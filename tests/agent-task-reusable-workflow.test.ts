import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { sha256BytesV1 } from "../.github/scripts/run-agent-task/materialize-external-native-package.mjs"
import { MAX_NATIVE_RESULT_BYTES, readNativeResult } from "../.github/scripts/run-agent-task/native-result-file.mjs"

const execFileAsync = promisify(execFile)

const workflow = await readFile(new URL("../.github/workflows/run-agent-task.yml", import.meta.url), "utf8")
const publicWorkflowSurface = workflow.slice(0, workflow.indexOf("jobs:"))

assert.match(workflow, /^name: Run Agent Task \(reusable\)$/m)
assert.match(workflow, /workflow_call:/)
assert.match(workflow, /wp_codebox_release_ref:/)
assert.match(workflow, /external_package_source:/)
assert.match(workflow, /runtime_sources:/)
assert.match(workflow, /EXTERNAL_PACKAGE_SOURCE_POLICY:/)
assert.doesNotMatch(publicWorkflowSurface, /external_package_allowed_repositories:|external_package_allowed_paths:/)
assert.match(workflow, /runner_workspace:/)
assert.match(workflow, /artifact_declarations:/)
assert.match(workflow, /output_projections:/)
assert.match(workflow, /verification_commands:/)
assert.match(workflow, /drift_checks:/)
assert.match(workflow, /access_token_repos:/)
assert.doesNotMatch(publicWorkflowSurface, /require_access_token:/)
assert.match(workflow, /projected_outputs_json:/)
assert.match(workflow, /ACCESS_TOKEN:/)
assert.match(workflow, /GITHUB_TOKEN: \$\{\{ secrets\.ACCESS_TOKEN \|\| github\.token \}\}/)
assert.match(workflow, /CALLER_REPO: \$\{\{ github\.repository \}\}/)
assert.match(workflow, /EXPLICIT_ACCESS_TOKEN_CONFIGURED: \$\{\{ secrets\.ACCESS_TOKEN != '' \}\}/)
assert.doesNotMatch(workflow, /homeboy|require_app_token|require_homeboy_app_token|REQUIRE_HOMEBOY_APP_TOKEN|Extra-Chill\/homeboy-action|agent-task run-plan/i)
assert.doesNotMatch(workflow, /docs-agent|wp-codebox\/docs-agent-runner-recipe\/v1|recipe_path|recipe_json|wp_codebox_ref/i)
assert.doesNotMatch(workflow, /datamachine-agent-ci|runtime-agent-full-run|Extra-Chill\/homeboy-extensions/)
assert.match(workflow, /Install WP Codebox runtime/)
assert.match(workflow, /Checkout target workspace/)
assert.match(workflow, /Execute native agent task/)
assert.match(workflow, /execute-native-agent-task\.mjs/)
assert.match(workflow, /workspace\/\.codebox\/agent-task-upload/)
assert.match(workflow, /prepare-agent-task-upload\.mjs/)
assert.match(workflow, /agent-task-upload/)
assert.match(workflow, /if: always\(\)/)
assert.match(workflow, /WP_CODEBOX_RELEASE_REF: \$\{\{ inputs\.wp_codebox_release_ref \}\}/)
assert.match(workflow, /\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/)
assert.doesNotMatch(workflow, /github\.workflow_ref|WORKFLOW_REF|expected_workflow_ref/)
assert.match(workflow, /repository: Automattic\/wp-codebox/)
assert.match(workflow, /ref: \$\{\{ inputs\.wp_codebox_release_ref \}\}/)
assert.match(workflow, /Verify WP Codebox workflow helper release/)
assert.match(workflow, /git ls-remote --exit-code --refs origin "refs\/tags\/\$\{WP_CODEBOX_RELEASE_REF\}"/)
assert.match(workflow, /checked_out_commit.*remote_tag_commit/)
assert.match(workflow, /JSON\.parse\(readFileSync\("package\.json", "utf8"\)\)\.version/)
assert.doesNotMatch(workflow, /steps\.[^.]+\.outputs\.ref/)
assert.match(workflow, /Validate WP Codebox release tag/)

const parseConsumerReleaseTags = (consumer: string) => ({
  workflow: consumer.match(/uses: Automattic\/wp-codebox\/\.github\/workflows\/run-agent-task\.yml@([^\s]+)/)?.[1],
  helpers: consumer.match(/wp_codebox_release_ref: ([^\s]+)/)?.[1],
})
const isExactReleaseTag = (value: string | undefined) => /^v\d+\.\d+\.\d+$/.test(value ?? "")
const isCoherentConsumer = (consumer: string) => {
  const { workflow: workflowTag, helpers: helperTag } = parseConsumerReleaseTags(consumer)
  return isExactReleaseTag(workflowTag) && workflowTag === helperTag
}
const coherentConsumer = await readFile(new URL("../fixtures/agent-task-reusable-workflow-consumer.yml", import.meta.url), "utf8")
const mismatchedConsumer = await readFile(new URL("../fixtures/agent-task-reusable-workflow-consumer-mismatched.yml", import.meta.url), "utf8")
const buildRunConsumer = await readFile(new URL("../fixtures/agent-task-reusable-workflow-build-run-29295530010.yml", import.meta.url), "utf8")
assert.equal(isCoherentConsumer(coherentConsumer), true, "An exact matching workflow and helper release tag must succeed")
assert.equal(isCoherentConsumer(mismatchedConsumer), false, "Mismatched workflow and helper release tags must fail")
assert.match(buildRunConsumer, /github\.workflow_ref: Automattic\/build-with-wordpress\/\.github\/workflows\/build\.yml@trunk/)
assert.equal(isCoherentConsumer(buildRunConsumer), true, "A foreign caller workflow_ref must not affect the paired release tags")
for (const invalidRef of ["main", "v0", "v0.12", "v0.12.3-rc.1", "0123456789abcdef0123456789abcdef01234567"]) {
  assert.equal(isExactReleaseTag(invalidRef), false, `Non-release ref must fail: ${invalidRef}`)
}
assert.doesNotMatch(publicWorkflowSurface, /step_budget:|tool_results_key:/)
assert.doesNotMatch(workflow, /steps\.plan\.outputs/)
assert.doesNotMatch(publicWorkflowSurface, /datamachine|data machine|data-machine|agents api/i)
assert.doesNotMatch(publicWorkflowSurface, /mount|component path|ability id|provider plugin/i)

const docs = await readFile(new URL("../docs/agent-task-reusable-workflow.md", import.meta.url), "utf8")
assert.match(docs, /^# Agent Task Reusable Workflow/m)
assert.match(docs, /Automattic\/wp-codebox\/.github\/workflows\/run-agent-task.yml@v0\.12\.3/)
assert.match(docs, /wp_codebox_release_ref: v0\.12\.3/)
assert.match(docs, /branches, commit SHAs, moving major tags, prereleases, and arbitrary\nrefs are rejected/)
assert.match(docs, /GitHub nested workflows\s+expose the caller's `github\.workflow_ref`, and the running workflow cannot\s+introspect its own `uses:` ref/)
assert.match(docs, /external_package_source/)
assert.match(docs, /runner_workspace/)
assert.match(docs, /access_token_repos/)
assert.match(docs, /built-in `github\.token` as `GITHUB_TOKEN`/)
assert.match(docs, /target in another\nrepository, `ACCESS_TOKEN` is required explicitly/)
assert.match(docs, /success_requires_pr/)
assert.match(docs, /intentional exposed-workflow breaking change/)
assert.match(docs, /wp-codebox\/reusable-workflow-interface\/v1/)
assert.match(docs, /run-agent-task-reusable-workflow-interface\.v1\.json/)
assert.match(docs, /WP_CODEBOX_DIR/)
assert.match(docs, /Runtime Coverage/)
assert.match(docs, /deterministic WordPress Playground end-to-end test/)
assert.doesNotMatch(docs.slice(0, docs.indexOf("## Runtime Coverage")), /docs-agent|wp-codebox\/docs-agent-runner-recipe\/v1|recipe_path|recipe_json|wp_codebox_ref|datamachine|data machine|data-machine|agents api|sandbox mounts|ability ids|provider internals|homeboy|require_app_token/i)

const tmp = await mkdtemp(join(tmpdir(), "wp-codebox-agent-task-workflow-"))
const controlledCodeboxPath = join(tmp, ".codebox")
await mkdir(controlledCodeboxPath)
const nativeResultPath = join(controlledCodeboxPath, "native-agent-task-result.json")
const nativeResult = {
  schema: "wp-codebox/agent-task-run/v1",
  success: true,
  status: "succeeded",
  agent_task_run_result: { schema: "wp-codebox/agent-task-run-result/v1", success: true, status: "succeeded" },
  padding: "x".repeat(40 * 1024),
}
const redactNativeResult = (value: unknown) => value
await writeFile(nativeResultPath, JSON.stringify(nativeResult))
const hostedTruncationRegression = await readNativeResult(nativeResultPath, controlledCodeboxPath, ["native-secret"], redactNativeResult)
assert.equal(hostedTruncationRegression.success, true, "A valid result larger than the 32 KiB stdout diagnostic limit must be read from the result file")
assert.equal((hostedTruncationRegression as Record<string, unknown>).padding, nativeResult.padding)
assert.match(await readFile(new URL("../.github/scripts/run-agent-task/execute-native-agent-task.mjs", import.meta.url), "utf8"), /"--result-file", nativeResultPath/)
await writeFile(nativeResultPath, "{")
assert.equal((await readNativeResult(nativeResultPath, controlledCodeboxPath, [], redactNativeResult) as any).diagnostics[0].code, "wp-codebox.agent-task.result-malformed")
await writeFile(nativeResultPath, JSON.stringify({ ...nativeResult, status: "pending" }))
assert.equal((await readNativeResult(nativeResultPath, controlledCodeboxPath, [], redactNativeResult) as any).diagnostics[0].code, "wp-codebox.agent-task.result-schema")
await writeFile(nativeResultPath, JSON.stringify({ ...nativeResult, padding: "x".repeat(MAX_NATIVE_RESULT_BYTES) }))
assert.equal((await readNativeResult(nativeResultPath, controlledCodeboxPath, [], redactNativeResult) as any).diagnostics[0].code, "wp-codebox.agent-task.result-too-large")
await writeFile(nativeResultPath, JSON.stringify({ ...nativeResult, padding: "native-secret" }))
assert.equal((await readNativeResult(nativeResultPath, controlledCodeboxPath, ["native-secret"], redactNativeResult) as any).diagnostics[0].code, "wp-codebox.agent-task.result-secret")
await writeFile(join(controlledCodeboxPath, "outside.json"), JSON.stringify(nativeResult))
await rm(nativeResultPath)
await symlink(join(controlledCodeboxPath, "outside.json"), nativeResultPath)
assert.equal((await readNativeResult(nativeResultPath, controlledCodeboxPath, [], redactNativeResult) as any).diagnostics[0].code, "wp-codebox.agent-task.result-file")
assert.equal((await readNativeResult(join(tmp, "outside.json"), controlledCodeboxPath, [], redactNativeResult) as any).diagnostics[0].code, "wp-codebox.agent-task.result-path")
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
    RUNTIME_SOURCES: "[]",
    EXTERNAL_PACKAGE_SOURCE_POLICY: '{"version":1,"repositories":{"automattic/example-agent-packages":["packages/example-agent.agent.json"]}}',
    WORKLOAD_ID: "example-maintenance",
    WORKLOAD_LABEL: "Run example maintenance",
    COMPONENT_ID: "example-ci-driver",
    TARGET_REPO: "Automattic/example-target",
    CALLER_REPO: "Automattic/example-target",
    PROMPT: "Update the configured surface.",
    WRITABLE_PATHS: "README.md,docs/**",
    PROVIDER: "openai",
    MODEL: "gpt-5.5",
    RUNNER_WORKSPACE_CONFIG: '{"enabled":true,"repo":"Automattic/example-target"}',
    VALIDATION_DEPENDENCIES: "",
    VERIFICATION_COMMANDS: '[{"command":"npm test","description":"Run checks","artifact":{"name":"completion_report","type":"CompletionReport","path":"completion-report.json"}}]',
    DRIFT_CHECKS: "[]",
    SUCCESS_REQUIRES_PR: "false",
    ACCESS_TOKEN_REPOS: "Automattic/example-target",
    ALLOWED_REPOS: '["Automattic/example-target"]',
    MAX_TURNS: "12",
    TIME_BUDGET_MS: "600000",
    OUTPUT_PROJECTIONS: '{"pr_url":"metadata.runner_workspace_publication.url"}',
    TRANSCRIPT_ARTIFACT_NAME: "agent-transcript",
    REPLAY_BUNDLE_ARTIFACT_NAME: "agent-replay",
    EXPECTED_ARTIFACTS: '["agent_transcript"]',
    ARTIFACT_DECLARATIONS: '[{"schema":"wp-codebox/artifact-declaration/v1","name":"agent_transcript"},{"name":"completion_report","type":"CompletionReport","direction":"output","contentType":"application/json"}]',
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
    GITHUB_TOKEN: "test-caller-token",
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
const nativeTaskInput = JSON.parse(await readFile(join(tmp, ".codebox", "native-agent-task-input.json"), "utf8"))
const hostedDocsAgentToolSnapshot = [
  "workspace_read", "workspace_ls", "workspace_grep", "workspace_write", "workspace_edit", "workspace_apply_patch",
  "workspace_show", "workspace_git_status", "workspace_git_diff",
]
assert.deepEqual(nativeTaskInput.task_input.sandbox_tool_policy.tools, hostedDocsAgentToolSnapshot.map((id) => ({
  id,
  runtime_tool_id: id,
  execution_location: "sandbox",
  transport_visibility: "sandbox",
  allowed: true,
  runtime: { environment: "runtime_local", capability_scope: "runtime_local" },
})), "Hosted Docs Agent run 29298164272 must emit canonical sandbox-local workspace metadata")
  assert.deepEqual(nativeTaskInput.task_input.workspaces.map((entry: Record<string, unknown>) => ({
    target: entry.target,
    mode: entry.mode,
    sourceMode: entry.sourceMode,
    seed: { ...(entry.seed as Record<string, unknown>), source: "[external snapshot]" },
  })), [{
    target: "/workspace",
    mode: "readwrite",
    sourceMode: "repo-backed",
    seed: {
      type: "directory",
      source: "[external snapshot]",
      excludePaths: [".git/**", ".codebox/**", "node_modules/**", "vendor/**", "dist/**", "build/**", "coverage/**", ".cache/**", ".env", ".env.*", ".npmrc", ".yarnrc.yml", ".pypirc", ".netrc", "auth.json", "id_rsa", "id_ed25519", "*.pem", "*.key", "credential files"],
    },
  }], "Hosted failures 29324157852 and 29324563665 placed the runner seed outside task_input, so agent-task-run discarded it")
  const seed = nativeTaskInput.task_input.workspaces[0]
  assert.notEqual(seed.seed.source, tmp)
  const seedProvenance = nativeTaskInput.task_input.runtime_task.input.metadata.runner_workspace_seed
  assert.match(seedProvenance.digest.sha256, /^[a-f0-9]{64}$/)
  assert.deepEqual(seedProvenance.excludes, [".git/**", ".codebox/**", "node_modules/**", "vendor/**", "dist/**", "build/**", "coverage/**", ".cache/**", ".env", ".env.*", ".npmrc", ".yarnrc.yml", ".pypirc", ".netrc", "auth.json", "id_rsa", "id_ed25519", "*.pem", "*.key", "credential files"])
  assert.doesNotMatch(JSON.stringify(seedProvenance), new RegExp(tmp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
assert.equal(nativeTaskInput.workspaces, undefined, "Runner workspace configuration must only use the canonical task_input.workspaces field")

const executeNativeAgentTask = new URL("../.github/scripts/run-agent-task/execute-native-agent-task.mjs", import.meta.url).pathname
const executeAccessCase = async (candidate: Record<string, unknown>, environment: Record<string, string>) => {
  await writeFile(requestPath, `${JSON.stringify(candidate, null, 2)}\n`)
  return execFileAsync("node", [executeNativeAgentTask], {
    cwd: tmp,
    env: {
      ...process.env,
      GITHUB_OUTPUT: outputPath,
      AGENT_TASK_REQUEST_PATH: requestPath,
      AGENT_TASK_WORKSPACE: tmp,
      WP_CODEBOX_WORKFLOW_ROOT: new URL("..", import.meta.url).pathname,
      EXTERNAL_PACKAGE_SOURCE_POLICY: '{"version":1,"repositories":{"automattic/example-agent-packages":["packages/example-agent.agent.json"]}}',
      ...environment,
    },
  })
}

// Hosted run 29293335972 supplied github.token with write permissions but no
// named ACCESS_TOKEN. This is the exact same-repository environment.
const callerToken = "caller-token-from-run-29293335972"
await executeAccessCase(request, { GITHUB_TOKEN: callerToken, EXPLICIT_ACCESS_TOKEN_CONFIGURED: "false" })
const sameRepositoryResult = JSON.parse(await readFile(resultPath, "utf8"))
assert.equal(sameRepositoryResult.access.authorized, true)
assert.doesNotMatch(JSON.stringify(sameRepositoryResult), new RegExp(callerToken))

await assert.rejects(
  executeAccessCase(request, { GITHUB_TOKEN: "", EXPLICIT_ACCESS_TOKEN_CONFIGURED: "false" }),
)
assert.match(JSON.parse(await readFile(resultPath, "utf8")).access.error, /No effective GitHub token/)

const crossRepositoryRequest = {
  ...request,
  target_repo: "automattic/another-target",
  access: { ...request.access, allowed_repos: ["automattic/another-target"], access_token_repos: ["automattic/another-target"] },
}
await assert.rejects(
  executeAccessCase(crossRepositoryRequest, { GITHUB_TOKEN: callerToken, EXPLICIT_ACCESS_TOKEN_CONFIGURED: "false" }),
)
assert.match(JSON.parse(await readFile(resultPath, "utf8")).access.error, /explicit ACCESS_TOKEN is required for cross-repository publication/)

const targetMismatchRequest = {
  ...request,
  target_repo: "automattic/another-target",
}
await assert.rejects(
  executeAccessCase(targetMismatchRequest, { GITHUB_TOKEN: callerToken, EXPLICIT_ACCESS_TOKEN_CONFIGURED: "true" }),
)
assert.match(JSON.parse(await readFile(resultPath, "utf8")).access.error, /Target repository is not explicitly authorized/)

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
    GITHUB_TOKEN: "test-caller-token",
    EXTERNAL_PACKAGE_SOURCE_POLICY: '{"version":1,"repositories":{"automattic/example-agent-packages":["packages/example-agent.agent.json"]}}',
  },
}), /verification_commands\[0\]\.command/)

const malformedArtifactRequest = { ...request, verification_commands: [{ command: "true", artifact: { name: "report", path: "report.json" } }] }
await writeFile(requestPath, `${JSON.stringify(malformedArtifactRequest, null, 2)}\n`)
await assert.rejects(execFileAsync("node", [executeNativeAgentTask], {
  cwd: tmp,
  env: {
    ...process.env,
    GITHUB_OUTPUT: outputPath,
    AGENT_TASK_REQUEST_PATH: requestPath,
    AGENT_TASK_WORKSPACE: tmp,
    WP_CODEBOX_WORKFLOW_ROOT: new URL("..", import.meta.url).pathname,
    GITHUB_TOKEN: "test-caller-token",
    EXTERNAL_PACKAGE_SOURCE_POLICY: '{"version":1,"repositories":{"automattic/example-agent-packages":["packages/example-agent.agent.json"]}}',
  },
}), /verification_commands\[0\]\.artifact\.type/)

await writeFile(requestPath, "{\n")
await assert.rejects(execFileAsync("node", [executeNativeAgentTask], {
  cwd: tmp,
  env: {
    ...process.env,
    GITHUB_OUTPUT: outputPath,
    AGENT_TASK_REQUEST_PATH: requestPath,
    AGENT_TASK_WORKSPACE: tmp,
    WP_CODEBOX_WORKFLOW_ROOT: new URL("..", import.meta.url).pathname,
    EXTERNAL_PACKAGE_SOURCE_POLICY: '{"version":1,"repositories":{"automattic/example-agent-packages":["packages/example-agent.agent.json"]}}',
  },
}))
const malformedParseResult = JSON.parse(await readFile(resultPath, "utf8"))
assert.equal(malformedParseResult.failure.classification, "execution")
await execFileAsync("node", [new URL("../.github/scripts/run-agent-task/prepare-agent-task-upload.mjs", import.meta.url).pathname], {
  cwd: tmp,
  env: { ...process.env, AGENT_TASK_WORKSPACE: tmp, AGENT_TASK_REQUEST_PATH: requestPath },
})
assert.ok(await readFile(join(tmp, ".codebox", "agent-task-upload", ".codebox", "agent-task-workflow-result.json"), "utf8"))

// Every lifecycle failure publishes the same safe review envelope, including
// failures before artifact materialization has created an artifact directory.
const assertEarlyFailureUpload = async (name: string, environment: Record<string, string>, expectedClassification: string) => {
  const failureRoot = await mkdtemp(join(tmpdir(), `wp-codebox-agent-task-${name}-`))
  const failureCodebox = join(failureRoot, ".codebox")
  const failureRequestPath = join(failureCodebox, "agent-task-request.json")
  await mkdir(failureCodebox, { recursive: true })
  await writeFile(failureRequestPath, `${JSON.stringify({ ...request, run_agent: name === "materialization", dry_run: false }, null, 2)}\n`)
  await assert.rejects(execFileAsync(process.execPath, [executeNativeAgentTask], {
    cwd: failureRoot,
    env: {
      ...process.env,
      GITHUB_OUTPUT: join(failureRoot, "github-output.txt"),
      AGENT_TASK_REQUEST_PATH: failureRequestPath,
      AGENT_TASK_WORKSPACE: failureRoot,
      WP_CODEBOX_WORKFLOW_ROOT: new URL("..", import.meta.url).pathname,
      EXTERNAL_PACKAGE_SOURCE_POLICY: '{"version":1,"repositories":{"automattic/example-agent-packages":["packages/example-agent.agent.json"]}}',
      GITHUB_TOKEN: "test-caller-token",
      ...environment,
    },
  }))
  const failureResultPath = join(failureCodebox, "agent-task-workflow-result.json")
  const failureResult = JSON.parse(await readFile(failureResultPath, "utf8"))
  assert.equal(failureResult.status, "failed")
  assert.equal(failureResult.success, false)
  assert.equal(failureResult.failure.classification, expectedClassification)
  assert.equal(await readFile(join(failureCodebox, "agent-task-artifacts", "exclusions.json"), "utf8").catch(() => "missing"), "missing", "Early failures must not create source or artifact trees")
  await execFileAsync("node", [new URL("../.github/scripts/run-agent-task/prepare-agent-task-upload.mjs", import.meta.url).pathname], {
    cwd: failureRoot,
    env: { ...process.env, AGENT_TASK_WORKSPACE: failureRoot, AGENT_TASK_REQUEST_PATH: failureRequestPath, AGENT_TASK_UPLOAD_PATH: join(failureCodebox, "agent-task-upload") },
  })
  const uploadRoot = join(failureCodebox, "agent-task-upload", ".codebox")
  assert.deepEqual(JSON.parse(await readFile(join(uploadRoot, "agent-task-workflow-result.json"), "utf8")).failure, failureResult.failure)
  assert.ok(await readFile(join(uploadRoot, "agent-task-request.json"), "utf8"))
  assert.ok(await readFile(join(uploadRoot, "agent-task-artifacts", "exclusions.json"), "utf8"))
  assert.equal((await readdir(uploadRoot, { recursive: true })).some((path) => /prepared-|source-package|\.php$|\.m?js$/i.test(path)), false, "Failure uploads must exclude sources")
}

await assertEarlyFailureUpload("source-policy", { EXTERNAL_PACKAGE_SOURCE_POLICY: "{}" }, "policy")
await assertEarlyFailureUpload("materialization", { PATH: "" }, "materialization")
await assertEarlyFailureUpload("approval", { GITHUB_TOKEN: "", EXPLICIT_ACCESS_TOKEN_CONFIGURED: "false" }, "policy")

// A serialized task request cannot stand in for a native run. Exercise the real
// package-staging and canonical agents/chat harnesses instead of fabricating CLI
// JSON or publication output in this workflow test.
await execFileAsync("npm", ["run", "test:agent-task-runtime-package-staging"], { cwd: new URL("..", import.meta.url).pathname })
await execFileAsync("npm", ["run", "test:agent-no-data-machine-loop"], { cwd: new URL("..", import.meta.url).pathname })
await execFileAsync("npm", ["run", "test:php-runner-workspace-tools"], { cwd: new URL("..", import.meta.url).pathname })

const outputs = await readFile(outputPath, "utf8")
assert.match(outputs, /job_status<<__WP_CODEBOX_OUTPUT__\nskipped\n__WP_CODEBOX_OUTPUT__/)
assert.match(outputs, /credential_mode<<__WP_CODEBOX_OUTPUT__\nrunner-access-token\n__WP_CODEBOX_OUTPUT__/)
assert.doesNotMatch(outputs, /caller-token-from-run-29293335972/)
assert.match(outputs, /request_path<<__WP_CODEBOX_OUTPUT__\n\.codebox\/agent-task-request\.json\n__WP_CODEBOX_OUTPUT__/)
assert.match(outputs, /result_path<<__WP_CODEBOX_OUTPUT__\n\.codebox\/agent-task-workflow-result\.json\n__WP_CODEBOX_OUTPUT__/)

// Uploads come only from a fail-closed staging directory. Policy data remains
// secret even though public package bytes may be present in runtime input.
const artifactsPath = join(tmp, ".codebox", "agent-task-artifacts")
await mkdir(artifactsPath, { recursive: true })
await writeFile(join(artifactsPath, "safe.txt"), "secret-agent-value secret-github-value")
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
const exclusions = await readFile(join(uploadArtifactsPath, "exclusions.json"), "utf8")
assert.match(exclusions, /"category": "undeclared-artifact"/)
assert.doesNotMatch(exclusions, /secret-agent-value|secret-github-value/)
assert.doesNotMatch(await readFile(join(tmp, ".codebox", "agent-task-upload", ".codebox", "agent-task-request.json"), "utf8"), /secret-agent-value|secret-github-value|\{"private":"policy"\}/)
for (const name of ["oversize.txt", "binary.bin", "linked-secret.txt"]) {
  await assert.rejects(readFile(join(uploadArtifactsPath, name), "utf8"), /ENOENT/)
}

// Workflow output limits are measured in UTF-8 bytes, never by JS code units.
// Oversized system outputs become artifact references; caller projections fail
// before they can produce malformed GitHub Actions JSON.
const fakeCliPath = join(tmp, "fake-agent-task-cli.mjs")
const outputValueAtBytes = (bytes: number) => {
  const overhead = Buffer.byteLength(JSON.stringify({ value: "" }))
  return { value: "x".repeat(bytes - overhead) }
}
const readWorkflowOutput = (contents: string, name: string) => {
  const match = contents.match(new RegExp(`${name}<<__WP_CODEBOX_OUTPUT__\\n([\\s\\S]*?)\\n__WP_CODEBOX_OUTPUT__`))
  assert.ok(match, `Missing ${name} output`)
  return JSON.parse(match[1])
}
const runWorkflowOutputCase = async (nativeOutputs: Record<string, unknown>, outputProjections = {}) => {
  const caseOutputPath = join(tmp, `github-output-${Math.random().toString(16).slice(2)}.txt`)
  const caseRequest = {
    ...request,
    external_package_source: nativeSource,
    runner_workspace: { enabled: false },
    validation_dependencies: "",
    verification_commands: [],
    drift_checks: [],
    run_agent: true,
    dry_run: false,
    outputs: { projections: outputProjections },
  }
  await writeFile(requestPath, `${JSON.stringify(caseRequest, null, 2)}\n`)
  const nativeResultForOutput = {
    schema: "wp-codebox/agent-task-run/v1",
    success: true,
    status: "succeeded",
    agent_task_run_result: { schema: "wp-codebox/agent-task-run-result/v1", success: true, status: "succeeded" },
    outputs: nativeOutputs,
  }
  await writeFile(fakeCliPath, [
    'import { writeFile } from "node:fs/promises"',
    'const path = process.argv[process.argv.indexOf("--result-file") + 1]',
    `await writeFile(path, ${JSON.stringify(JSON.stringify(nativeResultForOutput))})`,
  ].join("\n"))
  const execution = execFileAsync("node", [executeNativeAgentTask], {
    cwd: tmp,
    env: {
      ...process.env,
      NODE_ENV: "test",
      GITHUB_OUTPUT: caseOutputPath,
      AGENT_TASK_REQUEST_PATH: requestPath,
      AGENT_TASK_WORKSPACE: tmp,
      WP_CODEBOX_WORKFLOW_ROOT: new URL("..", import.meta.url).pathname,
      WP_CODEBOX_CLI_PATH: fakeCliPath,
      WP_CODEBOX_TEST_SKIP_MATERIALIZATION: "true",
      WP_CODEBOX_TEST_EXTERNAL_PACKAGE_PATH: nativePackagePath,
      GITHUB_TOKEN: "test-caller-token",
      EXTERNAL_PACKAGE_SOURCE_POLICY: '{"version":1,"repositories":{"automattic/example-agent-packages":["packages/example-agent.agent.json"]}}',
    },
  }).catch(async (error: any) => {
    const workflowResult = await readFile(resultPath, "utf8").catch(() => "missing")
    error.message = `${error.message}\n${error.stderr || ""}\n${workflowResult}`
    throw error
  })
  return { execution, result: () => readFile(resultPath, "utf8").then(JSON.parse), outputs: () => readFile(caseOutputPath, "utf8") }
}

const exactBoundaryEngineData = outputValueAtBytes(8192)
const exactBoundaryCase = await runWorkflowOutputCase(exactBoundaryEngineData)
await exactBoundaryCase.execution
assert.deepEqual(readWorkflowOutput(await exactBoundaryCase.outputs(), "engine_data_json"), exactBoundaryEngineData)
assert.equal((await exactBoundaryCase.result()).workflow_output_artifacts, undefined)

const overBoundaryEngineData = outputValueAtBytes(8193)
const overBoundaryCase = await runWorkflowOutputCase(overBoundaryEngineData)
await overBoundaryCase.execution
const overBoundaryReference = readWorkflowOutput(await overBoundaryCase.outputs(), "engine_data_json")
assert.deepEqual(overBoundaryReference, (await overBoundaryCase.result()).workflow_output_artifacts.engine_data_json)
assert.deepEqual(JSON.parse(await readFile(join(tmp, ".codebox", "agent-task-artifacts", overBoundaryReference.artifact_path), "utf8")), overBoundaryEngineData)
await execFileAsync("node", [new URL("../.github/scripts/run-agent-task/prepare-agent-task-upload.mjs", import.meta.url).pathname], {
  cwd: tmp,
  env: { ...process.env, AGENT_TASK_WORKSPACE: tmp, AGENT_TASK_REQUEST_PATH: requestPath },
})
assert.deepEqual(JSON.parse(await readFile(join(tmp, ".codebox", "agent-task-upload", ".codebox", "agent-task-artifacts", overBoundaryReference.artifact_path), "utf8")), overBoundaryEngineData)

const multibyteCase = await runWorkflowOutputCase({ value: "😀".repeat(2048) })
await multibyteCase.execution
assert.equal(readWorkflowOutput(await multibyteCase.outputs(), "engine_data_json").schema, "wp-codebox/workflow-output-reference/v1")

const nestedProjectionCase = await runWorkflowOutputCase(
  { nested: { result: { value: "x".repeat(8193) } } },
  { nested_output: "outputs.nested" },
)
await assert.rejects(nestedProjectionCase.execution)
const nestedProjectionResult = await nestedProjectionCase.result()
assert.equal(nestedProjectionResult.success, false)
assert.deepEqual(nestedProjectionResult.projection_error, {
  code: "wp-codebox.agent-task.output-projection-too-large",
  classification: "output-projection",
  message: nestedProjectionResult.projection_error.message,
  output_name: "nested_output",
  bytes: Buffer.byteLength(JSON.stringify({ result: { value: "x".repeat(8193) } })),
  max_bytes: 8192,
})
assert.deepEqual(readWorkflowOutput(await nestedProjectionCase.outputs(), "projected_outputs_json"), { error: nestedProjectionResult.projection_error })

console.log("agent task reusable workflow ok")
