import assert from "node:assert/strict"
import { resolveEffectiveRuntimeToolPolicy, resolveRuntimeToolAlias, sandboxAllowedRuntimeToolIds, type SandboxToolPolicySnapshot } from "../packages/runtime-core/src/index.js"

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

console.log("runtime tool policy passed")
