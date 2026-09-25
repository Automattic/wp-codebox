import type { ExecutionSpec, RuntimeCreateSpec } from "@automattic/wp-codebox-core"
import type { Browser, Page } from "playwright"
import { BrowserArtifactSession } from "./browser-artifact-session.js"
import type { BrowserArtifact, BrowserProbePreviewRouting } from "./browser-artifacts.js"
import { settleByFrameStability } from "./browser-frame-stability.js"
import { browserEnvironmentCell, createPlaywrightBrowserEnvironmentContext, resolvePlaywrightBrowserEnvironment } from "./browser-environment-matrix.js"
import { BrowserCommandArtifactError } from "./browser-command-artifact-error.js"
import { withBrowserCommandLiveness } from "./browser-liveness.js"
import { browserPreviewNeedsContextRouting, browserPreviewReadinessError, browserPreviewRouting, browserPreviewTopology, closeBrowserAndDrainPreviewRoutes, createBrowserPreviewRouteTracker, resolveBrowserPreviewUrl, routeBrowserPreviewContextNetwork, type BrowserPreviewNetworkPolicy, type BrowserPreviewRouteTracker } from "./browser-preview-routing.js"
import { browserCommandResult } from "./browser-result-sanitization.js"
import { launchChromiumBrowser } from "./browser-capture-session.js"
import { argValue, durationArg } from "./command-args.js"
import type { PlaygroundCliServer } from "./preview-server.js"

export const LAYOUT_SWEEP_SCHEMA = "wp-codebox/layout-sweep/v1"
export const LAYOUT_SWEEP_FINDING_SCHEMA = "homeboy/fuzz-finding/v1"
export const LAYOUT_SWEEP_COMMAND = "wordpress.layout-sweep"
export const LAYOUT_SWEEP_ARTIFACT_PREFIX = "files/browser/layout-sweep"

const TOLERANCE = 1.5
const DEFAULT_MIN_WIDTH = 320
const DEFAULT_MAX_WIDTH = 1920
const DEFAULT_HEIGHT = 900
const DEFAULT_SEED = 1
const DEFAULT_CONCURRENCY = 4
const DEFAULT_SCENARIOS = "sweep,history,storm,heights"
const CORE_SCENARIOS = ["sweep", "history", "storm", "heights", "drag"] as const

export interface LayoutSweepIdentity {
  kind: string
  container: string | null
  item: string | null
}

export interface LayoutSweepAcceptedFinding extends LayoutSweepIdentity {}

export interface LayoutSweepReplay {
  command: typeof LAYOUT_SWEEP_COMMAND
  args: string[]
}

export interface LayoutSweepFindingSample {
  scenario: string
  kind: string
  container: string | null
  item: string | null
  width?: number
  height?: number
  by?: number
  fit?: boolean
  w?: number
  h?: number
  burst?: number
  step?: number
}

export interface LayoutSweepFindingGroup {
  schema: typeof LAYOUT_SWEEP_FINDING_SCHEMA
  identity: LayoutSweepIdentity
  kind: string
  container: string | null
  item: string | null
  scenarios: string[]
  count: number
  widthRange: [number, number] | null
  worstMagnitude: number
  sample: LayoutSweepFindingSample
  replay: LayoutSweepReplay
  suppressed: boolean
}

export interface LayoutSweepMeasurement {
  width: number
  height: number
  mode: string
  containerHeight: number
}

export interface LayoutSweepBoundary {
  kind: "signature" | "height"
  low: number
  high: number
}

export interface LayoutSweepReport {
  schema: typeof LAYOUT_SWEEP_SCHEMA
  command: typeof LAYOUT_SWEEP_COMMAND
  status: "passed" | "failed"
  url: string
  seed: number
  profile: "quick" | "deep"
  range: { min: number; max: number; step: number; height: number }
  scenarios: string[]
  containers: number
  items: number
  resizes: number
  timings: Record<string, number>
  replay: LayoutSweepReplay
  findings: LayoutSweepFindingGroup[]
  unsuppressedFindings: number
  distinctProblems: Record<string, number>
  missingResources: string[]
  measurements: LayoutSweepMeasurement[]
  boundaries: LayoutSweepBoundary[]
  traces: { historyWidths: number[]; stormWidths: number[] }
  perf: LayoutSweepDragReport | null
  files?: { summary: string; findings: string }
}

export interface LayoutSweepDragReport {
  status: "reported" | "unavailable"
  steps?: number
  msPerStep?: number
  layoutMsPerStep?: number
  styleMsPerStep?: number
  scriptMsPerStep?: number
  layoutsPerStep?: number
  longTasks?: number
  longestTaskMs?: number
  message?: string
}

export interface LayoutSweepOptions {
  url: string
  containerSelector: string
  itemSelector: string
  minWidth?: number
  maxWidth?: number
  profile?: "quick" | "deep"
  seed?: number
  concurrency?: number
  scenarios?: string[]
  accepted?: LayoutSweepAcceptedFinding[]
  historySteps?: number
  storms?: number
  height?: number
}

interface LayoutItemSnapshot {
  index: number
  label: string
  x: number
  y: number
  w: number
  h: number
  textual: boolean
  hasContent: boolean
  textBottom: number
  textAbsBottom: number
  minFont: number | null
  distortion: number
}

interface LayoutContainerSnapshot {
  index: number
  label: string
  mode: string
  pageOverflow: number
  w: number
  h: number
  items: LayoutItemSnapshot[]
}

interface LayoutSnapshot {
  pageOverflow: number
  containers: LayoutContainerSnapshot[]
}

interface LayoutFinding extends LayoutSweepFindingSample {
  containerIndex?: number
}

type LayoutFindingContext = Omit<LayoutFinding, "scenario" | "kind" | "container" | "item"> & {
  container?: string | null
  item?: string | null
}

type LayoutFindingRecorder = (scenario: string, kind: string, context?: LayoutFindingContext) => void

type LayoutScenario =
  | { name: "sweep" | "history" | "storm" | "heights" | "drag" }
  | { name: "text-scale"; percent: number }
  | { name: "block-fonts" }
  | { name: "long-text"; ratio: number }
  | { name: "dpr"; deviceScaleFactor: number }

export interface LayoutSweepPage {
  page: Page
  errors: string[]
  missingResources: string[]
  close(): Promise<void>
}

export interface LayoutSweepOpenPageOptions {
  width: number
  height: number
  deviceScaleFactor?: number
  css?: string
  blockFonts?: boolean
  longTextRatio?: number
  containerSelector?: string
}

export async function runLayoutSweepCommand({
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
  const options = layoutSweepOptionsFromArgs(args)
  const timeoutMs = durationArg(args, "timeout", 180_000)
  const previewOrigin = server.wordpressUrl ?? server.serverUrl
  const preview = browserPreviewRouting(args, runtimeSpec, previewOrigin)
  const readinessError = browserPreviewReadinessError(preview)
  if (readinessError) throw readinessError
  const topology = browserPreviewTopology(args, runtimeSpec, previewOrigin, server.serverUrl)
  const targetUrl = resolveBrowserPreviewUrl(options.url, preview.effectiveOrigin)
  const artifactSession = new BrowserArtifactSession(artifactRoot, LAYOUT_SWEEP_ARTIFACT_PREFIX, { source: LAYOUT_SWEEP_COMMAND, operation: "layout-sweep" })
  const tracker = createBrowserPreviewRouteTracker()
  const browser = await launchChromiumBrowser()
  let report: LayoutSweepReport | undefined
  try {
    report = await withBrowserCommandLiveness({
      command: LAYOUT_SWEEP_COMMAND,
      phase: "sweep",
      operation: runLayoutSweep({
        browser,
        url: targetUrl,
        options,
        openPage: (pageOptions) => openEnvironmentLayoutSweepPage(browser, targetUrl, pageOptions, topology.networkPolicy, preview.effectiveOrigin, tracker),
      }),
      policy: { wallTimeoutMs: timeoutMs, idleTimeoutMs: 0 },
    })
  } finally {
    const closeErrors = await closeBrowserAndDrainPreviewRoutes(browser, tracker)
    if (!report && closeErrors.length > 0) throw closeErrors[0]
  }
  if (!report) throw new Error("wordpress.layout-sweep did not produce a report")
  report.files = {
    summary: `${LAYOUT_SWEEP_ARTIFACT_PREFIX}/summary.json`,
    findings: `${LAYOUT_SWEEP_ARTIFACT_PREFIX}/findings.json`,
  }
  await artifactSession.writeJson("summary", "summary.json", report)
  await artifactSession.writeJson("layoutSweep", "findings.json", report.findings)
  const artifact = layoutSweepArtifact(report, options.url, targetUrl, preview)
  if (report.status === "failed") {
    throw new BrowserCommandArtifactError(`wordpress.layout-sweep found ${report.unsuppressedFindings} unsuppressed layout finding(s)`, artifact)
  }
  return browserCommandResult(artifact, report)
}

export async function runLayoutSweep({
  browser,
  url,
  openPage,
  options,
}: {
  browser: Browser
  url: string
  openPage: (options: LayoutSweepOpenPageOptions) => Promise<LayoutSweepPage>
  options: LayoutSweepOptions
}): Promise<LayoutSweepReport> {
  const minWidth = options.minWidth ?? DEFAULT_MIN_WIDTH
  const maxWidth = options.maxWidth ?? DEFAULT_MAX_WIDTH
  const profile = options.profile ?? "quick"
  const seed = options.seed ?? DEFAULT_SEED
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY
  const height = options.height ?? DEFAULT_HEIGHT
  const scenarioTokens = options.scenarios ?? DEFAULT_SCENARIOS.split(",")
  const scenarios = scenarioTokens.map(parseLayoutScenario)
  const accepted = options.accepted ?? []
  if (minWidth > maxWidth) throw new Error("wordpress.layout-sweep min-width must not exceed max-width")
  if (concurrency < 1 || concurrency > 8) throw new Error("wordpress.layout-sweep concurrency must be from 1 to 8")
  const budget = profileBudget(profile)
  const historySteps = options.historySteps ?? budget.historySteps
  const storms = options.storms ?? budget.storms
  const random = rng(seed)
  const pick = <T>(list: T[]): T => list[Math.floor(random() * list.length)] as T
  const between = (min: number, max: number) => Math.round(min + random() * (max - min))
  const findings: LayoutFinding[] = []
  const missing = new Set<string>()
  const counts = { resizes: 0 }
  const timings: Record<string, number> = {}
  const started = Date.now()
  const reference = new Map<number, LayoutSnapshot>()
  const inflight = new Map<number, Promise<LayoutSnapshot>>()
  const boundaries: LayoutSweepBoundary[] = []
  const traces = { historyWidths: [] as number[], stormWidths: [] as number[] }
  const scenarioNames = new Set(scenarios.map((scenario) => scenario.name))

  const add: LayoutFindingRecorder = (scenario, kind, context = {}) => {
    findings.push({ scenario, kind, container: context.container ?? null, item: context.item ?? null, ...context })
  }

  const read = (page: Page) => readLayoutSnapshot(page, options.containerSelector, options.itemSelector)

  const resize = async (page: Page, width: number, viewportHeight = height) => {
    await page.setViewportSize({ width, height: viewportHeight })
    const settled = await settleByFrameStability(page, () => read(page))
    if (!settled.stable) add("settle", "unstable", { width, height: viewportHeight })
    return settled.snapshot
  }

  const measure = (page: Page, width: number) => {
    const existing = inflight.get(width)
    if (existing) return existing
    const pending = (async () => {
      counts.resizes += 1
      const snapshot = await resize(page, width)
      reference.set(width, snapshot)
      return snapshot
    })()
    inflight.set(width, pending)
    return pending
  }

  const coarse = coarseWidths(minWidth, maxWidth, budget.step)
  const time = async (name: string, run: () => Promise<void>) => {
    const begin = Date.now()
    await run()
    timings[name] = Date.now() - begin
  }

  const sweepChunk = async (widths: number[]) => {
    const opened = await openPage({ width: widths[0] ?? maxWidth, height })
    try {
      for (const width of widths) await measure(opened.page, width)
      for (let index = 1; index < widths.length; index += 1) {
        let low = widths[index - 1] as number
        let high = widths[index] as number
        const lowSignature = signature(reference.get(low) as LayoutSnapshot)
        if (lowSignature !== signature(reference.get(high) as LayoutSnapshot)) {
          while (high - low > 1) {
            const middle = Math.floor((low + high) / 2)
            if (signature(await measure(opened.page, middle)) === lowSignature) low = middle
            else high = middle
          }
          boundaries.push({ kind: "signature", low, high })
        }
        low = widths[index - 1] as number
        high = widths[index] as number
        if (high - low > 2 && excess(reference, low, high) > 0) {
          while (high - low > 2) {
            const middle = Math.floor((low + high) / 2)
            await measure(opened.page, middle)
            if (excess(reference, low, middle) >= excess(reference, middle, high)) high = middle
            else low = middle
          }
          boundaries.push({ kind: "height", low, high })
        }
      }
      for (const width of [...widths].reverse()) {
        counts.resizes += 1
        const drifted = drift(reference.get(width), await resize(opened.page, width))
        if (drifted.by > TOLERANCE) add("sweep", "hysteresis", { width, container: drifted.container, item: drifted.item, by: roundMagnitude(drifted.by) })
      }
      reportErrors("sweep", opened.errors, add)
    } finally {
      collectMissing(opened, missing)
      await opened.close()
    }
  }

  await time("sweep", async () => {
    await pool(chunksFor(coarse, concurrency).map((widths) => () => sweepChunk(widths)), concurrency)
    const anchors = anchorsFrom(reference)
    const widths = [...reference.keys()].sort((left, right) => left - right)
    if (scenarioNames.has("sweep")) {
      widths.forEach((width, step) => {
        const snapshot = reference.get(width) as LayoutSnapshot
        checkInvariants("sweep", { width }, snapshot, anchors, add)
        const low = step ? widths[step - 1] : undefined
        if (low === undefined || width - low > 2) return
        snapshot.containers.forEach((container, index) => {
          const prior = reference.get(low)?.containers[index]
          if (prior && deviation(prior, container) > jumpLimit(prior)) {
            add("sweep", "jump", { width, container: container.label, item: null, by: Math.round(container.h - prior.h) })
          }
        })
      })
    }
  })

  const known = [...reference.keys()]
  const anchors = anchorsFrom(reference)
  const tasks: Array<() => Promise<void>> = []
  const task = (name: string, pageOptions: LayoutSweepOpenPageOptions, run: (page: Page) => Promise<void>) => {
    tasks.push(async () => {
      const opened = await openPage(pageOptions)
      try {
        await time(name, () => run(opened.page))
        reportErrors(name, opened.errors, add)
      } finally {
        collectMissing(opened, missing)
        await opened.close()
      }
    })
  }

  if (scenarioNames.has("history") && known.length > 0) {
    task("history", { width: maxWidth, height }, async (page) => {
      for (let step = 0; step < historySteps; step += 1) {
        const width = pick(known)
        traces.historyWidths.push(width)
        counts.resizes += 1
        const drifted = drift(reference.get(width), await resize(page, width))
        if (drifted.by > TOLERANCE) add("history", "history", { width, container: drifted.container, item: drifted.item, by: roundMagnitude(drifted.by), step })
      }
    })
  }

  if (scenarioNames.has("storm") && known.length > 0) {
    task("storm", { width: maxWidth, height }, async (page) => {
      for (let burst = 0; burst < storms; burst += 1) {
        const length = between(5, 25)
        for (let index = 0; index < length; index += 1) {
          counts.resizes += 1
          traces.stormWidths.push(between(minWidth, maxWidth))
          await page.setViewportSize({ width: traces.stormWidths[traces.stormWidths.length - 1] as number, height: between(400, 1400) })
        }
        const width = pick(known)
        traces.stormWidths.push(width)
        counts.resizes += 1
        await page.setViewportSize({ width, height })
        const settled = await settleByFrameStability(page, () => read(page))
        if (!settled.stable) add("storm", "unstable", { width, burst })
        const drifted = drift(reference.get(width), settled.snapshot)
        if (drifted.by > TOLERANCE) add("storm", "storm", { width, container: drifted.container, item: drifted.item, by: roundMagnitude(drifted.by), burst })
      }
    })
  }

  if (scenarioNames.has("heights")) {
    task("heights", { width: minWidth, height }, async (page) => {
      for (const width of representativeWidths(minWidth, maxWidth)) {
        for (const viewportHeight of [320, 568, 900, 1400, 2400]) {
          counts.resizes += 1
          checkInvariants("heights", { width, height: viewportHeight }, await resize(page, width, viewportHeight), anchors, add)
        }
      }
    })
  }

  for (const scenario of scenarios) {
    if (scenario.name === "text-scale") {
      task(`text-scale:${scenario.percent}`, { width: minWidth, height, css: `html{font-size:${scenario.percent}% !important}` }, (page) => perturbSweep(page, scenarioTokens.find((token) => token.startsWith("text-scale:")) ?? "text-scale", minWidth, maxWidth, budget.perturbStep, height, anchors, counts, resize, add))
    }
    if (scenario.name === "block-fonts") {
      task("block-fonts", { width: minWidth, height, blockFonts: true }, (page) => perturbSweep(page, "block-fonts", minWidth, maxWidth, budget.perturbStep, height, anchors, counts, resize, add))
    }
    if (scenario.name === "long-text") {
      task(`long-text:${scenario.ratio}`, { width: minWidth, height, longTextRatio: scenario.ratio, containerSelector: options.containerSelector }, (page) => perturbSweep(page, `long-text:${scenario.ratio}`, minWidth, maxWidth, budget.perturbStep, height, anchors, counts, resize, add))
    }
    if (scenario.name === "dpr") {
      task(`dpr:${scenario.deviceScaleFactor}`, { width: minWidth, height, deviceScaleFactor: scenario.deviceScaleFactor }, (page) => perturbSweep(page, `dpr:${scenario.deviceScaleFactor}`, minWidth, maxWidth, budget.perturbStep, height, anchors, counts, resize, add))
    }
  }

  await time("parallel", () => pool(tasks, concurrency))

  let perf: LayoutSweepDragReport | null = null
  if (scenarioNames.has("drag")) {
    const opened = await openPage({ width: maxWidth, height })
    try {
      await time("drag", async () => {
        perf = await dragCost(opened.page, minWidth, maxWidth, height, budget.dragStep)
      })
      reportErrors("drag", opened.errors, add)
    } finally {
      collectMissing(opened, missing)
      await opened.close()
    }
  }

  timings.total = Date.now() - started
  const widest = reference.get(maxWidth) ?? reference.get([...reference.keys()].sort((left, right) => right - left)[0] ?? maxWidth)
  const replay = layoutSweepReplay(options, url, scenarioTokens, { minWidth, maxWidth, profile, seed, concurrency })
  const grouped = groupLayoutFindings(findings, accepted, replay)
  const distinctProblems: Record<string, number> = {}
  for (const group of grouped) distinctProblems[group.kind] = (distinctProblems[group.kind] ?? 0) + 1
  return {
    schema: LAYOUT_SWEEP_SCHEMA,
    command: LAYOUT_SWEEP_COMMAND,
    status: grouped.some((group) => !group.suppressed) ? "failed" : "passed",
    url,
    seed,
    profile,
    range: { min: minWidth, max: maxWidth, step: budget.step, height },
    scenarios: scenarioTokens,
    containers: widest?.containers.length ?? 0,
    items: widest?.containers.reduce((total, container) => total + container.items.length, 0) ?? 0,
    resizes: counts.resizes,
    timings,
    replay,
    findings: grouped,
    unsuppressedFindings: grouped.filter((group) => !group.suppressed).length,
    distinctProblems,
    missingResources: [...missing],
    measurements: measurementIndex(reference, height),
    boundaries,
    traces,
    perf,
  }
}

export async function prepareLayoutSweepPage(page: Page, url: string, setup: Omit<LayoutSweepOpenPageOptions, "width" | "height"> = {}): Promise<{ errors: string[]; missingResources: string[] }> {
  const watched = watchLayoutSweepPage(page)
  if (setup.blockFonts) {
    await page.route(/\.(woff2?|ttf|otf)(\?|$)/, (route) => route.abort())
  }
  await page.goto(url, { waitUntil: "load" })
  await page.evaluate(() => (document as Document & { fonts?: { ready?: Promise<unknown> } }).fonts?.ready)
  if (setup.css) await page.addStyleTag({ content: setup.css })
  if (setup.longTextRatio !== undefined) await expandLayoutText(page, setup.longTextRatio, setup.containerSelector)
  return watched
}

export function layoutSweepOptionsFromArgs(args: string[]): LayoutSweepOptions {
  const url = argValue(args, "url")?.trim()
  const containerSelector = argValue(args, "container-selector")?.trim()
  const itemSelector = argValue(args, "item-selector")?.trim()
  if (!url) throw new Error("wordpress.layout-sweep requires url=<path-or-url>")
  if (!containerSelector) throw new Error("wordpress.layout-sweep requires container-selector=<selector>")
  if (!itemSelector) throw new Error("wordpress.layout-sweep requires item-selector=<selector>")
  if (containerSelector.length > 512 || itemSelector.length > 512) throw new Error("wordpress.layout-sweep selectors must be at most 512 characters")
  const profile = argValue(args, "profile")?.trim() || "quick"
  if (profile !== "quick" && profile !== "deep") throw new Error("wordpress.layout-sweep profile must be quick or deep")
  const scenarios = (argValue(args, "scenarios")?.trim() || DEFAULT_SCENARIOS).split(",").map((token) => token.trim()).filter(Boolean)
  scenarios.forEach(parseLayoutScenario)
  return {
    url,
    containerSelector,
    itemSelector,
    minWidth: positiveIntegerArg(args, "min-width", DEFAULT_MIN_WIDTH),
    maxWidth: positiveIntegerArg(args, "max-width", DEFAULT_MAX_WIDTH),
    profile,
    seed: positiveIntegerArg(args, "seed", DEFAULT_SEED),
    concurrency: positiveIntegerArg(args, "concurrency", DEFAULT_CONCURRENCY),
    scenarios,
    accepted: acceptedFindingsArg(args),
  }
}

export function groupLayoutFindings(findings: LayoutFinding[], accepted: LayoutSweepAcceptedFinding[], replay: LayoutSweepReplay): LayoutSweepFindingGroup[] {
  const groups = new Map<string, LayoutSweepFindingGroup & { worstBy: number }>()
  for (const finding of findings) {
    const identity = { kind: finding.kind, container: finding.container ?? null, item: finding.item ?? null }
    const key = `${identity.kind}|${identity.container ?? ""}|${identity.item ?? ""}`
    const magnitude = Number.isFinite(finding.by) ? Math.abs(finding.by as number) : 0
    const group = groups.get(key) ?? {
      schema: LAYOUT_SWEEP_FINDING_SCHEMA,
      identity,
      kind: identity.kind,
      container: identity.container,
      item: identity.item,
      scenarios: [],
      count: 0,
      widthRange: null,
      worstMagnitude: 0,
      sample: findingSample(finding),
      replay: findingReplay(replay, finding),
      suppressed: false,
      worstBy: -1,
    }
    group.count += 1
    if (!group.scenarios.includes(finding.scenario)) group.scenarios.push(finding.scenario)
    if (Number.isFinite(finding.width)) {
      const width = finding.width as number
      group.widthRange = group.widthRange ? [Math.min(group.widthRange[0], width), Math.max(group.widthRange[1], width)] : [width, width]
    }
    if (magnitude > group.worstBy) {
      group.worstBy = magnitude
      group.worstMagnitude = magnitude
      group.sample = findingSample(finding)
      group.replay = findingReplay(replay, finding)
    }
    groups.set(key, group)
  }
  return [...groups.values()].map(({ worstBy: _worstBy, ...group }) => ({
    ...group,
    suppressed: accepted.some((entry) => entry.kind === group.kind && (entry.container ?? null) === group.container && (entry.item ?? null) === group.item),
  })).sort((left, right) => left.kind.localeCompare(right.kind) || right.worstMagnitude - left.worstMagnitude)
}

async function openEnvironmentLayoutSweepPage(browser: Browser, url: string, options: LayoutSweepOpenPageOptions, policy: BrowserPreviewNetworkPolicy, previewOrigin: string, tracker: BrowserPreviewRouteTracker): Promise<LayoutSweepPage> {
  const cell = browserEnvironmentCell({
    viewport: { width: options.width, height: options.height },
    ...(options.deviceScaleFactor !== undefined ? { deviceScaleFactor: options.deviceScaleFactor } : {}),
  })
  const resolved = await resolvePlaywrightBrowserEnvironment(cell, browser)
  const runtime = await createPlaywrightBrowserEnvironmentContext(browser, resolved)
  if (browserPreviewNeedsContextRouting(policy)) {
    await routeBrowserPreviewContextNetwork(runtime.context, policy, previewOrigin, tracker)
  }
  const watched = await prepareLayoutSweepPage(runtime.page, url, options)
  return { page: runtime.page, errors: watched.errors, missingResources: watched.missingResources, close: () => runtime.close() }
}

function watchLayoutSweepPage(page: Page): { errors: string[]; missingResources: string[] } {
  const errors: string[] = []
  const missingResources: string[] = []
  page.on("pageerror", (error) => errors.push(String(error.message)))
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) errors.push(message.text())
  })
  page.on("response", (response) => {
    if (response.status() >= 400) missingResources.push(`${response.status()} ${response.url()}`)
  })
  return { errors, missingResources }
}

function collectMissing(opened: LayoutSweepPage, missing: Set<string>): void {
  for (const resource of opened.missingResources) missing.add(resource)
}

async function readLayoutSnapshot(page: Page, containerSelector: string, itemSelector: string): Promise<LayoutSnapshot> {
  return page.evaluate(({ containerSelector, itemSelector }) => {
    const round = (value: number) => Math.round(value * 10) / 10
    const pageOverflow = document.documentElement.scrollWidth - window.innerWidth
    const containers = [...document.querySelectorAll(containerSelector)].map((container, containerIndex) => {
      const box = container.getBoundingClientRect()
      const mode = getComputedStyle(container).getPropertyValue("--layout-mode").trim()
      const labelSource = container.id ? `#${container.id}` : ([...container.classList][0] ?? container.tagName.toLowerCase())
      const items = [...container.querySelectorAll(itemSelector)].map((item, index) => {
        const rect = item.getBoundingClientRect()
        let bottom = rect.top
        let minFont = Infinity
        let textual = false
        const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT)
        const range = document.createRange()
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!node.textContent?.trim()) continue
          const parent = node.parentElement
          if (!parent) continue
          const style = getComputedStyle(parent)
          if (style.visibility === "hidden" || style.display === "none") continue
          // Clipping ancestors within the item (overflow other than visible)
          // hide text past their edge, so only the visible extent counts.
          let clipBottom = Infinity
          for (let ancestor: Element | null = parent; ancestor && item.contains(ancestor); ancestor = ancestor.parentElement) {
            if (getComputedStyle(ancestor).overflowY !== "visible") clipBottom = Math.min(clipBottom, ancestor.getBoundingClientRect().bottom)
          }
          range.selectNodeContents(node)
          for (const glyph of range.getClientRects()) {
            if (glyph.width && glyph.height) {
              textual = true
              bottom = Math.max(bottom, Math.min(glyph.bottom, clipBottom))
              minFont = Math.min(minFont, Number.parseFloat(style.fontSize))
            }
          }
        }
        let distortion = 0
        for (const image of item.querySelectorAll("img")) {
          const imageRect = image.getBoundingClientRect()
          if (image.naturalWidth && imageRect.width > 4 && imageRect.height > 4 && getComputedStyle(image).objectFit === "fill") {
            const natural = image.naturalWidth / image.naturalHeight
            distortion = Math.max(distortion, Math.abs(imageRect.width / imageRect.height / natural - 1))
          }
        }
        const block = [item, ...item.querySelectorAll("*")].flatMap((node) => [...node.classList]).find((name) => /^wp-block-/.test(name)) || item.tagName.toLowerCase()
        const text = (item.textContent || "").trim().replace(/\s+/g, " ").slice(0, 24)
        return {
          index,
          label: `#${index} ${block}${text ? ` "${text}"` : ""}`,
          x: round(rect.left - box.left),
          y: round(rect.top - box.top),
          w: round(rect.width),
          h: round(rect.height),
          textual,
          hasContent: textual || !!item.querySelector("img,svg,video"),
          textBottom: round(bottom - rect.top),
          textAbsBottom: round(bottom - box.top),
          minFont: Number.isFinite(minFont) ? minFont : null,
          distortion: round(distortion * 100),
        }
      })
      return {
        index: containerIndex,
        label: `#${containerIndex} ${labelSource}`,
        mode,
        pageOverflow: round(pageOverflow),
        w: round(box.width),
        h: round(box.height),
        items,
      }
    })
    return { pageOverflow: round(pageOverflow), containers }
  }, { containerSelector, itemSelector })
}

async function expandLayoutText(page: Page, ratio: number, containerSelector?: string): Promise<void> {
  await page.evaluate(({ ratio, containerSelector }) => {
    const roots = containerSelector ? [...document.querySelectorAll(containerSelector)] : [document.body]
    for (const root of roots) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      const nodes: Text[] = []
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.textContent?.trim()) nodes.push(node as Text)
      }
      for (const node of nodes) {
        const words = node.textContent?.trim().split(/\s+/) ?? []
        const extra = words.slice(0, Math.max(1, Math.ceil(words.length * ratio)))
        node.textContent = `${node.textContent} ${extra.join(" ")}`
      }
    }
  }, { ratio, containerSelector })
}

function checkInvariants(scenario: string, context: { width?: number; height?: number }, snapshot: LayoutSnapshot, anchors: Map<string, Set<string>>, add: LayoutFindingRecorder): void {
  if (snapshot.pageOverflow > 1) add(scenario, "hscroll", { ...context, container: null, item: null, by: snapshot.pageOverflow })
  for (const container of snapshot.containers) {
    for (const item of container.items) {
      const at = { ...context, container: container.label, item: item.label }
      if (item.textual && item.textBottom > item.h + TOLERANCE) add(scenario, "overflow", { ...at, by: Math.round(item.textBottom - item.h) })
      if (item.textual && item.textAbsBottom > container.h + TOLERANCE) add(scenario, "leak", { ...at, by: Math.round(item.textAbsBottom - container.h) })
      if (item.hasContent && (item.w < 2 || item.h < 2)) add(scenario, "collapsed", { ...at, w: item.w, h: item.h, by: Math.min(item.w, item.h) })
      if (item.minFont !== null && item.minFont < 9) add(scenario, "tiny-text", { ...at, by: item.minFont })
      if (item.distortion > 2) add(scenario, "distort", { ...at, by: item.distortion })
    }
    const anchor = anchors.get(`${container.index}:${container.mode}`)
    if (!anchor) continue
    for (const pair of overlapPairs(container)) {
      if (anchor.has(pair)) continue
      const [left, right] = pair.split(":").map(Number)
      add(scenario, "overlap", { ...context, container: container.label, item: `${container.items[left]?.label ?? left} × ${container.items[right]?.label ?? right}` })
    }
  }
}

function overlapPairs(container: LayoutContainerSnapshot): Set<string> {
  const pairs = new Set<string>()
  container.items.forEach((left, index) => {
    container.items.slice(index + 1).forEach((right) => {
      if (overlaps(left, right)) pairs.add(`${left.index}:${right.index}`)
    })
  })
  return pairs
}

function overlaps(left: LayoutItemSnapshot, right: LayoutItemSnapshot): boolean {
  return left.x < right.x + right.w - TOLERANCE && left.x + left.w > right.x + TOLERANCE && left.y < right.y + right.h - TOLERANCE && left.y + left.h > right.y + TOLERANCE
}

function anchorsFrom(reference: Map<number, LayoutSnapshot>): Map<string, Set<string>> {
  const anchors = new Map<string, Set<string>>()
  for (const width of [...reference.keys()].sort((left, right) => right - left)) {
    for (const container of reference.get(width)?.containers ?? []) {
      const key = `${container.index}:${container.mode}`
      if (!anchors.has(key)) anchors.set(key, overlapPairs(container))
    }
  }
  return anchors
}

function signature(snapshot: LayoutSnapshot): string {
  return JSON.stringify(snapshot.containers.map((container) => [
    container.mode,
    container.items.length,
    container.items.map((item) => [
      item.textual && item.textBottom > item.h + TOLERANCE,
      item.textual && item.textAbsBottom > container.h + TOLERANCE,
      item.hasContent && (item.w < 2 || item.h < 2),
    ].map(Number).join("")),
    [...overlapPairs(container)].sort(),
  ]))
}

function deviation(prior: LayoutContainerSnapshot, container: LayoutContainerSnapshot): number {
  if (prior.mode !== container.mode) return 0
  return Math.abs(container.h - prior.h * (container.w / Math.max(1, prior.w)))
}

function jumpLimit(prior: LayoutContainerSnapshot): number {
  return Math.max(40, 0.08 * prior.h)
}

function excess(reference: Map<number, LayoutSnapshot>, low: number, high: number): number {
  const highSnapshot = reference.get(high)
  const lowSnapshot = reference.get(low)
  if (!highSnapshot || !lowSnapshot) return 0
  return Math.max(0, ...highSnapshot.containers.map((container, index) => {
    const prior = lowSnapshot.containers[index]
    return prior ? deviation(prior, container) - jumpLimit(prior) : 0
  }))
}

function drift(left: LayoutSnapshot | undefined, right: LayoutSnapshot | undefined): { by: number; container: string | null; item: string | null } {
  if (!left || !right || left.containers.length !== right.containers.length) return { by: Infinity, container: null, item: "container-count" }
  let worst = { by: 0, container: null as string | null, item: null as string | null }
  left.containers.forEach((container, index) => {
    const other = right.containers[index]
    if (!other) return
    const heightDelta = Math.abs(container.h - other.h)
    if (heightDelta > worst.by) worst = { by: heightDelta, container: container.label, item: "container height" }
    if (container.items.length !== other.items.length) {
      worst = { by: Infinity, container: container.label, item: "item-count" }
      return
    }
    container.items.forEach((item, itemIndex) => {
      const twin = other.items[itemIndex]
      if (!twin) return
      const by = Math.max(Math.abs(item.x - twin.x), Math.abs(item.y - twin.y), Math.abs(item.w - twin.w), Math.abs(item.h - twin.h))
      if (by > worst.by) worst = { by, container: container.label, item: item.label }
    })
  })
  return worst
}

async function perturbSweep(page: Page, scenario: string, minWidth: number, maxWidth: number, step: number, height: number, anchors: Map<string, Set<string>>, counts: { resizes: number }, resize: (page: Page, width: number, height?: number) => Promise<LayoutSnapshot>, add: LayoutFindingRecorder): Promise<void> {
  for (let width = minWidth; width <= maxWidth; width += step) {
    counts.resizes += 1
    checkInvariants(scenario, { width }, await resize(page, width, height), anchors, add)
  }
}

async function dragCost(page: Page, minWidth: number, maxWidth: number, height: number, step: number): Promise<LayoutSweepDragReport> {
  try {
    const client = await page.context().newCDPSession(page)
    await client.send("Performance.enable")
    const metrics = async () => Object.fromEntries((await client.send("Performance.getMetrics")).metrics.map((metric: { name: string; value: number }) => [metric.name, metric.value]))
    await page.evaluate(() => {
      const target = window as Window & { __layoutSweepLongTasks?: number[] }
      target.__layoutSweepLongTasks = []
      new PerformanceObserver((list) => {
        target.__layoutSweepLongTasks?.push(...list.getEntries().map((entry) => entry.duration))
      }).observe({ type: "longtask" })
    })
    const steps: number[] = []
    for (let width = maxWidth; width >= minWidth; width -= step) steps.push(width)
    steps.push(...[...steps].reverse())
    const start = await metrics()
    const began = Date.now()
    for (const width of steps) {
      await page.setViewportSize({ width, height })
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
    }
    const elapsed = Date.now() - began
    const end = await metrics()
    const longTasks = await page.evaluate(() => (window as Window & { __layoutSweepLongTasks?: number[] }).__layoutSweepLongTasks ?? [])
    const ms = (key: string) => Math.round(((end[key] ?? 0) - (start[key] ?? 0)) * 1000)
    return {
      status: "reported",
      steps: steps.length,
      msPerStep: Math.round((elapsed / steps.length) * 10) / 10,
      layoutMsPerStep: Math.round((ms("LayoutDuration") / steps.length) * 10) / 10,
      styleMsPerStep: Math.round((ms("RecalcStyleDuration") / steps.length) * 10) / 10,
      scriptMsPerStep: Math.round((ms("ScriptDuration") / steps.length) * 10) / 10,
      layoutsPerStep: Math.round(((end.LayoutCount ?? 0) - (start.LayoutCount ?? 0)) / steps.length),
      longTasks: longTasks.length,
      longestTaskMs: Math.round(Math.max(0, ...longTasks)),
    }
  } catch (error) {
    return { status: "unavailable", message: error instanceof Error ? error.message : String(error) }
  }
}

function reportErrors(scenario: string, errors: string[], add: LayoutFindingRecorder): void {
  for (const message of new Set(errors)) add(scenario, "error", { container: null, item: message.slice(0, 200) })
}

function measurementIndex(reference: Map<number, LayoutSnapshot>, height: number): LayoutSweepMeasurement[] {
  return [...reference.keys()].sort((left, right) => left - right).map((width) => {
    const container = reference.get(width)?.containers[0]
    return { width, height, mode: container?.mode ?? "", containerHeight: container?.h ?? 0 }
  })
}

function layoutSweepArtifact(report: LayoutSweepReport, requestedUrl: string, finalUrl: string, preview: BrowserProbePreviewRouting): BrowserArtifact {
  return {
    artifactType: "layout-sweep",
    requestedUrl,
    url: finalUrl,
    preview,
    files: {
      summary: `${LAYOUT_SWEEP_ARTIFACT_PREFIX}/summary.json`,
      layoutSweep: `${LAYOUT_SWEEP_ARTIFACT_PREFIX}/findings.json`,
    },
    summary: {
      consoleMessages: 0,
      errors: report.findings.filter((finding) => finding.kind === "error").length,
      finalUrl,
      htmlSnapshot: false,
      networkEvents: report.missingResources.length,
      replayability: "artifact-backed",
      screenshot: false,
      viewport: null,
      layoutSweep: {
        schema: LAYOUT_SWEEP_SCHEMA,
        status: report.status,
        findings: report.findings.length,
        unsuppressedFindings: report.unsuppressedFindings,
        resizes: report.resizes,
      },
    },
  }
}

function layoutSweepReplay(options: LayoutSweepOptions, url: string, scenarios: string[], resolved: { minWidth: number; maxWidth: number; profile: "quick" | "deep"; seed: number; concurrency: number }): LayoutSweepReplay {
  return {
    command: LAYOUT_SWEEP_COMMAND,
    args: [
      `url=${url}`,
      `container-selector=${options.containerSelector}`,
      `item-selector=${options.itemSelector}`,
      `min-width=${resolved.minWidth}`,
      `max-width=${resolved.maxWidth}`,
      `profile=${resolved.profile}`,
      `seed=${resolved.seed}`,
      `concurrency=${resolved.concurrency}`,
      `scenarios=${scenarios.join(",")}`,
    ],
  }
}

function findingReplay(replay: LayoutSweepReplay, finding: LayoutFinding): LayoutSweepReplay {
  return {
    command: replay.command,
    args: [...replay.args, ...(Number.isFinite(finding.width) ? [`width=${finding.width}`] : []), ...(Number.isFinite(finding.height) ? [`height=${finding.height}`] : [])],
  }
}

function findingSample(finding: LayoutFinding): LayoutSweepFindingSample {
  return {
    scenario: finding.scenario,
    kind: finding.kind,
    container: finding.container ?? null,
    item: finding.item ?? null,
    ...(finding.width !== undefined ? { width: finding.width } : {}),
    ...(finding.height !== undefined ? { height: finding.height } : {}),
    ...(finding.by !== undefined ? { by: finding.by } : {}),
    ...(finding.w !== undefined ? { w: finding.w } : {}),
    ...(finding.h !== undefined ? { h: finding.h } : {}),
    ...(finding.burst !== undefined ? { burst: finding.burst } : {}),
    ...(finding.step !== undefined ? { step: finding.step } : {}),
  }
}

function parseLayoutScenario(token: string): LayoutScenario {
  if ((CORE_SCENARIOS as readonly string[]).includes(token)) return { name: token as "sweep" }
  const textScale = /^text-scale:(\d+(?:\.\d+)?)$/.exec(token)
  if (textScale) return { name: "text-scale", percent: Number(textScale[1]) }
  if (token === "block-fonts") return { name: "block-fonts" }
  const longText = /^long-text:(\d+(?:\.\d+)?)$/.exec(token)
  if (longText) return { name: "long-text", ratio: Number(longText[1]) }
  const dpr = /^dpr:(\d+(?:\.\d+)?)$/.exec(token)
  if (dpr) return { name: "dpr", deviceScaleFactor: Number(dpr[1]) }
  throw new Error(`wordpress.layout-sweep scenarios must be ${CORE_SCENARIOS.join(", ")}, text-scale:<percent>, block-fonts, long-text:<ratio>, or dpr:<n>: ${token}`)
}

function acceptedFindingsArg(args: string[]): LayoutSweepAcceptedFinding[] {
  const raw = argValue(args, "accepted")?.trim()
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error("wordpress.layout-sweep accepted must be a JSON array of {kind, container, item}")
  }
  if (!Array.isArray(parsed)) throw new Error("wordpress.layout-sweep accepted must be a JSON array of {kind, container, item}")
  return parsed.map((entry) => {
    if (!entry || typeof entry !== "object" || typeof (entry as { kind?: unknown }).kind !== "string") {
      throw new Error("wordpress.layout-sweep accepted entries require kind")
    }
    const record = entry as { kind: string; container?: unknown; item?: unknown }
    return {
      kind: record.kind,
      container: record.container === undefined || record.container === null ? null : String(record.container),
      item: record.item === undefined || record.item === null ? null : String(record.item),
    }
  })
}

function positiveIntegerArg(args: string[], name: string, fallback: number): number {
  const raw = argValue(args, name)?.trim()
  if (!raw) return fallback
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) throw new Error(`wordpress.layout-sweep ${name} must be a positive integer`)
  return Number(raw)
}

function profileBudget(profile: "quick" | "deep") {
  return profile === "deep"
    ? { step: 2, historySteps: 150, storms: 30, perturbStep: 20, dragStep: 4 }
    : { step: 16, historySteps: 40, storms: 12, perturbStep: 48, dragStep: 16 }
}

function coarseWidths(min: number, max: number, step: number): number[] {
  const widths: number[] = []
  for (let width = min; width < max; width += step) widths.push(width)
  widths.push(max)
  return widths
}

function chunksFor(coarse: number[], concurrency: number): number[][] {
  if (coarse.length <= 1) return [coarse]
  const size = Math.max(1, Math.ceil(coarse.length / concurrency))
  const chunks: number[][] = []
  for (let index = 0; index < coarse.length - 1; index += size) chunks.push(coarse.slice(index, index + size + 1))
  return chunks
}

function representativeWidths(min: number, max: number): number[] {
  return [...new Set([min, 390, 600, 768, 1024, 1280, 1440, max].filter((width) => width >= min && width <= max))].sort((left, right) => left - right)
}

async function pool(tasks: Array<() => Promise<void>>, concurrency: number): Promise<void> {
  if (tasks.length === 0) return
  const queue = [...tasks]
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const task = queue.shift()
      if (task) await task()
    }
  }))
}

function rng(seed: number): () => number {
  let state = seed >>> 0 || 1
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 4294967296
  }
}

function roundMagnitude(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : value
}
