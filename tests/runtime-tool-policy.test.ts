import assert from "node:assert/strict"
import { assertSandboxToolPolicySnapshot, resolveEffectiveRuntimeToolPolicy, resolveRuntimeToolAlias, runtimeMetadataForExecutionLocation, runtimeToolInputFromSandboxToolPolicy, sandboxAllowedRuntimeToolIds, sandboxToolPolicyFromAllowedTools, toolBridgeFromSandboxToolPolicy, type SandboxToolPolicySnapshot } from "../packages/runtime-core/src/index.js"

const policy: SandboxToolPolicySnapshot = {
  schema: "wp-codebox/sandbox-tool-policy/v1",
  version: 1,
  tools: [
    {
      id: "filesystem-write",
      runtime_tool_id: "client/filesystem-write",
      aliases: ["filesystem_write"],
      execution_location: "sandbox",
      transport_visibility: "sandbox",
      allowed: true,
      runtime: { environment: "runtime_local", capability_scope: "runtime_local" },
      metadata: {
        schema: "example/input/v1",
        aliases: ["write_file"],
        policy: { permission: "write" },
      },
    },
    {
      id: "browser-review",
      runtime_tool_id: "client/browser-review",
      execution_location: "parent",
      transport_visibility: "parent",
      allowed: true,
      runtime: { environment: "control_plane", capability_scope: "control_plane" },
    },
    {
      id: "internal-token",
      runtime_tool_id: "client/internal-token",
      execution_location: "sandbox",
      transport_visibility: "hidden",
      allowed: true,
      runtime: { environment: "runtime_local", capability_scope: "runtime_local" },
    },
  ],
  metadata: { source: "runtime-tool-policy.test" },
}

const effective = resolveEffectiveRuntimeToolPolicy(policy)
assert.deepEqual(effective.allowedRuntimeToolIds, ["client/filesystem-write"])
assert.deepEqual(effective.visibleRuntimeToolIds, ["client/filesystem-write"])
assert.deepEqual(effective.parentOnlyRuntimeToolIds, ["client/browser-review"])
assert.deepEqual(effective.hiddenRuntimeToolIds, ["client/internal-token"])

const writeTool = resolveRuntimeToolAlias(effective, "filesystem_write")
assert.equal(writeTool?.runtimeToolId, "client/filesystem-write")
assert.equal(writeTool?.schema, "example/input/v1")
assert.deepEqual(writeTool?.policy, { permission: "write" })
assert.equal(resolveRuntimeToolAlias(effective, "write_file")?.runtimeToolId, "client/filesystem-write")
assert.equal(resolveRuntimeToolAlias(policy, "client/browser-review")?.parentOnly, true)

assert.deepEqual(sandboxAllowedRuntimeToolIds(policy), ["client/filesystem-write"])

assert.deepEqual(runtimeToolInputFromSandboxToolPolicy(policy).allowed_tools, ["client/filesystem-write"])
assert.deepEqual(runtimeToolInputFromSandboxToolPolicy(policy).runtime_tools.map((tool) => tool.id), ["filesystem-write"])
assert.deepEqual(runtimeMetadataForExecutionLocation("sandbox"), { environment: "runtime_local", capability_scope: "runtime_local" })
assert.deepEqual(runtimeMetadataForExecutionLocation("parent"), { environment: "control_plane", capability_scope: "control_plane" })
assert.equal(runtimeMetadataForExecutionLocation("external"), undefined)

const contradictoryPolicy = structuredClone(policy)
contradictoryPolicy.tools[1].runtime = { environment: "runtime_local", capability_scope: "runtime_local" }
assert.throws(() => assertSandboxToolPolicySnapshot(contradictoryPolicy), /must be control_plane for parent tools/)
const invalidLocationPolicy = structuredClone(policy)
invalidLocationPolicy.tools[0].execution_location = "external"
assert.throws(() => assertSandboxToolPolicySnapshot(invalidLocationPolicy), /must be sandbox or parent/)

const canonicalPolicy = sandboxToolPolicyFromAllowedTools(["workspace.read", "workspace.search", "workspace.write", "workspace.edit"], { source: "test" })
assert.equal(canonicalPolicy.schema, "wp-codebox/sandbox-tool-policy/v1")
assert.deepEqual(canonicalPolicy.tools.map((tool) => tool.id), ["workspace.read", "workspace.search", "workspace.write", "workspace.edit"])
assert.deepEqual(runtimeToolInputFromSandboxToolPolicy(canonicalPolicy).allowed_tools, ["workspace_read", "workspace_search", "workspace_write", "workspace_edit"])

const bridge = toolBridgeFromSandboxToolPolicy(policy, ["filesystem-write"])
assert.equal(bridge.schema, "wp-codebox/tool-bridge/v1")
assert.deepEqual(bridge.allowed_tools, ["filesystem-write"])
assert.equal(bridge.dispatcher.owner, "wp-codebox")
assert.equal(bridge.dispatcher.callback, "wp_codebox_browser_runtime_tool_callback")
assert.equal(bridge.authorization.mode, "allowlist")
assert.equal(bridge.sandbox_tool_policy.schema, "wp-codebox/sandbox-tool-policy/v1")

console.log("runtime tool policy passed")
