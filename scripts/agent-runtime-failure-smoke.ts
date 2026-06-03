import assert from "node:assert/strict"
import { agentSandboxRuntimeFailure, recipeAgentResultFailure, type RecipeArtifactEvidenceResult } from "../packages/cli/src/recipe-evidence.ts"

const nestedFailure = agentSandboxRuntimeFailure({
  executionIndex: 0,
  command: "wordpress.run-php",
  exitCode: 0,
  recipeCommand: "wp-codebox.agent-sandbox-run",
  stdout: JSON.stringify({
    command: "agent-sandbox.run",
    output: JSON.stringify({
      agent_runtime: {
        success: false,
        error: {
          code: "chubes_ai_request_failed",
          message: "Provider codex is not registered in wp-ai-client",
        },
      },
    }),
  }),
  stderr: "",
  parsed: {
    command: "agent-sandbox.run",
    output: JSON.stringify({
      agent_runtime: {
        success: false,
        error: {
          code: "chubes_ai_request_failed",
          message: "Provider codex is not registered in wp-ai-client",
        },
      },
    }),
  },
})

assert.deepEqual(nestedFailure, {
  code: "chubes_ai_request_failed",
  message: "Provider codex is not registered in wp-ai-client",
})

const agentFailure = recipeAgentResultFailure({
  schema: "wp-codebox/agent-result/v1",
  status: "failed",
  actionable: false,
  summary: "Agent sandbox failed before producing actionable file changes.",
  changedFiles: { count: 0, paths: [], statuses: {}, artifact: "files/changed-files.json" },
  patch: { bytes: 0, sha256: "0".repeat(64), artifact: "files/patch.diff" },
  transcript: { artifact: "files/runtime-evidence/transcript.json", executionCount: 1 },
  artifacts: { directory: "/tmp/wp-codebox", review: "files/review.json", manifest: "manifest.json" },
  failures: [{ executionIndex: 0, command: "wordpress.run-php", exitCode: 0, message: nestedFailure.message }],
  artifact: { path: "files/runtime-evidence/agent-result.json", sha256: "1".repeat(64), kind: "agent-result", contentType: "application/json" },
} satisfies RecipeArtifactEvidenceResult["agentResult"])

assert.equal(agentFailure?.code, "agent-runtime-failed")
assert.equal(agentFailure?.message, "Provider codex is not registered in wp-ai-client")
assert.equal(agentFailure?.name, "AgentRuntimeError")

const pendingToolsFailure = agentSandboxRuntimeFailure({
  executionIndex: 1,
  command: "wordpress.run-php",
  exitCode: 0,
  recipeCommand: "wp-codebox.agent-sandbox-run",
  stdout: JSON.stringify({
    agent_runtime: {
      success: true,
      result: {
        status: "processing",
        completed: false,
        current_turn: 20,
        has_pending_tools: true,
      },
    },
  }),
  stderr: "",
  parsed: {
    agent_runtime: {
      success: true,
      result: {
        status: "processing",
        completed: false,
        current_turn: 20,
        has_pending_tools: true,
      },
    },
  },
})

assert.deepEqual(pendingToolsFailure, {
  code: "agent_runtime_incomplete",
  message: "Agent sandbox runtime ended before the nested agent completed pending tool work.",
  data: {
    status: "processing",
    completed: false,
    current_turn: 20,
    has_pending_tools: true,
  },
})

const rawPendingToolsFailure = agentSandboxRuntimeFailure({
  executionIndex: 2,
  command: "wordpress.run-php",
  exitCode: 0,
  recipeCommand: "wp-codebox.agent-sandbox-run",
  stdout: JSON.stringify({
    command: "agent-sandbox.run",
    output: JSON.stringify({
      status: "processing",
      current_turn: 20,
      has_pending_tools: true,
    }),
  }),
  stderr: "",
  parsed: {
    command: "agent-sandbox.run",
    output: JSON.stringify({
      status: "processing",
      current_turn: 20,
      has_pending_tools: true,
    }),
  },
})

assert.equal(rawPendingToolsFailure?.code, "agent_runtime_incomplete")
assert.equal(rawPendingToolsFailure?.message, "Agent sandbox runtime ended before the nested agent completed pending tool work.")
assert.deepEqual(rawPendingToolsFailure?.data, {
  status: "processing",
  current_turn: 20,
  has_pending_tools: true,
})

const maxTurnsFailure = agentSandboxRuntimeFailure({
  executionIndex: 3,
  command: "wordpress.run-php",
  exitCode: 0,
  recipeCommand: "wp-codebox.agent-sandbox-run",
  stdout: JSON.stringify({
    command: "agent-sandbox.run",
    output: JSON.stringify({
      status: "completed",
      current_turn: 20,
      max_turns: 20,
    }),
  }),
  stderr: "",
  parsed: {
    command: "agent-sandbox.run",
    output: JSON.stringify({
      status: "completed",
      current_turn: 20,
      max_turns: 20,
    }),
  },
})

assert.equal(maxTurnsFailure?.code, "agent_runtime_incomplete")
assert.deepEqual(maxTurnsFailure?.data, {
  status: "completed",
  current_turn: 20,
  max_turns: 20,
})

console.log("Agent runtime failure smoke passed")
