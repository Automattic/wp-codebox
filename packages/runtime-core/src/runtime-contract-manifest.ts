import { AGENT_TASK_RUN_RESULT_SCHEMA, normalizeAgentTaskRunResult, type AgentTaskRunResultSummary } from "./agent-task-run-result.js"
import { AGENT_RUNTIME_WORKLOAD_SCHEMA } from "./agent-runtime-workload.js"
import { ARTIFACT_RESULT_ENVELOPE_SCHEMA, normalizeArtifactResultEnvelope, type ArtifactResultEnvelope } from "./artifact-result-envelope.js"
import { FANOUT_AGGREGATION_INPUT_SCHEMA, FANOUT_AGGREGATION_OUTPUT_SCHEMA, aggregateFanoutOutputs, normalizeFanoutAggregationInput, type FanoutAggregationInput, type FanoutAggregationInputRequest, type FanoutAggregationOutput } from "./fanout-aggregation.js"
import { FUZZ_SUITE_RESULT_SCHEMA, FUZZ_SUITE_SCHEMA } from "./fuzz-suite-contracts.js"
import { HOST_DELEGATION_EVENT_SCHEMA, HOST_DELEGATION_REQUEST_SCHEMA, HOST_DELEGATION_RESULT_SCHEMA } from "./fanout-contracts.js"
import { ARTIFACT_BUNDLE_FILE_MANIFEST_SCHEMA, BROWSER_ARTIFACT_PERSISTENCE_REF_SCHEMA } from "./materialization-contracts.js"
import { PARENT_TOOL_BRIDGE_SCHEMA, PARENT_TOOL_REQUEST_SCHEMA, PARENT_TOOL_RESULT_SCHEMA } from "./parent-tool-bridge.js"
import { PROVIDER_CREDENTIAL_PREFLIGHT_SCHEMA, PROVIDER_CREDENTIAL_REQUIREMENTS_SCHEMA, PROVIDER_CREDENTIAL_RESOLUTION_SCHEMA, PROVIDER_RUNTIME_INVOCATION_CONTRACT_SCHEMA, providerRuntimeInvocationContract } from "./provider-runtime-contracts.js"
import { RUNTIME_RUN_RESULT_SCHEMA } from "./run-registry.js"
import { CODEBOX_RUN_RUNTIME_PACKAGE_ABILITY, RUNTIME_PACKAGE_ARTIFACT_DECLARATION_SCHEMA, RUNTIME_PACKAGE_EXECUTION_INPUT_SCHEMA, RUNTIME_PACKAGE_EXECUTION_RESULT_SCHEMA, RUNTIME_PACKAGE_OUTPUT_PROJECTION_SCHEMA } from "./runtime-package-execution.js"
import { WORDPRESS_REST_MATRIX_RESULT_SCHEMA, WORDPRESS_REST_MATRIX_SCHEMA } from "./rest-matrix-contracts.js"
import { BROWSER_CONTAINED_SITE_OPEN_SCHEMA, BROWSER_CONTAINED_SITE_STATUS_SCHEMA, BROWSER_PREVIEW_BOOT_CONFIG_SCHEMA, BROWSER_SESSION_PRODUCT_DTO_SCHEMA, PREVIEW_LEASE_SCHEMA, PREVIEW_REVIEWER_ACCESS_SCHEMA, RUNTIME_PROFILE_SCHEMA, normalizePreviewReviewerAccess, normalizeRuntimeProfile, type RuntimeProfile } from "./runtime-boundary-contracts.js"
import { STRUCTURED_ARTIFACT_SCHEMA, TYPED_ARTIFACT_INDEX_SCHEMA, normalizeTypedArtifactDTO, normalizeTypedArtifactIndex, type TypedArtifactIndex, type TypedArtifactRef } from "./structured-artifacts.js"
import {
  RUNNER_WORKSPACE_CAPTURE_REQUEST_SCHEMA,
  RUNNER_WORKSPACE_CAPTURE_RESULT_SCHEMA,
  RUNNER_WORKSPACE_COMMAND_REQUEST_SCHEMA,
  RUNNER_WORKSPACE_COMMAND_RESULT_SCHEMA,
  RUNNER_WORKSPACE_PREPARE_REQUEST_SCHEMA,
  RUNNER_WORKSPACE_PREPARE_RESULT_SCHEMA,
  RUNNER_WORKSPACE_PUBLICATION_REQUEST_SCHEMA,
  RUNNER_WORKSPACE_PUBLICATION_RESULT_SCHEMA,
} from "./runner-workspace-publication.js"
import { WORDPRESS_ADMIN_PAGE_INVENTORY_SCHEMA, WORDPRESS_FRONTEND_URL_INVENTORY_SCHEMA, WORDPRESS_REST_ROUTE_INVENTORY_SCHEMA, WORDPRESS_RUNTIME_DISCOVERY_SCHEMA } from "./wordpress-runtime-discovery-contracts.js"
import { WORDPRESS_DB_OPERATION_SCHEMA, WORDPRESS_DB_RESULT_SCHEMA } from "./wordpress-db-contracts.js"
import { WORDPRESS_WORKLOAD_RUN_SCHEMA } from "./wordpress-workload-primitives.js"

export const RUNTIME_CONTRACT_MANIFEST_SCHEMA = "wp-codebox/runtime-contract-manifest/v1" as const
export const AGENT_TASK_RUN_REQUEST_SCHEMA = "wp-codebox/agent-task-run-request/v1" as const

export const CODEBOX_RUN_AGENT_TASK_ABILITY = "wp-codebox/run-agent-task" as const
export const CODEBOX_RUN_AGENT_TASK_BATCH_ABILITY = "wp-codebox/run-agent-task-batch" as const
export const CODEBOX_RUN_AGENT_TASK_FANOUT_ABILITY = "wp-codebox/run-agent-task-fanout" as const
export const CODEBOX_RUN_SANDBOX_TASK_ABILITY = "wp-codebox/run-sandbox-task" as const
export const CODEBOX_RUN_SANDBOX_TASK_BATCH_ABILITY = "wp-codebox/run-sandbox-task-batch" as const
export const CODEBOX_RUN_SANDBOX_TASK_FANOUT_ABILITY = "wp-codebox/run-sandbox-task-fanout" as const
export const CODEBOX_RUN_WORDPRESS_WORKLOAD_ABILITY = "wp-codebox/run-wordpress-workload" as const
export const CODEBOX_RUN_FUZZ_SUITE_ABILITY = "wp-codebox/run-fuzz-suite" as const

export const CODEBOX_PUBLIC_RUNTIME_ABILITIES = {
  agentTask: {
    run: CODEBOX_RUN_AGENT_TASK_ABILITY,
    batch: CODEBOX_RUN_AGENT_TASK_BATCH_ABILITY,
    fanout: CODEBOX_RUN_AGENT_TASK_FANOUT_ABILITY,
    aliases: {
      runSandboxTask: CODEBOX_RUN_SANDBOX_TASK_ABILITY,
      runSandboxTaskBatch: CODEBOX_RUN_SANDBOX_TASK_BATCH_ABILITY,
      runSandboxTaskFanout: CODEBOX_RUN_SANDBOX_TASK_FANOUT_ABILITY,
    },
  },
  runtimePackage: {
    run: CODEBOX_RUN_RUNTIME_PACKAGE_ABILITY,
  },
  wordpressRuntime: {
    runWorkload: CODEBOX_RUN_WORDPRESS_WORKLOAD_ABILITY,
    runFuzzSuite: CODEBOX_RUN_FUZZ_SUITE_ABILITY,
  },
} as const

export const RUNTIME_CONTRACT_SCHEMAS = {
  agentTask: {
    runRequest: AGENT_TASK_RUN_REQUEST_SCHEMA,
    runResult: AGENT_TASK_RUN_RESULT_SCHEMA,
    legacyRunResponse: AGENT_TASK_RUN_RESULT_SCHEMA,
  },
  runtimeBoundary: {
    profile: RUNTIME_PROFILE_SCHEMA,
    previewLease: PREVIEW_LEASE_SCHEMA,
    browserContainedSiteStatus: BROWSER_CONTAINED_SITE_STATUS_SCHEMA,
    browserContainedSiteOpen: BROWSER_CONTAINED_SITE_OPEN_SCHEMA,
    browserSessionProductDto: BROWSER_SESSION_PRODUCT_DTO_SCHEMA,
    browserPreviewBootConfig: BROWSER_PREVIEW_BOOT_CONFIG_SCHEMA,
  },
  browserSession: {
    productDto: BROWSER_SESSION_PRODUCT_DTO_SCHEMA,
    containedSiteStatus: BROWSER_CONTAINED_SITE_STATUS_SCHEMA,
    containedSiteOpen: BROWSER_CONTAINED_SITE_OPEN_SCHEMA,
    previewBootConfig: BROWSER_PREVIEW_BOOT_CONFIG_SCHEMA,
  },
  preview: {
    lease: PREVIEW_LEASE_SCHEMA,
    reviewerAccess: PREVIEW_REVIEWER_ACCESS_SCHEMA,
  },
  artifact: {
    resultEnvelope: ARTIFACT_RESULT_ENVELOPE_SCHEMA,
    typedArtifact: STRUCTURED_ARTIFACT_SCHEMA,
    typedArtifactIndex: TYPED_ARTIFACT_INDEX_SCHEMA,
    runtimePackageDeclaration: RUNTIME_PACKAGE_ARTIFACT_DECLARATION_SCHEMA,
    runtimePackageProjection: RUNTIME_PACKAGE_OUTPUT_PROJECTION_SCHEMA,
    bundleFileManifest: ARTIFACT_BUNDLE_FILE_MANIFEST_SCHEMA,
    browserArtifactPersistenceRef: BROWSER_ARTIFACT_PERSISTENCE_REF_SCHEMA,
  },
  artifactBundle: {
    resultEnvelope: ARTIFACT_RESULT_ENVELOPE_SCHEMA,
    fileManifest: ARTIFACT_BUNDLE_FILE_MANIFEST_SCHEMA,
    browserPersistenceRef: BROWSER_ARTIFACT_PERSISTENCE_REF_SCHEMA,
  },
  taskState: {
    agentTaskRunResult: AGENT_TASK_RUN_RESULT_SCHEMA,
    runtimeRunResult: RUNTIME_RUN_RESULT_SCHEMA,
    agentRuntimeWorkload: AGENT_RUNTIME_WORKLOAD_SCHEMA,
  },
  runtimeProvider: {
    invocationContract: PROVIDER_RUNTIME_INVOCATION_CONTRACT_SCHEMA,
    credentialRequirements: PROVIDER_CREDENTIAL_REQUIREMENTS_SCHEMA,
    credentialPreflight: PROVIDER_CREDENTIAL_PREFLIGHT_SCHEMA,
    credentialResolution: PROVIDER_CREDENTIAL_RESOLUTION_SCHEMA,
  },
  providerRuntime: {
    invocation: PROVIDER_RUNTIME_INVOCATION_CONTRACT_SCHEMA,
    invocationContract: PROVIDER_RUNTIME_INVOCATION_CONTRACT_SCHEMA,
    credentialRequirements: PROVIDER_CREDENTIAL_REQUIREMENTS_SCHEMA,
    credentialPreflight: PROVIDER_CREDENTIAL_PREFLIGHT_SCHEMA,
    credentialResolution: PROVIDER_CREDENTIAL_RESOLUTION_SCHEMA,
  },
  hostDelegation: {
    request: HOST_DELEGATION_REQUEST_SCHEMA,
    result: HOST_DELEGATION_RESULT_SCHEMA,
    event: HOST_DELEGATION_EVENT_SCHEMA,
  },
  runtimePackage: {
    executionInput: RUNTIME_PACKAGE_EXECUTION_INPUT_SCHEMA,
    executionResult: RUNTIME_PACKAGE_EXECUTION_RESULT_SCHEMA,
  },
  runnerWorkspace: {
    prepareRequest: RUNNER_WORKSPACE_PREPARE_REQUEST_SCHEMA,
    prepareResult: RUNNER_WORKSPACE_PREPARE_RESULT_SCHEMA,
    captureRequest: RUNNER_WORKSPACE_CAPTURE_REQUEST_SCHEMA,
    captureResult: RUNNER_WORKSPACE_CAPTURE_RESULT_SCHEMA,
    commandRequest: RUNNER_WORKSPACE_COMMAND_REQUEST_SCHEMA,
    commandResult: RUNNER_WORKSPACE_COMMAND_RESULT_SCHEMA,
    publicationRequest: RUNNER_WORKSPACE_PUBLICATION_REQUEST_SCHEMA,
    publicationResult: RUNNER_WORKSPACE_PUBLICATION_RESULT_SCHEMA,
  },
  parentToolBridge: {
    bridge: PARENT_TOOL_BRIDGE_SCHEMA,
    request: PARENT_TOOL_REQUEST_SCHEMA,
    result: PARENT_TOOL_RESULT_SCHEMA,
  },
  fanoutAggregation: {
    input: FANOUT_AGGREGATION_INPUT_SCHEMA,
    output: FANOUT_AGGREGATION_OUTPUT_SCHEMA,
  },
  wordpressRuntimeDiscovery: {
    result: WORDPRESS_RUNTIME_DISCOVERY_SCHEMA,
    restRouteInventory: WORDPRESS_REST_ROUTE_INVENTORY_SCHEMA,
    adminPageInventory: WORDPRESS_ADMIN_PAGE_INVENTORY_SCHEMA,
    frontendUrlInventory: WORDPRESS_FRONTEND_URL_INVENTORY_SCHEMA,
    restMatrix: WORDPRESS_REST_MATRIX_SCHEMA,
    restMatrixResult: WORDPRESS_REST_MATRIX_RESULT_SCHEMA,
  },
  wordpressDb: {
    operation: WORDPRESS_DB_OPERATION_SCHEMA,
    result: WORDPRESS_DB_RESULT_SCHEMA,
  },
  wordpressRuntime: {
    workloadRun: WORDPRESS_WORKLOAD_RUN_SCHEMA,
    fuzzSuite: FUZZ_SUITE_SCHEMA,
    fuzzSuiteResult: FUZZ_SUITE_RESULT_SCHEMA,
  },
} as const

export type RuntimeContractSchemaGroup = keyof typeof RUNTIME_CONTRACT_SCHEMAS
export type RuntimeContractSchema = typeof RUNTIME_CONTRACT_SCHEMAS[RuntimeContractSchemaGroup][keyof typeof RUNTIME_CONTRACT_SCHEMAS[RuntimeContractSchemaGroup]]

export interface RuntimeContractManifest {
  schema: typeof RUNTIME_CONTRACT_MANIFEST_SCHEMA
  version: 1
  schemas: typeof RUNTIME_CONTRACT_SCHEMAS
  abilities: typeof CODEBOX_PUBLIC_RUNTIME_ABILITIES
  providerRuntime: ReturnType<typeof providerRuntimeInvocationContract>
}

export function runtimeContractManifest(): RuntimeContractManifest {
  return {
    schema: RUNTIME_CONTRACT_MANIFEST_SCHEMA,
    version: 1,
    schemas: RUNTIME_CONTRACT_SCHEMAS,
    abilities: CODEBOX_PUBLIC_RUNTIME_ABILITIES,
    providerRuntime: providerRuntimeInvocationContract(),
  }
}

export function runtimeContractSchemaValues(): RuntimeContractSchema[] {
  return [...new Set(Object.values(RUNTIME_CONTRACT_SCHEMAS).flatMap((group) => Object.values(group)))] as RuntimeContractSchema[]
}

export function isRuntimeContractSchema(value: unknown): value is RuntimeContractSchema {
  return typeof value === "string" && runtimeContractSchemaValues().includes(value as RuntimeContractSchema)
}

export function normalizeRuntimeContractSchema(value: unknown): RuntimeContractSchema {
  if (isRuntimeContractSchema(value)) return value
  throw new Error(`Unknown WP Codebox runtime contract schema: ${String(value)}`)
}

export const RUNTIME_CONTRACT_NORMALIZERS = {
  agentTaskRunResult: normalizeAgentTaskRunResult,
  artifactResultEnvelope: normalizeArtifactResultEnvelope,
  fanoutAggregationInput: normalizeFanoutAggregationInput,
  fanoutAggregationOutput: aggregateFanoutOutputs,
  runtimeProfile: normalizeRuntimeProfile,
  previewReviewerAccess: normalizePreviewReviewerAccess,
  typedArtifact: normalizeTypedArtifactDTO,
  typedArtifactIndex: normalizeTypedArtifactIndex,
} satisfies {
  agentTaskRunResult: (input: unknown) => AgentTaskRunResultSummary
  artifactResultEnvelope: (input: unknown) => ArtifactResultEnvelope
  fanoutAggregationInput: (input: FanoutAggregationInputRequest) => FanoutAggregationInput
  fanoutAggregationOutput: (input: FanoutAggregationInputRequest) => FanoutAggregationOutput
  runtimeProfile: (input: unknown) => RuntimeProfile
  previewReviewerAccess: typeof normalizePreviewReviewerAccess
  typedArtifact: (input: unknown) => TypedArtifactRef | undefined
  typedArtifactIndex: (input: unknown) => TypedArtifactIndex
}
