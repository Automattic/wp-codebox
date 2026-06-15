import assert from "node:assert/strict"
import { agentSandboxRuntimeFailure, buildAgentTaskSingleResult, recipeAgentResultFailure, type RecipeArtifactEvidenceResult } from "../packages/cli/src/recipe-evidence.ts"

const providerDiagnostic = {
  provider: "codex",
  registered_provider_ids: ["openai"],
  provider_plugins: ["ai-provider-for-openai/plugin.php"],
  provider_plugin_files: [{
    slug: "ai-provider-for-openai",
    source: "/runtime/ai-provider-for-openai",
    plugin_file: "ai-provider-for-openai/plugin.php",
    mounted_path: "/wordpress/wp-content/plugins/ai-provider-for-openai/plugin.php",
    load_as: "plugin",
    mounted: true,
  }],
  plugin_activation: {
    "ai-provider-for-openai/plugin.php": { active: true, load_as: "plugin", error: null },
  },
}

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
          data: providerDiagnostic,
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
          data: providerDiagnostic,
        },
      },
    }),
  },
})

assert.deepEqual(nestedFailure, {
  code: "chubes_ai_request_failed",
  message: "Provider codex is not registered in wp-ai-client",
  data: providerDiagnostic,
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

const singleResult = buildAgentTaskSingleResult({
  schema: "wp-codebox/agent-transcript/v1",
  executions: [{
    executionIndex: 0,
    command: "wordpress.run-php",
    exitCode: 0,
    recipeCommand: "wp-codebox.agent-sandbox-run",
    stdout: JSON.stringify({
      agent_runtime: {
        success: true,
        result: {
          schema: "datamachine/agent-bundle-result/v1",
          success: true,
          status: "completed",
          outputs: {
            issue_number: 614,
            issue_url: "https://github.com/Automattic/wp-codebox/issues/614",
          },
          diagnostics: { run_id: "runtime-run-123" },
        },
      },
    }),
    stderr: "",
    parsed: {
      agent_runtime: {
        success: true,
        result: {
          schema: "datamachine/agent-bundle-result/v1",
          success: true,
          status: "completed",
          outputs: {
            issue_number: 614,
            issue_url: "https://github.com/Automattic/wp-codebox/issues/614",
          },
          diagnostics: { run_id: "runtime-run-123" },
        },
      },
    },
  }],
})

assert.equal(singleResult?.schema, "wp-codebox/agent-task-result/v1")
assert.equal(singleResult?.success, true)
assert.equal(singleResult?.status, "completed")
assert.deepEqual(singleResult?.outputs, {
  issue_number: 614,
  issue_url: "https://github.com/Automattic/wp-codebox/issues/614",
})
assert.deepEqual(singleResult?.diagnostics.runtime, { run_id: "runtime-run-123" })
assert.ok(!("scenarios" in (singleResult ?? {})))

const failedSingleResult = buildAgentTaskSingleResult({
  schema: "wp-codebox/agent-transcript/v1",
  executions: [{
    executionIndex: 0,
    command: "wordpress.run-php",
    exitCode: 0,
    recipeCommand: "wp-codebox.agent-sandbox-run",
    stdout: JSON.stringify({ agent_runtime: { success: false, error: { code: "runtime_failed", message: "Runtime task failed." } } }),
    stderr: "",
    parsed: { agent_runtime: { success: false, error: { code: "runtime_failed", message: "Runtime task failed." } } },
  }],
})

assert.equal(failedSingleResult?.status, "failed")
assert.equal((failedSingleResult?.diagnostics.error as { code?: string } | undefined)?.code, "runtime_failed")

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
