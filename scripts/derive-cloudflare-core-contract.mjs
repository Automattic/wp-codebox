import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { execFile, spawn } from "node:child_process"
import { constants } from "node:fs"
import { access, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const cloudflareRoot = resolve(repositoryRoot, "packages/runtime-cloudflare")
const vendorRoot = resolve(cloudflareRoot, "vendor/wp-codebox-core")
const stagePrefix = ".runtime-cloudflare-core-stage-"
const stageLeasePrefix = ".runtime-cloudflare-core-stage-lease-"
const staleStageAgeMs = 24 * 60 * 60 * 1_000
export const cloudflareStageParent = dirname(cloudflareRoot)
let fileReaderHelper

export async function deriveCloudflareCoreContract({ write = false } = {}) {
  const cloudflarePackage = JSON.parse(await readFile(resolve(cloudflareRoot, "package.json"), "utf8"))
  const version = cloudflarePackage.wpCodeboxCoreCompatibility
  const sourceCommit = cloudflarePackage.wpCodeboxCoreSourceCommit
  assert.match(version, /^\d+\.\d+\.\d+$/, "Cloudflare core compatibility must be an exact release version")
  assert.match(sourceCommit, /^[a-f0-9]{40}$/, "Cloudflare core source must be pinned to an exact commit")
  const tag = `v${version}`
  const tagCommit = (await git(["rev-parse", `${tag}^{commit}`])).trim()
  assert.equal(tagCommit, sourceCommit, `${tag} must resolve to the pinned source commit`)
  const tagPackage = JSON.parse(await git(["show", `${tag}:packages/runtime-core/package.json`]))
  const tagLock = JSON.parse(await git(["show", `${tag}:npm-shrinkwrap.json`]))
  const compilerVersion = tagLock.packages?.["node_modules/typescript"]?.version
  assert.equal(tagPackage.name, "@automattic/wp-codebox-core")
  assert.equal(tagPackage.version, version, `${tag} must own the configured core version`)
  assert.match(compilerVersion, /^\d+\.\d+\.\d+$/, `${tag} must lock its TypeScript compiler`)

  const temporaryRoot = await mkdtemp(join(tmpdir(), "wp-codebox-core-contract-"))
  const sourceRoot = resolve(temporaryRoot, "source")
  let generatedSnapshotRoot
  try {
    await git(["worktree", "add", "--detach", sourceRoot, tagCommit])
    await execFileAsync("npm", ["ci", "--ignore-scripts"], { cwd: sourceRoot, maxBuffer: 1024 * 1024 * 20 })
    const installedCompiler = JSON.parse(await readFile(resolve(sourceRoot, "node_modules/typescript/package.json"), "utf8"))
    assert.equal(installedCompiler.version, compilerVersion, `${tag} must be derived with its locked TypeScript compiler`)
    await execFileAsync(process.execPath, [resolve(sourceRoot, "node_modules/typescript/bin/tsc"), "-p", resolve(sourceRoot, "packages/runtime-core/tsconfig.json"), "--pretty", "false"], {
      cwd: sourceRoot,
      maxBuffer: 1024 * 1024 * 20,
    })

    const generatedRoot = resolve(sourceRoot, "packages/runtime-core/dist")
    const generatedGeneration = await snapshotGeneratedTree(generatedRoot)
    generatedSnapshotRoot = generatedGeneration.root
    const pinnedGeneratedRoot = generatedGeneration.root
    const generatedFiles = await contractFilesFromSnapshot(pinnedGeneratedRoot, generatedGeneration.manifest)
    let promotion
    assert.ok(generatedFiles.includes("runtime-archive-component.js"))
    assert.ok(generatedFiles.includes("runtime-archive-component.d.ts"))
    assert.ok(generatedFiles.includes("runtime-package-profile.js"))
    assert.ok(generatedFiles.includes("runtime-package-profile.d.ts"))
    assert.ok(generatedFiles.includes("runtime-command-result.js"))
    assert.ok(generatedFiles.includes("runtime-command-result.d.ts"))

    if (write) {
      await reclaimStaleStages(cloudflareStageParent)
      const stagedRoot = await mkdtemp(resolve(cloudflareStageParent, `${stagePrefix}${process.pid}-`))
      const stageLease = await createStageLease(stagedRoot)
      try {
        for (const file of generatedFiles) {
          const target = resolve(stagedRoot, file)
          await mkdir(dirname(target), { recursive: true })
          await copyContainedRegularFile(pinnedGeneratedRoot, file, target)
        }
        await writeFile(resolve(stagedRoot, "package.json"), `${JSON.stringify(compatibilityPackage(version), null, 2)}\n`)
        promotion = await promoteValidatedDirectory({
          stagedRoot,
          destinationRoot: vendorRoot,
          stageLease,
          validate: (validatedRoot, candidateManifest) => assertContractTree(validatedRoot, pinnedGeneratedRoot, generatedFiles, version, tag, { candidateManifest, generatedManifest: generatedGeneration.manifest }),
        })
        if (promotion.outcome === "committed") await removeLease(stageLease.cleanupLease)
        else promotion = { ...promotion, cleanupLease: stageLease.cleanupLease }
      } finally {
        if (!promotion) {
          await resumePromotedCleanup(stageLease)
        }
      }
    } else {
      await assertContractTree(vendorRoot, pinnedGeneratedRoot, generatedFiles, version, tag, { generatedManifest: generatedGeneration.manifest })
    }
    return { tag, tagCommit, compilerVersion, generatedRoot, promotion }
  } finally {
    if (generatedSnapshotRoot) await rm(generatedSnapshotRoot, { recursive: true, force: true })
    await git(["worktree", "remove", "--force", sourceRoot], true)
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

function cleanupPendingResult(cleanupPath, dev, ino, stageLease, cleanupToken = stageLease?.cleanupToken ?? randomUUID()) {
  return {
    outcome: "promoted_cleanup_pending",
    cleanupPath,
    cleanupIdentity: { dev, ino },
    ...(stageLease?.cleanupFallbackIdentity ? { cleanupFallbackIdentity: stageLease.cleanupFallbackIdentity } : {}),
    ...(stageLease?.cleanupLease ? { cleanupLease: stageLease.cleanupLease } : {}),
    cleanupToken,
  }
}

export async function promoteValidatedDirectory({ stagedRoot, destinationRoot, stageLease, validate, fault = async () => {}, nativeFault = async () => {}, snapshotBarrier }) {
  const helperRoot = await mkdtemp(join(tmpdir(), "wp-codebox-atomic-exchange-"))
  const helper = resolve(helperRoot, "atomic-directory-exchange")
  let transaction
  let validationRoot
  try {
    await execFileAsync("cc", ["-Wall", "-Wextra", "-Werror", resolve(repositoryRoot, "scripts/atomic-directory-exchange.c"), "-o", helper])
    await fault("before-lock")
    const canonicalDestinationRoot = await canonicalDestinationPath(destinationRoot)
    const canonicalStagedRoot = await canonicalExistingDirectoryPath(stagedRoot, "staging")
    const lockDirectory = resolve(await realpath(tmpdir()), `wp-codebox-directory-exchange-${process.getuid?.() ?? "user"}-${createHash("sha256").update(canonicalDestinationRoot).digest("hex")}`)
    transaction = nativeTransaction(helper, lockDirectory, canonicalStagedRoot, canonicalDestinationRoot, snapshotBarrier)
    const locked = await expectNative(transaction, "LOCKED")
    const [, stageDev, stageIno, cleanupDev, cleanupIno] = locked.split(" ")
    if (stageLease) {
      stageLease.cleanupIdentity = { dev: cleanupDev, ino: cleanupIno }
      stageLease.cleanupFallbackIdentity = { dev: stageDev, ino: stageIno }
      await persistStageLease(stageLease)
    }

    const beforeValidation = await nativeManifest(transaction, stagedRoot)
    validationRoot = await mkdtemp(join(tmpdir(), "wp-codebox-validation-generation-"))
    validationRoot = await realpath(validationRoot)
    transaction.send(`SNAPSHOT ${validationRoot}`)
    const snapshotOutcome = await expectNative(transaction, "SNAPSHOT", { stagedRoot, destinationRoot })
    const snapshotManifest = snapshotOutcome.slice(9)
    if (!/^[a-f0-9]{64}$/.test(snapshotManifest)) throw nativeOutcomeError(snapshotOutcome, stagedRoot, destinationRoot)
    if (await treeManifest(validationRoot) !== snapshotManifest) throw new DirectoryPromotionError("STAGING_CONTENT_CHANGED", `validation snapshot changed before validation: ${stagedRoot}`)
    await validate(validationRoot, snapshotManifest)
    if (await treeManifest(validationRoot) !== snapshotManifest) throw new DirectoryPromotionError("STAGING_CONTENT_CHANGED", `validation snapshot changed during validation: ${stagedRoot}`)
    const validatedManifest = await nativeManifest(transaction, stagedRoot)
    if (validatedManifest !== beforeValidation) throw new DirectoryPromotionError("STAGING_CONTENT_CHANGED", `staging contents changed during validation: ${stagedRoot}`)
    if (snapshotManifest !== validatedManifest) throw new DirectoryPromotionError("STAGING_CONTENT_CHANGED", `validated snapshot does not match staging contents: ${stagedRoot}`)
    await fault("after-validation")
    await fault("before-promotion")

    transaction.send(`PROMOTE ${validatedManifest}`)
    await expectNative(transaction, "CHECKED")
    await nativeFault("helper-checked")
    transaction.send("EXCHANGE")
    await expectNative(transaction, "PROMOTED", { stagedRoot, destinationRoot })
    await nativeFault("after-promoted")
    try {
      await fault("after-promotion")
    } catch (cause) {
      transaction.send("ROLLBACK")
      const outcome = await transaction.next()
      if (outcome === "ROLLED_BACK") throw cause
      throw nativeOutcomeError(outcome, stagedRoot, destinationRoot, cause)
    }

    transaction.send("COMMIT")
    await expectNative(transaction, "FINAL_MANIFEST", { stagedRoot, destinationRoot })
    await nativeFault("after-final-manifest")
    transaction.send("FINALIZE")
    const commitOutcome = await transaction.next()
    if (commitOutcome === "ROLLED_BACK") throw new DirectoryPromotionError("STAGING_CONTENT_CHANGED", `promoted contents changed before commit: ${destinationRoot}`)
    if (commitOutcome !== "COMMITTED") throw nativeOutcomeError(commitOutcome, stagedRoot, destinationRoot)

    try {
      await nativeFault("before-cleanup")
    } catch {
      transaction.send("LEAVE")
      await expectNative(transaction, "CLEANUP_PENDING")
      return cleanupPendingResult(canonicalStagedRoot, cleanupDev, cleanupIno, stageLease)
    }
    const cleanupToken = stageLease?.cleanupToken ?? randomUUID()
    transaction.send(`CLEANUP ${cleanupToken}`)
    const cleanupOutcome = await transaction.next()
    if (cleanupOutcome === "CLEANUP_PENDING") return cleanupPendingResult(canonicalStagedRoot, cleanupDev, cleanupIno, stageLease, cleanupToken)
    if (cleanupOutcome !== "CLEANED") throw nativeOutcomeError(cleanupOutcome, stagedRoot, destinationRoot)
    return { outcome: "committed" }
  } finally {
    await transaction?.close()
    if (validationRoot) await rm(validationRoot, { recursive: true, force: true })
    await rm(helperRoot, { recursive: true, force: true })
  }
}

export async function resumePromotedCleanup({ cleanupPath, cleanupIdentity, cleanupFallbackIdentity, cleanupLease, cleanupToken, cleanupBarrier, cleanupBarrierPoint }) {
  const helperRoot = await mkdtemp(join(tmpdir(), "wp-codebox-atomic-cleanup-"))
  const helper = resolve(helperRoot, "atomic-directory-exchange")
  try {
    await execFileAsync("cc", ["-Wall", "-Wextra", "-Werror", resolve(repositoryRoot, "scripts/atomic-directory-exchange.c"), "-o", helper])
    const canonicalCleanupPath = resolve(await realpath(dirname(cleanupPath)), basename(cleanupPath))
    try {
      if (!cleanupToken) throw new DirectoryPromotionError("CLEANUP_PENDING", `cleanup ownership token is required: ${canonicalCleanupPath}`)
      const { stdout } = await execFileAsync(helper, ["--cleanup", canonicalCleanupPath, String(cleanupIdentity.dev), String(cleanupIdentity.ino), cleanupToken], {
        env: { ...process.env, ...(cleanupBarrier ? { WP_CODEBOX_CLEANUP_BARRIER: cleanupBarrier } : {}), ...(cleanupBarrierPoint ? { WP_CODEBOX_CLEANUP_BARRIER_POINT: cleanupBarrierPoint } : {}) },
      })
      if (stdout.trim() !== "CLEANED") throw nativeOutcomeError(stdout.trim(), canonicalCleanupPath, "")
      if (cleanupLease) await removeLease(cleanupLease)
      return { outcome: "cleaned" }
    } catch (cause) {
      if (cause.stdout?.trim() === "RIGHT_OWNERSHIP_CHANGED" && cleanupFallbackIdentity) {
        const resumed = await resumePromotedCleanup({ cleanupPath: canonicalCleanupPath, cleanupIdentity: cleanupFallbackIdentity, cleanupLease, cleanupToken, cleanupBarrier, cleanupBarrierPoint })
        return resumed.outcome === "promoted_cleanup_pending" ? { ...resumed, cleanupFallbackIdentity } : resumed
      }
      if (cause.stdout?.trim() === "RIGHT_OWNERSHIP_CHANGED") throw nativeOutcomeError("RIGHT_OWNERSHIP_CHANGED", canonicalCleanupPath, "", cause)
      if (cause.stdout?.trim() === "CLEANUP_PENDING") return { outcome: "promoted_cleanup_pending", cleanupPath: canonicalCleanupPath, cleanupIdentity, ...(cleanupFallbackIdentity ? { cleanupFallbackIdentity } : {}), ...(cleanupLease ? { cleanupLease } : {}), cleanupToken }
      throw cause
    }
  } finally {
    await rm(helperRoot, { recursive: true, force: true })
  }
}

function nativeTransaction(helper, lock, stagedRoot, destinationRoot, snapshotBarrier) {
  const holder = spawn(helper, ["--transaction", lock, stagedRoot, destinationRoot], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...(snapshotBarrier ? { WP_CODEBOX_SNAPSHOT_BARRIER: snapshotBarrier } : {}) } })
  let stderr = ""
  holder.stderr.setEncoding("utf8")
  holder.stderr.on("data", (chunk) => { stderr += chunk })
  const lines = []
  const waiters = []
  let buffer = ""
  let closed
  holder.stdout.setEncoding("utf8")
  holder.stdout.on("data", (chunk) => {
    buffer += chunk
    while (buffer.includes("\n")) {
      const line = buffer.slice(0, buffer.indexOf("\n"))
      buffer = buffer.slice(buffer.indexOf("\n") + 1)
      const waiter = waiters.shift()
      if (waiter) waiter.resolve(line)
      else lines.push(line)
    }
  })
  const closePromise = new Promise((resolveClose) => holder.once("close", (code) => {
    closed = code
    for (const waiter of waiters.splice(0)) waiter.reject(new Error(`native promotion transaction exited with ${code}: ${stderr}`))
    resolveClose(code)
  }))
  return {
    send(command) { holder.stdin.write(`${command}\n`) },
    next() {
      if (lines.length) return Promise.resolve(lines.shift())
      if (closed !== undefined) return Promise.reject(new Error(`native promotion transaction exited with ${closed}: ${stderr}`))
      return new Promise((resolveLine, rejectLine) => waiters.push({ resolve: resolveLine, reject: rejectLine }))
    },
    async close() {
      if (closed === undefined) holder.stdin.end()
      await closePromise
    },
  }
}

async function nativeManifest(transaction, stagedRoot) {
  transaction.send("MANIFEST")
  const outcome = await transaction.next()
  if (outcome.startsWith("MANIFEST ")) return outcome.slice(9)
  throw nativeOutcomeError(outcome, stagedRoot, "")
}

async function expectNative(transaction, expected, paths = {}) {
  const outcome = await transaction.next()
  if (outcome === expected || outcome.startsWith(`${expected} `)) return outcome
  throw nativeOutcomeError(outcome, paths.stagedRoot, paths.destinationRoot)
}

function nativeOutcomeError(outcome, stagedRoot, destinationRoot, cause) {
  const nativeCode = outcome.split(" ").at(-1)
  const codes = {
    LEFT_OWNERSHIP_CHANGED: "STAGING_OWNERSHIP_CHANGED",
    RIGHT_OWNERSHIP_CHANGED: "RIGHT_OWNERSHIP_CHANGED",
    STAGING_CONTENT_CHANGED: "STAGING_CONTENT_CHANGED",
    INVALID_STAGING: "INVALID_DIRECTORY_ENTRY",
    INVALID_DIRECTORY_ENTRY: "INVALID_DIRECTORY_ENTRY",
    ROLLBACK_FAILED: "ROLLBACK_FAILED",
    DIRECTORY_LOCK_LOST: "DIRECTORY_LOCK_LOST",
    CLEANUP_PENDING: "CLEANUP_PENDING",
  }
  const code = codes[nativeCode] ?? "ATOMIC_EXCHANGE_FAILED"
  if (code === "ROLLBACK_FAILED" && cause) {
    cause = new AggregateError([cause, new DirectoryPromotionError("LEFT_OWNERSHIP_CHANGED", `displaced destination ownership changed: ${stagedRoot}`)], "promotion and rollback both failed")
  }
  return new DirectoryPromotionError(code, `native directory promotion reported ${outcome}${cause?.message ? ` after ${cause.message}` : ""}: ${stagedRoot ?? ""} -> ${destinationRoot ?? ""}`, { cause })
}

async function canonicalDestinationPath(path) {
  const absolute = resolve(path)
  try {
    const entry = await lstat(absolute)
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new DirectoryPromotionError("INVALID_DIRECTORY_ENTRY", `destination entry must be a directory and not a symlink: ${path}`)
    }
    return await realpath(absolute)
  } catch (cause) {
    if (cause instanceof DirectoryPromotionError) throw cause
    if (cause?.code !== "ENOENT") throw cause
    const parent = dirname(absolute)
    const canonicalParent = await realpath(parent)
    const parentEntry = await stat(canonicalParent)
    if (!parentEntry.isDirectory()) throw new DirectoryPromotionError("INVALID_DIRECTORY_ENTRY", `destination parent must resolve to a directory: ${parent}`, { cause })
    return resolve(canonicalParent, basename(absolute))
  }
}

async function canonicalExistingDirectoryPath(path, role) {
  await directoryIdentity(path, role)
  return realpath(path)
}

export class DirectoryPromotionError extends Error {
  constructor(code, message, options) {
    super(message, options)
    this.name = "DirectoryPromotionError"
    this.code = code
  }
}

async function directoryIdentity(path, role) {
  let stat
  try {
    stat = await lstat(path, { bigint: true })
  } catch (cause) {
    throw new DirectoryPromotionError("INVALID_DIRECTORY_ENTRY", `${role} entry must be an existing directory: ${path}`, { cause })
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new DirectoryPromotionError("INVALID_DIRECTORY_ENTRY", `${role} entry must be a directory and not a symlink: ${path}`)
  }
  return { dev: stat.dev, ino: stat.ino }
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino
}

async function copyContainedRegularFile(root, file, target) {
  await writeFile(target, await readContainedRegularFile(root, file))
}

async function openContainedRegularFile(root, file) {
  const canonicalRoot = await realpath(root)
  let current = canonicalRoot
  for (const component of file.split(/[\\/]/)) {
    if (!component || component === "." || component === "..") {
      throw new DirectoryPromotionError("GENERATED_IMPORT_ESCAPE", `generated file path is not canonical: ${file}`)
    }
    current = resolve(current, component)
    const entry = await lstat(current)
    if (entry.isSymbolicLink()) throw new DirectoryPromotionError("GENERATED_SOURCE_SYMLINK", `generated source must not use symlinks: ${file}`)
  }
  const canonicalSource = await realpath(current)
  if (!isContainedPath(canonicalRoot, canonicalSource)) {
    throw new DirectoryPromotionError("GENERATED_IMPORT_ESCAPE", `generated source escapes its canonical root: ${file}`)
  }
  const sourceEntry = await lstat(current, { bigint: true })
  if (!sourceEntry.isFile()) throw new DirectoryPromotionError("INVALID_DIRECTORY_ENTRY", `generated source must be a regular file: ${file}`)
  const handle = await open(current, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  const openedEntry = await handle.stat({ bigint: true })
  if (!openedEntry.isFile() || !sameIdentity(sourceEntry, openedEntry)) {
    await handle.close()
    throw new DirectoryPromotionError("GENERATED_SOURCE_CHANGED", `generated source changed while it was opened: ${file}`)
  }
  return handle
}

async function readContainedRegularFile(root, file, encoding, expectedRootIdentity) {
  try {
    const helper = await fileReader()
    const canonicalRoot = await realpath(root)
    const options = typeof expectedRootIdentity === "object" && "identity" in expectedRootIdentity ? expectedRootIdentity : { identity: expectedRootIdentity }
    const rootIdentity = options.identity ?? await directoryIdentity(canonicalRoot, "generated source root")
    const { stdout } = await execFileAsync(helper, ["--read", canonicalRoot, file, String(rootIdentity.dev), String(rootIdentity.ino)], {
      encoding: encoding ?? null,
      maxBuffer: 1024 * 1024 * 20,
      env: { ...process.env, ...(options.readBarrier ? { WP_CODEBOX_READ_BARRIER: options.readBarrier } : {}) },
    })
    return stdout
  } catch (cause) {
    if (cause instanceof DirectoryPromotionError) throw cause
    throw new DirectoryPromotionError("GENERATED_SOURCE_CHANGED", `generated source could not be read without following links: ${file}`, { cause })
  }
}

async function fileReader() {
  fileReaderHelper ??= (async () => {
    const root = await mkdtemp(join(tmpdir(), "wp-codebox-file-reader-"))
    const helper = resolve(root, "atomic-directory-exchange")
    await execFileAsync("cc", ["-Wall", "-Wextra", "-Werror", resolve(repositoryRoot, "scripts/atomic-directory-exchange.c"), "-o", helper])
    return helper
  })()
  return fileReaderHelper
}

function isContainedPath(root, candidate) {
  const path = relative(root, candidate)
  return path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(path)
}

export async function reclaimStaleStages(parent) {
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    if (!entry.name.startsWith(stageLeasePrefix) || !entry.isFile()) continue
    const cleanupLease = resolve(parent, entry.name)
    const leaseStat = await lstat(cleanupLease)
    if (!leaseStat.isFile() || leaseStat.isSymbolicLink() || leaseStat.uid !== process.getuid?.() || (leaseStat.mode & 0o777) !== 0o600) continue
    let lease
    try { lease = JSON.parse(await readFile(cleanupLease, "utf8")) } catch { continue }
    if (typeof lease.name !== "string" || basename(lease.name) !== lease.name || !lease.name.startsWith(stagePrefix) || typeof lease.token !== "string" || !/^[A-Za-z0-9-]{1,80}$/.test(lease.token)) continue
    const pid = Number(lease.pid)
    const age = Date.now() - Number(lease.createdAt)
    if (age < staleStageAgeMs && (pid === process.pid || processIsAlive(pid))) continue
    try {
      await resumePromotedCleanup({
        cleanupPath: resolve(parent, lease.name),
        cleanupIdentity: { dev: lease.displacedDev ?? lease.dev, ino: lease.displacedIno ?? lease.ino },
        cleanupFallbackIdentity: lease.displacedDev ? { dev: lease.dev, ino: lease.ino } : undefined,
        cleanupLease,
        cleanupToken: lease.token,
      })
    } catch (error) {
      if (!(error instanceof DirectoryPromotionError) || error.code !== "RIGHT_OWNERSHIP_CHANGED") throw error
    }
  }
}

export async function createStageLease(stagePath, { createdAt = Date.now(), pid = process.pid } = {}) {
  const canonicalParent = await realpath(dirname(stagePath))
  const name = basename(stagePath)
  if (!name.startsWith(stagePrefix)) throw new DirectoryPromotionError("INVALID_DIRECTORY_ENTRY", `stage name is not owned by the derivation: ${stagePath}`)
  const cleanupIdentity = await directoryIdentity(resolve(canonicalParent, name), "staging")
  const cleanupLease = resolve(canonicalParent, `${stageLeasePrefix}${randomUUID()}`)
  const stageLease = { cleanupPath: resolve(canonicalParent, name), cleanupIdentity, cleanupLease, cleanupToken: randomUUID(), pid, createdAt }
  await persistStageLease(stageLease, true)
  return stageLease
}

async function persistStageLease(stageLease, exclusive = false) {
  const temporary = `${stageLease.cleanupLease}.tmp-${randomUUID()}`
  const record = {
    name: basename(stageLease.cleanupPath),
    dev: String(stageLease.cleanupFallbackIdentity?.dev ?? stageLease.cleanupIdentity.dev),
    ino: String(stageLease.cleanupFallbackIdentity?.ino ?? stageLease.cleanupIdentity.ino),
    ...(stageLease.cleanupFallbackIdentity ? { displacedDev: String(stageLease.cleanupIdentity.dev), displacedIno: String(stageLease.cleanupIdentity.ino) } : {}),
    token: stageLease.cleanupToken,
    pid: stageLease.pid ?? process.pid,
    createdAt: stageLease.createdAt ?? Date.now(),
  }
  if (exclusive && await exists(stageLease.cleanupLease)) throw new DirectoryPromotionError("INVALID_DIRECTORY_ENTRY", `stage lease already exists: ${stageLease.cleanupLease}`)
  const lease = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  try {
    await lease.writeFile(`${JSON.stringify(record)}\n`)
    await lease.sync()
  } finally {
    await lease.close()
  }
  await rename(temporary, stageLease.cleanupLease)
  await syncParent(stageLease.cleanupLease)
}

async function syncParent(path) {
  const parent = await open(dirname(path), constants.O_RDONLY)
  try { await parent.sync() } finally { await parent.close() }
}

async function removeLease(path) {
  await rm(path)
  await syncParent(path)
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === "EPERM"
  }
}

async function assertContractTree(candidateRoot, generatedRoot, generatedFiles, version, tag, { candidateManifest, generatedManifest } = {}) {
  const candidateBefore = await treeManifest(candidateRoot)
  const generatedBefore = await treeManifest(generatedRoot)
  if (candidateManifest && candidateBefore !== candidateManifest) throw new DirectoryPromotionError("STAGING_CONTENT_CHANGED", `candidate snapshot changed before validation: ${candidateRoot}`)
  if (generatedManifest && generatedBefore !== generatedManifest) throw new DirectoryPromotionError("GENERATED_SOURCE_CHANGED", `generated snapshot changed before validation: ${generatedRoot}`)
  const candidateFiles = (await filesBelow(candidateRoot)).filter((file) => file !== "package.json")
  assert.deepEqual(candidateFiles, generatedFiles, "vendored core files must be the complete generated contract dependency closure")
  for (const file of generatedFiles) {
    assert.deepEqual(await readContainedRegularFile(candidateRoot, file), await readContainedRegularFile(generatedRoot, file), `vendored core contract drifted from ${tag}: ${file}`)
  }
  const candidatePackage = JSON.parse(await readContainedRegularFile(candidateRoot, "package.json", "utf8"))
  assert.deepEqual(candidatePackage, compatibilityPackage(version), "vendored package metadata must expose only the selected generated release contracts")
  await assertContractBehavior(candidateRoot, generatedRoot)
  if (await treeManifest(candidateRoot) !== candidateBefore) throw new DirectoryPromotionError("STAGING_CONTENT_CHANGED", `candidate snapshot changed during validation: ${candidateRoot}`)
  if (await treeManifest(generatedRoot) !== generatedBefore) throw new DirectoryPromotionError("GENERATED_SOURCE_CHANGED", `generated snapshot changed during validation: ${generatedRoot}`)
}

function compatibilityPackage(version) {
  const contract = (file) => ({ types: `./${file}.d.ts`, import: `./${file}.js`, default: `./${file}.js` })
  return {
    name: "@automattic/wp-codebox-core",
    version,
    type: "module",
    exports: {
      "./package.json": "./package.json",
      "./runtime-archive-component": contract("runtime-archive-component"),
      "./runtime-package-profile": contract("runtime-package-profile"),
      "./runtime-command-result": contract("runtime-command-result"),
    },
  }
}

async function filesBelow(root) {
  const files = []
  async function visit(directory) {
    for (const entry of await readdir(directory)) {
      const path = resolve(directory, entry)
      const stat = await lstat(path)
      if (stat.isDirectory()) await visit(path)
      else files.push(relative(root, path))
    }
  }
  await visit(root)
  return files.sort()
}

export async function contractFiles(root, options = {}) {
  const generation = await snapshotGeneratedTree(root, options)
  try {
    return await contractFilesFromSnapshot(generation.root, generation.manifest)
  } finally {
    await rm(generation.root, { recursive: true, force: true })
  }
}

async function snapshotGeneratedTree(root, { fault = async () => {}, readBarrier } = {}) {
  const canonicalRoot = await realpath(root)
  const rootIdentity = await directoryIdentity(canonicalRoot, "generated source root")
  await assertNoGeneratedSymlinks(canonicalRoot, canonicalRoot)
  await fault("source-root-opened")
  const snapshotRoot = await mkdtemp(join(tmpdir(), "wp-codebox-generated-generation-"))
  try {
    const helper = await fileReader()
    const canonicalSnapshotRoot = await realpath(snapshotRoot)
    const { stdout } = await execFileAsync(helper, ["--snapshot", canonicalRoot, canonicalSnapshotRoot, String(rootIdentity.dev), String(rootIdentity.ino)], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 20,
      env: { ...process.env, ...(readBarrier ? { WP_CODEBOX_SNAPSHOT_BARRIER: readBarrier } : {}) },
    })
    const outcome = stdout.trim()
    if (!/^SNAPSHOT [a-f0-9]{64}$/.test(outcome)) throw nativeOutcomeError(outcome, canonicalRoot, snapshotRoot)
    await fault("source-snapshotted")
    return { root: canonicalSnapshotRoot, manifest: outcome.slice(9) }
  } catch (cause) {
    await rm(snapshotRoot, { recursive: true, force: true })
    if (cause instanceof DirectoryPromotionError) throw cause
    throw new DirectoryPromotionError("GENERATED_SOURCE_CHANGED", `generated source changed while its operation snapshot was created: ${root}`, { cause })
  }
}

async function assertNoGeneratedSymlinks(root, directory) {
  for (const entry of await readdir(directory)) {
    const path = resolve(directory, entry)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) throw new DirectoryPromotionError("GENERATED_SOURCE_SYMLINK", `generated source must not use symlinks: ${relative(root, path)}`)
    if (metadata.isDirectory()) await assertNoGeneratedSymlinks(root, path)
  }
}

async function contractFilesFromSnapshot(root, expectedManifest) {
  const before = await treeManifest(root)
  if (before !== expectedManifest) throw new DirectoryPromotionError("GENERATED_SOURCE_CHANGED", `generated source snapshot changed before dependency discovery: ${root}`)
  const files = new Set([
    "runtime-archive-component.js",
    "runtime-archive-component.d.ts",
    "runtime-package-profile.js",
    "runtime-package-profile.d.ts",
    "runtime-command-result.js",
    "runtime-command-result.d.ts",
  ])
  const pending = [...files]
  while (pending.length) {
    const file = pending.pop()
    const source = await readContainedRegularFile(root, file, "utf8")
    for (const match of source.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["'](\.[^"']+)["']/g)) {
      const importedPath = resolve(root, dirname(file), match[1])
      const imported = relative(root, importedPath)
      if (imported === ".." || imported.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
        throw new DirectoryPromotionError("GENERATED_IMPORT_ESCAPE", `generated relative import escapes the generated/source roots: ${file} imports ${match[1]}`)
      }
      for (const candidate of imported.endsWith(".js") ? [imported, imported.replace(/\.js$/, ".d.ts")] : [imported]) {
        if (!files.has(candidate) && await entryExists(resolve(root, candidate))) {
          const handle = await openContainedRegularFile(root, candidate)
          await handle.close()
          files.add(candidate)
          pending.push(candidate)
        }
      }
    }
  }
  for (const file of [...files]) {
    if (await entryExists(resolve(root, `${file}.map`))) {
      const handle = await openContainedRegularFile(root, `${file}.map`)
      await handle.close()
      files.add(`${file}.map`)
    }
  }
  if (await treeManifest(root) !== before) throw new DirectoryPromotionError("GENERATED_SOURCE_CHANGED", `generated source snapshot changed during dependency discovery: ${root}`)
  return [...files].sort()
}

async function treeManifest(root) {
  const canonicalRoot = await realpath(root)
  const identity = await directoryIdentity(canonicalRoot, "manifest root")
  const helper = await fileReader()
  const { stdout } = await execFileAsync(helper, ["--manifest", canonicalRoot, String(identity.dev), String(identity.ino)], { encoding: "utf8", maxBuffer: 1024 * 1024 * 20 })
  const outcome = stdout.trim()
  if (!/^MANIFEST [a-f0-9]{64}$/.test(outcome)) throw nativeOutcomeError(outcome, canonicalRoot, "")
  return outcome.slice(9)
}

async function assertContractBehavior(candidateRoot, generatedRoot) {
  const generation = randomUUID()
  const generatedArchive = await import(`${pathToFileURL(resolve(generatedRoot, "runtime-archive-component.js")).href}?generated=${generation}`)
  const vendorArchive = await import(`${pathToFileURL(resolve(candidateRoot, "runtime-archive-component.js")).href}?candidate=${generation}`)
  const generatedProfile = await import(`${pathToFileURL(resolve(generatedRoot, "runtime-package-profile.js")).href}?generated=${generation}`)
  const vendorProfile = await import(`${pathToFileURL(resolve(candidateRoot, "runtime-package-profile.js")).href}?candidate=${generation}`)
  const generatedResult = await import(`${pathToFileURL(resolve(generatedRoot, "runtime-command-result.js")).href}?generated=${generation}`)
  const vendorResult = await import(`${pathToFileURL(resolve(candidateRoot, "runtime-command-result.js")).href}?candidate=${generation}`)
  const component = { schema: generatedArchive.RUNTIME_ARCHIVE_COMPONENT_SCHEMA, id: "website-importer", package: { profile: "cloudflare", root: "static-site-importer" }, wordpress: { install_path: "plugins/static-site-importer", bootstrap_file: "plugin.php", load: { mode: "mu-plugin-loader", loader_path: "mu-plugins/loader.php" } }, abilities: { import: "sites/import" }, limits: { files: 100, bytes: 1_000_000 } }
  assert.deepEqual(vendorArchive.runtimeArchiveComponent(component), generatedArchive.runtimeArchiveComponent(component))
  for (const invalid of [null, { ...component, id: "../escape" }, { ...component, limits: { files: 0, bytes: 1 } }, { ...component, wordpress: { ...component.wordpress, bootstrap_file: "../plugin.php" } }]) {
    assertSameRejection(() => vendorArchive.runtimeArchiveComponent(invalid), () => generatedArchive.runtimeArchiveComponent(invalid))
  }
  const source = { schema: generatedArchive.RUNTIME_ARCHIVE_COMPONENT_SOURCE_SCHEMA, source: { url: "https://example.com/component.zip", version: "1.0.0", identity: "revision", sha256: "a".repeat(64) }, component }
  assert.deepEqual(vendorArchive.runtimeArchiveComponentSource(source), generatedArchive.runtimeArchiveComponentSource(source))
  assertSameRejection(() => vendorArchive.runtimeArchiveComponentSource({ ...source, source: { ...source.source, url: "http://example.com/component.zip" } }), () => generatedArchive.runtimeArchiveComponentSource({ ...source, source: { ...source.source, url: "http://example.com/component.zip" } }))

  const manifestSource = JSON.stringify({ schema: "example/runtime-package-manifest/v1", package: "example", package_root: "example", profiles: { cloudflare: { abilities: ["sites/import"], selectors: [{ type: "file", path: "plugin.php" }], required_files: ["plugin.php"] } } })
  const generatedManifest = generatedProfile.parseRuntimePackageManifest(manifestSource)
  const vendorManifest = vendorProfile.parseRuntimePackageManifest(manifestSource)
  assert.deepEqual(vendorManifest, generatedManifest)
  assert.deepEqual(vendorProfile.selectRuntimePackageProfileFiles(vendorManifest, "cloudflare", ["example/runtime-package-manifest.json", "example/plugin.php"], "example/runtime-package-manifest.json"), generatedProfile.selectRuntimePackageProfileFiles(generatedManifest, "cloudflare", ["example/runtime-package-manifest.json", "example/plugin.php"], "example/runtime-package-manifest.json"))
  for (const invalid of ["not-json", JSON.stringify({ package: "../escape" }), JSON.stringify({ schema: "example/runtime-package-manifest/v1", package: "example", package_root: "example", profiles: {} })]) {
    assertSameRejection(() => vendorProfile.parseRuntimePackageManifest(invalid), () => generatedProfile.parseRuntimePackageManifest(invalid))
  }
  assertSameRejection(() => vendorProfile.selectRuntimePackageProfileFiles(vendorManifest, "cloudflare", ["example/../plugin.php"], "example/runtime-package-manifest.json"), () => generatedProfile.selectRuntimePackageProfileFiles(generatedManifest, "cloudflare", ["example/../plugin.php"], "example/runtime-package-manifest.json"))
  for (const input of [{ status: "ok", stdout: "{\"passed\":true}\n" }, { status: "error", stdout: "{invalid", stderr: "failure" }, { stdout: "[1,2,3]" }]) {
    assert.deepEqual(vendorResult.runtimeCommandResultEnvelopeFromOutput(input), generatedResult.runtimeCommandResultEnvelopeFromOutput(input))
  }
}

function assertSameRejection(vendor, generated) {
  assert.throws(vendor, (vendorError) => {
    assert.throws(generated, (generatedError) => {
      assert.equal(vendorError.message, generatedError.message)
      return true
    })
    return true
  })
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function entryExists(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error?.code === "ENOENT") return false
    throw error
  }
}

async function git(args, tolerateFailure = false) {
  try {
    return (await execFileAsync("git", args, { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 1024 * 1024 * 20 })).stdout
  } catch (error) {
    if (tolerateFailure) return ""
    throw error
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await deriveCloudflareCoreContract({ write: process.argv.includes("--write") })
  console.log(`Cloudflare core contract ${process.argv.includes("--write") ? "generated" : "verified"}`)
}
