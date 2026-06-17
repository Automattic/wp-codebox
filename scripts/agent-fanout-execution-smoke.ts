import assert from "node:assert/strict"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FANOUT_EVENT_SCHEMA, FANOUT_REQUEST_SCHEMA, FANOUT_RESULT_SCHEMA } from "@automattic/wp-codebox-core"
import { executeAgentFanoutRequest } from "../packages/cli/src/agent-fanout.js"

const artifactRoot = await mkdtemp(join(tmpdir(), "wp-codebox-agent-fanout-execution-"))
const seenWorkers: string[] = []

const result = await executeAgentFanoutRequest({
  schema: FANOUT_REQUEST_SCHEMA,
  concurrency: 2,
  agent: "sandbox-worker",
  orchestrator: { request_id: "browser-task-123", product: "smoke" },
  aggregation: { policy: "fail", outputNamespace: "aggregate/final" },
  workers: [
    { id: "design", goal: "Draft a design candidate.", artifactNamespace: "workers/design" },
    { id: "copy", goal: "Draft a copy candidate.", artifactNamespace: "workers/copy" },
  ],
}, {
  artifactRoot,
  recipeDirectory: artifactRoot,
  runWorker: async (input) => {
    seenWorkers.push(String(input.orchestrator?.fanout_worker_id))
    const workerId = String(input.orchestrator?.fanout_worker_id)
    return {
      success: true,
      status: workerId === "copy" ? "no_op" : "completed",
      evidence_refs: [
        { kind: "worker-result", uri: `${input.artifacts_path}/result.json`, label: String(input.goal) },
      ],
      session: { id: input.sandbox_session_id },
    }
  },
})

assert.equal(result.schema, FANOUT_RESULT_SCHEMA)
assert.equal(result.success, true)
assert.equal(result.status, "completed")
assert.equal(result.concurrency, 2)
assert.deepEqual(seenWorkers.sort(), ["copy", "design"])
assert.equal(result.session.children.length, 2)
assert.deepEqual(result.workers.map((worker) => worker.status).sort(), ["no_op", "succeeded"])
assert.equal(result.aggregate.status, "succeeded")
assert.deepEqual(result.aggregate.finalArtifactRefs, [{ path: "aggregate/final/result.json", kind: "fanout-aggregate-output", namespace: "aggregate/final", contentType: "application/json" }])

const events = (await readFile(result.events_path, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)
assert.equal(events.every((event) => event.schema === FANOUT_EVENT_SCHEMA), true)
assert.deepEqual(events.map((event) => event.event).sort(), [
  "aggregation.completed",
  "aggregation.started",
  "fanout.completed",
  "fanout.started",
  "worker.completed",
  "worker.completed",
  "worker.started",
  "worker.started",
])

const persisted = JSON.parse(await readFile(result.result_path, "utf8")) as Record<string, unknown>
assert.equal(persisted.schema, FANOUT_RESULT_SCHEMA)
assert.equal((persisted.counts as Record<string, unknown>).completed, 2)

console.log("agent fanout execution smoke ok")
