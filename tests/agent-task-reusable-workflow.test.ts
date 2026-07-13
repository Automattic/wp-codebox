import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

const workflow = await readFile(new URL("../.github/workflows/run-agent-task.yml", import.meta.url), "utf8")
const publicWorkflowSurface = workflow.slice(0, workflow.indexOf("jobs:"))

assert.match(workflow, /^name: Run Agent Task \(reusable\)$/m)
assert.match(workflow, /workflow_call:/)
assert.match(workflow, /runner_recipe:/)
assert.match(workflow, /runner_recipe:\n\s+description:[^\n]*temporary[^\n]*\n\s+type: string\n\s+required: false/)
assert.match(workflow, /agent_bundle:/)
assert.match(workflow, /runner_workspace:/)
assert.match(workflow, /artifact_declarations:/)
assert.match(workflow, /output_projections:/)
assert.match(workflow, /verification_commands:/)
assert.match(workflow, /drift_checks:/)
assert.match(workflow, /access_token_repos:/)
assert.match(workflow, /require_access_token:/)
assert.doesNotMatch(workflow, /homeboy|require_app_token|require_homeboy_app_token|REQUIRE_HOMEBOY_APP_TOKEN|Extra-Chill\/homeboy-action|agent-task run-plan/i)
assert.doesNotMatch(workflow, /docs-agent|wp-codebox\/docs-agent-runner-recipe\/v1|recipe_path|recipe_json|wp_codebox_ref/i)
assert.doesNotMatch(workflow, /datamachine-agent-ci|runtime-agent-full-run|Extra-Chill\/homeboy-extensions/)
assert.doesNotMatch(publicWorkflowSurface, /datamachine|data machine|data-machine|agents api/i)
assert.doesNotMatch(publicWorkflowSurface, /mount|component path|ability id|provider plugin/i)

const docs = await readFile(new URL("../docs/agent-task-reusable-workflow.md", import.meta.url), "utf8")
assert.match(docs, /^# Agent Task Reusable Workflow/m)
assert.match(docs, /Automattic\/wp-codebox\/.github\/workflows\/run-agent-task.yml@main/)
assert.match(docs, /runner_recipe/)
assert.match(docs, /temporary optional input/)
assert.match(docs, /fails closed until the executable\s+\[wp-codebox#1751\]/)
assert.match(docs, /agent_bundle/)
assert.match(docs, /runner_workspace/)
assert.match(docs, /access_token_repos/)
assert.match(docs, /require_access_token/)
assert.match(docs, /implementation-specific\s+runtime\s+wiring,\s+workspace\s+adapters,\s+plugins,\s+and\s+model\s+setup\s+stay\s+behind\s+the\s+WP\s+Codebox\s+boundary/)
assert.doesNotMatch(docs, /wp-codebox\/docs-agent-runner-recipe\/v1|recipe_path|recipe_json|wp_codebox_ref|datamachine|data machine|data-machine|agents api|sandbox mounts|ability ids|provider internals|homeboy|require_app_token/i)

const tmp = await mkdtemp(join(tmpdir(), "wp-codebox-agent-task-workflow-"))
const outputPath = join(tmp, "github-output.txt")
const requestPath = join(tmp, ".codebox", "agent-task-request.json")
const resultPath = join(tmp, ".codebox", "agent-task-workflow-result.json")

await writeFile(outputPath, "")

await execFileAsync("node", [new URL("../.github/scripts/run-agent-task/build-codebox-task-request.mjs", import.meta.url).pathname], {
  cwd: tmp,
  env: {
    ...process.env,
    GITHUB_OUTPUT: outputPath,
    RUNNER_RECIPE: "Automattic/example-runner@abc123:ci/runner-recipe.json",
    AGENT_BUNDLE: "bundles/example-agent",
    WORKLOAD_ID: "example-maintenance",
    WORKLOAD_LABEL: "Run example maintenance",
    COMPONENT_ID: "example-ci-driver",
    TARGET_REPO: "Automattic/example-target",
    PROMPT: "Update the configured surface.",
    WRITABLE_PATHS: "README.md,docs/**",
    PROVIDER: "openai",
    MODEL: "gpt-5.5",
    RUNNER_WORKSPACE_CONFIG: '{"enabled":true,"repo":"Automattic/example-target"}',
    VALIDATION_DEPENDENCIES: "",
    CONTEXT_REPOSITORIES: "[]",
    VERIFICATION_COMMANDS: '[{"command":"npm test","description":"Run checks"}]',
    DRIFT_CHECKS: "[]",
    WORKSPACE_CONTRACT_CHECKS: "{}",
    ACTIONS_ARTIFACT_DOWNLOADS: "[]",
    SUCCESS_REQUIRES_PR: "false",
    SUCCESS_COMPLETION_OUTCOMES: "[]",
    ACCESS_TOKEN_REPOS: "Automattic/example-target",
    REQUIRE_ACCESS_TOKEN: "true",
    ALLOWED_REPOS: '["Automattic/example-target"]',
    MAX_TURNS: "12",
    STEP_BUDGET: "16",
    TIME_BUDGET_MS: "600000",
    TOOL_RESULTS_KEY: "tool_results",
    OUTPUT_PROJECTIONS: '{"pr_url":"metadata.runner_workspace_publication.url"}',
    TRANSCRIPT_ARTIFACT_NAME: "agent-transcript",
    REPLAY_BUNDLE_ARTIFACT_NAME: "agent-replay",
    EXPECTED_ARTIFACTS: '["agent_transcript"]',
    ARTIFACT_DECLARATIONS: '[{"schema":"wp-codebox/artifact-declaration/v1","name":"agent_transcript"}]',
    CALLBACK_DATA: '{"workload":"example-maintenance"}',
    RUN_AGENT: "false",
    DRY_RUN: "true",
  },
})

const request = JSON.parse(await readFile(requestPath, "utf8"))
const expectedRequest = JSON.parse(await readFile(new URL("../contracts/agent-task-workflow-request.fixture.json", import.meta.url), "utf8"))
assert.equal(request.schema, "wp-codebox/agent-task-workflow-request/v1")
assert.deepEqual(request, expectedRequest)
assert.doesNotMatch(JSON.stringify(request), /homeboy|require_app_token|app_token_repos/i)

const result = JSON.parse(await readFile(resultPath, "utf8"))
const expectedResult = JSON.parse(await readFile(new URL("../contracts/agent-task-workflow-result.fixture.json", import.meta.url), "utf8"))
assert.equal(result.schema, "wp-codebox/agent-task-workflow-result/v1")
assert.deepEqual(result, expectedResult)
assert.doesNotMatch(JSON.stringify(result), /homeboy|agent-task-plan|run-plan/i)

const outputs = await readFile(outputPath, "utf8")
assert.match(outputs, /job_status<<__WP_CODEBOX_OUTPUT__\nskipped\n__WP_CODEBOX_OUTPUT__/)
assert.match(outputs, /credential_mode<<__WP_CODEBOX_OUTPUT__\napp-token\n__WP_CODEBOX_OUTPUT__/)
assert.match(outputs, /request_path<<__WP_CODEBOX_OUTPUT__\n\.codebox\/agent-task-request\.json\n__WP_CODEBOX_OUTPUT__/)
assert.match(outputs, /result_path<<__WP_CODEBOX_OUTPUT__\n\.codebox\/agent-task-workflow-result\.json\n__WP_CODEBOX_OUTPUT__/)

async function runTaskRequest(runnerRecipe, runAgent, dryRun) {
  const cwd = await mkdtemp(join(tmpdir(), "wp-codebox-agent-task-workflow-no-recipe-"))
  const outputPath = join(cwd, "github-output.txt")
  await writeFile(outputPath, "")

  const run = execFileAsync("node", [new URL("../.github/scripts/run-agent-task/build-codebox-task-request.mjs", import.meta.url).pathname], {
    cwd,
    env: {
      ...process.env,
      GITHUB_OUTPUT: outputPath,
      RUNNER_RECIPE: runnerRecipe,
      AGENT_BUNDLE: "bundles/example-agent",
      TARGET_REPO: "Automattic/example-target",
      PROMPT: "Update the configured surface.",
      MAX_TURNS: "12",
      STEP_BUDGET: "16",
      TIME_BUDGET_MS: "600000",
      RUN_AGENT: String(runAgent),
      DRY_RUN: String(dryRun),
    },
  })

  return { cwd, outputPath, run }
}

for (const { runAgent, dryRun, status } of [
  { runAgent: false, dryRun: false, status: "skipped" },
  { runAgent: false, dryRun: true, status: "skipped" },
  { runAgent: true, dryRun: true, status: "dry-run" },
]) {
  const omittedRecipe = await runTaskRequest("", runAgent, dryRun)
  await omittedRecipe.run

  const omittedRecipeRequest = JSON.parse(await readFile(join(omittedRecipe.cwd, ".codebox", "agent-task-request.json"), "utf8"))
  const omittedRecipeResult = JSON.parse(await readFile(join(omittedRecipe.cwd, ".codebox", "agent-task-workflow-result.json"), "utf8"))
  assert.equal(Object.hasOwn(omittedRecipeRequest, "runner_recipe"), false)
  assert.equal(omittedRecipeResult.status, status)
  assert.match(await readFile(omittedRecipe.outputPath, "utf8"), new RegExp(`job_status<<__WP_CODEBOX_OUTPUT__\\n${status}\\n__WP_CODEBOX_OUTPUT__`))
}

const recipeBackedLiveRun = await runTaskRequest("Automattic/example-runner@abc123:ci/runner-recipe.json", true, false)
await recipeBackedLiveRun.run
const recipeBackedLiveResult = JSON.parse(await readFile(join(recipeBackedLiveRun.cwd, ".codebox", "agent-task-workflow-result.json"), "utf8"))
assert.equal(recipeBackedLiveResult.status, "planned")

const omittedRecipeLiveRun = await runTaskRequest("", true, false)
await assert.rejects(omittedRecipeLiveRun.run, (error: { stderr: string }) => {
  assert.match(error.stderr, /RUNNER_RECIPE may be omitted only when RUN_AGENT=false or DRY_RUN=true/)
  assert.match(error.stderr, /executable workflow in wp-codebox PR #1751 must land/)
  return true
})
assert.equal(await readFile(omittedRecipeLiveRun.outputPath, "utf8"), "")

console.log("agent task reusable workflow ok")
