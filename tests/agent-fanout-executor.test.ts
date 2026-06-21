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
    orchestrator: { session_id: "fanout-test" },
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
  assert.equal(result.concurrency, 3)
  assert.deepEqual(result.counts, { total: 2, completed: 2, failed: 0, skipped: 0, cancelled: 0, timed_out: 0 })
  assert.deepEqual(result.session.children.map((child) => child.id), ["fanout-test:one", "fanout-test:two"])
  assert.deepEqual(result.workers.map((worker) => worker.status), ["succeeded", "succeeded"])
  assert.equal(result.workers[0].artifact_refs[0].namespace, "workers/one")

  const events = (await readFile(join(root, "fanout", "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line))
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
      { id: "after-failing", goal: "Skip after failing", depends_on: ["failing"] },
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
  assert.deepEqual(skipped.output.dependencies, [{ worker_id: "failing", status: "failed", success: false }])

  const events = (await readFile(join(root, "fanout", "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line))
  assert.ok(events.find((event) => event.event === "worker.skipped" && event.worker_id === "after-failing"))
  assert.ok(events.findIndex((event) => event.event === "worker.completed" && event.worker_id === "setup") < events.findIndex((event) => event.event === "worker.started" && event.worker_id === "after-setup"))
})

console.log("agent fanout executor ok")
