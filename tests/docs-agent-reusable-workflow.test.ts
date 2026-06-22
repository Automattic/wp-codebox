import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const root = new URL("..", import.meta.url)

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
assert.doesNotMatch(workflow, /docs-agent-runner\.yml|wp-codebox\/docs-agent-runner-recipe\/v1|recipe_path|recipe_json|wp_codebox_ref/)
assert.doesNotMatch(workflow, /datamachine-agent-ci|runtime-agent-full-run|Extra-Chill\/homeboy-extensions/)
assert.doesNotMatch(publicWorkflowSurface, /datamachine|data machine|data-machine|agents api/i)
assert.doesNotMatch(publicWorkflowSurface, /mount|component path|ability id|provider plugin/i)

const docs = await readFile(new URL("../docs/docs-agent-reusable-workflow.md", import.meta.url), "utf8")
assert.match(docs, /^# Docs Agent Reusable Workflow/m)
assert.match(docs, /Automattic\/wp-codebox\/.github\/workflows\/run-agent-task.yml@main/)
assert.match(docs, /runner_recipe/)
assert.match(docs, /agent_bundle/)
assert.match(docs, /runner_workspace/)
assert.match(docs, /implementation-specific\s+runtime wiring, workspace adapters, plugins, and model setup stay behind the WP\s+Codebox boundary/)
assert.doesNotMatch(docs, /docs-agent-runner\.yml|wp-codebox\/docs-agent-runner-recipe\/v1|recipe_path|recipe_json|wp_codebox_ref|datamachine|data machine|data-machine|agents api|sandbox mounts|ability ids|provider internals/i)

const tmp = await mkdtemp(join(tmpdir(), "wp-codebox-docs-agent-recipe-"))
const outputPath = join(tmp, "github-output.txt")
const requestPath = join(tmp, ".codebox", "agent-task-request.json")

await writeFile(outputPath, "")

await execFileAsync("node", [new URL("../.github/scripts/run-agent-task/build-codebox-task-request.mjs", import.meta.url).pathname], {
  cwd: tmp,
  env: {
    ...process.env,
    GITHUB_OUTPUT: outputPath,
    RUNNER_RECIPE: "Automattic/docs-agent@abc123:ci/docs-agent-runner-recipe.json",
    AGENT_BUNDLE: "bundles/technical-docs-agent",
    WORKLOAD_ID: "technical-docs-maintenance-flow",
    WORKLOAD_LABEL: "Run technical Docs Agent",
    COMPONENT_ID: "docs-agent-ci-driver",
    TARGET_REPO: "Automattic/example-target",
    PROMPT: "Update docs.",
    WRITABLE_PATHS: "README.md,docs/**",
    PROVIDER: "openai",
    MODEL: "gpt-5.5",
    RUNNER_WORKSPACE: '{"enabled":true,"repo":"Automattic/example-target"}',
    VALIDATION_DEPENDENCIES: "",
    CONTEXT_REPOSITORIES: "[]",
    VERIFICATION_COMMANDS: '[{"command":"npm test","description":"Run docs checks"}]',
    DRIFT_CHECKS: "[]",
    WORKSPACE_CONTRACT_CHECKS: "{}",
    ACTIONS_ARTIFACT_DOWNLOADS: "[]",
    SUCCESS_REQUIRES_PR: "false",
    SUCCESS_COMPLETION_OUTCOMES: "[]",
    APP_TOKEN_REPOS: "Automattic/example-target",
    REQUIRE_HOMEBOY_APP_TOKEN: "true",
    ALLOWED_REPOS: '["Automattic/example-target"]',
    MAX_TURNS: "12",
    STEP_BUDGET: "16",
    TIME_BUDGET_MS: "600000",
    TOOL_RESULTS_KEY: "github_tool_results",
    OUTPUT_PROJECTIONS: '{"docs_pr_url":"metadata.engine_data.docs_agent.pr_url"}',
    TRANSCRIPT_ARTIFACT_NAME: "docs-agent-transcript",
    REPLAY_BUNDLE_ARTIFACT_NAME: "docs-agent-replay",
    EXPECTED_ARTIFACTS: '["docs_agent_transcript"]',
    ARTIFACT_DECLARATIONS: '[{"schema":"wp-codebox/artifact-declaration/v1","name":"docs_agent_transcript"}]',
    CALLBACK_DATA: '{"flow_slug":"technical-docs-maintenance-flow"}',
    RUN_AGENT: "false",
    DRY_RUN: "true",
  },
})

const request = JSON.parse(await readFile(requestPath, "utf8"))
assert.equal(request.schema, "wp-codebox/agent-task-workflow-request/v1")
assert.equal(request.runner_recipe, "Automattic/docs-agent@abc123:ci/docs-agent-runner-recipe.json")
assert.equal(request.agent_bundle, "bundles/technical-docs-agent")
assert.equal(request.target_repo, "Automattic/example-target")
assert.deepEqual(request.verification_commands, [{ command: "npm test", description: "Run docs checks" }])
assert.deepEqual(request.outputs.projections, { docs_pr_url: "metadata.engine_data.docs_agent.pr_url" })
assert.deepEqual(request.artifacts.declarations, [{ schema: "wp-codebox/artifact-declaration/v1", name: "docs_agent_transcript" }])

const outputs = await readFile(outputPath, "utf8")
assert.match(outputs, /job_status<<__WP_CODEBOX_OUTPUT__\nskipped\n__WP_CODEBOX_OUTPUT__/)
assert.match(outputs, /credential_mode<<__WP_CODEBOX_OUTPUT__\napp-token\n__WP_CODEBOX_OUTPUT__/)

console.log("docs agent reusable workflow ok")
