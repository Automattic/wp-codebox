import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { basename, join, resolve } from "node:path"
import { spawn } from "node:child_process"

const requestPath = process.env.AGENT_TASK_REQUEST_PATH || ".codebox/agent-task-request.json"
const workspace = resolve(process.env.AGENT_TASK_WORKSPACE || process.cwd())
const codeboxRoot = resolve(process.env.WP_CODEBOX_WORKFLOW_ROOT || ".")
const codeboxCliPath = process.env.WP_CODEBOX_CLI_PATH || join(codeboxRoot, "packages/cli/dist/index.js")
const outputPath = process.env.GITHUB_OUTPUT

function output(name, value) {
  if (!outputPath) return Promise.resolve()
  return appendFile(outputPath, `${name}<<__WP_CODEBOX_OUTPUT__\n${typeof value === "string" ? value : JSON.stringify(value)}\n__WP_CODEBOX_OUTPUT__\n`)
}

function command(command, args, cwd) {
  return new Promise((resolveCommand) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.on("close", (code) => resolveCommand({ code: code ?? 1, stdout, stderr }))
    child.on("error", (error) => resolveCommand({ code: 1, stdout, stderr: `${stderr}${error.message}\n` }))
  })
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {}
}

function string(value) {
  return typeof value === "string" ? value.trim() : ""
}

function verificationCommands(value) {
  return Array.isArray(value) ? value.flatMap((entry) => {
    if (typeof entry === "string" && entry.trim()) return [{ command: entry.trim(), description: entry.trim() }]
    const item = record(entry)
    const command = string(item.command)
    return command ? [{ command, description: string(item.description) || command }] : []
  }) : []
}

function resultValue(result, path) {
  return path.split(".").reduce((value, key) => record(value)[key], result)
}

const request = JSON.parse(await readFile(requestPath, "utf8"))
const runId = `${request.workload?.id || "agent-task"}-${process.env.GITHUB_RUN_ID || "local"}`.replace(/[^A-Za-z0-9._-]+/g, "-")
const packageSlug = basename(string(request.agent_bundle).replace(/\/+$/, ""))
const runtimePackageSource = `/workspace/${basename(workspace)}/${string(request.agent_bundle).replace(/^\/+/, "")}`
const artifactsPath = join(workspace, ".codebox", "agent-task-artifacts")
const runtimeInputPath = join(workspace, ".codebox", "native-agent-task-input.json")
const resultPath = join(workspace, ".codebox", "agent-task-workflow-result.json")
const runnerWorkspaceTools = [
  "workspace-read", "workspace-ls", "workspace-grep", "workspace-write", "workspace-edit", "workspace-apply-patch",
  "workspace-git-status", "workspace-git-diff", "workspace-git-add", "workspace-git-commit", "workspace-git-push",
  "create-github-pull-request", "create-github-issue", "comment-github-pull-request",
]

await mkdir(artifactsPath, { recursive: true })

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
    agent_bundles: [{ slug: packageSlug, source: runtimePackageSource }],
    provider: request.model?.provider,
    model: request.model?.name,
    secret_env: ["OPENAI_API_KEY", "MODEL_PROVIDER_SECRET_1", "MODEL_PROVIDER_SECRET_2", "MODEL_PROVIDER_SECRET_3", "MODEL_PROVIDER_SECRET_4", "MODEL_PROVIDER_SECRET_5"].filter((name) => process.env[name]),
    allowed_tools: runnerWorkspaceTools,
    sandbox_tool_policy: {
      schema: "wp-codebox/sandbox-tool-policy/v1",
      version: 1,
      tools: runnerWorkspaceTools.map((id) => ({ id, runtime_tool_id: id, execution_location: "parent", transport_visibility: "visible", allowed: true })),
    },
    max_turns: request.limits?.max_turns,
    task_timeout_seconds: Math.ceil(Number(request.limits?.time_budget_ms || 0) / 1000),
    runtime_task: {
      kind: "bundle",
      ability: "wp-codebox/run-runtime-package",
      input: {
        schema: "wp-codebox/runtime-package-task/v1",
        package: { slug: packageSlug, source: runtimePackageSource },
        workflow: { id: packageSlug },
        input: {
          prompt: request.prompt,
          runner_workspace: request.runner_workspace,
          target_repo: request.target_repo,
          writable_paths: request.writable_paths,
          verification_commands: request.verification_commands,
          drift_checks: request.drift_checks,
          workspace_contract_checks: request.workspace_contract_checks,
        },
        artifact_declarations: request.artifacts?.declarations || [],
        required_artifacts: request.artifacts?.expected || [],
        metadata: { workload: request.workload, output_projections: request.outputs?.projections || {} },
      },
    },
  },
}

await writeFile(runtimeInputPath, `${JSON.stringify(taskInput, null, 2)}\n`)

let execution = { code: 0, stdout: "", stderr: "" }
if (request.run_agent && !request.dry_run) {
  execution = await command("node", [codeboxCliPath, "agent-task-run", "--input-file", runtimeInputPath, "--json"], workspace)
}

let runtimeResult = {}
try {
  runtimeResult = JSON.parse(execution.stdout)
} catch {
  runtimeResult = { success: false, diagnostics: [{ code: "wp-codebox.agent-task.invalid-result", message: "Native agent-task-run did not return JSON.", stderr: execution.stderr }] }
}

const verification = []
if (execution.code === 0 && request.run_agent && !request.dry_run) {
  for (const check of verificationCommands(request.verification_commands)) {
    const checkResult = await command("bash", ["-lc", check.command], workspace)
    verification.push({ ...check, success: checkResult.code === 0, exit_code: checkResult.code, stdout: checkResult.stdout, stderr: checkResult.stderr })
  }
}

const verificationPassed = verification.every((check) => check.success)
const runtimeRecord = record(runtimeResult)
const agentResult = record(runtimeRecord.agent_task_run_result)
const publication = resultValue(runtimeRecord, "outputs.artifact_result.result.outputs.runner_workspace_publication")
const success = request.run_agent && !request.dry_run
  ? execution.code === 0 && runtimeRecord.success === true && verificationPassed
  : true
const status = request.run_agent && !request.dry_run ? (success ? "succeeded" : "failed") : "skipped"
const result = {
  schema: "wp-codebox/agent-task-workflow-result/v1",
  run_id: runId,
  status,
  success,
  request_path: requestPath,
  runtime_input_path: ".codebox/native-agent-task-input.json",
  runtime_result: runtimeRecord,
  verification,
  publication,
  transcript: { artifact_name: request.artifacts?.transcript_name || "agent-task-transcript" },
  artifacts: { declarations: request.artifacts?.declarations || [], expected: request.artifacts?.expected || [], replay_bundle_name: request.artifacts?.replay_bundle_name || "" },
  outputs: {
    engine_data: record(runtimeRecord.outputs),
    projections: record(request.outputs?.projections),
  },
  access: { credential_mode: process.env.OPENAI_API_KEY ? "runner-provider-credentials" : "runner-default-credentials" },
}

await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`)
await output("job_status", status)
await output("transcript_json", JSON.stringify(agentResult.refs?.transcripts || []))
await output("transcript_summary", `${request.workload?.label || "Run Agent Task"}: ${status}`)
await output("engine_data_json", result.outputs.engine_data)
await output("credential_mode", result.access.credential_mode)
await output("declared_artifacts_json", result.artifacts.declarations)
await output("result_path", ".codebox/agent-task-workflow-result.json")

if (!success) process.exitCode = 1
