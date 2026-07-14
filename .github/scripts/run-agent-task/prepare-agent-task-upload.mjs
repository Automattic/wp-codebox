import { constants } from "node:fs"
import { lstat, mkdir, open, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { isUtf8 } from "node:buffer"
import { isAbsolute, join, relative, resolve } from "node:path"

const MAX_UPLOAD_FILE_BYTES = 4 * 1024 * 1024
const workspace = resolve(process.env.AGENT_TASK_WORKSPACE || process.cwd())
const uploadPath = resolve(process.env.AGENT_TASK_UPLOAD_PATH || join(workspace, ".codebox", "agent-task-upload"))
const requestPath = resolve(process.env.AGENT_TASK_REQUEST_PATH || join(workspace, ".codebox", "agent-task-request.json"))
const secretValues = ["OPENAI_API_KEY", "MODEL_PROVIDER_SECRET_1", "MODEL_PROVIDER_SECRET_2", "MODEL_PROVIDER_SECRET_3", "MODEL_PROVIDER_SECRET_4", "MODEL_PROVIDER_SECRET_5", "GITHUB_TOKEN", "GH_TOKEN", "ACCESS_TOKEN", "EXTERNAL_PACKAGE_SOURCE_POLICY"].map((name) => process.env[name]).filter(Boolean)
const runtimeSourceRoot = process.env.WP_CODEBOX_RUNTIME_SOURCE_ROOT ? resolve(process.env.WP_CODEBOX_RUNTIME_SOURCE_ROOT) : ""
const RUNTIME_SOURCE_TREE = /(^|\/)(prepared-plugins|agents-api|ai-provider-for-openai)(\/|$)/
const RUNTIME_SOURCE_FILE = /^(agents-api\.php|plugin\.php)$/
const RUNTIME_SOURCE_CONTENT = /(?:Plugin Name:|WP_Agents_Registry|OpenAiProvider)/

function redact(value) {
  return secretValues.reduce((output, secret) => output.split(secret).join("[REDACTED]"), value)
}

const PRIVATE_RUNTIME_PATH_FIELDS = new Set(["source", "path", "sourceRoot", "originalSource", "preparedPath", "requestedPath", "source_package_root", "artifacts_path", "runtime_input_path", "task_path", "result_path", "event_stream_path", "materialization_result_path"])

function isPrivateRuntimePath(value) {
  if (!runtimeSourceRoot || typeof value !== "string") return false
  const path = resolve(value)
  const contained = relative(runtimeSourceRoot, path)
  return path === runtimeSourceRoot || (contained !== ".." && !contained.startsWith(`..${String.fromCharCode(47)}`) && !isAbsolute(contained))
}

function omitPrivateRuntimeSourcePaths(value) {
  if (Array.isArray(value)) return value.map(omitPrivateRuntimeSourcePaths)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => {
    if (PRIVATE_RUNTIME_PATH_FIELDS.has(key) && isPrivateRuntimePath(entry)) return []
    if (key === "runtime_sources" && Array.isArray(entry)) return [[key, entry.map(runtimeSourceProvenance)]]
    return [[key, omitPrivateRuntimeSourcePaths(entry)]]
  }))
}

function runtimeSourceProvenance(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return source
  const descriptor = source
  const provenance = { role: descriptor.role }
  if (descriptor.source?.type === "https_zip") {
    provenance.source = { type: "https_zip", url: descriptor.source.url, sha256: descriptor.source.sha256, ...(descriptor.source.archive_root ? { archive_root: descriptor.source.archive_root } : {}) }
  } else {
    Object.assign(provenance, ...["repository", "revision", "path", "digest"].flatMap((key) => descriptor[key] ? [{ [key]: descriptor[key] }] : []))
  }
  if (descriptor.role === "provider_plugin" && Array.isArray(descriptor.metadata?.providers)) provenance.providers = descriptor.metadata.providers
  return provenance
}

function sanitizeText(text) {
  try {
    return `${JSON.stringify(omitPrivateRuntimeSourcePaths(JSON.parse(text)), null, 2)}\n`
  } catch {
    return text
  }
}

async function stageFile(source, destination) {
  if (isPrivateRuntimePath(source)) {
    throw new Error("Runtime source files must never be staged for artifact upload.")
  }
  const metadata = await lstat(source).catch(() => null)
  if (!metadata?.isFile() || metadata.size > MAX_UPLOAD_FILE_BYTES) return false
  if (RUNTIME_SOURCE_TREE.test(source) || RUNTIME_SOURCE_FILE.test(source.split("/").pop() || "")) {
    throw new Error("Prepared runtime plugin sources must never be staged for artifact upload.")
  }
  const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null)
  if (!handle) return false
  const openedMetadata = await handle.stat()
  const contents = openedMetadata.isFile() && openedMetadata.size <= MAX_UPLOAD_FILE_BYTES ? await handle.readFile() : null
  await handle.close()
  if (!contents || contents.includes(0) || !isUtf8(contents)) return false
  await mkdir(resolve(destination, ".."), { recursive: true })
  let text = contents.toString("utf8")
  if (RUNTIME_SOURCE_CONTENT.test(text)) {
    throw new Error("Prepared runtime plugin source contents must never be staged for artifact upload.")
  }
  text = sanitizeText(text)
  if (runtimeSourceRoot && text.includes(runtimeSourceRoot)) throw new Error("Runtime source paths must never be persisted in artifact uploads.")
  await writeFile(destination, redact(text))
  return true
}

async function stageDirectory(source, destination) {
  const metadata = await lstat(source).catch(() => null)
  if (!metadata?.isDirectory()) return
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const entrySource = join(source, entry.name)
    const entryDestination = join(destination, entry.name)
    if (entry.isDirectory()) await stageDirectory(entrySource, entryDestination)
    else if (entry.isFile()) await stageFile(entrySource, entryDestination)
  }
}

async function assertNoPrivateRuntimePaths(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await assertNoPrivateRuntimePaths(path)
    else if (entry.isFile()) {
      const contents = await readFile(path, "utf8")
      if (runtimeSourceRoot && contents.includes(runtimeSourceRoot)) throw new Error("Runtime source paths must never be persisted in artifact uploads.")
      if (RUNTIME_SOURCE_TREE.test(path) || RUNTIME_SOURCE_FILE.test(entry.name) || RUNTIME_SOURCE_CONTENT.test(contents)) throw new Error("Prepared runtime plugin sources must never be persisted in artifact uploads.")
    }
  }
}

await rm(uploadPath, { recursive: true, force: true })
await mkdir(uploadPath, { recursive: true })
await stageFile(requestPath, join(uploadPath, ".codebox", "agent-task-request.json"))
for (const path of [".codebox/agent-task-workflow-result.json", ".codebox/native-agent-task-input.json"]) {
  await stageFile(join(workspace, path), join(uploadPath, path))
}
await stageDirectory(join(workspace, ".codebox", "agent-task-artifacts"), join(uploadPath, ".codebox", "agent-task-artifacts"))
await assertNoPrivateRuntimePaths(uploadPath)
