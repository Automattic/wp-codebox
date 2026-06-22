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

export interface AgentRuntimeWorkloadOptions {
  requiredOutputs?: Record<string, string> | string[]
  toolRecorders?: unknown
  workloadId?: string
  normalizerAdapters?: AgentRuntimeWorkloadNormalizerAdapter[]
  /** @deprecated Pass `legacyAgentRuntimeWorkloadNormalizerAdapters` as `normalizerAdapters` instead. */
  compatMode?: boolean
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
  const compatibilityDiagnostics: AgentRuntimeWorkloadDiagnostic[] = []
  const adapters = workloadNormalizerAdapters(options)
  const workload = canonicalWorkload ?? workloadFromNormalizerAdapters(raw, options, adapters, compatibilityDiagnostics) ?? emptyWorkload(options)
  const toolRecorderOutputs = outputsFromToolRecorders(workload, options.toolRecorders)
  const outputs = { ...workload.outputs, ...toolRecorderOutputs }
  const diagnostics = [...workload.diagnostics, ...compatibilityDiagnostics, ...diagnosticsFromWorkload({ ...workload, outputs }, options)]
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

export const legacyAgentRuntimeWorkloadNormalizerAdapters: AgentRuntimeWorkloadNormalizerAdapter[] = [
  { name: "runtime-workload-explicit-envelope", normalize: normalizeExplicitEnvelopeField },
  { name: "runtime-workload-stdout-json", normalize: normalizeStdoutJsonEnvelope },
  { name: "runtime-workload-nested-canonical", normalize: normalizeNestedCanonicalEnvelope },
  { name: "runtime-workload-agent-bundle-run", normalize: normalizeLegacyAgentBundleRun },
  { name: "runtime-workload-scenario-shape", normalize: normalizeScenarioShape },
  { name: "runtime-workload-single-result-shape", normalize: normalizeSingleResultShape },
  { name: "runtime-workload-recipe-run-nested-agent-task-result", normalize: normalizeRecipeRunNestedAgentTaskResult },
  { name: "runtime-workload-execution-stdout", normalize: normalizeExecutionStdout },
  { name: "runtime-workload-metadata-shape", normalize: normalizeMetadataShape },
]

function canonicalWorkloadFromRaw(raw: unknown, options: AgentRuntimeWorkloadOptions): WorkloadDraft | undefined {
  return parseAgentRuntimeWorkloadEnvelope(raw, options)
}

function workloadNormalizerAdapters(options: AgentRuntimeWorkloadOptions): AgentRuntimeWorkloadNormalizerAdapter[] {
  return Array.isArray(options.normalizerAdapters)
    ? options.normalizerAdapters
    : options.compatMode === true
      ? legacyAgentRuntimeWorkloadNormalizerAdapters
      : []
}

function workloadFromNormalizerAdapters(raw: unknown, options: AgentRuntimeWorkloadOptions, adapters: AgentRuntimeWorkloadNormalizerAdapter[], diagnostics: AgentRuntimeWorkloadDiagnostic[]): WorkloadDraft | undefined {
  if (adapters.length === 0) return undefined

  const context: AgentRuntimeWorkloadNormalizerContext = {
    options,
    normalizeRaw: (candidate) => canonicalWorkloadFromRaw(candidate, options) ?? workloadFromNormalizerAdapters(candidate, options, adapters, diagnostics),
  }

  for (const adapter of adapters) {
    const workload = adapter.normalize(raw, context)
    if (hasSemanticWorkload(workload)) return withCompatibilityDiagnostic(workload, diagnostics, adapter.name)
  }

  return undefined
}

function normalizeExplicitEnvelopeField(raw: unknown, context: AgentRuntimeWorkloadNormalizerContext): WorkloadDraft | undefined {
  const parsed = parseJsonEnvelope(raw)
  const record = objectValue(parsed)
  if (!record) return undefined

  return workloadFromExplicitEnvelopeField(record, context.options)
}

function normalizeStdoutJsonEnvelope(raw: unknown, context: AgentRuntimeWorkloadNormalizerContext): WorkloadDraft | undefined {
  const record = objectValue(parseJsonEnvelope(raw))
  if (!record) return undefined
  const stdout = stringValue(record.stdout)
  if (stdout) {
    return context.normalizeRaw(stdout)
  }
  return undefined
}

function normalizeNestedCanonicalEnvelope(raw: unknown, context: AgentRuntimeWorkloadNormalizerContext): WorkloadDraft | undefined {
  const record = objectValue(parseJsonEnvelope(raw))
  if (!record) return undefined
  const direct = objectValue(record.agent_runtime)?.result ?? record.result ?? record
  const candidate = parseJsonEnvelope(direct)
  const candidateRecord = objectValue(candidate)
  if (!candidateRecord) return undefined

  return parseAgentRuntimeWorkloadEnvelope(candidateRecord, context.options)
}

function normalizeLegacyAgentBundleRun(raw: unknown, context: AgentRuntimeWorkloadNormalizerContext): WorkloadDraft | undefined {
  const record = candidateRecordFromRaw(raw)
  return record && isLegacyAgentBundleRun(record) ? workloadFromLegacyAgentBundleRun(record, context.options) : undefined
}

function normalizeScenarioShape(raw: unknown, context: AgentRuntimeWorkloadNormalizerContext): WorkloadDraft | undefined {
  const record = candidateRecordFromRaw(raw)
  return record && Array.isArray(record.scenarios) ? workloadFromScenarioWorkload(record, context.options) : undefined
}

function normalizeSingleResultShape(raw: unknown, context: AgentRuntimeWorkloadNormalizerContext): WorkloadDraft | undefined {
  const record = candidateRecordFromRaw(raw)
  return record && isSingleResultWorkload(record) ? workloadFromSingleResult(record, context.options) : undefined
}

function normalizeRecipeRunNestedAgentTaskResult(raw: unknown, context: AgentRuntimeWorkloadNormalizerContext): WorkloadDraft | undefined {
  const candidateRecord = candidateRecordFromRaw(raw)
  if (!candidateRecord) return undefined

  const recipeRun = objectValue(candidateRecord.run)
  const agentTaskResult = objectValue(candidateRecord.agentTaskResult) ?? objectValue(recipeRun?.agentTaskResult) ?? objectValue(candidateRecord.agent_task_result)
  const nestedRuntime = objectValue(agentTaskResult?.raw)?.agent_runtime
  const nestedRuntimeRecord = objectValue(nestedRuntime)
  if (nestedRuntimeRecord?.result) return context.normalizeRaw({ agent_runtime: nestedRuntimeRecord })
  return undefined
}

function normalizeExecutionStdout(raw: unknown, context: AgentRuntimeWorkloadNormalizerContext): WorkloadDraft | undefined {
  const candidateRecord = candidateRecordFromRaw(raw)
  return candidateRecord ? workloadFromExecutions(candidateRecord, context) : undefined
}

function normalizeMetadataShape(raw: unknown, context: AgentRuntimeWorkloadNormalizerContext): WorkloadDraft | undefined {
  const candidateRecord = candidateRecordFromRaw(raw)
  if (!candidateRecord) return undefined
  if (candidateRecord.metadata || candidateRecord.metrics) {
    return {
      outputs: {},
      scenarios: [scenarioFromRecord(candidateRecord, context.options)],
      diagnostics: diagnosticsFromRaw(candidateRecord.diagnostics),
      artifacts: artifactsFromRaw(candidateRecord.artifacts),
      metadata: objectValue(candidateRecord.metadata) ?? {},
    }
  }

  return undefined
}

function candidateRecordFromRaw(raw: unknown): Record<string, unknown> | undefined {
  const record = objectValue(parseJsonEnvelope(raw))
  if (!record) return undefined

  const direct = objectValue(record.agent_runtime)?.result ?? record.result ?? record
  return objectValue(parseJsonEnvelope(direct))
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

function workloadFromExplicitEnvelopeField(record: Record<string, unknown>, options: AgentRuntimeWorkloadOptions): WorkloadDraft | undefined {
  const agentRuntime = objectValue(record.agent_runtime) ?? objectValue(record.agentRuntime)
  const candidates = [
    record.agent_runtime_workload,
    record.agentRuntimeWorkload,
    record.workload,
    agentRuntime?.workload,
    agentRuntime?.workload_envelope,
    agentRuntime?.workloadEnvelope,
  ]

  for (const candidate of candidates) {
    const workload = parseAgentRuntimeWorkloadEnvelope(candidate, options)
    if (workload) return workload
  }
  return undefined
}

function workloadFromExecutions(record: Record<string, unknown>, context: AgentRuntimeWorkloadNormalizerContext): WorkloadDraft | undefined {
  const executions = arrayObjects(record.executions).length > 0 ? arrayObjects(record.executions) : arrayObjects(objectValue(record.run)?.executions)
  for (const execution of executions) {
    const stdout = stringValue(execution.stdout)
    if (!stdout) continue
    const workload = context.normalizeRaw(stdout)
    if (hasSemanticWorkload(workload)) return workload
  }
  return undefined
}

function withCompatibilityDiagnostic(workload: WorkloadDraft, diagnostics: AgentRuntimeWorkloadDiagnostic[], adapter: string): WorkloadDraft {
  if (!diagnostics.some((diagnostic) => diagnostic.data?.adapter === adapter)) {
    diagnostics.push({
      class: "wp-codebox.normalizer.compat_mode_used",
      message: "Agent runtime workload was parsed using explicit normalizer compatibility mode.",
      data: { adapter },
    })
  }
  return workload
}

function workloadFromScenarioWorkload(record: Record<string, unknown>, options: AgentRuntimeWorkloadOptions): WorkloadDraft {
  const scenarios = arrayObjects(record.scenarios).map((scenario) => normalizeScenario(scenario, options))
  return {
    success: record.success === false ? false : undefined,
    outputs: objectValue(record.outputs) ?? {},
    scenarios,
    diagnostics: diagnosticsFromRaw(record.diagnostics),
    artifacts: [...artifactsFromRaw(record.artifacts), ...artifactsFromScenarios(scenarios)],
    metadata: objectValue(record.metadata) ?? {},
  }
}

function workloadFromSingleResult(record: Record<string, unknown>, options: AgentRuntimeWorkloadOptions): WorkloadDraft {
  const outputs = objectValue(record.outputs) ?? objectValue(record.output) ?? {}
  const scenario = stripUndefined({
    id: workloadId(options),
    success: typeof record.success === "boolean" ? record.success : undefined,
    status: stringValue(record.status) || undefined,
    summary: stringValue(record.summary) || stringValue(record.message) || undefined,
    outputs,
    metrics: objectValue(record.metrics),
    metadata: objectValue(record.metadata),
  }) as AgentRuntimeWorkloadScenario

  return {
    success: record.success === false ? false : undefined,
    outputs,
    scenarios: [scenario],
    diagnostics: diagnosticsFromRaw(record.diagnostics),
    artifacts: artifactsFromRaw(record.artifacts),
    metadata: objectValue(record.metadata) ?? {},
  }
}

function workloadFromLegacyAgentBundleRun(bundleRun: Record<string, unknown>, options: AgentRuntimeWorkloadOptions): WorkloadDraft {
  const bundle = objectValue(bundleRun.bundle) ?? {}
  const workflow = objectValue(bundleRun.workflow) ?? {}
  const workflowSteps = Array.isArray(workflow.steps) ? workflow.steps : []
  const outputs = objectValue(bundleRun.outputs) ?? {}
  const scenario = stripUndefined({
    id: stringValue(bundle.workload_id) || stringValue(bundle.workloadId) || stringValue(bundle.flow_slug) || stringValue(bundle.bundle_slug) || workloadId(options),
    success: bundleRun.success !== false,
    status: stringValue(bundleRun.job_status) || undefined,
    outputs,
    metrics: { workflow_step_count: workflowSteps.length },
    metadata: stripUndefined({
      schema: stringValue(bundleRun.schema),
      success: bundleRun.success !== false,
      dry_run: bundleRun.dry_run === true,
      bundle,
      job_id: stringValue(bundleRun.job_id),
      job_status: stringValue(bundleRun.job_status),
      wait_result: bundleRun.wait_result,
      engine_data: bundleRun.engine_data,
      error: bundleRun.success === false ? bundleRun.error : undefined,
    }),
  }) as AgentRuntimeWorkloadScenario

  return {
    success: bundleRun.success !== false,
    outputs,
    scenarios: [scenario],
    diagnostics: diagnosticsFromRaw(bundleRun.diagnostics),
    artifacts: [...artifactsFromRaw(bundleRun.artifacts), ...artifactsFromScenarios([scenario])],
    metadata: stripUndefined({ schema: stringValue(bundleRun.schema), bundle }),
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

  if (workload.scenarios.length === 0 && Object.keys(workload.outputs).length === 0) {
    diagnostics.push({
      class: "agent_runtime.workload.incomplete",
      message: "Agent runtime workload did not produce scenarios or semantic outputs.",
      data: { reason: "missing_semantic_outputs" },
    })
  }

  return diagnostics
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

function scenarioFromRecord(record: Record<string, unknown>, options: AgentRuntimeWorkloadOptions): AgentRuntimeWorkloadScenario {
  return stripUndefined({
    id: workloadId(options),
    success: typeof record.success === "boolean" ? record.success : undefined,
    status: stringValue(record.status) || undefined,
    summary: stringValue(record.summary) || stringValue(record.message) || undefined,
    outputs: objectValue(record.outputs),
    metrics: objectValue(record.metrics),
    metadata: objectValue(record.metadata),
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

function parseJsonEnvelope(value: unknown): unknown {
  if (typeof value !== "string") return value
  const parsed = parseJson(value)
  const wrapperOutput = objectValue(parsed)?.output
  return typeof wrapperOutput === "string" ? parseJson(wrapperOutput) ?? parsed : parsed
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

function parseJson(value: string): unknown {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.indexOf("{")
    const end = trimmed.lastIndexOf("}")
    if (start === -1 || end <= start) return undefined
    try {
      return JSON.parse(trimmed.slice(start, end + 1))
    } catch {
      return undefined
    }
  }
}

function isLegacyAgentBundleRun(record: Record<string, unknown>): boolean {
  return stringValue(record.schema).endsWith("/agent-bundle-run/v1")
}

function isSingleResultWorkload(record: Record<string, unknown>): boolean {
  return Boolean(objectValue(record.outputs) || objectValue(record.output) || Array.isArray(record.diagnostics) || stringValue(record.summary))
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
