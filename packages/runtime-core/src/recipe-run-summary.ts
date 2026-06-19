import { normalizeAgentTaskRunResult, type AgentTaskRunArtifactRef } from "./agent-task-run-result.js"
import { normalizeBrowserArtifactSummaryRefs } from "./artifact-references.js"
import { isPlainObject, stripUndefined } from "./object-utils.js"

export const RECIPE_RUN_SUMMARY_SCHEMA = "wp-codebox/recipe-run-summary/v1" as const

export type RecipeRunSummaryStatus = "succeeded" | "failed" | "timeout" | "interrupted" | (string & {})

export interface RecipeRunSummary {
  schema: typeof RECIPE_RUN_SUMMARY_SCHEMA
  success: boolean
  status: RecipeRunSummaryStatus
  failed_phase?: string
  failure_summary?: string
  diagnostics: Array<Record<string, unknown>>
  artifacts: AgentTaskRunArtifactRef[]
  commands: RecipeRunCommandSummary[]
  preview?: RecipeRunPreviewSummary
  refs: {
    startup_logs: AgentTaskRunArtifactRef[]
    probe_json: AgentTaskRunArtifactRef[]
    screenshots: AgentTaskRunArtifactRef[]
    side_effects: AgentTaskRunArtifactRef[]
    declared_artifacts: AgentTaskRunArtifactRef[]
    artifact_bundles: AgentTaskRunArtifactRef[]
    changed_files: AgentTaskRunArtifactRef[]
    patches: AgentTaskRunArtifactRef[]
    transcripts: AgentTaskRunArtifactRef[]
    logs: AgentTaskRunArtifactRef[]
    runtimes: AgentTaskRunArtifactRef[]
  }
  metadata: Record<string, unknown>
}

export interface RecipeRunCommandSummary {
  index: number
  command: string
  status: "succeeded" | "failed" | "unknown"
  exit_code?: number
  duration_ms?: number
  recipe_phase?: string
  recipe_step_index?: number
  stdout_tail?: string
  stderr_tail?: string
}

export interface RecipeRunPreviewSummary {
  status?: string
  lifecycle?: string
  source?: string
  created_at?: string
  expires_at?: string
  hold_seconds?: number
  reviewer_access?: Record<string, unknown>
}

export interface RecipeRunSummaryOptions {
  exitStatus?: number
}

export function normalizeRecipeRunSummary(raw: unknown, options: RecipeRunSummaryOptions = {}): RecipeRunSummary {
  const result = objectValue(raw)
  const agentTask = normalizeAgentTaskRunResult(result, { exitStatus: options.exitStatus })
  const success = result.success === true || agentTask.success
  const failedPhase = failedPhaseFromRecipeRun(result)
  const diagnostics = arrayObjects(result.diagnostics)
  const artifacts = normalizeRecipeRunArtifacts(result, agentTask.artifacts)
  const commands = recipeRunCommandSummaries(result)
  const preview = recipeRunPreviewSummary(result)
  const summary = failureSummary(result, diagnostics, failedPhase)

  return stripUndefined({
    schema: RECIPE_RUN_SUMMARY_SCHEMA,
    success,
    status: recipeRunStatus(result, success),
    failed_phase: failedPhase,
    failure_summary: success ? undefined : summary,
    diagnostics,
    artifacts,
    refs: {
      startup_logs: artifacts.filter((artifact) => artifact.kind === "codebox-runtime-log" || artifact.kind === "codebox-command-log" || artifact.kind === "codebox-command-events" || artifact.kind === "codebox-event-log" || artifact.kind === "codebox-runtime-metadata"),
      probe_json: artifacts.filter((artifact) => artifact.kind === "browser-summary" || artifact.kind === "recipe-probe-results" || artifact.kind === "distribution-startup-probe-results"),
      screenshots: artifacts.filter((artifact) => artifact.kind === "browser-screenshot" || artifact.kind === "screenshot"),
      side_effects: artifacts.filter((artifact) => artifact.kind === "recipe-side-effects" || artifact.kind === "runtime-side-effects" || artifact.kind === "codebox-observations"),
      declared_artifacts: artifacts.filter((artifact) => artifact.kind === "recipe-declared-artifact" || artifact.kind === "recipe-declared-artifact-results"),
      artifact_bundles: artifacts.filter((artifact) => artifact.kind === "artifact-bundle" || artifact.kind === "codebox-artifact-bundle"),
      changed_files: artifacts.filter((artifact) => artifact.kind === "codebox-changed-files"),
      patches: artifacts.filter((artifact) => artifact.kind === "codebox-patch"),
      transcripts: artifacts.filter((artifact) => artifact.kind === "codebox-transcript"),
      logs: artifacts.filter((artifact) => artifact.kind === "codebox-runtime-log" || artifact.kind === "codebox-command-log" || artifact.kind === "codebox-command-events" || artifact.kind === "codebox-event-log"),
      runtimes: agentTask.refs.runtimes,
    },
    commands,
    preview,
    metadata: stripUndefined({
      run_id: stringValue(objectValue(result.run).runId) || stringValue(objectValue(result.run_metadata).run_id) || stringValue(agentTask.metadata.run_id),
      run_status: stringValue(objectValue(result.run).status) || stringValue(objectValue(result.run_metadata).run_status) || stringValue(agentTask.metadata.run_status),
      runtime_id: stringValue(objectValue(result.runtime).id) || stringValue(objectValue(result.run_metadata).runtime_id) || stringValue(agentTask.metadata.runtime_id),
      runtime_status: stringValue(objectValue(result.runtime).status) || stringValue(objectValue(result.run_metadata).runtime_status) || stringValue(agentTask.metadata.runtime_status),
      failure_classification: failureClassificationValue(result),
      failure_phase: failedPhase,
      artifact_directory: stringValue(objectValue(result.artifacts).directory) || stringValue(result.artifacts),
      recipe_path: stringValue(result.recipePath),
    }),
  }) as RecipeRunSummary
}

function recipeRunStatus(result: Record<string, unknown>, success: boolean): RecipeRunSummaryStatus {
  const explicit = stringValue(result.status)
  if (explicit === "completed") return success ? "succeeded" : "failed"
  if (explicit) return explicit
  if (result.interruption) return "interrupted"
  if (objectValue(result.error).name === "RecipeRunTimeoutError") return "timeout"
  return success ? "succeeded" : "failed"
}

function failedPhaseFromRecipeRun(result: Record<string, unknown>): string | undefined {
  const phaseEvidence = arrayObjects(result.phaseEvidence)
  const failedPhase = [...phaseEvidence].reverse().find((phase) => stringValue(phase.status) === "failed")
  if (failedPhase) return stringValue(failedPhase.name) || undefined

  const diagnosticPhase = arrayObjects(result.diagnostics).map((diagnostic) => stringValue(diagnostic.phase)).find(Boolean)
  if (diagnosticPhase) return diagnosticPhase

  const classification = objectValue(objectValue(objectValue(result.run).metadata).runResourceEvidence).reliability
  const failureClassification = objectValue(objectValue(classification).failureClassification)
  return stringValue(failureClassification.phase) || stringValue(objectValue(result.error).activeOperation) || undefined
}

function failureClassificationValue(result: Record<string, unknown>): string {
  const runResourceEvidence = objectValue(objectValue(objectValue(result.run).metadata).runResourceEvidence)
  const reliability = objectValue(runResourceEvidence.reliability)
  const failureClassification = objectValue(reliability.failureClassification)
  return stringValue(failureClassification.value)
}

function failureSummary(result: Record<string, unknown>, diagnostics: Array<Record<string, unknown>>, failedPhase?: string): string {
  const diagnosticMessage = diagnostics.map((diagnostic) => stringValue(diagnostic.message)).find(Boolean)
  const error = objectValue(result.error)
  const message = stringValue(error.message) || stringValue(result.message) || diagnosticMessage || "WP Codebox recipe run failed."
  return failedPhase ? `${failedPhase}: ${message}` : message
}

function normalizeRecipeRunArtifacts(result: Record<string, unknown>, agentTaskArtifacts: AgentTaskRunArtifactRef[]): AgentTaskRunArtifactRef[] {
  const artifacts: AgentTaskRunArtifactRef[] = []
  for (const artifact of agentTaskArtifacts) appendUniqueArtifact(artifacts, artifact)

  const bundle = objectValue(result.artifacts)
  const bundleDirectory = stringValue(bundle.directory) || stringValue(result.artifacts)
  appendUniqueArtifact(artifacts, stripUndefined({ id: stringValue(bundle.id), kind: "codebox-artifact-bundle", path: bundleDirectory, sha256: stringValue(bundle.contentDigest) }))
  appendPathArtifact(artifacts, "codebox-event-log", bundle.eventsPath)
  appendPathArtifact(artifacts, "codebox-command-events", bundle.commandsPath)
  appendPathArtifact(artifacts, "codebox-command-log", bundle.commandsLogPath || bundle.commandsPath)
  appendPathArtifact(artifacts, "codebox-runtime-log", bundle.runtimeLogPath)
  appendPathArtifact(artifacts, "codebox-runtime-metadata", bundle.metadataPath)
  appendPathArtifact(artifacts, "codebox-observations", bundle.observationsPath)
  appendPathArtifact(artifacts, "codebox-changed-files", bundle.changedFilesPath)
  appendPathArtifact(artifacts, "codebox-patch", bundle.patchPath)
  appendPathArtifact(artifacts, "recipe-side-effects", bundle.diffsPath)

  for (const probe of arrayObjects(result.probes)) {
    appendUniqueArtifact(artifacts, stripUndefined({
      id: stringValue(probe.name) || `recipe-probe-${numberValue(probe.index) ?? artifacts.length + 1}`,
      kind: "recipe-probe-result",
      metadata: probe,
    }))
  }

  for (const probe of arrayObjects(result.distributionStartupProbes)) {
    appendUniqueArtifact(artifacts, stripUndefined({
      id: stringValue(probe.name) || `distribution-startup-probe-${numberValue(probe.index) ?? artifacts.length + 1}`,
      kind: "distribution-startup-probe-result",
      metadata: probe,
    }))
  }

  for (const artifact of arrayObjects(result.distributionSetupArtifacts)) {
    appendUniqueArtifact(artifacts, stripUndefined({
      id: stringValue(artifact.name) || `distribution-setup-artifact-${numberValue(artifact.index) ?? artifacts.length + 1}`,
      kind: "distribution-setup-artifact-result",
      path: stringValue(artifact.source),
      metadata: artifact,
    }))
  }

  for (const artifact of arrayObjects(result.declaredArtifacts)) {
    appendUniqueArtifact(artifacts, stripUndefined({
      id: stringValue(artifact.name) || stringValue(artifact.path),
      kind: "recipe-declared-artifact",
      path: stringValue(artifact.path),
      metadata: artifact,
    }))
  }

  for (const ref of normalizeBrowserArtifactSummaryRefs({ probes: arrayObjects(result.probes).map((probe) => objectValue(probe.artifacts || probe.files || probe.summary)) })) {
    appendUniqueArtifact(artifacts, { id: ref.path, kind: ref.kind, path: ref.path, metadata: { ...ref } })
  }

  return artifacts
}

function recipeRunCommandSummaries(result: Record<string, unknown>): RecipeRunCommandSummary[] {
  return arrayObjects(result.executions).map((execution, index) => {
    const exitCode = numberValue(execution.exitCode)
    return stripUndefined({
      index,
      command: stringValue(execution.command) || `command-${index + 1}`,
      status: exitCode === undefined ? "unknown" : exitCode === 0 ? "succeeded" : "failed",
      exit_code: exitCode,
      duration_ms: numberValue(execution.durationMs),
      recipe_phase: stringValue(execution.recipePhase),
      recipe_step_index: numberValue(execution.recipeStepIndex),
      stdout_tail: textTail(execution.stdout),
      stderr_tail: textTail(execution.stderr),
    }) as RecipeRunCommandSummary
  })
}

function recipeRunPreviewSummary(result: Record<string, unknown>): RecipeRunPreviewSummary | undefined {
  const preview = objectValue(objectValue(result.artifacts).preview)
  const runPreview = objectValue(objectValue(result.run).preview)
  const value = Object.keys(preview).length > 0 ? preview : runPreview
  if (Object.keys(value).length === 0) return undefined

  return stripUndefined({
    status: stringValue(value.status),
    lifecycle: stringValue(value.lifecycle),
    source: stringValue(value.source),
    created_at: stringValue(value.createdAt),
    expires_at: stringValue(value.expiresAt),
    hold_seconds: numberValue(value.holdSeconds),
    reviewer_access: objectValue(value.reviewerAccess),
  }) as RecipeRunPreviewSummary
}

function textTail(value: unknown, maxChars = 4_000): string | undefined {
  const text = stringValue(value)
  if (!text) return undefined
  return text.length > maxChars ? text.slice(-maxChars) : text
}

function appendPathArtifact(artifacts: AgentTaskRunArtifactRef[], kind: string, value: unknown): void {
  const path = stringValue(value)
  appendUniqueArtifact(artifacts, { id: path, kind, path })
}

function appendUniqueArtifact(artifacts: AgentTaskRunArtifactRef[], artifact: AgentTaskRunArtifactRef): void {
  if (!artifact.kind) return
  const key = artifact.path || artifact.url || artifact.id
  if (!key) return
  if (artifacts.some((existing) => (existing.path || existing.url || existing.id) === key)) return
  artifacts.push(artifact)
}

function objectValue(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {}
}

function arrayObjects(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isPlainObject) : []
}

function stringValue(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : ""
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}
