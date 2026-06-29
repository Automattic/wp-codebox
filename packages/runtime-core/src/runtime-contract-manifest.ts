import { AGENT_TASK_RUN_RESULT_SCHEMA, normalizeAgentTaskRunResult, type AgentTaskRunResultSummary } from "./agent-task-run-result.js"
import { HEADLESS_AGENT_TASK_REQUEST_SCHEMA, HEADLESS_AGENT_TASK_RESULT_SCHEMA } from "./headless-agent-task-contracts.js"
import { AGENT_RUNTIME_WORKLOAD_SCHEMA } from "./agent-runtime-workload.js"
import { ARTIFACT_RESULT_ENVELOPE_SCHEMA, normalizeArtifactResultEnvelope, type ArtifactResultEnvelope } from "./artifact-result-envelope.js"
import { FANOUT_AGGREGATION_INPUT_SCHEMA, FANOUT_AGGREGATION_OUTPUT_SCHEMA, aggregateFanoutOutputs, normalizeFanoutAggregationInput, validateFanoutAggregationOutput, type FanoutAggregationInput, type FanoutAggregationInputRequest, type FanoutAggregationOutput } from "./fanout-aggregation.js"
import { FUZZ_COVERAGE_PLAN_SCHEMA } from "./fuzz-coverage-plan-contracts.js"
import { FUZZ_RUNNER_CAPABILITIES_SCHEMA, FUZZ_RUNNER_READINESS_SCHEMA, FUZZ_SUITE_RESULT_SCHEMA, FUZZ_SUITE_SCHEMA, WORDPRESS_FUZZ_RUNTIME_CONTRACT_SCHEMA, wordpressFuzzRuntimeContract, type WordPressFuzzRuntimeContract } from "./fuzz-suite-contracts.js"
import { HOST_DELEGATION_EVENT_SCHEMA, HOST_DELEGATION_REQUEST_SCHEMA, HOST_DELEGATION_RESULT_SCHEMA } from "./fanout-contracts.js"
import { ARTIFACT_BUNDLE_FILE_MANIFEST_SCHEMA, BROWSER_ARTIFACT_PERSISTENCE_REF_SCHEMA } from "./materialization-contracts.js"
import { PARENT_TOOL_BRIDGE_SCHEMA, PARENT_TOOL_REQUEST_SCHEMA, PARENT_TOOL_RESULT_SCHEMA } from "./parent-tool-bridge.js"
import { PROVIDER_CREDENTIAL_PREFLIGHT_SCHEMA, PROVIDER_CREDENTIAL_REQUIREMENTS_SCHEMA, PROVIDER_CREDENTIAL_RESOLUTION_SCHEMA, PROVIDER_RUNTIME_INVOCATION_CONTRACT_SCHEMA, providerRuntimeInvocationContract } from "./provider-runtime-contracts.js"
import { RUNTIME_RUN_RESULT_SCHEMA } from "./run-registry.js"
import { RUNTIME_PACKAGE_DIAGNOSTIC_SCHEMA, RUNTIME_PACKAGE_RESULT_SCHEMA, RUNTIME_PACKAGE_TASK_SCHEMA } from "./runtime-package-contracts.js"
import { CODEBOX_RUN_RUNTIME_PACKAGE_ABILITY, RUNTIME_PACKAGE_ARTIFACT_DECLARATION_SCHEMA, RUNTIME_PACKAGE_EXECUTION_INPUT_SCHEMA, RUNTIME_PACKAGE_EXECUTION_RESULT_SCHEMA, RUNTIME_PACKAGE_OUTPUT_PROJECTION_SCHEMA } from "./runtime-package-execution.js"
import { WORDPRESS_REST_MATRIX_RESULT_SCHEMA, WORDPRESS_REST_MATRIX_SCHEMA } from "./rest-matrix-contracts.js"
import { BROWSER_CONTAINED_SITE_OPEN_SCHEMA, BROWSER_CONTAINED_SITE_STATUS_SCHEMA, BROWSER_PREVIEW_BOOT_CONFIG_SCHEMA, BROWSER_SESSION_PRODUCT_DTO_SCHEMA, PREVIEW_LEASE_SCHEMA, PREVIEW_REVIEWER_ACCESS_SCHEMA, RUNTIME_ACCESS_SCHEMA, RUNTIME_PROFILE_SCHEMA, normalizePreviewReviewerAccess, normalizeRuntimeAccess, normalizeRuntimeProfile, type RuntimeAccess, type RuntimeProfile } from "./runtime-boundary-contracts.js"
import { TYPED_ARTIFACT_INDEX_SCHEMA, TYPED_ARTIFACT_SCHEMA, normalizeTypedArtifactDTO, normalizeTypedArtifactIndex, type TypedArtifactDTO, type TypedArtifactIndex } from "./structured-artifacts.js"
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
import { WORDPRESS_ADMIN_ACTION_INVENTORY_SCHEMA, WORDPRESS_ADMIN_PAGE_INVENTORY_SCHEMA, WORDPRESS_DATABASE_INVENTORY_SCHEMA, WORDPRESS_EXECUTION_ACTION_RESULT_SCHEMA, WORDPRESS_EXECUTION_SURFACES_SCHEMA, WORDPRESS_FRONTEND_URL_INVENTORY_SCHEMA, WORDPRESS_REST_ROUTE_INVENTORY_SCHEMA, WORDPRESS_RUNTIME_DISCOVERY_SCHEMA } from "./wordpress-runtime-discovery-contracts.js"
import { WORDPRESS_DB_OPERATION_SCHEMA, WORDPRESS_DB_RESULT_SCHEMA } from "./wordpress-db-contracts.js"
import { WORDPRESS_BLOCK_EXERCISE_RESULT_SCHEMA } from "./wordpress-block-exercise-contracts.js"
import { WORDPRESS_WORKLOAD_RUN_SCHEMA } from "./wordpress-workload-primitives.js"
import { BROWSER_CONTAINED_SITE_APPLY_PLAN_SCHEMA, BROWSER_CONTAINED_SITE_APPLY_RESULT_SCHEMA, BROWSER_CONTAINED_SITE_EXPORT_SCHEMA, BROWSER_CONTAINED_SITE_SNAPSHOT_SCHEMA, BROWSER_CONTAINED_SITE_SYNC_APPLY_PLAN_SCHEMA, BROWSER_CONTAINED_SITE_SYNC_APPLY_RESULT_SCHEMA, BROWSER_CONTAINED_SITE_SYNC_DELEGATION_SCHEMA, BROWSER_CONTAINED_SITE_SYNC_EXPORT_SCHEMA, BROWSER_CONTAINED_SITE_SYNC_MANIFEST_SCHEMA, BROWSER_CONTAINED_SITE_SYNC_SOURCE_SCHEMA, BROWSER_CONTAINED_SITE_SYNC_VALIDATION_SCHEMA } from "./browser-contained-site-contracts.js"
import { SANDBOX_ISOLATION_PROOF_SCHEMA } from "./sandbox-isolation-proof-contracts.js"
import { CACHE_CHURN_OBSERVATION_SCHEMA } from "./cache-churn-observation.js"
import { QUERY_OBSERVATION_SCHEMA } from "./query-observation-contracts.js"

export const RUNTIME_CONTRACT_MANIFEST_SCHEMA = "wp-codebox/runtime-contract-manifest/v1" as const
export const AGENT_TASK_RUN_REQUEST_SCHEMA = "wp-codebox/agent-task-run-request/v1" as const

export const CODEBOX_RUN_AGENT_TASK_ABILITY = "wp-codebox/run-agent-task" as const
export const CODEBOX_RUN_AGENT_TASK_BATCH_ABILITY = "wp-codebox/run-agent-task-batch" as const
export const CODEBOX_RUN_AGENT_TASK_FANOUT_ABILITY = "wp-codebox/run-agent-task-fanout" as const
export const CODEBOX_RUN_WORDPRESS_WORKLOAD_ABILITY = "wp-codebox/run-wordpress-workload" as const
export const CODEBOX_RUN_FUZZ_SUITE_ABILITY = "wp-codebox/run-fuzz-suite" as const
export const CODEBOX_RESOLVE_RUNTIME_REQUIREMENTS_ABILITY = "wp-codebox/resolve-runtime-requirements" as const
export const RUNTIME_DESCRIPTOR_SCHEMA = "wp-codebox/runtime-descriptor/v1" as const

export const CODEBOX_PUBLIC_RUNTIME_CAPABILITIES = [
  "agent-task:run",
  "agent-task:batch",
  "agent-task:fanout",
  "runtime-package:run",
  "runtime-requirements:resolve",
  "wordpress-runtime:workload",
  "wordpress-runtime:fuzz-suite",
  "wordpress-runtime:sandbox-isolation-proof",
  "contract-manifest:read",
] as const

export const CODEBOX_PUBLIC_RUNTIME_ABILITIES = {
  agentTask: {
    run: CODEBOX_RUN_AGENT_TASK_ABILITY,
    batch: CODEBOX_RUN_AGENT_TASK_BATCH_ABILITY,
    fanout: CODEBOX_RUN_AGENT_TASK_FANOUT_ABILITY,
  },
  runtimePackage: {
    run: CODEBOX_RUN_RUNTIME_PACKAGE_ABILITY,
  },
  runtimeRequirements: {
    resolve: CODEBOX_RESOLVE_RUNTIME_REQUIREMENTS_ABILITY,
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
    headlessRequest: HEADLESS_AGENT_TASK_REQUEST_SCHEMA,
    headlessResult: HEADLESS_AGENT_TASK_RESULT_SCHEMA,
  },
  runtimeBoundary: {
    profile: RUNTIME_PROFILE_SCHEMA,
    previewLease: PREVIEW_LEASE_SCHEMA,
    browserContainedSiteStatus: BROWSER_CONTAINED_SITE_STATUS_SCHEMA,
    browserContainedSiteOpen: BROWSER_CONTAINED_SITE_OPEN_SCHEMA,
    browserSessionProductDto: BROWSER_SESSION_PRODUCT_DTO_SCHEMA,
    browserPreviewBootConfig: BROWSER_PREVIEW_BOOT_CONFIG_SCHEMA,
    runtimeAccess: RUNTIME_ACCESS_SCHEMA,
  },
  browserSession: {
    productDto: BROWSER_SESSION_PRODUCT_DTO_SCHEMA,
    containedSiteStatus: BROWSER_CONTAINED_SITE_STATUS_SCHEMA,
    containedSiteOpen: BROWSER_CONTAINED_SITE_OPEN_SCHEMA,
    previewBootConfig: BROWSER_PREVIEW_BOOT_CONFIG_SCHEMA,
    containedSiteSnapshot: BROWSER_CONTAINED_SITE_SNAPSHOT_SCHEMA,
    containedSiteExport: BROWSER_CONTAINED_SITE_EXPORT_SCHEMA,
    containedSiteApplyPlan: BROWSER_CONTAINED_SITE_APPLY_PLAN_SCHEMA,
    containedSiteApplyResult: BROWSER_CONTAINED_SITE_APPLY_RESULT_SCHEMA,
    containedSiteSyncDelegation: BROWSER_CONTAINED_SITE_SYNC_DELEGATION_SCHEMA,
    containedSiteSyncSource: BROWSER_CONTAINED_SITE_SYNC_SOURCE_SCHEMA,
    containedSiteSyncManifest: BROWSER_CONTAINED_SITE_SYNC_MANIFEST_SCHEMA,
    containedSiteSyncExport: BROWSER_CONTAINED_SITE_SYNC_EXPORT_SCHEMA,
    containedSiteSyncApplyPlan: BROWSER_CONTAINED_SITE_SYNC_APPLY_PLAN_SCHEMA,
    containedSiteSyncValidation: BROWSER_CONTAINED_SITE_SYNC_VALIDATION_SCHEMA,
    containedSiteSyncApplyResult: BROWSER_CONTAINED_SITE_SYNC_APPLY_RESULT_SCHEMA,
  },
  preview: {
    lease: PREVIEW_LEASE_SCHEMA,
    reviewerAccess: PREVIEW_REVIEWER_ACCESS_SCHEMA,
    runtimeAccess: RUNTIME_ACCESS_SCHEMA,
  },
  artifact: {
    resultEnvelope: ARTIFACT_RESULT_ENVELOPE_SCHEMA,
    typedArtifact: TYPED_ARTIFACT_SCHEMA,
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
    task: RUNTIME_PACKAGE_TASK_SCHEMA,
    result: RUNTIME_PACKAGE_RESULT_SCHEMA,
    diagnostic: RUNTIME_PACKAGE_DIAGNOSTIC_SCHEMA,
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
    adminActionInventory: WORDPRESS_ADMIN_ACTION_INVENTORY_SCHEMA,
    databaseInventory: WORDPRESS_DATABASE_INVENTORY_SCHEMA,
    frontendUrlInventory: WORDPRESS_FRONTEND_URL_INVENTORY_SCHEMA,
    executionSurfaces: WORDPRESS_EXECUTION_SURFACES_SCHEMA,
    executionActionResult: WORDPRESS_EXECUTION_ACTION_RESULT_SCHEMA,
    restMatrix: WORDPRESS_REST_MATRIX_SCHEMA,
    restMatrixResult: WORDPRESS_REST_MATRIX_RESULT_SCHEMA,
  },
  wordpressDb: {
    operation: WORDPRESS_DB_OPERATION_SCHEMA,
    result: WORDPRESS_DB_RESULT_SCHEMA,
  },
  wordpressRuntime: {
    workloadRun: WORDPRESS_WORKLOAD_RUN_SCHEMA,
    fuzzCoveragePlan: FUZZ_COVERAGE_PLAN_SCHEMA,
    fuzzSuite: FUZZ_SUITE_SCHEMA,
    fuzzSuiteResult: FUZZ_SUITE_RESULT_SCHEMA,
    fuzzRunnerCapabilities: FUZZ_RUNNER_CAPABILITIES_SCHEMA,
    fuzzRunnerReadiness: FUZZ_RUNNER_READINESS_SCHEMA,
    wordpressFuzzRuntimeContract: WORDPRESS_FUZZ_RUNTIME_CONTRACT_SCHEMA,
    cacheChurnObservation: CACHE_CHURN_OBSERVATION_SCHEMA,
    queryObservation: QUERY_OBSERVATION_SCHEMA,
    blockExerciseResult: WORDPRESS_BLOCK_EXERCISE_RESULT_SCHEMA,
    sandboxIsolationProof: SANDBOX_ISOLATION_PROOF_SCHEMA,
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

export interface RuntimeDescriptor {
  schema: typeof RUNTIME_DESCRIPTOR_SCHEMA
  version: 1
  runtime: {
    id: "wp-codebox"
    name: "WP Codebox"
  }
  readiness: {
    status: "available"
    publicApi: true
    contractManifest: true
  }
  capabilities: typeof CODEBOX_PUBLIC_RUNTIME_CAPABILITIES
  abilities: typeof CODEBOX_PUBLIC_RUNTIME_ABILITIES
  wordpressFuzzRuntimeContract: WordPressFuzzRuntimeContract
  contractManifest: RuntimeContractManifest
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

export function runtimeDescriptor(): RuntimeDescriptor {
  return {
    schema: RUNTIME_DESCRIPTOR_SCHEMA,
    version: 1,
    runtime: {
      id: "wp-codebox",
      name: "WP Codebox",
    },
    readiness: {
      status: "available",
      publicApi: true,
      contractManifest: true,
    },
    capabilities: CODEBOX_PUBLIC_RUNTIME_CAPABILITIES,
    abilities: CODEBOX_PUBLIC_RUNTIME_ABILITIES,
    wordpressFuzzRuntimeContract: wordpressFuzzRuntimeContract(),
    contractManifest: runtimeContractManifest(),
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
  fanoutAggregationOutputEnvelope: validateFanoutAggregationOutput,
  runtimeProfile: normalizeRuntimeProfile,
  runtimeAccess: normalizeRuntimeAccess,
  previewReviewerAccess: normalizePreviewReviewerAccess,
  typedArtifact: normalizeTypedArtifactDTO,
  typedArtifactIndex: normalizeTypedArtifactIndex,
} satisfies {
  agentTaskRunResult: (input: unknown) => AgentTaskRunResultSummary
  artifactResultEnvelope: (input: unknown) => ArtifactResultEnvelope
  fanoutAggregationInput: (input: FanoutAggregationInputRequest) => FanoutAggregationInput
  fanoutAggregationOutput: (input: FanoutAggregationInputRequest) => FanoutAggregationOutput
  fanoutAggregationOutputEnvelope: (input: unknown) => FanoutAggregationOutput
  runtimeProfile: (input: unknown) => RuntimeProfile
  runtimeAccess: (input: unknown) => RuntimeAccess
  previewReviewerAccess: typeof normalizePreviewReviewerAccess
  typedArtifact: (input: unknown) => TypedArtifactDTO | undefined
  typedArtifactIndex: (input: unknown) => TypedArtifactIndex
}
