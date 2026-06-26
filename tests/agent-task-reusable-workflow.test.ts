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
assert.match(docs, /agent_bundle/)
assert.match(docs, /runner_workspace/)
assert.match(docs, /access_token_repos/)
assert.match(docs, /require_access_token/)
assert.match(docs, /implementation-specific\s+runtime wiring, workspace adapters, plugins, and model setup stay behind the WP\s+Codebox boundary/)
assert.doesNotMatch(docs, /docs-agent|wp-codebox\/docs-agent-runner-recipe\/v1|recipe_path|recipe_json|wp_codebox_ref|datamachine|data machine|data-machine|agents api|sandbox mounts|ability ids|provider internals|homeboy|require_app_token/i)

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
    RUNNER_WORKSPACE: '{"enabled":true,"repo":"Automattic/example-target"}',
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

console.log("agent task reusable workflow ok")
