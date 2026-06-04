import type { Page } from "playwright"
import type {
  BrowserProbeCheckpointRecord,
  BrowserProbeMemoryArtifact,
  BrowserProbeMetricsSnapshot,
  BrowserProbePerformanceArtifact,
  BrowserProbeReplayability,
  BrowserProbeViewport,
  BrowserStepAssertion,
} from "./browser-artifacts.js"
import { browserProbeMemorySummary, browserProbePerformanceSummary, cdpDomCounters, cdpHeapUsage, cdpPerformanceMetrics } from "./browser-metrics.js"

export const BROWSER_PROBE_CAPTURE_VALUES = ["console", "errors", "html", "network", "performance", "memory", "screenshot"] as const

export const BROWSER_PROBE_STATE_INIT_SCRIPT = `
(() => {
  const state = globalThis.__wpCodeboxBrowserProbe = globalThis.__wpCodeboxBrowserProbe || { checkpoints: [], longTasks: [] };
  state.checkpoints = state.checkpoints || [];
  state.longTasks = state.longTasks || [];
  globalThis.__wpCodeboxProbeCheckpoint = (name, metadata = {}) => {
    state.checkpoints.push({
      name: String(name || ''),
      metadata,
      timestamp: new Date().toISOString(),
    });
  };
  globalThis.__wpCodeboxProbeFail = (message, details = undefined) => {
    state.terminalFailure = {
      message: String(message || 'Browser probe reported a terminal failure'),
      details,
      timestamp: new Date().toISOString(),
    };
  };
})();
`

export const BROWSER_PROBE_PERFORMANCE_INIT_SCRIPT = `
(() => {
  const state = globalThis.__wpCodeboxBrowserProbe = globalThis.__wpCodeboxBrowserProbe || { checkpoints: [], longTasks: [] };
  state.checkpoints = state.checkpoints || [];
  state.longTasks = state.longTasks || [];
  if (state.longTaskObserverInstalled || typeof PerformanceObserver === 'undefined') {
    return;
  }
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        state.longTasks.push({
          name: entry.name,
          startTime: entry.startTime,
          duration: entry.duration,
        });
      }
    });
    observer.observe({ type: 'longtask', buffered: true });
    state.longTaskObserverInstalled = true;
  } catch {
    state.longTaskObserverInstalled = false;
  }
})();
`

function now(): string {
  return new Date().toISOString()
}

export async function navigateBrowserProbe(page: Page, url: string, waitFor: string, durationMs: number): Promise<void> {
  if (["domcontentloaded", "load", "networkidle"].includes(waitFor)) {
    await page.goto(url, { waitUntil: waitFor as "domcontentloaded" | "load" | "networkidle", timeout: 30_000 })
    return
  }

  if (waitFor.startsWith("selector:")) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 })
    const selector = waitFor.slice("selector:".length).trim()
    if (!selector) {
      throw new Error("wordpress.browser-probe wait-for=selector:<selector> requires a selector")
    }
    await page.locator(selector).first().waitFor({ timeout: 30_000 })
    return
  }

  if (waitFor === "duration") {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 })
    await page.waitForTimeout(durationMs > 0 ? durationMs : 1000)
    return
  }

  throw new Error(`wordpress.browser-probe wait-for supports domcontentloaded, load, networkidle, selector:<selector>, duration: ${waitFor}`)
}

export async function browserProbeViewport(page: Page): Promise<BrowserProbeViewport> {
  const viewport = page.viewportSize()
  const device = await page.evaluate(() => ({
    deviceScaleFactor: window.devicePixelRatio,
    hasTouch: navigator.maxTouchPoints > 0,
    userAgent: navigator.userAgent,
  }))

  return {
    width: viewport?.width ?? 0,
    height: viewport?.height ?? 0,
    deviceScaleFactor: device.deviceScaleFactor,
    isMobile: /Mobile|Android|iPhone|iPad/i.test(device.userAgent),
    hasTouch: device.hasTouch,
    userAgent: device.userAgent,
  }
}

export function browserProbeReplayability(capture: Set<string>): BrowserProbeReplayability {
  if (capture.has("html") && capture.has("screenshot")) {
    return "artifact-backed"
  }

  if (capture.has("html") || capture.has("screenshot") || capture.has("network")) {
    return "partial"
  }

  return "diagnostic-only"
}

export interface BrowserProbeAssertionSpec {
  raw: string
  advisory: boolean
  type: "exists" | "not-exists" | "visible" | "hidden" | "count" | "text" | "attr" | "no-console-errors" | "no-page-errors" | "no-errors"
  selector?: string
  operator?: "=" | "==" | "!=" | ">" | ">=" | "<" | "<="
  expected?: string | number | boolean
  name?: string
}

export function browserProbeAssertionsFromArgs(args: string[]): BrowserProbeAssertionSpec[] {
  return args
    .filter((arg) => arg.startsWith("assert="))
    .map((arg) => parseBrowserProbeAssertion(arg.slice("assert=".length)))
}

export async function executeBrowserProbeAssertions(
  page: Page,
  assertions: BrowserProbeAssertionSpec[],
  consoleMessages: Record<string, unknown>[],
  pageErrors: Array<{ type?: string }>,
): Promise<BrowserStepAssertion[]> {
  const results: BrowserStepAssertion[] = []
  for (const assertion of assertions) {
    results.push(await executeBrowserProbeAssertion(page, assertion, consoleMessages, pageErrors))
  }
  return results
}

function parseBrowserProbeAssertion(value: string): BrowserProbeAssertionSpec {
  let raw = value.trim()
  if (!raw) {
    throw new Error("wordpress.browser-probe assert=<assertion> requires a value")
  }

  let advisory = false
  if (raw.startsWith("advisory:")) {
    advisory = true
    raw = raw.slice("advisory:".length).trim()
  }

  for (const type of ["not-exists", "exists", "visible", "hidden"] as const) {
    const prefix = `${type}:`
    if (raw.startsWith(prefix)) {
      return requireSelectorAssertion(value, advisory, type, raw.slice(prefix.length).trim())
    }
  }

  if (raw.startsWith("count:")) {
    const parsed = raw.slice("count:".length).trim().match(/^(.*?)(>=|<=|==|!=|=|>|<)\s*(\d+)$/)
    if (!parsed) {
      throw new Error(`wordpress.browser-probe count assertion must look like count:<selector><op><number>: ${value}`)
    }
    return {
      raw: value,
      advisory,
      type: "count",
      selector: parsed[1].trim(),
      operator: parsed[2] as BrowserProbeAssertionSpec["operator"],
      expected: Number.parseInt(parsed[3], 10),
    }
  }

  if (raw.startsWith("text:")) {
    const parsed = raw.slice("text:".length).trim().match(/^(.*?)\s+contains\s+([\s\S]+)$/)
    if (!parsed) {
      throw new Error(`wordpress.browser-probe text assertion must look like text:<selector> contains <text>: ${value}`)
    }
    return { raw: value, advisory, type: "text", selector: parsed[1].trim(), operator: "contains" as BrowserProbeAssertionSpec["operator"], expected: parsed[2] }
  }

  if (raw.startsWith("attr:")) {
    const body = raw.slice("attr:".length).trim()
    const bracket = body.match(/^(.*?)\[([^\]]+)\](?:\s*=\s*([\s\S]+))?$/)
    const at = body.match(/^(.*?)@([\w:-]+)(?:\s*=\s*([\s\S]+))?$/)
    const parsed = bracket ?? at
    if (!parsed) {
      throw new Error(`wordpress.browser-probe attr assertion must look like attr:<selector>[name][=value] or attr:<selector>@name[=value]: ${value}`)
    }
    return { raw: value, advisory, type: "attr", selector: parsed[1].trim(), name: parsed[2].trim(), operator: typeof parsed[3] === "undefined" ? undefined : "=", expected: parsed[3] }
  }

  if (raw === "no-console-errors" || raw === "no-page-errors" || raw === "no-errors") {
    return { raw: value, advisory, type: raw }
  }

  throw new Error(`wordpress.browser-probe assert supports exists, not-exists, visible, hidden, count, text contains, attr, no-console-errors, no-page-errors, and no-errors: ${value}`)
}

function requireSelectorAssertion(raw: string, advisory: boolean, type: BrowserProbeAssertionSpec["type"], selector: string): BrowserProbeAssertionSpec {
  if (!selector) {
    throw new Error(`wordpress.browser-probe ${type} assertion requires a selector: ${raw}`)
  }
  return { raw, advisory, type, selector }
}

async function executeBrowserProbeAssertion(
  page: Page,
  assertion: BrowserProbeAssertionSpec,
  consoleMessages: Record<string, unknown>[],
  pageErrors: Array<{ type?: string }>,
): Promise<BrowserStepAssertion> {
  const base = {
    kind: "probe" as const,
    assertion: assertion.raw,
    advisory: assertion.advisory,
    selector: assertion.selector,
    name: assertion.name,
    state: assertion.type,
    operator: assertion.operator,
    expected: assertion.expected,
  }

  switch (assertion.type) {
    case "exists": {
      const actual = await page.locator(assertion.selector ?? "").count()
      return { ...base, actual, passed: actual > 0 }
    }
    case "not-exists": {
      const actual = await page.locator(assertion.selector ?? "").count()
      return { ...base, actual, passed: actual === 0 }
    }
    case "visible": {
      const actual = await page.locator(assertion.selector ?? "").first().isVisible().catch(() => false)
      return { ...base, actual, passed: actual === true }
    }
    case "hidden": {
      const locator = page.locator(assertion.selector ?? "")
      const count = await locator.count()
      const visible = count > 0 ? await locator.first().isVisible().catch(() => false) : false
      return { ...base, actual: { count, visible }, passed: !visible }
    }
    case "count": {
      const actual = await page.locator(assertion.selector ?? "").count()
      return { ...base, actual, passed: compareNumbers(actual, Number(assertion.expected), assertion.operator ?? "=") }
    }
    case "text": {
      const actual = await page.locator(assertion.selector ?? "").first().textContent().catch(() => null)
      const expected = String(assertion.expected ?? "")
      return { ...base, actual, passed: typeof actual === "string" && actual.includes(expected) }
    }
    case "attr": {
      const actual = await page.locator(assertion.selector ?? "").first().getAttribute(assertion.name ?? "").catch(() => null)
      const passed = typeof assertion.expected === "undefined" ? actual !== null : actual === String(assertion.expected)
      return { ...base, actual, passed }
    }
    case "no-console-errors": {
      const actual = consoleMessages.filter((message) => message.type === "error").length
      return { ...base, actual, expected: 0, passed: actual === 0 }
    }
    case "no-page-errors": {
      const actual = pageErrors.filter((error) => error.type === "pageerror").length
      return { ...base, actual, expected: 0, passed: actual === 0 }
    }
    case "no-errors": {
      const consoleErrorCount = consoleMessages.filter((message) => message.type === "error").length
      const pageErrorCount = pageErrors.filter((error) => error.type === "pageerror").length
      const actual = { consoleErrors: consoleErrorCount, pageErrors: pageErrorCount }
      return { ...base, actual, expected: { consoleErrors: 0, pageErrors: 0 }, passed: consoleErrorCount === 0 && pageErrorCount === 0 }
    }
  }
}

function compareNumbers(actual: number, expected: number, operator: NonNullable<BrowserProbeAssertionSpec["operator"]>): boolean {
  switch (operator) {
    case "=":
    case "==":
      return actual === expected
    case "!=":
      return actual !== expected
    case ">":
      return actual > expected
    case ">=":
      return actual >= expected
    case "<":
      return actual < expected
    case "<=":
      return actual <= expected
  }
}

export async function browserProbePendingCheckpoints(page: Page): Promise<BrowserProbeCheckpointRecord[]> {
  const pending = await page.evaluate(() => {
    const state = (globalThis as typeof globalThis & { __wpCodeboxBrowserProbe?: { checkpoints?: Array<{ name?: unknown; metadata?: unknown; timestamp?: unknown }> } }).__wpCodeboxBrowserProbe
    const checkpoints = Array.isArray(state?.checkpoints) ? state.checkpoints.splice(0) : []
    return checkpoints.map((checkpoint) => ({
      name: typeof checkpoint.name === "string" ? checkpoint.name : "checkpoint",
      metadata: checkpoint.metadata,
      timestamp: typeof checkpoint.timestamp === "string" ? checkpoint.timestamp : undefined,
    }))
  })

  const records: BrowserProbeCheckpointRecord[] = []
  for (const checkpoint of pending) {
    records.push(await browserProbeCheckpoint(page, checkpoint.name, checkpoint.metadata, checkpoint.timestamp))
  }
  return records
}

export async function browserProbeCheckpoint(page: Page, name: string, metadata?: unknown, timestamp?: string): Promise<BrowserProbeCheckpointRecord> {
  return {
    schema: "wp-codebox/browser-checkpoint/v1",
    name,
    ...(typeof metadata !== "undefined" ? { metadata } : {}),
    timestamp: timestamp ?? now(),
    metrics: await browserProbeMetricsSnapshot(page),
  }
}

async function browserProbeMetricsSnapshot(page: Page): Promise<BrowserProbeMetricsSnapshot> {
  const [pageMetrics, cdpMetrics] = await Promise.all([
    page.evaluate(() => {
      const memory = (performance as Performance & { memory?: { usedJSHeapSize?: number; totalJSHeapSize?: number; jsHeapSizeLimit?: number } }).memory
      const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[]
      const longTasks = ((globalThis as typeof globalThis & { __wpCodeboxBrowserProbe?: { longTasks?: Array<{ duration?: number }> } }).__wpCodeboxBrowserProbe?.longTasks ?? [])
        .map((entry) => Number(entry.duration ?? 0))
        .filter((duration) => Number.isFinite(duration) && duration >= 0)

      return {
        performanceMemory: {
          usedJSHeapSize: finiteNumberOrNull(memory?.usedJSHeapSize),
          totalJSHeapSize: finiteNumberOrNull(memory?.totalJSHeapSize),
          jsHeapSizeLimit: finiteNumberOrNull(memory?.jsHeapSizeLimit),
        },
        dom: {
          nodes: document.querySelectorAll("*").length,
          documents: 1,
          iframes: document.querySelectorAll("iframe").length,
        },
        resources: {
          count: resources.length,
          transferSizeBytes: resourceTotal(resources, "transferSize"),
          encodedBodySizeBytes: resourceTotal(resources, "encodedBodySize"),
          decodedBodySizeBytes: resourceTotal(resources, "decodedBodySize"),
        },
        longTasks: {
          count: longTasks.length,
          totalDurationMs: longTasks.reduce((total, duration) => total + duration, 0),
          maxDurationMs: longTasks.reduce((max, duration) => Math.max(max, duration), 0),
        },
      }

      function finiteNumberOrNull(value: unknown): number | null {
        return typeof value === "number" && Number.isFinite(value) ? value : null
      }

      function resourceTotal(resources: PerformanceResourceTiming[], field: "transferSize" | "encodedBodySize" | "decodedBodySize"): number {
        return resources.reduce((total, resource) => {
          const value = resource[field]
          return total + (Number.isFinite(value) && value > 0 ? value : 0)
        }, 0)
      }
    }),
    browserProbeCdpMetrics(page),
  ])

  return {
    timestamp: now(),
    memory: {
      performanceMemory: pageMetrics.performanceMemory,
      cdpHeap: cdpMetrics.heap,
      domCounters: cdpMetrics.domCounters,
    },
    performance: {
      cdpMetrics: cdpMetrics.performance,
      dom: {
        nodes: cdpMetrics.domCounters.nodes ?? pageMetrics.dom.nodes,
        documents: cdpMetrics.domCounters.documents ?? pageMetrics.dom.documents,
        iframes: pageMetrics.dom.iframes,
      },
      resources: pageMetrics.resources,
      longTasks: pageMetrics.longTasks,
    },
  }
}

async function browserProbeCdpMetrics(page: Page): Promise<{
  performance: Record<string, number>
  domCounters: { documents: number | null; nodes: number | null; jsEventListeners: number | null }
  heap: { usedSize: number | null; totalSize: number | null }
}> {
  const fallback = {
    performance: {},
    domCounters: { documents: null, nodes: null, jsEventListeners: null },
    heap: { usedSize: null, totalSize: null },
  }

  try {
    const session = await page.context().newCDPSession(page)
    try {
      await session.send("Performance.enable").catch(() => undefined)
      const [performanceResult, domCountersResult, heapResult] = await Promise.all([
        session.send("Performance.getMetrics").catch(() => undefined),
        session.send("Memory.getDOMCounters").catch(() => undefined),
        session.send("Runtime.getHeapUsage").catch(() => undefined),
      ])
      return {
        performance: cdpPerformanceMetrics(performanceResult),
        domCounters: cdpDomCounters(domCountersResult),
        heap: cdpHeapUsage(heapResult),
      }
    } finally {
      await session.detach().catch(() => undefined)
    }
  } catch {
    return fallback
  }
}

export function browserProbeMemoryArtifact(checkpoints: BrowserProbeCheckpointRecord[]): BrowserProbeMemoryArtifact {
  const final = checkpoints.at(-1)?.metrics.memory ?? {
    performanceMemory: { usedJSHeapSize: null, totalJSHeapSize: null, jsHeapSizeLimit: null },
    cdpHeap: { usedSize: null, totalSize: null },
    domCounters: { documents: null, nodes: null, jsEventListeners: null },
  }

  return {
    schema: "wp-codebox/browser-memory/v1",
    version: 1,
    capturedAt: now(),
    final,
    peak: browserProbeMemorySummary(checkpoints),
    checkpoints,
  }
}

export function browserProbePerformanceArtifact(checkpoints: BrowserProbeCheckpointRecord[]): BrowserProbePerformanceArtifact {
  const final = checkpoints.at(-1)?.metrics.performance ?? {
    cdpMetrics: {},
    dom: { nodes: 0, documents: 0, iframes: 0 },
    resources: { count: 0, transferSizeBytes: 0, encodedBodySizeBytes: 0, decodedBodySizeBytes: 0 },
    longTasks: { count: 0, totalDurationMs: 0, maxDurationMs: 0 },
  }

  return {
    schema: "wp-codebox/browser-performance/v1",
    version: 1,
    capturedAt: now(),
    final,
    peak: browserProbePerformanceSummary(checkpoints),
    checkpoints,
  }
}
