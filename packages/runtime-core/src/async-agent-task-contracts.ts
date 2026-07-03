import { normalizeAgentTaskRunResult, type AgentTaskRunResultSummary } from "./agent-task-run-result.js"
import { artifactResultEnvelope, normalizeArtifactResultEnvelope, type ArtifactResultEnvelope } from "./artifact-result-envelope.js"
import { normalizeRuntimeAccess, previewLease, type PreviewLease, type RuntimeAccess } from "./runtime-boundary-contracts.js"
import { isPlainObject, objectValue, stringValue, stripUndefined } from "./object-utils.js"

export const CODEBOX_ASYNC_AGENT_TASK_HANDLE_SCHEMA = "wp-codebox/async-agent-task-handle/v1" as const
export const CODEBOX_ASYNC_AGENT_TASK_STATUS_SCHEMA = "wp-codebox/async-agent-task-status/v1" as const
export const CODEBOX_ASYNC_AGENT_TASK_RESULT_SCHEMA = "wp-codebox/async-agent-task-result/v1" as const

export type CodeboxAsyncAgentTaskState = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "expired" | "unknown" | (string & {})

export interface CodeboxAsyncAgentTaskHandle {
  schema: typeof CODEBOX_ASYNC_AGENT_TASK_HANDLE_SCHEMA
  run_id: string
  state: CodeboxAsyncAgentTaskState
  status_url?: string
  result_url?: string
  cancel_url?: string
  runtime_access?: RuntimeAccess
  lease?: PreviewLease
  artifact_result?: ArtifactResultEnvelope
  metadata: Record<string, unknown>
}

export interface CodeboxAsyncAgentTaskStatus {
  schema: typeof CODEBOX_ASYNC_AGENT_TASK_STATUS_SCHEMA
  run_id: string
  state: CodeboxAsyncAgentTaskState
  complete: boolean
  success?: boolean
  updated_at?: string
  runtime_access?: RuntimeAccess
  lease?: PreviewLease
  artifact_result?: ArtifactResultEnvelope
  diagnostics: Array<Record<string, unknown>>
  metadata: Record<string, unknown>
}

export interface CodeboxAsyncAgentTaskResult {
  schema: typeof CODEBOX_ASYNC_AGENT_TASK_RESULT_SCHEMA
  run_id: string
  state: CodeboxAsyncAgentTaskState
  success: boolean
  result: AgentTaskRunResultSummary
  artifact_result: ArtifactResultEnvelope
  runtime_access?: RuntimeAccess
  lease?: PreviewLease
  diagnostics: Array<Record<string, unknown>>
  metadata: Record<string, unknown>
}

export function codeboxAsyncAgentTaskHandle(input: {
  runId?: string
  run_id?: string
  state?: unknown
  statusUrl?: string
  status_url?: string
  resultUrl?: string
  result_url?: string
  cancelUrl?: string
  cancel_url?: string
  runtimeAccess?: unknown
  runtime_access?: unknown
  lease?: unknown
  artifactResult?: unknown
  artifact_result?: unknown
  metadata?: Record<string, unknown>
}): CodeboxAsyncAgentTaskHandle {
  const runId = stringValue(input.runId) || stringValue(input.run_id)
  if (!runId) throw new Error("codeboxAsyncAgentTaskHandle requires run_id")

  return stripUndefined({
    schema: CODEBOX_ASYNC_AGENT_TASK_HANDLE_SCHEMA,
    run_id: runId,
    state: normalizeAsyncAgentTaskState(input.state),
    status_url: stringValue(input.statusUrl) || stringValue(input.status_url) || undefined,
    result_url: stringValue(input.resultUrl) || stringValue(input.result_url) || undefined,
    cancel_url: stringValue(input.cancelUrl) || stringValue(input.cancel_url) || undefined,
    runtime_access: normalizeOptionalRuntimeAccess(input.runtimeAccess ?? input.runtime_access),
    lease: normalizeOptionalPreviewLease(input.lease),
    artifact_result: normalizeOptionalArtifactResult(input.artifactResult ?? input.artifact_result),
    metadata: isPlainObject(input.metadata) ? input.metadata : {},
  })
}

export function normalizeCodeboxAsyncAgentTaskHandle(input: unknown): CodeboxAsyncAgentTaskHandle | undefined {
  const record = objectValue(input)
  const runId = stringValue(record.run_id) || stringValue(record.runId) || stringValue(record.id) || stringValue(record.job_id) || stringValue(record.jobId)
  if (!runId) return undefined

  return codeboxAsyncAgentTaskHandle({
    run_id: runId,
    state: record.state ?? record.status,
    status_url: stringValue(record.status_url) || stringValue(record.statusUrl) || undefined,
    result_url: stringValue(record.result_url) || stringValue(record.resultUrl) || undefined,
    cancel_url: stringValue(record.cancel_url) || stringValue(record.cancelUrl) || undefined,
    runtime_access: record.runtime_access ?? record.runtimeAccess,
    lease: record.lease ?? objectValue(record.runtime_access).lease,
    artifact_result: record.artifact_result ?? record.artifactResult,
    metadata: objectValue(record.metadata),
  })
}

export function codeboxAsyncAgentTaskStatus(input: {
  runId?: string
  run_id?: string
  state?: unknown
  complete?: boolean
  success?: boolean
  updatedAt?: string
  updated_at?: string
  runtimeAccess?: unknown
  runtime_access?: unknown
  lease?: unknown
  artifactResult?: unknown
  artifact_result?: unknown
  diagnostics?: unknown
  metadata?: Record<string, unknown>
}): CodeboxAsyncAgentTaskStatus {
  const runId = stringValue(input.runId) || stringValue(input.run_id)
  if (!runId) throw new Error("codeboxAsyncAgentTaskStatus requires run_id")
  const state = normalizeAsyncAgentTaskState(input.state, input.success)

  return stripUndefined({
    schema: CODEBOX_ASYNC_AGENT_TASK_STATUS_SCHEMA,
    run_id: runId,
    state,
    complete: typeof input.complete === "boolean" ? input.complete : isTerminalAsyncAgentTaskState(state),
    success: typeof input.success === "boolean" ? input.success : state === "succeeded" ? true : state === "failed" ? false : undefined,
    updated_at: stringValue(input.updatedAt) || stringValue(input.updated_at) || undefined,
    runtime_access: normalizeOptionalRuntimeAccess(input.runtimeAccess ?? input.runtime_access),
    lease: normalizeOptionalPreviewLease(input.lease),
    artifact_result: normalizeOptionalArtifactResult(input.artifactResult ?? input.artifact_result),
    diagnostics: normalizeRecordList(input.diagnostics),
    metadata: isPlainObject(input.metadata) ? input.metadata : {},
  })
}

export function normalizeCodeboxAsyncAgentTaskStatus(input: unknown): CodeboxAsyncAgentTaskStatus | undefined {
  const record = objectValue(input)
  const runId = stringValue(record.run_id) || stringValue(record.runId) || stringValue(record.id) || stringValue(record.job_id) || stringValue(record.jobId)
  if (!runId) return undefined

  return codeboxAsyncAgentTaskStatus({
    run_id: runId,
    state: record.state ?? record.status,
    complete: typeof record.complete === "boolean" ? record.complete : undefined,
    success: typeof record.success === "boolean" ? record.success : undefined,
    updated_at: stringValue(record.updated_at) || stringValue(record.updatedAt) || undefined,
    runtime_access: record.runtime_access ?? record.runtimeAccess,
    lease: record.lease ?? objectValue(record.runtime_access).lease,
    artifact_result: record.artifact_result ?? record.artifactResult,
    diagnostics: record.diagnostics,
    metadata: objectValue(record.metadata),
  })
}

export function codeboxAsyncAgentTaskResult(input: {
  runId?: string
  run_id?: string
  state?: unknown
  success?: boolean
  result?: unknown
  artifactResult?: unknown
  artifact_result?: unknown
  runtimeAccess?: unknown
  runtime_access?: unknown
  lease?: unknown
  diagnostics?: unknown
  metadata?: Record<string, unknown>
}): CodeboxAsyncAgentTaskResult {
  const runId = stringValue(input.runId) || stringValue(input.run_id)
  if (!runId) throw new Error("codeboxAsyncAgentTaskResult requires run_id")
  const result = normalizeAgentTaskRunResult(input.result ?? { success: input.success })
  const state = normalizeAsyncAgentTaskState(input.state ?? result.status, result.success)
  const artifactResult = normalizeOptionalArtifactResult(input.artifactResult ?? input.artifact_result)
    ?? artifactResultEnvelope({ operation: "agent-task-run", status: result.success ? "created" : "failed", result: result as unknown as Record<string, unknown> })

  return stripUndefined({
    schema: CODEBOX_ASYNC_AGENT_TASK_RESULT_SCHEMA,
    run_id: runId,
    state,
    success: typeof input.success === "boolean" ? input.success : result.success,
    result,
    artifact_result: artifactResult,
    runtime_access: normalizeOptionalRuntimeAccess(input.runtimeAccess ?? input.runtime_access ?? result.runtime_access),
    lease: normalizeOptionalPreviewLease(input.lease ?? result.runtime_access?.lease),
    diagnostics: normalizeRecordList(input.diagnostics).concat(result.diagnostics),
    metadata: isPlainObject(input.metadata) ? input.metadata : {},
  })
}

export function normalizeCodeboxAsyncAgentTaskResult(input: unknown): CodeboxAsyncAgentTaskResult | undefined {
  const record = objectValue(input)
  const resultRecord = objectValue(record.result)
  const resultMetadata = objectValue(resultRecord.metadata)
  const runId = stringValue(record.run_id) || stringValue(record.runId) || stringValue(record.id) || stringValue(resultMetadata.run_id) || stringValue(record.job_id) || stringValue(record.jobId)
  if (!runId) return undefined

  return codeboxAsyncAgentTaskResult({
    run_id: runId,
    state: record.state ?? record.status ?? resultRecord.status,
    success: typeof record.success === "boolean" ? record.success : undefined,
    result: record.result ?? record,
    artifact_result: record.artifact_result ?? record.artifactResult,
    runtime_access: record.runtime_access ?? record.runtimeAccess,
    lease: record.lease ?? objectValue(record.runtime_access).lease,
    diagnostics: record.diagnostics,
    metadata: objectValue(record.metadata),
  })
}

export function isTerminalAsyncAgentTaskState(state: unknown): boolean {
  const normalized = normalizeAsyncAgentTaskState(state)
  return normalized === "succeeded" || normalized === "failed" || normalized === "cancelled" || normalized === "expired"
}

export function normalizeAsyncAgentTaskState(state: unknown, success?: boolean): CodeboxAsyncAgentTaskState {
  const value = stringValue(state).toLowerCase().replace(/_/g, "-")
  if (value === "queued" || value === "pending" || value === "created") return "queued"
  if (value === "running" || value === "in-progress" || value === "active") return "running"
  if (value === "succeeded" || value === "success" || value === "successful" || value === "completed" || value === "complete") return "succeeded"
  if (value === "failed" || value === "failure" || value === "error" || value === "provider-error" || value === "timeout") return "failed"
  if (value === "cancelled" || value === "canceled") return "cancelled"
  if (value === "expired") return "expired"
  if (typeof success === "boolean") return success ? "succeeded" : "failed"
  return value || "unknown"
}

function normalizeOptionalRuntimeAccess(input: unknown): RuntimeAccess | undefined {
  if (!isPlainObject(input)) return undefined
  try {
    return normalizeRuntimeAccess(input)
  } catch {
    return undefined
  }
}

function normalizeOptionalPreviewLease(input: unknown): PreviewLease | undefined {
  if (!isPlainObject(input)) return undefined
  try {
    return previewLease(input)
  } catch {
    return undefined
  }
}

function normalizeOptionalArtifactResult(input: unknown): ArtifactResultEnvelope | undefined {
  if (!isPlainObject(input)) return undefined
  return normalizeArtifactResultEnvelope(input, "agent-task-run")
}

function normalizeRecordList(input: unknown): Array<Record<string, unknown>> {
  return Array.isArray(input) ? input.filter(isPlainObject) : []
}
