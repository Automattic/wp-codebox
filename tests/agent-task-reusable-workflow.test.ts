import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

const workflow = await readFile(new URL("../.github/workflows/run-agent-task.yml", import.meta.url), "utf8")
const publicWorkflowSurface = workflow.slice(0, workflow.indexOf("jobs:"))

assert.match(workflow, /^name: Run Agent Task \(reusable\)$/m)
assert.match(workflow, /workflow_call:/)
assert.match(workflow, /agent_bundle:/)
assert.match(workflow, /runner_workspace:/)
assert.match(workflow, /artifact_declarations:/)
assert.match(workflow, /output_projections:/)
assert.match(workflow, /verification_commands:/)
assert.match(workflow, /drift_checks:/)
assert.match(workflow, /access_token_repos:/)
assert.match(workflow, /require_access_token:/)
assert.match(workflow, /projected_outputs_json:/)
assert.match(workflow, /ACCESS_TOKEN:/)
assert.match(workflow, /GITHUB_TOKEN: \$\{\{ secrets\.ACCESS_TOKEN \|\| github\.token \}\}/)
assert.match(workflow, /ACCESS_TOKEN_CONFIGURED: \$\{\{ secrets\.ACCESS_TOKEN != '' \}\}/)
assert.doesNotMatch(workflow, /homeboy|require_app_token|require_homeboy_app_token|REQUIRE_HOMEBOY_APP_TOKEN|Extra-Chill\/homeboy-action|agent-task run-plan/i)
assert.doesNotMatch(workflow, /docs-agent|wp-codebox\/docs-agent-runner-recipe\/v1|recipe_path|recipe_json|wp_codebox_ref/i)
assert.doesNotMatch(workflow, /datamachine-agent-ci|runtime-agent-full-run|Extra-Chill\/homeboy-extensions/)
assert.match(workflow, /Install WP Codebox runtime/)
assert.match(workflow, /Checkout target workspace/)
assert.match(workflow, /Execute native agent task/)
assert.match(workflow, /execute-native-agent-task\.mjs/)
assert.match(workflow, /agent-task-artifacts/)
assert.match(workflow, /prepare-agent-task-upload\.mjs/)
assert.match(workflow, /agent-task-upload/)
assert.match(workflow, /if: always\(\)/)
assert.doesNotMatch(publicWorkflowSurface, /step_budget:|tool_results_key:/)
assert.doesNotMatch(workflow, /steps\.plan\.outputs/)
assert.doesNotMatch(publicWorkflowSurface, /datamachine|data machine|data-machine|agents api/i)
assert.doesNotMatch(publicWorkflowSurface, /mount|component path|ability id|provider plugin/i)

const docs = await readFile(new URL("../docs/agent-task-reusable-workflow.md", import.meta.url), "utf8")
assert.match(docs, /^# Agent Task Reusable Workflow/m)
assert.match(docs, /Automattic\/wp-codebox\/.github\/workflows\/run-agent-task.yml@main/)
assert.match(docs, /agent_bundle/)
assert.match(docs, /runner_workspace/)
assert.match(docs, /access_token_repos/)
assert.match(docs, /require_access_token/)
assert.match(docs, /success_requires_pr/)
assert.match(docs, /intentional exposed-workflow breaking change/)
assert.match(docs, /wp-codebox\/reusable-workflow-interface\/v1/)
assert.match(docs, /run-agent-task-reusable-workflow-interface\.v1\.json/)
assert.match(docs, /WP_CODEBOX_DIR/)
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
    VERIFICATION_COMMANDS: '[{"command":"npm test","description":"Run checks"}]',
    DRIFT_CHECKS: "[]",
    SUCCESS_REQUIRES_PR: "false",
    ACCESS_TOKEN_REPOS: "Automattic/example-target",
    REQUIRE_ACCESS_TOKEN: "false",
    ALLOWED_REPOS: '["Automattic/example-target"]',
    MAX_TURNS: "12",
    TIME_BUDGET_MS: "600000",
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

await assert.rejects(readFile(resultPath, "utf8"), /ENOENT/)

await execFileAsync("node", [new URL("../.github/scripts/run-agent-task/execute-native-agent-task.mjs", import.meta.url).pathname], {
  cwd: tmp,
  env: {
    ...process.env,
    GITHUB_OUTPUT: outputPath,
    AGENT_TASK_REQUEST_PATH: requestPath,
    AGENT_TASK_WORKSPACE: tmp,
    WP_CODEBOX_WORKFLOW_ROOT: new URL("..", import.meta.url).pathname,
  },
})

const result = JSON.parse(await readFile(resultPath, "utf8"))
assert.equal(result.schema, "wp-codebox/agent-task-workflow-result/v1")
assert.equal(result.status, "skipped")
assert.equal(result.success, true)
assert.equal(result.runtime_input_path, ".codebox/native-agent-task-input.json")
assert.deepEqual(result.verification, [])
assert.doesNotMatch(JSON.stringify(result), /homeboy|agent-task-plan|run-plan/i)

const malformedRequest = { ...request, verification_commands: [{ description: "Missing command" }] }
await writeFile(requestPath, `${JSON.stringify(malformedRequest, null, 2)}\n`)
await assert.rejects(execFileAsync("node", [new URL("../.github/scripts/run-agent-task/execute-native-agent-task.mjs", import.meta.url).pathname], {
  cwd: tmp,
  env: {
    ...process.env,
    GITHUB_OUTPUT: outputPath,
    AGENT_TASK_REQUEST_PATH: requestPath,
    AGENT_TASK_WORKSPACE: tmp,
    WP_CODEBOX_WORKFLOW_ROOT: new URL("..", import.meta.url).pathname,
  },
}), /verification_commands\[0\]\.command/)

// A serialized task request cannot stand in for a native run. Exercise the real
// package-staging and canonical agents/chat harnesses instead of fabricating CLI
// JSON or publication output in this workflow test.
await execFileAsync("npm", ["run", "test:agent-task-runtime-package-staging"], { cwd: new URL("..", import.meta.url).pathname })
await execFileAsync("npm", ["run", "test:agent-no-data-machine-loop"], { cwd: new URL("..", import.meta.url).pathname })
await execFileAsync("npm", ["run", "test:php-runner-workspace-tools"], { cwd: new URL("..", import.meta.url).pathname })

const outputs = await readFile(outputPath, "utf8")
assert.match(outputs, /job_status<<__WP_CODEBOX_OUTPUT__\nskipped\n__WP_CODEBOX_OUTPUT__/)
assert.match(outputs, /credential_mode<<__WP_CODEBOX_OUTPUT__\nrunner-(provider|default)-credentials\n__WP_CODEBOX_OUTPUT__/)
assert.match(outputs, /request_path<<__WP_CODEBOX_OUTPUT__\n\.codebox\/agent-task-request\.json\n__WP_CODEBOX_OUTPUT__/)
assert.match(outputs, /result_path<<__WP_CODEBOX_OUTPUT__\n\.codebox\/agent-task-workflow-result\.json\n__WP_CODEBOX_OUTPUT__/)

// Native execution gets only agent credentials. Verification gets a clean
// environment, and any secret printed by either phase is redacted before the
// result or artifacts are persisted.
const fakeCli = join(tmp, "fake-cli.mjs")
await mkdir(join(tmp, ".codebox", "agent-task-artifacts"), { recursive: true })
await writeFile(fakeCli, `import { writeFile } from "node:fs/promises"; const input = JSON.parse(await (await import("node:fs/promises")).readFile(process.argv[process.argv.indexOf("--input-file") + 1], "utf8")); await writeFile(input.artifacts_path + "/agent.txt", process.env.OPENAI_API_KEY || ""); console.log(JSON.stringify({success:true, diagnostic:process.env.OPENAI_API_KEY, outputs:{artifact_result:{result:{outputs:{answer:"ok"}}}}, agent_task_run_result:{refs:{transcripts:[]}}}));`)
await writeFile(requestPath, `${JSON.stringify({ ...request, run_agent: true, dry_run: false, verification_commands: [{ command: 'test -z "$OPENAI_API_KEY" -a -z "$GITHUB_TOKEN" && printf secret-verification', description: "credential isolation" }], outputs: { projections: { answer: "outputs.artifact_result.result.outputs.answer" } } }, null, 2)}\n`)
await execFileAsync("node", [new URL("../.github/scripts/run-agent-task/execute-native-agent-task.mjs", import.meta.url).pathname], {
  cwd: tmp,
  env: { ...process.env, GITHUB_OUTPUT: outputPath, AGENT_TASK_REQUEST_PATH: requestPath, AGENT_TASK_WORKSPACE: tmp, WP_CODEBOX_WORKFLOW_ROOT: new URL("..", import.meta.url).pathname, WP_CODEBOX_CLI_PATH: fakeCli, OPENAI_API_KEY: "secret-agent-value", GITHUB_TOKEN: "secret-github-value" },
})
const secureResult = await readFile(resultPath, "utf8")
const secureArtifact = await readFile(join(tmp, ".codebox", "agent-task-artifacts", "agent.txt"), "utf8")
assert.match(secureResult, /\[REDACTED\]/)
assert.doesNotMatch(secureResult, /secret-agent-value|secret-github-value/)
assert.doesNotMatch(secureArtifact, /secret-agent-value|secret-github-value/)
assert.match(secureResult, /"answer": "ok"/)

// Uploads come only from a fail-closed staging directory. Oversize, binary,
// and symlinked artifacts are excluded before actions/upload-artifact can see them.
const artifactsPath = join(tmp, ".codebox", "agent-task-artifacts")
await writeFile(join(artifactsPath, "safe.txt"), "secret-agent-value")
await writeFile(join(artifactsPath, "oversize.txt"), `secret-agent-value${"x".repeat(4 * 1024 * 1024)}`)
await writeFile(join(artifactsPath, "binary.bin"), Buffer.from([0, ...Buffer.from("secret-agent-value")]))
const outsideArtifact = join(tmp, "outside-secret.txt")
await writeFile(outsideArtifact, "secret-agent-value")
await symlink(outsideArtifact, join(artifactsPath, "linked-secret.txt"))
await writeFile(requestPath, `${JSON.stringify({ ...request, prompt: "secret-agent-value" })}\n`)
await execFileAsync("node", [new URL("../.github/scripts/run-agent-task/prepare-agent-task-upload.mjs", import.meta.url).pathname], {
  cwd: tmp,
  env: { ...process.env, AGENT_TASK_WORKSPACE: tmp, OPENAI_API_KEY: "secret-agent-value", GITHUB_TOKEN: "secret-github-value" },
})
const uploadArtifactsPath = join(tmp, ".codebox", "agent-task-upload", ".codebox", "agent-task-artifacts")
assert.match(await readFile(join(uploadArtifactsPath, "safe.txt"), "utf8"), /\[REDACTED\]/)
assert.doesNotMatch(await readFile(join(tmp, ".codebox", "agent-task-upload", ".codebox", "agent-task-request.json"), "utf8"), /secret-agent-value|secret-github-value/)
for (const name of ["oversize.txt", "binary.bin", "linked-secret.txt"]) {
  await assert.rejects(readFile(join(uploadArtifactsPath, name), "utf8"), /ENOENT/)
}

// Stream capture retains a fixed amount while draining the process to completion.
await writeFile(requestPath, `${JSON.stringify({ ...request, run_agent: true, dry_run: false, verification_commands: [{ command: "node -e 'process.stdout.write(\"x\".repeat(65536)); process.stderr.write(\"y\".repeat(65536))'", description: "bounded output" }], outputs: { projections: {} } }, null, 2)}\n`)
await execFileAsync("node", [new URL("../.github/scripts/run-agent-task/execute-native-agent-task.mjs", import.meta.url).pathname], {
  cwd: tmp,
  env: { ...process.env, GITHUB_OUTPUT: outputPath, AGENT_TASK_REQUEST_PATH: requestPath, AGENT_TASK_WORKSPACE: tmp, WP_CODEBOX_WORKFLOW_ROOT: new URL("..", import.meta.url).pathname, WP_CODEBOX_CLI_PATH: fakeCli },
})
const noisyResult = JSON.parse(await readFile(resultPath, "utf8"))
const noisyVerification = noisyResult.verification[0]
assert.deepEqual(noisyResult.execution, { stdout_truncated: false, stderr_truncated: false })
assert.equal(noisyVerification.stdout_truncated, true)
assert.equal(noisyVerification.stderr_truncated, true)
assert.ok(Buffer.byteLength(noisyVerification.stdout) <= 32768)
assert.ok(Buffer.byteLength(noisyVerification.stderr) <= 32768)

console.log("agent task reusable workflow ok")
