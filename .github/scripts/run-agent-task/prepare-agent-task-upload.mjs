import { constants } from "node:fs"
import { lstat, mkdir, open, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { isUtf8 } from "node:buffer"
import { createHash } from "node:crypto"
import { isAbsolute, join, relative, resolve } from "node:path"
import { assertNoRuntimeSourcePaths, sanitizeRuntimeSourceJson } from "./runtime-source-sanitizer.mjs"

const MAX_UPLOAD_FILE_BYTES = 4 * 1024 * 1024
const MAX_TRANSCRIPT_EXECUTIONS = 64
const MAX_REVIEW_TEXT_BYTES = 32 * 1024
const MAX_TOOL_ARGUMENT_KEYS = 32
const workspace = resolve(process.env.AGENT_TASK_WORKSPACE || process.cwd())
const uploadPath = resolve(process.env.AGENT_TASK_UPLOAD_PATH || join(workspace, ".codebox", "agent-task-upload"))
const requestPath = resolve(process.env.AGENT_TASK_REQUEST_PATH || join(workspace, ".codebox", "agent-task-request.json"))
const artifactsPath = join(workspace, ".codebox", "agent-task-artifacts")
const secretValues = ["OPENAI_API_KEY", "MODEL_PROVIDER_SECRET_1", "MODEL_PROVIDER_SECRET_2", "MODEL_PROVIDER_SECRET_3", "MODEL_PROVIDER_SECRET_4", "MODEL_PROVIDER_SECRET_5", "GITHUB_TOKEN", "GH_TOKEN", "ACCESS_TOKEN", "EXTERNAL_PACKAGE_SOURCE_POLICY"].map((name) => process.env[name]).filter(Boolean)
const runtimeSourceRoot = process.env.WP_CODEBOX_RUNTIME_SOURCE_ROOT ? resolve(process.env.WP_CODEBOX_RUNTIME_SOURCE_ROOT) : ""
const runtimeSourcePrefix = process.env.WP_CODEBOX_RUNTIME_SOURCE_PREFIX ? resolve(process.env.WP_CODEBOX_RUNTIME_SOURCE_PREFIX) : ""
const runtimeSourceRoots = [runtimeSourceRoot, runtimeSourcePrefix].filter(Boolean)
const privateUploadRoots = [...runtimeSourceRoots, workspace]
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
  return sanitizeRuntimeSourceJson(text, privateUploadRoots)
    .replace(/\/(?:Users|home|private|var|tmp|opt|Volumes)\/[^\s"'\\]+/g, "[host-path]")
}

function compactNativeInput(text) {
  const privateFields = new Set(["source_package_root", "component_contracts", "extra_plugins", "provider_plugins", "runtime_overlays", "prepared_sources"])
  let seedProvenance = {}
  try {
    const parsed = JSON.parse(sanitizeText(text))
    seedProvenance = record(record(record(parsed).task_input).runtime_task?.input?.metadata).runner_workspace_seed
  } catch {}
  const compact = (value, key = "") => {
    if (Array.isArray(value)) return value.map(compact)
    const entry = record(value)
    if (!Object.keys(entry).length) return value
    if (key === "seed" && typeof entry.source === "string") {
      const provenance = record(seedProvenance)
      return {
        kind: "runner-workspace-seed",
        digest: record(provenance.digest).sha256,
        files: provenance.files,
        bytes: provenance.bytes,
        excludes: provenance.excludes,
        excluded: provenance.excluded,
      }
    }
    return Object.fromEntries(Object.entries(entry).flatMap(([childKey, item]) => privateFields.has(childKey) ? [] : [[childKey, compact(item, childKey)]]))
  }
  try {
    return `${JSON.stringify(compact(JSON.parse(sanitizeText(text))), null, 2)}\n`
  } catch {
    return sanitizeText(text)
  }
}

function assertNoSeedSnapshotPaths(text) {
  if (/wp-codebox-runner-workspace-seed-/i.test(text)) throw new Error("Temporary runner workspace seed paths must never be persisted in artifact uploads.")
  try {
    const visit = (value) => {
      if (Array.isArray(value)) return value.forEach(visit)
      const entry = record(value)
      if (!Object.keys(entry).length) return
      if (record(entry.seed).source && isAbsolute(record(entry.seed).source)) throw new Error("Absolute runner workspace seed paths must never be persisted in artifact uploads.")
      Object.values(entry).forEach(visit)
    }
    visit(JSON.parse(text))
  } catch (error) {
    if (error instanceof Error && /seed paths/.test(error.message)) throw error
  }
}

function sanitizeSeedSnapshotJson(text) {
  try {
    const compact = (value, key = "") => {
      if (typeof value === "string") return value.replace(/\/?[^\s"']*wp-codebox-runner-workspace-seed-[^\s"']*/gi, "[runner-workspace-seed]")
      if (Array.isArray(value)) return value.map((entry) => compact(entry))
      const entry = record(value)
      if (!Object.keys(entry).length) return value
      if (key === "seed" && typeof entry.source === "string") return { kind: "runner-workspace-seed" }
      return Object.fromEntries(Object.entries(entry).map(([childKey, item]) => [childKey, compact(item, childKey)]))
    }
    return `${JSON.stringify(compact(JSON.parse(text)), null, 2)}\n`
  } catch {
    return text
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
  const sanitized = options.compactNativeInput ? compactNativeInput(contents.toString("utf8")) : sanitizeText(contents.toString("utf8"))
  const text = redact(sanitizeSeedSnapshotJson(sanitized))
  assertNoRuntimeSourcePaths(text, privateUploadRoots, "Runtime source or workspace paths must never be persisted in artifact uploads.")
  assertNoSeedSnapshotPaths(text)
  if (!options.allowTargetCode && containsRuntimeSourceContent(text)) throw new Error("Prepared runtime plugin source contents must never be staged for artifact upload.")
  await mkdir(resolve(destination, ".."), { recursive: true })
  await writeFile(destination, text)
  return true
}

function canonicalTranscript(result) {
  const descriptor = record(record(result).reviewer_evidence).transcript
  if (descriptor === undefined) return undefined
  const transcript = record(descriptor)
  if (Object.keys(transcript).length !== 5
    || transcript.schema !== "wp-codebox/agent-transcript/v1"
    || transcript.kind !== "codebox-transcript"
    || typeof transcript.path !== "string"
    || !/^[a-f0-9]{64}$/.test(transcript.source_sha256)
    || !Number.isSafeInteger(transcript.size_bytes)
    || transcript.size_bytes < 0
    || transcript.size_bytes > MAX_UPLOAD_FILE_BYTES) {
    throw new Error("Reviewer evidence transcript descriptor is malformed.")
  }
  return transcript
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

function boundedText(value) {
  if (typeof value !== "string") return undefined
  const text = redact(sanitizeText(value)).slice(0, MAX_REVIEW_TEXT_BYTES)
  return containsRuntimeSourceContent(text) ? "[redacted-source-content]" : text
}

function safeTargetPath(value) {
  const path = safeRelativeArtifactPath(value)
  return path ? `workspace/${path}` : undefined
}

function omittedText(value) {
  if (typeof value !== "string") return undefined
  const bytes = Buffer.byteLength(value)
  return { bytes, sha256: digest(Buffer.from(value)) }
}

function projectArguments(value) {
  const entry = record(value)
  const paths = [entry.path, ...(Array.isArray(entry.paths) ? entry.paths : [])].map(safeTargetPath).filter(Boolean).slice(0, 32)
  const counts = Object.fromEntries(["bytes", "byte_count", "match_count", "matches", "change_count", "changes", "count"].flatMap((key) => typeof entry[key] === "number" ? [[key, entry[key]]] : []))
  const payloads = Object.fromEntries(["content", "patch", "diff", "write", "old_string", "new_string", "text"].flatMap((key) => omittedText(entry[key]) ? [[key, omittedText(entry[key])]] : []))
  return Object.fromEntries(Object.entries({ paths: paths.length ? paths : undefined, counts: Object.keys(counts).length ? counts : undefined, omitted_payloads: Object.keys(payloads).length ? payloads : undefined }).filter(([, item]) => item !== undefined))
}

function projectToolCall(value) {
  const entry = record(value)
  const tool = boundedText(entry.tool_id ?? entry.toolId ?? entry.name ?? entry.tool_name)
  const args = projectArguments(entry.args ?? entry.arguments)
  const paths = [...(args.paths ?? []), ...[safeTargetPath(entry.path)].filter(Boolean)].slice(0, 32)
  const result = record(entry.result ?? entry.output)
  const resultSummary = projectArguments({ ...result, content: result.content ?? entry.content, path: result.path ?? entry.path })
  return Object.fromEntries(Object.entries({ tool, paths: paths.length ? paths : undefined, status: boundedText(entry.status), arguments: Object.keys(args).length ? args : undefined, result: Object.keys(resultSummary).length ? resultSummary : undefined, error_code: boundedText(record(entry.error).code ?? entry.error_code), error: boundedText(record(entry.error).message ?? entry.error) }).filter(([, item]) => item !== undefined))
}

function projectParsed(value) {
  const parsed = record(value)
  const messages = Array.isArray(parsed.messages) ? parsed.messages : Array.isArray(parsed.model_messages) ? parsed.model_messages : []
  const tools = Array.isArray(parsed.tool_calls) ? parsed.tool_calls : Array.isArray(parsed.toolCalls) ? parsed.toolCalls : []
  const results = Array.isArray(parsed.tool_results) ? parsed.tool_results : Array.isArray(parsed.toolResults) ? parsed.toolResults : []
  const errors = Array.isArray(parsed.errors) ? parsed.errors : parsed.error ? [parsed.error] : []
  const agent = record(parsed.agent ?? parsed.agent_metadata)
  const toolObservability = canonicalToolObservability(parsed.metadata)
    ?? canonicalToolObservability(record(parsed.agent_runtime).result?.metadata)
  return Object.fromEntries(Object.entries({
    agent: Object.fromEntries(["id", "name", "status"].flatMap((key) => boundedText(agent[key]) ? [[key, boundedText(agent[key])]] : [])),
    model_messages: messages.slice(0, MAX_TRANSCRIPT_EXECUTIONS).flatMap((message) => boundedText(record(message).content ?? record(message).text ?? message) ? [{ role: boundedText(record(message).role), content: boundedText(record(message).content ?? record(message).text ?? message) }] : []),
    tool_calls: tools.slice(0, MAX_TRANSCRIPT_EXECUTIONS).map(projectToolCall),
    tool_results: results.slice(0, MAX_TRANSCRIPT_EXECUTIONS).map(projectToolCall),
    errors: errors.slice(0, MAX_TRANSCRIPT_EXECUTIONS).flatMap((error) => boundedText(record(error).message ?? error) ? [boundedText(record(error).message ?? error)] : []),
    tool_observability: toolObservability,
  }).filter(([, item]) => item !== undefined && (Array.isArray(item) ? item.length > 0 : Object.keys(item).length > 0)))
}

// This is deliberately limited to the public Agents API summary. Tool payloads
// and provider-specific tool records are not inputs to reviewer artifacts.
function canonicalToolObservability(metadata) {
  const source = record(record(record(metadata).agents_api).tool_observability)
  if (source.version !== 1 || !Array.isArray(source.calls) || source.calls.length > MAX_TRANSCRIPT_EXECUTIONS) return undefined
  const calls = source.calls.map(projectCanonicalToolCall).filter(Boolean)
  return calls.length ? { version: 1, calls } : undefined
}

function projectCanonicalToolCall(value) {
  const call = record(value)
  const argumentsSummary = record(call.arguments)
  const keys = Array.isArray(argumentsSummary.keys) ? argumentsSummary.keys : []
  if (!Number.isSafeInteger(call.sequence) || call.sequence < 1 || !Number.isSafeInteger(call.turn) || call.turn < 1
    || !safeToolIdentifier(call.tool_call_id) || !safeToolIdentifier(call.tool_name)
    || !["succeeded", "failed", "rejected", "pending"].includes(call.status)
    || argumentsSummary.redacted !== true || !Number.isSafeInteger(argumentsSummary.count) || argumentsSummary.count < 0
    || argumentsSummary.count !== keys.length || keys.length > MAX_TOOL_ARGUMENT_KEYS || !keys.every(safeToolIdentifier)) return undefined
  const resultSummary = projectCanonicalToolResult(call.result)
  if (call.result !== undefined && !resultSummary) return undefined
  return Object.fromEntries(Object.entries({
    sequence: call.sequence,
    turn: call.turn,
    tool_call_id: call.tool_call_id,
    tool_name: call.tool_name,
    status: call.status,
    arguments: { keys, count: argumentsSummary.count, redacted: true },
    result: resultSummary,
    error: call.status === "failed" ? { code: "tool_call_failed", message: "Tool call failed." }
      : call.status === "rejected" ? { code: "tool_call_rejected", message: "Tool call was rejected." }
        : undefined,
  }).filter(([, item]) => item !== undefined))
}

function projectCanonicalToolResult(value) {
  const result = record(value)
  if (Object.keys(result).length === 0) return undefined
  if (["array", "object"].includes(result.type)) return Number.isSafeInteger(result.count) && result.count >= 0 ? { type: result.type, count: result.count } : undefined
  if (result.type === "string") return Number.isSafeInteger(result.size) && result.size >= 0 ? { type: result.type, size: result.size } : undefined
  return ["integer", "double", "boolean", "null"].includes(result.type) ? { type: result.type } : undefined
}

function safeToolIdentifier(value) {
  return typeof value === "string" && value.length <= 256 && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)
}

async function trustedTranscriptFile(path) {
  const root = await realpath(artifactsPath).catch(() => "")
  if (!root) return { unavailable: "artifact-root-missing" }
  // Resolve before evaluating containment so harmless relative spelling is not
  // mistaken for an escape while aliases and symlinks still fail closed.
  const requested = resolve(root, path)
  const requestedRelative = relative(root, requested)
  if (requestedRelative === ".." || requestedRelative.startsWith(`..${String.fromCharCode(47)}`) || isAbsolute(requestedRelative)) throw new Error("Canonical transcript escapes the trusted artifact root.")
  const parts = requestedRelative.split("/").filter(Boolean)
  let current = root
  for (const part of parts) {
    current = join(current, part)
    const stat = await lstat(current).catch((error) => error?.code === "ENOENT" ? undefined : Promise.reject(error))
    if (!stat) return { unavailable: "referenced-file-missing" }
    if (stat.isSymbolicLink()) throw new Error("Canonical transcript must not traverse symlinks.")
  }
  const stat = await lstat(current)
  if (!stat.isFile() || stat.size > MAX_UPLOAD_FILE_BYTES) throw new Error("Canonical transcript must be a bounded regular file.")
  const resolved = await realpath(current)
  const contained = relative(root, resolved)
  if (contained === ".." || contained.startsWith(`..${String.fromCharCode(47)}`) || isAbsolute(contained)) throw new Error("Canonical transcript escapes the trusted artifact root.")
  return { source: resolved }
}

async function stageCanonicalTranscript(result) {
  const ref = await canonicalTranscript(result)
  if (!ref) return undefined
  const trusted = await trustedTranscriptFile(ref.path)
  if (trusted.unavailable) return { unavailable: trusted.unavailable, provenance: { kind: ref.kind, artifact_path: ref.path } }
  const source = trusted.source
  const bytes = await readFile(source)
  if (bytes.includes(0) || !isUtf8(bytes)) throw new Error("Canonical transcript must be UTF-8 JSON.")
  const actualDigest = digest(bytes)
  if (ref.source_sha256 !== actualDigest) throw new Error("Canonical transcript digest does not match its reviewer evidence descriptor.")
  if (ref.size_bytes !== bytes.length) throw new Error("Canonical transcript size does not match its reviewer evidence descriptor.")
  const raw = parseJsonOrEmpty(bytes.toString("utf8"))
  if (raw.schema !== ref.schema || !Array.isArray(raw.executions) || raw.executions.length > MAX_TRANSCRIPT_EXECUTIONS) throw new Error("Canonical transcript must be a bounded wp-codebox/agent-transcript/v1 envelope.")
  const projection = {
    schema: "wp-codebox/reviewer-agent-transcript/v1",
    executions: raw.executions.map((execution, index) => {
      const entry = record(execution)
      if (typeof entry.command !== "string" || typeof entry.exitCode !== "number") throw new Error("Canonical transcript execution is malformed.")
      return Object.fromEntries(Object.entries({ execution_index: typeof entry.executionIndex === "number" ? entry.executionIndex : index, command: boundedText(entry.command), status: entry.exitCode === 0 ? "succeeded" : "failed", exit_code: entry.exitCode, parsed: Object.keys(record(entry.parsed)).length ? projectParsed(entry.parsed) : undefined, error: boundedText(entry.stderr) }).filter(([, item]) => item !== undefined))
    }),
  }
  const destination = join(uploadPath, ".codebox", "agent-task-artifacts", "transcript.json")
  await mkdir(resolve(destination, ".."), { recursive: true })
  await writeFile(destination, `${JSON.stringify(projection, null, 2)}\n`)
  const projectionDigest = digest(await readFile(destination))
  return {
    path: ".codebox/agent-task-artifacts/transcript.json",
    sha256: projectionDigest,
    provenance: { kind: ref.kind, artifact_path: ref.path, source_sha256: actualDigest, projection_sha256: projectionDigest },
  }
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

async function exclusions(root, declaredPaths, transcript) {
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
  return {
    exclusions: [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([category, count]) => ({ category, count })),
    ...(transcript ? { canonical_transcripts: [transcript] } : {}),
  }
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
      assertNoRuntimeSourcePaths(text, privateUploadRoots, "Runtime source or workspace paths must never be persisted in artifact uploads.")
      assertNoSeedSnapshotPaths(text)
      if (relativePath !== ".codebox/agent-task-artifacts/transcript.json" && containsRuntimeSourceContent(text)) throw new Error("Prepared runtime plugin source contents must never be persisted in artifact uploads.")
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
    // Package declarations cannot authorize source trees or escape the root.
    // Keep staging independent of an untrusted alias, including transcripts.
    continue
  }
  await stageTextFile(source, join(uploadPath, ".codebox", "agent-task-artifacts", path))
}
const transcript = await stageCanonicalTranscript(result)
if (transcript?.provenance?.source_sha256) {
  const stagedResultPath = join(uploadPath, ".codebox", "agent-task-workflow-result.json")
  const stagedResult = parseJsonOrEmpty(await readFile(stagedResultPath, "utf8"))
  stagedResult.artifact_upload = { canonical_transcript: transcript.provenance }
  await writeFile(stagedResultPath, `${JSON.stringify(stagedResult, null, 2)}\n`)
}
await mkdir(join(uploadPath, ".codebox", "agent-task-artifacts"), { recursive: true })
await writeFile(join(uploadPath, ".codebox", "agent-task-artifacts", "runtime-provenance.json"), `${JSON.stringify({ schema: "wp-codebox/agent-task-runtime-provenance/v1", sources: runtimeProvenance(request) }, null, 2)}\n`)
await writeFile(join(uploadPath, ".codebox", "agent-task-artifacts", "exclusions.json"), `${JSON.stringify({ schema: "wp-codebox/agent-task-upload-exclusions/v1", ...(await exclusions(artifactsPath, declaredPaths, transcript)) }, null, 2)}\n`)
await finalScan(uploadPath)
