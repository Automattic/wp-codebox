import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { assertRuntimeCommandAllowed, browserInteractionScriptUsesEvaluate, type ExecutionSpec, type RuntimeCreateSpec } from "@automattic/wp-codebox-core"
import { browserInteractionStepsFromArgs, durationStringMs } from "./browser-actions.js"
import type { BrowserProbeArtifact, BrowserProbeCheckpointRecord, BrowserProbeContextDetails, BrowserProbeErrorRecord, BrowserProbeMemoryArtifact, BrowserProbeNetworkRecord, BrowserProbePerformanceArtifact, BrowserProbeScriptMetadata, BrowserProbeViewport, BrowserStepRecord } from "./browser-artifacts.js"
import { browserAssertionsSummary, browserStepRecord, executeBrowserInteractionStep } from "./browser-interactions.js"
import { browserProbeBenchMetrics, jsonLines, serializeBrowserConsoleMessage, serializeBrowserError, serializeBrowserFinishedRequest, serializeBrowserRequestFailure } from "./browser-metrics.js"
import { BROWSER_PROBE_CAPTURE_VALUES, BROWSER_PROBE_PERFORMANCE_INIT_SCRIPT, BROWSER_PROBE_STATE_INIT_SCRIPT, browserProbeAssertionsFromArgs, browserProbeCheckpoint, browserProbeMemoryArtifact, browserProbePendingCheckpoints, browserProbePerformanceArtifact, browserProbeReplayability, browserProbeViewport, executeBrowserProbeAssertions, navigateBrowserProbe } from "./browser-probe.js"
import { argValue, cleanWpCliOutput, commaListArg } from "./commands.js"
import { editorActionStepsFromArgs, editorOpenTargetFromArgs, type EditorActionStep } from "./editor-actions.js"
import { bootstrapPhpCode } from "./php-bootstrap.js"
import { assertPlaygroundResponseOk, type PlaygroundRunResponse } from "./playground-command-errors.js"
import type { PlaygroundCliServer } from "./preview-server.js"

const BROWSER_STEP_DEFAULT_TIMEOUT_MS = 15_000
const BROWSER_SCRIPT_DEFAULT_TIMEOUT_MS = 120_000

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
  server,
  spec,
}: {
  artifactRoot: string
  command?: string
  runtimeSpec: RuntimeCreateSpec
  server: PlaygroundCliServer
  spec: ExecutionSpec
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
  const requestedContext = browserProbeContextRequest(args, requestedViewport)
  const prePageScript = argValue(args, "pre-page-script")
  const script = argValue(args, "script")
  const failFast = booleanArg(args, "fail-fast", false)
  const stallTimeoutMs = durationArg(args, "stall-timeout", 0)
  const assertions = browserProbeAssertionsFromArgs(args)
  const capturesConsoleForAssertions = assertions.some((assertion) => assertion.type === "no-console-errors" || assertion.type === "no-errors")
  const capturesErrorsForAssertions = assertions.some((assertion) => assertion.type === "no-page-errors" || assertion.type === "no-errors")
  const capturesBrowserMetrics = capture.has("performance") || capture.has("memory")
  const prePageScriptMetadata = prePageScript ? browserProbeScriptMetadata(prePageScript) : undefined
  const previewOrigins = browserProbePreviewOrigins(runtimeSpec, server.serverUrl)
  const targetUrl = resolveBrowserProbeUrl(urlArg, previewOrigins.effectivePreviewOrigin)
  const browserDirectory = join(artifactRoot, "files", "browser")
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
  const networkPath = join(browserDirectory, "network.jsonl")
  const performancePath = join(browserDirectory, "performance.json")
  const screenshotPath = join(browserDirectory, "screenshot.png")
  const summaryPath = join(browserDirectory, "summary.json")
  const startedAt = now()
  const progress = createBrowserProbeProgressTracker(startedAt, stallTimeoutMs)
  const { chromium, devices } = await import("playwright")
  const deviceProfile = requestedContext.device ? devices[requestedContext.device] : undefined
  if (requestedContext.device && !deviceProfile) {
    throw new Error(`wordpress.browser-probe unknown Playwright device profile: ${requestedContext.device}`)
  }
  const browser = await chromium.launch()
  let finalUrl = targetUrl
  let htmlSha256: string | undefined
  let screenshotSha256: string | undefined
  let viewport: BrowserProbeViewport | null = null
  let scriptResult: unknown
  let memoryArtifact: BrowserProbeMemoryArtifact | undefined
  let performanceArtifact: BrowserProbePerformanceArtifact | undefined
  let page: import("playwright").Page | null = null
  let context: import("playwright").BrowserContext | null = null
  let contextDetails: BrowserProbeContextDetails | undefined
  let assertionResults: import("./browser-artifacts.js").BrowserStepAssertion[] = []
  let pendingError: Error | undefined
  let artifact: BrowserProbeArtifact | undefined

  try {
    context = requestedContext.device || requestedContext.locale
      ? await browser.newContext({
        ...(deviceProfile ?? {}),
        ...(requestedContext.locale ? { locale: requestedContext.locale } : {}),
      })
      : null
    page = context ? await context.newPage() : await browser.newPage()
    if (requestedViewport) {
      await page.setViewportSize(requestedViewport)
    }
    await page.addInitScript(BROWSER_PROBE_STATE_INIT_SCRIPT)
    if (capturesBrowserMetrics) {
      await page.addInitScript(BROWSER_PROBE_PERFORMANCE_INIT_SCRIPT)
    }
    if (prePageScript) {
      await page.addInitScript(prePageScript)
    }
    viewport = await browserProbeViewport(page)
    contextDetails = await browserProbeContextDetails(page, requestedContext, viewport)
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
    if (capture.has("network")) {
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

    await withBrowserProbeLiveness(page, progress, failFast, navigateBrowserProbe(page, targetUrl, waitFor, durationMs))
    progress.mark("navigation")
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
      assertionResults = await executeBrowserProbeAssertions(page, assertions, consoleMessages, errors)
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
      if (capturesBrowserMetrics) {
        checkpoints.push(await browserProbeCheckpoint(page, "final"))
        if (capture.has("memory")) {
          memoryArtifact = browserProbeMemoryArtifact(checkpoints)
        }
        if (capture.has("performance")) {
          performanceArtifact = browserProbePerformanceArtifact(checkpoints)
        }
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
    if (capture.has("console")) {
      await writeFile(consolePath, jsonLines(consoleMessages))
    }
    if (capture.has("errors")) {
      await writeFile(errorsPath, jsonLines(errors))
    }
    if (capture.has("network")) {
      await writeFile(networkPath, jsonLines(network))
    }
    if (checkpoints.length > 0) {
      await writeFile(checkpointsPath, jsonLines(checkpoints))
    }
    if (memoryArtifact) {
      await writeFile(memoryPath, `${JSON.stringify(memoryArtifact, null, 2)}\n`)
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

    artifact = {
      requestedUrl: targetUrl,
      url: targetUrl,
      ...previewOrigins,
      ...(prePageScriptMetadata ? { prePageScript: prePageScriptMetadata } : {}),
      files: {
        ...(capture.has("console") ? { console: "files/browser/console.jsonl" } : {}),
        ...(checkpoints.length > 0 ? { checkpoints: "files/browser/checkpoints.jsonl" } : {}),
        ...(capture.has("errors") ? { errors: "files/browser/errors.jsonl" } : {}),
        ...(capture.has("html") ? { html: "files/browser/snapshot.html" } : {}),
        ...(memoryArtifact ? { memory: "files/browser/memory.json" } : {}),
        ...(capture.has("network") ? { network: "files/browser/network.jsonl" } : {}),
        ...(performanceArtifact ? { performance: "files/browser/performance.json" } : {}),
        ...(capture.has("screenshot") ? { screenshot: "files/browser/screenshot.png" } : {}),
        summary: "files/browser/summary.json",
      },
      summary: {
        ...(assertionSummary.total > 0 ? { assertions: assertionSummary } : {}),
        consoleMessages: consoleMessages.length,
        errors: errors.length,
        finalUrl,
        htmlSnapshot: capture.has("html"),
        ...(memoryArtifact ? { memory: memoryArtifact.peak } : {}),
        ...(memoryArtifact || performanceArtifact ? { metrics: browserProbeBenchMetrics(memoryArtifact, performanceArtifact) } : {}),
        networkEvents: network.length,
        ...(performanceArtifact ? { performance: performanceArtifact.peak } : {}),
        progress: progress.summary(),
        context: contextDetails,
        replayability: browserProbeReplayability(capture),
        screenshot: capture.has("screenshot"),
        ...(typeof scriptResult !== "undefined" ? { scriptResult } : {}),
        viewport,
      },
    }
    await writeFile(summaryPath, `${JSON.stringify({
      schema: "wp-codebox/browser-probe/v1",
      requestedUrl: targetUrl,
      ...previewOrigins,
      finalUrl,
      waitFor,
      durationMs,
      failFast,
      stallTimeoutMs,
      capture: [...capture].sort(),
      ...(assertionSummary.total > 0 ? { assertions: assertionSummary } : {}),
      ...(prePageScriptMetadata ? { prePageScript: prePageScriptMetadata } : {}),
      startedAt,
      finishedAt: now(),
      files: artifact.files,
      hashes: {
        ...(htmlSha256 ? { html: { algorithm: "sha256", value: htmlSha256 } } : {}),
        ...(screenshotSha256 ? { screenshot: { algorithm: "sha256", value: screenshotSha256 } } : {}),
      },
      context: contextDetails,
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
      ...previewOrigins,
      finalUrl: artifact.summary.finalUrl ?? targetUrl,
      files: artifact.files,
      summary: artifact.summary,
    }, null, 2)}\n`,
  }
}

function browserProbeScriptMetadata(source: string): BrowserProbeScriptMetadata {
  return {
    sha256: sha256(Buffer.from(source, "utf8")),
    bytes: Buffer.byteLength(source, "utf8"),
  }
}

function browserProbeContextRequest(args: string[], viewport: { width: number; height: number } | undefined): BrowserProbeContextDetails["requested"] {
  const device = argValue(args, "device")?.trim()
  const locale = argValue(args, "locale")?.trim()
  return {
    ...(device ? { device } : {}),
    ...(locale ? { locale } : {}),
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
      ...(requested.device ? { device: requested.device } : {}),
      ...(effective.locale ? { locale: effective.locale } : {}),
      ...(effective.timezone ? { timezone: effective.timezone } : {}),
      viewport,
    },
  }
}

export async function runHtmlCaptureCommand(input: {
  artifactRoot: string
  runtimeSpec: RuntimeCreateSpec
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

export async function runBrowserActionsCommand({
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
  let requestedUrl = initialUrl ? resolveBrowserProbeUrl(initialUrl, server.serverUrl) : server.serverUrl
  let finalUrl = requestedUrl
  let htmlSha256: string | undefined
  let screenshotSha256: string | undefined
  let viewport: BrowserProbeViewport | null = null
  let pendingError: Error | undefined
  let artifact: BrowserProbeArtifact | undefined

  try {
    const page = await browser.newPage()
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
        viewport,
      },
    }
    await writeFile(summaryPath, `${JSON.stringify({
      schema: "wp-codebox/browser-actions/v1",
      requestedUrl,
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
      finalUrl: artifact.summary.finalUrl ?? finalUrl,
      files: artifact.files,
      summary: artifact.summary,
      steps: stepRecords,
    }, null, 2)}\n`,
  }
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
  const targetUrl = resolveBrowserProbeUrl(target.url, server.serverUrl)
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
    await installEditorAuthCookies({ page, runPlaygroundCommand, runtimeSpec, server })
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
  const targetUrl = resolveBrowserProbeUrl(target.url, server.serverUrl)
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
    await installEditorAuthCookies({ page, runPlaygroundCommand, runtimeSpec, server })
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
      finalUrl: artifact.summary.finalUrl ?? finalUrl,
      files: artifact.files,
      summary: artifact.summary,
      steps: stepRecords,
    }, null, 2)}\n`,
  }
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

async function installEditorAuthCookies({
  page,
  runPlaygroundCommand,
  runtimeSpec,
  server,
}: {
  page: import("playwright").Page
  runPlaygroundCommand: (command: string, server: PlaygroundCliServer, options: { code: string } | { scriptPath: string }) => Promise<PlaygroundRunResponse>
  runtimeSpec: RuntimeCreateSpec
  server: PlaygroundCliServer
}): Promise<void> {
  const response = await runPlaygroundCommand("wordpress.editor-open.auth", server, { code: bootstrapPhpCode(runtimeSpec, editorAuthCookiePhpCode(server.serverUrl), []) })
  assertPlaygroundResponseOk("wordpress.editor-open.auth", response)
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
}

function editorAuthCookiePhpCode(browserUrl: string): string {
  return `
$user_id = 1;
$user = get_user_by( 'id', $user_id );
if ( ! $user ) {
    throw new RuntimeException( 'wordpress.editor-open requires admin user ID 1 to exist.' );
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

function now(): string {
  return new Date().toISOString()
}

function browserProbePreviewOrigins(runtimeSpec: RuntimeCreateSpec, localPreviewOrigin: string): { localPreviewOrigin: string; requestedPreviewOrigin?: string; effectivePreviewOrigin: string } {
  return {
    localPreviewOrigin,
    requestedPreviewOrigin: runtimeSpec.preview?.publicUrl,
    effectivePreviewOrigin: runtimeSpec.preview?.publicUrl ?? localPreviewOrigin,
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
