import { createHash } from "node:crypto"
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const COMMIT = /^[0-9a-f]{40}$/i
const DIGEST = /^[0-9a-f]{64}$/i
const DIGEST_SCHEME = "sha256-bytes-v1"
const MAX_PACKAGE_BYTES = 1024 * 1024
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const ROLE = /^(component|provider_plugin|bundled_library)$/
const string = (value) => typeof value === "string" ? value.trim() : ""

export function canonicalExternalNativeAgentIdentity(bytes) {
  let packageDocument
  try {
    packageDocument = JSON.parse(Buffer.from(bytes).toString("utf8"))
  } catch {
    throw new Error("External native package must contain valid UTF-8 JSON.")
  }
  if (!packageDocument || typeof packageDocument !== "object" || Array.isArray(packageDocument) || packageDocument.schema_version !== 1 || !SLUG.test(packageDocument.bundle_slug)) {
    throw new Error("External native package must use the canonical flat schema_version 1 and bundle_slug contract.")
  }
  const agent = packageDocument.agent
  if (!agent || typeof agent !== "object" || Array.isArray(agent) || typeof agent.agent_slug !== "string" || !SLUG.test(agent.agent_slug)) {
    throw new Error("External native package must declare exactly one canonical agent.agent_slug identity.")
  }
  if (["slug", "agent_slug", "package_slug", "agents"].some((field) => Object.hasOwn(packageDocument, field)) || Object.hasOwn(agent, "slug")) {
    throw new Error("External native package contains ambiguous agent identities.")
  }
  return { slug: agent.agent_slug }
}

function normalizePath(value) {
  const path = value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")
  if (!path || path.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("external_package_source.path must be a non-empty relative path without traversal.")
  return path
}

function normalizeRuntimePath(value) {
  if (string(value) === ".") return "."
  return normalizePath(value)
}

export function sha256BytesV1(bytes) {
  return `${DIGEST_SCHEME}:${createHash("sha256").update(bytes).digest("hex")}`
}

export function canonicalPublicGithubRepositorySource(repository) {
  const normalized = string(repository).toLowerCase()
  if (!REPOSITORY.test(normalized)) throw new Error("external_package_source.repository must be an OWNER/REPO identifier.")
  return `https://github.com/${normalized}.git`
}

function normalizeDigest(value) {
  const [scheme, digest] = string(value).split(":", 2)
  if (scheme !== DIGEST_SCHEME || !DIGEST.test(digest)) throw new Error(`external_package_source.digest must use ${DIGEST_SCHEME}:<64 lowercase hexadecimal characters>.`)
  return `${scheme}:${digest.toLowerCase()}`
}

export function normalizeExternalPackageSource(value, policy = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {}
  const repository = string(source.repository).toLowerCase()
  const revision = string(source.revision).toLowerCase()
  const path = normalizePath(string(source.path))
  const digest = normalizeDigest(source.digest)
  if (!REPOSITORY.test(repository)) throw new Error("external_package_source.repository must be an OWNER/REPO identifier.")
  if (!COMMIT.test(revision)) throw new Error("external_package_source.revision must be a full immutable 40-character commit SHA.")
  if (!path.endsWith(".agent.json")) throw new Error("external_package_source.path must identify exactly one standalone .agent.json file.")
  const allowedPaths = policy.repositories?.[repository]
  if (!Array.isArray(allowedPaths)) throw new Error("External package repository is not authorized.")
  if (!allowedPaths.some((entry) => {
    const pattern = string(entry)
    if (!pattern) return false
    if (pattern.endsWith("/*")) return path.startsWith(`${normalizePath(pattern.slice(0, -2))}/`)
    return path === normalizePath(pattern)
  })) throw new Error("External package path is not authorized.")
  return { repository, revision, path, digest }
}

export function parseExternalPackageSourcePolicy(raw) {
  let policy
  try {
    policy = JSON.parse(string(raw))
  } catch {
    throw new Error("EXTERNAL_PACKAGE_SOURCE_POLICY must be valid JSON.")
  }
  if (!policy || typeof policy !== "object" || Array.isArray(policy) || policy.version !== 1 || !policy.repositories || typeof policy.repositories !== "object" || Array.isArray(policy.repositories)) {
    throw new Error("EXTERNAL_PACKAGE_SOURCE_POLICY must be a version 1 policy with a repositories mapping.")
  }
  const repositories = {}
  for (const [repository, paths] of Object.entries(policy.repositories)) {
    const normalizedRepository = string(repository).toLowerCase()
    if (!REPOSITORY.test(normalizedRepository) || !Array.isArray(paths) || paths.length === 0) throw new Error("EXTERNAL_PACKAGE_SOURCE_POLICY contains an invalid repository entry.")
    repositories[normalizedRepository] = paths.map((path) => {
      const value = string(path)
      if (!value || value.includes("*")) throw new Error("EXTERNAL_PACKAGE_SOURCE_POLICY paths must be exact standalone .agent.json paths.")
      const agentPath = normalizePath(value)
      if (!agentPath.endsWith(".agent.json")) throw new Error("EXTERNAL_PACKAGE_SOURCE_POLICY paths must identify standalone .agent.json files.")
      return agentPath
    })
  }
  const runtime_sources = normalizeRuntimeSourcePolicy(policy.runtime_sources)
  if (Object.keys(repositories).length === 0 && Object.keys(runtime_sources).length === 0) throw new Error("EXTERNAL_PACKAGE_SOURCE_POLICY must authorize at least one repository.")
  return { version: 1, repositories, runtime_sources }
}

function normalizeRuntimeSourcePolicy(value) {
  if (value === undefined) return {}
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("EXTERNAL_PACKAGE_SOURCE_POLICY runtime_sources must be a repositories mapping.")
  const repositories = {}
  for (const [repository, paths] of Object.entries(value)) {
    const normalizedRepository = string(repository).toLowerCase()
    if (!REPOSITORY.test(normalizedRepository) || !Array.isArray(paths) || paths.length === 0) throw new Error("EXTERNAL_PACKAGE_SOURCE_POLICY contains an invalid runtime source repository entry.")
    repositories[normalizedRepository] = paths.map((path) => normalizeRuntimePath(string(path)))
  }
  return repositories
}

export function normalizeRuntimeSources(value, policy = {}) {
  if (!Array.isArray(value)) throw new Error("runtime_sources must be a JSON array.")
  return value.map((entry, index) => normalizeRuntimeSource(entry, policy, `runtime_sources[${index}]`))
}

export function normalizeRuntimeSource(value, policy = {}, label = "runtime_source") {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {}
  if (source.version !== 1) throw new Error(`${label}.version must be 1.`)
  const role = string(source.role)
  const repository = string(source.repository).toLowerCase()
  const revision = string(source.revision).toLowerCase()
  const path = normalizeRuntimePath(string(source.path))
  if (!ROLE.test(role)) throw new Error(`${label}.role must be component, provider_plugin, or bundled_library.`)
  if (!REPOSITORY.test(repository)) throw new Error(`${label}.repository must be an OWNER/REPO identifier.`)
  if (!COMMIT.test(revision)) throw new Error(`${label}.revision must be a full immutable 40-character commit SHA.`)
  const allowedPaths = policy.runtime_sources?.[repository]
  if (!Array.isArray(allowedPaths) || !allowedPaths.includes(path)) throw new Error("Runtime source repository or path is not authorized.")
  const digest = source.digest === undefined || source.digest === "" ? undefined : normalizeRuntimeDigest(source.digest, label)
  const metadata = source.metadata && typeof source.metadata === "object" && !Array.isArray(source.metadata) ? source.metadata : {}
  const normalized = { version: 1, role, repository, revision, path, ...(digest ? { digest } : {}), metadata: normalizeRuntimeMetadata(role, metadata, label) }
  return normalized
}

function normalizeRuntimeDigest(value, label) {
  const [scheme, digest] = string(value).split(":", 2)
  if (scheme !== "sha256-git-archive-v1" || !DIGEST.test(digest)) throw new Error(`${label}.digest must use sha256-git-archive-v1:<64 lowercase hexadecimal characters>.`)
  return `${scheme}:${digest.toLowerCase()}`
}

function normalizeRuntimeMetadata(role, metadata, label) {
  const slug = string(metadata.slug)
  const pluginFile = string(metadata.pluginFile)
  const activate = metadata.activate
  if (role === "component") {
    if (!SLUG.test(slug) || !["plugin", "mu-plugin"].includes(metadata.loadAs)) throw new Error(`${label}.metadata must declare a slug and loadAs plugin or mu-plugin for a component.`)
    if (pluginFile && !normalizePath(pluginFile)) throw new Error(`${label}.metadata.pluginFile must be a safe relative path.`)
    if (activate !== undefined && typeof activate !== "boolean") throw new Error(`${label}.metadata.activate must be boolean when provided.`)
    return { slug, loadAs: metadata.loadAs, ...(pluginFile ? { pluginFile } : {}), ...(activate === undefined ? {} : { activate }) }
  }
  if (role === "provider_plugin") {
    if (slug && !SLUG.test(slug)) throw new Error(`${label}.metadata.slug must be a stable plugin slug.`)
    if (pluginFile && !normalizePath(pluginFile)) throw new Error(`${label}.metadata.pluginFile must be a safe relative path.`)
    if (activate !== undefined && typeof activate !== "boolean") throw new Error(`${label}.metadata.activate must be boolean when provided.`)
    return { ...(slug ? { slug } : {}), ...(pluginFile ? { pluginFile } : {}), ...(activate === undefined ? { activate: true } : { activate }) }
  }
  if (!SLUG.test(string(metadata.library)) || !SLUG.test(string(metadata.strategy))) throw new Error(`${label}.metadata must declare library and strategy for a bundled library.`)
  const target = string(metadata.target)
  if (target && (!target.startsWith("/") || target.split("/").includes(".."))) throw new Error(`${label}.metadata.target must be an absolute path without traversal.`)
  return { library: string(metadata.library), strategy: string(metadata.strategy), ...(target ? { target } : {}) }
}

export function sha256GitArchiveV1(bytes) {
  return `sha256-git-archive-v1:${createHash("sha256").update(bytes).digest("hex")}`
}

export async function materializeRuntimeSources(sources, options = {}) {
  const descriptors = normalizeRuntimeSources(sources, options.policy)
  const root = await mkdtemp(join(options.tempRoot ?? tmpdir(), "wp-codebox-runtime-sources-"))
  try {
    const lowered = []
    for (const [index, descriptor] of descriptors.entries()) {
      const checkout = join(root, `source-${index}`)
      const source = join(checkout, "source")
      const environment = publicGitEnvironment(root)
      const remote = options.remotes?.[descriptor.repository] ?? canonicalPublicGithubRepositorySource(descriptor.repository)
      await run("git", ["init", "--quiet", checkout], { env: environment })
      await run("git", ["remote", "add", "origin", remote], { cwd: checkout, env: environment })
      await run("git", ["-c", "credential.helper=", "-c", "http.extraHeader=", "fetch", "--depth=1", "origin", descriptor.revision], { cwd: checkout, env: environment })
      const commit = (await run("git", ["rev-parse", "FETCH_HEAD^{commit}"], { cwd: checkout, env: environment })).toString("utf8").trim().toLowerCase()
      if (commit !== descriptor.revision) throw new Error("Runtime source revision did not resolve to the requested immutable commit.")
      const objectType = (await run("git", ["cat-file", "-t", `${descriptor.revision}:${descriptor.path}`], { cwd: checkout, env: environment })).toString("utf8").trim()
      if (objectType !== "tree") throw new Error("Runtime source path must identify a directory.")
      const entries = (await run("git", ["ls-tree", "-r", "-z", descriptor.revision, "--", descriptor.path], { cwd: checkout, env: environment })).toString("utf8").split("\0").filter(Boolean)
      if (entries.length === 0 || entries.some((entry) => !/^100(?:644|755)\s+blob\s+[0-9a-f]{40}\t/.test(entry))) throw new Error("Runtime source must contain only regular files; symlinks and special files are rejected.")
      const archive = await run("git", ["archive", "--format=tar", descriptor.revision, descriptor.path], { cwd: checkout, env: environment })
      if (descriptor.digest && sha256GitArchiveV1(archive) !== descriptor.digest) throw new Error("Runtime source archive digest does not match the trusted descriptor.")
      await mkdir(source, { recursive: true })
      const archivePath = join(checkout, "source.tar")
      await writeFile(archivePath, archive)
      await run("tar", ["-xf", archivePath, "-C", source], { cwd: checkout, env: environment })
      const materializedPath = join(source, descriptor.path)
      lowered.push(lowerRuntimeSource(descriptor, materializedPath))
    }
    return { root, descriptors, lowered }
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error }
}

export function lowerRuntimeSource(descriptor, source) {
  const provenance = { role: descriptor.role, repository: descriptor.repository, revision: descriptor.revision, path: descriptor.path, ...(descriptor.digest ? { digest: descriptor.digest } : {}) }
  if (descriptor.role === "component") return { component_contracts: [{ path: source, ...descriptor.metadata, metadata: { runtime_source: provenance } }] }
  if (descriptor.role === "provider_plugin") return { provider_plugin_paths: [source], provider_plugins: [{ source, ...descriptor.metadata, metadata: { runtime_source: provenance } }] }
  return { runtime_overlays: [{ kind: "bundled-library", source, ...descriptor.metadata, metadata: { runtime_source: provenance } }] }
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

export function publicGitEnvironment(home) {
  return {
    PATH: process.env.PATH || "",
    HOME: home,
    XDG_CONFIG_HOME: join(home, "config"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/false",
  }
}

export async function materializeExternalNativePackage(source, options = {}) {
  const descriptor = normalizeExternalPackageSource(source, options.policy)
  const root = await mkdtemp(join(options.tempRoot ?? tmpdir(), "wp-codebox-native-package-")); const checkout = join(root, "checkout")
  try {
    // Source acquisition is always an unauthenticated public Git transport. The
    // optional remote exists only for hermetic transport tests; workflow callers
    // always use the canonical GitHub HTTPS origin.
    const remote = options.remote ?? canonicalPublicGithubRepositorySource(descriptor.repository)
    const environment = publicGitEnvironment(root)
    await run("git", ["init", "--quiet", checkout], { env: environment }); await run("git", ["remote", "add", "origin", remote], { cwd: checkout, env: environment })
    await run("git", ["-c", "credential.helper=", "-c", "http.extraHeader=", "fetch", "--depth=1", "origin", descriptor.revision], { cwd: checkout, env: environment })
    const commit = (await run("git", ["rev-parse", "FETCH_HEAD^{commit}"], { cwd: checkout, env: environment })).toString("utf8").trim().toLowerCase()
    if (commit !== descriptor.revision) throw new Error("External package revision did not resolve to the requested immutable commit.")
    const objectType = (await run("git", ["cat-file", "-t", `${descriptor.revision}:${descriptor.path}`], { cwd: checkout, env: environment })).toString("utf8").trim()
    if (objectType !== "blob") throw new Error("External native package source must identify a standalone .agent.json file, not a directory or package envelope.")
    const bytes = await run("git", ["show", `${descriptor.revision}:${descriptor.path}`], { cwd: checkout, env: environment })
    if (bytes.length === 0 || bytes.length > MAX_PACKAGE_BYTES) throw new Error("External native package source must be between 1 byte and 1 MiB.")
    if (sha256BytesV1(bytes) !== descriptor.digest) throw new Error("External package byte digest does not match the trusted descriptor.")
    const identity = canonicalExternalNativeAgentIdentity(bytes)
    await rm(root, { recursive: true, force: true })
    return { bytes, descriptor, identity }
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error }
}
