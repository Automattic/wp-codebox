import { createHash } from "node:crypto"
import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import { assertRuntimeCommandAllowed, browserInteractionScriptUsesEvaluate, validateBrowserInteractionScript, type BrowserInteractionStep, type ExecutionSpec, type RuntimeCreateSpec } from "@automattic/wp-codebox-core"
import pixelmatch from "pixelmatch"
import { PNG } from "pngjs"
import { browserInteractionStepsFromArgs, durationStringMs, sanitizeScreenshotName } from "./browser-actions.js"
import type { BrowserArtifact, BrowserArtifactSummary, BrowserEditorCanvasProbeDiagnostic, BrowserEditorCanvasProbeSummary, BrowserEditorCanvasSelectorGroupSummary, BrowserEditorCanvasSelectorSummary, BrowserProbeArtifact, BrowserProbeArtifactRef, BrowserProbeAuthSummary, BrowserProbeCapabilityDiagnostics, BrowserProbeCheckpointRecord, BrowserProbeContextDetails, BrowserProbeErrorRecord, BrowserProbeLifecycleArtifact, BrowserProbeMeasuredMetric, BrowserProbeMemoryArtifact, BrowserProbeNetworkCountSummary, BrowserProbeNetworkRecord, BrowserProbeNetworkReviewSummary, BrowserProbePerformanceArtifact, BrowserProbePreviewRouting, BrowserProbeReviewSummary, BrowserProbeScriptMetadata, BrowserProbeViewport, BrowserRedirectDiagnosticsSummary, BrowserStepRecord, BrowserWordPressDiagnosticsSummary } from "./browser-artifacts.js"
import { attachBrowserCaptureListeners, chromiumBrowserMetadata, launchChromiumBrowser, settleBrowserNetworkTasks } from "./browser-capture-session.js"
import { browserAssertionsSummary, browserStepRecord, executeBrowserInteractionStep } from "./browser-interactions.js"
import { browserProbeLifecycleArtifact, browserProbeLifecycleInitScript, collectBrowserProbeLifecycle } from "./browser-lifecycle.js"
import { browserProbeBenchMetrics, jsonLines, serializeBrowserError } from "./browser-metrics.js"
import { browserPreviewNetworkPolicy, browserPreviewNetworkPolicyIsActive, browserPreviewNetworkPolicySummary, browserPreviewNeedsContextRouting, browserPreviewOrigins, browserPreviewReadinessError, browserPreviewRouting, browserPreviewSecureContextError, resolveBrowserPreviewUrl, routeBrowserPreviewContextNetwork, routeBrowserPreviewPageNetwork } from "./browser-preview-routing.js"
import { BROWSER_PROBE_CAPTURE_VALUES, BROWSER_PROBE_PERFORMANCE_INIT_SCRIPT, BROWSER_PROBE_STATE_INIT_SCRIPT, browserProbeAssertionsFromArgs, browserProbeAssertionsNeedMetrics, browserProbeAssertionsNeedNetwork, browserProbeCheckpoint, browserProbeMemoryArtifact, browserProbePendingCheckpoints, browserProbePerformanceArtifact, browserProbeReplayability, browserProbeViewport, executeBrowserProbeAssertions, navigateBrowserProbe } from "./browser-probe.js"
import { argValue, cleanWpCliOutput, commaListArg, durationArg, jsonArrayArg, strictBooleanArg, viewportArg } from "./commands.js"
import { editorActionStepsFromArgs, editorOpenTargetFromArgs, type EditorActionStep } from "./editor-actions.js"
import { bootstrapPhpCode } from "./php-bootstrap.js"
import { assertPlaygroundResponseOk, type PlaygroundRunResponse } from "./playground-command-errors.js"
import type { PlaygroundCliServer } from "./preview-server.js"
import type { Page } from "playwright"

const BROWSER_STEP_DEFAULT_TIMEOUT_MS = 15_000
const BROWSER_SCRIPT_DEFAULT_TIMEOUT_MS = 120_000
const EDITOR_CANVAS_DEFAULT_IFRAME_SELECTOR = 'iframe[name="editor-canvas"]'
const EDITOR_CANVAS_DEFAULT_LAYOUT_SELECTOR = ".block-editor-block-list__layout"
const EDITOR_CANVAS_DEFAULT_BLOCK_SELECTOR = ".block-editor-block-list__block, [data-block]"
const EDITOR_CANVAS_DEFAULT_TIMEOUT_MS = 30_000
const BROWSER_PROBE_PROFILE_OVERRIDES = new Set(["browser", "device", "locale", "permissions", "throttle", "timezone", "user-agent", "viewport"])
const VISUAL_EXPLANATION_STYLE_PROPERTIES = ["display", "position", "box-sizing", "width", "height", "margin-top", "margin-right", "margin-bottom", "margin-left", "padding-top", "padding-right", "padding-bottom", "padding-left", "font-family", "font-size", "font-weight", "line-height", "letter-spacing", "color", "background-color", "border-top-width", "border-right-width", "border-bottom-width", "border-left-width", "border-top-color", "border-right-color", "border-bottom-color", "border-left-color", "opacity", "transform", "visibility"] as const
const VISUAL_EXPLANATION_ATTRIBUTE_NAMES = ["id", "class", "role", "aria-label", "title", "href", "src", "type", "name"] as const

interface BrowserProbeProfileDefinition {
  id: string
  browser: "chromium" | "webkit"
  args: string[]
}

interface BrowserProbeRunPlan {
  url: string
  capture: Set<string>
  waitFor: string
  durationMs: number
  requestedViewport?: { width: number; height: number }
  throttleProfile?: BrowserProbeThrottleProfileDefinition
  requestedContext: BrowserProbeContextDetails["requested"]
  prePageScript?: string
  script?: string
  authRequest?: { userId: number }
  failFast: boolean
  stallTimeoutMs: number
  lifecycleSelectors: string[]
  assertions: ReturnType<typeof browserProbeAssertionsFromArgs>
}

interface BrowserActionsRunPlan {
  initialUrl?: string
  steps: BrowserInteractionStep[]
  capture: Set<string>
  stepTimeoutMs: number
  totalTimeoutMs: number
  requestedViewport?: { width: number; height: number }
  authRequest?: { userId: number }
  maxDomSnapshotElements: number
}

interface BrowserRunPlan {
  profile: string
  capture: string[]
  probe?: BrowserProbeRunPlan
  actions?: BrowserActionsRunPlan
}

interface VisualCompareDomElementSnapshot {
  path: string
  tag: string
  text: string
  attributes: Record<string, string>
  boundingBox: { x: number; y: number; width: number; height: number }
  styles: Record<string, string>
}

interface VisualCompareSelectorSnapshot {
  selector: string
  matched: number
  captured: number
  paths: string[]
  error?: string
}

interface VisualCompareDomSnapshot {
  url: string
  title: string
  elementCount: number
  capturedElements: VisualCompareDomElementSnapshot[]
  selectors?: VisualCompareSelectorSnapshot[]
  truncated: boolean
}

interface VisualCompareDomSnapshotArtifact {
  schema: "wp-codebox/browser-dom-snapshot/v1"
  command: "wordpress.browser-actions" | "wordpress.visual-compare"
  screenshot: string
  step?: { index: number; name?: string; kind: string }
  finalUrl: string
  viewport: BrowserProbeViewport | null
  capturedAt: string
  limits: { maxElements: number }
  summary: { elementCount: number; capturedElements: number; truncated: boolean }
  snapshot: VisualCompareDomSnapshot
}

interface VisualCompareElementDelta {
  path: string
  tag: string
  changes: {
    text?: { source: string; candidate: string }
    boundingBox?: { source: VisualCompareDomElementSnapshot["boundingBox"]; candidate: VisualCompareDomElementSnapshot["boundingBox"]; delta: { x: number; y: number; width: number; height: number } }
    attributes?: Record<string, { source: string | null; candidate: string | null }>
    styles?: Record<string, { source: string; candidate: string }>
  }
}

interface VisualCompareMismatchRegion {
  x: number
  y: number
  width: number
  height: number
  pixels: number
}

interface VisualCompareDimensionDriftRegion extends VisualCompareMismatchRegion {
  owner: "source" | "candidate"
}

interface VisualCompareDimensionDrift {
  widthDelta: number
  heightDelta: number
  sourceOnly: VisualCompareDimensionDriftRegion[]
  candidateOnly: VisualCompareDimensionDriftRegion[]
}

interface VisualCompareExplanation {
  schema: "wp-codebox/visual-explanation/v1"
  source: { label: string; url: string; title: string; elementCount: number; capturedElements: number; truncated: boolean }
  candidate: { label: string; url: string; title: string; elementCount: number; capturedElements: number; truncated: boolean }
  viewport: BrowserProbeViewport | null
  mismatchRegions: VisualCompareMismatchRegion[]
  selectors?: Array<{ selector: string; source: VisualCompareSelectorSnapshot; candidate: VisualCompareSelectorSnapshot }>
  missingSelectors?: Array<{ selector: string; sourceMatched: boolean; candidateMatched: boolean; sourceError?: string; candidateError?: string }>
  limits: { maxElements: number; maxCandidates: number }
  truncation: { changed: boolean; added: boolean; removed: boolean }
  summary: { changedElements: number; addedElements: number; removedElements: number; sourceCapturedElements: number; candidateCapturedElements: number }
  changes: VisualCompareElementDelta[]
  added: VisualCompareDomElementSnapshot[]
  removed: VisualCompareDomElementSnapshot[]
  limitations: string[]
}

interface VisualCompareComparisonMetrics {
  status?: string
  mismatchRatio?: number
  mismatchPixels?: number
  totalPixels?: number
  dimensionMismatch?: boolean
}

interface VisualCompareComparisonSummary extends VisualCompareComparisonMetrics {
  source?: { label?: string; url?: string; screenshot?: string }
  candidate?: { label?: string; url?: string; screenshot?: string }
}

interface VisualCompareBaselineDelta {
  ref: string
  selectedIndex: number
  match: "labels" | "only-comparison" | "first-comparison"
  availableComparisons: number
  baseline: VisualCompareComparisonSummary
  delta: {
    status?: { baseline?: string; current: string; changed: boolean }
    mismatchRatio?: { baseline: number; current: number; absoluteDelta: number; percentDelta?: number }
    mismatchPixels?: { baseline: number; current: number; absoluteDelta: number; percentDelta?: number }
    totalPixels?: { baseline: number; current: number; absoluteDelta: number; percentDelta?: number }
    dimensionMismatch?: { baseline: boolean; current: boolean; changed: boolean }
  }
}

const BROWSER_PROBE_PROFILES: Record<string, BrowserProbeProfileDefinition> = {
  "desktop-chrome": {
    id: "desktop-chrome",
    browser: "chromium",
    args: ["browser=chromium", "viewport=1280x720"],
  },
  "mobile-chrome": {
    id: "mobile-chrome",
    browser: "chromium",
    args: ["browser=chromium", "device=Pixel 5"],
  },
  "low-end-mobile-slow-4g": {
    id: "low-end-mobile-slow-4g",
    browser: "chromium",
    args: ["browser=chromium", "device=Pixel 5", "throttle=low-end-mobile-slow-4g"],
  },
  "desktop-webkit": {
    id: "desktop-webkit",
    browser: "webkit",
    args: ["browser=webkit", "viewport=1280x720"],
  },
  "mobile-webkit": {
    id: "mobile-webkit",
    browser: "webkit",
    args: ["browser=webkit", "device=iPhone 13"],
  },
}

interface BrowserProbeThrottleProfileDefinition {
  id: string
  cpuSlowdownRate: number
  network: {
    offline: boolean
    latencyMs: number
    downloadThroughputBytesPerSecond: number
    uploadThroughputBytesPerSecond: number
  }
}

const BROWSER_PROBE_THROTTLE_PROFILES: Record<string, BrowserProbeThrottleProfileDefinition> = {
  "low-end-mobile-slow-4g": {
    id: "low-end-mobile-slow-4g",
    cpuSlowdownRate: 4,
    network: {
      offline: false,
      latencyMs: 150,
      downloadThroughputBytesPerSecond: 1_600_000 / 8,
      uploadThroughputBytesPerSecond: 750_000 / 8,
    },
  },
}

export class BrowserCommandArtifactError extends Error {
  constructor(message: string, readonly artifact: BrowserArtifact) {
    super(message)
    this.name = "BrowserCommandArtifactError"
  }
}

export function isBrowserCommandArtifactError(error: unknown): error is BrowserCommandArtifactError {
  return error instanceof BrowserCommandArtifactError
}

export async function runBrowserProbeCommand({
  artifactRoot,
  command = "wordpress.browser-probe",
  plan,
  runtimeSpec,
  runPlaygroundCommand,
  server,
  spec,
}: {
  artifactRoot: string
  command?: string
  plan?: BrowserProbeRunPlan
  runtimeSpec?: RuntimeCreateSpec
  runPlaygroundCommand?: (command: string, server: PlaygroundCliServer, options: { code: string } | { scriptPath: string }) => Promise<PlaygroundRunResponse>
  server: PlaygroundCliServer
  spec: ExecutionSpec
}): Promise<{ artifact: BrowserProbeArtifact; artifacts?: BrowserProbeArtifact[]; output: string }> {
  if (plan) {
    return runSingleBrowserProbeCommand({ artifactRoot, command, plan, runtimeSpec, runPlaygroundCommand, server, spec, browserFilesDirectory: "files/browser" })
  }

  const profileIds = browserProbeProfileIds(spec.args ?? [])
  if (profileIds.length === 0) {
    const profileId = argValue(spec.args ?? [], "profile")?.trim()
    if (profileId) {
      const profile = browserProbeProfile(profileId)
      if (profile.browser !== "chromium") {
        throw new Error(`wordpress.browser-probe profile ${profile.id} requests ${profile.browser}, but this runner currently supports Chromium profiles only. Supported Chromium profiles: desktop-chrome, mobile-chrome, low-end-mobile-slow-4g.`)
      }
      return runSingleBrowserProbeCommand({
        artifactRoot,
        command,
        runtimeSpec,
        runPlaygroundCommand,
        server,
        spec: { ...spec, args: browserProbeProfileArgs(spec.args ?? [], profile) },
        browserFilesDirectory: "files/browser",
        profileId: profile.id,
      })
    }
    return runSingleBrowserProbeCommand({ artifactRoot, command, runtimeSpec, runPlaygroundCommand, server, spec, browserFilesDirectory: "files/browser" })
  }

  const profiles = profileIds.map((profileId) => browserProbeProfile(profileId))
  for (const profile of profiles) {
    if (profile.browser !== "chromium") {
      throw new Error(`wordpress.browser-probe profile ${profile.id} requests ${profile.browser}, but this runner currently supports Chromium profiles only. Supported Chromium profiles: desktop-chrome, mobile-chrome, low-end-mobile-slow-4g.`)
    }
  }

  const artifacts: BrowserProbeArtifact[] = []
  const outputs: unknown[] = []
  for (const profile of profiles) {
    const result = await runSingleBrowserProbeCommand({
      artifactRoot,
      command,
      runtimeSpec,
      runPlaygroundCommand,
      server,
      spec: {
        ...spec,
        args: browserProbeProfileArgs(spec.args ?? [], profile),
      },
      browserFilesDirectory: `files/browser/${profile.id}`,
      profileId: profile.id,
    })
    artifacts.push(result.artifact)
    outputs.push(JSON.parse(result.output))
  }

  const artifact = artifacts[0]
  if (!artifact) {
    throw new Error("wordpress.browser-probe profiles requires at least one profile")
  }

  return {
    artifact,
    artifacts,
    output: `${JSON.stringify({
      command,
      schema: "wp-codebox/browser-probe-profile-matrix/v1",
      profiles: outputs,
    }, null, 2)}\n`,
  }
}

async function runSingleBrowserProbeCommand({
  artifactRoot,
  command,
  plan,
  runtimeSpec,
  runPlaygroundCommand,
  server,
  spec,
  browserFilesDirectory,
  profileId,
}: {
  artifactRoot: string
  command: string
  plan?: BrowserProbeRunPlan
  runtimeSpec?: RuntimeCreateSpec
  runPlaygroundCommand?: (command: string, server: PlaygroundCliServer, options: { code: string } | { scriptPath: string }) => Promise<PlaygroundRunResponse>
  server: PlaygroundCliServer
  spec: ExecutionSpec
  browserFilesDirectory: string
  profileId?: string
}): Promise<{ artifact: BrowserProbeArtifact; output: string }> {
  const args = spec.args ?? []
  const runPlan = plan ?? browserProbeRunPlanFromArgs(args, profileId)
  if (!runPlan.url) {
    throw new Error("wordpress.browser-probe requires url=<path-or-url>")
  }

  const capture = runPlan.capture

  for (const item of capture) {
    if (!(BROWSER_PROBE_CAPTURE_VALUES as readonly string[]).includes(item)) {
      throw new Error(`wordpress.browser-probe capture supports ${BROWSER_PROBE_CAPTURE_VALUES.join(", ")}: ${item}`)
    }
  }

  const waitFor = runPlan.waitFor
  const durationMs = runPlan.durationMs
  const requestedViewport = runPlan.requestedViewport
  const throttleProfile = runPlan.throttleProfile
  const requestedContext = runPlan.requestedContext
  const prePageScript = runPlan.prePageScript
  const script = runPlan.script
  const authRequest = runPlan.authRequest
  const failFast = runPlan.failFast
  const stallTimeoutMs = runPlan.stallTimeoutMs
  const lifecycleSelectors = runPlan.lifecycleSelectors
  const routedHosts = commaListArg(args, "route-host")
  const assertions = runPlan.assertions
  const capturesConsoleForAssertions = assertions.some((assertion) => assertion.type === "no-console-errors" || assertion.type === "no-errors")
  const capturesErrorsForAssertions = assertions.some((assertion) => assertion.type === "no-page-errors" || assertion.type === "no-errors")
  const capturesNetworkForAssertions = browserProbeAssertionsNeedNetwork(assertions)
  const capturesBrowserMetrics = capture.has("performance") || capture.has("memory") || browserProbeAssertionsNeedMetrics(assertions)
  const prePageScriptMetadata = prePageScript ? browserProbeScriptMetadata(prePageScript) : undefined
  const preview = browserPreviewRouting(args, runtimeSpec, server.serverUrl)
  const networkPolicy = browserPreviewNetworkPolicy(args, routedHosts, preview)
  const previewOrigins = browserPreviewOrigins(preview)
  const targetUrl = resolveBrowserPreviewUrl(runPlan.url, preview.effectiveOrigin)
  const browserDirectory = join(artifactRoot, browserFilesDirectory)
  await mkdir(browserDirectory, { recursive: true })

  const consoleMessages: Record<string, unknown>[] = []
  const errors: BrowserProbeErrorRecord[] = []
  const network: BrowserProbeNetworkRecord[] = []
  const networkTasks: Array<Promise<void>> = []
  const checkpoints: BrowserProbeCheckpointRecord[] = []
  const consolePath = join(browserDirectory, "console.jsonl")
  const checkpointsPath = join(browserDirectory, "checkpoints.jsonl")
  const errorsPath = join(browserDirectory, "errors.jsonl")
  const htmlPath = join(browserDirectory, "snapshot.html")
  const memoryPath = join(browserDirectory, "memory.json")
  const lifecyclePath = join(browserDirectory, "lifecycle.json")
  const networkPath = join(browserDirectory, "network.jsonl")
  const performancePath = join(browserDirectory, "performance.json")
  const reviewPath = join(browserDirectory, "review.json")
  const screenshotPath = join(browserDirectory, "screenshot.png")
  const summaryPath = join(browserDirectory, "summary.json")
  const redirectDiagnosticsPath = join(browserDirectory, "redirect-diagnostics.json")
  const wordpressDiagnosticsPath = join(browserDirectory, "wordpress-diagnostics.json")
  const startedAt = now()
  const startedAtMs = Date.now()
  const progress = createBrowserProbeProgressTracker(startedAt, stallTimeoutMs)
  const { devices } = await import("playwright")
  if (requestedContext.browser && requestedContext.browser !== "chromium") {
    throw new Error(`wordpress.browser-probe browser=${requestedContext.browser} is unsupported by this runner; use browser=chromium or a Chromium profile.`)
  }
  const deviceProfile = requestedContext.device ? devices[requestedContext.device] : undefined
  if (requestedContext.device && !deviceProfile) {
    throw new Error(`wordpress.browser-probe unknown Playwright device profile: ${requestedContext.device}`)
  }
  const browser = await launchChromiumBrowser()
  const browserMetadata = chromiumBrowserMetadata(browser)
  let finalUrl = targetUrl
  let windowLocationOrigin: string | undefined
  let htmlSha256: string | undefined
  let screenshotSha256: string | undefined
  let viewport: BrowserProbeViewport | null = null
  let scriptResult: unknown
  let lifecycleArtifact: BrowserProbeLifecycleArtifact | undefined
  let memoryArtifact: BrowserProbeMemoryArtifact | undefined
  let performanceArtifact: BrowserProbePerformanceArtifact | undefined
  let page: import("playwright").Page | null = null
  let context: import("playwright").BrowserContext | null = null
  let contextDetails: BrowserProbeContextDetails | undefined
  let authSummary: BrowserProbeAuthSummary | undefined
  let capabilityDiagnostics: BrowserProbeCapabilityDiagnostics | undefined
  let assertionResults: import("./browser-artifacts.js").BrowserStepAssertion[] = []
  let pendingError: Error | undefined
  let artifact: BrowserProbeArtifact | undefined
  let wordpressDiagnosticsReady = false

  try {
    context = browserPreviewNeedsContextRouting(networkPolicy) || requestedContext.device || requestedContext.locale || requestedContext.timezone || requestedContext.userAgent || (requestedContext.permissions?.length ?? 0) > 0
      ? await browser.newContext({
        ...(deviceProfile ?? {}),
        ...(requestedContext.locale ? { locale: requestedContext.locale } : {}),
        ...(requestedContext.timezone ? { timezoneId: requestedContext.timezone } : {}),
        ...(requestedContext.userAgent ? { userAgent: requestedContext.userAgent } : {}),
      })
      : null
    if (context && requestedContext.permissions && requestedContext.permissions.length > 0) {
      await context.grantPermissions(requestedContext.permissions)
    }
    if (context && browserPreviewNeedsContextRouting(networkPolicy)) {
      await routeBrowserPreviewContextNetwork(context, networkPolicy, preview.localOrigin)
    }
    page = context ? await context.newPage() : await browser.newPage()
    if (authRequest) {
      authSummary = await installWordPressAdminAuthCookies({ command, cookieUrls: browserAuthCookieUrls(server.serverUrl, routedHosts, [targetUrl]), page, runPlaygroundCommand, runtimeSpec, server, userId: authRequest.userId })
    }
    if (requestedViewport) {
      await page.setViewportSize(requestedViewport)
    }
    if (throttleProfile) {
      await applyBrowserProbeThrottleProfile(page, throttleProfile)
    }
    if (!context && browserPreviewNeedsContextRouting(networkPolicy)) {
      await routeBrowserPreviewPageNetwork(page, networkPolicy, preview.localOrigin)
    }
    await page.addInitScript(BROWSER_PROBE_STATE_INIT_SCRIPT)
    if (lifecycleSelectors.length > 0) {
      await page.addInitScript(browserProbeLifecycleInitScript(lifecycleSelectors))
    }
    if (capturesBrowserMetrics) {
      await page.addInitScript(BROWSER_PROBE_PERFORMANCE_INIT_SCRIPT)
    }
    if (prePageScript) {
      await page.addInitScript(prePageScript)
    }
    wordpressDiagnosticsReady = await installBrowserWordPressDiagnostics(runPlaygroundCommand, server)
    viewport = await browserProbeViewport(page)
    contextDetails = await browserProbeContextDetails(page, requestedContext, viewport)
    capabilityDiagnostics = await browserProbeCapabilityDiagnostics(page, viewport)
    attachBrowserCaptureListeners({
      captureConsole: capture.has("console") || capturesConsoleForAssertions,
      captureErrors: capture.has("errors") || capturesErrorsForAssertions,
      captureNetwork: true,
      consoleMessages,
      errors,
      network,
      networkTasks,
      onConsole: () => progress.mark("console"),
      onNetwork: () => progress.mark("network"),
      onPageError: () => progress.mark("pageerror"),
      page,
    })

    const previewReadinessError = browserPreviewReadinessError(preview)
    if (previewReadinessError) {
      throw previewReadinessError
    }

    await withBrowserProbeLiveness(page, progress, failFast, navigateBrowserProbe(page, targetUrl, waitFor, durationMs))
    progress.mark("navigation")
    const browserLocation = await page.evaluate(() => ({ origin: window.location.origin, secureContext: window.isSecureContext })).catch(() => undefined)
    windowLocationOrigin = browserLocation?.origin
    preview.secureContext = browserLocation?.secureContext
    const secureContextError = browserPreviewSecureContextError(preview)
    if (secureContextError) {
      throw secureContextError
    }
    if (capturesBrowserMetrics) {
      checkpoints.push(await browserProbeCheckpoint(page, "after-navigation"))
    }
    if (script) {
      scriptResult = await withBrowserProbeLiveness(page, progress, failFast, page.evaluate(async (source) => {
        const run = new Function(`return (async () => {\n${source}\n})()`)
        return run()
      }, script))
      progress.mark("script")
      if (capturesBrowserMetrics) {
        const pendingCheckpoints = await browserProbePendingCheckpoints(page)
        if (pendingCheckpoints.length > 0) {
          progress.mark("checkpoint")
        }
        checkpoints.push(...pendingCheckpoints)
        checkpoints.push(await browserProbeCheckpoint(page, "after-script"))
      }
    }
    if (durationMs > 0 && waitFor !== "duration") {
      await withBrowserProbeLiveness(page, progress, failFast, page.waitForTimeout(durationMs))
      progress.mark("duration")
      if (capturesBrowserMetrics) {
        checkpoints.push(await browserProbeCheckpoint(page, "after-duration"))
      }
    }
    if (assertions.length > 0) {
      await settleBrowserNetworkTasks(networkTasks)
      const assertionMetrics = capturesBrowserMetrics ? browserProbeBenchMetrics(browserProbeMemoryArtifact(checkpoints), browserProbePerformanceArtifact(checkpoints)) : {}
      assertionResults = await executeBrowserProbeAssertions(page, assertions, consoleMessages, errors, network, assertionMetrics)
      if (capturesBrowserMetrics) {
        checkpoints.push(await browserProbeCheckpoint(page, "after-assertions"))
      }
      const fatalFailures = assertionResults.filter((assertion) => !assertion.passed && !assertion.advisory)
      if (fatalFailures.length > 0) {
        pendingError = new Error(`wordpress.browser-probe assertion failed: ${fatalFailures.map((assertion) => assertion.assertion).join(", ")}`)
      }
    }
    finalUrl = page.url()
  } catch (error) {
    pendingError = error instanceof Error ? error : new Error(String(error))
    progress.fail("probe-error", pendingError)
    errors.push(serializeBrowserError("probe-error", error))
  } finally {
    if (page) {
      finalUrl = page.url()
      windowLocationOrigin = windowLocationOrigin ?? await page.evaluate(() => window.location.origin).catch(() => undefined)
      if (capturesBrowserMetrics) {
        checkpoints.push(await browserProbeCheckpoint(page, "final"))
        if (capture.has("memory")) {
          memoryArtifact = browserProbeMemoryArtifact(checkpoints)
        }
        if (capture.has("performance")) {
          performanceArtifact = browserProbePerformanceArtifact(checkpoints, { consoleMessages, errors, network, startedAt })
        }
      }
      const lifecycle = lifecycleSelectors.length > 0 ? await collectBrowserProbeLifecycle(page) : undefined
      if (lifecycle) {
        lifecycleArtifact = browserProbeLifecycleArtifact(lifecycle)
      }

      if (capture.has("html")) {
        try {
          const html = await page.content()
          await writeFile(htmlPath, html)
          htmlSha256 = sha256(Buffer.from(html, "utf8"))
        } catch (error) {
          errors.push(serializeBrowserError("probe-error", error))
        }
      }

      if (capture.has("screenshot")) {
        try {
          await page.screenshot({ path: screenshotPath, fullPage: true })
          screenshotSha256 = await fileSha256(screenshotPath)
        } catch (error) {
          errors.push(serializeBrowserError("probe-error", error))
        }
      }
    }
    await settleBrowserNetworkTasks(networkTasks)
    await browser.close()
    if (capture.has("console") || capturesConsoleForAssertions) {
      await writeFile(consolePath, jsonLines(consoleMessages))
    }
    if (capture.has("errors") || capturesErrorsForAssertions) {
      await writeFile(errorsPath, jsonLines(errors))
    }
    if (capture.has("network") || capturesNetworkForAssertions) {
      await writeFile(networkPath, jsonLines(network))
    }
    if (checkpoints.length > 0) {
      await writeFile(checkpointsPath, jsonLines(checkpoints))
    }
    if (memoryArtifact) {
      await writeFile(memoryPath, `${JSON.stringify(memoryArtifact, null, 2)}\n`)
    }
    if (lifecycleArtifact) {
      await writeFile(lifecyclePath, `${JSON.stringify(lifecycleArtifact, null, 2)}\n`)
    }
    if (performanceArtifact) {
      await writeFile(performancePath, `${JSON.stringify(performanceArtifact, null, 2)}\n`)
    }

    const redirectDiagnostics = browserRedirectDiagnosticsArtifact({
      artifactPath: `${browserFilesDirectory}/redirect-diagnostics.json`,
      error: pendingError,
      finalAttemptedUrl: finalUrl,
      network,
      requestedUrl: targetUrl,
    })
    if (redirectDiagnostics) {
      await writeFile(redirectDiagnosticsPath, `${JSON.stringify(redirectDiagnostics, null, 2)}\n`)
    }
    const redirectDiagnosticsSummary = redirectDiagnostics?.summary

    const wordpressDiagnostics = await browserWordPressDiagnosticsArtifact({
      artifactPath: `${browserFilesDirectory}/wordpress-diagnostics.json`,
      network,
      ready: wordpressDiagnosticsReady,
      server,
    })
    if (wordpressDiagnostics) {
      await writeFile(wordpressDiagnosticsPath, `${JSON.stringify(wordpressDiagnostics, null, 2)}\n`)
    }
    const wordpressDiagnosticsSummary = wordpressDiagnostics?.summary

    const assertionPassed = assertionResults.filter((assertion) => assertion.passed).length
    const assertionFailed = assertionResults.filter((assertion) => !assertion.passed).length
    const advisoryFailed = assertionResults.filter((assertion) => !assertion.passed && assertion.advisory).length
    const assertionSummary = {
      total: assertionResults.length,
      passed: assertionPassed,
      failed: assertionFailed,
      advisoryFailed,
      fatalFailed: assertionFailed - advisoryFailed,
      results: assertionResults,
    }

    const finishedAt = now()
    const review = browserProbeReviewSummary({
      browser: browserMetadata,
      capture,
      checkpoints,
      consoleMessages,
      durationMs,
      errors,
      files: browserProbeArtifactRefs(browserFilesDirectory, capture, {
        checkpoints: checkpoints.length > 0,
        console: capture.has("console") || capturesConsoleForAssertions,
        errors: capture.has("errors") || capturesErrorsForAssertions,
        html: capture.has("html") ? htmlSha256 : undefined,
        lifecycle: Boolean(lifecycleArtifact),
        memory: Boolean(memoryArtifact),
        network: capture.has("network") || capturesNetworkForAssertions,
        performance: Boolean(performanceArtifact),
        redirectDiagnostics: Boolean(redirectDiagnostics),
        screenshot: capture.has("screenshot") ? screenshotSha256 : undefined,
        wordpressDiagnostics: Boolean(wordpressDiagnostics),
      }),
      finishedAt,
      network,
      performanceArtifact,
      startedAt,
      throttle: throttleProfile?.id ?? null,
      totalDurationMs: Date.now() - startedAtMs,
      viewport,
      waitFor,
      redirectDiagnostics: redirectDiagnosticsSummary,
      wordpressDiagnostics: wordpressDiagnosticsSummary,
    })
    await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`)

    artifact = {
      artifactType: "probe",
      requestedUrl: targetUrl,
      url: targetUrl,
      preview,
      ...(browserPreviewNetworkPolicyIsActive(networkPolicy) ? { networkPolicy: browserPreviewNetworkPolicySummary(networkPolicy) } : {}),
      ...previewOrigins,
      ...(prePageScriptMetadata ? { prePageScript: prePageScriptMetadata } : {}),
      files: {
        ...(capture.has("console") || capturesConsoleForAssertions ? { console: `${browserFilesDirectory}/console.jsonl` } : {}),
        ...(checkpoints.length > 0 ? { checkpoints: `${browserFilesDirectory}/checkpoints.jsonl` } : {}),
        ...(capture.has("errors") || capturesErrorsForAssertions ? { errors: `${browserFilesDirectory}/errors.jsonl` } : {}),
        ...(htmlSha256 ? { html: `${browserFilesDirectory}/snapshot.html` } : {}),
        ...(lifecycleArtifact ? { lifecycle: `${browserFilesDirectory}/lifecycle.json` } : {}),
        ...(memoryArtifact ? { memory: `${browserFilesDirectory}/memory.json` } : {}),
        ...(capture.has("network") || capturesNetworkForAssertions ? { network: `${browserFilesDirectory}/network.jsonl` } : {}),
        ...(performanceArtifact ? { performance: `${browserFilesDirectory}/performance.json` } : {}),
        ...(redirectDiagnostics ? { redirectDiagnostics: `${browserFilesDirectory}/redirect-diagnostics.json` } : {}),
        review: `${browserFilesDirectory}/review.json`,
        ...(capture.has("screenshot") ? { screenshot: `${browserFilesDirectory}/screenshot.png` } : {}),
        ...(wordpressDiagnostics ? { wordpressDiagnostics: `${browserFilesDirectory}/wordpress-diagnostics.json` } : {}),
        summary: `${browserFilesDirectory}/summary.json`,
      },
      summary: {
        ...(assertionSummary.total > 0 ? { assertions: assertionSummary } : {}),
        consoleMessages: consoleMessages.length,
        errors: errors.length,
        finalUrl,
        ...(windowLocationOrigin ? { windowLocationOrigin } : {}),
        htmlSnapshot: Boolean(htmlSha256),
        ...(browserPreviewNetworkPolicyIsActive(networkPolicy) ? { networkPolicy: browserPreviewNetworkPolicySummary(networkPolicy) } : {}),
        ...(lifecycleArtifact ? { lifecycle: { schema: lifecycleArtifact.schema, version: lifecycleArtifact.version, startedAtMs: lifecycleArtifact.startedAtMs, selectors: lifecycleArtifact.selectors } } : {}),
        ...(memoryArtifact ? { memory: memoryArtifact.peak } : {}),
        ...(memoryArtifact || performanceArtifact ? { metrics: browserProbeBenchMetrics(memoryArtifact, performanceArtifact) } : {}),
        networkEvents: network.length,
        ...(performanceArtifact?.phaseMetrics ? { phaseMetrics: performanceArtifact.phaseMetrics } : {}),
        ...(performanceArtifact ? { performance: performanceArtifact.peak } : {}),
        progress: progress.summary(),
        review,
        ...(redirectDiagnosticsSummary ? { redirectDiagnostics: redirectDiagnosticsSummary } : {}),
        ...(wordpressDiagnosticsSummary ? { wordpressDiagnostics: wordpressDiagnosticsSummary } : {}),
        context: contextDetails,
        auth: authSummary,
        capabilities: capabilityDiagnostics,
        replayability: browserProbeReplayability(capture),
        screenshot: capture.has("screenshot"),
        ...(typeof scriptResult !== "undefined" ? { scriptResult } : {}),
        viewport,
      },
    }
    await writeFile(summaryPath, `${JSON.stringify({
      schema: "wp-codebox/browser-probe/v1",
      requestedUrl: targetUrl,
      preview,
      ...(browserPreviewNetworkPolicyIsActive(networkPolicy) ? { networkPolicy: browserPreviewNetworkPolicySummary(networkPolicy) } : {}),
      ...previewOrigins,
      finalUrl,
      ...(windowLocationOrigin ? { windowLocationOrigin } : {}),
      waitFor,
      durationMs,
      ...(lifecycleSelectors.length > 0 ? { observe: lifecycleSelectors } : {}),
      failFast,
      stallTimeoutMs,
      capture: [...capture].sort(),
      ...(assertionSummary.total > 0 ? { assertions: assertionSummary } : {}),
      ...(prePageScriptMetadata ? { prePageScript: prePageScriptMetadata } : {}),
      startedAt,
      finishedAt,
      files: artifact.files,
      hashes: {
        ...(htmlSha256 ? { html: { algorithm: "sha256", value: htmlSha256 } } : {}),
        ...(screenshotSha256 ? { screenshot: { algorithm: "sha256", value: screenshotSha256 } } : {}),
      },
      context: contextDetails,
      auth: authSummary,
      capabilities: capabilityDiagnostics,
      review,
      ...(redirectDiagnosticsSummary ? { redirectDiagnostics: redirectDiagnosticsSummary } : {}),
      ...(wordpressDiagnosticsSummary ? { wordpressDiagnostics: wordpressDiagnosticsSummary } : {}),
      viewport,
      summary: artifact.summary,
    }, null, 2)}\n`)
  }

  if (pendingError) {
    if (!artifact) {
      throw pendingError
    }
    throw new BrowserCommandArtifactError(pendingError.message, artifact)
  }

  return {
    artifact,
    output: `${JSON.stringify({
      command,
      requestedUrl: targetUrl,
      preview,
      ...(browserPreviewNetworkPolicyIsActive(networkPolicy) ? { networkPolicy: browserPreviewNetworkPolicySummary(networkPolicy) } : {}),
      ...previewOrigins,
      finalUrl: artifact.summary.finalUrl ?? targetUrl,
      files: artifact.files,
      summary: artifact.summary,
    }, null, 2)}\n`,
  }
}

function browserProbeProfileIds(args: string[]): string[] {
  const raw = argValue(args, "profiles")?.trim()
  if (!raw) {
    return []
  }
  return raw.split(",").map((profile) => profile.trim()).filter(Boolean)
}

function browserProbeProfile(profileId: string): BrowserProbeProfileDefinition {
  const profile = BROWSER_PROBE_PROFILES[profileId]
  if (!profile) {
    throw new Error(`wordpress.browser-probe unknown profile: ${profileId}. Supported profiles: ${Object.keys(BROWSER_PROBE_PROFILES).join(", ")}`)
  }
  return profile
}

function browserProbeRunPlanFromArgs(args: string[], profileId?: string): BrowserProbeRunPlan {
  const capture = new Set(commaListArg(args, "capture"))
  if (capture.size === 0) {
    capture.add("console")
    capture.add("errors")
    capture.add("html")
    capture.add("network")
    capture.add("screenshot")
  }
  const requestedViewport = viewportArg(args, "viewport")
  const throttleProfile = browserProbeThrottleProfile(args)
  return {
    url: argValue(args, "url")?.trim() ?? "",
    capture,
    waitFor: argValue(args, "wait-for")?.trim() || "domcontentloaded",
    durationMs: durationArg(args, "duration", 0),
    requestedViewport,
    throttleProfile,
    requestedContext: browserProbeContextRequest(args, requestedViewport, profileId, throttleProfile?.id),
    prePageScript: argValue(args, "pre-page-script"),
    script: argValue(args, "script"),
    authRequest: browserAuthRequest(args),
    failFast: strictBooleanArg(args, "fail-fast", false),
    stallTimeoutMs: durationArg(args, "stall-timeout", 0),
    lifecycleSelectors: commaListArg(args, "observe"),
    assertions: browserProbeAssertionsFromArgs(args),
  }
}

function browserProbeProfileArgs(args: string[], profile: BrowserProbeProfileDefinition): string[] {
  const explicitOverrideKeys = new Set(args.map((arg) => arg.match(/^([^=]+)=/)?.[1]).filter((key): key is string => typeof key === "string" && BROWSER_PROBE_PROFILE_OVERRIDES.has(key)))
  return [
    ...args.filter((arg) => !arg.startsWith("profiles=") && !arg.startsWith("profile=")),
    `profile=${profile.id}`,
    ...profile.args.filter((arg) => {
      const key = arg.match(/^([^=]+)=/)?.[1]
      return !key || !explicitOverrideKeys.has(key)
    }),
  ]
}

function browserProbeThrottleProfile(args: string[]): BrowserProbeThrottleProfileDefinition | undefined {
  const profileId = argValue(args, "throttle")?.trim()
  if (!profileId || profileId === "none") {
    return undefined
  }

  const profile = BROWSER_PROBE_THROTTLE_PROFILES[profileId]
  if (!profile) {
    throw new Error(`wordpress.browser-probe unknown throttle profile: ${profileId}. Supported profiles: ${Object.keys(BROWSER_PROBE_THROTTLE_PROFILES).join(", ")}`)
  }
  return profile
}

async function applyBrowserProbeThrottleProfile(page: import("playwright").Page, profile: BrowserProbeThrottleProfileDefinition): Promise<void> {
  const session = await page.context().newCDPSession(page)
  try {
    await Promise.all([
      session.send("Network.enable").catch(() => undefined),
      session.send("Emulation.setCPUThrottlingRate", { rate: profile.cpuSlowdownRate }).catch(() => undefined),
    ])
    await session.send("Network.emulateNetworkConditions", {
      offline: profile.network.offline,
      latency: profile.network.latencyMs,
      downloadThroughput: profile.network.downloadThroughputBytesPerSecond,
      uploadThroughput: profile.network.uploadThroughputBytesPerSecond,
    }).catch(() => undefined)
  } finally {
    await session.detach().catch(() => undefined)
  }
}

function browserProbeScriptMetadata(source: string): BrowserProbeScriptMetadata {
  return {
    sha256: sha256(Buffer.from(source, "utf8")),
    bytes: Buffer.byteLength(source, "utf8"),
  }
}

function browserProbeContextRequest(args: string[], viewport: { width: number; height: number } | undefined, profileId?: string, throttleProfileId?: string): BrowserProbeContextDetails["requested"] {
  const browser = argValue(args, "browser")?.trim()
  const device = argValue(args, "device")?.trim()
  const locale = argValue(args, "locale")?.trim()
  const permissions = commaListArg(args, "permissions")
  const timezone = argValue(args, "timezone")?.trim()
  const userAgent = argValue(args, "user-agent")?.trim()
  return {
    ...(browser ? { browser } : {}),
    ...(device ? { device } : {}),
    ...(locale ? { locale } : {}),
    ...(permissions.length > 0 ? { permissions } : {}),
    ...(profileId ? { profile: profileId } : {}),
    ...(throttleProfileId ? { throttle: throttleProfileId } : {}),
    ...(timezone ? { timezone } : {}),
    ...(userAgent ? { userAgent } : {}),
    ...(viewport ? { viewport } : {}),
  }
}

async function browserProbeContextDetails(page: import("playwright").Page, requested: BrowserProbeContextDetails["requested"], viewport: BrowserProbeViewport | null): Promise<BrowserProbeContextDetails> {
  const effective = await page.evaluate(() => ({
    locale: navigator.language || undefined,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || undefined,
  })).catch(() => ({ locale: undefined, timezone: undefined }))

  return {
    requested,
    effective: {
      ...(requested.browser ? { browser: requested.browser } : {}),
      ...(requested.device ? { device: requested.device } : {}),
      ...(effective.locale ? { locale: effective.locale } : {}),
      ...(requested.permissions ? { permissions: requested.permissions } : {}),
      ...(requested.profile ? { profile: requested.profile } : {}),
      ...(requested.throttle ? { throttle: requested.throttle } : {}),
      ...(effective.timezone ? { timezone: effective.timezone } : {}),
      ...(viewport?.userAgent ? { userAgent: viewport.userAgent } : {}),
      viewport,
    },
  }
}

async function browserProbeCapabilityDiagnostics(page: import("playwright").Page, viewport: BrowserProbeViewport | null): Promise<BrowserProbeCapabilityDiagnostics> {
  const fallback: BrowserProbeCapabilityDiagnostics = {
    secureContext: false,
    userAgent: viewport?.userAgent ?? "",
    viewport: viewport ? browserProbeCapabilityViewport(viewport) : null,
    maxTouchPoints: 0,
    paymentRequest: { available: false },
    permissions: {},
  }

  return page.evaluate(async (probeViewport) => {
    const resolvedOptions = Intl.DateTimeFormat().resolvedOptions()
    const permissionNames = ["clipboard-read", "clipboard-write", "geolocation", "notifications", "payment-handler"]
    const permissions: BrowserProbeCapabilityDiagnostics["permissions"] = {}
    const permissionsApi = (navigator as typeof navigator & { permissions?: { query?: (descriptor: { name: string }) => Promise<{ state?: string }> } }).permissions
    const normalizePermissionState = (state: unknown): BrowserProbeCapabilityDiagnostics["permissions"][string]["state"] => {
      if (state === "granted" || state === "denied" || state === "prompt") {
        return state
      }
      return typeof state === "string" ? "error" : "unsupported"
    }

    for (const name of permissionNames) {
      if (!permissionsApi?.query) {
        permissions[name] = { state: "unsupported" }
        continue
      }

      try {
        const status = await permissionsApi.query({ name })
        permissions[name] = { state: normalizePermissionState(status.state) }
      } catch {
        permissions[name] = { state: "unsupported" }
      }
    }

    return {
      secureContext: Boolean(window.isSecureContext),
      userAgent: navigator.userAgent || "",
      language: navigator.language || undefined,
      languages: Array.isArray(navigator.languages) ? navigator.languages.slice(0, 10).filter((language) => typeof language === "string" && language.length > 0) : undefined,
      locale: resolvedOptions.locale || navigator.language || undefined,
      timezone: resolvedOptions.timeZone || undefined,
      viewport: probeViewport ? {
        width: probeViewport.width,
        height: probeViewport.height,
        deviceScaleFactor: probeViewport.deviceScaleFactor,
        isMobile: probeViewport.isMobile,
        hasTouch: probeViewport.hasTouch,
      } : null,
      maxTouchPoints: typeof navigator.maxTouchPoints === "number" ? navigator.maxTouchPoints : 0,
      paymentRequest: { available: typeof (window as typeof window & { PaymentRequest?: unknown }).PaymentRequest === "function" },
      permissions,
    }
  }, viewport).catch(() => fallback)
}

function browserProbeCapabilityViewport(viewport: BrowserProbeViewport): BrowserProbeCapabilityDiagnostics["viewport"] {
  return {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: viewport.deviceScaleFactor,
    isMobile: viewport.isMobile,
    hasTouch: viewport.hasTouch,
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
    network: browserProbeNetworkReviewSummary(input.network, input.files.network),
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

function browserProbeNetworkReviewSummary(network: BrowserProbeNetworkRecord[], artifact?: BrowserProbeArtifactRef): BrowserProbeNetworkReviewSummary {
  if (!artifact) {
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
    waterfall: artifact,
  }
}

function addBrowserProbeNetworkCount(target: Record<string, BrowserProbeNetworkCountSummary>, key: string, record: BrowserProbeNetworkRecord): void {
  const summary = target[key] ?? { requests: 0, responses: 0, failures: 0, transferSizeBytes: 0 }
  summary.requests += 1
  if (record.type === "response") {
    summary.responses += 1
  }
  if (record.type === "requestfailed") {
    summary.failures += 1
  }
  summary.transferSizeBytes += typeof record.transferSize === "number" && Number.isFinite(record.transferSize) ? record.transferSize : 0
  target[key] = summary
}

function sortBrowserProbeNetworkCounts(value: Record<string, BrowserProbeNetworkCountSummary>): Record<string, BrowserProbeNetworkCountSummary> {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
}

function requestHost(url: string): string | undefined {
  try {
    return new URL(url).host
  } catch {
    return undefined
  }
}

function browserProbeArtifactRefs(browserFilesDirectory: string, capture: Set<string>, input: {
  checkpoints: boolean
  console: boolean
  errors: boolean
  html?: string
  lifecycle: boolean
  memory: boolean
  network: boolean
  performance: boolean
  redirectDiagnostics: boolean
  screenshot?: string
  wordpressDiagnostics: boolean
}): Record<string, BrowserProbeArtifactRef> {
  return {
    ...(input.console ? { console: { path: `${browserFilesDirectory}/console.jsonl`, kind: "jsonl" as const } } : {}),
    ...(input.checkpoints ? { checkpoints: { path: `${browserFilesDirectory}/checkpoints.jsonl`, kind: "jsonl" as const } } : {}),
    ...(input.errors ? { errors: { path: `${browserFilesDirectory}/errors.jsonl`, kind: "jsonl" as const } } : {}),
    ...(input.html ? { html: { path: `${browserFilesDirectory}/snapshot.html`, kind: "html" as const, sha256: input.html } } : {}),
    ...(input.lifecycle ? { lifecycle: { path: `${browserFilesDirectory}/lifecycle.json`, kind: "json" as const } } : {}),
    ...(input.memory ? { memory: { path: `${browserFilesDirectory}/memory.json`, kind: "json" as const } } : {}),
    ...(input.network ? { network: { path: `${browserFilesDirectory}/network.jsonl`, kind: "jsonl" as const } } : {}),
    ...(input.performance ? { performance: { path: `${browserFilesDirectory}/performance.json`, kind: "json" as const } } : {}),
    ...(input.redirectDiagnostics ? { redirectDiagnostics: { path: `${browserFilesDirectory}/redirect-diagnostics.json`, kind: "json" as const } } : {}),
    review: { path: `${browserFilesDirectory}/review.json`, kind: "json" as const },
    ...(capture.has("screenshot") ? { screenshot: { path: `${browserFilesDirectory}/screenshot.png`, kind: "png" as const, ...(input.screenshot ? { sha256: input.screenshot } : {}) } } : {}),
    ...(input.wordpressDiagnostics ? { wordpressDiagnostics: { path: `${browserFilesDirectory}/wordpress-diagnostics.json`, kind: "json" as const } } : {}),
    summary: { path: `${browserFilesDirectory}/summary.json`, kind: "json" as const },
  }
}

function safeBrowserProbeUrl(value: string | undefined): string | null {
  if (!value) {
    return null
  }
  if (/^data:/i.test(value)) {
    return "data:[redacted]"
  }
  return value
}

interface BrowserRedirectDiagnosticsArtifact {
  schema: "wp-codebox/browser-redirect-diagnostics/v1"
  version: 1
  capturedAt: string
  status: BrowserRedirectDiagnosticsSummary["status"]
  classification: BrowserRedirectDiagnosticsSummary["classification"]
  reason: string
  error?: { name: string; message: string }
  chain: BrowserRedirectDiagnosticsChainEntry[]
  summary: BrowserRedirectDiagnosticsSummary
}

interface BrowserRedirectDiagnosticsChainEntry {
  url: string
  method: string
  status?: number
  statusText?: string
  timestamp: string
  host?: string
  path?: string
  queryKeys: string[]
  redactedQueryKeys: string[]
}

function browserRedirectDiagnosticsArtifact({
  artifactPath,
  error,
  finalAttemptedUrl,
  network,
  requestedUrl,
}: {
  artifactPath: string
  error?: Error
  finalAttemptedUrl: string
  network: BrowserProbeNetworkRecord[]
  requestedUrl: string
}): BrowserRedirectDiagnosticsArtifact | undefined {
  const errorMessage = error?.message ?? ""
  const tooManyRedirects = /ERR_TOO_MANY_REDIRECTS/i.test(errorMessage)
  const documentEvents = network.filter((record) => record.resourceType === "document")
  const redirectResponses = documentEvents.filter((record) => record.type === "response" && typeof record.status === "number" && record.status >= 300 && record.status < 400)
  const chain = documentEvents.map(browserRedirectDiagnosticsChainEntry)
  const repeatedUrls = repeatedBrowserRedirectValues(chain.map((entry) => entry.url), "url")
  const repeatedHosts = repeatedBrowserRedirectValues(chain.map((entry) => entry.host).filter((host): host is string => Boolean(host)), "host")
  const repeatedPaths = repeatedBrowserRedirectValues(chain.map((entry) => entry.path).filter((path): path is string => Boolean(path)), "path")
  const hasRepeatedTarget = repeatedUrls.length > 0 || repeatedHosts.length > 0 || repeatedPaths.length > 0

  if (!tooManyRedirects && redirectResponses.length === 0 && !hasRepeatedTarget) {
    return undefined
  }

  const finalAttempted = browserRedirectSafeUrl(extractBrowserNavigationUrl(errorMessage) ?? finalAttemptedUrl)
  const firstUrl = chain[0]?.url ?? browserRedirectSafeUrl(requestedUrl)
  const lastUrl = chain.at(-1)?.url ?? finalAttempted
  const sanitizedQueryKeys = [...new Set(chain.flatMap((entry) => entry.queryKeys))].sort()
  const redactedQueryKeys = [...new Set(chain.flatMap((entry) => entry.redactedQueryKeys))].sort()
  const classification: BrowserRedirectDiagnosticsSummary["classification"] = tooManyRedirects || hasRepeatedTarget ? "redirect-loop" : "redirect-chain"
  const reason = tooManyRedirects
    ? "playwright reported ERR_TOO_MANY_REDIRECTS"
    : hasRepeatedTarget ? "document navigation repeated URL, host, or path values" : "document navigation included redirect responses"
  const summary: BrowserRedirectDiagnosticsSummary = {
    status: "captured",
    artifact: artifactPath,
    classification,
    reason,
    documentEvents: chain.length,
    redirectResponses: redirectResponses.length,
    repeatedUrls,
    repeatedHosts,
    repeatedPaths,
    ...(firstUrl ? { firstUrl } : {}),
    ...(lastUrl ? { lastUrl } : {}),
    ...(finalAttempted ? { finalAttemptedUrl: finalAttempted } : {}),
    sanitizedQueryKeys,
    redactedQueryKeys,
  }

  return {
    schema: "wp-codebox/browser-redirect-diagnostics/v1",
    version: 1,
    capturedAt: now(),
    status: "captured",
    classification,
    reason,
    ...(error ? { error: { name: error.name, message: sanitizeBrowserRedirectMessage(error.message) } } : {}),
    chain,
    summary,
  }
}

function browserRedirectDiagnosticsChainEntry(record: BrowserProbeNetworkRecord): BrowserRedirectDiagnosticsChainEntry {
  const parsed = parseBrowserRedirectUrl(record.url)
  return {
    url: browserRedirectSafeUrl(record.url),
    method: record.method,
    ...(typeof record.status === "number" ? { status: record.status } : {}),
    ...(record.statusText ? { statusText: record.statusText } : {}),
    timestamp: record.timestamp,
    ...(parsed ? { host: parsed.host, path: parsed.pathname } : {}),
    queryKeys: parsed?.queryKeys ?? [],
    redactedQueryKeys: parsed?.redactedQueryKeys ?? [],
  }
}

function browserRedirectSafeUrl(value: string): string {
  if (/^data:/i.test(value)) {
    return "data:[redacted]"
  }
  const parsed = parseBrowserRedirectUrl(value)
  if (!parsed) {
    return value
  }
  const search = parsed.queryKeys.length > 0
    ? `?${parsed.queryKeys.map((key) => `${encodeURIComponent(key)}=[redacted]`).join("&")}`
    : ""
  return `${parsed.origin}${parsed.pathname}${search}${parsed.hash ? "#[redacted]" : ""}`
}

function parseBrowserRedirectUrl(value: string): { origin: string; host: string; pathname: string; hash: string; queryKeys: string[]; redactedQueryKeys: string[] } | undefined {
  try {
    const url = new URL(value)
    const queryKeys = [...new Set([...url.searchParams.keys()])].sort()
    return {
      origin: url.origin,
      host: url.host,
      pathname: url.pathname || "/",
      hash: url.hash,
      queryKeys,
      redactedQueryKeys: queryKeys.filter(isSensitiveBrowserRedirectQueryKey),
    }
  } catch {
    return undefined
  }
}

function isSensitiveBrowserRedirectQueryKey(key: string): boolean {
  const tokens = key.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  return tokens.some((token) => ["auth", "bearer", "code", "cookie", "credential", "key", "login", "nonce", "pass", "password", "secret", "session", "state", "token"].includes(token))
}

function repeatedBrowserRedirectValues<Key extends "url" | "host" | "path">(values: string[], key: Key): Array<Record<Key, string> & { count: number }> {
  const counts = new Map<string, number>()
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .sort(([leftValue, leftCount], [rightValue, rightCount]) => rightCount - leftCount || leftValue.localeCompare(rightValue))
    .map(([value, count]) => ({ [key]: value, count }) as Record<Key, string> & { count: number })
}

function extractBrowserNavigationUrl(message: string): string | undefined {
  return message.match(/\bat\s+(https?:\/\/\S+)/i)?.[1]?.replace(/[),.]+$/, "")
}

function sanitizeBrowserRedirectMessage(message: string): string {
  return message.replace(/https?:\/\/[^\s"')]+/gi, (url) => browserRedirectSafeUrl(url.replace(/[),.]+$/, "")))
}

interface BrowserWordPressDiagnosticRecord {
  schema: "wp-codebox/browser-wordpress-diagnostic-record/v1"
  classification: "php-fatal"
  severity: "error"
  errorType: number
  message: string
  file: string
  line: number
  capturedAt: string
}

interface BrowserWordPressDiagnosticsArtifact {
  schema: "wp-codebox/browser-wordpress-diagnostics/v1"
  version: 1
  capturedAt: string
  status: BrowserWordPressDiagnosticsSummary["status"]
  document5xxResponses: Array<{ url: string; status: number; statusText?: string }>
  diagnostics: BrowserWordPressDiagnosticRecord[]
  summary: BrowserWordPressDiagnosticsSummary
}

const BROWSER_WORDPRESS_DIAGNOSTICS_LOG = "/wordpress/wp-content/wp-codebox-browser-diagnostics.jsonl"
const BROWSER_WORDPRESS_DIAGNOSTICS_MU_PLUGIN = "/wordpress/wp-content/mu-plugins/000-wp-codebox-browser-diagnostics.php"
const BROWSER_WORDPRESS_DIAGNOSTICS_PLUGIN = `<?php
/**
 * Plugin Name: WP Codebox Browser Diagnostics
 */

if ( ! defined( 'WPINC' ) ) {
    return;
}

register_shutdown_function(
    static function (): void {
        $error = error_get_last();
        if ( ! is_array( $error ) ) {
            return;
        }

        $fatal_types = array( E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR, E_USER_ERROR, E_RECOVERABLE_ERROR );
        if ( ! in_array( $error['type'] ?? null, $fatal_types, true ) ) {
            return;
        }

        $record = array(
            'schema'         => 'wp-codebox/browser-wordpress-diagnostic-record/v1',
            'classification' => 'php-fatal',
            'severity'       => 'error',
            'errorType'      => (int) ( $error['type'] ?? 0 ),
            'message'        => (string) ( $error['message'] ?? '' ),
            'file'           => (string) ( $error['file'] ?? '' ),
            'line'           => (int) ( $error['line'] ?? 0 ),
            'capturedAt'     => gmdate( 'c' ),
        );

        file_put_contents( WP_CONTENT_DIR . '/wp-codebox-browser-diagnostics.jsonl', wp_json_encode( $record ) . "\n", FILE_APPEND | LOCK_EX );
    }
);
`

async function installBrowserWordPressDiagnostics(
  runPlaygroundCommand: ((command: string, server: PlaygroundCliServer, options: { code: string } | { scriptPath: string }) => Promise<PlaygroundRunResponse>) | undefined,
  server: PlaygroundCliServer,
): Promise<boolean> {
  if (runPlaygroundCommand) {
    try {
      const response = await runPlaygroundCommand("wordpress.browser-diagnostics-setup", server, {
        code: `<?php
$directory = '/wordpress/wp-content/mu-plugins';
if (!is_dir($directory)) {
    mkdir($directory, 0777, true);
}
file_put_contents(${JSON.stringify(BROWSER_WORDPRESS_DIAGNOSTICS_MU_PLUGIN)}, base64_decode(${JSON.stringify(Buffer.from(BROWSER_WORDPRESS_DIAGNOSTICS_PLUGIN, "utf8").toString("base64"))}));
file_put_contents(${JSON.stringify(BROWSER_WORDPRESS_DIAGNOSTICS_LOG)}, '');
`,
      })
      assertPlaygroundResponseOk("wordpress.browser-diagnostics-setup", response)
      return true
    } catch {
      // Browser diagnostics are best-effort; preserve the browser command outcome.
    }
  }

  if (!server.playground.writeFile) {
    return false
  }

  try {
    await server.playground.writeFile(BROWSER_WORDPRESS_DIAGNOSTICS_MU_PLUGIN, BROWSER_WORDPRESS_DIAGNOSTICS_PLUGIN)
    await server.playground.writeFile(BROWSER_WORDPRESS_DIAGNOSTICS_LOG, "")
    return true
  } catch {
    return false
  }
}

async function browserWordPressDiagnosticsArtifact({
  artifactPath,
  network,
  ready,
  server,
}: {
  artifactPath: string
  network: BrowserProbeNetworkRecord[]
  ready: boolean
  server: PlaygroundCliServer
}): Promise<BrowserWordPressDiagnosticsArtifact | undefined> {
  const document5xxResponses = network
    .filter((record) => record.type === "response" && record.resourceType === "document" && typeof record.status === "number" && record.status >= 500 && record.status < 600)
    .map((record) => ({
      url: safeBrowserProbeUrl(record.url) ?? record.url,
      status: record.status as number,
      ...(record.statusText ? { statusText: record.statusText } : {}),
    }))

  if (document5xxResponses.length === 0) {
    return undefined
  }

  const diagnostics = ready ? await readBrowserWordPressDiagnostics(server) : []
  const fatalErrors = diagnostics.filter((diagnostic) => diagnostic.classification === "php-fatal").length
  const classifications = [...new Set(diagnostics.map((diagnostic) => diagnostic.classification))].sort()
  const status: BrowserWordPressDiagnosticsSummary["status"] = !ready
    ? "unavailable"
    : diagnostics.length > 0 ? "captured" : "clean"
  const summary: BrowserWordPressDiagnosticsSummary = {
    status,
    artifact: artifactPath,
    document5xxResponses: document5xxResponses.length,
    diagnostics: diagnostics.length,
    fatalErrors,
    classifications,
  }

  return {
    schema: "wp-codebox/browser-wordpress-diagnostics/v1",
    version: 1,
    capturedAt: now(),
    status,
    document5xxResponses,
    diagnostics,
    summary,
  }
}

async function readBrowserWordPressDiagnostics(server: PlaygroundCliServer): Promise<BrowserWordPressDiagnosticRecord[]> {
  if (!server.playground.readFileAsText) {
    return []
  }

  let contents = ""
  try {
    contents = await server.playground.readFileAsText(BROWSER_WORDPRESS_DIAGNOSTICS_LOG)
  } catch {
    return []
  }

  return contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseBrowserWordPressDiagnosticRecord)
    .filter((record): record is BrowserWordPressDiagnosticRecord => Boolean(record))
}

function parseBrowserWordPressDiagnosticRecord(line: string): BrowserWordPressDiagnosticRecord | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined
  }

  const record = parsed as Record<string, unknown>
  if (record.schema !== "wp-codebox/browser-wordpress-diagnostic-record/v1" || record.classification !== "php-fatal") {
    return undefined
  }

  return {
    schema: "wp-codebox/browser-wordpress-diagnostic-record/v1",
    classification: "php-fatal",
    severity: "error",
    errorType: typeof record.errorType === "number" && Number.isFinite(record.errorType) ? record.errorType : 0,
    message: typeof record.message === "string" ? record.message : "",
    file: typeof record.file === "string" ? record.file : "",
    line: typeof record.line === "number" && Number.isFinite(record.line) ? record.line : 0,
    capturedAt: typeof record.capturedAt === "string" ? record.capturedAt : now(),
  }
}

export async function runHtmlCaptureCommand(input: {
  artifactRoot: string
  runtimeSpec: RuntimeCreateSpec
  runPlaygroundCommand?: (command: string, server: PlaygroundCliServer, options: { code: string } | { scriptPath: string }) => Promise<PlaygroundRunResponse>
  server: PlaygroundCliServer
  spec: ExecutionSpec
}): Promise<{ artifact: BrowserArtifact; output: string }> {
  const args = [...(input.spec.args ?? [])]
  if (!args.some((arg) => arg.startsWith("capture="))) {
    args.push("capture=html,console,errors,network")
  }

  return runBrowserProbeCommand({
    ...input,
    command: "wordpress.capture-html",
    spec: { ...input.spec, args },
  })
}

export async function runEditorCanvasProbeCommand({
  artifactRoot,
  runtimeSpec,
  server,
  spec,
}: {
  artifactRoot: string
  runtimeSpec: RuntimeCreateSpec
  server: PlaygroundCliServer
  spec: ExecutionSpec
}): Promise<{ artifact: BrowserArtifact; output: string }> {
  const args = spec.args ?? []
  const urlArg = argValue(args, "url")?.trim()
  if (!urlArg) {
    throw new Error("wordpress.editor-canvas-probe requires url=<path-or-url>")
  }

  const capture = new Set(commaListArg(args, "capture"))
  if (strictBooleanArg(args, "screenshot", false)) {
    capture.add("screenshot")
  }
  for (const item of capture) {
    if (item !== "screenshot") {
      throw new Error(`wordpress.editor-canvas-probe capture supports screenshot: ${item}`)
    }
  }

  const iframeSelector = argValue(args, "iframe-selector")?.trim() || argValue(args, "iframeSelector")?.trim() || EDITOR_CANVAS_DEFAULT_IFRAME_SELECTOR
  const layoutSelector = argValue(args, "layout-selector")?.trim() || argValue(args, "layoutSelector")?.trim() || EDITOR_CANVAS_DEFAULT_LAYOUT_SELECTOR
  const blockSelector = argValue(args, "block-selector")?.trim() || argValue(args, "blockSelector")?.trim() || EDITOR_CANVAS_DEFAULT_BLOCK_SELECTOR
  const timeoutMs = editorCanvasTimeoutMs(args)
  const selectorGroups = editorCanvasSelectorGroups(args, layoutSelector, blockSelector)
  const preview = browserPreviewRouting(args, runtimeSpec, server.serverUrl)
  const previewOrigins = browserPreviewOrigins(preview)
  const targetUrl = resolveBrowserPreviewUrl(urlArg, preview.effectiveOrigin)
  const browserDirectory = join(artifactRoot, "files", "browser")
  await mkdir(browserDirectory, { recursive: true })

  const summaryPath = join(browserDirectory, "editor-canvas-summary.json")
  const screenshotPath = join(browserDirectory, "editor-canvas-screenshot.png")
  const startedAt = now()
  const startedAtMs = Date.now()
  const browser = await launchChromiumBrowser()
  const errors: BrowserProbeErrorRecord[] = []
  let artifact: BrowserArtifact | undefined
  let finalUrl = targetUrl
  let windowLocationOrigin: string | undefined
  let viewport: BrowserProbeViewport | null = null
  let screenshotSha256: string | undefined
  let pendingError: Error | undefined

  try {
    const previewReadinessError = browserPreviewReadinessError(preview)
    if (previewReadinessError) {
      throw previewReadinessError
    }

    const page = await browser.newPage()
    viewport = await browserProbeViewport(page)
    attachBrowserCaptureListeners({
      captureConsole: false,
      captureErrors: true,
      captureNetwork: false,
      consoleMessages: [],
      errors,
      network: [],
      page,
    })
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs })
    finalUrl = page.url()
    const browserLocation = await page.evaluate(() => ({ origin: window.location.origin, secureContext: window.isSecureContext })).catch(() => undefined)
    windowLocationOrigin = browserLocation?.origin
    preview.secureContext = browserLocation?.secureContext
    const secureContextError = browserPreviewSecureContextError(preview)
    if (secureContextError) {
      throw secureContextError
    }

    const probe = await waitForEditorCanvasProbe(page, {
      blockSelector,
      iframeSelector,
      layoutSelector,
      selectorGroups,
      startedAtMs,
      timeoutMs,
    })

    if (probe.ready && capture.has("screenshot")) {
      try {
        await probe.frame.locator(layoutSelector).first().screenshot({ path: screenshotPath, timeout: timeoutMs })
        screenshotSha256 = await fileSha256(screenshotPath)
      } catch (error) {
        probe.summary.diagnostics.push({
          code: "screenshot-failed",
          severity: "warning",
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const summary = probe.summary
    artifact = {
      artifactType: "probe",
      requestedUrl: targetUrl,
      url: targetUrl,
      preview,
      ...previewOrigins,
      files: {
        ...(screenshotSha256 ? { screenshot: "files/browser/editor-canvas-screenshot.png" } : {}),
        summary: "files/browser/editor-canvas-summary.json",
      },
      summary: {
        consoleMessages: 0,
        errors: errors.length,
        finalUrl,
        ...(windowLocationOrigin ? { windowLocationOrigin } : {}),
        htmlSnapshot: false,
        networkEvents: 0,
        replayability: screenshotSha256 ? "artifact-backed" : "diagnostic-only",
        screenshot: Boolean(screenshotSha256),
        viewport,
        editorCanvas: summary,
      },
    }

    await writeFile(summaryPath, `${JSON.stringify({
      schema: "wp-codebox/editor-canvas-probe/v1",
      requestedUrl: targetUrl,
      preview,
      ...previewOrigins,
      finalUrl,
      ...(windowLocationOrigin ? { windowLocationOrigin } : {}),
      startedAt,
      finishedAt: now(),
      timeoutMs,
      files: artifact.files,
      hashes: {
        ...(screenshotSha256 ? { screenshot: { algorithm: "sha256", value: screenshotSha256 } } : {}),
      },
      viewport,
      summary,
    }, null, 2)}\n`)

    if (!summary.ready) {
      pendingError = new Error(`wordpress.editor-canvas-probe failed: ${summary.diagnostics.map((diagnostic) => diagnostic.code).join(", ") || "not-ready"}`)
    }
  } catch (error) {
    pendingError = error instanceof Error ? error : new Error(String(error))
    errors.push(serializeBrowserError("probe-error", error))
    if (!artifact) {
      const diagnostics: BrowserEditorCanvasProbeDiagnostic[] = [{ code: "timeout", severity: "error", message: pendingError.message }]
      const summary: BrowserEditorCanvasProbeSummary = {
        ready: false,
        readyMs: null,
        iframeSelector,
        layoutSelector,
        blockSelector,
        diagnostics,
        selectorSummary: emptyEditorCanvasSelectorSummary(selectorGroups),
      }
      artifact = {
        artifactType: "probe",
        requestedUrl: targetUrl,
        url: targetUrl,
        preview,
        ...previewOrigins,
        files: { summary: "files/browser/editor-canvas-summary.json" },
        summary: {
          consoleMessages: 0,
          errors: errors.length,
          finalUrl,
          htmlSnapshot: false,
          networkEvents: 0,
          replayability: "diagnostic-only",
          screenshot: false,
          viewport,
          editorCanvas: summary,
        },
      }
      await writeFile(summaryPath, `${JSON.stringify({
        schema: "wp-codebox/editor-canvas-probe/v1",
        requestedUrl: targetUrl,
        preview,
        ...previewOrigins,
        finalUrl,
        startedAt,
        finishedAt: now(),
        timeoutMs,
        files: artifact.files,
        hashes: {},
        viewport,
        summary,
      }, null, 2)}\n`)
    }
  } finally {
    await browser.close()
  }

  if (pendingError) {
    throw new BrowserCommandArtifactError(pendingError.message, artifact)
  }

  return {
    artifact,
    output: `${JSON.stringify({
      command: "wordpress.editor-canvas-probe",
      requestedUrl: targetUrl,
      finalUrl: artifact.summary.finalUrl,
      files: artifact.files,
      summary: artifact.summary.editorCanvas,
    }, null, 2)}\n`,
  }
}

interface EditorCanvasSelectorGroupInput {
  name: string
  selectors: string[]
}

interface EditorCanvasReadyProbe {
  ready: boolean
  frame: import("playwright").Frame
  summary: BrowserEditorCanvasProbeSummary
}

async function waitForEditorCanvasProbe(page: import("playwright").Page, options: {
  blockSelector: string
  iframeSelector: string
  layoutSelector: string
  selectorGroups: EditorCanvasSelectorGroupInput[]
  startedAtMs: number
  timeoutMs: number
}): Promise<EditorCanvasReadyProbe> {
  const deadlineMs = Date.now() + options.timeoutMs
  let frame: import("playwright").Frame | null = null
  let latest: Awaited<ReturnType<typeof evaluateEditorCanvasState>> | null = null

  while (Date.now() <= deadlineMs) {
    frame = await resolveEditorCanvasFrame(page, options.iframeSelector)
    if (frame) {
      latest = await evaluateEditorCanvasState(frame, options.layoutSelector, options.blockSelector, options.selectorGroups)
      if (latest.ready) {
        return {
          ready: true,
          frame,
          summary: {
            ready: true,
            readyMs: Date.now() - options.startedAtMs,
            iframeSelector: options.iframeSelector,
            layoutSelector: options.layoutSelector,
            blockSelector: options.blockSelector,
            diagnostics: latest.diagnostics,
            selectorSummary: latest.selectorSummary,
          },
        }
      }
    }
    await page.waitForTimeout(100)
  }

  const diagnostics = latest?.diagnostics.length
    ? [...latest.diagnostics, { code: "timeout", severity: "error", message: `Editor canvas was not ready within ${options.timeoutMs}ms.` } satisfies BrowserEditorCanvasProbeDiagnostic]
    : [{ code: "iframe-missing", severity: "error", message: `Editor canvas iframe was not found: ${options.iframeSelector}` }, { code: "timeout", severity: "error", message: `Editor canvas was not ready within ${options.timeoutMs}ms.` }] satisfies BrowserEditorCanvasProbeDiagnostic[]

  return {
    ready: false,
    frame: frame ?? page.mainFrame(),
    summary: {
      ready: false,
      readyMs: null,
      iframeSelector: options.iframeSelector,
      layoutSelector: options.layoutSelector,
      blockSelector: options.blockSelector,
      diagnostics,
      selectorSummary: latest?.selectorSummary ?? emptyEditorCanvasSelectorSummary(options.selectorGroups),
    },
  }
}

async function resolveEditorCanvasFrame(page: import("playwright").Page, iframeSelector: string): Promise<import("playwright").Frame | null> {
  const namedFrame = page.frame({ name: "editor-canvas" })
  if (namedFrame) {
    return namedFrame
  }
  const handle = await page.locator(iframeSelector).elementHandle().catch(() => null)
  return handle ? await handle.contentFrame() : null
}

async function evaluateEditorCanvasState(frame: import("playwright").Frame, layoutSelector: string, blockSelector: string, selectorGroups: EditorCanvasSelectorGroupInput[]): Promise<{
  ready: boolean
  diagnostics: BrowserEditorCanvasProbeDiagnostic[]
  selectorSummary: BrowserEditorCanvasSelectorSummary
}> {
  return frame.evaluate(({ layoutSelector: innerLayoutSelector, blockSelector: innerBlockSelector, selectorGroups: innerSelectorGroups }) => {
    function elementVisible(element: Element): boolean {
      const rect = element.getBoundingClientRect()
      const style = window.getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0
    }

    function summarizeSelector(selector: string) {
      try {
        const matches = Array.from(document.querySelectorAll(selector)).map((element) => {
          const rect = element.getBoundingClientRect()
          return {
            visible: elementVisible(element),
            boundingBox: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
            text: String(element.textContent || "").trim().replace(/\s+/g, " ").slice(0, 160),
          }
        })
        return {
          selector,
          count: matches.length,
          visible_count: matches.filter((match) => match.visible).length,
          nonzero_bounding_box_count: matches.filter((match) => match.boundingBox.width > 0 && match.boundingBox.height > 0).length,
          first_match: matches[0] || null,
          error: "",
        }
      } catch (error) {
        return {
          selector,
          count: 0,
          visible_count: 0,
          nonzero_bounding_box_count: 0,
          first_match: null,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }

    const layout = document.querySelector(innerLayoutSelector)
    const diagnostics: BrowserEditorCanvasProbeDiagnostic[] = []
    if (!layout) {
      diagnostics.push({ code: "layout-missing", severity: "error", message: `Editor canvas layout was not found: ${innerLayoutSelector}` })
    }
    const loading = Boolean(layout?.matches('.is-loading, [aria-busy="true"]') || layout?.querySelector('.is-loading, [aria-busy="true"], .components-spinner'))
    if (loading) {
      diagnostics.push({ code: "loading-state", severity: "warning", message: "Editor canvas layout is still marked as loading." })
    }
    const blocks = layout ? Array.from(layout.querySelectorAll(innerBlockSelector)) : []
    if (layout && blocks.length === 0) {
      diagnostics.push({ code: "no-blocks", severity: "error", message: `Editor canvas has no blocks matching: ${innerBlockSelector}` })
    }
    const rect = layout?.getBoundingClientRect()
    const ready = Boolean(layout && rect && rect.width > 0 && rect.height > 0 && !loading && blocks.length > 0)

    const groups = innerSelectorGroups.map((group) => {
      const selectors = group.selectors.map(summarizeSelector)
      return {
        name: group.name,
        selectors,
        selector_count: selectors.length,
        missing_selector_count: selectors.filter((item) => item.count === 0).length,
        errored_selector_count: selectors.filter((item) => item.error).length,
        matched_selector_count: selectors.filter((item) => item.count > 0).length,
        visible_selector_count: selectors.filter((item) => item.visible_count > 0).length,
        nonzero_bounding_box_selector_count: selectors.filter((item) => item.nonzero_bounding_box_count > 0).length,
      }
    })

    return {
      ready,
      diagnostics,
      selectorSummary: {
        groups,
        totals: groups.reduce((totals, group) => {
          totals.selector_count += group.selector_count
          totals.missing_selector_count += group.missing_selector_count
          totals.errored_selector_count += group.errored_selector_count
          totals.matched_selector_count += group.matched_selector_count
          totals.visible_selector_count += group.visible_selector_count
          totals.nonzero_bounding_box_selector_count += group.nonzero_bounding_box_selector_count
          return totals
        }, {
          selector_count: 0,
          missing_selector_count: 0,
          errored_selector_count: 0,
          matched_selector_count: 0,
          visible_selector_count: 0,
          nonzero_bounding_box_selector_count: 0,
        }),
      },
    }
  }, { layoutSelector, blockSelector, selectorGroups })
}

function editorCanvasSelectorGroups(args: string[], layoutSelector: string, blockSelector: string): EditorCanvasSelectorGroupInput[] {
  const groups = jsonArrayArg(args, "selector-groups-json")
  if (groups.length === 0) {
    return [
      { name: "editor_canvas", selectors: [layoutSelector] },
      { name: "blocks", selectors: [blockSelector] },
    ]
  }

  return groups.map((group, index) => {
    if (!group || typeof group !== "object" || Array.isArray(group)) {
      throw new Error(`wordpress.editor-canvas-probe selector-groups-json[${index}] must be an object`)
    }
    const input = group as Record<string, unknown>
    const selectors = Array.isArray(input.selectors) ? input.selectors : [input.selector].filter(Boolean)
    const normalizedSelectors = selectors.map((selector) => String(selector || "").trim()).filter(Boolean)
    if (normalizedSelectors.length === 0) {
      throw new Error(`wordpress.editor-canvas-probe selector-groups-json[${index}] requires selector or selectors`)
    }
    return {
      name: String(input.name || `group_${index + 1}`),
      selectors: normalizedSelectors,
    }
  })
}

function emptyEditorCanvasSelectorSummary(groups: EditorCanvasSelectorGroupInput[]): BrowserEditorCanvasSelectorSummary {
  return {
    groups: groups.map((group): BrowserEditorCanvasSelectorGroupSummary => ({
      name: group.name,
      selectors: group.selectors.map((selector) => ({ selector, count: 0, visible_count: 0, nonzero_bounding_box_count: 0, first_match: null, error: "" })),
      selector_count: group.selectors.length,
      missing_selector_count: group.selectors.length,
      errored_selector_count: 0,
      matched_selector_count: 0,
      visible_selector_count: 0,
      nonzero_bounding_box_selector_count: 0,
    })),
    totals: {
      selector_count: groups.reduce((total, group) => total + group.selectors.length, 0),
      missing_selector_count: groups.reduce((total, group) => total + group.selectors.length, 0),
      errored_selector_count: 0,
      matched_selector_count: 0,
      visible_selector_count: 0,
      nonzero_bounding_box_selector_count: 0,
    },
  }
}

function editorCanvasTimeoutMs(args: string[]): number {
  const rawMs = argValue(args, "timeout-ms") ?? argValue(args, "timeoutMs")
  if (rawMs) {
    const parsed = Number.parseInt(rawMs, 10)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`wordpress.editor-canvas-probe timeout-ms must be a positive integer: ${rawMs}`)
    }
    return parsed
  }
  return durationArg(args, "timeout", EDITOR_CANVAS_DEFAULT_TIMEOUT_MS)
}

export async function runBrowserActionsCommand({
  artifactRoot,
  plan,
  runtimeSpec,
  runPlaygroundCommand,
  server,
  spec,
}: {
  artifactRoot: string
  plan?: BrowserActionsRunPlan
  runtimeSpec: RuntimeCreateSpec
  runPlaygroundCommand?: (command: string, server: PlaygroundCliServer, options: { code: string } | { scriptPath: string }) => Promise<PlaygroundRunResponse>
  server: PlaygroundCliServer
  spec: ExecutionSpec
}): Promise<{ artifact: BrowserArtifact; output: string }> {
  const args = spec.args ?? []
  const runPlan = plan ?? await browserActionsRunPlanFromArgs(args)
  const steps = [...runPlan.steps]
  const initialUrl = runPlan.initialUrl
  if (steps.length === 0 && !initialUrl) {
    throw new Error("wordpress.browser-actions requires steps-json=<array> or url=<path-or-url>")
  }

  if (initialUrl && steps[0]?.kind !== "navigate") {
    steps.unshift({ kind: "navigate", url: initialUrl })
  }

  // evaluate (arbitrary page JS) is gated by a dedicated policy capability,
  // mirroring how wordpress.run-php is gated. Non-JS interaction steps are
  // allowed whenever wordpress.browser-actions itself is allowed.
  if (browserInteractionScriptUsesEvaluate(steps)) {
    assertRuntimeCommandAllowed("wordpress.browser-actions.evaluate", runtimeSpec.policy)
  }

  const capture = runPlan.capture

  for (const item of capture) {
    if (!["steps", "console", "errors", "html", "network", "screenshot", "dom-snapshot"].includes(item)) {
      throw new Error(`wordpress.browser-actions capture supports steps, console, errors, html, network, screenshot, dom-snapshot: ${item}`)
    }
  }

  const stepTimeoutMs = runPlan.stepTimeoutMs
  const totalTimeoutMs = runPlan.totalTimeoutMs
  const requestedViewport = runPlan.requestedViewport
  const authRequest = runPlan.authRequest
  const maxDomSnapshotElements = runPlan.maxDomSnapshotElements
  const routedHosts = commaListArg(args, "route-host")

  const browserDirectory = join(artifactRoot, "files", "browser")
  await mkdir(browserDirectory, { recursive: true })

  const stepRecords: BrowserStepRecord[] = []
  const consoleMessages: Record<string, unknown>[] = []
  const errors: BrowserProbeErrorRecord[] = []
  const network: BrowserProbeNetworkRecord[] = []
  const networkTasks: Array<Promise<void>> = []
  const stepsPath = join(browserDirectory, "steps.jsonl")
  const consolePath = join(browserDirectory, "console.jsonl")
  const errorsPath = join(browserDirectory, "errors.jsonl")
  const htmlPath = join(browserDirectory, "snapshot.html")
  const networkPath = join(browserDirectory, "network.jsonl")
  const screenshotPath = join(browserDirectory, "screenshot.png")
  const domSnapshotPath = join(browserDirectory, "dom-snapshot.json")
  const summaryPath = join(browserDirectory, "action-summary.json")
  const redirectDiagnosticsPath = join(browserDirectory, "redirect-diagnostics.json")
  const wordpressDiagnosticsPath = join(browserDirectory, "wordpress-diagnostics.json")
  const startedAt = now()
  const startedAtMs = Date.now()
  const browser = await launchChromiumBrowser()
  const preview = browserPreviewRouting(args, runtimeSpec, server.serverUrl)
  const networkPolicy = browserPreviewNetworkPolicy(args, routedHosts, preview)
  const previewOrigins = browserPreviewOrigins(preview)
  let requestedUrl = initialUrl ? resolveBrowserPreviewUrl(initialUrl, preview.effectiveOrigin) : preview.effectiveOrigin
  let finalUrl = requestedUrl
  let htmlSha256: string | undefined
  let screenshotSha256: string | undefined
  const domSnapshots: Array<{ screenshot: string; snapshot: string; step?: { index: number; name?: string; kind: string }; elementCount: number; capturedElements: number; truncated: boolean }> = []
  let viewport: BrowserProbeViewport | null = null
  let authSummary: BrowserProbeAuthSummary | undefined
  let pendingError: Error | undefined
  let artifact: BrowserArtifact | undefined
  let wordpressDiagnosticsReady = false

  try {
    const context = browserPreviewNeedsContextRouting(networkPolicy) ? await browser.newContext() : null
    if (context) {
      await routeBrowserPreviewContextNetwork(context, networkPolicy, preview.localOrigin)
    }
    const page = context ? await context.newPage() : await browser.newPage()
    if (authRequest) {
      authSummary = await installWordPressAdminAuthCookies({ command: "wordpress.browser-actions", cookieUrls: browserAuthCookieUrls(server.serverUrl, routedHosts, browserActionTargetUrls(steps, preview.effectiveOrigin, requestedUrl)), page, runPlaygroundCommand, runtimeSpec, server, userId: authRequest.userId })
    }
    if (requestedViewport) {
      await page.setViewportSize(requestedViewport)
    }
    wordpressDiagnosticsReady = await installBrowserWordPressDiagnostics(runPlaygroundCommand, server)
    viewport = await browserProbeViewport(page)
    attachBrowserCaptureListeners({
      captureConsole: capture.has("console"),
      captureErrors: capture.has("errors"),
      captureNetwork: true,
      consoleMessages,
      errors,
      network,
      networkTasks,
      page,
    })

    for (const [index, step] of steps.entries()) {
      const recordStartedAt = now()
      const recordStartedAtMs = Date.now()
      // Total-script timeout: stop before starting a step that would exceed the budget.
      if (totalTimeoutMs > 0 && recordStartedAtMs - startedAtMs >= totalTimeoutMs) {
        const timeoutError = new Error(`wordpress.browser-actions exceeded total timeout of ${totalTimeoutMs}ms before step ${index} (${step.kind})`)
        const serialized = serializeBrowserError("probe-error", timeoutError)
        errors.push(serialized)
        stepRecords.push(browserStepRecord(index, step, "failed", recordStartedAt, recordStartedAtMs, page.url(), { error: serialized }))
        pendingError = timeoutError
        break
      }
      try {
        const outcome = await executeBrowserInteractionStep(page, step, preview.effectiveOrigin, stepTimeoutMs, screenshotPath, browserDirectory)
        finalUrl = page.url()
        if (step.kind === "navigate") {
          requestedUrl = resolveBrowserPreviewUrl((step.url ?? "").trim(), preview.effectiveOrigin)
        }
        if (outcome.screenshot && capture.has("screenshot") && outcome.screenshotIsDefault) {
          screenshotSha256 = await fileSha256(screenshotPath)
        }
        if (outcome.screenshot && capture.has("dom-snapshot")) {
          domSnapshots.push(await captureBrowserActionDomSnapshot({
            browserDirectory,
            finalUrl,
            maxElements: maxDomSnapshotElements,
            page,
            screenshotRef: outcome.screenshot,
            step: { index, kind: step.kind, ...(typeof step.name === "string" ? { name: step.name } : {}) },
            viewport,
          }))
        }
        // A failed expect/evaluate assertion is a clean step failure: no silent partial success.
        if (outcome.assertion && !outcome.assertion.passed) {
          stepRecords.push(browserStepRecord(index, step, "failed", recordStartedAt, recordStartedAtMs, finalUrl, outcome))
          pendingError = new Error(`wordpress.browser-actions ${step.kind} assertion failed at step ${index}`)
          break
        }
        stepRecords.push(browserStepRecord(index, step, "ok", recordStartedAt, recordStartedAtMs, finalUrl, outcome))
      } catch (error) {
        const serialized = serializeBrowserError("probe-error", error)
        errors.push(serialized)
        stepRecords.push(browserStepRecord(index, step, "failed", recordStartedAt, recordStartedAtMs, page.url(), { error: serialized }))
        pendingError = error instanceof Error ? error : new Error(String(error))
        break
      }
    }

    if (capture.has("html")) {
      try {
        const html = await page.content()
        await writeFile(htmlPath, html)
        htmlSha256 = sha256(Buffer.from(html, "utf8"))
      } catch (error) {
        const serialized = serializeBrowserError("probe-error", error)
        errors.push(serialized)
        if (!pendingError) {
          pendingError = error instanceof Error ? error : new Error(String(error))
        }
      }
    }

    if (capture.has("screenshot")) {
      try {
        await page.screenshot({ path: screenshotPath, fullPage: true })
        screenshotSha256 = await fileSha256(screenshotPath)
        if (capture.has("dom-snapshot")) {
          domSnapshots.push(await captureBrowserActionDomSnapshot({
            outputPath: domSnapshotPath,
            finalUrl,
            maxElements: maxDomSnapshotElements,
            page,
            screenshotRef: "files/browser/screenshot.png",
            snapshotRef: "files/browser/dom-snapshot.json",
            viewport,
          }))
        }
      } catch (error) {
        const serialized = serializeBrowserError("probe-error", error)
        errors.push(serialized)
        if (!pendingError) {
          pendingError = error instanceof Error ? error : new Error(String(error))
        }
      }
    }
  } finally {
    await settleBrowserNetworkTasks(networkTasks)
    await browser.close()
    if (capture.has("steps")) {
      await writeFile(stepsPath, jsonLines(stepRecords))
    }
    if (capture.has("console")) {
      await writeFile(consolePath, jsonLines(consoleMessages))
    }
    if (capture.has("errors")) {
      await writeFile(errorsPath, jsonLines(errors))
    }
    if (capture.has("network")) {
      await writeFile(networkPath, jsonLines(network))
    }

    const redirectDiagnostics = browserRedirectDiagnosticsArtifact({
      artifactPath: "files/browser/redirect-diagnostics.json",
      error: pendingError,
      finalAttemptedUrl: finalUrl,
      network,
      requestedUrl,
    })
    if (redirectDiagnostics) {
      await writeFile(redirectDiagnosticsPath, `${JSON.stringify(redirectDiagnostics, null, 2)}\n`)
    }
    const redirectDiagnosticsSummary = redirectDiagnostics?.summary

    const wordpressDiagnostics = await browserWordPressDiagnosticsArtifact({
      artifactPath: "files/browser/wordpress-diagnostics.json",
      network,
      ready: wordpressDiagnosticsReady,
      server,
    })
    if (wordpressDiagnostics) {
      await writeFile(wordpressDiagnosticsPath, `${JSON.stringify(wordpressDiagnostics, null, 2)}\n`)
    }
    const wordpressDiagnosticsSummary = wordpressDiagnostics?.summary

    const assertions = browserAssertionsSummary(stepRecords)
    artifact = {
      artifactType: "actions",
      requestedUrl,
      url: requestedUrl,
      preview,
      ...(browserPreviewNetworkPolicyIsActive(networkPolicy) ? { networkPolicy: browserPreviewNetworkPolicySummary(networkPolicy) } : {}),
      ...previewOrigins,
      files: {
        ...(capture.has("steps") ? { steps: "files/browser/steps.jsonl" } : {}),
        ...(capture.has("console") ? { console: "files/browser/console.jsonl" } : {}),
        ...(capture.has("errors") ? { errors: "files/browser/errors.jsonl" } : {}),
        ...(htmlSha256 ? { html: "files/browser/snapshot.html" } : {}),
        ...(capture.has("network") ? { network: "files/browser/network.jsonl" } : {}),
        ...(redirectDiagnostics ? { redirectDiagnostics: "files/browser/redirect-diagnostics.json" } : {}),
        ...(capture.has("screenshot") ? { screenshot: "files/browser/screenshot.png" } : {}),
        ...(domSnapshots.length > 0 ? { domSnapshots: domSnapshots.map((snapshot) => snapshot.snapshot) } : {}),
        ...(wordpressDiagnostics ? { wordpressDiagnostics: "files/browser/wordpress-diagnostics.json" } : {}),
        summary: "files/browser/action-summary.json",
      },
      summary: {
        actions: stepRecords.length,
        steps: stepRecords.length,
        ...(assertions.total > 0 ? { assertions } : {}),
        consoleMessages: consoleMessages.length,
        errors: errors.length,
        finalUrl,
        htmlSnapshot: Boolean(htmlSha256),
        ...(browserPreviewNetworkPolicyIsActive(networkPolicy) ? { networkPolicy: browserPreviewNetworkPolicySummary(networkPolicy) } : {}),
        ...(domSnapshots.length > 0 ? { domSnapshots } : {}),
        networkEvents: network.length,
        ...(redirectDiagnosticsSummary ? { redirectDiagnostics: redirectDiagnosticsSummary } : {}),
        ...(wordpressDiagnosticsSummary ? { wordpressDiagnostics: wordpressDiagnosticsSummary } : {}),
        replayability: browserProbeReplayability(capture),
        screenshot: capture.has("screenshot"),
        auth: authSummary,
        viewport,
      },
    }
    await writeFile(summaryPath, `${JSON.stringify({
      schema: "wp-codebox/browser-actions/v1",
      requestedUrl,
      preview,
      finalUrl,
      capture: [...capture].sort(),
      stepTimeoutMs,
      totalTimeoutMs,
      steps: stepRecords,
      ...(assertions.total > 0 ? { assertions } : {}),
      startedAt,
      finishedAt: now(),
      files: artifact.files,
      hashes: {
        ...(htmlSha256 ? { html: { algorithm: "sha256", value: htmlSha256 } } : {}),
        ...(screenshotSha256 ? { screenshot: { algorithm: "sha256", value: screenshotSha256 } } : {}),
      },
      limits: {
        maxDomSnapshotElements,
      },
      ...(redirectDiagnosticsSummary ? { redirectDiagnostics: redirectDiagnosticsSummary } : {}),
      ...(wordpressDiagnosticsSummary ? { wordpressDiagnostics: wordpressDiagnosticsSummary } : {}),
      viewport,
      summary: artifact.summary,
    }, null, 2)}\n`)
  }

  if (pendingError) {
    throw new BrowserCommandArtifactError(`wordpress.browser-actions failed after ${stepRecords.length} step(s): ${pendingError.message}`, artifact)
  }

  return {
    artifact,
    output: `${JSON.stringify({
      command: "wordpress.browser-actions",
      requestedUrl,
      preview,
      finalUrl: artifact.summary.finalUrl ?? finalUrl,
      files: artifact.files,
      summary: artifact.summary,
      steps: stepRecords,
    }, null, 2)}\n`,
  }
}

async function browserActionsRunPlanFromArgs(args: string[]): Promise<BrowserActionsRunPlan> {
  const capture = new Set(commaListArg(args, "capture").map((item) => item === "actions" ? "steps" : item))
  if (capture.size === 0) {
    capture.add("steps")
    capture.add("console")
    capture.add("errors")
    capture.add("network")
    capture.add("html")
    capture.add("screenshot")
    capture.add("dom-snapshot")
  }
  return {
    initialUrl: argValue(args, "url")?.trim(),
    steps: await browserInteractionStepsFromArgs(args),
    capture,
    stepTimeoutMs: durationArg(args, "step-timeout", BROWSER_STEP_DEFAULT_TIMEOUT_MS),
    totalTimeoutMs: durationArg(args, "timeout", BROWSER_SCRIPT_DEFAULT_TIMEOUT_MS),
    requestedViewport: viewportArg(args, "viewport"),
    authRequest: browserAuthRequest(args),
    maxDomSnapshotElements: positiveIntegerArg(args, "max-dom-snapshot-elements", 160),
  }
}

async function captureBrowserActionDomSnapshot({
  browserDirectory,
  finalUrl,
  maxElements,
  outputPath,
  page,
  screenshotRef,
  snapshotRef,
  step,
  viewport,
}: {
  browserDirectory?: string
  finalUrl: string
  maxElements: number
  outputPath?: string
  page: Page
  screenshotRef: string
  snapshotRef?: string
  step?: { index: number; name?: string; kind: string }
  viewport: BrowserProbeViewport | null
}): Promise<{ screenshot: string; snapshot: string; step?: { index: number; name?: string; kind: string }; elementCount: number; capturedElements: number; truncated: boolean }> {
  const sanitizedName = step?.name ? sanitizeScreenshotName(step.name) : undefined
  const relativeSnapshotRef = snapshotRef ?? `files/browser/dom-snapshot-${sanitizedName || `step-${step?.index ?? 0}`}.json`
  const snapshotPath = outputPath ?? join(browserDirectory ?? dirname(relativeSnapshotRef), relativeSnapshotRef.replace(/^files\/browser\//, ""))
  const snapshot = await captureVisualCompareDomSnapshot(page, maxElements)
  const artifact: VisualCompareDomSnapshotArtifact = {
    schema: "wp-codebox/browser-dom-snapshot/v1",
    command: "wordpress.browser-actions",
    screenshot: screenshotRef,
    ...(step ? { step } : {}),
    finalUrl,
    viewport,
    capturedAt: now(),
    limits: { maxElements },
    summary: {
      elementCount: snapshot.elementCount,
      capturedElements: snapshot.capturedElements.length,
      truncated: snapshot.truncated,
    },
    snapshot,
  }
  await writeFile(snapshotPath, `${JSON.stringify(artifact, null, 2)}\n`)
  return {
    screenshot: screenshotRef,
    snapshot: relativeSnapshotRef,
    ...(step ? { step } : {}),
    elementCount: snapshot.elementCount,
    capturedElements: snapshot.capturedElements.length,
    truncated: snapshot.truncated,
  }
}

interface BrowserScenarioInput {
  url?: string
  profile?: string
  captures?: string[]
  prePageScript?: string
  observers?: Array<Record<string, unknown>>
  steps?: Array<Record<string, unknown>>
  assertions?: Array<Record<string, unknown>>
  viewport?: string
  device?: string
  locale?: string
  auth?: string
  authUserId?: string | number
  waitFor?: string
  duration?: string
  stepTimeout?: string
  timeout?: string
}

export async function runBrowserScenarioCommand({
  artifactRoot,
  runtimeSpec,
  runPlaygroundCommand,
  server,
  spec,
}: {
  artifactRoot: string
  runtimeSpec: RuntimeCreateSpec
  runPlaygroundCommand?: (command: string, server: PlaygroundCliServer, options: { code: string } | { scriptPath: string }) => Promise<PlaygroundRunResponse>
  server: PlaygroundCliServer
  spec: ExecutionSpec
}): Promise<{ artifact: BrowserArtifact; output: string }> {
  const args = spec.args ?? []
  const scenario = await browserScenarioFromArgs(args)
  const url = scenario.url?.trim() || argValue(args, "url")?.trim()
  if (!url) {
    throw new Error("wordpress.browser-scenario requires url=<path-or-url> or scenario-json.url")
  }

  const runPlan = browserScenarioRunPlan(scenario, args, url)
  const startedAt = now()
  const browserDirectory = join(artifactRoot, "files", "browser")
  await mkdir(browserDirectory, { recursive: true })

  let probeResult: Awaited<ReturnType<typeof runBrowserProbeCommand>> | undefined
  let actionsResult: Awaited<ReturnType<typeof runBrowserActionsCommand>> | undefined
  let pendingError: Error | undefined

  if (runPlan.probe) {
    try {
      probeResult = await runBrowserProbeCommand({ artifactRoot, plan: runPlan.probe, runtimeSpec, runPlaygroundCommand, server, spec: { ...spec, command: "wordpress.browser-probe", args } })
    } catch (error) {
      if (isBrowserCommandArtifactError(error) && error.artifact.artifactType === "probe") {
        probeResult = { artifact: error.artifact, output: "" }
      }
      pendingError = error instanceof Error ? error : new Error(String(error))
    }
  }

  if (!pendingError && runPlan.actions) {
    try {
      actionsResult = await runBrowserActionsCommand({ artifactRoot, plan: runPlan.actions, runtimeSpec, runPlaygroundCommand, server, spec: { ...spec, command: "wordpress.browser-actions", args } })
    } catch (error) {
      if (isBrowserCommandArtifactError(error) && error.artifact.artifactType === "actions") {
        actionsResult = { artifact: error.artifact, output: "" }
      }
      pendingError = error instanceof Error ? error : new Error(String(error))
    }
  }

  const primaryArtifact = actionsResult?.artifact ?? probeResult?.artifact
  if (!primaryArtifact) {
    throw pendingError ?? new Error("wordpress.browser-scenario did not produce a browser artifact")
  }

  const finalUrl = primaryArtifact.summary.finalUrl
  const scenarioSummaryPath = join(browserDirectory, "scenario-summary.json")
  const scenarioSummary = {
    schema: "wp-codebox/browser-scenario/v1",
    requestedUrl: primaryArtifact.requestedUrl,
    url: primaryArtifact.url,
    localPreviewOrigin: primaryArtifact.localPreviewOrigin,
    requestedPreviewOrigin: primaryArtifact.requestedPreviewOrigin,
    effectivePreviewOrigin: primaryArtifact.effectivePreviewOrigin,
    finalUrl,
    profile: runPlan.profile,
    capture: runPlan.capture,
    startedAt,
    finishedAt: now(),
    context: primaryArtifact.summary.context,
    auth: primaryArtifact.summary.auth,
    viewport: primaryArtifact.summary.viewport,
    files: {
      ...(probeResult ? { probeSummary: probeResult.artifact.files.summary } : {}),
      ...(actionsResult ? { actionSummary: actionsResult.artifact.files.summary } : {}),
      scenarioSummary: "files/browser/scenario-summary.json",
    },
    summary: {
      probe: probeResult ? probeResult.artifact.summary : undefined,
      actions: actionsResult ? actionsResult.artifact.summary : undefined,
      assertions: actionsResult?.artifact.summary.assertions ?? probeResult?.artifact.summary.assertions,
      auth: primaryArtifact.summary.auth,
    },
  }
  await writeFile(scenarioSummaryPath, `${JSON.stringify(scenarioSummary, null, 2)}\n`)

  const artifact: BrowserArtifact = {
    ...primaryArtifact,
    artifactType: "scenario",
    files: {
      ...primaryArtifact.files,
      summary: "files/browser/scenario-summary.json",
    },
    summary: {
      ...primaryArtifact.summary,
      actions: actionsResult?.artifact.summary.actions ?? primaryArtifact.summary.actions,
      steps: actionsResult?.artifact.summary.steps ?? primaryArtifact.summary.steps,
      assertions: actionsResult?.artifact.summary.assertions ?? probeResult?.artifact.summary.assertions,
      context: primaryArtifact.summary.context,
      auth: primaryArtifact.summary.auth,
      finalUrl,
    },
  }

  if (pendingError) {
    throw new BrowserCommandArtifactError(`wordpress.browser-scenario failed: ${pendingError.message}`, artifact)
  }

  return {
    artifact,
    output: `${JSON.stringify({
      command: "wordpress.browser-scenario",
      requestedUrl: artifact.requestedUrl,
      finalUrl,
      files: artifact.files,
      summary: artifact.summary,
      scenario: scenarioSummary,
    }, null, 2)}\n`,
  }
}

async function browserScenarioFromArgs(args: string[]): Promise<BrowserScenarioInput> {
  const raw = argValue(args, "scenario-json")
  if (!raw) {
    return {}
  }
  const text = raw.startsWith("@") ? await readFile(raw.slice(1), "utf8") : raw
  const parsed = JSON.parse(text) as unknown
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("wordpress.browser-scenario scenario-json must be a JSON object")
  }
  return parsed as BrowserScenarioInput
}

function browserScenarioCaptures(scenario: BrowserScenarioInput, args: string[]): string[] {
  const raw = scenario.captures ?? commaListArg(args, "capture")
  const captures = Array.isArray(raw) ? raw.map(String).filter(Boolean) : []
  return captures.length > 0 ? captures : ["steps", "console", "errors", "html", "network", "screenshot", "dom-snapshot"]
}

function browserScenarioRunPlan(scenario: BrowserScenarioInput, args: string[], url: string): BrowserRunPlan {
  const captures = browserScenarioCaptures(scenario, args)
  const steps = browserScenarioSteps(scenario, args)
  const assertions = browserScenarioAssertions(scenario)
  const actionSteps = [...steps, ...assertions]
  const requestedViewport = browserScenarioViewport(scenario, args)
  const device = scenario.device ?? (scenario.profile && scenario.profile !== "desktop-chrome" ? scenario.profile : undefined) ?? argValue(args, "device")
  const locale = scenario.locale ?? argValue(args, "locale")
  const prePageScript = scenario.prePageScript ?? browserScenarioObserverScript(scenario.observers) ?? argValue(args, "pre-page-script")
  const authRequest = browserScenarioAuthRequest(scenario.auth ?? argValue(args, "auth"), scenario.authUserId ?? argValue(args, "auth-user-id"))
  const shouldRunProbe = actionSteps.length === 0 || Boolean(prePageScript) || captures.some((capture) => capture === "performance" || capture === "memory")

  const plan: BrowserRunPlan = {
    profile: scenario.profile ?? "desktop-chrome",
    capture: captures,
  }

  if (shouldRunProbe) {
    plan.probe = {
      url,
      capture: new Set(browserScenarioProbeCaptures(captures, actionSteps.length > 0)),
      waitFor: scenario.waitFor ?? argValue(args, "wait-for") ?? "domcontentloaded",
      durationMs: durationStringMs(scenario.duration ?? argValue(args, "duration")),
      requestedViewport: requestedViewport ? parseBrowserViewport(requestedViewport, "viewport") : undefined,
      requestedContext: {
        ...(device ? { device } : {}),
        ...(locale ? { locale } : {}),
        ...(requestedViewport ? { viewport: parseBrowserViewport(requestedViewport, "viewport") } : {}),
      },
      prePageScript,
      authRequest,
      failFast: false,
      stallTimeoutMs: 0,
      lifecycleSelectors: [],
      assertions: [],
    }
  }

  if (actionSteps.length > 0) {
    const validation = validateBrowserInteractionScript(actionSteps)
    if (!validation.valid) {
      throw new Error(`wordpress.browser-scenario steps/assertions are invalid: ${validation.issues.map((issue) => `[${issue.index}] ${issue.message}`).join("; ")}`)
    }
    plan.actions = {
      initialUrl: url,
      steps: validation.steps,
      capture: new Set(browserScenarioActionCaptures(captures)),
      stepTimeoutMs: durationStringMs(scenario.stepTimeout ?? argValue(args, "step-timeout")) || BROWSER_STEP_DEFAULT_TIMEOUT_MS,
      totalTimeoutMs: durationStringMs(scenario.timeout ?? argValue(args, "timeout")) || BROWSER_SCRIPT_DEFAULT_TIMEOUT_MS,
      requestedViewport: requestedViewport ? parseBrowserViewport(requestedViewport, "viewport") : undefined,
      authRequest,
      maxDomSnapshotElements: positiveIntegerArg(args, "max-dom-snapshot-elements", 160),
    }
  }

  return plan
}

function browserScenarioProbeCaptures(captures: string[], actionsWillRun: boolean): string[] {
  const supported = new Set(["console", "errors", "html", "network", "performance", "memory", "screenshot"])
  const selected = captures.filter((capture) => supported.has(capture) && (!actionsWillRun || capture === "performance" || capture === "memory"))
  return selected.length > 0 ? selected : ["console", "errors", "html", "network", "screenshot"]
}

function browserScenarioActionCaptures(captures: string[]): string[] {
  const supported = new Set(["steps", "console", "errors", "html", "network", "screenshot", "dom-snapshot"])
  const selected = captures.filter((capture) => supported.has(capture))
  return selected.length > 0 ? selected : ["steps", "console", "errors", "html", "network", "screenshot", "dom-snapshot"]
}

function browserScenarioSteps(scenario: BrowserScenarioInput, args: string[]): Array<Record<string, unknown>> {
  const raw = scenario.steps ?? parseInlineJsonArrayArg(args, "steps-json")
  return (raw ?? []).map((step) => normalizeBrowserScenarioStep(step))
}

function browserScenarioAssertions(scenario: BrowserScenarioInput): Array<Record<string, unknown>> {
  return (scenario.assertions ?? []).map((assertion) => normalizeBrowserScenarioAssertion(assertion))
}

function normalizeBrowserScenarioStep(step: Record<string, unknown>): Record<string, unknown> {
  const type = typeof step.type === "string" ? step.type : undefined
  const kind = typeof step.kind === "string" ? step.kind : type
  if (kind === "wait" && typeof step.ms === "number") {
    return { kind: "waitFor", waitFor: "duration", duration: `${step.ms}ms` }
  }
  if (kind === "scrollTo" && typeof step.selector === "string") {
    return { kind: "evaluate", expression: `document.querySelector(${JSON.stringify(step.selector)})?.scrollIntoView({ block: "center", inline: "center" })` }
  }
  if (kind === "wait") {
    return { ...step, kind: "waitFor" }
  }
  const { type: _type, ...rest } = step
  return { ...rest, kind }
}

function normalizeBrowserScenarioAssertion(assertion: Record<string, unknown>): Record<string, unknown> {
  if (assertion.type === "selectorVisible" && typeof assertion.selector === "string") {
    return { kind: "expect", selector: assertion.selector, state: "visible", ...(typeof assertion.withinMs === "number" ? { timeout: `${assertion.withinMs}ms` } : {}) }
  }
  if (assertion.type === "noPageErrors") {
    return { kind: "evaluate", expression: "window.__wpCodeboxBrowserErrors?.length ?? 0", assert: 0 }
  }
  if (typeof assertion.type === "string") {
    const { type: _type, ...rest } = assertion
    return { ...rest, kind: assertion.type }
  }
  return assertion
}

function parseInlineJsonArrayArg(args: string[], name: string): Array<Record<string, unknown>> | undefined {
  const raw = argValue(args, name)
  if (!raw || raw.startsWith("@")) {
    return undefined
  }
  const parsed = JSON.parse(raw) as unknown
  if (!Array.isArray(parsed)) {
    throw new Error(`wordpress.browser-scenario ${name} must be a JSON array`)
  }
  return parsed as Array<Record<string, unknown>>
}

function browserScenarioViewport(scenario: BrowserScenarioInput, args: string[]): string | undefined {
  if (scenario.viewport) return scenario.viewport
  return argValue(args, "viewport")
}

function parseBrowserViewport(raw: string, name: string): { width: number; height: number } {
  const match = raw.trim().match(/^(\d+)x(\d+)$/i)
  if (!match) {
    throw new Error(`${name} must use <width>x<height>, for example 390x844: ${raw}`)
  }
  const width = Number.parseInt(match[1] ?? "", 10)
  const height = Number.parseInt(match[2] ?? "", 10)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`${name} width and height must be positive integers: ${raw}`)
  }
  return { width, height }
}

function browserScenarioAuthRequest(auth: string | undefined, authUserId: string | number | undefined): { userId: number } | undefined {
  if (!auth) {
    return undefined
  }
  if (auth !== "wordpress-admin") {
    throw new Error(`Browser auth supports wordpress-admin: ${auth}`)
  }
  const parsedUserId = typeof authUserId === "number" ? authUserId : Number.parseInt(authUserId ?? "1", 10)
  return { userId: Number.isFinite(parsedUserId) && parsedUserId > 0 ? parsedUserId : 1 }
}

function browserScenarioObserverScript(observers: Array<Record<string, unknown>> | undefined): string | undefined {
  if (!observers || observers.length === 0) {
    return undefined
  }
  return `window.__wpCodeboxBrowserScenarioObservers = ${JSON.stringify(observers)}; window.__wpCodeboxBrowserErrors = []; window.addEventListener("error", (event) => window.__wpCodeboxBrowserErrors.push({ message: event.message, filename: event.filename, lineno: event.lineno, colno: event.colno }));`
}

export async function runEditorOpenCommand({
  artifactRoot,
  runPlaygroundCommand,
  runtimeSpec,
  server,
  spec,
}: {
  artifactRoot: string
  runPlaygroundCommand: (command: string, server: PlaygroundCliServer, options: { code: string } | { scriptPath: string }) => Promise<PlaygroundRunResponse>
  runtimeSpec: RuntimeCreateSpec
  server: PlaygroundCliServer
  spec: ExecutionSpec
}): Promise<{ artifact: BrowserArtifact; output: string }> {
  const args = spec.args ?? []
  const target = editorOpenTargetFromArgs(args)
  const capture = new Set(commaListArg(args, "capture"))
  if (capture.size === 0) {
    capture.add("steps")
    capture.add("console")
    capture.add("errors")
    capture.add("html")
    capture.add("screenshot")
    capture.add("editor-state")
  }
  for (const item of capture) {
    if (!["steps", "console", "errors", "html", "screenshot", "editor-state"].includes(item)) {
      throw new Error(`wordpress.editor-open capture supports steps, console, errors, html, screenshot, editor-state: ${item}`)
    }
  }

  const waitTimeoutMs = durationArg(args, "wait-timeout", BROWSER_STEP_DEFAULT_TIMEOUT_MS)
  const routedHosts = commaListArg(args, "route-host")
  const preview = browserPreviewRouting(args, runtimeSpec, server.serverUrl)
  const networkPolicy = browserPreviewNetworkPolicy(args, routedHosts, preview)
  const previewOrigins = browserPreviewOrigins(preview)
  const targetUrl = resolveBrowserPreviewUrl(target.url, preview.effectiveOrigin)
  const browserDirectory = join(artifactRoot, "files", "browser")
  await mkdir(browserDirectory, { recursive: true })

  const stepRecords: BrowserStepRecord[] = []
  const consoleMessages: Record<string, unknown>[] = []
  const errors: BrowserProbeErrorRecord[] = []
  const stepsPath = join(browserDirectory, "editor-steps.jsonl")
  const consolePath = join(browserDirectory, "editor-console.jsonl")
  const errorsPath = join(browserDirectory, "editor-errors.jsonl")
  const htmlPath = join(browserDirectory, "editor-snapshot.html")
  const screenshotPath = join(browserDirectory, "editor-screenshot.png")
  const editorStatePath = join(browserDirectory, "editor-state.json")
  const summaryPath = join(browserDirectory, "editor-summary.json")
  const startedAt = now()
  const browser = await launchChromiumBrowser()
  let finalUrl = targetUrl
  let htmlSha256: string | undefined
  let screenshotSha256: string | undefined
  let viewport: BrowserProbeViewport | null = null
  let editorState: EditorStateSnapshot | undefined
  let authSummary: BrowserProbeAuthSummary | undefined
  let pendingError: Error | undefined
  let artifact: BrowserArtifact | undefined

  try {
    const context = browserPreviewNeedsContextRouting(networkPolicy) ? await browser.newContext() : null
    if (context) {
      await routeBrowserPreviewContextNetwork(context, networkPolicy, preview.localOrigin)
    }
    const page = context ? await context.newPage() : await browser.newPage()
    authSummary = await installWordPressAdminAuthCookies({ command: "wordpress.editor-open", cookieUrls: browserAuthCookieUrls(server.serverUrl, routedHosts, [targetUrl]), page, runPlaygroundCommand, runtimeSpec, server, userId: 1 })
    viewport = await browserProbeViewport(page)
    attachBrowserCaptureListeners({
      captureConsole: capture.has("console"),
      captureErrors: capture.has("errors"),
      captureNetwork: false,
      consoleMessages,
      errors,
      network: [],
      page,
    })

    const navigateStartedAt = now()
    const navigateStartedAtMs = Date.now()
    try {
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: waitTimeoutMs })
      finalUrl = page.url()
      stepRecords.push(browserStepRecord(0, { kind: "navigate", url: target.url }, "ok", navigateStartedAt, navigateStartedAtMs, finalUrl, {}))
    } catch (error) {
      const serialized = serializeBrowserError("probe-error", error)
      errors.push(serialized)
      stepRecords.push(browserStepRecord(0, { kind: "navigate", url: target.url }, "failed", navigateStartedAt, navigateStartedAtMs, page.url(), { error: serialized }))
      pendingError = error instanceof Error ? error : new Error(String(error))
    }

    if (!pendingError) {
      const waitStartedAt = now()
      const waitStartedAtMs = Date.now()
      try {
        await waitForAnyVisibleSelector(page, target.waitSelector, waitTimeoutMs)
        finalUrl = page.url()
        stepRecords.push(browserStepRecord(1, { kind: "waitFor", selector: target.waitSelector }, "ok", waitStartedAt, waitStartedAtMs, finalUrl, {}))
      } catch (error) {
        const serialized = serializeBrowserError("probe-error", error)
        errors.push(serialized)
        stepRecords.push(browserStepRecord(1, { kind: "waitFor", selector: target.waitSelector }, "failed", waitStartedAt, waitStartedAtMs, page.url(), { error: serialized }))
        pendingError = error instanceof Error ? error : new Error(String(error))
      }
    }

    if (capture.has("editor-state")) {
      editorState = await captureEditorState(page, target)
      await writeFile(editorStatePath, `${JSON.stringify(editorState, null, 2)}\n`)
    }
    if (capture.has("html")) {
      const html = await page.content()
      await writeFile(htmlPath, html)
      htmlSha256 = sha256(Buffer.from(html, "utf8"))
    }
    if (capture.has("screenshot")) {
      await page.screenshot({ path: screenshotPath, fullPage: true })
      screenshotSha256 = await fileSha256(screenshotPath)
    }
  } finally {
    await browser.close()
    if (capture.has("steps")) {
      await writeFile(stepsPath, jsonLines(stepRecords))
    }
    if (capture.has("console")) {
      await writeFile(consolePath, jsonLines(consoleMessages))
    }
    if (capture.has("errors")) {
      await writeFile(errorsPath, jsonLines(errors))
    }

    const editorSummary = editorState ? summarizeEditorState(target, editorState) : undefined
    artifact = {
      artifactType: "editor-open",
      requestedUrl: targetUrl,
      url: targetUrl,
      preview,
      ...(browserPreviewNetworkPolicyIsActive(networkPolicy) ? { networkPolicy: browserPreviewNetworkPolicySummary(networkPolicy) } : {}),
      ...previewOrigins,
      files: {
        ...(capture.has("steps") ? { steps: "files/browser/editor-steps.jsonl" } : {}),
        ...(capture.has("console") ? { console: "files/browser/editor-console.jsonl" } : {}),
        ...(capture.has("editor-state") ? { editorState: "files/browser/editor-state.json" } : {}),
        ...(capture.has("errors") ? { errors: "files/browser/editor-errors.jsonl" } : {}),
        ...(capture.has("html") ? { html: "files/browser/editor-snapshot.html" } : {}),
        ...(capture.has("screenshot") ? { screenshot: "files/browser/editor-screenshot.png" } : {}),
        summary: "files/browser/editor-summary.json",
      },
      summary: {
        steps: stepRecords.length,
        consoleMessages: consoleMessages.length,
        errors: errors.length,
        finalUrl,
        htmlSnapshot: capture.has("html"),
        auth: authSummary,
        ...(browserPreviewNetworkPolicyIsActive(networkPolicy) ? { networkPolicy: browserPreviewNetworkPolicySummary(networkPolicy) } : {}),
        networkEvents: 0,
        replayability: browserProbeReplayability(capture),
        screenshot: capture.has("screenshot"),
        ...(editorSummary ? { editor: editorSummary } : {}),
        viewport,
      },
    }
    await writeFile(summaryPath, `${JSON.stringify({
      schema: "wp-codebox/editor-open/v1",
      target,
      requestedUrl: targetUrl,
      preview,
      ...(browserPreviewNetworkPolicyIsActive(networkPolicy) ? { networkPolicy: browserPreviewNetworkPolicySummary(networkPolicy) } : {}),
      ...previewOrigins,
      finalUrl,
      capture: [...capture].sort(),
      waitTimeoutMs,
      steps: stepRecords,
      startedAt,
      finishedAt: now(),
      files: artifact.files,
      hashes: {
        ...(htmlSha256 ? { html: { algorithm: "sha256", value: htmlSha256 } } : {}),
        ...(screenshotSha256 ? { screenshot: { algorithm: "sha256", value: screenshotSha256 } } : {}),
      },
      viewport,
      summary: artifact.summary,
    }, null, 2)}\n`)
  }

  if (pendingError) {
    throw new Error(`wordpress.editor-open failed after ${stepRecords.length} step(s): ${pendingError.message}`)
  }

  return {
    artifact,
    output: `${JSON.stringify({
      command: "wordpress.editor-open",
      target,
      requestedUrl: targetUrl,
      preview,
      finalUrl: artifact.summary.finalUrl ?? finalUrl,
      files: artifact.files,
      summary: artifact.summary,
      steps: stepRecords,
    }, null, 2)}\n`,
  }
}

export async function runEditorActionsCommand({
  artifactRoot,
  runPlaygroundCommand,
  runtimeSpec,
  server,
  spec,
}: {
  artifactRoot: string
  runPlaygroundCommand: (command: string, server: PlaygroundCliServer, options: { code: string } | { scriptPath: string }) => Promise<PlaygroundRunResponse>
  runtimeSpec: RuntimeCreateSpec
  server: PlaygroundCliServer
  spec: ExecutionSpec
}): Promise<{ artifact: BrowserArtifact; output: string }> {
  const args = spec.args ?? []
  const target = editorOpenTargetFromArgs(args)
  const actionSteps = await editorActionStepsFromArgs(args)
  const capture = new Set(commaListArg(args, "capture"))
  if (capture.size === 0) {
    capture.add("steps")
    capture.add("console")
    capture.add("errors")
    capture.add("html")
    capture.add("screenshot")
    capture.add("editor-state")
  }
  for (const item of capture) {
    if (!["steps", "console", "errors", "html", "screenshot", "editor-state"].includes(item)) {
      throw new Error(`wordpress.editor-actions capture supports steps, console, errors, html, screenshot, editor-state: ${item}`)
    }
  }

  const waitTimeoutMs = durationArg(args, "wait-timeout", BROWSER_STEP_DEFAULT_TIMEOUT_MS)
  const stepTimeoutMs = durationArg(args, "step-timeout", BROWSER_STEP_DEFAULT_TIMEOUT_MS)
  const totalTimeoutMs = durationArg(args, "timeout", BROWSER_SCRIPT_DEFAULT_TIMEOUT_MS)
  const routedHosts = commaListArg(args, "route-host")
  const preview = browserPreviewRouting(args, runtimeSpec, server.serverUrl)
  const networkPolicy = browserPreviewNetworkPolicy(args, routedHosts, preview)
  const previewOrigins = browserPreviewOrigins(preview)
  const targetUrl = resolveBrowserPreviewUrl(target.url, preview.effectiveOrigin)
  const browserDirectory = join(artifactRoot, "files", "browser")
  await mkdir(browserDirectory, { recursive: true })

  const stepRecords: BrowserStepRecord[] = []
  const consoleMessages: Record<string, unknown>[] = []
  const errors: BrowserProbeErrorRecord[] = []
  const stepsPath = join(browserDirectory, "editor-action-steps.jsonl")
  const consolePath = join(browserDirectory, "editor-action-console.jsonl")
  const errorsPath = join(browserDirectory, "editor-action-errors.jsonl")
  const htmlPath = join(browserDirectory, "editor-action-snapshot.html")
  const screenshotPath = join(browserDirectory, "editor-action-screenshot.png")
  const editorStatePath = join(browserDirectory, "editor-action-state.json")
  const summaryPath = join(browserDirectory, "editor-action-summary.json")
  const startedAt = now()
  const startedAtMs = Date.now()
  const browser = await launchChromiumBrowser()
  let finalUrl = targetUrl
  let htmlSha256: string | undefined
  let screenshotSha256: string | undefined
  let viewport: BrowserProbeViewport | null = null
  let editorState: EditorStateSnapshot | undefined
  let authSummary: BrowserProbeAuthSummary | undefined
  let pendingError: Error | undefined
  let artifact: BrowserArtifact | undefined

  try {
    const context = browserPreviewNeedsContextRouting(networkPolicy) ? await browser.newContext() : null
    if (context) {
      await routeBrowserPreviewContextNetwork(context, networkPolicy, preview.localOrigin)
    }
    const page = context ? await context.newPage() : await browser.newPage()
    authSummary = await installWordPressAdminAuthCookies({ command: "wordpress.editor-actions", cookieUrls: browserAuthCookieUrls(server.serverUrl, routedHosts, [targetUrl]), page, runPlaygroundCommand, runtimeSpec, server, userId: 1 })
    viewport = await browserProbeViewport(page)
    attachBrowserCaptureListeners({
      captureConsole: capture.has("console"),
      captureErrors: capture.has("errors"),
      captureNetwork: false,
      consoleMessages,
      errors,
      network: [],
      page,
    })

    const navigateStartedAt = now()
    const navigateStartedAtMs = Date.now()
    try {
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: waitTimeoutMs })
      finalUrl = page.url()
      stepRecords.push(browserStepRecord(0, { kind: "navigate", url: target.url }, "ok", navigateStartedAt, navigateStartedAtMs, finalUrl, {}))
    } catch (error) {
      const serialized = serializeBrowserError("probe-error", error)
      errors.push(serialized)
      stepRecords.push(browserStepRecord(0, { kind: "navigate", url: target.url }, "failed", navigateStartedAt, navigateStartedAtMs, page.url(), { error: serialized }))
      pendingError = error instanceof Error ? error : new Error(String(error))
    }

    if (!pendingError) {
      const waitStartedAt = now()
      const waitStartedAtMs = Date.now()
      try {
        await waitForAnyVisibleSelector(page, target.waitSelector, waitTimeoutMs)
        finalUrl = page.url()
        stepRecords.push(browserStepRecord(1, { kind: "waitFor", selector: target.waitSelector }, "ok", waitStartedAt, waitStartedAtMs, finalUrl, {}))
      } catch (error) {
        const serialized = serializeBrowserError("probe-error", error)
        errors.push(serialized)
        stepRecords.push(browserStepRecord(1, { kind: "waitFor", selector: target.waitSelector }, "failed", waitStartedAt, waitStartedAtMs, page.url(), { error: serialized }))
        pendingError = error instanceof Error ? error : new Error(String(error))
      }
    }

    for (const [index, step] of actionSteps.entries()) {
      if (pendingError) break
      if (Date.now() - startedAtMs > totalTimeoutMs) {
        pendingError = new Error(`wordpress.editor-actions exceeded total timeout of ${totalTimeoutMs}ms before step ${index} (${step.kind})`)
        break
      }
      const actionStartedAt = now()
      const actionStartedAtMs = Date.now()
      try {
        const state = await executeEditorActionStep(page, step, stepTimeoutMs)
        if (state) {
          editorState = { schema: "wp-codebox/editor-state/v1", capturedAt: now(), target, ...state }
        }
        finalUrl = page.url()
        stepRecords.push(browserStepRecord(index + 2, { kind: step.kind } as never, "ok", actionStartedAt, actionStartedAtMs, finalUrl, {}))
      } catch (error) {
        const serialized = serializeBrowserError("probe-error", error)
        errors.push(serialized)
        stepRecords.push(browserStepRecord(index + 2, { kind: step.kind } as never, "failed", actionStartedAt, actionStartedAtMs, page.url(), { error: serialized }))
        pendingError = error instanceof Error ? error : new Error(String(error))
      }
    }

    if (capture.has("editor-state")) {
      editorState = await captureEditorState(page, target)
      await writeFile(editorStatePath, `${JSON.stringify(editorState, null, 2)}\n`)
    }
    if (capture.has("html")) {
      const html = await page.content()
      await writeFile(htmlPath, html)
      htmlSha256 = sha256(Buffer.from(html, "utf8"))
    }
    if (capture.has("screenshot")) {
      await page.screenshot({ path: screenshotPath, fullPage: true })
      screenshotSha256 = await fileSha256(screenshotPath)
    }
  } finally {
    await browser.close()
    if (capture.has("steps")) {
      await writeFile(stepsPath, jsonLines(stepRecords))
    }
    if (capture.has("console")) {
      await writeFile(consolePath, jsonLines(consoleMessages))
    }
    if (capture.has("errors")) {
      await writeFile(errorsPath, jsonLines(errors))
    }

    const editorSummary = editorState ? summarizeEditorState(target, editorState) : undefined
    artifact = {
      artifactType: "editor-actions",
      requestedUrl: targetUrl,
      url: targetUrl,
      preview,
      ...(browserPreviewNetworkPolicyIsActive(networkPolicy) ? { networkPolicy: browserPreviewNetworkPolicySummary(networkPolicy) } : {}),
      ...previewOrigins,
      files: {
        ...(capture.has("steps") ? { steps: "files/browser/editor-action-steps.jsonl" } : {}),
        ...(capture.has("console") ? { console: "files/browser/editor-action-console.jsonl" } : {}),
        ...(capture.has("editor-state") ? { editorState: "files/browser/editor-action-state.json" } : {}),
        ...(capture.has("errors") ? { errors: "files/browser/editor-action-errors.jsonl" } : {}),
        ...(capture.has("html") ? { html: "files/browser/editor-action-snapshot.html" } : {}),
        ...(capture.has("screenshot") ? { screenshot: "files/browser/editor-action-screenshot.png" } : {}),
        summary: "files/browser/editor-action-summary.json",
      },
      summary: {
        actions: actionSteps.length,
        steps: stepRecords.length,
        consoleMessages: consoleMessages.length,
        errors: errors.length,
        finalUrl,
        htmlSnapshot: capture.has("html"),
        auth: authSummary,
        ...(browserPreviewNetworkPolicyIsActive(networkPolicy) ? { networkPolicy: browserPreviewNetworkPolicySummary(networkPolicy) } : {}),
        networkEvents: 0,
        replayability: browserProbeReplayability(capture),
        screenshot: capture.has("screenshot"),
        ...(editorSummary ? { editor: editorSummary } : {}),
        viewport,
      },
    }
    await writeFile(summaryPath, `${JSON.stringify({
      schema: "wp-codebox/editor-actions/v1",
      target,
      actions: actionSteps,
      requestedUrl: targetUrl,
      preview,
      ...(browserPreviewNetworkPolicyIsActive(networkPolicy) ? { networkPolicy: browserPreviewNetworkPolicySummary(networkPolicy) } : {}),
      ...previewOrigins,
      finalUrl,
      capture: [...capture].sort(),
      waitTimeoutMs,
      stepTimeoutMs,
      totalTimeoutMs,
      steps: stepRecords,
      startedAt,
      finishedAt: now(),
      files: artifact.files,
      hashes: {
        ...(htmlSha256 ? { html: { algorithm: "sha256", value: htmlSha256 } } : {}),
        ...(screenshotSha256 ? { screenshot: { algorithm: "sha256", value: screenshotSha256 } } : {}),
      },
      viewport,
      summary: artifact.summary,
    }, null, 2)}\n`)
  }

  if (pendingError) {
    throw new BrowserCommandArtifactError(`wordpress.editor-actions failed after ${stepRecords.length} step(s): ${pendingError.message}`, artifact)
  }

  return {
    artifact,
    output: `${JSON.stringify({
      command: "wordpress.editor-actions",
      target,
      actions: actionSteps.length,
      requestedUrl: targetUrl,
      preview,
      finalUrl: artifact.summary.finalUrl ?? finalUrl,
      files: artifact.files,
      summary: artifact.summary,
      steps: stepRecords,
    }, null, 2)}\n`,
  }
}

export async function runVisualCompareCommand({
  artifactRoot,
  runtimeSpec,
  server,
  spec,
}: {
  artifactRoot: string
  runtimeSpec?: RuntimeCreateSpec
  server: PlaygroundCliServer
  spec: ExecutionSpec
}): Promise<{ artifact: BrowserArtifact; output: string }> {
  const args = spec.args ?? []
  const matrixJson = argValue(args, "matrix-json")?.trim()
  if (matrixJson) {
    return runVisualCompareMatrixCommand({ artifactRoot, runtimeSpec, server, args, matrixJson })
  }

  return runVisualComparePairCommand({ artifactRoot, runtimeSpec, server, args })
}

async function runVisualComparePairCommand({
  artifactRoot,
  runtimeSpec,
  server,
  args,
  artifactPathPrefix = "files/browser/visual-compare",
}: {
  artifactRoot: string
  runtimeSpec?: RuntimeCreateSpec
  server: PlaygroundCliServer
  args: string[]
  artifactPathPrefix?: string
}): Promise<{ artifact: BrowserArtifact; output: string }> {
  const sourceUrl = argValue(args, "source-url")?.trim()
  const candidateUrl = argValue(args, "candidate-url")?.trim()
  const sourceScreenshot = argValue(args, "source-screenshot")?.trim()
  const candidateScreenshot = argValue(args, "candidate-screenshot")?.trim()
  const sourceDomSnapshotRef = argValue(args, "source-dom-snapshot")?.trim()
  const candidateDomSnapshotRef = argValue(args, "candidate-dom-snapshot")?.trim()
  const baselineRef = (argValue(args, "baseline") ?? argValue(args, "baseline-visual-diff") ?? argValue(args, "baseline-artifact"))?.trim()
  const sourceLabel = argValue(args, "source-label")?.trim() || "source"
  const candidateLabel = argValue(args, "candidate-label")?.trim() || "candidate"
  const waitFor = argValue(args, "wait-for")?.trim() || "domcontentloaded"
  const durationMs = durationArg(args, "duration", 0)
  const requestedViewport = viewportArg(args, "viewport")
  const fullPage = strictBooleanArg(args, "full-page", true)
  const threshold = numberArg(args, "threshold", 0.1)
  const includeAA = strictBooleanArg(args, "include-aa", false)
  const maxRegions = positiveIntegerArg(args, "max-regions", 8)
  const maxExplanationElements = positiveIntegerArg(args, "max-explanation-elements", 25)
  const maxExplanationCandidates = positiveIntegerArg(args, "max-explanation-candidates", 160)
  const explainSelectors = visualCompareExplainSelectors(args)

  if (threshold < 0 || threshold > 1) {
    throw new Error("threshold must be between 0 and 1")
  }
  if (Boolean(sourceUrl) !== Boolean(candidateUrl) || Boolean(sourceScreenshot) !== Boolean(candidateScreenshot)) {
    throw new Error("wordpress.visual-compare requires source-url and candidate-url, or source-screenshot and candidate-screenshot")
  }
  if (Boolean(sourceDomSnapshotRef) !== Boolean(candidateDomSnapshotRef)) {
    throw new Error("wordpress.visual-compare requires both source-dom-snapshot and candidate-dom-snapshot when DOM snapshots are provided")
  }
  if (!sourceUrl && !sourceScreenshot) {
    throw new Error("wordpress.visual-compare requires source-url/candidate-url or source-screenshot/candidate-screenshot")
  }

  const browserDirectory = join(artifactRoot, artifactPathPrefix)
  await mkdir(browserDirectory, { recursive: true })
  const sourcePath = join(browserDirectory, "source.png")
  const candidatePath = join(browserDirectory, "candidate.png")
  const diffPath = join(browserDirectory, "diff.png")
  const visualDiffPath = join(browserDirectory, "visual-diff.json")
  const visualExplanationPath = join(browserDirectory, "visual-explanation.json")
  const summaryPath = join(browserDirectory, "summary.json")
  const startedAt = now()
  const preview = browserPreviewRouting(args, runtimeSpec, server.serverUrl)
  const sourceTargetUrl = sourceUrl ? resolveBrowserPreviewUrl(sourceUrl, preview.effectiveOrigin) : undefined
  const candidateTargetUrl = candidateUrl ? resolveBrowserPreviewUrl(candidateUrl, preview.effectiveOrigin) : undefined
  let finalSourceUrl = sourceTargetUrl
  let finalCandidateUrl = candidateTargetUrl
  let viewport: BrowserProbeViewport | null = null
  let sourceDomSnapshot: VisualCompareDomSnapshot | undefined
  let candidateDomSnapshot: VisualCompareDomSnapshot | undefined
  const sourceSummary = (): Record<string, unknown> => ({
    label: sourceLabel,
    ...(sourceUrl ? { url: sourceUrl, finalUrl: finalSourceUrl } : {}),
    ...(sourceScreenshot ? { screenshot: sourceScreenshot } : {}),
    ...(sourceDomSnapshotRef ? { domSnapshot: sourceDomSnapshotRef } : {}),
  })
  const candidateSummary = (): Record<string, unknown> => ({
    label: candidateLabel,
    ...(candidateUrl ? { url: candidateUrl, finalUrl: finalCandidateUrl } : {}),
    ...(candidateScreenshot ? { screenshot: candidateScreenshot } : {}),
    ...(candidateDomSnapshotRef ? { domSnapshot: candidateDomSnapshotRef } : {}),
  })

  const writePartialSummary = async (stage: "source-captured" | "candidate-captured"): Promise<void> => {
    await writeVisualComparePartialSummary(summaryPath, {
      artifactPathPrefix,
      stage,
      startedAt,
      source: sourceSummary(),
      candidate: candidateSummary(),
      options: { waitFor, durationMs, fullPage, threshold, includeAA, maxRegions, maxExplanationElements, maxExplanationCandidates, ...(explainSelectors.length > 0 ? { explainSelectors } : {}) },
      preview,
      viewport,
    })
  }

  if (sourceTargetUrl && candidateTargetUrl) {
    const browser = await launchChromiumBrowser()
    try {
      const page = await browser.newPage(requestedViewport ? { viewport: requestedViewport } : undefined)
      viewport = await browserProbeViewport(page)
      const sourceCapture = await captureVisualCompareUrl(page, sourceTargetUrl, sourcePath, waitFor, durationMs, fullPage, maxExplanationCandidates, explainSelectors)
      finalSourceUrl = sourceCapture.finalUrl
      sourceDomSnapshot = sourceCapture.domSnapshot
      await writePartialSummary("source-captured")
      const candidateCapture = await captureVisualCompareUrl(page, candidateTargetUrl, candidatePath, waitFor, durationMs, fullPage, maxExplanationCandidates, explainSelectors)
      finalCandidateUrl = candidateCapture.finalUrl
      candidateDomSnapshot = candidateCapture.domSnapshot
      await writePartialSummary("candidate-captured")
    } finally {
      await browser.close()
    }
  } else if (sourceScreenshot && candidateScreenshot) {
    const sourceResolvedPath = await maybeResolveVisualCompareScreenshotPath(sourceScreenshot, artifactRoot)
    const candidateResolvedPath = await maybeResolveVisualCompareScreenshotPath(candidateScreenshot, artifactRoot)
    const missingInputs = visualCompareMissingScreenshotInputs({ sourceScreenshot, candidateScreenshot, sourceResolvedPath, candidateResolvedPath })
    if (missingInputs.length > 0) {
      const copiedFiles: Partial<{ sourceScreenshot: string; candidateScreenshot: string }> = {}
      if (sourceResolvedPath) {
        await writeFile(sourcePath, await readFile(sourceResolvedPath))
        copiedFiles.sourceScreenshot = `${artifactPathPrefix}/source.png`
      }
      if (candidateResolvedPath) {
        await writeFile(candidatePath, await readFile(candidateResolvedPath))
        copiedFiles.candidateScreenshot = `${artifactPathPrefix}/candidate.png`
      }
      const result = await writeVisualCompareMissingInputSummary({
        summaryPath,
        visualDiffPath,
        artifactPathPrefix,
        startedAt,
        source: sourceSummary(),
        candidate: candidateSummary(),
        options: { waitFor, durationMs, fullPage, threshold, includeAA, maxRegions, maxExplanationElements, maxExplanationCandidates, ...(explainSelectors.length > 0 ? { explainSelectors } : {}) },
        preview,
        viewport,
        missingInputs,
        copiedFiles,
      })
      throw new BrowserCommandArtifactError("wordpress.visual-compare missing expected screenshot input", visualCompareMissingInputArtifact({ source: sourceSummary(), candidate: candidateSummary(), preview, viewport, files: result.files, summary: result.summary }))
    }

    const resolvedSourceScreenshotPath = sourceResolvedPath
    const resolvedCandidateScreenshotPath = candidateResolvedPath
    if (!resolvedSourceScreenshotPath || !resolvedCandidateScreenshotPath) {
      throw new Error("wordpress.visual-compare expected screenshot inputs to be resolved after missing-input guard")
    }
    await writeFile(sourcePath, await readFile(resolvedSourceScreenshotPath))
    await writePartialSummary("source-captured")
    await writeFile(candidatePath, await readFile(resolvedCandidateScreenshotPath))
    if (sourceDomSnapshotRef && candidateDomSnapshotRef) {
      const sourceArtifact = await readVisualCompareDomSnapshotArtifact(sourceDomSnapshotRef, artifactRoot)
      const candidateArtifact = await readVisualCompareDomSnapshotArtifact(candidateDomSnapshotRef, artifactRoot)
      sourceDomSnapshot = sourceArtifact.snapshot
      candidateDomSnapshot = candidateArtifact.snapshot
      finalSourceUrl = sourceArtifact.finalUrl || sourceArtifact.snapshot.url
      finalCandidateUrl = candidateArtifact.finalUrl || candidateArtifact.snapshot.url
      viewport = candidateArtifact.viewport ?? sourceArtifact.viewport ?? viewport
    }
    await writePartialSummary("candidate-captured")
  }

  const comparison = await comparePngFiles(sourcePath, candidatePath, diffPath, { threshold, includeAA, maxRegions })
  const explanation = createVisualCompareExplanation({
    source: sourceDomSnapshot,
    candidate: candidateDomSnapshot,
    sourceLabel,
    candidateLabel,
    viewport,
    comparison,
    limits: { maxElements: maxExplanationElements, maxCandidates: maxExplanationCandidates },
    explainSelectors,
  })
  const finishedAt = now()
  const status = comparison.mismatchPixels === 0 && !comparison.dimensionMismatch ? "identical" : "different"
  const baseline = baselineRef
    ? await createVisualCompareBaselineDelta({
        baselineRef,
        artifactRoot,
        current: { status, comparison, source: sourceSummary(), candidate: candidateSummary() },
      })
    : undefined
  const files = {
    sourceScreenshot: `${artifactPathPrefix}/source.png`,
    candidateScreenshot: `${artifactPathPrefix}/candidate.png`,
    diffScreenshot: `${artifactPathPrefix}/diff.png`,
    visualDiff: `${artifactPathPrefix}/visual-diff.json`,
    ...(explanation ? { visualExplanation: `${artifactPathPrefix}/visual-explanation.json` } : {}),
    summary: `${artifactPathPrefix}/summary.json`,
  }
  const summary = {
    schema: "wp-codebox/visual-compare/v1",
    command: "wordpress.visual-compare",
    status,
    source: sourceSummary(),
    candidate: candidateSummary(),
    options: { waitFor, durationMs, fullPage, threshold, includeAA, maxRegions, maxExplanationElements, maxExplanationCandidates, ...(explainSelectors.length > 0 ? { explainSelectors } : {}) },
    limitations: explanation
      ? explanation.limitations
      : ["visual explanations require source-url/candidate-url targets or source-dom-snapshot/candidate-dom-snapshot sidecars so WP Codebox can include DOM and computed style context; screenshot-only comparisons include pixel evidence only"],
    preview,
    viewport,
    startedAt,
    finishedAt,
    files,
    hashes: {
      sourceScreenshot: { algorithm: "sha256", value: await fileSha256(sourcePath) },
      candidateScreenshot: { algorithm: "sha256", value: await fileSha256(candidatePath) },
      diffScreenshot: { algorithm: "sha256", value: await fileSha256(diffPath) },
    },
    comparison,
    ...(baseline ? { baseline } : {}),
  }
  const summaryJson = `${JSON.stringify(summary, null, 2)}\n`
  await writeFile(visualDiffPath, summaryJson)
  if (explanation) {
    await writeFile(visualExplanationPath, `${JSON.stringify(explanation, null, 2)}\n`)
  }
  await writeFile(summaryPath, summaryJson)

  const artifact: BrowserArtifact = {
    artifactType: "visual-compare",
    requestedUrl: sourceTargetUrl ?? sourceScreenshot ?? sourceLabel,
    url: candidateTargetUrl ?? candidateScreenshot ?? candidateLabel,
    preview,
    files,
    summary: {
      steps: 0,
      consoleMessages: 0,
      errors: 0,
      finalUrl: finalCandidateUrl ?? finalSourceUrl ?? "",
      htmlSnapshot: false,
      networkEvents: 0,
      replayability: "artifact-backed",
      screenshot: true,
      visualCompare: {
        status: summary.status,
        mismatchRatio: comparison.mismatchRatio,
        mismatchPixels: comparison.mismatchPixels,
        totalPixels: comparison.totalPixels,
        dimensionMismatch: comparison.dimensionMismatch,
        ...(explanation ? { explanation: files.visualExplanation } : {}),
      },
      viewport,
    },
  }

  return {
    artifact,
    output: `${JSON.stringify(summary, null, 2)}\n`,
  }
}

async function runVisualCompareMatrixCommand({
  artifactRoot,
  runtimeSpec,
  server,
  args,
  matrixJson,
}: {
  artifactRoot: string
  runtimeSpec?: RuntimeCreateSpec
  server: PlaygroundCliServer
  args: string[]
  matrixJson: string
}): Promise<{ artifact: BrowserArtifact; output: string }> {
  const matrix = normalizeVisualCompareMatrixSpec(JSON.parse(matrixJson))
  const baseArgs = args.filter((arg) => !arg.startsWith("matrix-json="))
  const startedAt = now()
  const entries: Array<{ name: string; artifact: BrowserArtifact; summary: VisualComparePairSummary }> = []
  const failedEntries: VisualCompareMatrixFailedEntry[] = []

  for (const entry of matrix.entries) {
    const entryArgs = mergeVisualCompareMatrixArgs(baseArgs, entry.args)
    try {
      const result = await runVisualComparePairCommand({
        artifactRoot,
        runtimeSpec,
        server,
        args: entryArgs,
        artifactPathPrefix: `files/browser/visual-compare/${entry.name}`,
      })
      entries.push({ name: entry.name, artifact: result.artifact, summary: JSON.parse(result.output) as VisualComparePairSummary })
      await writeVisualCompareMatrixSummary(artifactRoot, args, runtimeSpec, server, matrix.entries, entries, failedEntries, startedAt, false)
    } catch (error) {
      failedEntries.push(await createVisualCompareMatrixFailedEntry(entry.name, entryArgs, artifactRoot, error))
      const matrixSummary = await writeVisualCompareMatrixSummary(artifactRoot, args, runtimeSpec, server, matrix.entries, entries, failedEntries, startedAt, false)
      throw new BrowserCommandArtifactError(`wordpress.visual-compare matrix incomplete: ${errorMessage(error)}`, visualCompareMatrixArtifact(args, runtimeSpec, server, matrix.entries, entries, matrixSummary))
    }
  }

  const matrixSummary = await writeVisualCompareMatrixSummary(artifactRoot, args, runtimeSpec, server, matrix.entries, entries, failedEntries, startedAt, true)

  const artifact = visualCompareMatrixArtifact(args, runtimeSpec, server, matrix.entries, entries, matrixSummary)

  return {
    artifact,
    output: `${JSON.stringify(matrixSummary, null, 2)}\n`,
  }
}

function visualCompareMatrixArtifact(
  args: string[],
  runtimeSpec: RuntimeCreateSpec | undefined,
  server: PlaygroundCliServer,
  expectedEntries: VisualCompareMatrixEntry[],
  entries: Array<{ name: string; artifact: BrowserArtifact; summary: VisualComparePairSummary }>,
  matrixSummary: VisualCompareMatrixSummary,
): BrowserArtifact {
  const sourceScreenshots = entries.map((entry) => entry.artifact.files.sourceScreenshot).filter((file): file is string => typeof file === "string")
  const candidateScreenshots = entries.map((entry) => entry.artifact.files.candidateScreenshot).filter((file): file is string => typeof file === "string")
  const diffScreenshots = entries.map((entry) => entry.artifact.files.diffScreenshot).filter((file): file is string => typeof file === "string")
  const visualDiffs = entries.map((entry) => entry.artifact.files.visualDiff).filter((file): file is string => typeof file === "string")
  const visualExplanations = entries.map((entry) => entry.artifact.files.visualExplanation).filter((file): file is string => typeof file === "string")
  const firstArtifact = entries[0]?.artifact
  return {
    artifactType: "visual-compare",
    requestedUrl: expectedEntries.map((entry) => entry.name).join(","),
    url: firstArtifact?.url ?? "visual-compare-matrix",
    preview: firstArtifact?.preview ?? browserPreviewRouting(args, runtimeSpec, server.serverUrl),
    files: {
      summary: matrixSummary.files.summary,
      visualDiff: visualDiffs,
      sourceScreenshot: sourceScreenshots,
      candidateScreenshot: candidateScreenshots,
      diffScreenshot: diffScreenshots,
      ...(visualExplanations.length > 0 ? { visualExplanation: visualExplanations } : {}),
    },
    summary: {
      steps: 0,
      consoleMessages: entries.reduce((total, entry) => total + entry.artifact.summary.consoleMessages, 0),
      errors: entries.reduce((total, entry) => total + entry.artifact.summary.errors, 0),
      finalUrl: firstArtifact?.summary.finalUrl ?? "",
      htmlSnapshot: false,
      networkEvents: entries.reduce((total, entry) => total + entry.artifact.summary.networkEvents, 0),
      replayability: "artifact-backed",
      screenshot: entries.length > 0,
      visualCompare: {
        status: matrixSummary.status,
        mismatchRatio: matrixSummary.metrics.maxMismatchRatio,
        mismatchPixels: matrixSummary.metrics.maxMismatchPixels,
        totalPixels: matrixSummary.comparisons.reduce((total, entry) => total + (entry.comparison?.totalPixels ?? 0), 0),
        dimensionMismatch: matrixSummary.comparisons.some((entry) => entry.comparison?.dimensionMismatch === true),
        explanation: matrixSummary.files.summary,
      },
      viewport: firstArtifact?.summary.viewport ?? null,
    },
  }
}

async function writeVisualComparePartialSummary(summaryPath: string, input: {
  artifactPathPrefix: string
  stage: "source-captured" | "candidate-captured"
  startedAt: string
  source: Record<string, unknown>
  candidate: Record<string, unknown>
  options: Record<string, unknown>
  preview: ReturnType<typeof browserPreviewRouting>
  viewport: BrowserProbeViewport | null
}): Promise<void> {
  const files = {
    sourceScreenshot: `${input.artifactPathPrefix}/source.png`,
    ...(input.stage === "candidate-captured" ? { candidateScreenshot: `${input.artifactPathPrefix}/candidate.png` } : {}),
    summary: `${input.artifactPathPrefix}/summary.json`,
  }
  const summary = {
    schema: "wp-codebox/visual-compare/v1",
    command: "wordpress.visual-compare",
    status: "partial",
    partial: true,
    stage: input.stage,
    source: input.source,
    candidate: input.candidate,
    options: input.options,
    limitations: ["visual compare was interrupted before full diff metrics were available; recovered files show the latest completed capture stage"],
    preview: input.preview,
    viewport: input.viewport,
    startedAt: input.startedAt,
    updatedAt: now(),
    files,
  }
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`)
}

async function writeVisualCompareMissingInputSummary(input: {
  summaryPath: string
  visualDiffPath: string
  artifactPathPrefix: string
  startedAt: string
  source: Record<string, unknown>
  candidate: Record<string, unknown>
  options: Record<string, unknown>
  preview: ReturnType<typeof browserPreviewRouting>
  viewport: BrowserProbeViewport | null
  missingInputs: VisualCompareMissingInput[]
  copiedFiles: Partial<{ sourceScreenshot: string; candidateScreenshot: string }>
}): Promise<{ files: { sourceScreenshot: string | string[]; candidateScreenshot: string | string[]; diffScreenshot: string | string[]; visualDiff: string; summary: string }; summary: VisualCompareMissingInputSummary }> {
  const files = {
    sourceScreenshot: input.copiedFiles.sourceScreenshot ?? [],
    candidateScreenshot: input.copiedFiles.candidateScreenshot ?? [],
    diffScreenshot: [],
    visualDiff: `${input.artifactPathPrefix}/visual-diff.json`,
    summary: `${input.artifactPathPrefix}/summary.json`,
  }
  const summary: VisualCompareMissingInputSummary = {
    schema: "wp-codebox/visual-compare/v1",
    command: "wordpress.visual-compare",
    status: "missing",
    partial: true,
    stage: "missing-input",
    source: input.source,
    candidate: input.candidate,
    options: input.options,
    limitations: ["visual compare could not run because one or more expected screenshot inputs were missing; recovered files show any screenshots that were available before comparison"],
    preview: input.preview,
    viewport: input.viewport,
    startedAt: input.startedAt,
    updatedAt: now(),
    files,
    diagnostic: {
      type: "missing-input",
      message: "Visual compare is missing expected screenshot input.",
      missingInputs: input.missingInputs,
    },
  }
  const json = `${JSON.stringify(summary, null, 2)}\n`
  await writeFile(input.visualDiffPath, json)
  await writeFile(input.summaryPath, json)
  return { files, summary }
}

function visualCompareMissingInputArtifact(input: {
  source: Record<string, unknown>
  candidate: Record<string, unknown>
  preview: ReturnType<typeof browserPreviewRouting>
  viewport: BrowserProbeViewport | null
  files: { sourceScreenshot: string | string[]; candidateScreenshot: string | string[]; diffScreenshot: string | string[]; visualDiff: string; summary: string }
  summary: VisualCompareMissingInputSummary
}): BrowserArtifact {
  return {
    artifactType: "visual-compare",
    requestedUrl: typeof input.source.url === "string" ? input.source.url : typeof input.source.screenshot === "string" ? input.source.screenshot : "source",
    url: typeof input.candidate.url === "string" ? input.candidate.url : typeof input.candidate.screenshot === "string" ? input.candidate.screenshot : "candidate",
    preview: input.preview,
    files: input.files,
    summary: {
      steps: 0,
      consoleMessages: 0,
      errors: 0,
      finalUrl: "",
      htmlSnapshot: false,
      networkEvents: 0,
      replayability: "artifact-backed",
      screenshot: Array.isArray(input.files.sourceScreenshot) ? input.files.sourceScreenshot.length > 0 : Boolean(input.files.sourceScreenshot),
      visualCompare: {
        status: input.summary.status,
        explanation: input.files.visualDiff,
      },
      viewport: input.viewport,
    },
  }
}

function visualCompareMissingScreenshotInputs(input: {
  sourceScreenshot: string
  candidateScreenshot: string
  sourceResolvedPath?: string
  candidateResolvedPath?: string
}): VisualCompareMissingInput[] {
  const missingInputs: VisualCompareMissingInput[] = []
  if (!input.sourceResolvedPath) {
    missingInputs.push({ role: "sourceScreenshot", path: input.sourceScreenshot })
  }
  if (!input.candidateResolvedPath) {
    missingInputs.push({ role: "candidateScreenshot", path: input.candidateScreenshot })
  }
  return missingInputs
}

async function maybeResolveVisualCompareScreenshotPath(requestedPath: string, artifactRoot: string): Promise<string | undefined> {
  try {
    return await resolveVisualCompareScreenshotPath(requestedPath, artifactRoot)
  } catch {
    return undefined
  }
}

async function writeVisualCompareMatrixSummary(
  artifactRoot: string,
  args: string[],
  runtimeSpec: RuntimeCreateSpec | undefined,
  server: PlaygroundCliServer,
  expectedEntries: VisualCompareMatrixEntry[],
  entries: Array<{ name: string; artifact: BrowserArtifact; summary: VisualComparePairSummary }>,
  failedEntries: VisualCompareMatrixFailedEntry[],
  startedAt: string,
  complete: boolean,
): Promise<VisualCompareMatrixSummary> {
  const comparisons = entries.map((entry) => ({
    name: entry.name,
    status: entry.summary.status,
    source: entry.summary.source,
    candidate: entry.summary.candidate,
    options: entry.summary.options,
    viewport: entry.summary.viewport,
    files: entry.summary.files,
    comparison: entry.summary.comparison,
  }))
  const allComparisons = [...comparisons, ...failedEntries]
  const mismatchRatios = comparisons.map((entry) => entry.comparison.mismatchRatio)
  const mismatchPixels = comparisons.map((entry) => entry.comparison.mismatchPixels)
  const maxMismatchRatio = mismatchRatios.length > 0 ? Math.max(...mismatchRatios) : 0
  const maxMismatchPixels = mismatchPixels.length > 0 ? Math.max(...mismatchPixels) : 0
  const matrixComplete = complete && failedEntries.length === 0
  const matrixSummary: VisualCompareMatrixSummary = {
    schema: "wp-codebox/visual-compare-matrix/v1",
    command: "wordpress.visual-compare",
    status: matrixComplete
      ? comparisons.every((entry) => entry.status === "identical") ? "identical" : "different"
      : "partial",
    complete: matrixComplete,
    startedAt,
    ...(matrixComplete ? { finishedAt: now() } : { updatedAt: now() }),
    metrics: {
      expectedComparisons: expectedEntries.length,
      comparisons: comparisons.length,
      missing: failedEntries.filter((entry) => entry.status === "missing").length,
      failed: failedEntries.filter((entry) => entry.status === "failed").length,
      identical: comparisons.filter((entry) => entry.status === "identical").length,
      different: comparisons.filter((entry) => entry.status !== "identical").length,
      maxMismatchRatio,
      meanMismatchRatio: mismatchRatios.length > 0 ? mismatchRatios.reduce((total, value) => total + value, 0) / mismatchRatios.length : 0,
      maxMismatchPixels,
      meanMismatchPixels: mismatchPixels.length > 0 ? mismatchPixels.reduce((total, value) => total + value, 0) / mismatchPixels.length : 0,
    },
    comparisons: allComparisons,
    files: {
      summary: "files/browser/visual-compare/matrix-summary.json",
    },
    ...(!matrixComplete ? {
      preview: entries[0]?.artifact.preview ?? browserPreviewRouting(args, runtimeSpec, server.serverUrl),
      limitations: ["visual compare matrix was interrupted or an expected input was missing before all comparisons completed; recovered comparisons contain complete per-entry evidence for finished viewports and structured diagnostics for incomplete entries"],
    } : {}),
  }
  const browserDirectory = join(artifactRoot, "files", "browser", "visual-compare")
  await mkdir(browserDirectory, { recursive: true })
  await writeFile(join(browserDirectory, "matrix-summary.json"), `${JSON.stringify(matrixSummary, null, 2)}\n`)
  return matrixSummary
}

async function createVisualCompareMatrixFailedEntry(name: string, args: string[], artifactRoot: string, error: unknown): Promise<VisualCompareMatrixFailedEntry> {
  const sourceScreenshot = argValue(args, "source-screenshot")?.trim()
  const candidateScreenshot = argValue(args, "candidate-screenshot")?.trim()
  const missingInputs: Array<{ role: "sourceScreenshot" | "candidateScreenshot"; path: string }> = []
  if (sourceScreenshot && !await visualCompareScreenshotExists(sourceScreenshot, artifactRoot)) {
    missingInputs.push({ role: "sourceScreenshot", path: sourceScreenshot })
  }
  if (candidateScreenshot && !await visualCompareScreenshotExists(candidateScreenshot, artifactRoot)) {
    missingInputs.push({ role: "candidateScreenshot", path: candidateScreenshot })
  }

  return {
    name,
    status: missingInputs.length > 0 ? "missing" : "failed",
    source: visualCompareMatrixEndpoint(args, "source"),
    candidate: visualCompareMatrixEndpoint(args, "candidate"),
    options: visualCompareMatrixOptions(args),
    viewport: null,
    files: {},
    diagnostic: {
      type: missingInputs.length > 0 ? "missing-input" : "comparison-failed",
      message: missingInputs.length > 0 ? "Visual compare matrix entry is missing expected screenshot input." : errorMessage(error),
      ...(missingInputs.length > 0 ? { missingInputs } : {}),
    },
  }
}

async function visualCompareScreenshotExists(requestedPath: string, artifactRoot: string): Promise<boolean> {
  try {
    await resolveVisualCompareScreenshotPath(requestedPath, artifactRoot)
    return true
  } catch {
    return false
  }
}

function visualCompareMatrixEndpoint(args: string[], role: "source" | "candidate"): Record<string, unknown> {
  const label = argValue(args, `${role}-label`)?.trim() || role
  const url = argValue(args, `${role}-url`)?.trim()
  const screenshot = argValue(args, `${role}-screenshot`)?.trim()
  const domSnapshot = argValue(args, `${role}-dom-snapshot`)?.trim()
  return {
    label,
    ...(url ? { url } : {}),
    ...(screenshot ? { screenshot } : {}),
    ...(domSnapshot ? { domSnapshot } : {}),
  }
}

function visualCompareMatrixOptions(args: string[]): Record<string, unknown> {
  const requestedViewport = viewportArg(args, "viewport")
  return {
    waitFor: argValue(args, "wait-for")?.trim() || "domcontentloaded",
    durationMs: durationArg(args, "duration", 0),
    ...(requestedViewport ? { requestedViewport } : {}),
    fullPage: strictBooleanArg(args, "full-page", true),
    threshold: numberArg(args, "threshold", 0.1),
    includeAA: strictBooleanArg(args, "include-aa", false),
    maxRegions: positiveIntegerArg(args, "max-regions", 8),
    maxExplanationElements: positiveIntegerArg(args, "max-explanation-elements", 25),
    maxExplanationCandidates: positiveIntegerArg(args, "max-explanation-candidates", 160),
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface VisualComparePairSummary {
  status: string
  source: Record<string, unknown>
  candidate: Record<string, unknown>
  options: Record<string, unknown>
  viewport: BrowserProbeViewport | null
  files: Record<string, string>
  comparison: { mismatchRatio: number; mismatchPixels: number; totalPixels: number; dimensionMismatch: boolean }
}

interface VisualCompareMissingInput {
  role: "sourceScreenshot" | "candidateScreenshot"
  path: string
}

interface VisualCompareMissingInputSummary {
  schema: "wp-codebox/visual-compare/v1"
  command: "wordpress.visual-compare"
  status: "missing"
  partial: true
  stage: "missing-input"
  source: Record<string, unknown>
  candidate: Record<string, unknown>
  options: Record<string, unknown>
  limitations: string[]
  preview: ReturnType<typeof browserPreviewRouting>
  viewport: BrowserProbeViewport | null
  startedAt: string
  updatedAt: string
  files: { sourceScreenshot: string | string[]; candidateScreenshot: string | string[]; diffScreenshot: string | string[]; visualDiff: string; summary: string }
  diagnostic: {
    type: "missing-input"
    message: string
    missingInputs: VisualCompareMissingInput[]
  }
}

interface VisualCompareMatrixSummary {
  schema: "wp-codebox/visual-compare-matrix/v1"
  command: "wordpress.visual-compare"
  status: string
  complete: boolean
  startedAt: string
  finishedAt?: string
  updatedAt?: string
  metrics: {
    expectedComparisons: number
    comparisons: number
    missing: number
    failed: number
    identical: number
    different: number
    maxMismatchRatio: number
    meanMismatchRatio: number
    maxMismatchPixels: number
    meanMismatchPixels: number
  }
  comparisons: Array<{
    name: string
    status: string
    source: Record<string, unknown>
    candidate: Record<string, unknown>
    options: Record<string, unknown>
    viewport: BrowserProbeViewport | null
    files: Record<string, string>
    comparison?: VisualComparePairSummary["comparison"]
    diagnostic?: VisualCompareMatrixFailedEntry["diagnostic"]
  }>
  files: { summary: string }
  preview?: ReturnType<typeof browserPreviewRouting>
  limitations?: string[]
}

interface VisualCompareMatrixFailedEntry {
  name: string
  status: "missing" | "failed"
  source: Record<string, unknown>
  candidate: Record<string, unknown>
  options: Record<string, unknown>
  viewport: BrowserProbeViewport | null
  files: Record<string, string>
  diagnostic: {
    type: "missing-input" | "comparison-failed"
    message: string
    missingInputs?: Array<{ role: "sourceScreenshot" | "candidateScreenshot"; path: string }>
  }
}

interface VisualCompareMatrixEntry {
  name: string
  args: string[]
}

function normalizeVisualCompareMatrixSpec(input: unknown): { entries: VisualCompareMatrixEntry[] } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("matrix-json must be a JSON object")
  }
  const record = input as Record<string, unknown>
  const comparisons = record.comparisons
  if (!Array.isArray(comparisons) || comparisons.length === 0) {
    throw new Error("matrix-json.comparisons must be a non-empty array")
  }
  const viewports = Array.isArray(record.viewports) && record.viewports.length > 0 ? record.viewports : [undefined]
  const entries: VisualCompareMatrixEntry[] = []
  for (const comparison of comparisons) {
    const comparisonRecord = visualCompareMatrixRecord(comparison, "matrix-json.comparisons entries")
    const comparisonName = visualCompareMatrixString(comparisonRecord, ["name", "id", "label"]) ?? `comparison-${entries.length + 1}`
    for (const viewport of viewports) {
      const viewportRecord = viewport === undefined || typeof viewport === "string" ? undefined : visualCompareMatrixRecord(viewport, "matrix-json.viewports entries")
      const viewportValue = typeof viewport === "string" ? viewport : viewportRecord ? visualCompareMatrixString(viewportRecord, ["viewport", "size"]) : undefined
      const viewportName = viewportRecord ? visualCompareMatrixString(viewportRecord, ["name", "id", "label"]) : viewportValue
      const name = sanitizeVisualCompareMatrixName([comparisonName, viewportName].filter(Boolean).join("-"))
      const args = visualCompareMatrixArgs(comparisonRecord)
      if (viewportValue) {
        args.push(`viewport=${viewportValue}`)
      }
      entries.push({ name, args })
    }
  }
  return { entries }
}

function visualCompareMatrixRecord(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${label} must be JSON objects`)
  }
  return input as Record<string, unknown>
}

function visualCompareMatrixArgs(record: Record<string, unknown>): string[] {
  const fields: Array<[string, string[]]> = [
    ["source-url", ["source-url", "sourceUrl"]],
    ["candidate-url", ["candidate-url", "candidateUrl"]],
    ["source-screenshot", ["source-screenshot", "sourceScreenshot"]],
    ["candidate-screenshot", ["candidate-screenshot", "candidateScreenshot"]],
    ["source-dom-snapshot", ["source-dom-snapshot", "sourceDomSnapshot"]],
    ["candidate-dom-snapshot", ["candidate-dom-snapshot", "candidateDomSnapshot"]],
    ["source-label", ["source-label", "sourceLabel"]],
    ["candidate-label", ["candidate-label", "candidateLabel"]],
    ["wait-for", ["wait-for", "waitFor"]],
    ["duration", ["duration", "durationMs"]],
    ["viewport", ["viewport"]],
    ["full-page", ["full-page", "fullPage"]],
    ["threshold", ["threshold"]],
    ["include-aa", ["include-aa", "includeAA"]],
    ["max-regions", ["max-regions", "maxRegions"]],
    ["max-explanation-elements", ["max-explanation-elements", "maxExplanationElements"]],
    ["max-explanation-candidates", ["max-explanation-candidates", "maxExplanationCandidates"]],
  ]
  return fields.flatMap(([argName, keys]) => {
    const value = visualCompareMatrixValue(record, keys)
    return value === undefined ? [] : [`${argName}=${String(value)}`]
  })
}

function visualCompareMatrixString(record: Record<string, unknown>, keys: string[]): string | undefined {
  const value = visualCompareMatrixValue(record, keys)
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function visualCompareMatrixValue(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null && record[key] !== "") {
      return record[key]
    }
  }
  return undefined
}

function sanitizeVisualCompareMatrixName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "comparison"
}

function mergeVisualCompareMatrixArgs(baseArgs: string[], entryArgs: string[]): string[] {
  const merged = baseArgs.filter((arg) => !entryArgs.some((entryArg) => arg.slice(0, arg.indexOf("=") + 1) === entryArg.slice(0, entryArg.indexOf("=") + 1)))
  merged.push(...entryArgs)
  return merged
}

async function resolveVisualCompareScreenshotPath(requestedPath: string, artifactRoot: string): Promise<string> {
  return resolveVisualCompareArtifactPath(requestedPath, artifactRoot, "Visual compare screenshot")
}

async function createVisualCompareBaselineDelta({
  baselineRef,
  artifactRoot,
  current,
}: {
  baselineRef: string
  artifactRoot: string
  current: {
    status: string
    comparison: VisualCompareComparisonMetrics
    source: VisualCompareComparisonSummary["source"]
    candidate: VisualCompareComparisonSummary["candidate"]
  }
}): Promise<VisualCompareBaselineDelta> {
  const baselinePath = await resolveVisualCompareArtifactPath(baselineRef, artifactRoot, "Visual compare baseline")
  const parsed = JSON.parse(await readFile(baselinePath, "utf8")) as unknown
  const comparisons = collectVisualCompareBaselineComparisons(parsed)
  if (comparisons.length === 0) {
    throw new Error(`Visual compare baseline does not contain comparison evidence: ${baselineRef}`)
  }

  const labelMatchIndex = comparisons.findIndex((comparison) => {
    return comparison.source?.label === current.source?.label && comparison.candidate?.label === current.candidate?.label
  })
  const selectedIndex = labelMatchIndex >= 0 ? labelMatchIndex : 0
  const baseline = comparisons[selectedIndex]
  const match: VisualCompareBaselineDelta["match"] = labelMatchIndex >= 0
    ? "labels"
    : comparisons.length === 1
      ? "only-comparison"
      : "first-comparison"

  return {
    ref: baselineRef,
    selectedIndex,
    match,
    availableComparisons: comparisons.length,
    baseline,
    delta: visualCompareBaselineDelta(baseline, current),
  }
}

function visualCompareBaselineDelta(baseline: VisualCompareComparisonSummary, current: { status: string; comparison: VisualCompareComparisonMetrics }): VisualCompareBaselineDelta["delta"] {
  const delta: VisualCompareBaselineDelta["delta"] = {
    status: { baseline: baseline.status, current: current.status, changed: baseline.status !== current.status },
  }
  const currentComparison = current.comparison
  if (typeof baseline.mismatchRatio === "number" && typeof currentComparison.mismatchRatio === "number") {
    delta.mismatchRatio = visualCompareNumericDelta(baseline.mismatchRatio, currentComparison.mismatchRatio)
  }
  if (typeof baseline.mismatchPixels === "number" && typeof currentComparison.mismatchPixels === "number") {
    delta.mismatchPixels = visualCompareNumericDelta(baseline.mismatchPixels, currentComparison.mismatchPixels)
  }
  if (typeof baseline.totalPixels === "number" && typeof currentComparison.totalPixels === "number") {
    delta.totalPixels = visualCompareNumericDelta(baseline.totalPixels, currentComparison.totalPixels)
  }
  if (typeof baseline.dimensionMismatch === "boolean" && typeof currentComparison.dimensionMismatch === "boolean") {
    delta.dimensionMismatch = { baseline: baseline.dimensionMismatch, current: currentComparison.dimensionMismatch, changed: baseline.dimensionMismatch !== currentComparison.dimensionMismatch }
  }
  return delta
}

function visualCompareNumericDelta(baseline: number, current: number): { baseline: number; current: number; absoluteDelta: number; percentDelta?: number } {
  return {
    baseline,
    current,
    absoluteDelta: current - baseline,
    ...(baseline !== 0 ? { percentDelta: ((current - baseline) / baseline) * 100 } : {}),
  }
}

function collectVisualCompareBaselineComparisons(input: unknown, seen = new Set<unknown>()): VisualCompareComparisonSummary[] {
  if (!input || typeof input !== "object" || seen.has(input)) {
    return []
  }
  seen.add(input)

  const record = input as Record<string, unknown>
  const direct = normalizeVisualCompareBaselineComparison(record)
  if (direct) {
    return [direct]
  }
  const comparisons: VisualCompareComparisonSummary[] = []

  for (const value of Object.values(record)) {
    if (!value || typeof value !== "object") {
      continue
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        comparisons.push(...collectVisualCompareBaselineComparisons(item, seen))
      }
      continue
    }
    comparisons.push(...collectVisualCompareBaselineComparisons(value, seen))
  }

  return comparisons
}

function normalizeVisualCompareBaselineComparison(record: Record<string, unknown>): VisualCompareComparisonSummary | undefined {
  const comparison = visualCompareRecord(record.comparison)
  if (comparison) {
    return {
      ...comparison,
      ...(typeof record.status === "string" ? { status: record.status } : {}),
      source: visualCompareEndpoint(record.source),
      candidate: visualCompareEndpoint(record.candidate),
    }
  }

  const visualCompare = visualCompareRecord(record.visualCompare)
  if (visualCompare) {
    return visualCompare
  }

  return visualCompareRecord(record)
}

function visualCompareRecord(input: unknown): VisualCompareComparisonSummary | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined
  }
  const record = input as Record<string, unknown>
  const status = typeof record.status === "string" ? record.status : undefined
  const mismatchRatio = typeof record.mismatchRatio === "number" ? record.mismatchRatio : undefined
  const mismatchPixels = typeof record.mismatchPixels === "number" ? record.mismatchPixels : undefined
  const totalPixels = typeof record.totalPixels === "number" ? record.totalPixels : undefined
  const dimensionMismatch = typeof record.dimensionMismatch === "boolean" ? record.dimensionMismatch : undefined
  if (!status && mismatchRatio === undefined && mismatchPixels === undefined && totalPixels === undefined && dimensionMismatch === undefined) {
    return undefined
  }
  return { status, mismatchRatio, mismatchPixels, totalPixels, dimensionMismatch }
}

function visualCompareEndpoint(input: unknown): VisualCompareComparisonSummary["source"] | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined
  }
  const record = input as Record<string, unknown>
  return {
    ...(typeof record.label === "string" ? { label: record.label } : {}),
    ...(typeof record.url === "string" ? { url: record.url } : {}),
    ...(typeof record.screenshot === "string" ? { screenshot: record.screenshot } : {}),
  }
}

async function readVisualCompareDomSnapshotArtifact(requestedPath: string, artifactRoot: string): Promise<VisualCompareDomSnapshotArtifact> {
  const path = await resolveVisualCompareArtifactPath(requestedPath, artifactRoot, "Visual compare DOM snapshot")
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown
  const artifact = normalizeVisualCompareDomSnapshotArtifact(parsed, requestedPath)
  return artifact
}

async function resolveVisualCompareArtifactPath(requestedPath: string, artifactRoot: string, label: string): Promise<string> {
  try {
    await access(requestedPath)
    return requestedPath
  } catch {
    // Recipes are authored before the runtime id exists, so callers may point to
    // the stable artifacts root while browser captures live under the current runtime root.
    const stableBrowserRoot = join(dirname(artifactRoot), "files", "browser")
    const browserRelativePath = relative(stableBrowserRoot, requestedPath)
    if (browserRelativePath && !browserRelativePath.startsWith("..")) {
      const runtimePath = join(artifactRoot, "files", "browser", browserRelativePath)
      await access(runtimePath)
      return runtimePath
    }

    throw new Error(`${label} not found: ${requestedPath}`)
  }
}

function normalizeVisualCompareDomSnapshotArtifact(input: unknown, requestedPath: string): VisualCompareDomSnapshotArtifact {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`Visual compare DOM snapshot must be a JSON object: ${requestedPath}`)
  }
  const record = input as Partial<VisualCompareDomSnapshotArtifact> & { snapshot?: unknown }
  if (record.schema !== "wp-codebox/browser-dom-snapshot/v1") {
    throw new Error(`Visual compare DOM snapshot has unsupported schema: ${requestedPath}`)
  }
  const snapshot = record.snapshot
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error(`Visual compare DOM snapshot is missing snapshot object: ${requestedPath}`)
  }
  const typedSnapshot = snapshot as Partial<VisualCompareDomSnapshot>
  if (!Array.isArray(typedSnapshot.capturedElements)) {
    throw new Error(`Visual compare DOM snapshot capturedElements must be an array: ${requestedPath}`)
  }
  return record as VisualCompareDomSnapshotArtifact
}

function visualCompareExplainSelectors(args: string[]): string[] {
  const selectors = new Set<string>()
  for (const arg of args) {
    if (arg.startsWith("explain-selector=")) {
      const selector = arg.slice("explain-selector=".length).trim()
      if (selector) {
        selectors.add(selector)
      }
    }
  }
  for (const item of jsonArrayArg(args, "explain-selectors")) {
    if (typeof item !== "string") {
      throw new Error("explain-selectors must be a JSON array of strings")
    }
    const selector = item.trim()
    if (selector) {
      selectors.add(selector)
    }
  }

  return [...selectors]
}

async function captureVisualCompareUrl(page: Page, targetUrl: string, outputPath: string, waitFor: string, durationMs: number, fullPage: boolean, maxExplanationCandidates: number, explainSelectors: string[]): Promise<{ finalUrl: string; domSnapshot: VisualCompareDomSnapshot }> {
  if (waitFor === "duration") {
    await page.goto(targetUrl, { waitUntil: "domcontentloaded" })
    if (durationMs > 0) {
      await page.waitForTimeout(durationMs)
    }
  } else if (waitFor.startsWith("selector:")) {
    await page.goto(targetUrl, { waitUntil: "domcontentloaded" })
    await page.waitForSelector(waitFor.slice("selector:".length), { state: "visible" })
    if (durationMs > 0) {
      await page.waitForTimeout(durationMs)
    }
  } else if (waitFor === "domcontentloaded" || waitFor === "load" || waitFor === "networkidle") {
    await page.goto(targetUrl, { waitUntil: waitFor })
    if (durationMs > 0) {
      await page.waitForTimeout(durationMs)
    }
  } else {
    throw new Error(`wait-for supports domcontentloaded, load, networkidle, selector:<selector>, or duration: ${waitFor}`)
  }
  const domSnapshot = await captureVisualCompareDomSnapshot(page, maxExplanationCandidates, explainSelectors)
  await page.screenshot({ path: outputPath, fullPage })
  return { finalUrl: page.url(), domSnapshot }
}

async function captureVisualCompareDomSnapshot(page: Page, maxElements: number, explainSelectors: string[] = []): Promise<VisualCompareDomSnapshot> {
  return page.evaluate(({ maxElements: maxElementsInput, styleProperties, attributeNames, selectors }) => {
    const maxElements = Math.max(1, Number(maxElementsInput) || 1)
    const elements = Array.from(document.body?.querySelectorAll("*") ?? [])
    const visibleElements = elements
      .map((element) => elementSnapshot(element, styleProperties, attributeNames))
      .filter((element): element is VisualCompareDomElementSnapshot => Boolean(element))
    const capturedByPath = new Map(visibleElements.slice(0, maxElements).map((element) => [element.path, element]))
    const selectorSnapshots = selectors.map((selector) => selectorSnapshot(selector, capturedByPath, styleProperties, attributeNames))

    return {
      url: window.location.href,
      title: document.title || "",
      elementCount: visibleElements.length,
      capturedElements: [...capturedByPath.values()],
      ...(selectorSnapshots.length > 0 ? { selectors: selectorSnapshots } : {}),
      truncated: visibleElements.length > maxElements,
    }

    function selectorSnapshot(selector: string, captured: Map<string, VisualCompareDomElementSnapshot>, styles: string[], attributes: string[]): VisualCompareSelectorSnapshot {
      try {
        const matches = Array.from(document.querySelectorAll(selector))
        const snapshots = matches.map((element) => elementSnapshot(element, styles, attributes)).filter((element): element is VisualCompareDomElementSnapshot => Boolean(element))
        for (const snapshot of snapshots) {
          captured.set(snapshot.path, snapshot)
        }
        return { selector, matched: matches.length, captured: snapshots.length, paths: snapshots.map((snapshot) => snapshot.path) }
      } catch (error) {
        return { selector, matched: 0, captured: 0, paths: [], error: error instanceof Error ? error.message : String(error) }
      }
    }

    function elementSnapshot(element: Element, styles: string[], attributes: string[]): VisualCompareDomElementSnapshot | null {
      const rect = element.getBoundingClientRect()
      const computed = window.getComputedStyle(element)
      if (rect.width <= 0 || rect.height <= 0 || computed.display === "none" || computed.visibility === "hidden" || computed.opacity === "0") {
        return null
      }
      return {
        path: elementPath(element),
        tag: element.tagName.toLowerCase(),
        text: compactText(element.textContent || "", 180),
        attributes: Object.fromEntries(attributes.flatMap((name) => {
          const value = element.getAttribute(name)
          return value === null ? [] : [[name, compactText(value, 180)]]
        })),
        boundingBox: {
          x: roundNumber(rect.x),
          y: roundNumber(rect.y),
          width: roundNumber(rect.width),
          height: roundNumber(rect.height),
        },
        styles: Object.fromEntries(styles.map((name) => [name, computed.getPropertyValue(name)])),
      }
    }

    function elementPath(element: Element): string {
      const parts: string[] = []
      let current: Element | null = element
      while (current && current !== document.body && parts.length < 6) {
        let part = current.tagName.toLowerCase()
        const id = current.getAttribute("id")
        if (id) {
          part += `#${cssEscape(id)}`
          parts.unshift(part)
          break
        }
        const classes = Array.from(current.classList || []).slice(0, 2).map(cssEscape)
        if (classes.length > 0) {
          part += `.${classes.join(".")}`
        }
        const parent: Element | null = current.parentElement
        if (parent) {
          const sameTagSiblings = Array.from(parent.children).filter((child: Element) => child.tagName === current?.tagName)
          if (sameTagSiblings.length > 1) {
            part += `:nth-of-type(${sameTagSiblings.indexOf(current) + 1})`
          }
        }
        parts.unshift(part)
        current = parent
      }
      return parts.length > 0 ? parts.join(" > ") : element.tagName.toLowerCase()
    }

    function compactText(value: string, maxLength: number): string {
      const compact = value.replace(/\s+/g, " ").trim()
      return compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}…` : compact
    }

    function roundNumber(value: number): number {
      return Math.round(value * 100) / 100
    }

    function cssEscape(value: string): string {
      if (globalThis.CSS && typeof globalThis.CSS.escape === "function") {
        return globalThis.CSS.escape(String(value))
      }
      return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&")
    }
  }, { maxElements, styleProperties: [...VISUAL_EXPLANATION_STYLE_PROPERTIES], attributeNames: [...VISUAL_EXPLANATION_ATTRIBUTE_NAMES], selectors: explainSelectors })
}

function createVisualCompareExplanation({
  source,
  candidate,
  sourceLabel,
  candidateLabel,
  viewport,
  comparison,
  limits,
  explainSelectors,
}: {
  source?: VisualCompareDomSnapshot
  candidate?: VisualCompareDomSnapshot
  sourceLabel: string
  candidateLabel: string
  viewport: BrowserProbeViewport | null
  comparison: Awaited<ReturnType<typeof comparePngFiles>>
  limits: { maxElements: number; maxCandidates: number }
  explainSelectors: string[]
}): VisualCompareExplanation | undefined {
  if (!source || !candidate) {
    return undefined
  }

  const sourceElements = new Map(source.capturedElements.map((element) => [element.path, element]))
  const candidateElements = new Map(candidate.capturedElements.map((element) => [element.path, element]))
  const changed: VisualCompareElementDelta[] = []
  const added: VisualCompareDomElementSnapshot[] = []
  const removed: VisualCompareDomElementSnapshot[] = []

  for (const sourceElement of source.capturedElements) {
    const candidateElement = candidateElements.get(sourceElement.path)
    if (!candidateElement) {
      removed.push(sourceElement)
      continue
    }
    const delta = visualCompareElementDelta(sourceElement, candidateElement)
    if (delta) {
      changed.push(delta)
    }
  }

  for (const candidateElement of candidate.capturedElements) {
    if (!sourceElements.has(candidateElement.path)) {
      added.push(candidateElement)
    }
  }

  const maxElements = limits.maxElements
  const selectorSummary = visualCompareSelectorSummary(source.selectors, candidate.selectors, explainSelectors)
  const limitations = [
    "visual explanations are heuristic evidence generated from DOM snapshots and computed styles; pixel screenshots remain the source of visual truth",
    "elements are matched by deterministic CSS-like paths, so large structural moves can appear as added and removed elements",
  ]
  if (source.truncated || candidate.truncated || changed.length > maxElements || added.length > maxElements || removed.length > maxElements) {
    limitations.push("element explanation output was truncated to keep the artifact bounded")
  }

  return {
    schema: "wp-codebox/visual-explanation/v1",
    source: { label: sourceLabel, url: source.url, title: source.title, elementCount: source.elementCount, capturedElements: source.capturedElements.length, truncated: source.truncated },
    candidate: { label: candidateLabel, url: candidate.url, title: candidate.title, elementCount: candidate.elementCount, capturedElements: candidate.capturedElements.length, truncated: candidate.truncated },
    viewport,
    mismatchRegions: comparison.regions,
    ...(selectorSummary.selectors.length > 0 ? { selectors: selectorSummary.selectors } : {}),
    ...(selectorSummary.missingSelectors.length > 0 ? { missingSelectors: selectorSummary.missingSelectors } : {}),
    limits,
    truncation: {
      changed: changed.length > maxElements,
      added: added.length > maxElements,
      removed: removed.length > maxElements,
    },
    summary: {
      changedElements: changed.length,
      addedElements: added.length,
      removedElements: removed.length,
      sourceCapturedElements: source.capturedElements.length,
      candidateCapturedElements: candidate.capturedElements.length,
    },
    changes: changed.slice(0, maxElements),
    added: added.slice(0, maxElements),
    removed: removed.slice(0, maxElements),
    limitations,
  }
}

function visualCompareSelectorSummary(sourceSelectors: VisualCompareSelectorSnapshot[] | undefined, candidateSelectors: VisualCompareSelectorSnapshot[] | undefined, requestedSelectors: string[] = []): {
  selectors: Array<{ selector: string; source: VisualCompareSelectorSnapshot; candidate: VisualCompareSelectorSnapshot }>
  missingSelectors: Array<{ selector: string; sourceMatched: boolean; candidateMatched: boolean; sourceError?: string; candidateError?: string }>
} {
  const selectorNames = [...new Set([...requestedSelectors, ...(sourceSelectors ?? []).map((item) => item.selector), ...(candidateSelectors ?? []).map((item) => item.selector)])]
  const sourceBySelector = new Map((sourceSelectors ?? []).map((item) => [item.selector, item]))
  const candidateBySelector = new Map((candidateSelectors ?? []).map((item) => [item.selector, item]))
  const selectors = selectorNames.map((selector) => {
    const source = sourceBySelector.get(selector) ?? { selector, matched: 0, captured: 0, paths: [] }
    const candidate = candidateBySelector.get(selector) ?? { selector, matched: 0, captured: 0, paths: [] }
    return { selector, source, candidate }
  })
  const missingSelectors = selectors
    .filter((item) => item.source.matched === 0 || item.candidate.matched === 0 || Boolean(item.source.error) || Boolean(item.candidate.error))
    .map((item) => ({
      selector: item.selector,
      sourceMatched: item.source.matched > 0,
      candidateMatched: item.candidate.matched > 0,
      ...(item.source.error ? { sourceError: item.source.error } : {}),
      ...(item.candidate.error ? { candidateError: item.candidate.error } : {}),
    }))

  return { selectors, missingSelectors }
}

function visualCompareElementDelta(source: VisualCompareDomElementSnapshot, candidate: VisualCompareDomElementSnapshot): VisualCompareElementDelta | undefined {
  const changes: VisualCompareElementDelta["changes"] = {}
  if (source.text !== candidate.text) {
    changes.text = { source: source.text, candidate: candidate.text }
  }
  if (visualCompareBoundingBoxChanged(source.boundingBox, candidate.boundingBox)) {
    changes.boundingBox = {
      source: source.boundingBox,
      candidate: candidate.boundingBox,
      delta: {
        x: roundVisualDelta(candidate.boundingBox.x - source.boundingBox.x),
        y: roundVisualDelta(candidate.boundingBox.y - source.boundingBox.y),
        width: roundVisualDelta(candidate.boundingBox.width - source.boundingBox.width),
        height: roundVisualDelta(candidate.boundingBox.height - source.boundingBox.height),
      },
    }
  }
  const attributes = visualCompareRecordDelta(source.attributes, candidate.attributes, true)
  if (Object.keys(attributes).length > 0) {
    changes.attributes = attributes
  }
  const styles = visualCompareRecordDelta(source.styles, candidate.styles, false) as Record<string, { source: string; candidate: string }>
  if (Object.keys(styles).length > 0) {
    changes.styles = styles
  }
  return Object.keys(changes).length > 0 ? { path: source.path, tag: source.tag, changes } : undefined
}

function visualCompareBoundingBoxChanged(source: VisualCompareDomElementSnapshot["boundingBox"], candidate: VisualCompareDomElementSnapshot["boundingBox"]): boolean {
  return Math.abs(source.x - candidate.x) >= 0.5 || Math.abs(source.y - candidate.y) >= 0.5 || Math.abs(source.width - candidate.width) >= 0.5 || Math.abs(source.height - candidate.height) >= 0.5
}

function visualCompareRecordDelta(source: Record<string, string>, candidate: Record<string, string>, nullable: boolean): Record<string, { source: string | null; candidate: string | null }> {
  const keys = [...new Set([...Object.keys(source), ...Object.keys(candidate)])]
  const delta: Record<string, { source: string | null; candidate: string | null }> = {}
  for (const key of keys) {
    const sourceValue = source[key]
    const candidateValue = candidate[key]
    if (sourceValue !== candidateValue) {
      delta[key] = { source: sourceValue ?? (nullable ? null : ""), candidate: candidateValue ?? (nullable ? null : "") }
    }
  }
  return delta
}

function roundVisualDelta(value: number): number {
  return Math.round(value * 100) / 100
}

async function comparePngFiles(sourcePath: string, candidatePath: string, diffPath: string, options: { threshold: number; includeAA: boolean; maxRegions: number }): Promise<{
  source: { width: number; height: number }
  candidate: { width: number; height: number }
  diff: { width: number; height: number }
  dimensionMismatch: boolean
  dimensionDrift?: VisualCompareDimensionDrift
  mismatchPixels: number
  totalPixels: number
  mismatchRatio: number
  regions: VisualCompareMismatchRegion[]
}> {
  const source = PNG.sync.read(await readFile(sourcePath))
  const candidate = PNG.sync.read(await readFile(candidatePath))
  const width = Math.max(source.width, candidate.width)
  const height = Math.max(source.height, candidate.height)
  const overlap = { width: Math.min(source.width, candidate.width), height: Math.min(source.height, candidate.height) }
  const sourceCanvas = visualCompareCanvas(source, width, height)
  const candidateCanvas = visualCompareCanvas(candidate, width, height)
  const diff = new PNG({ width, height })
  const mismatchPixels = pixelmatch(sourceCanvas.data, candidateCanvas.data, diff.data, width, height, { threshold: options.threshold, includeAA: options.includeAA })
  await writeFile(diffPath, PNG.sync.write(diff))
  const dimensionMismatch = source.width !== candidate.width || source.height !== candidate.height

  return {
    source: { width: source.width, height: source.height },
    candidate: { width: candidate.width, height: candidate.height },
    diff: { width, height },
    dimensionMismatch,
    ...(dimensionMismatch ? { dimensionDrift: visualCompareDimensionDrift(source, candidate) } : {}),
    mismatchPixels,
    totalPixels: width * height,
    mismatchRatio: width * height > 0 ? mismatchPixels / (width * height) : 0,
    regions: visualCompareMismatchRegions(diff, options.maxRegions, overlap),
  }
}

function visualCompareCanvas(image: PNG, width: number, height: number): PNG {
  if (image.width === width && image.height === height) {
    return image
  }
  const canvas = new PNG({ width, height })
  for (let y = 0; y < image.height; y += 1) {
    const sourceStart = (image.width * y) << 2
    const targetStart = (width * y) << 2
    image.data.copy(canvas.data, targetStart, sourceStart, sourceStart + (image.width << 2))
  }
  return canvas
}

function visualCompareDimensionDrift(source: PNG, candidate: PNG): VisualCompareDimensionDrift {
  const sourceOnly: VisualCompareDimensionDriftRegion[] = []
  const candidateOnly: VisualCompareDimensionDriftRegion[] = []
  const minWidth = Math.min(source.width, candidate.width)
  const minHeight = Math.min(source.height, candidate.height)
  collectDimensionDriftRegions(source, candidate, "source", sourceOnly, minWidth, minHeight)
  collectDimensionDriftRegions(candidate, source, "candidate", candidateOnly, minWidth, minHeight)
  return {
    widthDelta: candidate.width - source.width,
    heightDelta: candidate.height - source.height,
    sourceOnly,
    candidateOnly,
  }
}

function collectDimensionDriftRegions(image: PNG, other: PNG, owner: "source" | "candidate", regions: VisualCompareDimensionDriftRegion[], minWidth: number, minHeight: number): void {
  if (image.width > other.width) {
    regions.push({ owner, x: minWidth, y: 0, width: image.width - minWidth, height: image.height, pixels: (image.width - minWidth) * image.height })
  }
  if (image.height > other.height) {
    regions.push({ owner, x: 0, y: minHeight, width: minWidth, height: image.height - minHeight, pixels: minWidth * (image.height - minHeight) })
  }
}

function visualCompareMismatchRegions(diff: PNG, maxRegions: number, bounds: { width: number; height: number } = { width: diff.width, height: diff.height }): VisualCompareMismatchRegion[] {
  const visited = new Uint8Array(diff.width * diff.height)
  const regions: VisualCompareMismatchRegion[] = []
  const width = Math.min(diff.width, Math.max(0, bounds.width))
  const height = Math.min(diff.height, Math.max(0, bounds.height))
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * diff.width + x
      if (visited[index] || !visualCompareDiffPixel(diff, x, y)) {
        continue
      }
      const region = visualCompareFloodRegion(diff, x, y, visited, { width, height })
      regions.push(...visualCompareSegmentLargeRegion(diff, region, maxRegions))
    }
  }
  return regions.sort((a, b) => b.pixels - a.pixels).slice(0, maxRegions)
}

function visualCompareFloodRegion(diff: PNG, startX: number, startY: number, visited: Uint8Array, bounds: { width: number; height: number }): VisualCompareMismatchRegion {
  const stack: Array<[number, number]> = [[startX, startY]]
  let minX = startX
  let maxX = startX
  let minY = startY
  let maxY = startY
  let pixels = 0
  while (stack.length > 0) {
    const [x, y] = stack.pop() ?? [0, 0]
    if (x < 0 || y < 0 || x >= bounds.width || y >= bounds.height) {
      continue
    }
    const index = y * diff.width + x
    if (visited[index] || !visualCompareDiffPixel(diff, x, y)) {
      continue
    }
    visited[index] = 1
    pixels += 1
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1])
  }
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, pixels }
}

function visualCompareSegmentLargeRegion(diff: PNG, region: VisualCompareMismatchRegion, maxRegions: number): VisualCompareMismatchRegion[] {
  const coversMostCanvas = region.width >= diff.width * 0.8 && region.height >= diff.height * 0.8
  if (!coversMostCanvas || maxRegions < 2 || region.height < 2) {
    return [region]
  }

  const segmentHeight = Math.max(1, Math.ceil(region.height / maxRegions))
  const segments: VisualCompareMismatchRegion[] = []
  for (let y = region.y; y < region.y + region.height; y += segmentHeight) {
    const segment = visualCompareRegionBounds(diff, region.x, y, region.width, Math.min(segmentHeight, region.y + region.height - y))
    if (segment) {
      segments.push(segment)
    }
  }
  return segments.length > 0 ? segments : [region]
}

function visualCompareRegionBounds(diff: PNG, x: number, y: number, width: number, height: number): VisualCompareMismatchRegion | undefined {
  let minX = x + width
  let maxX = x
  let minY = y + height
  let maxY = y
  let pixels = 0
  for (let row = y; row < y + height; row += 1) {
    for (let column = x; column < x + width; column += 1) {
      if (!visualCompareDiffPixel(diff, column, row)) {
        continue
      }
      pixels += 1
      minX = Math.min(minX, column)
      maxX = Math.max(maxX, column)
      minY = Math.min(minY, row)
      maxY = Math.max(maxY, row)
    }
  }
  return pixels > 0 ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, pixels } : undefined
}

function visualCompareDiffPixel(diff: PNG, x: number, y: number): boolean {
  const offset = ((y * diff.width) + x) << 2
  return diff.data[offset] > 0 || diff.data[offset + 1] > 0 || diff.data[offset + 2] > 0
}

async function executeEditorActionStep(page: import("playwright").Page, step: EditorActionStep, timeoutMs: number): Promise<Omit<EditorStateSnapshot, "schema" | "capturedAt" | "target"> | undefined> {
  switch (step.kind) {
    case "open":
      return undefined
    case "insertBlock": {
      const beforeCount = await editorBlockCount(page)
      await page.evaluate((input) => {
        const win = window as unknown as {
          wp?: {
            blocks?: { createBlock?: (name: string, attributes?: Record<string, unknown>) => unknown }
            data?: { dispatch?: (store: string) => Record<string, unknown> }
          }
        }
        const createBlock = win.wp?.blocks?.createBlock
        const dispatch = win.wp?.data?.dispatch
        if (typeof createBlock !== "function" || typeof dispatch !== "function") {
          throw new Error("WordPress block editor APIs are unavailable")
        }
        const attributes = { ...(input.attributes ?? {}) }
        if (input.name === "core/paragraph" && typeof input.content === "string" && attributes.content === undefined) {
          attributes.content = input.content
        }
        const block = createBlock(input.name, attributes)
        const blockEditor = dispatch("core/block-editor")
        if (typeof blockEditor.insertBlocks !== "function") {
          throw new Error("core/block-editor insertBlocks is unavailable")
        }
        blockEditor.insertBlocks([block], undefined, undefined, Boolean(input.select))
      }, { name: step.name ?? "core/paragraph", attributes: step.attributes, content: step.content, select: step.select !== false })
      await page.waitForFunction((count) => {
        const select = (window as unknown as { wp?: { data?: { select?: (store: string) => Record<string, unknown> } } }).wp?.data?.select
        const blockEditor = typeof select === "function" ? select("core/block-editor") : undefined
        const blocks = typeof blockEditor?.getBlocks === "function" ? blockEditor.getBlocks() as unknown[] : []
        return blocks.length > count
      }, beforeCount, { timeout: stepTimeoutMs(step, timeoutMs) })
      return undefined
    }
    case "selectBlock": {
      await page.evaluate((input) => {
        const wpData = (window as unknown as { wp?: { data?: { select?: (store: string) => Record<string, unknown>; dispatch?: (store: string) => Record<string, unknown> } } }).wp?.data
        const blockEditor = wpData?.select?.("core/block-editor")
        const blocks = typeof blockEditor?.getBlocks === "function" ? blockEditor.getBlocks() as Array<Record<string, unknown>> : []
        const clientId = input.clientId ?? (typeof input.index === "number" ? blocks[input.index]?.clientId : undefined)
        if (typeof clientId !== "string" || clientId.length === 0) {
          throw new Error("selectBlock requires clientId or a valid block index")
        }
        const dispatch = wpData?.dispatch?.("core/block-editor")
        if (typeof dispatch?.selectBlock !== "function") {
          throw new Error("core/block-editor selectBlock is unavailable")
        }
        dispatch.selectBlock(clientId)
      }, { clientId: step.clientId, index: step.index })
      return undefined
    }
    case "inspectState":
      return page.evaluate(() => {
        const wpData = (window as unknown as { wp?: { data?: { select?: (store: string) => Record<string, unknown> } } }).wp?.data
        const select = wpData?.select
        if (!select) {
          return { storesAvailable: false }
        }
        const editor = select("core/editor")
        const blockEditor = select("core/block-editor")
        const currentPost = typeof editor.getCurrentPost === "function" ? editor.getCurrentPost() as Record<string, unknown> | null : null
        const blocks = typeof blockEditor.getBlocks === "function" ? blockEditor.getBlocks() as Array<Record<string, unknown>> : []
        return {
          storesAvailable: true,
          post: {
            id: typeof editor.getCurrentPostId === "function" ? editor.getCurrentPostId() : currentPost?.id,
            type: typeof editor.getCurrentPostType === "function" ? editor.getCurrentPostType() : currentPost?.type,
            status: typeof currentPost?.status === "string" ? currentPost.status : undefined,
            title: typeof currentPost?.title === "object" && currentPost.title
              ? stringValue((currentPost.title as Record<string, unknown>).raw ?? (currentPost.title as Record<string, unknown>).rendered)
              : undefined,
          },
          blocks: blocks.map((block) => ({
            name: typeof block.name === "string" ? block.name : "",
            clientId: typeof block.clientId === "string" ? block.clientId : undefined,
            attributes: typeof block.attributes === "object" && block.attributes ? block.attributes as Record<string, unknown> : undefined,
          })),
        }
      })
  }
}

async function editorBlockCount(page: import("playwright").Page): Promise<number> {
  return page.evaluate(() => {
    const select = (window as unknown as { wp?: { data?: { select?: (store: string) => Record<string, unknown> } } }).wp?.data?.select
    const blockEditor = typeof select === "function" ? select("core/block-editor") : undefined
    const blocks = typeof blockEditor?.getBlocks === "function" ? blockEditor.getBlocks() as unknown[] : []
    return blocks.length
  })
}

function stepTimeoutMs(step: EditorActionStep, fallbackMs: number): number {
  return typeof step.timeout === "string" && step.timeout.length > 0 ? durationStringMs(step.timeout) : fallbackMs
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

async function waitForAnyVisibleSelector(page: import("playwright").Page, selector: string, timeoutMs: number): Promise<void> {
  await page.waitForFunction((targetSelector) => {
    return Array.from(document.querySelectorAll(targetSelector)).some((element) => {
      const rect = element.getBoundingClientRect()
      const style = window.getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none"
    })
  }, selector, { timeout: timeoutMs })
}

interface EditorStateSnapshot {
  schema: "wp-codebox/editor-state/v1"
  capturedAt: string
  target: ReturnType<typeof editorOpenTargetFromArgs>
  storesAvailable: boolean
  post?: {
    id?: number
    type?: string
    status?: string
    title?: string
  }
  blocks?: Array<{
    name: string
    clientId?: string
    attributes?: Record<string, unknown>
  }>
}

async function captureEditorState(page: import("playwright").Page, target: ReturnType<typeof editorOpenTargetFromArgs>): Promise<EditorStateSnapshot> {
  const state = await page.evaluate(() => {
    const wpData = (window as unknown as { wp?: { data?: { select?: (store: string) => Record<string, unknown> } } }).wp?.data
    const select = wpData?.select
    if (!select) {
      return { storesAvailable: false }
    }
    const editor = select("core/editor")
    const blockEditor = select("core/block-editor")
    const currentPost = typeof editor.getCurrentPost === "function" ? editor.getCurrentPost() as Record<string, unknown> | null : null
    const blocks = typeof blockEditor.getBlocks === "function" ? blockEditor.getBlocks() as Array<Record<string, unknown>> : []
    return {
      storesAvailable: true,
      post: {
        id: typeof editor.getCurrentPostId === "function" ? editor.getCurrentPostId() : currentPost?.id,
        type: typeof editor.getCurrentPostType === "function" ? editor.getCurrentPostType() : currentPost?.type,
        status: currentPost?.status,
        title: typeof currentPost?.title === "object" && currentPost.title ? (currentPost.title as Record<string, unknown>).raw ?? (currentPost.title as Record<string, unknown>).rendered : undefined,
      },
      blocks: blocks.map((block) => ({
        name: typeof block.name === "string" ? block.name : "",
        clientId: typeof block.clientId === "string" ? block.clientId : undefined,
        attributes: typeof block.attributes === "object" && block.attributes ? block.attributes as Record<string, unknown> : undefined,
      })),
    }
  }) as Omit<EditorStateSnapshot, "schema" | "capturedAt" | "target">

  return {
    schema: "wp-codebox/editor-state/v1",
    capturedAt: now(),
    target,
    ...state,
  }
}

function summarizeEditorState(target: ReturnType<typeof editorOpenTargetFromArgs>, state: EditorStateSnapshot): NonNullable<BrowserArtifactSummary["editor"]> {
  return {
    kind: target.kind,
    ...(typeof state.post?.id === "number" ? { postId: state.post.id } : {}),
    ...(typeof state.post?.type === "string" ? { postType: state.post.type } : target.postType ? { postType: target.postType } : {}),
    ...(typeof state.post?.title === "string" ? { title: state.post.title } : {}),
    ...(Array.isArray(state.blocks) ? { blockCount: state.blocks.length } : {}),
    storesAvailable: state.storesAvailable,
  }
}

async function installWordPressAdminAuthCookies({
  cookieUrls,
  command,
  page,
  runPlaygroundCommand,
  runtimeSpec,
  server,
  userId,
}: {
  cookieUrls?: string[]
  command: string
  page: import("playwright").Page
  runPlaygroundCommand?: (command: string, server: PlaygroundCliServer, options: { code: string } | { scriptPath: string }) => Promise<PlaygroundRunResponse>
  runtimeSpec?: RuntimeCreateSpec
  server: PlaygroundCliServer
  userId: number
}): Promise<BrowserProbeAuthSummary> {
  if (!runPlaygroundCommand) {
    throw new Error(`${command} auth=wordpress-admin requires Playground PHP command support`)
  }
  if (!runtimeSpec) {
    throw new Error(`${command} auth=wordpress-admin requires a runtime spec`)
  }

  const authCommand = `${command}.auth`
  const urls = uniqueBrowserAuthCookieUrls(cookieUrls ?? [server.serverUrl])
  const response = await runPlaygroundCommand(authCommand, server, { code: bootstrapPhpCode(runtimeSpec, wordpressAdminAuthCookiePhpCode(urls, userId), []) })
  assertPlaygroundResponseOk(authCommand, response)
  const cookies = JSON.parse(cleanWpCliOutput(response.text)) as Array<{ name?: string; value?: string; domain?: string; path?: string; expires?: number; httpOnly?: boolean; secure?: boolean; sameSite?: "Lax" }>
  await page.context().addCookies(cookies.map((cookie) => ({
    name: String(cookie.name ?? ""),
    value: String(cookie.value ?? ""),
    domain: String(cookie.domain ?? new URL(server.serverUrl).hostname),
    path: typeof cookie.path === "string" && cookie.path.length > 0 ? cookie.path : "/",
    expires: typeof cookie.expires === "number" ? cookie.expires : Math.floor(Date.now() / 1000) + 3600,
    httpOnly: cookie.httpOnly !== false,
    secure: cookie.secure === true,
    sameSite: cookie.sameSite ?? "Lax",
  })))

  return { mode: "wordpress-admin", userId, cookieCount: cookies.length, cookieHosts: browserAuthCookieHostSummary(cookies) }
}

function wordpressAdminAuthCookiePhpCode(browserUrls: string[], userId: number): string {
  return `
$user_id = ${JSON.stringify(userId)};
$user = get_user_by( 'id', $user_id );
if ( ! $user ) {
    throw new RuntimeException( 'Browser auth requires the requested WordPress user to exist.' );
}
wp_set_current_user( $user_id );
$expiration = time() + HOUR_IN_SECONDS;
$token = '';
if ( class_exists( 'WP_Session_Tokens' ) ) {
    $token = WP_Session_Tokens::get_instance( $user_id )->create( $expiration );
}
$browser_urls = ${JSON.stringify(browserUrls)};
$cookies = array();
foreach ( $browser_urls as $browser_url ) {
    $browser_host = wp_parse_url( $browser_url, PHP_URL_HOST );
    if ( ! $browser_host ) {
        continue;
    }
    $secure = 'https' === wp_parse_url( $browser_url, PHP_URL_SCHEME );
    foreach ( array( array( AUTH_COOKIE, 'auth', false ), array( SECURE_AUTH_COOKIE, 'secure_auth', true ) ) as $admin_cookie ) {
        $cookies[] = array(
            'name'     => $admin_cookie[0],
            'value'    => wp_generate_auth_cookie( $user_id, $expiration, $admin_cookie[1], $token ),
            'domain'   => $browser_host,
            'path'     => defined( 'ADMIN_COOKIE_PATH' ) && ADMIN_COOKIE_PATH ? ADMIN_COOKIE_PATH : '/wp-admin',
            'expires'  => $expiration,
            'httpOnly' => true,
            'secure'   => $admin_cookie[2],
            'sameSite' => 'Lax',
        );
    }
    $logged_in_cookie = array(
        'name'     => LOGGED_IN_COOKIE,
        'value'    => wp_generate_auth_cookie( $user_id, $expiration, 'logged_in', $token ),
        'domain'   => $browser_host,
        'path'     => defined( 'COOKIEPATH' ) && COOKIEPATH ? COOKIEPATH : '/',
        'expires'  => $expiration,
        'httpOnly' => true,
        'secure'   => $secure,
        'sameSite' => 'Lax',
    );
    $cookies[] = $logged_in_cookie;
    if ( defined( 'SITECOOKIEPATH' ) && SITECOOKIEPATH && SITECOOKIEPATH !== COOKIEPATH ) {
        $logged_in_cookie['path'] = SITECOOKIEPATH;
        $cookies[] = $logged_in_cookie;
    }
}
echo wp_json_encode( $cookies );
`
}

function browserAuthCookieUrls(serverUrl: string, routedHosts: string[], targetUrls: string[]): string[] {
  const urls = [serverUrl]
  for (const host of routedHosts.map(normalizeBrowserCookieHost).filter(Boolean)) {
    const matchingTarget = targetUrls.find((targetUrl) => normalizeBrowserCookieHost(browserUrlHostname(targetUrl) ?? "") === host)
    const protocol = matchingTarget ? new URL(matchingTarget).protocol : browserAuthCookieProtocol(targetUrls)
    urls.push(`${protocol}//${host}/`)
  }
  return uniqueBrowserAuthCookieUrls(urls)
}

function browserActionTargetUrls(steps: BrowserInteractionStep[], effectiveOrigin: string, fallbackUrl: string): string[] {
  const urls = steps
    .filter((step) => step.kind === "navigate" && typeof step.url === "string" && step.url.trim().length > 0)
    .map((step) => resolveBrowserPreviewUrl(String(step.url), effectiveOrigin))
  return urls.length > 0 ? urls : [fallbackUrl]
}

function uniqueBrowserAuthCookieUrls(urls: string[]): string[] {
  const unique = new Map<string, string>()
  for (const url of urls) {
    try {
      const parsed = new URL(url)
      unique.set(`${parsed.protocol}//${normalizeBrowserCookieHost(parsed.hostname)}`, `${parsed.protocol}//${parsed.hostname}/`)
    } catch {
      // Ignore invalid cookie URL inputs; callers still include the local server URL.
    }
  }
  return [...unique.values()]
}

function browserAuthCookieProtocol(targetUrls: string[]): string {
  for (const targetUrl of targetUrls) {
    try {
      return new URL(targetUrl).protocol
    } catch {
      // Keep looking for a usable target URL.
    }
  }
  return "http:"
}

function browserUrlHostname(url: string): string | undefined {
  try {
    return new URL(url).hostname
  } catch {
    return undefined
  }
}

function normalizeBrowserCookieHost(host: string): string {
  return host.trim().toLowerCase().replace(/:\d+$/, "")
}

function browserAuthCookieHostSummary(cookies: Array<{ domain?: string }>): Array<{ host: string; cookieCount: number }> {
  const counts = new Map<string, number>()
  for (const cookie of cookies) {
    const host = normalizeBrowserCookieHost(String(cookie.domain ?? ""))
    if (!host) continue
    counts.set(host, (counts.get(host) ?? 0) + 1)
  }
  return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([host, cookieCount]) => ({ host, cookieCount }))
}

function browserAuthRequest(args: string[]): { userId: number } | undefined {
  const auth = argValue(args, "auth")?.trim()
  if (!auth) {
    return undefined
  }
  if (auth !== "wordpress-admin") {
    throw new Error(`Browser auth supports wordpress-admin: ${auth}`)
  }
  return { userId: positiveIntegerArg(args, "auth-user-id", 1) }
}

function now(): string {
  return new Date().toISOString()
}

async function fileSha256(path: string): Promise<string> {
  return sha256(await readFile(path))
}

function sha256(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex")
}

type BrowserProbeProgressSource = "navigation" | "network" | "console" | "pageerror" | "checkpoint" | "script" | "duration" | "probe-error"

class BrowserProbeTerminalFailureError extends Error {
  readonly code = "browser-probe-terminal-failure"

  constructor(readonly failure: { message: string; reason?: string; details?: unknown; timestamp: string }) {
    super(`Browser probe reported a terminal failure: ${failure.message}`)
    this.name = "BrowserProbeTerminalFailureError"
  }
}

class BrowserProbeStallError extends Error {
  readonly code = "browser-probe-stalled"

  constructor(readonly idleMs: number, readonly stallTimeoutMs: number, readonly lastProgressSource: BrowserProbeProgressSource) {
    super(`Browser probe stalled after ${idleMs}ms without progress; last progress source was ${lastProgressSource}`)
    this.name = "BrowserProbeStallError"
  }
}

function createBrowserProbeProgressTracker(startedAt: string, stallTimeoutMs: number): {
  mark(source: BrowserProbeProgressSource, timestamp?: string): void
  fail(source: BrowserProbeProgressSource, error: Error): void
  terminalFailure(failure: { message: string; reason?: string; details?: unknown; timestamp: string }): void
  lastProgressElapsedMs(): number
  summary(): {
    status: "active" | "failed" | "stalled"
    startedAt: string
    lastProgressAt: string
    lastProgressSource: BrowserProbeProgressSource
    idleMs: number
    stallTimeoutMs?: number
    terminalFailure?: { message: string; reason?: string; details?: unknown; timestamp: string }
  }
} {
  let status: "active" | "failed" | "stalled" = "active"
  let lastProgressAt = startedAt
  let lastProgressSource: BrowserProbeProgressSource = "navigation"
  let terminalFailure: { message: string; reason?: string; details?: unknown; timestamp: string } | undefined

  return {
    mark(source, timestamp = now()) {
      lastProgressAt = timestamp
      lastProgressSource = source
    },
    fail(source, error) {
      lastProgressAt = now()
      lastProgressSource = source
      status = error instanceof BrowserProbeStallError ? "stalled" : "failed"
      if (error instanceof BrowserProbeTerminalFailureError) {
        terminalFailure = error.failure
      }
    },
    terminalFailure(failure) {
      status = "failed"
      terminalFailure = failure
      lastProgressAt = failure.timestamp
      lastProgressSource = "probe-error"
    },
    lastProgressElapsedMs() {
      return Math.max(0, Date.now() - Date.parse(lastProgressAt))
    },
    summary() {
      return {
        status,
        startedAt,
        lastProgressAt,
        lastProgressSource,
        idleMs: this.lastProgressElapsedMs(),
        ...(stallTimeoutMs > 0 ? { stallTimeoutMs } : {}),
        ...(terminalFailure ? { terminalFailure } : {}),
      }
    },
  }
}

async function withBrowserProbeLiveness<T>(page: import("playwright").Page, progress: ReturnType<typeof createBrowserProbeProgressTracker>, failFast: boolean, operation: Promise<T>): Promise<T> {
  const stallTimeoutMs = progress.summary().stallTimeoutMs ?? 0
  if (!failFast && stallTimeoutMs <= 0) {
    return operation
  }

  let interval: NodeJS.Timeout | undefined
  operation.catch(() => undefined)

  try {
    const result = await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        interval = setInterval(() => {
          void (async () => {
            try {
              const state = await page.evaluate(() => {
                const probe = (globalThis as typeof globalThis & {
                  __wpCodeboxBrowserProbe?: {
                    checkpoints?: Array<{ timestamp?: unknown }>
                    terminalFailure?: { message?: unknown; reason?: unknown; details?: unknown; timestamp?: unknown }
                  }
                }).__wpCodeboxBrowserProbe
                const checkpoints = Array.isArray(probe?.checkpoints) ? probe.checkpoints : []
                const latestCheckpoint = [...checkpoints].reverse().find((checkpoint) => typeof checkpoint.timestamp === "string")
                const failure = probe?.terminalFailure
                return {
                  checkpointTimestamp: latestCheckpoint?.timestamp,
                  terminalFailure: failure && typeof failure.message === "string" ? {
                    message: failure.message,
                    reason: typeof failure.reason === "string" ? failure.reason : undefined,
                    details: failure.details,
                    timestamp: typeof failure.timestamp === "string" ? failure.timestamp : new Date().toISOString(),
                  } : undefined,
                }
              })
              if (typeof state.checkpointTimestamp === "string") {
                progress.mark("checkpoint", state.checkpointTimestamp)
              }
              if (state.terminalFailure) {
                progress.terminalFailure(state.terminalFailure)
                reject(new BrowserProbeTerminalFailureError(state.terminalFailure))
                return
              }
              if (stallTimeoutMs > 0 && progress.lastProgressElapsedMs() >= stallTimeoutMs) {
                const summary = progress.summary()
                reject(new BrowserProbeStallError(summary.idleMs, stallTimeoutMs, summary.lastProgressSource))
              }
            } catch {
              // The page may be navigating or already closed; the outer operation remains authoritative.
            }
          })()
        }, 250)
        interval.unref()
      }),
    ])
    const terminalFailure = failFast ? await browserProbeTerminalFailure(page) : undefined
    if (terminalFailure) {
      progress.terminalFailure(terminalFailure)
      throw new BrowserProbeTerminalFailureError(terminalFailure)
    }
    return result
  } finally {
    if (interval) {
      clearInterval(interval)
    }
  }
}

async function browserProbeTerminalFailure(page: import("playwright").Page): Promise<{ message: string; reason?: string; details?: unknown; timestamp: string } | undefined> {
  return page.evaluate(() => {
    const failure = (globalThis as typeof globalThis & {
      __wpCodeboxBrowserProbe?: {
        terminalFailure?: { message?: unknown; reason?: unknown; details?: unknown; timestamp?: unknown }
      }
    }).__wpCodeboxBrowserProbe?.terminalFailure
    if (!failure || typeof failure.message !== "string") {
      return undefined
    }
    return {
      message: failure.message,
      reason: typeof failure.reason === "string" ? failure.reason : undefined,
      details: failure.details,
      timestamp: typeof failure.timestamp === "string" ? failure.timestamp : new Date().toISOString(),
    }
  }).catch(() => undefined)
}

function numberArg(args: string[], name: string, fallback: number): number {
  const raw = argValue(args, name)?.trim()
  if (!raw) {
    return fallback
  }
  const parsed = Number.parseFloat(raw)
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number`)
  }
  return parsed
}

function positiveIntegerArg(args: string[], name: string, fallback: number): number {
  const raw = argValue(args, name)?.trim()
  if (!raw) {
    return fallback
  }
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}
