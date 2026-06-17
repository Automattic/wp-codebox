import { BROWSER_PROBE_BROWSER_VALUES, BROWSER_PROBE_CAPTURE_VALUES, BROWSER_PROBE_CHROMIUM_PROFILE_IDS, BROWSER_PROBE_PROFILES, BROWSER_PROBE_THROTTLE_PROFILE_IDS, redactString, type BrowserProbeProfileDefinition, type ExecutionSpec, type RuntimeCreateSpec } from "@automattic/wp-codebox-core"
import { BrowserArtifactSession } from "./browser-artifact-session.js"
import { BrowserCommandArtifactError } from "./browser-command-artifact-error.js"
import type { BrowserProbeArtifact, BrowserProbeArtifactRef, BrowserProbeAuthSummary, BrowserProbeCapabilityDiagnostics, BrowserProbeCheckpointRecord, BrowserProbeContextDetails, BrowserProbeErrorRecord, BrowserProbeLifecycleArtifact, BrowserProbeMeasuredMetric, BrowserProbeMemoryArtifact, BrowserProbeNetworkCountSummary, BrowserProbeNetworkRecord, BrowserProbeNetworkReviewSummary, BrowserProbePerformanceArtifact, BrowserProbeReviewSummary, BrowserProbeScriptMetadata, BrowserProbeViewport, BrowserProbeWaterfallArtifact, BrowserProbeWaterfallEntry, BrowserRedirectDiagnosticsSummary, BrowserStepAssertion, BrowserWordPressDiagnosticsSummary } from "./browser-artifacts.js"
import { attachBrowserCaptureListeners, chromiumBrowserMetadata, launchChromiumBrowser, settleBrowserNetworkTasks } from "./browser-capture-session.js"
import { browserCommandLivenessPolicy, isBrowserCommandLivenessError } from "./browser-liveness.js"
import { browserProbeLifecycleArtifact, browserProbeLifecycleInitScript, collectBrowserProbeLifecycle } from "./browser-lifecycle.js"
import { browserProbeBenchMetrics, serializeBrowserError } from "./browser-metrics.js"
import { browserPreviewNetworkPolicyIsActive, browserPreviewNetworkPolicySummary, browserPreviewNeedsContextRouting, browserPreviewReadinessError, browserPreviewSecureContextError, browserPreviewTopology, createBrowserPreviewRouteTracker, drainBrowserPreviewRouteTracker, routeBrowserPreviewContextNetwork, routeBrowserPreviewPageNetwork } from "./browser-preview-routing.js"
import { BROWSER_PROBE_PERFORMANCE_INIT_SCRIPT, BROWSER_PROBE_STATE_INIT_SCRIPT, browserProbeAssertionsFromArgs, browserProbeAssertionsNeedMetrics, browserProbeAssertionsNeedNetwork, browserProbeCheckpoint, browserProbeMemoryArtifact, browserProbePendingCheckpoints, browserProbePerformanceArtifact, browserProbeReplayability, browserProbeViewport, executeBrowserProbeAssertions, navigateBrowserProbe } from "./browser-probe.js"
import { argValue, commaListArg, durationArg, strictBooleanArg, viewportArg } from "./commands.js"
import type { PlaygroundRunResponse } from "./playground-command-errors.js"
import type { PlaygroundCliServer } from "./preview-server.js"
import { addBrowserProbeNetworkCount, browserAuthRequest, browserProbeArtifactRefs, browserRedirectDiagnosticsArtifact, browserStorageStateAuthSummary, browserStorageStateImportFromArgs, browserWordPressDiagnosticsArtifact, createBrowserProbeProgressTracker, fileSha256, installBrowserWordPressDiagnostics, installWordPressAdminAuthCookies, now, requestHost, safeBrowserProbeUrl, sha256, sortBrowserProbeNetworkCounts, withBrowserProbeLiveness, normalizeBrowserProbeScriptCheckpoint, type BrowserCommandProgressEvent, type BrowserProbeScriptCheckpoint, type BrowserStorageStateImport } from "./browser-probe-support.js"

const BROWSER_PROBE_PROFILE_OVERRIDES = new Set(["browser", "device", "locale", "permissions", "throttle", "timezone", "user-agent", "viewport"])

export interface BrowserProbeRunPlan {
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

export async function runSingleBrowserProbeCommand({
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
