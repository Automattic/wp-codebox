import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildAgentRuntimeDiagnostics } from "../packages/cli/src/commands/agent-task-run.js"

const directory = await mkdtemp(join(tmpdir(), "wp-codebox-agent-runtime-diagnostics-"))

try {
  const metadataPath = join(directory, "metadata.json")
  await writeFile(metadataPath, `${JSON.stringify({
    context: {
      preparedComponentContracts: [{ slug: "sample-runtime", requestedPath: "/host/sample-runtime", preparedPath: "/tmp/prepared-plugins/sample-runtime", pluginFile: "sample-runtime/sample-runtime.php", loadAs: "mu-plugin", activate: true, status: "prepared" }],
      preparedWorkspaces: [{ target: "/workspace/sample-runtime", mode: "readwrite", metadata: { repo: "sample-runtime" } }],
      preparedStagedFiles: [{ sourceRef: "bundle.json", target: "/workspace/bundle.json", type: "file" }],
      preparedRuntimeOverlays: [{ target: "/wordpress/wp-content/mu-plugins/runtime.php", type: "file", mode: "readonly" }],
      recipe: { inputs: { component_contracts: [{ slug: "sample-runtime", path: "/host/sample-runtime", loadAs: "mu-plugin", activate: true }] } },
    },
  }, null, 2)}\n`)

  const sandboxPayload = {
    agent_runtime: {
      success: false,
      input: {
        allow_only: ["workspace.read", "workspace.grep"],
        tool_policy: { mode: "allow", tools: ["workspace.grep", "workspace.read"] },
      },
      stack: {
        plugins: {
          "sample-runtime/sample-runtime.php": { active: true, load_as: "mu-plugin", error: null },
        },
        signals: {
          provider_plugins: ["ai-provider-for-opencode/ai-provider-for-opencode.php"],
          provider_plugin_files: [{ slug: "ai-provider-for-opencode", plugin_file: "ai-provider-for-opencode/ai-provider-for-opencode.php", mounted_path: "/wordpress/wp-content/mu-plugins/wp-codebox-runtime/ai-provider-for-opencode/ai-provider-for-opencode.php", load_as: "mu-plugin", mounted: true }],
        },
        abilities: { count: 2, ids: ["agents/chat", "sample-runtime/run"], requested: "agents/chat", requested_available: true },
      },
      error: { code: "expected-test-error", message: "synthetic" },
    },
  }

  const summary = await buildAgentRuntimeDiagnostics({
    artifacts: { metadataPath },
    componentContracts: [{ slug: "sample-runtime", requestedPath: "/host/sample-runtime", preparedPath: "/tmp/prepared-plugins/sample-runtime", pluginFile: "sample-runtime/sample-runtime.php", loadAs: "mu-plugin", activationStatus: "loaded", status: "loaded" }],
    phaseEvidence: [{ name: "mount_plugins", status: "completed", data: { count: 2 } }, { name: "activate_plugins", status: "completed" }],
    executions: [
      { recipePhase: "setup", recipeCommand: "extra-plugin.install-mu-loader", command: "wordpress.run-php", exitCode: 0 },
      { recipePhase: "run", recipeCommand: "wp-codebox.agent-sandbox-run", command: "wordpress.run-php", exitCode: 1, stdout: JSON.stringify(sandboxPayload) },
    ],
  }, {
    sandbox_tool_policy: {
      schema: "wp-codebox/sandbox-tool-policy/v1",
      version: 1,
      metadata: {},
      tools: [
        { id: "read", runtime_tool_id: "workspace.read", execution_location: "sandbox", transport_visibility: "sandbox", allowed: true, runtime: { environment: "runtime_local", capability_scope: "runtime_local" } },
        { id: "grep", runtime_tool_id: "workspace.grep", execution_location: "sandbox", transport_visibility: "sandbox", allowed: true, runtime: { environment: "runtime_local", capability_scope: "runtime_local" } },
        { id: "write", runtime_tool_id: "workspace.write", execution_location: "sandbox", transport_visibility: "sandbox", allowed: false, runtime: { environment: "runtime_local", capability_scope: "runtime_local" } },
      ],
    },
  })

  assert.equal(summary.schema, "wp-codebox/agent-runtime-diagnostics/v1")
  assert.match(JSON.stringify(summary.component_contracts), /sample-runtime/)
  assert.match(JSON.stringify(summary.prepared_paths), /prepared-plugins/)
  assert.match(JSON.stringify(summary.loader_entries), /ai-provider-for-opencode/)
  assert.match(JSON.stringify(summary.loaded_entrypoints), /sample-runtime.php/)
  assert.match(JSON.stringify(summary.lifecycle_actions), /mount_plugins/)
  assert.deepEqual(summary.registered_abilities, { count: 2, ids: ["agents/chat", "sample-runtime/run"], requested: "agents/chat", requested_available: true })
  assert.deepEqual(summary.resolved_tool_ids, { before_filtering: ["workspace.read", "workspace.grep", "workspace.write"], after_filtering: ["workspace.grep", "workspace.read"] })

  console.log("agent-runtime-diagnostics-summary-smoke: ok")
} finally {
  await rm(directory, { recursive: true, force: true })
}
