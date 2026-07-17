import { rmSync } from "node:fs"
import { appendFile, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { isUtf8 } from "node:buffer"
import { isAbsolute, join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { canonicalExternalNativeAgentIdentity, materializeExternalNativePackage, materializeRuntimeSources, normalizeExternalPackageSource, normalizeRuntimeSources, parseExternalPackageSourcePolicy, sha256BytesV1, validateRuntimeSourceModel } from "./materialize-external-native-package.mjs"
import { readNativeResult } from "./native-result-file.mjs"
import { assertNoRuntimeSourcePaths, sanitizeRuntimeSourceJson, sanitizeRuntimeSourceText, sanitizeRuntimeSourceValue } from "./runtime-source-sanitizer.mjs"
import { publishRunnerWorkspace } from "./runner-workspace-publisher.mjs"
import { createRunnerWorkspaceSeedSnapshot, RUNNER_WORKSPACE_SEED_EXCLUDES } from "./runner-workspace-seed-snapshot.mjs"
import { createTrustedArtifactApplyChannel, trustedArtifactApplyRefs } from "./trusted-artifact-snapshot.mjs"

const requestPath = process.env.AGENT_TASK_REQUEST_PATH || ".codebox/agent-task-request.json"
const workspace = resolve(process.env.AGENT_TASK_WORKSPACE || process.cwd())
const codeboxRoot = resolve(process.env.WP_CODEBOX_WORKFLOW_ROOT || ".")
const codeboxCliPath = process.env.WP_CODEBOX_CLI_PATH || join(codeboxRoot, "packages/cli/dist/index.js")
const outputPath = process.env.GITHUB_OUTPUT
const MAX_CAPTURE_BYTES = 32768
const MAX_WORKFLOW_OUTPUT_BYTES = 8192
const secretValues = ["OPENAI_API_KEY", "MODEL_PROVIDER_SECRET_1", "MODEL_PROVIDER_SECRET_2", "MODEL_PROVIDER_SECRET_3", "MODEL_PROVIDER_SECRET_4", "MODEL_PROVIDER_SECRET_5", "GITHUB_TOKEN", "GH_TOKEN", "ACCESS_TOKEN", "EXTERNAL_PACKAGE_SOURCE_POLICY"].map((name) => process.env[name]).filter(Boolean)
let privateRuntimeSourceRoot = ""
let privateRuntimeSourceRootForSanitization = ""
let runnerWorkspaceSeedSnapshot
let reviewerEvidence
let trustedApplyArtifactRoot

const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }
let materializedSourceCleanup
function claimMaterializedSourcePaths() {
  const paths = []
  if (runnerWorkspaceSeedSnapshot) {
    paths.push(runnerWorkspaceSeedSnapshot.source)
    runnerWorkspaceSeedSnapshot = undefined
  }
  if (privateRuntimeSourceRoot) {
    paths.push(privateRuntimeSourceRoot)
    privateRuntimeSourceRoot = ""
  }
  if (trustedApplyArtifactRoot) {
    paths.push(trustedApplyArtifactRoot)
    trustedApplyArtifactRoot = ""
  }
  return paths
}
// Single idempotent cleanup coordinator for the private runtime source
// materialization root and the runner workspace seed snapshot. Every
// completion path (normal, failure, signal) awaits this coordinator; repeat
// invocations chain onto the in-flight cleanup instead of racing it.
function cleanupMaterializedSources() {
  materializedSourceCleanup = (materializedSourceCleanup ?? Promise.resolve())
    .then(() => Promise.all(claimMaterializedSourcePaths().map((path) => rm(path, { recursive: true, force: true }))))
  return materializedSourceCleanup
}
process.once("exit", () => {
  // Bounded synchronous best-effort fallback for abrupt exits; on every
  // awaited path the coordinator has already claimed these roots.
  for (const path of claimMaterializedSourcePaths()) {
    try { rmSync(path, { recursive: true, force: true, maxRetries: 0 }) } catch { /* best effort */ }
  }
})
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => { cleanupMaterializedSources().finally(() => process.exit(SIGNAL_EXIT_CODES[signal])) })
}

function redact(value) {
  if (typeof value === "string") return secretValues.reduce((output, secret) => output.split(secret).join("[REDACTED]"), value)
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redact(entry)]))
  return value
}

function bounded(value, limit = MAX_CAPTURE_BYTES) {
  const safe = sanitizeRuntimeSourceText(redact(value), privateRuntimeSourceRoot)
  if (typeof safe !== "string") return safe
  return safe.length > limit ? `${safe.slice(0, limit)}\n[TRUNCATED ${safe.length - limit} characters]` : safe
}

function capturedStream(limit = MAX_CAPTURE_BYTES) {
  const chunks = []
  let retainedBytes = 0
  let totalBytes = 0
  return {
    append(chunk) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      totalBytes += value.length
      const remaining = limit - retainedBytes
      if (remaining > 0) {
        const retained = value.subarray(0, remaining)
        chunks.push(retained)
        retainedBytes += retained.length
      }
    },
    result() {
      return {
        output: bounded(Buffer.concat(chunks, retainedBytes).toString("utf8"), limit),
        truncated: totalBytes > retainedBytes,
      }
    },
  }
}

function output(name, value) {
  if (!outputPath) return Promise.resolve()
  const rendered = typeof value === "string" ? value : JSON.stringify(value)
  const safe = sanitizeRuntimeSourceText(redact(rendered), privateRuntimeSourceRootForSanitization)
  const bytes = Buffer.byteLength(safe)
  if (bytes > MAX_WORKFLOW_OUTPUT_BYTES) {
    throw new Error(`${name} exceeds the ${MAX_WORKFLOW_OUTPUT_BYTES}-byte workflow output limit.`)
  }
  return appendFile(outputPath, `${name}<<__WP_CODEBOX_OUTPUT__\n${safe}\n__WP_CODEBOX_OUTPUT__\n`)
}

function serializedJson(value) {
  return JSON.stringify(value)
}

function workflowOutputReference(name, rendered, artifactsPath) {
  const bytes = Buffer.byteLength(rendered)
  if (bytes <= MAX_WORKFLOW_OUTPUT_BYTES) return Promise.resolve({ rendered })

  const artifactPath = `workflow-outputs/${name}.json`
  const reference = {
    schema: "wp-codebox/workflow-output-reference/v1",
    kind: "codebox-workflow-output",
    output: name,
    artifact_path: artifactPath,
    bytes,
    sha256: createHash("sha256").update(rendered).digest("hex"),
  }
  return mkdir(join(artifactsPath, "workflow-outputs"), { recursive: true })
    .then(() => writeFile(join(artifactsPath, artifactPath), `${rendered}\n`))
    .then(() => ({ rendered: serializedJson(reference), reference }))
}

function projectionOutputLimitError(name, bytes) {
  const error = new Error(`output_projections.${name} serializes to ${bytes} bytes, exceeding the ${MAX_WORKFLOW_OUTPUT_BYTES}-byte workflow output limit. Store the canonical value as a declared artifact and project its artifact-relative reference.`)
  error.code = "wp-codebox.agent-task.output-projection-too-large"
  error.output_name = name
  error.bytes = bytes
  error.max_bytes = MAX_WORKFLOW_OUTPUT_BYTES
  return error
}

function validateProjectionOutputSize(value) {
  for (const [name, projected] of Object.entries(value)) {
    const projectedBytes = Buffer.byteLength(serializedJson(projected))
    if (projectedBytes > MAX_WORKFLOW_OUTPUT_BYTES) throw projectionOutputLimitError(name, projectedBytes)
  }
  const rendered = serializedJson(value)
  const bytes = Buffer.byteLength(rendered)
  if (bytes > MAX_WORKFLOW_OUTPUT_BYTES) throw projectionOutputLimitError("projected_outputs_json", bytes)
}

function safeEnvironment(extra = {}) {
  return { PATH: process.env.PATH || "", HOME: process.env.HOME || "", CI: process.env.CI || "true", ...extra }
}

function agentEnvironment(extra = {}) {
  return safeEnvironment({ ...Object.fromEntries(["OPENAI_API_KEY", "MODEL_PROVIDER_SECRET_1", "MODEL_PROVIDER_SECRET_2", "MODEL_PROVIDER_SECRET_3", "MODEL_PROVIDER_SECRET_4", "MODEL_PROVIDER_SECRET_5", "GITHUB_TOKEN"].map((name) => [name, process.env[name]]).filter(([, value]) => value)), ...extra })
}

function command(command, args, cwd, env = safeEnvironment()) {
  return new Promise((resolveCommand) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] })
    const stdout = capturedStream()
    const stderr = capturedStream()
    let settled = false
    const complete = (code, error) => {
      if (settled) return
      settled = true
      if (error) stderr.append(`${error.message}\n`)
      const capturedStdout = stdout.result()
      const capturedStderr = stderr.result()
      resolveCommand({
        code: code ?? 1,
        stdout: capturedStdout.output,
        stderr: capturedStderr.output,
        stdout_truncated: capturedStdout.truncated,
        stderr_truncated: capturedStderr.truncated,
      })
    }
    child.stdout.on("data", (chunk) => { stdout.append(chunk) })
    child.stderr.on("data", (chunk) => { stderr.append(chunk) })
    child.on("close", (code) => complete(code))
    child.on("error", (error) => complete(1, error))
  })
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {}
}

function canonicalToolObservability(metadata) {
  const source = record(record(record(metadata).agents_api).tool_observability)
  if (source.version !== 1 || !Array.isArray(source.calls) || source.calls.length > 64) return undefined
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
    || argumentsSummary.count !== keys.length || keys.length > 32 || !keys.every(safeToolIdentifier)) return undefined
  const resultSummary = projectCanonicalToolResult(call.result)
  if (call.result !== undefined && !resultSummary) return undefined
  return Object.fromEntries(Object.entries({
    sequence: call.sequence, turn: call.turn, tool_call_id: call.tool_call_id, tool_name: call.tool_name, status: call.status,
    arguments: { keys, count: argumentsSummary.count, redacted: true }, result: resultSummary,
    error: call.status === "failed" ? { code: "tool_call_failed", message: "Tool call failed." }
      : call.status === "rejected" ? { code: "tool_call_rejected", message: "Tool call was rejected." } : undefined,
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

function removeRawToolObservability(metadata) {
  const visit = (value) => {
    if (Array.isArray(value)) return value.forEach(visit)
    const entry = record(value)
    if (!Object.keys(entry).length) return
    const agentsApi = record(record(entry.metadata).agents_api)
    delete agentsApi.tool_observability
    Object.values(entry).forEach(visit)
  }
  visit(metadata)
}

function string(value) {
  return typeof value === "string" ? value.trim() : ""
}

function commandEntries(value, name) {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array.`)
  return value.map((entry, index) => {
    const check = record(entry)
    const command = string(check.command)
    if (!command) throw new Error(`${name}[${index}].command must be a non-empty string.`)
    const description = check.description === undefined ? command : string(check.description)
    if (!description) throw new Error(`${name}[${index}].description must be a non-empty string when provided.`)
    return { command, description }
  })
}

function resultValue(result, path) {
  return path.split(".").reduce((value, key) => value && typeof value === "object" && !Array.isArray(value) ? value[key] : undefined, result)
}

function accessFailure(request) {
  const access = record(request.access)
  const allowed = Array.isArray(access.allowed_repos) ? access.allowed_repos : []
  const tokenRepos = Array.isArray(access.access_token_repos) ? access.access_token_repos : []
  const target = string(request.target_repo)
  const caller = string(access.caller_repo)
  if (!allowed.includes(target) || !tokenRepos.includes(target)) return "Target repository is not explicitly authorized by allowed_repos and access_token_repos."
  if (!caller) return "Caller repository is required for publication authorization."
  if (target !== caller && process.env.EXPLICIT_ACCESS_TOKEN_CONFIGURED !== "true") return "An explicit ACCESS_TOKEN is required for cross-repository publication."
  if (!string(process.env.ACCESS_TOKEN || process.env.GITHUB_TOKEN)) return "No effective GitHub token is available for runner workspace tools."
  return ""
}

function validPublication(value, targetRepo) {
  const publication = record(value)
  const pullRequest = record(publication.pull_request)
  const url = string(pullRequest.url)
  return publication.schema === "wp-codebox/runner-workspace-publication-result/v1"
    && publication.success === true
    && publication.status === "published"
    && /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+\/?$/.test(url)
    && url.startsWith(`https://github.com/${targetRepo}/pull/`)
}

async function verifyPublishedPullRequest(publication, targetRepo, cwd) {
  if (!validPublication(publication, targetRepo)) return { valid: false, error: "Publication did not return a valid canonical pull-request result." }
  const match = string(record(publication).pull_request && record(publication).pull_request.url).match(/\/pull\/(\d+)\/?$/)
  const pullNumber = match?.[1]
  if (!pullNumber) return { valid: false, error: "Publication pull-request URL did not contain a pull number." }
  const response = await command("gh", ["api", `repos/${targetRepo}/pulls/${pullNumber}`], cwd, agentEnvironment())
  if (response.code !== 0) return { valid: false, error: "Published pull request could not be resolved through GitHub.", stderr: response.stderr, stderr_truncated: response.stderr_truncated }
  try {
    const pullRequest = JSON.parse(response.stdout)
    return {
      valid: pullRequest?.html_url === record(publication).pull_request?.url
        && pullRequest?.base?.repo?.full_name === targetRepo,
      error: "Published pull request did not resolve to the target repository.",
    }
  } catch {
    return { valid: false, error: "GitHub pull-request validation did not return JSON." }
  }
}

function projections(value, runtimeResult) {
  const entries = Object.entries(record(value))
  const output = {}
  for (const [name, declaration] of entries) {
    const descriptor = typeof declaration === "string" ? { path: declaration, required: true } : record(declaration)
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
      throw new Error(`output_projections.${name} must have a non-empty output name.`)
    }
    if (Object.keys(descriptor).some((key) => key !== "path" && key !== "required")) {
      throw new Error(`output_projections.${name} descriptor supports only path and required.`)
    }
    const path = string(descriptor.path)
    if (!path || !/^[A-Za-z0-9_.-]+(?:\.[A-Za-z0-9_.-]+)*$/.test(path)) {
      throw new Error(`output_projections.${name}.path must be a dot-delimited result path.`)
    }
    if (typeof descriptor.required !== "boolean") {
      throw new Error(`output_projections.${name}.required must be a boolean.`)
    }
    const projected = resultValue(runtimeResult, path)
    if (projected === undefined && descriptor.required) throw new Error(`output_projections.${name} did not resolve from ${path}.`)
    if (projected === undefined) continue
    output[name] = projected
  }
  return output
}

function requiredArtifacts(declarations) {
  return Array.from(new Set((Array.isArray(declarations) ? declarations : []).flatMap((declaration) => {
    const artifact = record(declaration)
    const name = string(artifact.name)
    return artifact.required === true && artifact.direction !== "input" && name ? [name] : []
  })))
}

async function testRuntimeFixtures(externalPackageSource) {
  if (process.env.NODE_ENV !== "test") return {}
  const packagePath = string(process.env.WP_CODEBOX_TEST_EXTERNAL_PACKAGE_PATH)
  const runtimeSourceInputs = string(process.env.WP_CODEBOX_TEST_RUNTIME_SOURCE_INPUTS)
  if (!packagePath && !runtimeSourceInputs) return {}
  const fixtures = {}
  if (packagePath) {
    const bytes = await readFile(packagePath)
    if (sha256BytesV1(bytes) !== externalPackageSource.digest) throw new Error("Test external package fixture digest does not match the request.")
    fixtures.materializedPackage = { bytes, descriptor: externalPackageSource, identity: canonicalExternalNativeAgentIdentity(bytes) }
  }
  if (runtimeSourceInputs) {
    try {
      fixtures.runtimeSourceInputs = JSON.parse(runtimeSourceInputs)
    } catch {
      throw new Error("WP_CODEBOX_TEST_RUNTIME_SOURCE_INPUTS must be valid JSON.")
    }
  }
  return fixtures
}

// Test-only interruption hook: inert in production (requires NODE_ENV=test and
// an explicit marker path). Publishes the seed snapshot location, then holds a
// bounded window so a harness can deliver a termination signal.
async function testPauseAfterSeedSnapshot(seedSnapshot) {
  if (process.env.NODE_ENV !== "test") return
  const markerPath = string(process.env.WP_CODEBOX_TEST_SEED_SNAPSHOT_PAUSE_FILE)
  if (!markerPath) return
  await writeFile(markerPath, `${JSON.stringify({ schema: "wp-codebox/test-seed-snapshot-pause/v1", seed_snapshot_source: seedSnapshot?.source ?? "" })}\n`)
  await new Promise((resolvePause) => setTimeout(resolvePause, 120_000))
}

function runtimeSourceFixtureRoot(value) {
  const paths = []
  const collect = (entry) => {
    if (typeof entry === "string") {
      if (isAbsolute(entry)) paths.push(resolve(entry))
      return
    }
    if (Array.isArray(entry)) return entry.forEach(collect)
    if (entry && typeof entry === "object") Object.values(entry).forEach(collect)
  }
  collect(value)
  if (paths.length === 0) return ""

  const shared = paths.map((path) => path.split("/").filter(Boolean)).reduce((prefix, parts) => prefix.filter((part, index) => parts[index] === part))
  return shared.length > 0 ? `/${shared.join("/")}` : ""
}

function workflowPath(path) {
  const relativePath = relative(workspace, resolve(path))
  return relativePath && !relativePath.startsWith("..") ? relativePath.replaceAll("\\", "/") : ".codebox/agent-task-workflow-result.json"
}

function failureClassification(error) {
  const message = error instanceof Error ? error.message : String(error)
  const code = typeof error?.code === "string" && error.code ? error.code : ""
  if (code.includes(".policy")) return { code, classification: "policy" }
  if (code && !/materializ|fetch|download|archive|entrypoint|git failed|spawn git/i.test(message)) return { code, classification: "native-agent-task" }
  if (/policy|authorized|allowlisted|allowed_repos|ACCESS_TOKEN/i.test(message)) return { code: "wp-codebox.agent-task.policy", classification: "policy" }
  if (/materializ|fetch|download|archive|entrypoint|git failed|spawn git/i.test(message)) return { code: "wp-codebox.agent-task.materialization", classification: "materialization" }
  if (/approval|publication|pull request/i.test(message)) return { code: "wp-codebox.agent-task.approval", classification: "approval" }
  if (/projection/i.test(message)) return { code: "wp-codebox.agent-task.output-projection", classification: "output-projection" }
  return { code: "wp-codebox.agent-task.execution", classification: "execution" }
}

async function writeNormalizedFailure(error, request = {}) {
  const resultPath = join(workspace, ".codebox", "agent-task-workflow-result.json")
  const failure = failureClassification(error)
  const message = bounded(error instanceof Error ? error.message : String(error), MAX_WORKFLOW_OUTPUT_BYTES)
  const accessError = failure.classification === "policy" && /allowed_repos|ACCESS_TOKEN|GitHub token|Caller repository|authorized/i.test(message)
  const result = {
    schema: "wp-codebox/agent-task-workflow-result/v1",
    run_id: `${record(request).workload?.id || "agent-task"}-${process.env.GITHUB_RUN_ID || "local"}`.replace(/[^A-Za-z0-9._-]+/g, "-"),
    status: "failed",
    success: false,
    request_path: workflowPath(requestPath),
    failure: { ...failure, message },
    ...(reviewerEvidence ? { reviewer_evidence: reviewerEvidence } : {}),
    ...(accessError ? { access: { authorized: false, error: message } } : {}),
  }
  await mkdir(join(workspace, ".codebox"), { recursive: true })
  const sanitized = sanitizeRuntimeSourceValue(redact(result), privateRuntimeSourceRootForSanitization)
  assertNoRuntimeSourcePaths(sanitized, privateRuntimeSourceRootForSanitization)
  await writeFile(resultPath, `${JSON.stringify(sanitized, null, 2)}\n`)
  await output("job_status", "failed")
  await output("result_path", ".codebox/agent-task-workflow-result.json")
}

function underRoot(root, path) {
  const contained = relative(root, path)
  return contained !== ".." && !contained.startsWith(`..${String.fromCharCode(47)}`) && !isAbsolute(contained)
}

async function canonicalReviewerTranscript(nativeRuntimeResult, artifactsPath) {
  const publicCore = await import(pathToFileURL(join(codeboxRoot, "packages/runtime-core/dist/public.js")).href)
  const refs = publicCore.normalizePublicArtifactRefDTOs(nativeRuntimeResult)
    .filter((ref) => ref.kind === "codebox-transcript" && typeof ref.path === "string" && ref.path)
  if (refs.length === 0) return undefined

  const root = await realpath(artifactsPath)
  const artifactRoot = resolve(artifactsPath)
  const transcripts = new Map()
  for (const ref of refs) {
    // Resolve first so containment, rather than spelling, defines a trusted path.
    const requested = resolve(artifactRoot, ref.path)
    const canonical = await realpath(requested).catch((error) => error?.code === "ENOENT" ? "" : Promise.reject(error))
    if (!canonical) continue
    if (!underRoot(root, canonical)) throw new Error("Canonical transcript escapes the trusted artifact root.")
    const requestedRelative = relative(artifactRoot, requested)
    if (!underRoot(artifactRoot, requested)) throw new Error("Canonical transcript escapes the trusted artifact root.")
    let current = artifactRoot
    for (const part of requestedRelative.split("/").filter(Boolean)) {
      current = join(current, part)
      const metadata = await lstat(current)
      if (metadata.isSymbolicLink()) throw new Error("Canonical transcript must not traverse symlinks.")
    }
    const metadata = await lstat(current)
    if (!metadata.isFile()) throw new Error("Canonical transcript must be a regular file.")
    const source = await realpath(current)
    const bytes = await readFile(source)
    const raw = JSON.parse(bytes.toString("utf8"))
    if (raw?.schema !== "wp-codebox/agent-transcript/v1") throw new Error("Canonical transcript must use wp-codebox/agent-transcript/v1.")
    transcripts.set(source, {
      schema: raw.schema,
      kind: "codebox-transcript",
      path: relative(root, source).replaceAll("\\", "/"),
      source_sha256: createHash("sha256").update(bytes).digest("hex"),
      size_bytes: bytes.length,
    })
  }
  if (transcripts.size === 0) return undefined
  if (transcripts.size !== 1) throw new Error("Canonical transcript requires exactly one distinct existing file.")
  return { transcript: [...transcripts.values()][0] }
}

async function redactArtifactFiles(directory, artifactRoot = directory) {
  const { readdir, stat } = await import("node:fs/promises")
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (reviewerEvidence?.transcript && path === resolve(artifactRoot, reviewerEvidence.transcript.path)) continue
    if (entry.isDirectory()) await redactArtifactFiles(path, artifactRoot)
    if (entry.isFile() && (await stat(path)).size <= 4 * 1024 * 1024) {
      const contents = await readFile(path).catch(() => null)
      if (contents && !contents.includes(0) && isUtf8(contents)) {
        const sanitized = sanitizeRuntimeSourceJson(redact(bounded(contents.toString("utf8"), 4 * 1024 * 1024)), privateRuntimeSourceRootForSanitization)
        assertNoRuntimeSourcePaths(sanitized, privateRuntimeSourceRootForSanitization)
        await writeFile(path, sanitized)
      }
    }
  }
}

async function executeNativeAgentTask() {
const request = JSON.parse(await readFile(requestPath, "utf8"))
const verificationCommands = commandEntries(request.verification_commands, "verification_commands")
const driftChecks = commandEntries(request.drift_checks, "drift_checks")
const runId = `${request.workload?.id || "agent-task"}-${process.env.GITHUB_RUN_ID || "local"}`.replace(/[^A-Za-z0-9._-]+/g, "-")
const externalPackagePolicy = parseExternalPackageSourcePolicy(string(process.env.EXTERNAL_PACKAGE_SOURCE_POLICY))
const externalPackageSource = normalizeExternalPackageSource(request.external_package_source, externalPackagePolicy)
const runtimeSources = normalizeRuntimeSources(request.runtime_sources ?? [], externalPackagePolicy)
const requestedModel = validateRuntimeSourceModel(request.model, runtimeSources)
const writablePaths = String(request.writable_paths || "").split(",").map((value) => value.trim()).filter(Boolean)
const artifactsPath = join(workspace, ".codebox", "agent-task-artifacts")
const runtimeInputPath = join(workspace, ".codebox", "native-agent-task-input.json")
const resultPath = join(workspace, ".codebox", "agent-task-workflow-result.json")
const controlledCodeboxPath = resolve(requestPath, "..")
 const nativeResultPath = join(controlledCodeboxPath, "native-agent-task-result.json")
  const runnerWorkspaceTools = [
   "workspace_read", "workspace_ls", "workspace_grep", "workspace_write", "workspace_edit", "workspace_apply_patch",
   "workspace_show", "workspace_git_status", "workspace_git_diff",
 ]

function runtimeMetadataForExecutionLocation(executionLocation) {
  if (executionLocation === "sandbox") return { environment: "runtime_local", capability_scope: "runtime_local" }
  if (executionLocation === "parent") return { environment: "control_plane", capability_scope: "control_plane" }
  throw new Error(`Unsupported tool execution location: ${executionLocation}`)
}

await mkdir(artifactsPath, { recursive: true })

 const accessError = accessFailure(request)
if (accessError) {
  const error = new Error(accessError)
  error.code = "wp-codebox.agent-task.policy"
   throw error
 }

 if (request.runner_workspace?.enabled) runnerWorkspaceSeedSnapshot = await createRunnerWorkspaceSeedSnapshot(workspace)
 await testPauseAfterSeedSnapshot(runnerWorkspaceSeedSnapshot)

const testFixtures = await testRuntimeFixtures(externalPackageSource)
const skipMaterialization = process.env.NODE_ENV === "test" && (process.env.WP_CODEBOX_TEST_SKIP_MATERIALIZATION === "true" || Boolean(testFixtures.materializedPackage || testFixtures.runtimeSourceInputs))
const materializedPackage = request.run_agent && !request.dry_run && !skipMaterialization
  ? await materializeExternalNativePackage(externalPackageSource, { policy: externalPackagePolicy })
  : testFixtures.materializedPackage
const materializedRuntimeSources = request.run_agent && !request.dry_run && !skipMaterialization
  ? await materializeRuntimeSources(runtimeSources, { policy: externalPackagePolicy, forbiddenRoots: [workspace, artifactsPath] })
  : undefined
privateRuntimeSourceRoot = materializedRuntimeSources?.root ?? ""
privateRuntimeSourceRootForSanitization = privateRuntimeSourceRoot
await output("runtime_source_root", privateRuntimeSourceRoot)
const runtimeSourceInputs = (materializedRuntimeSources?.lowered ?? []).reduce((input, lowered) => {
  for (const [key, entries] of Object.entries(lowered)) input[key] = [...(input[key] ?? []), ...entries]
  return input
}, testFixtures.runtimeSourceInputs ?? {})
const runtimeSourceOutputRoots = [privateRuntimeSourceRoot, runtimeSourceFixtureRoot(testFixtures.runtimeSourceInputs)]
// Runtime source preparation must remain beside the private checkout, never in
// the target artifact directory that is collected after the run.
const privatePreparationRoot = privateRuntimeSourceRoot ? join(privateRuntimeSourceRoot, "prepared-runtime-sources") : ""
const sourcePackageRoot = privatePreparationRoot || artifactsPath
const executionInputPath = privateRuntimeSourceRoot ? join(privateRuntimeSourceRoot, "native-agent-task-input.json") : runtimeInputPath

const taskInput = {
  schema: "wp-codebox/agent-task-run-request/v1",
  task_id: runId,
    artifacts_path: artifactsPath,
    source_package_root: sourcePackageRoot,
  callback_data: record(request.callback_data),
  task_input: {
    schema: "wp-codebox/task-input/v1",
    goal: request.prompt,
    target: { kind: "repo", materialization: { root: workspace } },
    expected_artifacts: request.artifacts?.expected || [],
    structured_artifacts: request.artifacts?.declarations || [],
    secret_env: ["OPENAI_API_KEY", "MODEL_PROVIDER_SECRET_1", "MODEL_PROVIDER_SECRET_2", "MODEL_PROVIDER_SECRET_3", "MODEL_PROVIDER_SECRET_4", "MODEL_PROVIDER_SECRET_5"].filter((name) => process.env[name]),
    ...runtimeSourceInputs,
     allowed_tools: runnerWorkspaceTools,
    sandbox_tool_policy: {
      schema: "wp-codebox/sandbox-tool-policy/v1",
      version: 1,
       tools: runnerWorkspaceTools.map((id) => ({ id, runtime_tool_id: id, execution_location: "sandbox", transport_visibility: "sandbox", allowed: true, runtime: runtimeMetadataForExecutionLocation("sandbox") })),
    },
    max_turns: request.limits?.max_turns,
    task_timeout_seconds: Math.ceil(Number(request.limits?.time_budget_ms || 0) / 1000),
    runtime_task: {
      kind: "bundle",
      ability: "wp-codebox/run-runtime-package",
      input: {
        schema: "wp-codebox/runtime-package-task/v1",
        package: {
          slug: materializedPackage?.identity.slug || "external-agent-pending-materialization",
          source: "public-external-package",
          external_source: externalPackageSource,
          bootstrap: materializedPackage ? { encoding: "base64", bytes: materializedPackage.bytes.toString("base64"), digest: externalPackageSource.digest } : undefined,
        },
        workflow: { id: "agents/chat" },
        input: {
          prompt: request.prompt,
          provider: requestedModel.provider,
          model: requestedModel.name,
          runner_workspace: { ...record(request.runner_workspace), allowed_repos: request.access.allowed_repos },
          target_repo: request.target_repo,
           writable_paths: writablePaths,
            runner_workspace_policy: { allowed_repos: request.access.allowed_repos, writable_paths: writablePaths },
        },
        artifact_declarations: request.artifacts?.declarations || [],
        required_artifacts: requiredArtifacts(request.artifacts?.declarations),
        output_projections: [],
         metadata: { workload: request.workload, ...(materializedPackage ? { imported_agent: materializedPackage.identity } : {}), runtime_sources: materializedRuntimeSources?.descriptors ?? [], ...(runnerWorkspaceSeedSnapshot ? { runner_workspace_seed: runnerWorkspaceSeedSnapshot.provenance } : {}) },
      },
    },
       // agent-task-run unwraps task_input before building the recipe. The
       // external snapshot prevents the recipe from ever mounting the checkout.
       workspaces: runnerWorkspaceSeedSnapshot ? [{ target: "/workspace", mode: "readwrite", sourceMode: "repo-backed", seed: { type: "directory", source: runnerWorkspaceSeedSnapshot.source, excludePaths: RUNNER_WORKSPACE_SEED_EXCLUDES } }] : [],
    },
  }

await writeFile(executionInputPath, `${JSON.stringify(taskInput, null, 2)}\n`)

let execution = { code: 0, stdout: "", stderr: "", stdout_truncated: false, stderr_truncated: false }
if (request.run_agent && !request.dry_run) {
   if (request.runner_workspace?.enabled) trustedApplyArtifactRoot = await createTrustedArtifactApplyChannel()
   execution = await command("node", [codeboxCliPath, "agent-task-run", "--input-file", executionInputPath, "--result-file", nativeResultPath], workspace, agentEnvironment(trustedApplyArtifactRoot ? { WP_CODEBOX_TRUSTED_APPLY_ARTIFACT_ROOT: trustedApplyArtifactRoot } : {}))
 }

// Public package bytes are embedded in the runtime recipe and consumed only by
// the Playground bootstrap before the agent's tools are resolved.

const nativeRuntimeResult = request.run_agent && !request.dry_run
  ? await readNativeResult(nativeResultPath, controlledCodeboxPath, secretValues, redact)
  : {}
await rm(nativeResultPath, { force: true })
reviewerEvidence = await canonicalReviewerTranscript(nativeRuntimeResult, artifactsPath)
const toolObservability = canonicalToolObservability(record(nativeRuntimeResult).metadata)
  ?? canonicalToolObservability(record(record(nativeRuntimeResult).agent_task_run_result).metadata)
let runtimeResult = sanitizeRuntimeSourceValue(nativeRuntimeResult, privateRuntimeSourceRootForSanitization)
removeRawToolObservability(runtimeResult)
const normalizedAgentTaskResult = record(record(runtimeResult).agent_task_run_result)
if (toolObservability) {
  normalizedAgentTaskResult.metadata = {
    ...record(normalizedAgentTaskResult.metadata),
    tool_observability: toolObservability,
  }
}
assertNoRuntimeSourcePaths(runtimeResult, privateRuntimeSourceRootForSanitization)
let workspaceApply = { status: "no-op", changedFiles: [] }
let runnerWorkspaceCore = null
let downstreamFailure = null
if (execution.code === 0 && runtimeResult.success === true && request.runner_workspace?.enabled) {
  try {
    runnerWorkspaceCore = await import(pathToFileURL(join(codeboxRoot, "packages/runtime-core/dist/runner-workspace-apply.js")).href)
    const publicCore = await import(pathToFileURL(join(codeboxRoot, "packages/runtime-core/dist/public.js")).href)
    const refs = publicCore.normalizePublicArtifactRefDTOs(runtimeResult)
      .filter((ref) => ref.kind === "codebox-patch" || ref.kind === "codebox-changed-files")
    const trustedArtifacts = await trustedArtifactApplyRefs(trustedApplyArtifactRoot, refs)
    workspaceApply = await runnerWorkspaceCore.applyRunnerWorkspacePatch({ artifactRoot: trustedArtifacts.root, artifactRefs: trustedArtifacts.refs, workspaceRoot: workspace, writablePaths, seedIdentity: runnerWorkspaceSeedSnapshot?.provenance.identity })
  } catch (error) {
    downstreamFailure = { stage: "apply", message: bounded(error instanceof Error ? error.message : String(error), MAX_WORKFLOW_OUTPUT_BYTES), ...(error?.evidence ? { evidence: error.evidence } : {}) }
  }
}
if (trustedApplyArtifactRoot) {
  await rm(trustedApplyArtifactRoot, { recursive: true, force: true })
  trustedApplyArtifactRoot = ""
}
runtimeResult = sanitizeRuntimeSourceValue(runtimeResult, runtimeSourceOutputRoots)
privateRuntimeSourceRootForSanitization = runtimeSourceOutputRoots
assertNoRuntimeSourcePaths(runtimeResult, privateRuntimeSourceRootForSanitization)

await redactArtifactFiles(artifactsPath)

const verification = []
if (execution.code === 0 && request.run_agent && !request.dry_run && !downstreamFailure) {
  const validationDependencies = string(request.validation_dependencies)
  if (validationDependencies) {
    const checkResult = await command("bash", ["-lc", validationDependencies], workspace)
    verification.push({ kind: "validation_dependencies", command: validationDependencies, description: "Install validation dependencies", success: checkResult.code === 0, exit_code: checkResult.code, stdout: checkResult.stdout, stderr: checkResult.stderr, stdout_truncated: checkResult.stdout_truncated, stderr_truncated: checkResult.stderr_truncated })
  }
  for (const check of verificationCommands) {
    const checkResult = await command("bash", ["-lc", check.command], workspace)
    verification.push({ kind: "verification", ...check, success: checkResult.code === 0, exit_code: checkResult.code, stdout: checkResult.stdout, stderr: checkResult.stderr, stdout_truncated: checkResult.stdout_truncated, stderr_truncated: checkResult.stderr_truncated })
  }
  for (const check of driftChecks) {
    const checkResult = await command("bash", ["-lc", check.command], workspace)
    verification.push({ kind: "drift", ...check, success: checkResult.code === 0, exit_code: checkResult.code, stdout: checkResult.stdout, stderr: checkResult.stderr, stdout_truncated: checkResult.stdout_truncated, stderr_truncated: checkResult.stderr_truncated })
  }
}

const verificationPassed = verification.every((check) => check.success)
if (!verificationPassed) {
  downstreamFailure ??= { stage: "verification", message: "Runner workspace verification did not pass." }
}
const runtimeRecord = record(runtimeResult)
const agentResult = record(runtimeRecord.agent_task_run_result)
let publication = resultValue(runtimeRecord, "metadata.runner_workspace_publication")
if (execution.code === 0 && runtimeRecord.success === true && verificationPassed && workspaceApply.status === "applied") {
  try {
    await runnerWorkspaceCore.verifyRunnerWorkspaceIntegrity(workspaceApply.integrity)
    const testPublisher = string(process.env.WP_CODEBOX_TEST_PUBLISHER_MODULE)
    const publisher = testPublisher ? (await import(pathToFileURL(resolve(testPublisher)).href)).publishRunnerWorkspace : publishRunnerWorkspace
     const testHook = testPublisher && process.env.WP_CODEBOX_TEST_PUBLISHER_HOOK
       ? JSON.parse(process.env.WP_CODEBOX_TEST_PUBLISHER_HOOK)
       : undefined
     publication = await publisher({ request, changedFiles: workspaceApply.changedFiles, publicationFiles: workspaceApply.publicationFiles, token: process.env.ACCESS_TOKEN || process.env.GITHUB_TOKEN, ...(testHook ? { testHook } : {}) })
    runtimeRecord.metadata = { ...record(runtimeRecord.metadata), runner_workspace_publication: publication }
    runtimeRecord.outputs = { ...record(runtimeRecord.outputs), runner_workspace_publication: publication }
  } catch (error) {
    downstreamFailure = { stage: "publication", message: bounded(error instanceof Error ? error.message : String(error), MAX_WORKFLOW_OUTPUT_BYTES) }
  }
}
if (request.success?.requires_pr === true && workspaceApply.status === "no-op" && !publication) {
  downstreamFailure ??= { stage: "no-op", message: "success_requires_pr cannot succeed for a no-op runner workspace task." }
}
let evaluatedProjections = {}
let projectionError
try {
  evaluatedProjections = projections(request.outputs?.projections, runtimeRecord)
  validateProjectionOutputSize(evaluatedProjections)
} catch (error) {
  projectionError = {
    code: typeof error?.code === "string" ? error.code : "wp-codebox.agent-task.output-projection",
    classification: "output-projection",
    message: error instanceof Error ? error.message : String(error),
    ...(typeof error?.output_name === "string" ? { output_name: error.output_name } : {}),
    ...(Number.isSafeInteger(error?.bytes) ? { bytes: error.bytes } : {}),
    ...(Number.isSafeInteger(error?.max_bytes) ? { max_bytes: error.max_bytes } : {}),
  }
}
const publicationRequired = request.success?.requires_pr === true
const publicationVerification = publicationRequired && execution.code === 0 && runtimeRecord.success === true
  ? await verifyPublishedPullRequest(publication, request.target_repo, workspace)
  : { valid: !publicationRequired, error: "" }
const publicationPassed = publicationVerification.valid
if (publicationRequired && !publicationPassed) {
  downstreamFailure ??= { stage: "publication", message: publicationVerification.error || "Runner workspace publication did not pass verification." }
}
const success = request.run_agent && !request.dry_run
  ? execution.code === 0 && runtimeRecord.success === true && verificationPassed && publicationPassed && !projectionError && !downstreamFailure
  : true
const status = request.run_agent && !request.dry_run ? (success ? "succeeded" : "failed") : "skipped"
const workflowOutputs = {
  transcript_json: await workflowOutputReference("transcript_json", serializedJson(agentResult.refs?.transcripts || []), artifactsPath),
  engine_data_json: await workflowOutputReference("engine_data_json", serializedJson(redact(record(runtimeRecord.outputs))), artifactsPath),
  projected_outputs_json: { rendered: serializedJson(projectionError ? { error: projectionError } : evaluatedProjections) },
  declared_artifacts_json: await workflowOutputReference("declared_artifacts_json", serializedJson(request.artifacts?.declarations || []), artifactsPath),
}
const result = {
  schema: "wp-codebox/agent-task-workflow-result/v1",
  run_id: runId,
  status,
  success,
  request_path: requestPath,
  runtime_input_path: ".codebox/native-agent-task-input.json",
  execution: { stdout_truncated: execution.stdout_truncated, stderr_truncated: execution.stderr_truncated },
  runtime_result: redact(runtimeRecord),
  ...(reviewerEvidence ? { reviewer_evidence: reviewerEvidence } : {}),
  verification,
  publication,
  transcript: { artifact_name: request.artifacts?.transcript_name || "agent-task-transcript" },
  artifacts: { declarations: request.artifacts?.declarations || [], expected: request.artifacts?.expected || [], replay_bundle_name: request.artifacts?.replay_bundle_name || "" },
  outputs: {
    engine_data: record(runtimeRecord.outputs),
    projections: evaluatedProjections,
  },
  ...(Object.values(workflowOutputs).some((output) => output.reference) ? {
    workflow_output_artifacts: Object.fromEntries(Object.entries(workflowOutputs)
      .flatMap(([name, output]) => output.reference ? [[name, output.reference]] : [])),
  } : {}),
  access: { authorized: true, credential_mode: process.env.GITHUB_TOKEN ? "runner-access-token" : (process.env.OPENAI_API_KEY ? "runner-provider-credentials" : "runner-default-credentials"), policy: { allowed_repos: request.access.allowed_repos } },
  ...(publicationRequired ? { publication_verification: publicationVerification } : {}),
  ...(publicationRequired && !publicationPassed ? { publication_error: "success_requires_pr requires a valid published runner-workspace pull request for target_repo." } : {}),
  ...(downstreamFailure ? { failure: { code: "wp-codebox.agent-task.downstream", classification: "downstream", ...downstreamFailure } } : {}),
  ...(projectionError ? { projection_error: projectionError } : {}),
}

const sanitizedResult = sanitizeRuntimeSourceValue(redact(result), privateRuntimeSourceRootForSanitization)
assertNoRuntimeSourcePaths(sanitizedResult, privateRuntimeSourceRootForSanitization)
await writeFile(resultPath, `${JSON.stringify(sanitizedResult, null, 2)}\n`)
await output("job_status", status)
await output("transcript_json", workflowOutputs.transcript_json.rendered)
await output("transcript_summary", `${request.workload?.label || "Run Agent Task"}: ${status}`)
await output("engine_data_json", workflowOutputs.engine_data_json.rendered)
await output("projected_outputs_json", workflowOutputs.projected_outputs_json.rendered)
await output("credential_mode", result.access.credential_mode)
await output("declared_artifacts_json", workflowOutputs.declared_artifacts_json.rendered)
await output("result_path", ".codebox/agent-task-workflow-result.json")

if (!success) process.exitCode = 1
}

try {
  await executeNativeAgentTask()
} catch (error) {
  await writeNormalizedFailure(error)
  console.error(bounded(error instanceof Error ? error.message : String(error), MAX_WORKFLOW_OUTPUT_BYTES))
  process.exitCode = 1
} finally {
  await cleanupMaterializedSources()
}
