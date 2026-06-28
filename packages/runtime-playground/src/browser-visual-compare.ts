import { access, readFile, writeFile } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import type { ExecutionSpec, RuntimeCreateSpec } from "@automattic/wp-codebox-core"
import { errorMessage, now, sha256 } from "@automattic/wp-codebox-core/internals"
import pixelmatch from "pixelmatch"
import { PNG } from "pngjs"
import { BrowserArtifactSession } from "./browser-artifact-session.js"
import type { BrowserArtifact, BrowserProbeViewport } from "./browser-artifacts.js"
import { launchChromiumBrowser } from "./browser-capture-session.js"
import { captureBrowserDomSnapshot, normalizeBrowserDomSnapshotArtifact, type BrowserDomElementSnapshot as VisualCompareDomElementSnapshot, type BrowserDomSelectorSnapshot as VisualCompareSelectorSnapshot, type BrowserDomSnapshot as VisualCompareDomSnapshot, type BrowserDomSnapshotArtifact as VisualCompareDomSnapshotArtifact } from "./browser-dom-snapshot.js"
import { browserCommandLivenessPolicy, withBrowserCommandLiveness } from "./browser-liveness.js"
import { browserPreviewRouting, resolveBrowserPreviewUrl } from "./browser-preview-routing.js"
import { browserProbeViewport } from "./browser-probe.js"
import { BrowserCommandArtifactError } from "./browser-command-artifact-error.js"
import { argValue, durationArg, jsonArrayArg, strictBooleanArg, viewportArg } from "./commands.js"
import type { PlaygroundCliServer } from "./preview-server.js"
import type { Page } from "playwright"

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

export interface BlocksEngineVisualParityReport {
  schema: "blocks-engine/php-transformer/visual-parity-report/v1"
  status: "pass" | "warning" | "fail" | "unknown"
  severity: "none" | "info" | "warning" | "error" | "critical"
  source_render: Record<string, unknown> & { kind: "source" }
  target_render: Record<string, unknown> & { kind: "target" }
  viewports: Array<{ id: string; label?: string; width: number; height: number; device_scale_factor?: number; source_screenshot_path?: string; target_screenshot_path?: string; diff_screenshot_path?: string }>
  matches: Array<{ kind: "generic"; source_selector: string; target_selector: string; confidence: number; viewport_id?: string; selector_evidence?: Record<string, unknown> }>
  computed_style_deltas?: Array<{ property: string; severity: "none" | "info" | "warning" | "error" | "critical"; viewport_id?: string; source_selector?: string; target_selector?: string; source_value?: unknown; target_value?: unknown; delta?: unknown }>
  visual_diff?: { available: boolean; mismatch_percent?: number; mismatch_pixels?: number; total_pixels?: number; threshold?: number; diff_screenshot_path?: string; by_viewport?: Array<{ viewport_id: string; mismatch_percent?: number; mismatch_pixels?: number; diff_screenshot_path?: string }> }
  findings: Array<{ id: string; severity: "none" | "info" | "warning" | "error" | "critical"; category: "visual" | "layout" | "style" | "dom" | "interaction" | "content" | "asset" | "accessibility"; summary: string; viewport_id?: string; visual_diff?: { viewport_id: string; mismatch_percent?: number; mismatch_pixels?: number; diff_screenshot_path?: string }; recommendation_ids?: string[] }>
  recommendations: Array<{ id: string; priority: "low" | "medium" | "high" | "blocking"; summary: string; rationale?: string; finding_ids?: string[] }>
  metadata?: Record<string, unknown>
}

export function blocksEngineVisualParityReportFromVisualCompare(input: {
  status?: string
  source?: Record<string, unknown>
  candidate?: Record<string, unknown>
  viewport?: BrowserProbeViewport | null
  files?: Record<string, unknown>
  comparison?: VisualCompareComparisonMetrics
  options?: Record<string, unknown>
  explanation?: VisualCompareExplanation
  comparisons?: Array<{ name: string; status?: string; source?: Record<string, unknown>; candidate?: Record<string, unknown>; viewport?: BrowserProbeViewport | null; files?: Record<string, unknown>; comparison?: VisualCompareComparisonMetrics }>
  metrics?: Record<string, unknown>
  command?: string
  startedAt?: string
  finishedAt?: string
  updatedAt?: string
}): BlocksEngineVisualParityReport {
  const comparisons = input.comparisons?.length ? input.comparisons : [{ name: "default", status: input.status, source: input.source, candidate: input.candidate, viewport: input.viewport, files: input.files, comparison: input.comparison }]
  const completeComparisons = comparisons.filter((comparison) => comparison.comparison)
  const status = input.status === "identical" ? "pass" : input.status === "different" ? "fail" : input.status === "partial" ? "warning" : input.status === "missing" || input.status === "failed" ? "unknown" : "unknown"
  const severity = status === "pass" ? "none" : status === "fail" ? "error" : status === "warning" ? "warning" : "info"
  const first = comparisons[0]
  const sourceScreenshot = first?.files?.sourceScreenshot
  const targetScreenshot = first?.files?.candidateScreenshot
  const diffScreenshot = first?.files?.diffScreenshot
  const viewports = comparisons.map((comparison, index) => blocksEngineVisualParityViewport(comparison, index)).filter((viewport): viewport is BlocksEngineVisualParityReport["viewports"][number] => Boolean(viewport))
  const fallbackViewport = viewports.length > 0 ? viewports : [blocksEngineVisualParityViewport({ name: "default", viewport: input.viewport, files: input.files }, 0)].filter((viewport): viewport is BlocksEngineVisualParityReport["viewports"][number] => Boolean(viewport))
  const findings = completeComparisons.filter((comparison) => (comparison.comparison?.mismatchPixels ?? 0) > 0 || comparison.comparison?.dimensionMismatch).map((comparison, index) => {
    const viewport = blocksEngineVisualParityViewport(comparison, index)
    const mismatchPercent = typeof comparison.comparison?.mismatchRatio === "number" ? comparison.comparison.mismatchRatio * 100 : undefined
    const diffPath = stringFileRef(comparison.files?.diffScreenshot)
    return {
      id: `visual-diff-${sanitizeVisualCompareMatrixName(comparison.name || String(index + 1))}`,
      severity: "error" as const,
      category: "visual" as const,
      summary: comparison.comparison?.dimensionMismatch ? "Rendered screenshots differ in dimensions." : "Rendered screenshots contain pixel differences.",
      ...(viewport ? { viewport_id: viewport.id } : {}),
      ...(viewport ? { visual_diff: { viewport_id: viewport.id, ...(mismatchPercent !== undefined ? { mismatch_percent: mismatchPercent } : {}), ...(typeof comparison.comparison?.mismatchPixels === "number" ? { mismatch_pixels: comparison.comparison.mismatchPixels } : {}), ...(diffPath ? { diff_screenshot_path: diffPath } : {}) } } : {}),
      recommendation_ids: ["review-visual-diff"],
    }
  })
  const matches = input.explanation?.selectors?.map((selector) => ({
    kind: "generic" as const,
    source_selector: selector.selector,
    target_selector: selector.selector,
    confidence: 1,
    ...(fallbackViewport[0] ? { viewport_id: fallbackViewport[0].id } : {}),
    selector_evidence: {
      source_selector: selector.selector,
      target_selector: selector.selector,
    },
  })) ?? []

  return {
    schema: "blocks-engine/php-transformer/visual-parity-report/v1",
    status,
    severity,
    source_render: blocksEngineVisualParityRender("source", input.source, stringFileRef(sourceScreenshot)),
    target_render: blocksEngineVisualParityRender("target", input.candidate, stringFileRef(targetScreenshot)),
    viewports: fallbackViewport,
    matches,
    visual_diff: {
      available: completeComparisons.length > 0,
      ...(typeof input.comparison?.mismatchRatio === "number" ? { mismatch_percent: input.comparison.mismatchRatio * 100 } : {}),
      ...(typeof input.comparison?.mismatchPixels === "number" ? { mismatch_pixels: input.comparison.mismatchPixels } : {}),
      ...(typeof input.comparison?.totalPixels === "number" ? { total_pixels: input.comparison.totalPixels } : {}),
      ...(typeof input.options?.threshold === "number" ? { threshold: input.options.threshold } : {}),
      ...(stringFileRef(diffScreenshot) ? { diff_screenshot_path: stringFileRef(diffScreenshot) } : {}),
      by_viewport: completeComparisons.map((comparison, index) => blocksEngineVisualParityDiffViewport(comparison, index)).filter((viewport): viewport is NonNullable<NonNullable<BlocksEngineVisualParityReport["visual_diff"]>["by_viewport"]>[number] => Boolean(viewport)),
    },
    findings,
    recommendations: findings.length > 0 ? [{ id: "review-visual-diff", priority: "blocking", summary: "Review the visual diff evidence and repair source or target rendering until the parity report passes.", finding_ids: findings.map((finding) => finding.id) }] : [],
    metadata: {
      producer: "wp-codebox",
      source_schema: input.comparisons ? "wp-codebox/visual-compare-matrix/v1" : "wp-codebox/visual-compare/v1",
      ...(input.command ? { command: input.command } : {}),
      ...(input.startedAt ? { started_at: input.startedAt } : {}),
      ...(input.finishedAt ? { finished_at: input.finishedAt } : {}),
      ...(input.updatedAt ? { updated_at: input.updatedAt } : {}),
      ...(input.metrics ? { source_metrics: input.metrics } : {}),
    },
  }
}

function blocksEngineVisualParityRender(kind: "source", input?: Record<string, unknown>, screenshotPath?: string): BlocksEngineVisualParityReport["source_render"]
function blocksEngineVisualParityRender(kind: "target", input?: Record<string, unknown>, screenshotPath?: string): BlocksEngineVisualParityReport["target_render"]
function blocksEngineVisualParityRender(kind: "source" | "target", input?: Record<string, unknown>, screenshotPath?: string): BlocksEngineVisualParityReport["source_render"] | BlocksEngineVisualParityReport["target_render"] {
  return {
    kind,
    ...(typeof input?.url === "string" ? { url: input.url } : {}),
    ...(typeof input?.finalUrl === "string" ? { ref: input.finalUrl } : {}),
    ...(typeof input?.label === "string" ? { renderer: input.label } : {}),
    ...(typeof input?.screenshot === "string" ? { artifact_path: input.screenshot } : {}),
    ...(screenshotPath ? { screenshot_path: screenshotPath } : {}),
  }
}

function blocksEngineVisualParityViewport(input: { name?: string; viewport?: BrowserProbeViewport | null; files?: Record<string, unknown> }, index: number): BlocksEngineVisualParityReport["viewports"][number] | undefined {
  const width = input.viewport?.width
  const height = input.viewport?.height
  if (typeof width !== "number" || typeof height !== "number") {
    return undefined
  }
  const id = sanitizeVisualCompareMatrixName(input.name || `viewport-${index + 1}`)
  return {
    id,
    width,
    height,
    ...(typeof input.viewport?.deviceScaleFactor === "number" ? { device_scale_factor: input.viewport.deviceScaleFactor } : {}),
    ...(stringFileRef(input.files?.sourceScreenshot) ? { source_screenshot_path: stringFileRef(input.files?.sourceScreenshot) } : {}),
    ...(stringFileRef(input.files?.candidateScreenshot) ? { target_screenshot_path: stringFileRef(input.files?.candidateScreenshot) } : {}),
    ...(stringFileRef(input.files?.diffScreenshot) ? { diff_screenshot_path: stringFileRef(input.files?.diffScreenshot) } : {}),
  }
}

function blocksEngineVisualParityDiffViewport(input: { name?: string; viewport?: BrowserProbeViewport | null; files?: Record<string, unknown>; comparison?: VisualCompareComparisonMetrics }, index: number): NonNullable<NonNullable<BlocksEngineVisualParityReport["visual_diff"]>["by_viewport"]>[number] | undefined {
  const viewport = blocksEngineVisualParityViewport(input, index)
  if (!viewport || !input.comparison) {
    return undefined
  }
  return {
    viewport_id: viewport.id,
    ...(typeof input.comparison.mismatchRatio === "number" ? { mismatch_percent: input.comparison.mismatchRatio * 100 } : {}),
    ...(typeof input.comparison.mismatchPixels === "number" ? { mismatch_pixels: input.comparison.mismatchPixels } : {}),
    ...(stringFileRef(input.files?.diffScreenshot) ? { diff_screenshot_path: stringFileRef(input.files?.diffScreenshot) } : {}),
  }
}

function stringFileRef(value: unknown): string | undefined {
  if (typeof value === "string" && value) {
    return value
  }
  if (Array.isArray(value) && typeof value[0] === "string" && value[0]) {
    return value[0]
  }
  return undefined
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
  const baselineRef = argValue(args, "baseline")?.trim()
  const sourceLabel = argValue(args, "source-label")?.trim() || "source"
  const candidateLabel = argValue(args, "candidate-label")?.trim() || "candidate"
  const waitFor = argValue(args, "wait-for")?.trim() || "domcontentloaded"
  const durationMs = durationArg(args, "duration", 0)
  const visualTimeoutMs = durationArg(args, "timeout", browserCommandLivenessPolicy().wallTimeoutMs)
  const requestedViewport = viewportArg(args, "viewport")
  const fullPage = strictBooleanArg(args, "full-page", true)
  const threshold = numberArg(args, "threshold", 0.1)
  const includeAA = strictBooleanArg(args, "include-aa", false)
  const maxRegions = positiveIntegerArg(args, "max-regions", 8)
  const maxExplanationElements = positiveIntegerArg(args, "max-explanation-elements", 25)
  const maxExplanationCandidates = positiveIntegerArg(args, "max-explanation-candidates", 160)
  const explainSelectors = visualCompareExplainSelectors(args)
  // Disposable WP Codebox sandboxes have no outbound network egress. A captured
  // page that references external resources (Google Fonts, CDNs, analytics) would
  // otherwise leave those requests hanging until the navigation/screenshot hits
  // the wall timeout, surfacing as a `capture-failed`/timeout even though the
  // local document served fine. Aborting cross-origin requests up front makes
  // both targets render deterministically (offline, system-font fallback) and
  // fast. On by default; `block-external-requests=false` opts back into the live
  // (egress-dependent) behavior.
  const blockExternalRequests = strictBooleanArg(args, "block-external-requests", true)

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

  const artifactSession = new BrowserArtifactSession(artifactRoot, artifactPathPrefix, { source: "wordpress.visual-compare", operation: "visual-compare" })
  const sourcePath = artifactSession.absolutePath("source.png")
  const candidatePath = artifactSession.absolutePath("candidate.png")
  const diffPath = artifactSession.absolutePath("diff.png")
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
    await writeVisualComparePartialSummary(artifactSession, {
      artifactPathPrefix,
      stage,
      startedAt,
      source: sourceSummary(),
      candidate: candidateSummary(),
      options: { waitFor, durationMs, timeoutMs: visualTimeoutMs, fullPage, threshold, includeAA, maxRegions, maxExplanationElements, maxExplanationCandidates, ...(explainSelectors.length > 0 ? { explainSelectors } : {}) },
      preview,
      viewport,
    })
  }

  if (sourceTargetUrl && candidateTargetUrl) {
    const browser = await launchChromiumBrowser()
    try {
      const page = await browser.newPage(requestedViewport ? { viewport: requestedViewport } : undefined)
      if (blockExternalRequests) {
        await installVisualCompareOfflineIsolation(page, preview.effectiveOrigin)
      }
      viewport = await browserProbeViewport(page)
      try {
        let sourceCapture: Awaited<ReturnType<typeof captureVisualCompareUrl>> | undefined
        await artifactSession.writeGenerated("sourceScreenshot", "source.png", async (path) => {
          sourceCapture = await withBrowserCommandLiveness({
            command: "wordpress.visual-compare",
            phase: "source-capture",
            operation: captureVisualCompareUrl(page, sourceTargetUrl, path, waitFor, durationMs, fullPage, maxExplanationCandidates, explainSelectors, visualTimeoutMs),
            policy: { wallTimeoutMs: visualTimeoutMs, idleTimeoutMs: 0 },
          })
        })
        if (!sourceCapture) {
          throw new Error("wordpress.visual-compare did not produce source capture")
        }
        finalSourceUrl = sourceCapture.finalUrl
        sourceDomSnapshot = sourceCapture.domSnapshot
        await writePartialSummary("source-captured")
        let candidateCapture: Awaited<ReturnType<typeof captureVisualCompareUrl>> | undefined
        await artifactSession.writeGenerated("candidateScreenshot", "candidate.png", async (path) => {
          candidateCapture = await withBrowserCommandLiveness({
            command: "wordpress.visual-compare",
            phase: "candidate-capture",
            operation: captureVisualCompareUrl(page, candidateTargetUrl, path, waitFor, durationMs, fullPage, maxExplanationCandidates, explainSelectors, visualTimeoutMs),
            policy: { wallTimeoutMs: visualTimeoutMs, idleTimeoutMs: 0 },
          })
        })
        if (!candidateCapture) {
          throw new Error("wordpress.visual-compare did not produce candidate capture")
        }
        finalCandidateUrl = candidateCapture.finalUrl
        candidateDomSnapshot = candidateCapture.domSnapshot
        await writePartialSummary("candidate-captured")
      } catch (error) {
        const result = await writeVisualCompareFailureSummary({
          artifactSession,
          artifactPathPrefix,
          startedAt,
          source: sourceSummary(),
          candidate: candidateSummary(),
          options: { waitFor, durationMs, timeoutMs: visualTimeoutMs, fullPage, threshold, includeAA, maxRegions, maxExplanationElements, maxExplanationCandidates, ...(explainSelectors.length > 0 ? { explainSelectors } : {}) },
          preview,
          viewport,
          message: errorMessage(error),
          copiedFiles: {
            ...(await fileExists(sourcePath) ? { sourceScreenshot: `${artifactPathPrefix}/source.png` } : {}),
            ...(await fileExists(candidatePath) ? { candidateScreenshot: `${artifactPathPrefix}/candidate.png` } : {}),
          },
        })
        throw new BrowserCommandArtifactError(`wordpress.visual-compare failed during capture: ${errorMessage(error)}`, visualCompareFailureArtifact({ source: sourceSummary(), candidate: candidateSummary(), preview, viewport, files: result.files, summary: result.summary }))
      }
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
        await artifactSession.writeBuffer("sourceScreenshot", "source.png", await readFile(sourceResolvedPath))
        copiedFiles.sourceScreenshot = `${artifactPathPrefix}/source.png`
      }
      if (candidateResolvedPath) {
        await artifactSession.writeBuffer("candidateScreenshot", "candidate.png", await readFile(candidateResolvedPath))
        copiedFiles.candidateScreenshot = `${artifactPathPrefix}/candidate.png`
      }
      const result = await writeVisualCompareMissingInputSummary({
        artifactSession,
        artifactPathPrefix,
        startedAt,
        source: sourceSummary(),
        candidate: candidateSummary(),
        options: { waitFor, durationMs, timeoutMs: visualTimeoutMs, fullPage, threshold, includeAA, maxRegions, maxExplanationElements, maxExplanationCandidates, ...(explainSelectors.length > 0 ? { explainSelectors } : {}) },
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
    await artifactSession.writeBuffer("sourceScreenshot", "source.png", await readFile(resolvedSourceScreenshotPath))
    await writePartialSummary("source-captured")
    await artifactSession.writeBuffer("candidateScreenshot", "candidate.png", await readFile(resolvedCandidateScreenshotPath))
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

  let comparison: Awaited<ReturnType<typeof comparePngFiles>> | undefined
  await artifactSession.writeGenerated("diffScreenshot", "diff.png", async (path) => {
    comparison = await comparePngFiles(sourcePath, candidatePath, path, { threshold, includeAA, maxRegions })
  })
  if (!comparison) {
    throw new Error("wordpress.visual-compare did not produce comparison metrics")
  }
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
    blocksEngineVisualParity: `${artifactPathPrefix}/blocks-engine-visual-parity-report.json`,
    summary: `${artifactPathPrefix}/summary.json`,
  }
  const summary = {
    schema: "wp-codebox/visual-compare/v1",
    command: "wordpress.visual-compare",
    status,
    source: sourceSummary(),
    candidate: candidateSummary(),
    options: { waitFor, durationMs, timeoutMs: visualTimeoutMs, fullPage, threshold, includeAA, maxRegions, maxExplanationElements, maxExplanationCandidates, ...(explainSelectors.length > 0 ? { explainSelectors } : {}) },
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
  const blocksEngineVisualParity = blocksEngineVisualParityReportFromVisualCompare({ ...summary, explanation })
  const summaryWithBlocksEngineVisualParity = { ...summary, blocksEngineVisualParity }
  await artifactSession.writeJson("visualDiff", "visual-diff.json", summaryWithBlocksEngineVisualParity)
  if (explanation) {
    await artifactSession.writeJson("visualExplanation", "visual-explanation.json", explanation)
  }
  await artifactSession.writeJson("blocksEngineVisualParity", "blocks-engine-visual-parity-report.json", blocksEngineVisualParity)
  await artifactSession.writeJson("summary", "summary.json", summaryWithBlocksEngineVisualParity)

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
        blocksEngineVisualParity: files.blocksEngineVisualParity,
      },
      viewport,
    },
  }

  return {
    artifact,
    output: `${JSON.stringify(summaryWithBlocksEngineVisualParity, null, 2)}\n`,
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
      ...(matrixSummary.files.blocksEngineVisualParity ? { blocksEngineVisualParity: matrixSummary.files.blocksEngineVisualParity } : {}),
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
        ...(matrixSummary.files.blocksEngineVisualParity ? { blocksEngineVisualParity: matrixSummary.files.blocksEngineVisualParity } : {}),
      },
      viewport: firstArtifact?.summary.viewport ?? null,
    },
  }
}

async function writeVisualComparePartialSummary(artifactSession: BrowserArtifactSession, input: {
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
  await artifactSession.writeJson("summary", "summary.json", summary)
}

async function writeVisualCompareMissingInputSummary(input: {
  artifactSession: BrowserArtifactSession
  artifactPathPrefix: string
  startedAt: string
  source: Record<string, unknown>
  candidate: Record<string, unknown>
  options: Record<string, unknown>
  preview: ReturnType<typeof browserPreviewRouting>
  viewport: BrowserProbeViewport | null
  missingInputs: VisualCompareMissingInput[]
  copiedFiles: Partial<{ sourceScreenshot: string; candidateScreenshot: string }>
}): Promise<{ files: { sourceScreenshot: string | string[]; candidateScreenshot: string | string[]; diffScreenshot: string | string[]; visualDiff: string; blocksEngineVisualParity: string; summary: string }; summary: VisualCompareMissingInputSummary & { blocksEngineVisualParity: BlocksEngineVisualParityReport } }> {
  const files = {
    sourceScreenshot: input.copiedFiles.sourceScreenshot ?? [],
    candidateScreenshot: input.copiedFiles.candidateScreenshot ?? [],
    diffScreenshot: [],
    visualDiff: `${input.artifactPathPrefix}/visual-diff.json`,
    blocksEngineVisualParity: `${input.artifactPathPrefix}/blocks-engine-visual-parity-report.json`,
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
  const blocksEngineVisualParity = blocksEngineVisualParityReportFromVisualCompare(summary)
  const summaryWithBlocksEngineVisualParity = { ...summary, blocksEngineVisualParity }
  await input.artifactSession.writeJson("visualDiff", "visual-diff.json", summaryWithBlocksEngineVisualParity)
  await input.artifactSession.writeJson("blocksEngineVisualParity", "blocks-engine-visual-parity-report.json", blocksEngineVisualParity)
  await input.artifactSession.writeJson("summary", "summary.json", summaryWithBlocksEngineVisualParity)
  return { files, summary: summaryWithBlocksEngineVisualParity }
}

async function writeVisualCompareFailureSummary(input: {
  artifactSession: BrowserArtifactSession
  artifactPathPrefix: string
  startedAt: string
  source: Record<string, unknown>
  candidate: Record<string, unknown>
  options: Record<string, unknown>
  preview: ReturnType<typeof browserPreviewRouting>
  viewport: BrowserProbeViewport | null
  message: string
  copiedFiles: Partial<{ sourceScreenshot: string; candidateScreenshot: string }>
}): Promise<{ files: { sourceScreenshot: string | string[]; candidateScreenshot: string | string[]; diffScreenshot: string | string[]; visualDiff: string; blocksEngineVisualParity: string; summary: string }; summary: VisualCompareFailureSummary & { blocksEngineVisualParity: BlocksEngineVisualParityReport } }> {
  const files = {
    sourceScreenshot: input.copiedFiles.sourceScreenshot ?? [],
    candidateScreenshot: input.copiedFiles.candidateScreenshot ?? [],
    diffScreenshot: [],
    visualDiff: `${input.artifactPathPrefix}/visual-diff.json`,
    blocksEngineVisualParity: `${input.artifactPathPrefix}/blocks-engine-visual-parity-report.json`,
    summary: `${input.artifactPathPrefix}/summary.json`,
  }
  const summary: VisualCompareFailureSummary = {
    schema: "wp-codebox/visual-compare/v1",
    command: "wordpress.visual-compare",
    status: "failed",
    partial: true,
    stage: "capture-failed",
    source: input.source,
    candidate: input.candidate,
    options: input.options,
    limitations: ["visual compare capture failed before full diff metrics were available; recovered files show any screenshots captured before failure"],
    preview: input.preview,
    viewport: input.viewport,
    startedAt: input.startedAt,
    updatedAt: now(),
    files,
    diagnostic: {
      type: "comparison-failed",
      message: input.message,
    },
  }
  const blocksEngineVisualParity = blocksEngineVisualParityReportFromVisualCompare(summary)
  const summaryWithBlocksEngineVisualParity = { ...summary, blocksEngineVisualParity }
  await input.artifactSession.writeJson("visualDiff", "visual-diff.json", summaryWithBlocksEngineVisualParity)
  await input.artifactSession.writeJson("blocksEngineVisualParity", "blocks-engine-visual-parity-report.json", blocksEngineVisualParity)
  await input.artifactSession.writeJson("summary", "summary.json", summaryWithBlocksEngineVisualParity)
  return { files, summary: summaryWithBlocksEngineVisualParity }
}

function visualCompareMissingInputArtifact(input: {
  source: Record<string, unknown>
  candidate: Record<string, unknown>
  preview: ReturnType<typeof browserPreviewRouting>
  viewport: BrowserProbeViewport | null
  files: { sourceScreenshot: string | string[]; candidateScreenshot: string | string[]; diffScreenshot: string | string[]; visualDiff: string; blocksEngineVisualParity?: string; summary: string }
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
        ...(input.files.blocksEngineVisualParity ? { blocksEngineVisualParity: input.files.blocksEngineVisualParity } : {}),
      },
      viewport: input.viewport,
    },
  }
}

function visualCompareFailureArtifact(input: {
  source: Record<string, unknown>
  candidate: Record<string, unknown>
  preview: ReturnType<typeof browserPreviewRouting>
  viewport: BrowserProbeViewport | null
  files: { sourceScreenshot: string | string[]; candidateScreenshot: string | string[]; diffScreenshot: string | string[]; visualDiff: string; blocksEngineVisualParity?: string; summary: string }
  summary: VisualCompareFailureSummary
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
      errors: 1,
      finalUrl: "",
      htmlSnapshot: false,
      networkEvents: 0,
      replayability: "artifact-backed",
      screenshot: Array.isArray(input.files.sourceScreenshot) ? input.files.sourceScreenshot.length > 0 : Boolean(input.files.sourceScreenshot),
      visualCompare: {
        status: input.summary.status,
        explanation: input.files.visualDiff,
        ...(input.files.blocksEngineVisualParity ? { blocksEngineVisualParity: input.files.blocksEngineVisualParity } : {}),
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

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
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
      blocksEngineVisualParity: "files/browser/visual-compare/blocks-engine-visual-parity-report.json",
    },
    ...(!matrixComplete ? {
      preview: entries[0]?.artifact.preview ?? browserPreviewRouting(args, runtimeSpec, server.serverUrl),
      limitations: ["visual compare matrix was interrupted or an expected input was missing before all comparisons completed; recovered comparisons contain complete per-entry evidence for finished viewports and structured diagnostics for incomplete entries"],
    } : {}),
  }
  const blocksEngineVisualParity = blocksEngineVisualParityReportFromVisualCompare(matrixSummary)
  const matrixSummaryWithBlocksEngineVisualParity = { ...matrixSummary, blocksEngineVisualParity }
  const artifactSession = new BrowserArtifactSession(artifactRoot, "files/browser/visual-compare", { source: "wordpress.visual-compare", operation: "visual-compare-matrix" })
  await artifactSession.writeJson("blocksEngineVisualParity", "blocks-engine-visual-parity-report.json", blocksEngineVisualParity)
  await artifactSession.writeJson("summary", "matrix-summary.json", matrixSummaryWithBlocksEngineVisualParity)
  return matrixSummaryWithBlocksEngineVisualParity
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

interface VisualCompareFailureSummary {
  schema: "wp-codebox/visual-compare/v1"
  command: "wordpress.visual-compare"
  status: "failed"
  partial: true
  stage: "capture-failed"
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
    type: "comparison-failed"
    message: string
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
  files: { summary: string; blocksEngineVisualParity?: string }
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
  const artifact = normalizeBrowserDomSnapshotArtifact(parsed, requestedPath, "Visual compare DOM snapshot")
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

// Abort every request whose origin differs from the live preview origin so an
// egress-free sandbox renders captured pages deterministically instead of
// hanging on unreachable external resources. Same-origin requests (the document,
// its local CSS/JS/images served by the preview server) pass through untouched.
async function installVisualCompareOfflineIsolation(page: Page, previewOrigin: string): Promise<void> {
  let allowedOrigin: string | null = null
  try {
    allowedOrigin = new URL(previewOrigin).origin
  } catch {
    allowedOrigin = null
  }
  await page.route("**/*", (route) => {
    const requestUrl = route.request().url()
    let requestOrigin: string | null = null
    try {
      requestOrigin = new URL(requestUrl).origin
    } catch {
      requestOrigin = null
    }
    // Allow same-origin (preview) and non-HTTP schemes (data:, blob:, about:).
    if (!requestUrl.startsWith("http") || (allowedOrigin && requestOrigin === allowedOrigin)) {
      void route.continue()
      return
    }
    void route.abort()
  })
}

async function captureVisualCompareUrl(page: Page, targetUrl: string, outputPath: string, waitFor: string, durationMs: number, fullPage: boolean, maxExplanationCandidates: number, explainSelectors: string[], timeoutMs: number): Promise<{ finalUrl: string; domSnapshot: VisualCompareDomSnapshot }> {
  if (waitFor === "duration") {
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs })
    if (durationMs > 0) {
      await withBrowserCommandLiveness({ command: "wordpress.visual-compare", phase: "duration", operation: page.waitForTimeout(durationMs), policy: { wallTimeoutMs: Math.min(durationMs + 1_000, timeoutMs), idleTimeoutMs: 0 } })
    }
  } else if (waitFor.startsWith("selector:")) {
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs })
    await page.waitForSelector(waitFor.slice("selector:".length), { state: "visible", timeout: timeoutMs })
    if (durationMs > 0) {
      await withBrowserCommandLiveness({ command: "wordpress.visual-compare", phase: "duration", operation: page.waitForTimeout(durationMs), policy: { wallTimeoutMs: Math.min(durationMs + 1_000, timeoutMs), idleTimeoutMs: 0 } })
    }
  } else if (waitFor === "domcontentloaded" || waitFor === "load" || waitFor === "networkidle") {
    await page.goto(targetUrl, { waitUntil: waitFor, timeout: timeoutMs })
    if (durationMs > 0) {
      await withBrowserCommandLiveness({ command: "wordpress.visual-compare", phase: "duration", operation: page.waitForTimeout(durationMs), policy: { wallTimeoutMs: Math.min(durationMs + 1_000, timeoutMs), idleTimeoutMs: 0 } })
    }
  } else {
    throw new Error(`wait-for supports domcontentloaded, load, networkidle, selector:<selector>, or duration: ${waitFor}`)
  }
  const domSnapshot = await withBrowserCommandLiveness({ command: "wordpress.visual-compare", phase: "dom-snapshot", operation: captureBrowserDomSnapshot(page, maxExplanationCandidates, explainSelectors), policy: { wallTimeoutMs: timeoutMs, idleTimeoutMs: 0 } })
  await page.screenshot({ path: outputPath, fullPage, timeout: timeoutMs })
  return { finalUrl: page.url(), domSnapshot }
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

async function fileSha256(path: string): Promise<string> {
  return sha256(await readFile(path))
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
