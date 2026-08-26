import { type ExecutionSpec, type RuntimeCreateSpec } from "@automattic/wp-codebox-core"
import { now, sha256 } from "@automattic/wp-codebox-core/internals"
import { durationStringMs } from "./browser-actions.js"
import { BrowserArtifactSession } from "./browser-artifact-session.js"
import { BrowserCommandArtifactError } from "./browser-command-artifact-error.js"
import type { BrowserArtifact, BrowserArtifactFiles, BrowserArtifactSummary, BrowserEditorCanvasProbeDiagnostic, BrowserEditorCanvasProbeSummary, BrowserEditorCanvasSelectorGroupSummary, BrowserEditorCanvasSelectorSummary, BrowserEditorIdleCanvasSummary, BrowserEditorPresentationSummary, BrowserEditorReadinessSummary, BrowserEditorSaveSummary, BrowserEditorValidateBlocksSummary, BrowserEditorValiditySummary, BrowserProbeAuthSummary, BrowserProbeErrorRecord, BrowserProbeViewport, BrowserStepRecord } from "./browser-artifacts.js"
import { attachBrowserCaptureListeners, launchChromiumBrowser } from "./browser-capture-session.js"
import { browserStepRecord } from "./browser-interactions.js"
import { browserPreviewCleanupErrorIsFatal, browserPreviewNetworkPolicyIsActive, browserPreviewNetworkPolicySummary, browserPreviewNeedsContextRouting, browserPreviewReadinessError, browserPreviewSecureContextError, browserPreviewTopology, closeBrowserAndDrainPreviewRoutes, createBrowserPreviewRouteTracker, routeBrowserPreviewContextNetwork } from "./browser-preview-routing.js"
import { browserCommandResult } from "./browser-result-sanitization.js"
import { browserProbeReplayability, browserProbeViewport } from "./browser-probe.js"
import { argValue, commaListArg, durationArg, jsonArrayArg } from "./commands.js"
import { DEFAULT_EDITOR_WAIT_SELECTOR, editorActionStepsFromArgs, editorOpenTargetFromArgs, editorValidateContentFromArgs, editorValidateProviderFromArgs, resolveEditorOpenTarget, type EditorActionStep, type EditorBlockSpec, type EditorBlockTarget, type EditorOpenTarget } from "./editor-actions.js"
import { assertPlaygroundResponseOk, type PlaygroundRunResponse } from "./playground-command-errors.js"
import type { PlaygroundCliServer } from "./preview-server.js"
import { serializeBrowserError } from "./browser-metrics.js"
import { fileSha256, installWordPressAdminAuthCookies } from "./browser-probe-support.js"
import { bootstrapPhpCode } from "./php-bootstrap.js"
import { cleanWpCliOutput } from "./wp-cli-command-handlers.js"
import { comparePngFiles } from "./browser-visual-compare.js"

const BROWSER_STEP_DEFAULT_TIMEOUT_MS = 15_000
const BROWSER_SCRIPT_DEFAULT_TIMEOUT_MS = 120_000
const EDITOR_CANVAS_DEFAULT_IFRAME_SELECTOR = 'iframe[name="editor-canvas"]'
const EDITOR_CANVAS_DEFAULT_LAYOUT_SELECTOR = ".block-editor-block-list__layout"
const EDITOR_CANVAS_DEFAULT_BLOCK_SELECTOR = ".block-editor-block-list__block, [data-block]"
const EDITOR_CANVAS_DEFAULT_TIMEOUT_MS = 30_000
const EDITOR_PRESENTATION_SETTLE_MS = 250
const EDITOR_PRESENTATION_MIN_OBSERVATION_MS = 4_000
const EDITOR_PRESENTATION_POLL_MS = 50
const EDITOR_PRESENTATION_IFRAME_DISCOVERY_MS = 1_000
const EDITOR_PRESENTATION_MAX_CAPTURE_MS = 10_000
const EDITOR_VALIDITY_WARNING_SELECTORS = [
  ".block-editor-warning",
  ".block-editor-block-list__block.is-invalid",
  "[data-type].is-invalid",
  ".components-notice",
]

export function editorCommandWordPressUrl(server: PlaygroundCliServer): string {
  return server.wordpressUrl ?? server.serverUrl
}

function editorCommandPreviewTopology(args: string[], runtimeSpec: RuntimeCreateSpec, server: PlaygroundCliServer) {
  return browserPreviewTopology(["preview-mode=local", ...args], runtimeSpec, editorCommandWordPressUrl(server))
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
  const topology = browserPreviewTopology(args, runtimeSpec, server.serverUrl, server.previewProxyDiagnostics?.targetOrigin)
  const { preview, networkPolicy } = topology
  const previewOrigins = topology.origins
  const targetUrl = topology.resolveUrl(urlArg)
  const artifactSession = new BrowserArtifactSession(artifactRoot, "files/browser", { source: "wordpress.editor-canvas-probe", operation: "editor-canvas-probe" })
  const screenshotPath = artifactSession.absolutePath("editor-canvas-screenshot.png")
  const startedAt = now()
  const startedAtMs = Date.now()
  const browser = await launchChromiumBrowser()
  const routeTracker = createBrowserPreviewRouteTracker()
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

    const context = browserPreviewNeedsContextRouting(networkPolicy) ? await browser.newContext(topology.contextOptions()) : null
    if (context) {
      await routeBrowserPreviewContextNetwork(context, networkPolicy, topology.origins.localProxyOrigin, routeTracker)
    }
    const page = context ? await context.newPage() : await browser.newPage()
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
    for (const routeError of await closeBrowserAndDrainPreviewRoutes(browser, routeTracker)) {
      errors.push(serializeBrowserError("probe-error", routeError))
      if (browserPreviewCleanupErrorIsFatal(routeError)) pendingError ??= routeError
    }
    if (artifact) {
      artifact.summary.errors = errors.length
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
        errors,
        summary: artifact.summary.editorCanvas,
      })
    }
  }

  if (!artifact) {
    throw pendingError ?? new Error("wordpress.editor-canvas-probe did not produce an artifact")
  }
  if (pendingError) {
    throw new BrowserCommandArtifactError(pendingError.message, artifact)
  }

  return browserCommandResult(artifact, {
      command: "wordpress.editor-canvas-probe",
      requestedUrl: targetUrl,
      finalUrl: artifact.summary.finalUrl,
      files: artifact.files,
      summary: artifact.summary.editorCanvas,
  })
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
  const locator = page.locator(iframeSelector).first()
  if (await locator.count() === 0) return null
  const handle = await locator.elementHandle().catch(() => null)
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
  const target = await resolveEditorOpenTarget(editorOpenTargetFromArgs(args), {
    command: "wordpress.editor-open",
    runPlaygroundCommand,
    runtimeSpec,
    server,
  })
  const capture = new Set(commaListArg(args, "capture"))
  if (capture.size === 0) {
    capture.add("steps")
    capture.add("console")
    capture.add("errors")
    capture.add("html")
    capture.add("screenshot")
    capture.add("editor-state")
    capture.add("editor-validity")
  }
  for (const item of capture) {
    if (!["steps", "console", "errors", "html", "screenshot", "editor-state", "editor-validity"].includes(item)) {
      throw new Error(`wordpress.editor-open capture supports steps, console, errors, html, screenshot, editor-state, editor-validity: ${item}`)
    }
  }

  const waitTimeoutMs = durationArg(args, "wait-timeout", BROWSER_STEP_DEFAULT_TIMEOUT_MS)
  const topology = editorCommandPreviewTopology(args, runtimeSpec, server)
  const { preview, networkPolicy } = topology
  const routeTracker = createBrowserPreviewRouteTracker()
  const targetUrl = topology.resolveUrl(target.url)
  const artifactPathPrefix = editorOpenArtifactPathPrefixFromArgs(args)
  const artifactSession = new BrowserArtifactSession(artifactRoot, artifactPathPrefix, { source: "wordpress.editor-open", operation: "editor-open" })

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
  let editorValidity: EditorValidityArtifact | undefined
  let editorCanvasReadiness: BrowserEditorCanvasProbeSummary | undefined
  let editorReadiness: BrowserEditorReadinessSummary | undefined
  let editorPresentation: BrowserEditorPresentationSummary | undefined
  let authSummary: BrowserProbeAuthSummary | undefined
  let pendingError: Error | undefined
  let artifact: BrowserArtifact | undefined

  try {
    const previewReadinessError = browserPreviewReadinessError(preview)
    if (previewReadinessError) {
      throw previewReadinessError
    }
    const context = browserPreviewNeedsContextRouting(networkPolicy) ? await browser.newContext(topology.contextOptions()) : null
    if (context) {
      await routeBrowserPreviewContextNetwork(context, networkPolicy, topology.origins.localProxyOrigin, routeTracker)
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
        const readiness = await waitForEditorOpenReadiness(page, target.waitSelector, waitTimeoutMs)
        editorReadiness = readiness.editorReadiness
        editorCanvasReadiness = readiness.editorCanvasReadiness
        finalUrl = page.url()
        stepRecords.push(browserStepRecord(1, { kind: "waitFor", selector: target.waitSelector ?? "wp.data core/block-editor.getBlocks" }, "ok", waitStartedAt, waitStartedAtMs, finalUrl, {
          editorReadiness,
          ...(editorCanvasReadiness ? { editorCanvas: editorCanvasReadiness } : {}),
        } as never))
      } catch (error) {
        const serialized = serializeBrowserError("probe-error", error)
        errors.push(serialized)
        stepRecords.push(browserStepRecord(1, { kind: "waitFor", selector: target.waitSelector }, "failed", waitStartedAt, waitStartedAtMs, page.url(), { error: serialized }))
        pendingError = error instanceof Error ? error : new Error(String(error))
      }
    }

    if (editorReadiness) {
      await dismissWordPressOnboardingDialogs(page)
      editorPresentation = await captureEditorPresentation(page, waitTimeoutMs)
      if (editorPresentation) {
        const expected = await captureExpectedEditorPresentationIdentities(target, runPlaygroundCommand, runtimeSpec, server)
        const idleCanvas = await captureEditorIdleCanvas(page)
        editorPresentation = {
          ...editorPresentation,
          ...(expected ? {
            expectedGeneratedPresentationIdentities: expected.identities,
            expectedGeneratedPresentationIdentitiesComplete: expected.complete,
          } : {}),
          idleCanvas,
          matchedRendering: await captureEditorPresentationMatch({ args, artifactSession, page, topology, waitTimeoutMs }),
        }
      }
    }

    if (capture.has("editor-state")) {
      editorState = await captureEditorState(page, target)
      await artifactSession.writeJson("editorState", "editor-state.json", editorState)
    }
    if (capture.has("editor-validity")) {
      editorValidity = await captureEditorValidity(page, target)
      await artifactSession.writeJson("editorValidity", "editor-validity.json", editorValidity)
    }
    if (capture.has("html")) {
      const html = await page.content()
      await artifactSession.writeText("html", "editor-snapshot.html", html)
      htmlSha256 = sha256(Buffer.from(html, "utf8"))
    }
    if (capture.has("screenshot")) {
      await dismissWordPressOnboardingDialogs(page)
      await artifactSession.writeGenerated("screenshot", "editor-screenshot.png", async (path) => {
        if (editorCanvasReadiness?.ready && target.waitSelector) {
          const frame = await resolveEditorCanvasFrame(page, target.waitSelector)
          if (frame) {
            await frame.locator(EDITOR_CANVAS_DEFAULT_LAYOUT_SELECTOR).first().screenshot({ path, timeout: waitTimeoutMs })
            return
          }
        }
        await page.screenshot({ path, fullPage: true })
      })
      screenshotSha256 = await fileSha256(screenshotPath)
    }
  } catch (error) {
    pendingError = error instanceof Error ? error : new Error(String(error))
    errors.push(serializeBrowserError("probe-error", error))
  } finally {
    for (const routeError of await closeBrowserAndDrainPreviewRoutes(browser, routeTracker)) {
      errors.push(serializeBrowserError("probe-error", routeError))
      if (browserPreviewCleanupErrorIsFatal(routeError)) pendingError ??= routeError
    }
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
        ...editorOpenArtifactFilesForCapture(capture, artifactPathPrefix),
        ...(editorPresentation?.matchedRendering?.frontendScreenshot && editorPresentation.matchedRendering.editorScreenshot && editorPresentation.matchedRendering.diffScreenshot
          ? { screenshots: [editorPresentation.matchedRendering.frontendScreenshot, editorPresentation.matchedRendering.editorScreenshot, editorPresentation.matchedRendering.diffScreenshot] }
          : {}),
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
        ...(editorValidity ? { editorValidity: editorValidity.summary } : {}),
        ...(editorReadiness ? { editorReadiness } : {}),
        ...(editorPresentation ? { editorPresentation } : {}),
        ...(editorCanvasReadiness ? { editorCanvas: editorCanvasReadiness } : {}),
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
    throw editorOpenArtifactError(stepRecords.length, pendingError, artifact)
  }

  return browserCommandResult(artifact, {
      command: "wordpress.editor-open",
      target,
      requestedUrl: targetUrl,
      preview,
      ...(server.previewProxyDiagnostics ? { previewProxy: server.previewProxyDiagnostics } : {}),
      finalUrl: artifact.summary.finalUrl ?? finalUrl,
      files: artifact.files,
      summary: artifact.summary,
      steps: stepRecords,
  })
}

export function editorOpenArtifactPathPrefixFromArgs(args: string[]): string {
  const rawPrefix = argValue(args, "artifact-prefix")?.trim()
  if (!rawPrefix) {
    return "files/browser"
  }

  const prefix = rawPrefix.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "")
  if (!prefix || prefix.startsWith("/") || prefix.split("/").includes("..")) {
    throw new Error(`wordpress.editor-open artifact-prefix must be a relative artifact directory without traversal: ${rawPrefix}`)
  }
  return prefix
}

export function editorOpenArtifactFilesForCapture(capture: ReadonlySet<string>, artifactPathPrefix = "files/browser"): BrowserArtifactFiles & { summary: string } {
  return {
    ...(capture.has("steps") ? { steps: `${artifactPathPrefix}/editor-steps.jsonl` } : {}),
    ...(capture.has("console") ? { console: `${artifactPathPrefix}/editor-console.jsonl` } : {}),
    ...(capture.has("editor-state") ? { editorState: `${artifactPathPrefix}/editor-state.json` } : {}),
    ...(capture.has("editor-validity") ? { editorValidity: `${artifactPathPrefix}/editor-validity.json` } : {}),
    ...(capture.has("errors") ? { errors: `${artifactPathPrefix}/editor-errors.jsonl` } : {}),
    ...(capture.has("html") ? { html: `${artifactPathPrefix}/editor-snapshot.html` } : {}),
    ...(capture.has("screenshot") ? { screenshot: `${artifactPathPrefix}/editor-screenshot.png` } : {}),
    summary: `${artifactPathPrefix}/editor-summary.json`,
  }
}

export async function waitForEditorOpenReadiness(page: import("playwright").Page, waitSelector: string | undefined, timeoutMs: number): Promise<{ editorReadiness: BrowserEditorReadinessSummary; editorCanvasReadiness?: BrowserEditorCanvasProbeSummary }> {
  const editorReadiness = await waitForEditorSemanticReadiness(page, timeoutMs)
  if (!waitSelector) {
    return { editorReadiness }
  }

  await waitForAnyVisibleSelector(page, waitSelector, timeoutMs)
  if (!waitSelector.includes("editor-canvas")) {
    return { editorReadiness }
  }

  const probe = await waitForEditorCanvasProbe(page, {
    blockSelector: EDITOR_CANVAS_DEFAULT_BLOCK_SELECTOR,
    iframeSelector: waitSelector,
    layoutSelector: EDITOR_CANVAS_DEFAULT_LAYOUT_SELECTOR,
    selectorGroups: editorCanvasSelectorGroups([], EDITOR_CANVAS_DEFAULT_LAYOUT_SELECTOR, EDITOR_CANVAS_DEFAULT_BLOCK_SELECTOR),
    startedAtMs: Date.now(),
    timeoutMs,
  })
  if (!probe.summary.ready) {
    throw new Error(`Editor canvas was not ready: ${probe.summary.diagnostics.map((diagnostic) => diagnostic.code).join(", ") || "not-ready"}`)
  }

  return { editorReadiness, editorCanvasReadiness: probe.summary }
}

interface EditorPresentationCapture {
  canvasDocumentType: "iframe" | "parent"
  iframeCount: number
  stylesheetUrls: string[]
  inlineStyleContents: string[]
}

export function summarizeEditorPresentation(capture: EditorPresentationCapture): BrowserEditorPresentationSummary {
  const iframeStylesheetUrls = [...new Set(capture.stylesheetUrls.map((url) => url.trim()).filter(Boolean))].sort()
  const generatedPresentationIdentities = [...new Set(
    capture.inlineStyleContents.flatMap((content) => [...content.matchAll(/blocks-engine-presentation:([a-f0-9]{64})/gi)].map((match) => match[1]!.toLowerCase())),
  )].sort()
  return {
    schema: "wp-codebox/editor-presentation/v1",
    canvasDocumentType: capture.canvasDocumentType,
    iframeCount: capture.iframeCount,
    iframeStylesheetUrlCount: iframeStylesheetUrls.length,
    iframeStylesheetUrls,
    generatedPresentationIdentityCount: generatedPresentationIdentities.length,
    generatedPresentationIdentities,
  }
}

export async function captureEditorPresentation(page: import("playwright").Page, timeoutMs: number): Promise<BrowserEditorPresentationSummary | undefined> {
  const startedAtMs = Date.now()
  const deadlineMs = startedAtMs + Math.min(timeoutMs, EDITOR_PRESENTATION_MAX_CAPTURE_MS)
  let previousFingerprint: string | undefined
  let stableSinceMs: number | undefined
  let sawCanvas = false

  while (Date.now() <= deadlineMs) {
    const frame = await resolveEditorCanvasFrame(page, EDITOR_CANVAS_DEFAULT_IFRAME_SELECTOR)
    let canvas: import("playwright").Page | import("playwright").Frame | undefined = frame ?? undefined
    let canvasDocumentType: "iframe" | "parent" = "iframe"
    if (!frame) {
      const hasParentDocumentCanvas = await page.locator(EDITOR_CANVAS_DEFAULT_LAYOUT_SELECTOR).first().isVisible().catch(() => false)
      if (sawCanvas || !hasParentDocumentCanvas || Date.now() - startedAtMs < EDITOR_PRESENTATION_IFRAME_DISCOVERY_MS) {
        previousFingerprint = undefined
        stableSinceMs = undefined
        await page.waitForTimeout(EDITOR_PRESENTATION_POLL_MS)
        continue
      }
      canvas = page
      canvasDocumentType = "parent"
    }

    if (!canvas) continue
    if (frame) sawCanvas = true
    const capture = await canvas.evaluate(({ canvasDocumentType, iframeCount }) => {
      if (document.readyState !== "complete" || document.fonts?.status === "loading") return null
      const stylesheets = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"]'))
      if (stylesheets.some((stylesheet) => !stylesheet.disabled && !stylesheet.sheet)) return null
      return {
        documentIdentity: `${location.href}\n${performance.timeOrigin}`,
        documentAgeMs: performance.now(),
        canvasDocumentType,
        iframeCount,
        stylesheetUrls: stylesheets.flatMap((stylesheet) => stylesheet.href ? [stylesheet.href] : []),
        inlineStyleContents: Array.from(document.querySelectorAll("style"), (style) => style.textContent ?? ""),
      }
    }, { canvasDocumentType, iframeCount: canvasDocumentType === "iframe" ? 1 : 0 }).catch(() => null) as (EditorPresentationCapture & { documentIdentity: string; documentAgeMs: number }) | null
    if (capture) {
      const summary = summarizeEditorPresentation(capture)
      const fingerprint = `${capture.documentIdentity}\n${JSON.stringify(summary)}`
      const observedAtMs = Date.now()
      if (fingerprint === previousFingerprint) {
        const currentDocumentIdentity = capture.canvasDocumentType === "iframe"
          ? await resolveEditorCanvasFrame(page, EDITOR_CANVAS_DEFAULT_IFRAME_SELECTOR)
              .then(async (currentFrame) => currentFrame && currentFrame === frame ? await currentFrame.evaluate(() => `${location.href}\n${performance.timeOrigin}`) : undefined)
              .catch(() => undefined)
          : await resolveEditorCanvasFrame(page, EDITOR_CANVAS_DEFAULT_IFRAME_SELECTOR)
              .then(async (currentFrame) => currentFrame ? undefined : await page.evaluate(() => `${location.href}\n${performance.timeOrigin}`))
              .catch(() => undefined)
        if (stableSinceMs !== undefined
          && observedAtMs - stableSinceMs >= EDITOR_PRESENTATION_SETTLE_MS
          && capture.documentAgeMs >= EDITOR_PRESENTATION_MIN_OBSERVATION_MS
          && currentDocumentIdentity === capture.documentIdentity) {
          return summary
        }
      } else {
        previousFingerprint = fingerprint
        stableSinceMs = observedAtMs
      }
    }
    await page.waitForTimeout(EDITOR_PRESENTATION_POLL_MS)
  }

  return undefined
}

// Ask WordPress for the same filtered editor settings used to construct the
// canvas. This is independent of the rendered iframe, so a missing style is
// observable rather than certified from the observed set itself.
async function captureExpectedEditorPresentationIdentities(
  target: EditorOpenTarget,
  runPlaygroundCommand: (command: string, server: PlaygroundCliServer, options: { code: string } | { scriptPath: string }) => Promise<PlaygroundRunResponse>,
  runtimeSpec: RuntimeCreateSpec,
  server: PlaygroundCliServer,
): Promise<{ identities: string[]; complete: boolean } | undefined> {
  if (target.kind !== "post" || !target.postId) return undefined
  const response = await runPlaygroundCommand("wordpress.editor-open.capture-presentation-contract", server, {
    code: bootstrapPhpCode(runtimeSpec, `
$post = get_post(${target.postId});
if ( ! $post instanceof WP_Post ) { throw new RuntimeException( 'Editor target post is unavailable.' ); }
$settings = get_block_editor_settings( array(), new WP_Block_Editor_Context( array( 'post' => $post ) ) );
$identities = array();
foreach ( (array) ( $settings['styles'] ?? array() ) as $style ) {
  if ( ! is_array( $style ) || ! is_string( $style['css'] ?? null ) ) { continue; }
  if ( preg_match_all( '/--blocks-engine-presentation:([a-f0-9]{64})/i', $style['css'], $matches ) ) {
    foreach ( $matches[1] as $identity ) { $identities[] = strtolower( $identity ); }
  }
}
$identities = array_values( array_unique( $identities ) );
sort( $identities, SORT_STRING );
echo wp_json_encode( array( 'identities' => $identities, 'complete' => true ) );
`, []),
  })
  assertPlaygroundResponseOk("wordpress.editor-open.capture-presentation-contract", response)
  const value = JSON.parse(cleanWpCliOutput(response.text)) as { identities?: unknown; complete?: unknown }
  if (!Array.isArray(value.identities) || value.complete !== true || !value.identities.every((identity) => typeof identity === "string" && /^[a-f0-9]{64}$/.test(identity))) {
    throw new Error("wordpress.editor-open presentation contract returned an invalid identity set")
  }
  return { identities: [...new Set(value.identities)].sort(), complete: true }
}

export async function captureEditorIdleCanvas(page: import("playwright").Page): Promise<BrowserEditorIdleCanvasSummary> {
  const onboardingModalCount = await page.evaluate(() => {
    const selectors = [".components-guide", ".welcome-panel", ".components-modal__frame"]
    const elements = new Set(selectors.flatMap((selector) => Array.from(document.querySelectorAll<HTMLElement>(selector))))
    return Array.from(elements).filter((element) => {
      const style = getComputedStyle(element)
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0
    }).length
  }).catch(() => undefined)
  return onboardingModalCount === undefined
    ? { schema: "wp-codebox/editor-idle-canvas/v1", status: "unavailable" }
    : { schema: "wp-codebox/editor-idle-canvas/v1", status: "captured", onboardingModalCount }
}

async function captureEditorPresentationMatch(input: {
  args: string[]
  artifactSession: BrowserArtifactSession
  page: import("playwright").Page
  topology: ReturnType<typeof editorCommandPreviewTopology>
  waitTimeoutMs: number
}): Promise<NonNullable<BrowserEditorPresentationSummary["matchedRendering"]>> {
  const presentationUrl = argValue(input.args, "presentation-url")?.trim()
  if (!presentationUrl) return { schema: "wp-codebox/editor-presentation-match/v1", status: "unavailable", diagnostic: "presentation-url was not supplied" }
  const frontendSelector = boundedPresentationSelector(input.args, "presentation-frontend-selector", "body")
  const editorSelector = boundedPresentationSelector(input.args, "presentation-editor-selector", EDITOR_CANVAS_DEFAULT_LAYOUT_SELECTOR)
  const threshold = presentationThreshold(input.args)
  const frontendPath = input.artifactSession.absolutePath("presentation-frontend.png")
  const editorPath = input.artifactSession.absolutePath("presentation-editor.png")
  const frontendRef = input.artifactSession.path("presentation-frontend.png")
  const editorRef = input.artifactSession.path("presentation-editor.png")
  const diffRef = input.artifactSession.path("presentation-diff.png")
  try {
    const frame = await resolveEditorCanvasFrame(input.page, EDITOR_CANVAS_DEFAULT_IFRAME_SELECTOR)
    const canvas = frame ?? input.page
    const editor = canvas.locator(editorSelector).first()
    const editorBox = await editor.boundingBox()
    if (!editorBox || editorBox.width <= 0 || editorBox.height <= 0) return { schema: "wp-codebox/editor-presentation-match/v1", status: "unavailable", diagnostic: "editor presentation surface has no visible bounds" }
    const browser = input.page.context().browser()
    if (!browser) return { schema: "wp-codebox/editor-presentation-match/v1", status: "unavailable", diagnostic: "browser context is not available for frontend capture" }
    const frontendContext = await browser.newContext({
      ...input.topology.contextOptions(),
      viewport: { width: Math.round(editorBox.width), height: Math.max(1, Math.round(editorBox.height)) },
    })
    const frontend = await frontendContext.newPage()
    try {
      await frontend.goto(input.topology.resolveUrl(presentationUrl), { waitUntil: "networkidle", timeout: input.waitTimeoutMs })
      const source = frontend.locator(frontendSelector).first()
      if (!await source.isVisible()) return { schema: "wp-codebox/editor-presentation-match/v1", status: "unavailable", diagnostic: `frontend presentation selector is not visible: ${frontendSelector}` }
      const [frontendEvidence, editorEvidence] = await Promise.all([presentationSurfaceEvidence(frontend, frontendSelector), presentationSurfaceEvidence(canvas, editorSelector)])
      await input.artifactSession.writeGenerated("screenshot", "presentation-frontend.png", async (path) => { await source.screenshot({ path, timeout: input.waitTimeoutMs }); })
      await input.artifactSession.writeGenerated("screenshot", "presentation-editor.png", async (path) => { await editor.screenshot({ path, timeout: input.waitTimeoutMs }); })
      let comparison: Awaited<ReturnType<typeof comparePngFiles>> | undefined
      await input.artifactSession.writeGenerated("screenshot", "presentation-diff.png", async (path) => {
        comparison = await comparePngFiles(frontendPath, editorPath, path, { threshold, includeAA: false, maxRegions: 8 })
      })
      if (!comparison) throw new Error("Presentation comparison did not produce metrics")
      const equivalentCanvasWidths = comparison.source.width === comparison.candidate.width
      // The same bounded threshold applies to canvas extent and the shared
      // visual region; equal widths alone must not certify different renders.
      const majorGeometryDrift = comparison.dimensionDeltaRatio > threshold || comparison.overlapMismatchRatio > threshold
      const unreadableContent = !frontendEvidence.readable || !editorEvidence.readable
      const hiddenContent = !frontendEvidence.visible || !editorEvidence.visible
      const unresolvedAssetCount = frontendEvidence.unresolvedAssets + editorEvidence.unresolvedAssets
      const passed = equivalentCanvasWidths && !majorGeometryDrift && !unreadableContent && !hiddenContent && unresolvedAssetCount === 0
      return { schema: "wp-codebox/editor-presentation-match/v1", status: passed ? "passed" : "failed", equivalentCanvasWidths, majorGeometryDrift, unreadableContent, hiddenContent, unresolvedAssetCount, frontendScreenshot: frontendRef, editorScreenshot: editorRef, diffScreenshot: diffRef }
    } finally { await frontendContext.close() }
  } catch (error) {
    return { schema: "wp-codebox/editor-presentation-match/v1", status: "unavailable", diagnostic: error instanceof Error ? error.message : String(error) }
  }
}

function boundedPresentationSelector(args: string[], name: string, fallback: string): string {
  const selector = argValue(args, name)?.trim() || fallback
  if (selector.length > 512) throw new Error(`wordpress.editor-open ${name} must be at most 512 characters`)
  return selector
}

function presentationThreshold(args: string[]): number {
  const raw = argValue(args, "presentation-threshold")?.trim()
  if (!raw) return 0.02
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`wordpress.editor-open presentation-threshold must be between 0 and 1: ${raw}`)
  return value
}

async function presentationSurfaceEvidence(surface: import("playwright").Page | import("playwright").Frame, selector: string): Promise<{ visible: boolean; readable: boolean; unresolvedAssets: number }> {
  return surface.evaluate((selector) => {
    const element = document.querySelector<HTMLElement>(selector)
    if (!element) return { visible: false, readable: false, unresolvedAssets: 0 }
    const style = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    const visible = style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0 && rect.width > 0 && rect.height > 0
    const readable = visible && (element.innerText || "").trim().length > 0
    const unresolvedAssets = Array.from(element.querySelectorAll<HTMLImageElement>("img")).filter((image) => image.src && (!image.complete || image.naturalWidth === 0)).length
      + Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"]')).filter((link) => !link.disabled && !link.sheet).length
    return { visible, readable, unresolvedAssets }
  }, selector)
}

export async function dismissWordPressOnboardingDialogs(page: import("playwright").Page): Promise<void> {
  // Gutenberg can mount the guide shortly after the editor first reports ready.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.evaluate(() => {
      const selectors = [
        ".components-guide__finish-button",
        ".components-guide__close",
        '.components-guide button[aria-label^="Close"]',
        '.components-guide .components-button[aria-label="Close"]',
        '.components-guide .components-button[aria-label="Dismiss"]',
        '.components-modal__header .components-button[aria-label="Close"]',
        '.components-modal__header .components-button[aria-label="Dismiss"]',
        '.components-modal__header button',
        ".welcome-panel-close",
      ]
      const dismissed = new Set<Element>()
      for (const selector of selectors) {
        for (const control of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
          if (!dismissed.has(control) && !control.hasAttribute("disabled")) {
            dismissed.add(control)
            control.click()
          }
        }
      }
    })
    await page.waitForTimeout(150)
  }
}

export function editorOpenArtifactError(stepCount: number, error: Error, artifact: BrowserArtifact): BrowserCommandArtifactError {
  return new BrowserCommandArtifactError(`wordpress.editor-open failed after ${stepCount} step(s): ${error.message}`, artifact)
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
  const target = await resolveEditorOpenTarget(editorOpenTargetFromArgs(args), {
    command: "wordpress.editor-actions",
    runPlaygroundCommand,
    runtimeSpec,
    server,
  })
  const actionSteps = await editorActionStepsFromArgs(args)
  const editorWaitSelector = target.waitSelector ?? DEFAULT_EDITOR_WAIT_SELECTOR
  const capture = new Set(commaListArg(args, "capture"))
  if (capture.size === 0) {
    capture.add("steps")
    capture.add("console")
    capture.add("errors")
    capture.add("html")
    capture.add("screenshot")
    capture.add("editor-state")
    capture.add("editor-validity")
  }
  for (const item of capture) {
    if (!["steps", "console", "errors", "html", "screenshot", "editor-state", "editor-validity"].includes(item)) {
      throw new Error(`wordpress.editor-actions capture supports steps, console, errors, html, screenshot, editor-state, editor-validity: ${item}`)
    }
  }

  const waitTimeoutMs = durationArg(args, "wait-timeout", BROWSER_STEP_DEFAULT_TIMEOUT_MS)
  const stepTimeoutMs = durationArg(args, "step-timeout", BROWSER_STEP_DEFAULT_TIMEOUT_MS)
  const totalTimeoutMs = durationArg(args, "timeout", BROWSER_SCRIPT_DEFAULT_TIMEOUT_MS)
  const topology = editorCommandPreviewTopology(args, runtimeSpec, server)
  const { preview, networkPolicy } = topology
  const routeTracker = createBrowserPreviewRouteTracker()
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
  let editorValidity: EditorValidityArtifact | undefined
  let editorReadiness: BrowserEditorReadinessSummary | undefined
  let editorSave: BrowserEditorSaveSummary | undefined
  let authSummary: BrowserProbeAuthSummary | undefined
  let pendingError: Error | undefined
  let artifact: BrowserArtifact | undefined

  try {
    const previewReadinessError = browserPreviewReadinessError(preview)
    if (previewReadinessError) {
      throw previewReadinessError
    }
    const context = browserPreviewNeedsContextRouting(networkPolicy) ? await browser.newContext(topology.contextOptions()) : null
    if (context) {
      await routeBrowserPreviewContextNetwork(context, networkPolicy, topology.origins.localProxyOrigin, routeTracker)
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
        await waitForAnyVisibleSelector(page, editorWaitSelector, waitTimeoutMs)
        finalUrl = page.url()
        stepRecords.push(browserStepRecord(1, { kind: "waitFor", selector: editorWaitSelector }, "ok", waitStartedAt, waitStartedAtMs, finalUrl, {}))
      } catch (error) {
        const serialized = serializeBrowserError("probe-error", error)
        errors.push(serialized)
        stepRecords.push(browserStepRecord(1, { kind: "waitFor", selector: editorWaitSelector }, "failed", waitStartedAt, waitStartedAtMs, page.url(), { error: serialized }))
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
      const before = await captureEditorState(page, target)
      let after: EditorStateSnapshot | undefined
      try {
        const result = await executeEditorActionStep(page, step, stepTimeoutMs, targetUrl, before)
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
        after = await captureEditorState(page, target)
        assertEditorMutationPostcondition(step, before, after)
        editorState = after
        stepRecords.push(browserStepRecord(index + 2, { kind: step.kind } as never, "ok", actionStartedAt, actionStartedAtMs, finalUrl, {
          ...(result?.readiness ? { editorReadiness: result.readiness } : {}),
          ...(result?.save ? { editorSave: result.save } : {}),
          ...(editorActionMutatesState(step) ? { editorMutation: { status: "applied", before: summarizeEditorStateForStep(before), after: summarizeEditorStateForStep(after) } } : {}),
        } as never))
      } catch (error) {
        const serialized = serializeBrowserError("probe-error", error)
        errors.push(serialized)
        after ??= await captureEditorState(page, target).catch(() => undefined)
        const noOp = serialized.message.startsWith("wp-codebox-editor-mutation-noop:")
        stepRecords.push(browserStepRecord(index + 2, { kind: step.kind } as never, "failed", actionStartedAt, actionStartedAtMs, page.url(), {
          error: serialized,
          ...(editorActionMutatesState(step) ? { editorMutation: { status: noOp ? "no-op" : "failed", before: summarizeEditorStateForStep(before), ...(after ? { after: summarizeEditorStateForStep(after) } : {}), failure: serialized.message } } : {}),
        }))
        pendingError = error instanceof Error ? error : new Error(String(error))
      }
    }

    if (capture.has("editor-state")) {
      editorState = await captureEditorState(page, target)
      await artifactSession.writeJson("editorState", "editor-action-state.json", editorState)
    }
    if (capture.has("editor-validity")) {
      editorValidity = await captureEditorValidity(page, target)
      await artifactSession.writeJson("editorValidity", "editor-action-validity.json", editorValidity)
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
  } catch (error) {
    pendingError = error instanceof Error ? error : new Error(String(error))
    errors.push(serializeBrowserError("probe-error", error))
  } finally {
    for (const routeError of await closeBrowserAndDrainPreviewRoutes(browser, routeTracker)) {
      errors.push(serializeBrowserError("probe-error", routeError))
      if (browserPreviewCleanupErrorIsFatal(routeError)) pendingError ??= routeError
    }
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
        ...(capture.has("editor-validity") ? { editorValidity: "files/browser/editor-action-validity.json" } : {}),
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
        ...(editorValidity ? { editorValidity: editorValidity.summary } : {}),
        ...(editorReadiness ? { editorReadiness } : {}),
        ...(editorSave ? { editorSave } : {}),
        editorCapabilities: { clipboard: "unsupported" },
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

  return browserCommandResult(artifact, {
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
  })
}

interface EditorActionStepResult {
  state?: Omit<EditorStateSnapshot, "schema" | "capturedAt" | "target">
  readiness?: BrowserEditorReadinessSummary
  save?: BrowserEditorSaveSummary
}

export async function executeEditorActionStep(page: import("playwright").Page, step: EditorActionStep, timeoutMs: number, targetUrl: string, beforeState?: EditorStateSnapshot): Promise<EditorActionStepResult | undefined> {
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
      try {
        await page.waitForFunction((count) => {
          const select = (window as unknown as { wp?: { data?: { select?: (store: string) => Record<string, unknown> } } }).wp?.data?.select
          const blockEditor = typeof select === "function" ? select("core/block-editor") : undefined
          const blocks = typeof blockEditor?.getBlocks === "function" ? blockEditor.getBlocks() as unknown[] : []
          return blocks.length > count
        }, beforeCount, { timeout: stepTimeoutMs(step, timeoutMs) })
      } catch (error) {
        if (beforeState) {
          try {
            const afterState = await captureEditorState(page, beforeState.target)
            if (!beforeState.storesAvailable || !afterState.storesAvailable) {
              throw error
            }
            assertEditorMutationPostcondition(step, beforeState, afterState)
          } catch (postconditionError) {
            if (postconditionError instanceof Error && postconditionError.message.startsWith("wp-codebox-editor-mutation-noop:")) {
              throw postconditionError
            }
          }
        }
        throw error
      }
      return undefined
    }
    case "selectBlock": {
      await executeEditorBlockMutation(page, step)
      return undefined
    }
    case "updateBlockAttributes":
    case "removeBlock":
    case "moveBlock":
    case "duplicateBlock":
    case "replaceBlock":
    case "replaceInnerBlocks":
      await executeEditorBlockMutation(page, step)
      return undefined
    case "undo":
    case "redo":
      await page.evaluate((kind) => {
        const action = (window as unknown as { wp?: { data?: { dispatch?: (store: string) => Record<string, unknown> } } }).wp?.data?.dispatch?.("core/editor")?.[kind]
        if (typeof action !== "function") throw new Error(`wp-codebox-editor-${kind}-unsupported: core/editor.${kind} is unavailable`)
        action()
      }, step.kind)
      return undefined
    case "reload":
      await page.reload({ waitUntil: "domcontentloaded", timeout: stepTimeoutMs(step, timeoutMs) })
      return { readiness: await waitForEditorReadiness(page, stepTimeoutMs(step, timeoutMs)) }
    case "reopen":
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: stepTimeoutMs(step, timeoutMs) })
      return { readiness: await waitForEditorReadiness(page, stepTimeoutMs(step, timeoutMs)) }
    case "inspectState":
      return { state: await page.evaluate(() => {
        const wpData = (window as unknown as { wp?: { data?: { select?: (store: string) => Record<string, unknown> } } }).wp?.data
        const select = wpData?.select
        if (typeof select !== "function") {
          return { storesAvailable: false }
        }
        const editor = select("core/editor")
        const blockEditor = select("core/block-editor")
        if (!editor || !blockEditor) {
          return { storesAvailable: false }
        }
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

async function executeEditorBlockMutation(page: import("playwright").Page, step: Extract<EditorActionStep, { clientId?: string; index?: number; path?: number[] }>): Promise<void> {
  await page.evaluate((input) => {
    type Block = { clientId?: string; innerBlocks?: Block[] }
    const wp = (window as unknown as { wp?: { blocks?: { createBlock?: (name: string, attributes?: Record<string, unknown>, innerBlocks?: unknown[]) => unknown }; data?: { select?: (store: string) => Record<string, unknown>; dispatch?: (store: string) => Record<string, unknown> } } }).wp
    const select = wp?.data?.select
    const dispatch = wp?.data?.dispatch
    const store = typeof select === "function" ? select("core/block-editor") : undefined
    const actions = typeof dispatch === "function" ? dispatch("core/block-editor") : undefined
    if (!store || !actions || typeof store.getBlocks !== "function") throw new Error("wp-codebox-editor-block-store-unavailable: core/block-editor APIs are unavailable")
    const blocks = store.getBlocks() as Block[]
    let parentClientId: string | undefined
    let siblings = blocks
    let block: Block | undefined
    if (typeof input.clientId === "string") {
      const pending: Array<{ items: Block[]; parent?: string }> = [{ items: blocks }]
      while (!block && pending.length > 0) {
        const current = pending.pop()!
        for (const item of current.items) {
          if (item.clientId === input.clientId) { block = item; parentClientId = current.parent; siblings = current.items; break }
          if (item.innerBlocks?.length) pending.push({ items: item.innerBlocks, parent: item.clientId })
        }
      }
    } else {
      const path = input.path ?? [input.index ?? -1]
      for (const position of path) {
        block = siblings[position]
        if (!block) break
        parentClientId = siblings === blocks ? undefined : parentClientId
        siblings = block.innerBlocks ?? []
      }
      if (input.path && input.path.length > 1) {
        let items = blocks
        for (const position of input.path.slice(0, -1)) { const parent = items[position]; parentClientId = parent?.clientId; items = parent?.innerBlocks ?? [] }
        siblings = items
        block = items[input.path[input.path.length - 1]]
      }
    }
    if (!block?.clientId) throw new Error("wp-codebox-editor-target-not-found: clientId, index, or path did not resolve a block")
    let actionName: string = input.kind
    let actionArgs: unknown[] = [block.clientId]
    if (input.kind === "updateBlockAttributes") actionArgs.push(input.attributes)
    if (input.kind === "removeBlock") { actionName = "removeBlocks"; actionArgs = [[block.clientId]] }
    if (input.kind === "duplicateBlock") { actionName = "duplicateBlocks"; actionArgs = [[block.clientId]] }
    if (input.kind === "moveBlock") { actionName = "moveBlocksToPosition"; actionArgs = [[block.clientId], parentClientId, parentClientId, input.position] }
    if (input.kind === "replaceBlock" || input.kind === "replaceInnerBlocks") {
      const createBlock = wp?.blocks?.createBlock
      if (typeof createBlock !== "function") throw new Error("wp-codebox-editor-create-block-unsupported: wp.blocks.createBlock is unavailable")
      const specs = input.kind === "replaceBlock" ? [input.block] : input.blocks
      const created = new Map<object, unknown>()
      const pending = specs.map((spec) => ({ spec, visited: false }))
      while (pending.length > 0) {
        const current = pending.pop()!
        if (!current.visited) {
          pending.push({ spec: current.spec, visited: true })
          for (const child of current.spec.innerBlocks ?? []) pending.push({ spec: child, visited: false })
          continue
        }
        created.set(current.spec, createBlock(current.spec.name, current.spec.attributes ?? {}, (current.spec.innerBlocks ?? []).map((child) => created.get(child))))
      }
      actionName = input.kind
      actionArgs = input.kind === "replaceBlock" ? [block.clientId, created.get(input.block)] : [block.clientId, input.blocks.map((spec) => created.get(spec))]
    }
    const action = actions[actionName]
    if (typeof action !== "function") throw new Error(`wp-codebox-editor-${input.kind}-unsupported: core/block-editor.${actionName} is unavailable`)
    action(...actionArgs)
  }, step)
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
    if (!editor || !blockEditor || !editorDispatch || typeof editorDispatch.savePost !== "function") {
      return false
    }
    return {
      schema: "wp-codebox/editor-readiness/v1",
      status: "ready",
      storesAvailable: true,
      canSave: true,
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

// Opening and validating an editor require the block-editor data store. Global
// block APIs and save availability are stricter, separate capabilities.
async function waitForEditorSemanticReadiness(page: import("playwright").Page, timeoutMs: number): Promise<BrowserEditorReadinessSummary> {
  return page.waitForFunction(() => {
    const win = window as unknown as {
      wp?: {
        blocks?: { parse?: unknown; getBlockTypes?: () => unknown[] }
        data?: { select?: (store: string) => Record<string, unknown>; dispatch?: (store: string) => Record<string, unknown> }
      }
    }
    const select = win.wp?.data?.select
    if (typeof select !== "function") {
      return false
    }

    const blockEditor = select("core/block-editor")
    if (!blockEditor || typeof blockEditor.getBlocks !== "function") {
      return false
    }

    const wpBlocks = win.wp?.blocks
    const blockTypes = typeof wpBlocks?.getBlockTypes === "function" ? wpBlocks.getBlockTypes() : undefined
    const dispatch = win.wp?.data?.dispatch
    const editor = select("core/editor")
    const editorDispatch = typeof dispatch === "function" ? dispatch("core/editor") : undefined
    return {
      schema: "wp-codebox/editor-readiness/v1",
      status: "ready",
      storesAvailable: Boolean(editor && blockEditor),
      canSave: typeof editorDispatch?.savePost === "function",
      ...(Array.isArray(blockTypes) ? { blockTypesRegistered: blockTypes.length } : {}),
      postId: typeof editor?.getCurrentPostId === "function" ? editor.getCurrentPostId() : undefined,
      postType: typeof editor?.getCurrentPostType === "function" ? editor.getCurrentPostType() : undefined,
    }
  }, undefined, { timeout: timeoutMs }).then(async (handle) => {
    const readiness = await handle.jsonValue() as BrowserEditorReadinessSummary | false
    if (!readiness) {
      throw new Error("wp-codebox-editor-readiness-timeout: Gutenberg block runtime did not become available")
    }
    return readiness
  })
}

async function saveEditorPost(page: import("playwright").Page, step: Extract<EditorActionStep, { kind: "savePost" }>, timeoutMs: number): Promise<BrowserEditorSaveSummary> {
  await page.evaluate(async (input) => {
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
    if (!editor) {
      throw new Error("wp-codebox-editor-readiness-unavailable: core/editor store is unavailable")
    }
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
  }, { marker: step.marker, content: step.content })
  const settled = await page.waitForFunction(() => {
    const editor = (window as unknown as { wp?: { data?: { select?: (store: string) => Record<string, unknown> } } }).wp?.data?.select?.("core/editor")
    if (!editor) return false
    const saving = typeof editor.isSavingPost === "function" ? Boolean(editor.isSavingPost()) : false
    const failed = typeof editor.didPostSaveRequestFail === "function" ? Boolean(editor.didPostSaveRequestFail()) : false
    const succeeded = typeof editor.didPostSaveRequestSucceed === "function" ? Boolean(editor.didPostSaveRequestSucceed()) : undefined
    return !saving && (failed || succeeded !== false) ? { failed } : false
  }, undefined, { timeout: timeoutMs }).then((handle) => handle.jsonValue() as Promise<{ failed: boolean }>)
  if (settled.failed) throw new Error("wp-codebox-editor-save-failed: core/editor savePost reported a failed request")
  const save = await page.evaluate((input) => {
    const editor = (window as unknown as { wp?: { data?: { select?: (store: string) => Record<string, unknown> } } }).wp?.data?.select?.("core/editor")
    if (!editor) throw new Error("wp-codebox-editor-readiness-unavailable: core/editor store is unavailable")
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
  }, { marker: step.marker })

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

export interface EditorStateSnapshot {
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
    isValid?: boolean
    innerBlocks?: EditorStateSnapshot["blocks"]
  }>
  serializedContent?: string
  serializedContentSha256?: string
  dirty?: boolean
  saving?: boolean
  savedContent?: string
  savedContentSha256?: string
}

interface EditorValidityWarning {
  source: "dom" | "block-editor-store"
  selector?: string
  path?: string
  message: string
  blockName?: string
  clientId?: string
}

interface EditorValidityArtifact {
  schema: "wp-codebox/editor-validity/v1"
  capturedAt: string
  target: ReturnType<typeof editorOpenTargetFromArgs>
  selectors: string[]
  warnings: EditorValidityWarning[]
  summary: BrowserEditorValiditySummary
}

export async function captureEditorState(page: import("playwright").Page, target: ReturnType<typeof editorOpenTargetFromArgs>): Promise<EditorStateSnapshot> {
  const state = await page.evaluate(() => {
    const wpData = (window as unknown as { wp?: { data?: { select?: (store: string) => Record<string, unknown> } } }).wp?.data
    const select = wpData?.select
    if (typeof select !== "function") {
      return { storesAvailable: false }
    }
    const editor = select("core/editor")
    const blockEditor = select("core/block-editor")
    if (!editor || !blockEditor) {
      return { storesAvailable: false }
    }
    const currentPost = typeof editor.getCurrentPost === "function" ? editor.getCurrentPost() as Record<string, unknown> | null : null
    const blocks = typeof blockEditor.getBlocks === "function" ? blockEditor.getBlocks() as Array<Record<string, unknown>> : []
    const serialize = (window as unknown as { wp?: { blocks?: { serialize?: (items: unknown[]) => string } } }).wp?.blocks?.serialize
    const tree: NonNullable<EditorStateSnapshot["blocks"]> = []
    const pending: Array<{ items: Array<Record<string, unknown>>; output: NonNullable<EditorStateSnapshot["blocks"]> }> = [{ items: blocks, output: tree }]
    while (pending.length > 0) {
      const current = pending.pop()!
      for (const block of current.items) {
        const innerBlocks: NonNullable<EditorStateSnapshot["blocks"]> = []
        current.output.push({
          name: typeof block.name === "string" ? block.name : "",
          clientId: typeof block.clientId === "string" ? block.clientId : undefined,
          attributes: typeof block.attributes === "object" && block.attributes ? block.attributes as Record<string, unknown> : undefined,
          isValid: typeof block.isValid === "boolean" ? block.isValid : undefined,
          innerBlocks,
        })
        if (Array.isArray(block.innerBlocks)) pending.push({ items: block.innerBlocks as Array<Record<string, unknown>>, output: innerBlocks })
      }
    }
    const savedContent = typeof currentPost?.content === "object" && currentPost.content
      ? stringValue((currentPost.content as Record<string, unknown>).raw ?? (currentPost.content as Record<string, unknown>).rendered)
      : undefined
    return {
      storesAvailable: true,
      post: {
        id: typeof editor.getCurrentPostId === "function" ? editor.getCurrentPostId() : currentPost?.id,
        type: typeof editor.getCurrentPostType === "function" ? editor.getCurrentPostType() : currentPost?.type,
        status: typeof currentPost?.status === "string" ? currentPost.status : undefined,
        title: typeof currentPost?.title === "object" && currentPost.title ? (currentPost.title as Record<string, unknown>).raw ?? (currentPost.title as Record<string, unknown>).rendered : undefined,
      },
      blocks: tree,
      serializedContent: typeof serialize === "function" ? serialize(blocks) : typeof editor.getEditedPostContent === "function" ? String(editor.getEditedPostContent() ?? "") : undefined,
      dirty: typeof editor.isEditedPostDirty === "function" ? Boolean(editor.isEditedPostDirty()) : undefined,
      saving: typeof editor.isSavingPost === "function" ? Boolean(editor.isSavingPost()) : undefined,
      savedContent,
    }
  }) as Omit<EditorStateSnapshot, "schema" | "capturedAt" | "target">

  const serializedContent = typeof state.serializedContent === "string" ? state.serializedContent : undefined
  const savedContent = typeof state.savedContent === "string" ? state.savedContent : undefined
  return {
    schema: "wp-codebox/editor-state/v1",
    capturedAt: now(),
    target,
    ...state,
    ...(serializedContent !== undefined ? { serializedContentSha256: sha256(Buffer.from(serializedContent, "utf8")) } : {}),
    ...(savedContent !== undefined ? { savedContentSha256: sha256(Buffer.from(savedContent, "utf8")) } : {}),
  }
}

function summarizeEditorStateForStep(state: EditorStateSnapshot): { blockCount?: number; contentSha256?: string; dirty?: boolean; saving?: boolean; savedContentSha256?: string } {
  return {
    ...(state.blocks ? { blockCount: state.blocks.length } : {}),
    ...(state.serializedContentSha256 ? { contentSha256: state.serializedContentSha256 } : {}),
    ...(typeof state.dirty === "boolean" ? { dirty: state.dirty } : {}),
    ...(typeof state.saving === "boolean" ? { saving: state.saving } : {}),
    ...(state.savedContentSha256 ? { savedContentSha256: state.savedContentSha256 } : {}),
  }
}

function editorActionMutatesState(step: EditorActionStep): boolean {
  return ["insertBlock", "updateBlockAttributes", "removeBlock", "moveBlock", "duplicateBlock", "replaceBlock", "replaceInnerBlocks", "undo", "redo"].includes(step.kind)
}

interface EditorStateBlock {
  name: string
  clientId?: string
  attributes?: Record<string, unknown>
  innerBlocks?: EditorStateBlock[]
}

interface EditorStateBlockLocation {
  block: EditorStateBlock
  siblings: EditorStateBlock[]
  index: number
  parentClientId?: string
}

function editorStateBlocks(state: EditorStateSnapshot): EditorStateBlock[] {
  return state.blocks ?? []
}

function locateEditorStateBlock(blocks: EditorStateBlock[], target: EditorBlockTarget): EditorStateBlockLocation | undefined {
  if (typeof target.clientId === "string") {
    const visit = (items: EditorStateBlock[], parentClientId?: string): EditorStateBlockLocation | undefined => {
      for (const [index, block] of items.entries()) {
        if (block.clientId === target.clientId) return { block, siblings: items, index, parentClientId }
        const found = visit(block.innerBlocks ?? [], block.clientId)
        if (found) return found
      }
      return undefined
    }
    return visit(blocks)
  }
  const path = target.path ?? (typeof target.index === "number" ? [target.index] : [])
  let siblings = blocks
  let parentClientId: string | undefined
  for (const [depth, index] of path.entries()) {
    const block = siblings[index]
    if (!block) return undefined
    if (depth === path.length - 1) return { block, siblings, index, parentClientId }
    parentClientId = block.clientId
    siblings = block.innerBlocks ?? []
  }
  return undefined
}

function countEditorStateBlocks(blocks: EditorStateBlock[]): number {
  return blocks.reduce((count, block) => count + 1 + countEditorStateBlocks(block.innerBlocks ?? []), 0)
}

function editorValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => editorValuesEqual(value, right[index]))
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord).sort()
  const rightKeys = Object.keys(rightRecord).sort()
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && editorValuesEqual(leftRecord[key], rightRecord[key]))
}

function blockMatchesEditorSpec(block: EditorStateBlock | undefined, spec: EditorBlockSpec): boolean {
  if (!block || block.name !== spec.name) return false
  if (spec.attributes && !Object.entries(spec.attributes).every(([key, value]) => editorValuesEqual(block.attributes?.[key], value))) return false
  const expectedChildren = spec.innerBlocks ?? []
  const actualChildren = block.innerBlocks ?? []
  return actualChildren.length === expectedChildren.length && expectedChildren.every((child, index) => blockMatchesEditorSpec(actualChildren[index], child))
}

// Gutenberg dispatchers can silently decline locked or unsupported changes. Verify
// the intended state transition instead of treating a successful dispatch as success.
export function assertEditorMutationPostcondition(step: EditorActionStep, before: EditorStateSnapshot, after: EditorStateSnapshot): void {
  if (!editorActionMutatesState(step)) return
  const fail = (reason: string): never => { throw new Error(`wp-codebox-editor-mutation-noop:${step.kind}:${reason}`) }
  if (step.kind === "insertBlock" || step.kind === "undo" || step.kind === "redo") {
    if (before.serializedContentSha256 === after.serializedContentSha256 && editorValuesEqual(editorStateBlocks(before), editorStateBlocks(after))) fail("editor state did not change")
    return
  }
  const blockStep = step as EditorBlockTarget
  const beforeTarget = locateEditorStateBlock(editorStateBlocks(before), blockStep)
  if (!beforeTarget) throw new Error(`wp-codebox-editor-mutation-noop:${step.kind}:target was absent from the before state`)
  const afterTarget = beforeTarget.block.clientId ? locateEditorStateBlock(editorStateBlocks(after), { clientId: beforeTarget.block.clientId }) : undefined
  if (step.kind === "updateBlockAttributes") {
    if (!afterTarget) throw new Error(`wp-codebox-editor-mutation-noop:${step.kind}:target was absent after dispatch`)
    if (!Object.entries(step.attributes).every(([key, value]) => editorValuesEqual(afterTarget.block.attributes?.[key], value))) fail("updated attributes were not present after dispatch")
    if (editorValuesEqual(beforeTarget.block.attributes, afterTarget.block.attributes)) fail("attributes were unchanged")
    return
  }
  if (step.kind === "removeBlock") {
    if (afterTarget || countEditorStateBlocks(editorStateBlocks(after)) >= countEditorStateBlocks(editorStateBlocks(before))) fail("target remained after remove dispatch")
    return
  }
  if (step.kind === "moveBlock") {
    if (!afterTarget) throw new Error(`wp-codebox-editor-mutation-noop:${step.kind}:target was absent after dispatch`)
    if (afterTarget.index !== step.position) fail("target did not reach the requested position")
    if (beforeTarget.parentClientId === afterTarget.parentClientId && beforeTarget.index === afterTarget.index) fail("target position was unchanged")
    return
  }
  if (step.kind === "duplicateBlock") {
    if (!afterTarget) throw new Error(`wp-codebox-editor-mutation-noop:${step.kind}:target was absent after dispatch`)
    if (afterTarget.siblings.length <= beforeTarget.siblings.length) fail("sibling count did not increase")
    const duplicate = afterTarget.siblings.some((block) => block.clientId !== afterTarget.block.clientId && block.name === beforeTarget.block.name && editorValuesEqual(block.attributes, beforeTarget.block.attributes))
    if (!duplicate) fail("no duplicate sibling matched the target")
    return
  }
  if (step.kind === "replaceBlock") {
    const afterAtPosition = afterTarget?.siblings[beforeTarget.index] ?? (beforeTarget.parentClientId ? locateEditorStateBlock(editorStateBlocks(after), { clientId: beforeTarget.parentClientId })?.block.innerBlocks?.[beforeTarget.index] : editorStateBlocks(after)[beforeTarget.index])
    if (!blockMatchesEditorSpec(afterAtPosition, step.block)) fail("replacement block did not match the requested specification")
    return
  }
  if (step.kind === "replaceInnerBlocks") {
    if (!afterTarget || !blockMatchesEditorSpec(afterTarget.block, { name: afterTarget.block.name, innerBlocks: step.blocks })) fail("inner blocks did not match the requested specification")
  }
}

export async function captureEditorValidity(page: import("playwright").Page, target: ReturnType<typeof editorOpenTargetFromArgs>): Promise<EditorValidityArtifact> {
  const selectors = EDITOR_VALIDITY_WARNING_SELECTORS
  const warnings = await page.evaluate((warningSelectors) => {
    const compactText = (value: unknown, maxLength = 240): string => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength)
    const cssEscape = (value: string): string => {
      const css = (globalThis as typeof globalThis & { CSS?: { escape?: (input: string) => string } }).CSS
      return typeof css?.escape === "function" ? css.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, "\\$&")
    }
    const elementPath = (element: Element): string => {
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
    const seen = new Set<string>()
    const warnings: EditorValidityWarning[] = []
    for (const selector of warningSelectors) {
      for (const element of Array.from(document.querySelectorAll(selector))) {
        const text = compactText(element.textContent)
        if (!/invalid|unexpected|block contains|attempt block recovery/i.test(text) && !element.classList.contains("is-invalid")) {
          continue
        }
        const path = elementPath(element)
        const key = `dom:${selector}:${path}:${text}`
        if (seen.has(key)) {
          continue
        }
        seen.add(key)
        const block = element.closest("[data-block], [data-type]")
        warnings.push({
          source: "dom",
          selector,
          path,
          message: text || "Editor invalid-block warning matched selector.",
          blockName: block?.getAttribute("data-type") ?? undefined,
          clientId: block?.getAttribute("data-block") ?? undefined,
        })
      }
    }

    const select = (window as unknown as { wp?: { data?: { select?: (store: string) => Record<string, unknown> } } }).wp?.data?.select
    const blockEditor = typeof select === "function" ? select("core/block-editor") : undefined
    const blocks = typeof blockEditor?.getBlocks === "function" ? blockEditor.getBlocks() as Array<Record<string, unknown>> : []
    const visitBlocks = (items: Array<Record<string, unknown>>): void => {
      for (const block of items) {
        if (block.isValid === false) {
          const clientId = typeof block.clientId === "string" ? block.clientId : undefined
          const name = typeof block.name === "string" ? block.name : undefined
          const key = `store:${clientId ?? ""}:${name ?? ""}`
          if (!seen.has(key)) {
            seen.add(key)
            warnings.push({
              source: "block-editor-store",
              message: "Block editor store reported an invalid block.",
              blockName: name,
              clientId,
            })
          }
        }
        if (Array.isArray(block.innerBlocks)) {
          visitBlocks(block.innerBlocks as Array<Record<string, unknown>>)
        }
      }
    }
    visitBlocks(blocks)
    return warnings
  }, selectors)
  const messages = [...new Set(warnings.map((warning) => warning.message).filter((message) => message.length > 0))]
  return {
    schema: "wp-codebox/editor-validity/v1",
    capturedAt: now(),
    target,
    selectors,
    warnings,
    summary: {
      schema: "wp-codebox/editor-validity/v1",
      status: warnings.length > 0 ? "warnings" : "clean",
      warningCount: warnings.length,
      selectors,
      messages,
    },
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

const EDITOR_VALIDATE_BLOCKS_READY_TIMEOUT_MS = 30_000

export interface BlockValidationNode {
  name: string
  isValid: boolean
  issues: string[]
  innerBlocks?: BlockValidationNode[]
}

export interface BlockValidationResult {
  name: string
  isValid: boolean
  issues: string[]
}

export interface EditorValidateBlocksResult {
  total_blocks: number
  valid_blocks: number
  invalid_blocks: number
  validation_method: "wp.blocks.validateBlock"
  validation_provider: string
  content_source: "argument" | "edited-post-content"
  block_types_registered: number
  results: BlockValidationResult[]
}

interface EditorBlockValidationEvaluation {
  nodes: BlockValidationNode[]
  validationProvider: string
  contentSource: "argument" | "edited-post-content"
  blockTypesRegistered: number
}

interface EditorBlockValidation {
  result: EditorValidateBlocksResult
  contentSource: "argument" | "edited-post-content"
  blockTypesRegistered: number
}

export function flattenBlockValidationNodes(nodes: BlockValidationNode[]): BlockValidationResult[] {
  const results: BlockValidationResult[] = []
  const walk = (list: BlockValidationNode[]): void => {
    for (const node of list) {
      results.push({
        name: typeof node.name === "string" ? node.name : "",
        isValid: node.isValid !== false,
        issues: Array.isArray(node.issues) ? node.issues.filter((issue): issue is string => typeof issue === "string") : [],
      })
      if (Array.isArray(node.innerBlocks) && node.innerBlocks.length > 0) {
        walk(node.innerBlocks)
      }
    }
  }
  walk(nodes)
  return results
}

export function summarizeBlockValidation(input: { nodes: BlockValidationNode[]; validationProvider: string; contentSource: "argument" | "edited-post-content"; blockTypesRegistered: number }): EditorValidateBlocksResult {
  const results = flattenBlockValidationNodes(input.nodes)
  const validBlocks = results.filter((result) => result.isValid).length
  return {
    total_blocks: results.length,
    valid_blocks: validBlocks,
    invalid_blocks: results.length - validBlocks,
    validation_method: "wp.blocks.validateBlock",
    validation_provider: input.validationProvider,
    content_source: input.contentSource,
    block_types_registered: input.blockTypesRegistered,
    results,
  }
}

export async function validateEditorBlocks(page: import("playwright").Page, options: { content?: string; provider: string }): Promise<EditorBlockValidation> {
  const evaluation = await evaluateEditorBlockValidation(page, options)
  return {
    result: summarizeBlockValidation({
      nodes: evaluation.nodes,
      validationProvider: evaluation.validationProvider,
      contentSource: evaluation.contentSource,
      blockTypesRegistered: evaluation.blockTypesRegistered,
    }),
    contentSource: evaluation.contentSource,
    blockTypesRegistered: evaluation.blockTypesRegistered,
  }
}

async function evaluateEditorBlockValidation(page: import("playwright").Page, options: { content?: string; provider: string }): Promise<EditorBlockValidationEvaluation> {
  return page.evaluate((input) => {
    const win = window as unknown as {
      wp?: {
        blocks?: {
          parse?: (content: string) => unknown[]
          validateBlock?: (block: unknown, blockType?: unknown) => unknown
          getBlockType?: (name: string) => unknown
          getBlockTypes?: () => unknown[]
        }
        data?: { select?: (store: string) => Record<string, unknown> }
      }
    }
    const wpBlocks = win.wp?.blocks
    if (!wpBlocks || typeof wpBlocks.parse !== "function") {
      throw new Error("wp-codebox-editor-validate-blocks-unavailable: wp.blocks.parse is not available in the editor runtime")
    }
    const validateBlock = wpBlocks.validateBlock
    const getBlockType = wpBlocks.getBlockType
    const getBlockTypes = wpBlocks.getBlockTypes
    const blockTypesRegistered = typeof getBlockTypes === "function" ? (getBlockTypes() as unknown[]).length : 0

    let contentSource: "argument" | "edited-post-content" = "argument"
    let content = input.content
    if (typeof content !== "string") {
      const select = win.wp?.data?.select
      const editor = typeof select === "function" ? select("core/editor") : undefined
      content = typeof editor?.getEditedPostContent === "function" ? String((editor.getEditedPostContent as () => unknown)() ?? "") : ""
      contentSource = "edited-post-content"
    }

    const formatIssue = (issue: unknown): string => {
      if (typeof issue === "string") {
        return issue
      }
      if (issue && typeof issue === "object") {
        const record = issue as Record<string, unknown>
        if (Array.isArray(record.args)) {
          return record.args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ").trim()
        }
        if (typeof record.message === "string") {
          return record.message
        }
      }
      return String(issue)
    }

    type ValidationNode = { name: string; isValid: boolean; issues: string[]; innerBlocks: ValidationNode[] }
    const validateNode = (block: unknown): ValidationNode => {
      const record = (block && typeof block === "object" ? block : {}) as Record<string, unknown>
      const name = typeof record.name === "string" ? record.name : ""
      let isValid = record.isValid !== false
      let issues: string[] = []
      if (typeof validateBlock === "function") {
        const blockType = typeof getBlockType === "function" && name ? getBlockType(name) : undefined
        try {
          const outcome = validateBlock(block, blockType)
          if (Array.isArray(outcome)) {
            isValid = Boolean(outcome[0])
            if (Array.isArray(outcome[1])) {
              issues = (outcome[1] as unknown[]).map(formatIssue).filter((issue) => issue.length > 0)
            }
          } else {
            isValid = Boolean(outcome)
          }
        } catch (error) {
          isValid = false
          issues = [error instanceof Error ? error.message : String(error)]
        }
      }
      if (isValid === false && issues.length === 0 && Array.isArray(record.validationIssues)) {
        issues = (record.validationIssues as unknown[]).map(formatIssue).filter((issue) => issue.length > 0)
      }
      const innerBlocks = Array.isArray(record.innerBlocks) ? (record.innerBlocks as unknown[]).map(validateNode) : []
      return { name, isValid, issues, innerBlocks }
    }

    const parsed = wpBlocks.parse(content)
    const nodes = Array.isArray(parsed) ? parsed.map(validateNode) : []
    return { nodes, validationProvider: input.provider, contentSource, blockTypesRegistered }
  }, { content: options.content, provider: options.provider })
}

export async function runEditorValidateBlocksCommand({
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
  const target = await resolveEditorOpenTarget(editorOpenTargetFromArgs(args), {
    command: "wordpress.editor-validate-blocks",
    runPlaygroundCommand,
    runtimeSpec,
    server,
  })
  const editorWaitSelector = target.waitSelector ?? DEFAULT_EDITOR_WAIT_SELECTOR
  const content = await editorValidateContentFromArgs(args)
  const provider = editorValidateProviderFromArgs(args)
  const waitTimeoutMs = durationArg(args, "wait-timeout", EDITOR_VALIDATE_BLOCKS_READY_TIMEOUT_MS)
  const topology = editorCommandPreviewTopology(args, runtimeSpec, server)
  const { preview, networkPolicy } = topology
  const routeTracker = createBrowserPreviewRouteTracker()
  const targetUrl = topology.resolveUrl(target.url)
  const artifactSession = new BrowserArtifactSession(artifactRoot, "files/browser", { source: "wordpress.editor-validate-blocks", operation: "editor-validate-blocks" })

  const errors: BrowserProbeErrorRecord[] = []
  const startedAt = now()
  const browser = await launchChromiumBrowser()
  let finalUrl = targetUrl
  let viewport: BrowserProbeViewport | null = null
  let authSummary: BrowserProbeAuthSummary | undefined
  let validation: EditorBlockValidation | undefined
  let pendingError: Error | undefined
  let artifact: BrowserArtifact | undefined

  try {
    const previewReadinessError = browserPreviewReadinessError(preview)
    if (previewReadinessError) {
      throw previewReadinessError
    }
    const context = browserPreviewNeedsContextRouting(networkPolicy) ? await browser.newContext(topology.contextOptions()) : null
    if (context) {
      await routeBrowserPreviewContextNetwork(context, networkPolicy, topology.origins.localProxyOrigin, routeTracker)
    }
    const page = context ? await context.newPage() : await browser.newPage()
    authSummary = await installWordPressAdminAuthCookies({ command: "wordpress.editor-validate-blocks", cookieUrls: topology.authCookieUrls([targetUrl]), page, runPlaygroundCommand, runtimeSpec, server, userId: 1 })
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

    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: waitTimeoutMs })
    finalUrl = page.url()
    await waitForAnyVisibleSelector(page, editorWaitSelector, waitTimeoutMs)
    await waitForEditorBlocksRuntime(page, waitTimeoutMs)
    finalUrl = page.url()
    validation = await validateEditorBlocks(page, { content, provider })
  } catch (error) {
    pendingError = error instanceof Error ? error : new Error(String(error))
    errors.push(serializeBrowserError("probe-error", error))
  } finally {
    for (const routeError of await closeBrowserAndDrainPreviewRoutes(browser, routeTracker)) {
      errors.push(serializeBrowserError("probe-error", routeError))
      if (browserPreviewCleanupErrorIsFatal(routeError)) pendingError ??= routeError
    }

    const summary: BrowserEditorValidateBlocksSummary | undefined = validation
      ? {
          schema: "wp-codebox/editor-validate-blocks/v1",
          totalBlocks: validation.result.total_blocks,
          validBlocks: validation.result.valid_blocks,
          invalidBlocks: validation.result.invalid_blocks,
          validationMethod: "wp.blocks.validateBlock",
          validationProvider: validation.result.validation_provider,
          contentSource: validation.contentSource,
          blockTypesRegistered: validation.blockTypesRegistered,
        }
      : undefined

    await artifactSession.writeJson("validateBlocks", "editor-validate-blocks.json", {
      schema: "wp-codebox/editor-validate-blocks/v1",
      target,
      requestedUrl: targetUrl,
      preview,
      ...topology.origins,
      finalUrl,
      provider,
      contentSource: validation?.contentSource,
      blockTypesRegistered: validation?.blockTypesRegistered,
      startedAt,
      finishedAt: now(),
      result: validation?.result,
    })

    artifact = {
      artifactType: "editor-validate-blocks",
      requestedUrl: targetUrl,
      url: targetUrl,
      preview,
      ...(server.previewProxyDiagnostics ? { previewProxy: server.previewProxyDiagnostics } : {}),
      ...(browserPreviewNetworkPolicyIsActive(networkPolicy) ? { networkPolicy: browserPreviewNetworkPolicySummary(networkPolicy) } : {}),
      ...topology.origins,
      files: {
        validateBlocks: "files/browser/editor-validate-blocks.json",
        summary: "files/browser/editor-validate-blocks-summary.json",
      },
      summary: {
        consoleMessages: 0,
        errors: errors.length,
        finalUrl,
        htmlSnapshot: false,
        ...(server.previewProxyDiagnostics ? { previewProxy: server.previewProxyDiagnostics } : {}),
        auth: authSummary,
        ...(browserPreviewNetworkPolicyIsActive(networkPolicy) ? { networkPolicy: browserPreviewNetworkPolicySummary(networkPolicy) } : {}),
        networkEvents: 0,
        replayability: "diagnostic-only",
        screenshot: false,
        editorValidateBlocks: summary ?? {
          schema: "wp-codebox/editor-validate-blocks/v1",
          totalBlocks: 0,
          validBlocks: 0,
          invalidBlocks: 0,
          validationMethod: "wp.blocks.validateBlock",
          validationProvider: provider,
          contentSource: typeof content === "string" ? "argument" : "edited-post-content",
          blockTypesRegistered: 0,
        },
        viewport,
      },
    } as BrowserArtifact

    await artifactSession.writeJson("summary", "editor-validate-blocks-summary.json", {
      schema: "wp-codebox/editor-validate-blocks/v1",
      target,
      requestedUrl: targetUrl,
      preview,
      ...topology.origins,
      finalUrl,
      startedAt,
      finishedAt: now(),
      files: artifact.files,
      viewport,
      summary: artifact.summary,
    })
  }

  if (pendingError) {
    throw new BrowserCommandArtifactError(`wordpress.editor-validate-blocks failed: ${pendingError.message}`, artifact)
  }
  if (!validation) {
    throw new BrowserCommandArtifactError("wordpress.editor-validate-blocks failed: block validation did not complete", artifact)
  }

  return browserCommandResult(artifact, validation.result)
}

async function waitForEditorBlocksRuntime(page: import("playwright").Page, timeoutMs: number): Promise<void> {
  await page.waitForFunction(() => {
    const wpBlocks = (window as unknown as { wp?: { blocks?: { parse?: unknown; getBlockTypes?: () => unknown[] } } }).wp?.blocks
    if (!wpBlocks || typeof wpBlocks.parse !== "function") {
      return false
    }
    const blockTypes = typeof wpBlocks.getBlockTypes === "function" ? wpBlocks.getBlockTypes() : []
    return Array.isArray(blockTypes) && blockTypes.length > 0
  }, undefined, { timeout: timeoutMs })
}
