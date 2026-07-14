import { createHash } from "node:crypto"
import { mkdtemp, rm, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"
import { spawn } from "node:child_process"

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const COMMIT = /^[0-9a-f]{40}$/i
const DIGEST = /^[0-9a-f]{64}$/i
const DIGEST_SCHEME = "sha256-bytes-v1"
const MAX_PACKAGE_BYTES = 1024 * 1024
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const ROLE = /^(component|provider_plugin|bundled_library)$/
const HTTPS_URL = /^https:\/\//i
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024
const MAX_ZIP_ENTRIES = 10_000
const MAX_ZIP_UNCOMPRESSED_BYTES = 128 * 1024 * 1024
const MAX_ZIP_FILE_BYTES = 32 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 30_000
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
  const runtime_artifacts = normalizeRuntimeArtifactPolicy(policy.runtime_artifacts)
  if (Object.keys(repositories).length === 0 && Object.keys(runtime_sources).length === 0 && Object.keys(runtime_artifacts).length === 0) throw new Error("EXTERNAL_PACKAGE_SOURCE_POLICY must authorize at least one source.")
  return { version: 1, repositories, runtime_sources, runtime_artifacts }
}

function normalizeRuntimeArtifactPolicy(value) {
  if (value === undefined) return {}
  if (!Array.isArray(value)) throw new Error("EXTERNAL_PACKAGE_SOURCE_POLICY runtime_artifacts must be an array.")
  const artifacts = {}
  for (const entry of value) {
    const artifact = entry && typeof entry === "object" && !Array.isArray(entry) ? entry : {}
    const url = normalizeHttpsUrl(artifact.url, "EXTERNAL_PACKAGE_SOURCE_POLICY runtime_artifacts.url")
    const sha256 = normalizeSha256(artifact.sha256, "EXTERNAL_PACKAGE_SOURCE_POLICY runtime_artifacts.sha256")
    if (Object.hasOwn(artifacts, url)) throw new Error("EXTERNAL_PACKAGE_SOURCE_POLICY runtime_artifacts must not repeat URLs.")
    artifacts[url] = sha256
  }
  return artifacts
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
  const sources = value.map((entry, index) => normalizeRuntimeSource(entry, policy, `runtime_sources[${index}]`))
  const pluginSlugs = new Set()
  const overlayTargets = new Set()
  for (const source of sources) {
    if (source.role === "bundled_library") {
      const target = source.metadata.target || `${source.metadata.library}/${source.metadata.strategy}`
      if (overlayTargets.has(target)) throw new Error(`runtime_sources contains a colliding bundled library target: ${target}`)
      overlayTargets.add(target)
      continue
    }
    const slug = source.metadata.slug
    if (pluginSlugs.has(slug)) throw new Error(`runtime_sources contains a duplicate plugin slug: ${slug}`)
    pluginSlugs.add(slug)
  }
  return sources
}

export function normalizeRuntimeSource(value, policy = {}, label = "runtime_source") {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {}
  if (source.version !== 1) throw new Error(`${label}.version must be 1.`)
  const role = string(source.role)
  const sourceDescriptor = source.source && typeof source.source === "object" && !Array.isArray(source.source) ? source.source : undefined
  if (sourceDescriptor?.type === "https_zip") return normalizeHttpsZipRuntimeSource(source, sourceDescriptor, policy, label)
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

function normalizeHttpsZipRuntimeSource(source, artifact, policy, label) {
  const role = string(source.role)
  if (!/^(component|provider_plugin)$/.test(role)) throw new Error(`${label}.source https_zip supports component and provider_plugin roles.`)
  if (Object.keys(source).some((key) => ["repository", "revision", "path", "digest"].includes(key))) throw new Error(`${label}.source https_zip must not mix Git source fields.`)
  const url = normalizeHttpsUrl(artifact.url, `${label}.source.url`)
  const sha256 = normalizeSha256(artifact.sha256, `${label}.source.sha256`)
  const archive_root = artifact.archive_root === undefined ? "" : normalizePath(string(artifact.archive_root))
  if (Object.keys(artifact).some((key) => !["type", "url", "sha256", "archive_root"].includes(key))) throw new Error(`${label}.source https_zip contains an unsupported field.`)
  const expectedDigest = policy.runtime_artifacts?.[url]
  if (expectedDigest === undefined) throw new Error("Runtime artifact URL is not authorized.")
  if (expectedDigest !== sha256) throw new Error("Runtime artifact digest does not match its trusted policy.")
  const metadata = source.metadata && typeof source.metadata === "object" && !Array.isArray(source.metadata) ? source.metadata : {}
  return { version: 1, role, source: { type: "https_zip", url, sha256, ...(archive_root ? { archive_root } : {}) }, metadata: normalizeRuntimeMetadata(role, metadata, label) }
}

function normalizeHttpsUrl(value, label) {
  const url = string(value)
  if (!HTTPS_URL.test(url)) throw new Error(`${label} must be an HTTPS URL.`)
  let parsed
  try { parsed = new URL(url) } catch { throw new Error(`${label} must be an HTTPS URL.`) }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) throw new Error(`${label} must be a canonical HTTPS URL without credentials or fragments.`)
  return parsed.toString()
}

function normalizeSha256(value, label) {
  const digest = string(value).toLowerCase()
  if (!DIGEST.test(digest)) throw new Error(`${label} must be exactly 64 hexadecimal SHA-256 characters.`)
  return digest
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
    assertPrivateRuntimeRoot(root, options.forbiddenRoots)
    const lowered = []
    for (const [index, descriptor] of descriptors.entries()) {
      if (descriptor.source?.type === "https_zip") {
        const materializedPath = await materializeHttpsZipRuntimeSource(descriptor, root, index, options)
        await assertRuntimePluginEntrypoint(descriptor, materializedPath)
        lowered.push(lowerRuntimeSource(descriptor, materializedPath))
        continue
      }
      const checkout = join(root, `source-${index}`)
      const source = join(checkout, "source")
      const environment = publicGitEnvironment(root)
      const remote = options.remotes?.[descriptor.repository] ?? canonicalPublicGithubRepositorySource(descriptor.repository)
      await run("git", ["init", "--quiet", checkout], { env: environment })
      await run("git", ["remote", "add", "origin", remote], { cwd: checkout, env: environment })
      await run("git", ["-c", "credential.helper=", "-c", "http.extraHeader=", "fetch", "--depth=1", "origin", descriptor.revision], { cwd: checkout, env: environment })
      const commit = (await run("git", ["rev-parse", "FETCH_HEAD^{commit}"], { cwd: checkout, env: environment })).toString("utf8").trim().toLowerCase()
      if (commit !== descriptor.revision) throw new Error("Runtime source revision did not resolve to the requested immutable commit.")
      const sourceObject = descriptor.path === "." ? `${descriptor.revision}^{tree}` : `${descriptor.revision}:${descriptor.path}`
      const objectType = (await run("git", ["cat-file", "-t", sourceObject], { cwd: checkout, env: environment })).toString("utf8").trim()
      if (objectType !== "tree") throw new Error("Runtime source path must identify a directory.")
      const entries = (await run("git", descriptor.path === "." ? ["ls-tree", "-r", "-z", descriptor.revision] : ["ls-tree", "-r", "-z", descriptor.revision, "--", descriptor.path], { cwd: checkout, env: environment })).toString("utf8").split("\0").filter(Boolean)
      if (entries.length === 0 || entries.some((entry) => !/^100(?:644|755)\s+blob\s+[0-9a-f]{40}\t/.test(entry))) throw new Error("Runtime source must contain only regular files; symlinks and special files are rejected.")
      const archive = await run("git", descriptor.path === "." ? ["archive", "--format=tar", descriptor.revision] : ["archive", "--format=tar", descriptor.revision, descriptor.path], { cwd: checkout, env: environment })
      if (descriptor.digest && sha256GitArchiveV1(archive) !== descriptor.digest) throw new Error("Runtime source archive digest does not match the trusted descriptor.")
      await mkdir(source, { recursive: true })
      const archivePath = join(checkout, "source.tar")
      await writeFile(archivePath, archive)
      await run("tar", ["-xf", archivePath, "-C", source], { cwd: checkout, env: environment })
      const materializedPath = descriptor.path === "." ? source : join(source, descriptor.path)
      if (descriptor.role !== "bundled_library") await assertRuntimePluginEntrypoint(descriptor, materializedPath)
      lowered.push(lowerRuntimeSource(descriptor, materializedPath))
    }
    return { root, descriptors: descriptors.map(runtimeSourceProvenance), lowered }
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error }
}

async function materializeHttpsZipRuntimeSource(descriptor, root, index, options) {
  const checkout = join(root, `source-${index}`)
  const archive = await fetchTrustedZip(descriptor.source.url, options.policy, options.fetch)
  if (archive.length === 0 || archive.length > MAX_ARTIFACT_BYTES) throw new Error("Runtime ZIP artifact exceeds the bounded download size.")
  if (createHash("sha256").update(archive).digest("hex") !== descriptor.source.sha256) throw new Error("Runtime ZIP artifact digest does not match the descriptor.")
  const entries = inspectZipArchive(archive, descriptor.source.archive_root)
  const extractionRoot = join(checkout, "source")
  await mkdir(extractionRoot, { recursive: true })
  const archivePath = join(checkout, "source.zip")
  await writeFile(archivePath, archive)
  for (const entry of entries) {
    const destination = join(extractionRoot, entry.name)
    if (entry.directory) {
      await mkdir(destination, { recursive: true })
      continue
    }
    await mkdir(join(destination, ".."), { recursive: true })
    const contents = await run("unzip", ["-p", archivePath, entry.name], { maxOutputBytes: entry.uncompressedSize + 1 })
    if (contents.length !== entry.uncompressedSize) throw new Error("Runtime ZIP artifact entry size did not match its verified central directory.")
    await writeFile(destination, contents)
  }
  return join(extractionRoot, descriptor.source.archive_root || entries[0].name.split("/")[0])
}

async function fetchTrustedZip(url, policy, fetchImpl = fetch) {
  let current = url
  for (let redirects = 0; redirects < 3; redirects++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
    let response
    try { response = await fetchImpl(current, { redirect: "manual", signal: controller.signal }) } finally { clearTimeout(timer) }
    if (response.status >= 300 && response.status < 400) {
      const next = response.headers.get("location")
      if (!next) throw new Error("Runtime ZIP artifact redirect was missing a location.")
      current = new URL(next, current).toString()
      if (policy.runtime_artifacts?.[current] === undefined || new URL(current).protocol !== "https:" || new URL(current).host !== new URL(url).host) throw new Error("Runtime ZIP artifact redirect is not an allowlisted HTTPS URL on the original host.")
      continue
    }
    if (!response.ok || !response.body) throw new Error(`Runtime ZIP artifact download failed with HTTP ${response.status}.`)
    const length = Number(response.headers.get("content-length") || 0)
    if (length > MAX_ARTIFACT_BYTES) throw new Error("Runtime ZIP artifact exceeds the bounded download size.")
    const chunks = []; let size = 0
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > MAX_ARTIFACT_BYTES) throw new Error("Runtime ZIP artifact exceeds the bounded download size.")
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  }
  throw new Error("Runtime ZIP artifact exceeded the redirect limit.")
}

export function inspectZipArchive(bytes, expectedRoot = "") {
  const directory = []
  const endOfCentralDirectory = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (endOfCentralDirectory < 0 || endOfCentralDirectory + 22 > bytes.length) throw new Error("Runtime ZIP artifact is missing a valid central directory.")
  const entriesCount = bytes.readUInt16LE(endOfCentralDirectory + 10)
  const centralDirectorySize = bytes.readUInt32LE(endOfCentralDirectory + 12)
  const centralDirectoryOffset = bytes.readUInt32LE(endOfCentralDirectory + 16)
  if (entriesCount === 0xffff || centralDirectorySize === 0xffffffff || centralDirectoryOffset === 0xffffffff || centralDirectoryOffset + centralDirectorySize > endOfCentralDirectory) throw new Error("Runtime ZIP artifact contains unsupported ZIP64 entries.")
  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize
  for (let offset = centralDirectoryOffset; offset < centralDirectoryEnd;) {
    if (offset + 46 > centralDirectoryEnd || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error("Runtime ZIP artifact central directory is malformed.")
    const flags = bytes.readUInt16LE(offset + 8)
    const compressedSize = bytes.readUInt32LE(offset + 20)
    const uncompressedSize = bytes.readUInt32LE(offset + 24)
    const nameLength = bytes.readUInt16LE(offset + 28)
    const extraLength = bytes.readUInt16LE(offset + 30)
    const commentLength = bytes.readUInt16LE(offset + 32)
    const externalAttributes = bytes.readUInt32LE(offset + 38)
    const end = offset + 46 + nameLength + extraLength + commentLength
    if (end > centralDirectoryEnd || flags & 1 || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) throw new Error("Runtime ZIP artifact contains unsupported encrypted or ZIP64 entries.")
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8")
    const directoryEntry = name.endsWith("/")
    const mode = externalAttributes >>> 16
    const type = mode & 0o170000
    if (!safeZipEntryName(name) || (!directoryEntry && type && type !== 0o100000) || (directoryEntry && type && type !== 0o040000)) throw new Error("Runtime ZIP artifact contains a traversal, symlink, or special-file entry.")
    if (uncompressedSize > MAX_ZIP_FILE_BYTES) throw new Error("Runtime ZIP artifact contains an oversized entry.")
    directory.push({ name: directoryEntry ? name.slice(0, -1) : name, directory: directoryEntry, uncompressedSize })
    offset = end
  }
  if (directory.length !== entriesCount || directory.length === 0 || directory.length > MAX_ZIP_ENTRIES) throw new Error("Runtime ZIP artifact has an invalid number of entries.")
  if (directory.reduce((total, entry) => total + entry.uncompressedSize, 0) > MAX_ZIP_UNCOMPRESSED_BYTES) throw new Error("Runtime ZIP artifact exceeds the bounded extraction size.")
  const roots = new Set(directory.map((entry) => entry.name.split("/")[0]).filter(Boolean))
  if (roots.size !== 1) throw new Error("Runtime ZIP artifact must contain exactly one archive root.")
  const root = [...roots][0]
  if (expectedRoot && root !== expectedRoot) throw new Error("Runtime ZIP artifact archive root does not match the descriptor.")
  return directory
}

function safeZipEntryName(name) {
  const normalized = name.endsWith("/") ? name.slice(0, -1) : name
  return Boolean(normalized) && !normalized.includes("\\") && !normalized.includes("\0") && !normalized.startsWith("/") && !normalized.split("/").some((part) => !part || part === "." || part === "..")
}

async function assertRuntimePluginEntrypoint(descriptor, source) {
  const entries = await readdir(source, { withFileTypes: true })
  const phpFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".php"))
    .map((entry) => entry.name)
    .sort()
  const headers = []
  for (const file of phpFiles) {
    if (/^[\s\S]{0,8192}?Plugin Name:\s*\S/m.test(await readFile(join(source, file), "utf8"))) headers.push(file)
  }
  if (headers.length > 1) throw new Error(`Runtime plugin source contains multiple plugin entrypoints: ${headers.join(", ")}`)
  const declared = descriptor.metadata.pluginFile ? pluginFileWithinSource(descriptor.metadata.pluginFile, descriptor.metadata.slug) : ""
  const fallback = phpFiles.includes(`${descriptor.metadata.slug}.php`) ? `${descriptor.metadata.slug}.php` : phpFiles.includes("plugin.php") ? "plugin.php" : headers[0]
  const entrypoint = declared || fallback
  if (!entrypoint) throw new Error(`Runtime plugin source does not contain a plugin entrypoint for slug ${descriptor.metadata.slug}; top-level entries: ${entries.map((entry) => entry.name).sort().join(", ") || "none"}`)
  try {
    if (!(await stat(join(source, entrypoint))).isFile()) throw new Error()
  } catch {
    throw new Error(`Runtime plugin source does not contain declared plugin entrypoint ${entrypoint}`)
  }
}

function pluginFileWithinSource(pluginFile, slug) {
  const normalized = normalizePath(pluginFile)
  return normalized.startsWith(`${slug}/`) ? normalized.slice(slug.length + 1) : normalized
}

export function runtimeSourceProvenance(descriptor) {
  if (descriptor.source?.type === "https_zip") return { role: descriptor.role, source: { type: "https_zip", url: descriptor.source.url, sha256: descriptor.source.sha256, ...(descriptor.source.archive_root ? { archive_root: descriptor.source.archive_root } : {}) } }
  return { role: descriptor.role, repository: descriptor.repository, revision: descriptor.revision, path: descriptor.path, ...(descriptor.digest ? { digest: descriptor.digest } : {}) }
}

export function assertPrivateRuntimeRoot(root, forbiddenRoots = []) {
  const privateRoot = resolve(root)
  for (const forbiddenRoot of forbiddenRoots) {
    if (!forbiddenRoot) continue
    const boundary = resolve(forbiddenRoot)
    const path = relative(boundary, privateRoot)
    if (privateRoot === boundary || (!path.startsWith(`..${String.fromCharCode(47)}`) && path !== ".." && !isAbsolute(path))) {
      throw new Error("Runtime sources must be materialized outside target workspaces and artifacts.")
    }
  }
}

export function lowerRuntimeSource(descriptor, source) {
  const provenance = runtimeSourceProvenance(descriptor)
  if (descriptor.role === "component") return { component_contracts: [{ path: source, ...descriptor.metadata, metadata: { runtime_source: provenance } }] }
  if (descriptor.role === "provider_plugin") return { provider_plugin_paths: [source], provider_plugins: [{ source, ...descriptor.metadata, metadata: { runtime_source: provenance } }] }
  return { runtime_overlays: [{ kind: "bundled-library", source, ...descriptor.metadata, metadata: { runtime_source: provenance } }] }
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: options.stdio ?? ["ignore", "pipe", "pipe"] })
    const stdout = []; const stderr = []; let outputBytes = 0; let overflow = false
    child.stdout?.on("data", (chunk) => { outputBytes += chunk.length; if (options.maxOutputBytes && outputBytes > options.maxOutputBytes) { overflow = true; child.kill() } else stdout.push(chunk) }); child.stderr?.on("data", (chunk) => stderr.push(chunk))
    child.on("error", reject)
    if (options.input) child.stdin?.end(options.input)
    child.on("close", (code) => overflow ? reject(new Error(`${command} exceeded the bounded output size.`)) : code === 0 ? resolveRun(Buffer.concat(stdout)) : reject(new Error(`${command} failed: ${Buffer.concat(stderr).toString("utf8").trim()}`)))
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
