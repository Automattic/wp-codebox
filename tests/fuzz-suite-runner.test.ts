import assert from "node:assert/strict"

import { PHP_IN_PROCESS_FUZZ_SUITE_RUNNER_CAPABILITIES, RUNTIME_BACKED_FUZZ_SUITE_RUNNER_CAPABILITIES, fuzzRunnerCapabilitiesContract, fuzzSuiteContract, fuzzSuiteResetPolicyDiagnostics, normalizeFuzzSuiteResetPolicy, planFuzzSuiteCaseExecutionSpec, runFuzzSuite, runWordPressRestMatrix, wordpressRestMatrixContract, wordpressRestMatrixToFuzzSuite, type ExecutionResult, type ExecutionSpec } from "../packages/runtime-core/src/index.js"

const executed: ExecutionSpec[] = []
const result = await runFuzzSuite(fuzzSuiteContract({
  id: "suite-001",
  version: "2026-06-21",
  target: { kind: "command", id: "inspect-mounted-inputs" },
  cases: [
    { id: "case-pass", input: { args: ["--json"], cwd: "/workspace", timeoutMs: 1000 }, metadata: { source: "fixture" } },
    { id: "case-fail", target: { kind: "runtime", entrypoint: "wordpress.run-php" }, input: ["code=exit(1);"] },
    { id: "case-http", target: { kind: "http" }, input: { url: "/", method: "GET", expectStatus: 200 } },
    { id: "case-rest", target: { kind: "rest", id: "/wp/v2/types" }, input: { method: "GET", params: { context: "view" } } },
    { id: "case-ability", target: { kind: "ability", id: "example/echo" }, input: { input: { message: "hello" }, expectedResultSchema: "example/result" } },
    { id: "case-runtime-action", target: { kind: "runtime-action" }, input: { type: "rest_request", path: "/wp/v2/status", method: "GET" } },
    { id: "case-runtime-action-browser", target: { kind: "runtime-action" }, input: { type: "browser", operation: "navigate", url: "/sample-page/", capture: ["console", "screenshot"] } },
    { id: "case-runtime-action-admin", target: { kind: "runtime-action" }, input: { type: "admin_page", path: "plugins.php", capture_diagnostics: ["php-notices"] } },
    { id: "case-runtime-action-page", target: { kind: "runtime-action" }, input: { type: "page", path: "/sample-page/", query: { preview: true } } },
    { id: "case-runtime-action-editor", target: { kind: "runtime-action" }, input: { type: "editor_open", target: "post-new", post_type: "page", capture: ["editor-state"] } },
    { id: "case-runtime-action-crud", target: { kind: "runtime-action" }, input: { type: "crud_operation", operation: "read", resource: { kind: "post", type: "page", id: 42 } } },
    { id: "case-runtime-action-db", target: { kind: "runtime-action" }, input: { type: "db_operation", operation: "inspect", resource: { table: "posts" } } },
    { id: "case-runtime-action-unsupported", target: { kind: "runtime-action" }, input: { type: "filesystem", operation: "list" } },
  ],
}), {
  executor: async (spec) => {
    executed.push(spec)
    const exitCode = spec.command === "wordpress.run-php" ? 1 : 0
    return {
      id: `exec-${executed.length}`,
      command: spec.command,
      args: spec.args ?? [],
      exitCode,
      stdout: exitCode === 0 ? "ok" : "",
      stderr: exitCode === 0 ? "" : "failed",
      startedAt: `2026-01-01T00:00:0${executed.length}.000Z`,
      finishedAt: `2026-01-01T00:00:0${executed.length + 1}.000Z`,
      artifactRefs: [{ kind: "execution", id: `artifact-${executed.length}`, path: `/artifacts/exec-${executed.length}.json`, digest: { algorithm: "sha256", value: `sha-${executed.length}` } }],
    } satisfies ExecutionResult
  },
})

assert.equal(result.schema, "wp-codebox/fuzz-suite-result/v1")
assert.equal(result.suite.id, "suite-001")
assert.equal(result.status, "failed")
assert.equal(result.success, false)
assert.deepEqual(result.summary, { total: 13, passed: 11, failed: 1, error: 0, skipped: 1 })
assert.deepEqual(result.coverageSummary, {
  discovered: 13,
  generated: 13,
  executed: 12,
  skipped: 1,
  untested: 0,
  skippedReasons: [{ reason: "fuzz_suite_target_adapter_unsupported", count: 1, caseIds: ["case-runtime-action-unsupported"] }],
})
assert.equal(result.coveragePlan?.schema, "wp-codebox/fuzz-coverage-plan/v1")
assert.deepEqual({ discovered: result.coveragePlan?.summary.discovered, generated: result.coveragePlan?.summary.generated, executable: result.coveragePlan?.summary.executable, executed: result.coveragePlan?.summary.executed, skipped: result.coveragePlan?.summary.skipped, untested: result.coveragePlan?.summary.untested }, { discovered: 13, generated: 13, executable: 13, executed: 12, skipped: 1, untested: 0 })
assert.deepEqual(result.coveragePlan?.executed.map((item) => item.id), result.cases.filter((item) => item.status !== "skipped").map((item) => item.id))
assert.equal(result.coveragePlan?.skipped[0]?.reason?.code, "fuzz_suite_target_adapter_unsupported")
assert.deepEqual(executed.map((spec) => spec.command), ["inspect-mounted-inputs", "wordpress.run-php", "wordpress.http-request", "wordpress.rest-request", "wordpress.ability", "wordpress.rest-request", "wordpress.browser-actions", "wordpress.admin-page-load", "wordpress.frontend-page-load", "wordpress.editor-open", "wordpress.crud-operation", "wordpress.db-operation"])
assert.deepEqual(executed[0], { command: "inspect-mounted-inputs", args: ["--json"], cwd: "/workspace", timeoutMs: 1000 })
assert.deepEqual(executed[2], { command: "wordpress.http-request", args: ["url=/", "method=GET", "expect-status=200"], method: "GET", path: "/" })
assert.deepEqual(executed[3], { command: "wordpress.rest-request", args: ["path=/wp/v2/types", "method=GET", "params-json={\"context\":\"view\"}"], method: "GET", path: "/wp/v2/types" })
assert.deepEqual(executed[4], { command: "wordpress.ability", args: ["name=example/echo", "input={\"message\":\"hello\"}", "expected-result-schema=example/result"] })
assert.deepEqual(executed[5], { command: "wordpress.rest-request", args: ["path=/wp/v2/status", "method=GET"], method: "GET", path: "/wp/v2/status" })
assert.deepEqual(executed[6], { command: "wordpress.browser-actions", args: ['steps-json=[{"kind":"navigate","url":"/sample-page/"}]', "capture=console,screenshot"] })
assert.deepEqual(executed[7], { command: "wordpress.admin-page-load", args: ["path=plugins.php", "capture-diagnostics=php-notices"] })
assert.deepEqual(executed[8], { command: "wordpress.frontend-page-load", args: ["path=/sample-page/", "query-json={\"preview\":true}"] })
assert.deepEqual(executed[9], { command: "wordpress.editor-open", args: ["target=post-new", "post-type=page", "capture=editor-state"] })
assert.equal(JSON.parse(executed[10]?.args?.[0]?.replace("operation-json=", "") ?? "{}").schema, "wp-codebox/wordpress-crud-operation/v1")
assert.equal(JSON.parse(executed[11]?.args?.[0]?.replace("operation-json=", "") ?? "{}").schema, "wp-codebox/wordpress-db-operation/v1")
assert.equal(JSON.parse(executed[11]?.args?.[0]?.replace("operation-json=", "") ?? "{}").resource.table, "posts")
assert.equal(result.cases[0]?.status, "passed")
assert.equal(result.cases[0]?.artifactRefs?.[0]?.path, "/artifacts/exec-1.json")
assert.equal(result.cases[1]?.status, "failed")
assert.equal(result.cases[1]?.diagnostics[0]?.code, "fuzz_suite_command_failed")
assert.equal(result.cases[12]?.status, "skipped")
assert.equal(result.cases[12]?.skipReason, "fuzz_suite_target_adapter_unsupported")
assert.equal(result.cases[12]?.diagnostics[0]?.code, "fuzz_suite_target_adapter_unsupported")
assert.equal(result.artifactRefs.length, 12)
assert.equal((result.cases[0]?.metadata?.replay as Record<string, unknown> | undefined)?.caseId, "case-pass")
assert.equal(RUNTIME_BACKED_FUZZ_SUITE_RUNNER_CAPABILITIES.capabilities.includes("db_operation"), true)
assert.equal(RUNTIME_BACKED_FUZZ_SUITE_RUNNER_CAPABILITIES.runtimeActionTypes?.includes("db_operation"), true)
assert.equal(RUNTIME_BACKED_FUZZ_SUITE_RUNNER_CAPABILITIES.commands?.includes("wordpress.db-operation"), true)

const blockedRestMutation = await runFuzzSuite(fuzzSuiteContract({
  id: "suite-rest-mutation-blocked",
  cases: [{ id: "delete-post", target: { kind: "runtime-action" }, input: { type: "rest_request", method: "DELETE", path: "/wp/v2/posts/10" } }],
}), { runtimeActionExecutor: async () => { throw new Error("must not execute") } })
assert.equal(blockedRestMutation.status, "skipped")
assert.equal(blockedRestMutation.cases[0]?.skipReason, "fuzz_suite_input_unsupported")
assert.equal(blockedRestMutation.cases[0]?.diagnostics[0]?.metadata?.mutationSkipped, true)

const allowedRestMutations: string[] = []
const allowedRestMutation = await runFuzzSuite(fuzzSuiteContract({
  id: "suite-rest-mutation-allowed",
  metadata: { allowRestMutations: true },
  cases: [{ id: "delete-post", target: { kind: "runtime-action" }, input: { type: "rest_request", method: "DELETE", path: "/wp/v2/posts/10" } }],
}), {
  runtimeActionExecutor: async ({ action }) => {
    allowedRestMutations.push(action.type)
    return { schema: "wp-codebox/runtime-action-observation/v1", type: action.type, status: "ok", action, data: { method: "DELETE", path: "/wp/v2/posts/10", status: 200 }, observedAt: "2026-01-01T00:00:00.000Z", digest: { algorithm: "sha256", value: "delete" } }
  },
})
assert.equal(allowedRestMutation.status, "passed")
assert.deepEqual(allowedRestMutations, ["rest_request"])

const plannedEditor = planFuzzSuiteCaseExecutionSpec({
  suite: fuzzSuiteContract({ id: "planner", cases: [] }),
  case: { id: "editor", target: { kind: "runtime-action" }, input: { type: "editor_open", target: "site" } },
  caseIndex: 0,
})
assert.equal(plannedEditor.status, "supported")
assert.deepEqual(plannedEditor.spec, { command: "wordpress.editor-open", args: ["target=site"] })
assert.equal(plannedEditor.replayMetadata.caseId, "editor")

const workloadExecutions: Record<string, unknown>[] = []
const runtimeWorkloadResult = await runFuzzSuite(fuzzSuiteContract({
  id: "suite-runtime-workload",
  cases: [{
    id: "rest-db-query-profile:default",
    target: { kind: "runtime", id: "wordpress.run-workload", entrypoint: "wordpress.run-workload" },
    input: {
      schema: "wp-codebox/wordpress-workload-run/v1",
      enableQueryCapture: true,
      steps: [{ command: "wordpress.rest-performance-observation", args: ["path=/wp/v2/types", "capture-queries=1"] }],
    },
  }],
}), {
  runtimeWorkloadExecutor: async ({ workload }) => {
    workloadExecutions.push(workload)
    return { id: "workload-exec-1", command: "wordpress.run-workload", args: ["steps=1"], exitCode: 0, stdout: "ok", stderr: "", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z", artifactRefs: [{ kind: "workload", id: "workload-artifact", path: "files/workload.json" }], result: { schema: "wp-codebox/runtime-command-result/v1", status: "ok", json: { metrics: { query_count: 7 }, artifacts: { profile: { schema: "example/profile" } } } } }
  },
})
assert.equal(runtimeWorkloadResult.status, "passed")
assert.equal(runtimeWorkloadResult.cases[0]?.status, "passed")
assert.equal(runtimeWorkloadResult.cases[0]?.diagnostics[0]?.code, undefined)
assert.equal(runtimeWorkloadResult.cases[0]?.artifactRefs?.[0]?.path, "files/workload.json")
assert.deepEqual(((runtimeWorkloadResult.cases[0]?.metadata?.execution as { result?: { json?: { metrics?: { query_count?: number } } } } | undefined)?.result?.json?.metrics?.query_count), 7)
assert.deepEqual((workloadExecutions[0]?.steps as Array<{ command: string; args: string[] }> | undefined)?.[0], { command: "wordpress.rest-performance-observation", args: ["path=/wp/v2/types", "capture-queries=1"] })

const noExecutor = await runFuzzSuite(fuzzSuiteContract({
  id: "suite-002",
  target: { kind: "command", id: "inspect-mounted-inputs" },
  cases: [{ id: "case-skipped" }],
}))
assert.equal(noExecutor.status, "skipped")
assert.deepEqual(noExecutor.coverageSummary?.skippedReasons, [{ reason: "fuzz_suite_executor_unavailable", count: 1, caseIds: ["case-skipped"] }])
assert.equal(noExecutor.cases[0]?.diagnostics[0]?.code, "fuzz_suite_executor_unavailable")

const requiredRuntimeOnPhpRunner = await runFuzzSuite(fuzzSuiteContract({
  id: "suite-runtime-required-on-php-runner",
  target: { kind: "runtime", entrypoint: "wordpress.admin-page-load" },
  cases: [{ id: "admin-page", input: { args: ["path=plugins.php"] } }],
  metadata: { requiredRunnerCapabilities: { capabilities: ["target:runtime", "runtime"], targetKinds: ["runtime"], commands: ["wordpress.admin-page-load"] } },
}), {
  requireCoverage: true,
  runnerCapabilities: PHP_IN_PROCESS_FUZZ_SUITE_RUNNER_CAPABILITIES,
})
assert.equal(requiredRuntimeOnPhpRunner.status, "error")
assert.equal(requiredRuntimeOnPhpRunner.success, false)
assert.equal(requiredRuntimeOnPhpRunner.diagnostics[0]?.code, "fuzz_suite_required_runner_capabilities_unsupported")
assert.equal(requiredRuntimeOnPhpRunner.cases[0]?.skipReason, "fuzz_suite_required_runner_capabilities_unsupported")
assert.deepEqual((requiredRuntimeOnPhpRunner.metadata?.runnerCapabilities as { unsupportedRequiredCapabilities?: string[] } | undefined)?.unsupportedRequiredCapabilities, ["target:runtime", "runtime", "command:wordpress.admin-page-load"])

const phpCapabilities = fuzzRunnerCapabilitiesContract(PHP_IN_PROCESS_FUZZ_SUITE_RUNNER_CAPABILITIES, {
  capabilities: ["target:rest", "runtime"],
  targetKinds: ["rest", "runtime"],
  runtimeActionTypes: ["browser"],
  commands: ["wordpress.rest-request"],
})
assert.equal(phpCapabilities.schema, "wp-codebox/fuzz-runner-capabilities/v1")
assert.equal(phpCapabilities.mode, "php-in-process")
assert.deepEqual(phpCapabilities.targetKinds, ["ability", "http", "rest"])
assert.deepEqual(phpCapabilities.unsupportedRequiredCapabilities, ["runtime", "target:runtime", "runtime-action:browser", "command:wordpress.rest-request"])

const skippedCoverageRequired = await runFuzzSuite(fuzzSuiteContract({
  id: "suite-required-coverage-skipped",
  target: { kind: "command", id: "inspect-mounted-inputs" },
  cases: [{ id: "case-skipped" }],
}), { requireCoverage: true })
assert.equal(skippedCoverageRequired.status, "error")
assert.equal(skippedCoverageRequired.diagnostics.some((diagnostic) => diagnostic.code === "fuzz_suite_required_coverage_unsupported"), true)

assert.deepEqual(normalizeFuzzSuiteResetPolicy("checkpoint-per-case"), { mode: "checkpoint-per-case" })
assert.deepEqual(normalizeFuzzSuiteResetPolicy({ mode: "restore-snapshot", snapshot_ref: "artifact:baseline/files/runtime-snapshot.json", fixture_refs: ["fixtures/store.json"] }), {
  mode: "restore-snapshot",
  snapshot_ref: "artifact:baseline/files/runtime-snapshot.json",
  fixtureRefs: ["fixtures/store.json"],
})
assert.deepEqual(fuzzSuiteResetPolicyDiagnostics({ mode: "restore-snapshot" }).map((diagnostic) => diagnostic.code), ["fuzz_suite_reset_policy_snapshot_ref_required"])
assert.deepEqual(fuzzSuiteResetPolicyDiagnostics({ mode: "truncate-database" }).map((diagnostic) => diagnostic.code), ["fuzz_suite_reset_policy_invalid_mode"])

const resetAttempts: string[] = []
const resetResult = await runFuzzSuite(fuzzSuiteContract({
  id: "suite-reset-required",
  resetPolicy: { mode: "checkpoint-per-case", checkpointName: "baseline", fixtureRefs: ["fixtures/store.json"] },
  target: { kind: "command", id: "inspect-mounted-inputs" },
  cases: [{ id: "case-reset" }],
}), {
  resetExecutor: async ({ policy }) => {
    resetAttempts.push(policy.mode)
    return { mode: policy.mode, status: "passed", checkpointName: policy.checkpointName, fixtureRefs: policy.fixtureRefs, artifactRefs: [{ kind: "checkpoint", path: "files/checkpoint.json" }] }
  },
  executor: async (spec) => ({ id: "exec-reset", command: spec.command, args: spec.args ?? [], exitCode: 0, stdout: "ok", stderr: "", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z" }),
})
assert.equal(resetResult.status, "passed")
assert.deepEqual(resetAttempts, ["checkpoint-per-case"])
assert.equal(resetResult.cases[0]?.reset?.status, "passed")
assert.equal(resetResult.cases[0]?.reset?.checkpointName, "baseline")
assert.equal(resetResult.artifactRefs[0]?.path, "files/checkpoint.json")

const resetExecutorMissing = await runFuzzSuite(fuzzSuiteContract({
  id: "suite-reset-missing-executor",
  resetPolicy: { mode: "checkpoint-per-case" },
  target: { kind: "command", id: "inspect-mounted-inputs" },
  cases: [{ id: "case-reset-blocked" }],
}), { executor: async (spec) => ({ id: "exec-skipped", command: spec.command, args: spec.args ?? [], exitCode: 0, stdout: "ok", stderr: "", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z" }) })
assert.equal(resetExecutorMissing.status, "error")
assert.equal(resetExecutorMissing.cases[0]?.reset?.status, "unsupported")
assert.equal(resetExecutorMissing.cases[0]?.diagnostics[0]?.code, "fuzz_suite_reset_executor_unavailable")

const emptyRequiredArtifacts = await runFuzzSuite(fuzzSuiteContract({
  id: "suite-empty-required-artifacts",
  cases: [],
  metadata: {
    artifacts: { expected: [{ name: "fuzz-report", required: true }] },
  },
}))
assert.equal(emptyRequiredArtifacts.status, "error")
assert.equal(emptyRequiredArtifacts.success, false)
assert.deepEqual(emptyRequiredArtifacts.diagnostics.map((diagnostic) => diagnostic.code), [
  "fuzz_suite_empty_cases_for_declared_contract",
  "fuzz_suite_required_artifacts_missing",
])

const emptyCoverageContract = await runFuzzSuite(fuzzSuiteContract({
  id: "suite-empty-coverage",
  cases: [],
  metadata: {
    coverage: { surface_ids: ["rest-api"], operations: ["route-inventory"] },
  },
}))
assert.equal(emptyCoverageContract.status, "error")
assert.equal(emptyCoverageContract.diagnostics[0]?.code, "fuzz_suite_empty_cases_for_declared_contract")

const declaredOnlyEmpty = await runFuzzSuite(fuzzSuiteContract({
  id: "suite-declared-only-empty",
  cases: [],
  metadata: {
    readiness: { level: "declared" },
    artifacts: { expected: [{ name: "placeholder-report", required: true }] },
    coverage: { surface_ids: ["rest-api"] },
  },
}))
assert.equal(declaredOnlyEmpty.status, "passed")
assert.deepEqual(declaredOnlyEmpty.diagnostics, [])

const blockedEmpty = await runFuzzSuite(fuzzSuiteContract({
  id: "suite-blocked-empty",
  cases: [],
  metadata: {
    generic_primitive: { status: "blocked" },
    artifacts: { expected: [{ name: "blocked-report", required: true }] },
  },
}))
assert.equal(blockedEmpty.status, "passed")
assert.deepEqual(blockedEmpty.diagnostics, [])

const runtimeActions: string[] = []
const runtimeActionResult = await runFuzzSuite(fuzzSuiteContract({
  id: "suite-episode-actions",
  target: { kind: "runtime-action" },
  cases: [
    { id: "browser-capture", input: { type: "browser", operation: "capture", capture: ["html"] } },
    { id: "admin-page", input: { type: "admin_page", path: "plugins.php", capture: ["html"] } },
  ],
}), {
  runtimeActionExecutor: async ({ action }) => {
    runtimeActions.push(action.type)
    return {
      schema: "wp-codebox/runtime-action-observation/v1",
      type: action.type,
      status: "ok",
      action,
      data: { actionType: action.type },
      observedAt: "2026-01-01T00:00:00.000Z",
      artifactRefs: [{ kind: "runtime-action", id: `${action.type}-artifact`, path: `files/${action.type}.json`, digest: { algorithm: "sha256", value: `sha-${action.type}` } }],
      digest: { algorithm: "sha256", value: `digest-${action.type}` },
    }
  },
})
assert.equal(runtimeActionResult.status, "passed")
assert.deepEqual(runtimeActionResult.summary, { total: 2, passed: 2, failed: 0, error: 0, skipped: 0 })
assert.deepEqual(runtimeActions, ["browser", "admin_page"])
assert.equal(runtimeActionResult.cases[0]?.artifactRefs?.[0]?.path, "files/browser.json")
assert.equal((runtimeActionResult.cases[0]?.metadata?.adapter as Record<string, unknown> | undefined)?.executorKind, "episode")

const restMatrix = wordpressRestMatrixContract({
  id: "rest-matrix-001",
  cases: [{ id: "get-posts", method: "GET", path: "/wp/v2/posts", params: { per_page: 1 }, headers: { accept: "application/json" }, session: "admin" }],
})
const restSuite = wordpressRestMatrixToFuzzSuite(restMatrix)
assert.equal(restMatrix.schema, "wp-codebox/wordpress-rest-matrix/v1")
assert.equal(restSuite.target?.kind, "rest")
assert.equal(restSuite.target?.entrypoint, "wordpress.rest-request")
assert.deepEqual((restSuite.cases[0]?.input as { args: string[] }).args, [
  "method=GET",
  "path=/wp/v2/posts",
  'headers-json={"accept":"application/json"}',
  'params-json={"per_page":1}',
  "session=admin",
])

const restExecuted: ExecutionSpec[] = []
const restResult = await runWordPressRestMatrix(restMatrix, {
  executor: async (spec) => {
    restExecuted.push(spec)
    return { id: "rest-exec-1", command: spec.command, args: spec.args ?? [], exitCode: 0, stdout: "{}", stderr: "", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z" }
  },
})
assert.equal(restResult.schema, "wp-codebox/wordpress-rest-matrix-result/v1")
assert.equal(restResult.sourceSchema, "wp-codebox/wordpress-rest-matrix/v1")
assert.equal(restResult.success, true)
assert.equal(restExecuted[0]?.command, "wordpress.rest-request")

console.log("fuzz suite runner ok")
