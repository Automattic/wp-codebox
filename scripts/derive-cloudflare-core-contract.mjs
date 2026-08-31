import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { execFile, spawn } from "node:child_process"
import { constants } from "node:fs"
import { access, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const cloudflareRoot = resolve(repositoryRoot, "packages/runtime-cloudflare")
const vendorRoot = resolve(cloudflareRoot, "vendor/wp-codebox-core")
const stagePrefix = ".runtime-cloudflare-core-stage-"
const staleStageAgeMs = 24 * 60 * 60 * 1_000
export const cloudflareStageParent = dirname(cloudflareRoot)

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
    const generatedFiles = await contractFiles(generatedRoot)
    assert.ok(generatedFiles.includes("runtime-archive-component.js"))
    assert.ok(generatedFiles.includes("runtime-archive-component.d.ts"))
    assert.ok(generatedFiles.includes("runtime-package-profile.js"))
    assert.ok(generatedFiles.includes("runtime-package-profile.d.ts"))
    assert.ok(generatedFiles.includes("runtime-command-result.js"))
    assert.ok(generatedFiles.includes("runtime-command-result.d.ts"))

    if (write) {
      await reclaimStaleStages(cloudflareStageParent)
      const stagedRoot = await mkdtemp(resolve(cloudflareStageParent, `${stagePrefix}${process.pid}-`))
      try {
        for (const file of generatedFiles) {
          const target = resolve(stagedRoot, file)
          await mkdir(dirname(target), { recursive: true })
          await copyContainedRegularFile(generatedRoot, file, target)
        }
        await writeFile(resolve(stagedRoot, "package.json"), `${JSON.stringify(compatibilityPackage(version), null, 2)}\n`)
        await promoteValidatedDirectory({
          stagedRoot,
          destinationRoot: vendorRoot,
          validate: () => assertContractTree(stagedRoot, generatedRoot, generatedFiles, version, tag),
        })
      } finally {
        await rm(stagedRoot, { recursive: true, force: true })
      }
    } else {
      await assertContractTree(vendorRoot, generatedRoot, generatedFiles, version, tag)
    }
    return { tag, tagCommit, compilerVersion, generatedRoot }
  } finally {
    await git(["worktree", "remove", "--force", sourceRoot], true)
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

export async function promoteValidatedDirectory({ stagedRoot, destinationRoot, validate, fault = async () => {} }) {
  const helperRoot = await mkdtemp(join(tmpdir(), "wp-codebox-atomic-exchange-"))
  const helper = resolve(helperRoot, "atomic-directory-exchange")
  try {
    await execFileAsync("cc", [resolve(repositoryRoot, "scripts/atomic-directory-exchange.c"), "-o", helper])
    await fault("before-lock")
    await withDestinationLock(helper, destinationRoot, async (canonicalDestinationRoot) => {
      const stagedIdentity = await directoryIdentity(stagedRoot, "staging")
      await directoryIdentity(canonicalDestinationRoot, "destination")
      const beforeValidation = await directoryManifest(stagedRoot)
      await validate(stagedRoot)
      const validatedManifest = await directoryManifest(stagedRoot)
      if (validatedManifest !== beforeValidation) {
        throw new DirectoryPromotionError("STAGING_CONTENT_CHANGED", `staging contents changed during validation: ${stagedRoot}`)
      }
      await fault("after-validation")

      await fault("before-promotion")
      const readyStagedIdentity = await directoryIdentity(stagedRoot, "staging")
      if (!sameIdentity(readyStagedIdentity, stagedIdentity)) {
        throw new DirectoryPromotionError("STAGING_OWNERSHIP_CHANGED", `staging generation changed before exchange: ${stagedRoot}`)
      }
      if (await directoryManifest(stagedRoot) !== validatedManifest) {
        throw new DirectoryPromotionError("STAGING_CONTENT_CHANGED", `staging contents changed after validation: ${stagedRoot}`)
      }
      const previousIdentity = await directoryIdentity(canonicalDestinationRoot, "destination")
      await atomicExchangeDirectories(helper, stagedRoot, canonicalDestinationRoot, stagedIdentity, previousIdentity)
      try {
        await fault("after-promotion")
      } catch (error) {
        try {
          await atomicExchangeDirectories(helper, stagedRoot, canonicalDestinationRoot, previousIdentity, stagedIdentity)
        } catch (rollbackError) {
          if (rollbackError instanceof DirectoryPromotionError && rollbackError.code === "RIGHT_OWNERSHIP_CHANGED") throw error
          await takeFailedReplacementOffline(helper, canonicalDestinationRoot, stagedIdentity)
          throw new DirectoryPromotionError("ROLLBACK_FAILED", `failed promotion could not restore its previous destination: ${canonicalDestinationRoot}`, {
            cause: new AggregateError([error, rollbackError], "promotion and rollback both failed"),
          })
        }
        throw error
      }

      await rm(stagedRoot, { recursive: true, force: true })
    })
  } finally {
    await rm(helperRoot, { recursive: true, force: true })
  }
}

async function withDestinationLock(helper, destinationRoot, action) {
  const canonicalDestination = await canonicalDestinationPath(destinationRoot)
  const lock = resolve(tmpdir(), `wp-codebox-directory-exchange-${createHash("sha256").update(canonicalDestination).digest("hex")}.lock`)
  const holder = spawn(helper, ["--lock", lock], { stdio: ["pipe", "pipe", "pipe"] })
  let stderr = ""
  holder.stderr.setEncoding("utf8")
  holder.stderr.on("data", (chunk) => { stderr += chunk })
  let closed = false
  let closeCode
  const closePromise = new Promise((resolveClose) => holder.once("close", (code) => {
    closed = true
    closeCode = code
    resolveClose(code)
  }))
  try {
    await new Promise((resolveLocked, rejectLocked) => {
      let stdout = ""
      holder.stdout.setEncoding("utf8")
      holder.stdout.on("data", (chunk) => {
        stdout += chunk
        if (stdout.includes("locked\n")) resolveLocked()
      })
      holder.once("error", rejectLocked)
      holder.once("exit", (code) => rejectLocked(new Error(`directory lock holder exited with ${code}: ${stderr}`)))
    })
    const result = await action(canonicalDestination)
    if (closed) throw new DirectoryPromotionError("DIRECTORY_LOCK_LOST", `directory lock holder exited with ${closeCode}: ${stderr}`)
    return result
  } finally {
    if (!closed) holder.stdin.end()
    await closePromise
  }
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

async function atomicExchangeDirectories(helper, left, right, expectedLeft, expectedRight) {
  try {
    await execFileAsync(helper, [left, right, String(expectedLeft.dev), String(expectedLeft.ino), String(expectedRight.dev), String(expectedRight.ino)])
  } catch (cause) {
    if (cause.code === 3) throw new DirectoryPromotionError("LEFT_OWNERSHIP_CHANGED", `left exchange generation changed: ${left}`, { cause })
    if (cause.code === 4) throw new DirectoryPromotionError("RIGHT_OWNERSHIP_CHANGED", `right exchange generation changed: ${right}`, { cause })
    throw new DirectoryPromotionError("ATOMIC_EXCHANGE_FAILED", `atomic directory exchange failed for ${left} and ${right}`, { cause })
  }
}

async function takeFailedReplacementOffline(helper, destinationRoot, failedIdentity) {
  const emptyRoot = await mkdtemp(resolve(dirname(destinationRoot), ".wp-codebox-rollback-empty-"))
  try {
    const emptyIdentity = await directoryIdentity(emptyRoot, "rollback replacement")
    try {
      await atomicExchangeDirectories(helper, emptyRoot, destinationRoot, emptyIdentity, failedIdentity)
    } catch (error) {
      if (error instanceof DirectoryPromotionError && error.code === "RIGHT_OWNERSHIP_CHANGED") return
      throw error
    }
  } finally {
    await rm(emptyRoot, { recursive: true, force: true })
  }
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino
}

async function directoryManifest(root) {
  const hash = createHash("sha256")
  async function visit(directory, relativeDirectory = "") {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const relativePath = join(relativeDirectory, entry.name)
      const path = resolve(directory, entry.name)
      const identity = await lstat(path, { bigint: true })
      if (identity.isSymbolicLink()) throw new DirectoryPromotionError("INVALID_DIRECTORY_ENTRY", `staging contents must not contain symlinks: ${path}`)
      if (identity.isDirectory()) {
        hash.update(`d\0${relativePath}\0${identity.mode}\0`)
        await visit(path, relativePath)
      } else if (identity.isFile()) {
        const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
        try {
          const openedIdentity = await handle.stat({ bigint: true })
          if (!openedIdentity.isFile() || !sameIdentity(identity, openedIdentity)) {
            throw new DirectoryPromotionError("STAGING_CONTENT_CHANGED", `staging file changed while it was inspected: ${path}`)
          }
          hash.update(`f\0${relativePath}\0${openedIdentity.mode}\0${openedIdentity.size}\0`)
          hash.update(await handle.readFile())
        } finally {
          await handle.close()
        }
      } else {
        throw new DirectoryPromotionError("INVALID_DIRECTORY_ENTRY", `staging contents must contain only files and directories: ${path}`)
      }
    }
  }
  await visit(root)
  return hash.digest("hex")
}

async function copyContainedRegularFile(root, file, target) {
  const source = await openContainedRegularFile(root, file)
  try {
    await writeFile(target, await source.readFile())
  } finally {
    await source.close()
  }
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

async function readContainedRegularFile(root, file, encoding) {
  const handle = await openContainedRegularFile(root, file)
  try {
    return await handle.readFile(encoding)
  } finally {
    await handle.close()
  }
}

function isContainedPath(root, candidate) {
  const path = relative(root, candidate)
  return path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(path)
}

export async function reclaimStaleStages(parent) {
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    if (!entry.name.startsWith(stagePrefix) || !entry.isDirectory()) continue
    const path = resolve(parent, entry.name)
    const match = /^\.runtime-cloudflare-core-stage-(\d+)-/.exec(entry.name)
    const pid = Number(match?.[1])
    const age = Date.now() - Number((await lstat(path)).mtimeMs)
    if (age < staleStageAgeMs && (pid === process.pid || processIsAlive(pid))) continue
    await rm(path, { recursive: true, force: true })
  }
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

async function assertContractTree(candidateRoot, generatedRoot, generatedFiles, version, tag) {
  const candidateFiles = (await filesBelow(candidateRoot)).filter((file) => file !== "package.json")
  assert.deepEqual(candidateFiles, generatedFiles, "vendored core files must be the complete generated contract dependency closure")
  for (const file of generatedFiles) {
    assert.deepEqual(await readFile(resolve(candidateRoot, file)), await readFile(resolve(generatedRoot, file)), `vendored core contract drifted from ${tag}: ${file}`)
  }
  const candidatePackage = JSON.parse(await readFile(resolve(candidateRoot, "package.json"), "utf8"))
  assert.deepEqual(candidatePackage, compatibilityPackage(version), "vendored package metadata must expose only the selected generated release contracts")
  await assertContractBehavior(candidateRoot, generatedRoot)
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

export async function contractFiles(root) {
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
  return [...files].sort()
}

async function assertContractBehavior(candidateRoot, generatedRoot) {
  const generatedArchive = await import(`${pathToFileURL(resolve(generatedRoot, "runtime-archive-component.js")).href}?generated`)
  const vendorArchive = await import(`${pathToFileURL(resolve(candidateRoot, "runtime-archive-component.js")).href}?candidate`)
  const generatedProfile = await import(`${pathToFileURL(resolve(generatedRoot, "runtime-package-profile.js")).href}?generated`)
  const vendorProfile = await import(`${pathToFileURL(resolve(candidateRoot, "runtime-package-profile.js")).href}?candidate`)
  const generatedResult = await import(`${pathToFileURL(resolve(generatedRoot, "runtime-command-result.js")).href}?generated`)
  const vendorResult = await import(`${pathToFileURL(resolve(candidateRoot, "runtime-command-result.js")).href}?candidate`)
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
