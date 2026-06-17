import { agentTaskStatusSucceeded, normalizeAgentTaskStatus } from "./status-taxonomy.js"

export const FANOUT_AGGREGATION_INPUT_SCHEMA = "wp-codebox/agent-fanout-aggregation-input/v1" as const
export const FANOUT_AGGREGATION_OUTPUT_SCHEMA = "wp-codebox/agent-fanout-aggregation-output/v1" as const

export type FanoutWorkerStatus = "succeeded" | "failed" | "cancelled" | "missing" | (string & {})
export type FanoutAggregationPolicy = "fail" | "partial" | "repair" | "caller-review-required" | (string & {})
export type FanoutAggregationOutputStatus = "succeeded" | "failed" | "partial" | "repair_required" | "caller_review_required"
export type FanoutConflictType =
  | "duplicate-final-artifact-path"
  | "failed-worker"
  | "missing-worker-dependency"
  | "failed-worker-dependency"
  | "partial-output"
  | "incompatible-schema"
  | "aggregation-failure"
  | (string & {})

export interface FanoutArtifactRef {
  id?: string
  path: string
  kind?: string
  workerId?: string
  namespace?: string
  finalPath?: string
  contentType?: string
  sha256?: string
  bytes?: number
  metadata?: Record<string, unknown>
}

export interface FanoutWorkerPlan {
  id: string
  dependsOn: string[]
  required: boolean
  artifactNamespace?: string
  metadata?: Record<string, unknown>
  [key: string]: unknown
}

export interface FanoutPlan {
  id?: string
  workers: FanoutWorkerPlan[]
  metadata?: Record<string, unknown>
  [key: string]: unknown
}

export interface FanoutWorkerResultRef {
  workerId: string
  status: FanoutWorkerStatus
  required: boolean
  resultRef?: string
  artifactRefs: FanoutArtifactRef[]
  error?: {
    code?: string
    message: string
    details?: Record<string, unknown>
  }
  metadata?: Record<string, unknown>
}

export interface FanoutConflictRecord {
  type: FanoutConflictType
  severity: "error" | "warning" | "info" | (string & {})
  message: string
  workerIds?: string[]
  path?: string
  artifactRefs?: FanoutArtifactRef[]
  dependencyId?: string
  details?: Record<string, unknown>
}

export interface FanoutAggregatorConfig {
  agent?: string
  task?: string
  inputRef?: string
  outputNamespace?: string
  metadata?: Record<string, unknown>
  [key: string]: unknown
}

export interface FanoutAggregationInput {
  schema: typeof FANOUT_AGGREGATION_INPUT_SCHEMA
  plan: FanoutPlan
  policy: FanoutAggregationPolicy
  aggregator?: FanoutAggregatorConfig
  workerResultRefs: FanoutWorkerResultRef[]
  artifactRefs: FanoutArtifactRef[]
  conflictCandidates: FanoutConflictRecord[]
  metadata?: Record<string, unknown>
}

export interface FanoutAggregationResultOptions {
  finalArtifactRefs?: FanoutArtifactRef[]
  outputNamespace?: string
  aggregationError?: {
    code?: string
    message: string
    details?: Record<string, unknown>
  }
  metadata?: Record<string, unknown>
}

export interface FanoutAggregationOutput {
  schema: typeof FANOUT_AGGREGATION_OUTPUT_SCHEMA
  status: FanoutAggregationOutputStatus
  policy: FanoutAggregationPolicy
  plan: FanoutPlan
  aggregator?: FanoutAggregatorConfig
  workerResultRefs: FanoutWorkerResultRef[]
  rawWorkerArtifactRefs: FanoutArtifactRef[]
  finalArtifactRefs: FanoutArtifactRef[]
  conflicts: FanoutConflictRecord[]
  metadata?: Record<string, unknown>
}

export type FanoutAggregationInputRequest = Partial<Omit<FanoutAggregationInput, "schema" | "workerResultRefs" | "artifactRefs" | "conflictCandidates">> & {
  schema?: string
  workerResultRefs?: unknown[]
  worker_results?: unknown[]
  workerResults?: unknown[]
  artifactRefs?: unknown[]
  artifact_refs?: unknown[]
  conflictCandidates?: unknown[]
  conflict_candidates?: unknown[]
  aggregation?: FanoutAggregatorConfig
}

export function normalizeFanoutAggregationInput(input: FanoutAggregationInputRequest): FanoutAggregationInput {
  const workerResultRefs = (input.workerResultRefs ?? input.worker_results ?? input.workerResults ?? []).map(normalizeWorkerResultRef)
  const artifactRefs = [
    ...(input.artifactRefs ?? input.artifact_refs ?? []).map((artifact) => normalizeArtifactRef(artifact)),
    ...workerResultRefs.flatMap((worker) => worker.artifactRefs),
  ]

  return {
    schema: FANOUT_AGGREGATION_INPUT_SCHEMA,
    plan: normalizePlan(input.plan),
    policy: input.policy ?? "fail",
    aggregator: input.aggregator ?? input.aggregation,
    workerResultRefs,
    artifactRefs,
    conflictCandidates: (input.conflictCandidates ?? input.conflict_candidates ?? []).map(normalizeConflictRecord),
    metadata: input.metadata,
  }
}

export function aggregateFanoutOutputs(input: FanoutAggregationInputRequest, options: FanoutAggregationResultOptions = {}): FanoutAggregationOutput {
  const normalized = normalizeFanoutAggregationInput(input)
  const conflicts = [
    ...normalized.conflictCandidates,
    ...detectDuplicateFinalArtifactPathConflicts(normalized.artifactRefs),
    ...detectWorkerDependencyConflicts(normalized.plan, normalized.workerResultRefs),
  ]

  if (options.aggregationError) {
    conflicts.push({
      type: "aggregation-failure",
      severity: "error",
      message: options.aggregationError.message,
      details: {
        code: options.aggregationError.code,
        ...options.aggregationError.details,
      },
    })
  }

  const hasError = conflicts.some((conflict) => conflict.severity === "error")

  return {
    schema: FANOUT_AGGREGATION_OUTPUT_SCHEMA,
    status: resolveAggregationStatus(normalized.policy, conflicts),
    policy: normalized.policy,
    plan: normalized.plan,
    aggregator: normalized.aggregator,
    workerResultRefs: normalized.workerResultRefs,
    rawWorkerArtifactRefs: normalized.artifactRefs,
    finalArtifactRefs: hasError ? [] : (options.finalArtifactRefs ?? defaultFinalArtifactRefs(normalized, options.outputNamespace)),
    conflicts,
    metadata: options.metadata ?? normalized.metadata,
  }
}

export function defaultFanoutAggregationOutputPath(input: FanoutAggregationInputRequest, outputNamespace?: string): string {
  const normalized = normalizeFanoutAggregationInput(input)
  return `${normalizeOutputNamespace(outputNamespace ?? normalized.aggregator?.outputNamespace)}/result.json`
}

export function defaultFinalArtifactRefs(input: FanoutAggregationInputRequest | FanoutAggregationInput, outputNamespace?: string): FanoutArtifactRef[] {
  const path = defaultFanoutAggregationOutputPath(input, outputNamespace)
  return [{
    path,
    kind: "fanout-aggregate-output",
    contentType: "application/json",
  }]
}

export function detectDuplicateFinalArtifactPathConflicts(artifactRefs: FanoutArtifactRef[]): FanoutConflictRecord[] {
  const byFinalPath = new Map<string, FanoutArtifactRef[]>()

  for (const artifactRef of artifactRefs) {
    const finalPath = artifactRef.finalPath
    if (!finalPath) continue
    byFinalPath.set(finalPath, [...(byFinalPath.get(finalPath) ?? []), artifactRef])
  }

  return [...byFinalPath.entries()]
    .filter(([, refs]) => refs.length > 1)
    .map(([path, refs]) => ({
      type: "duplicate-final-artifact-path",
      severity: "error",
      message: `Multiple fanout worker artifacts target final path ${path}.`,
      path,
      workerIds: uniqueStrings(refs.map((ref) => ref.workerId).filter(isString)),
      artifactRefs: refs,
    }))
}

export function detectWorkerDependencyConflicts(plan: FanoutPlan, workerResults: FanoutWorkerResultRef[]): FanoutConflictRecord[] {
  const conflicts: FanoutConflictRecord[] = []
  const resultByWorkerId = new Map(workerResults.map((result) => [result.workerId, result]))

  for (const result of workerResults) {
    if (result.required && !agentTaskStatusSucceeded(result.status)) {
      conflicts.push({
        type: "failed-worker",
        severity: "error",
        message: `Required fanout worker ${result.workerId} ended with status ${result.status}.`,
        workerIds: [result.workerId],
        artifactRefs: result.artifactRefs,
        details: result.error ? { error: result.error } : undefined,
      })
    }
  }

  for (const worker of plan.workers) {
    for (const dependencyId of worker.dependsOn) {
      const dependency = resultByWorkerId.get(dependencyId)
      if (!dependency) {
        conflicts.push({
          type: "missing-worker-dependency",
          severity: "error",
          message: `Fanout worker ${worker.id} depends on missing worker ${dependencyId}.`,
          workerIds: [worker.id],
          dependencyId,
        })
        continue
      }

      if (!agentTaskStatusSucceeded(dependency.status)) {
        conflicts.push({
          type: "failed-worker-dependency",
          severity: "error",
          message: `Fanout worker ${worker.id} depends on ${dependencyId}, which ended with status ${dependency.status}.`,
          workerIds: [worker.id, dependencyId],
          dependencyId,
          artifactRefs: dependency.artifactRefs,
        })
      }
    }
  }

  return conflicts
}

function resolveAggregationStatus(policy: FanoutAggregationPolicy, conflicts: FanoutConflictRecord[]): FanoutAggregationOutputStatus {
  const hasError = conflicts.some((conflict) => conflict.severity === "error")
  if (!hasError) return "succeeded"
  if (policy === "partial") return "partial"
  if (policy === "repair") return "repair_required"
  if (policy === "caller-review-required") return "caller_review_required"
  return "failed"
}

function normalizePlan(plan: FanoutAggregationInputRequest["plan"]): FanoutPlan {
  const source: Record<string, unknown> = isRecord(plan) ? plan : {}
  const workers = Array.isArray(source.workers) ? source.workers.map(normalizeWorkerPlan) : []

  return {
    ...source,
    id: isString(source.id) ? source.id : undefined,
    workers,
    metadata: isRecord(source.metadata) ? source.metadata : undefined,
  }
}

function normalizeWorkerPlan(worker: unknown): FanoutWorkerPlan {
  const source = isRecord(worker) ? worker : {}
  const dependsOn = source.dependsOn ?? source.depends_on

  return {
    ...source,
    id: isString(source.id) ? source.id : "",
    dependsOn: Array.isArray(dependsOn) ? dependsOn.filter(isString) : [],
    required: source.required !== false,
    artifactNamespace: isString(source.artifactNamespace) ? source.artifactNamespace : isString(source.artifact_namespace) ? source.artifact_namespace : undefined,
    metadata: isRecord(source.metadata) ? source.metadata : undefined,
  }
}

function normalizeWorkerResultRef(workerResult: unknown): FanoutWorkerResultRef {
  const source = isRecord(workerResult) ? workerResult : {}
  const artifactRefs = source.artifactRefs ?? source.artifact_refs

  return {
    workerId: isString(source.workerId) ? source.workerId : isString(source.worker_id) ? source.worker_id : "",
    status: isString(source.status) ? normalizeAgentTaskStatus({ status: source.status, success: source.success }) : "missing",
    required: source.required !== false,
    resultRef: isString(source.resultRef) ? source.resultRef : isString(source.result_ref) ? source.result_ref : undefined,
    artifactRefs: Array.isArray(artifactRefs) ? artifactRefs.map((artifact) => normalizeArtifactRef(artifact, source.workerId ?? source.worker_id)) : [],
    error: normalizeError(source.error),
    metadata: isRecord(source.metadata) ? source.metadata : undefined,
  }
}

function normalizeArtifactRef(artifactRef: unknown, fallbackWorkerId?: unknown): FanoutArtifactRef {
  const source = isRecord(artifactRef) ? artifactRef : {}

  return {
    id: isString(source.id) ? source.id : undefined,
    path: isString(source.path) ? source.path : "",
    kind: isString(source.kind) ? source.kind : undefined,
    workerId: isString(source.workerId) ? source.workerId : isString(source.worker_id) ? source.worker_id : isString(fallbackWorkerId) ? fallbackWorkerId : undefined,
    namespace: isString(source.namespace) ? source.namespace : undefined,
    finalPath: isString(source.finalPath) ? source.finalPath : isString(source.final_path) ? source.final_path : undefined,
    contentType: isString(source.contentType) ? source.contentType : isString(source.content_type) ? source.content_type : undefined,
    sha256: isString(source.sha256) ? source.sha256 : undefined,
    bytes: typeof source.bytes === "number" ? source.bytes : undefined,
    metadata: isRecord(source.metadata) ? source.metadata : undefined,
  }
}

function normalizeConflictRecord(conflict: unknown): FanoutConflictRecord {
  const source = isRecord(conflict) ? conflict : {}
  const artifactRefs = source.artifactRefs ?? source.artifact_refs
  const workerIds = source.workerIds ?? source.worker_ids

  return {
    type: isString(source.type) ? source.type : "partial-output",
    severity: isString(source.severity) ? source.severity : "error",
    message: isString(source.message) ? source.message : "Fanout aggregation conflict candidate.",
    workerIds: Array.isArray(workerIds) ? workerIds.filter(isString) : undefined,
    path: isString(source.path) ? source.path : undefined,
    artifactRefs: Array.isArray(artifactRefs) ? artifactRefs.map((artifact) => normalizeArtifactRef(artifact)) : undefined,
    dependencyId: isString(source.dependencyId) ? source.dependencyId : isString(source.dependency_id) ? source.dependency_id : undefined,
    details: isRecord(source.details) ? source.details : undefined,
  }
}

function normalizeError(error: unknown): FanoutWorkerResultRef["error"] {
  if (!isRecord(error)) return undefined

  return {
    code: isString(error.code) ? error.code : undefined,
    message: isString(error.message) ? error.message : "Fanout worker failed.",
    details: isRecord(error.details) ? error.details : undefined,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)]
}

function normalizeOutputNamespace(outputNamespace: unknown): string {
  const raw = isString(outputNamespace) ? outputNamespace : "aggregate/final"
  return raw
    .split("/")
    .map((segment) => segment.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, ""))
    .filter(Boolean)
    .join("/") || "aggregate/final"
}
