import assert from "node:assert/strict"

import {
  AGENT_TASK_RUN_RESULT_SCHEMA,
  ARTIFACT_RESULT_ENVELOPE_SCHEMA,
  CODEBOX_PUBLIC_RUNTIME_ABILITIES,
  CODEBOX_RUN_AGENT_TASK_ABILITY,
  CODEBOX_RUN_AGENT_TASK_BATCH_ABILITY,
  CODEBOX_RUN_AGENT_TASK_FANOUT_ABILITY,
  CODEBOX_RUN_RUNTIME_PACKAGE_ABILITY,
  CODEBOX_RUN_SANDBOX_TASK_ABILITY,
  CODEBOX_RUN_SANDBOX_TASK_BATCH_ABILITY,
  CODEBOX_RUN_SANDBOX_TASK_FANOUT_ABILITY,
  FANOUT_AGGREGATION_INPUT_SCHEMA,
  FANOUT_AGGREGATION_OUTPUT_SCHEMA,
  PARENT_TOOL_BRIDGE_SCHEMA,
  PARENT_TOOL_REQUEST_SCHEMA,
  PARENT_TOOL_RESULT_SCHEMA,
  RUNTIME_CONTRACT_MANIFEST_SCHEMA,
  RUNTIME_CONTRACT_NORMALIZERS,
  RUNTIME_CONTRACT_SCHEMAS,
  RUNTIME_PACKAGE_ARTIFACT_DECLARATION_SCHEMA,
  RUNTIME_PACKAGE_EXECUTION_INPUT_SCHEMA,
  RUNTIME_PACKAGE_EXECUTION_RESULT_SCHEMA,
  RUNTIME_PACKAGE_OUTPUT_PROJECTION_SCHEMA,
  RUNTIME_PROFILE_SCHEMA,
  WORDPRESS_REST_MATRIX_RESULT_SCHEMA,
  WORDPRESS_REST_MATRIX_SCHEMA,
  RUNNER_WORKSPACE_CAPTURE_RESULT_SCHEMA,
  RUNNER_WORKSPACE_COMMAND_RESULT_SCHEMA,
  RUNNER_WORKSPACE_PREPARE_RESULT_SCHEMA,
  RUNNER_WORKSPACE_PUBLICATION_RESULT_SCHEMA,
  WORDPRESS_RUNTIME_DISCOVERY_SCHEMA,
  isRuntimeContractSchema,
  normalizeRuntimeContractSchema,
  runtimeContractManifest,
  runtimeContractSchemaValues,
} from "../packages/runtime-core/src/index.js"

const manifest = runtimeContractManifest()

assert.equal(manifest.schema, RUNTIME_CONTRACT_MANIFEST_SCHEMA)
assert.equal(manifest.version, 1)
assert.deepEqual(manifest.schemas, RUNTIME_CONTRACT_SCHEMAS)
assert.deepEqual(manifest.abilities, CODEBOX_PUBLIC_RUNTIME_ABILITIES)

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
assert.equal(manifest.schemas.fanoutAggregation.input, FANOUT_AGGREGATION_INPUT_SCHEMA)
assert.equal(manifest.schemas.fanoutAggregation.output, FANOUT_AGGREGATION_OUTPUT_SCHEMA)
assert.equal(manifest.schemas.wordpressRuntimeDiscovery.result, WORDPRESS_RUNTIME_DISCOVERY_SCHEMA)
assert.equal(manifest.schemas.wordpressRuntimeDiscovery.restMatrix, WORDPRESS_REST_MATRIX_SCHEMA)
assert.equal(manifest.schemas.wordpressRuntimeDiscovery.restMatrixResult, WORDPRESS_REST_MATRIX_RESULT_SCHEMA)
assert.equal(manifest.abilities.agentTask.run, CODEBOX_RUN_AGENT_TASK_ABILITY)
assert.equal(manifest.abilities.agentTask.batch, CODEBOX_RUN_AGENT_TASK_BATCH_ABILITY)
assert.equal(manifest.abilities.agentTask.fanout, CODEBOX_RUN_AGENT_TASK_FANOUT_ABILITY)
assert.equal(manifest.abilities.agentTask.aliases.runSandboxTask, CODEBOX_RUN_SANDBOX_TASK_ABILITY)
assert.equal(manifest.abilities.agentTask.aliases.runSandboxTaskBatch, CODEBOX_RUN_SANDBOX_TASK_BATCH_ABILITY)
assert.equal(manifest.abilities.agentTask.aliases.runSandboxTaskFanout, CODEBOX_RUN_SANDBOX_TASK_FANOUT_ABILITY)
assert.equal(manifest.abilities.runtimePackage.run, CODEBOX_RUN_RUNTIME_PACKAGE_ABILITY)

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
assert.doesNotMatch(JSON.stringify(manifest), /agents\/run-runtime-package|wp_codebox_runner_workspace_backend|workspace_worktree_add/i)

console.log("runtime contract manifest ok")
