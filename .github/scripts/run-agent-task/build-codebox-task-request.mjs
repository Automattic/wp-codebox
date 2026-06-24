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

const runId = `${request.workload.id}-${process.env.GITHUB_RUN_ID || "local"}`.replace(/[^A-Za-z0-9._-]+/g, "-")
const runnerRecipe = parseRunnerRecipe(request.runner_recipe)
const secretEnv = [
  request.model.provider === "openai" ? "OPENAI_API_KEY" : "",
  ...[1, 2, 3, 4, 5]
    .map((index) => `MODEL_PROVIDER_SECRET_${index}`)
    .filter((name) => process.env[name]),
].filter(Boolean)

const homeboyPlan = {
  schema: "homeboy/agent-task-plan/v1",
  plan_id: runId,
  tasks: [
    stripUndefined({
      schema: "homeboy/agent-task-request/v1",
      task_id: runId,
      executor: {
        backend: "codebox",
        secret_env: secretEnv,
        config: stripUndefined({
          execution_kind: "agent_bundle",
          runner_recipe: request.runner_recipe,
          recipe_repo: runnerRecipe.repository,
          recipe_ref: runnerRecipe.ref,
          recipe_path: runnerRecipe.path,
          bundle_repo: runnerRecipe.repository,
          bundle_ref: runnerRecipe.ref,
          bundle_path_in_repo: request.agent_bundle,
          agent_bundle: {
            bundle_repo: runnerRecipe.repository,
            bundle_ref: runnerRecipe.ref,
            bundle_path_in_repo: request.agent_bundle,
          },
          target_repo: request.target_repo,
          component_id: request.workload.component_id,
          provider: request.model.provider,
          model: request.model.name,
          prompt: request.prompt,
          writable_paths: request.writable_paths,
          runner_workspace: request.runner_workspace,
          context_repositories: request.context_repositories,
          verification_commands: request.verification_commands,
          drift_checks: request.drift_checks,
          workspace_contract_checks: request.workspace_contract_checks,
          actions_artifact_downloads: request.actions_artifact_downloads,
          validation_dependencies: request.validation_dependencies,
          success_requires_pr: request.success.requires_pr,
          success_completion_outcomes: request.success.completion_outcomes,
          tool_results_key: request.outputs.tool_results_key,
          engine_data_outputs: request.outputs.projections,
          transcript_artifact_name: request.artifacts.transcript_name,
          replay_bundle_artifact_name: request.artifacts.replay_bundle_name,
          artifact_declarations: request.artifacts.declarations,
          expected_artifacts: request.artifacts.expected,
          callback_data: request.callback_data,
          max_turns: request.limits.max_turns,
          step_budget: request.limits.step_budget,
          time_budget_ms: request.limits.time_budget_ms,
        }),
      },
      instructions: request.prompt,
      workspace: {
        mode: "managed",
        target_repo: request.target_repo,
        publication: request.runner_workspace,
      },
      policy: {
        read: "allow",
        write: "patch_only",
        apply: "reviewed",
      },
      limits: {
        max_turns: request.limits.max_turns,
        step_budget: request.limits.step_budget,
        time_budget_ms: request.limits.time_budget_ms,
      },
      expected_artifacts: request.artifacts.expected,
      artifact_declarations: request.artifacts.declarations,
      metadata: {
        workflow_request_schema: request.schema,
        target_repo: request.target_repo,
        workload: request.workload,
        callback_data: request.callback_data,
      },
    }),
  ],
  options: {
    max_concurrency: 1,
    max_queue_depth: 1,
  },
  metadata: {
    source_schema: request.schema,
    runner_recipe: request.runner_recipe,
    agent_bundle: request.agent_bundle,
  },
}

mkdirSync(".codebox", { recursive: true })
writeFileSync(".codebox/agent-task-request.json", `${JSON.stringify(request, null, 2)}\n`)
writeFileSync(".codebox/homeboy-agent-task-plan.json", `${JSON.stringify(homeboyPlan, null, 2)}\n`)

const status = request.run_agent && !request.dry_run ? "planned" : "skipped"
output("job_status", status)
output("transcript_json", request.artifacts.transcript_name)
output("transcript_summary", `${request.workload.label}: ${status}`)
output("engine_data_json", JSON.stringify({}))
output("credential_mode", request.access.require_access_token ? "app-token" : "default")
output("declared_artifacts_json", JSON.stringify(artifactDeclarations))
output("homeboy_plan_path", ".codebox/homeboy-agent-task-plan.json")
output("run_id", runId)

function parseRunnerRecipe(descriptor) {
  const match = String(descriptor || "").match(/^([^@:\s]+\/[^@:\s]+)@([^:\s]+):(.+)$/)
  if (!match) {
    throw new Error("RUNNER_RECIPE must use OWNER/REPO@ref:path.")
  }
  return {
    repository: `https://github.com/${match[1]}.git`,
    ref: match[2],
    path: match[3],
  }
}

function stripUndefined(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value
  }
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined))
}
