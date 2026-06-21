import { AGENT_TASK_RUN_RESULT_SCHEMA, normalizeAgentTaskRunResult, type AgentTaskRunResultSummary } from "./agent-task-run-result.js"
import { ARTIFACT_RESULT_ENVELOPE_SCHEMA, normalizeArtifactResultEnvelope, type ArtifactResultEnvelope } from "./artifact-result-envelope.js"
import { FANOUT_AGGREGATION_INPUT_SCHEMA, FANOUT_AGGREGATION_OUTPUT_SCHEMA, aggregateFanoutOutputs, normalizeFanoutAggregationInput, type FanoutAggregationInput, type FanoutAggregationInputRequest, type FanoutAggregationOutput } from "./fanout-aggregation.js"
import { PARENT_TOOL_BRIDGE_SCHEMA, PARENT_TOOL_REQUEST_SCHEMA, PARENT_TOOL_RESULT_SCHEMA } from "./parent-tool-bridge.js"
import { PROVIDER_CREDENTIAL_PREFLIGHT_SCHEMA, PROVIDER_CREDENTIAL_REQUIREMENTS_SCHEMA, PROVIDER_CREDENTIAL_RESOLUTION_SCHEMA, PROVIDER_RUNTIME_INVOCATION_CONTRACT_SCHEMA, providerRuntimeInvocationContract, type ProviderRuntimeInvocationContract } from "./provider-runtime-contracts.js"
import { CODEBOX_RUN_RUNTIME_PACKAGE_ABILITY, RUNTIME_PACKAGE_ARTIFACT_DECLARATION_SCHEMA, RUNTIME_PACKAGE_EXECUTION_INPUT_SCHEMA, RUNTIME_PACKAGE_EXECUTION_RESULT_SCHEMA, RUNTIME_PACKAGE_OUTPUT_PROJECTION_SCHEMA } from "./runtime-package-execution.js"
import { BROWSER_CONTAINED_SITE_OPEN_SCHEMA, BROWSER_CONTAINED_SITE_STATUS_SCHEMA, BROWSER_PREVIEW_BOOT_CONFIG_SCHEMA, BROWSER_SESSION_PRODUCT_DTO_SCHEMA, PREVIEW_LEASE_SCHEMA, RUNTIME_PROFILE_SCHEMA, runtimeProfile, type RuntimeProfile } from "./runtime-boundary-contracts.js"
import {
  RUNNER_WORKSPACE_CAPTURE_REQUEST_SCHEMA,
  RUNNER_WORKSPACE_CAPTURE_RESULT_SCHEMA,
  RUNNER_WORKSPACE_BACKEND_ABILITY_KEYS,
  RUNNER_WORKSPACE_BACKEND_FILTER,
  RUNNER_WORKSPACE_COMMAND_REQUEST_SCHEMA,
  RUNNER_WORKSPACE_COMMAND_RESULT_SCHEMA,
  RUNNER_WORKSPACE_PREPARE_REQUEST_SCHEMA,
  RUNNER_WORKSPACE_PREPARE_RESULT_SCHEMA,
  RUNNER_WORKSPACE_PUBLICATION_REQUEST_SCHEMA,
  RUNNER_WORKSPACE_PUBLICATION_RESULT_SCHEMA,
} from "./runner-workspace-publication.js"
import { WORDPRESS_RUNTIME_DISCOVERY_SCHEMA } from "./wordpress-runtime-discovery-contracts.js"

export const RUNTIME_CONTRACT_MANIFEST_SCHEMA = "wp-codebox/runtime-contract-manifest/v1" as const

export const RUNTIME_CONTRACT_SCHEMAS = {
  providerRuntime: {
    invocation: PROVIDER_RUNTIME_INVOCATION_CONTRACT_SCHEMA,
    credentialRequirements: PROVIDER_CREDENTIAL_REQUIREMENTS_SCHEMA,
    credentialPreflight: PROVIDER_CREDENTIAL_PREFLIGHT_SCHEMA,
    credentialResolution: PROVIDER_CREDENTIAL_RESOLUTION_SCHEMA,
  },
  agentTask: {
    runResult: AGENT_TASK_RUN_RESULT_SCHEMA,
  },
  runtimeBoundary: {
    profile: RUNTIME_PROFILE_SCHEMA,
    previewLease: PREVIEW_LEASE_SCHEMA,
    browserContainedSiteStatus: BROWSER_CONTAINED_SITE_STATUS_SCHEMA,
    browserContainedSiteOpen: BROWSER_CONTAINED_SITE_OPEN_SCHEMA,
    browserSessionProductDto: BROWSER_SESSION_PRODUCT_DTO_SCHEMA,
    browserPreviewBootConfig: BROWSER_PREVIEW_BOOT_CONFIG_SCHEMA,
  },
  artifact: {
    resultEnvelope: ARTIFACT_RESULT_ENVELOPE_SCHEMA,
    runtimePackageDeclaration: RUNTIME_PACKAGE_ARTIFACT_DECLARATION_SCHEMA,
    runtimePackageProjection: RUNTIME_PACKAGE_OUTPUT_PROJECTION_SCHEMA,
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
  },
} as const

export type RuntimeContractSchemaGroup = keyof typeof RUNTIME_CONTRACT_SCHEMAS
export type RuntimeContractSchema = typeof RUNTIME_CONTRACT_SCHEMAS[RuntimeContractSchemaGroup][keyof typeof RUNTIME_CONTRACT_SCHEMAS[RuntimeContractSchemaGroup]]

export interface RuntimeContractManifest {
  schema: typeof RUNTIME_CONTRACT_MANIFEST_SCHEMA
  version: 1
  schemas: typeof RUNTIME_CONTRACT_SCHEMAS
  abilities: {
    runRuntimePackage: typeof CODEBOX_RUN_RUNTIME_PACKAGE_ABILITY
  }
  providerRuntime: ProviderRuntimeInvocationContract
  runnerWorkspaceBackend: {
    filter: typeof RUNNER_WORKSPACE_BACKEND_FILTER
    abilityKeys: typeof RUNNER_WORKSPACE_BACKEND_ABILITY_KEYS
  }
}

export function runtimeContractManifest(): RuntimeContractManifest {
  return {
    schema: RUNTIME_CONTRACT_MANIFEST_SCHEMA,
    version: 1,
    schemas: RUNTIME_CONTRACT_SCHEMAS,
    abilities: {
      runRuntimePackage: CODEBOX_RUN_RUNTIME_PACKAGE_ABILITY,
    },
    providerRuntime: providerRuntimeInvocationContract(),
    runnerWorkspaceBackend: {
      filter: RUNNER_WORKSPACE_BACKEND_FILTER,
      abilityKeys: RUNNER_WORKSPACE_BACKEND_ABILITY_KEYS,
    },
  }
}

export function runtimeContractSchemaValues(): RuntimeContractSchema[] {
  return Object.values(RUNTIME_CONTRACT_SCHEMAS).flatMap((group) => Object.values(group)) as RuntimeContractSchema[]
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
  runtimeProfile,
} satisfies {
  agentTaskRunResult: (input: unknown) => AgentTaskRunResultSummary
  artifactResultEnvelope: (input: unknown) => ArtifactResultEnvelope
  fanoutAggregationInput: (input: FanoutAggregationInputRequest) => FanoutAggregationInput
  fanoutAggregationOutput: (input: FanoutAggregationInputRequest) => FanoutAggregationOutput
  runtimeProfile: (input: unknown) => RuntimeProfile
}
