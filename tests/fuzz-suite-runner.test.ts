import assert from "node:assert/strict"

import { fuzzSuiteContract, runFuzzSuite, runWordPressRestMatrix, wordpressRestMatrixContract, wordpressRestMatrixToFuzzSuite, type ExecutionResult, type ExecutionSpec } from "../packages/runtime-core/src/index.js"

const executed: ExecutionSpec[] = []
const result = await runFuzzSuite(fuzzSuiteContract({
  id: "suite-001",
  version: "2026-06-21",
  target: { kind: "command", id: "inspect-mounted-inputs" },
  cases: [
    { id: "case-pass", input: { args: ["--json"], cwd: "/workspace", timeoutMs: 1000 }, metadata: { source: "fixture" } },
    { id: "case-fail", target: { kind: "runtime", entrypoint: "wordpress.run-php" }, input: ["code=exit(1);"] },
    { id: "case-unsupported", target: { kind: "http", id: "GET /" }, input: { url: "/" } },
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
assert.deepEqual(result.summary, { total: 3, passed: 1, failed: 1, error: 0, skipped: 1 })
assert.deepEqual(executed.map((spec) => spec.command), ["inspect-mounted-inputs", "wordpress.run-php"])
assert.deepEqual(executed[0], { command: "inspect-mounted-inputs", args: ["--json"], cwd: "/workspace", timeoutMs: 1000 })
assert.equal(result.cases[0]?.status, "passed")
assert.equal(result.cases[0]?.artifactRefs?.[0]?.path, "/artifacts/exec-1.json")
assert.equal(result.cases[1]?.status, "failed")
assert.equal(result.cases[1]?.diagnostics[0]?.code, "fuzz_suite_command_failed")
assert.equal(result.cases[2]?.status, "skipped")
assert.equal(result.cases[2]?.diagnostics[0]?.code, "fuzz_suite_case_unsupported")
assert.equal(result.artifactRefs.length, 2)
assert.equal((result.cases[0]?.metadata?.replay as Record<string, unknown> | undefined)?.caseId, "case-pass")

const noExecutor = await runFuzzSuite(fuzzSuiteContract({
  id: "suite-002",
  target: { kind: "command", id: "inspect-mounted-inputs" },
  cases: [{ id: "case-skipped" }],
}))
assert.equal(noExecutor.status, "skipped")
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
