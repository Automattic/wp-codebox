import assert from "node:assert/strict"
import { resolveSandboxTaskCode } from "../packages/cli/src/agent-code.ts"

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
  assert.match(code, /workspace_apply_patch/, "sandbox tool policy should include patch application")
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
