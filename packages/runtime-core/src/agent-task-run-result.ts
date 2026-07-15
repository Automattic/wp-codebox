import { isPlainObject, numberValue, objectValue, stringValue, stripUndefined } from "./object-utils.js"
import { normalizeAgentTerminalResult, type AgentTerminalResult } from "./agent-terminal-result.js"
import { RUNTIME_ACCESS_SCHEMA, normalizeRuntimeAccess, type RuntimeAccess } from "./runtime-boundary-contracts.js"
import { normalizeAgentTaskStatus } from "./status-taxonomy.js"
import { normalizeToolObservability } from "./tool-observability.js"

export const AGENT_TASK_RUN_RESULT_SCHEMA = "wp-codebox/agent-task-run-result/v1" as const

export const AGENT_TASK_RUN_RESULT_JSON_SCHEMA = {
  type: "object",
  required: ["schema", "status", "success", "summary", "artifacts", "refs", "diagnostics", "metadata", "no_op"],
  properties: {
    schema: { type: "string", const: AGENT_TASK_RUN_RESULT_SCHEMA },
    status: { type: "string" },
    success: { type: "boolean" },
    summary: { type: "string" },
    artifacts: { type: "array", items: { type: "object" } },
    refs: {
      type: "object",
      properties: {
        artifact_bundles: { type: "array", items: { type: "object" } },
        changed_files: { type: "array", items: { type: "object" } },
        patches: { type: "array", items: { type: "object" } },
        transcripts: { type: "array", items: { type: "object" } },
        logs: { type: "array", items: { type: "object" } },
        runtimes: { type: "array", items: { type: "object" } },
        evidence_bundles: { type: "array", items: { type: "object" } },
      },
    },
    diagnostics: { type: "array", items: { type: "object" } },
    metadata: { type: "object" },
    terminal_result: { type: "object" },
    runtime_access: { type: "object" },
    no_op: { type: "object" },
    failure_classification: { type: "string" },
  },
} as const

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
    evidence_bundles: AgentTaskRunArtifactRef[]
  }
  diagnostics: Array<Record<string, unknown>>
  metadata: Record<string, unknown>
  terminal_result?: AgentTerminalResult
  runtime_access?: RuntimeAccess
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

export function normalizeAgentTaskRunResult(raw: unknown, options: AgentTaskRunResultOptions = {}): AgentTaskRunResultSummary {
  const result = objectValue(raw)
  const exitStatus = options.exitStatus ?? 0
  const agentResult = agentResultRecord(result)
  const completionOutcome = completionOutcomeRecord(result)
  const runMetadata = objectValue(result.run_metadata)
  const patch = objectValue(agentResult.patch)
  const terminalResult = terminalResultForCompletion(
    terminalResultRecord(result, agentResult),
    completionOutcome,
  )
  const status = normalizeStatus(result, agentResult, exitStatus, terminalResult)
  const artifacts = normalizeArtifacts(result, agentResult, completionOutcome)
  const noOp = noOpMetadata(result, agentResult)
  const failureClassification = status === "succeeded" || status === "no_op"
    ? ""
    : stringValue(result.failure_classification) || terminalResult?.failure_classification || failureClassificationForStatus(status)

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
      evidence_bundles: artifacts.filter((artifact) => artifact.kind === "evidence-bundle" || artifact.kind === "codebox-evidence-bundle"),
    },
    diagnostics: [...arrayObjects(result.diagnostics), ...(terminalResult?.diagnostics ?? [])],
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
      failure_evidence: objectValue(result.failure_evidence),
      tool_observability: normalizeToolObservability(result.metadata) ?? normalizeToolObservability(agentResult.metadata),
    }),
    terminal_result: terminalResult,
    runtime_access: agentTaskRuntimeAccess(result),
    no_op: noOp,
    failure_classification: failureClassification || undefined,
  }) as AgentTaskRunResultSummary
}

function agentTaskRuntimeAccess(result: Record<string, unknown>): RuntimeAccess | undefined {
  const explicit = objectValue(result.runtime_access)
  const outputs = objectValue(result.outputs)
  const preview = firstObject(result.preview, outputs.preview)
  const source = firstObject(explicit, outputs.runtime_access, outputs.runtimeAccess, outputs)
  const reviewerAccess = objectValue(source.reviewer_access ?? source.reviewerAccess ?? preview.reviewerAccess ?? preview.reviewer_access)
  const reviewerUrl = stringValue(reviewerAccess.openUrl) || stringValue(reviewerAccess.targetUrl)
  const publicUrl = stringValue(source.public_url ?? source.publicUrl ?? source.preview_public_url ?? source.previewPublicUrl) || stringValue(preview.publicUrl ?? preview.public_url ?? preview.previewPublicUrl ?? preview.preview_public_url)
  const siteUrl = stringValue(source.site_url ?? source.siteUrl) || stringValue(preview.siteUrl ?? preview.site_url)
  const directPreviewUrl = stringValue(source.preview_url ?? source.previewUrl) || stringValue(preview.preview_url ?? preview.previewUrl)
  const fallbackPreviewUrl = directPreviewUrl || (publicUrl || siteUrl || reviewerUrl ? "" : stringValue(preview.url))
  const candidate = stripUndefined({
    schema: RUNTIME_ACCESS_SCHEMA,
    preview_url: fallbackPreviewUrl,
    public_url: publicUrl,
    site_url: siteUrl,
    local_url: stringValue(source.local_url ?? source.localUrl) || stringValue(preview.localUrl ?? preview.local_url),
    admin_url: stringValue(source.admin_url ?? source.adminUrl),
    lease: source.lease ?? preview.lease,
    reviewer_access: Object.keys(reviewerAccess).length > 0 ? reviewerAccess : undefined,
    metadata: Object.keys(objectValue(source.metadata)).length > 0 ? objectValue(source.metadata) : undefined,
  })

  try {
    return normalizeRuntimeAccess(candidate)
  } catch {
    return undefined
  }
}

function normalizeStatus(result: Record<string, unknown>, agentResult: Record<string, unknown>, exitStatus: number, terminalResult?: AgentTerminalResult): AgentTaskRunStatus {
  const noOp = noOpMetadata(result, agentResult)
  if (terminalResult) {
    if (terminalResult.status === "max_turns") return "timeout"
    if (terminalResult.status === "incomplete" && noOp.detected) return "no_op"
    if (terminalResult.status === "incomplete") return "failed"
    const terminalStatus = normalizeAgentTaskStatus({ status: terminalResult.status, success: terminalResult.success })
    if (terminalStatus === "succeeded" || terminalStatus === "failed" || terminalStatus === "no_op" || terminalStatus === "timeout" || terminalStatus === "provider_error" || terminalStatus === "unable_to_remediate") return terminalStatus
  }

  if (noOp.detected) return "no_op"
  return normalizeAgentTaskStatus({
    status: result.status,
    success: result.success,
    exitStatus,
    timeout: result.timeout,
    providerError: result.provider_error,
    unableToRemediate: result.unable_to_remediate,
  })
}

function normalizeArtifacts(result: Record<string, unknown>, agentResult: Record<string, unknown>, completionOutcome: Record<string, unknown>): AgentTaskRunArtifactRef[] {
  const artifacts: AgentTaskRunArtifactRef[] = []
  const artifactPolicy = objectValue(result.workspace_artifact_policy ?? result.workspaceArtifactPolicy)
  const publicUrlRoot = stringValue(artifactPolicy.public_url_root ?? artifactPolicy.publicUrlRoot)
  for (const artifact of artifactRecords(result.artifacts)) {
    appendUniqueArtifact(artifacts, withPublicArtifactUrl(artifactFromResultArtifact(artifact), publicUrlRoot, ""))
  }

  for (const ref of arrayObjects(runRecord(result).artifactRefs)) {
    const digest = objectValue(ref.digest)
    appendUniqueArtifact(artifacts, withPublicArtifactUrl(stripUndefined({
      id: stringValue(ref.id) || stringValue(digest.value),
      kind: stringValue(ref.kind) || "codebox-artifact-bundle",
      path: stringValue(ref.directory),
      sha256: stringValue(digest.value),
      metadata: Object.keys(digest).length ? { digest } : undefined,
    }), publicUrlRoot, ""))
  }

  const bundleDirectory = stringValue(objectValue(agentResult.artifacts).directory)
    || stringValue(objectValue(completionOutcome.provenance).artifactDirectory)
    || stringValue(objectValue(objectValue(result.session).artifacts).path)
  const artifactBundleId = stringValue(objectValue(completionOutcome.provenance).artifactBundleId)
    || stringValue(objectValue(objectValue(result.session).artifacts).bundle_id)
    || stringValue(objectValue(result.artifacts).id)
  appendUniqueArtifact(artifacts, withPublicArtifactUrl(stripUndefined({
    id: artifactBundleId,
    kind: "codebox-artifact-bundle",
    path: bundleDirectory,
    metadata: stripUndefined({
      runtime_id: stringValue(runtimeRecord(result).id),
      runtime_status: stringValue(runtimeRecord(result).status),
    }),
  }), publicUrlRoot, bundleDirectory))

  appendUniqueArtifact(artifacts, withPublicArtifactUrl(artifactFromAgentResult("codebox-changed-files", "codebox-changed-files", bundleDirectory, objectValue(agentResult.changedFiles)), publicUrlRoot, bundleDirectory))
  appendUniqueArtifact(artifacts, withPublicArtifactUrl(artifactFromAgentResult("codebox-patch", "codebox-patch", bundleDirectory, objectValue(agentResult.patch)), publicUrlRoot, bundleDirectory))
  appendUniqueArtifact(artifacts, withPublicArtifactUrl(artifactFromAgentResult("codebox-transcript", "codebox-transcript", bundleDirectory, objectValue(agentResult.transcript)), publicUrlRoot, bundleDirectory))

  const runtimeLogPath = stringValue(objectValue(result.artifacts).runtimeLogPath)
  appendUniqueArtifact(artifacts, withPublicArtifactUrl(stripUndefined({ id: runtimeLogPath ? "codebox-runtime-log" : "", kind: "codebox-runtime-log", path: runtimeLogPath }), publicUrlRoot, bundleDirectory))
  const commandsLogPath = stringValue(objectValue(result.artifacts).commandsLogPath)
  appendUniqueArtifact(artifacts, withPublicArtifactUrl(stripUndefined({ id: commandsLogPath ? "codebox-command-log" : "", kind: "codebox-command-log", path: commandsLogPath }), publicUrlRoot, bundleDirectory))

  for (const evidenceRef of arrayObjects(result.evidence_refs)) {
    appendUniqueArtifact(artifacts, withPublicArtifactUrl(artifactFromResultArtifact({ kind: "codebox-evidence-bundle", ...evidenceRef }), publicUrlRoot, bundleDirectory))
  }

  const runtime = runtimeRecord(result)
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
    url: stringValue(artifact.url) || stringValue(artifact.uri) || stringValue(artifact.public_url) || stringValue(artifact.publicUrl),
    sha256: stringValue(artifact.sha256),
    size_bytes: numberValue(artifact.size_bytes) ?? numberValue(artifact.sizeBytes),
    metadata: objectValue(artifact.metadata),
  }) as AgentTaskRunArtifactRef
}

function artifactRecords(value: unknown): Record<string, unknown>[] {
  const list = arrayObjects(value)
  if (list.length > 0) return list
  const artifact = objectValue(value)
  if (stringValue(artifact.kind)) return [artifact]
  return arrayObjects(artifact.items ?? artifact.files ?? artifact.artifacts)
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
  const explicitNoOp = objectValue(result.no_op)
  const changedFilesCount = numberValue(objectValue(agentResult.changedFiles).count)
    ?? numberValue(explicitNoOp.changed_files_count)
    ?? numberValue(explicitNoOp.changedFilesCount)
  const patchBytes = numberValue(objectValue(agentResult.patch).bytes)
    ?? numberValue(explicitNoOp.patch_bytes)
    ?? numberValue(explicitNoOp.patchBytes)
  const reason = stringValue(agentResult.noOpReason) || stringValue(result.no_op_reason) || stringValue(explicitNoOp.reason)
  const detected = result.outcome === "no_op"
    || result.no_op === true
    || explicitNoOp.detected === true
    || (result.success === true && Boolean(reason) && changedFilesCount === 0 && patchBytes === 0)

  return stripUndefined({ detected, reason, changed_files_count: changedFilesCount, patch_bytes: patchBytes })
}

function agentResultRecord(result: Record<string, unknown>): Record<string, unknown> {
  return firstObject(objectValue(result.run).agentResult, result.agentResult, result.agent_result)
}

function completionOutcomeRecord(result: Record<string, unknown>): Record<string, unknown> {
  return firstObject(result.completionOutcome)
}

function runRecord(result: Record<string, unknown>): Record<string, unknown> {
  return firstObject(result.run)
}

function runtimeRecord(result: Record<string, unknown>): Record<string, unknown> {
  return firstObject(runRecord(result).runtime)
}

function terminalResultRecord(result: Record<string, unknown>, agentResult: Record<string, unknown>): AgentTerminalResult | undefined {
  return normalizeAgentTerminalResult(result.terminal_result) ?? normalizeAgentTerminalResult(agentResult.terminal_result)
}

function terminalResultForCompletion(terminalResult: AgentTerminalResult | undefined, completionOutcome: Record<string, unknown>): AgentTerminalResult | undefined {
  if (stringValue(completionOutcome.status) !== "succeeded") return terminalResult
  if (terminalResult?.success === true && terminalResult.status === "succeeded") return terminalResult
  if (terminalResult && terminalResult.status !== "incomplete" && terminalResult.status !== "unknown") return terminalResult

  return {
    schema: "wp-codebox/agent-terminal-result/v1",
    terminal: true,
    status: "succeeded",
    success: true,
    source: terminalResult?.source ?? "canonical",
    evidence_refs: terminalResult?.evidence_refs ?? [],
  }
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

function withPublicArtifactUrl(artifact: AgentTaskRunArtifactRef, publicUrlRoot: string, bundleDirectory: string): AgentTaskRunArtifactRef {
  if (!artifact.path || artifact.url || !publicUrlRoot) return artifact
  const normalizedBundleDirectory = bundleDirectory.replace(/\/$/, "")
  const relativePath = normalizedBundleDirectory && artifact.path.startsWith(`${normalizedBundleDirectory}/`)
    ? artifact.path.slice(normalizedBundleDirectory.length + 1)
    : ""
  return stripUndefined({
    ...artifact,
    url: relativePath ? `${publicUrlRoot.replace(/\/$/, "")}/${relativePath.replace(/^\//, "")}` : undefined,
  }) as AgentTaskRunArtifactRef
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
