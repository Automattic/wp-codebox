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
  sourceElements?: VisualCompareRegionElementOverlap[]
  candidateElements?: VisualCompareRegionElementOverlap[]
}

interface VisualCompareRegionElementOverlap {
  path: string
  tag: string
  text?: string
  className?: string
  boundingBox: VisualCompareDomElementSnapshot["boundingBox"]
  overlap: { x: number; y: number; width: number; height: number; area: number; regionCoverage: number; elementCoverage: number }
  styles: Record<string, string>
}

export interface VisualCompareActionableStyleDelta {
  property: string
  source: string
  candidate: string
  category: "layout" | "typography" | "paint" | "effect"
  severity: "info" | "warning" | "error"
  hint: string
}

export interface VisualCompareSelectorDelta {
  selector: string
  sourcePath: string
  candidatePath: string
  source: { path: string; tag: string; boundingBox: VisualCompareDomElementSnapshot["boundingBox"] }
  candidate: { path: string; tag: string; boundingBox: VisualCompareDomElementSnapshot["boundingBox"] }
  boundingBox: { source: VisualCompareDomElementSnapshot["boundingBox"]; candidate: VisualCompareDomElementSnapshot["boundingBox"]; delta: { x: number; y: number; width: number; height: number }; severity: "none" | "info" | "warning" | "error"; category: "layout"; hint: string }
  styles: VisualCompareActionableStyleDelta[]
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

export type VisualCompareLayoutDriftDivergenceType = "height-delta" | "gap-delta" | "y-offset" | "added-flow-element" | "removed-flow-element" | "screenshot-only"

export interface VisualCompareLayoutDriftAnchor {
  path: string
  tag: string
  text?: string
  className?: string
  source?: VisualCompareDomElementSnapshot["boundingBox"]
  candidate?: VisualCompareDomElementSnapshot["boundingBox"]
  delta?: { y?: number; height?: number; gap?: number }
}

export interface VisualCompareLayoutDriftDivergence {
  type: VisualCompareLayoutDriftDivergenceType
  path?: string
  tag?: string
  text?: string
  className?: string
  y?: number
  previousPath?: string
  source?: VisualCompareDomElementSnapshot["boundingBox"]
  candidate?: VisualCompareDomElementSnapshot["boundingBox"]
  delta?: { y?: number; height?: number; gap?: number }
}

export interface VisualCompareLayoutDrift {
  summary: {
    compact: string
    firstDivergenceType: VisualCompareLayoutDriftDivergenceType
    matchedFlowElements: number
    addedFlowElements: number
    removedFlowElements: number
    changedFlowElements: number
    maxAbsYOffset: number
    maxAbsHeightDelta: number
    maxAbsGapDelta: number
  }
  firstDivergence: VisualCompareLayoutDriftDivergence
  anchors: VisualCompareLayoutDriftAnchor[]
}

interface VisualCompareExplanation {
  schema: "wp-codebox/visual-explanation/v1"
  source: { label: string; url: string; title: string; elementCount: number; capturedElements: number; truncated: boolean }
  candidate: { label: string; url: string; title: string; elementCount: number; capturedElements: number; truncated: boolean }
  viewport: BrowserProbeViewport | null
  mismatchRegions: VisualCompareMismatchRegion[]
  selectors?: Array<{ selector: string; source: VisualCompareSelectorSnapshot; candidate: VisualCompareSelectorSnapshot }>
  selectorDeltas?: VisualCompareSelectorDelta[]
  missingSelectors?: Array<{ selector: string; sourceMatched: boolean; candidateMatched: boolean; sourceError?: string; candidateError?: string }>
  limits: { maxElements: number; maxCandidates: number }
  truncation: { changed: boolean; added: boolean; removed: boolean }
  summary: { changedElements: number; addedElements: number; removedElements: number; sourceCapturedElements: number; candidateCapturedElements: number }
  layoutDrift?: VisualCompareLayoutDrift
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
  // Dimension-fair signals: overlap region only (the trustworthy ratio) plus the
  // canvas-size delta surfaced separately rather than smeared into mismatchRatio.
  overlapMismatchRatio?: number
  overlapMismatchPixels?: number
  overlapPixels?: number
  dimensionDeltaPixels?: number
  dimensionDeltaRatio?: number
}

interface VisualCompareComparisonSummary extends VisualCompareComparisonMetrics {
  source?: { label?: string; url?: string; screenshot?: string }
  candidate?: { label?: string; url?: string; screenshot?: string }
}

export interface VisualCompareCaptureDiagnostics {
  schema: "wp-codebox/visual-compare-capture-diagnostics/v1"
  readiness: {
    status: "ready" | "warning"
    confidence: "high" | "medium" | "low"
    afterSettle: true
    reasons: string[]
  }
  assets: {
    stylesheets: { total: number; loaded: number; pending: number; errored: number }
    images: { total: number; loaded: number; loading: number; failed: number }
    fonts: { status: string; total?: number; loaded?: number; loading?: number; error?: number }
  }
  environment: {
    url: string
    title: string
    userAgent: string
    viewport: { width: number; height: number }
    devicePixelRatio: number
    colorScheme: string
    reducedMotion: boolean
    timezone: string
  }
  dynamicContent: {
    fixed: number
    sticky: number
    video: number
    canvas: number
    iframe: number
    animated: number
    focusedElement: boolean
    focusedElementTag?: string
  }
}

export interface VisualCompareCaptureDiagnosticsCompact {
  readiness: "ready" | "warning"
  confidence: "high" | "medium" | "low"
  reasons: string[]
  assets: {
    stylesheets: { total: number; pending: number; errored: number }
    images: { total: number; loading: number; failed: number }
    fonts: { status: string; loading?: number; error?: number }
  }
  dynamicContent: VisualCompareCaptureDiagnostics["dynamicContent"]
  environment: Pick<VisualCompareCaptureDiagnostics["environment"], "url" | "viewport" | "devicePixelRatio" | "colorScheme" | "reducedMotion">
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
    overlapMismatchRatio?: { baseline: number; current: number; absoluteDelta: number; percentDelta?: number }
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
  visual_diff?: { available: boolean; mismatch_percent?: number; mismatch_pixels?: number; total_pixels?: number; overlap_mismatch_percent?: number; overlap_mismatch_pixels?: number; overlap_pixels?: number; dimension_delta_pixels?: number; threshold?: number; diff_screenshot_path?: string; by_viewport?: Array<{ viewport_id: string; mismatch_percent?: number; overlap_mismatch_percent?: number; mismatch_pixels?: number; diff_screenshot_path?: string }> }
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
  captureDiagnostics?: { source?: VisualCompareCaptureDiagnostics; candidate?: VisualCompareCaptureDiagnostics }
  explanation?: VisualCompareExplanation
  comparisons?: Array<{ name: string; status?: string; source?: Record<string, unknown>; candidate?: Record<string, unknown>; viewport?: BrowserProbeViewport | null; files?: Record<string, unknown>; captureDiagnostics?: { source?: VisualCompareCaptureDiagnostics; candidate?: VisualCompareCaptureDiagnostics }; comparison?: VisualCompareComparisonMetrics }>
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
  const computedStyleDeltas = blocksEngineComputedStyleDeltas(input.explanation?.selectorDeltas, fallbackViewport[0]?.id)

  return {
    schema: "blocks-engine/php-transformer/visual-parity-report/v1",
    status,
    severity,
    source_render: blocksEngineVisualParityRender("source", input.source, stringFileRef(sourceScreenshot)),
    target_render: blocksEngineVisualParityRender("target", input.candidate, stringFileRef(targetScreenshot)),
    viewports: fallbackViewport,
    matches,
    ...(computedStyleDeltas.length > 0 ? { computed_style_deltas: computedStyleDeltas } : {}),
    visual_diff: {
      available: completeComparisons.length > 0,
      ...(typeof input.comparison?.mismatchRatio === "number" ? { mismatch_percent: input.comparison.mismatchRatio * 100 } : {}),
      ...(typeof input.comparison?.mismatchPixels === "number" ? { mismatch_pixels: input.comparison.mismatchPixels } : {}),
      ...(typeof input.comparison?.totalPixels === "number" ? { total_pixels: input.comparison.totalPixels } : {}),
      ...(typeof input.comparison?.overlapMismatchRatio === "number" ? { overlap_mismatch_percent: input.comparison.overlapMismatchRatio * 100 } : {}),
      ...(typeof input.comparison?.overlapMismatchPixels === "number" ? { overlap_mismatch_pixels: input.comparison.overlapMismatchPixels } : {}),
      ...(typeof input.comparison?.overlapPixels === "number" ? { overlap_pixels: input.comparison.overlapPixels } : {}),
      ...(typeof input.comparison?.dimensionDeltaPixels === "number" ? { dimension_delta_pixels: input.comparison.dimensionDeltaPixels } : {}),
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
      ...(input.captureDiagnostics ? { capture_diagnostics: visualCompareCompactCaptureDiagnostics(input.captureDiagnostics) } : {}),
    },
  }
}

function blocksEngineComputedStyleDeltas(selectorDeltas: VisualCompareSelectorDelta[] | undefined, viewportId?: string): NonNullable<BlocksEngineVisualParityReport["computed_style_deltas"]> {
  return (selectorDeltas ?? []).flatMap((selectorDelta) => {
    const common = {
      ...(viewportId ? { viewport_id: viewportId } : {}),
      source_selector: selectorDelta.selector,
      target_selector: selectorDelta.selector,
    }
    const deltas: NonNullable<BlocksEngineVisualParityReport["computed_style_deltas"]> = []
    if (selectorDelta.boundingBox.severity !== "none") {
      deltas.push({
        property: "bounding-box",
        severity: selectorDelta.boundingBox.severity,
        ...common,
        source_value: selectorDelta.boundingBox.source,
        target_value: selectorDelta.boundingBox.candidate,
        delta: { ...selectorDelta.boundingBox.delta, category: selectorDelta.boundingBox.category, hint: selectorDelta.boundingBox.hint },
      })
    }
    for (const style of selectorDelta.styles) {
      deltas.push({
        property: style.property,
        severity: style.severity,
        ...common,
        source_value: style.source,
        target_value: style.candidate,
        delta: { category: style.category, hint: style.hint },
      })
    }
    return deltas
  })
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
    ...(typeof input.comparison.overlapMismatchRatio === "number" ? { overlap_mismatch_percent: input.comparison.overlapMismatchRatio * 100 } : {}),
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
  const maxFullPageHeight = positiveIntegerArg(args, "max-full-page-height", VISUAL_COMPARE_MAX_FULL_PAGE_HEIGHT_PX)
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
  let captureDiagnostics: { source?: VisualCompareCaptureDiagnostics; candidate?: VisualCompareCaptureDiagnostics } | undefined
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
      options: { waitFor, durationMs, timeoutMs: visualTimeoutMs, fullPage, maxFullPageHeight, threshold, includeAA, maxRegions, maxExplanationElements, maxExplanationCandidates, ...(explainSelectors.length > 0 ? { explainSelectors } : {}) },
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
      // Determinism applies to BOTH source and candidate: the init script runs on
      // every navigation of this shared page, so source and candidate are captured
      // under identical reveal/animation conditions.
      await installVisualCompareDeterministicReveal(page)
      viewport = await browserProbeViewport(page)
      try {
        let sourceCapture: Awaited<ReturnType<typeof captureVisualCompareUrl>> | undefined
        await artifactSession.writeGenerated("sourceScreenshot", "source.png", async (path) => {
          sourceCapture = await withBrowserCommandLiveness({
            command: "wordpress.visual-compare",
            phase: "source-capture",
            operation: captureVisualCompareUrl(page, sourceTargetUrl, path, waitFor, durationMs, fullPage, maxFullPageHeight, maxExplanationCandidates, explainSelectors, visualTimeoutMs),
            policy: { wallTimeoutMs: visualTimeoutMs, idleTimeoutMs: 0 },
          })
        })
        if (!sourceCapture) {
          throw new Error("wordpress.visual-compare did not produce source capture")
        }
        finalSourceUrl = sourceCapture.finalUrl
        sourceDomSnapshot = sourceCapture.domSnapshot
        const sourceCaptureDiagnostics = sourceCapture.captureDiagnostics
        await writePartialSummary("source-captured")
        let candidateCapture: Awaited<ReturnType<typeof captureVisualCompareUrl>> | undefined
        await artifactSession.writeGenerated("candidateScreenshot", "candidate.png", async (path) => {
          candidateCapture = await withBrowserCommandLiveness({
            command: "wordpress.visual-compare",
            phase: "candidate-capture",
            operation: captureVisualCompareUrl(page, candidateTargetUrl, path, waitFor, durationMs, fullPage, maxFullPageHeight, maxExplanationCandidates, explainSelectors, visualTimeoutMs),
            policy: { wallTimeoutMs: visualTimeoutMs, idleTimeoutMs: 0 },
          })
        })
        if (!candidateCapture) {
          throw new Error("wordpress.visual-compare did not produce candidate capture")
        }
        finalCandidateUrl = candidateCapture.finalUrl
        candidateDomSnapshot = candidateCapture.domSnapshot
        const candidateCaptureDiagnostics = candidateCapture.captureDiagnostics
        captureDiagnostics = { source: sourceCaptureDiagnostics, candidate: candidateCaptureDiagnostics }
        await writePartialSummary("candidate-captured")
      } catch (error) {
        const result = await writeVisualCompareFailureSummary({
          artifactSession,
          artifactPathPrefix,
          startedAt,
          source: sourceSummary(),
          candidate: candidateSummary(),
          options: { waitFor, durationMs, timeoutMs: visualTimeoutMs, fullPage, maxFullPageHeight, threshold, includeAA, maxRegions, maxExplanationElements, maxExplanationCandidates, ...(explainSelectors.length > 0 ? { explainSelectors } : {}) },
          preview,
          viewport,
          message: visualCompareErrorDetail(error),
          copiedFiles: {
            ...(await fileExists(sourcePath) ? { sourceScreenshot: `${artifactPathPrefix}/source.png` } : {}),
            ...(await fileExists(candidatePath) ? { candidateScreenshot: `${artifactPathPrefix}/candidate.png` } : {}),
          },
        })
        throw new BrowserCommandArtifactError(`wordpress.visual-compare failed during capture: ${visualCompareErrorDetail(error)}`, visualCompareFailureArtifact({ source: sourceSummary(), candidate: candidateSummary(), preview, viewport, files: result.files, summary: result.summary }))
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
        options: { waitFor, durationMs, timeoutMs: visualTimeoutMs, fullPage, maxFullPageHeight, threshold, includeAA, maxRegions, maxExplanationElements, maxExplanationCandidates, ...(explainSelectors.length > 0 ? { explainSelectors } : {}) },
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
    options: { waitFor, durationMs, timeoutMs: visualTimeoutMs, fullPage, maxFullPageHeight, threshold, includeAA, maxRegions, maxExplanationElements, maxExplanationCandidates, ...(explainSelectors.length > 0 ? { explainSelectors } : {}) },
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
    ...(captureDiagnostics ? { captureDiagnostics } : {}),
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
        overlapMismatchRatio: comparison.overlapMismatchRatio,
        overlapMismatchPixels: comparison.overlapMismatchPixels,
        overlapPixels: comparison.overlapPixels,
        dimensionDeltaPixels: comparison.dimensionDeltaPixels,
        dimensionDeltaRatio: comparison.dimensionDeltaRatio,
        dimensionMismatch: comparison.dimensionMismatch,
        ...(captureDiagnostics ? { captureDiagnostics: visualCompareCompactCaptureDiagnostics(captureDiagnostics) } : {}),
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
  const captureDiagnostics = visualCompareMatrixCompactCaptureDiagnostics(matrixSummary)
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
        overlapMismatchRatio: matrixSummary.metrics.maxOverlapMismatchRatio,
        dimensionMismatch: matrixSummary.comparisons.some((entry) => entry.comparison?.dimensionMismatch === true),
        ...(captureDiagnostics ? { captureDiagnostics } : {}),
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
    ...(entry.summary.captureDiagnostics ? { captureDiagnostics: entry.summary.captureDiagnostics } : {}),
    comparison: entry.summary.comparison,
  }))
  const allComparisons = [...comparisons, ...failedEntries]
  const mismatchRatios = comparisons.map((entry) => entry.comparison.mismatchRatio)
  const mismatchPixels = comparisons.map((entry) => entry.comparison.mismatchPixels)
  const overlapMismatchRatios = comparisons.map((entry) => entry.comparison.overlapMismatchRatio).filter((value): value is number => typeof value === "number")
  const maxMismatchRatio = mismatchRatios.length > 0 ? Math.max(...mismatchRatios) : 0
  const maxMismatchPixels = mismatchPixels.length > 0 ? Math.max(...mismatchPixels) : 0
  const maxOverlapMismatchRatio = overlapMismatchRatios.length > 0 ? Math.max(...overlapMismatchRatios) : 0
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
      maxOverlapMismatchRatio,
      meanOverlapMismatchRatio: overlapMismatchRatios.length > 0 ? overlapMismatchRatios.reduce((total, value) => total + value, 0) / overlapMismatchRatios.length : 0,
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
  captureDiagnostics?: { source?: VisualCompareCaptureDiagnostics; candidate?: VisualCompareCaptureDiagnostics }
  comparison: { mismatchRatio: number; mismatchPixels: number; totalPixels: number; dimensionMismatch: boolean; overlapMismatchRatio?: number; overlapMismatchPixels?: number; overlapPixels?: number; dimensionDeltaPixels?: number; dimensionDeltaRatio?: number }
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
    maxOverlapMismatchRatio: number
    meanOverlapMismatchRatio: number
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
    captureDiagnostics?: VisualComparePairSummary["captureDiagnostics"]
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
  if (typeof baseline.overlapMismatchRatio === "number" && typeof currentComparison.overlapMismatchRatio === "number") {
    delta.overlapMismatchRatio = visualCompareNumericDelta(baseline.overlapMismatchRatio, currentComparison.overlapMismatchRatio)
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
  const overlapMismatchRatio = typeof record.overlapMismatchRatio === "number" ? record.overlapMismatchRatio : undefined
  const overlapMismatchPixels = typeof record.overlapMismatchPixels === "number" ? record.overlapMismatchPixels : undefined
  const overlapPixels = typeof record.overlapPixels === "number" ? record.overlapPixels : undefined
  const dimensionMismatch = typeof record.dimensionMismatch === "boolean" ? record.dimensionMismatch : undefined
  if (!status && mismatchRatio === undefined && mismatchPixels === undefined && totalPixels === undefined && dimensionMismatch === undefined && overlapMismatchRatio === undefined) {
    return undefined
  }
  return { status, mismatchRatio, mismatchPixels, totalPixels, overlapMismatchRatio, overlapMismatchPixels, overlapPixels, dimensionMismatch }
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
  await page.route("**/*", (route) => {
    if (visualCompareOfflineRequestAllowed(route.request().url(), previewOrigin)) {
      void route.continue()
      return
    }
    void route.abort()
  })
}

export function visualCompareOfflineRequestAllowed(requestUrl: string, previewOrigin: string): boolean {
  let request: URL
  try {
    request = new URL(requestUrl)
  } catch {
    return true
  }
  if (request.protocol !== "http:" && request.protocol !== "https:") {
    return true
  }

  try {
    if (request.origin === new URL(previewOrigin).origin) {
      return true
    }
  } catch {
    // Ignore malformed preview origins and fall through to loopback allowance.
  }

  return isLoopbackHostname(request.hostname)
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return normalized === "localhost" || normalized === "::1" || normalized === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(normalized)
}

// A static full-page screenshot never scrolls the document, so any content gated
// behind a scroll/IntersectionObserver entrance reveal (a near-universal pattern,
// e.g. `.reveal { opacity: 0 }` toggled to a visible class once the element enters
// the viewport) stays at its hidden initial state below the fold. The imported
// WordPress candidate typically renders that content statically visible (the reveal
// scripts/styles are not carried through the transform), so comparing a scroll-gated
// source against a static candidate counts the entire below-the-fold region as a
// false pixel diff that has nothing to do with real visual parity.
//
// Programmatic scrolling alone is an unreliable trigger under headless capture
// (IntersectionObserver delivery is throttled/batched and frequently fires for only
// a fraction of off-screen elements), so this stubs `IntersectionObserver` via an
// init script that runs before any page script: every observed element is reported
// as intersecting on the next microtask. That deterministically drives the page's
// OWN reveal logic for ALL elements regardless of scroll position, with no
// fixture-specific selectors or class names. The init script persists across this
// shared page's navigations, so source and candidate are treated identically; on a
// page with no IntersectionObserver-gated reveals it is a harmless no-op.
async function installVisualCompareDeterministicReveal(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const NativeIntersectionObserver = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver
    if (typeof NativeIntersectionObserver !== "function") {
      return
    }
    class ImmediateIntersectionObserver {
      private readonly callback: (entries: unknown[], observer: unknown) => void
      constructor(callback: (entries: unknown[], observer: unknown) => void) {
        this.callback = callback
      }
      observe(target: Element): void {
        const rect = typeof target.getBoundingClientRect === "function" ? target.getBoundingClientRect() : ({} as DOMRect)
        const entry = {
          target,
          isIntersecting: true,
          intersectionRatio: 1,
          boundingClientRect: rect,
          intersectionRect: rect,
          rootBounds: null,
          time: 0,
        }
        Promise.resolve().then(() => {
          try {
            this.callback([entry], this)
          } catch {
            // Ignore reveal-callback errors so capture stays deterministic.
          }
        })
      }
      unobserve(): void {}
      disconnect(): void {}
      takeRecords(): unknown[] {
        return []
      }
    }
    try {
      ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = ImmediateIntersectionObserver
    } catch {
      // If the global is read-only, leave the native observer in place.
    }
  })
}

// Complements the IntersectionObserver reveal trigger by walking the full document
// height before capture. This drives genuine scroll-position-driven effects (lazy
// media, sticky headers) and lets any triggered reveals settle, then returns to the
// origin so the full-page capture is deterministic. Bounded by a guard so it can
// never loop. Applied IDENTICALLY to source and candidate.
async function settleVisualComparePageForCapture(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()))
    const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
    const documentHeight = (): number => Math.max(
      document.body?.scrollHeight ?? 0,
      document.body?.offsetHeight ?? 0,
      document.documentElement?.scrollHeight ?? 0,
      document.documentElement?.offsetHeight ?? 0,
      document.documentElement?.clientHeight ?? 0,
    )
    const viewportHeight = Math.max(1, window.innerHeight || document.documentElement?.clientHeight || 1)
    const step = Math.max(1, Math.floor(viewportHeight * 0.8))
    let position = 0
    let guard = 0
    // Walk the full document height in viewport-sized steps, pausing for a frame at
    // each so IntersectionObserver callbacks (and lazy content) fire as they would
    // under a real scroll. `documentHeight()` is re-read each iteration because
    // reveals can grow the page.
    while (position < documentHeight() - viewportHeight && guard < 2000) {
      position += step
      window.scrollTo(0, position)
      await nextFrame()
      await sleep(16)
      guard += 1
    }
    window.scrollTo(0, documentHeight())
    await nextFrame()
    await sleep(32)
    // Return to the origin so the full-page screenshot starts from a deterministic
    // top-of-document position regardless of how far the reveal walk scrolled.
    window.scrollTo(0, 0)
    await nextFrame()
    await sleep(16)
  })
}

async function waitForVisualComparePaintReady(page: Page, timeoutMs: number): Promise<void> {
  const readinessTimeoutMs = Math.max(1_000, Math.min(10_000, timeoutMs))
  await page.waitForLoadState("load", { timeout: readinessTimeoutMs }).catch(() => undefined)
  await page.evaluate(async (timeout) => {
    const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
    const until = Date.now() + timeout

    const stylesheetLinks = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"]'))
      .filter((link) => !link.disabled && Boolean(link.href))
    await Promise.all(stylesheetLinks.map(async (link) => {
      while (!link.sheet && Date.now() < until) {
        await Promise.race([
          new Promise<void>((resolve) => {
            link.addEventListener("load", () => resolve(), { once: true })
            link.addEventListener("error", () => resolve(), { once: true })
          }),
          sleep(100),
        ])
      }
    }))

    await (document as Document & { fonts?: { ready?: Promise<unknown> } }).fonts?.ready?.catch(() => undefined)

    const images = Array.from(document.images).filter((image) => !image.complete)
    await Promise.all(images.map(async (image) => {
      if (typeof image.decode === "function") {
        await image.decode().catch(() => undefined)
        return
      }
      if (image.complete) {
        return
      }
      await Promise.race([
        new Promise<void>((resolve) => {
          image.addEventListener("load", () => resolve(), { once: true })
          image.addEventListener("error", () => resolve(), { once: true })
        }),
        sleep(Math.max(0, until - Date.now())),
      ])
    }))

    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  }, readinessTimeoutMs).catch(() => undefined)
}

export interface VisualCompareNavigationPolicy {
  attempts: number
  navigationBudgetMs: number
  perAttemptTimeoutMs: number
}

export function visualCompareNavigationPolicy(wallTimeoutMs: number): VisualCompareNavigationPolicy {
  const normalizedWallTimeoutMs = Number.isFinite(wallTimeoutMs) && wallTimeoutMs > 0 ? wallTimeoutMs : browserCommandLivenessPolicy().wallTimeoutMs
  const attempts = 2
  const navigationBudgetMs = Math.max(10_000, Math.min(Math.floor(normalizedWallTimeoutMs / 2), 60_000))
  return {
    attempts,
    navigationBudgetMs,
    perAttemptTimeoutMs: Math.max(5_000, Math.floor(navigationBudgetMs / attempts)),
  }
}

// Navigate with a bounded per-attempt timeout and one transient-failure retry.
//
// The fixture-matrix source page is served by the SAME in-sandbox WordPress origin
// as the candidate (rigs #565 staged it into the uploads path, fixing the original
// "unserved path" hang). The residual reliability problem is transient resource
// contention: a disposable sandbox running Playground + a headless browser can be
// slow to serve the first byte of a large staged page under load, and a single
// `page.goto` allowed to consume the entire 120s wall surfaces as an opaque
// `source-capture exceeded 120000ms`. Capping each attempt well under the wall and
// retrying once turns a transient slow first response into a clean recovery while
// still failing loudly (re-throwing the last error) when serving is genuinely
// broken — it does not mask a real serving bug. External resources are already
// blocked (`block-external-requests`), so navigation never waits on unreachable
// hosts regardless of `waitFor`.
async function gotoVisualCompareTarget(page: Page, targetUrl: string, waitUntil: "domcontentloaded" | "load" | "networkidle", wallTimeoutMs: number): Promise<void> {
  // Reserve roughly half the wall for navigation, capped well below the overall
  // visual-compare wall so a bad candidate route cannot consume the full 120s
  // capture window before producing diagnostics.
  const policy = visualCompareNavigationPolicy(wallTimeoutMs)
  let lastError: unknown
  for (let attempt = 1; attempt <= policy.attempts; attempt += 1) {
    try {
      await page.goto(targetUrl, { waitUntil, timeout: policy.perAttemptTimeoutMs })
      return
    } catch (error) {
      lastError = error
      if (attempt >= policy.attempts) {
        break
      }
    }
  }
  const wrapped = new Error(`wordpress.visual-compare navigation failed for ${targetUrl} after ${policy.attempts} attempt(s) with ${policy.perAttemptTimeoutMs}ms per attempt (waitUntil=${waitUntil}): ${visualCompareErrorDetail(lastError)}`)
  ;(wrapped as Error & { cause?: unknown }).cause = lastError
  throw wrapped
}

// A full-page screenshot of a very tall document forces the renderer to allocate a
// single backing bitmap covering the ENTIRE scroll height (width × height × 4 bytes).
// For pathologically tall pages (tens of thousands of px) that bitmap alone is hundreds
// of MB and the capture can crash/close the renderer target — historically surfacing as
// an opaque, empty screenshot failure. Clamp the captured height to a documented cap,
// applied IDENTICALLY to source and candidate so the dimension-fair overlap semantics
// (both renders anchored at the document origin, cropped to the shared min height) are
// preserved. Normal 5–6k px pages render far below the cap and are unaffected.
const VISUAL_COMPARE_MAX_FULL_PAGE_HEIGHT_PX = 20_000

// errorMessage() returns an empty string when a thrown Error carries no message — which
// is exactly what a crashed/closed renderer target tends to produce — and previously
// surfaced as an opaque empty `capture-failed` diagnostic with no actionable signal.
// Always produce a non-empty, descriptive detail so the failure summary names a real
// cause.
export function visualCompareErrorDetail(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message?.trim()
    if (message) {
      return message
    }
    const name = error.name?.trim()
    return name ? `${name} (no message)` : "Error (no message)"
  }
  if (error === undefined) {
    return "unknown error (undefined)"
  }
  if (error === null) {
    return "unknown error (null)"
  }
  const text = String(error).trim()
  return text || "unknown error"
}

// Take the page screenshot with a bounded per-attempt timeout, one transient-failure
// retry, an always-non-empty error on final failure, and a height clamp for
// pathologically tall pages. The clamp computes the document content size and, when it
// exceeds the cap, captures a top-anchored `clip` of the full content width × capped
// height instead of a `fullPage` capture — identical treatment for source and candidate.
async function captureVisualComparePageScreenshot(page: Page, outputPath: string, options: { fullPage: boolean; timeoutMs: number; maxFullPageHeightPx: number }): Promise<void> {
  let clamp: { width: number; height: number; fullHeight: number } | undefined
  if (options.fullPage && options.maxFullPageHeightPx > 0) {
    const metrics = await page.evaluate(() => ({
      width: Math.max(document.documentElement?.scrollWidth ?? 0, document.body?.scrollWidth ?? 0, window.innerWidth || 0, 1),
      height: Math.max(document.documentElement?.scrollHeight ?? 0, document.body?.scrollHeight ?? 0, window.innerHeight || 0, 1),
    }))
    if (metrics.height > options.maxFullPageHeightPx) {
      clamp = { width: Math.max(1, Math.round(metrics.width)), height: options.maxFullPageHeightPx, fullHeight: Math.round(metrics.height) }
    }
  }

  const attempts = 2
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      if (clamp) {
        await page.screenshot({ path: outputPath, fullPage: false, clip: { x: 0, y: 0, width: clamp.width, height: clamp.height }, timeout: options.timeoutMs, animations: "disabled" })
      } else {
        await page.screenshot({ path: outputPath, fullPage: options.fullPage, timeout: options.timeoutMs, animations: "disabled" })
      }
      return
    } catch (error) {
      lastError = error
      if (attempt >= attempts) {
        break
      }
    }
  }
  const where = clamp ? ` (clamped ${clamp.width}x${clamp.height} of full height ${clamp.fullHeight})` : options.fullPage ? " (full-page)" : ""
  throw new Error(`wordpress.visual-compare screenshot failed after ${attempts} attempt(s)${where}: ${visualCompareErrorDetail(lastError)}`)
}

export function visualCompareCaptureReadiness(input: Pick<VisualCompareCaptureDiagnostics, "assets" | "dynamicContent">): VisualCompareCaptureDiagnostics["readiness"] {
  const reasons: string[] = []
  if (input.assets.stylesheets.pending > 0) {
    reasons.push(`${input.assets.stylesheets.pending} stylesheet(s) still pending`)
  }
  if (input.assets.stylesheets.errored > 0) {
    reasons.push(`${input.assets.stylesheets.errored} stylesheet(s) errored`)
  }
  if (input.assets.images.loading > 0) {
    reasons.push(`${input.assets.images.loading} image(s) still loading`)
  }
  if (input.assets.images.failed > 0) {
    reasons.push(`${input.assets.images.failed} image(s) failed`)
  }
  if (input.assets.fonts.status && input.assets.fonts.status !== "loaded") {
    reasons.push(`fonts status is ${input.assets.fonts.status}`)
  }
  if ((input.assets.fonts.loading ?? 0) > 0) {
    reasons.push(`${input.assets.fonts.loading} font face(s) still loading`)
  }
  if ((input.assets.fonts.error ?? 0) > 0) {
    reasons.push(`${input.assets.fonts.error} font face(s) errored`)
  }

  const noise = input.dynamicContent.animated + input.dynamicContent.video + input.dynamicContent.canvas + input.dynamicContent.iframe
  if (noise > 0) {
    reasons.push(`${noise} dynamic/noisy element(s) present`)
  }
  if (input.dynamicContent.focusedElement) {
    reasons.push("focused element present")
  }

  return {
    status: reasons.length === 0 ? "ready" : "warning",
    confidence: reasons.length === 0 ? "high" : reasons.length <= 2 ? "medium" : "low",
    afterSettle: true,
    reasons,
  }
}

export function visualCompareCompactCaptureDiagnostics(input: { source?: VisualCompareCaptureDiagnostics; candidate?: VisualCompareCaptureDiagnostics }): { source?: VisualCompareCaptureDiagnosticsCompact; candidate?: VisualCompareCaptureDiagnosticsCompact } {
  return {
    ...(input.source ? { source: visualCompareCompactCaptureDiagnostic(input.source) } : {}),
    ...(input.candidate ? { candidate: visualCompareCompactCaptureDiagnostic(input.candidate) } : {}),
  }
}

function visualCompareCompactCaptureDiagnostic(input: VisualCompareCaptureDiagnostics): VisualCompareCaptureDiagnosticsCompact {
  return {
    readiness: input.readiness.status,
    confidence: input.readiness.confidence,
    reasons: input.readiness.reasons,
    assets: {
      stylesheets: { total: input.assets.stylesheets.total, pending: input.assets.stylesheets.pending, errored: input.assets.stylesheets.errored },
      images: { total: input.assets.images.total, loading: input.assets.images.loading, failed: input.assets.images.failed },
      fonts: { status: input.assets.fonts.status, ...(input.assets.fonts.loading !== undefined ? { loading: input.assets.fonts.loading } : {}), ...(input.assets.fonts.error !== undefined ? { error: input.assets.fonts.error } : {}) },
    },
    dynamicContent: input.dynamicContent,
    environment: {
      url: input.environment.url,
      viewport: input.environment.viewport,
      devicePixelRatio: input.environment.devicePixelRatio,
      colorScheme: input.environment.colorScheme,
      reducedMotion: input.environment.reducedMotion,
    },
  }
}

function visualCompareMatrixCompactCaptureDiagnostics(input: VisualCompareMatrixSummary): { comparisons: Array<{ name: string; source?: VisualCompareCaptureDiagnosticsCompact; candidate?: VisualCompareCaptureDiagnosticsCompact }> } | undefined {
  const comparisons = input.comparisons
    .filter((comparison) => comparison.captureDiagnostics)
    .map((comparison) => ({ name: comparison.name, ...visualCompareCompactCaptureDiagnostics(comparison.captureDiagnostics ?? {}) }))
  return comparisons.length > 0 ? { comparisons } : undefined
}

async function captureVisualCompareDiagnostics(page: Page): Promise<VisualCompareCaptureDiagnostics> {
  const diagnostics = await page.evaluate(() => {
    const stylesheetLinks = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"]')).filter((link) => !link.disabled && Boolean(link.href))
    const stylesheetStatus = stylesheetLinks.map((link) => {
      const resource = performance.getEntriesByName(link.href).at(-1) as PerformanceResourceTiming | undefined
      const loaded = Boolean(link.sheet)
      const errored = !loaded && resource !== undefined && resource.transferSize === 0 && resource.decodedBodySize === 0
      return { loaded, errored }
    })
    const images = Array.from(document.images)
    const fontSet = (document as Document & { fonts?: FontFaceSet }).fonts
    const fontFaces = fontSet ? Array.from(fontSet) : []
    const elements = Array.from(document.querySelectorAll<HTMLElement>("body *"))
    const positionCounts = elements.reduce((counts, element) => {
      const position = getComputedStyle(element).position
      if (position === "fixed") {
        counts.fixed += 1
      } else if (position === "sticky") {
        counts.sticky += 1
      }
      return counts
    }, { fixed: 0, sticky: 0 })
    const animatedTargets = new Set<Element>()
    const documentWithSubtreeAnimations = document as Document & { getAnimations(options?: { subtree?: boolean }): Animation[] }
    for (const animation of documentWithSubtreeAnimations.getAnimations({ subtree: true })) {
      const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null
      if (target instanceof Element) {
        animatedTargets.add(target)
      }
    }
    const active = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
    const colorScheme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"

    return {
      schema: "wp-codebox/visual-compare-capture-diagnostics/v1" as const,
      assets: {
        stylesheets: {
          total: stylesheetStatus.length,
          loaded: stylesheetStatus.filter((item) => item.loaded).length,
          pending: stylesheetStatus.filter((item) => !item.loaded && !item.errored).length,
          errored: stylesheetStatus.filter((item) => item.errored).length,
        },
        images: {
          total: images.length,
          loaded: images.filter((image) => image.complete && image.naturalWidth > 0).length,
          loading: images.filter((image) => !image.complete).length,
          failed: images.filter((image) => image.complete && image.naturalWidth === 0).length,
        },
        fonts: {
          status: fontSet?.status ?? "unavailable",
          ...(fontSet ? { total: fontFaces.length, loaded: fontFaces.filter((font) => font.status === "loaded").length, loading: fontFaces.filter((font) => font.status === "loading").length, error: fontFaces.filter((font) => font.status === "error").length } : {}),
        },
      },
      environment: {
        url: location.href,
        title: document.title,
        userAgent: navigator.userAgent,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        devicePixelRatio: window.devicePixelRatio || 1,
        colorScheme,
        reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown",
      },
      dynamicContent: {
        fixed: positionCounts.fixed,
        sticky: positionCounts.sticky,
        video: document.querySelectorAll("video").length,
        canvas: document.querySelectorAll("canvas").length,
        iframe: document.querySelectorAll("iframe").length,
        animated: animatedTargets.size,
        focusedElement: Boolean(active),
        ...(active ? { focusedElementTag: active.tagName.toLowerCase() } : {}),
      },
    }
  })
  return { ...diagnostics, readiness: visualCompareCaptureReadiness(diagnostics) }
}

async function captureVisualCompareUrl(page: Page, targetUrl: string, outputPath: string, waitFor: string, durationMs: number, fullPage: boolean, maxFullPageHeight: number, maxExplanationCandidates: number, explainSelectors: string[], timeoutMs: number): Promise<{ finalUrl: string; domSnapshot: VisualCompareDomSnapshot; captureDiagnostics: VisualCompareCaptureDiagnostics }> {
  if (waitFor === "duration") {
    await gotoVisualCompareTarget(page, targetUrl, "domcontentloaded", timeoutMs)
    if (durationMs > 0) {
      await withBrowserCommandLiveness({ command: "wordpress.visual-compare", phase: "duration", operation: page.waitForTimeout(durationMs), policy: { wallTimeoutMs: Math.min(durationMs + 1_000, timeoutMs), idleTimeoutMs: 0 } })
    }
  } else if (waitFor.startsWith("selector:")) {
    await gotoVisualCompareTarget(page, targetUrl, "domcontentloaded", timeoutMs)
    await page.waitForSelector(waitFor.slice("selector:".length), { state: "visible", timeout: timeoutMs })
    if (durationMs > 0) {
      await withBrowserCommandLiveness({ command: "wordpress.visual-compare", phase: "duration", operation: page.waitForTimeout(durationMs), policy: { wallTimeoutMs: Math.min(durationMs + 1_000, timeoutMs), idleTimeoutMs: 0 } })
    }
  } else if (waitFor === "domcontentloaded" || waitFor === "load" || waitFor === "networkidle") {
    await gotoVisualCompareTarget(page, targetUrl, waitFor, timeoutMs)
    if (durationMs > 0) {
      await withBrowserCommandLiveness({ command: "wordpress.visual-compare", phase: "duration", operation: page.waitForTimeout(durationMs), policy: { wallTimeoutMs: Math.min(durationMs + 1_000, timeoutMs), idleTimeoutMs: 0 } })
    }
  } else {
    throw new Error(`wait-for supports domcontentloaded, load, networkidle, selector:<selector>, or duration: ${waitFor}`)
  }
  await withBrowserCommandLiveness({ command: "wordpress.visual-compare", phase: "paint-ready", operation: waitForVisualComparePaintReady(page, timeoutMs), policy: { wallTimeoutMs: timeoutMs, idleTimeoutMs: 0 } })
  // Settle scroll/IntersectionObserver-gated entrance reveals before snapshotting
  // so both the DOM snapshot (computed styles) and the pixel screenshot reflect the
  // fully-revealed page state. Identical treatment for source and candidate.
  await withBrowserCommandLiveness({ command: "wordpress.visual-compare", phase: "settle", operation: settleVisualComparePageForCapture(page), policy: { wallTimeoutMs: timeoutMs, idleTimeoutMs: 0 } })
  const captureDiagnostics = await withBrowserCommandLiveness({ command: "wordpress.visual-compare", phase: "capture-diagnostics", operation: captureVisualCompareDiagnostics(page), policy: { wallTimeoutMs: timeoutMs, idleTimeoutMs: 0 } })
  const domSnapshot = await withBrowserCommandLiveness({ command: "wordpress.visual-compare", phase: "dom-snapshot", operation: captureBrowserDomSnapshot(page, maxExplanationCandidates, explainSelectors), policy: { wallTimeoutMs: timeoutMs, idleTimeoutMs: 0 } })
  // `animations: "disabled"` fast-forwards finite CSS/Web animations and transitions
  // to their final state and freezes infinite ones to a deterministic frame, so the
  // capture does not depend on transition timing. Applied to both sides equally.
  await captureVisualComparePageScreenshot(page, outputPath, { fullPage, timeoutMs, maxFullPageHeightPx: maxFullPageHeight })
  return { finalUrl: page.url(), domSnapshot, captureDiagnostics }
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
  const selectorDeltas = visualCompareSelectorDeltas(source.selectors, candidate.selectors, source.capturedElements, candidate.capturedElements, explainSelectors)
  const layoutDrift = visualCompareLayoutDrift(source.capturedElements, candidate.capturedElements, comparison.mismatchPixels > 0 || comparison.dimensionMismatch)
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
    mismatchRegions: visualCompareExplainRegions(comparison.regions, source.capturedElements, candidate.capturedElements),
    ...(selectorSummary.selectors.length > 0 ? { selectors: selectorSummary.selectors } : {}),
    ...(selectorDeltas.length > 0 ? { selectorDeltas } : {}),
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
    ...(layoutDrift ? { layoutDrift } : {}),
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

export function visualCompareSelectorDeltas(sourceSelectors: VisualCompareSelectorSnapshot[] | undefined, candidateSelectors: VisualCompareSelectorSnapshot[] | undefined, sourceElements: VisualCompareDomElementSnapshot[], candidateElements: VisualCompareDomElementSnapshot[], requestedSelectors: string[] = []): VisualCompareSelectorDelta[] {
  const sourceBySelector = new Map((sourceSelectors ?? []).map((item) => [item.selector, item]))
  const candidateBySelector = new Map((candidateSelectors ?? []).map((item) => [item.selector, item]))
  const sourceByPath = new Map(sourceElements.map((element) => [element.path, element]))
  const candidateByPath = new Map(candidateElements.map((element) => [element.path, element]))

  return [...new Set(requestedSelectors)].flatMap((selector) => {
    const source = sourceBySelector.get(selector)
    const candidate = candidateBySelector.get(selector)
    if (!source || !candidate || source.captured !== 1 || candidate.captured !== 1) {
      return []
    }
    const sourceElement = sourceByPath.get(source.paths[0] ?? "")
    const candidateElement = candidateByPath.get(candidate.paths[0] ?? "")
    if (!sourceElement || !candidateElement) {
      return []
    }

    const boundingBoxDelta = visualCompareBoundingBoxDelta(sourceElement.boundingBox, candidateElement.boundingBox)
    const styles = visualCompareActionableStyleDeltas(sourceElement.styles, candidateElement.styles)
    if (boundingBoxDelta.severity === "none" && styles.length === 0) {
      return []
    }

    return [{
      selector,
      sourcePath: sourceElement.path,
      candidatePath: candidateElement.path,
      source: { path: sourceElement.path, tag: sourceElement.tag, boundingBox: sourceElement.boundingBox },
      candidate: { path: candidateElement.path, tag: candidateElement.tag, boundingBox: candidateElement.boundingBox },
      boundingBox: boundingBoxDelta,
      styles,
    }]
  })
}

function visualCompareBoundingBoxDelta(source: VisualCompareDomElementSnapshot["boundingBox"], candidate: VisualCompareDomElementSnapshot["boundingBox"]): VisualCompareSelectorDelta["boundingBox"] {
  const delta = {
    x: roundVisualDelta(candidate.x - source.x),
    y: roundVisualDelta(candidate.y - source.y),
    width: roundVisualDelta(candidate.width - source.width),
    height: roundVisualDelta(candidate.height - source.height),
  }
  const maxPositionDelta = Math.max(Math.abs(delta.x), Math.abs(delta.y))
  const maxSizeDelta = Math.max(Math.abs(delta.width), Math.abs(delta.height))
  const severity = maxPositionDelta >= 8 || maxSizeDelta >= 8 ? "error" : maxPositionDelta >= 1 || maxSizeDelta >= 1 ? "warning" : maxPositionDelta >= 0.5 || maxSizeDelta >= 0.5 ? "info" : "none"
  return {
    source,
    candidate,
    delta,
    severity,
    category: "layout",
    hint: severity === "none" ? "Bounding boxes match within the visual-compare tolerance." : "Check layout, spacing, sizing, and positioning rules for this selector.",
  }
}

function visualCompareActionableStyleDeltas(source: Record<string, string>, candidate: Record<string, string>): VisualCompareActionableStyleDelta[] {
  return Object.keys(visualCompareActionableStyles({ ...source, ...candidate }))
    .filter((property) => (source[property] ?? "") !== (candidate[property] ?? ""))
    .map((property) => ({
      property,
      source: source[property] ?? "",
      candidate: candidate[property] ?? "",
      ...visualCompareStyleDeltaMetadata(property),
    }))
}

function visualCompareStyleDeltaMetadata(property: string): Pick<VisualCompareActionableStyleDelta, "category" | "severity" | "hint"> {
  if (/^(display|position|top|right|bottom|left|z-index|width|height|min-|max-|margin-|padding-|overflow|flex-|justify-content|align-|gap|row-gap|column-gap|grid-)/.test(property)) {
    return { category: "layout", severity: property === "display" || property === "position" ? "error" : "warning", hint: "Check layout, flow, sizing, or spacing rules for this selector." }
  }
  if (/^(font-|line-height$|letter-spacing$|text-align$|white-space$)/.test(property)) {
    return { category: "typography", severity: "warning", hint: "Check typography rules that can shift text metrics and wrapping." }
  }
  if (/^(opacity|transform|visibility)$/.test(property)) {
    return { category: "effect", severity: property === "transform" || property === "visibility" ? "error" : "warning", hint: "Check visibility, transform, or compositing rules for this selector." }
  }
  return { category: "paint", severity: "info", hint: "Check paint-only rules such as color, background, border, or object rendering." }
}

function visualCompareExplainRegions(regions: VisualCompareMismatchRegion[], sourceElements: VisualCompareDomElementSnapshot[], candidateElements: VisualCompareDomElementSnapshot[]): VisualCompareMismatchRegion[] {
  return regions.map((region) => ({
    ...region,
    sourceElements: visualCompareRegionElementOverlaps(region, sourceElements),
    candidateElements: visualCompareRegionElementOverlaps(region, candidateElements),
  }))
}

export function visualCompareRegionElementOverlaps(region: VisualCompareMismatchRegion, elements: VisualCompareDomElementSnapshot[], limit = 8): VisualCompareRegionElementOverlap[] {
  const regionArea = region.width * region.height
  if (regionArea <= 0) {
    return []
  }

  return elements
    .map((element) => {
      const box = element.boundingBox
      const overlapX = Math.max(region.x, box.x)
      const overlapY = Math.max(region.y, box.y)
      const overlapRight = Math.min(region.x + region.width, box.x + box.width)
      const overlapBottom = Math.min(region.y + region.height, box.y + box.height)
      const width = Math.max(0, overlapRight - overlapX)
      const height = Math.max(0, overlapBottom - overlapY)
      const area = width * height
      if (area <= 0) {
        return undefined
      }
      const elementArea = Math.max(1, box.width * box.height)
      return {
        path: element.path,
        tag: element.tag,
        ...(element.text ? { text: element.text } : {}),
        ...(element.attributes.class ? { className: element.attributes.class } : {}),
        boundingBox: box,
        overlap: {
          x: roundVisualDelta(overlapX),
          y: roundVisualDelta(overlapY),
          width: roundVisualDelta(width),
          height: roundVisualDelta(height),
          area: roundVisualDelta(area),
          regionCoverage: roundVisualDelta(area / regionArea),
          elementCoverage: roundVisualDelta(area / elementArea),
        },
        styles: visualCompareActionableStyles(element.styles),
      } satisfies VisualCompareRegionElementOverlap
    })
    .filter((element): element is VisualCompareRegionElementOverlap => Boolean(element))
    .sort((a, b) => {
      const areaDelta = b.overlap.area - a.overlap.area
      if (Math.abs(areaDelta) >= 1) {
        return areaDelta
      }
      const aArea = a.boundingBox.width * a.boundingBox.height
      const bArea = b.boundingBox.width * b.boundingBox.height
      return aArea - bArea
    })
    .slice(0, limit)
}

function visualCompareActionableStyles(styles: Record<string, string>): Record<string, string> {
  const keys = ["display", "position", "box-sizing", "top", "right", "bottom", "left", "z-index", "width", "height", "min-width", "max-width", "min-height", "max-height", "margin-top", "margin-right", "margin-bottom", "margin-left", "padding-top", "padding-right", "padding-bottom", "padding-left", "overflow", "overflow-x", "overflow-y", "flex-direction", "flex-wrap", "justify-content", "align-items", "align-content", "gap", "row-gap", "column-gap", "grid-template-columns", "grid-template-rows", "grid-auto-flow", "font-family", "font-size", "font-weight", "line-height", "letter-spacing", "text-align", "white-space", "color", "background-color", "border-top-width", "border-right-width", "border-bottom-width", "border-left-width", "border-top-color", "border-right-color", "border-bottom-color", "border-left-color", "border-top-left-radius", "border-top-right-radius", "border-bottom-right-radius", "border-bottom-left-radius", "object-fit", "object-position", "opacity", "transform", "visibility"]
  return Object.fromEntries(keys.flatMap((key) => (styles[key] ? [[key, styles[key]]] : [])))
}

export function visualCompareLayoutDrift(sourceElements: VisualCompareDomElementSnapshot[], candidateElements: VisualCompareDomElementSnapshot[], screenshotChanged = false): VisualCompareLayoutDrift | undefined {
  const sourceFlow = sourceElements.filter(visualCompareElementInDocumentFlow).sort(visualCompareFlowOrder)
  const candidateFlow = candidateElements.filter(visualCompareElementInDocumentFlow).sort(visualCompareFlowOrder)
  const sourceByPath = new Map(sourceFlow.map((element) => [element.path, element]))
  const candidateByPath = new Map(candidateFlow.map((element) => [element.path, element]))
  const matched = sourceFlow.map((source) => ({ source, candidate: candidateByPath.get(source.path) })).filter((pair): pair is { source: VisualCompareDomElementSnapshot; candidate: VisualCompareDomElementSnapshot } => Boolean(pair.candidate))
  const added = candidateFlow.filter((element) => !sourceByPath.has(element.path))
  const removed = sourceFlow.filter((element) => !candidateByPath.has(element.path))
  const divergences: VisualCompareLayoutDriftDivergence[] = []
  const anchors: VisualCompareLayoutDriftAnchor[] = []
  let maxAbsYOffset = 0
  let maxAbsHeightDelta = 0
  let maxAbsGapDelta = 0

  for (const { source, candidate } of matched) {
    const yDelta = roundVisualDelta(candidate.boundingBox.y - source.boundingBox.y)
    const heightDelta = roundVisualDelta(candidate.boundingBox.height - source.boundingBox.height)
    maxAbsYOffset = Math.max(maxAbsYOffset, Math.abs(yDelta))
    maxAbsHeightDelta = Math.max(maxAbsHeightDelta, Math.abs(heightDelta))
    if (Math.abs(heightDelta) >= 1) {
      divergences.push(visualCompareLayoutDriftDivergence("height-delta", source, candidate, { height: heightDelta }))
    }
    if (Math.abs(yDelta) >= 1) {
      divergences.push(visualCompareLayoutDriftDivergence("y-offset", source, candidate, { y: yDelta }))
    }
    if (Math.abs(yDelta) >= 1 || Math.abs(heightDelta) >= 1) {
      anchors.push(visualCompareLayoutDriftAnchor(source, candidate, { ...(Math.abs(yDelta) >= 1 ? { y: yDelta } : {}), ...(Math.abs(heightDelta) >= 1 ? { height: heightDelta } : {}) }))
    }
  }

  for (let index = 1; index < matched.length; index += 1) {
    const previous = matched[index - 1]
    const current = matched[index]
    const sourceGap = current.source.boundingBox.y - (previous.source.boundingBox.y + previous.source.boundingBox.height)
    const candidateGap = current.candidate.boundingBox.y - (previous.candidate.boundingBox.y + previous.candidate.boundingBox.height)
    const gapDelta = roundVisualDelta(candidateGap - sourceGap)
    maxAbsGapDelta = Math.max(maxAbsGapDelta, Math.abs(gapDelta))
    if (Math.abs(gapDelta) >= 1) {
      divergences.push({ ...visualCompareLayoutDriftDivergence("gap-delta", current.source, current.candidate, { gap: gapDelta }), previousPath: previous.source.path })
      anchors.push(visualCompareLayoutDriftAnchor(current.source, current.candidate, { gap: gapDelta }))
    }
  }

  for (const element of added) {
    divergences.push(visualCompareLayoutDriftDivergence("added-flow-element", undefined, element))
    anchors.push(visualCompareLayoutDriftAnchor(undefined, element))
  }
  for (const element of removed) {
    divergences.push(visualCompareLayoutDriftDivergence("removed-flow-element", element, undefined))
    anchors.push(visualCompareLayoutDriftAnchor(element, undefined))
  }

  const changedFlowElements = new Set(anchors.map((anchor) => anchor.path)).size
  if (divergences.length === 0) {
    if (!screenshotChanged) {
      return undefined
    }
    const firstDivergence: VisualCompareLayoutDriftDivergence = { type: "screenshot-only" }
    return {
      summary: {
        compact: "Screenshot pixels differ, but captured in-flow DOM anchors do not show vertical layout drift.",
        firstDivergenceType: firstDivergence.type,
        matchedFlowElements: matched.length,
        addedFlowElements: 0,
        removedFlowElements: 0,
        changedFlowElements: 0,
        maxAbsYOffset: 0,
        maxAbsHeightDelta: 0,
        maxAbsGapDelta: 0,
      },
      firstDivergence,
      anchors: [],
    }
  }

  const firstDivergence = divergences.sort(visualCompareLayoutDivergenceOrder)[0] as VisualCompareLayoutDriftDivergence
  const summary = {
    compact: visualCompareLayoutDriftSummary(firstDivergence, { matched: matched.length, added: added.length, removed: removed.length }),
    firstDivergenceType: firstDivergence.type,
    matchedFlowElements: matched.length,
    addedFlowElements: added.length,
    removedFlowElements: removed.length,
    changedFlowElements,
    maxAbsYOffset: roundVisualDelta(maxAbsYOffset),
    maxAbsHeightDelta: roundVisualDelta(maxAbsHeightDelta),
    maxAbsGapDelta: roundVisualDelta(maxAbsGapDelta),
  }
  return { summary, firstDivergence, anchors: anchors.sort(visualCompareLayoutAnchorOrder).slice(0, 12) }
}

function visualCompareElementInDocumentFlow(element: VisualCompareDomElementSnapshot): boolean {
  const position = element.styles.position?.trim().toLowerCase()
  return position !== "fixed" && position !== "sticky"
}

function visualCompareFlowOrder(a: VisualCompareDomElementSnapshot, b: VisualCompareDomElementSnapshot): number {
  return a.boundingBox.y - b.boundingBox.y || a.boundingBox.x - b.boundingBox.x || a.path.localeCompare(b.path)
}

function visualCompareLayoutDriftDivergence(type: Exclude<VisualCompareLayoutDriftDivergenceType, "screenshot-only">, source?: VisualCompareDomElementSnapshot, candidate?: VisualCompareDomElementSnapshot, delta?: VisualCompareLayoutDriftDivergence["delta"]): VisualCompareLayoutDriftDivergence {
  const element = source ?? candidate
  return {
    type,
    ...(element ? { path: element.path, tag: element.tag } : {}),
    ...(element?.text ? { text: element.text } : {}),
    ...(element?.attributes.class ? { className: element.attributes.class } : {}),
    ...(element ? { y: roundVisualDelta(element.boundingBox.y) } : {}),
    ...(source ? { source: source.boundingBox } : {}),
    ...(candidate ? { candidate: candidate.boundingBox } : {}),
    ...(delta ? { delta } : {}),
  }
}

function visualCompareLayoutDriftAnchor(source?: VisualCompareDomElementSnapshot, candidate?: VisualCompareDomElementSnapshot, delta?: VisualCompareLayoutDriftAnchor["delta"]): VisualCompareLayoutDriftAnchor {
  const element = source ?? candidate
  return {
    path: element?.path ?? "",
    tag: element?.tag ?? "",
    ...(element?.text ? { text: element.text } : {}),
    ...(element?.attributes.class ? { className: element.attributes.class } : {}),
    ...(source ? { source: source.boundingBox } : {}),
    ...(candidate ? { candidate: candidate.boundingBox } : {}),
    ...(delta ? { delta } : {}),
  }
}

function visualCompareLayoutDivergenceOrder(a: VisualCompareLayoutDriftDivergence, b: VisualCompareLayoutDriftDivergence): number {
  return (a.y ?? Number.MAX_SAFE_INTEGER) - (b.y ?? Number.MAX_SAFE_INTEGER) || visualCompareLayoutDivergencePriority(a.type) - visualCompareLayoutDivergencePriority(b.type) || (a.path ?? "").localeCompare(b.path ?? "")
}

function visualCompareLayoutAnchorOrder(a: VisualCompareLayoutDriftAnchor, b: VisualCompareLayoutDriftAnchor): number {
  const aY = Math.min(a.source?.y ?? Number.MAX_SAFE_INTEGER, a.candidate?.y ?? Number.MAX_SAFE_INTEGER)
  const bY = Math.min(b.source?.y ?? Number.MAX_SAFE_INTEGER, b.candidate?.y ?? Number.MAX_SAFE_INTEGER)
  return aY - bY || a.path.localeCompare(b.path)
}

function visualCompareLayoutDivergencePriority(type: VisualCompareLayoutDriftDivergenceType): number {
  return ["height-delta", "gap-delta", "y-offset", "added-flow-element", "removed-flow-element", "screenshot-only"].indexOf(type)
}

function visualCompareLayoutDriftSummary(first: VisualCompareLayoutDriftDivergence, counts: { matched: number; added: number; removed: number }): string {
  const delta = first.delta?.height ?? first.delta?.gap ?? first.delta?.y
  const deltaText = typeof delta === "number" ? ` (${delta > 0 ? "+" : ""}${delta}px)` : ""
  const location = first.path ? ` at ${first.path}` : ""
  return `First layout drift: ${first.type}${location}${deltaText}. Flow anchors: ${counts.matched} matched, ${counts.added} added, ${counts.removed} removed.`
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

export async function comparePngFiles(sourcePath: string, candidatePath: string, diffPath: string, options: { threshold: number; includeAA: boolean; maxRegions: number }): Promise<{
  source: { width: number; height: number }
  candidate: { width: number; height: number }
  diff: { width: number; height: number }
  dimensionMismatch: boolean
  dimensionDrift?: VisualCompareDimensionDrift
  mismatchPixels: number
  totalPixels: number
  mismatchRatio: number
  overlapMismatchPixels: number
  overlapPixels: number
  overlapMismatchRatio: number
  dimensionDeltaPixels: number
  dimensionDeltaRatio: number
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
  // RAW mismatch over the union canvas: both images are padded out to the max
  // width/height, so when dimensions differ the padded band (one side real content,
  // the other transparent fill) is counted as mismatch. This figure is dominated by
  // the canvas-size delta and is NOT a faithful visual-fidelity signal — it is kept
  // only for backward compatibility and as the raw denominator.
  const mismatchPixels = pixelmatch(sourceCanvas.data, candidateCanvas.data, diff.data, width, height, { threshold: options.threshold, includeAA: options.includeAA })
  await writeFile(diffPath, PNG.sync.write(diff))
  const dimensionMismatch = source.width !== candidate.width || source.height !== candidate.height

  // FAIR (dimension-normalized) mismatch over the common overlap region only: the
  // largest rectangle present in BOTH renders (min width × min height). Cropping
  // both images to that rectangle and running pixelmatch over it removes the
  // canvas-size band entirely, so the ratio reflects real visual difference where
  // the two pages actually overlap and is ~0 for a faithful import even when total
  // page height/width differs slightly. This is the trustworthy iteration signal.
  const overlapPixels = overlap.width * overlap.height
  let overlapMismatchPixels = 0
  if (overlapPixels > 0) {
    if (!dimensionMismatch) {
      // Same dimensions: the union canvas IS the overlap, so reuse the raw count
      // instead of paying for a second pixelmatch pass.
      overlapMismatchPixels = mismatchPixels
    } else {
      const sourceOverlap = cropVisualCompareCanvas(source, overlap.width, overlap.height)
      const candidateOverlap = cropVisualCompareCanvas(candidate, overlap.width, overlap.height)
      overlapMismatchPixels = pixelmatch(sourceOverlap.data, candidateOverlap.data, undefined, overlap.width, overlap.height, { threshold: options.threshold, includeAA: options.includeAA })
    }
  }
  const totalPixels = width * height
  // Pixels that exist in only one render because the canvases differ in size. This
  // is the dimension delta reported as a SEPARATE signal alongside the fair ratio,
  // rather than being smeared into a single mismatch number.
  const dimensionDeltaPixels = totalPixels - overlapPixels

  return {
    source: { width: source.width, height: source.height },
    candidate: { width: candidate.width, height: candidate.height },
    diff: { width, height },
    dimensionMismatch,
    ...(dimensionMismatch ? { dimensionDrift: visualCompareDimensionDrift(source, candidate) } : {}),
    mismatchPixels,
    totalPixels,
    mismatchRatio: totalPixels > 0 ? mismatchPixels / totalPixels : 0,
    overlapMismatchPixels,
    overlapPixels,
    overlapMismatchRatio: overlapPixels > 0 ? overlapMismatchPixels / overlapPixels : 0,
    dimensionDeltaPixels,
    dimensionDeltaRatio: totalPixels > 0 ? dimensionDeltaPixels / totalPixels : 0,
    regions: visualCompareMismatchRegions(diff, options.maxRegions, overlap),
  }
}

// Crop an image to the top-left `width`×`height` rectangle (the shared overlap
// origin). Both source and candidate are anchored at (0,0) — the document origin —
// so cropping to the common min dimensions compares the same on-page region.
function cropVisualCompareCanvas(image: PNG, width: number, height: number): PNG {
  const canvas = new PNG({ width, height })
  const copyHeight = Math.min(height, image.height)
  const copyWidthBytes = Math.min(width, image.width) << 2
  for (let y = 0; y < copyHeight; y += 1) {
    const sourceStart = (image.width * y) << 2
    const targetStart = (width * y) << 2
    image.data.copy(canvas.data, targetStart, sourceStart, sourceStart + copyWidthBytes)
  }
  return canvas
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
  // Use a flat numeric stack of pixel indices (`y * width + x`) instead of `[x, y]`
  // tuple arrays, and mark each pixel visited at PUSH time so it is enqueued at most
  // once. The previous implementation pushed four heap-allocated 2-element arrays per
  // visited pixel and only marked visited at POP time, so the live stack could hold up
  // to ~4× the mismatched-pixel count as tiny arrays. For a tall page with a high
  // mismatch ratio (the SSI gate routinely sees tens of millions of differing pixels,
  // e.g. a ~0.945 raw ratio over a 1280×6000 union) that grew the JS heap into the
  // multi-GB range and OOM'd old-space. A `number[]` of indices costs ~8 bytes/entry
  // and, with mark-at-push, the live frontier is bounded by the region perimeter rather
  // than its area. Region geometry/pixel counts are identical to the old walk.
  const stride = diff.width
  const startIndex = startY * stride + startX
  visited[startIndex] = 1
  const stack: number[] = [startIndex]
  let minX = startX
  let maxX = startX
  let minY = startY
  let maxY = startY
  let pixels = 0
  while (stack.length > 0) {
    const index = stack.pop() as number
    const x = index % stride
    const y = (index - x) / stride
    pixels += 1
    if (x < minX) {
      minX = x
    }
    if (x > maxX) {
      maxX = x
    }
    if (y < minY) {
      minY = y
    }
    if (y > maxY) {
      maxY = y
    }
    if (x + 1 < bounds.width) {
      visualCompareEnqueueNeighbor(diff, visited, stack, index + 1, x + 1, y)
    }
    if (x - 1 >= 0) {
      visualCompareEnqueueNeighbor(diff, visited, stack, index - 1, x - 1, y)
    }
    if (y + 1 < bounds.height) {
      visualCompareEnqueueNeighbor(diff, visited, stack, index + stride, x, y + 1)
    }
    if (y - 1 >= 0) {
      visualCompareEnqueueNeighbor(diff, visited, stack, index - stride, x, y - 1)
    }
  }
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, pixels }
}

function visualCompareEnqueueNeighbor(diff: PNG, visited: Uint8Array, stack: number[], index: number, x: number, y: number): void {
  if (visited[index] || !visualCompareDiffPixel(diff, x, y)) {
    return
  }
  visited[index] = 1
  stack.push(index)
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
  const red = diff.data[offset]
  const green = diff.data[offset + 1]
  const blue = diff.data[offset + 2]
  // pixelmatch renders unchanged pixels as grayscale source context, so RGB>0 is
  // not a mismatch signal. Actual mismatches use red and anti-aliased pixels use
  // yellow, both non-grayscale. Region detection must walk those colored pixels,
  // not the entire grayscale backdrop.
  return red !== green || green !== blue
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
