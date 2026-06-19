import assert from "node:assert/strict"

import { executeRunPlan, type RunPlanWorkerAdapter } from "../packages/runtime-core/src/index.js"

const events: string[] = []
const adapter: RunPlanWorkerAdapter = {
  async run({ descriptor }) {
    return {
      workerId: descriptor.id,
      status: descriptor.id === "failed" ? "failed" : "succeeded",
      success: descriptor.id !== "failed",
      output: {
        goal: descriptor.goal,
        artifactNamespace: descriptor.artifactNamespace,
      },
    }
  },
}

const result = await executeRunPlan({
  concurrency: 10,
  workers: [
    { id: "one", goal: "Collect first result" },
    { id: "failed", goal: "Collect failed result", artifact_namespace: "custom/failed" },
    { id: "two", goal: "Collect second result" },
  ],
}, {
  adapter,
  maxConcurrency: 2,
  requireGoal: true,
  onWorkerStarted: (worker) => events.push(`started:${worker.id}`),
  onWorkerCompleted: (worker) => events.push(`completed:${worker.id}`),
  onWorkerFailed: (worker) => events.push(`failed:${worker.id}`),
})

assert.equal(result.success, false)
assert.equal(result.concurrency, 2)
assert.deepEqual(result.counts, { total: 3, completed: 2, failed: 1, cancelled: 0 })
assert.deepEqual(result.workers.map((worker) => worker.workerId), ["one", "failed", "two"])
assert.equal(result.workers[1].output?.artifactNamespace, "custom/failed")
assert.deepEqual(events, ["started:one", "started:failed", "completed:one", "failed:failed", "started:two", "completed:two"])

await assert.rejects(executeRunPlan({ concurrency: 1, workers: [{ id: "missing-goal" }] }, { adapter, requireGoal: true }), /requires goal/)
await assert.rejects(executeRunPlan({ concurrency: 1, workers: [{ id: "duplicate", goal: "one" }, { id: "duplicate", goal: "two" }] }, { adapter }), /must be unique/)

console.log("run plan executor ok")
