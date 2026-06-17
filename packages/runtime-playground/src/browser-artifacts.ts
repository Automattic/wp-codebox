import { join } from "node:path"
import { artifactManifestFile, type ArtifactManifestFile, type ArtifactManifestFileOptions, type ArtifactReviewBrowserSummary } from "@automattic/wp-codebox-core"
import type { PlaygroundPreviewProxyDiagnostics } from "./preview-server.js"
import type { Request } from "playwright"

export type BrowserArtifact = BrowserProbeArtifact | BrowserActionsArtifact | BrowserEditorOpenArtifact | BrowserEditorActionsArtifact | BrowserScenarioArtifact | BrowserVisualCompareArtifact

export type BrowserArtifactType = BrowserArtifact["artifactType"]

export interface BrowserArtifactBase {
  artifactType: "probe" | "actions" | "editor-open" | "editor-actions" | "scenario" | "visual-compare"
  requestedUrl: string
  url: string
  preview: BrowserProbePreviewRouting
  previewProxy?: PlaygroundPreviewProxyDiagnostics
  networkPolicy?: BrowserProbeNetworkPolicySummary
  localPreviewOrigin?: string
  requestedPreviewOrigin?: string
  effectivePreviewOrigin?: string
  prePageScript?: BrowserProbeScriptMetadata
  files: BrowserArtifactFiles
  summary: BrowserArtifactSummary
}

export interface BrowserProbeArtifact extends BrowserArtifactBase {
  artifactType: "probe"
  files: BrowserArtifactFiles & { summary: string }
}

export interface BrowserActionsArtifact extends BrowserArtifactBase {
  artifactType: "actions"
  files: BrowserArtifactFiles & { summary: string }
  summary: BrowserArtifactSummary & { actions: number; steps: number }
}

export interface BrowserEditorOpenArtifact extends BrowserArtifactBase {
  artifactType: "editor-open"
  files: BrowserArtifactFiles & { summary: string }
}

export interface BrowserEditorActionsArtifact extends BrowserArtifactBase {
  artifactType: "editor-actions"
  files: BrowserArtifactFiles & { summary: string }
  summary: BrowserArtifactSummary & { actions: number; steps: number }
}

export interface BrowserScenarioArtifact extends BrowserArtifactBase {
  artifactType: "scenario"
  files: BrowserArtifactFiles & { summary: string }
}

export interface BrowserVisualCompareArtifact extends BrowserArtifactBase {
  artifactType: "visual-compare"
  files: BrowserArtifactFiles & { summary: string; sourceScreenshot: string | string[]; candidateScreenshot: string | string[]; diffScreenshot: string | string[]; visualDiff: string | string[] }
  summary: BrowserArtifactSummary & { visualCompare: NonNullable<BrowserArtifactSummary["visualCompare"]> }
}

export interface BrowserArtifactFiles {
  actions?: string
  editorState?: string
  steps?: string
  checkpoints?: string
  console?: string
  errors?: string
  html?: string
  lifecycle?: string
  memory?: string
  network?: string
  waterfall?: string
  performance?: string
  review?: string
  screenshot?: string
  domSnapshots?: string[]
  sourceScreenshot?: string | string[]
  candidateScreenshot?: string | string[]
  diffScreenshot?: string | string[]
  visualDiff?: string | string[]
  visualExplanation?: string | string[]
  redirectDiagnostics?: string
  wordpressDiagnostics?: string
  summary: string
}

export interface BrowserRedirectDiagnosticsSummary {
  status: "captured" | "not-applicable"
  artifact?: string
  classification: "redirect-loop" | "redirect-chain"
  reason: string
  documentEvents: number
  redirectResponses: number
  repeatedUrls: Array<{ url: string; count: number }>
  repeatedHosts: Array<{ host: string; count: number }>
  repeatedPaths: Array<{ path: string; count: number }>
  firstUrl?: string
  lastUrl?: string
  finalAttemptedUrl?: string
  sanitizedQueryKeys: string[]
  redactedQueryKeys: string[]
}

export interface BrowserWordPressDiagnosticsSummary {
  status: "captured" | "clean" | "unavailable"
  artifact?: string
  document5xxResponses: number
  diagnostics: number
  fatalErrors: number
  classifications: string[]
}

export interface BrowserArtifactSummary {
  actions?: number
  editor?: {
    kind: string
    postId?: number
    postType?: string
    title?: string
    blockCount?: number
    storesAvailable: boolean
  }
  editorReadiness?: BrowserEditorReadinessSummary
  editorSave?: BrowserEditorSaveSummary
  editorCanvas?: BrowserEditorCanvasProbeSummary
  steps?: number
  assertions?: BrowserAssertionsSummary
  consoleMessages: number
  errors: number
  finalUrl: string
  windowLocationOrigin?: string
  htmlSnapshot: boolean
  domSnapshots?: Array<{
    screenshot: string
    snapshot: string
    step?: { index: number; name?: string; kind: string }
    elementCount: number
    capturedElements: number
    truncated: boolean
  }>
  networkPolicy?: BrowserProbeNetworkPolicySummary
  previewProxy?: PlaygroundPreviewProxyDiagnostics
  lifecycle?: BrowserProbeLifecycleSummary
  liveness?: {
    wallTimeoutMs?: number
    stallTimeoutMs?: number
    networkSettleTimeoutMs?: number
  }
  memory?: BrowserProbeMemorySummary
  metrics?: Record<string, number>
  networkEvents: number
  phaseMetrics?: BrowserProbePhaseMetricsArtifact
  performance?: BrowserProbePerformanceSummary
  progress?: BrowserProbeProgressSummary
  review?: BrowserProbeReviewSummary
  redirectDiagnostics?: BrowserRedirectDiagnosticsSummary
  wordpressDiagnostics?: BrowserWordPressDiagnosticsSummary
  context?: BrowserProbeContextDetails
  auth?: BrowserProbeAuthSummary
  capabilities?: BrowserProbeCapabilityDiagnostics
  replayability: BrowserProbeReplayability
  screenshot: boolean
  visualCompare?: {
    status: string
    mismatchRatio?: number
    mismatchPixels?: number
    totalPixels?: number
    dimensionMismatch?: boolean
    explanation?: string
  }
  scriptResult?: unknown
  viewport: BrowserProbeViewport | null
}

export interface BrowserEditorReadinessSummary {
  schema: "wp-codebox/editor-readiness/v1"
  status: "ready"
  storesAvailable: true
  canSave: boolean
  postId?: number
  postType?: string
}

export interface BrowserEditorSaveSummary {
  schema: "wp-codebox/editor-save/v1"
  status: "saved"
  method: "core/editor.savePost"
  postId?: number
  postType?: string
  markerPresent?: boolean
  contentSha256?: string
}

export interface BrowserProbeAuthSummary {
  mode: "wordpress-admin" | "storage-state"
  userId?: number
  cookieCount: number
  cookieHosts: Array<{ host: string; cookieCount: number }>
  storageState?: {
    status: "ready" | "unsupported" | "error"
    source: "inline" | "file"
    schema?: string
    kind?: string
    cookieCount: number
    cookieHosts: Array<{ host: string; cookieCount: number }>
    originCount: number
    diagnostics: Array<{ code: string; severity: "error" | "warning" | "info"; message: string; details?: Record<string, unknown> }>
  }
}

export interface BrowserEditorCanvasProbeSummary {
  ready: boolean
  readyMs: number | null
  iframeSelector: string
  layoutSelector: string
  blockSelector: string
  diagnostics: BrowserEditorCanvasProbeDiagnostic[]
  selectorSummary: BrowserEditorCanvasSelectorSummary
}

export interface BrowserEditorCanvasProbeDiagnostic {
  code: "iframe-missing" | "layout-missing" | "no-blocks" | "loading-state" | "timeout" | "screenshot-failed" | "screenshot-fallback"
  severity: "error" | "warning" | "info"
  message: string
  details?: Record<string, unknown>
}

export interface BrowserEditorCanvasSelectorSummary {
  groups: BrowserEditorCanvasSelectorGroupSummary[]
  totals: {
    selector_count: number
    missing_selector_count: number
    errored_selector_count: number
    matched_selector_count: number
    visible_selector_count: number
    nonzero_bounding_box_selector_count: number
  }
}

export interface BrowserEditorCanvasSelectorGroupSummary {
  name: string
  selectors: BrowserEditorCanvasSelectorMatchSummary[]
  selector_count: number
  missing_selector_count: number
  errored_selector_count: number
  matched_selector_count: number
  visible_selector_count: number
  nonzero_bounding_box_selector_count: number
}

export interface BrowserEditorCanvasSelectorMatchSummary {
  selector: string
  count: number
  visible_count: number
  nonzero_bounding_box_count: number
  first_match: {
    visible: boolean
    boundingBox: { x: number; y: number; width: number; height: number }
    text: string
  } | null
  error: string
}

export interface BrowserProbeReviewSummary {
  schema: "wp-codebox/browser-probe-review/v1"
  version: 1
  browser: {
    name: string
    channel: string
    version: string | null
  }
  runtime: {
    node: string
    platform: string
    arch: string
  }
  profile: {
    viewport: BrowserProbeViewport | null
    userAgent: string | null
    throttle: string | null
    waitFor: string
    durationMs: number
  }
  timings: {
    startedAt: string
    finishedAt: string
    totalDurationMs: BrowserProbeMeasuredMetric
    navigation: BrowserProbeNavigationTimingSummary
    ttfbMs: BrowserProbeMeasuredMetric
    firstContentfulPaintMs: BrowserProbeMeasuredMetric
    largestContentfulPaintMs: BrowserProbeMeasuredMetric
    loadEventMs: BrowserProbeMeasuredMetric
  }
  lcp: {
    status: "available" | "missing"
    reason?: string
    element: string | null
    size: number | null
    url: string | null
  }
  errors: {
    console: BrowserProbeIssueSummary
    page: BrowserProbeIssueSummary
    probe: BrowserProbeIssueSummary
  }
  network: BrowserProbeNetworkReviewSummary
  redirectDiagnostics?: BrowserRedirectDiagnosticsSummary
  wordpressDiagnostics?: BrowserWordPressDiagnosticsSummary
  milestones: BrowserProbeMilestoneSummary
  artifacts: Record<string, BrowserProbeArtifactRef>
}

export interface BrowserProbeMeasuredMetric {
  status: "available" | "missing"
  value: number | null
  unit: "ms"
  reason?: string
}

export interface BrowserProbeIssueSummary {
  count: number
  status: "ok" | "issues" | "not-captured"
  artifact?: string
}

export interface BrowserProbeNetworkReviewSummary {
  status: "captured" | "not-captured"
  events: number
  responses: number
  failures: number
  byHost: Record<string, BrowserProbeNetworkCountSummary>
  byType: Record<string, BrowserProbeNetworkCountSummary>
  waterfall?: BrowserProbeArtifactRef
}

export interface BrowserProbeNetworkCountSummary {
  requests: number
  responses: number
  failures: number
  transferSizeBytes: number
}

export interface BrowserProbeMilestoneSummary {
  status: "captured" | "not-captured"
  count: number
  names: string[]
  artifact?: string
}

export interface BrowserProbeArtifactRef {
  path: string
  kind: "json" | "jsonl" | "html" | "png"
  sha256?: string
}

export interface BrowserProbeCapabilityDiagnostics {
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
  permissions: Record<string, BrowserProbePermissionState>
}

export interface BrowserProbePermissionState {
  state: "granted" | "denied" | "prompt" | "unsupported" | "error"
}

export type BrowserProbePreviewMode = "local" | "public" | "secure"

export interface BrowserProbePreviewRouting {
  requestedMode: BrowserProbePreviewMode
  effectiveMode: BrowserProbePreviewMode
  localOrigin: string
  effectiveOrigin: string
  publicOrigin?: string
  secureContext?: boolean
  diagnostics: BrowserProbePreviewDiagnostic[]
}

export interface BrowserProbePreviewDiagnostic {
  code: string
  severity: "error" | "warning" | "info"
  message: string
  details?: Record<string, unknown>
}

export interface BrowserProbeNetworkPolicySummary {
  mode: "allow" | "block" | "record"
  allowHosts: string[]
  blockHosts: string[]
  routeHosts: string[]
  recordExternal: boolean
  externalRequests: number
  blockedRequests: number
  hosts: Record<string, {
    requests: number
    external: boolean
    blocked: number
    routed: number
  }>
}

export interface BrowserProbeContextDetails {
  requested: {
    browser?: string
    device?: string
    locale?: string
    permissions?: string[]
    profile?: string
    throttle?: string
    timezone?: string
    userAgent?: string
    viewport?: {
      width: number
      height: number
    }
  }
  effective: {
    browser?: string
    device?: string
    locale?: string
    permissions?: string[]
    profile?: string
    throttle?: string
    timezone?: string
    userAgent?: string
    viewport: BrowserProbeViewport | null
  }
}

export interface BrowserProbeProgressSummary {
  status: "active" | "failed" | "stalled"
  startedAt: string
  lastProgressAt: string
  lastProgressSource: BrowserProbeProgressSource
  idleMs: number
  stallTimeoutMs?: number
  terminalFailure?: BrowserProbeTerminalFailure
}

export type BrowserProbeProgressSource = "navigation" | "network" | "console" | "pageerror" | "checkpoint" | "script" | "duration" | "probe-error"

export interface BrowserProbeTerminalFailure {
  message: string
  reason?: string
  details?: unknown
  timestamp: string
}

export interface BrowserProbeScriptMetadata {
  sha256: string
  bytes: number
}

export interface BrowserAssertionsSummary {
  total: number
  passed: number
  failed: number
  advisoryFailed?: number
  fatalFailed?: number
  results: BrowserStepAssertion[]
}

export interface BrowserProbeMetricDigest {
  final: number | null
  peak: number | null
}

export interface BrowserProbeMemorySummary {
  usedJSHeapSize: BrowserProbeMetricDigest
  totalJSHeapSize: BrowserProbeMetricDigest
  jsHeapSizeLimit: number | null
  domNodes: BrowserProbeMetricDigest
  documents: BrowserProbeMetricDigest
  jsEventListeners: BrowserProbeMetricDigest
}

export interface BrowserProbeLifecycleMetric {
  selector: string
  first_seen_ms: number | null
  first_visible_ms: number | null
  first_child_ms: number | null
  first_iframe_ms: number | null
  first_visible_iframe_ms: number | null
  first_button_ms: number | null
  first_visible_button_ms: number | null
  stable_visible_ms: number | null
  removed_count: number
  peak_child_count: number
  peak_iframe_count: number
  peak_visible_iframe_count: number
  peak_button_count: number
  peak_visible_button_count: number
  final_child_count: number
  final_iframe_count: number
  final_visible_iframe_count: number
  final_button_count: number
  final_visible_button_count: number
}

export interface BrowserProbeLifecycleSummary {
  schema: "wp-codebox/browser-lifecycle/v1"
  version: 1
  startedAtMs: number
  selectors: Record<string, BrowserProbeLifecycleMetric>
}

export interface BrowserProbeLifecycleArtifact {
  schema: "wp-codebox/browser-lifecycle/v1"
  version: 1
  capturedAt: string
  startedAtMs: number
  selectors: Record<string, BrowserProbeLifecycleMetric>
}

export interface BrowserProbePerformanceSummary {
  navigation: BrowserProbeNavigationTimingSummary
  paint: BrowserProbePaintTimingSummary
  resources: number
  transferSizeBytes: number
  encodedBodySizeBytes: number
  decodedBodySizeBytes: number
  longTasks: number
  longTaskDurationMs: number
  layoutShifts: BrowserProbeLayoutShiftSummary
  domNodes: BrowserProbeMetricDigest
  cdpMetrics: Record<string, BrowserProbeMetricDigest>
}

export interface BrowserProbeNavigationTimingSummary {
  type: string | null
  redirectCount: number
  durationMs: number | null
  domContentLoadedMs: number | null
  loadEventMs: number | null
  responseStartMs: number | null
  responseEndMs: number | null
  requestStartMs: number | null
  ttfbMs: number | null
  redirectMs: number | null
}

export interface BrowserProbePaintTimingSummary {
  firstPaintMs: number | null
  firstContentfulPaintMs: number | null
  largestContentfulPaintMs: number | null
  largestContentfulPaintSize: number | null
  largestContentfulPaintElement: string | null
  largestContentfulPaintUrl: string | null
}

export interface BrowserProbeLayoutShiftSummary {
  cls: number
  count: number
  totalCount: number
  max: number
}

export interface BrowserProbeLayoutShiftSourceRecord {
  selector: string | null
  node: string | null
  previousRect: Record<string, number | null>
  currentRect: Record<string, number | null>
}

export interface BrowserProbeLayoutShiftRecord {
  name: string
  startTime: number
  duration: number
  value: number
  hadRecentInput: boolean
  sources: BrowserProbeLayoutShiftSourceRecord[]
}

export interface BrowserProbeCheckpointRecord {
  schema: "wp-codebox/browser-checkpoint/v1"
  name: string
  metadata?: unknown
  timestamp: string
  metrics: BrowserProbeMetricsSnapshot
}

export interface BrowserProbeMetricsSnapshot {
  timestamp: string
  memory: {
    performanceMemory: {
      usedJSHeapSize: number | null
      totalJSHeapSize: number | null
      jsHeapSizeLimit: number | null
    }
    cdpHeap: {
      usedSize: number | null
      totalSize: number | null
    }
    domCounters: {
      documents: number | null
      nodes: number | null
      jsEventListeners: number | null
    }
  }
  performance: {
    cdpMetrics: Record<string, number>
    navigation: BrowserProbeNavigationTimingSummary
    paint: BrowserProbePaintTimingSummary
    dom: {
      nodes: number
      documents: number
      iframes: number
    }
    resources: {
      count: number
      transferSizeBytes: number
      encodedBodySizeBytes: number
      decodedBodySizeBytes: number
    }
    longTasks: {
      count: number
      totalDurationMs: number
      maxDurationMs: number
    }
    layoutShifts: BrowserProbeLayoutShiftSummary & {
      entries: BrowserProbeLayoutShiftRecord[]
    }
  }
}

export interface BrowserProbeMemoryArtifact {
  schema: "wp-codebox/browser-memory/v1"
  version: 1
  capturedAt: string
  final: BrowserProbeMetricsSnapshot["memory"]
  peak: BrowserProbeMemorySummary
  checkpoints: BrowserProbeCheckpointRecord[]
}

export interface BrowserProbePerformanceArtifact {
  schema: "wp-codebox/browser-performance/v1"
  version: 1
  capturedAt: string
  final: BrowserProbeMetricsSnapshot["performance"]
  peak: BrowserProbePerformanceSummary
  phaseMetrics?: BrowserProbePhaseMetricsArtifact
  checkpoints: BrowserProbeCheckpointRecord[]
}

export interface BrowserProbePhaseMetricsArtifact {
  schema: "wp-codebox/browser-phase-metrics/v1"
  version: 1
  capturedAt: string
  phases: BrowserProbePhaseMetric[]
}

export interface BrowserProbePhaseMetric {
  name: string
  checkpoint: string
  timestamp: string
  elapsedMs: number | null
  network: {
    requests: number
    responses: number
    failures: number
    transferSizeBytes: number
    responseBodySizeBytes: number
    firstRequest: BrowserProbePhaseFirstRequest | null
    firstRequestByHost: Record<string, BrowserProbePhaseFirstRequest>
  }
  errors: {
    console: number
    page: number
    probe: number
  }
  performance: {
    resources: number
    transferSizeBytes: number
    domNodes: number
    firstContentfulPaintMs: number | null
    largestContentfulPaintMs: number | null
  }
}

export interface BrowserProbePhaseFirstRequest {
  url: string
  host: string
  method: string
  resourceType: string
  timestamp: string
  elapsedMs: number | null
  status?: number
}

export interface BrowserProbeViewport {
  width: number
  height: number
  deviceScaleFactor: number
  isMobile: boolean
  hasTouch: boolean
  userAgent: string
}

export type BrowserProbeReplayability = "artifact-backed" | "partial" | "diagnostic-only"

export interface BrowserStepRecord {
  index: number
  kind: string
  status: "ok" | "failed"
  startedAt: string
  finishedAt: string
  durationMs: number
  url?: string
  selector?: string
  text?: string
  key?: string
  waitFor?: string
  duration?: string
  /** Machine-readable assertion outcome for expect/evaluate steps. */
  assertion?: BrowserStepAssertion
  readiness?: BrowserStepReadiness
  target?: BrowserStepScreenshotTarget
  screenshot?: string
  screenshotFallback?: BrowserStepScreenshotFallback
  finalUrl?: string
  error?: BrowserProbeErrorRecord
}

export interface BrowserStepScreenshotFallback {
  mode: "page-screenshot"
  reason: string
}

export interface BrowserStepScreenshotTarget {
  mode: "frame-selector" | "frame-url"
  selector?: string
  urlFragment?: string
  frameUrl?: string
}

export interface BrowserStepReadiness {
  mode: "page" | "frame-selector" | "frame-url"
  selector?: string
  urlFragment?: string
  ready: boolean
  waitedMs: number
  visibleElementCount: number
  textLength: number
  frameUrl?: string
}

export interface BrowserStepAssertion {
  kind: "expect" | "evaluate" | "probe"
  id?: string
  status?: "pass" | "fail" | "warn" | "skipped"
  assertion?: string
  advisory?: boolean
  message?: string
  selector?: string
  frameSelector?: string
  frameTarget?: BrowserStepAssertionFrameTarget
  frameUrl?: string
  name?: string
  state?: string
  expression?: string
  operator?: string
  expected?: unknown
  expectedBudget?: unknown
  actual?: unknown
  observed?: unknown
  supportingArtifacts?: string[]
  passed: boolean
}

export interface BrowserStepAssertionFrameTarget {
  kind: "selector" | "url"
  value: string
  status: "resolved"
  url: string
}

export interface BrowserProbeErrorRecord {
  type: "pageerror" | "probe-error"
  name: string
  message: string
  stack?: string
  timestamp: string
}

export interface BrowserProbeNetworkRecord {
  type: "response" | "requestfailed"
  url: string
  method: string
  resourceType: string
  timestamp: string
  status?: number
  statusText?: string
  ok?: boolean
  contentType?: string | null
  timing?: Record<string, number>
  sizes?: BrowserProbeNetworkSizes
  transferSize?: number
  bodySize?: number
  requestBodySize?: number
  responseBodySize?: number
  responseTextPreview?: string
  responseTextSha256?: string
  responseTextTruncated?: boolean
  failure?: ReturnType<Request["failure"]>
}

export interface BrowserProbeWaterfallArtifact {
  schema: "wp-codebox/browser-waterfall/v1"
  version: 1
  capturedAt: string
  startedAt: string
  summary: {
    requests: number
    responses: number
    failures: number
    transferSizeBytes: number
  }
  log: {
    version: "1.2"
    creator: { name: "wp-codebox"; version: "1" }
    entries: BrowserProbeWaterfallEntry[]
  }
}

export interface BrowserProbeWaterfallEntry {
  startedDateTime: string
  time: number
  request: {
    method: string
    url: string
  }
  response: {
    status: number
    statusText: string
    content: { mimeType: string }
    redirectURL: string
  }
  cache: Record<string, never>
  timings: {
    blocked: number
    dns: number
    connect: number
    ssl: number
    send: number
    wait: number
    receive: number
  }
  _wpCodebox: {
    type: BrowserProbeNetworkRecord["type"]
    resourceType: string
    timestamp: string
    ok?: boolean
    transferSize?: number
    requestBodySize?: number
    responseBodySize?: number
    failure?: BrowserProbeNetworkRecord["failure"]
  }
}

export interface BrowserProbeNetworkSizes {
  requestBodySize: number
  requestHeadersSize: number
  responseBodySize: number
  responseHeadersSize: number
}

export function browserReviewSummary(probes: BrowserArtifact[]): ArtifactReviewBrowserSummary | undefined {
  if (probes.length === 0) {
    return undefined
  }

  const consoleMessages = probes.reduce((total, probe) => total + probe.summary.consoleMessages, 0)
  const errors = probes.reduce((total, probe) => total + probe.summary.errors, 0)
  const screenshots = probes.filter((probe) => probe.summary.screenshot).length
  const actions = probes.reduce((total, probe) => total + (probe.summary.actions ?? 0), 0)
  return {
    summary: `Browser evidence captured ${actions} action${actions === 1 ? "" : "s"}, ${consoleMessages} console message${consoleMessages === 1 ? "" : "s"}, ${errors} error${errors === 1 ? "" : "s"}, and ${screenshots} screenshot${screenshots === 1 ? "" : "s"}.`,
    probes: probes.map((probe) => ({
      url: probe.url,
      requestedUrl: probe.requestedUrl,
      preview: probe.preview,
      localPreviewOrigin: probe.localPreviewOrigin,
      requestedPreviewOrigin: probe.requestedPreviewOrigin,
      effectivePreviewOrigin: probe.effectivePreviewOrigin,
      finalUrl: probe.summary.finalUrl,
      windowLocationOrigin: probe.summary.windowLocationOrigin,
      viewport: probe.summary.viewport,
      capabilities: probe.summary.capabilities,
      replayability: probe.summary.replayability,
      consoleMessages: probe.summary.consoleMessages,
      errors: probe.summary.errors,
      html: probe.files.html,
      lifecycle: probe.files.lifecycle,
      network: probe.files.network,
      waterfall: probe.files.waterfall,
      networkEvents: probe.summary.networkEvents,
      screenshot: probe.files.screenshot,
      domSnapshots: probe.files.domSnapshots,
      console: probe.files.console,
      checkpoints: probe.files.checkpoints,
      errorsFile: probe.files.errors,
      editorState: probe.files.editorState,
      memory: probe.files.memory,
      review: probe.files.review,
      actions: probe.files.steps ?? probe.files.actions,
      actionCount: probe.summary.steps ?? probe.summary.actions,
      steps: probe.files.steps,
      stepCount: probe.summary.steps,
      ...(probe.summary.assertions ? { assertions: { total: probe.summary.assertions.total, passed: probe.summary.assertions.passed, failed: probe.summary.assertions.failed } } : {}),
      performance: probe.files.performance,
      visualCompare: probe.summary.visualCompare,
      redirectDiagnostics: probe.summary.redirectDiagnostics,
      wordpressDiagnostics: probe.summary.wordpressDiagnostics,
      summaryFile: probe.files.summary,
    })),
  }
}

export function browserManifestFiles(artifactRoot: string, probes: BrowserArtifact[]): ArtifactManifestFile[] {
  if (probes.length === 0) {
    return []
  }

  const files = new Map<string, BrowserArtifactFileManifestEntry>()
  for (const probe of probes) {
    for (const file of browserArtifactFileEntries(probe)) {
      files.set(file.path, file.manifest)
    }
  }

  return [...files.entries()].map(([path, entry]) => artifactManifestFile(join(artifactRoot, path), entry.kind, entry.contentType))
}

export function browserRedactionPaths(probe: BrowserArtifact): string[] {
  return browserArtifactFileEntries(probe)
    .filter((file) => file.manifest.redact)
    .map((file) => file.path)
}

interface BrowserArtifactFileManifestEntry {
  kind: string
  contentType: string
  redact: boolean
}

export interface BrowserArtifactFileManifestMetadata {
  kind: string
  contentType: string
  redaction?: ArtifactManifestFileOptions["redaction"]
}

const BROWSER_ARTIFACT_FILE_MANIFEST: Record<keyof BrowserArtifactFiles, BrowserArtifactFileManifestEntry> = {
  actions: { kind: "browser-actions", contentType: "application/x-ndjson", redact: true },
  editorState: { kind: "browser-editor-state", contentType: "application/json", redact: true },
  steps: { kind: "browser-steps", contentType: "application/x-ndjson", redact: true },
  checkpoints: { kind: "browser-checkpoints", contentType: "application/x-ndjson", redact: true },
  console: { kind: "browser-console", contentType: "application/x-ndjson", redact: true },
  errors: { kind: "browser-errors", contentType: "application/x-ndjson", redact: true },
  html: { kind: "browser-html-snapshot", contentType: "text/html; charset=utf-8", redact: true },
  lifecycle: { kind: "browser-lifecycle", contentType: "application/json", redact: true },
  memory: { kind: "browser-memory", contentType: "application/json", redact: true },
  network: { kind: "browser-network", contentType: "application/x-ndjson", redact: true },
  waterfall: { kind: "browser-waterfall", contentType: "application/json", redact: true },
  performance: { kind: "browser-performance", contentType: "application/json", redact: true },
  review: { kind: "browser-review", contentType: "application/json", redact: true },
  screenshot: { kind: "browser-screenshot", contentType: "image/png", redact: false },
  domSnapshots: { kind: "browser-dom-snapshot", contentType: "application/json", redact: true },
  sourceScreenshot: { kind: "browser-visual-source-screenshot", contentType: "image/png", redact: false },
  candidateScreenshot: { kind: "browser-visual-candidate-screenshot", contentType: "image/png", redact: false },
  diffScreenshot: { kind: "browser-visual-diff-screenshot", contentType: "image/png", redact: false },
  visualDiff: { kind: "browser-visual-diff", contentType: "application/json", redact: true },
  visualExplanation: { kind: "browser-visual-explanation", contentType: "application/json", redact: true },
  redirectDiagnostics: { kind: "browser-redirect-diagnostics", contentType: "application/json", redact: true },
  wordpressDiagnostics: { kind: "browser-wordpress-diagnostics", contentType: "application/json", redact: true },
  summary: { kind: "browser-summary", contentType: "application/json", redact: true },
}

export function browserArtifactFileManifest(key: keyof BrowserArtifactFiles): BrowserArtifactFileManifestMetadata {
  const entry = BROWSER_ARTIFACT_FILE_MANIFEST[key]
  return {
    kind: entry.kind,
    contentType: entry.contentType,
    ...(entry.redact ? { redaction: { policy: "required", sensitive: true, reason: "Browser artifacts can include page content, URLs, user data, headers, or runtime diagnostics." } } : { redaction: { policy: "none", sensitive: false } }),
  }
}

function browserArtifactFileEntries(probe: BrowserArtifact): Array<{ path: string; manifest: BrowserArtifactFileManifestEntry }> {
  const entries: Array<{ path: string; manifest: BrowserArtifactFileManifestEntry }> = []
  for (const [key, manifest] of Object.entries(BROWSER_ARTIFACT_FILE_MANIFEST) as Array<[keyof BrowserArtifactFiles, BrowserArtifactFileManifestEntry]>) {
    const value = probe.files[key]
    if (Array.isArray(value)) {
      entries.push(...value.map((path) => ({ path, manifest })))
    } else if (typeof value === "string" && value.length > 0) {
      entries.push({ path: value, manifest })
    }
  }
  return entries
}
