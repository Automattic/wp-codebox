import type { MaterializationArtifactRef, MaterializationDiagnostic } from "./materialization-contracts.js"
import { buildArtifactDiagnostics, type ArtifactDiagnosticNormalizerOptions, type ArtifactDiagnostics } from "./artifact-diagnostics.js"

export const ARTIFACT_RESULT_ENVELOPE_SCHEMA = "wp-codebox/artifact-result-envelope/v1" as const

export type ArtifactResultOperation = "import-artifact-bundle" | "reimport-artifact-bundle" | "materialize-replay-package" | (string & {})
export type ArtifactResultStatus = "created" | "existing" | "updated" | "failed" | "skipped"

export interface ArtifactResultEnvelopeBase {
  schema: typeof ARTIFACT_RESULT_ENVELOPE_SCHEMA
  operation: ArtifactResultOperation
  status: ArtifactResultStatus
  success: boolean
  artifactBundle?: MaterializationArtifactRef
  artifactRefs: MaterializationArtifactRef[]
  verification?: Record<string, unknown>
  result?: Record<string, unknown>
  diagnostics: MaterializationDiagnostic[]
  metadata?: Record<string, unknown>
}

export interface SuccessfulArtifactResultEnvelope extends ArtifactResultEnvelopeBase {
  status: "created" | "existing" | "updated"
  success: true
}

export interface FailedArtifactResultEnvelope extends ArtifactResultEnvelopeBase {
  status: "failed"
  success: false
  error: {
    name: string
    message: string
    code?: string
  }
}

export interface SkippedArtifactResultEnvelope extends ArtifactResultEnvelopeBase {
  status: "skipped"
  success: false
  reason?: string
}

export type ArtifactResultEnvelope = SuccessfulArtifactResultEnvelope | FailedArtifactResultEnvelope | SkippedArtifactResultEnvelope

export function artifactDiagnosticsResultEnvelope(input: {
  operation: ArtifactResultOperation
  status?: ArtifactResultStatus
  diagnosticsInput: unknown
  diagnosticOptions?: ArtifactDiagnosticNormalizerOptions
  artifactBundle?: MaterializationArtifactRef
  artifactRefs?: MaterializationArtifactRef[]
  verification?: Record<string, unknown>
  result?: Record<string, unknown>
  metadata?: Record<string, unknown>
  error?: { name?: string; message?: string; code?: string } | Error | string
  reason?: string
}): ArtifactResultEnvelope {
  const artifactDiagnostics = buildArtifactDiagnostics(input.diagnosticsInput, input.diagnosticOptions)
  return artifactResultEnvelope({
    operation: input.operation,
    status: input.status,
    artifactBundle: input.artifactBundle,
    artifactRefs: input.artifactRefs,
    verification: input.verification,
    result: stripUndefined({
      ...input.result,
      artifactDiagnostics,
    }),
    diagnostics: artifactDiagnosticsResultDiagnostics(artifactDiagnostics),
    metadata: input.metadata,
    error: input.error,
    reason: input.reason,
  })
}

export function artifactResultEnvelope(input: {
  operation: ArtifactResultOperation
  status?: ArtifactResultStatus
  artifactBundle?: MaterializationArtifactRef
  artifactRefs?: MaterializationArtifactRef[]
  verification?: Record<string, unknown>
  result?: Record<string, unknown>
  diagnostics?: MaterializationDiagnostic[]
  metadata?: Record<string, unknown>
  error?: { name?: string; message?: string; code?: string } | Error | string
  reason?: string
}): ArtifactResultEnvelope {
  const status = input.status ?? (input.error ? "failed" : "created")
  const artifactRefs = normalizeArtifactRefs([...(input.artifactBundle ? [input.artifactBundle] : []), ...(input.artifactRefs ?? [])])
  const diagnostics = input.diagnostics ?? []
  const base = stripUndefined({
    schema: ARTIFACT_RESULT_ENVELOPE_SCHEMA,
    operation: input.operation,
    status,
    success: status === "created" || status === "existing" || status === "updated",
    artifactBundle: input.artifactBundle,
    artifactRefs,
    verification: input.verification,
    result: input.result,
    diagnostics,
    metadata: input.metadata,
  })

  if (status === "failed") {
    return stripUndefined({
      ...base,
      status,
      success: false as const,
      error: normalizeError(input.error, diagnostics[0]?.message ?? "Artifact operation failed."),
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
  }
}

export function normalizeArtifactResultEnvelope(input: unknown, fallbackOperation: ArtifactResultOperation = "import-artifact-bundle"): ArtifactResultEnvelope {
  const record = asRecord(input)
  if (record?.schema === ARTIFACT_RESULT_ENVELOPE_SCHEMA) {
    return artifactResultEnvelope({
      operation: stringValue(record.operation) || fallbackOperation,
      status: artifactResultStatus(record.status),
      artifactBundle: materializationArtifactRef(record.artifactBundle),
      artifactRefs: Array.isArray(record.artifactRefs) ? record.artifactRefs.map(materializationArtifactRef).filter(isDefined) : [],
      verification: asRecord(record.verification),
      result: asRecord(record.result),
      diagnostics: Array.isArray(record.diagnostics) ? record.diagnostics.map(materializationDiagnostic).filter(isDefined) : [],
      metadata: asRecord(record.metadata),
      error: errorObject(record.error),
      reason: stringValue(record.reason) || undefined,
    })
  }

  const result = asRecord(record?.result) ?? record ?? {}
  return artifactResultEnvelope({
    operation: fallbackOperation,
    status: result.success === false ? "failed" : undefined,
    artifactBundle: materializationArtifactRef(result.artifactBundle ?? result.artifact_bundle ?? result.artifact_ref),
    artifactRefs: Array.isArray(result.artifactRefs) ? result.artifactRefs.map(materializationArtifactRef).filter(isDefined) : [],
    verification: asRecord(result.verification),
    result,
    error: result.success === false ? errorObject(result.error) ?? "Artifact operation failed." : undefined,
  })
}

function normalizeArtifactRefs(refs: MaterializationArtifactRef[]): MaterializationArtifactRef[] {
  const seen = new Set<string>()
  const normalized: MaterializationArtifactRef[] = []
  for (const ref of refs) {
    const key = `${ref.kind}:${ref.id ?? ""}:${ref.path ?? ""}:${ref.digest?.value ?? ""}`
    if (seen.has(key)) continue
    seen.add(key)
    normalized.push(ref)
  }
  return normalized
}

function artifactDiagnosticsResultDiagnostics(artifactDiagnostics: ArtifactDiagnostics): MaterializationDiagnostic[] {
  if (artifactDiagnostics.summary.total === 0) {
    return []
  }

  return [{
    code: "wp-codebox.artifact-diagnostics.reported",
    message: `${artifactDiagnostics.summary.total} artifact diagnostic${artifactDiagnostics.summary.total === 1 ? "" : "s"} reported.`,
    severity: artifactDiagnostics.summary.error > 0 ? "error" : artifactDiagnostics.summary.warning > 0 ? "warning" : "info",
    metadata: { summary: artifactDiagnostics.summary },
  }]
}

function materializationArtifactRef(input: unknown): MaterializationArtifactRef | undefined {
  const record = asRecord(input)
  if (!record) return undefined
  const kind = stringValue(record.kind) || "artifact-bundle"
  const digest = asRecord(record.digest)
  const ref: MaterializationArtifactRef = { kind }
  const id = stringValue(record.id ?? record.artifact_id)
  const path = stringValue(record.path ?? record.artifacts_path ?? record.directory)
  const digestValue = stringValue(digest?.value)
  if (id) ref.id = id
  if (path) ref.path = path
  if (digestValue) {
    ref.digest = {
      algorithm: stringValue(digest?.algorithm) || "sha256",
      value: digestValue,
    }
  }
  return ref
}

function materializationDiagnostic(input: unknown): MaterializationDiagnostic | undefined {
  const record = asRecord(input)
  const code = stringValue(record?.code)
  const message = stringValue(record?.message)
  if (!code || !message) return undefined
  let severity: MaterializationDiagnostic["severity"] | undefined
  if (record?.severity === "info" || record?.severity === "warning" || record?.severity === "error") {
    severity = record.severity
  }
  return stripUndefined({
    code,
    message,
    severity,
    phase: stringValue(record?.phase),
    metadata: asRecord(record?.metadata),
  })
}

function normalizeError(error: unknown, fallbackMessage: string): { name: string; message: string; code?: string } {
  if (error instanceof Error) {
    return { name: error.name || "Error", message: error.message || fallbackMessage }
  }
  if (typeof error === "string" && error) {
    return { name: "Error", message: error }
  }
  const record = asRecord(error)
  return stripUndefined({
    name: stringValue(record?.name) || "Error",
    message: stringValue(record?.message) || fallbackMessage,
    code: stringValue(record?.code),
  })
}

function artifactResultStatus(value: unknown): ArtifactResultStatus | undefined {
  return value === "created" || value === "existing" || value === "updated" || value === "failed" || value === "skipped" ? value : undefined
}

function errorObject(value: unknown): { name?: string; message?: string; code?: string } | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  return {
    name: stringValue(record.name),
    message: stringValue(record.message),
    code: stringValue(record.code),
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(asRecord(value))
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}

function stripUndefined<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T
}
