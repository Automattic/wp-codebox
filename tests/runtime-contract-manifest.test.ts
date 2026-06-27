import assert from "node:assert/strict"

import {
  AGENT_RUNTIME_WORKLOAD_SCHEMA,
  AGENT_TASK_RUN_REQUEST_SCHEMA,
  AGENT_TASK_RUN_RESULT_SCHEMA,
  ARTIFACT_BUNDLE_FILE_MANIFEST_SCHEMA,
  ARTIFACT_RESULT_ENVELOPE_SCHEMA,
  BROWSER_ARTIFACT_PERSISTENCE_REF_SCHEMA,
  BROWSER_CONTAINED_SITE_APPLY_PLAN_SCHEMA,
  BROWSER_CONTAINED_SITE_APPLY_RESULT_SCHEMA,
  BROWSER_CONTAINED_SITE_EXPORT_SCHEMA,
  BROWSER_CONTAINED_SITE_OPEN_SCHEMA,
  BROWSER_CONTAINED_SITE_SNAPSHOT_SCHEMA,
  BROWSER_CONTAINED_SITE_STATUS_SCHEMA,
  BROWSER_PREVIEW_BOOT_CONFIG_SCHEMA,
  BROWSER_SESSION_PRODUCT_DTO_SCHEMA,
  CODEBOX_PUBLIC_RUNTIME_CAPABILITIES,
  CODEBOX_PUBLIC_RUNTIME_ABILITIES,
  CODEBOX_RESOLVE_RUNTIME_REQUIREMENTS_ABILITY,
  CODEBOX_RUN_AGENT_TASK_ABILITY,
  CODEBOX_RUN_AGENT_TASK_BATCH_ABILITY,
  CODEBOX_RUN_AGENT_TASK_FANOUT_ABILITY,
  CODEBOX_RUN_FUZZ_SUITE_ABILITY,
  CODEBOX_RUN_RUNTIME_PACKAGE_ABILITY,
  CODEBOX_RUN_WORDPRESS_WORKLOAD_ABILITY,
  FANOUT_AGGREGATION_INPUT_SCHEMA,
  FANOUT_AGGREGATION_OUTPUT_SCHEMA,
  FUZZ_COVERAGE_PLAN_SCHEMA,
  FUZZ_SUITE_RESULT_SCHEMA,
  FUZZ_SUITE_SCHEMA,
  HOST_DELEGATION_EVENT_SCHEMA,
  HOST_DELEGATION_REQUEST_SCHEMA,
  HOST_DELEGATION_RESULT_SCHEMA,
  PARENT_TOOL_BRIDGE_SCHEMA,
  PARENT_TOOL_REQUEST_SCHEMA,
  PARENT_TOOL_RESULT_SCHEMA,
  PREVIEW_LEASE_SCHEMA,
  PROVIDER_CREDENTIAL_PREFLIGHT_SCHEMA,
  PROVIDER_CREDENTIAL_REQUIREMENTS_SCHEMA,
  PROVIDER_CREDENTIAL_RESOLUTION_SCHEMA,
  PROVIDER_RUNTIME_TASK_NAMES,
  PROVIDER_RUNTIME_INVOCATION_CONTRACT_SCHEMA,
  RUNTIME_CONTRACT_MANIFEST_SCHEMA,
  RUNTIME_CONTRACT_NORMALIZERS,
  RUNTIME_CONTRACT_SCHEMAS,
  RUNTIME_PACKAGE_ARTIFACT_DECLARATION_SCHEMA,
  RUNTIME_PACKAGE_EXECUTION_INPUT_SCHEMA,
  RUNTIME_PACKAGE_EXECUTION_RESULT_SCHEMA,
  RUNTIME_PACKAGE_OUTPUT_PROJECTION_SCHEMA,
  RUNTIME_PROFILE_SCHEMA,
  RUNTIME_DESCRIPTOR_SCHEMA,
  RUNTIME_RUN_RESULT_SCHEMA,
  WORDPRESS_REST_MATRIX_RESULT_SCHEMA,
  WORDPRESS_REST_MATRIX_SCHEMA,
  RUNNER_WORKSPACE_CAPTURE_RESULT_SCHEMA,
  RUNNER_WORKSPACE_COMMAND_RESULT_SCHEMA,
  RUNNER_WORKSPACE_PREPARE_RESULT_SCHEMA,
  RUNNER_WORKSPACE_PUBLICATION_RESULT_SCHEMA,
  WORDPRESS_BLOCK_EXERCISE_RESULT_SCHEMA,
  WORDPRESS_RUNTIME_DISCOVERY_SCHEMA,
  WORDPRESS_WORKLOAD_RUN_SCHEMA,
  isRuntimeContractSchema,
  normalizeRuntimeContractSchema,
  runtimeContractManifest,
  runtimeContractSchemaValues,
  runtimeDescriptor,
} from "../packages/runtime-core/src/index.js"

const manifest = runtimeContractManifest()
const descriptor = runtimeDescriptor()

assert.equal(manifest.schema, RUNTIME_CONTRACT_MANIFEST_SCHEMA)
assert.equal(manifest.version, 1)
assert.deepEqual(manifest.schemas, RUNTIME_CONTRACT_SCHEMAS)
assert.deepEqual(manifest.abilities, CODEBOX_PUBLIC_RUNTIME_ABILITIES)

assert.equal(manifest.schemas.agentTask.runRequest, AGENT_TASK_RUN_REQUEST_SCHEMA)
assert.equal(manifest.schemas.agentTask.runResult, AGENT_TASK_RUN_RESULT_SCHEMA)
assert.equal(manifest.schemas.agentTask.legacyRunResponse, AGENT_TASK_RUN_RESULT_SCHEMA)
assert.equal(manifest.schemas.runtimeBoundary.profile, RUNTIME_PROFILE_SCHEMA)
assert.equal(manifest.schemas.runtimeBoundary.previewLease, PREVIEW_LEASE_SCHEMA)
assert.equal(manifest.schemas.runtimeBoundary.browserSessionProductDto, BROWSER_SESSION_PRODUCT_DTO_SCHEMA)
assert.equal(manifest.schemas.browserSession.productDto, BROWSER_SESSION_PRODUCT_DTO_SCHEMA)
assert.equal(manifest.schemas.browserSession.containedSiteStatus, BROWSER_CONTAINED_SITE_STATUS_SCHEMA)
assert.equal(manifest.schemas.browserSession.containedSiteOpen, BROWSER_CONTAINED_SITE_OPEN_SCHEMA)
assert.equal(manifest.schemas.browserSession.previewBootConfig, BROWSER_PREVIEW_BOOT_CONFIG_SCHEMA)
assert.equal(manifest.schemas.browserSession.containedSiteSnapshot, BROWSER_CONTAINED_SITE_SNAPSHOT_SCHEMA)
assert.equal(manifest.schemas.browserSession.containedSiteExport, BROWSER_CONTAINED_SITE_EXPORT_SCHEMA)
assert.equal(manifest.schemas.browserSession.containedSiteApplyPlan, BROWSER_CONTAINED_SITE_APPLY_PLAN_SCHEMA)
assert.equal(manifest.schemas.browserSession.containedSiteApplyResult, BROWSER_CONTAINED_SITE_APPLY_RESULT_SCHEMA)
assert.equal(manifest.schemas.preview.lease, PREVIEW_LEASE_SCHEMA)
assert.equal(manifest.schemas.preview.reviewerAccess, "wp-codebox/preview-reviewer-access/v1")
assert.equal(manifest.schemas.artifact.resultEnvelope, ARTIFACT_RESULT_ENVELOPE_SCHEMA)
assert.equal(manifest.schemas.artifact.typedArtifact, "wp-codebox/structured-artifact/v1")
assert.equal(manifest.schemas.artifact.typedArtifactIndex, "wp-codebox/typed-artifacts-index/v1")
assert.equal(manifest.schemas.artifact.runtimePackageDeclaration, RUNTIME_PACKAGE_ARTIFACT_DECLARATION_SCHEMA)
assert.equal(manifest.schemas.artifact.runtimePackageProjection, RUNTIME_PACKAGE_OUTPUT_PROJECTION_SCHEMA)
assert.equal(manifest.schemas.artifact.bundleFileManifest, ARTIFACT_BUNDLE_FILE_MANIFEST_SCHEMA)
assert.equal(manifest.schemas.artifact.browserArtifactPersistenceRef, BROWSER_ARTIFACT_PERSISTENCE_REF_SCHEMA)
assert.equal(manifest.schemas.artifactBundle.resultEnvelope, ARTIFACT_RESULT_ENVELOPE_SCHEMA)
assert.equal(manifest.schemas.artifactBundle.fileManifest, ARTIFACT_BUNDLE_FILE_MANIFEST_SCHEMA)
assert.equal(manifest.schemas.artifactBundle.browserPersistenceRef, BROWSER_ARTIFACT_PERSISTENCE_REF_SCHEMA)
assert.equal(manifest.schemas.taskState.agentTaskRunResult, AGENT_TASK_RUN_RESULT_SCHEMA)
assert.equal(manifest.schemas.taskState.runtimeRunResult, RUNTIME_RUN_RESULT_SCHEMA)
assert.equal(manifest.schemas.taskState.agentRuntimeWorkload, AGENT_RUNTIME_WORKLOAD_SCHEMA)
assert.equal(manifest.schemas.runtimeProvider.invocationContract, PROVIDER_RUNTIME_INVOCATION_CONTRACT_SCHEMA)
assert.equal(manifest.schemas.runtimeProvider.credentialRequirements, PROVIDER_CREDENTIAL_REQUIREMENTS_SCHEMA)
assert.equal(manifest.schemas.runtimeProvider.credentialPreflight, PROVIDER_CREDENTIAL_PREFLIGHT_SCHEMA)
assert.equal(manifest.schemas.runtimeProvider.credentialResolution, PROVIDER_CREDENTIAL_RESOLUTION_SCHEMA)
assert.equal(manifest.schemas.providerRuntime.invocationContract, PROVIDER_RUNTIME_INVOCATION_CONTRACT_SCHEMA)
assert.equal(manifest.schemas.providerRuntime.invocation, PROVIDER_RUNTIME_INVOCATION_CONTRACT_SCHEMA)
assert.equal(manifest.schemas.providerRuntime.credentialRequirements, PROVIDER_CREDENTIAL_REQUIREMENTS_SCHEMA)
assert.equal(manifest.schemas.providerRuntime.credentialPreflight, PROVIDER_CREDENTIAL_PREFLIGHT_SCHEMA)
assert.equal(manifest.schemas.providerRuntime.credentialResolution, PROVIDER_CREDENTIAL_RESOLUTION_SCHEMA)
assert.equal(manifest.schemas.hostDelegation.request, HOST_DELEGATION_REQUEST_SCHEMA)
assert.equal(manifest.schemas.hostDelegation.result, HOST_DELEGATION_RESULT_SCHEMA)
assert.equal(manifest.schemas.hostDelegation.event, HOST_DELEGATION_EVENT_SCHEMA)
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
assert.equal(manifest.schemas.wordpressRuntime.workloadRun, WORDPRESS_WORKLOAD_RUN_SCHEMA)
assert.equal(manifest.schemas.wordpressRuntime.fuzzCoveragePlan, FUZZ_COVERAGE_PLAN_SCHEMA)
assert.equal(manifest.schemas.wordpressRuntime.fuzzSuite, FUZZ_SUITE_SCHEMA)
assert.equal(manifest.schemas.wordpressRuntime.fuzzSuiteResult, FUZZ_SUITE_RESULT_SCHEMA)
assert.equal(manifest.schemas.wordpressRuntime.blockExerciseResult, WORDPRESS_BLOCK_EXERCISE_RESULT_SCHEMA)
assert.equal(manifest.abilities.agentTask.run, CODEBOX_RUN_AGENT_TASK_ABILITY)
assert.equal(manifest.abilities.agentTask.batch, CODEBOX_RUN_AGENT_TASK_BATCH_ABILITY)
assert.equal(manifest.abilities.agentTask.fanout, CODEBOX_RUN_AGENT_TASK_FANOUT_ABILITY)
assert.equal("aliases" in manifest.abilities.agentTask, false)
assert.equal(manifest.abilities.runtimePackage.run, CODEBOX_RUN_RUNTIME_PACKAGE_ABILITY)
assert.equal(manifest.abilities.runtimeRequirements.resolve, CODEBOX_RESOLVE_RUNTIME_REQUIREMENTS_ABILITY)
assert.equal(manifest.abilities.wordpressRuntime.runWorkload, CODEBOX_RUN_WORDPRESS_WORKLOAD_ABILITY)
assert.equal(manifest.abilities.wordpressRuntime.runFuzzSuite, CODEBOX_RUN_FUZZ_SUITE_ABILITY)
assert.equal(manifest.providerRuntime.schema, PROVIDER_RUNTIME_INVOCATION_CONTRACT_SCHEMA)
assert.deepEqual(manifest.providerRuntime.tasks, PROVIDER_RUNTIME_TASK_NAMES)
assert.equal(manifest.providerRuntime.tasks.workspaceCommand, "wp-codebox.runner-workspace.command")
assert.equal(manifest.providerRuntime.result_schemas.artifact_result_envelope, ARTIFACT_RESULT_ENVELOPE_SCHEMA)

const values = runtimeContractSchemaValues()
assert.equal(new Set(values).size, values.length, "runtime contract schema constants must be unique")
assert.equal(isRuntimeContractSchema(RUNTIME_PROFILE_SCHEMA), true)
assert.equal(normalizeRuntimeContractSchema(ARTIFACT_RESULT_ENVELOPE_SCHEMA), ARTIFACT_RESULT_ENVELOPE_SCHEMA)
assert.throws(() => normalizeRuntimeContractSchema("example/unknown/v1"), /Unknown WP Codebox runtime contract schema/)

assert.equal(RUNTIME_CONTRACT_NORMALIZERS.agentTaskRunResult({ status: "completed", success: true }).schema, AGENT_TASK_RUN_RESULT_SCHEMA)
assert.equal(RUNTIME_CONTRACT_NORMALIZERS.artifactResultEnvelope({ success: true, result: { artifact_ref: { kind: "bundle", path: "artifacts/run" } } }).schema, ARTIFACT_RESULT_ENVELOPE_SCHEMA)
assert.equal(RUNTIME_CONTRACT_NORMALIZERS.runtimeProfile({ schema: RUNTIME_PROFILE_SCHEMA, components: [] }).schema, RUNTIME_PROFILE_SCHEMA)
assert.equal(RUNTIME_CONTRACT_NORMALIZERS.previewReviewerAccess(undefined).status, "unavailable")
assert.equal(RUNTIME_CONTRACT_NORMALIZERS.typedArtifact({ name: "report", type: "json", path: "files/report.json", sha256: "a".repeat(64) })?.artifact.kind, "typed-artifact")
assert.equal(RUNTIME_CONTRACT_NORMALIZERS.typedArtifactIndex({ artifacts: [{ name: "report", type: "json", path: "files/report.json", sha256: "a".repeat(64) }] }).artifacts.length, 1)
assert.equal(RUNTIME_CONTRACT_NORMALIZERS.fanoutAggregationInput({ plan: { workers: [] } }).schema, FANOUT_AGGREGATION_INPUT_SCHEMA)
assert.equal(RUNTIME_CONTRACT_NORMALIZERS.fanoutAggregationOutput({ plan: { workers: [] } }).schema, FANOUT_AGGREGATION_OUTPUT_SCHEMA)
assert.equal(RUNTIME_CONTRACT_NORMALIZERS.fanoutAggregationOutputEnvelope(RUNTIME_CONTRACT_NORMALIZERS.fanoutAggregationOutput({ plan: { workers: [] } })).schema, FANOUT_AGGREGATION_OUTPUT_SCHEMA)

assert.equal(descriptor.schema, RUNTIME_DESCRIPTOR_SCHEMA)
assert.equal(descriptor.readiness.status, "available")
assert.equal(descriptor.readiness.publicApi, true)
assert.equal(descriptor.readiness.contractManifest, true)
assert.deepEqual(descriptor.capabilities, CODEBOX_PUBLIC_RUNTIME_CAPABILITIES)
assert.ok(descriptor.capabilities.includes("runtime-requirements:resolve"))
assert.deepEqual(descriptor.abilities, CODEBOX_PUBLIC_RUNTIME_ABILITIES)
assert.deepEqual(descriptor.contractManifest, manifest)

assert.doesNotMatch(JSON.stringify(manifest), /datamachine|data machine|homeboy|wpsg|wp-site-generator|wp site generator/i)
assert.doesNotMatch(JSON.stringify(manifest), /agents\/run-runtime-package|wp_codebox_runner_workspace_backend|workspace_worktree_add/i)
assert.doesNotMatch(JSON.stringify(descriptor), /packages\/runtime-core\/dist|package-lock|node_modules|worktree|cache layout/i)

console.log("runtime contract manifest ok")
