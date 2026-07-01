import type { PlaygroundPreviewProxyDiagnostics } from "./preview-server.js"
import type { BrowserPreviewTopology } from "./browser-preview-routing.js"
import { addBrowserProbeNetworkCount, browserProbeArtifactRefs, browserProbeWebSocketSummary, createBrowserProbeProgressTracker, now, requestHost, safeBrowserProbeUrl, sortBrowserProbeNetworkCounts } from "./browser-probe-support.js"
import { browserProbeBenchMetrics } from "./browser-metrics.js"
import { browserProbeAssertionsFromArgs, browserProbeAssertionsNeedMetrics, browserProbeAssertionsNeedNetwork, browserProbeReplayability } from "./browser-probe.js"
import type { BrowserProbeArtifact, BrowserProbeArtifactRef, BrowserProbeAuthSummary, BrowserProbeCapabilityDiagnostics, BrowserProbeCheckpointRecord, BrowserProbeContextDetails, BrowserProbeErrorRecord, BrowserProbeLifecycleArtifact, BrowserProbeMeasuredMetric, BrowserProbeMemoryArtifact, BrowserProbeNetworkCountSummary, BrowserProbeNetworkPolicySummary, BrowserProbeNetworkRecord, BrowserProbeNetworkReviewSummary, BrowserProbePerformanceArtifact, BrowserProbePreviewRouting, BrowserProbeReviewSummary, BrowserProbeScriptMetadata, BrowserProbeViewport, BrowserProbeWebSocketRecord, BrowserProbeWebSocketReviewSummary, BrowserRedirectDiagnosticsSummary, BrowserStepAssertion, BrowserWordPressDiagnosticsSummary } from "./browser-artifacts.js"

export interface BrowserProbeCaptureSelection {
  console: boolean
  errors: boolean
  network: boolean
  metrics: boolean
  consoleForAssertions: boolean
  errorsForAssertions: boolean
  networkForAssertions: boolean
}

export function browserProbeCaptureSelection(capture: Set<string>, assertions: ReturnType<typeof browserProbeAssertionsFromArgs>): BrowserProbeCaptureSelection {
  const consoleForAssertions = assertions.some((assertion) => assertion.type === "no-console-errors" || assertion.type === "no-errors")
  const errorsForAssertions = assertions.some((assertion) => assertion.type === "no-page-errors" || assertion.type === "no-errors")
  const networkForAssertions = browserProbeAssertionsNeedNetwork(assertions)
  const metricsForAssertions = browserProbeAssertionsNeedMetrics(assertions)
  return {
    console: capture.has("console") || consoleForAssertions,
    errors: capture.has("errors") || errorsForAssertions,
    network: capture.has("network") || networkForAssertions,
    metrics: capture.has("performance") || capture.has("memory") || metricsForAssertions,
    consoleForAssertions,
    errorsForAssertions,
    networkForAssertions,
  }
}

export interface BrowserProbeArtifactHashes {
  htmlSha256?: string
  screenshotSha256?: string
}

export interface BrowserProbeSessionResultInput {
  assertions: BrowserStepAssertion[]
  authSummary?: BrowserProbeAuthSummary
  browser: BrowserProbeReviewSummary["browser"]
  browserFilesDirectory: string
  capabilities?: BrowserProbeCapabilityDiagnostics
  capture: Set<string>
  captureSelection: BrowserProbeCaptureSelection
  checkpoints: BrowserProbeCheckpointRecord[]
  command: string
  consoleMessages: Record<string, unknown>[]
  context?: BrowserProbeContextDetails
  durationMs: number
  errors: BrowserProbeErrorRecord[]
  failFast: boolean
  finalUrl: string
  hashes: BrowserProbeArtifactHashes
  lifecycleArtifact?: BrowserProbeLifecycleArtifact
  lifecycleSelectors: string[]
  liveness: { wallTimeoutMs: number; stallTimeoutMs: number; networkSettleTimeoutMs: number }
  memoryArtifact?: BrowserProbeMemoryArtifact
  network: BrowserProbeNetworkRecord[]
  networkPolicySummary?: BrowserProbeNetworkPolicySummary
  performanceArtifact?: BrowserProbePerformanceArtifact
  prePageScriptMetadata?: BrowserProbeScriptMetadata
  preview: BrowserProbePreviewRouting
  previewProxyDiagnostics?: PlaygroundPreviewProxyDiagnostics
  progress: ReturnType<typeof createBrowserProbeProgressTracker>
  redirectDiagnostics?: { summary: BrowserRedirectDiagnosticsSummary }
  requestedUrl: string
  scriptResult?: unknown
  startedAt: string
  startedAtMs: number
  throttleId: string | null
  topologyOrigins: BrowserPreviewTopology["origins"]
  viewport: BrowserProbeViewport | null
  waitFor: string
  webSockets: BrowserProbeWebSocketRecord[]
  windowLocationOrigin?: string
  wordpressDiagnostics?: { summary: BrowserWordPressDiagnosticsSummary }
}

export interface BrowserProbeSessionResult {
  artifact: BrowserProbeArtifact
  output: string
  review: BrowserProbeReviewSummary
  summary: Record<string, unknown>
}

export class BrowserProbeSessionResultBuilder {
  compose(input: BrowserProbeSessionResultInput): BrowserProbeSessionResult {
    const assertionSummary = browserProbeAssertionSummary(input.assertions)
    const finishedAt = now()
    const files = browserProbeArtifactFileMap(input)
    const review = browserProbeReviewSummary({
      browser: input.browser,
      capture: input.capture,
      checkpoints: input.checkpoints,
      consoleMessages: input.consoleMessages,
      durationMs: input.durationMs,
      errors: input.errors,
      files: browserProbeArtifactRefs(input.browserFilesDirectory, input.capture, {
        checkpoints: input.checkpoints.length > 0,
        console: Boolean(files.console),
        errors: Boolean(files.errors),
        html: input.hashes.htmlSha256,
        lifecycle: Boolean(input.lifecycleArtifact),
        memory: Boolean(input.memoryArtifact),
        network: Boolean(files.network),
        waterfall: Boolean(files.waterfall),
        websocket: Boolean(files.websocket),
        performance: Boolean(input.performanceArtifact),
        redirectDiagnostics: Boolean(input.redirectDiagnostics),
        screenshot: input.hashes.screenshotSha256,
        wordpressDiagnostics: Boolean(input.wordpressDiagnostics),
      }),
      finishedAt,
      network: input.network,
      performanceArtifact: input.performanceArtifact,
      startedAt: input.startedAt,
      throttle: input.throttleId,
      totalDurationMs: Date.now() - input.startedAtMs,
      viewport: input.viewport,
      waitFor: input.waitFor,
      webSockets: input.webSockets,
      redirectDiagnostics: input.redirectDiagnostics?.summary,
      wordpressDiagnostics: input.wordpressDiagnostics?.summary,
    })
    const summary = browserProbeArtifactSummary(input, assertionSummary, review)
    const artifact: BrowserProbeArtifact = {
      artifactType: "probe",
      requestedUrl: input.requestedUrl,
      url: input.requestedUrl,
      preview: input.preview,
      ...(input.previewProxyDiagnostics ? { previewProxy: input.previewProxyDiagnostics } : {}),
      ...(input.networkPolicySummary ? { networkPolicy: input.networkPolicySummary } : {}),
      ...input.topologyOrigins,
      ...(input.prePageScriptMetadata ? { prePageScript: input.prePageScriptMetadata } : {}),
      files,
      summary,
    }
    return {
      artifact,
      review,
      summary: browserProbeSummaryArtifact(input, artifact, assertionSummary, review, finishedAt),
      output: `${JSON.stringify({
        command: input.command,
        requestedUrl: input.requestedUrl,
        preview: input.preview,
        ...(input.previewProxyDiagnostics ? { previewProxy: input.previewProxyDiagnostics } : {}),
        ...(input.networkPolicySummary ? { networkPolicy: input.networkPolicySummary } : {}),
        ...input.topologyOrigins,
        finalUrl: artifact.summary.finalUrl ?? input.requestedUrl,
        files: artifact.files,
        summary: artifact.summary,
      }, null, 2)}\n`,
    }
  }
}

function browserProbeArtifactFileMap(input: BrowserProbeSessionResultInput): BrowserProbeArtifact["files"] {
  return {
    ...(input.capture.has("console") || input.captureSelection?.consoleForAssertions ? { console: `${input.browserFilesDirectory}/console.jsonl` } : {}),
    ...(input.checkpoints.length > 0 ? { checkpoints: `${input.browserFilesDirectory}/checkpoints.jsonl` } : {}),
    ...(input.capture.has("errors") || input.captureSelection?.errorsForAssertions ? { errors: `${input.browserFilesDirectory}/errors.jsonl` } : {}),
    ...(input.hashes.htmlSha256 ? { html: `${input.browserFilesDirectory}/snapshot.html` } : {}),
    ...(input.lifecycleArtifact ? { lifecycle: `${input.browserFilesDirectory}/lifecycle.json` } : {}),
		...(input.memoryArtifact ? { memory: `${input.browserFilesDirectory}/memory.json` } : {}),
		...(input.capture.has("network") || input.captureSelection?.networkForAssertions ? { network: `${input.browserFilesDirectory}/network.jsonl` } : {}),
		...(input.capture.has("network") || input.captureSelection?.networkForAssertions ? { requestCoverage: `${input.browserFilesDirectory}/request-coverage.json` } : {}),
		...(input.capture.has("network") || input.captureSelection?.networkForAssertions ? { waterfall: `${input.browserFilesDirectory}/waterfall.json` } : {}),
    ...(input.capture.has("websocket") ? { websocket: `${input.browserFilesDirectory}/websocket.json` } : {}),
    ...(input.performanceArtifact ? { performance: `${input.browserFilesDirectory}/performance.json` } : {}),
    ...(input.redirectDiagnostics ? { redirectDiagnostics: `${input.browserFilesDirectory}/redirect-diagnostics.json` } : {}),
    review: `${input.browserFilesDirectory}/review.json`,
    ...(input.hashes.screenshotSha256 ? { screenshot: `${input.browserFilesDirectory}/screenshot.png` } : {}),
    ...(input.wordpressDiagnostics ? { wordpressDiagnostics: `${input.browserFilesDirectory}/wordpress-diagnostics.json` } : {}),
    summary: `${input.browserFilesDirectory}/summary.json`,
  }
}

function browserProbeArtifactSummary(input: BrowserProbeSessionResultInput, assertionSummary: BrowserAssertionsSummary, review: BrowserProbeReviewSummary): BrowserProbeArtifact["summary"] {
  return {
    ...(assertionSummary.total > 0 ? { assertions: assertionSummary } : {}),
    consoleMessages: input.consoleMessages.length,
    errors: input.errors.length,
    finalUrl: input.finalUrl,
    ...(input.windowLocationOrigin ? { windowLocationOrigin: input.windowLocationOrigin } : {}),
    htmlSnapshot: Boolean(input.hashes.htmlSha256),
    ...(input.previewProxyDiagnostics ? { previewProxy: input.previewProxyDiagnostics } : {}),
    ...(input.networkPolicySummary ? { networkPolicy: input.networkPolicySummary } : {}),
    ...(input.lifecycleArtifact ? { lifecycle: { schema: input.lifecycleArtifact.schema, version: input.lifecycleArtifact.version, startedAtMs: input.lifecycleArtifact.startedAtMs, selectors: input.lifecycleArtifact.selectors } } : {}),
    liveness: input.liveness,
    ...(input.memoryArtifact ? { memory: input.memoryArtifact.peak } : {}),
    ...(input.memoryArtifact || input.performanceArtifact ? { metrics: browserProbeBenchMetrics(input.memoryArtifact, input.performanceArtifact) } : {}),
    networkEvents: input.network.length,
    ...(input.capture.has("websocket") ? { webSockets: browserProbeWebSocketSummary(input.webSockets) } : {}),
    ...(input.performanceArtifact?.phaseMetrics ? { phaseMetrics: input.performanceArtifact.phaseMetrics } : {}),
    ...(input.performanceArtifact ? { performance: input.performanceArtifact.peak } : {}),
    progress: input.progress.summary(),
    review,
    ...(input.redirectDiagnostics ? { redirectDiagnostics: input.redirectDiagnostics.summary } : {}),
    ...(input.wordpressDiagnostics ? { wordpressDiagnostics: input.wordpressDiagnostics.summary } : {}),
    context: input.context,
    auth: input.authSummary,
    capabilities: input.capabilities,
    replayability: browserProbeReplayability(input.capture),
    screenshot: Boolean(input.hashes.screenshotSha256),
    ...(typeof input.scriptResult !== "undefined" ? { scriptResult: input.scriptResult } : {}),
    viewport: input.viewport,
  }
}

function browserProbeSummaryArtifact(input: BrowserProbeSessionResultInput, artifact: BrowserProbeArtifact, assertionSummary: BrowserAssertionsSummary, review: BrowserProbeReviewSummary, finishedAt: string): Record<string, unknown> {
  return {
    schema: "wp-codebox/browser-probe/v1",
    requestedUrl: input.requestedUrl,
    preview: input.preview,
    ...(input.previewProxyDiagnostics ? { previewProxy: input.previewProxyDiagnostics } : {}),
    ...(input.networkPolicySummary ? { networkPolicy: input.networkPolicySummary } : {}),
    ...input.topologyOrigins,
    finalUrl: input.finalUrl,
    ...(input.windowLocationOrigin ? { windowLocationOrigin: input.windowLocationOrigin } : {}),
    waitFor: input.waitFor,
    durationMs: input.durationMs,
    ...(input.lifecycleSelectors.length > 0 ? { observe: input.lifecycleSelectors } : {}),
    failFast: input.failFast,
    stallTimeoutMs: input.liveness.stallTimeoutMs,
    capture: [...input.capture].sort(),
    ...(assertionSummary.total > 0 ? { assertions: assertionSummary } : {}),
    ...(input.prePageScriptMetadata ? { prePageScript: input.prePageScriptMetadata } : {}),
    startedAt: input.startedAt,
    finishedAt,
    files: artifact.files,
    hashes: {
      ...(input.hashes.htmlSha256 ? { html: { algorithm: "sha256", value: input.hashes.htmlSha256 } } : {}),
      ...(input.hashes.screenshotSha256 ? { screenshot: { algorithm: "sha256", value: input.hashes.screenshotSha256 } } : {}),
    },
    context: input.context,
    auth: input.authSummary,
    capabilities: input.capabilities,
    review,
    ...(input.redirectDiagnostics ? { redirectDiagnostics: input.redirectDiagnostics.summary } : {}),
    ...(input.wordpressDiagnostics ? { wordpressDiagnostics: input.wordpressDiagnostics.summary } : {}),
    viewport: input.viewport,
    summary: artifact.summary,
  }
}

interface BrowserAssertionsSummary {
  total: number
  passed: number
  failed: number
  advisoryFailed: number
  fatalFailed: number
  results: BrowserStepAssertion[]
}

function browserProbeAssertionSummary(assertionResults: BrowserStepAssertion[]): BrowserAssertionsSummary {
  const passed = assertionResults.filter((assertion) => assertion.passed).length
  const failed = assertionResults.filter((assertion) => !assertion.passed).length
  const advisoryFailed = assertionResults.filter((assertion) => !assertion.passed && assertion.advisory).length
  return {
    total: assertionResults.length,
    passed,
    failed,
    advisoryFailed,
    fatalFailed: failed - advisoryFailed,
    results: assertionResults,
  }
}

function browserProbeReviewSummary(input: {
  browser: BrowserProbeReviewSummary["browser"]
  capture: Set<string>
  checkpoints: BrowserProbeCheckpointRecord[]
  consoleMessages: Record<string, unknown>[]
  durationMs: number
  errors: BrowserProbeErrorRecord[]
  files: Record<string, BrowserProbeArtifactRef>
  finishedAt: string
  network: BrowserProbeNetworkRecord[]
  performanceArtifact?: BrowserProbePerformanceArtifact
  startedAt: string
  throttle: string | null
  totalDurationMs: number
  viewport: BrowserProbeViewport | null
  waitFor: string
  webSockets: BrowserProbeWebSocketRecord[]
  redirectDiagnostics?: BrowserRedirectDiagnosticsSummary
  wordpressDiagnostics?: BrowserWordPressDiagnosticsSummary
}): BrowserProbeReviewSummary {
  const performance = input.performanceArtifact?.final
  const paint = performance?.paint
  const navigation = performance?.navigation ?? {
    type: null,
    redirectCount: 0,
    durationMs: null,
    domContentLoadedMs: null,
    loadEventMs: null,
    responseStartMs: null,
    responseEndMs: null,
    requestStartMs: null,
    ttfbMs: null,
    redirectMs: null,
  }
  const missingReason = input.capture.has("performance")
    ? "metric not reported by browser"
    : "capture=performance was not requested"
  const pageErrors = input.errors.filter((error) => error.type === "pageerror")
  const probeErrors = input.errors.filter((error) => error.type === "probe-error")
  const consoleErrors = input.consoleMessages.filter((message) => message.type === "error")
  const lcpUrl = safeBrowserProbeUrl(paint?.largestContentfulPaintUrl ?? undefined)

  return {
    schema: "wp-codebox/browser-probe-review/v1",
    version: 1,
    browser: input.browser,
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    profile: {
      viewport: input.viewport,
      userAgent: input.viewport?.userAgent ?? null,
      throttle: input.throttle,
      waitFor: input.waitFor,
      durationMs: input.durationMs,
    },
    timings: {
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      totalDurationMs: browserProbeMetric(input.totalDurationMs, "probe wall-clock duration unavailable"),
      navigation,
      ttfbMs: browserProbeMetric(navigation.ttfbMs, missingReason),
      firstContentfulPaintMs: browserProbeMetric(paint?.firstContentfulPaintMs, missingReason),
      largestContentfulPaintMs: browserProbeMetric(paint?.largestContentfulPaintMs, missingReason),
      loadEventMs: browserProbeMetric(navigation.loadEventMs, missingReason),
    },
    lcp: {
      status: typeof paint?.largestContentfulPaintMs === "number" ? "available" : "missing",
      ...(typeof paint?.largestContentfulPaintMs === "number" ? {} : { reason: missingReason }),
      element: paint?.largestContentfulPaintElement ?? null,
      size: paint?.largestContentfulPaintSize ?? null,
      url: lcpUrl ?? null,
    },
    errors: {
      console: browserProbeIssueSummary(consoleErrors.length, Boolean(input.files.console), input.files.console?.path),
      page: browserProbeIssueSummary(pageErrors.length, Boolean(input.files.errors), input.files.errors?.path),
      probe: browserProbeIssueSummary(probeErrors.length, Boolean(input.files.errors), input.files.errors?.path),
    },
    network: browserProbeNetworkReviewSummary(input.network, input.files.network, input.files.waterfall),
    ...(input.files.websocket ? { webSockets: browserProbeWebSocketReviewSummary(input.webSockets, input.files.websocket) } : {}),
    ...(input.redirectDiagnostics ? { redirectDiagnostics: input.redirectDiagnostics } : {}),
    ...(input.wordpressDiagnostics ? { wordpressDiagnostics: input.wordpressDiagnostics } : {}),
    milestones: {
      status: input.checkpoints.length > 0 ? "captured" : "not-captured",
      count: input.checkpoints.length,
      names: [...new Set(input.checkpoints.map((checkpoint) => checkpoint.name).filter(Boolean))].sort(),
      ...(input.files.checkpoints ? { artifact: input.files.checkpoints.path } : {}),
    },
    artifacts: input.files,
  }
}

function browserProbeWebSocketReviewSummary(webSockets: BrowserProbeWebSocketRecord[], websocketArtifact?: BrowserProbeArtifactRef): BrowserProbeWebSocketReviewSummary {
  if (!websocketArtifact) {
    return { status: "not-captured", ...browserProbeWebSocketSummary([]) }
  }

  return {
    status: "captured",
    ...browserProbeWebSocketSummary(webSockets),
    artifact: websocketArtifact,
  }
}

function browserProbeMetric(value: number | null | undefined, reason: string): BrowserProbeMeasuredMetric {
  return typeof value === "number" && Number.isFinite(value)
    ? { status: "available", value, unit: "ms" }
    : { status: "missing", value: null, unit: "ms", reason }
}

function browserProbeIssueSummary(count: number, captured: boolean, artifact?: string): BrowserProbeReviewSummary["errors"]["console"] {
  if (!captured && count === 0) {
    return { count: 0, status: "not-captured" }
  }
  return {
    count,
    status: count > 0 ? "issues" : "ok",
    ...(artifact ? { artifact } : {}),
  }
}

function browserProbeNetworkReviewSummary(network: BrowserProbeNetworkRecord[], networkArtifact?: BrowserProbeArtifactRef, waterfallArtifact?: BrowserProbeArtifactRef): BrowserProbeNetworkReviewSummary {
  if (!networkArtifact) {
    return { status: "not-captured", events: 0, responses: 0, failures: 0, byHost: {}, byType: {} }
  }

  const byHost: Record<string, BrowserProbeNetworkCountSummary> = {}
  const byType: Record<string, BrowserProbeNetworkCountSummary> = {}
  for (const record of network) {
    addBrowserProbeNetworkCount(byHost, requestHost(record.url) || "unknown", record)
    addBrowserProbeNetworkCount(byType, record.resourceType || "unknown", record)
  }

  return {
    status: "captured",
    events: network.length,
    responses: network.filter((record) => record.type === "response").length,
    failures: network.filter((record) => record.type === "requestfailed").length,
    byHost: sortBrowserProbeNetworkCounts(byHost),
    byType: sortBrowserProbeNetworkCounts(byType),
    ...(waterfallArtifact ? { waterfall: waterfallArtifact } : {}),
  }
}
