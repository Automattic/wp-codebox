import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { FANOUT_REQUEST_SCHEMA } from "../packages/runtime-core/src/index.js"
import { executeAgentFanoutRequest } from "../packages/cli/src/agent-fanout.js"
import { withTempDir } from "../scripts/test-kit.js"

await withTempDir("wp-codebox-agent-fanout-executor-", async (root) => {
  const result = await executeAgentFanoutRequest({
    schema: FANOUT_REQUEST_SCHEMA,
    concurrency: 3,
    agent: "sandbox-agent",
    session_id: "fanout-test",
    orchestrator: {},
    deterministic: { event_time: "2026-01-02T03:04:05.000Z" },
    workers: [
      { id: "one", goal: "Collect first result" },
      { id: "two", goal: "Collect second result" },
    ],
  }, {
    artifactRoot: root,
    recipeDirectory: root,
    runWorker: async (input) => ({
      success: true,
      status: "succeeded",
      evidence_refs: [{ path: `${input.artifacts_path}/result.json`, kind: "worker-result" }],
    }),
    previewHoldSeconds: "",
    previewPublicUrl: "",
  })

  assert.equal(result.success, true)
  assert.equal(result.fanout_id, "fanout-test")
  assert.equal(result.concurrency, 3)
  assert.deepEqual(result.counts, { total: 2, completed: 2, failed: 0, skipped: 0, cancelled: 0, timed_out: 0 })
  assert.deepEqual(result.session.children.map((child) => child.id), ["fanout-test:one", "fanout-test:two"])
  assert.deepEqual(result.session.children.map((child) => child.artifacts), ["fanout/workers/one/artifacts", "fanout/workers/two/artifacts"])
  assert.deepEqual(result.workers.map((worker) => worker.status), ["succeeded", "succeeded"])
  assert.equal(result.workers[0].artifact_refs[0].namespace, "workers/one")
  assert.equal(result.workers[0].artifact_refs[0].path, "fanout/workers/one/artifacts/result.json")
  assert.equal((result.workers[0].artifact_refs[0].metadata as Record<string, unknown>).private instanceof Object, true)
  assert.equal(result.diagnostics?.private instanceof Object, true)
  assert.equal(result.progress.schema, "wp-codebox/live-progress-event/v1")
  assert.equal(result.progress.phase, "fanout.completed")
  assert.equal(result.progress.status, "succeeded")
  assert.equal(result.progress.session_id, "fanout-test")
  assert.equal(result.progress.run_id, "fanout-test")
  assert.deepEqual(result.progress.progress, { current: 2, total: 2, active: 0, completed: 2, failed: 0, skipped: 0, cancelled: 0, timed_out: 0, percent: 100 })

  const events = (await readFile(join(root, "fanout", "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line))
  const plan = JSON.parse(await readFile(join(root, "fanout", "plan.json"), "utf8"))
  assert.equal(plan.fanout_id, "fanout-test")
  assert.deepEqual([...new Set(events.map((event) => event.fanout_id))], ["fanout-test"])
  assert.deepEqual(events.map((event) => event.event), [
    "fanout.started",
    "worker.started",
    "worker.started",
    "worker.completed",
    "worker.completed",
    "aggregation.started",
    "aggregation.completed",
    "fanout.completed",
  ])
  const eventCounts = events.map((event) => [event.event, event.total, event.active, event.completed, event.failed, event.skipped])
  assert.deepEqual(eventCounts.slice(0, 3), [
    ["fanout.started", 2, 0, 0, 0, 0],
    ["worker.started", 2, 1, 0, 0, 0],
    ["worker.started", 2, 2, 0, 0, 0],
  ])
  assert.deepEqual(eventCounts.slice(3, 5).sort((a, b) => Number(a[3]) - Number(b[3])), [
    ["worker.completed", 2, 1, 1, 0, 0],
    ["worker.completed", 2, 0, 2, 0, 0],
  ])
  assert.deepEqual(eventCounts.slice(5), [
    ["aggregation.started", 2, 0, 2, 0, 0],
    ["aggregation.completed", 2, 0, 2, 0, 0],
    ["fanout.completed", 2, 0, 2, 0, 0],
  ])
  assert.deepEqual([...new Set(events.map((event) => event.time))], ["2026-01-02T03:04:05.000Z"])
  assert.deepEqual(events.map((event) => [event.phase, event.timestamp, event.session_id, event.run_id]), events.map((event) => [event.event, "2026-01-02T03:04:05.000Z", "fanout-test", "fanout-test"]))
  assert.equal(events[0].normalized_progress.schema, "wp-codebox/live-progress-event/v1")
  assert.equal(events[0].normalized_progress.label, "Fanout started")
  assert.deepEqual(events[0].normalized_progress.progress, { current: 0, total: 2, active: 0, completed: 0, failed: 0, skipped: 0, cancelled: 0, timed_out: 0, percent: 0 })
  assert.equal(events.at(-1).normalized_progress.phase, "fanout.completed")
  assert.equal(events.at(-1).normalized_progress.status, "succeeded")
})

await withTempDir("wp-codebox-agent-fanout-dag-", async (root) => {
  const invoked: string[] = []
  const result = await executeAgentFanoutRequest({
    schema: FANOUT_REQUEST_SCHEMA,
    concurrency: 4,
    agent: "sandbox-agent",
    orchestrator: { session_id: "fanout-dag" },
    workers: [
      { id: "setup", goal: "Prepare shared context" },
      { id: "failing", goal: "Fail this branch" },
      { id: "after-setup", goal: "Run after setup", dependsOn: ["setup"] },
      { id: "after-failing", goal: "Skip after failing", dependsOn: ["failing"] },
      { id: "after-skipped", goal: "Skip after skipped", dependsOn: ["after-failing"] },
    ],
  }, {
    artifactRoot: root,
    recipeDirectory: root,
    runWorker: async (input) => {
      const workerId = String((input.orchestrator as Record<string, unknown>).fanout_worker_id)
      invoked.push(workerId)
      return {
        success: workerId !== "failing",
        status: workerId === "failing" ? "failed" : "succeeded",
        evidence_refs: [{ path: `${input.artifacts_path}/result.json`, kind: "worker-result" }],
      }
    },
    previewHoldSeconds: "",
    previewPublicUrl: "",
  })

  assert.equal(result.success, false)
  assert.equal(result.fanout_id, "fanout-dag")
  assert.deepEqual(result.counts, { total: 5, completed: 2, failed: 1, skipped: 2, cancelled: 0, timed_out: 0 })
  assert.deepEqual(result.workers.map((worker) => [worker.worker_id, worker.status]), [
    ["setup", "succeeded"],
    ["failing", "failed"],
    ["after-setup", "succeeded"],
    ["after-failing", "skipped"],
    ["after-skipped", "skipped"],
  ])
  assert.deepEqual(invoked.sort(), ["after-setup", "failing", "setup"])

  const plan = JSON.parse(await readFile(join(root, "fanout", "plan.json"), "utf8"))
  assert.deepEqual(plan.workers[2].depends_on, ["setup"])

  const skipped = JSON.parse(await readFile(join(root, "fanout", "workers", "after-failing", "result.json"), "utf8"))
  assert.equal(skipped.status, "skipped")
  assert.equal(skipped.error.code, "dependency-skipped")
  assert.deepEqual(skipped.output.dependencies, [{ worker_id: "failing", status: "failed", success: false }])

  const events = (await readFile(join(root, "fanout", "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line))
  assert.ok(events.find((event) => event.event === "worker.skipped" && event.worker_id === "after-failing"))
  assert.ok(events.findIndex((event) => event.event === "worker.completed" && event.worker_id === "setup") < events.findIndex((event) => event.event === "worker.started" && event.worker_id === "after-setup"))
})

console.log("agent fanout executor ok")
