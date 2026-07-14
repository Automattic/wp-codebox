import { constants } from "node:fs"
import { lstat, mkdir, open, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { isUtf8 } from "node:buffer"
import { isAbsolute, join, relative, resolve } from "node:path"
import { assertNoRuntimeSourcePaths, sanitizeRuntimeSourceJson } from "./runtime-source-sanitizer.mjs"

const MAX_UPLOAD_FILE_BYTES = 4 * 1024 * 1024
const workspace = resolve(process.env.AGENT_TASK_WORKSPACE || process.cwd())
const uploadPath = resolve(process.env.AGENT_TASK_UPLOAD_PATH || join(workspace, ".codebox", "agent-task-upload"))
const requestPath = resolve(process.env.AGENT_TASK_REQUEST_PATH || join(workspace, ".codebox", "agent-task-request.json"))
const artifactsPath = join(workspace, ".codebox", "agent-task-artifacts")
const secretValues = ["OPENAI_API_KEY", "MODEL_PROVIDER_SECRET_1", "MODEL_PROVIDER_SECRET_2", "MODEL_PROVIDER_SECRET_3", "MODEL_PROVIDER_SECRET_4", "MODEL_PROVIDER_SECRET_5", "GITHUB_TOKEN", "GH_TOKEN", "ACCESS_TOKEN", "EXTERNAL_PACKAGE_SOURCE_POLICY"].map((name) => process.env[name]).filter(Boolean)
const runtimeSourceRoot = process.env.WP_CODEBOX_RUNTIME_SOURCE_ROOT ? resolve(process.env.WP_CODEBOX_RUNTIME_SOURCE_ROOT) : ""
const runtimeSourcePrefix = process.env.WP_CODEBOX_RUNTIME_SOURCE_PREFIX ? resolve(process.env.WP_CODEBOX_RUNTIME_SOURCE_PREFIX) : ""
const runtimeSourceRoots = [runtimeSourceRoot, runtimeSourcePrefix].filter(Boolean)
const SOURCE_TREE = /(^|\/)(prepared-plugins|prepared-source-packages|source-package[^/]*)(\/|$)/i
const SOURCE_FILE = /\.(?:php|phtml|js|mjs|cjs|jsx|ts|tsx)$/i
const PHP_OPENING_TAG = /<\?(?:php|=)(?:\s|$)/i
const PHP_DECLARATION = /\b(?:namespace\s+\\?[A-Za-z_]\w*(?:\\[A-Za-z_]\w*)*|(?:abstract\s+|final\s+|readonly\s+)*(?:class|interface|trait|enum)\s+[A-Za-z_]\w*|function\s+&?\s*[A-Za-z_]\w*\s*\()/i
const WORDPRESS_PLUGIN_HEADER = /\/\*[\s\S]{0,200}?\bPlugin Name\s*:/i

// Diagnostics commonly name runtime classes. Reject only PHP-shaped source, even
// when a source file has been disguised with a reviewer-safe extension.
function containsRuntimeSourceContent(text) {
  const hasPhpTag = PHP_OPENING_TAG.test(text)
  const hasDeclaration = PHP_DECLARATION.test(text)
  return (hasPhpTag && hasDeclaration) || (WORDPRESS_PLUGIN_HEADER.test(text) && (hasPhpTag || hasDeclaration))
}

function redact(value) {
  return secretValues.reduce((output, secret) => output.split(secret).join("[REDACTED]"), value)
}

function sanitizeText(text) {
  return sanitizeRuntimeSourceJson(text, runtimeSourceRoots)
}

function compactNativeInput(text) {
  const privateFields = new Set(["source_package_root", "component_contracts", "extra_plugins", "provider_plugins", "runtime_overlays", "prepared_sources"])
  const compact = (value) => {
    if (Array.isArray(value)) return value.map(compact)
    const entry = record(value)
    if (!Object.keys(entry).length) return value
    return Object.fromEntries(Object.entries(entry).flatMap(([key, item]) => privateFields.has(key) ? [] : [[key, compact(item)]]))
  }
  try {
    return `${JSON.stringify(compact(JSON.parse(sanitizeText(text))), null, 2)}\n`
  } catch {
    return sanitizeText(text)
  }
}

function isPrivateRuntimePath(value) {
  if (!runtimeSourceRoots.length || typeof value !== "string") return false
  const path = resolve(value)
  return runtimeSourceRoots.some((root) => {
    const contained = relative(root, path)
    return path === root || (contained !== ".." && !contained.startsWith(`..${String.fromCharCode(47)}`) && !isAbsolute(contained))
  })
}

function safeRelativeArtifactPath(value) {
  if (typeof value !== "string" || !value.trim() || isAbsolute(value)) return ""
  const path = value.replace(/\\/g, "/").replace(/^\.\//, "")
  if (path.split("/").some((part) => !part || part === "." || part === "..")) return ""
  return path
}

function sourceCategory(path, absolutePath) {
  if (isPrivateRuntimePath(absolutePath)) return "private-runtime"
  if (SOURCE_TREE.test(path)) return "source-tree"
  if (SOURCE_FILE.test(path)) return "source-file"
  return ""
}

async function stageTextFile(source, destination, options = {}) {
  const metadata = await lstat(source).catch(() => null)
  if (!metadata?.isFile() || metadata.size > MAX_UPLOAD_FILE_BYTES) return false
  const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null)
  if (!handle) return false
  const openedMetadata = await handle.stat()
  const contents = openedMetadata.isFile() && openedMetadata.size <= MAX_UPLOAD_FILE_BYTES ? await handle.readFile() : null
  await handle.close()
  if (!contents || contents.includes(0) || !isUtf8(contents)) return false
  const text = redact(options.compactNativeInput ? compactNativeInput(contents.toString("utf8")) : sanitizeText(contents.toString("utf8")))
  assertNoRuntimeSourcePaths(text, runtimeSourceRoots, "Runtime source paths must never be persisted in artifact uploads.")
  if (containsRuntimeSourceContent(text)) throw new Error("Prepared runtime plugin source contents must never be staged for artifact upload.")
  await mkdir(resolve(destination, ".."), { recursive: true })
  await writeFile(destination, text)
  return true
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {}
}

function declarations(request) {
  return (Array.isArray(record(request).artifacts?.declarations) ? record(request).artifacts.declarations : [])
    .flatMap((declaration) => {
      const entry = record(declaration)
      return typeof entry.name === "string" && entry.name.trim()
        ? [{ name: entry.name.trim(), type: typeof entry.type === "string" ? entry.type.trim() : "" }]
        : []
    })
}

function declaredArtifactPaths(result, allowed) {
  const paths = new Set()
  const visit = (value) => {
    if (Array.isArray(value)) return value.forEach(visit)
    const entry = record(value)
    if (!Object.keys(entry).length) return
    const artifact = record(entry.artifact)
    const path = safeRelativeArtifactPath(artifact.path)
    const declared = allowed.some((candidate) => candidate.name === entry.name && (!candidate.type || candidate.type === entry.type))
    if (path && declared) paths.add(path)
    Object.values(entry).forEach(visit)
  }
  visit(result)
  return [...paths].sort()
}

async function exclusions(root, declaredPaths) {
  const counts = new Map()
  const count = (category) => counts.set(category, (counts.get(category) || 0) + 1)
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const source = join(directory, entry.name)
      const path = relative(root, source).replaceAll("\\", "/")
      if (entry.isDirectory()) await visit(source)
      else if (entry.isFile()) {
        const category = sourceCategory(path, source)
        if (category) count(category)
        else if (!declaredPaths.has(path)) count("undeclared-artifact")
      } else count("special-file")
    }
  }
  await visit(root)
  return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([category, count]) => ({ category, count }))
}

function runtimeProvenance(request) {
  const sources = Array.isArray(record(request).runtime_sources) ? record(request).runtime_sources : []
  return sources.flatMap((source) => {
    const entry = record(source)
    if (typeof entry.role !== "string") return []
    const provenance = { role: entry.role }
    if (record(entry.source).type === "https_zip") {
      const sourceInfo = record(entry.source)
      provenance.source = Object.fromEntries(["type", "url", "sha256", "archive_root"].flatMap((key) => typeof sourceInfo[key] === "string" ? [[key, sourceInfo[key]]] : []))
    } else Object.assign(provenance, ...["repository", "revision", "digest"].flatMap((key) => typeof entry[key] === "string" ? [{ [key]: entry[key] }] : []))
    return [provenance]
  })
}

async function finalScan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const relativePath = relative(uploadPath, path).replaceAll("\\", "/")
    if (sourceCategory(relativePath, path)) throw new Error("Prepared runtime plugin sources must never be persisted in artifact uploads.")
    if (entry.isDirectory()) await finalScan(path)
    else if (entry.isFile()) {
      const bytes = await readFile(path)
      const text = isUtf8(bytes) ? bytes.toString("utf8") : ""
      assertNoRuntimeSourcePaths(text, runtimeSourceRoots, "Runtime source paths must never be persisted in artifact uploads.")
      if (containsRuntimeSourceContent(text)) throw new Error("Prepared runtime plugin source contents must never be persisted in artifact uploads.")
    } else throw new Error("Only regular files may be persisted in artifact uploads.")
  }
}

const parseJsonOrEmpty = (text) => {
  try { return JSON.parse(text) } catch { return {} }
}
const request = parseJsonOrEmpty(await readFile(requestPath, "utf8").catch(() => "{}"))
const resultSource = join(workspace, ".codebox", "agent-task-workflow-result.json")
const result = parseJsonOrEmpty(await readFile(resultSource, "utf8").catch(() => "{}"))
const declaredPaths = new Set(declaredArtifactPaths(result, declarations(request)))

await rm(uploadPath, { recursive: true, force: true })
await mkdir(uploadPath, { recursive: true })
await stageTextFile(requestPath, join(uploadPath, ".codebox", "agent-task-request.json"))
await stageTextFile(resultSource, join(uploadPath, ".codebox", "agent-task-workflow-result.json"))
await stageTextFile(join(workspace, ".codebox", "native-agent-task-input.json"), join(uploadPath, ".codebox", "native-agent-task-input.json"), { compactNativeInput: true })
for (const path of declaredPaths) {
  const source = resolve(artifactsPath, path)
  if (relative(artifactsPath, source).startsWith("..") || sourceCategory(path, source)) {
    throw new Error("Declared reviewer artifacts must not reference source files or private runtime internals.")
  }
  await stageTextFile(source, join(uploadPath, ".codebox", "agent-task-artifacts", path))
}
await mkdir(join(uploadPath, ".codebox", "agent-task-artifacts"), { recursive: true })
await writeFile(join(uploadPath, ".codebox", "agent-task-artifacts", "runtime-provenance.json"), `${JSON.stringify({ schema: "wp-codebox/agent-task-runtime-provenance/v1", sources: runtimeProvenance(request) }, null, 2)}\n`)
await writeFile(join(uploadPath, ".codebox", "agent-task-artifacts", "exclusions.json"), `${JSON.stringify({ schema: "wp-codebox/agent-task-upload-exclusions/v1", exclusions: await exclusions(artifactsPath, declaredPaths) }, null, 2)}\n`)
await finalScan(uploadPath)
