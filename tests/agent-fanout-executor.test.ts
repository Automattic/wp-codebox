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
  assert.deepEqual(result.counts, { total: 2, completed: 2, failed: 0, cancelled: 0 })
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

console.log("agent fanout executor ok")
