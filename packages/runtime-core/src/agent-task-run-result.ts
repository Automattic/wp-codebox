import { isPlainObject, numberValue, objectValue, stringValue, stripUndefined } from "./object-utils.js"
import { normalizeAgentTerminalResult, type AgentTerminalResult } from "./agent-terminal-result.js"
import { normalizeAgentTaskStatus } from "./status-taxonomy.js"

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
  terminal_result?: AgentTerminalResult
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
  compatMode?: boolean
}

export function normalizeAgentTaskRunResult(raw: unknown, options: AgentTaskRunResultOptions = {}): AgentTaskRunResultSummary {
  const result = objectValue(raw)
  const exitStatus = options.exitStatus ?? 0
  const compatMode = options.compatMode === true
  const compatibilityDiagnostics: Array<Record<string, unknown>> = []
  const agentResult = agentResultRecord(result, compatMode, compatibilityDiagnostics)
  const completionOutcome = completionOutcomeRecord(result, compatMode, compatibilityDiagnostics)
  const runMetadata = objectValue(result.run_metadata)
  const patch = objectValue(agentResult.patch)
  const terminalResult = terminalResultRecord(result, agentResult, compatMode, compatibilityDiagnostics)
  const status = normalizeStatus(result, agentResult, exitStatus, terminalResult)
  const artifacts = normalizeArtifacts(result, agentResult, completionOutcome, compatMode, compatibilityDiagnostics)
  const noOp = noOpMetadata(result, agentResult)
  const failureClassification = stringValue(result.failure_classification) || terminalResult?.failure_classification || failureClassificationForStatus(status)

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
    diagnostics: [...arrayObjects(result.diagnostics), ...compatibilityDiagnostics, ...(terminalResult?.diagnostics ?? [])],
    metadata: stripUndefined({
      run_id: stringValue(runRecord(result, compatMode, compatibilityDiagnostics).runId) || stringValue(runMetadata.run_id),
      run_status: stringValue(runRecord(result, compatMode, compatibilityDiagnostics).status) || stringValue(runMetadata.run_status),
      runtime_id: stringValue(runtimeRecord(result, compatMode, compatibilityDiagnostics).id) || stringValue(runMetadata.runtime_id),
      runtime_status: stringValue(runtimeRecord(result, compatMode, compatibilityDiagnostics).status) || stringValue(runMetadata.runtime_status),
      changed_files_count: noOp.changed_files_count,
      patch_bytes: noOp.patch_bytes,
      patch_sha256: stringValue(patch.sha256),
      no_op_reason: noOp.reason,
      completion_status: stringValue(completionOutcome.status),
      completion_next_action: stringValue(completionOutcome.nextAction),
      confidence: stringValue(completionOutcome.confidence),
      provider_error: objectValue(result.provider_error),
      timeout: result.timeout === true ? true : undefined,
      failure_evidence: objectValue(result.failure_evidence),
    }),
    terminal_result: terminalResult,
    no_op: noOp,
    failure_classification: failureClassification || undefined,
  }) as AgentTaskRunResultSummary
}

function normalizeStatus(result: Record<string, unknown>, agentResult: Record<string, unknown>, exitStatus: number, terminalResult?: AgentTerminalResult): AgentTaskRunStatus {
  if (terminalResult) {
    if (terminalResult.status === "max_turns") return "timeout"
    if (terminalResult.status === "incomplete") return "failed"
    const terminalStatus = normalizeAgentTaskStatus({ status: terminalResult.status, success: terminalResult.success })
    if (terminalStatus === "succeeded" || terminalStatus === "failed" || terminalStatus === "no_op" || terminalStatus === "timeout" || terminalStatus === "provider_error" || terminalStatus === "unable_to_remediate") return terminalStatus
  }

  if (noOpMetadata(result, agentResult).detected) return "no_op"
  return normalizeAgentTaskStatus({
    status: result.status,
    success: result.success,
    exitStatus,
    timeout: result.timeout,
    providerError: result.provider_error,
    unableToRemediate: result.unable_to_remediate,
  })
}

function normalizeArtifacts(result: Record<string, unknown>, agentResult: Record<string, unknown>, completionOutcome: Record<string, unknown>, compatMode: boolean, diagnostics: Array<Record<string, unknown>>): AgentTaskRunArtifactRef[] {
  const artifacts: AgentTaskRunArtifactRef[] = []
  for (const artifact of arrayObjects(result.artifacts)) {
    appendUniqueArtifact(artifacts, artifactFromResultArtifact(artifact))
  }

  for (const ref of arrayObjects(runRecord(result, compatMode, diagnostics).artifactRefs)) {
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
      runtime_id: stringValue(runtimeRecord(result, compatMode, diagnostics).id),
      runtime_status: stringValue(runtimeRecord(result, compatMode, diagnostics).status),
    }),
  }))

  appendUniqueArtifact(artifacts, artifactFromAgentResult("codebox-changed-files", "codebox-changed-files", bundleDirectory, objectValue(agentResult.changedFiles)))
  appendUniqueArtifact(artifacts, artifactFromAgentResult("codebox-patch", "codebox-patch", bundleDirectory, objectValue(agentResult.patch)))
  appendUniqueArtifact(artifacts, artifactFromAgentResult("codebox-transcript", "codebox-transcript", bundleDirectory, objectValue(agentResult.transcript)))

  const runtimeLogPath = stringValue(objectValue(result.artifacts).runtimeLogPath)
  appendUniqueArtifact(artifacts, stripUndefined({ id: runtimeLogPath ? "codebox-runtime-log" : "", kind: "codebox-runtime-log", path: runtimeLogPath }))
  const commandsLogPath = stringValue(objectValue(result.artifacts).commandsLogPath)
  appendUniqueArtifact(artifacts, stripUndefined({ id: commandsLogPath ? "codebox-command-log" : "", kind: "codebox-command-log", path: commandsLogPath }))

  const runtime = runtimeRecord(result, compatMode, diagnostics)
  appendUniqueArtifact(artifacts, stripUndefined({
    id: stringValue(runtime.id),
    kind: "codebox-runtime",
    metadata: stripUndefined({ status: stringValue(runtime.status) }),
  }))

  return artifacts
}

function artifactFromResultArtifact(artifact: Record<string, unknown>): AgentTaskRunArtifactRef {
  return stripUndefined({
    id: stringValue(artifact.id),
    kind: stringValue(artifact.kind),
    path: stringValue(artifact.path),
    url: stringValue(artifact.url) || stringValue(artifact.uri),
    sha256: stringValue(artifact.sha256),
    size_bytes: numberValue(artifact.size_bytes) ?? numberValue(artifact.sizeBytes),
    metadata: objectValue(artifact.metadata),
  }) as AgentTaskRunArtifactRef
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

function agentResultRecord(result: Record<string, unknown>, compatMode: boolean, diagnostics: Array<Record<string, unknown>>): Record<string, unknown> {
  const metadataRecipeRun = objectValue(objectValue(result.metadata).recipe_run)
  const canonical = firstObject(objectValue(result.run).agentResult, result.agentResult)
  if (Object.keys(canonical).length > 0 || !compatMode) return canonical

  return firstCompatObject(diagnostics, "agent-result-legacy-shape", result.agent_result, result.agent_task_result, metadataRecipeRun.agentResult, metadataRecipeRun.agent_task_result, objectValue(metadataRecipeRun.run).agentResult)
}

function completionOutcomeRecord(result: Record<string, unknown>, compatMode: boolean, diagnostics: Array<Record<string, unknown>>): Record<string, unknown> {
  const metadataRecipeRun = objectValue(objectValue(result.metadata).recipe_run)
  const canonical = firstObject(result.completionOutcome)
  if (Object.keys(canonical).length > 0 || !compatMode) return canonical

  return firstCompatObject(diagnostics, "completion-outcome-legacy-shape", result.completion_outcome, metadataRecipeRun.completionOutcome, metadataRecipeRun.completion_outcome)
}

function runRecord(result: Record<string, unknown>, compatMode = false, diagnostics: Array<Record<string, unknown>> = []): Record<string, unknown> {
  const metadataRecipeRun = objectValue(objectValue(result.metadata).recipe_run)
  const canonical = firstObject(result.run)
  if (Object.keys(canonical).length > 0 || !compatMode) return canonical

  return firstCompatObject(diagnostics, "run-record-legacy-shape", metadataRecipeRun.run)
}

function runtimeRecord(result: Record<string, unknown>, compatMode = false, diagnostics: Array<Record<string, unknown>> = []): Record<string, unknown> {
  const metadataRecipeRun = objectValue(objectValue(result.metadata).recipe_run)
  const canonical = firstObject(runRecord(result, compatMode, diagnostics).runtime)
  if (Object.keys(canonical).length > 0 || !compatMode) return canonical

  return firstCompatObject(diagnostics, "runtime-record-legacy-shape", objectValue(metadataRecipeRun.run).runtime)
}

function terminalResultRecord(result: Record<string, unknown>, agentResult: Record<string, unknown>, compatMode: boolean, diagnostics: Array<Record<string, unknown>>): AgentTerminalResult | undefined {
  const canonical = normalizeAgentTerminalResult(result.terminal_result)
  if (canonical || !compatMode) return canonical

  const candidates = [result.terminalResult, agentResult.terminal_result, agentResult.terminalResult, objectValue(agentResult.raw).agent_runtime]
  for (const candidate of candidates) {
    const terminalResult = normalizeAgentTerminalResult(candidate, { compatMode: true })
    if (terminalResult) {
      pushCompatibilityDiagnostic(diagnostics, "terminal-result-legacy-shape")
      return terminalResult
    }
  }
  return undefined
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

function firstObject(...values: unknown[]): Record<string, unknown> {
  for (const value of values) {
    if (isPlainObject(value) && Object.keys(value).length > 0) return value
  }
  return {}
}

function firstCompatObject(diagnostics: Array<Record<string, unknown>>, adapter: string, ...values: unknown[]): Record<string, unknown> {
  const value = firstObject(...values)
  if (Object.keys(value).length > 0) pushCompatibilityDiagnostic(diagnostics, adapter)
  return value
}

function pushCompatibilityDiagnostic(diagnostics: Array<Record<string, unknown>>, adapter: string): void {
  if (diagnostics.some((diagnostic) => objectValue(diagnostic.data).adapter === adapter)) return
  diagnostics.push(compatibilityDiagnostic(adapter))
}

function compatibilityDiagnostic(adapter: string): Record<string, unknown> {
  return {
    class: "wp-codebox.normalizer.compat_mode_used",
    message: "Agent task run result was parsed using explicit normalizer compatibility mode.",
    data: { adapter },
  }
}

function arrayObjects(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isPlainObject) : []
}
