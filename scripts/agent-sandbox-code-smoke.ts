import assert from "node:assert/strict"
import { recipeExecutionSpec } from "../packages/cli/src/agent-sandbox.ts"
import { agentSandboxRunCode, resolveSandboxTaskCode } from "../packages/cli/src/agent-code.ts"

async function main() {
  const sandboxWorkspace = {
    schema: "wp-codebox/sandbox-workspace/v1" as const,
    root: "/workspace",
    defaultMode: "repo-backed" as const,
    mounts: [
      {
        target: "/workspace/wp-codebox",
        mode: "readwrite" as const,
        sourceMode: "repo-backed" as const,
        workspaceRef: "wp-codebox@fix-issue-533-mounted-workspace-perception",
        repo: "Automattic/wp-codebox",
        mountRole: "recipe-workspace",
      },
    ],
    dmc: {
      safeAbilities: ["datamachine/workspace-read"],
      parentOnlyAbilities: [],
    },
  }
  const code = await resolveSandboxTaskCode({
    task: "Fix duplicate code",
    agent: "sandbox-agent",
    mode: "sandbox",
    provider: "opencode",
    model: "opencode-go/kimi-k2.6",
    sessionId: "codebox-smoke-session",
    sandboxWorkspace,
    sandboxToolPolicy: {
      schema: "wp-codebox/sandbox-tool-policy/v1",
      version: 1,
      tools: [
        { id: "datamachine/workspace-read", runtime_tool_id: "workspace_read", execution_location: "sandbox", transport_visibility: "sandbox", allowed: true },
        { id: "datamachine/workspace-write", runtime_tool_id: "workspace_write", execution_location: "sandbox", transport_visibility: "sandbox", allowed: true },
        { id: "datamachine/workspace-edit", runtime_tool_id: "workspace_edit", execution_location: "sandbox", transport_visibility: "sandbox", allowed: true },
        { id: "datamachine/workspace-git-status", runtime_tool_id: "workspace_git_status", execution_location: "parent", transport_visibility: "parent", allowed: false },
      ],
      metadata: { source: "smoke" },
    },
    agentBundles: [
      { source: "/tmp/site-generator-agent.json", slug: "site-generator" },
      {
        bundle: {
          bundle_version: "1.0.0",
          agent: { agent_slug: "repair-agent", agent_name: "Repair Agent", agent_config: {} },
        },
        slug: "repair-agent",
      },
    ],
  })

  assert.match(code, /\\"modes\\":\[\\"sandbox\\",\\"chat\\"\]/, "sandbox chat input should inherit chat tool surface")
  assert.doesNotMatch(code, /\\"session_id\\":\\"codebox-smoke-session\\"/, "fresh sandbox chats should not continue a nonexistent transcript session")
  assert.match(code, /\\"codebox_session_id\\":\\"codebox-smoke-session\\"/, "Codebox session id should remain orchestration metadata")
  assert.match(code, /\\"auth_source\\":\\"runtime\\"/, "sandbox agent request should carry an Agents API runtime principal")
  assert.match(code, /\\"request_context\\":\\"runtime\\"/, "sandbox agent request should identify runtime request context")
  assert.match(code, /\\"owner_type\\":\\"runtime\\"/, "sandbox agent request should scope transcript ownership to the runtime")
  assert.match(code, /\\"runtime_type\\":\\"wordpress-playground\\"/, "sandbox agent request should declare the delegated runtime type")
  assert.match(code, /\\"agent_modes\\":\[\\"sandbox\\",\\"chat\\"\]/, "client context should report additive sandbox modes without pipeline completion semantics")
  assert.doesNotMatch(code, /\\"pipeline\\"/, "sandbox agents should not use pipeline mode because it completes after handler tools")
  assert.match(code, /\\"tool_policy\\"/, "sandbox agent should include a tool policy")
  assert.match(code, /\\"mode\\":\\"allow\\"/, "sandbox agent should use allow-mode tool policy")
  assert.match(code, /\\"workspace_read\\"/, "sandbox agent should allow workspace read tool")
  assert.match(code, /datamachine_agent_mode_sandbox/, "sandbox mode should inject tool guidance")
  assert.match(code, /WP_Codebox_Sandbox_Perception_Directive/, "sandbox mode should inject a WP Codebox perception directive")
  assert.match(code, /WP Codebox Sandbox Perception/, "sandbox perception should expose workspace context by default")
  assert.match(code, /sandbox_workspace/, "sandbox request should include mounted workspace context")
  assert.match(code, /default_workspace/, "sandbox request should include a default mounted workspace")
  assert.match(code, /wp-codebox@fix-issue-533-mounted-workspace-perception/, "sandbox context should include mounted workspace handle")
  assert.match(code, /\/workspace\/wp-codebox/, "sandbox context should include mounted workspace path")
  assert.match(code, /Automattic\/wp-codebox/, "sandbox context should include mounted workspace repo")
  assert.match(code, /\\"mode\\":\\"readwrite\\"/, "sandbox context should include mounted workspace mode")
  assert.match(code, /Mounted Workspaces/, "sandbox perception should render a mounted workspace section")
  assert.match(code, /Bounded tree/, "sandbox perception should render bounded mounted workspace trees")
  assert.match(code, /TREE_MAX_ENTRIES = 80/, "sandbox perception should bound the root tree")
  assert.match(code, /scan_tree\(\$mount_path, \$mount_path, 0, 30\)/, "sandbox perception should bound each mounted workspace tree")
  assert.match(code, /Prefer this mounted-workspace map before broad reconnaissance/, "sandbox guidance should discourage repeated reconnaissance")
  assert.match(code, /datamachine_code_remote_workspace_backend_should_handle/, "sandbox mode should use the mounted workspace backend")
  assert.match(code, /is_file\(\$sandbox_workspace_dir \. '\/.git'\)/, "sandbox setup should detect linked worktree mounts")
  assert.match(code, /linked_worktree_mount/, "sandbox setup should report linked worktree mounts as non-fatal diagnostics")
  assert.ok(code.indexOf("linked_worktree_mount") < code.indexOf("$sandbox_adopt_result = $sandbox_adopt_ability->execute"), "linked worktree mounts should be skipped before Data Machine workspace adoption")
  assert.match(code, /Do not invent alternate tool names such as read_file/, "sandbox guidance should prevent pseudo-tool aliases")
  assert.match(code, /\\"tool_policy\\":\{\\"mode\\":\\"allow\\",\\"tools\\":\[\\"workspace_read\\",\\"workspace_write\\",\\"workspace_edit\\"\]/, "sandbox agent tool policy should include only sandbox-visible runtime tool ids")
  assert.match(code, /For changes use workspace_write or workspace_edit/, "sandbox guidance should steer changes to tools that work without git")
  assert.match(code, /wp_codebox_import_sandbox_agent_bundles/, "sandbox setup should import declared runtime agent bundles")
  assert.match(code, /apply_filters\('wp_agent_runtime_import_bundle'/, "sandbox setup should delegate bundle imports through the generic runtime hook")
  assert.doesNotMatch(code, /wp_get_ability\('datamachine\/import-agent'\)/, "sandbox setup should not call the Data Machine import ability directly")
  assert.match(code, /agent_bundle_imports/, "sandbox setup should report agent bundle import results")
  assert.match(code, /agent_bundle_import_failed/, "sandbox setup should fail before chat when bundle imports fail")
  assert.ok(code.indexOf("wp_codebox_import_sandbox_agent_bundles") < code.indexOf("wp_get_ability('agents/chat')"), "agent bundles should import before agents/chat is resolved")
  assert.doesNotMatch(code, /DataMachine\\Core\\Database\\Agents\\Agents/, "sandbox setup should not create Data Machine agent rows directly")
  assert.doesNotMatch(code, /create_if_missing/, "sandbox setup should leave Data Machine materialization to its runtime import adapter")
  assert.match(code, /repair-agent/, "inline bundle specs should be embedded in sandbox setup")

  const recipeSpec = await recipeExecutionSpec(
    {
      command: "wp-codebox.agent-sandbox-run",
      args: [
        "task=Inspect the mounted repo",
        "agent=sandbox-agent",
        "sandbox-tool-policy-json=" + JSON.stringify({
          schema: "wp-codebox/sandbox-tool-policy/v1",
          version: 1,
          tools: [
            { id: "datamachine/workspace-read", runtime_tool_id: "workspace_read", execution_location: "sandbox", transport_visibility: "sandbox", allowed: true },
          ],
          metadata: { source: "smoke" },
        }),
      ],
    },
    process.cwd(),
    sandboxWorkspace,
  )
  const recipeCodeArg = recipeSpec.args.find((arg) => arg.startsWith("code=")) ?? ""
  assert.match(recipeCodeArg, /wp-codebox@fix-issue-533-mounted-workspace-perception/, "recipe-generated sandbox code should include mounted workspace handle")
  assert.match(recipeCodeArg, /\/workspace\/wp-codebox/, "recipe-generated sandbox code should include mounted workspace path")
  assert.match(recipeCodeArg, /Automattic\/wp-codebox/, "recipe-generated sandbox code should include mounted workspace repo")
  assert.match(recipeCodeArg, /\\"mode\\":\\"readwrite\\"/, "recipe-generated sandbox code should include mounted workspace mode")

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
