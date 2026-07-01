import assert from "node:assert/strict"

import { DELETE_BOUNDARY_ARTIFACT_KIND, DELETE_BOUNDARY_ARTIFACT_SCHEMA, MUTATION_ISOLATION_ARTIFACT_KIND, MUTATION_ISOLATION_ARTIFACT_SCHEMA, PHP_IN_PROCESS_FUZZ_SUITE_RUNNER_CAPABILITIES, RUNTIME_BACKED_FUZZ_SUITE_RUNNER_CAPABILITIES, fuzzRunnerCapabilitiesContract, fuzzFixturePlanContract, fuzzSuiteContract, fuzzSuiteResetPolicyDiagnostics, mutationFixtureSeedOperation, normalizeFuzzSuiteResetPolicy, planBrowserRandomWalk, planFuzzSuiteCaseExecutionSpec, restMutationFixtureOptInContract, runFuzzSuite, runWordPressRestMatrix, wordpressRestMatrixContract, wordpressRestMatrixToFuzzSuite, type ExecutionResult, type ExecutionSpec } from "../packages/runtime-core/src/index.js"

const disposableSandboxBoundary = { disposable: true, destructivePermission: true, teardown: "discard", hostAccess: "declared-mounts-only" }
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
    { id: "case-runtime-action-random-walk", target: { kind: "runtime-action" }, input: { type: "random_walk", context: "admin", seed: "seed-walk", max_steps: 4, action_families: ["capture", "press"], start_url: "/wp-admin/edit.php", capture: ["console"] } },
    { id: "case-runtime-action-admin", target: { kind: "runtime-action" }, input: { type: "admin_page", path: "plugins.php", capture_diagnostics: ["php-notices"] } },
    { id: "case-runtime-action-page", target: { kind: "runtime-action" }, input: { type: "page", path: "/sample-page/", query: { preview: true } } },
    { id: "case-runtime-action-editor", target: { kind: "runtime-action" }, input: { type: "editor_open", target: "post-new", post_type: "page", capture: ["editor-state"] } },
    { id: "case-runtime-action-crud", target: { kind: "runtime-action" }, input: { type: "crud_operation", operation: "read", resource: { kind: "post", type: "page", id: 42 } } },
    { id: "case-runtime-action-db", target: { kind: "runtime-action" }, input: { type: "db_operation", operation: "inspect", resource: { table: "posts" } } },
    {
      id: "case-runtime-workload-phases",
      target: { kind: "runtime", id: "wordpress.run-workload" },
      phases: {
        setup: [{ command: "wordpress.ensure-plugin-active", args: ["plugin=example/example.php"] }],
        action: [{ command: "wordpress.fuzz-admin-pages", args: ["safe_methods=GET"] }],
        assert: [{ command: "wordpress.collect-workload-result", args: ["artifact=admin_page_coverage"] }],
      },
    },
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
assert.deepEqual(result.summary, { total: 15, passed: 13, failed: 1, error: 0, skipped: 1 })
assert.deepEqual(result.coverageSummary, {
  discovered: 15,
  generated: 15,
  executed: 14,
  skipped: 1,
  untested: 0,
  skippedReasons: [{ reason: "fuzz_suite_target_adapter_unsupported", count: 1, caseIds: ["case-runtime-action-unsupported"] }],
})
assert.equal(result.coveragePlan?.schema, "wp-codebox/fuzz-coverage-plan/v1")
assert.deepEqual({ discovered: result.coveragePlan?.summary.discovered, generated: result.coveragePlan?.summary.generated, executable: result.coveragePlan?.summary.executable, executed: result.coveragePlan?.summary.executed, skipped: result.coveragePlan?.summary.skipped, untested: result.coveragePlan?.summary.untested }, { discovered: 15, generated: 15, executable: 15, executed: 14, skipped: 1, untested: 0 })
assert.deepEqual(result.coveragePlan?.executed.map((item) => item.id), result.cases.filter((item) => item.status !== "skipped").map((item) => item.id))
assert.equal(result.coveragePlan?.skipped[0]?.reason?.code, "fuzz_suite_target_adapter_unsupported")
assert.deepEqual(executed.map((spec) => spec.command), ["inspect-mounted-inputs", "wordpress.run-php", "wordpress.http-request", "wordpress.rest-request", "wordpress.ability", "wordpress.rest-request", "wordpress.browser-actions", "wordpress.browser-actions", "wordpress.simulated-admin-page-load", "wordpress.simulated-frontend-page-load", "wordpress.editor-open", "wordpress.crud-operation", "wordpress.db-operation", "wordpress.run-workload"])
assert.deepEqual(executed[0], { command: "inspect-mounted-inputs", args: ["--json"], cwd: "/workspace", timeoutMs: 1000 })
assert.deepEqual(executed[2], { command: "wordpress.http-request", args: ["url=/", "method=GET", "expect-status=200"], method: "GET", path: "/" })
assert.deepEqual(executed[3], { command: "wordpress.rest-request", args: ["path=/wp/v2/types", "method=GET", "params-json={\"context\":\"view\"}"], method: "GET", path: "/wp/v2/types" })
assert.deepEqual(executed[4], { command: "wordpress.ability", args: ["name=example/echo", "input={\"message\":\"hello\"}", "expected-result-schema=example/result"] })
assert.deepEqual(executed[5], { command: "wordpress.rest-request", args: ["path=/wp/v2/status", "method=GET"], method: "GET", path: "/wp/v2/status" })
assert.deepEqual(executed[6], { command: "wordpress.browser-actions", args: ['steps-json=[{"kind":"navigate","url":"/sample-page/"}]', "capture=console,screenshot"] })
assert.deepEqual(JSON.parse(executed[7]?.args?.[0]?.replace("steps-json=", "") ?? "[]"), planBrowserRandomWalk({ context: "admin", seed: "seed-walk", max_steps: 4, action_families: ["capture", "press"], start_url: "/wp-admin/edit.php" }).steps)
assert.equal(executed[7]?.args?.[1], "capture=console")
assert.deepEqual(executed[8], { command: "wordpress.simulated-admin-page-load", args: ["path=plugins.php", "capture-diagnostics=php-notices"] })
assert.deepEqual(executed[9], { command: "wordpress.simulated-frontend-page-load", args: ["path=/sample-page/", "query-json={\"preview\":true}"] })
assert.deepEqual(executed[10], { command: "wordpress.editor-open", args: ["target=post-new", "post-type=page", "capture=editor-state"] })
assert.equal(JSON.parse(executed[11]?.args?.[0]?.replace("operation-json=", "") ?? "{}").schema, "wp-codebox/wordpress-crud-operation/v1")
assert.equal(JSON.parse(executed[12]?.args?.[0]?.replace("operation-json=", "") ?? "{}").schema, "wp-codebox/wordpress-db-operation/v1")
assert.equal(JSON.parse(executed[12]?.args?.[0]?.replace("operation-json=", "") ?? "{}").resource.table, "posts")
const phaseWorkload = JSON.parse(executed[13]?.args?.[0]?.replace("workload-json=", "") ?? "{}")
assert.equal(phaseWorkload.schema, "wp-codebox/wordpress-workload-run/v1")
assert.equal(phaseWorkload.steps.length, 3)
assert.deepEqual(phaseWorkload.steps.map((step: { command: string; phase: string }) => [step.phase, step.command]), [["setup", "wordpress.ensure-plugin-active"], ["action", "wordpress.fuzz-admin-pages"], ["assert", "wordpress.collect-workload-result"]])
assert.equal(result.cases[0]?.status, "passed")
assert.equal(result.cases[0]?.artifactRefs?.[0]?.path, "/artifacts/exec-1.json")
assert.equal(result.cases[1]?.status, "failed")
assert.equal(result.cases[1]?.diagnostics[0]?.code, "fuzz_suite_command_failed")
assert.equal(result.cases[14]?.status, "skipped")
assert.equal(result.cases[14]?.skipReason, "fuzz_suite_target_adapter_unsupported")
assert.equal(result.cases[14]?.diagnostics[0]?.code, "fuzz_suite_target_adapter_unsupported")
assert.equal(result.artifactRefs.length, 14)
assert.equal((result.cases[0]?.metadata?.replay as Record<string, unknown> | undefined)?.caseId, "case-pass")
assert.deepEqual(result.cases[0]?.metadata?.timing, { startedAt: "2026-01-01T00:00:01.000Z", finishedAt: "2026-01-01T00:00:02.000Z", durationMs: 1000 })
assert.equal(RUNTIME_BACKED_FUZZ_SUITE_RUNNER_CAPABILITIES.capabilities.includes("db_operation"), true)
assert.equal(RUNTIME_BACKED_FUZZ_SUITE_RUNNER_CAPABILITIES.runtimeActionTypes?.includes("db_operation"), true)
assert.equal(RUNTIME_BACKED_FUZZ_SUITE_RUNNER_CAPABILITIES.runtimeActionTypes?.includes("random_walk"), true)
assert.equal(RUNTIME_BACKED_FUZZ_SUITE_RUNNER_CAPABILITIES.runtimeActionTypes?.includes("sequence"), true)
assert.equal(RUNTIME_BACKED_FUZZ_SUITE_RUNNER_CAPABILITIES.commands?.includes("wordpress.db-operation"), true)
assert.equal(RUNTIME_BACKED_FUZZ_SUITE_RUNNER_CAPABILITIES.commands?.includes("wordpress.fuzz-admin-pages"), true)
assert.equal(RUNTIME_BACKED_FUZZ_SUITE_RUNNER_CAPABILITIES.commands?.includes("wordpress.collect-workload-result"), true)

const phaseWorkloadSpecs: ExecutionSpec[] = []
const phaseWorkloadResult = await runFuzzSuite(fuzzSuiteContract({
  id: "suite-phase-workload",
  cases: [{
    id: "phase-case",
    target: { kind: "runtime", id: "wordpress.run-workload", entrypoint: "wordpress.run-workload" },
    input: { runtimeEnv: { EXAMPLE: "1" }, stagedFiles: [{ source: "bench/example.php", target: "/tmp/wp-codebox-workloads/example.php" }] },
    phases: {
      setup: [{ command: "wordpress.wp-cli", args: ["command=plugin list"], timeoutMs: 1000 }],
      action: [{ command: "wordpress.run-workload", args: ["type=php", "path=${package.root}/bench/example.php"] }],
      assert: [{ command: "wordpress.rest-request", args: ["path=/wp/v2/types", "method=GET"] }],
      teardown: [{ command: "wordpress.wp-cli", args: ["command=cache flush"], advisory: true }],
    },
  }],
}), {
  executor: async (spec) => {
    phaseWorkloadSpecs.push(spec)
    return { id: "phase-exec", command: spec.command, args: spec.args ?? [], exitCode: 0, stdout: "ok", stderr: "", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z" }
  },
})
assert.equal(phaseWorkloadResult.status, "passed")
assert.deepEqual(phaseWorkloadSpecs.map((spec) => spec.command), ["wordpress.run-workload"])
const loweredPhaseWorkload = JSON.parse(phaseWorkloadSpecs[0]?.args?.[0]?.replace("workload-json=", "") ?? "{}")
assert.deepEqual(loweredPhaseWorkload.steps.map((step: { phase: string; command: string }) => [step.phase, step.command]), [["setup", "wordpress.wp-cli"], ["action", "wordpress.run-workload"], ["assert", "wordpress.rest-request"], ["teardown", "wordpress.wp-cli"]])
assert.deepEqual(loweredPhaseWorkload.runtimeEnv, { EXAMPLE: "1" })
assert.equal(loweredPhaseWorkload.stagedFiles[0].target, "/tmp/wp-codebox-workloads/example.php")
assert.equal(loweredPhaseWorkload.steps[1].args[1], "path=${package.root}/bench/example.php")
assert.deepEqual(loweredPhaseWorkload.metadata.phaseCounts, { setup: 1, action: 1, assert: 1, teardown: 1 })

const invalidPhaseWorkload = await runFuzzSuite(fuzzSuiteContract({
  id: "suite-invalid-phase-workload",
  cases: [{ id: "bad-phase", target: { kind: "runtime", id: "wordpress.run-workload" }, phases: { action: [{ command: "", args: ["path=/"] }] } }],
}), { executor: async () => { throw new Error("invalid phase workload must not execute") } })
assert.equal(invalidPhaseWorkload.status, "skipped")
assert.equal(invalidPhaseWorkload.cases[0]?.diagnostics[0]?.code, "fuzz_suite_input_unsupported")
assert.match(invalidPhaseWorkload.cases[0]?.diagnostics[0]?.message ?? "", /phases\.action\[0\] requires a non-empty command/)

const plannedWalkA = planBrowserRandomWalk({ context: "editor", seed: "same", max_steps: 5, action_families: ["click", "fill", "capture"] })
const plannedWalkB = planBrowserRandomWalk({ context: "editor", seed: "same", max_steps: 5, action_families: ["click", "fill", "capture"] })
assert.deepEqual(plannedWalkA.steps, plannedWalkB.steps)
assert.equal(plannedWalkA.replay.seed, "same")
assert.equal(plannedWalkA.steps[0]?.kind, "navigate")

for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
  const blockedRestMutation = await runFuzzSuite(fuzzSuiteContract({
    id: `suite-rest-${method.toLowerCase()}-mutation-blocked`,
    cases: [{ id: `${method.toLowerCase()}-blocked`, target: { kind: "runtime-action" }, input: { type: "rest_request", method, path: "/wp/v2/posts/10" } }],
  }), { runtimeActionExecutor: async () => { throw new Error("must not execute") } })
  assert.equal(blockedRestMutation.status, "skipped")
  assert.equal(blockedRestMutation.cases[0]?.skipReason, "fuzz_suite_disposable_sandbox_boundary_required")
  assert.equal(blockedRestMutation.cases[0]?.diagnostics[0]?.metadata?.mutationSkipped, true)
}

for (const input of [
  { type: "wp_cli", command: "option update blogname changed" },
  { type: "php", code: "update_option('blogname', 'changed');" },
  { type: "browser", operation: "click", selector: "#submit" },
  { type: "crud_operation", operation: "update", resource: { kind: "post", id: 1 }, values: { title: "changed" } },
  { type: "db_operation", operation: "write", query: { table: "posts", values: { post_title: "changed" } }, options: { mutation: "insert", bounded: true } },
]) {
  const blockedMutation = await runFuzzSuite(fuzzSuiteContract({
    id: `suite-${input.type}-mutation-blocked`,
    cases: [{ id: `${input.type}-blocked`, target: { kind: "runtime-action" }, input }],
  }), { runtimeActionExecutor: async () => { throw new Error("must not execute") } })
  assert.equal(blockedMutation.status, "skipped")
  assert.equal(blockedMutation.cases[0]?.skipReason, "fuzz_suite_disposable_sandbox_boundary_required")
}

const allowedRestMutations: string[] = []
const restMutationOptIn = restMutationFixtureOptInContract({
  id: "delete-post-fixture",
  route: "/wp/v2/posts/10",
  methods: ["DELETE"],
  auth: { user: "fixture-user" },
  rollbackPolicy: { mode: "checkpoint-per-case", checkpointName: "rest-mutation-fixture" },
  fixturePlan: fuzzFixturePlanContract({
    id: "delete-post-fixture-plan",
    operations: [mutationFixtureSeedOperation({ id: "delete-post", method: "DELETE", target: "/wp/v2/posts/10", input: { body: { force: false } } })],
  }),
})
const allowedRestMutation = await runFuzzSuite(fuzzSuiteContract({
  id: "suite-rest-mutation-allowed",
  cases: [{ id: "delete-post", target: { kind: "runtime-action" }, input: { type: "rest_request", method: "DELETE", path: "/wp/v2/posts/10", restMutationFixtureOptIn: restMutationOptIn } }],
}), {
  runtimeActionExecutor: async ({ action }) => {
    allowedRestMutations.push(action.type)
    return { schema: "wp-codebox/runtime-action-observation/v1", type: action.type, status: "ok", action, data: { method: "DELETE", path: "/wp/v2/posts/10", status: 200, deleteBoundaryArtifact: { schema: DELETE_BOUNDARY_ARTIFACT_SCHEMA, artifactKind: DELETE_BOUNDARY_ARTIFACT_KIND, operation: "rest_request", target: "/wp/v2/posts/10", method: "DELETE", status: 200, artifactPath: "files/delete-boundaries/delete-post.json", sha256: "delete", bytes: 123, generatedAt: "2026-01-01T00:00:00.000Z" } }, observedAt: "2026-01-01T00:00:00.000Z", digest: { algorithm: "sha256", value: "delete" } }
  },
})
assert.equal(allowedRestMutation.status, "passed")
assert.deepEqual(allowedRestMutations, ["rest_request"])
assert.equal(allowedRestMutation.cases[0]?.artifactRefs?.some((ref) => ref.kind === DELETE_BOUNDARY_ARTIFACT_KIND && ref.path === "files/delete-boundaries/delete-post.json"), undefined)
assert.equal((allowedRestMutation.cases[0]?.metadata?.deleteBoundary as Record<string, unknown> | undefined)?.artifactPath, "files/delete-boundaries/delete-post.json")
assert.deepEqual(allowedRestMutation.cases[0]?.diagnostics, [])

const resetGuardedRestMutationSpecs: ExecutionSpec[] = []
const resetGuardedRestMutation = await runFuzzSuite(fuzzSuiteContract({
  id: "suite-rest-mutation-reset-guarded",
  metadata: { disposableSandboxBoundary },
  resetPolicy: { mode: "checkpoint-per-case", checkpointName: "destructive-baseline" },
  mutation: { intent: "delete", destructive: true, intensity: "high" },
  cases: [{ id: "delete-post-reset-guarded", target: { kind: "rest", id: "/wp/v2/posts/10" }, input: { method: "DELETE", bodyJson: { force: true } }, mutation: { intent: "delete", destructive: true, intensity: "high" } }],
}), {
  resetExecutor: async ({ policy }) => ({ mode: policy.mode, status: "passed", checkpointName: policy.checkpointName }),
  executor: async (spec) => {
    resetGuardedRestMutationSpecs.push(spec)
    return { id: "exec-reset-guarded-delete", command: spec.command, args: spec.args ?? [], exitCode: 0, stdout: "ok", stderr: "", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:02.000Z" }
  },
})
assert.equal(resetGuardedRestMutation.status, "passed")
assert.equal(resetGuardedRestMutation.cases[0]?.reset?.status, "passed")
assert.equal((resetGuardedRestMutation.cases[0]?.metadata?.adapter as Record<string, unknown> | undefined)?.resetPolicyAllowsMutation, true)
assert.deepEqual(resetGuardedRestMutationSpecs[0], { command: "wordpress.rest-request", args: ["path=/wp/v2/posts/10", "method=DELETE", "body-json={\"force\":true}"], method: "DELETE", path: "/wp/v2/posts/10" })
assert.deepEqual(resetGuardedRestMutation.cases[0]?.metadata?.timing, { startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:02.000Z", durationMs: 2000 })
assert.deepEqual((resetGuardedRestMutation.coveragePlan?.generated[0]?.metadata as { mutation?: unknown } | undefined)?.mutation, { intent: "delete", destructive: true, intensity: "high" })

const resetGuardedRuntimeActionMutation = await runFuzzSuite(fuzzSuiteContract({
  id: "suite-runtime-action-mutation-reset-guarded",
  metadata: { disposableSandboxBoundary },
  resetPolicy: { mode: "checkpoint-per-case", checkpointName: "runtime-action-destructive-baseline" },
  cases: [{ id: "delete-post-runtime-action-reset-guarded", target: { kind: "runtime-action" }, input: { type: "rest_request", method: "DELETE", path: "/wp/v2/posts/10" } }],
}), {
  resetExecutor: async ({ policy }) => ({ mode: policy.mode, status: "passed", checkpointName: policy.checkpointName }),
  runtimeActionExecutor: async ({ action }) => ({ schema: "wp-codebox/runtime-action-observation/v1", type: action.type, status: "ok", action, data: { method: "DELETE", path: "/wp/v2/posts/10", status: 200, deleteBoundaryArtifact: { schema: DELETE_BOUNDARY_ARTIFACT_SCHEMA, artifactKind: DELETE_BOUNDARY_ARTIFACT_KIND, operation: "rest_request", target: "/wp/v2/posts/10", method: "DELETE", status: 200, generatedAt: "2026-01-01T00:00:00.000Z", restore: { status: "passed", exitCode: 0 }, rollback: passingRollbackArtifact("rest_request", "/wp/v2/posts/10") } }, observedAt: "2026-01-01T00:00:00.000Z", digest: { algorithm: "sha256", value: "delete-reset-guarded" } }),
})
assert.equal(resetGuardedRuntimeActionMutation.status, "passed")
assert.equal((resetGuardedRuntimeActionMutation.cases[0]?.metadata?.adapter as Record<string, unknown> | undefined)?.resetPolicyAllowsMutation, true)

for (const method of ["POST", "PUT", "PATCH"] as const) {
  const fixtureOptIn = restMutationFixtureOptInContract({
    id: `${method.toLowerCase()}-fixture`,
    route: "/example/v1/entities/1",
    methods: [method],
    auth: { session: "fixture-session" },
    rollbackPolicy: { mode: "checkpoint-per-case", checkpointName: `${method.toLowerCase()}-fixture` },
    fixturePlan: fuzzFixturePlanContract({
      id: `${method.toLowerCase()}-fixture-plan`,
      operations: [mutationFixtureSeedOperation({ id: `${method.toLowerCase()}-entity`, method, target: "/example/v1/entities/1", input: { body: { name: "fixture" } } })],
    }),
  })
  const mutationResult = await runFuzzSuite(fuzzSuiteContract({
    id: `suite-rest-${method.toLowerCase()}-mutation`,
    cases: [{ id: `${method.toLowerCase()}-entity`, target: { kind: "runtime-action" }, input: { type: "rest_request", method, path: "/example/v1/entities/1", bodyJson: { name: "fixture" }, restMutationFixtureOptIn: fixtureOptIn } }],
  }), {
    runtimeActionExecutor: async ({ action, case: fuzzCase }) => ({ schema: "wp-codebox/runtime-action-observation/v1", type: action.type, status: "ok", action, data: { method, path: "/example/v1/entities/1", status: method === "POST" ? 201 : 200, mutationIsolationArtifact: { schema: MUTATION_ISOLATION_ARTIFACT_SCHEMA, artifactKind: MUTATION_ISOLATION_ARTIFACT_KIND, operation: "rest_request", target: "/example/v1/entities/1", method, status: method === "POST" ? 201 : 200, artifactPath: `files/mutation-isolation/${fuzzCase.id}.json`, sha256: method.toLowerCase(), bytes: 123, generatedAt: "2026-01-01T00:00:00.000Z", restore: { status: "passed", exitCode: 0 }, rollback: passingRollbackArtifact("rest_request", "/example/v1/entities/1") } }, observedAt: "2026-01-01T00:00:00.000Z", digest: { algorithm: "sha256", value: method } }),
  })
  assert.equal(mutationResult.status, "passed")
  assert.equal((mutationResult.cases[0]?.metadata?.adapter as Record<string, unknown> | undefined)?.executorKind, "episode")
  assert.equal(mutationResult.cases[0]?.artifactRefs?.some((ref) => ref.kind === MUTATION_ISOLATION_ARTIFACT_KIND && ref.path === `files/mutation-isolation/${method.toLowerCase()}-entity.json`), undefined)
  assert.equal((mutationResult.cases[0]?.metadata?.mutationIsolation as Record<string, unknown> | undefined)?.artifactPath, `files/mutation-isolation/${method.toLowerCase()}-entity.json`)
}

const failingRuntimeAction = await runFuzzSuite(fuzzSuiteContract({
  id: "suite-runtime-action-failure",
  target: { kind: "runtime-action" },
  cases: [{ id: "browser-fails", input: { type: "browser", operation: "capture" } }],
}), {
  runtimeActionExecutor: async ({ action }) => ({ schema: "wp-codebox/runtime-action-observation/v1", type: action.type, status: "ok", action, data: {}, observedAt: "2026-01-01T00:00:00.000Z", step: { id: "step-failed", index: 0, action: { schema: "wp-codebox/runtime-episode-action/v1", id: "action-failed", kind: "command", command: "wordpress.browser-actions", args: [], digest: { algorithm: "sha256", value: "action" } }, actionRef: { kind: "action", id: "action-failed" }, execution: { id: "exec-failed", command: "wordpress.browser-actions", args: [], exitCode: 2, stdout: "", stderr: "browser failed", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z" }, executionRef: { kind: "execution", id: "exec-failed" } }, digest: { algorithm: "sha256", value: "failed" } }),
})
assert.equal(failingRuntimeAction.status, "failed")
assert.equal(failingRuntimeAction.cases[0]?.diagnostics[0]?.code, "fuzz_suite_runtime_action_failed")

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
  target: { kind: "runtime", entrypoint: "wordpress.simulated-admin-page-load" },
  cases: [{ id: "admin-page", input: { args: ["path=plugins.php"] } }],
  metadata: { requiredRunnerCapabilities: { capabilities: ["target:runtime", "runtime"], targetKinds: ["runtime"], commands: ["wordpress.simulated-admin-page-load"] } },
}), {
  requireCoverage: true,
  runnerCapabilities: PHP_IN_PROCESS_FUZZ_SUITE_RUNNER_CAPABILITIES,
})
assert.equal(requiredRuntimeOnPhpRunner.status, "error")
assert.equal(requiredRuntimeOnPhpRunner.success, false)
assert.equal(requiredRuntimeOnPhpRunner.diagnostics[0]?.code, "fuzz_suite_required_runner_capabilities_unsupported")
assert.equal(requiredRuntimeOnPhpRunner.cases[0]?.skipReason, "fuzz_suite_required_runner_capabilities_unsupported")
assert.deepEqual((requiredRuntimeOnPhpRunner.metadata?.runnerCapabilities as { unsupportedRequiredCapabilities?: string[] } | undefined)?.unsupportedRequiredCapabilities, ["target:runtime", "runtime", "command:wordpress.simulated-admin-page-load"])

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

const sequenceWithoutExecutor = await runFuzzSuite(fuzzSuiteContract({
  id: "suite-sequence-without-executor",
  target: { kind: "runtime-action" },
  cases: [{ id: "sequence", input: { type: "sequence", seed: "seq-1", max_steps: 2, action_families: ["read"], steps: [{ type: "rest_request", method: "GET", path: "/wp/v2/types" }] } }],
}))
assert.equal(sequenceWithoutExecutor.status, "skipped")
assert.equal(sequenceWithoutExecutor.cases[0]?.skipReason, "fuzz_suite_input_unsupported")
assert.equal(sequenceWithoutExecutor.cases[0]?.diagnostics[0]?.metadata?.executorRequired, "runtimeActionExecutor")

const mutatingSequenceWithoutReset = await runFuzzSuite(fuzzSuiteContract({
  id: "suite-mutating-sequence-without-reset",
  target: { kind: "runtime-action" },
  cases: [{ id: "sequence-mutation", input: { type: "sequence", seed: "seq-mutate", maxSteps: 2, actionFamilies: ["rest", "db"], steps: [{ type: "rest_request", method: "GET", path: "/wp/v2/types" }, { type: "db_operation", operation: "write", query: { table: "demo", values: { name: "sample" } }, options: { mutation: "insert", bounded: true } }] } }],
}), { runtimeActionExecutor: async () => { throw new Error("must not execute without reset") } })
assert.equal(mutatingSequenceWithoutReset.status, "skipped")
assert.equal(mutatingSequenceWithoutReset.cases[0]?.skipReason, "fuzz_suite_disposable_sandbox_boundary_required")

const sequenceSteps: string[] = []
const mutatingSequenceWithReset = await runFuzzSuite(fuzzSuiteContract({
  id: "suite-mutating-sequence-with-reset",
  metadata: { disposableSandboxBoundary },
  resetPolicy: { mode: "checkpoint-per-case", checkpointName: "sequence-baseline" },
  target: { kind: "runtime-action" },
  cases: [{ id: "sequence-mutation", input: { type: "sequence", seed: "seq-mutate", maxSteps: 3, actionFamilies: ["rest", "db"], steps: [{ type: "rest_request", method: "GET", path: "/wp/v2/types" }, { type: "db_operation", operation: "write", query: { table: "demo", values: { name: "sample" } }, options: { mutation: "insert", bounded: true } }] } }],
}), {
  resetExecutor: async ({ policy }) => ({ mode: policy.mode, status: "passed", checkpointName: policy.checkpointName }),
  runtimeActionExecutor: async ({ action }) => {
    sequenceSteps.push(action.type)
    return { schema: "wp-codebox/runtime-action-observation/v1", type: action.type, status: "ok", action, data: { actionType: action.type }, observedAt: "2026-01-01T00:00:00.000Z", artifactRefs: [{ kind: "runtime-action", id: `${action.type}-artifact`, path: `files/sequence-${action.type}.json` }], digest: { algorithm: "sha256", value: `seq-${action.type}` } }
  },
})
assert.equal(mutatingSequenceWithReset.status, "passed")
assert.deepEqual(sequenceSteps, ["rest_request", "db_operation"])
assert.deepEqual(mutatingSequenceWithReset.cases[0]?.diagnostics, [])
assert.equal((mutatingSequenceWithReset.cases[0]?.metadata?.adapter as Record<string, unknown> | undefined)?.actionType, "sequence")
assert.equal((mutatingSequenceWithReset.cases[0]?.metadata?.adapter as Record<string, unknown> | undefined)?.steps, 2)
assert.deepEqual((mutatingSequenceWithReset.cases[0]?.metadata?.replay as { sequence?: { seed?: string; maxSteps?: number; actionFamilies?: string[] } } | undefined)?.sequence, { schema: "wp-codebox/runtime-action-sequence/v1", seed: "seq-mutate", maxSteps: 3, actionFamilies: ["rest", "db"], steps: [{ type: "rest_request", method: "GET", path: "/wp/v2/types" }, { type: "db_operation", operation: "write", query: { table: "demo", values: { name: "sample" } }, options: { mutation: "insert", bounded: true } }] })
assert.equal(mutatingSequenceWithReset.artifactRefs.length, 2)

const sequenceFailure = await runFuzzSuite(fuzzSuiteContract({
  id: "suite-sequence-step-failure",
  metadata: { disposableSandboxBoundary },
  resetPolicy: { mode: "checkpoint-per-case", checkpointName: "sequence-failure-baseline" },
  target: { kind: "runtime-action" },
  cases: [{ id: "sequence-fails", input: { type: "sequence", steps: [{ type: "rest_request", method: "GET", path: "/wp/v2/types" }, { type: "browser", operation: "click", selector: "#missing" }] } }],
}), {
  resetExecutor: async ({ policy }) => ({ mode: policy.mode, status: "passed", checkpointName: policy.checkpointName }),
  runtimeActionExecutor: async ({ action }) => ({ schema: "wp-codebox/runtime-action-observation/v1", type: action.type, status: "ok", action, data: {}, observedAt: "2026-01-01T00:00:00.000Z", step: { id: `step-${action.type}`, index: 0, action: { schema: "wp-codebox/runtime-episode-action/v1", id: `action-${action.type}`, kind: "command", command: action.type === "browser" ? "wordpress.browser-actions" : "wordpress.rest-request", args: [], digest: { algorithm: "sha256", value: action.type } }, actionRef: { kind: "action", id: `action-${action.type}` }, execution: { id: `exec-${action.type}`, command: action.type === "browser" ? "wordpress.browser-actions" : "wordpress.rest-request", args: [], exitCode: action.type === "browser" ? 1 : 0, stdout: "", stderr: action.type === "browser" ? "missing selector" : "", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z" }, executionRef: { kind: "execution", id: `exec-${action.type}` } }, digest: { algorithm: "sha256", value: action.type } }),
})
assert.equal(sequenceFailure.status, "failed")
assert.equal(sequenceFailure.cases[0]?.diagnostics[0]?.code, "fuzz_suite_runtime_action_failed")
assert.equal(sequenceFailure.cases[0]?.diagnostics[0]?.metadata?.stepIndex, 1)

let dbWriteOperation: Record<string, unknown> | undefined
const commandBackedDbWrite = await runFuzzSuite(fuzzSuiteContract({
  id: "suite-db-write-reset-command-backed",
  metadata: { disposableSandboxBoundary },
  resetPolicy: { mode: "checkpoint-per-case", checkpointName: "db-baseline" },
  target: { kind: "runtime-action" },
  cases: [{ id: "db-write", input: { type: "db_operation", operation: "write", query: { table: "options", where: { option_name: "missing" }, values: { option_value: "fuzz" }, limit: 1 }, options: { mutation: "update" } } }],
}), {
  resetExecutor: async ({ policy }) => ({ mode: policy.mode, status: "passed", checkpointName: policy.checkpointName }),
  executor: async (spec) => {
    dbWriteOperation = JSON.parse(spec.args?.[0]?.replace("operation-json=", "") ?? "{}")
    return { id: "exec-db-write", command: spec.command, args: spec.args ?? [], exitCode: 0, stdout: JSON.stringify({ schema: "wp-codebox/wordpress-db-result/v1", status: "ok", metadata: { affectedRows: 0, affectedRowsMayBeZeroOrUnknown: true } }), stderr: "", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z" }
  },
})
assert.equal(commandBackedDbWrite.status, "passed")
assert.equal(commandBackedDbWrite.cases[0]?.target?.kind, "runtime-action")
assert.equal(dbWriteOperation?.operation, "write")
assert.deepEqual((dbWriteOperation?.options as Record<string, unknown> | undefined)?.destructivePermission, true)
assert.deepEqual(((dbWriteOperation?.metadata as Record<string, unknown> | undefined)?.disposableSandboxBoundary as Record<string, unknown> | undefined)?.destructivePermission, true)
assert.deepEqual((dbWriteOperation?.metadata as Record<string, unknown> | undefined)?.affectedRowsMayBeZeroOrUnknown, true)

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

function passingRollbackArtifact(operation: string, target: string): Record<string, unknown> {
  return {
    schema: "wp-codebox/wordpress-rollback-artifact/v1",
    artifactKind: "wordpress-rollback",
    operation,
    target,
    lifecycle: { before: { status: "captured" }, after: { status: "captured" }, restore: { status: "restored" } },
    result: { status: "passed", restored: true, validation: "matched-before" },
    diff: { objects: [{ kind: "post", id: 10, changed: true, restoreMatchesBefore: true }] },
    changedObjects: [{ kind: "post", id: 10, source: "rollback-diff" }],
    generatedAt: "2026-01-01T00:00:00.000Z",
  }
}

console.log("fuzz suite runner ok")
