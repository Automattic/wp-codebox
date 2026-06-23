import { mkdirSync, writeFileSync, appendFileSync } from "node:fs"

function parseJson(name, fallback, expected) {
  const raw = process.env[name]
  const value = raw && raw.trim() ? JSON.parse(raw) : fallback
  if (expected === "array" && !Array.isArray(value)) {
    throw new Error(`${name} must be a JSON array.`)
  }
  if (expected === "object" && (!value || typeof value !== "object" || Array.isArray(value))) {
    throw new Error(`${name} must be a JSON object.`)
  }
  return value
}

function requiredString(name) {
  const value = process.env[name]?.trim() ?? ""
  if (!value) {
    throw new Error(`${name} is required.`)
  }
  return value
}

function booleanEnv(name) {
  return process.env[name] === "true"
}

function numberEnv(name) {
  const value = Number(process.env[name])
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a number.`)
  }
  return value
}

function output(name, value) {
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}<<__WP_CODEBOX_OUTPUT__\n${String(value)}\n__WP_CODEBOX_OUTPUT__\n`)
}

const artifactDeclarations = parseJson("ARTIFACT_DECLARATIONS", [], "array")
const request = {
  schema: "wp-codebox/agent-task-workflow-request/v1",
  runner_recipe: requiredString("RUNNER_RECIPE"),
  agent_bundle: requiredString("AGENT_BUNDLE"),
  workload: {
    id: process.env.WORKLOAD_ID || "agent-task",
    label: process.env.WORKLOAD_LABEL || "Run Agent Task",
    component_id: process.env.COMPONENT_ID || "agent-task",
  },
  target_repo: requiredString("TARGET_REPO"),
  prompt: requiredString("PROMPT"),
  writable_paths: process.env.WRITABLE_PATHS || "",
  model: {
    provider: process.env.PROVIDER || "openai",
    name: process.env.MODEL || "gpt-5.5",
  },
  runner_workspace: parseJson("RUNNER_WORKSPACE", {}, "object"),
  validation_dependencies: process.env.VALIDATION_DEPENDENCIES || "",
  context_repositories: parseJson("CONTEXT_REPOSITORIES", [], "array"),
  verification_commands: parseJson("VERIFICATION_COMMANDS", [], "array"),
  drift_checks: parseJson("DRIFT_CHECKS", [], "array"),
  workspace_contract_checks: parseJson("WORKSPACE_CONTRACT_CHECKS", {}, "object"),
  actions_artifact_downloads: parseJson("ACTIONS_ARTIFACT_DOWNLOADS", [], "array"),
  success: {
    requires_pr: booleanEnv("SUCCESS_REQUIRES_PR"),
    completion_outcomes: parseJson("SUCCESS_COMPLETION_OUTCOMES", [], "array"),
  },
  access: {
    access_token_repos: process.env.ACCESS_TOKEN_REPOS || process.env.TARGET_REPO || "",
    require_access_token: booleanEnv("REQUIRE_ACCESS_TOKEN"),
    allowed_repos: parseJson("ALLOWED_REPOS", [], "array"),
  },
  limits: {
    max_turns: numberEnv("MAX_TURNS"),
    step_budget: numberEnv("STEP_BUDGET"),
    time_budget_ms: numberEnv("TIME_BUDGET_MS"),
  },
  artifacts: {
    expected: parseJson("EXPECTED_ARTIFACTS", [], "array"),
    declarations: artifactDeclarations,
    transcript_name: process.env.TRANSCRIPT_ARTIFACT_NAME || "agent-task-transcript",
    replay_bundle_name: process.env.REPLAY_BUNDLE_ARTIFACT_NAME || "",
  },
  outputs: {
    tool_results_key: process.env.TOOL_RESULTS_KEY || "tool_results",
    projections: parseJson("OUTPUT_PROJECTIONS", {}, "object"),
  },
  callback_data: parseJson("CALLBACK_DATA", {}, "object"),
  run_agent: booleanEnv("RUN_AGENT"),
  dry_run: booleanEnv("DRY_RUN"),
}

mkdirSync(".codebox", { recursive: true })
writeFileSync(".codebox/agent-task-request.json", `${JSON.stringify(request, null, 2)}\n`)

const status = request.run_agent && !request.dry_run ? "planned" : "skipped"
output("job_status", status)
output("transcript_json", request.artifacts.transcript_name)
output("transcript_summary", `${request.workload.label}: ${status}`)
output("engine_data_json", JSON.stringify({}))
output("credential_mode", request.access.require_access_token ? "app-token" : "default")
output("declared_artifacts_json", JSON.stringify(artifactDeclarations))
