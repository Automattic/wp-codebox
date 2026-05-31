import type { ArtifactPreview, ArtifactProvenance } from "./runtime-contracts.js"

export * from "./artifact-manifest.js"
export * from "./runtime-contracts.js"
export * from "./runtime-policy.js"
export * from "./workspace-policy.js"
export * from "./sandbox-datamachine-tool-policy.js"
export * from "./command-registry.js"
export * from "./task-input.js"
export * from "./browser-interaction.js"
export * from "./recipe-schema.js"
export * from "./runtime-episode.js"
export * from "./runtime-reference.js"
export * from "./object-utils.js"
export * from "./runtime-action-adapter.js"
export * from "./artifact-bundle-verifier.js"

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
    patch: string
    patchSha256: string
    artifactContentDigest: string
    changedFiles: string
    testResults?: string
    runtimeEpisodeTrace?: string
    runtimeReferenceManifest?: string
    runtimeReplayReferenceIndex?: string
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
    finalUrl?: string
    viewport?: {
      width: number
      height: number
      deviceScaleFactor: number
      isMobile: boolean
      hasTouch: boolean
      userAgent: string
    } | null
    replayability?: "artifact-backed" | "partial" | "diagnostic-only"
    consoleMessages: number
    errors: number
    html?: string
    network?: string
    networkEvents?: number
    checkpoints?: string
    memory?: string
    performance?: string
    screenshot?: string
    console?: string
    errorsFile?: string
    actions?: string
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
