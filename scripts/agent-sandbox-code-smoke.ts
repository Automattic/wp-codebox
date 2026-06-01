import assert from "node:assert/strict"
import { agentSandboxRunCode, resolveSandboxTaskCode } from "../packages/cli/src/agent-code.ts"

async function main() {
  const code = await resolveSandboxTaskCode({
    task: "Fix duplicate code",
    agent: "sandbox-agent",
    mode: "sandbox",
    provider: "opencode",
    model: "opencode-go/kimi-k2.6",
  })

  assert.match(code, /\\"modes\\":\[\\"sandbox\\",\\"chat\\"\]/, "sandbox chat input should inherit chat tool surface")
  assert.match(code, /\\"agent_modes\\":\[\\"sandbox\\",\\"chat\\"\]/, "client context should report additive sandbox modes without pipeline completion semantics")
  assert.doesNotMatch(code, /\\"pipeline\\"/, "sandbox agents should not use pipeline mode because it completes after handler tools")
  assert.match(code, /\\"tool_policy\\":\{\\"mode\\":\\"allow\\",\\"tools\\":\[.*\\"workspace_read\\"/, "sandbox agent should allow workspace tools")
  assert.match(code, /datamachine_agent_mode_sandbox/, "sandbox mode should inject tool guidance")
  assert.match(code, /WP_Codebox_Sandbox_Perception_Directive/, "sandbox mode should inject a WP Codebox perception directive")
  assert.match(code, /WP Codebox Sandbox Perception/, "sandbox perception should expose workspace context by default")
  assert.match(code, /datamachine_code_remote_workspace_backend_should_handle/, "sandbox mode should use the mounted workspace backend")
  assert.match(code, /Do not invent alternate tool names such as read_file/, "sandbox guidance should prevent pseudo-tool aliases")
  assert.doesNotMatch(code, /workspace_apply_patch/, "sandbox tool policy should not advertise git-backed patch application")
  assert.doesNotMatch(code, /workspace_git_status/, "sandbox tool policy should not advertise unbridged git status")
  assert.doesNotMatch(code, /workspace_git_log/, "sandbox tool policy should not advertise unbridged git log")
  assert.doesNotMatch(code, /workspace_git_diff/, "sandbox tool policy should not advertise unbridged git diff")
  assert.match(code, /For changes use workspace_write or workspace_edit/, "sandbox guidance should steer changes to tools that work without git")

  const runCode = agentSandboxRunCode(
    '{"prompt":"Do not interpolate $buckets, $meta, or $state_store."}',
    '<?php echo "ok";',
    [],
  )
  assert.match(runCode, /<<<'WP_CODEBOX_LITERAL_/, "sandbox task JSON should use a single-quoted nowdoc")
  assert.doesNotMatch(runCode, /\$sandbox_task = "\{/, "sandbox task JSON should not use PHP double-quoted strings")
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
