import assert from "node:assert/strict"
import { recipeExecutionSpec } from "../packages/cli/src/agent-sandbox.ts"
import { agentSandboxRunCode, resolveSandboxTaskCode } from "../packages/cli/src/agent-code.ts"

async function main() {
  const explicitInlineCode = await resolveSandboxTaskCode({
    task: "Run explicit code",
    agent: "sandbox-agent",
    code: "echo 'explicit';",
  })
  assert.equal(explicitInlineCode, "echo 'explicit';", "explicit sandbox code should take precedence over generated agent chat code")

  const explicitFileCode = await resolveSandboxTaskCode({
    task: "Run explicit code file",
    agent: "sandbox-agent",
    codeFile: "scripts/agent-sandbox-code-smoke.ts",
  })
  assert.match(explicitFileCode, /resolveSandboxTaskCode/, "explicit sandbox code files should take precedence over generated agent chat code")

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
        { id: "datamachine/workspace-read", runtime_tool_id: "workspace_read", execution_location: "sandbox", transport_visibility: "sandbox", allowed: true, runtime: { environment: "runtime_local", capability_scope: "runtime_local" } },
        { id: "datamachine/workspace-write", runtime_tool_id: "workspace_write", execution_location: "sandbox", transport_visibility: "sandbox", allowed: true, runtime: { environment: "runtime_local", capability_scope: "runtime_local" } },
        { id: "datamachine/workspace-edit", runtime_tool_id: "workspace_edit", execution_location: "sandbox", transport_visibility: "sandbox", allowed: true, runtime: { environment: "runtime_local", capability_scope: "runtime_local" } },
        { id: "datamachine/workspace-git-status", runtime_tool_id: "workspace_git_status", execution_location: "parent", transport_visibility: "parent", allowed: false, runtime: { environment: "control_plane", capability_scope: "control_plane" } },
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
  assert.match(code, /agents_chat_runtime_principal_permission/, "sandbox chat should authorize through Agents API runtime-principal permission")
  assert.match(code, /AgentsAPI\\AI\\WP_Agent_Execution_Principal/, "sandbox chat should emit a valid namespaced runtime principal class reference")
  assert.doesNotMatch(code, /AgentsAPIAIWP_Agent_Execution_Principal/, "sandbox chat should not collapse namespaced runtime principal references")
  assert.doesNotMatch(code, /DataMachine\\/, "sandbox chat should not emit Data Machine class references")
  assert.doesNotMatch(code, /PermissionHelper::run_as_authenticated/, "sandbox chat should leave runtime authentication to mounted components")
  assert.doesNotMatch(code, /datamachine-code\/workspace-adopt/, "sandbox setup should leave workspace adoption to mounted components")
  assert.doesNotMatch(code, /datamachine\/workspace-adopt/, "sandbox setup should not call legacy Data Machine workspace adoption")
  assert.doesNotMatch(code, /DataMachineAbilitiesPermissionHelper/, "sandbox chat should not collapse namespaced PermissionHelper references")
  assert.doesNotMatch(code, /datamachine_agent_mode_sandbox/, "sandbox chat should not depend on Data Machine agent mode filters")
  assert.doesNotMatch(code, /WP_Codebox_Sandbox_Perception_Directive/, "sandbox chat should not register Data Machine directives")
  assert.match(code, /WP Codebox sandbox workspace guidance/, "sandbox agent message should include Codebox-owned workspace guidance")
  assert.match(code, /current repository root: \/workspace\/wp-codebox/, "sandbox guidance should name the default mounted repo root")
  assert.match(code, /Available workspace tools: `workspace_read`, `workspace_write`, `workspace_edit`/, "sandbox guidance should name available workspace tools")
  assert.match(code, /Use the exact mounted target from this context when the task refers to the repo, workspace, or project/, "sandbox guidance should prefer exact mounted targets")
  assert.match(code, /Make the needed workspace tool calls before your final answer/, "sandbox guidance should require completing workspace inspection before final answers")
  assert.match(code, /Final answers should report completed inspection results/, "sandbox guidance should discourage future-step final answers")
  assert.match(code, /report the workspace root you verified and the sandbox capability needed for any deeper inspection/, "sandbox guidance should describe capability reporting")
  assert.ok(code.indexOf("WP Codebox sandbox workspace guidance") < code.indexOf("Fix duplicate code"), "sandbox guidance should precede the user task")
  assert.match(code, /sandbox_workspace/, "sandbox request should include mounted workspace context")
  assert.match(code, /default_workspace/, "sandbox request should include a default mounted workspace")
  assert.match(code, /wp-codebox@fix-issue-533-mounted-workspace-perception/, "sandbox context should include mounted workspace handle")
  assert.match(code, /\/workspace\/wp-codebox/, "sandbox context should include mounted workspace path")
  assert.match(code, /Automattic\/wp-codebox/, "sandbox context should include mounted workspace repo")
  assert.match(code, /\\"mode\\":\\"readwrite\\"/, "sandbox context should include mounted workspace mode")
  assert.doesNotMatch(code, /Mounted Workspaces/, "sandbox chat should leave mounted workspace rendering to the generic runtime")
  assert.doesNotMatch(code, /Bounded tree/, "sandbox chat should not inject Data Machine directive tree output")
  assert.doesNotMatch(code, /datamachine_code_remote_workspace_backend_should_handle/, "sandbox mode should not hardcode Data Machine workspace backend filters")
  assert.doesNotMatch(code, /\$sandbox_workspace_adoptions/, "sandbox setup should not own runtime-specific workspace adoption")
  assert.doesNotMatch(code, /repo_backed_mount/, "sandbox setup should leave repo-backed mount handling to mounted components")
  assert.doesNotMatch(code, /data-machine\/data-machine\.php/, "sandbox setup should not hardcode Data Machine plugin activation")
  assert.doesNotMatch(code, /data-machine-code\/data-machine-code\.php/, "sandbox setup should not hardcode Data Machine Code plugin activation")
  assert.match(code, /\\"tool_policy\\":\{\\"mode\\":\\"allow\\",\\"tools\\":\[\\"workspace_read\\",\\"workspace_write\\",\\"workspace_edit\\"\]/, "sandbox agent tool policy should include only sandbox-visible runtime tool ids")
  assert.match(code, /wp_codebox_import_sandbox_agent_bundles/, "sandbox setup should import declared runtime agent bundles")
  assert.match(code, /wp_agent_import_runtime_bundles/, "sandbox setup should consume the generic runtime bundle helper")
  assert.match(code, /apply_filters\('wp_agent_runtime_import_bundle'/, "sandbox setup should retain a generic runtime hook fallback")
  assert.doesNotMatch(code, /wp_get_ability\('datamachine\/import-agent'\)/, "sandbox setup should not call the Data Machine import ability directly")
  assert.match(code, /agent_bundle_imports/, "sandbox setup should report agent bundle import results")
  assert.match(code, /agent_bundle_import_failed/, "sandbox setup should fail before chat when bundle imports fail")
  assert.ok(code.indexOf("wp_codebox_import_sandbox_agent_bundles") < code.indexOf("$ability = empty($sandbox_agent_bundle_import_failures)"), "agent bundles should import before the runtime ability is resolved")
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
            { id: "datamachine/workspace-read", runtime_tool_id: "workspace_read", execution_location: "sandbox", transport_visibility: "sandbox", allowed: true, runtime: { environment: "runtime_local", capability_scope: "runtime_local" } },
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
