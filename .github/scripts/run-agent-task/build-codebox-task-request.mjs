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

function optionalString(name) {
  const value = process.env[name]?.trim() ?? ""
  return value || undefined
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
const runnerRecipe = optionalString("RUNNER_RECIPE")
const runAgent = booleanEnv("RUN_AGENT")
const dryRun = booleanEnv("DRY_RUN")

if (!runnerRecipe && runAgent && !dryRun) {
  throw new Error("RUNNER_RECIPE may be omitted only when RUN_AGENT=false or DRY_RUN=true. The executable workflow in wp-codebox PR #1751 must land before a live agent run can omit it.")
}

const request = {
  schema: "wp-codebox/agent-task-workflow-request/v1",
  ...(runnerRecipe ? { runner_recipe: runnerRecipe } : {}),
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
  runner_workspace: parseJson("RUNNER_WORKSPACE_CONFIG", {}, "object"),
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
  run_agent: runAgent,
  dry_run: dryRun,
}

const runId = `${request.workload.id}-${process.env.GITHUB_RUN_ID || "local"}`.replace(/[^A-Za-z0-9._-]+/g, "-")
mkdirSync(".codebox", { recursive: true })
writeFileSync(".codebox/agent-task-request.json", `${JSON.stringify(request, null, 2)}\n`)

output("request_path", ".codebox/agent-task-request.json")
output("run_id", runId)
