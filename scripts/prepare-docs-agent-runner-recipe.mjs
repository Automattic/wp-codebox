import { readFileSync, appendFileSync } from "node:fs"
import { resolve } from "node:path"

const SCHEMA = "wp-codebox/docs-agent-runner-recipe/v1"

function readRecipe() {
  const inline = process.env.RECIPE_JSON?.trim() ?? ""
  const path = process.env.RECIPE_PATH?.trim() ?? ""

  if (inline && path) {
    throw new Error("Set recipe_json or recipe_path, not both.")
  }

  if (inline) {
    return JSON.parse(inline)
  }

  if (!path) {
    throw new Error("A Docs Agent recipe is required. Set recipe_path or recipe_json.")
  }

  return JSON.parse(readFileSync(resolve(process.cwd(), path), "utf8"))
}

function objectValue(value, name) {
  if (value === undefined) return {}
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`)
  }
  return value
}

function arrayValue(value, name) {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array.`)
  }
  return value
}

function stringValue(value, name, fallback = "") {
  if (value === undefined || value === null || value === "") return fallback
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string.`)
  }
  return value
}

function booleanValue(value, name, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean.`)
  }
  return value
}

function numberValue(value, name, fallback) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`)
  }
  return value
}

function jsonOutput(value) {
  return JSON.stringify(value ?? {})
}

function writeOutput(name, value) {
  const output = String(value)
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}<<__WP_CODEBOX_OUTPUT__\n${output}\n__WP_CODEBOX_OUTPUT__\n`)
}

const recipe = readRecipe()

if (recipe.schema !== SCHEMA) {
  throw new Error(`Docs Agent recipe schema must be ${SCHEMA}.`)
}

const docsAgent = objectValue(recipe.docsAgent, "docsAgent")
const runner = objectValue(recipe.runner, "runner")
const policy = objectValue(recipe.policy, "policy")
const runtime = objectValue(recipe.runtime, "runtime")
const artifacts = objectValue(recipe.artifacts, "artifacts")
const engine = objectValue(recipe.engine, "engine")
const evalConfig = objectValue(recipe.eval, "eval")

const targetRepo = stringValue(process.env.TARGET_REPO, "target_repo", stringValue(recipe.targetRepository, "targetRepository", process.env.GITHUB_REPOSITORY_NAME))
const prompt = stringValue(process.env.PROMPT, "prompt", stringValue(recipe.prompt, "prompt"))
const bundleRepo = stringValue(docsAgent.repository, "docsAgent.repository", "https://github.com/Automattic/docs-agent.git")
const bundlePath = stringValue(docsAgent.bundlePath, "docsAgent.bundlePath", "bundles/docs-agent")

if (!targetRepo) {
  throw new Error("target_repo is required when the caller repository is unavailable.")
}

writeOutput("target_repo", targetRepo)
writeOutput("prompt", prompt)
writeOutput("bundle_repo", bundleRepo)
writeOutput("bundle_ref", stringValue(docsAgent.ref, "docsAgent.ref", "main"))
writeOutput("bundle_path", bundlePath)
writeOutput("bundle_path_in_repo", stringValue(docsAgent.bundlePathInRepo, "docsAgent.bundlePathInRepo", bundlePath))
writeOutput("agent_slug", stringValue(docsAgent.agentSlug, "docsAgent.agentSlug", "docs-agent"))
writeOutput("pipeline_slug", stringValue(docsAgent.pipelineSlug, "docsAgent.pipelineSlug", "docs-agent-pipeline"))
writeOutput("flow_slug", stringValue(docsAgent.flowSlug, "docsAgent.flowSlug", "docs-agent-flow"))
writeOutput("validation_dependencies", stringValue(runner.validationDependencies, "runner.validationDependencies"))
writeOutput("context_repositories", jsonOutput(arrayValue(runner.contextRepositories, "runner.contextRepositories")))
writeOutput("verification_commands", jsonOutput(arrayValue(runner.verificationCommands, "runner.verificationCommands")))
writeOutput("drift_checks", jsonOutput(arrayValue(runner.driftChecks, "runner.driftChecks")))
writeOutput("writable_paths", stringValue(runner.writablePaths, "runner.writablePaths"))
writeOutput("workspace_contract_checks", jsonOutput(objectValue(runner.workspaceContractChecks, "runner.workspaceContractChecks")))
writeOutput("runner_workspace", jsonOutput(objectValue(runner.workspace, "runner.workspace")))
writeOutput("actions_artifact_downloads", jsonOutput(arrayValue(runner.actionsArtifactDownloads, "runner.actionsArtifactDownloads")))
writeOutput("success_requires_pr", booleanValue(policy.successRequiresPr, "policy.successRequiresPr", false))
writeOutput("success_completion_outcomes", jsonOutput(arrayValue(policy.successCompletionOutcomes, "policy.successCompletionOutcomes")))
writeOutput("app_token_repos", stringValue(policy.appTokenRepositories, "policy.appTokenRepositories", targetRepo))
writeOutput("require_app_token", booleanValue(policy.requireAppToken, "policy.requireAppToken", false))
writeOutput("allowed_repos", jsonOutput(policy.allowedRepositories === undefined ? [targetRepo] : arrayValue(policy.allowedRepositories, "policy.allowedRepositories")))
writeOutput("max_turns", numberValue(runtime.maxTurns, "runtime.maxTurns", 12))
writeOutput("step_budget", numberValue(runtime.stepBudget, "runtime.stepBudget", 16))
writeOutput("time_budget_ms", numberValue(runtime.timeBudgetMs, "runtime.timeBudgetMs", 600000))
writeOutput("expected_artifacts", jsonOutput(arrayValue(artifacts.expected, "artifacts.expected")))
writeOutput("artifact_declarations", jsonOutput(arrayValue(artifacts.declarations, "artifacts.declarations")))
writeOutput("artifact_export_config", jsonOutput(objectValue(artifacts.exportConfig, "artifacts.exportConfig")))
writeOutput("transcript_artifact_name", stringValue(artifacts.transcriptName, "artifacts.transcriptName", `docs-agent-transcript-${Date.now()}`))
writeOutput("replay_bundle_artifact_name", stringValue(artifacts.replayBundleName, "artifacts.replayBundleName"))
writeOutput("engine_key", stringValue(engine.key, "engine.key", "docs_agent"))
writeOutput("tool_results_key", stringValue(engine.toolResultsKey, "engine.toolResultsKey", "github_tool_results"))
writeOutput("output_mappings", jsonOutput(objectValue(engine.outputMappings, "engine.outputMappings")))
writeOutput("tool_recorders", jsonOutput(arrayValue(engine.toolRecorders, "engine.toolRecorders")))
writeOutput("rules", jsonOutput(objectValue(evalConfig.rules, "eval.rules")))
writeOutput("general_rules", jsonOutput(arrayValue(evalConfig.generalRules, "eval.generalRules")))
writeOutput("task_rules", jsonOutput(arrayValue(evalConfig.taskRules, "eval.taskRules")))
writeOutput("probes", jsonOutput(objectValue(evalConfig.probes, "eval.probes")))
writeOutput("comment_pr_summary", booleanValue(policy.commentPrSummary, "policy.commentPrSummary", false))
