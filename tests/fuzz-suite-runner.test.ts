import assert from "node:assert/strict"

import { fuzzSuiteContract, planFuzzSuiteCaseExecutionSpec, runFuzzSuite, runWordPressRestMatrix, wordpressRestMatrixContract, wordpressRestMatrixToFuzzSuite, type ExecutionResult, type ExecutionSpec } from "../packages/runtime-core/src/index.js"

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
assert.deepEqual(result.summary, { total: 11, passed: 9, failed: 1, error: 0, skipped: 1 })
assert.deepEqual(result.coverageSummary, {
  discovered: 11,
  generated: 11,
  executed: 10,
  skipped: 1,
  untested: 0,
  skippedReasons: [{ reason: "fuzz_suite_target_adapter_unsupported", count: 1, caseIds: ["case-runtime-action-unsupported"] }],
})
assert.deepEqual(executed.map((spec) => spec.command), ["inspect-mounted-inputs", "wordpress.run-php", "wordpress.http-request", "wordpress.rest-request", "wordpress.ability", "wordpress.rest-request", "wordpress.browser-actions", "wordpress.admin-page-load", "wordpress.frontend-page-load", "wordpress.editor-open"])
assert.deepEqual(executed[0], { command: "inspect-mounted-inputs", args: ["--json"], cwd: "/workspace", timeoutMs: 1000 })
assert.deepEqual(executed[2], { command: "wordpress.http-request", args: ["url=/", "method=GET", "expect-status=200"], method: "GET", path: "/" })
assert.deepEqual(executed[3], { command: "wordpress.rest-request", args: ["path=/wp/v2/types", "method=GET", "params-json={\"context\":\"view\"}"], method: "GET", path: "/wp/v2/types" })
assert.deepEqual(executed[4], { command: "wordpress.ability", args: ["name=example/echo", "input={\"message\":\"hello\"}", "expected-result-schema=example/result"] })
assert.deepEqual(executed[5], { command: "wordpress.rest-request", args: ["path=/wp/v2/status", "method=GET"], method: "GET", path: "/wp/v2/status" })
assert.deepEqual(executed[6], { command: "wordpress.browser-actions", args: ['steps-json=[{"kind":"navigate","url":"/sample-page/"}]', "capture=console,screenshot"] })
assert.deepEqual(executed[7], { command: "wordpress.admin-page-load", args: ["path=plugins.php", "capture-diagnostics=php-notices"] })
assert.deepEqual(executed[8], { command: "wordpress.frontend-page-load", args: ["path=/sample-page/", "query-json={\"preview\":true}"] })
assert.deepEqual(executed[9], { command: "wordpress.editor-open", args: ["target=post-new", "post-type=page", "capture=editor-state"] })
assert.equal(result.cases[0]?.status, "passed")
assert.equal(result.cases[0]?.artifactRefs?.[0]?.path, "/artifacts/exec-1.json")
assert.equal(result.cases[1]?.status, "failed")
assert.equal(result.cases[1]?.diagnostics[0]?.code, "fuzz_suite_command_failed")
assert.equal(result.cases[10]?.status, "skipped")
assert.equal(result.cases[10]?.skipReason, "fuzz_suite_target_adapter_unsupported")
assert.equal(result.cases[10]?.diagnostics[0]?.code, "fuzz_suite_target_adapter_unsupported")
assert.equal(result.artifactRefs.length, 10)
assert.equal((result.cases[0]?.metadata?.replay as Record<string, unknown> | undefined)?.caseId, "case-pass")

const plannedEditor = planFuzzSuiteCaseExecutionSpec({
  suite: fuzzSuiteContract({ id: "planner", cases: [] }),
  case: { id: "editor", target: { kind: "runtime-action" }, input: { type: "editor_open", target: "site" } },
  caseIndex: 0,
})
assert.equal(plannedEditor.status, "supported")
assert.deepEqual(plannedEditor.spec, { command: "wordpress.editor-open", args: ["target=site"] })
assert.equal(plannedEditor.replayMetadata.caseId, "editor")

const noExecutor = await runFuzzSuite(fuzzSuiteContract({
  id: "suite-002",
  target: { kind: "command", id: "inspect-mounted-inputs" },
  cases: [{ id: "case-skipped" }],
}))
assert.equal(noExecutor.status, "skipped")
assert.deepEqual(noExecutor.coverageSummary?.skippedReasons, [{ reason: "fuzz_suite_executor_unavailable", count: 1, caseIds: ["case-skipped"] }])
assert.equal(noExecutor.cases[0]?.diagnostics[0]?.code, "fuzz_suite_executor_unavailable")

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
