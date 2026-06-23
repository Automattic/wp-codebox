import assert from "node:assert/strict"
import { normalizeAgentTaskRunResult, normalizeAgentTerminalResult } from "@automattic/wp-codebox-core"
import { agentSandboxRuntimeFailure, buildAgentTaskSingleResult } from "../packages/cli/src/recipe-evidence.ts"

const canonicalTerminalResult = {
  schema: "wp-codebox/agent-terminal-result/v1",
  terminal: true,
  status: "succeeded",
  success: true,
  pending_tools: { detected: false },
  max_turns: { reached: false, current: 8, max: 20 },
  evidence_refs: [{ kind: "transcript", uri: "files/transcript.json" }],
}

const canonical = normalizeAgentTerminalResult({ terminal_result: canonicalTerminalResult })
assert.equal(canonical?.source, "canonical")
assert.equal(canonical?.status, "succeeded")
assert.equal(canonical?.success, true)
assert.equal(canonical?.evidence_refs[0]?.kind, "transcript")

const canonicalExecutionFailure = agentSandboxRuntimeFailure({
  executionIndex: 0,
  command: "wordpress.run-php",
  exitCode: 0,
  recipeCommand: "wp-codebox.agent-sandbox-run",
  stdout: "",
  stderr: "",
  parsed: {
    agent_runtime: {
      success: true,
      result: {
        status: "processing",
        completed: false,
        has_pending_tools: true,
        terminal_result: canonicalTerminalResult,
      },
    },
  },
})
assert.equal(canonicalExecutionFailure, undefined, "canonical terminal_result overrides legacy pending-tool fields")

const replyExecutionFailure = agentSandboxRuntimeFailure({
  executionIndex: 0,
  command: "wordpress.run-php",
  exitCode: 0,
  recipeCommand: "wp-codebox.agent-sandbox-run",
  stdout: "",
  stderr: "",
  parsed: {
    agent_runtime: {
      success: true,
      result: {
        reply: "Concept packet produced.",
        current_turn: 20,
        max_turns: 20,
      },
    },
  },
})
assert.equal(replyExecutionFailure, undefined, "reply is a terminal answer for max-turn compatibility checks")

const legacy = normalizeAgentTerminalResult({
  status: "processing",
  completed: false,
  has_pending_tools: true,
  current_turn: 20,
  max_turns: 20,
}, { compatMode: true })
assert.equal(legacy?.source, "legacy-fallback")
assert.equal(legacy?.status, "max_turns")
assert.equal(legacy?.success, false)
assert.equal(legacy?.failure_classification, "max_turns")
assert.deepEqual(legacy?.max_turns, { reached: true, current: 20, max: 20 })

const taskResult = buildAgentTaskSingleResult({
  schema: "wp-codebox/agent-transcript/v1",
  executions: [{
    executionIndex: 0,
    command: "wordpress.run-php",
    exitCode: 0,
    recipeCommand: "wp-codebox.agent-sandbox-run",
    stdout: "",
    stderr: "",
    parsed: {
      agent_runtime: {
        success: true,
        result: {
          outputs: { artifact_url: "https://example.test/artifact" },
          terminal_result: canonicalTerminalResult,
        },
      },
    },
  }],
})
assert.equal(taskResult?.terminal_result?.schema, "wp-codebox/agent-terminal-result/v1")
assert.equal(taskResult?.terminal_result?.source, "canonical")

const runResult = normalizeAgentTaskRunResult({
  schema: "wp-codebox/agent-task-run/v1",
  success: true,
  status: "completed",
  agent_task_result: taskResult,
  agentResult: taskResult,
  terminal_result: canonicalTerminalResult,
})
assert.equal(runResult.terminal_result?.status, "succeeded")
assert.equal(runResult.status, "succeeded")
assert.equal(runResult.success, true)

const completionSucceededRunResult = normalizeAgentTaskRunResult({
  schema: "wp-codebox/agent-task-run/v1",
  success: false,
  status: "failed",
  terminal_result: {
    schema: "wp-codebox/agent-terminal-result/v1",
    terminal: true,
    status: "incomplete",
    success: false,
    evidence_refs: [],
  },
  completion_outcome: {
    schema: "wp-codebox/sandbox-completion-outcome/v1",
    status: "succeeded",
    summary: "Agent sandbox produced artifacts.",
  },
}, { compatMode: true })
assert.equal(completionSucceededRunResult.terminal_result?.status, "succeeded")
assert.equal(completionSucceededRunResult.status, "succeeded")
assert.equal(completionSucceededRunResult.success, true)

const partialNoOpRunResult = normalizeAgentTaskRunResult({
  schema: "wp-codebox/agent-task-run/v1",
  success: false,
  status: "failed",
  terminal_result: {
    schema: "wp-codebox/agent-terminal-result/v1",
    terminal: true,
    status: "incomplete",
    success: false,
    failure_classification: "incomplete",
    evidence_refs: [],
  },
  agentResult: {
    summary: "Agent sandbox completed successfully without actionable file changes.",
  },
  no_op: {
    detected: true,
    reason: "no_file_changes",
    changed_files_count: 0,
    patch_bytes: 0,
  },
  completion_outcome: {
    schema: "wp-codebox/sandbox-completion-outcome/v1",
    status: "partial",
    summary: "Agent sandbox completed successfully without actionable file changes.",
    blockers: [],
    riskNotes: ["no_file_changes"],
  },
}, { compatMode: true })
assert.equal(partialNoOpRunResult.status, "no_op")
assert.equal(partialNoOpRunResult.success, true)
assert.equal(partialNoOpRunResult.failure_classification, undefined)

console.log("agent terminal result contract smoke passed")
