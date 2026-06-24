import assert from "node:assert/strict"

import { createRunPlanEvent, executeRunPlan, normalizeRunPlanProgressSnapshot, type RunPlanEventContract, type RunPlanWorkerAdapter } from "../packages/runtime-core/src/index.js"

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

const successfulRun = await executeRunPlan({
  concurrency: 1,
  workers: [{ id: "success", goal: "Complete normally" }],
}, {
  adapter: {
    async run({ descriptor }) {
      return { workerId: descriptor.id, status: "succeeded", success: true }
    },
  },
})
assert.equal(successfulRun.success, true)
assert.deepEqual(successfulRun.counts, { total: 1, completed: 1, failed: 0, skipped: 0, cancelled: 0, timed_out: 0 })

const timedOutRuns: string[] = []
const timedOutRun = await executeRunPlan({
  concurrency: 1,
  workers: [
    { id: "slow", goal: "Time out", timeout_seconds: 1 },
    { id: "after-slow", goal: "Skip after timeout", dependsOn: ["slow"] },
  ],
}, {
  adapter: {
    async run({ descriptor }) {
      timedOutRuns.push(descriptor.id)
      await new Promise((resolve) => setTimeout(resolve, 1100))
      return { workerId: descriptor.id, status: "succeeded", success: true }
    },
  },
})
assert.equal(timedOutRun.success, false)
assert.deepEqual(timedOutRun.counts, { total: 2, completed: 0, failed: 0, skipped: 1, cancelled: 0, timed_out: 1 })
assert.equal(timedOutRun.workers[0].status, "timed_out")
assert.equal(timedOutRun.workers[1].status, "skipped")
assert.deepEqual(timedOutRuns, ["slow"])

const cancelledRuns: string[] = []
const cancelledRun = await executeRunPlan({
  concurrency: 1,
  workers: [
    { id: "cancelled", goal: "Do not start", cancel_requested: true, cancel_reason: "operator-requested" },
    { id: "after-cancelled", goal: "Skip after cancellation", dependsOn: ["cancelled"] },
  ],
}, {
  adapter: {
    async run({ descriptor }) {
      cancelledRuns.push(descriptor.id)
      return { workerId: descriptor.id, status: "succeeded", success: true }
    },
  },
})
assert.equal(cancelledRun.success, false)
assert.deepEqual(cancelledRun.counts, { total: 2, completed: 0, failed: 0, skipped: 1, cancelled: 1, timed_out: 0 })
assert.equal(cancelledRun.workers[0].status, "cancelled")
assert.equal((cancelledRun.workers[0] as { error?: { message?: string } }).error?.message, "operator-requested")
assert.equal(cancelledRun.workers[1].status, "skipped")
assert.deepEqual(cancelledRuns, [])

const deadlineRuns: string[] = []
const deadlineRun = await executeRunPlan({
  concurrency: 1,
  workers: [{ id: "expired", goal: "Do not start after deadline", deadline: "2026-03-04T05:06:06.000Z" }],
}, {
  adapter: {
    async run({ descriptor }) {
      deadlineRuns.push(descriptor.id)
      return { workerId: descriptor.id, status: "succeeded", success: true }
    },
  },
  clock: () => "2026-03-04T05:06:07.000Z",
})
assert.equal(deadlineRun.success, false)
assert.deepEqual(deadlineRun.counts, { total: 1, completed: 0, failed: 0, skipped: 0, cancelled: 0, timed_out: 1 })
assert.equal(deadlineRun.workers[0].status, "timed_out")
assert.deepEqual(deadlineRuns, [])

await assert.rejects(executeRunPlan({ concurrency: 1, workers: [{ id: "missing-goal" }] }, { adapter, requireGoal: true }), /requires goal/)
await assert.rejects(executeRunPlan({ concurrency: 1, workers: [{ id: "duplicate", goal: "one" }, { id: "duplicate", goal: "two" }] }, { adapter }), /must be unique/)
await assert.rejects(executeRunPlan({ concurrency: 1, workers: [{ id: "unknown", goal: "one", dependsOn: ["missing"] }] }, { adapter }), /unknown worker/)
await assert.rejects(executeRunPlan({ concurrency: 1, workers: [{ id: "a", goal: "one", dependsOn: ["b"] }, { id: "b", goal: "two", dependsOn: ["a"] }] }, { adapter }), /cycle/)

assert.deepEqual(createRunPlanEvent<RunPlanEventContract>("wp-codebox/run-plan-event/v1", { event: "worker.started" }, { clock: () => "2026-03-04T05:06:07.000Z" }), {
  schema: "wp-codebox/run-plan-event/v1",
  time: "2026-03-04T05:06:07.000Z",
  event: "worker.started",
})

assert.deepEqual(normalizeRunPlanProgressSnapshot({
  plan: {
    id: "run-123",
    sessionId: "session-123",
    concurrency: 2,
    workers: [
      { id: "one", goal: "Done", artifactNamespace: "workers/one" },
      { id: "two", goal: "Active" },
      { id: "three", goal: "Queued" },
    ],
  },
  events: [
    { event: "worker.started", workerId: "one", time: "2026-03-04T05:06:00.000Z" },
    { event: "worker.completed", workerId: "one", time: "2026-03-04T05:06:01.000Z" },
    { event: "worker.started", workerId: "two", time: "2026-03-04T05:06:02.000Z" },
  ],
  results: [{ workerId: "one", status: "succeeded", success: true }],
  eventsRef: "events.jsonl",
  resultRef: "result.json",
  time: "2026-03-04T05:06:03.000Z",
}), {
  schema: "wp-codebox/run-plan-progress/v1",
  time: "2026-03-04T05:06:03.000Z",
  status: "running",
  active: 1,
  counts: { total: 3, completed: 1, failed: 0, skipped: 0, cancelled: 0, timed_out: 0 },
  workers: [
    { id: "one", status: "succeeded", artifactNamespace: "workers/one", lastEvent: "worker.completed", startedAt: "2026-03-04T05:06:00.000Z", completedAt: "2026-03-04T05:06:01.000Z" },
    { id: "two", status: "running", lastEvent: "worker.started", startedAt: "2026-03-04T05:06:02.000Z" },
    { id: "three", status: "queued" },
  ],
  sessionId: "session-123",
  runId: "run-123",
  eventsRef: "events.jsonl",
  resultRef: "result.json",
})

console.log("run plan executor ok")
