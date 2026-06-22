import assert from "node:assert/strict"

import { executeFanoutRequest, FANOUT_REQUEST_SCHEMA, type RunPlanWorkerAdapter } from "../packages/runtime-core/src/index.js"

const successfulAdapter: RunPlanWorkerAdapter = {
  async run({ descriptor }) {
    return {
      workerId: descriptor.id,
      success: true,
      status: "succeeded",
      resultRef: `workers/${descriptor.id}/result.json`,
      evidence_refs: [
        { path: `workers/${descriptor.id}/evidence.json`, kind: "worker-evidence", finalPath: `evidence/${descriptor.id}.json` },
      ],
      metadata: { arbitrary_worker: true },
    }
  },
}

const success = await executeFanoutRequest({
  schema: FANOUT_REQUEST_SCHEMA,
  concurrency: 3,
  orchestrator: { session_id: "generic-success" },
  workers: [
    { id: "alpha", goal: "Run alpha" },
    { id: "beta", goal: "Run beta", dependsOn: ["alpha"] },
  ],
}, {
  adapter: successfulAdapter,
  requireGoal: true,
  maxConcurrency: 2,
  finalArtifactRefs: [{ path: "aggregate/result.json", kind: "generic-fanout-result" }],
})

assert.equal(success.schema, "wp-codebox/agent-fanout-result/v1")
assert.equal(success.success, true)
assert.equal(success.status, "completed")
assert.equal(success.concurrency, 2)
assert.deepEqual(success.counts, { total: 2, completed: 2, failed: 0, skipped: 0, cancelled: 0, timed_out: 0 })
assert.deepEqual(success.workerResultRefs.map((worker) => worker.workerId), ["alpha", "beta"])
assert.deepEqual(success.aggregate.rawWorkerArtifactRefs.map((ref) => ref.path), ["workers/alpha/evidence.json", "workers/beta/evidence.json"])
assert.deepEqual(success.aggregate.finalArtifactRefs, [{ path: "aggregate/result.json", kind: "generic-fanout-result" }])
assert.equal(success.aggregate.status, "succeeded")

const events: string[] = []
const failingAdapter: RunPlanWorkerAdapter = {
  async run({ descriptor }) {
    events.push(`run:${descriptor.id}`)
    return {
      workerId: descriptor.id,
      success: false,
      status: "failed",
      error: { code: "worker-failed", message: `${descriptor.id} failed` },
      artifactRefs: [{ path: `workers/${descriptor.id}/failure.json`, kind: "failure-evidence" }],
    }
  },
}

const failure = await executeFanoutRequest({
  schema: FANOUT_REQUEST_SCHEMA,
  concurrency: 2,
  orchestrator: { session_id: "generic-failure" },
  workers: [
    { id: "failed", goal: "Fail" },
    { id: "dependent", goal: "Skip", dependsOn: ["failed"] },
  ],
}, {
  adapter: failingAdapter,
  requireGoal: true,
  createSkippedResult: (descriptor, dependencies) => ({
    workerId: descriptor.id,
    success: false,
    status: "skipped",
    error: { code: "dependency-skipped", message: `${descriptor.id} skipped after ${dependencies.map((dependency) => dependency.workerId).join(", ")}` },
  }),
  onWorkerSkipped: (descriptor) => events.push(`skip:${descriptor.id}`),
})

assert.equal(failure.success, false)
assert.equal(failure.status, "failed")
assert.deepEqual(failure.counts, { total: 2, completed: 0, failed: 1, skipped: 1, cancelled: 0, timed_out: 0 })
assert.deepEqual(events, ["run:failed", "skip:dependent"])
assert.deepEqual(failure.workerResultRefs.map((worker) => worker.status), ["failed", "skipped"])
assert.deepEqual(failure.aggregate.rawWorkerArtifactRefs.map((ref) => ref.path), ["workers/failed/failure.json"])
assert.deepEqual(failure.aggregate.finalArtifactRefs, [])
assert.deepEqual(failure.aggregate.conflicts.map((conflict) => conflict.type), ["failed-worker", "failed-worker", "failed-worker-dependency"])

console.log("fanout execution ok")
