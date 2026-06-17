import { readFile } from "node:fs/promises"
import { assertRuntimeCommandAllowed, browserInteractionScriptUsesEvaluate, resolveCommandPath, validateBrowserInteractionScript, type BrowserInteractionStep, type ExecutionSpec, type RuntimeCreateSpec } from "@automattic/wp-codebox-core"
import { now, sha256 } from "@automattic/wp-codebox-core/internals"
import { browserInteractionStepsFromArgs, browserStepTimeoutMs, durationStringMs, sanitizeScreenshotName } from "./browser-actions.js"
import { BrowserArtifactSession } from "./browser-artifact-session.js"
import { BrowserCommandArtifactError, isBrowserCommandArtifactError } from "./browser-command-artifact-error.js"
import type { BrowserArtifact, BrowserProbeAuthSummary, BrowserProbeErrorRecord, BrowserProbeNetworkRecord, BrowserProbeViewport, BrowserStepRecord } from "./browser-artifacts.js"
import { attachBrowserCaptureListeners, launchChromiumBrowser, settleBrowserNetworkTasks } from "./browser-capture-session.js"
import { captureBrowserDomSnapshot, type BrowserDomSnapshotArtifact } from "./browser-dom-snapshot.js"
import { browserAssertionsSummary, browserStepRecord, executeBrowserInteractionStep } from "./browser-interactions.js"
import { browserCommandLivenessPolicy, isBrowserCommandLivenessError, withBrowserCommandLiveness } from "./browser-liveness.js"
import { serializeBrowserError } from "./browser-metrics.js"
import { browserPreviewNetworkPolicyIsActive, browserPreviewNetworkPolicySummary, browserPreviewNeedsContextRouting, browserPreviewTopology, resolveBrowserPreviewUrl, routeBrowserPreviewContextNetwork } from "./browser-preview-routing.js"
import { BROWSER_PROBE_STATE_INIT_SCRIPT, browserProbeReplayability, browserProbeViewport } from "./browser-probe.js"
import { runBrowserProbeCommand, type BrowserProbeRunPlan } from "./browser-probe-runner.js"
import { browserActionTargetUrls, browserAuthRequest, browserProbeWaterfallArtifact, browserRedirectDiagnosticsArtifact, browserStorageStateAuthSummary, browserStorageStateImportFromArgs, browserWordPressDiagnosticsArtifact, createBrowserProbeProgressTracker, fileSha256, installBrowserWordPressDiagnostics, installWordPressAdminAuthCookies, livenessRemainingWallTimeMs, normalizeBrowserProbeScriptCheckpoint, type BrowserCommandProgressEvent, type BrowserStorageStateImport } from "./browser-probe-support.js"
import { positiveIntegerArg } from "./command-args.js"
import { argValue, commaListArg, durationArg, viewportArg } from "./commands.js"
import type { PlaygroundRunResponse } from "./playground-command-errors.js"
import type { PlaygroundCliServer } from "./preview-server.js"
import type { Page } from "playwright"

const BROWSER_STEP_DEFAULT_TIMEOUT_MS = 15_000
const BROWSER_SCRIPT_DEFAULT_TIMEOUT_MS = 120_000

export interface BrowserActionsRunPlan {
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

interface BrowserRunPlan {
  profile: string
  capture: string[]
  probe?: BrowserProbeRunPlan
  actions?: BrowserActionsRunPlan
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
  const snapshot = await captureBrowserDomSnapshot(page, maxElements)
  const artifact: BrowserDomSnapshotArtifact = {
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
