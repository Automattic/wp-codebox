export const PROVIDER_RUNTIME_INVOCATION_CONTRACT_SCHEMA = "wp-codebox/provider-runtime-invocation-contract/v1" as const
export const PROVIDER_CREDENTIAL_REQUIREMENTS_SCHEMA = "wp-codebox/provider-credential-requirements/v1" as const
export const PROVIDER_CREDENTIAL_PREFLIGHT_SCHEMA = "wp-codebox/provider-credential-preflight/v1" as const
export const PROVIDER_CREDENTIAL_RESOLUTION_SCHEMA = "wp-codebox/provider-credential-resolution/v1" as const

export const PROVIDER_RUNTIME_TASK_NAMES = {
  workspacePrepare: "wp-codebox.runner-workspace.prepare",
  workspaceCapture: "wp-codebox.runner-workspace.capture",
  workspaceCommand: "wp-codebox.runner-workspace.command",
  workspacePublish: "wp-codebox.runner-workspace.publish",
  toolCallTranscriptRecord: "wp-codebox.tool-call-transcript.record",
  artifactHandoff: "wp-codebox.artifact-handoff",
} as const

export const PROVIDER_RUNTIME_ABILITY_NAMES = {
  workspacePrepare: "wp-codebox/runner-workspace-prepare",
  workspaceCapture: "wp-codebox/runner-workspace-capture",
  workspaceCommand: "wp-codebox/runner-workspace-command",
  workspacePublish: "wp-codebox/runner-workspace-publish",
  toolCallTranscriptRecord: "wp-codebox/record-tool-call-transcript",
  artifactHandoff: "wp-codebox/handoff-artifacts",
} as const

export type ProviderRuntimeContractKey = keyof typeof PROVIDER_RUNTIME_TASK_NAMES

export interface ProviderRuntimeInvocationContract {
  schema: typeof PROVIDER_RUNTIME_INVOCATION_CONTRACT_SCHEMA
  version: 1
  tasks: Record<ProviderRuntimeContractKey, string>
  abilities: Record<ProviderRuntimeContractKey, string>
  result_schemas: {
    workspace_prepare: "wp-codebox/runner-workspace-prepare-result/v1"
    workspace_capture: "wp-codebox/runner-workspace-capture-result/v1"
    workspace_command: "wp-codebox/runner-workspace-command-result/v1"
    workspace_publication: "wp-codebox/runner-workspace-publication-result/v1"
    tool_call_transcript: "wp-codebox/tool-call-transcript/v1"
    evidence_artifact_envelope: "wp-codebox/evidence-artifact-envelope/v1"
    artifact_result_envelope: "wp-codebox/artifact-result-envelope/v1"
  }
}

export type ProviderCredentialStatus = "available" | "missing" | "denied" | "not-required"

export interface ProviderCredentialRequirement {
  name: string
  required: boolean
  kind?: string
  scope?: string
  source?: string
  secretEnv?: string[]
}

export interface ProviderCredentialRequirementsContract {
  schema: typeof PROVIDER_CREDENTIAL_REQUIREMENTS_SCHEMA
  provider: string
  model?: string
  requirements: ProviderCredentialRequirement[]
  redacted: true
}

export interface ProviderCredentialPreflightContract {
  schema: typeof PROVIDER_CREDENTIAL_PREFLIGHT_SCHEMA
  provider: string
  model?: string
  status: ProviderCredentialStatus
  requirements: ProviderCredentialRequirement[]
  secret_env: string[]
  diagnostics: Array<{ code?: string; severity?: "info" | "warning" | "error"; message?: string }>
  redacted: true
}

export interface ProviderCredentialResolutionContract {
  schema: typeof PROVIDER_CREDENTIAL_RESOLUTION_SCHEMA
  requirements: ProviderCredentialRequirementsContract
  preflight: ProviderCredentialPreflightContract
  secret_env: string[]
  redacted: true
}

export function providerRuntimeInvocationContract(): ProviderRuntimeInvocationContract {
  return {
    schema: PROVIDER_RUNTIME_INVOCATION_CONTRACT_SCHEMA,
    version: 1,
    tasks: { ...PROVIDER_RUNTIME_TASK_NAMES },
    abilities: { ...PROVIDER_RUNTIME_ABILITY_NAMES },
    result_schemas: {
      workspace_prepare: "wp-codebox/runner-workspace-prepare-result/v1",
      workspace_capture: "wp-codebox/runner-workspace-capture-result/v1",
      workspace_command: "wp-codebox/runner-workspace-command-result/v1",
      workspace_publication: "wp-codebox/runner-workspace-publication-result/v1",
      tool_call_transcript: "wp-codebox/tool-call-transcript/v1",
      evidence_artifact_envelope: "wp-codebox/evidence-artifact-envelope/v1",
      artifact_result_envelope: "wp-codebox/artifact-result-envelope/v1",
    },
  }
}
