import { constants } from "node:fs"
import { lstat, mkdir, open, readdir, rm, writeFile } from "node:fs/promises"
import { isUtf8 } from "node:buffer"
import { join, resolve } from "node:path"

const MAX_UPLOAD_FILE_BYTES = 4 * 1024 * 1024
const workspace = resolve(process.env.AGENT_TASK_WORKSPACE || process.cwd())
const uploadPath = resolve(process.env.AGENT_TASK_UPLOAD_PATH || join(workspace, ".codebox", "agent-task-upload"))
const requestPath = resolve(process.env.AGENT_TASK_REQUEST_PATH || join(workspace, ".codebox", "agent-task-request.json"))
const secretValues = ["OPENAI_API_KEY", "MODEL_PROVIDER_SECRET_1", "MODEL_PROVIDER_SECRET_2", "MODEL_PROVIDER_SECRET_3", "MODEL_PROVIDER_SECRET_4", "MODEL_PROVIDER_SECRET_5", "GITHUB_TOKEN", "GH_TOKEN", "ACCESS_TOKEN", "EXTERNAL_PACKAGE_SOURCE_POLICY"].map((name) => process.env[name]).filter(Boolean)

function redact(value) {
  return secretValues.reduce((output, secret) => output.split(secret).join("[REDACTED]"), value)
}

async function stageFile(source, destination) {
  const metadata = await lstat(source).catch(() => null)
  if (!metadata?.isFile() || metadata.size > MAX_UPLOAD_FILE_BYTES) return false
  const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null)
  if (!handle) return false
  const openedMetadata = await handle.stat()
  const contents = openedMetadata.isFile() && openedMetadata.size <= MAX_UPLOAD_FILE_BYTES ? await handle.readFile() : null
  await handle.close()
  if (!contents || contents.includes(0) || !isUtf8(contents)) return false
  await mkdir(resolve(destination, ".."), { recursive: true })
  await writeFile(destination, redact(contents.toString("utf8")))
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

await rm(uploadPath, { recursive: true, force: true })
await mkdir(uploadPath, { recursive: true })
await stageFile(requestPath, join(uploadPath, ".codebox", "agent-task-request.json"))
for (const path of [".codebox/agent-task-workflow-result.json", ".codebox/native-agent-task-input.json"]) {
  await stageFile(join(workspace, path), join(uploadPath, path))
}
await stageDirectory(join(workspace, ".codebox", "agent-task-artifacts"), join(uploadPath, ".codebox", "agent-task-artifacts"))
