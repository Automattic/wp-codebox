import { isPlainObject, stripUndefined } from "./object-utils.js"

export const AGENT_RUNTIME_WORKLOAD_SCHEMA = "wp-codebox/agent-runtime-workload/v1" as const

export const AGENT_RUNTIME_WORKLOAD_JSON_SCHEMA = {
  $id: AGENT_RUNTIME_WORKLOAD_SCHEMA,
  type: "object",
  required: ["schema"],
  properties: {
    schema: { const: AGENT_RUNTIME_WORKLOAD_SCHEMA, description: "Canonical WP Codebox agent runtime workload envelope schema." },
    success: { type: "boolean", description: "Whether the workload completed successfully before Codebox-required output checks." },
    outputs: { type: "object", description: "Caller-defined semantic outputs produced by the runtime." },
    scenarios: {
      type: "array",
      description: "One or more normalized workload scenarios, attempts, or cases.",
      items: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
          status: { type: "string" },
          success: { type: "boolean" },
          summary: { type: "string" },
          outputs: { type: "object" },
          metrics: { type: "object" },
          metadata: { type: "object" },
        },
      },
    },
    diagnostics: {
      type: "array",
      description: "Runtime diagnostics using class/message/data entries.",
      items: {
        type: "object",
        required: ["class", "message"],
        properties: {
          class: { type: "string" },
          message: { type: "string" },
          data: { type: "object" },
        },
      },
    },
    artifacts: {
      type: "array",
      description: "Artifacts emitted by the runtime workload.",
      items: {
        type: "object",
        required: ["kind"],
        properties: {
          id: { type: "string" },
          kind: { type: "string" },
          path: { type: "string" },
          url: { type: "string" },
          sha256: { type: "string" },
          size_bytes: { type: "number" },
          metadata: { type: "object" },
        },
      },
    },
    metadata: { type: "object", description: "Non-secret caller/runtime metadata." },
  },
} as const

export interface AgentRuntimeWorkloadArtifact {
  id?: string
  kind: string
  path?: string
  url?: string
  sha256?: string
  size_bytes?: number
  metadata?: Record<string, unknown>
}

export interface AgentRuntimeWorkloadDiagnostic {
  class: string
  message: string
  data?: Record<string, unknown>
}

export interface AgentRuntimeWorkloadScenario {
  id: string
  status?: string
  success?: boolean
  summary?: string
  outputs?: Record<string, unknown>
  metrics?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export interface AgentRuntimeWorkload {
  schema: typeof AGENT_RUNTIME_WORKLOAD_SCHEMA
  success: boolean
  outputs: Record<string, unknown>
  scenarios: AgentRuntimeWorkloadScenario[]
  diagnostics: AgentRuntimeWorkloadDiagnostic[]
  artifacts: AgentRuntimeWorkloadArtifact[]
  metadata: Record<string, unknown>
}

export interface AgentRuntimeExecutionChanges {
  changed_files_count: number
  patch_bytes: number
  refs: AgentRuntimeWorkloadArtifact[]
}

export interface AgentRuntimeWorkloadOptions {
  requiredOutputs?: Record<string, string> | string[]
  toolRecorders?: unknown
  workloadId?: string
  normalizerAdapters?: AgentRuntimeWorkloadNormalizerAdapter[]
  executionChanges?: AgentRuntimeExecutionChanges
}

export type AgentRuntimeWorkloadDraft = Omit<AgentRuntimeWorkload, "schema" | "success"> & { success?: boolean }

export interface AgentRuntimeWorkloadNormalizerContext {
  options: AgentRuntimeWorkloadOptions
  normalizeRaw(raw: unknown): AgentRuntimeWorkloadDraft | undefined
}

export interface AgentRuntimeWorkloadNormalizerAdapter {
  name: string
  normalize(raw: unknown, context: AgentRuntimeWorkloadNormalizerContext): AgentRuntimeWorkloadDraft | undefined
}

type WorkloadDraft = AgentRuntimeWorkloadDraft

export function normalizeAgentRuntimeWorkload(raw: unknown, options: AgentRuntimeWorkloadOptions = {}): AgentRuntimeWorkload {
  const canonicalWorkload = canonicalWorkloadFromRaw(raw, options)
  const adapters = workloadNormalizerAdapters(options)
  const workload = canonicalWorkload ?? workloadFromNormalizerAdapters(raw, options, adapters) ?? emptyWorkload(options)
  const toolRecorderOutputs = outputsFromToolRecorders(workload, options.toolRecorders)
  const executionChanges = options.executionChanges
  const outputs = {
    ...workload.outputs,
    ...toolRecorderOutputs,
    ...(executionChanges ? { execution_changes: executionChangeSummary(executionChanges) } : {}),
  }
  const diagnostics = [...workload.diagnostics, ...diagnosticsFromWorkload({ ...workload, outputs }, options)]
  const success = workload.success !== false && diagnostics.every((diagnostic) => !isFailureDiagnostic(diagnostic))

  return {
    schema: AGENT_RUNTIME_WORKLOAD_SCHEMA,
    success,
    outputs,
    scenarios: workload.scenarios,
    diagnostics,
    artifacts: workload.artifacts,
    metadata: stripUndefined({
      ...workload.metadata,
      workload_id: options.workloadId,
      tool_recorders: options.toolRecorders,
    }),
  }
}

function canonicalWorkloadFromRaw(raw: unknown, options: AgentRuntimeWorkloadOptions): WorkloadDraft | undefined {
  return parseAgentRuntimeWorkloadEnvelope(raw, options)
}

function workloadNormalizerAdapters(options: AgentRuntimeWorkloadOptions): AgentRuntimeWorkloadNormalizerAdapter[] {
  return Array.isArray(options.normalizerAdapters) ? options.normalizerAdapters : []
}

function workloadFromNormalizerAdapters(raw: unknown, options: AgentRuntimeWorkloadOptions, adapters: AgentRuntimeWorkloadNormalizerAdapter[]): WorkloadDraft | undefined {
  if (adapters.length === 0) return undefined

  const context: AgentRuntimeWorkloadNormalizerContext = {
    options,
    normalizeRaw: (candidate) => canonicalWorkloadFromRaw(candidate, options) ?? workloadFromNormalizerAdapters(candidate, options, adapters),
  }

  for (const adapter of adapters) {
    const workload = adapter.normalize(raw, context)
    if (hasSemanticWorkload(workload)) return workload
  }

  return undefined
}

function parseAgentRuntimeWorkloadEnvelope(raw: unknown, options: AgentRuntimeWorkloadOptions): WorkloadDraft | undefined {
  const record = objectValue(parseStrictJsonEnvelope(raw))
  if (!record || stringValue(record.schema) !== AGENT_RUNTIME_WORKLOAD_SCHEMA) return undefined

  const scenarios = arrayObjects(record.scenarios).map((scenario) => normalizeScenario(scenario, options))
  return {
    success: typeof record.success === "boolean" ? record.success : undefined,
    outputs: objectValue(record.outputs) ?? {},
    scenarios,
    diagnostics: diagnosticsFromRaw(record.diagnostics),
    artifacts: [...artifactsFromRaw(record.artifacts), ...artifactsFromScenarios(scenarios)],
    metadata: objectValue(record.metadata) ?? {},
  }
}

function diagnosticsFromWorkload(workload: WorkloadDraft, options: AgentRuntimeWorkloadOptions): AgentRuntimeWorkloadDiagnostic[] {
  const diagnostics: AgentRuntimeWorkloadDiagnostic[] = []
  for (const scenario of workload.scenarios) {
    const metadata = scenario.metadata ?? {}
    const error = metadata.error ?? metadata.error_message ?? metadata.errorMessage
    if (error) {
      diagnostics.push({
        class: "agent_runtime.workload.failed",
        message: String(error),
        data: { reason: "scenario_error", scenario_id: scenario.id, metadata },
      })
    }
  }

  const missing = missingRequiredOutputs(workload, options.requiredOutputs)
  if (missing.length > 0) {
    diagnostics.push({
      class: "agent_runtime.workload.incomplete",
      message: `Agent runtime workload did not produce required outputs: ${missing.map((item) => item.name).join(", ")}.`,
      data: { reason: "missing_required_outputs", missing },
    })
  }

  if (workload.scenarios.length === 0 && Object.keys(workload.outputs).length === 0 && !options.executionChanges) {
    diagnostics.push({
      class: "agent_runtime.workload.incomplete",
      message: "Agent runtime workload did not produce scenarios or semantic outputs.",
      data: { reason: "missing_semantic_outputs" },
    })
  }

  return diagnostics
}

export function normalizeAgentRuntimeExecutionChanges(raw: unknown): AgentRuntimeExecutionChanges | undefined {
  const agentResult = objectValue(raw)
  const changedFiles = objectValue(agentResult?.changedFiles)
  const patch = objectValue(agentResult?.patch)
  const changedFilesCount = numberValue(changedFiles?.count)
  const patchBytes = numberValue(patch?.bytes)
  if (!changedFilesCount || !patchBytes) return undefined

  const refs = [
    executionChangeRef("codebox-changed-files", changedFiles),
    executionChangeRef("codebox-patch", patch),
  ].filter((ref): ref is AgentRuntimeWorkloadArtifact => Boolean(ref))

  return { changed_files_count: changedFilesCount, patch_bytes: patchBytes, refs }
}

function executionChangeSummary(changes: AgentRuntimeExecutionChanges): Record<string, unknown> {
  return {
    summary: `Agent execution changed ${changes.changed_files_count} file${changes.changed_files_count === 1 ? "" : "s"} with a ${changes.patch_bytes}-byte patch.`,
    changed_files_count: changes.changed_files_count,
    patch_bytes: changes.patch_bytes,
    refs: changes.refs,
  }
}

function executionChangeRef(kind: string, evidence: Record<string, unknown> | undefined): AgentRuntimeWorkloadArtifact | undefined {
  const path = stringValue(evidence?.artifact)
  if (!path) return undefined
  return stripUndefined({
    id: path,
    kind,
    path,
    sha256: stringValue(evidence?.sha256) || undefined,
    size_bytes: numberValue(evidence?.bytes),
  })
}

function missingRequiredOutputs(workload: WorkloadDraft, requiredOutputs: AgentRuntimeWorkloadOptions["requiredOutputs"]): Array<{ name: string; path?: string }> {
  const required = Array.isArray(requiredOutputs)
    ? Object.fromEntries(requiredOutputs.map((name) => [name, name]))
    : objectValue(requiredOutputs) ?? {}
  const sources = [workload.outputs, ...workload.scenarios, ...workload.scenarios.map((scenario) => scenario.metadata ?? {})]
  const missing: Array<{ name: string; path?: string }> = []

  for (const [name, path] of Object.entries(required)) {
    if (present(workload.outputs[name])) continue
    if (sources.some((source) => present(pathValue(source, String(path))))) continue
    missing.push({ name, path: String(path) })
  }

  return missing
}

function outputsFromToolRecorders(workload: WorkloadDraft, toolRecorders: unknown): Record<string, unknown> {
  const recorders = Array.isArray(toolRecorders)
    ? toolRecorders
    : Object.entries(objectValue(toolRecorders) ?? {}).map(([name, path]) => ({ name, path }))
  const sources = [workload.outputs, ...workload.scenarios, ...workload.scenarios.map((scenario) => scenario.metadata ?? {})]
  const outputs: Record<string, unknown> = {}

  for (const recorder of recorders) {
    const recorderRecord = objectValue(recorder)
    const name = stringValue(recorderRecord?.name) || stringValue(recorderRecord?.id) || stringValue(recorderRecord?.key) || stringValue(recorder)
    const path = stringValue(recorderRecord?.output_path) || stringValue(recorderRecord?.outputPath) || stringValue(recorderRecord?.path) || name
    if (!name || !path || present(workload.outputs[name])) continue
    for (const source of sources) {
      const value = pathValue(source, path)
      if (present(value)) {
        outputs[name] = value
        break
      }
    }
  }

  return outputs
}

function normalizeScenario(scenario: Record<string, unknown>, options: AgentRuntimeWorkloadOptions): AgentRuntimeWorkloadScenario {
  return stripUndefined({
    id: stringValue(scenario.id) || workloadId(options),
    status: stringValue(scenario.status) || undefined,
    success: typeof scenario.success === "boolean" ? scenario.success : undefined,
    summary: stringValue(scenario.summary) || stringValue(scenario.message) || undefined,
    outputs: objectValue(scenario.outputs),
    metrics: objectValue(scenario.metrics),
    metadata: objectValue(scenario.metadata),
  }) as AgentRuntimeWorkloadScenario
}

function diagnosticsFromRaw(raw: unknown): AgentRuntimeWorkloadDiagnostic[] {
  return Array.isArray(raw) ? raw.map((diagnostic) => {
    const record = objectValue(diagnostic)
    return {
      class: stringValue(record?.class) || stringValue(record?.kind) || "agent_runtime.workload",
      message: stringValue(record?.message) || String(diagnostic),
      data: objectValue(record?.data),
    }
  }) : []
}

function artifactsFromRaw(raw: unknown): AgentRuntimeWorkloadArtifact[] {
  const values = Array.isArray(raw) ? raw : Object.values(objectValue(raw) ?? {})
  return values.map((artifact, index) => artifactFromRaw(artifact, index)).filter((artifact): artifact is AgentRuntimeWorkloadArtifact => Boolean(artifact))
}

function artifactFromRaw(raw: unknown, index: number): AgentRuntimeWorkloadArtifact | undefined {
  const artifact = objectValue(raw)
  if (!artifact) return undefined
  const path = stringValue(artifact.path) || stringValue(artifact.directory)
  const url = stringValue(artifact.url) || stringValue(artifact.uri)
  const id = stringValue(artifact.id) || stringValue(artifact.sha256) || path || url || `agent-runtime-artifact-${index + 1}`
  return stripUndefined({
    id,
    kind: stringValue(artifact.kind) || stringValue(artifact.type) || "agent-runtime-artifact",
    path,
    url,
    sha256: stringValue(artifact.sha256),
    size_bytes: numberValue(artifact.size_bytes) ?? numberValue(artifact.sizeBytes),
    metadata: objectValue(artifact.metadata),
  })
}

function artifactsFromScenarios(scenarios: AgentRuntimeWorkloadScenario[]): AgentRuntimeWorkloadArtifact[] {
  const artifacts: AgentRuntimeWorkloadArtifact[] = []
  for (const scenario of scenarios) {
    const metadata = scenario.metadata ?? {}
    const transcriptArtifacts = objectValue(metadata.transcript_artifacts) ?? {}
    appendArtifact(artifacts, { id: "agent-runtime-transcript-json", kind: "agent-runtime-transcript", path: stringValue(transcriptArtifacts.json), metadata: { scenario_id: scenario.id, format: "json" } })
    appendArtifact(artifacts, { id: "agent-runtime-transcript-summary", kind: "agent-runtime-transcript-summary", path: stringValue(transcriptArtifacts.summary), metadata: { scenario_id: scenario.id, format: "markdown" } })
    const replayBundle = objectValue(metadata.replay_bundle) ?? {}
    appendArtifact(artifacts, { id: "agent-runtime-replay-bundle", kind: "agent-runtime-replay-bundle", path: stringValue(metadata.replay_bundle_path) || stringValue(replayBundle.path), metadata: { scenario_id: scenario.id } })
    for (const [index, exported] of arrayObjects(metadata.job_artifact_exports).entries()) {
      appendArtifact(artifacts, artifactFromRaw({ ...exported, metadata: { ...exported, scenario_id: scenario.id } }, index))
    }
  }
  return artifacts
}

function emptyWorkload(options: AgentRuntimeWorkloadOptions): WorkloadDraft {
  return { outputs: {}, scenarios: [], diagnostics: [], artifacts: [], metadata: { workload_id: options.workloadId } }
}

function parseStrictJsonEnvelope(value: unknown): unknown {
  if (typeof value !== "string") return value
  const parsed = parseStrictJson(value)
  const wrapperOutput = objectValue(parsed)?.output
  return typeof wrapperOutput === "string" ? parseStrictJson(wrapperOutput) ?? parsed : parsed
}

function parseStrictJson(value: string): unknown {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

function hasSemanticWorkload(workload: WorkloadDraft | undefined): workload is WorkloadDraft {
  return Boolean(workload && (workload.scenarios.length > 0 || Object.keys(workload.outputs).length > 0))
}

function isFailureDiagnostic(diagnostic: AgentRuntimeWorkloadDiagnostic): boolean {
  return diagnostic.class.endsWith(".failed") || diagnostic.class.endsWith(".incomplete")
}

function appendArtifact(artifacts: AgentRuntimeWorkloadArtifact[], artifact: AgentRuntimeWorkloadArtifact | undefined): void {
  if (!artifact?.kind) return
  const key = artifact.path || artifact.url || artifact.id
  if (!key || artifacts.some((existing) => (existing.path || existing.url || existing.id) === key)) return
  artifacts.push(artifact)
}

function pathValue(source: unknown, dottedPath: string): unknown {
  return dottedPath.split(".").filter(Boolean).reduce<unknown>((value, key) => objectValue(value)?.[key], source)
}

function present(value: unknown): boolean {
  return value !== undefined && value !== null && value !== ""
}

function workloadId(options: AgentRuntimeWorkloadOptions): string {
  return options.workloadId || "agent-runtime-workload"
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return isPlainObject(value) ? value : undefined
}

function arrayObjects(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isPlainObject) : []
}

function stringValue(value: unknown): string {
  return value === undefined || value === null ? "" : String(value).trim()
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}
