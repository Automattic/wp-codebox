import assert from "node:assert/strict"
import {
  agentTaskStatusFailed,
  agentTaskStatusSucceeded,
  normalizeAgentTaskStatus,
  normalizeAgentTaskRunResult,
  normalizeCheckStatus,
  normalizeCommandEnvelopeStatus,
  normalizePhaseRecipeStatus,
} from "@automattic/wp-codebox-core"

assert.equal(normalizeCommandEnvelopeStatus({ status: "succeeded" }), "completed")
assert.equal(normalizeCommandEnvelopeStatus({ status: "timeout" }), "timed_out")
assert.equal(normalizeCommandEnvelopeStatus({ success: false, exitStatus: 1 }), "failed")

assert.equal(normalizePhaseRecipeStatus({ status: "completed" }), "succeeded")
assert.equal(normalizePhaseRecipeStatus({ status: "timed_out" }), "failed")
assert.equal(normalizePhaseRecipeStatus({ status: "partial" }), "partial")

assert.equal(normalizeAgentTaskStatus({ status: "completed", success: true }), "succeeded")
assert.equal(normalizeAgentTaskStatus({ status: "completed", success: false }), "failed")
assert.equal(normalizeAgentTaskStatus({ status: "timed_out" }), "timeout")
assert.equal(normalizeAgentTaskStatus({ noOp: true }), "no_op")
assert.equal(normalizeAgentTaskStatus({ providerError: { code: "provider" } }), "provider_error")
assert.equal(normalizeAgentTaskRunResult({ status: "completed", success: true }).status, "succeeded")

assert.equal(normalizeCheckStatus({ status: "succeeded" }), "passed")
assert.equal(normalizeCheckStatus({ status: "partial" }), "warning")
assert.equal(normalizeCheckStatus({ status: "timeout" }), "failed")

assert.equal(agentTaskStatusSucceeded("succeeded"), true)
assert.equal(agentTaskStatusSucceeded("no_op"), true)
assert.equal(agentTaskStatusFailed("provider_error"), true)
assert.equal(agentTaskStatusFailed("completed"), false)

console.log("status taxonomy smoke ok")
