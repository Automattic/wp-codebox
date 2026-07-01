import type { RuntimeRunArtifactRef } from "./run-registry.js"

export const MATERIALIZATION_RESULT_SCHEMA = "wp-codebox/materialization-result/v1" as const
export const BROWSER_ARTIFACT_PERSISTENCE_REF_SCHEMA = "wp-codebox/browser-artifact-persistence/ref/v1" as const
export const BROWSER_ARTIFACT_PERSISTENCE_PROJECTION_SCHEMA = BROWSER_ARTIFACT_PERSISTENCE_REF_SCHEMA
export const ARTIFACT_BUNDLE_FILE_MANIFEST_SCHEMA = "wp-codebox/artifact-bundle-file-manifest/v1" as const

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

export interface MaterializationResultEnvelopeExtraction {
  report?: Record<string, unknown>
  response?: Record<string, unknown>
  result?: Record<string, unknown>
  task?: string
  error?: FailedMaterializationResultEnvelope["error"]
  malformed?: boolean
}

export interface BrowserArtifactProjectionInput {
  artifact?: Record<string, unknown> | null
  artifacts?: unknown
  artifactRefs?: unknown
  artifact_bundle?: Record<string, unknown> | null
  artifactBundle?: Record<string, unknown> | null
  materialization?: Record<string, unknown> | null
  result?: Record<string, unknown> | null
}

export interface BrowserArtifactPersistenceRef {
  schema: typeof BROWSER_ARTIFACT_PERSISTENCE_REF_SCHEMA
  artifact?: Record<string, unknown>
  artifacts: Record<string, unknown>[]
  artifactBundle?: Record<string, unknown>
  materialization?: Record<string, unknown>
  artifactRefs: MaterializationArtifactRef[]
}

export type BrowserArtifactPersistenceProjection = BrowserArtifactPersistenceRef

export interface ArtifactBundleFileManifest {
  schema: typeof ARTIFACT_BUNDLE_FILE_MANIFEST_SCHEMA
  bundle?: MaterializationArtifactRef
  files: MaterializationArtifactRef[]
  paths: string[]
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
  const artifactRefs = normalizeMaterializationArtifactRefs([...(input.artifactRefs ?? []), ...phases.flatMap((phase) => phase.artifactRefs)])
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

export function normalizeMaterializationResultEnvelope(materialization: unknown, fallbackMessage = "Materialization failed."): MaterializationResultEnvelope {
  const extracted = extractMaterializationResultEnvelope(materialization, fallbackMessage)
  const { report, response } = extracted
  if (response?.success !== true) {
    return materializationResultEnvelope({
      task: extracted.task,
      status: "failed",
      report: report ?? null,
      response,
      error: extracted.error ?? fallbackMessage,
      codeboxMaterialization: materialization,
    })
  }

  const canonicalResult = extracted.result
  if (canonicalResult?.success === false) {
    return materializationResultEnvelope({
      task: extracted.task,
      status: "failed",
      result: canonicalResult,
      report: report ?? null,
      response,
      error: errorObject(canonicalResult) ?? fallbackMessage,
      codeboxMaterialization: materialization,
    })
  }
  if (extracted.malformed) {
    return materializationResultEnvelope({
      task: extracted.task,
      status: "failed",
      report: report ?? null,
      response,
      error: extracted.error ?? fallbackMessage,
      codeboxMaterialization: materialization,
    })
  }

  return requireCompletedMaterializationResultEnvelope(materializationResultEnvelope({
    task: extracted.task,
    result: canonicalResult ?? response,
    report: report ?? null,
    response,
    codeboxMaterialization: materialization,
  }))
}

export function extractMaterializationResultEnvelope(materialization: unknown, fallbackMessage = "Materialization failed."): MaterializationResultEnvelopeExtraction {
  const materializationRecord = asRecord(materialization)
  const raw = asRecord(materializationRecord?.response) ?? materializationRecord
  const report = raw?.schema === MATERIALIZATION_RESULT_SCHEMA || typeof raw?.schema === "string"
    ? raw
    : undefined
  const response = asRecord(report?.response) ?? raw
  const result = canonicalMaterializationResult(response) ?? capturedMaterializationResult(response) ?? capturedMaterializationResult(report)
  const task = stringValue(response?.task) || stringValue(report?.task) || undefined
  const error = errorObject(response) ?? errorObject(report)
  const malformed = response?.success === true && response.schema === MATERIALIZATION_RESULT_SCHEMA && !result

  return stripUndefined({
    report,
    response,
    result,
    task,
    error: malformed ? error ?? normalizeError(fallbackMessage, fallbackMessage) : error,
    malformed: malformed || undefined,
  })
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
  const artifactRefs = [
    ...normalizeMaterializationArtifactRefs(Array.isArray(source.artifactRefs) ? source.artifactRefs : []),
    ...browserArtifactProjectionRefs({ artifactBundle, artifacts, materialization }),
  ]

  return stripUndefined({
    schema: BROWSER_ARTIFACT_PERSISTENCE_REF_SCHEMA,
    artifact,
    artifacts,
    artifactBundle,
    materialization,
    artifactRefs: normalizeMaterializationArtifactRefs(artifactRefs),
  })
}

export function normalizeMaterializationArtifactRef(input: unknown, defaults: Partial<MaterializationArtifactRef> = {}): MaterializationArtifactRef | undefined {
  const source = asRecord(input)
  if (!source) {
    return undefined
  }

  const kind = stringValue(source.kind ?? source.role ?? source.artifact_type) || defaults.kind
  const id = stringValue(source.id ?? source.artifact_id) || defaults.id
  const path = stringValue(source.path ?? source.artifacts_path ?? source.directory) || defaults.path
  const digest = normalizeDigest(source.digest ?? source.contentDigest ?? source.content_digest ?? source.sha256) ?? defaults.digest

  if (!id && !path && !digest && !stringValue(source.kind)) {
    return undefined
  }

  return stripUndefined({
    kind: kind ?? "artifact",
    id,
    path,
    digest,
  })
}

export function normalizeMaterializationArtifactRefs(inputs: unknown[] | undefined): MaterializationArtifactRef[] {
  const refs: MaterializationArtifactRef[] = []
  const seen = new Set<string>()
  for (const input of inputs ?? []) {
    const ref = normalizeMaterializationArtifactRef(input)
    if (!ref) {
      continue
    }
    const key = `${ref.kind}\u0000${ref.id ?? ""}\u0000${ref.path ?? ""}\u0000${ref.digest?.algorithm ?? ""}\u0000${ref.digest?.value ?? ""}`
    if (!seen.has(key)) {
      refs.push(ref)
      seen.add(key)
    }
  }
  return refs
}

export function persistedBrowserArtifactRefs(input: BrowserArtifactProjectionInput | MaterializationResultEnvelope | unknown): MaterializationArtifactRef[] {
  return browserArtifactPersistenceProjection(input).artifactRefs
}

export function artifactBundleFileManifest(input: BrowserArtifactProjectionInput | MaterializationResultEnvelope | BrowserArtifactPersistenceProjection | unknown): ArtifactBundleFileManifest {
  const projection = isBrowserArtifactPersistenceRef(input)
    ? input as unknown as BrowserArtifactPersistenceProjection
    : browserArtifactPersistenceProjection(input)
  const refs = normalizeMaterializationArtifactRefs(projection.artifactRefs)
  const bundle = refs.find((ref) => ref.kind === "artifact-bundle")
  const files = refs.filter((ref) => ref.path && ref.kind !== "artifact-bundle" && ref.kind !== "materialization")
  return stripUndefined({
    schema: ARTIFACT_BUNDLE_FILE_MANIFEST_SCHEMA,
    bundle,
    files,
    paths: files.map((file) => file.path as string),
  })
}

export function isBrowserArtifactPersistenceRef(input: unknown): input is BrowserArtifactPersistenceRef {
  return isRecord(input) && input.schema === BROWSER_ARTIFACT_PERSISTENCE_REF_SCHEMA
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
  const bundle = normalizeMaterializationArtifactRef(input.artifactBundle, { kind: "artifact-bundle" })
  if (bundle) {
    refs.push(bundle)
  }

  for (const artifact of input.artifacts) {
    const ref = normalizeMaterializationArtifactRef(artifact, { kind: "browser-artifact" })
    if (ref?.path || ref?.id) {
      refs.push(ref)
    }
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
  return value ? { algorithm, value } : normalizeDigest(input.sha256) ?? normalizeDigest(input.digest)
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

function canonicalMaterializationResult(response: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return firstRecord(
    asRecord(response?.result)?.result,
    asRecord(response?.result)?.data,
    asRecord(response?.result)?.response,
    response?.result,
    response?.data,
    response?.response,
  )
}

function capturedMaterializationResult(source: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const captures = Array.isArray(source?.captures) ? source.captures : []
  for (const capture of captures) {
    const captureRecord = asRecord(capture)
    const json = asRecord(captureRecord?.json) ?? parseJsonRecord(captureRecord?.content)
    const nestedResponse = asRecord(json?.response) ?? json
    const result = canonicalMaterializationResult(nestedResponse)
    if (result) {
      return result
    }
  }
  return undefined
}

function parseJsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined
  }
  try {
    return asRecord(JSON.parse(value))
  } catch {
    return undefined
  }
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
