import { sha256StableJson } from "@automattic/wp-codebox-core/internals"
import type { ArtifactDiagnostic } from "@automattic/wp-codebox-core"
import type { CanonicalChangedFiles, MountDiff, WorkspacePatchArtifact } from "./artifacts.js"
import type { RuntimeSnapshotArtifact } from "./runtime-snapshot.js"

export const RUNTIME_CAPTURE_STATUS_SCHEMA = "wp-codebox/runtime-capture-status/v1" as const

export type RuntimeCaptureState = "clean" | "changed" | "unknown" | "unsupported"

export interface RuntimeCaptureDiagnostic {
  severity: "info" | "warning" | "error"
  code: string
  message: string
  details?: Record<string, unknown>
}

export interface RuntimeCaptureStatus {
  schema: typeof RUNTIME_CAPTURE_STATUS_SCHEMA
  version: 1
  state: RuntimeCaptureState
  snapshotDigest?: { algorithm: "sha256"; value: string }
  captureDigest?: { algorithm: "sha256"; value: string }
  resources?: {
    databaseTables?: number
    wpContentFiles?: number
  }
  changes?: {
    files: number
    added: number
    modified: number
    deleted: number
    workspaces?: number
  }
  diagnostics: RuntimeCaptureDiagnostic[]
  limitations: string[]
}

export interface RuntimeCaptureStatusInput {
  supported?: boolean
  snapshot?: RuntimeSnapshotArtifact
  workspacePatch?: Pick<WorkspacePatchArtifact, "summary" | "contentDigest" | "workspaces">
  changedFiles?: CanonicalChangedFiles
  mountDiffs?: MountDiff[]
  captureDigest?: string | { algorithm: "sha256"; value: string }
  diagnostics?: Array<RuntimeCaptureDiagnostic | ArtifactDiagnostic>
  limitations?: string[]
}

export function runtimeCaptureStatus(input: RuntimeCaptureStatusInput = {}): RuntimeCaptureStatus {
  const diagnostics = normalizeRuntimeCaptureDiagnostics(input.diagnostics ?? [])
  const limitations = [...(input.limitations ?? [])]
  const snapshotDigest = input.snapshot ? digest(input.snapshot) : undefined
  const captureDigest = normalizeDigest(input.captureDigest)
    ?? input.workspacePatch?.contentDigest
    ?? (input.changedFiles ? digest(input.changedFiles) : undefined)
    ?? snapshotDigest
  const changes = summarizeChanges(input)
  const resources = input.snapshot ? {
    databaseTables: input.snapshot.database.tables.length,
    wpContentFiles: input.snapshot.files.length,
  } : undefined

  if (input.supported === false) {
    return {
      schema: RUNTIME_CAPTURE_STATUS_SCHEMA,
      version: 1,
      state: "unsupported",
      ...(snapshotDigest ? { snapshotDigest } : {}),
      ...(captureDigest ? { captureDigest } : {}),
      ...(resources ? { resources } : {}),
      ...(changes ? { changes } : {}),
      diagnostics,
      limitations,
    }
  }

  const hasChangeEvidence = Boolean(input.workspacePatch || input.changedFiles || input.mountDiffs)
  const state: RuntimeCaptureState = hasChangeEvidence ? (changes && changes.files > 0 ? "changed" : "clean") : "unknown"

  return {
    schema: RUNTIME_CAPTURE_STATUS_SCHEMA,
    version: 1,
    state,
    ...(snapshotDigest ? { snapshotDigest } : {}),
    ...(captureDigest ? { captureDigest } : {}),
    ...(resources ? { resources } : {}),
    ...(changes ? { changes } : {}),
    diagnostics,
    limitations,
  }
}

function summarizeChanges(input: RuntimeCaptureStatusInput): RuntimeCaptureStatus["changes"] | undefined {
  if (input.workspacePatch) {
    return {
      files: input.workspacePatch.summary.files,
      added: input.workspacePatch.summary.added,
      modified: input.workspacePatch.summary.modified,
      deleted: input.workspacePatch.summary.deleted,
      workspaces: input.workspacePatch.workspaces.length,
    }
  }

  if (input.changedFiles) {
    return changedFileStats(input.changedFiles.files)
  }

  if (input.mountDiffs) {
    return {
      files: input.mountDiffs.filter((diff) => diff.changed).length,
      added: 0,
      modified: input.mountDiffs.filter((diff) => diff.changed).length,
      deleted: 0,
      workspaces: input.mountDiffs.length,
    }
  }

  return undefined
}

function changedFileStats(files: CanonicalChangedFiles["files"]): NonNullable<RuntimeCaptureStatus["changes"]> {
  return {
    files: files.length,
    added: files.filter((file) => file.status === "added").length,
    modified: files.filter((file) => file.status === "modified").length,
    deleted: files.filter((file) => file.status === "deleted").length,
  }
}

function normalizeDigest(value: RuntimeCaptureStatusInput["captureDigest"]): RuntimeCaptureStatus["captureDigest"] | undefined {
  if (!value) {
    return undefined
  }

  return typeof value === "string" ? { algorithm: "sha256", value } : value
}

function digest(value: unknown): { algorithm: "sha256"; value: string } {
  return { algorithm: "sha256", value: sha256StableJson(value) }
}

function normalizeRuntimeCaptureDiagnostics(diagnostics: Array<RuntimeCaptureDiagnostic | ArtifactDiagnostic>): RuntimeCaptureDiagnostic[] {
  return diagnostics.map((diagnostic) => ({
    severity: normalizeSeverity(diagnostic.severity),
    code: ("code" in diagnostic ? diagnostic.code : diagnostic.type) || "runtime-capture-diagnostic",
    message: diagnostic.message,
    ...(diagnostic.details ? { details: diagnostic.details as Record<string, unknown> } : {}),
  }))
}

function normalizeSeverity(severity: string): RuntimeCaptureDiagnostic["severity"] {
  return severity === "error" || severity === "warning" ? severity : "info"
}
