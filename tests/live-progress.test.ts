import assert from "node:assert/strict"
import { normalizeLiveProgressEvent } from "../packages/runtime-core/src/live-progress.js"

const event = normalizeLiveProgressEvent({
  schema: "wp-codebox/fanout-event/v1",
  event: "worker.completed",
  fanout_id: "fanout-1",
  worker_id: "worker-2",
  completed: 2,
  total: 4,
  status: "completed",
  artifacts: { result: "fanout/worker-2/result.json" },
  diagnostics: { counts: { failed: 0 } },
  time: "2026-06-26T00:00:00.000Z",
})

assert.equal(event.schema, "wp-codebox/live-progress-event/v1")
assert.equal(event.phase, "worker.completed")
assert.equal(event.status, "succeeded")
assert.equal(event.progress?.current, 2)
assert.equal(event.progress?.total, 4)
assert.equal(event.progress?.percent, 50)
assert.deepEqual(event.artifacts, { result: "fanout/worker-2/result.json" })
assert.deepEqual(event.diagnostics, { counts: { failed: 0 } })
