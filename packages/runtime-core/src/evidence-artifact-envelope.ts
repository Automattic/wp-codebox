import type { ArtifactFileDigest } from "./artifact-manifest.js"
import { safeArtifactRelativePath } from "./artifact-paths.js"
import { artifactStoragePublicUrl, type RuntimeArtifactStorageDescriptor } from "./artifact-storage.js"
import { isPlainObject, normalizeJsonValue, stripUndefined } from "./object-utils.js"

export const EVIDENCE_ARTIFACT_ENVELOPE_SCHEMA = "wp-codebox/evidence-artifact-envelope/v1" as const
export const BROWSER_EVIDENCE_CAPTURE_SCHEMA = "wp-codebox/browser-evidence-capture/v1" as const

const EVIDENCE_CAPTURE_STATUSES = new Set(["passed", "failed", "errored", "skipped", "unknown"])

export type EvidenceCaptureStatus = "passed" | "failed" | "errored" | "skipped" | "unknown"

export interface EvidenceArtifactDigestInput {
  algorithm?: string
  value?: string
}

export interface ReviewerSafeArtifactRefInput {
  path: string
  kind: string
  label?: string
  contentType?: string
  digest?: string | ArtifactFileDigest | EvidenceArtifactDigestInput
  publicUrl?: string
  metadata?: Record<string, unknown>
}

export interface ReviewerSafeArtifactRef {
  path: string
  kind: string
  label?: string
  contentType?: string
  digest?: ArtifactFileDigest
  publicUrl?: string
  metadata?: Record<string, unknown>
}

export interface BrowserEvidenceCaptureInput {
  id: string
  status?: string
  url?: string
  finalUrl?: string
  title?: string
  summary?: string
  startedAt?: string | Date
  completedAt?: string | Date
  artifacts?: ReviewerSafeArtifactRefInput[]
  metadata?: Record<string, unknown>
}

export interface BrowserEvidenceCapture {
  schema: typeof BROWSER_EVIDENCE_CAPTURE_SCHEMA
  id: string
  status: EvidenceCaptureStatus
  url?: string
  finalUrl?: string
  title?: string
  summary?: string
  startedAt?: string
  completedAt?: string
  artifacts: ReviewerSafeArtifactRef[]
  metadata?: Record<string, unknown>
}

export interface EvidenceArtifactEnvelopeInput {
  id: string
  subject?: {
    kind: string
    id?: string
    label?: string
  }
  status?: string
  summary?: string
  createdAt?: string | Date
  artifacts?: ReviewerSafeArtifactRefInput[]
  browserCaptures?: BrowserEvidenceCaptureInput[]
  metadata?: Record<string, unknown>
}

export interface EvidenceArtifactEnvelope {
  schema: typeof EVIDENCE_ARTIFACT_ENVELOPE_SCHEMA
  id: string
  subject?: {
    kind: string
    id?: string
    label?: string
  }
  status: EvidenceCaptureStatus
  summary?: string
  createdAt: string
  artifacts: ReviewerSafeArtifactRef[]
  browserCaptures: BrowserEvidenceCapture[]
  metadata?: Record<string, unknown>
}

export interface EvidenceArtifactEnvelopeValidationResult {
  valid: boolean
  errors: string[]
}

export function reviewerSafeArtifactRef(input: ReviewerSafeArtifactRefInput, storage?: RuntimeArtifactStorageDescriptor): ReviewerSafeArtifactRef {
  const path = safeArtifactRelativePath(input.path)
  const kind = stringValue(input.kind)
  if (!kind) {
    throw new Error("Evidence artifact ref kind is required")
  }

  const publicUrl = normalizeReviewerSafePublicUrl(input.publicUrl ?? (storage ? artifactStoragePublicUrl(storage, path) : undefined))
  return stripUndefined({
    path,
    kind,
    label: optionalString(input.label),
    contentType: optionalString(input.contentType),
    digest: normalizeEvidenceArtifactDigest(input.digest),
    publicUrl,
    metadata: metadataRecord(input.metadata),
  })
}

export function browserEvidenceCapture(input: BrowserEvidenceCaptureInput, storage?: RuntimeArtifactStorageDescriptor): BrowserEvidenceCapture {
  const id = stringValue(input.id)
  if (!id) {
    throw new Error("Browser evidence capture id is required")
  }

  return stripUndefined({
    schema: BROWSER_EVIDENCE_CAPTURE_SCHEMA,
    id,
    status: normalizeEvidenceStatus(input.status),
    url: optionalString(input.url),
    finalUrl: optionalString(input.finalUrl),
    title: optionalString(input.title),
    summary: optionalString(input.summary),
    startedAt: optionalIsoDate(input.startedAt),
    completedAt: optionalIsoDate(input.completedAt),
    artifacts: (input.artifacts ?? []).map((artifact) => reviewerSafeArtifactRef(artifact, storage)),
    metadata: metadataRecord(input.metadata),
  })
}

export function evidenceArtifactEnvelope(input: EvidenceArtifactEnvelopeInput, storage?: RuntimeArtifactStorageDescriptor): EvidenceArtifactEnvelope {
  const id = stringValue(input.id)
  if (!id) {
    throw new Error("Evidence artifact envelope id is required")
  }

  return stripUndefined({
    schema: EVIDENCE_ARTIFACT_ENVELOPE_SCHEMA,
    id,
    subject: normalizeEvidenceSubject(input.subject),
    status: normalizeEvidenceStatus(input.status),
    summary: optionalString(input.summary),
    createdAt: optionalIsoDate(input.createdAt) ?? new Date().toISOString(),
    artifacts: (input.artifacts ?? []).map((artifact) => reviewerSafeArtifactRef(artifact, storage)),
    browserCaptures: (input.browserCaptures ?? []).map((capture) => browserEvidenceCapture(capture, storage)),
    metadata: metadataRecord(input.metadata),
  })
}

export function validateEvidenceArtifactEnvelope(value: unknown): EvidenceArtifactEnvelopeValidationResult {
  const errors: string[] = []
  if (!isPlainObject(value)) {
    return { valid: false, errors: ["Envelope must be an object"] }
  }

  if (value.schema !== EVIDENCE_ARTIFACT_ENVELOPE_SCHEMA) errors.push("Envelope schema must be wp-codebox/evidence-artifact-envelope/v1")
  if (!stringValue(value.id)) errors.push("Envelope id is required")
  if (!isIsoDateString(value.createdAt)) errors.push("Envelope createdAt must be an ISO date string")
  if (!EVIDENCE_CAPTURE_STATUSES.has(stringValue(value.status))) errors.push("Envelope status is invalid")

  validateArtifactRefs(value.artifacts, "artifacts", errors)

  if (!Array.isArray(value.browserCaptures)) {
    errors.push("browserCaptures must be an array")
  } else {
    for (const [index, capture] of value.browserCaptures.entries()) {
      validateBrowserCapture(capture, `browserCaptures[${index}]`, errors)
    }
  }

  return { valid: errors.length === 0, errors }
}

function validateBrowserCapture(value: unknown, prefix: string, errors: string[]): void {
  if (!isPlainObject(value)) {
    errors.push(`${prefix} must be an object`)
    return
  }
  if (value.schema !== BROWSER_EVIDENCE_CAPTURE_SCHEMA) errors.push(`${prefix}.schema must be wp-codebox/browser-evidence-capture/v1`)
  if (!stringValue(value.id)) errors.push(`${prefix}.id is required`)
  if (!EVIDENCE_CAPTURE_STATUSES.has(stringValue(value.status))) errors.push(`${prefix}.status is invalid`)
  if (value.startedAt !== undefined && !isIsoDateString(value.startedAt)) errors.push(`${prefix}.startedAt must be an ISO date string`)
  if (value.completedAt !== undefined && !isIsoDateString(value.completedAt)) errors.push(`${prefix}.completedAt must be an ISO date string`)
  validateArtifactRefs(value.artifacts, `${prefix}.artifacts`, errors)
}

function validateArtifactRefs(value: unknown, prefix: string, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push(`${prefix} must be an array`)
    return
  }
  for (const [index, artifact] of value.entries()) {
    if (!isPlainObject(artifact)) {
      errors.push(`${prefix}[${index}] must be an object`)
      continue
    }
    try {
      safeArtifactRelativePath(String(artifact.path ?? ""))
    } catch (error) {
      errors.push(`${prefix}[${index}].path ${error instanceof Error ? error.message : "is invalid"}`)
    }
    if (!stringValue(artifact.kind)) errors.push(`${prefix}[${index}].kind is required`)
    try {
      normalizeReviewerSafePublicUrl(typeof artifact.publicUrl === "string" ? artifact.publicUrl : undefined)
    } catch (error) {
      errors.push(`${prefix}[${index}].publicUrl ${error instanceof Error ? error.message : "is invalid"}`)
    }
  }
}

function normalizeEvidenceSubject(subject: EvidenceArtifactEnvelopeInput["subject"]): EvidenceArtifactEnvelope["subject"] | undefined {
  if (!subject) return undefined
  const kind = stringValue(subject.kind)
  if (!kind) {
    throw new Error("Evidence artifact envelope subject kind is required")
  }
  return stripUndefined({ kind, id: optionalString(subject.id), label: optionalString(subject.label) })
}

function normalizeEvidenceStatus(status: unknown): EvidenceCaptureStatus {
  const normalized = stringValue(status)
  return EVIDENCE_CAPTURE_STATUSES.has(normalized) ? normalized as EvidenceCaptureStatus : "unknown"
}

function normalizeEvidenceArtifactDigest(input: ReviewerSafeArtifactRefInput["digest"]): ArtifactFileDigest | undefined {
  if (typeof input === "string" && input.trim()) {
    return { algorithm: "sha256", value: input.trim() }
  }
  if (!input || typeof input !== "object") {
    return undefined
  }
  if (input.algorithm === "sha256" && typeof input.value === "string" && input.value.trim()) {
    return { algorithm: "sha256", value: input.value.trim() }
  }
  return undefined
}

function normalizeReviewerSafePublicUrl(url: string | undefined): string | undefined {
  const trimmed = url?.trim()
  if (!trimmed) return undefined

  const parsed = new URL(trimmed)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("must use http:// or https://")
  }
  if (isLoopbackHost(parsed.hostname)) {
    throw new Error("must not use a loopback host")
  }
  parsed.hash = ""
  return parsed.toString()
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  return normalized === "localhost" || normalized === "::1" || /^127(?:\.\d{1,3}){3}$/.test(normalized)
}

function optionalIsoDate(value: string | Date | undefined): string | undefined {
  if (value === undefined) return undefined
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.valueOf())) {
    throw new Error("Evidence date must be a valid date")
  }
  return date.toISOString()
}

function isIsoDateString(value: unknown): boolean {
  return typeof value === "string" && !Number.isNaN(new Date(value).valueOf()) && new Date(value).toISOString() === value
}

function metadataRecord(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!value || Object.keys(value).length === 0) return undefined
  const normalized = normalizeJsonValue(value)
  return isPlainObject(normalized) ? normalized : undefined
}

function optionalString(value: unknown): string | undefined {
  const normalized = stringValue(value)
  return normalized || undefined
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}
