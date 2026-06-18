import type { RuntimeRunArtifactRef } from "./run-registry.js"

export const MATERIALIZATION_RESULT_SCHEMA = "wp-codebox/materialization-result/v1" as const

export interface MaterializationArtifactRef {
  kind: string
  path?: string
  id?: string
  digest?: {
    algorithm: "sha256" | (string & {})
    value: string
  }
}

export interface MaterializationPhaseResult {
  schema: "wp-codebox/materialization-phase-result/v1"
  phase: string
  status: "completed" | "failed" | "skipped"
  artifactRefs: MaterializationArtifactRef[]
  metadata?: Record<string, unknown>
  error?: {
    name: string
    message: string
    code?: string
  }
}

export type MaterializationResultStatus = "completed" | "failed" | "skipped"

export interface MaterializationDiagnostic {
  code: string
  message: string
  severity?: "info" | "warning" | "error"
  phase?: string
  metadata?: Record<string, unknown>
}

export interface MaterializationProjection {
  kind: string
  schema?: string
  [key: string]: unknown
}

export interface MaterializationResultEnvelopeBase {
  schema: typeof MATERIALIZATION_RESULT_SCHEMA
  status: MaterializationResultStatus
  success: boolean
  task?: string
  phases: MaterializationPhaseResult[]
  artifactRefs: MaterializationArtifactRef[]
  diagnostics: MaterializationDiagnostic[]
  projections?: MaterializationProjection[]
  metadata?: Record<string, unknown>
  result?: Record<string, unknown>
  report: Record<string, unknown> | null
  response?: Record<string, unknown>
  codeboxMaterialization?: unknown
}

export interface CompletedMaterializationResultEnvelope extends MaterializationResultEnvelopeBase {
  status: "completed"
  success: true
  result: Record<string, unknown>
}

export interface FailedMaterializationResultEnvelope extends MaterializationResultEnvelopeBase {
  status: "failed"
  success: false
  error: {
    name: string
    message: string
    code?: string
  }
}

export interface SkippedMaterializationResultEnvelope extends MaterializationResultEnvelopeBase {
  status: "skipped"
  success: false
  reason?: string
}

export type MaterializationResultEnvelope = CompletedMaterializationResultEnvelope | FailedMaterializationResultEnvelope | SkippedMaterializationResultEnvelope

export interface BrowserArtifactProjectionInput {
  artifact?: Record<string, unknown> | null
  artifacts?: unknown
  artifact_bundle?: Record<string, unknown> | null
  artifactBundle?: Record<string, unknown> | null
  materialization?: Record<string, unknown> | null
  result?: Record<string, unknown> | null
}

export interface BrowserArtifactPersistenceProjection {
  schema: "wp-codebox/browser-artifact-persistence-projection/v1"
  artifact?: Record<string, unknown>
  artifacts: Record<string, unknown>[]
  artifactBundle?: Record<string, unknown>
  materialization?: Record<string, unknown>
  artifactRefs: MaterializationArtifactRef[]
}

export function materializationPhaseResult(input: Omit<MaterializationPhaseResult, "schema" | "artifactRefs"> & { artifactRefs?: MaterializationArtifactRef[] }): MaterializationPhaseResult {
  return stripUndefined({
    schema: "wp-codebox/materialization-phase-result/v1" as const,
    ...input,
    artifactRefs: input.artifactRefs ?? [],
  })
}

export function materializationResultEnvelope(input: {
  task?: string
  status?: MaterializationResultStatus
  phases?: MaterializationPhaseResult[]
  artifactRefs?: MaterializationArtifactRef[]
  diagnostics?: MaterializationDiagnostic[]
  projections?: MaterializationProjection[]
  metadata?: Record<string, unknown>
  result?: Record<string, unknown>
  report?: Record<string, unknown> | null
  response?: Record<string, unknown>
  error?: { name?: string; message?: string; code?: string } | Error | string
  reason?: string
  codeboxMaterialization?: unknown
}): MaterializationResultEnvelope {
  const phases = input.phases ?? []
  const status = input.status ?? (input.error || phases.some((phase) => phase.status === "failed") ? "failed" : "completed")
  const artifactRefs = [...(input.artifactRefs ?? []), ...phases.flatMap((phase) => phase.artifactRefs)]
  const diagnostics = input.diagnostics ?? phases.flatMap(phaseDiagnostics)
  const base = stripUndefined({
    schema: MATERIALIZATION_RESULT_SCHEMA,
    status,
    success: status === "completed",
    task: input.task,
    phases,
    artifactRefs,
    diagnostics,
    projections: input.projections,
    metadata: input.metadata,
    result: input.result,
    report: input.report ?? null,
    response: input.response,
    codeboxMaterialization: input.codeboxMaterialization,
  })

  if (status === "failed") {
    return stripUndefined({
      ...base,
      status,
      success: false as const,
      error: normalizeError(input.error, diagnostics[0]?.message ?? "Materialization failed."),
    })
  }

  if (status === "skipped") {
    return stripUndefined({
      ...base,
      status,
      success: false as const,
      reason: input.reason,
    })
  }

  return {
    ...base,
    status,
    success: true as const,
    result: input.result ?? {},
  }
}

export function normalizeMaterializationResultEnvelope(materialization: unknown, fallbackMessage = "Materialization failed."): CompletedMaterializationResultEnvelope {
  const materializationRecord = asRecord(materialization)
  const raw = asRecord(materializationRecord?.response) ?? materializationRecord
  const report = raw?.schema === MATERIALIZATION_RESULT_SCHEMA || typeof raw?.schema === "string"
    ? raw
    : undefined
  const response = asRecord(report?.response) ?? raw
  if (response?.success !== true) {
    return requireCompletedMaterializationResultEnvelope(materializationResultEnvelope({
      task: stringValue(response?.task) || stringValue(report?.task),
      status: "failed",
      report: report ?? null,
      response,
      error: errorObject(response) ?? errorObject(report) ?? fallbackMessage,
      codeboxMaterialization: materialization,
    }))
  }

  const canonicalResult = firstRecord(
    asRecord(response.result)?.result,
    asRecord(response.result)?.data,
    asRecord(response.result)?.response,
    response.result,
    response.data,
    response.response,
  )
  if (canonicalResult?.success === false) {
    return requireCompletedMaterializationResultEnvelope(materializationResultEnvelope({
      task: stringValue(response.task) || stringValue(report?.task),
      status: "failed",
      result: canonicalResult,
      report: report ?? null,
      response,
      error: errorObject(canonicalResult) ?? fallbackMessage,
      codeboxMaterialization: materialization,
    }))
  }

  return requireCompletedMaterializationResultEnvelope(materializationResultEnvelope({
    task: stringValue(response.task) || stringValue(report?.task),
    result: canonicalResult ?? response,
    report: report ?? null,
    response,
    codeboxMaterialization: materialization,
  }))
}

export function requireCompletedMaterializationResultEnvelope(envelope: MaterializationResultEnvelope): CompletedMaterializationResultEnvelope {
  if (envelope.status !== "completed") {
    throw new Error(envelope.status === "failed" ? envelope.error.message : envelope.reason ?? "Materialization did not complete.")
  }
  return envelope
}

export function browserArtifactPersistenceProjection(input: BrowserArtifactProjectionInput | MaterializationResultEnvelope | unknown): BrowserArtifactPersistenceProjection {
  const source = materializationProjectionSource(input)
  const artifactBundle = asRecord(source.artifact_bundle) ?? asRecord(source.artifactBundle) ?? undefined
  const artifact = asRecord(source.artifact) ?? undefined
  const artifacts = Array.isArray(source.artifacts)
    ? source.artifacts.filter(isRecord)
    : artifact ? [artifact] : []
  const materialization = asRecord(source.materialization) ?? undefined
  const artifactRefs = browserArtifactProjectionRefs({ artifactBundle, artifacts, materialization })

  return stripUndefined({
    schema: "wp-codebox/browser-artifact-persistence-projection/v1" as const,
    artifact,
    artifacts,
    artifactBundle,
    materialization,
    artifactRefs,
  })
}

export function materializationRunArtifactRefs(results: MaterializationPhaseResult[]): RuntimeRunArtifactRef[] {
  return results.flatMap((result) =>
    result.artifactRefs.map((ref) =>
      stripUndefined({
        kind: `materialization:${ref.kind}`,
        path: ref.path,
        id: ref.id,
        digest: ref.digest,
      }),
    ),
  )
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T
}

function materializationProjectionSource(input: unknown): Record<string, unknown> {
  const source = asRecord(input) ?? {}
  if (source.schema === MATERIALIZATION_RESULT_SCHEMA && isRecord(source.result)) {
    return source.result
  }
  if (isRecord(source.result) && (source.result.artifact || source.result.artifacts || source.result.artifact_bundle || source.result.artifactBundle || source.result.materialization)) {
    return source.result
  }
  return source
}

function browserArtifactProjectionRefs(input: { artifactBundle?: Record<string, unknown>; artifacts: Record<string, unknown>[]; materialization?: Record<string, unknown> }): MaterializationArtifactRef[] {
  const refs: MaterializationArtifactRef[] = []
  const bundleId = stringValue(input.artifactBundle?.id ?? input.artifactBundle?.artifact_id)
  const bundleDigest = normalizeDigest(input.artifactBundle?.contentDigest ?? input.artifactBundle?.content_digest ?? input.artifactBundle?.digest ?? input.artifactBundle?.sha256)
  if (bundleId || bundleDigest || stringValue(input.artifactBundle?.path)) {
    refs.push(stripUndefined({
      kind: "artifact-bundle",
      id: bundleId || undefined,
      path: stringValue(input.artifactBundle?.path) || stringValue(input.artifactBundle?.directory) || undefined,
      digest: bundleDigest,
    }))
  }

  for (const artifact of input.artifacts) {
    const path = stringValue(artifact.path)
    const id = stringValue(artifact.id ?? artifact.artifact_id)
    if (!path && !id) {
      continue
    }
    refs.push(stripUndefined({
      kind: stringValue(artifact.kind ?? artifact.artifact_type ?? artifact.role) || "browser-artifact",
      id: id || undefined,
      path: path || undefined,
      digest: normalizeDigest(artifact.digest ?? artifact.sha256 ?? artifact.contentDigest ?? artifact.content_digest),
    }))
  }

  const materializationId = stringValue(input.materialization?.id ?? input.materialization?.artifact_id)
  if (materializationId) {
    refs.push({ kind: "materialization", id: materializationId })
  }

  return refs
}

function normalizeDigest(input: unknown): MaterializationArtifactRef["digest"] | undefined {
  if (typeof input === "string" && input.length > 0) {
    return { algorithm: "sha256", value: input }
  }
  if (!isRecord(input)) {
    return undefined
  }
  const value = stringValue(input.value)
  const algorithm = stringValue(input.algorithm) || "sha256"
  return value ? { algorithm, value } : normalizeDigest(input.sha256) ?? normalizeDigest(input.digest) ?? normalizeDigest(input.contentDigest)
}

function phaseDiagnostics(phase: MaterializationPhaseResult): MaterializationDiagnostic[] {
  if (phase.status !== "failed" || !phase.error) {
    return []
  }
  return [{
    code: phase.error.code ?? "materialization-phase-failed",
    message: phase.error.message,
    severity: "error",
    phase: phase.phase,
  }]
}

function normalizeError(input: { name?: string; message?: string; code?: string } | Error | string | undefined, fallbackMessage: string): FailedMaterializationResultEnvelope["error"] {
  if (input instanceof Error) {
    return stripUndefined({ name: input.name || "Error", message: input.message || fallbackMessage, code: "code" in input && typeof input.code === "string" ? input.code : undefined })
  }
  if (typeof input === "string") {
    return { name: "Error", message: input || fallbackMessage }
  }
  return stripUndefined({
    name: stringValue(input?.name) || "Error",
    message: stringValue(input?.message) || fallbackMessage,
    code: stringValue(input?.code) || undefined,
  })
}

function errorObject(value: Record<string, unknown> | undefined): FailedMaterializationResultEnvelope["error"] | undefined {
  const error = asRecord(value?.error)
  const message = stringValue(error?.message) || stringValue(value?.message)
  return message ? normalizeError({ name: stringValue(error?.name) || "Error", message, code: stringValue(error?.code) || undefined }, message) : undefined
}

function firstRecord(...values: unknown[]): Record<string, unknown> | undefined {
  return values.find(isRecord)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : ""
}
