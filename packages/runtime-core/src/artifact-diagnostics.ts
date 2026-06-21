import { stripUndefined } from "./object-utils.js"

export const ARTIFACT_DIAGNOSTICS_SCHEMA = "wp-codebox/artifact-diagnostics/v1" as const

export type ArtifactDiagnosticSeverity = "error" | "warning" | "notice" | "info" | (string & {})

export interface ArtifactDiagnosticRef {
  path?: string
  kind?: string
  id?: string
  url?: string
}

export interface ArtifactDiagnostic {
  id: string
  type: string
  severity: ArtifactDiagnosticSeverity
  message: string
  category?: string
  source?: string
  path?: string
  selector?: string
  stage?: string
  code?: string
  provenance?: Record<string, unknown>
  refs?: ArtifactDiagnosticRef[]
  details?: Record<string, unknown>
}

export interface ArtifactDiagnostics {
  schema: typeof ARTIFACT_DIAGNOSTICS_SCHEMA
  status: "clean" | "reported"
  summary: {
    total: number
    error: number
    warning: number
    notice: number
    info: number
  }
  diagnostics: ArtifactDiagnostic[]
}

export type ArtifactDiagnosticNormalizerRef = ArtifactDiagnosticRef

export interface ArtifactDiagnosticNormalizerOptions {
  source?: string
  stage?: string
  observationType?: string
  refs?: ArtifactDiagnosticNormalizerRef[]
}

export function buildArtifactDiagnostics(input: unknown, options: ArtifactDiagnosticNormalizerOptions = {}): ArtifactDiagnostics {
  const observations = Array.isArray(input) ? input : [input]
  const diagnostics = observations.flatMap((observation, observationIndex) => diagnosticsFromArtifactObservation(observation, observationIndex, options))

  return artifactDiagnosticsEnvelope(diagnostics)
}

export function normalizeArtifactDiagnostics(input: unknown, options: ArtifactDiagnosticNormalizerOptions = {}): ArtifactDiagnostics {
  const record = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined
  if (record?.schema !== ARTIFACT_DIAGNOSTICS_SCHEMA) {
    return buildArtifactDiagnostics(input, options)
  }

  return artifactDiagnosticsEnvelope(arrayPayload(record.diagnostics)
    .map((value, index) => normalizeArtifactDiagnostic(value, record, 0, index, options))
    .filter((diagnostic): diagnostic is ArtifactDiagnostic => diagnostic !== null))
}

export function isArtifactDiagnostics(input: unknown): input is ArtifactDiagnostics {
  return Boolean(input && typeof input === "object" && !Array.isArray(input) && (input as Record<string, unknown>).schema === ARTIFACT_DIAGNOSTICS_SCHEMA)
}

function artifactDiagnosticsEnvelope(diagnostics: ArtifactDiagnostic[]): ArtifactDiagnostics {
  const summary = {
    total: diagnostics.length,
    error: diagnostics.filter((diagnostic) => diagnostic.severity === "error").length,
    warning: diagnostics.filter((diagnostic) => diagnostic.severity === "warning").length,
    notice: diagnostics.filter((diagnostic) => diagnostic.severity === "notice").length,
    info: diagnostics.filter((diagnostic) => diagnostic.severity === "info").length,
  }

  return {
    schema: ARTIFACT_DIAGNOSTICS_SCHEMA,
    status: diagnostics.length > 0 ? "reported" : "clean",
    summary,
    diagnostics,
  }
}

function diagnosticsFromArtifactObservation(observation: unknown, observationIndex: number, options: ArtifactDiagnosticNormalizerOptions): ArtifactDiagnostic[] {
  if (!observation || typeof observation !== "object" || Array.isArray(observation)) {
    return []
  }

  const record = observation as Record<string, unknown>
  const payload = record.data && typeof record.data === "object" && !Array.isArray(record.data) ? record.data as Record<string, unknown> : record
  const rawDiagnostics = [
    ...arrayPayload(payload.diagnostics),
    ...arrayPayload(payload.findings),
    ...arrayPayload(payload.issues),
    ...arrayPayload(payload.diagnostic),
  ]

  if (rawDiagnostics.length === 0 && !("data" in record) && !hasDiagnosticContainer(record)) {
    rawDiagnostics.push(record)
  }

  return rawDiagnostics
    .map((raw, diagnosticIndex) => normalizeArtifactDiagnostic(raw, record, observationIndex, diagnosticIndex, options))
    .filter((diagnostic): diagnostic is ArtifactDiagnostic => diagnostic !== null)
}

function hasDiagnosticContainer(record: Record<string, unknown>): boolean {
  return ["diagnostics", "findings", "issues", "diagnostic"].some((key) => key in record)
}

function normalizeArtifactDiagnostic(raw: unknown, observation: Record<string, unknown>, observationIndex: number, diagnosticIndex: number, options: ArtifactDiagnosticNormalizerOptions): ArtifactDiagnostic | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null
  }

  const value = raw as Record<string, unknown>
  const type = stringField(value.type) || stringField(value.kind) || stringField(value.code) || stringField(value.reason_code) || "diagnostic"
  const message = stringField(value.message) || stringField(value.summary) || stringField(value.reason) || stringField(value.excerpt) || stringField(value.error_message) || type
  const explicitDetails = value.details && typeof value.details === "object" && !Array.isArray(value.details) ? value.details as Record<string, unknown> : undefined
  const extraDetails = stripUndefined(Object.fromEntries(Object.entries(value).filter(([key]) => ![
    "id",
    "diagnostic_id",
    "type",
    "kind",
    "code",
    "reason_code",
    "message",
    "summary",
    "reason",
    "excerpt",
    "error_message",
    "severity",
    "category",
    "source",
    "path",
    "source_path",
    "selector",
    "stage",
    "refs",
    "references",
    "artifactRefs",
    "provenance",
    "details",
  ].includes(key))))
  const details = stripUndefined({
    ...explicitDetails,
    ...extraDetails,
  })
  const provenance = value.provenance && typeof value.provenance === "object" && !Array.isArray(value.provenance) ? value.provenance as Record<string, unknown> : {}

  return stripUndefined({
    id: stringField(value.id) || stringField(value.diagnostic_id) || `${stringField(observation.id) ?? `observation-${observationIndex}`}-diagnostic-${diagnosticIndex + 1}`,
    type,
    severity: normalizeArtifactDiagnosticSeverity(value.severity),
    message,
    category: stringField(value.category),
    source: stringField(value.source) || options.source,
    path: stringField(value.path) || stringField(value.source_path),
    selector: stringField(value.selector),
    stage: stringField(value.stage) || options.stage,
    code: stringField(value.code) || stringField(value.reason_code),
    provenance: stripUndefined({
      observationId: stringField(observation.id),
      observationType: stringField(observation.type) || options.observationType,
      observedAt: stringField(observation.observedAt),
      ...provenance,
    }),
    refs: artifactDiagnosticRefs(value.refs ?? value.references ?? value.artifactRefs, options.refs),
    details: Object.keys(details).length > 0 ? details : undefined,
  }) as ArtifactDiagnostic
}

function artifactDiagnosticRefs(raw: unknown, defaults: ArtifactDiagnosticNormalizerRef[] = []): ArtifactDiagnostic["refs"] {
  return [
    ...defaults,
    ...arrayPayload(raw)
      .filter((value) => value && typeof value === "object" && !Array.isArray(value))
      .map((value) => {
        const record = value as Record<string, unknown>
        return stripUndefined({
          path: stringField(record.path),
          kind: stringField(record.kind),
          id: stringField(record.id),
          url: stringField(record.url),
        })
      }),
  ].filter((value) => Object.keys(value).length > 0)
}

function arrayPayload(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value
  }
  return value && typeof value === "object" ? [value] : []
}

function stringField(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") {
    return value
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value)
  }
  return undefined
}

function normalizeArtifactDiagnosticSeverity(value: unknown): ArtifactDiagnostic["severity"] {
  const severity = stringField(value)?.toLowerCase()
  return severity === "error" || severity === "warning" || severity === "notice" || severity === "info" ? severity : "warning"
}
