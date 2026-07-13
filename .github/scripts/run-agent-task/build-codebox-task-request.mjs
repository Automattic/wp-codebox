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

const MAX_OUTPUT_CHARS = 8192

function output(name, value) {
  const rendered = String(value)
  if (rendered.length > MAX_OUTPUT_CHARS) throw new Error(`${name} exceeds the ${MAX_OUTPUT_CHARS}-character workflow output limit.`)
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}<<__WP_CODEBOX_OUTPUT__\n${rendered}\n__WP_CODEBOX_OUTPUT__\n`)
}

function repositoryList(name) {
  const repositories = (process.env[name] || "").split(",").map((value) => value.trim()).filter(Boolean)
  if (repositories.some((repository) => !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))) {
    throw new Error(`${name} must contain comma-separated OWNER/REPO values.`)
  }
  return repositories
}

function commandList(name) {
  const value = parseJson(name, [], "array")
  return value.map((entry, index) => {
    if (typeof entry === "string" && entry.trim()) return { command: entry.trim(), description: entry.trim() }
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.command !== "string" || !entry.command.trim()) {
      throw new Error(`${name}[${index}] must be a non-empty command string or an object with a non-empty command.`)
    }
    if (entry.description !== undefined && (typeof entry.description !== "string" || !entry.description.trim())) {
      throw new Error(`${name}[${index}].description must be a non-empty string when provided.`)
    }
    return { command: entry.command.trim(), description: typeof entry.description === "string" ? entry.description.trim() : entry.command.trim() }
  })
}

const artifactDeclarations = parseJson("ARTIFACT_DECLARATIONS", [], "array")
const request = {
  schema: "wp-codebox/agent-task-workflow-request/v1",
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
  verification_commands: commandList("VERIFICATION_COMMANDS"),
  drift_checks: commandList("DRIFT_CHECKS"),
  success: {
    requires_pr: booleanEnv("SUCCESS_REQUIRES_PR"),
  },
  access: {
    access_token_repos: repositoryList("ACCESS_TOKEN_REPOS"),
    require_access_token: booleanEnv("REQUIRE_ACCESS_TOKEN"),
    allowed_repos: parseJson("ALLOWED_REPOS", [], "array"),
  },
  limits: {
    max_turns: numberEnv("MAX_TURNS"),
    time_budget_ms: numberEnv("TIME_BUDGET_MS"),
  },
  artifacts: {
    expected: parseJson("EXPECTED_ARTIFACTS", [], "array"),
    declarations: artifactDeclarations,
    transcript_name: process.env.TRANSCRIPT_ARTIFACT_NAME || "agent-task-transcript",
    replay_bundle_name: process.env.REPLAY_BUNDLE_ARTIFACT_NAME || "",
  },
  outputs: {
    projections: parseJson("OUTPUT_PROJECTIONS", {}, "object"),
  },
  callback_data: parseJson("CALLBACK_DATA", {}, "object"),
  run_agent: booleanEnv("RUN_AGENT"),
  dry_run: booleanEnv("DRY_RUN"),
}

if (request.access.allowed_repos.some((repository) => typeof repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))) {
  throw new Error("ALLOWED_REPOS must be a JSON array of OWNER/REPO values.")
}
request.access.allowed_repos = [...new Set(request.access.allowed_repos.map((repository) => repository.toLowerCase()))]
request.access.access_token_repos = [...new Set(request.access.access_token_repos.map((repository) => repository.toLowerCase()))]
request.target_repo = request.target_repo.toLowerCase()
if (!request.access.allowed_repos.includes(request.target_repo)) {
  throw new Error("ALLOWED_REPOS must explicitly include TARGET_REPO.")
}
if (!request.access.access_token_repos.includes(request.target_repo)) {
  throw new Error("ACCESS_TOKEN_REPOS must explicitly include TARGET_REPO.")
}

const runId = `${request.workload.id}-${process.env.GITHUB_RUN_ID || "local"}`.replace(/[^A-Za-z0-9._-]+/g, "-")
mkdirSync(".codebox", { recursive: true })
writeFileSync(".codebox/agent-task-request.json", `${JSON.stringify(request, null, 2)}\n`)

output("request_path", ".codebox/agent-task-request.json")
output("run_id", runId)
