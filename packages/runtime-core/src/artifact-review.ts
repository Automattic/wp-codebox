import type { ArtifactPreview, ArtifactProvenance } from "./runtime-contracts.js"

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
