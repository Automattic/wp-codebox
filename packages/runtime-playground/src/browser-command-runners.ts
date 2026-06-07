import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { assertRuntimeCommandAllowed, browserInteractionScriptUsesEvaluate, type ExecutionSpec, type RuntimeCreateSpec } from "@automattic/wp-codebox-core"
import pixelmatch from "pixelmatch"
import { PNG } from "pngjs"
import { browserInteractionStepsFromArgs, durationStringMs } from "./browser-actions.js"
import type { BrowserEditorCanvasProbeDiagnostic, BrowserEditorCanvasProbeSummary, BrowserEditorCanvasSelectorGroupSummary, BrowserEditorCanvasSelectorSummary, BrowserProbeArtifact, BrowserProbeArtifactRef, BrowserProbeAuthSummary, BrowserProbeCapabilityDiagnostics, BrowserProbeCheckpointRecord, BrowserProbeContextDetails, BrowserProbeErrorRecord, BrowserProbeLifecycleArtifact, BrowserProbeMeasuredMetric, BrowserProbeMemoryArtifact, BrowserProbeNetworkCountSummary, BrowserProbeNetworkPolicySummary, BrowserProbeNetworkRecord, BrowserProbeNetworkReviewSummary, BrowserProbePerformanceArtifact, BrowserProbePreviewMode, BrowserProbePreviewRouting, BrowserProbeReviewSummary, BrowserProbeScriptMetadata, BrowserProbeViewport, BrowserStepRecord } from "./browser-artifacts.js"
import { browserAssertionsSummary, browserStepRecord, executeBrowserInteractionStep } from "./browser-interactions.js"
import { browserProbeLifecycleArtifact, browserProbeLifecycleInitScript, collectBrowserProbeLifecycle } from "./browser-lifecycle.js"
import { browserProbeBenchMetrics, jsonLines, serializeBrowserConsoleMessage, serializeBrowserError, serializeBrowserFinishedRequest, serializeBrowserRequestFailure } from "./browser-metrics.js"
import { BROWSER_PROBE_CAPTURE_VALUES, BROWSER_PROBE_PERFORMANCE_INIT_SCRIPT, BROWSER_PROBE_STATE_INIT_SCRIPT, browserProbeAssertionsFromArgs, browserProbeAssertionsNeedMetrics, browserProbeAssertionsNeedNetwork, browserProbeCheckpoint, browserProbeMemoryArtifact, browserProbePendingCheckpoints, browserProbePerformanceArtifact, browserProbeReplayability, browserProbeViewport, executeBrowserProbeAssertions, navigateBrowserProbe } from "./browser-probe.js"
import { argValue, cleanWpCliOutput, commaListArg, jsonArrayArg } from "./commands.js"
import { editorActionStepsFromArgs, editorOpenTargetFromArgs, type EditorActionStep } from "./editor-actions.js"
import { bootstrapPhpCode } from "./php-bootstrap.js"
import { assertPlaygroundResponseOk, type PlaygroundRunResponse } from "./playground-command-errors.js"
import type { PlaygroundCliServer } from "./preview-server.js"
import type { Page, Route } from "playwright"

const BROWSER_STEP_DEFAULT_TIMEOUT_MS = 15_000
const BROWSER_SCRIPT_DEFAULT_TIMEOUT_MS = 120_000
const EDITOR_CANVAS_DEFAULT_IFRAME_SELECTOR = 'iframe[name="editor-canvas"]'
const EDITOR_CANVAS_DEFAULT_LAYOUT_SELECTOR = ".block-editor-block-list__layout"
const EDITOR_CANVAS_DEFAULT_BLOCK_SELECTOR = ".block-editor-block-list__block, [data-block]"
const EDITOR_CANVAS_DEFAULT_TIMEOUT_MS = 30_000
const BROWSER_PROBE_PROFILE_OVERRIDES = new Set(["browser", "device", "locale", "permissions", "throttle", "timezone", "user-agent", "viewport"])

interface BrowserProbeProfileDefinition {
  id: string
  browser: "chromium" | "webkit"
  args: string[]
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
  constructor(message: string, readonly artifact: BrowserProbeArtifact) {
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
  runtimeSpec,
  runPlaygroundCommand,
  server,
  spec,
}: {
  artifactRoot: string
  command?: string
  runtimeSpec?: RuntimeCreateSpec
  runPlaygroundCommand?: (command: string, server: PlaygroundCliServer, options: { code: string } | { scriptPath: string }) => Promise<PlaygroundRunResponse>
  server: PlaygroundCliServer
  spec: ExecutionSpec
}): Promise<{ artifact: BrowserProbeArtifact; artifacts?: BrowserProbeArtifact[]; output: string }> {
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
  runtimeSpec,
  runPlaygroundCommand,
  server,
  spec,
  browserFilesDirectory,
  profileId,
}: {
  artifactRoot: string
  command: string
  runtimeSpec?: RuntimeCreateSpec
  runPlaygroundCommand?: (command: string, server: PlaygroundCliServer, options: { code: string } | { scriptPath: string }) => Promise<PlaygroundRunResponse>
  server: PlaygroundCliServer
  spec: ExecutionSpec
  browserFilesDirectory: string
  profileId?: string
}): Promise<{ artifact: BrowserProbeArtifact; output: string }> {
  const args = spec.args ?? []
  const urlArg = argValue(args, "url")?.trim()
  if (!urlArg) {
    throw new Error("wordpress.browser-probe requires url=<path-or-url>")
  }

  const capture = new Set(commaListArg(args, "capture"))
  if (capture.size === 0) {
    capture.add("console")
    capture.add("errors")
    capture.add("html")
    capture.add("network")
    capture.add("screenshot")
  }

  for (const item of capture) {
    if (!(BROWSER_PROBE_CAPTURE_VALUES as readonly string[]).includes(item)) {
      throw new Error(`wordpress.browser-probe capture supports ${BROWSER_PROBE_CAPTURE_VALUES.join(", ")}: ${item}`)
    }
  }

  const waitFor = argValue(args, "wait-for")?.trim() || "domcontentloaded"
  const durationMs = durationArg(args, "duration", 0)
  const requestedViewport = viewportArg(args, "viewport")
  const throttleProfile = browserProbeThrottleProfile(args)
  const requestedContext = browserProbeContextRequest(args, requestedViewport, profileId, throttleProfile?.id)
  const prePageScript = argValue(args, "pre-page-script")
  const script = argValue(args, "script")
  const authRequest = browserAuthRequest(args)
  const failFast = booleanArg(args, "fail-fast", false)
  const stallTimeoutMs = durationArg(args, "stall-timeout", 0)
  const lifecycleSelectors = commaListArg(args, "observe")
  const routedHosts = commaListArg(args, "route-host")
  const assertions = browserProbeAssertionsFromArgs(args)
  const capturesConsoleForAssertions = assertions.some((assertion) => assertion.type === "no-console-errors" || assertion.type === "no-errors")
  const capturesErrorsForAssertions = assertions.some((assertion) => assertion.type === "no-page-errors" || assertion.type === "no-errors")
  const capturesNetworkForAssertions = browserProbeAssertionsNeedNetwork(assertions)
  const capturesBrowserMetrics = capture.has("performance") || capture.has("memory") || browserProbeAssertionsNeedMetrics(assertions)
  const prePageScriptMetadata = prePageScript ? browserProbeScriptMetadata(prePageScript) : undefined
  const preview = browserProbePreviewRouting(args, runtimeSpec, server.serverUrl)
  const networkPolicy = browserProbeNetworkPolicy(args, routedHosts, preview)
  const previewOrigins = browserProbePreviewOrigins(preview)
  const targetUrl = resolveBrowserProbeUrl(urlArg, preview.effectiveOrigin)
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
  const startedAt = now()
  const startedAtMs = Date.now()
  const progress = createBrowserProbeProgressTracker(startedAt, stallTimeoutMs)
  const { chromium, devices } = await import("playwright")
  if (requestedContext.browser && requestedContext.browser !== "chromium") {
    throw new Error(`wordpress.browser-probe browser=${requestedContext.browser} is unsupported by this runner; use browser=chromium or a Chromium profile.`)
  }
  const deviceProfile = requestedContext.device ? devices[requestedContext.device] : undefined
  if (requestedContext.device && !deviceProfile) {
    throw new Error(`wordpress.browser-probe unknown Playwright device profile: ${requestedContext.device}`)
  }
  const browser = await chromium.launch(
    process.env.WP_CODEBOX_BROWSER_CHANNEL
      ? { channel: process.env.WP_CODEBOX_BROWSER_CHANNEL }
      : undefined,
  )
  const browserMetadata = {
    name: "chromium",
    channel: process.env.WP_CODEBOX_BROWSER_CHANNEL || "bundled",
    version: browser.version(),
  }
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

  try {
    context = browserProbeNeedsContextRouting(networkPolicy) || requestedContext.device || requestedContext.locale || requestedContext.timezone || requestedContext.userAgent || (requestedContext.permissions?.length ?? 0) > 0
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
    if (context && browserProbeNeedsContextRouting(networkPolicy)) {
      await routeBrowserProbeContextNetwork(context, networkPolicy, preview.localOrigin)
    }
    page = context ? await context.newPage() : await browser.newPage()
    if (authRequest) {
      authSummary = await installWordPressAdminAuthCookies({ command, page, runPlaygroundCommand, runtimeSpec, server, userId: authRequest.userId })
    }
    if (requestedViewport) {
      await page.setViewportSize(requestedViewport)
    }
    if (throttleProfile) {
      await applyBrowserProbeThrottleProfile(page, throttleProfile)
    }
    if (!context && browserProbeNeedsContextRouting(networkPolicy)) {
      await routeBrowserProbePageNetwork(page, networkPolicy, preview.localOrigin)
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
    viewport = await browserProbeViewport(page)
    contextDetails = await browserProbeContextDetails(page, requestedContext, viewport)
    capabilityDiagnostics = await browserProbeCapabilityDiagnostics(page, viewport)
    if (capture.has("console") || capturesConsoleForAssertions) {
      page.on("console", (message) => {
        progress.mark("console")
        consoleMessages.push(serializeBrowserConsoleMessage(message))
      })
    }
    if (capture.has("errors") || capturesErrorsForAssertions) {
      page.on("pageerror", (error) => {
        progress.mark("pageerror")
        errors.push(serializeBrowserError("pageerror", error))
      })
    }
    if (capture.has("network") || capturesNetworkForAssertions) {
      page.on("requestfinished", (request) => {
        const task = serializeBrowserFinishedRequest(request).then((record) => {
          progress.mark("network")
          network.push(record)
        }).catch(() => undefined)
        networkTasks.push(task)
      })
      page.on("requestfailed", (request) => {
        progress.mark("network")
        network.push(serializeBrowserRequestFailure(request))
      })
    }

    const previewReadinessError = browserProbePreviewReadinessError(preview)
    if (previewReadinessError) {
      throw previewReadinessError
    }

    await withBrowserProbeLiveness(page, progress, failFast, navigateBrowserProbe(page, targetUrl, waitFor, durationMs))
    progress.mark("navigation")
    const browserLocation = await page.evaluate(() => ({ origin: window.location.origin, secureContext: window.isSecureContext })).catch(() => undefined)
    windowLocationOrigin = browserLocation?.origin
    preview.secureContext = browserLocation?.secureContext
    const secureContextError = browserProbeSecureContextError(preview)
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
      if (networkTasks.length > 0) {
        await Promise.all(networkTasks)
      }
      const assertionMetrics = capturesBrowserMetrics ? browserProbeBenchMetrics(browserProbeMemoryArtifact(checkpoints), browserProbePerformanceArtifact(checkpoints)) : {}
      assertionResults = await executeBrowserProbeAssertions(page, assertions, consoleMessages, errors, network, assertionMetrics)
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
          performanceArtifact = browserProbePerformanceArtifact(checkpoints)
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
    if (networkTasks.length > 0) {
      await Promise.all(networkTasks)
    }
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
        screenshot: capture.has("screenshot") ? screenshotSha256 : undefined,
      }),
      finishedAt,
      network,
      performanceArtifact,
      startedAt,
      throttle: throttleProfile?.id ?? null,
      totalDurationMs: Date.now() - startedAtMs,
      viewport,
      waitFor,
    })
    await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`)

    artifact = {
      requestedUrl: targetUrl,
      url: targetUrl,
      preview,
      ...(browserProbeNetworkPolicyIsActive(networkPolicy) ? { networkPolicy: browserProbeNetworkPolicySummary(networkPolicy) } : {}),
      ...previewOrigins,
      ...(prePageScriptMetadata ? { prePageScript: prePageScriptMetadata } : {}),
      files: {
        ...(capture.has("console") || capturesConsoleForAssertions ? { console: `${browserFilesDirectory}/console.jsonl` } : {}),
        ...(checkpoints.length > 0 ? { checkpoints: `${browserFilesDirectory}/checkpoints.jsonl` } : {}),
        ...(capture.has("errors") || capturesErrorsForAssertions ? { errors: `${browserFilesDirectory}/errors.jsonl` } : {}),
        ...(capture.has("html") ? { html: `${browserFilesDirectory}/snapshot.html` } : {}),
        ...(lifecycleArtifact ? { lifecycle: `${browserFilesDirectory}/lifecycle.json` } : {}),
        ...(memoryArtifact ? { memory: `${browserFilesDirectory}/memory.json` } : {}),
        ...(capture.has("network") || capturesNetworkForAssertions ? { network: `${browserFilesDirectory}/network.jsonl` } : {}),
        ...(performanceArtifact ? { performance: `${browserFilesDirectory}/performance.json` } : {}),
        review: `${browserFilesDirectory}/review.json`,
        ...(capture.has("screenshot") ? { screenshot: `${browserFilesDirectory}/screenshot.png` } : {}),
        summary: `${browserFilesDirectory}/summary.json`,
      },
      summary: {
        ...(assertionSummary.total > 0 ? { assertions: assertionSummary } : {}),
        consoleMessages: consoleMessages.length,
        errors: errors.length,
        finalUrl,
        ...(windowLocationOrigin ? { windowLocationOrigin } : {}),
        htmlSnapshot: capture.has("html"),
        ...(browserProbeNetworkPolicyIsActive(networkPolicy) ? { networkPolicy: browserProbeNetworkPolicySummary(networkPolicy) } : {}),
        ...(lifecycleArtifact ? { lifecycle: { schema: lifecycleArtifact.schema, version: lifecycleArtifact.version, startedAtMs: lifecycleArtifact.startedAtMs, selectors: lifecycleArtifact.selectors } } : {}),
        ...(memoryArtifact ? { memory: memoryArtifact.peak } : {}),
        ...(memoryArtifact || performanceArtifact ? { metrics: browserProbeBenchMetrics(memoryArtifact, performanceArtifact) } : {}),
        networkEvents: network.length,
        ...(performanceArtifact ? { performance: performanceArtifact.peak } : {}),
        progress: progress.summary(),
        review,
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
      ...(browserProbeNetworkPolicyIsActive(networkPolicy) ? { networkPolicy: browserProbeNetworkPolicySummary(networkPolicy) } : {}),
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
      ...(browserProbeNetworkPolicyIsActive(networkPolicy) ? { networkPolicy: browserProbeNetworkPolicySummary(networkPolicy) } : {}),
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
  screenshot?: string
}): Record<string, BrowserProbeArtifactRef> {
  return {
    ...(input.console ? { console: { path: `${browserFilesDirectory}/console.jsonl`, kind: "jsonl" as const } } : {}),
    ...(input.checkpoints ? { checkpoints: { path: `${browserFilesDirectory}/checkpoints.jsonl`, kind: "jsonl" as const } } : {}),
    ...(input.errors ? { errors: { path: `${browserFilesDirectory}/errors.jsonl`, kind: "jsonl" as const } } : {}),
    ...(capture.has("html") ? { html: { path: `${browserFilesDirectory}/snapshot.html`, kind: "html" as const, ...(input.html ? { sha256: input.html } : {}) } } : {}),
    ...(input.lifecycle ? { lifecycle: { path: `${browserFilesDirectory}/lifecycle.json`, kind: "json" as const } } : {}),
    ...(input.memory ? { memory: { path: `${browserFilesDirectory}/memory.json`, kind: "json" as const } } : {}),
    ...(input.network ? { network: { path: `${browserFilesDirectory}/network.jsonl`, kind: "jsonl" as const } } : {}),
    ...(input.performance ? { performance: { path: `${browserFilesDirectory}/performance.json`, kind: "json" as const } } : {}),
    review: { path: `${browserFilesDirectory}/review.json`, kind: "json" as const },
    ...(capture.has("screenshot") ? { screenshot: { path: `${browserFilesDirectory}/screenshot.png`, kind: "png" as const, ...(input.screenshot ? { sha256: input.screenshot } : {}) } } : {}),
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

export async function runHtmlCaptureCommand(input: {
  artifactRoot: string
  runtimeSpec: RuntimeCreateSpec
  runPlaygroundCommand?: (command: string, server: PlaygroundCliServer, options: { code: string } | { scriptPath: string }) => Promise<PlaygroundRunResponse>
  server: PlaygroundCliServer
  spec: ExecutionSpec
}): Promise<{ artifact: BrowserProbeArtifact; output: string }> {
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
}): Promise<{ artifact: BrowserProbeArtifact; output: string }> {
  const args = spec.args ?? []
  const urlArg = argValue(args, "url")?.trim()
  if (!urlArg) {
    throw new Error("wordpress.editor-canvas-probe requires url=<path-or-url>")
  }

  const capture = new Set(commaListArg(args, "capture"))
  if (booleanArg(args, "screenshot", false)) {
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
  const preview = browserProbePreviewRouting(args, runtimeSpec, server.serverUrl)
  const previewOrigins = browserProbePreviewOrigins(preview)
  const targetUrl = resolveBrowserProbeUrl(urlArg, preview.effectiveOrigin)
  const browserDirectory = join(artifactRoot, "files", "browser")
  await mkdir(browserDirectory, { recursive: true })

  const summaryPath = join(browserDirectory, "editor-canvas-summary.json")
  const screenshotPath = join(browserDirectory, "editor-canvas-screenshot.png")
  const startedAt = now()
  const startedAtMs = Date.now()
  const { chromium } = await import("playwright")
  const browser = await chromium.launch(process.env.WP_CODEBOX_BROWSER_CHANNEL ? { channel: process.env.WP_CODEBOX_BROWSER_CHANNEL } : undefined)
  const errors: BrowserProbeErrorRecord[] = []
  let artifact: BrowserProbeArtifact | undefined
  let finalUrl = targetUrl
  let windowLocationOrigin: string | undefined
  let viewport: BrowserProbeViewport | null = null
  let screenshotSha256: string | undefined
  let pendingError: Error | undefined

  try {
    const previewReadinessError = browserProbePreviewReadinessError(preview)
    if (previewReadinessError) {
      throw previewReadinessError
    }

    const page = await browser.newPage()
    viewport = await browserProbeViewport(page)
    page.on("pageerror", (error) => errors.push(serializeBrowserError("pageerror", error)))
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs })
    finalUrl = page.url()
    const browserLocation = await page.evaluate(() => ({ origin: window.location.origin, secureContext: window.isSecureContext })).catch(() => undefined)
    windowLocationOrigin = browserLocation?.origin
    preview.secureContext = browserLocation?.secureContext
    const secureContextError = browserProbeSecureContextError(preview)
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
}): Promise<{ artifact: BrowserProbeArtifact; output: string }> {
  const args = spec.args ?? []
  const steps = await browserInteractionStepsFromArgs(args)
  const initialUrl = argValue(args, "url")?.trim()
  if (steps.length === 0 && !initialUrl) {
    throw new Error("wordpress.browser-actions requires steps-json=<array> (or actions-json=<array>) or url=<path-or-url>")
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

  const capture = new Set(commaListArg(args, "capture"))
  if (capture.size === 0) {
    capture.add("steps")
    capture.add("console")
    capture.add("errors")
    capture.add("network")
    capture.add("html")
    capture.add("screenshot")
  }
  // Back-compat: "actions" remains an alias for the per-step timeline capture.
  if (capture.has("actions")) {
    capture.delete("actions")
    capture.add("steps")
  }

  for (const item of capture) {
    if (!["steps", "console", "errors", "html", "network", "screenshot"].includes(item)) {
      throw new Error(`wordpress.browser-actions capture supports steps, console, errors, html, network, screenshot: ${item}`)
    }
  }

  const stepTimeoutMs = durationArg(args, "step-timeout", BROWSER_STEP_DEFAULT_TIMEOUT_MS)
  const totalTimeoutMs = durationArg(args, "timeout", BROWSER_SCRIPT_DEFAULT_TIMEOUT_MS)
  const requestedViewport = viewportArg(args, "viewport")
  const authRequest = browserAuthRequest(args)

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
  const summaryPath = join(browserDirectory, "action-summary.json")
  const startedAt = now()
  const startedAtMs = Date.now()
  const { chromium } = await import("playwright")
  const browser = await chromium.launch()
  const preview = browserProbePreviewRouting([], runtimeSpec, server.serverUrl)
  let requestedUrl = initialUrl ? resolveBrowserProbeUrl(initialUrl, preview.effectiveOrigin) : preview.effectiveOrigin
  let finalUrl = requestedUrl
  let htmlSha256: string | undefined
  let screenshotSha256: string | undefined
  let viewport: BrowserProbeViewport | null = null
  let authSummary: BrowserProbeAuthSummary | undefined
  let pendingError: Error | undefined
  let artifact: BrowserProbeArtifact | undefined

  try {
    const page = await browser.newPage()
    if (authRequest) {
      authSummary = await installWordPressAdminAuthCookies({ command: "wordpress.browser-actions", page, runPlaygroundCommand, runtimeSpec, server, userId: authRequest.userId })
    }
    if (requestedViewport) {
      await page.setViewportSize(requestedViewport)
    }
    viewport = await browserProbeViewport(page)
    if (capture.has("console")) {
      page.on("console", (message) => consoleMessages.push(serializeBrowserConsoleMessage(message)))
    }
    if (capture.has("errors")) {
      page.on("pageerror", (error) => errors.push(serializeBrowserError("pageerror", error)))
    }
    if (capture.has("network")) {
      page.on("requestfinished", (request) => {
        const task = serializeBrowserFinishedRequest(request).then((record) => {
          network.push(record)
        }).catch(() => undefined)
        networkTasks.push(task)
      })
      page.on("requestfailed", (request) => network.push(serializeBrowserRequestFailure(request)))
    }

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
        const outcome = await executeBrowserInteractionStep(page, step, server.serverUrl, stepTimeoutMs, screenshotPath, browserDirectory)
        finalUrl = page.url()
        if (step.kind === "navigate") {
          requestedUrl = resolveBrowserProbeUrl((step.url ?? "").trim(), server.serverUrl)
        }
        if (outcome.screenshot && capture.has("screenshot") && outcome.screenshotIsDefault) {
          screenshotSha256 = await fileSha256(screenshotPath)
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
      } catch (error) {
        const serialized = serializeBrowserError("probe-error", error)
        errors.push(serialized)
        if (!pendingError) {
          pendingError = error instanceof Error ? error : new Error(String(error))
        }
      }
    }
  } finally {
    if (networkTasks.length > 0) {
      await Promise.all(networkTasks)
    }
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

    const assertions = browserAssertionsSummary(stepRecords)
    artifact = {
      requestedUrl,
      url: requestedUrl,
      preview,
      files: {
        ...(capture.has("steps") ? { steps: "files/browser/steps.jsonl" } : {}),
        ...(capture.has("console") ? { console: "files/browser/console.jsonl" } : {}),
        ...(capture.has("errors") ? { errors: "files/browser/errors.jsonl" } : {}),
        ...(capture.has("html") ? { html: "files/browser/snapshot.html" } : {}),
        ...(capture.has("network") ? { network: "files/browser/network.jsonl" } : {}),
        ...(capture.has("screenshot") ? { screenshot: "files/browser/screenshot.png" } : {}),
        summary: "files/browser/action-summary.json",
      },
      summary: {
        actions: stepRecords.length,
        steps: stepRecords.length,
        ...(assertions.total > 0 ? { assertions } : {}),
        consoleMessages: consoleMessages.length,
        errors: errors.length,
        finalUrl,
        htmlSnapshot: capture.has("html"),
        networkEvents: network.length,
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

interface BrowserScenarioInput {
  url?: string
  profile?: string
  captures?: string[]
  capture?: string[]
  prePageScript?: string
  pre_page_script?: string
  observers?: Array<Record<string, unknown>>
  steps?: Array<Record<string, unknown>>
  assertions?: Array<Record<string, unknown>>
  viewport?: string
  device?: string
  locale?: string
  auth?: string
  authUserId?: string | number
  auth_user_id?: string | number
  waitFor?: string
  wait_for?: string
  duration?: string
  stepTimeout?: string
  step_timeout?: string
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
}): Promise<{ artifact: BrowserProbeArtifact; output: string }> {
  const args = spec.args ?? []
  const scenario = await browserScenarioFromArgs(args)
  const url = scenario.url?.trim() || argValue(args, "url")?.trim()
  if (!url) {
    throw new Error("wordpress.browser-scenario requires url=<path-or-url> or scenario-json.url")
  }

  const captures = browserScenarioCaptures(scenario, args)
  const steps = browserScenarioSteps(scenario, args)
  const assertions = browserScenarioAssertions(scenario)
  const actionSteps = [...steps, ...assertions]
  const requestedViewport = browserScenarioViewport(scenario, args)
  const device = scenario.device ?? (scenario.profile && scenario.profile !== "desktop-chrome" ? scenario.profile : undefined) ?? argValue(args, "device")
  const locale = scenario.locale ?? argValue(args, "locale")
  const prePageScript = scenario.prePageScript ?? scenario.pre_page_script ?? browserScenarioObserverScript(scenario.observers) ?? argValue(args, "pre-page-script")
  const auth = scenario.auth ?? argValue(args, "auth")
  const authUserId = scenario.authUserId ?? scenario.auth_user_id ?? argValue(args, "auth-user-id")
  const startedAt = now()
  const browserDirectory = join(artifactRoot, "files", "browser")
  await mkdir(browserDirectory, { recursive: true })

  let probeResult: Awaited<ReturnType<typeof runBrowserProbeCommand>> | undefined
  let actionsResult: Awaited<ReturnType<typeof runBrowserActionsCommand>> | undefined
  let pendingError: Error | undefined

  const shouldRunProbe = actionSteps.length === 0 || Boolean(prePageScript) || captures.some((capture) => capture === "performance" || capture === "memory")
  if (shouldRunProbe) {
    const probeArgs = [
      `url=${url}`,
      `capture=${browserScenarioProbeCaptures(captures, actionSteps.length > 0).join(",")}`,
      `wait-for=${scenario.waitFor ?? scenario.wait_for ?? argValue(args, "wait-for") ?? "domcontentloaded"}`,
    ]
    const duration = scenario.duration ?? argValue(args, "duration")
    if (duration) probeArgs.push(`duration=${duration}`)
    if (requestedViewport) probeArgs.push(`viewport=${requestedViewport}`)
    if (device) probeArgs.push(`device=${device}`)
    if (locale) probeArgs.push(`locale=${locale}`)
    if (prePageScript) probeArgs.push(`pre-page-script=${prePageScript}`)
    if (auth) probeArgs.push(`auth=${auth}`)
    if (authUserId) probeArgs.push(`auth-user-id=${authUserId}`)

    try {
      probeResult = await runBrowserProbeCommand({ artifactRoot, runtimeSpec, runPlaygroundCommand, server, spec: { ...spec, command: "wordpress.browser-probe", args: probeArgs } })
    } catch (error) {
      if (isBrowserCommandArtifactError(error)) {
        probeResult = { artifact: error.artifact, output: "" }
      }
      pendingError = error instanceof Error ? error : new Error(String(error))
    }
  }

  if (!pendingError && actionSteps.length > 0) {
    const actionsArgs = [
      `url=${url}`,
      `steps-json=${JSON.stringify(actionSteps)}`,
      `capture=${browserScenarioActionCaptures(captures).join(",")}`,
    ]
    const stepTimeout = scenario.stepTimeout ?? scenario.step_timeout ?? argValue(args, "step-timeout")
    const timeout = scenario.timeout ?? argValue(args, "timeout")
    if (requestedViewport) actionsArgs.push(`viewport=${requestedViewport}`)
    if (stepTimeout) actionsArgs.push(`step-timeout=${stepTimeout}`)
    if (timeout) actionsArgs.push(`timeout=${timeout}`)
    if (auth) actionsArgs.push(`auth=${auth}`)
    if (authUserId) actionsArgs.push(`auth-user-id=${authUserId}`)

    try {
      actionsResult = await runBrowserActionsCommand({ artifactRoot, runtimeSpec, runPlaygroundCommand, server, spec: { ...spec, command: "wordpress.browser-actions", args: actionsArgs } })
    } catch (error) {
      if (isBrowserCommandArtifactError(error)) {
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
    profile: scenario.profile ?? "desktop-chrome",
    capture: captures,
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

  const artifact: BrowserProbeArtifact = {
    ...primaryArtifact,
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
  const raw = scenario.captures ?? scenario.capture ?? commaListArg(args, "capture")
  const captures = Array.isArray(raw) ? raw.map(String).filter(Boolean) : []
  return captures.length > 0 ? captures : ["steps", "console", "errors", "html", "network", "screenshot"]
}

function browserScenarioProbeCaptures(captures: string[], actionsWillRun: boolean): string[] {
  const supported = new Set(["console", "errors", "html", "network", "performance", "memory", "screenshot"])
  const selected = captures.filter((capture) => supported.has(capture) && (!actionsWillRun || capture === "performance" || capture === "memory"))
  return selected.length > 0 ? selected : ["console", "errors", "html", "network", "screenshot"]
}

function browserScenarioActionCaptures(captures: string[]): string[] {
  const supported = new Set(["steps", "actions", "console", "errors", "html", "network", "screenshot"])
  const selected = captures.filter((capture) => supported.has(capture))
  return selected.length > 0 ? selected : ["steps", "console", "errors", "html", "network", "screenshot"]
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
}): Promise<{ artifact: BrowserProbeArtifact; output: string }> {
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
  const preview = browserProbePreviewRouting([], runtimeSpec, server.serverUrl)
  const targetUrl = resolveBrowserProbeUrl(target.url, preview.effectiveOrigin)
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
  const { chromium } = await import("playwright")
  const browser = await chromium.launch()
  let finalUrl = targetUrl
  let htmlSha256: string | undefined
  let screenshotSha256: string | undefined
  let viewport: BrowserProbeViewport | null = null
  let editorState: EditorStateSnapshot | undefined
  let pendingError: Error | undefined
  let artifact: BrowserProbeArtifact | undefined

  try {
    const page = await browser.newPage()
    await installWordPressAdminAuthCookies({ command: "wordpress.editor-open", page, runPlaygroundCommand, runtimeSpec, server, userId: 1 })
    viewport = await browserProbeViewport(page)
    if (capture.has("console")) {
      page.on("console", (message) => consoleMessages.push(serializeBrowserConsoleMessage(message)))
    }
    if (capture.has("errors")) {
      page.on("pageerror", (error) => errors.push(serializeBrowserError("pageerror", error)))
    }

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
      requestedUrl: targetUrl,
      url: targetUrl,
      preview,
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
}): Promise<{ artifact: BrowserProbeArtifact; output: string }> {
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
  const preview = browserProbePreviewRouting([], runtimeSpec, server.serverUrl)
  const targetUrl = resolveBrowserProbeUrl(target.url, preview.effectiveOrigin)
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
  const { chromium } = await import("playwright")
  const browser = await chromium.launch()
  let finalUrl = targetUrl
  let htmlSha256: string | undefined
  let screenshotSha256: string | undefined
  let viewport: BrowserProbeViewport | null = null
  let editorState: EditorStateSnapshot | undefined
  let pendingError: Error | undefined
  let artifact: BrowserProbeArtifact | undefined

  try {
    const page = await browser.newPage()
    await installWordPressAdminAuthCookies({ command: "wordpress.editor-actions", page, runPlaygroundCommand, runtimeSpec, server, userId: 1 })
    viewport = await browserProbeViewport(page)
    if (capture.has("console")) {
      page.on("console", (message) => consoleMessages.push(serializeBrowserConsoleMessage(message)))
    }
    if (capture.has("errors")) {
      page.on("pageerror", (error) => errors.push(serializeBrowserError("pageerror", error)))
    }

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
      requestedUrl: targetUrl,
      url: targetUrl,
      preview,
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
}): Promise<{ artifact: BrowserProbeArtifact; output: string }> {
  const args = spec.args ?? []
  const sourceUrl = argValue(args, "source-url")?.trim()
  const candidateUrl = argValue(args, "candidate-url")?.trim()
  const sourceScreenshot = argValue(args, "source-screenshot")?.trim()
  const candidateScreenshot = argValue(args, "candidate-screenshot")?.trim()
  const sourceLabel = argValue(args, "source-label")?.trim() || "source"
  const candidateLabel = argValue(args, "candidate-label")?.trim() || "candidate"
  const waitFor = argValue(args, "wait-for")?.trim() || "domcontentloaded"
  const durationMs = durationArg(args, "duration", 0)
  const requestedViewport = viewportArg(args, "viewport")
  const fullPage = booleanArg(args, "full-page", true)
  const threshold = numberArg(args, "threshold", 0.1)
  const includeAA = booleanArg(args, "include-aa", false)
  const maxRegions = positiveIntegerArg(args, "max-regions", 8)

  if (threshold < 0 || threshold > 1) {
    throw new Error("threshold must be between 0 and 1")
  }
  if (Boolean(sourceUrl) !== Boolean(candidateUrl) || Boolean(sourceScreenshot) !== Boolean(candidateScreenshot)) {
    throw new Error("wordpress.visual-compare requires source-url and candidate-url, or source-screenshot and candidate-screenshot")
  }
  if (!sourceUrl && !sourceScreenshot) {
    throw new Error("wordpress.visual-compare requires source-url/candidate-url or source-screenshot/candidate-screenshot")
  }

  const browserDirectory = join(artifactRoot, "files", "browser", "visual-compare")
  await mkdir(browserDirectory, { recursive: true })
  const sourcePath = join(browserDirectory, "source.png")
  const candidatePath = join(browserDirectory, "candidate.png")
  const diffPath = join(browserDirectory, "diff.png")
  const visualDiffPath = join(browserDirectory, "visual-diff.json")
  const summaryPath = join(browserDirectory, "summary.json")
  const startedAt = now()
  const preview = browserProbePreviewRouting([], runtimeSpec, server.serverUrl)
  const sourceTargetUrl = sourceUrl ? resolveBrowserProbeUrl(sourceUrl, preview.effectiveOrigin) : undefined
  const candidateTargetUrl = candidateUrl ? resolveBrowserProbeUrl(candidateUrl, preview.effectiveOrigin) : undefined
  let finalSourceUrl = sourceTargetUrl
  let finalCandidateUrl = candidateTargetUrl
  let viewport: BrowserProbeViewport | null = null

  if (sourceTargetUrl && candidateTargetUrl) {
    const { chromium } = await import("playwright")
    const browser = await chromium.launch(process.env.WP_CODEBOX_BROWSER_CHANNEL ? { channel: process.env.WP_CODEBOX_BROWSER_CHANNEL } : undefined)
    try {
      const page = await browser.newPage(requestedViewport ? { viewport: requestedViewport } : undefined)
      viewport = await browserProbeViewport(page)
      finalSourceUrl = await captureVisualCompareUrl(page, sourceTargetUrl, sourcePath, waitFor, durationMs, fullPage)
      finalCandidateUrl = await captureVisualCompareUrl(page, candidateTargetUrl, candidatePath, waitFor, durationMs, fullPage)
    } finally {
      await browser.close()
    }
  } else if (sourceScreenshot && candidateScreenshot) {
    await writeFile(sourcePath, await readFile(sourceScreenshot))
    await writeFile(candidatePath, await readFile(candidateScreenshot))
  }

  const comparison = await comparePngFiles(sourcePath, candidatePath, diffPath, { threshold, includeAA, maxRegions })
  const finishedAt = now()
  const files = {
    sourceScreenshot: "files/browser/visual-compare/source.png",
    candidateScreenshot: "files/browser/visual-compare/candidate.png",
    diffScreenshot: "files/browser/visual-compare/diff.png",
    visualDiff: "files/browser/visual-compare/visual-diff.json",
    summary: "files/browser/visual-compare/summary.json",
  }
  const summary = {
    schema: "wp-codebox/visual-compare/v1",
    command: "wordpress.visual-compare",
    status: comparison.mismatchPixels === 0 && !comparison.dimensionMismatch ? "identical" : "different",
    source: {
      label: sourceLabel,
      ...(sourceUrl ? { url: sourceUrl, finalUrl: finalSourceUrl } : {}),
      ...(sourceScreenshot ? { screenshot: sourceScreenshot } : {}),
    },
    candidate: {
      label: candidateLabel,
      ...(candidateUrl ? { url: candidateUrl, finalUrl: finalCandidateUrl } : {}),
      ...(candidateScreenshot ? { screenshot: candidateScreenshot } : {}),
    },
    options: { waitFor, durationMs, fullPage, threshold, includeAA, maxRegions },
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
  }
  const summaryJson = `${JSON.stringify(summary, null, 2)}\n`
  await writeFile(visualDiffPath, summaryJson)
  await writeFile(summaryPath, summaryJson)

  const artifact: BrowserProbeArtifact = {
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
      },
      viewport,
    },
  }

  return {
    artifact,
    output: `${JSON.stringify(summary, null, 2)}\n`,
  }
}

async function captureVisualCompareUrl(page: import("playwright").Page, targetUrl: string, outputPath: string, waitFor: string, durationMs: number, fullPage: boolean): Promise<string> {
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
  await page.screenshot({ path: outputPath, fullPage })
  return page.url()
}

async function comparePngFiles(sourcePath: string, candidatePath: string, diffPath: string, options: { threshold: number; includeAA: boolean; maxRegions: number }): Promise<{
  source: { width: number; height: number }
  candidate: { width: number; height: number }
  diff: { width: number; height: number }
  dimensionMismatch: boolean
  mismatchPixels: number
  totalPixels: number
  mismatchRatio: number
  regions: Array<{ x: number; y: number; width: number; height: number; pixels: number }>
}> {
  const source = PNG.sync.read(await readFile(sourcePath))
  const candidate = PNG.sync.read(await readFile(candidatePath))
  const width = Math.max(source.width, candidate.width)
  const height = Math.max(source.height, candidate.height)
  const sourceCanvas = visualCompareCanvas(source, width, height)
  const candidateCanvas = visualCompareCanvas(candidate, width, height)
  const diff = new PNG({ width, height })
  const mismatchPixels = pixelmatch(sourceCanvas.data, candidateCanvas.data, diff.data, width, height, { threshold: options.threshold, includeAA: options.includeAA })
  await writeFile(diffPath, PNG.sync.write(diff))

  return {
    source: { width: source.width, height: source.height },
    candidate: { width: candidate.width, height: candidate.height },
    diff: { width, height },
    dimensionMismatch: source.width !== candidate.width || source.height !== candidate.height,
    mismatchPixels,
    totalPixels: width * height,
    mismatchRatio: width * height > 0 ? mismatchPixels / (width * height) : 0,
    regions: visualCompareMismatchRegions(diff, options.maxRegions),
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

function visualCompareMismatchRegions(diff: PNG, maxRegions: number): Array<{ x: number; y: number; width: number; height: number; pixels: number }> {
  const visited = new Uint8Array(diff.width * diff.height)
  const regions: Array<{ x: number; y: number; width: number; height: number; pixels: number }> = []
  for (let y = 0; y < diff.height; y += 1) {
    for (let x = 0; x < diff.width; x += 1) {
      const index = y * diff.width + x
      if (visited[index] || !visualCompareDiffPixel(diff, x, y)) {
        continue
      }
      regions.push(visualCompareFloodRegion(diff, x, y, visited))
    }
  }
  return regions.sort((a, b) => b.pixels - a.pixels).slice(0, maxRegions)
}

function visualCompareFloodRegion(diff: PNG, startX: number, startY: number, visited: Uint8Array): { x: number; y: number; width: number; height: number; pixels: number } {
  const stack: Array<[number, number]> = [[startX, startY]]
  let minX = startX
  let maxX = startX
  let minY = startY
  let maxY = startY
  let pixels = 0
  while (stack.length > 0) {
    const [x, y] = stack.pop() ?? [0, 0]
    if (x < 0 || y < 0 || x >= diff.width || y >= diff.height) {
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

function summarizeEditorState(target: ReturnType<typeof editorOpenTargetFromArgs>, state: EditorStateSnapshot): NonNullable<BrowserProbeArtifact["summary"]["editor"]> {
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
  command,
  page,
  runPlaygroundCommand,
  runtimeSpec,
  server,
  userId,
}: {
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
  const response = await runPlaygroundCommand(authCommand, server, { code: bootstrapPhpCode(runtimeSpec, wordpressAdminAuthCookiePhpCode(server.serverUrl, userId), []) })
  assertPlaygroundResponseOk(authCommand, response)
  const cookies = JSON.parse(cleanWpCliOutput(response.text)) as Array<{ name?: string; value?: string; path?: string; expires?: number; httpOnly?: boolean; secure?: boolean; sameSite?: "Lax" }>
  const cookieDomain = new URL(server.serverUrl).hostname
  await page.context().addCookies(cookies.map((cookie) => ({
    name: String(cookie.name ?? ""),
    value: String(cookie.value ?? ""),
    domain: cookieDomain,
    path: typeof cookie.path === "string" && cookie.path.length > 0 ? cookie.path : "/",
    expires: typeof cookie.expires === "number" ? cookie.expires : Math.floor(Date.now() / 1000) + 3600,
    httpOnly: cookie.httpOnly !== false,
    secure: cookie.secure === true,
    sameSite: cookie.sameSite ?? "Lax",
  })))

  return { mode: "wordpress-admin", userId, cookieCount: cookies.length }
}

function wordpressAdminAuthCookiePhpCode(browserUrl: string, userId: number): string {
  return `
$user_id = ${JSON.stringify(userId)};
$user = get_user_by( 'id', $user_id );
if ( ! $user ) {
    throw new RuntimeException( 'Browser auth requires the requested WordPress user to exist.' );
}
wp_set_current_user( $user_id );
$expiration = time() + HOUR_IN_SECONDS;
$browser_url = ${JSON.stringify(browserUrl)};
$auth_scheme = is_ssl() ? 'secure_auth' : 'auth';
$cookies = array(
    array(
        'name'     => AUTH_COOKIE,
        'value'    => wp_generate_auth_cookie( $user_id, $expiration, $auth_scheme ),
        'url'      => $browser_url,
        'path'     => defined( 'ADMIN_COOKIE_PATH' ) && ADMIN_COOKIE_PATH ? ADMIN_COOKIE_PATH : '/wp-admin',
        'expires'  => $expiration,
        'httpOnly' => true,
        'secure'   => is_ssl(),
        'sameSite' => 'Lax',
    ),
    array(
        'name'     => LOGGED_IN_COOKIE,
        'value'    => wp_generate_auth_cookie( $user_id, $expiration, 'logged_in' ),
        'url'      => $browser_url,
        'path'     => defined( 'COOKIEPATH' ) && COOKIEPATH ? COOKIEPATH : '/',
        'expires'  => $expiration,
        'httpOnly' => true,
        'secure'   => is_ssl(),
        'sameSite' => 'Lax',
    ),
);
if ( defined( 'SITECOOKIEPATH' ) && SITECOOKIEPATH && SITECOOKIEPATH !== COOKIEPATH ) {
    $cookies[] = array(
        'name'     => LOGGED_IN_COOKIE,
        'value'    => wp_generate_auth_cookie( $user_id, $expiration, 'logged_in' ),
        'url'      => $browser_url,
        'path'     => SITECOOKIEPATH,
        'expires'  => $expiration,
        'httpOnly' => true,
        'secure'   => is_ssl(),
        'sameSite' => 'Lax',
    );
}
echo wp_json_encode( $cookies );
`
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

interface BrowserProbeNetworkPolicy {
  mode: "allow" | "block" | "record"
  allowHosts: Set<string>
  blockHosts: Set<string>
  routeHosts: Set<string>
  firstPartyHosts: Set<string>
  recordExternal: boolean
  stats: Map<string, { requests: number; external: boolean; blocked: number; routed: number }>
}

async function routeBrowserProbePageNetwork(page: Page, policy: BrowserProbeNetworkPolicy, localPreviewOrigin: string): Promise<void> {
  await routeBrowserProbeNetwork(page.route.bind(page), policy, localPreviewOrigin)
}

async function routeBrowserProbeContextNetwork(context: import("playwright").BrowserContext, policy: BrowserProbeNetworkPolicy, localPreviewOrigin: string): Promise<void> {
  await routeBrowserProbeNetwork(context.route.bind(context), policy, localPreviewOrigin)
}

async function routeBrowserProbeNetwork(routePattern: (url: string, handler: (route: Route) => Promise<void>) => Promise<unknown>, policy: BrowserProbeNetworkPolicy, localPreviewOrigin: string): Promise<void> {
  if (!browserProbeNeedsContextRouting(policy)) {
    return
  }

  const localOrigin = new URL(localPreviewOrigin)
  await routePattern("**/*", async (route) => {
    const request = route.request()
    let requestUrl: URL
    try {
      requestUrl = new URL(request.url())
    } catch {
      await route.continue()
      return
    }

    const host = normalizeBrowserProbeHost(requestUrl.hostname)
    const stat = browserProbeNetworkPolicyHostStat(policy, host)
    stat.requests += 1
    stat.external = !policy.firstPartyHosts.has(host)

    if (policy.blockHosts.has(host) || (policy.mode === "block" && stat.external && !policy.allowHosts.has(host))) {
      stat.blocked += 1
      await route.abort("blockedbyclient")
      return
    }

    if (!policy.routeHosts.has(host)) {
      await route.continue()
      return
    }

    stat.routed += 1
    const response = await fetchBrowserProbeRoutedHost(route, requestUrl, policy.routeHosts, localOrigin)
    await route.fulfill({ response })
  })
}

function browserProbeNetworkPolicy(args: string[], routeHosts: string[], preview: BrowserProbePreviewRouting): BrowserProbeNetworkPolicy {
  const mode = browserProbeNetworkPolicyMode(args)
  const allowHosts = new Set(commaListArg(args, "allow-host").map(normalizeBrowserProbeHost).filter(Boolean))
  const blockHosts = new Set(commaListArg(args, "block-host").map(normalizeBrowserProbeHost).filter(Boolean))
  const routedHosts = new Set(routeHosts.map(normalizeBrowserProbeHost).filter(Boolean))
  const firstPartyHosts = new Set<string>()
  for (const origin of [preview.localOrigin, preview.effectiveOrigin, preview.publicOrigin]) {
    const host = origin ? browserProbeUrlHostname(origin) : undefined
    if (host) {
      firstPartyHosts.add(host)
    }
  }

  return {
    mode,
    allowHosts,
    blockHosts,
    routeHosts: routedHosts,
    firstPartyHosts,
    recordExternal: booleanArg(args, "record-external", false),
    stats: new Map(),
  }
}

function browserProbeNetworkPolicyMode(args: string[]): BrowserProbeNetworkPolicy["mode"] {
  const raw = argValue(args, "network-policy")?.trim() || "record"
  if (raw === "allow" || raw === "block" || raw === "record") {
    return raw
  }

  throw new Error(`wordpress.browser-probe network-policy supports allow, block, record: ${raw}`)
}

function browserProbeNetworkPolicyIsActive(policy: BrowserProbeNetworkPolicy): boolean {
  return policy.mode !== "record" || policy.allowHosts.size > 0 || policy.blockHosts.size > 0 || policy.routeHosts.size > 0 || policy.recordExternal
}

function browserProbeNeedsContextRouting(policy: BrowserProbeNetworkPolicy): boolean {
  return policy.mode === "block" || policy.blockHosts.size > 0 || policy.routeHosts.size > 0 || policy.recordExternal
}

function browserProbeNetworkPolicySummary(policy: BrowserProbeNetworkPolicy): BrowserProbeNetworkPolicySummary {
  const hosts = Object.fromEntries([...policy.stats.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([host, stat]) => [host, { ...stat }]))
  return {
    mode: policy.mode,
    allowHosts: [...policy.allowHosts].sort(),
    blockHosts: [...policy.blockHosts].sort(),
    routeHosts: [...policy.routeHosts].sort(),
    recordExternal: policy.recordExternal,
    externalRequests: Object.values(hosts).filter((stat) => stat.external).reduce((total, stat) => total + stat.requests, 0),
    blockedRequests: Object.values(hosts).reduce((total, stat) => total + stat.blocked, 0),
    hosts: policy.recordExternal ? hosts : Object.fromEntries(Object.entries(hosts).filter(([, stat]) => stat.blocked > 0 || stat.routed > 0)),
  }
}

function browserProbeNetworkPolicyHostStat(policy: BrowserProbeNetworkPolicy, host: string): { requests: number; external: boolean; blocked: number; routed: number } {
  let stat = policy.stats.get(host)
  if (!stat) {
    stat = { requests: 0, external: false, blocked: 0, routed: 0 }
    policy.stats.set(host, stat)
  }
  return stat
}

function browserProbeUrlHostname(url: string): string | undefined {
  try {
    return normalizeBrowserProbeHost(new URL(url).hostname)
  } catch {
    return undefined
  }
}

function normalizeBrowserProbeHost(host: string): string {
  return host.trim().toLowerCase().replace(/:\d+$/, "")
}

async function fetchBrowserProbeRoutedHost(route: Route, requestUrl: URL, routedHosts: Set<string>, localOrigin: URL): Promise<Awaited<ReturnType<Route["fetch"]>>> {
  let currentUrl = requestUrl
  for (let redirectCount = 0; redirectCount < 10; redirectCount++) {
    const routedUrl = new URL(currentUrl.toString())
    routedUrl.protocol = localOrigin.protocol
    routedUrl.hostname = localOrigin.hostname
    routedUrl.port = localOrigin.port

    const response = await route.fetch({
      url: routedUrl.toString(),
      headers: {
        ...route.request().headers(),
        host: currentUrl.host,
        "x-forwarded-host": currentUrl.host,
        "x-forwarded-port": currentUrl.port || (currentUrl.protocol === "https:" ? "443" : "80"),
        "x-forwarded-proto": currentUrl.protocol.replace(":", ""),
      },
      maxRedirects: 0,
    })

    const location = response.headers().location
    if (!location || response.status() < 300 || response.status() >= 400) {
      return response
    }

    const redirectedUrl = new URL(location, currentUrl)
    if (!routedHosts.has(redirectedUrl.hostname.toLowerCase())) {
      return response
    }

    currentUrl = redirectedUrl
  }

  throw new Error(`wordpress.browser-probe route-host exceeded redirect limit for ${requestUrl.href}`)
}

function browserProbePreviewOrigins(preview: BrowserProbePreviewRouting): { localPreviewOrigin: string; requestedPreviewOrigin?: string; effectivePreviewOrigin: string } {
  return {
    localPreviewOrigin: preview.localOrigin,
    requestedPreviewOrigin: preview.publicOrigin,
    effectivePreviewOrigin: preview.effectiveOrigin,
  }
}

function browserProbePreviewRouting(args: string[], runtimeSpec: RuntimeCreateSpec | undefined, localPreviewOrigin: string): BrowserProbePreviewRouting {
  const publicOrigin = runtimeSpec?.preview?.publicUrl
  const requestedMode = browserProbePreviewMode(args, publicOrigin)
  const effectiveMode: BrowserProbePreviewMode = requestedMode === "local" || !publicOrigin ? "local" : requestedMode
  const effectiveOrigin = effectiveMode === "local" ? localPreviewOrigin : (publicOrigin ?? localPreviewOrigin)
  const diagnostics: BrowserProbePreviewRouting["diagnostics"] = []

  if ((requestedMode === "public" || requestedMode === "secure") && !publicOrigin) {
    diagnostics.push({
      code: "preview-public-origin-missing",
      severity: "error",
      message: `wordpress.browser-probe preview-mode=${requestedMode} requires runtime.preview.publicUrl or --preview-public-url`,
      details: { requestedMode, localOrigin: localPreviewOrigin },
    })
  }

  if (requestedMode === "secure" && publicOrigin) {
    const protocol = urlProtocol(publicOrigin)
    if (protocol !== "https:") {
      diagnostics.push({
        code: "preview-public-origin-not-https",
        severity: "error",
        message: "wordpress.browser-probe preview-mode=secure requires an HTTPS public preview origin",
        details: { publicOrigin, protocol },
      })
    }
  }

  return {
    requestedMode,
    effectiveMode,
    localOrigin: localPreviewOrigin,
    effectiveOrigin,
    ...(publicOrigin ? { publicOrigin } : {}),
    diagnostics,
  }
}

function browserProbePreviewMode(args: string[], publicOrigin: string | undefined): BrowserProbePreviewMode {
  const raw = argValue(args, "preview-mode")?.trim() || (publicOrigin ? "public" : "local")
  if (raw === "local" || raw === "public" || raw === "secure") {
    return raw
  }

  throw new Error(`wordpress.browser-probe preview-mode supports local, public, secure: ${raw}`)
}

function browserProbePreviewReadinessError(preview: BrowserProbePreviewRouting): Error | undefined {
  const diagnostic = preview.diagnostics.find((item) => item.severity === "error")
  if (!diagnostic) {
    return undefined
  }

  return new Error(diagnostic.message)
}

function browserProbeSecureContextError(preview: BrowserProbePreviewRouting): Error | undefined {
  if (preview.requestedMode !== "secure" || preview.secureContext !== false) {
    return undefined
  }

  const diagnostic = {
    code: "preview-secure-context-unavailable",
    severity: "error" as const,
    message: "wordpress.browser-probe preview-mode=secure reached the preview, but the page did not report a secure browser context",
    details: { effectiveOrigin: preview.effectiveOrigin, secureContext: preview.secureContext },
  }
  preview.diagnostics.push(diagnostic)
  return new Error(diagnostic.message)
}

function urlProtocol(url: string): string | undefined {
  try {
    return new URL(url).protocol
  } catch {
    return undefined
  }
}

function resolveBrowserProbeUrl(pathOrUrl: string, baseUrl: string): string {
  try {
    return new URL(pathOrUrl).toString()
  } catch {
    return new URL(pathOrUrl, baseUrl).toString()
  }
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

function booleanArg(args: string[], name: string, fallback: boolean): boolean {
  const raw = argValue(args, name)?.trim().toLowerCase()
  if (!raw) {
    return fallback
  }
  if (["1", "true", "yes", "on"].includes(raw)) {
    return true
  }
  if (["0", "false", "no", "off"].includes(raw)) {
    return false
  }
  throw new Error(`${name} must be true or false`)
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

function durationArg(args: string[], name: string, fallbackMs: number): number {
  const raw = argValue(args, name)?.trim()
  if (!raw) {
    return fallbackMs
  }

  const match = raw.match(/^(\d+(?:\.\d+)?)(ms|s)$/)
  if (!match) {
    throw new Error(`${name} must be a duration like 500ms or 2s`)
  }

  const value = Number.parseFloat(match[1])
  return Math.max(0, Math.round(match[2] === "ms" ? value : value * 1000))
}

function viewportArg(args: string[], name: string): { width: number; height: number } | undefined {
  const raw = argValue(args, name)?.trim()
  if (!raw) {
    return undefined
  }

  const match = raw.match(/^(\d+)x(\d+)$/i)
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
