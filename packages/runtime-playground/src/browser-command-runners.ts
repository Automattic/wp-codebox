import { createHash } from "node:crypto"
import { access, readFile, writeFile } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import { assertRuntimeCommandAllowed, browserInteractionScriptUsesEvaluate, BROWSER_PROBE_BROWSER_VALUES, BROWSER_PROBE_CAPTURE_VALUES, BROWSER_PROBE_CHROMIUM_PROFILE_IDS, BROWSER_PROBE_PROFILES, BROWSER_PROBE_THROTTLE_PROFILE_IDS, redactString, resolveCommandPath, validateBrowserInteractionScript, type BrowserInteractionStep, type BrowserProbeProfileDefinition, type ExecutionSpec, type RuntimeCreateSpec } from "@automattic/wp-codebox-core"
import pixelmatch from "pixelmatch"
import { PNG } from "pngjs"
import { browserInteractionStepsFromArgs, browserStepTimeoutMs, durationStringMs, sanitizeScreenshotName } from "./browser-actions.js"
import { BrowserArtifactSession } from "./browser-artifact-session.js"
import { BrowserCommandArtifactError, isBrowserCommandArtifactError } from "./browser-command-artifact-error.js"
import { normalizeBrowserStorageStatePayload, type BrowserAuthStorageState, type BrowserStorageStateImportSummary } from "./browser-auth-storage-state.js"
import type { BrowserArtifact, BrowserArtifactSummary, BrowserEditorCanvasProbeDiagnostic, BrowserEditorCanvasProbeSummary, BrowserEditorCanvasSelectorGroupSummary, BrowserEditorCanvasSelectorSummary, BrowserEditorReadinessSummary, BrowserEditorSaveSummary, BrowserProbeArtifact, BrowserProbeArtifactRef, BrowserProbeAuthSummary, BrowserProbeCapabilityDiagnostics, BrowserProbeCheckpointRecord, BrowserProbeContextDetails, BrowserProbeErrorRecord, BrowserProbeLifecycleArtifact, BrowserProbeMeasuredMetric, BrowserProbeMemoryArtifact, BrowserProbeNetworkCountSummary, BrowserProbeNetworkRecord, BrowserProbeNetworkReviewSummary, BrowserProbePerformanceArtifact, BrowserProbePreviewRouting, BrowserProbeReviewSummary, BrowserProbeScriptMetadata, BrowserProbeViewport, BrowserProbeWaterfallArtifact, BrowserProbeWaterfallEntry, BrowserRedirectDiagnosticsSummary, BrowserStepRecord, BrowserWordPressDiagnosticsSummary } from "./browser-artifacts.js"
import { attachBrowserCaptureListeners, chromiumBrowserMetadata, launchChromiumBrowser, settleBrowserNetworkTasks } from "./browser-capture-session.js"
import { browserAssertionsSummary, browserStepRecord, executeBrowserInteractionStep } from "./browser-interactions.js"
import { browserCommandLivenessPolicy, isBrowserCommandLivenessError, withBrowserCommandLiveness, type BrowserCommandLivenessPolicy } from "./browser-liveness.js"
import { browserProbeLifecycleArtifact, browserProbeLifecycleInitScript, collectBrowserProbeLifecycle } from "./browser-lifecycle.js"
import { browserProbeBenchMetrics, serializeBrowserError } from "./browser-metrics.js"
import { browserPreviewNetworkPolicyIsActive, browserPreviewNetworkPolicySummary, browserPreviewNeedsContextRouting, browserPreviewOrigins, browserPreviewReadinessError, browserPreviewRouting, browserPreviewSecureContextError, browserPreviewTopology, createBrowserPreviewRouteTracker, drainBrowserPreviewRouteTracker, resolveBrowserPreviewUrl, routeBrowserPreviewContextNetwork, routeBrowserPreviewPageNetwork } from "./browser-preview-routing.js"
import { BROWSER_PROBE_PERFORMANCE_INIT_SCRIPT, BROWSER_PROBE_STATE_INIT_SCRIPT, browserProbeAssertionsFromArgs, browserProbeAssertionsNeedMetrics, browserProbeAssertionsNeedNetwork, browserProbeCheckpoint, browserProbeMemoryArtifact, browserProbePendingCheckpoints, browserProbePerformanceArtifact, browserProbeReplayability, browserProbeViewport, executeBrowserProbeAssertions, navigateBrowserProbe } from "./browser-probe.js"
import { argValue, cleanWpCliOutput, commaListArg, durationArg, jsonArrayArg, strictBooleanArg, viewportArg } from "./commands.js"
import { editorActionStepsFromArgs, editorOpenTargetFromArgs, type EditorActionStep } from "./editor-actions.js"
import { bootstrapPhpCode } from "./php-bootstrap.js"
import { phpBrowserWordPressDiagnosticsPlugin } from "./php-snippets.js"
import { assertPlaygroundResponseOk, type PlaygroundRunResponse } from "./playground-command-errors.js"
import type { PlaygroundCliServer } from "./preview-server.js"
import type { Page } from "playwright"
import { captureVisualCompareDomSnapshot, type VisualCompareDomSnapshotArtifact } from "./browser-visual-compare.js"

const BROWSER_STEP_DEFAULT_TIMEOUT_MS = 15_000
const BROWSER_SCRIPT_DEFAULT_TIMEOUT_MS = 120_000
const EDITOR_CANVAS_DEFAULT_IFRAME_SELECTOR = 'iframe[name="editor-canvas"]'
const EDITOR_CANVAS_DEFAULT_LAYOUT_SELECTOR = ".block-editor-block-list__layout"
const EDITOR_CANVAS_DEFAULT_BLOCK_SELECTOR = ".block-editor-block-list__block, [data-block]"
const EDITOR_CANVAS_DEFAULT_TIMEOUT_MS = 30_000
const BROWSER_PROBE_PROFILE_OVERRIDES = new Set(["browser", "device", "locale", "permissions", "throttle", "timezone", "user-agent", "viewport"])

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
  storageStateImport?: BrowserStorageStateImport
  failFast: boolean
  stallTimeoutMs: number
  wallTimeoutMs: number
  lifecycleSelectors: string[]
  assertions: ReturnType<typeof browserProbeAssertionsFromArgs>
}

interface BrowserActionsRunPlan {
  initialUrl?: string
  steps: BrowserInteractionStep[]
  capture: Set<string>
  stepTimeoutMs: number
  totalTimeoutMs: number
  networkSettleTimeoutMs: number
  requestedViewport?: { width: number; height: number }
  authRequest?: { userId: number }
  storageStateImport?: BrowserStorageStateImport
  maxDomSnapshotElements: number
}

interface BrowserStorageStateImport {
  storageState: BrowserAuthStorageState
  summary: BrowserStorageStateImportSummary
}

interface BrowserRunPlan {
  profile: string
  capture: string[]
  probe?: BrowserProbeRunPlan
  actions?: BrowserActionsRunPlan
}

interface BrowserCommandProgressEvent {
  command: string
  phase: "checkpoint"
  checkpoint: BrowserProbeScriptCheckpoint
  progress: ReturnType<ReturnType<typeof createBrowserProbeProgressTracker>["summary"]>
}

interface BrowserProbeScriptCheckpoint {
  name: string
  metadata?: unknown
  timestamp: string
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

export { BrowserCommandArtifactError, isBrowserCommandArtifactError }
export { runVisualCompareCommand } from "./browser-visual-compare.js"

export async function runBrowserProbeCommand({
  abortSignal,
  artifactRoot,
  command = "wordpress.browser-probe",
  plan,
  runtimeSpec,
  runPlaygroundCommand,
  server,
  spec,
  onProgress,
}: {
  abortSignal?: AbortSignal
  artifactRoot: string
  command?: string
  plan?: BrowserProbeRunPlan
  runtimeSpec?: RuntimeCreateSpec
  runPlaygroundCommand?: (command: string, server: PlaygroundCliServer, options: { code: string } | { scriptPath: string }) => Promise<PlaygroundRunResponse>
  server: PlaygroundCliServer
  spec: ExecutionSpec
  onProgress?: (event: BrowserCommandProgressEvent) => void
}): Promise<{ artifact: BrowserProbeArtifact; artifacts?: BrowserProbeArtifact[]; output: string }> {
  if (plan) {
    return runSingleBrowserProbeCommand({ abortSignal, artifactRoot, command, plan, runtimeSpec, runPlaygroundCommand, server, spec, browserFilesDirectory: "files/browser", onProgress })
  }

  const profileIds = browserProbeProfileIds(spec.args ?? [])
  if (profileIds.length === 0) {
    const profileId = argValue(spec.args ?? [], "profile")?.trim()
    if (profileId) {
      const profile = browserProbeProfile(profileId)
      return runSingleBrowserProbeCommand({
        abortSignal,
        artifactRoot,
        command,
        runtimeSpec,
        runPlaygroundCommand,
        server,
        spec: { ...spec, args: browserProbeProfileArgs(spec.args ?? [], profile) },
        browserFilesDirectory: "files/browser",
        profileId: profile.id,
        onProgress,
      })
    }
    return runSingleBrowserProbeCommand({ abortSignal, artifactRoot, command, runtimeSpec, runPlaygroundCommand, server, spec, browserFilesDirectory: "files/browser", onProgress })
  }

  const profiles = profileIds.map((profileId) => browserProbeProfile(profileId))
  const artifacts: BrowserProbeArtifact[] = []
  const outputs: unknown[] = []
  for (const profile of profiles) {
    const result = await runSingleBrowserProbeCommand({
      abortSignal,
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
      onProgress,
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
  abortSignal,
  artifactRoot,
  command,
  plan,
  runtimeSpec,
  runPlaygroundCommand,
  server,
  spec,
  browserFilesDirectory,
  profileId,
  onProgress,
}: {
  abortSignal?: AbortSignal
  artifactRoot: string
  command: string
  plan?: BrowserProbeRunPlan
  runtimeSpec?: RuntimeCreateSpec
  runPlaygroundCommand?: (command: string, server: PlaygroundCliServer, options: { code: string } | { scriptPath: string }) => Promise<PlaygroundRunResponse>
  server: PlaygroundCliServer
  spec: ExecutionSpec
  browserFilesDirectory: string
  profileId?: string
  onProgress?: (event: BrowserCommandProgressEvent) => void
}): Promise<{ artifact: BrowserProbeArtifact; output: string }> {
  const args = spec.args ?? []
  const runPlan = plan ?? await browserProbeRunPlanFromArgs(args, profileId)
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
  const storageStateImport = runPlan.storageStateImport
  if (authRequest && storageStateImport) {
    throw new Error(`${command} supports one browser authentication source at a time: use auth=wordpress-admin or storage-state, not both`)
  }
  const failFast = runPlan.failFast
  const stallTimeoutMs = runPlan.stallTimeoutMs
  const wallTimeoutMs = runPlan.wallTimeoutMs
  const livenessPolicy = browserCommandLivenessPolicy({ wallTimeoutMs, idleTimeoutMs: stallTimeoutMs })
  const lifecycleSelectors = runPlan.lifecycleSelectors
  const assertions = runPlan.assertions
  const capturesConsoleForAssertions = assertions.some((assertion) => assertion.type === "no-console-errors" || assertion.type === "no-errors")
  const capturesErrorsForAssertions = assertions.some((assertion) => assertion.type === "no-page-errors" || assertion.type === "no-errors")
  const capturesNetworkForAssertions = browserProbeAssertionsNeedNetwork(assertions)
  const capturesBrowserMetrics = capture.has("performance") || capture.has("memory") || browserProbeAssertionsNeedMetrics(assertions)
  const prePageScriptMetadata = prePageScript ? browserProbeScriptMetadata(prePageScript) : undefined
  const topology = browserPreviewTopology(args, runtimeSpec, server.serverUrl)
  const { preview, networkPolicy } = topology
  const routeTracker = createBrowserPreviewRouteTracker()
  const targetUrl = topology.resolveUrl(runPlan.url)
  const artifactSession = new BrowserArtifactSession(artifactRoot, browserFilesDirectory, { source: command, operation: "browser-probe" })

  const consoleMessages: Record<string, unknown>[] = []
  const errors: BrowserProbeErrorRecord[] = []
  const network: BrowserProbeNetworkRecord[] = []
  const networkTasks: Array<Promise<void>> = []
  const checkpoints: BrowserProbeCheckpointRecord[] = []
  const screenshotPath = artifactSession.absolutePath("screenshot.png")
  const startedAt = now()
  const startedAtMs = Date.now()
  const progress = createBrowserProbeProgressTracker(startedAt, stallTimeoutMs)
  const { devices } = await import("playwright")
  if (requestedContext.browser && !(BROWSER_PROBE_BROWSER_VALUES as readonly string[]).includes(requestedContext.browser)) {
    throw new Error(`wordpress.browser-probe browser=${requestedContext.browser} is unsupported by this runner; supported browsers: ${BROWSER_PROBE_BROWSER_VALUES.join(", ")}.`)
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
  const abortHandler = () => {
    pendingError = pendingError ?? new Error("Browser command aborted during runtime cleanup")
    void page?.close().catch(() => undefined)
    void context?.close().catch(() => undefined)
    void browser.close().catch(() => undefined)
  }
  abortSignal?.addEventListener("abort", abortHandler, { once: true })

  try {
    if (abortSignal?.aborted) {
      abortHandler()
      throw pendingError
    }
    context = browserPreviewNeedsContextRouting(networkPolicy) || !!storageStateImport || requestedContext.device || requestedContext.locale || requestedContext.timezone || requestedContext.userAgent || (requestedContext.permissions?.length ?? 0) > 0
      ? await browser.newContext({
        ...(deviceProfile ?? {}),
        ...(storageStateImport ? { storageState: storageStateImport.storageState } : {}),
        ...(requestedContext.locale ? { locale: requestedContext.locale } : {}),
        ...(requestedContext.timezone ? { timezoneId: requestedContext.timezone } : {}),
        ...(requestedContext.userAgent ? { userAgent: requestedContext.userAgent } : {}),
      })
      : null
    if (context && requestedContext.permissions && requestedContext.permissions.length > 0) {
      await context.grantPermissions(requestedContext.permissions)
    }
    if (context && browserPreviewNeedsContextRouting(networkPolicy)) {
      await routeBrowserPreviewContextNetwork(context, networkPolicy, preview.effectiveOrigin, routeTracker)
    }
    page = context ? await context.newPage() : await browser.newPage()
    if (onProgress) {
      await page.exposeFunction("__wpCodeboxProbeCheckpointEvent", (checkpoint: unknown) => {
        const normalized = normalizeBrowserProbeScriptCheckpoint(checkpoint)
        if (!normalized) {
          return
        }
        progress.mark("checkpoint", normalized.timestamp, normalized)
        onProgress({ command, phase: "checkpoint", checkpoint: normalized, progress: progress.summary() })
      })
    }
    if (storageStateImport) {
      authSummary = browserStorageStateAuthSummary(storageStateImport.summary)
    }
    if (authRequest) {
      authSummary = await installWordPressAdminAuthCookies({ command, cookieUrls: topology.authCookieUrls([targetUrl]), page, runPlaygroundCommand, runtimeSpec, server, userId: authRequest.userId })
    }
    if (requestedViewport) {
      await page.setViewportSize(requestedViewport)
    }
    if (throttleProfile) {
      await applyBrowserProbeThrottleProfile(page, throttleProfile)
    }
    if (!context && browserPreviewNeedsContextRouting(networkPolicy)) {
      await routeBrowserPreviewPageNetwork(page, networkPolicy, preview.effectiveOrigin, routeTracker)
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

    await withBrowserProbeLiveness(page, progress, failFast, navigateBrowserProbe(page, targetUrl, waitFor, durationMs, wallTimeoutMs), livenessPolicy, "navigation")
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
      }, script), livenessPolicy, "script")
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
      await withBrowserProbeLiveness(page, progress, failFast, page.waitForTimeout(durationMs), livenessPolicy, "duration")
      progress.mark("duration")
      if (capturesBrowserMetrics) {
        checkpoints.push(await browserProbeCheckpoint(page, "after-duration"))
      }
    }
    if (assertions.length > 0) {
      await settleBrowserNetworkTasks(networkTasks, livenessPolicy.networkSettleTimeoutMs)
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
    if (isBrowserCommandLivenessError(pendingError)) {
      await page?.close().catch(() => undefined)
      page = null
    }
    progress.fail("probe-error", pendingError)
    errors.push(serializeBrowserError("probe-error", error))
  } finally {
    if (abortSignal?.aborted) {
      await closeBrowserBestEffort(browser)
      abortSignal.removeEventListener("abort", abortHandler)
      throw pendingError ?? new Error("Browser command aborted during runtime cleanup")
    }
    try {
      await drainBrowserPreviewRouteTracker(routeTracker)
    } catch (error) {
      const routeError = error instanceof Error ? error : new Error(String(error))
      if (!pendingError) {
        pendingError = routeError
        progress.fail("probe-error", routeError)
      }
      errors.push(serializeBrowserError("probe-error", error))
    }
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
          await artifactSession.writeText("html", "snapshot.html", html)
          htmlSha256 = sha256(Buffer.from(html, "utf8"))
        } catch (error) {
          errors.push(serializeBrowserError("probe-error", error))
        }
      }

      if (capture.has("screenshot")) {
        try {
          const activePage = page
          await artifactSession.writeGenerated("screenshot", "screenshot.png", (path) => activePage.screenshot({ path, fullPage: true }).then(() => undefined))
          screenshotSha256 = await fileSha256(screenshotPath)
        } catch (error) {
          errors.push(serializeBrowserError("probe-error", error))
        }
      }
    }
    await settleBrowserNetworkTasks(networkTasks, livenessPolicy.networkSettleTimeoutMs)
    await browser.close()
    if (capture.has("console") || capturesConsoleForAssertions) {
      await artifactSession.writeJsonLines("console", "console.jsonl", consoleMessages)
    }
    if (capture.has("errors") || capturesErrorsForAssertions) {
      await artifactSession.writeJsonLines("errors", "errors.jsonl", errors)
    }
    if (capture.has("network") || capturesNetworkForAssertions) {
      await artifactSession.writeJsonLines("network", "network.jsonl", network)
      await artifactSession.writeJson("waterfall", "waterfall.json", browserProbeWaterfallArtifact(network, startedAt))
    }
    if (checkpoints.length > 0) {
      await artifactSession.writeJsonLines("checkpoints", "checkpoints.jsonl", checkpoints)
    }
    if (memoryArtifact) {
      await artifactSession.writeJson("memory", "memory.json", memoryArtifact)
    }
    if (lifecycleArtifact) {
      await artifactSession.writeJson("lifecycle", "lifecycle.json", lifecycleArtifact)
    }
    if (performanceArtifact) {
      await artifactSession.writeJson("performance", "performance.json", performanceArtifact)
    }

    const redirectDiagnostics = browserRedirectDiagnosticsArtifact({
      artifactPath: `${browserFilesDirectory}/redirect-diagnostics.json`,
      error: pendingError,
      finalAttemptedUrl: finalUrl,
      network,
      requestedUrl: targetUrl,
    })
    if (redirectDiagnostics) {
      await artifactSession.writeJson("redirectDiagnostics", "redirect-diagnostics.json", redirectDiagnostics)
    }
    const redirectDiagnosticsSummary = redirectDiagnostics?.summary

    const wordpressDiagnostics = await browserWordPressDiagnosticsArtifact({
      artifactPath: `${browserFilesDirectory}/wordpress-diagnostics.json`,
      network,
      ready: wordpressDiagnosticsReady,
      server,
    })
    if (wordpressDiagnostics) {
      await artifactSession.writeJson("wordpressDiagnostics", "wordpress-diagnostics.json", wordpressDiagnostics)
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
        waterfall: capture.has("network") || capturesNetworkForAssertions,
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
    await artifactSession.writeJson("review", "review.json", review)

    artifact = {
      artifactType: "probe",
      requestedUrl: targetUrl,
      url: targetUrl,
      preview,
      ...(server.previewProxyDiagnostics ? { previewProxy: server.previewProxyDiagnostics } : {}),
      ...(browserPreviewNetworkPolicyIsActive(networkPolicy) ? { networkPolicy: browserPreviewNetworkPolicySummary(networkPolicy) } : {}),
      ...topology.origins,
      ...(prePageScriptMetadata ? { prePageScript: prePageScriptMetadata } : {}),
      files: {
        ...(capture.has("console") || capturesConsoleForAssertions ? { console: `${browserFilesDirectory}/console.jsonl` } : {}),
        ...(checkpoints.length > 0 ? { checkpoints: `${browserFilesDirectory}/checkpoints.jsonl` } : {}),
        ...(capture.has("errors") || capturesErrorsForAssertions ? { errors: `${browserFilesDirectory}/errors.jsonl` } : {}),
        ...(htmlSha256 ? { html: `${browserFilesDirectory}/snapshot.html` } : {}),
        ...(lifecycleArtifact ? { lifecycle: `${browserFilesDirectory}/lifecycle.json` } : {}),
        ...(memoryArtifact ? { memory: `${browserFilesDirectory}/memory.json` } : {}),
        ...(capture.has("network") || capturesNetworkForAssertions ? { network: `${browserFilesDirectory}/network.jsonl` } : {}),
        ...(capture.has("network") || capturesNetworkForAssertions ? { waterfall: `${browserFilesDirectory}/waterfall.json` } : {}),
        ...(performanceArtifact ? { performance: `${browserFilesDirectory}/performance.json` } : {}),
        ...(redirectDiagnostics ? { redirectDiagnostics: `${browserFilesDirectory}/redirect-diagnostics.json` } : {}),
        review: `${browserFilesDirectory}/review.json`,
        ...(screenshotSha256 ? { screenshot: `${browserFilesDirectory}/screenshot.png` } : {}),
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
        ...(server.previewProxyDiagnostics ? { previewProxy: server.previewProxyDiagnostics } : {}),
        ...(browserPreviewNetworkPolicyIsActive(networkPolicy) ? { networkPolicy: browserPreviewNetworkPolicySummary(networkPolicy) } : {}),
        ...(lifecycleArtifact ? { lifecycle: { schema: lifecycleArtifact.schema, version: lifecycleArtifact.version, startedAtMs: lifecycleArtifact.startedAtMs, selectors: lifecycleArtifact.selectors } } : {}),
        liveness: { wallTimeoutMs, stallTimeoutMs, networkSettleTimeoutMs: livenessPolicy.networkSettleTimeoutMs },
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
        screenshot: Boolean(screenshotSha256),
        ...(typeof scriptResult !== "undefined" ? { scriptResult } : {}),
        viewport,
      },
    }
    await artifactSession.writeJson("summary", "summary.json", {
      schema: "wp-codebox/browser-probe/v1",
      requestedUrl: targetUrl,
      preview,
      ...(server.previewProxyDiagnostics ? { previewProxy: server.previewProxyDiagnostics } : {}),
      ...(browserPreviewNetworkPolicyIsActive(networkPolicy) ? { networkPolicy: browserPreviewNetworkPolicySummary(networkPolicy) } : {}),
      ...topology.origins,
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
    })
  }

  abortSignal?.removeEventListener("abort", abortHandler)
  if (pendingError) {
    if (!artifact) {
      throw pendingError
    }
    throw new BrowserCommandArtifactError(pendingError.message, artifact)
  }
  if (!artifact) {
    throw new Error("wordpress.browser-probe did not produce a browser artifact")
  }
  return {
    artifact,
    output: `${JSON.stringify({
      command,
      requestedUrl: targetUrl,
      preview,
      ...(server.previewProxyDiagnostics ? { previewProxy: server.previewProxyDiagnostics } : {}),
      ...(browserPreviewNetworkPolicyIsActive(networkPolicy) ? { networkPolicy: browserPreviewNetworkPolicySummary(networkPolicy) } : {}),
      ...topology.origins,
      finalUrl: artifact.summary.finalUrl ?? targetUrl,
      files: artifact.files,
      summary: artifact.summary,
    }, null, 2)}\n`,
  }
}

async function closeBrowserBestEffort(browser: import("playwright").Browser): Promise<void> {
  await Promise.race([
    browser.close().catch(() => undefined),
    new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 1_000)
      timeout.unref()
    }),
  ])
}

function browserProbeProfileIds(args: string[]): string[] {
  const raw = argValue(args, "profiles")?.trim()
  if (!raw) {
    return []
  }
  return raw.split(",").map((profile) => profile.trim()).filter(Boolean)
}

function browserProbeProfile(profileId: string): BrowserProbeProfileDefinition {
  const profile = BROWSER_PROBE_PROFILES[profileId as keyof typeof BROWSER_PROBE_PROFILES]
  if (!profile) {
    throw new Error(`wordpress.browser-probe unknown profile: ${profileId}. Supported profiles: ${BROWSER_PROBE_CHROMIUM_PROFILE_IDS.join(", ")}`)
  }
  return profile
}

async function browserProbeRunPlanFromArgs(args: string[], profileId?: string): Promise<BrowserProbeRunPlan> {
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
    storageStateImport: await browserStorageStateImportFromArgs(args, "wordpress.browser-probe"),
    failFast: strictBooleanArg(args, "fail-fast", false),
    stallTimeoutMs: durationArg(args, "stall-timeout", 0),
    wallTimeoutMs: durationArg(args, "timeout", browserCommandLivenessPolicy().wallTimeoutMs),
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
    throw new Error(`wordpress.browser-probe unknown throttle profile: ${profileId}. Supported profiles: ${BROWSER_PROBE_THROTTLE_PROFILE_IDS.join(", ")}`)
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
    network: browserProbeNetworkReviewSummary(input.network, input.files.network, input.files.waterfall),
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

function browserProbeWaterfallArtifact(network: BrowserProbeNetworkRecord[], startedAt: string): BrowserProbeWaterfallArtifact {
  return {
    schema: "wp-codebox/browser-waterfall/v1",
    version: 1,
    capturedAt: now(),
    startedAt,
    summary: {
      requests: network.length,
      responses: network.filter((record) => record.type === "response").length,
      failures: network.filter((record) => record.type === "requestfailed").length,
      transferSizeBytes: network.reduce((total, record) => total + finiteNumber(record.transferSize, 0), 0),
    },
    log: {
      version: "1.2",
      creator: { name: "wp-codebox", version: "1" },
      entries: network.map(browserProbeWaterfallEntry),
    },
  }
}

function browserProbeWaterfallEntry(record: BrowserProbeNetworkRecord): BrowserProbeWaterfallEntry {
  const timings = browserProbeWaterfallTimings(record.timing ?? {})
  const startedDateTime = browserProbeWaterfallStartedDateTime(record)
  const responseEnd = finiteNumber(record.timing?.responseEnd, 0)
  const fallbackTime = Math.max(0, Date.parse(record.timestamp) - Date.parse(startedDateTime))
  const time = responseEnd > 0 ? responseEnd : fallbackTime
  return {
    startedDateTime,
    time,
    request: {
      method: record.method,
      url: redactBrowserArtifactUrl(record.url),
    },
    response: {
      status: record.status ?? 0,
      statusText: record.statusText ?? (record.type === "requestfailed" ? "Request Failed" : ""),
      content: { mimeType: record.contentType ?? "" },
      redirectURL: "",
    },
    cache: {},
    timings,
    _wpCodebox: {
      type: record.type,
      resourceType: record.resourceType,
      timestamp: record.timestamp,
      ...(typeof record.ok === "boolean" ? { ok: record.ok } : {}),
      ...(typeof record.transferSize === "number" ? { transferSize: record.transferSize } : {}),
      ...(typeof record.requestBodySize === "number" ? { requestBodySize: record.requestBodySize } : {}),
      ...(typeof record.responseBodySize === "number" ? { responseBodySize: record.responseBodySize } : {}),
      ...(record.failure ? { failure: record.failure } : {}),
    },
  }
}

function browserProbeWaterfallTimings(timing: Record<string, number>): BrowserProbeWaterfallEntry["timings"] {
  const requestStart = finiteNumber(timing.requestStart, 0)
  const responseStart = finiteNumber(timing.responseStart, 0)
  const responseEnd = finiteNumber(timing.responseEnd, responseStart)
  const dns = timingDelta(timing.domainLookupStart, timing.domainLookupEnd)
  const connect = timingDelta(timing.connectStart, timing.connectEnd)
  const ssl = timingDelta(timing.secureConnectionStart, timing.connectEnd)
  return {
    blocked: Math.max(0, requestStart),
    dns,
    connect,
    ssl,
    send: timingDelta(timing.requestStart, timing.requestStart),
    wait: responseStart >= requestStart ? responseStart - requestStart : 0,
    receive: responseEnd >= responseStart ? responseEnd - responseStart : 0,
  }
}

function browserProbeWaterfallStartedDateTime(record: BrowserProbeNetworkRecord): string {
  const startTime = record.timing?.startTime
  if (typeof startTime === "number" && Number.isFinite(startTime) && startTime > 0) {
    return new Date(startTime).toISOString()
  }
  return record.timestamp
}

function timingDelta(start: number | undefined, end: number | undefined): number {
  if (typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
    return -1
  }
  return end - start
}

function finiteNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function redactBrowserArtifactUrl(url: string): string {
  return redactString(url, { redactAllUrlQueryValues: true, redactUrlHash: true, redactQueryAssignments: true })
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
  waterfall: boolean
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
    ...(input.waterfall ? { waterfall: { path: `${browserFilesDirectory}/waterfall.json`, kind: "json" as const } } : {}),
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
  classification: "php-fatal" | "http-5xx-status" | "http-response-code-5xx"
  severity: "error"
  errorType?: number
  message: string
  file?: string
  line?: number
  status?: number
  statusHeader?: string
  requestUri?: string
  backtrace?: Array<{ file?: string; line?: number; function?: string; class?: string; type?: string }>
  capturedAt: string
}

interface BrowserWordPressDiagnosticsArtifact {
  schema: "wp-codebox/browser-wordpress-diagnostics/v1"
  version: 1
  capturedAt: string
  status: BrowserWordPressDiagnosticsSummary["status"]
  document5xxResponses: Array<{ url: string; status: number; statusText?: string; responseTextPreview?: string; responseTextSha256?: string; responseTextTruncated?: boolean }>
  diagnostics: BrowserWordPressDiagnosticRecord[]
  summary: BrowserWordPressDiagnosticsSummary
}

const BROWSER_WORDPRESS_DIAGNOSTICS_LOG = "/wordpress/wp-content/wp-codebox-browser-diagnostics.jsonl"
const BROWSER_WORDPRESS_DIAGNOSTICS_MU_PLUGIN = "/wordpress/wp-content/mu-plugins/000-wp-codebox-browser-diagnostics.php"
const BROWSER_WORDPRESS_DIAGNOSTICS_PLUGIN = phpBrowserWordPressDiagnosticsPlugin()

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
      url: browserRedirectSafeUrl(safeBrowserProbeUrl(record.url) ?? record.url),
      status: record.status as number,
      ...(record.statusText ? { statusText: record.statusText } : {}),
      ...(record.responseTextPreview ? { responseTextPreview: record.responseTextPreview } : {}),
      ...(record.responseTextSha256 ? { responseTextSha256: record.responseTextSha256 } : {}),
      ...(typeof record.responseTextTruncated === "boolean" ? { responseTextTruncated: record.responseTextTruncated } : {}),
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
  if (record.schema !== "wp-codebox/browser-wordpress-diagnostic-record/v1" || !isBrowserWordPressDiagnosticClassification(record.classification)) {
    return undefined
  }

  const classification = record.classification

  return {
    schema: "wp-codebox/browser-wordpress-diagnostic-record/v1",
    classification,
    severity: "error",
    ...(typeof record.errorType === "number" && Number.isFinite(record.errorType) ? { errorType: record.errorType } : {}),
    message: sanitizeBrowserWordPressDiagnosticString(typeof record.message === "string" ? record.message : ""),
    ...(typeof record.file === "string" && record.file.length > 0 ? { file: sanitizeBrowserWordPressDiagnosticString(record.file) } : {}),
    ...(typeof record.line === "number" && Number.isFinite(record.line) ? { line: record.line } : {}),
    ...(typeof record.status === "number" && Number.isFinite(record.status) ? { status: record.status } : {}),
    ...(typeof record.statusHeader === "string" && record.statusHeader.length > 0 ? { statusHeader: sanitizeBrowserWordPressDiagnosticString(record.statusHeader) } : {}),
    ...(typeof record.requestUri === "string" && record.requestUri.length > 0 ? { requestUri: sanitizeBrowserWordPressDiagnosticRequestUri(record.requestUri) } : {}),
    ...(Array.isArray(record.backtrace) ? { backtrace: sanitizeBrowserWordPressDiagnosticBacktrace(record.backtrace) } : {}),
    capturedAt: typeof record.capturedAt === "string" ? record.capturedAt : now(),
  }
}

function isBrowserWordPressDiagnosticClassification(value: unknown): value is BrowserWordPressDiagnosticRecord["classification"] {
  return value === "php-fatal" || value === "http-5xx-status" || value === "http-response-code-5xx"
}

function sanitizeBrowserWordPressDiagnosticString(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => browserRedirectSafeUrl(url))
    .replace(/([?&][^=&#\s"'<>]+)=([^&#\s"'<>]+)/g, "$1=[redacted]")
    .replace(/((?:access[_-]?token|auth|bearer|code|cookie|credential|key|login|nonce|pass|password|secret|session|state|token)["'\s:=]+)[^\s"'<>]+/gi, "$1[redacted]")
}

function sanitizeBrowserWordPressDiagnosticRequestUri(value: string): string {
  try {
    const parsed = new URL(value, "http://wp-codebox.local")
    const queryKeys = [...new Set([...parsed.searchParams.keys()])].sort()
    const query = queryKeys.length > 0 ? `?${queryKeys.map((key) => `${encodeURIComponent(key)}=[redacted]`).join("&")}` : ""
    return `${parsed.pathname || "/"}${query}${parsed.hash ? "#[redacted]" : ""}`
  } catch {
    return sanitizeBrowserWordPressDiagnosticString(value)
  }
}

function sanitizeBrowserWordPressDiagnosticBacktrace(value: unknown[]): BrowserWordPressDiagnosticRecord["backtrace"] {
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return []
    }
    const frame = entry as Record<string, unknown>
    return [{
      ...(typeof frame.file === "string" && frame.file.length > 0 ? { file: sanitizeBrowserWordPressDiagnosticString(frame.file) } : {}),
      ...(typeof frame.line === "number" && Number.isFinite(frame.line) ? { line: frame.line } : {}),
      ...(typeof frame.function === "string" && frame.function.length > 0 ? { function: sanitizeBrowserWordPressDiagnosticString(frame.function) } : {}),
      ...(typeof frame.class === "string" && frame.class.length > 0 ? { class: sanitizeBrowserWordPressDiagnosticString(frame.class) } : {}),
      ...(typeof frame.type === "string" && frame.type.length > 0 ? { type: sanitizeBrowserWordPressDiagnosticString(frame.type) } : {}),
    }]
  }).slice(0, 12)
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
  for (const item of capture) {
    if (item !== "screenshot") {
      throw new Error(`wordpress.editor-canvas-probe capture supports screenshot: ${item}`)
    }
  }

  const iframeSelector = argValue(args, "iframe-selector")?.trim() || EDITOR_CANVAS_DEFAULT_IFRAME_SELECTOR
  const layoutSelector = argValue(args, "layout-selector")?.trim() || EDITOR_CANVAS_DEFAULT_LAYOUT_SELECTOR
  const blockSelector = argValue(args, "block-selector")?.trim() || EDITOR_CANVAS_DEFAULT_BLOCK_SELECTOR
  const timeoutMs = editorCanvasTimeoutMs(args)
  const selectorGroups = editorCanvasSelectorGroups(args, layoutSelector, blockSelector)
  const preview = browserPreviewRouting(args, runtimeSpec, server.serverUrl)
  const previewOrigins = browserPreviewOrigins(preview)
  const targetUrl = resolveBrowserPreviewUrl(urlArg, preview.effectiveOrigin)
  const artifactSession = new BrowserArtifactSession(artifactRoot, "files/browser", { source: "wordpress.editor-canvas-probe", operation: "editor-canvas-probe" })
  const screenshotPath = artifactSession.absolutePath("editor-canvas-screenshot.png")
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
        try {
          await artifactSession.writeGenerated("screenshot", "editor-canvas-screenshot.png", (path) => probe.frame.locator(layoutSelector).first().screenshot({ path, timeout: timeoutMs }).then(() => undefined))
        } catch (error) {
          probe.summary.diagnostics.push({
            code: "screenshot-fallback",
            severity: "warning",
            message: `Frame screenshot was unstable; captured full page fallback instead: ${error instanceof Error ? error.message : String(error)}`,
          })
          await artifactSession.writeGenerated("screenshot", "editor-canvas-screenshot.png", (path) => probe.frame.page().screenshot({ path, fullPage: true }).then(() => undefined))
        }
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

    await artifactSession.writeJson("summary", "editor-canvas-summary.json", {
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
    })

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
      await artifactSession.writeJson("summary", "editor-canvas-summary.json", {
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
      })
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
  onProgress,
}: {
  artifactRoot: string
  plan?: BrowserActionsRunPlan
  runtimeSpec: RuntimeCreateSpec
  runPlaygroundCommand?: (command: string, server: PlaygroundCliServer, options: { code: string } | { scriptPath: string }) => Promise<PlaygroundRunResponse>
  server: PlaygroundCliServer
  spec: ExecutionSpec
  onProgress?: (event: BrowserCommandProgressEvent) => void
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
  const livenessPolicy = browserCommandLivenessPolicy({ wallTimeoutMs: totalTimeoutMs, networkSettleTimeoutMs: runPlan.networkSettleTimeoutMs })
  const requestedViewport = runPlan.requestedViewport
  const authRequest = runPlan.authRequest
  const storageStateImport = runPlan.storageStateImport
  if (authRequest && storageStateImport) {
    throw new Error("wordpress.browser-actions supports one browser authentication source at a time: use auth=wordpress-admin or storage-state, not both")
  }
  const maxDomSnapshotElements = runPlan.maxDomSnapshotElements
  const artifactSession = new BrowserArtifactSession(artifactRoot, "files/browser", { source: "wordpress.browser-actions", operation: "browser-actions" })

  const stepRecords: BrowserStepRecord[] = []
  const consoleMessages: Record<string, unknown>[] = []
  const errors: BrowserProbeErrorRecord[] = []
  const network: BrowserProbeNetworkRecord[] = []
  const networkTasks: Array<Promise<void>> = []
  const screenshotPath = artifactSession.absolutePath("screenshot.png")
  const startedAt = now()
  const startedAtMs = Date.now()
  const progress = createBrowserProbeProgressTracker(startedAt, 0)
  const browser = await launchChromiumBrowser()
  const topology = browserPreviewTopology(args, runtimeSpec, server.serverUrl)
  const { preview, networkPolicy } = topology
  let requestedUrl = initialUrl ? topology.resolveUrl(initialUrl) : preview.effectiveOrigin
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
    const context = browserPreviewNeedsContextRouting(networkPolicy) || !!storageStateImport ? await browser.newContext({
      ...(storageStateImport ? { storageState: storageStateImport.storageState } : {}),
    }) : null
    if (context) {
      await routeBrowserPreviewContextNetwork(context, networkPolicy, preview.effectiveOrigin)
    }
    const page = context ? await context.newPage() : await browser.newPage()
    if (onProgress) {
      await page.exposeFunction("__wpCodeboxProbeCheckpointEvent", (checkpoint: unknown) => {
        const normalized = normalizeBrowserProbeScriptCheckpoint(checkpoint)
        if (!normalized) {
          return
        }
        progress.mark("checkpoint", normalized.timestamp, normalized)
        onProgress({ command: "wordpress.browser-actions", phase: "checkpoint", checkpoint: normalized, progress: progress.summary() })
      })
    }
    await page.addInitScript(BROWSER_PROBE_STATE_INIT_SCRIPT)
    if (storageStateImport) {
      authSummary = browserStorageStateAuthSummary(storageStateImport.summary)
    }
    if (authRequest) {
      authSummary = await installWordPressAdminAuthCookies({ command: "wordpress.browser-actions", cookieUrls: topology.authCookieUrls(browserActionTargetUrls(steps, preview.effectiveOrigin, requestedUrl)), page, runPlaygroundCommand, runtimeSpec, server, userId: authRequest.userId })
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
        const outcome = await withBrowserCommandLiveness({
          command: "wordpress.browser-actions",
          phase: `step ${index} (${step.kind})`,
          operation: executeBrowserInteractionStep(page, step, preview.effectiveOrigin, stepTimeoutMs, async (fileName, write) => {
            await artifactSession.writeGenerated("screenshot", fileName, write)
            return { path: artifactSession.path(fileName), isDefault: fileName === "screenshot.png" }
          }),
          policy: { wallTimeoutMs: Math.min(browserStepTimeoutMs(step, stepTimeoutMs), livenessRemainingWallTimeMs(startedAtMs, totalTimeoutMs)), idleTimeoutMs: 0 },
        })
        finalUrl = page.url()
        if (step.kind === "navigate") {
          requestedUrl = resolveBrowserPreviewUrl((step.url ?? "").trim(), preview.effectiveOrigin)
        }
        if (outcome.screenshot && capture.has("screenshot") && outcome.screenshotIsDefault) {
          screenshotSha256 = await fileSha256(screenshotPath)
        }
        if (outcome.screenshot && capture.has("dom-snapshot")) {
          domSnapshots.push(await captureBrowserActionDomSnapshot({
            artifactSession,
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
        if (isBrowserCommandLivenessError(pendingError)) {
          await page.close().catch(() => undefined)
        }
        break
      }
    }

    if (capture.has("html")) {
      try {
        const html = await page.content()
        await artifactSession.writeText("html", "snapshot.html", html)
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
        await artifactSession.writeGenerated("screenshot", "screenshot.png", (path) => page.screenshot({ path, fullPage: true }).then(() => undefined))
        screenshotSha256 = await fileSha256(screenshotPath)
        if (capture.has("dom-snapshot")) {
          domSnapshots.push(await captureBrowserActionDomSnapshot({
            artifactSession,
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
    await settleBrowserNetworkTasks(networkTasks, livenessPolicy.networkSettleTimeoutMs)
    await browser.close()
    if (capture.has("steps")) {
      await artifactSession.writeJsonLines("steps", "steps.jsonl", stepRecords)
    }
    if (capture.has("console")) {
      await artifactSession.writeJsonLines("console", "console.jsonl", consoleMessages)
    }
    if (capture.has("errors")) {
      await artifactSession.writeJsonLines("errors", "errors.jsonl", errors)
    }
    if (capture.has("network")) {
      await artifactSession.writeJsonLines("network", "network.jsonl", network)
      await artifactSession.writeJson("waterfall", "waterfall.json", browserProbeWaterfallArtifact(network, startedAt))
    }

    const redirectDiagnostics = browserRedirectDiagnosticsArtifact({
      artifactPath: "files/browser/redirect-diagnostics.json",
      error: pendingError,
      finalAttemptedUrl: finalUrl,
      network,
      requestedUrl,
    })
    if (redirectDiagnostics) {
      await artifactSession.writeJson("redirectDiagnostics", "redirect-diagnostics.json", redirectDiagnostics)
    }
    const redirectDiagnosticsSummary = redirectDiagnostics?.summary

    const wordpressDiagnostics = await browserWordPressDiagnosticsArtifact({
      artifactPath: "files/browser/wordpress-diagnostics.json",
      network,
      ready: wordpressDiagnosticsReady,
      server,
    })
    if (wordpressDiagnostics) {
      await artifactSession.writeJson("wordpressDiagnostics", "wordpress-diagnostics.json", wordpressDiagnostics)
    }
    const wordpressDiagnosticsSummary = wordpressDiagnostics?.summary

    const assertions = browserAssertionsSummary(stepRecords)
    artifact = {
      artifactType: "actions",
      requestedUrl,
      url: requestedUrl,
      preview,
      ...(server.previewProxyDiagnostics ? { previewProxy: server.previewProxyDiagnostics } : {}),
      ...(browserPreviewNetworkPolicyIsActive(networkPolicy) ? { networkPolicy: browserPreviewNetworkPolicySummary(networkPolicy) } : {}),
      ...topology.origins,
      files: {
        ...(capture.has("steps") ? { steps: "files/browser/steps.jsonl" } : {}),
        ...(capture.has("console") ? { console: "files/browser/console.jsonl" } : {}),
        ...(capture.has("errors") ? { errors: "files/browser/errors.jsonl" } : {}),
        ...(htmlSha256 ? { html: "files/browser/snapshot.html" } : {}),
        ...(capture.has("network") ? { network: "files/browser/network.jsonl" } : {}),
        ...(capture.has("network") ? { waterfall: "files/browser/waterfall.json" } : {}),
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
        ...(server.previewProxyDiagnostics ? { previewProxy: server.previewProxyDiagnostics } : {}),
        ...(browserPreviewNetworkPolicyIsActive(networkPolicy) ? { networkPolicy: browserPreviewNetworkPolicySummary(networkPolicy) } : {}),
        ...(domSnapshots.length > 0 ? { domSnapshots } : {}),
        liveness: { wallTimeoutMs: totalTimeoutMs, networkSettleTimeoutMs: livenessPolicy.networkSettleTimeoutMs },
        networkEvents: network.length,
        ...(redirectDiagnosticsSummary ? { redirectDiagnostics: redirectDiagnosticsSummary } : {}),
        ...(wordpressDiagnosticsSummary ? { wordpressDiagnostics: wordpressDiagnosticsSummary } : {}),
        replayability: browserProbeReplayability(capture),
        screenshot: capture.has("screenshot"),
        auth: authSummary,
        viewport,
      },
    }
    await artifactSession.writeJson("summary", "action-summary.json", {
      schema: "wp-codebox/browser-actions/v1",
      requestedUrl,
      preview,
      ...(server.previewProxyDiagnostics ? { previewProxy: server.previewProxyDiagnostics } : {}),
      finalUrl,
      capture: [...capture].sort(),
      stepTimeoutMs,
      totalTimeoutMs,
      networkSettleTimeoutMs: livenessPolicy.networkSettleTimeoutMs,
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
    })
  }

  if (pendingError) {
    if (!artifact) {
      throw pendingError
    }
    throw new BrowserCommandArtifactError(`wordpress.browser-actions failed after ${stepRecords.length} step(s): ${pendingError.message}`, artifact)
  }
  if (!artifact) {
    throw new Error("wordpress.browser-actions did not produce a browser artifact")
  }

  return {
    artifact,
    output: `${JSON.stringify({
      command: "wordpress.browser-actions",
      requestedUrl,
      preview,
      ...(server.previewProxyDiagnostics ? { previewProxy: server.previewProxyDiagnostics } : {}),
      finalUrl: artifact.summary.finalUrl ?? finalUrl,
      files: artifact.files,
      summary: artifact.summary,
      steps: stepRecords,
    }, null, 2)}\n`,
  }
}

async function browserActionsRunPlanFromArgs(args: string[]): Promise<BrowserActionsRunPlan> {
  const capture = new Set(commaListArg(args, "capture"))
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
    networkSettleTimeoutMs: durationArg(args, "network-settle-timeout", browserCommandLivenessPolicy().networkSettleTimeoutMs),
    requestedViewport: viewportArg(args, "viewport"),
    authRequest: browserAuthRequest(args),
    storageStateImport: await browserStorageStateImportFromArgs(args, "wordpress.browser-actions"),
    maxDomSnapshotElements: positiveIntegerArg(args, "max-dom-snapshot-elements", 160),
  }
}

async function captureBrowserActionDomSnapshot({
  artifactSession,
  finalUrl,
  maxElements,
  page,
  screenshotRef,
  snapshotRef,
  step,
  viewport,
}: {
  artifactSession: BrowserArtifactSession
  finalUrl: string
  maxElements: number
  page: Page
  screenshotRef: string
  snapshotRef?: string
  step?: { index: number; name?: string; kind: string }
  viewport: BrowserProbeViewport | null
}): Promise<{ screenshot: string; snapshot: string; step?: { index: number; name?: string; kind: string }; elementCount: number; capturedElements: number; truncated: boolean }> {
  const sanitizedName = step?.name ? sanitizeScreenshotName(step.name) : undefined
  const relativeSnapshotRef = snapshotRef ?? `files/browser/dom-snapshot-${sanitizedName || `step-${step?.index ?? 0}`}.json`
  const snapshotFileName = relativeSnapshotRef.replace(/^files\/browser\//, "")
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
  await artifactSession.writeJson("domSnapshots", snapshotFileName, artifact)
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
  const artifactSession = new BrowserArtifactSession(artifactRoot, "files/browser", { source: "wordpress.browser-scenario", operation: "browser-scenario" })

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
  await artifactSession.writeJson("summary", "scenario-summary.json", scenarioSummary)

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
  const text = raw.startsWith("@") ? await readFile(resolveCommandPath(raw.slice(1)), "utf8") : raw
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
      wallTimeoutMs: durationStringMs(scenario.timeout ?? argValue(args, "timeout")) || browserCommandLivenessPolicy().wallTimeoutMs,
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
      networkSettleTimeoutMs: durationArg(args, "network-settle-timeout", browserCommandLivenessPolicy().networkSettleTimeoutMs),
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
  const topology = browserPreviewTopology(args, runtimeSpec, server.serverUrl)
  const { preview, networkPolicy } = topology
  const targetUrl = topology.resolveUrl(target.url)
  const artifactSession = new BrowserArtifactSession(artifactRoot, "files/browser", { source: "wordpress.editor-open", operation: "editor-open" })

  const stepRecords: BrowserStepRecord[] = []
  const consoleMessages: Record<string, unknown>[] = []
  const errors: BrowserProbeErrorRecord[] = []
  const screenshotPath = artifactSession.absolutePath("editor-screenshot.png")
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
      await routeBrowserPreviewContextNetwork(context, networkPolicy, preview.effectiveOrigin)
    }
    const page = context ? await context.newPage() : await browser.newPage()
    authSummary = await installWordPressAdminAuthCookies({ command: "wordpress.editor-open", cookieUrls: topology.authCookieUrls([targetUrl]), page, runPlaygroundCommand, runtimeSpec, server, userId: 1 })
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
      await artifactSession.writeJson("editorState", "editor-state.json", editorState)
    }
    if (capture.has("html")) {
      const html = await page.content()
      await artifactSession.writeText("html", "editor-snapshot.html", html)
      htmlSha256 = sha256(Buffer.from(html, "utf8"))
    }
    if (capture.has("screenshot")) {
      await artifactSession.writeGenerated("screenshot", "editor-screenshot.png", (path) => page.screenshot({ path, fullPage: true }).then(() => undefined))
      screenshotSha256 = await fileSha256(screenshotPath)
    }
  } finally {
    await browser.close()
    if (capture.has("steps")) {
      await artifactSession.writeJsonLines("steps", "editor-steps.jsonl", stepRecords)
    }
    if (capture.has("console")) {
      await artifactSession.writeJsonLines("console", "editor-console.jsonl", consoleMessages)
    }
    if (capture.has("errors")) {
      await artifactSession.writeJsonLines("errors", "editor-errors.jsonl", errors)
    }

    const editorSummary = editorState ? summarizeEditorState(target, editorState) : undefined
    artifact = {
      artifactType: "editor-open",
      requestedUrl: targetUrl,
      url: targetUrl,
      preview,
      ...(server.previewProxyDiagnostics ? { previewProxy: server.previewProxyDiagnostics } : {}),
      ...(browserPreviewNetworkPolicyIsActive(networkPolicy) ? { networkPolicy: browserPreviewNetworkPolicySummary(networkPolicy) } : {}),
      ...topology.origins,
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
        ...(server.previewProxyDiagnostics ? { previewProxy: server.previewProxyDiagnostics } : {}),
        auth: authSummary,
        ...(browserPreviewNetworkPolicyIsActive(networkPolicy) ? { networkPolicy: browserPreviewNetworkPolicySummary(networkPolicy) } : {}),
        networkEvents: 0,
        replayability: browserProbeReplayability(capture),
        screenshot: capture.has("screenshot"),
        ...(editorSummary ? { editor: editorSummary } : {}),
        viewport,
      },
    }
    await artifactSession.writeJson("summary", "editor-summary.json", {
      schema: "wp-codebox/editor-open/v1",
      target,
      requestedUrl: targetUrl,
      preview,
      ...(server.previewProxyDiagnostics ? { previewProxy: server.previewProxyDiagnostics } : {}),
      ...(browserPreviewNetworkPolicyIsActive(networkPolicy) ? { networkPolicy: browserPreviewNetworkPolicySummary(networkPolicy) } : {}),
      ...topology.origins,
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
    })
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
      ...(server.previewProxyDiagnostics ? { previewProxy: server.previewProxyDiagnostics } : {}),
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
  const topology = browserPreviewTopology(args, runtimeSpec, server.serverUrl)
  const { preview, networkPolicy } = topology
  const targetUrl = topology.resolveUrl(target.url)
  const artifactSession = new BrowserArtifactSession(artifactRoot, "files/browser", { source: "wordpress.editor-actions", operation: "editor-actions" })

  const stepRecords: BrowserStepRecord[] = []
  const consoleMessages: Record<string, unknown>[] = []
  const errors: BrowserProbeErrorRecord[] = []
  const screenshotPath = artifactSession.absolutePath("editor-action-screenshot.png")
  const startedAt = now()
  const startedAtMs = Date.now()
  const browser = await launchChromiumBrowser()
  let finalUrl = targetUrl
  let htmlSha256: string | undefined
  let screenshotSha256: string | undefined
  let viewport: BrowserProbeViewport | null = null
  let editorState: EditorStateSnapshot | undefined
  let editorReadiness: BrowserEditorReadinessSummary | undefined
  let editorSave: BrowserEditorSaveSummary | undefined
  let authSummary: BrowserProbeAuthSummary | undefined
  let pendingError: Error | undefined
  let artifact: BrowserArtifact | undefined

  try {
    const context = browserPreviewNeedsContextRouting(networkPolicy) ? await browser.newContext() : null
    if (context) {
      await routeBrowserPreviewContextNetwork(context, networkPolicy, preview.effectiveOrigin)
    }
    const page = context ? await context.newPage() : await browser.newPage()
    authSummary = await installWordPressAdminAuthCookies({ command: "wordpress.editor-actions", cookieUrls: topology.authCookieUrls([targetUrl]), page, runPlaygroundCommand, runtimeSpec, server, userId: 1 })
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
        const result = await executeEditorActionStep(page, step, stepTimeoutMs)
        if (result?.state) {
          editorState = { schema: "wp-codebox/editor-state/v1", capturedAt: now(), target, ...result.state }
        }
        if (result?.readiness) {
          editorReadiness = result.readiness
        }
        if (result?.save) {
          editorSave = result.save
        }
        finalUrl = page.url()
        stepRecords.push(browserStepRecord(index + 2, { kind: step.kind } as never, "ok", actionStartedAt, actionStartedAtMs, finalUrl, {
          ...(result?.readiness ? { editorReadiness: result.readiness } : {}),
          ...(result?.save ? { editorSave: result.save } : {}),
        } as never))
      } catch (error) {
        const serialized = serializeBrowserError("probe-error", error)
        errors.push(serialized)
        stepRecords.push(browserStepRecord(index + 2, { kind: step.kind } as never, "failed", actionStartedAt, actionStartedAtMs, page.url(), { error: serialized }))
        pendingError = error instanceof Error ? error : new Error(String(error))
      }
    }

    if (capture.has("editor-state")) {
      editorState = await captureEditorState(page, target)
      await artifactSession.writeJson("editorState", "editor-action-state.json", editorState)
    }
    if (capture.has("html")) {
      const html = await page.content()
      await artifactSession.writeText("html", "editor-action-snapshot.html", html)
      htmlSha256 = sha256(Buffer.from(html, "utf8"))
    }
    if (capture.has("screenshot")) {
      await artifactSession.writeGenerated("screenshot", "editor-action-screenshot.png", (path) => page.screenshot({ path, fullPage: true }).then(() => undefined))
      screenshotSha256 = await fileSha256(screenshotPath)
    }
  } finally {
    await browser.close()
    if (capture.has("steps")) {
      await artifactSession.writeJsonLines("steps", "editor-action-steps.jsonl", stepRecords)
    }
    if (capture.has("console")) {
      await artifactSession.writeJsonLines("console", "editor-action-console.jsonl", consoleMessages)
    }
    if (capture.has("errors")) {
      await artifactSession.writeJsonLines("errors", "editor-action-errors.jsonl", errors)
    }

    const editorSummary = editorState ? summarizeEditorState(target, editorState) : undefined
    artifact = {
      artifactType: "editor-actions",
      requestedUrl: targetUrl,
      url: targetUrl,
      preview,
      ...(server.previewProxyDiagnostics ? { previewProxy: server.previewProxyDiagnostics } : {}),
      ...(browserPreviewNetworkPolicyIsActive(networkPolicy) ? { networkPolicy: browserPreviewNetworkPolicySummary(networkPolicy) } : {}),
      ...topology.origins,
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
        ...(server.previewProxyDiagnostics ? { previewProxy: server.previewProxyDiagnostics } : {}),
        auth: authSummary,
        ...(browserPreviewNetworkPolicyIsActive(networkPolicy) ? { networkPolicy: browserPreviewNetworkPolicySummary(networkPolicy) } : {}),
        networkEvents: 0,
        replayability: browserProbeReplayability(capture),
        screenshot: capture.has("screenshot"),
        ...(editorSummary ? { editor: editorSummary } : {}),
        ...(editorReadiness ? { editorReadiness } : {}),
        ...(editorSave ? { editorSave } : {}),
        viewport,
      },
    }
    await artifactSession.writeJson("summary", "editor-action-summary.json", {
      schema: "wp-codebox/editor-actions/v1",
      target,
      actions: actionSteps,
      requestedUrl: targetUrl,
      preview,
      ...(server.previewProxyDiagnostics ? { previewProxy: server.previewProxyDiagnostics } : {}),
      ...(browserPreviewNetworkPolicyIsActive(networkPolicy) ? { networkPolicy: browserPreviewNetworkPolicySummary(networkPolicy) } : {}),
      ...topology.origins,
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
    })
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
      ...(server.previewProxyDiagnostics ? { previewProxy: server.previewProxyDiagnostics } : {}),
      finalUrl: artifact.summary.finalUrl ?? finalUrl,
      files: artifact.files,
      summary: artifact.summary,
      steps: stepRecords,
    }, null, 2)}\n`,
  }
}



interface EditorActionStepResult {
  state?: Omit<EditorStateSnapshot, "schema" | "capturedAt" | "target">
  readiness?: BrowserEditorReadinessSummary
  save?: BrowserEditorSaveSummary
}

async function executeEditorActionStep(page: import("playwright").Page, step: EditorActionStep, timeoutMs: number): Promise<EditorActionStepResult | undefined> {
  switch (step.kind) {
    case "open":
      return undefined
    case "waitForReady":
      return { readiness: await waitForEditorReadiness(page, stepTimeoutMs(step, timeoutMs)) }
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
      return { state: await page.evaluate(() => {
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
      }) }
    case "savePost":
      return { save: await saveEditorPost(page, step, stepTimeoutMs(step, timeoutMs)) }
  }
}

async function waitForEditorReadiness(page: import("playwright").Page, timeoutMs: number): Promise<BrowserEditorReadinessSummary> {
  return page.waitForFunction(() => {
    const wpData = (window as unknown as { wp?: { data?: { select?: (store: string) => Record<string, unknown>; dispatch?: (store: string) => Record<string, unknown> } } }).wp?.data
    const select = wpData?.select
    const dispatch = wpData?.dispatch
    if (typeof select !== "function" || typeof dispatch !== "function") {
      return false
    }
    const editor = select("core/editor")
    const blockEditor = select("core/block-editor")
    const editorDispatch = dispatch("core/editor")
    if (!editor || !blockEditor || !editorDispatch) {
      return false
    }
    return {
      schema: "wp-codebox/editor-readiness/v1",
      status: "ready",
      storesAvailable: true,
      canSave: typeof editorDispatch.savePost === "function",
      postId: typeof editor.getCurrentPostId === "function" ? editor.getCurrentPostId() : undefined,
      postType: typeof editor.getCurrentPostType === "function" ? editor.getCurrentPostType() : undefined,
    }
  }, undefined, { timeout: timeoutMs }).then(async (handle) => {
    const readiness = await handle.jsonValue() as BrowserEditorReadinessSummary | false
    if (!readiness) {
      throw new Error("wp-codebox-editor-readiness-timeout: WordPress editor data stores did not become available")
    }
    return readiness
  })
}

async function saveEditorPost(page: import("playwright").Page, step: Extract<EditorActionStep, { kind: "savePost" }>, timeoutMs: number): Promise<BrowserEditorSaveSummary> {
  const save = await page.evaluate(async (input) => {
    const win = window as unknown as {
      wp?: {
        blocks?: { createBlock?: (name: string, attributes?: Record<string, unknown>) => unknown }
        data?: { select?: (store: string) => Record<string, unknown>; dispatch?: (store: string) => Record<string, unknown>; subscribe?: (listener: () => void) => () => void }
      }
    }
    const wpData = win.wp?.data
    const select = wpData?.select
    const dispatch = wpData?.dispatch
    if (typeof select !== "function" || typeof dispatch !== "function") {
      throw new Error("wp-codebox-editor-readiness-unavailable: WordPress editor data APIs are unavailable")
    }
    const editor = select("core/editor")
    const blockEditor = dispatch("core/block-editor")
    const editorDispatch = dispatch("core/editor")
    if (typeof editorDispatch?.savePost !== "function") {
      throw new Error("wp-codebox-editor-save-unsupported: core/editor savePost is unavailable")
    }
    if (input.marker || input.content) {
      const createBlock = win.wp?.blocks?.createBlock
      if (typeof createBlock !== "function" || typeof blockEditor?.insertBlocks !== "function") {
        throw new Error("wp-codebox-editor-save-unsupported: block insertion APIs are unavailable")
      }
      blockEditor.insertBlocks([createBlock("core/paragraph", { content: input.content ?? input.marker })])
    }
    await Promise.resolve(editorDispatch.savePost())
    const deadline = Date.now() + input.timeoutMs
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        const isSaving = typeof editor.isSavingPost === "function" ? Boolean(editor.isSavingPost()) : false
        const didSucceed = typeof editor.didPostSaveRequestSucceed === "function" ? Boolean(editor.didPostSaveRequestSucceed()) : undefined
        const didFail = typeof editor.didPostSaveRequestFail === "function" ? Boolean(editor.didPostSaveRequestFail()) : false
        if (!isSaving && didSucceed !== false) {
          cleanup()
          resolve()
        } else if (didFail) {
          cleanup()
          reject(new Error("wp-codebox-editor-save-failed: core/editor savePost reported a failed request"))
        } else if (Date.now() > deadline) {
          cleanup()
          reject(new Error("wp-codebox-editor-save-timeout: timed out waiting for core/editor savePost to settle"))
        }
      }
      const unsubscribe = typeof wpData?.subscribe === "function" ? wpData.subscribe(done) : undefined
      const interval = window.setInterval(done, 250)
      const cleanup = () => {
        window.clearInterval(interval)
        if (unsubscribe) unsubscribe()
      }
      done()
    })
    const editedContent = typeof editor.getEditedPostContent === "function" ? String(editor.getEditedPostContent() ?? "") : ""
    return {
      schema: "wp-codebox/editor-save/v1",
      status: "saved",
      method: "core/editor.savePost",
      postId: typeof editor.getCurrentPostId === "function" ? editor.getCurrentPostId() : undefined,
      postType: typeof editor.getCurrentPostType === "function" ? editor.getCurrentPostType() : undefined,
      markerPresent: input.marker ? editedContent.includes(input.marker) : undefined,
      content: editedContent,
    }
  }, { marker: step.marker, content: step.content, timeoutMs })

  const { content, ...summary } = save as BrowserEditorSaveSummary & { content?: string }
  return {
    ...summary,
    ...(typeof content === "string" && content.length > 0 ? { contentSha256: sha256(Buffer.from(content, "utf8")) } : {}),
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

export function wordpressAdminAuthCookiePhpCode(browserUrls: string[], userId: number): string {
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

async function browserStorageStateImportFromArgs(args: string[], command: string): Promise<BrowserStorageStateImport | undefined> {
  const raw = argValue(args, "storage-state")?.trim()
  if (!raw) {
    return undefined
  }

  const source = raw.startsWith("@") ? "file" : "inline"
  const text = source === "file" ? await readFile(resolveCommandPath(raw.slice(1)), "utf8") : raw
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch (error) {
    throw new BrowserStorageStateImportError(`${command} storage-state must be valid JSON`, {
      status: "error",
      source,
      cookieCount: 0,
      cookieHosts: [],
      originCount: 0,
      diagnostics: [{ code: "storage-state-json-invalid", severity: "error", message: error instanceof Error ? error.message : String(error) }],
    })
  }

  const normalized = normalizeBrowserStorageStatePayload(payload, source)
  if (normalized.summary.status !== "ready") {
    throw new BrowserStorageStateImportError(`${command} storage-state is unsupported`, normalized.summary)
  }
  return normalized
}

function browserStorageStateAuthSummary(summary: BrowserStorageStateImportSummary): BrowserProbeAuthSummary {
  return {
    mode: "storage-state",
    storageState: summary,
    cookieCount: summary.cookieCount,
    cookieHosts: summary.cookieHosts,
  }
}

class BrowserStorageStateImportError extends Error {
  constructor(message: string, readonly storageState: BrowserStorageStateImportSummary) {
    super(message)
    this.name = "BrowserStorageStateImportError"
  }

  toJSON(): { name: string; message: string; storageState: BrowserStorageStateImportSummary } {
    return { name: this.name, message: this.message, storageState: this.storageState }
  }
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

  constructor(readonly idleMs: number, readonly stallTimeoutMs: number, readonly lastProgressSource: BrowserProbeProgressSource, readonly lastCheckpoint?: BrowserProbeScriptCheckpoint) {
    super(`Browser probe stalled after ${idleMs}ms without progress; last progress source was ${lastProgressSource}${lastCheckpoint ? ` (${lastCheckpoint.name})` : ""}`)
    this.name = "BrowserProbeStallError"
  }
}

function createBrowserProbeProgressTracker(startedAt: string, stallTimeoutMs: number): {
  mark(source: BrowserProbeProgressSource, timestamp?: string, checkpoint?: BrowserProbeScriptCheckpoint): void
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
    lastCheckpoint?: BrowserProbeScriptCheckpoint
    terminalFailure?: { message: string; reason?: string; details?: unknown; timestamp: string }
  }
} {
  let status: "active" | "failed" | "stalled" = "active"
  let lastProgressAt = startedAt
  let lastProgressSource: BrowserProbeProgressSource = "navigation"
  let lastCheckpoint: BrowserProbeScriptCheckpoint | undefined
  let terminalFailure: { message: string; reason?: string; details?: unknown; timestamp: string } | undefined

  return {
    mark(source, timestamp = now(), checkpoint) {
      lastProgressAt = timestamp
      lastProgressSource = source
      if (checkpoint) {
        lastCheckpoint = checkpoint
      }
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
        ...(lastCheckpoint ? { lastCheckpoint } : {}),
        ...(terminalFailure ? { terminalFailure } : {}),
      }
    },
  }
}

async function withBrowserProbeLiveness<T>(page: import("playwright").Page, progress: ReturnType<typeof createBrowserProbeProgressTracker>, failFast: boolean, operation: Promise<T>, policy: Required<BrowserCommandLivenessPolicy>, phase: string): Promise<T> {
  const result = await withBrowserCommandLiveness({
    command: "wordpress.browser-probe",
    phase,
    operation,
    policy,
    idle: () => {
      const summary = progress.summary()
      return { idleMs: summary.idleMs, lastProgressSource: summary.lastProgressSource }
    },
    poll: async () => {
      try {
        const state = await page.evaluate(() => {
          const probe = (globalThis as typeof globalThis & {
            __wpCodeboxBrowserProbe?: {
              checkpoints?: Array<{ name?: unknown; metadata?: unknown; timestamp?: unknown }>
              terminalFailure?: { message?: unknown; reason?: unknown; details?: unknown; timestamp?: unknown }
            }
          }).__wpCodeboxBrowserProbe
          const checkpoints = Array.isArray(probe?.checkpoints) ? probe.checkpoints : []
          const latestCheckpoint = [...checkpoints].reverse().find((checkpoint) => typeof checkpoint.timestamp === "string")
          const latestCheckpointTimestamp = typeof latestCheckpoint?.timestamp === "string" ? latestCheckpoint.timestamp : undefined
          const checkpoint = latestCheckpoint && latestCheckpointTimestamp ? {
            name: typeof latestCheckpoint.name === "string" ? latestCheckpoint.name : "checkpoint",
            metadata: latestCheckpoint.metadata,
            timestamp: latestCheckpointTimestamp,
          } : undefined
          const failure = probe?.terminalFailure
          return {
            checkpoint,
            terminalFailure: failure && typeof failure.message === "string" ? {
              message: failure.message,
              reason: typeof failure.reason === "string" ? failure.reason : undefined,
              details: failure.details,
              timestamp: typeof failure.timestamp === "string" ? failure.timestamp : new Date().toISOString(),
            } : undefined,
          }
        })
        if (state.checkpoint) {
          progress.mark("checkpoint", state.checkpoint.timestamp, state.checkpoint)
        }
        if (state.terminalFailure) {
          progress.terminalFailure(state.terminalFailure)
          throw new BrowserProbeTerminalFailureError(state.terminalFailure)
        }
      } catch (error) {
        if (error instanceof BrowserProbeTerminalFailureError) {
          throw error
        }
        // The page may be navigating or already closed; the outer operation remains authoritative.
      }
    },
    onTimeout: async () => {
      await page.close().catch(() => undefined)
    },
  }).catch((error) => {
    if (isBrowserCommandLivenessError(error) && error.code === "browser-command-idle-timeout") {
      const summary = progress.summary()
      throw new BrowserProbeStallError(summary.idleMs, policy.idleTimeoutMs, summary.lastProgressSource, summary.lastCheckpoint)
    }
    throw error
  })
  const terminalFailure = failFast ? await browserProbeTerminalFailure(page) : undefined
  if (terminalFailure) {
    progress.terminalFailure(terminalFailure)
    throw new BrowserProbeTerminalFailureError(terminalFailure)
  }
  return result
}

function livenessRemainingWallTimeMs(startedAtMs: number, totalTimeoutMs: number): number {
  if (totalTimeoutMs <= 0) {
    return browserCommandLivenessPolicy().wallTimeoutMs
  }
  return Math.max(1, totalTimeoutMs - (Date.now() - startedAtMs))
}

function normalizeBrowserProbeScriptCheckpoint(checkpoint: unknown): BrowserProbeScriptCheckpoint | undefined {
  if (!checkpoint || typeof checkpoint !== "object") {
    return undefined
  }
  const record = checkpoint as { name?: unknown; metadata?: unknown; timestamp?: unknown }
  return {
    name: typeof record.name === "string" && record.name.length > 0 ? record.name : "checkpoint",
    ...(typeof record.metadata !== "undefined" ? { metadata: record.metadata } : {}),
    timestamp: typeof record.timestamp === "string" ? record.timestamp : now(),
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
