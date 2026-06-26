import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import vm from "node:vm"

import { aggregateFanoutOutputs, fanoutAggregationInputFromWorkerArtifacts, validateFanoutAggregationOutput } from "../packages/runtime-core/src/index.js"
import { executeAgentFanoutRequest } from "../packages/cli/src/agent-fanout.js"
import { FANOUT_REQUEST_SCHEMA } from "../packages/runtime-core/src/index.js"
import { withTempDir } from "../scripts/test-kit.js"

const root = new URL("../", import.meta.url)
const fixture = JSON.parse(await readFile(new URL("fixtures/fanout-aggregation-contract.json", import.meta.url), "utf8"))
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const runtimeOutput = plain(aggregateFanoutOutputs(fixture.input))
assert.deepEqual(plain(validateFanoutAggregationOutput(runtimeOutput)), fixture.expectedOutput, "canonical fanout output fixture must validate")
assert.deepEqual(runtimeOutput, fixture.expectedOutput, "runtime-core aggregation output must match the canonical fixture")
assert.throws(() => validateFanoutAggregationOutput({ ...runtimeOutput, workerResultRefs: undefined }), /workerResultRefs/, "canonical fanout output requires worker result refs")
assert.throws(() => validateFanoutAggregationOutput({ ...runtimeOutput, rawWorkerArtifactRefs: [{ kind: "worker-report" }] }), /requires path/, "canonical fanout output requires artifact ref paths")

const normalizedFromArtifacts = plain(fanoutAggregationInputFromWorkerArtifacts({
  plan: fixture.input.plan,
  policy: fixture.input.policy,
  aggregator: fixture.input.aggregation,
  workerResultRefs: fixture.input.worker_results,
}))
assert.equal(normalizedFromArtifacts.schema, "wp-codebox/agent-fanout-aggregation-input/v1")
assert.deepEqual(plain(aggregateFanoutOutputs(normalizedFromArtifacts)), fixture.expectedOutput, "worker artifact refs must normalize into the same aggregation output")

const runtimeSource = await readFile(new URL("packages/wordpress-plugin/assets/browser-runtime.js", root), "utf8")
const sandbox = {
  window: {} as { wpCodeboxBrowser?: { v1?: { aggregateFanoutOutputs?: (input: unknown) => unknown } } },
  btoa: (value: string) => Buffer.from(value, "binary").toString("base64"),
  TextDecoder,
  TextEncoder,
  URL,
}
vm.runInNewContext(runtimeSource, sandbox, { filename: "browser-runtime.js" })
const browserAggregate = sandbox.window.wpCodeboxBrowser?.v1?.aggregateFanoutOutputs
assert.equal(typeof browserAggregate, "function", "browser runtime must expose the aggregation contract helper")
assert.deepEqual(plain(browserAggregate?.(fixture.input)), fixture.expectedOutput, "WordPress browser runtime aggregation output must match runtime-core")

await withTempDir("wp-codebox-fanout-aggregation-parity-", async (artifactRoot) => {
  const result = await executeAgentFanoutRequest({
    schema: FANOUT_REQUEST_SCHEMA,
    concurrency: 2,
    orchestrator: { session_id: "fanout-contract-fixture" },
    aggregation: fixture.input.aggregation,
    workers: [
      { id: "alpha", goal: "Collect alpha result" },
      { id: "beta", goal: "Collect beta result", dependsOn: ["alpha"] },
    ],
  }, {
    artifactRoot,
    recipeDirectory: artifactRoot,
    runWorker: async (input) => ({
      success: true,
      status: "completed",
      evidence_refs: [{ path: `${input.artifacts_path}/report.json`, kind: "worker-report" }],
    }),
  })

  assert.equal(result.aggregate.schema, "wp-codebox/agent-fanout-aggregation-output/v1")
  assert.equal(result.aggregate.status, "succeeded")
  assert.deepEqual(result.aggregate.workerResultRefs.map((worker) => worker.status), ["succeeded", "succeeded"])
  assert.equal(result.aggregate.rawWorkerArtifactRefs.length, 2)
  assert.deepEqual(result.aggregate.finalArtifactRefs, [{ path: "aggregate/final/result.json", kind: "fanout-aggregate-output", namespace: "aggregate/final", contentType: "application/json" }])
})

console.log("fanout aggregation contract parity ok")
