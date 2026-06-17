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
import { runBrowserProbeCommand, type BrowserProbeRunPlan } from "./browser-probe-runner.js"
import { browserActionTargetUrls, browserAuthRequest, browserProbeWaterfallArtifact, browserRedirectDiagnosticsArtifact, browserStorageStateAuthSummary, browserStorageStateImportFromArgs, browserWordPressDiagnosticsArtifact, createBrowserProbeProgressTracker, fileSha256, installBrowserWordPressDiagnostics, installWordPressAdminAuthCookies, livenessRemainingWallTimeMs, normalizeBrowserProbeScriptCheckpoint, now, sha256, type BrowserCommandProgressEvent, type BrowserStorageStateImport } from "./browser-probe-support.js"

const BROWSER_STEP_DEFAULT_TIMEOUT_MS = 15_000
const BROWSER_SCRIPT_DEFAULT_TIMEOUT_MS = 120_000
const EDITOR_CANVAS_DEFAULT_IFRAME_SELECTOR = 'iframe[name="editor-canvas"]'
const EDITOR_CANVAS_DEFAULT_LAYOUT_SELECTOR = ".block-editor-block-list__layout"
const EDITOR_CANVAS_DEFAULT_BLOCK_SELECTOR = ".block-editor-block-list__block, [data-block]"
const EDITOR_CANVAS_DEFAULT_TIMEOUT_MS = 30_000

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

interface BrowserRunPlan {
  profile: string
  capture: string[]
  probe?: BrowserProbeRunPlan
  actions?: BrowserActionsRunPlan
}

export { BrowserCommandArtifactError, isBrowserCommandArtifactError }
export { runBrowserProbeCommand, runSingleBrowserProbeCommand, type BrowserProbeRunPlan } from "./browser-probe-runner.js"
export { wordpressAdminAuthCookiePhpCode } from "./browser-probe-support.js"
export { runVisualCompareCommand } from "./browser-visual-compare.js"


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
