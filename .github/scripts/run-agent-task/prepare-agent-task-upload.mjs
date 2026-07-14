import { constants } from "node:fs"
import { lstat, mkdir, open, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { isUtf8 } from "node:buffer"
import { isAbsolute, join, relative, resolve } from "node:path"
import { assertNoRuntimeSourcePaths, sanitizeRuntimeSourceJson } from "./runtime-source-sanitizer.mjs"

const MAX_UPLOAD_FILE_BYTES = 4 * 1024 * 1024
const workspace = resolve(process.env.AGENT_TASK_WORKSPACE || process.cwd())
const uploadPath = resolve(process.env.AGENT_TASK_UPLOAD_PATH || join(workspace, ".codebox", "agent-task-upload"))
const requestPath = resolve(process.env.AGENT_TASK_REQUEST_PATH || join(workspace, ".codebox", "agent-task-request.json"))
const secretValues = ["OPENAI_API_KEY", "MODEL_PROVIDER_SECRET_1", "MODEL_PROVIDER_SECRET_2", "MODEL_PROVIDER_SECRET_3", "MODEL_PROVIDER_SECRET_4", "MODEL_PROVIDER_SECRET_5", "GITHUB_TOKEN", "GH_TOKEN", "ACCESS_TOKEN", "EXTERNAL_PACKAGE_SOURCE_POLICY"].map((name) => process.env[name]).filter(Boolean)
const runtimeSourceRoot = process.env.WP_CODEBOX_RUNTIME_SOURCE_ROOT ? resolve(process.env.WP_CODEBOX_RUNTIME_SOURCE_ROOT) : ""
const runtimeSourcePrefix = process.env.WP_CODEBOX_RUNTIME_SOURCE_PREFIX ? resolve(process.env.WP_CODEBOX_RUNTIME_SOURCE_PREFIX) : ""
const runtimeSourceRoots = [runtimeSourceRoot, runtimeSourcePrefix].filter(Boolean)
const RUNTIME_SOURCE_TREE = /(^|\/)(prepared-plugins|agents-api|ai-provider-for-openai)(\/|$)/
const RUNTIME_SOURCE_FILE = /^(agents-api\.php|plugin\.php)$/
const RUNTIME_SOURCE_CONTENT = /(?:Plugin Name:|WP_Agents_Registry|OpenAiProvider)/

function redact(value) {
  return secretValues.reduce((output, secret) => output.split(secret).join("[REDACTED]"), value)
}

function isPrivateRuntimePath(value) {
  if (!runtimeSourceRoot || typeof value !== "string") return false
  const path = resolve(value)
  const contained = relative(runtimeSourceRoot, path)
  return path === runtimeSourceRoot || (contained !== ".." && !contained.startsWith(`..${String.fromCharCode(47)}`) && !isAbsolute(contained))
}

function sanitizeText(text) {
  return sanitizeRuntimeSourceJson(text, runtimeSourceRoots)
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
  assertNoRuntimeSourcePaths(text, runtimeSourceRoots, "Runtime source paths must never be persisted in artifact uploads.")
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
      assertNoRuntimeSourcePaths(contents, runtimeSourceRoots, "Runtime source paths must never be persisted in artifact uploads.")
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
