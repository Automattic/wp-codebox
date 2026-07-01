import { BROWSER_PROBE_BROWSER_VALUES, BROWSER_PROBE_CAPTURE_VALUES, BROWSER_PROBE_CHROMIUM_PROFILE_IDS, BROWSER_PROBE_PROFILES, BROWSER_PROBE_THROTTLE_PROFILE_IDS, type BrowserProbeProfileDefinition, type ExecutionSpec, type RuntimeCreateSpec } from "@automattic/wp-codebox-core"
import { BrowserArtifactSession } from "./browser-artifact-session.js"
import { BrowserCommandArtifactError } from "./browser-command-artifact-error.js"
import type { BrowserArtifactFiles, BrowserProbeArtifact, BrowserProbeAuthSummary, BrowserProbeCapabilityDiagnostics, BrowserProbeCheckpointRecord, BrowserProbeContextDetails, BrowserProbeErrorRecord, BrowserProbeLifecycleArtifact, BrowserProbeMemoryArtifact, BrowserProbeNetworkRecord, BrowserProbePerformanceArtifact, BrowserProbeScriptMetadata, BrowserProbeViewport, BrowserProbeWebSocketRecord, BrowserWordPressDiagnosticsSummary } from "./browser-artifacts.js"
import { attachBrowserCaptureListeners, chromiumBrowserMetadata, launchChromiumBrowser, settleBrowserNetworkTasks } from "./browser-capture-session.js"
import { browserCommandLivenessPolicy, isBrowserCommandLivenessError, withBrowserCommandLiveness } from "./browser-liveness.js"
import { browserProbeLifecycleArtifact, browserProbeLifecycleInitScript, collectBrowserProbeLifecycle } from "./browser-lifecycle.js"
import { browserProbeBenchMetrics, serializeBrowserError } from "./browser-metrics.js"
import { browserPreviewNetworkPolicyIsActive, browserPreviewNetworkPolicySummary, browserPreviewNeedsContextRouting, browserPreviewReadinessError, browserPreviewSecureContextError, browserPreviewTopology, createBrowserPreviewRouteTracker, drainBrowserPreviewRouteTracker, routeBrowserPreviewContextNetwork, routeBrowserPreviewPageNetwork } from "./browser-preview-routing.js"
import { BROWSER_PROBE_PERFORMANCE_INIT_SCRIPT, BROWSER_PROBE_STATE_INIT_SCRIPT, browserProbeAssertionsFromArgs, browserProbeCheckpoint, browserProbeMemoryArtifact, browserProbePendingCheckpoints, browserProbePerformanceArtifact, browserProbeViewport, executeBrowserProbeAssertions, navigateBrowserProbe } from "./browser-probe.js"
import { argValue, commaListArg, durationArg, strictBooleanArg, viewportArg } from "./commands.js"
import type { PlaygroundRunResponse } from "./playground-command-errors.js"
import type { PlaygroundCliServer } from "./preview-server.js"
import { browserAuthRequest, browserProbeWaterfallArtifact, browserProbeWebSocketArtifact, browserRedirectDiagnosticsArtifact, browserRequestCoverageArtifact, browserStorageStateAuthSummary, browserStorageStateImportFromArgs, createBrowserProbeProgressTracker, fileSha256, installWordPressAdminAuthCookies, now, sha256, withBrowserProbeLiveness, normalizeBrowserProbeScriptCheckpoint, type BrowserCommandProgressEvent, type BrowserProbeScriptCheckpoint, type BrowserStorageStateImport } from "./browser-probe-support.js"
import { BrowserProbeSessionResultBuilder, browserProbeCaptureSelection } from "./browser-probe-session-result-builder.js"

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
  routeHostDrain: "required" | "advisory"
  failFast: boolean
  stallTimeoutMs: number
  wallTimeoutMs: number
  lifecycleSelectors: string[]
  assertions: ReturnType<typeof browserProbeAssertionsFromArgs>
  diagnosticProviders?: BrowserProbeDiagnosticProvider[]
}

export interface BrowserProbeDiagnosticProvider {
  id: string
  setup(input: BrowserProbeDiagnosticSetupInput): Promise<unknown>
  collect(input: BrowserProbeDiagnosticCollectInput): Promise<BrowserProbeCollectedDiagnostic | undefined>
}

export interface BrowserProbeDiagnosticSetupInput {
  command: string
  runPlaygroundCommand?: (command: string, server: PlaygroundCliServer, options: { code: string } | { scriptPath: string }) => Promise<PlaygroundRunResponse>
  server: PlaygroundCliServer
}

export interface BrowserProbeDiagnosticCollectInput extends BrowserProbeDiagnosticSetupInput {
  artifactPath: string
  network: BrowserProbeNetworkRecord[]
  setupResult: unknown
}

export interface BrowserProbeCollectedDiagnostic {
  key: keyof BrowserArtifactFiles
  fileName: string
  artifact: unknown
  summary: unknown
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
  diagnosticProviders,
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
  diagnosticProviders?: BrowserProbeDiagnosticProvider[]
}): Promise<{ artifact: BrowserProbeArtifact; artifacts?: BrowserProbeArtifact[]; output: string }> {
  if (plan) {
    return runSingleBrowserProbeCommand({ abortSignal, artifactRoot, command, plan, runtimeSpec, runPlaygroundCommand, server, spec, browserFilesDirectory: "files/browser", onProgress, diagnosticProviders })
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
        diagnosticProviders,
      })
    }
    return runSingleBrowserProbeCommand({ abortSignal, artifactRoot, command, runtimeSpec, runPlaygroundCommand, server, spec, browserFilesDirectory: "files/browser", onProgress, diagnosticProviders })
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
      diagnosticProviders,
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
  diagnosticProviders,
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
  diagnosticProviders?: BrowserProbeDiagnosticProvider[]
}): Promise<{ artifact: BrowserProbeArtifact; output: string }> {
  const args = spec.args ?? []
  const runPlan = plan ?? await browserProbeRunPlanFromArgs(args, profileId, artifactRoot)
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
  // Diagnostic providers run external playground commands (e.g. browser-diagnostics-setup) that
  // can wedge under runtime contention. Bound them with the same wall budget as navigation so a
  // stuck provider fails fast with a clear error instead of riding the recipe-level timeout.
  const diagnosticsTimeoutMs = wallTimeoutMs > 0 ? wallTimeoutMs : livenessPolicy.idleTimeoutMs
  const lifecycleSelectors = runPlan.lifecycleSelectors
  const assertions = runPlan.assertions
  const activeDiagnosticProviders = runPlan.diagnosticProviders ?? diagnosticProviders ?? []
  const captureSelection = browserProbeCaptureSelection(capture, assertions)
  const prePageScriptMetadata = prePageScript ? browserProbeScriptMetadata(prePageScript) : undefined
  const topology = browserPreviewTopology(args, runtimeSpec, server.serverUrl)
  const { preview, networkPolicy } = topology
  const routeTracker = createBrowserPreviewRouteTracker()
  const targetUrl = topology.resolveUrl(runPlan.url)
  const artifactSession = new BrowserArtifactSession(artifactRoot, browserFilesDirectory, { source: command, operation: "browser-probe" })

  const consoleMessages: Record<string, unknown>[] = []
  const errors: BrowserProbeErrorRecord[] = []
  const network: BrowserProbeNetworkRecord[] = []
  const webSockets: BrowserProbeWebSocketRecord[] = []
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
  let output: string | undefined
  const diagnosticSetupResults = new Map<string, unknown>()
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
    if (captureSelection.metrics) {
      await page.addInitScript(BROWSER_PROBE_PERFORMANCE_INIT_SCRIPT)
    }
    if (prePageScript) {
      await page.addInitScript(prePageScript)
    }
    for (const provider of activeDiagnosticProviders) {
      const setupResult = await runBoundedBrowserDiagnostic({
        command,
        phase: `diagnostics-setup:${provider.id}`,
        operation: provider.setup({ command, runPlaygroundCommand, server }),
        timeoutMs: diagnosticsTimeoutMs,
        onError: (error) => errors.push(serializeBrowserError("probe-error", error)),
      })
      if (setupResult.ok) {
        diagnosticSetupResults.set(provider.id, setupResult.value)
      }
    }
    viewport = await browserProbeViewport(page)
    contextDetails = await browserProbeContextDetails(page, requestedContext, viewport)
    capabilityDiagnostics = await browserProbeCapabilityDiagnostics(page, viewport)
    attachBrowserCaptureListeners({
      captureConsole: captureSelection.console,
      captureErrors: captureSelection.errors,
      captureNetwork: true,
      captureWebSocket: capture.has("websocket"),
      consoleMessages,
      errors,
      network,
      networkTasks,
      onConsole: () => progress.mark("console"),
      onNetwork: () => progress.mark("network"),
      onPageError: () => progress.mark("pageerror"),
      onWebSocket: () => progress.mark("websocket"),
      page,
      webSockets,
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
    if (captureSelection.metrics) {
      checkpoints.push(await browserProbeCheckpoint(page, "after-navigation"))
    }
    if (script) {
      scriptResult = await withBrowserProbeLiveness(page, progress, failFast, page.evaluate(async (source) => {
        const run = new Function(`return (async () => {\n${source}\n})()`)
        return run()
      }, script), livenessPolicy, "script")
      progress.mark("script")
      if (captureSelection.metrics) {
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
      if (captureSelection.metrics) {
        checkpoints.push(await browserProbeCheckpoint(page, "after-duration"))
      }
    }
    if (assertions.length > 0) {
      await settleBrowserNetworkTasks(networkTasks, livenessPolicy.networkSettleTimeoutMs)
      const assertionMetrics = captureSelection.metrics ? browserProbeBenchMetrics(browserProbeMemoryArtifact(checkpoints), browserProbePerformanceArtifact(checkpoints)) : {}
      assertionResults = await executeBrowserProbeAssertions(page, assertions, consoleMessages, errors, network, assertionMetrics)
      if (captureSelection.metrics) {
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
      if (!pendingError && runPlan.routeHostDrain === "required") {
        pendingError = routeError
        progress.fail("probe-error", routeError)
      }
      errors.push(serializeBrowserError("probe-error", error))
    }
    if (page) {
      finalUrl = page.url()
      windowLocationOrigin = windowLocationOrigin ?? await page.evaluate(() => window.location.origin).catch(() => undefined)
      if (captureSelection.metrics) {
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
    if (captureSelection.console) {
      await artifactSession.writeJsonLines("console", "console.jsonl", consoleMessages)
    }
    if (captureSelection.errors) {
      await artifactSession.writeJsonLines("errors", "errors.jsonl", errors)
    }
    if (captureSelection.network) {
      await artifactSession.writeJsonLines("network", "network.jsonl", network)
      await artifactSession.writeJson("requestCoverage", "request-coverage.json", browserRequestCoverageArtifact(network, startedAt))
      await artifactSession.writeJson("waterfall", "waterfall.json", browserProbeWaterfallArtifact(network, startedAt))
    }
    if (capture.has("websocket")) {
      await artifactSession.writeJson("websocket", "websocket.json", browserProbeWebSocketArtifact(webSockets, startedAt))
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
    const diagnostics: BrowserProbeCollectedDiagnostic[] = []
    for (const provider of activeDiagnosticProviders) {
      const collected = await runBoundedBrowserDiagnostic({
        command,
        phase: `diagnostics-collect:${provider.id}`,
        operation: provider.collect({
          artifactPath: `${browserFilesDirectory}/${provider.id}-diagnostics.json`,
          command,
          network,
          runPlaygroundCommand,
          server,
          setupResult: diagnosticSetupResults.get(provider.id),
        }),
        timeoutMs: diagnosticsTimeoutMs,
        onError: (error) => errors.push(serializeBrowserError("probe-error", error)),
      })
      const diagnostic = collected.ok ? collected.value : undefined
      if (diagnostic) {
        diagnostics.push(diagnostic)
        await artifactSession.writeJson(diagnostic.key, diagnostic.fileName, diagnostic.artifact)
      }
    }
    const wordpressDiagnostics = diagnostics.find((diagnostic): diagnostic is BrowserProbeCollectedDiagnostic & { key: "wordpressDiagnostics"; summary: BrowserWordPressDiagnosticsSummary } => diagnostic.key === "wordpressDiagnostics")
    const result = new BrowserProbeSessionResultBuilder().compose({
      assertions: assertionResults,
      authSummary,
      browser: browserMetadata,
      browserFilesDirectory,
      capabilities: capabilityDiagnostics,
      capture,
      captureSelection,
      checkpoints,
      command,
      consoleMessages,
      context: contextDetails,
      durationMs,
      errors,
      failFast,
      finalUrl,
      hashes: {
        ...(capture.has("html") ? { htmlSha256 } : {}),
        ...(capture.has("screenshot") ? { screenshotSha256 } : {}),
      },
      lifecycleArtifact,
      lifecycleSelectors,
      liveness: { wallTimeoutMs, stallTimeoutMs, networkSettleTimeoutMs: livenessPolicy.networkSettleTimeoutMs },
      memoryArtifact,
      network,
      ...(browserPreviewNetworkPolicyIsActive(networkPolicy) ? { networkPolicySummary: browserPreviewNetworkPolicySummary(networkPolicy) } : {}),
      performanceArtifact,
      prePageScriptMetadata,
      preview,
      ...(server.previewProxyDiagnostics ? { previewProxyDiagnostics: server.previewProxyDiagnostics } : {}),
      progress,
      redirectDiagnostics: redirectDiagnostics ? { summary: redirectDiagnostics.summary } : undefined,
      requestedUrl: targetUrl,
      scriptResult,
      startedAt,
      startedAtMs,
      throttleId: throttleProfile?.id ?? null,
      topologyOrigins: topology.origins,
      viewport,
      waitFor,
      webSockets,
      windowLocationOrigin,
      wordpressDiagnostics: wordpressDiagnostics ? { summary: wordpressDiagnostics.summary } : undefined,
    })
    await artifactSession.writeJson("review", "review.json", result.review)
    artifact = result.artifact
    output = result.output
    await artifactSession.writeJson("summary", "summary.json", result.summary)
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
    output: output ?? "",
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

export type BoundedBrowserDiagnosticResult<T> = { ok: true; value: T } | { ok: false; error: Error }

/**
 * Runs a best-effort browser diagnostic provider operation under a bounded wall timeout.
 *
 * Diagnostic providers shell out to playground commands (e.g. wordpress.browser-diagnostics-setup)
 * that can wedge under runtime contention. Without a bound, a stuck provider rides the recipe-level
 * timeout — observed as wordpress.capture-html hanging for the full recipe budget while the sibling
 * navigation path failed fast. This wraps the operation so it fails fast with a clear, non-empty
 * liveness error that is surfaced through onError as a non-fatal probe error rather than aborting
 * the capture. The discriminated result distinguishes a legitimately resolved value (including
 * undefined or false) from a timeout/failure.
 */
export async function runBoundedBrowserDiagnostic<T>({
  command,
  phase,
  operation,
  timeoutMs,
  onError,
}: {
  command: string
  phase: string
  operation: Promise<T>
  timeoutMs: number
  onError: (error: Error) => void
}): Promise<BoundedBrowserDiagnosticResult<T>> {
  try {
    const value = await withBrowserCommandLiveness({
      command,
      phase,
      operation,
      policy: { wallTimeoutMs: timeoutMs, idleTimeoutMs: 0 },
    })
    return { ok: true, value }
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error))
    onError(normalized)
    return { ok: false, error: normalized }
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
  const profile = BROWSER_PROBE_PROFILES[profileId as keyof typeof BROWSER_PROBE_PROFILES]
  if (!profile) {
    throw new Error(`wordpress.browser-probe unknown profile: ${profileId}. Supported profiles: ${BROWSER_PROBE_CHROMIUM_PROFILE_IDS.join(", ")}`)
  }
  return profile
}

async function browserProbeRunPlanFromArgs(args: string[], profileId: string | undefined, artifactRoot: string): Promise<BrowserProbeRunPlan> {
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
    storageStateImport: await browserStorageStateImportFromArgs(args, "wordpress.browser-probe", artifactRoot),
    routeHostDrain: routeHostDrainMode(args),
    failFast: strictBooleanArg(args, "fail-fast", false),
    stallTimeoutMs: durationArg(args, "stall-timeout", 0),
    wallTimeoutMs: durationArg(args, "timeout", browserCommandLivenessPolicy().wallTimeoutMs),
    lifecycleSelectors: commaListArg(args, "observe"),
    assertions: browserProbeAssertionsFromArgs(args),
  }
}

function routeHostDrainMode(args: string[]): "required" | "advisory" {
  const raw = argValue(args, "route-host-drain")?.trim() || "required"
  if (raw === "required" || raw === "advisory") {
    return raw
  }
  throw new Error(`wordpress.browser-probe route-host-drain supports required or advisory: ${raw}`)
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
