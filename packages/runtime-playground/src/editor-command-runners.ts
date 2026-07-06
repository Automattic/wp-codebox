import { type ExecutionSpec, type RuntimeCreateSpec } from "@automattic/wp-codebox-core"
import { now, sha256 } from "@automattic/wp-codebox-core/internals"
import { durationStringMs } from "./browser-actions.js"
import { BrowserArtifactSession } from "./browser-artifact-session.js"
import { BrowserCommandArtifactError } from "./browser-command-artifact-error.js"
import type { BrowserArtifact, BrowserArtifactSummary, BrowserEditorCanvasProbeDiagnostic, BrowserEditorCanvasProbeSummary, BrowserEditorCanvasSelectorGroupSummary, BrowserEditorCanvasSelectorSummary, BrowserEditorReadinessSummary, BrowserEditorSaveSummary, BrowserEditorValidateBlocksSummary, BrowserEditorValiditySummary, BrowserProbeAuthSummary, BrowserProbeErrorRecord, BrowserProbeViewport, BrowserStepRecord } from "./browser-artifacts.js"
import { attachBrowserCaptureListeners, launchChromiumBrowser } from "./browser-capture-session.js"
import { browserStepRecord } from "./browser-interactions.js"
import { browserPreviewNetworkPolicyIsActive, browserPreviewNetworkPolicySummary, browserPreviewNeedsContextRouting, browserPreviewOrigins, browserPreviewReadinessError, browserPreviewRouting, browserPreviewSecureContextError, browserPreviewTopology, resolveBrowserPreviewUrl, routeBrowserPreviewContextNetwork } from "./browser-preview-routing.js"
import { browserProbeReplayability, browserProbeViewport } from "./browser-probe.js"
import { argValue, commaListArg, durationArg, jsonArrayArg } from "./commands.js"
import { editorActionStepsFromArgs, editorOpenTargetFromArgs, editorValidateContentFromArgs, editorValidateProviderFromArgs, resolveEditorOpenTarget, type EditorActionStep } from "./editor-actions.js"
import type { PlaygroundRunResponse } from "./playground-command-errors.js"
import type { PlaygroundCliServer } from "./preview-server.js"
import { serializeBrowserError } from "./browser-metrics.js"
import { fileSha256, installWordPressAdminAuthCookies } from "./browser-probe-support.js"

const BROWSER_STEP_DEFAULT_TIMEOUT_MS = 15_000
const BROWSER_SCRIPT_DEFAULT_TIMEOUT_MS = 120_000
const EDITOR_CANVAS_DEFAULT_IFRAME_SELECTOR = 'iframe[name="editor-canvas"]'
const EDITOR_CANVAS_DEFAULT_LAYOUT_SELECTOR = ".block-editor-block-list__layout"
const EDITOR_CANVAS_DEFAULT_BLOCK_SELECTOR = ".block-editor-block-list__block, [data-block]"
const EDITOR_CANVAS_DEFAULT_TIMEOUT_MS = 30_000
const EDITOR_VALIDITY_WARNING_SELECTORS = [
  ".block-editor-warning",
  ".block-editor-block-list__block.is-invalid",
  "[data-type].is-invalid",
  ".components-notice",
]

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
  }
  for (const item of capture) {
    if (!["steps", "console", "errors", "html", "screenshot", "editor-state", "editor-validity"].includes(item)) {
      throw new Error(`wordpress.editor-open capture supports steps, console, errors, html, screenshot, editor-state, editor-validity: ${item}`)
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
  let editorValidity: EditorValidityArtifact | undefined
  let editorCanvasReadiness: BrowserEditorCanvasProbeSummary | undefined
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
        editorCanvasReadiness = await waitForEditorOpenCanvasReadiness(page, target.waitSelector, waitTimeoutMs)
        finalUrl = page.url()
        stepRecords.push(browserStepRecord(1, { kind: "waitFor", selector: target.waitSelector }, "ok", waitStartedAt, waitStartedAtMs, finalUrl, {
          ...(editorCanvasReadiness ? { editorCanvas: editorCanvasReadiness } : {}),
        } as never))
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
      await artifactSession.writeGenerated("screenshot", "editor-screenshot.png", async (path) => {
        if (editorCanvasReadiness?.ready) {
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
        ...(capture.has("editor-validity") ? { editorValidity: "files/browser/editor-validity.json" } : {}),
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
        ...(editorValidity ? { editorValidity: editorValidity.summary } : {}),
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

async function waitForEditorOpenCanvasReadiness(page: import("playwright").Page, waitSelector: string, timeoutMs: number): Promise<BrowserEditorCanvasProbeSummary | undefined> {
  if (!waitSelector.includes("editor-canvas")) {
    return undefined
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

  return probe.summary
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
    if (!["steps", "console", "errors", "html", "screenshot", "editor-state", "editor-validity"].includes(item)) {
      throw new Error(`wordpress.editor-actions capture supports steps, console, errors, html, screenshot, editor-state, editor-validity: ${item}`)
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
  let editorValidity: EditorValidityArtifact | undefined
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
    for (const block of blocks) {
      if (block.isValid !== false) {
        continue
      }
      const clientId = typeof block.clientId === "string" ? block.clientId : undefined
      const name = typeof block.name === "string" ? block.name : undefined
      const key = `store:${clientId ?? ""}:${name ?? ""}`
      if (seen.has(key)) {
        continue
      }
      seen.add(key)
      warnings.push({
        source: "block-editor-store",
        message: "Block editor store reported an invalid block.",
        blockName: name,
        clientId,
      })
    }
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

export function summarizeBlockValidation(input: { nodes: BlockValidationNode[]; validationProvider: string }): EditorValidateBlocksResult {
  const results = flattenBlockValidationNodes(input.nodes)
  const validBlocks = results.filter((result) => result.isValid).length
  return {
    total_blocks: results.length,
    valid_blocks: validBlocks,
    invalid_blocks: results.length - validBlocks,
    validation_method: "wp.blocks.validateBlock",
    validation_provider: input.validationProvider,
    results,
  }
}

export async function validateEditorBlocks(page: import("playwright").Page, options: { content?: string; provider: string }): Promise<EditorBlockValidation> {
  const evaluation = await evaluateEditorBlockValidation(page, options)
  return {
    result: summarizeBlockValidation({ nodes: evaluation.nodes, validationProvider: evaluation.validationProvider }),
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
  const content = await editorValidateContentFromArgs(args)
  const provider = editorValidateProviderFromArgs(args)
  const waitTimeoutMs = durationArg(args, "wait-timeout", EDITOR_VALIDATE_BLOCKS_READY_TIMEOUT_MS)
  const topology = browserPreviewTopology(args, runtimeSpec, server.serverUrl)
  const { preview, networkPolicy } = topology
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
    const context = browserPreviewNeedsContextRouting(networkPolicy) ? await browser.newContext() : null
    if (context) {
      await routeBrowserPreviewContextNetwork(context, networkPolicy, preview.effectiveOrigin)
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
    await waitForAnyVisibleSelector(page, target.waitSelector, waitTimeoutMs)
    await waitForEditorBlocksRuntime(page, waitTimeoutMs)
    finalUrl = page.url()
    validation = await validateEditorBlocks(page, { content, provider })
  } catch (error) {
    pendingError = error instanceof Error ? error : new Error(String(error))
    errors.push(serializeBrowserError("probe-error", error))
  } finally {
    await browser.close()

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

  return {
    artifact,
    output: `${JSON.stringify(validation.result, null, 2)}\n`,
  }
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
