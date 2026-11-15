import assert from "node:assert/strict"

import { agentRuntimeFailure } from "../.github/scripts/run-agent-task/agent-runtime-failure.mjs"

// A successful runtime has no failure.
assert.equal(agentRuntimeFailure({ execution: { code: 0 }, runtimeResult: { success: true } }), undefined)

// An unreadable native result (exit 0) names the reader diagnostic.
{
  const failure = agentRuntimeFailure({
    execution: { code: 0, stdout: "", stderr: "" },
    runtimeResult: { success: false, diagnostics: [{ code: "wp-codebox.agent-task.result-too-large", message: "Native agent-task result is 2000000 bytes, exceeding the 1048576-byte limit." }] },
  })
  assert.equal(failure?.stage, "agent")
  assert.equal(failure?.code, "wp-codebox.agent-task.result-too-large")
  assert.match(String(failure?.message), /2000000 bytes/)
  assert.equal(failure?.exit_code, 0)
  assert.equal(failure?.stderr_tail, undefined, "stream tails are only attached to non-zero exits")
}

// A non-zero exit without diagnostics still yields a code and message with the stderr tail.
{
  const failure = agentRuntimeFailure({ execution: { code: 1, stdout: "failed: task", stderr: "PHP Fatal error: boom" }, runtimeResult: {} })
  assert.equal(failure?.code, "agent_runtime_exit")
  assert.match(String(failure?.message), /exited with code 1.*PHP Fatal error: boom/)
  assert.equal(failure?.stderr_tail, "PHP Fatal error: boom")
}

// Error diagnostics lead over warnings; provider errors classify the failure.
{
  const failure = agentRuntimeFailure({
    execution: { code: 1 },
    runtimeResult: {
      success: false,
      agent_task_run_result: {
        status: "provider_error",
        diagnostics: [{ code: "slow", message: "slow", severity: "warning" }, { code: "provider_http_429", message: "Too many requests", severity: "error" }],
        metadata: { provider_error: { message: "Too many requests", code: "429" } },
      },
    },
  })
  assert.equal(failure?.code, "provider_http_429")
  assert.equal(failure?.classification, "provider_error")
  assert.equal(failure?.runtime_status, "provider_error")
  assert.deepEqual(failure?.provider_error, { message: "Too many requests", code: "429" })
}

// A failed terminal status without diagnostics becomes the code.
{
  const failure = agentRuntimeFailure({ execution: { code: 0 }, runtimeResult: { success: false, terminal_result: { status: "timeout", failure_classification: "timeout" } } })
  assert.equal(failure?.code, "agent_timeout")
  assert.equal(failure?.classification, "timeout")
}

console.log("agent runtime failure ok")
