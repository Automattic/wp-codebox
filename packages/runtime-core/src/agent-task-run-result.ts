import { isPlainObject, stripUndefined } from "./object-utils.js"

export const AGENT_TASK_RUN_RESULT_SCHEMA = "wp-codebox/agent-task-run-result/v1" as const

export type AgentTaskRunStatus =
  | "succeeded"
  | "failed"
  | "no_op"
  | "timeout"
  | "provider_error"
  | "unable_to_remediate"
  | (string & {})

export type AgentTaskRunFailureClassification = "provider" | "timeout" | "runtime" | "task" | (string & {})

export interface AgentTaskRunArtifactRef {
  id?: string
  kind: string
  path?: string
  url?: string
  sha256?: string
  size_bytes?: number
  metadata?: Record<string, unknown>
}

export interface AgentTaskRunResultSummary {
  schema: typeof AGENT_TASK_RUN_RESULT_SCHEMA
  status: AgentTaskRunStatus
  success: boolean
  summary: string
  artifacts: AgentTaskRunArtifactRef[]
  refs: {
    artifact_bundles: AgentTaskRunArtifactRef[]
    changed_files: AgentTaskRunArtifactRef[]
    patches: AgentTaskRunArtifactRef[]
    transcripts: AgentTaskRunArtifactRef[]
    logs: AgentTaskRunArtifactRef[]
    runtimes: AgentTaskRunArtifactRef[]
  }
  diagnostics: Array<Record<string, unknown>>
  metadata: Record<string, unknown>
  no_op: {
    detected: boolean
    reason?: string
    changed_files_count?: number
    patch_bytes?: number
  }
  failure_classification?: AgentTaskRunFailureClassification
}

export interface AgentTaskRunResultOptions {
  exitStatus?: number
}

const KNOWN_STATUSES = new Set(["succeeded", "failed", "no_op", "timeout", "provider_error", "unable_to_remediate"])

export function normalizeAgentTaskRunResult(raw: unknown, options: AgentTaskRunResultOptions = {}): AgentTaskRunResultSummary {
  const result = objectValue(raw)
  const exitStatus = options.exitStatus ?? 0
  const agentResult = agentResultRecord(result)
  const completionOutcome = completionOutcomeRecord(result)
  const runMetadata = objectValue(result.run_metadata)
  const patch = objectValue(agentResult.patch)
  const status = normalizeStatus(result, agentResult, exitStatus)
  const artifacts = normalizeArtifacts(result, agentResult, completionOutcome)
  const noOp = noOpMetadata(result, agentResult)
  const failureClassification = stringValue(result.failure_classification) || failureClassificationForStatus(status)

  return stripUndefined({
    schema: AGENT_TASK_RUN_RESULT_SCHEMA,
    status,
    success: status === "succeeded" || status === "no_op",
    summary: stringValue(result.summary) || stringValue(result.message) || stringValue(agentResult.summary) || defaultSummary(status),
    artifacts,
    refs: {
      artifact_bundles: artifacts.filter((artifact) => artifact.kind === "artifact-bundle" || artifact.kind === "codebox-artifact-bundle"),
      changed_files: artifacts.filter((artifact) => artifact.kind === "codebox-changed-files"),
      patches: artifacts.filter((artifact) => artifact.kind === "codebox-patch"),
      transcripts: artifacts.filter((artifact) => artifact.kind === "codebox-transcript"),
      logs: artifacts.filter((artifact) => artifact.kind === "codebox-runtime-log" || artifact.kind === "codebox-command-log"),
      runtimes: artifacts.filter((artifact) => artifact.kind === "codebox-runtime"),
    },
    diagnostics: arrayObjects(result.diagnostics),
    metadata: stripUndefined({
      run_id: stringValue(runRecord(result).runId) || stringValue(runMetadata.run_id),
      run_status: stringValue(runRecord(result).status) || stringValue(runMetadata.run_status),
      runtime_id: stringValue(runtimeRecord(result).id) || stringValue(runMetadata.runtime_id),
      runtime_status: stringValue(runtimeRecord(result).status) || stringValue(runMetadata.runtime_status),
      changed_files_count: noOp.changed_files_count,
      patch_bytes: noOp.patch_bytes,
      patch_sha256: stringValue(patch.sha256),
      no_op_reason: noOp.reason,
      completion_status: stringValue(completionOutcome.status),
      completion_next_action: stringValue(completionOutcome.nextAction),
      confidence: stringValue(completionOutcome.confidence),
      provider_error: objectValue(result.provider_error),
      timeout: result.timeout === true ? true : undefined,
    }),
    no_op: noOp,
    failure_classification: failureClassification || undefined,
  }) as AgentTaskRunResultSummary
}

function normalizeStatus(result: Record<string, unknown>, agentResult: Record<string, unknown>, exitStatus: number): AgentTaskRunStatus {
  const explicitStatus = stringValue(result.status)
  if (KNOWN_STATUSES.has(explicitStatus)) return explicitStatus as AgentTaskRunStatus
  if (explicitStatus === "completed") return result.success === true && exitStatus === 0 ? "succeeded" : "failed"

  if (noOpMetadata(result, agentResult).detected) return "no_op"
  if (result.unable_to_remediate === true) return "unable_to_remediate"
  if (result.timeout === true) return "timeout"
  if (result.provider_error) return "provider_error"

  return result.success === true && exitStatus === 0 ? "succeeded" : "failed"
}

function normalizeArtifacts(result: Record<string, unknown>, agentResult: Record<string, unknown>, completionOutcome: Record<string, unknown>): AgentTaskRunArtifactRef[] {
  const artifacts: AgentTaskRunArtifactRef[] = []
  for (const ref of arrayObjects(runRecord(result).artifactRefs)) {
    const digest = objectValue(ref.digest)
    appendUniqueArtifact(artifacts, stripUndefined({
      id: stringValue(ref.id) || stringValue(digest.value),
      kind: stringValue(ref.kind) || "codebox-artifact-bundle",
      path: stringValue(ref.directory),
      sha256: stringValue(digest.value),
      metadata: Object.keys(digest).length ? { digest } : undefined,
    }))
  }

  const bundleDirectory = stringValue(objectValue(agentResult.artifacts).directory)
    || stringValue(objectValue(objectValue(result.agent_result).artifacts).directory)
    || stringValue(objectValue(completionOutcome.provenance).artifactDirectory)
    || stringValue(objectValue(objectValue(result.session).artifacts).path)
  const artifactBundleId = stringValue(objectValue(completionOutcome.provenance).artifactBundleId)
    || stringValue(objectValue(objectValue(result.session).artifacts).bundle_id)
    || stringValue(objectValue(result.artifacts).id)
  appendUniqueArtifact(artifacts, stripUndefined({
    id: artifactBundleId,
    kind: "codebox-artifact-bundle",
    path: bundleDirectory,
    metadata: stripUndefined({
      runtime_id: stringValue(runtimeRecord(result).id),
      runtime_status: stringValue(runtimeRecord(result).status),
    }),
  }))

  appendUniqueArtifact(artifacts, artifactFromAgentResult("codebox-changed-files", "codebox-changed-files", bundleDirectory, objectValue(agentResult.changedFiles)))
  appendUniqueArtifact(artifacts, artifactFromAgentResult("codebox-patch", "codebox-patch", bundleDirectory, objectValue(agentResult.patch)))
  appendUniqueArtifact(artifacts, artifactFromAgentResult("codebox-transcript", "codebox-transcript", bundleDirectory, objectValue(agentResult.transcript)))

  const runtimeLogPath = stringValue(objectValue(result.artifacts).runtimeLogPath)
  appendUniqueArtifact(artifacts, stripUndefined({ id: runtimeLogPath ? "codebox-runtime-log" : "", kind: "codebox-runtime-log", path: runtimeLogPath }))
  const commandsLogPath = stringValue(objectValue(result.artifacts).commandsLogPath)
  appendUniqueArtifact(artifacts, stripUndefined({ id: commandsLogPath ? "codebox-command-log" : "", kind: "codebox-command-log", path: commandsLogPath }))

  const runtime = runtimeRecord(result)
  appendUniqueArtifact(artifacts, stripUndefined({
    id: stringValue(runtime.id),
    kind: "codebox-runtime",
    metadata: stripUndefined({ status: stringValue(runtime.status) }),
  }))

  return artifacts
}

function artifactFromAgentResult(id: string, kind: string, root: string, metadata: Record<string, unknown>): AgentTaskRunArtifactRef {
  const path = artifactPath(root, stringValue(metadata.artifact))
  return stripUndefined({
    id: path ? id : "",
    kind,
    path,
    sha256: stringValue(metadata.sha256),
    size_bytes: numberValue(metadata.bytes),
    metadata,
  })
}

function noOpMetadata(result: Record<string, unknown>, agentResult: Record<string, unknown>): AgentTaskRunResultSummary["no_op"] {
  const changedFilesCount = numberValue(objectValue(agentResult.changedFiles).count)
  const patchBytes = numberValue(objectValue(agentResult.patch).bytes)
  const reason = stringValue(agentResult.noOpReason) || stringValue(result.no_op_reason)
  const detected = result.outcome === "no_op"
    || result.no_op === true
    || (result.success === true && Boolean(reason) && changedFilesCount === 0 && patchBytes === 0)

  return stripUndefined({ detected, reason, changed_files_count: changedFilesCount, patch_bytes: patchBytes })
}

function agentResultRecord(result: Record<string, unknown>): Record<string, unknown> {
  const metadataRecipeRun = objectValue(objectValue(result.metadata).recipe_run)
  return firstObject(
    objectValue(result.run).agentResult,
    result.agentResult,
    result.agent_result,
    metadataRecipeRun.agentResult,
    objectValue(metadataRecipeRun.run).agentResult,
  )
}

function completionOutcomeRecord(result: Record<string, unknown>): Record<string, unknown> {
  const metadataRecipeRun = objectValue(objectValue(result.metadata).recipe_run)
  return firstObject(result.completionOutcome, result.completion_outcome, metadataRecipeRun.completionOutcome)
}

function runRecord(result: Record<string, unknown>): Record<string, unknown> {
  const metadataRecipeRun = objectValue(objectValue(result.metadata).recipe_run)
  return firstObject(result.run, metadataRecipeRun.run)
}

function runtimeRecord(result: Record<string, unknown>): Record<string, unknown> {
  const metadataRecipeRun = objectValue(objectValue(result.metadata).recipe_run)
  return firstObject(runRecord(result).runtime, objectValue(metadataRecipeRun.run).runtime)
}

function failureClassificationForStatus(status: AgentTaskRunStatus): AgentTaskRunFailureClassification | "" {
  if (status === "provider_error") return "provider"
  if (status === "timeout") return "timeout"
  if (status === "failed") return "runtime"
  return ""
}

function defaultSummary(status: AgentTaskRunStatus): string {
  if (status === "succeeded") return "WP Codebox agent task succeeded."
  if (status === "no_op") return "WP Codebox agent task completed without actionable file changes."
  return "WP Codebox agent task failed."
}

function appendUniqueArtifact(artifacts: AgentTaskRunArtifactRef[], artifact: AgentTaskRunArtifactRef): void {
  if (!artifact.kind) return
  const key = artifact.path || artifact.url || artifact.id
  if (!key) return
  if (artifacts.some((existing) => (existing.path || existing.url || existing.id) === key)) return
  artifacts.push(artifact)
}

function artifactPath(root: string, relativePath: string): string {
  if (!root || !relativePath) return ""
  return `${root.replace(/\/$/, "")}/${relativePath.replace(/^\//, "")}`
}

function objectValue(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {}
}

function firstObject(...values: unknown[]): Record<string, unknown> {
  for (const value of values) {
    if (isPlainObject(value) && Object.keys(value).length > 0) return value
  }
  return {}
}

function arrayObjects(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isPlainObject) : []
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}
