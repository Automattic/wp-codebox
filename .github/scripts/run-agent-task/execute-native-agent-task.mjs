import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { spawn } from "node:child_process"
import { materializeExternalNativePackage, normalizeExternalPackageSource, parseExternalPackageSourcePolicy } from "./materialize-external-native-package.mjs"
import { readNativeResult } from "./native-result-file.mjs"

const requestPath = process.env.AGENT_TASK_REQUEST_PATH || ".codebox/agent-task-request.json"
const workspace = resolve(process.env.AGENT_TASK_WORKSPACE || process.cwd())
const codeboxRoot = resolve(process.env.WP_CODEBOX_WORKFLOW_ROOT || ".")
const codeboxCliPath = process.env.WP_CODEBOX_CLI_PATH || join(codeboxRoot, "packages/cli/dist/index.js")
const outputPath = process.env.GITHUB_OUTPUT
const MAX_CAPTURE_BYTES = 32768
const MAX_OUTPUT_CHARS = 8192
const secretValues = ["OPENAI_API_KEY", "MODEL_PROVIDER_SECRET_1", "MODEL_PROVIDER_SECRET_2", "MODEL_PROVIDER_SECRET_3", "MODEL_PROVIDER_SECRET_4", "MODEL_PROVIDER_SECRET_5", "GITHUB_TOKEN", "GH_TOKEN", "ACCESS_TOKEN", "EXTERNAL_PACKAGE_SOURCE_POLICY"].map((name) => process.env[name]).filter(Boolean)
function redact(value) {
  if (typeof value === "string") return secretValues.reduce((output, secret) => output.split(secret).join("[REDACTED]"), value)
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redact(entry)]))
  return value
}

function bounded(value, limit = MAX_CAPTURE_BYTES) {
  const safe = redact(value)
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
  return appendFile(outputPath, `${name}<<__WP_CODEBOX_OUTPUT__\n${bounded(rendered, MAX_OUTPUT_CHARS)}\n__WP_CODEBOX_OUTPUT__\n`)
}

function safeEnvironment(extra = {}) {
  return { PATH: process.env.PATH || "", HOME: process.env.HOME || "", CI: process.env.CI || "true", ...extra }
}

function agentEnvironment() {
  return safeEnvironment(Object.fromEntries(["OPENAI_API_KEY", "MODEL_PROVIDER_SECRET_1", "MODEL_PROVIDER_SECRET_2", "MODEL_PROVIDER_SECRET_3", "MODEL_PROVIDER_SECRET_4", "MODEL_PROVIDER_SECRET_5", "GITHUB_TOKEN"].map((name) => [name, process.env[name]]).filter(([, value]) => value)))
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
  if (!string(process.env.GITHUB_TOKEN)) return "No effective GitHub token is available for runner workspace tools."
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
  for (const [name, source] of entries) {
    if (typeof source !== "string" || !source.trim() || !/^[A-Za-z0-9_.-]+(?:\.[A-Za-z0-9_.-]+)*$/.test(source)) {
      throw new Error(`output_projections.${name} must be a dot-delimited result path.`)
    }
    const projected = resultValue(runtimeResult, source.trim())
    if (projected === undefined) throw new Error(`output_projections.${name} did not resolve from ${source}.`)
    output[name] = projected
  }
  return output
}

async function redactArtifactFiles(directory) {
  const { readdir, stat } = await import("node:fs/promises")
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await redactArtifactFiles(path)
    if (entry.isFile() && (await stat(path)).size <= 4 * 1024 * 1024) {
      const contents = await readFile(path, "utf8").catch(() => null)
      if (contents !== null) await writeFile(path, bounded(contents, 4 * 1024 * 1024))
    }
  }
}

const request = JSON.parse(await readFile(requestPath, "utf8"))
const verificationCommands = commandEntries(request.verification_commands, "verification_commands")
const driftChecks = commandEntries(request.drift_checks, "drift_checks")
const runId = `${request.workload?.id || "agent-task"}-${process.env.GITHUB_RUN_ID || "local"}`.replace(/[^A-Za-z0-9._-]+/g, "-")
const externalPackagePolicy = parseExternalPackageSourcePolicy(string(process.env.EXTERNAL_PACKAGE_SOURCE_POLICY))
const externalPackageSource = normalizeExternalPackageSource(request.external_package_source, externalPackagePolicy)
const artifactsPath = join(workspace, ".codebox", "agent-task-artifacts")
const runtimeInputPath = join(workspace, ".codebox", "native-agent-task-input.json")
const resultPath = join(workspace, ".codebox", "agent-task-workflow-result.json")
const controlledCodeboxPath = resolve(requestPath, "..")
const nativeResultPath = join(controlledCodeboxPath, "native-agent-task-result.json")
const runnerWorkspaceTools = [
  "workspace-read", "workspace-ls", "workspace-grep", "workspace-write", "workspace-edit", "workspace-apply-patch",
  "workspace-git-status", "workspace-git-diff", "workspace-git-add", "workspace-git-commit", "workspace-git-push",
  "create-github-pull-request", "create-github-issue", "comment-github-pull-request",
]

function runtimeMetadataForExecutionLocation(executionLocation) {
  if (executionLocation === "sandbox") return { environment: "runtime_local", capability_scope: "runtime_local" }
  if (executionLocation === "parent") return { environment: "control_plane", capability_scope: "control_plane" }
  throw new Error(`Unsupported tool execution location: ${executionLocation}`)
}

await mkdir(artifactsPath, { recursive: true })

const accessError = accessFailure(request)
if (accessError) {
  const result = { schema: "wp-codebox/agent-task-workflow-result/v1", run_id: runId, status: "failed", success: false, request_path: requestPath, access: { authorized: false, error: accessError } }
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`)
  await output("job_status", "failed")
  process.exitCode = 1
  process.exit()
}

const materializedPackage = request.run_agent && !request.dry_run
  ? await materializeExternalNativePackage(externalPackageSource, { policy: externalPackagePolicy })
  : undefined

const taskInput = {
  schema: "wp-codebox/agent-task-run-request/v1",
  task_id: runId,
  artifacts_path: artifactsPath,
  callback_data: record(request.callback_data),
  task_input: {
    schema: "wp-codebox/task-input/v1",
    goal: request.prompt,
    target: { kind: "repo", materialization: { root: workspace } },
    expected_artifacts: request.artifacts?.expected || [],
    structured_artifacts: request.artifacts?.declarations || [],
    provider: request.model?.provider,
    model: request.model?.name,
    secret_env: ["OPENAI_API_KEY", "MODEL_PROVIDER_SECRET_1", "MODEL_PROVIDER_SECRET_2", "MODEL_PROVIDER_SECRET_3", "MODEL_PROVIDER_SECRET_4", "MODEL_PROVIDER_SECRET_5"].filter((name) => process.env[name]),
    allowed_tools: runnerWorkspaceTools,
    sandbox_tool_policy: {
      schema: "wp-codebox/sandbox-tool-policy/v1",
      version: 1,
      tools: runnerWorkspaceTools.map((id) => ({ id, runtime_tool_id: id, execution_location: "parent", transport_visibility: "visible", allowed: true, runtime: runtimeMetadataForExecutionLocation("parent") })),
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
          runner_workspace: { ...record(request.runner_workspace), allowed_repos: request.access.allowed_repos },
          target_repo: request.target_repo,
          writable_paths: request.writable_paths,
          runner_workspace_policy: { allowed_repos: request.access.allowed_repos },
        },
        artifact_declarations: request.artifacts?.declarations || [],
        required_artifacts: request.artifacts?.expected || [],
        output_projections: [],
        metadata: { workload: request.workload, ...(materializedPackage ? { imported_agent: materializedPackage.identity } : {}) },
      },
    },
  },
}

await writeFile(runtimeInputPath, `${JSON.stringify(taskInput, null, 2)}\n`)

let execution = { code: 0, stdout: "", stderr: "", stdout_truncated: false, stderr_truncated: false }
if (request.run_agent && !request.dry_run) {
  execution = await command("node", [codeboxCliPath, "agent-task-run", "--input-file", runtimeInputPath, "--result-file", nativeResultPath], workspace, agentEnvironment())
}

// Public package bytes are embedded in the runtime recipe and consumed only by
// the Playground bootstrap before the agent's tools are resolved.

const runtimeResult = request.run_agent && !request.dry_run
  ? await readNativeResult(nativeResultPath, controlledCodeboxPath, secretValues, redact)
  : {}
await rm(nativeResultPath, { force: true })

await redactArtifactFiles(artifactsPath)

const verification = []
if (execution.code === 0 && request.run_agent && !request.dry_run) {
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
const runtimeRecord = record(runtimeResult)
const agentResult = record(runtimeRecord.agent_task_run_result)
const publication = resultValue(runtimeRecord, "outputs.artifact_result.result.outputs.runner_workspace_publication")
let evaluatedProjections = {}
let projectionError = ""
try {
  evaluatedProjections = projections(request.outputs?.projections, runtimeRecord)
} catch (error) {
  projectionError = error instanceof Error ? error.message : String(error)
}
const publicationRequired = request.success?.requires_pr === true
const publicationVerification = publicationRequired && execution.code === 0 && runtimeRecord.success === true
  ? await verifyPublishedPullRequest(publication, request.target_repo, workspace)
  : { valid: !publicationRequired, error: "" }
const publicationPassed = publicationVerification.valid
const success = request.run_agent && !request.dry_run
  ? execution.code === 0 && runtimeRecord.success === true && verificationPassed && publicationPassed && !projectionError
  : true
const status = request.run_agent && !request.dry_run ? (success ? "succeeded" : "failed") : "skipped"
const result = {
  schema: "wp-codebox/agent-task-workflow-result/v1",
  run_id: runId,
  status,
  success,
  request_path: requestPath,
  runtime_input_path: ".codebox/native-agent-task-input.json",
  execution: { stdout_truncated: execution.stdout_truncated, stderr_truncated: execution.stderr_truncated },
  runtime_result: redact(runtimeRecord),
  verification,
  publication,
  transcript: { artifact_name: request.artifacts?.transcript_name || "agent-task-transcript" },
  artifacts: { declarations: request.artifacts?.declarations || [], expected: request.artifacts?.expected || [], replay_bundle_name: request.artifacts?.replay_bundle_name || "" },
  outputs: {
    engine_data: record(runtimeRecord.outputs),
    projections: evaluatedProjections,
  },
  access: { authorized: true, credential_mode: process.env.GITHUB_TOKEN ? "runner-access-token" : (process.env.OPENAI_API_KEY ? "runner-provider-credentials" : "runner-default-credentials"), policy: { allowed_repos: request.access.allowed_repos } },
  ...(publicationRequired ? { publication_verification: publicationVerification } : {}),
  ...(publicationRequired && !publicationPassed ? { publication_error: "success_requires_pr requires a valid published runner-workspace pull request for target_repo." } : {}),
  ...(projectionError ? { projection_error: projectionError } : {}),
}

await writeFile(resultPath, `${JSON.stringify(redact(result), null, 2)}\n`)
await output("job_status", status)
await output("transcript_json", JSON.stringify(agentResult.refs?.transcripts || []))
await output("transcript_summary", `${request.workload?.label || "Run Agent Task"}: ${status}`)
await output("engine_data_json", result.outputs.engine_data)
await output("projected_outputs_json", result.outputs.projections)
await output("credential_mode", result.access.credential_mode)
await output("declared_artifacts_json", result.artifacts.declarations)
await output("result_path", ".codebox/agent-task-workflow-result.json")

if (!success) process.exitCode = 1
