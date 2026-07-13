import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { sha256BytesV1 } from "../.github/scripts/run-agent-task/materialize-external-native-package.mjs"

const execFileAsync = promisify(execFile)

const workflow = await readFile(new URL("../.github/workflows/run-agent-task.yml", import.meta.url), "utf8")
const publicWorkflowSurface = workflow.slice(0, workflow.indexOf("jobs:"))

assert.match(workflow, /^name: Run Agent Task \(reusable\)$/m)
assert.match(workflow, /workflow_call:/)
assert.match(workflow, /external_package_source:/)
assert.match(workflow, /EXTERNAL_PACKAGE_SOURCE_POLICY:/)
assert.doesNotMatch(publicWorkflowSurface, /external_package_allowed_repositories:|external_package_allowed_paths:/)
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
const helperRevision = workflow.match(/WP_CODEBOX_HELPER_REVISION:\s*([0-9a-f]{40})/)?.[1]
assert.ok(helperRevision, "The workflow must declare one full immutable WP Codebox helper revision")
assert.match(workflow, /ref: \$\{\{ env\.WP_CODEBOX_HELPER_REVISION \}\}/)
assert.doesNotMatch(workflow, /github\.(?:workflow_sha|workflow_ref)/)
assert.doesNotMatch(workflow, /steps\.[^.]+\.outputs\.ref/)
const foreignCallerSha = "ba2df8c2215407b1a58edbff29e3ddcb5efa2249"
assert.notEqual(helperRevision, foreignCallerSha, "A caller repository SHA must not select WP Codebox helpers")
assert.doesNotMatch(workflow, new RegExp(foreignCallerSha))
assert.match(workflow, /Validate pinned WP Codebox helper revision/)

const requiredHelperFiles = {
  ".github/scripts/run-agent-task/build-codebox-task-request.mjs": "a0b9052bf63b0d5b096568c21a1e7333b7474b35834ffd1bc0d748fb0cfd0859",
  ".github/scripts/run-agent-task/execute-native-agent-task.mjs": "b67910e538c6fb231c25dee43d0ff2e06e521e08108f8570e0389b022f9f8ccc",
  ".github/scripts/run-agent-task/prepare-agent-task-upload.mjs": "93511e4174e705f55ff014ba68ac52fdaca771ce3f19f3921cceb661e69569da",
}
for (const [path, digest] of Object.entries(requiredHelperFiles)) {
  const { stdout } = await execFileAsync("git", ["show", `${helperRevision}:${path}`], { encoding: "buffer" })
  const actualDigest = createHash("sha256").update(stdout).digest("hex")
  assert.equal(actualDigest, digest, `Pinned helper source changed unexpectedly: ${path}`)
}
assert.doesNotMatch(publicWorkflowSurface, /step_budget:|tool_results_key:/)
assert.doesNotMatch(workflow, /steps\.plan\.outputs/)
assert.doesNotMatch(publicWorkflowSurface, /datamachine|data machine|data-machine|agents api/i)
assert.doesNotMatch(publicWorkflowSurface, /mount|component path|ability id|provider plugin/i)

const docs = await readFile(new URL("../docs/agent-task-reusable-workflow.md", import.meta.url), "utf8")
assert.match(docs, /^# Agent Task Reusable Workflow/m)
assert.match(docs, /Automattic\/wp-codebox\/.github\/workflows\/run-agent-task.yml@main/)
assert.match(docs, /external_package_source/)
assert.match(docs, /runner_workspace/)
assert.match(docs, /access_token_repos/)
assert.match(docs, /require_access_token/)
assert.match(docs, /success_requires_pr/)
assert.match(docs, /intentional exposed-workflow breaking change/)
assert.match(docs, /wp-codebox\/reusable-workflow-interface\/v1/)
assert.match(docs, /run-agent-task-reusable-workflow-interface\.v1\.json/)
assert.match(docs, /WP_CODEBOX_DIR/)
assert.match(docs, /Runtime Coverage/)
assert.match(docs, /not a WordPress Playground end-to-end test/)
assert.doesNotMatch(docs.slice(0, docs.indexOf("## Runtime Coverage")), /docs-agent|wp-codebox\/docs-agent-runner-recipe\/v1|recipe_path|recipe_json|wp_codebox_ref|datamachine|data machine|data-machine|agents api|sandbox mounts|ability ids|provider internals|homeboy|require_app_token/i)

const tmp = await mkdtemp(join(tmpdir(), "wp-codebox-agent-task-workflow-"))
const nativePackageRepository = join(tmp, "native-package-repository")
const nativePackagePath = join(nativePackageRepository, "packages", "example-agent.agent.json")
await mkdir(join(nativePackageRepository, "packages"), { recursive: true })
const nativePackageBytes = Buffer.from('{"schema_version":1,"bundle_slug":"example-agent","agent":{"agent_slug":"example-agent"}}\n')
await writeFile(nativePackagePath, nativePackageBytes)
await execFileAsync("git", ["init", "--quiet"], { cwd: nativePackageRepository })
await execFileAsync("git", ["config", "user.email", "test@example.test"], { cwd: nativePackageRepository })
await execFileAsync("git", ["config", "user.name", "Test"], { cwd: nativePackageRepository })
await execFileAsync("git", ["add", "."], { cwd: nativePackageRepository })
await execFileAsync("git", ["commit", "--quiet", "-m", "native package"], { cwd: nativePackageRepository })
const { stdout: nativeRevision } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: nativePackageRepository })
const nativeSource = { repository: "automattic/example-agent-packages", revision: nativeRevision.trim(), path: "packages/example-agent.agent.json", digest: sha256BytesV1(nativePackageBytes) }
const outputPath = join(tmp, "github-output.txt")
const requestPath = join(tmp, ".codebox", "agent-task-request.json")
const resultPath = join(tmp, ".codebox", "agent-task-workflow-result.json")

await writeFile(outputPath, "")

await execFileAsync("node", [new URL("../.github/scripts/run-agent-task/build-codebox-task-request.mjs", import.meta.url).pathname], {
  cwd: tmp,
  env: {
    ...process.env,
    GITHUB_OUTPUT: outputPath,
    EXTERNAL_PACKAGE_SOURCE: '{"repository":"Automattic/example-agent-packages","revision":"0123456789abcdef0123456789abcdef01234567","path":"packages/example-agent.agent.json","digest":"sha256-bytes-v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}',
    EXTERNAL_PACKAGE_SOURCE_POLICY: '{"version":1,"repositories":{"automattic/example-agent-packages":["packages/example-agent.agent.json"]}}',
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
assert.doesNotMatch(JSON.stringify(request), /external_package_policy|repositories.*packages/i)
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
    EXTERNAL_PACKAGE_SOURCE_POLICY: '{"version":1,"repositories":{"automattic/example-agent-packages":["packages/example-agent.agent.json"]}}',
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
    EXTERNAL_PACKAGE_SOURCE_POLICY: '{"version":1,"repositories":{"automattic/example-agent-packages":["packages/example-agent.agent.json"]}}',
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

// Uploads come only from a fail-closed staging directory. Policy data remains
// secret even though public package bytes may be present in runtime input.
const artifactsPath = join(tmp, ".codebox", "agent-task-artifacts")
await mkdir(artifactsPath, { recursive: true })
await writeFile(join(artifactsPath, "safe.txt"), "secret-agent-value")
await writeFile(join(artifactsPath, "oversize.txt"), `secret-agent-value${"x".repeat(4 * 1024 * 1024)}`)
await writeFile(join(artifactsPath, "binary.bin"), Buffer.from([0, ...Buffer.from("secret-agent-value")]))
const outsideArtifact = join(tmp, "outside-secret.txt")
await writeFile(outsideArtifact, "secret-agent-value")
await symlink(outsideArtifact, join(artifactsPath, "linked-secret.txt"))
await writeFile(requestPath, `${JSON.stringify({ ...request, prompt: "secret-agent-value" })}\n`)
await execFileAsync("node", [new URL("../.github/scripts/run-agent-task/prepare-agent-task-upload.mjs", import.meta.url).pathname], {
  cwd: tmp,
  env: { ...process.env, AGENT_TASK_WORKSPACE: tmp, OPENAI_API_KEY: "secret-agent-value", GITHUB_TOKEN: "secret-github-value", EXTERNAL_PACKAGE_SOURCE_POLICY: '{"private":"policy"}' },
})
const uploadArtifactsPath = join(tmp, ".codebox", "agent-task-upload", ".codebox", "agent-task-artifacts")
assert.match(await readFile(join(uploadArtifactsPath, "safe.txt"), "utf8"), /\[REDACTED\]/)
assert.doesNotMatch(await readFile(join(tmp, ".codebox", "agent-task-upload", ".codebox", "agent-task-request.json"), "utf8"), /secret-agent-value|secret-github-value|\{"private":"policy"\}/)
for (const name of ["oversize.txt", "binary.bin", "linked-secret.txt"]) {
  await assert.rejects(readFile(join(uploadArtifactsPath, name), "utf8"), /ENOENT/)
}

console.log("agent task reusable workflow ok")
