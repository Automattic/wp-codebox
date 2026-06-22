import assert from "node:assert/strict"

import {
  AGENT_TASK_RUN_RESULT_SCHEMA,
  ARTIFACT_RESULT_ENVELOPE_SCHEMA,
  CODEBOX_RUN_RUNTIME_PACKAGE_ABILITY,
  FANOUT_AGGREGATION_INPUT_SCHEMA,
  FANOUT_AGGREGATION_OUTPUT_SCHEMA,
  PARENT_TOOL_BRIDGE_SCHEMA,
  PARENT_TOOL_REQUEST_SCHEMA,
  PARENT_TOOL_RESULT_SCHEMA,
  PROVIDER_CREDENTIAL_PREFLIGHT_SCHEMA,
  PROVIDER_CREDENTIAL_REQUIREMENTS_SCHEMA,
  PROVIDER_CREDENTIAL_RESOLUTION_SCHEMA,
  PROVIDER_RUNTIME_INVOCATION_CONTRACT_SCHEMA,
  RUNTIME_CONTRACT_MANIFEST_SCHEMA,
  RUNTIME_CONTRACT_NORMALIZERS,
  RUNTIME_CONTRACT_SCHEMAS,
  RUNTIME_PACKAGE_ARTIFACT_DECLARATION_SCHEMA,
  RUNTIME_PACKAGE_EXECUTION_INPUT_SCHEMA,
  RUNTIME_PACKAGE_EXECUTION_RESULT_SCHEMA,
  RUNTIME_PACKAGE_OUTPUT_PROJECTION_SCHEMA,
  RUNTIME_PROFILE_SCHEMA,
  RUNNER_WORKSPACE_BACKEND_ABILITY_KEYS,
  RUNNER_WORKSPACE_BACKEND_FILTER,
  RUNNER_WORKSPACE_CAPTURE_RESULT_SCHEMA,
  RUNNER_WORKSPACE_COMMAND_RESULT_SCHEMA,
  RUNNER_WORKSPACE_PREPARE_RESULT_SCHEMA,
  RUNNER_WORKSPACE_PUBLICATION_RESULT_SCHEMA,
  WORDPRESS_RUNTIME_DISCOVERY_SCHEMA,
  isRuntimeContractSchema,
  normalizeRuntimeContractSchema,
  providerRuntimeInvocationContract,
  runtimeContractManifest,
  runtimeContractSchemaValues,
} from "../packages/runtime-core/src/index.js"

const manifest = runtimeContractManifest()

assert.equal(manifest.schema, RUNTIME_CONTRACT_MANIFEST_SCHEMA)
assert.equal(manifest.version, 1)
assert.deepEqual(manifest.schemas, RUNTIME_CONTRACT_SCHEMAS)
assert.deepEqual(manifest.abilities, { runRuntimePackage: CODEBOX_RUN_RUNTIME_PACKAGE_ABILITY })
assert.deepEqual(manifest.providerRuntime, providerRuntimeInvocationContract())
assert.deepEqual(manifest.runnerWorkspaceBackend, {
  filter: RUNNER_WORKSPACE_BACKEND_FILTER,
  abilityKeys: RUNNER_WORKSPACE_BACKEND_ABILITY_KEYS,
})

assert.equal(manifest.schemas.providerRuntime.invocation, PROVIDER_RUNTIME_INVOCATION_CONTRACT_SCHEMA)
assert.equal(manifest.schemas.providerRuntime.credentialRequirements, PROVIDER_CREDENTIAL_REQUIREMENTS_SCHEMA)
assert.equal(manifest.schemas.providerRuntime.credentialPreflight, PROVIDER_CREDENTIAL_PREFLIGHT_SCHEMA)
assert.equal(manifest.schemas.providerRuntime.credentialResolution, PROVIDER_CREDENTIAL_RESOLUTION_SCHEMA)
assert.equal(manifest.schemas.agentTask.runResult, AGENT_TASK_RUN_RESULT_SCHEMA)
assert.equal(manifest.schemas.runtimeBoundary.profile, RUNTIME_PROFILE_SCHEMA)
assert.equal(manifest.schemas.artifact.resultEnvelope, ARTIFACT_RESULT_ENVELOPE_SCHEMA)
assert.equal(manifest.schemas.artifact.runtimePackageDeclaration, RUNTIME_PACKAGE_ARTIFACT_DECLARATION_SCHEMA)
assert.equal(manifest.schemas.artifact.runtimePackageProjection, RUNTIME_PACKAGE_OUTPUT_PROJECTION_SCHEMA)
assert.equal(manifest.schemas.runtimePackage.executionInput, RUNTIME_PACKAGE_EXECUTION_INPUT_SCHEMA)
assert.equal(manifest.schemas.runtimePackage.executionResult, RUNTIME_PACKAGE_EXECUTION_RESULT_SCHEMA)
assert.equal(manifest.schemas.runnerWorkspace.prepareResult, RUNNER_WORKSPACE_PREPARE_RESULT_SCHEMA)
assert.equal(manifest.schemas.runnerWorkspace.captureResult, RUNNER_WORKSPACE_CAPTURE_RESULT_SCHEMA)
assert.equal(manifest.schemas.runnerWorkspace.commandResult, RUNNER_WORKSPACE_COMMAND_RESULT_SCHEMA)
assert.equal(manifest.schemas.runnerWorkspace.publicationResult, RUNNER_WORKSPACE_PUBLICATION_RESULT_SCHEMA)
assert.equal(manifest.schemas.parentToolBridge.bridge, PARENT_TOOL_BRIDGE_SCHEMA)
assert.equal(manifest.schemas.parentToolBridge.request, PARENT_TOOL_REQUEST_SCHEMA)
assert.equal(manifest.schemas.parentToolBridge.result, PARENT_TOOL_RESULT_SCHEMA)
assert.equal(RUNNER_WORKSPACE_BACKEND_FILTER, "wp_codebox_runner_workspace_backend")
assert.deepEqual(RUNNER_WORKSPACE_BACKEND_ABILITY_KEYS, [
  "workspace_adopt",
  "workspace_show",
  "workspace_clone",
  "workspace_worktree_add",
  "workspace_git_status",
  "workspace_git_diff",
  "run_runner_workspace_command",
  "publish_runner_workspace",
])
assert.equal(manifest.schemas.fanoutAggregation.input, FANOUT_AGGREGATION_INPUT_SCHEMA)
assert.equal(manifest.schemas.fanoutAggregation.output, FANOUT_AGGREGATION_OUTPUT_SCHEMA)
assert.equal(manifest.schemas.wordpressRuntimeDiscovery.result, WORDPRESS_RUNTIME_DISCOVERY_SCHEMA)

const values = runtimeContractSchemaValues()
assert.equal(new Set(values).size, values.length, "runtime contract schema constants must be unique")
assert.equal(isRuntimeContractSchema(RUNTIME_PROFILE_SCHEMA), true)
assert.equal(normalizeRuntimeContractSchema(ARTIFACT_RESULT_ENVELOPE_SCHEMA), ARTIFACT_RESULT_ENVELOPE_SCHEMA)
assert.throws(() => normalizeRuntimeContractSchema("example/unknown/v1"), /Unknown WP Codebox runtime contract schema/)

assert.equal(RUNTIME_CONTRACT_NORMALIZERS.agentTaskRunResult({ status: "completed", success: true }).schema, AGENT_TASK_RUN_RESULT_SCHEMA)
assert.equal(RUNTIME_CONTRACT_NORMALIZERS.artifactResultEnvelope({ success: true, result: { artifact_ref: { kind: "bundle", path: "artifacts/run" } } }).schema, ARTIFACT_RESULT_ENVELOPE_SCHEMA)
assert.equal(RUNTIME_CONTRACT_NORMALIZERS.runtimeProfile({ schema: RUNTIME_PROFILE_SCHEMA, components: [] }).schema, RUNTIME_PROFILE_SCHEMA)
assert.equal(RUNTIME_CONTRACT_NORMALIZERS.fanoutAggregationInput({ plan: { workers: [] } }).schema, FANOUT_AGGREGATION_INPUT_SCHEMA)
assert.equal(RUNTIME_CONTRACT_NORMALIZERS.fanoutAggregationOutput({ plan: { workers: [] } }).schema, FANOUT_AGGREGATION_OUTPUT_SCHEMA)

assert.doesNotMatch(JSON.stringify(manifest), /datamachine|data machine|homeboy|wpsg|wp-site-generator|wp site generator/i)

console.log("runtime contract manifest ok")
