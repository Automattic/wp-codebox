import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

import { executeFanoutRequest, FANOUT_REQUEST_SCHEMA, validateFanoutResultContract, type RunPlanWorkerAdapter } from "../packages/runtime-core/src/index.js"

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
assert.equal(success.fanout_id, "generic-success")
assert.equal(success.plan.fanout_id, "generic-success")
assert.equal(success.aggregate.plan.id, "generic-success")
assert.equal(success.concurrency, 2)
assert.deepEqual(success.counts, { total: 2, completed: 2, failed: 0, skipped: 0, cancelled: 0, timed_out: 0 })
assert.deepEqual(success.workerResultRefs.map((worker) => worker.workerId), ["alpha", "beta"])
assert.deepEqual(success.workerResultRefs.map((worker) => worker.resultRef), ["workers/alpha/result.json", "workers/beta/result.json"])
assert.deepEqual(success.workerResultRefs.map((worker) => worker.artifactRefs[0]?.path), ["workers/alpha/evidence.json", "workers/beta/evidence.json"])
assert.deepEqual(success.aggregate.rawWorkerArtifactRefs.map((ref) => ref.path), ["workers/alpha/evidence.json", "workers/beta/evidence.json"])
assert.deepEqual(success.aggregate.finalArtifactRefs, [{ path: "aggregate/result.json", kind: "generic-fanout-result" }])
assert.equal(success.aggregate.status, "succeeded")
assert.deepEqual(validateFanoutResultContract(success), { valid: true, issues: [] })
assert.equal(validateFanoutResultContract({ ...success, workerResultRefs: undefined, workers: success.workerResultRefs }).valid, false)

const fixture = JSON.parse(await readFile(new URL("./fixtures/fanout-result-worker-refs.json", import.meta.url), "utf8"))
assert.deepEqual(validateFanoutResultContract(fixture), { valid: true, issues: [] })
assert.equal(fixture.workerResultRefs[0].resultRef, "fanout/workers/planner/result.json")
assert.equal(fixture.workerResultRefs[0].artifactRefs[0].path, "fanout/workers/planner/result.json")

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
assert.deepEqual(failure.workers.map((worker) => worker.workerId), ["failed", "dependent"])
assert.deepEqual(failure.workers[1].error, { code: "dependency-skipped", message: "dependent skipped after failed" })
assert.deepEqual(failure.aggregate.rawWorkerArtifactRefs.map((ref) => ref.path), ["workers/failed/failure.json", "workers/failed/failure.json"])
assert.deepEqual(failure.workerResultRefs[1].artifactRefs.map((ref) => ref.path), ["workers/failed/failure.json"])
assert.equal(failure.workerResultRefs[1].artifactRefs[0].metadata?.preserved_for_skipped_worker, "dependent")
assert.deepEqual(failure.aggregate.finalArtifactRefs, [])
assert.deepEqual(failure.aggregate.conflicts.map((conflict) => conflict.type), ["failed-worker", "failed-worker", "failed-worker-dependency"])

const released: Array<() => void> = []
const orderedEvents: string[] = []
const ordered = await executeFanoutRequest({
  schema: FANOUT_REQUEST_SCHEMA,
  concurrency: 3,
  orchestrator: { session_id: "generic-ordered" },
  workers: [
    { id: "slow-root", goal: "Run slow root" },
    { id: "independent", goal: "Run independent worker" },
    { id: "after-root", goal: "Run after root", dependsOn: ["slow-root"] },
  ],
}, {
  adapter: {
    async run({ descriptor }) {
      orderedEvents.push(`run:${descriptor.id}`)
      if (descriptor.id === "slow-root") {
        await new Promise<void>((resolve) => released.push(resolve))
      }
      if (descriptor.id === "independent") {
        released.splice(0).forEach((release) => release())
      }
      orderedEvents.push(`done:${descriptor.id}`)
      return {
        workerId: descriptor.id,
        success: true,
        status: "succeeded",
        resultRef: `workers/${descriptor.id}/result.json`,
      }
    },
  },
  requireGoal: true,
  onWorkerStarted: (descriptor) => orderedEvents.push(`start:${descriptor.id}`),
  onWorkerCompleted: (descriptor) => orderedEvents.push(`complete:${descriptor.id}`),
})

assert.deepEqual(ordered.workers.map((worker) => worker.workerId), ["slow-root", "independent", "after-root"])
assert.deepEqual(ordered.counts, { total: 3, completed: 3, failed: 0, skipped: 0, cancelled: 0, timed_out: 0 })
assert.ok(orderedEvents.indexOf("start:after-root") > orderedEvents.indexOf("complete:slow-root"), "dependent worker must not start until its dependency completes")
assert.ok(orderedEvents.indexOf("start:independent") < orderedEvents.indexOf("complete:slow-root"), "independent worker should run while the dependency root is still active")

await assert.rejects(() => executeFanoutRequest({
  schema: FANOUT_REQUEST_SCHEMA,
  concurrency: 1,
  workers: [
    { id: "duplicate", goal: "One" },
    { id: "duplicate", goal: "Two" },
  ],
}, { adapter: successfulAdapter, requireGoal: true }), /worker ids must be unique/)

await assert.rejects(() => executeFanoutRequest({
  schema: FANOUT_REQUEST_SCHEMA,
  concurrency: 1,
  workers: [
    { id: "child", goal: "Child", dependsOn: ["missing"] },
  ],
}, { adapter: successfulAdapter, requireGoal: true }), /depends on unknown worker/)

console.log("fanout execution ok")
