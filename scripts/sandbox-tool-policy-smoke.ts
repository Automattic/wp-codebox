import assert from "node:assert/strict"
import {
  normalizeSandboxToolPolicySnapshot,
  sandboxAllowedRuntimeToolIds,
  sandboxToolRuntimeMetadata,
  validateSandboxToolPolicySnapshot,
} from "@automattic/wp-codebox-core"

const datamachineShapedSnapshot = {
  schema: "wp-codebox/sandbox-tool-policy/v1",
  version: 1,
  tools: [
    {
      id: "datamachine/workspace-read",
      runtime_tool_id: "workspace_read",
      execution_location: "sandbox",
      transport_visibility: "sandbox",
      allowed: true,
      runtime: {
        environment: "runtime_local",
        capability_scope: "runtime_local",
      },
      risk: "read",
      action: "workspace.read",
    },
    {
      id: "datamachine/workspace-git-push",
      runtime_tool_id: "workspace_git_push",
      execution_location: "parent",
      transport_visibility: "parent",
      allowed: false,
      runtime: {
        environment: "control_plane",
        capability_scope: "control_plane",
      },
      risk: "write-remote",
      action: "git.push",
    },
  ],
  metadata: { source: "data-machine-smoke" },
}

const genericSnapshot = {
  schema: "wp-codebox/sandbox-tool-policy/v1",
  version: 1,
  tools: [
    {
      id: "workspace.read",
      runtime_tool_id: "workspace_read",
      execution_location: "sandbox",
      transport_visibility: "both",
      allowed: true,
      risk: "read",
      action: "workspace.read",
    },
    {
      id: "deploy.production",
      runtime_tool_id: "deploy_production",
      execution_location: "parent",
      transport_visibility: "hidden",
      allowed: false,
      risk: "deploy",
      action: "deploy.production",
    },
  ],
  metadata: { source: "generic-smoke" },
}

const agentsApiRuntimeMetadataSnapshot = {
  schema: "wp-codebox/sandbox-tool-policy/v1",
  version: 1,
  tools: [
    {
      id: "client/filesystem_write",
      runtime_tool_id: "filesystem_write",
      execution_location: "parent",
      transport_visibility: "hidden",
      allowed: true,
      runtime: {
        environment: "runtime_local",
        capability_scope: "runtime_local",
      },
    },
    {
      id: "host/deploy_production",
      runtime_tool_id: "deploy_production",
      execution_location: "sandbox",
      transport_visibility: "both",
      allowed: true,
      runtime: {
        environment: "control_plane",
        capability_scope: "control_plane",
      },
    },
  ],
  metadata: { source: "agents-api-runtime-metadata-smoke" },
}

assert.equal(validateSandboxToolPolicySnapshot(datamachineShapedSnapshot).valid, true)
assert.deepEqual(sandboxAllowedRuntimeToolIds(normalizeSandboxToolPolicySnapshot(datamachineShapedSnapshot)), ["workspace_read"])
assert.deepEqual(sandboxToolRuntimeMetadata(normalizeSandboxToolPolicySnapshot(datamachineShapedSnapshot).tools[0]), { environment: "runtime_local", capability_scope: "runtime_local" })

assert.equal(validateSandboxToolPolicySnapshot(genericSnapshot).valid, true)
assert.deepEqual(sandboxAllowedRuntimeToolIds(normalizeSandboxToolPolicySnapshot(genericSnapshot)), ["workspace_read"])

assert.equal(validateSandboxToolPolicySnapshot(agentsApiRuntimeMetadataSnapshot).valid, true)
assert.deepEqual(sandboxAllowedRuntimeToolIds(normalizeSandboxToolPolicySnapshot(agentsApiRuntimeMetadataSnapshot)), ["filesystem_write"])

assert.equal(validateSandboxToolPolicySnapshot({}).valid, false)
