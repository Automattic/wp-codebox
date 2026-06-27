import assert from "node:assert/strict"

import * as core from "@automattic/wp-codebox-core"
import * as contracts from "@automattic/wp-codebox-core/contracts"
import * as phpSnippets from "@automattic/wp-codebox-core/php-snippets"

for (const entrypoint of [core, contracts]) {
  assert.equal(typeof entrypoint.runtimeContractManifest, "function")
  const manifest = entrypoint.runtimeContractManifest()

  assert.equal(manifest.schema, "wp-codebox/runtime-contract-manifest/v1")
  assert.equal(manifest.schemas.agentTask.runRequest, "wp-codebox/agent-task-run-request/v1")
  assert.equal(manifest.schemas.runtimePackage.task, "wp-codebox/runtime-package-task/v1")
  assert.equal(manifest.schemas.runtimePackage.result, "wp-codebox/runtime-package-result/v1")
  assert.equal(manifest.providerRuntime.tasks.workspaceCommand, "wp-codebox.runner-workspace.command")
}

assert.equal(contracts.RUNTIME_PACKAGE_TASK_SCHEMA, "wp-codebox/runtime-package-task/v1")
assert.equal(contracts.RUNTIME_PACKAGE_RESULT_SCHEMA, "wp-codebox/runtime-package-result/v1")
assert.equal(typeof contracts.normalizeRuntimePackageTask, "function")
assert.equal(typeof contracts.validateRuntimePackageTask, "function")

assert.equal(contracts.PERFORMANCE_OBSERVATION_SCHEMA, "wp-codebox/performance-observation/v1")
assert.equal(contracts.performanceObservation({ command: "wordpress.rest-performance-observation" }).schema, "wp-codebox/performance-observation/v1")

assert.equal(typeof phpSnippets.phpRuntimeComponentLifecycleReplayFunction, "function")
assert.equal(typeof phpSnippets.phpRuntimeRecipePluginPreloadFunction, "function")

assert.equal(contracts.WORDPRESS_RUNTIME_DISCOVERY_SCHEMA, "wp-codebox/wordpress-runtime-discovery/v1")
assert.equal(contracts.WORDPRESS_CRUD_OPERATION_SCHEMA, "wp-codebox/wordpress-crud-operation/v1")
assert.equal(contracts.WORDPRESS_DB_OPERATION_SCHEMA, "wp-codebox/wordpress-db-operation/v1")
assert.equal(contracts.WORDPRESS_HOTSPOTS_SCHEMA, "wp-codebox/wordpress-hotspots/v1")
assert.equal(contracts.MUTATION_ISOLATION_ARTIFACT_SCHEMA, "wp-codebox/mutation-isolation-artifact/v1")
assert.equal(contracts.DELETE_BOUNDARY_ARTIFACT_SCHEMA, "wp-codebox/delete-boundary-artifact/v1")
assert.equal(typeof contracts.wordpressRestMatrixContract, "function")
assert.equal(typeof contracts.restRouteInventoryToFuzzSuite, "function")
assert.equal(typeof contracts.performanceObservation, "function")
assert.equal(typeof contracts.wordpressHotspotsArtifact, "function")
assert.equal(typeof contracts.adminPageInventoryToFuzzSuite, "function")
assert.equal(typeof contracts.normalizeWordPressCrudOperation, "function")
assert.equal(typeof contracts.normalizeWordPressDbOperation, "function")

console.log("runtime contract package exports ok")
