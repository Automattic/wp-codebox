import assert from "node:assert/strict"

import * as core from "@automattic/wp-codebox-core"
import * as contracts from "@automattic/wp-codebox-core/contracts"
import * as phpSnippets from "@automattic/wp-codebox-core/php-snippets"

for (const entrypoint of [core, contracts]) {
  assert.equal(typeof entrypoint.runtimeContractManifest, "function")
  const manifest = entrypoint.runtimeContractManifest()

  assert.equal(manifest.schema, "wp-codebox/runtime-contract-manifest/v1")
  assert.equal(manifest.schemas.agentTask.runRequest, "wp-codebox/agent-task-run-request/v1")
  assert.equal(manifest.providerRuntime.tasks.workspaceCommand, "wp-codebox.runner-workspace.command")
}

assert.equal(typeof phpSnippets.phpRuntimeComponentLifecycleReplayFunction, "function")
assert.equal(typeof phpSnippets.phpRuntimeRecipePluginPreloadFunction, "function")

console.log("runtime contract package exports ok")
