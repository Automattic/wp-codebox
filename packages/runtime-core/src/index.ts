import { stripUndefined } from "./object-utils.js"
import type { ArtifactPreview, ArtifactProvenance } from "./runtime-contracts.js"

export * from "./artifact-manifest.js"
export * from "./artifact-references.js"
export * from "./runtime-contracts.js"
export * from "./runtime-defaults.js"
export * from "./runtime-policy.js"
export * from "./workspace-policy.js"
export * from "./sandbox-tool-policy.js"
export * from "./command-registry.js"
export * from "./task-input.js"
export * from "./agent-task-run-result.js"
export * from "./agent-runtime-workload.js"
export * from "./browser-interaction.js"
export * from "./browser-review-bridge.js"
export * from "./browser-result-shapes.js"
export * from "./recipe-schema.js"
export * from "./recipe-builders.js"
export * from "./benchmark-contracts.js"
export * from "./benchmark-substrate.js"
export * from "./runtime-episode.js"
export * from "./runtime-reference.js"
export * from "./object-utils.js"
export * from "./runtime-action-adapter.js"
export * from "./artifact-bundle-verifier.js"
export * from "./artifact-apply-adapter.js"
export * from "./transfer-proof.js"
export * from "./host-tool-registry.js"
export * from "./run-registry.js"
export * from "./fanout-contracts.js"
export * from "./fanout-aggregation.js"
export * from "./partial-artifact-discovery.js"
export * from "./recipe-run-summary.js"

export type ArtifactReviewProgressEventType =
  | "boot"
  | "mount"
  | "agent-start"
  | "tool-activity"
  | "artifact"
  | "complete"
  | (string & {})

export interface ArtifactReviewProgressEvent {
  type: ArtifactReviewProgressEventType
  label: string
  component?: string
  action?: string
  timestamp?: string
}

export type ArtifactReviewActionKind = "approve" | "approve-files" | "discard" | "iterate" | (string & {})

export interface ArtifactReviewAction {
  kind: ArtifactReviewActionKind
  label: string
  requiresApprovedFiles?: boolean
}

export interface ArtifactReviewChangedFile {
  path: string
  status: "added" | "modified" | "deleted"
  label: string
  mountTarget: string
  relativePath: string
}

export interface ArtifactReview {
  schema: "wp-codebox/artifact-review/v1"
  artifactId: string
  createdAt: string
  provenance: ArtifactProvenance
  summary: string
  stats: {
    added: number
    modified: number
    deleted: number
    total: number
  }
  changedFiles: ArtifactReviewChangedFile[]
  preview?: ArtifactPreview
  progress: ArtifactReviewProgressEvent[]
  actions: ArtifactReviewAction[]
  evidence: {
    workspacePatch: string
    patch: string
    patchSha256: string
    artifactContentDigest: string
    changedFiles: string
    diagnostics?: string
    testResults?: string
    runtimeEpisodeTrace?: string
    runtimeReferenceManifest?: string
    runtimeReplayReferenceIndex?: string
    previewEvidence?: string
    previewSessionEvidence?: string
    agentResult?: string
    transcript?: string
  }
  browser?: ArtifactReviewBrowserSummary
  redaction?: ArtifactRedactionSummary
  riskFlags: string[]
}

export interface ArtifactReviewBrowserSummary {
  summary: string
  probes: Array<{
    url: string
    requestedUrl?: string
    preview?: {
      requestedMode: "local" | "public" | "secure"
      effectiveMode: "local" | "public" | "secure"
      localOrigin: string
      effectiveOrigin: string
      publicOrigin?: string
      secureContext?: boolean
      diagnostics: Array<{
        code: string
        severity: "error" | "warning" | "info"
        message: string
        details?: Record<string, unknown>
      }>
    }
    localPreviewOrigin?: string
    requestedPreviewOrigin?: string
    effectivePreviewOrigin?: string
    finalUrl?: string
    windowLocationOrigin?: string
    viewport?: {
      width: number
      height: number
      deviceScaleFactor: number
      isMobile: boolean
      hasTouch: boolean
      userAgent: string
    } | null
    capabilities?: ArtifactReviewBrowserCapabilities
    replayability?: "artifact-backed" | "partial" | "diagnostic-only"
    consoleMessages: number
    errors: number
    html?: string
    lifecycle?: string
    network?: string
    networkEvents?: number
    checkpoints?: string
    memory?: string
    performance?: string
    review?: string
    screenshot?: string
    visualCompare?: {
      status: string
      mismatchRatio?: number
      mismatchPixels?: number
      totalPixels?: number
      dimensionMismatch?: boolean
    }
    console?: string
    errorsFile?: string
    actions?: string
    editorState?: string
    actionCount?: number
    steps?: string
    stepCount?: number
    assertions?: {
      total: number
      passed: number
      failed: number
    }
    summaryFile?: string
  }>
}

export interface ArtifactReviewBrowserCapabilities {
  secureContext: boolean
  userAgent: string
  language?: string
  languages?: string[]
  locale?: string
  timezone?: string
  viewport: {
    width: number
    height: number
    deviceScaleFactor: number
    isMobile: boolean
    hasTouch: boolean
  } | null
  maxTouchPoints: number
  paymentRequest: {
    available: boolean
  }
  permissions: Record<string, { state: "granted" | "denied" | "prompt" | "unsupported" | "error" }>
}

export interface ArtifactRedactionArtifactSummary {
  path: string
  count: number
  kinds: string[]
}

export interface ArtifactRedactionSummary {
  schema: "wp-codebox/artifact-redaction/v1"
  status: "clean" | "redacted"
  total: number
  byKind: Record<string, number>
  artifacts: ArtifactRedactionArtifactSummary[]
}

export interface ArtifactTestResultsRawLogReference {
  path: string
  kind: string
}

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
  schema: "wp-codebox/artifact-diagnostics/v1"
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
  const summary = {
    total: diagnostics.length,
    error: diagnostics.filter((diagnostic) => diagnostic.severity === "error").length,
    warning: diagnostics.filter((diagnostic) => diagnostic.severity === "warning").length,
    notice: diagnostics.filter((diagnostic) => diagnostic.severity === "notice").length,
    info: diagnostics.filter((diagnostic) => diagnostic.severity === "info").length,
  }

  return {
    schema: "wp-codebox/artifact-diagnostics/v1",
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
  const details = stripUndefined(Object.fromEntries(Object.entries(value).filter(([key]) => ![
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
  ].includes(key))))

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

export interface ArtifactTestResultsSuite {
  name: string
  status: "passed" | "failed" | "skipped" | "unknown"
  tests: number
  passed: number
  failed: number
  skipped: number
  unknown: number
  rawLogReferences?: ArtifactTestResultsRawLogReference[]
}

export interface ArtifactTestResults {
  schema: "wp-codebox/test-results/v1"
  status: "passed" | "failed" | "skipped" | "unknown"
  summary: {
    total: number
    passed: number
    failed: number
    skipped: number
    unknown: number
  }
  suites: ArtifactTestResultsSuite[]
  rawLogReferences: ArtifactTestResultsRawLogReference[]
}
