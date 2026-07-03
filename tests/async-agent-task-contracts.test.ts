import assert from "node:assert/strict"

import {
  CODEBOX_ASYNC_AGENT_TASK_HANDLE_SCHEMA,
  CODEBOX_ASYNC_AGENT_TASK_RESULT_SCHEMA,
  CODEBOX_ASYNC_AGENT_TASK_STATUS_SCHEMA,
  normalizeAsyncAgentTaskState,
  normalizeCodeboxAsyncAgentTaskHandle,
  normalizeCodeboxAsyncAgentTaskResult,
  normalizeCodeboxAsyncAgentTaskStatus,
} from "../packages/runtime-core/src/public.js"

const lease = {
  schema: "wp-codebox/preview-lease/v1",
  public_url: "https://preview.example.com/run-123",
  lease: { id: "lease-123", status: "active", owner: "homeboy", provider: "codebox" },
}

const handle = normalizeCodeboxAsyncAgentTaskHandle({
  id: "run-123",
  status: "pending",
  statusUrl: "https://codebox.example.com/runs/run-123/status",
  resultUrl: "https://codebox.example.com/runs/run-123/result",
  runtime_access: { schema: "wp-codebox/runtime-access/v1", lease },
  artifact_result: { success: true, artifactBundle: { kind: "artifact-bundle", path: "artifacts/run-123" } },
})

assert.equal(handle?.schema, CODEBOX_ASYNC_AGENT_TASK_HANDLE_SCHEMA)
assert.equal(handle?.run_id, "run-123")
assert.equal(handle?.state, "queued")
assert.equal(handle?.runtime_access?.lease?.public_url, "https://preview.example.com/run-123")
assert.equal(handle?.artifact_result?.schema, "wp-codebox/artifact-result-envelope/v1")

const status = normalizeCodeboxAsyncAgentTaskStatus({
  job_id: "run-123",
  status: "in_progress",
  diagnostics: [{ code: "wp-codebox.progress", message: "Agent is still running." }],
  metadata: { queue: "runtime" },
})

assert.equal(status?.schema, CODEBOX_ASYNC_AGENT_TASK_STATUS_SCHEMA)
assert.equal(status?.state, "running")
assert.equal(status?.complete, false)
assert.equal(status?.diagnostics[0]?.code, "wp-codebox.progress")
assert.deepEqual(status?.metadata, { queue: "runtime" })

const result = normalizeCodeboxAsyncAgentTaskResult({
  run_id: "run-123",
  state: "completed",
  result: {
    success: true,
    summary: "Agent task completed.",
    artifacts: [{ kind: "codebox-patch", path: "files/patch.diff" }],
    runtime_access: { schema: "wp-codebox/runtime-access/v1", lease },
  },
  artifact_result: {
    schema: "wp-codebox/artifact-result-envelope/v1",
    operation: "agent-task-run",
    status: "created",
    artifactRefs: [{ kind: "codebox-patch", path: "files/patch.diff" }],
    typed_artifacts: [],
  },
})

assert.equal(result?.schema, CODEBOX_ASYNC_AGENT_TASK_RESULT_SCHEMA)
assert.equal(result?.state, "succeeded")
assert.equal(result?.success, true)
assert.equal(result?.result.refs.patches[0]?.path, "files/patch.diff")
assert.equal(result?.artifact_result.artifactRefs[0]?.kind, "codebox-patch")
assert.equal(result?.runtime_access?.lease?.lease?.id, "lease-123")

assert.equal(normalizeAsyncAgentTaskState("provider_error"), "failed")
assert.equal(normalizeCodeboxAsyncAgentTaskHandle({ status: "queued" }), undefined)

console.log("async agent task contracts passed")
