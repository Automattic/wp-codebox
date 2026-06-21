import assert from "node:assert/strict"

import { executeRunPlan, type RunPlanWorkerAdapter } from "../packages/runtime-core/src/index.js"

const events: string[] = []
const runs: string[] = []
const adapter: RunPlanWorkerAdapter = {
  async run({ descriptor }) {
    runs.push(descriptor.id)
    await new Promise((resolve) => setTimeout(resolve, descriptor.id === "one" ? 20 : 1))
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
    { id: "after-one", goal: "Collect dependent result", dependsOn: ["one"] },
    { id: "after-failed", goal: "Skip after failed result", depends_on: ["failed"] },
    { id: "after-skipped", goal: "Skip after skipped result", dependsOn: ["after-failed"] },
    { id: "two", goal: "Collect second result" },
  ],
}, {
  adapter,
  maxConcurrency: 2,
  requireGoal: true,
  onWorkerStarted: (worker) => events.push(`started:${worker.id}`),
  onWorkerCompleted: (worker) => events.push(`completed:${worker.id}`),
  onWorkerFailed: (worker) => events.push(`failed:${worker.id}`),
  onWorkerSkipped: (worker) => events.push(`skipped:${worker.id}`),
})

assert.equal(result.success, false)
assert.equal(result.concurrency, 2)
assert.deepEqual(result.counts, { total: 6, completed: 3, failed: 1, skipped: 2, cancelled: 0, timed_out: 0 })
assert.deepEqual(result.workers.map((worker) => worker.workerId), ["one", "failed", "after-one", "after-failed", "after-skipped", "two"])
assert.equal(result.workers[1].output?.artifactNamespace, "custom/failed")
assert.equal(result.workers[3].status, "skipped")
assert.equal(result.workers[4].status, "skipped")
assert.deepEqual(runs.sort(), ["after-one", "failed", "one", "two"])
assert.ok(events.indexOf("completed:one") < events.indexOf("started:after-one"), "dependent starts after dependency completion")
assert.ok(!events.includes("started:after-failed"), "failed dependency dependent is never started")
assert.ok(events.indexOf("skipped:after-failed") < events.indexOf("skipped:after-skipped"), "transitive skip is deterministic")

await assert.rejects(executeRunPlan({ concurrency: 1, workers: [{ id: "missing-goal" }] }, { adapter, requireGoal: true }), /requires goal/)
await assert.rejects(executeRunPlan({ concurrency: 1, workers: [{ id: "duplicate", goal: "one" }, { id: "duplicate", goal: "two" }] }, { adapter }), /must be unique/)
await assert.rejects(executeRunPlan({ concurrency: 1, workers: [{ id: "unknown", goal: "one", dependsOn: ["missing"] }] }, { adapter }), /unknown worker/)
await assert.rejects(executeRunPlan({ concurrency: 1, workers: [{ id: "a", goal: "one", dependsOn: ["b"] }, { id: "b", goal: "two", dependsOn: ["a"] }] }, { adapter }), /cycle/)

console.log("run plan executor ok")
