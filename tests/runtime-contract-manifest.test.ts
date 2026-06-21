import assert from "node:assert/strict"

import {
  AGENT_TASK_RUN_RESULT_SCHEMA,
  ARTIFACT_RESULT_ENVELOPE_SCHEMA,
  FANOUT_AGGREGATION_INPUT_SCHEMA,
  FANOUT_AGGREGATION_OUTPUT_SCHEMA,
  PROVIDER_CREDENTIAL_PREFLIGHT_SCHEMA,
  PROVIDER_CREDENTIAL_REQUIREMENTS_SCHEMA,
  PROVIDER_CREDENTIAL_RESOLUTION_SCHEMA,
  PROVIDER_RUNTIME_INVOCATION_CONTRACT_SCHEMA,
  RUNTIME_CONTRACT_MANIFEST_SCHEMA,
  RUNTIME_CONTRACT_NORMALIZERS,
  RUNTIME_CONTRACT_SCHEMAS,
  RUNTIME_PROFILE_SCHEMA,
  RUNNER_WORKSPACE_CAPTURE_RESULT_SCHEMA,
  RUNNER_WORKSPACE_COMMAND_RESULT_SCHEMA,
  RUNNER_WORKSPACE_PREPARE_RESULT_SCHEMA,
  RUNNER_WORKSPACE_PUBLICATION_RESULT_SCHEMA,
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
assert.deepEqual(manifest.providerRuntime, providerRuntimeInvocationContract())

assert.equal(manifest.schemas.providerRuntime.invocation, PROVIDER_RUNTIME_INVOCATION_CONTRACT_SCHEMA)
assert.equal(manifest.schemas.providerRuntime.credentialRequirements, PROVIDER_CREDENTIAL_REQUIREMENTS_SCHEMA)
assert.equal(manifest.schemas.providerRuntime.credentialPreflight, PROVIDER_CREDENTIAL_PREFLIGHT_SCHEMA)
assert.equal(manifest.schemas.providerRuntime.credentialResolution, PROVIDER_CREDENTIAL_RESOLUTION_SCHEMA)
assert.equal(manifest.schemas.agentTask.runResult, AGENT_TASK_RUN_RESULT_SCHEMA)
assert.equal(manifest.schemas.runtimeBoundary.profile, RUNTIME_PROFILE_SCHEMA)
assert.equal(manifest.schemas.artifact.resultEnvelope, ARTIFACT_RESULT_ENVELOPE_SCHEMA)
assert.equal(manifest.schemas.runnerWorkspace.prepareResult, RUNNER_WORKSPACE_PREPARE_RESULT_SCHEMA)
assert.equal(manifest.schemas.runnerWorkspace.captureResult, RUNNER_WORKSPACE_CAPTURE_RESULT_SCHEMA)
assert.equal(manifest.schemas.runnerWorkspace.commandResult, RUNNER_WORKSPACE_COMMAND_RESULT_SCHEMA)
assert.equal(manifest.schemas.runnerWorkspace.publicationResult, RUNNER_WORKSPACE_PUBLICATION_RESULT_SCHEMA)
assert.equal(manifest.schemas.fanoutAggregation.input, FANOUT_AGGREGATION_INPUT_SCHEMA)
assert.equal(manifest.schemas.fanoutAggregation.output, FANOUT_AGGREGATION_OUTPUT_SCHEMA)

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
