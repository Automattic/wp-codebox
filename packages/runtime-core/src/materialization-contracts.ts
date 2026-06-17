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

export interface MaterializationResultEnvelope {
  schema: typeof MATERIALIZATION_RESULT_SCHEMA
  success: true
  task: string
  result: Record<string, unknown>
  report: Record<string, unknown> | null
  response: Record<string, unknown>
  codeboxMaterialization: unknown
}

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

export function normalizeMaterializationResultEnvelope(materialization: unknown, fallbackMessage = "Materialization failed."): MaterializationResultEnvelope {
  const materializationRecord = asRecord(materialization)
  const raw = asRecord(materializationRecord?.response) ?? materializationRecord
  const report = raw?.schema === MATERIALIZATION_RESULT_SCHEMA || typeof raw?.schema === "string"
    ? raw
    : undefined
  const response = asRecord(report?.response) ?? raw
  if (response?.success !== true) {
    throw new Error(errorMessage(response) ?? errorMessage(report) ?? fallbackMessage)
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
    throw new Error(errorMessage(canonicalResult) ?? fallbackMessage)
  }

  return {
    schema: MATERIALIZATION_RESULT_SCHEMA,
    success: true,
    task: stringValue(response.task) || stringValue(report?.task),
    result: canonicalResult ?? response,
    report: report ?? null,
    response,
    codeboxMaterialization: materialization,
  }
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

function errorMessage(value: Record<string, unknown> | undefined): string | undefined {
  const error = asRecord(value?.error)
  return stringValue(error?.message) || stringValue(value?.message) || undefined
}
