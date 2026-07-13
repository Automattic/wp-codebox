import { createHash } from "node:crypto"
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { spawn } from "node:child_process"

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const COMMIT = /^[0-9a-f]{40}$/i
const DIGEST = /^[0-9a-f]{64}$/i
const string = (value) => typeof value === "string" ? value.trim() : ""

function normalizePath(value) {
  const path = value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")
  if (!path || path.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("external_package_source.path must be a non-empty relative path without traversal.")
  return path
}

export function normalizeExternalPackageSource(value, policy = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {}
  const repository = string(source.repository).toLowerCase()
  const revision = string(source.revision).toLowerCase()
  const path = normalizePath(string(source.path))
  const sha256 = string(source.sha256).toLowerCase()
  if (!REPOSITORY.test(repository)) throw new Error("external_package_source.repository must be an OWNER/REPO identifier.")
  if (!COMMIT.test(revision)) throw new Error("external_package_source.revision must be a full immutable 40-character commit SHA.")
  if (!DIGEST.test(sha256)) throw new Error("external_package_source.sha256 must be a SHA-256 digest.")
  const repositories = Array.isArray(policy.allowed_repositories) ? policy.allowed_repositories.map((entry) => string(entry).toLowerCase()) : []
  if (!repositories.includes(repository)) throw new Error("External package repository is not authorized.")
  const paths = Array.isArray(policy.allowed_paths) ? policy.allowed_paths : []
  if (paths.length && !paths.some((pattern) => {
    const normalized = normalizePath(string(pattern).replace(/\*$/, ""))
    return string(pattern).endsWith("*") ? path.startsWith(normalized) : path === normalized || path.startsWith(`${normalized}/`)
  })) throw new Error("External package path is not authorized.")
  return { repository, revision, path, sha256 }
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: options.stdio ?? ["ignore", "pipe", "pipe"] })
    const stdout = []; const stderr = []
    child.stdout?.on("data", (chunk) => stdout.push(chunk)); child.stderr?.on("data", (chunk) => stderr.push(chunk))
    child.on("error", reject)
    if (options.input) child.stdin?.end(options.input)
    child.on("close", (code) => code === 0 ? resolveRun(Buffer.concat(stdout)) : reject(new Error(`${command} failed: ${Buffer.concat(stderr).toString("utf8").trim()}`)))
  })
}

export async function packageDirectorySha256(root) {
  const files = []
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name); const relativePath = relative(root, path).replace(/\\/g, "/"); const info = await lstat(path)
      if (info.isSymbolicLink()) throw new Error(`External package contains a symbolic link: ${relativePath}`)
      if (info.isDirectory()) await visit(path)
      else if (info.isFile()) files.push({ path, relativePath, mode: info.mode & 0o777 })
      else throw new Error(`External package contains an unsupported file type: ${relativePath}`)
    }
  }
  await visit(root)
  const digest = createHash("sha256")
  for (const file of files.sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    digest.update(`${file.relativePath}\0${file.mode.toString(8)}\0`); digest.update(createHash("sha256").update(await readFile(file.path)).digest("hex")); digest.update("\n")
  }
  return digest.digest("hex")
}

async function makeReadOnly(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) { const path = join(root, entry.name); if (entry.isDirectory()) await makeReadOnly(path); await chmod(path, entry.isDirectory() ? 0o555 : 0o444) }
  await chmod(root, 0o555)
}

export async function materializeExternalNativePackage(source, options = {}) {
  const descriptor = normalizeExternalPackageSource(source, options.policy)
  const root = await mkdtemp(join(options.tempRoot ?? tmpdir(), "wp-codebox-native-package-")); const checkout = join(root, "checkout"); const packageRoot = join(root, "package")
  try {
    await run("git", ["init", "--quiet", checkout]); await run("git", ["remote", "add", "origin", options.remote ?? `https://github.com/${descriptor.repository}.git`], { cwd: checkout })
    const token = string(options.token)
    await run("git", token ? ["-c", `http.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`, "fetch", "--depth=1", "origin", descriptor.revision] : ["fetch", "--depth=1", "origin", descriptor.revision], { cwd: checkout })
    const commit = (await run("git", ["rev-parse", "FETCH_HEAD^{commit}"], { cwd: checkout })).toString("utf8").trim().toLowerCase()
    if (commit !== descriptor.revision) throw new Error("External package revision did not resolve to the requested immutable commit.")
    await mkdir(packageRoot); const archive = await run("git", ["archive", "--format=tar", descriptor.revision, descriptor.path], { cwd: checkout })
    await run("tar", ["-x", "-C", packageRoot, "--strip-components", String(descriptor.path.split("/").length)], { stdio: ["pipe", "ignore", "pipe"], input: archive })
    if (!(await stat(join(packageRoot, ".agent.json")).catch(() => null))) throw new Error("External native package must contain a standalone .agent.json file.")
    if (await packageDirectorySha256(packageRoot) !== descriptor.sha256) throw new Error("External package SHA-256 digest does not match the trusted descriptor.")
    await makeReadOnly(packageRoot); await rm(checkout, { recursive: true, force: true })
    return { source: packageRoot, descriptor }
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error }
}
