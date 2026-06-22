import assert from "node:assert/strict"

import { fuzzSuiteContract, runFuzzSuite, type ExecutionResult, type ExecutionSpec } from "../packages/runtime-core/src/index.js"

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
    { id: "case-runtime-action-unsupported", target: { kind: "runtime-action" }, input: { type: "browser", operation: "capture" } },
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
assert.deepEqual(result.summary, { total: 7, passed: 5, failed: 1, error: 0, skipped: 1 })
assert.deepEqual(executed.map((spec) => spec.command), ["inspect-mounted-inputs", "wordpress.run-php", "wordpress.http-request", "wordpress.rest-request", "wordpress.ability", "wordpress.rest-request"])
assert.deepEqual(executed[0], { command: "inspect-mounted-inputs", args: ["--json"], cwd: "/workspace", timeoutMs: 1000 })
assert.deepEqual(executed[2], { command: "wordpress.http-request", args: ["url=/", "method=GET", "expect-status=200"], method: "GET", path: "/" })
assert.deepEqual(executed[3], { command: "wordpress.rest-request", args: ["path=/wp/v2/types", "method=GET", "params-json={\"context\":\"view\"}"], method: "GET", path: "/wp/v2/types" })
assert.deepEqual(executed[4], { command: "wordpress.ability", args: ["name=example/echo", "input={\"message\":\"hello\"}", "expected-result-schema=example/result"] })
assert.deepEqual(executed[5], { command: "wordpress.rest-request", args: ["path=/wp/v2/status", "method=GET"], method: "GET", path: "/wp/v2/status" })
assert.equal(result.cases[0]?.status, "passed")
assert.equal(result.cases[0]?.artifactRefs?.[0]?.path, "/artifacts/exec-1.json")
assert.equal(result.cases[1]?.status, "failed")
assert.equal(result.cases[1]?.diagnostics[0]?.code, "fuzz_suite_command_failed")
assert.equal(result.cases[6]?.status, "skipped")
assert.equal(result.cases[6]?.diagnostics[0]?.code, "fuzz_suite_target_adapter_unsupported")
assert.equal(result.artifactRefs.length, 6)
assert.equal((result.cases[0]?.metadata?.replay as Record<string, unknown> | undefined)?.caseId, "case-pass")

const noExecutor = await runFuzzSuite(fuzzSuiteContract({
  id: "suite-002",
  target: { kind: "command", id: "inspect-mounted-inputs" },
  cases: [{ id: "case-skipped" }],
}))
assert.equal(noExecutor.status, "skipped")
assert.equal(noExecutor.cases[0]?.diagnostics[0]?.code, "fuzz_suite_executor_unavailable")

console.log("fuzz suite runner ok")
