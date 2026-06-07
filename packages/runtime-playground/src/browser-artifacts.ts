import { join } from "node:path"
import { artifactManifestFile, type ArtifactManifestFile, type ArtifactReviewBrowserSummary } from "@automattic/wp-codebox-core"
import type { Request } from "playwright"

export interface BrowserProbeArtifact {
  requestedUrl: string
  url: string
  preview: BrowserProbePreviewRouting
  networkPolicy?: BrowserProbeNetworkPolicySummary
  localPreviewOrigin?: string
  requestedPreviewOrigin?: string
  effectivePreviewOrigin?: string
  prePageScript?: BrowserProbeScriptMetadata
  files: {
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
    performance?: string
    review?: string
    screenshot?: string
    sourceScreenshot?: string
    candidateScreenshot?: string
    diffScreenshot?: string
    visualDiff?: string
    summary: string
  }
  summary: {
    actions?: number
    editor?: {
      kind: string
      postId?: number
      postType?: string
      title?: string
      blockCount?: number
      storesAvailable: boolean
    }
    editorCanvas?: BrowserEditorCanvasProbeSummary
    steps?: number
    assertions?: BrowserAssertionsSummary
    consoleMessages: number
    errors: number
    finalUrl: string
    windowLocationOrigin?: string
    htmlSnapshot: boolean
    networkPolicy?: BrowserProbeNetworkPolicySummary
    lifecycle?: BrowserProbeLifecycleSummary
    memory?: BrowserProbeMemorySummary
    metrics?: Record<string, number>
    networkEvents: number
    performance?: BrowserProbePerformanceSummary
    progress?: BrowserProbeProgressSummary
    review?: BrowserProbeReviewSummary
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
    }
    scriptResult?: unknown
    viewport: BrowserProbeViewport | null
  }
}

export interface BrowserProbeAuthSummary {
  mode: "wordpress-admin"
  userId: number
  cookieCount: number
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
  code: "iframe-missing" | "layout-missing" | "no-blocks" | "loading-state" | "timeout" | "screenshot-failed"
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
  checkpoints: BrowserProbeCheckpointRecord[]
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
  screenshot?: string
  finalUrl?: string
  error?: BrowserProbeErrorRecord
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
  failure?: ReturnType<Request["failure"]>
}

export interface BrowserProbeNetworkSizes {
  requestBodySize: number
  requestHeadersSize: number
  responseBodySize: number
  responseHeadersSize: number
}

export function browserReviewSummary(probes: BrowserProbeArtifact[]): ArtifactReviewBrowserSummary | undefined {
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
      networkEvents: probe.summary.networkEvents,
      screenshot: probe.files.screenshot,
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
      summaryFile: probe.files.summary,
    })),
  }
}

export function browserManifestFiles(artifactRoot: string, probes: BrowserProbeArtifact[]): ArtifactManifestFile[] {
  if (probes.length === 0) {
    return []
  }

  const files = new Map<string, { kind: string; contentType: string }>()
  for (const probe of probes) {
    if (probe.files.steps) {
      files.set(probe.files.steps, { kind: "browser-steps", contentType: "application/x-ndjson" })
    }
    if (probe.files.actions) {
      files.set(probe.files.actions, { kind: "browser-actions", contentType: "application/x-ndjson" })
    }
    if (probe.files.editorState) {
      files.set(probe.files.editorState, { kind: "browser-editor-state", contentType: "application/json" })
    }
    if (probe.files.console) {
      files.set(probe.files.console, { kind: "browser-console", contentType: "application/x-ndjson" })
    }
    if (probe.files.checkpoints) {
      files.set(probe.files.checkpoints, { kind: "browser-checkpoints", contentType: "application/x-ndjson" })
    }
    if (probe.files.errors) {
      files.set(probe.files.errors, { kind: "browser-errors", contentType: "application/x-ndjson" })
    }
    if (probe.files.html) {
      files.set(probe.files.html, { kind: "browser-html-snapshot", contentType: "text/html; charset=utf-8" })
    }
    if (probe.files.lifecycle) {
      files.set(probe.files.lifecycle, { kind: "browser-lifecycle", contentType: "application/json" })
    }
    if (probe.files.memory) {
      files.set(probe.files.memory, { kind: "browser-memory", contentType: "application/json" })
    }
    if (probe.files.network) {
      files.set(probe.files.network, { kind: "browser-network", contentType: "application/x-ndjson" })
    }
    if (probe.files.performance) {
      files.set(probe.files.performance, { kind: "browser-performance", contentType: "application/json" })
    }
    if (probe.files.review) {
      files.set(probe.files.review, { kind: "browser-review", contentType: "application/json" })
    }
    if (probe.files.screenshot) {
      files.set(probe.files.screenshot, { kind: "browser-screenshot", contentType: "image/png" })
    }
    if (probe.files.sourceScreenshot) {
      files.set(probe.files.sourceScreenshot, { kind: "browser-visual-source-screenshot", contentType: "image/png" })
    }
    if (probe.files.candidateScreenshot) {
      files.set(probe.files.candidateScreenshot, { kind: "browser-visual-candidate-screenshot", contentType: "image/png" })
    }
    if (probe.files.diffScreenshot) {
      files.set(probe.files.diffScreenshot, { kind: "browser-visual-diff-screenshot", contentType: "image/png" })
    }
    if (probe.files.visualDiff) {
      files.set(probe.files.visualDiff, { kind: "browser-visual-diff", contentType: "application/json" })
    }
    files.set(probe.files.summary, { kind: "browser-summary", contentType: "application/json" })
  }

  return [...files.entries()].map(([path, entry]) => artifactManifestFile(join(artifactRoot, path), entry.kind, entry.contentType))
}

export function browserRedactionPaths(probe: BrowserProbeArtifact): string[] {
  return [probe.files.steps, probe.files.actions, probe.files.editorState, probe.files.checkpoints, probe.files.console, probe.files.errors, probe.files.html, probe.files.lifecycle, probe.files.memory, probe.files.network, probe.files.performance, probe.files.review, probe.files.visualDiff, probe.files.summary]
    .filter((path): path is string => typeof path === "string" && path.length > 0)
}
