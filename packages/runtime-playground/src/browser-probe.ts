import type { Page } from "playwright"
import type {
  BrowserProbeCheckpointRecord,
  BrowserProbeMemoryArtifact,
  BrowserProbeMetricsSnapshot,
  BrowserProbeNetworkRecord,
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
  const state = globalThis.__wpCodeboxBrowserProbe = globalThis.__wpCodeboxBrowserProbe || { checkpoints: [], longTasks: [], layoutShifts: [], cls: 0, paintEntries: [], largestContentfulPaint: null };
  state.checkpoints = state.checkpoints || [];
  state.longTasks = state.longTasks || [];
  state.layoutShifts = state.layoutShifts || [];
  state.paintEntries = state.paintEntries || [];
  state.cls = typeof state.cls === 'number' ? state.cls : 0;
  if (state.longTaskObserverInstalled || typeof PerformanceObserver === 'undefined') {
    installLayoutShiftObserver();
    return installPaintObservers();
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
  installLayoutShiftObserver();
  installPaintObservers();

  function installPaintObservers() {
    if (typeof PerformanceObserver === 'undefined') {
      return;
    }
    if (!state.paintObserverInstalled) {
      try {
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            state.paintEntries.push({
              name: String(entry.name || ''),
              startTime: entry.startTime,
              duration: entry.duration,
            });
          }
        });
        observer.observe({ type: 'paint', buffered: true });
        state.paintObserverInstalled = true;
      } catch {
        state.paintObserverInstalled = false;
      }
    }
    if (!state.lcpObserverInstalled) {
      try {
        const observer = new PerformanceObserver((list) => {
          const entries = list.getEntries();
          const entry = entries[entries.length - 1];
          if (entry) {
            state.largestContentfulPaint = {
              name: String(entry.name || 'largest-contentful-paint'),
              startTime: entry.startTime,
              renderTime: entry.renderTime,
              loadTime: entry.loadTime,
              size: entry.size,
              element: sourceSelector(entry.element),
              url: typeof entry.url === 'string' ? entry.url : '',
            };
          }
        });
        observer.observe({ type: 'largest-contentful-paint', buffered: true });
        state.lcpObserverInstalled = true;
      } catch {
        state.lcpObserverInstalled = false;
      }
    }
  }

  function installLayoutShiftObserver() {
    if (state.layoutShiftObserverInstalled || typeof PerformanceObserver === 'undefined') {
      return;
    }
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const value = Number(entry.value || 0);
          const hadRecentInput = entry.hadRecentInput === true;
          if (!hadRecentInput && Number.isFinite(value) && value > 0) {
            state.cls += value;
          }
          state.layoutShifts.push({
            name: String(entry.name || 'layout-shift'),
            startTime: entry.startTime,
            duration: entry.duration,
            value,
            hadRecentInput,
            sources: Array.from(entry.sources || []).slice(0, 5).map((source) => ({
              selector: sourceSelector(source.node),
              node: sourceNodeName(source.node),
              previousRect: sourceRect(source.previousRect),
              currentRect: sourceRect(source.currentRect),
            })),
          });
          if (state.layoutShifts.length > 100) {
            state.layoutShifts.splice(0, state.layoutShifts.length - 100);
          }
        }
      });
      observer.observe({ type: 'layout-shift', buffered: true });
      state.layoutShiftObserverInstalled = true;
    } catch {
      state.layoutShiftObserverInstalled = false;
    }
  }

  function sourceNodeName(node) {
    return node && typeof node.nodeName === 'string' ? node.nodeName.toLowerCase() : null;
  }

  function sourceSelector(node) {
    if (!node || node.nodeType !== 1) {
      return null;
    }
    const parts = [];
    let current = node;
    while (current && current.nodeType === 1 && parts.length < 4) {
      let part = current.nodeName.toLowerCase();
      if (current.id) {
        part += '#' + cssEscape(current.id);
        parts.unshift(part);
        break;
      }
      if (current.classList && current.classList.length > 0) {
        part += '.' + Array.from(current.classList).slice(0, 2).map(cssEscape).join('.');
      }
      parts.unshift(part);
      current = current.parentElement;
    }
    return parts.join(' > ') || null;
  }

  function cssEscape(value) {
    if (globalThis.CSS && typeof globalThis.CSS.escape === 'function') {
      return globalThis.CSS.escape(String(value));
    }
    return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  function sourceRect(rect) {
    return {
      x: finiteNumberOrNull(rect && rect.x),
      y: finiteNumberOrNull(rect && rect.y),
      width: finiteNumberOrNull(rect && rect.width),
      height: finiteNumberOrNull(rect && rect.height),
      top: finiteNumberOrNull(rect && rect.top),
      right: finiteNumberOrNull(rect && rect.right),
      bottom: finiteNumberOrNull(rect && rect.bottom),
      left: finiteNumberOrNull(rect && rect.left),
    };
  }

  function finiteNumberOrNull(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
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
  type: "exists" | "not-exists" | "visible" | "hidden" | "count" | "text" | "attr" | "no-console-errors" | "no-page-errors" | "no-errors" | "request-count-by-host" | "request-count-by-type" | "total-transfer-size" | "metric"
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
  network: BrowserProbeNetworkRecord[],
  metrics: Record<string, number>,
): Promise<BrowserStepAssertion[]> {
  const results: BrowserStepAssertion[] = []
  for (const assertion of assertions) {
    results.push(await executeBrowserProbeAssertion(page, assertion, consoleMessages, pageErrors, network, metrics))
  }
  return results
}

export function browserProbeAssertionsNeedNetwork(assertions: BrowserProbeAssertionSpec[]): boolean {
  return assertions.some((assertion) => assertion.type === "request-count-by-host" || assertion.type === "request-count-by-type" || assertion.type === "total-transfer-size")
}

export function browserProbeAssertionsNeedMetrics(assertions: BrowserProbeAssertionSpec[]): boolean {
  return assertions.some((assertion) => assertion.type === "metric")
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

  for (const type of ["request-count-by-host", "request-count-by-type"] as const) {
    const prefix = `${type}:`
    if (raw.startsWith(prefix)) {
      const parsed = parseBudgetBody(raw.slice(prefix.length).trim(), value)
      return { raw: value, advisory, type, name: parsed.name, operator: parsed.operator, expected: parsed.expected }
    }
  }

  if (raw.startsWith("total-transfer-size")) {
    const parsed = parseBudgetBody(raw.slice("total-transfer-size".length).trim(), value, false)
    return { raw: value, advisory, type: "total-transfer-size", operator: parsed.operator, expected: parsed.expected }
  }

  if (raw.startsWith("metric:")) {
    const parsed = parseBudgetBody(raw.slice("metric:".length).trim(), value)
    return { raw: value, advisory, type: "metric", name: normalizeBrowserMetricName(parsed.name), operator: parsed.operator, expected: parsed.expected }
  }

  const metricBudget = parseBudgetBodyOrUndefined(raw)
  if (metricBudget) {
    return { raw: value, advisory, type: "metric", name: normalizeBrowserMetricName(metricBudget.name), operator: metricBudget.operator, expected: metricBudget.expected }
  }

  throw new Error(`wordpress.browser-probe assert supports exists, not-exists, visible, hidden, count, text contains, attr, no-console-errors, no-page-errors, no-errors, request-count-by-host, request-count-by-type, total-transfer-size, and metric budgets: ${value}`)
}

function parseBudgetBodyOrUndefined(body: string): { name?: string; operator: NonNullable<BrowserProbeAssertionSpec["operator"]>; expected: number } | undefined {
  const parsed = body.match(/^(.*?)(>=|<=|==|!=|=|>|<)\s*(\d+(?:\.\d+)?)$/)
  if (!parsed || !parsed[1].trim()) {
    return undefined
  }

  return { name: parsed[1].trim(), operator: parsed[2] as NonNullable<BrowserProbeAssertionSpec["operator"]>, expected: Number.parseFloat(parsed[3]) }
}

function normalizeBrowserMetricName(name: string | undefined): string | undefined {
  if (!name || name.startsWith("browser_")) {
    return name
  }

  return `browser_${name}`
}

function parseBudgetBody(body: string, raw: string, requiresName = true): { name?: string; operator: NonNullable<BrowserProbeAssertionSpec["operator"]>; expected: number } {
  const pattern = requiresName ? /^(.*?)(>=|<=|==|!=|=|>|<)\s*(\d+(?:\.\d+)?)$/ : /^(>=|<=|==|!=|=|>|<)\s*(\d+(?:\.\d+)?)$/
  const parsed = body.match(pattern)
  if (!parsed) {
    throw new Error(`wordpress.browser-probe budget assertion must look like <name><op><number> or total-transfer-size<op><number>: ${raw}`)
  }

  const operator = (requiresName ? parsed[2] : parsed[1]) as NonNullable<BrowserProbeAssertionSpec["operator"]>
  const expected = Number.parseFloat(requiresName ? parsed[3] : parsed[2])
  const name = requiresName ? parsed[1].trim() : undefined
  if (requiresName && !name) {
    throw new Error(`wordpress.browser-probe budget assertion requires a name: ${raw}`)
  }

  return { name, operator, expected }
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
  network: BrowserProbeNetworkRecord[],
  metrics: Record<string, number>,
): Promise<BrowserStepAssertion> {
  const base = {
    kind: "probe" as const,
    id: assertion.raw,
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
      return finalizeProbeAssertion(base, actual, assertion.expected, actual > 0)
    }
    case "not-exists": {
      const actual = await page.locator(assertion.selector ?? "").count()
      return finalizeProbeAssertion(base, actual, assertion.expected, actual === 0)
    }
    case "visible": {
      const actual = await page.locator(assertion.selector ?? "").first().isVisible().catch(() => false)
      return finalizeProbeAssertion(base, actual, assertion.expected, actual === true)
    }
    case "hidden": {
      const locator = page.locator(assertion.selector ?? "")
      const count = await locator.count()
      const visible = count > 0 ? await locator.first().isVisible().catch(() => false) : false
      return finalizeProbeAssertion(base, { count, visible }, assertion.expected, !visible)
    }
    case "count": {
      const actual = await page.locator(assertion.selector ?? "").count()
      return finalizeProbeAssertion(base, actual, assertion.expected, compareNumbers(actual, Number(assertion.expected), assertion.operator ?? "="))
    }
    case "text": {
      const actual = await page.locator(assertion.selector ?? "").first().textContent().catch(() => null)
      const expected = String(assertion.expected ?? "")
      return finalizeProbeAssertion(base, actual, expected, typeof actual === "string" && actual.includes(expected))
    }
    case "attr": {
      const actual = await page.locator(assertion.selector ?? "").first().getAttribute(assertion.name ?? "").catch(() => null)
      const passed = typeof assertion.expected === "undefined" ? actual !== null : actual === String(assertion.expected)
      return finalizeProbeAssertion(base, actual, assertion.expected, passed)
    }
    case "no-console-errors": {
      const actual = consoleMessages.filter((message) => message.type === "error").length
      return finalizeProbeAssertion(base, actual, 0, actual === 0, ["files/browser/console.jsonl"])
    }
    case "no-page-errors": {
      const actual = pageErrors.filter((error) => error.type === "pageerror").length
      return finalizeProbeAssertion(base, actual, 0, actual === 0, ["files/browser/errors.jsonl"])
    }
    case "no-errors": {
      const consoleErrorCount = consoleMessages.filter((message) => message.type === "error").length
      const pageErrorCount = pageErrors.filter((error) => error.type === "pageerror").length
      const actual = { consoleErrors: consoleErrorCount, pageErrors: pageErrorCount }
      return finalizeProbeAssertion(base, actual, { consoleErrors: 0, pageErrors: 0 }, consoleErrorCount === 0 && pageErrorCount === 0, ["files/browser/console.jsonl", "files/browser/errors.jsonl"])
    }
    case "request-count-by-host": {
      const actual = network.filter((record) => requestHost(record.url) === assertion.name).length
      return finalizeProbeAssertion(base, actual, assertion.expected, compareNumbers(actual, Number(assertion.expected), assertion.operator ?? "<="), ["files/browser/network.jsonl"])
    }
    case "request-count-by-type": {
      const actual = network.filter((record) => record.resourceType === assertion.name).length
      return finalizeProbeAssertion(base, actual, assertion.expected, compareNumbers(actual, Number(assertion.expected), assertion.operator ?? "<="), ["files/browser/network.jsonl"])
    }
    case "total-transfer-size": {
      const actual = network.reduce((total, record) => total + (typeof record.transferSize === "number" && Number.isFinite(record.transferSize) ? record.transferSize : 0), 0)
      return finalizeProbeAssertion(base, actual, assertion.expected, compareNumbers(actual, Number(assertion.expected), assertion.operator ?? "<="), ["files/browser/network.jsonl"])
    }
    case "metric": {
      const actual = metrics[assertion.name ?? ""]
      const observed = typeof actual === "number" && Number.isFinite(actual) ? actual : null
      const passed = typeof observed === "number" && compareNumbers(observed, Number(assertion.expected), assertion.operator ?? "<=")
      return finalizeProbeAssertion(base, observed, assertion.expected, passed, ["files/browser/performance.json", "files/browser/memory.json"])
    }
  }
}

function finalizeProbeAssertion(
  base: Omit<BrowserStepAssertion, "passed">,
  observed: unknown,
  expectedBudget: unknown,
  passed: boolean,
  supportingArtifacts: string[] = [],
): BrowserStepAssertion {
  return {
    ...base,
    status: passed ? "pass" : base.advisory ? "warn" : "fail",
    expected: expectedBudget,
    expectedBudget,
    actual: observed,
    observed,
    ...(supportingArtifacts.length > 0 ? { supportingArtifacts } : {}),
    passed,
  }
}

function requestHost(url: string): string | undefined {
  try {
    return new URL(url).host
  } catch {
    return undefined
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
      const layoutShiftState = (globalThis as typeof globalThis & {
        __wpCodeboxBrowserProbe?: {
          cls?: number
          layoutShifts?: Array<{
            name?: string
            startTime?: number
            duration?: number
            value?: number
            hadRecentInput?: boolean
            sources?: Array<{
              selector?: string | null
              node?: string | null
              previousRect?: Record<string, number | null>
              currentRect?: Record<string, number | null>
            }>
          }>
          paintEntries?: Array<{ name?: string; startTime?: number; duration?: number }>
          largestContentfulPaint?: {
            startTime?: number
            renderTime?: number
            loadTime?: number
            size?: number
            element?: string | null
            url?: string
          } | null
        }
      }).__wpCodeboxBrowserProbe
      const navigation = navigationTimingSummary(performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)
      const paint = paintTimingSummary(layoutShiftState?.paintEntries ?? [], layoutShiftState?.largestContentfulPaint ?? null)
      const layoutShifts = (layoutShiftState?.layoutShifts ?? [])
        .map((entry) => ({
          name: typeof entry.name === "string" ? entry.name : "layout-shift",
          startTime: finiteNumberOrZero(entry.startTime),
          duration: finiteNumberOrZero(entry.duration),
          value: finiteNumberOrZero(entry.value),
          hadRecentInput: entry.hadRecentInput === true,
          sources: Array.isArray(entry.sources) ? entry.sources.map((source) => ({
            selector: typeof source.selector === "string" ? source.selector : null,
            node: typeof source.node === "string" ? source.node : null,
            previousRect: source.previousRect && typeof source.previousRect === "object" ? source.previousRect : {},
            currentRect: source.currentRect && typeof source.currentRect === "object" ? source.currentRect : {},
          })) : [],
        }))
        .filter((entry) => entry.value >= 0)
      const layoutShiftsWithoutRecentInput = layoutShifts.filter((entry) => !entry.hadRecentInput)

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
        navigation,
        paint,
        longTasks: {
          count: longTasks.length,
          totalDurationMs: longTasks.reduce((total, duration) => total + duration, 0),
          maxDurationMs: longTasks.reduce((max, duration) => Math.max(max, duration), 0),
        },
        layoutShifts: {
          cls: finiteNumberOrZero(layoutShiftState?.cls),
          count: layoutShiftsWithoutRecentInput.length,
          totalCount: layoutShifts.length,
          max: layoutShiftsWithoutRecentInput.reduce((max, entry) => Math.max(max, entry.value), 0),
          entries: layoutShifts,
        },
      }

      function finiteNumberOrNull(value: unknown): number | null {
        return typeof value === "number" && Number.isFinite(value) ? value : null
      }

      function finiteNumberOrZero(value: unknown): number {
        return typeof value === "number" && Number.isFinite(value) ? value : 0
      }

      function resourceTotal(resources: PerformanceResourceTiming[], field: "transferSize" | "encodedBodySize" | "decodedBodySize"): number {
        return resources.reduce((total, resource) => {
          const value = resource[field]
          return total + (Number.isFinite(value) && value > 0 ? value : 0)
        }, 0)
      }

      function navigationTimingSummary(entry: PerformanceNavigationTiming | undefined) {
        return {
          type: typeof entry?.type === "string" ? entry.type : null,
          redirectCount: finiteNumberOrZero(entry?.redirectCount),
          durationMs: relativeTiming(entry?.duration),
          domContentLoadedMs: relativeTiming(entry?.domContentLoadedEventEnd),
          loadEventMs: relativeTiming(entry?.loadEventEnd),
          responseStartMs: relativeTiming(entry?.responseStart),
          responseEndMs: relativeTiming(entry?.responseEnd),
          requestStartMs: relativeTiming(entry?.requestStart),
          ttfbMs: ttfbTiming(entry),
          redirectMs: entry ? durationBetween(entry.redirectStart, entry.redirectEnd) : null,
        }
      }

      function paintTimingSummary(entries: Array<{ name?: string; startTime?: number }>, lcp: { startTime?: number; renderTime?: number; loadTime?: number; size?: number; element?: string | null; url?: string } | null) {
        const paintEntries = [...performance.getEntriesByType("paint"), ...entries]
        return {
          firstPaintMs: firstEntryStartTime(paintEntries, "first-paint"),
          firstContentfulPaintMs: firstEntryStartTime(paintEntries, "first-contentful-paint"),
          largestContentfulPaintMs: lcpTiming(lcp),
          largestContentfulPaintSize: finiteNumberOrNull(lcp?.size),
          largestContentfulPaintElement: typeof lcp?.element === "string" ? lcp.element : null,
          largestContentfulPaintUrl: typeof lcp?.url === "string" && lcp.url.length > 0 ? lcp.url : null,
        }
      }

      function firstEntryStartTime(entries: Array<{ name?: string; startTime?: number }>, name: string): number | null {
        const entry = entries.find((candidate) => candidate.name === name)
        return finiteNumberOrNull(entry?.startTime)
      }

      function lcpTiming(entry: { startTime?: number; renderTime?: number; loadTime?: number } | null): number | null {
        return finiteNumberOrNull(entry?.renderTime) ?? finiteNumberOrNull(entry?.loadTime) ?? finiteNumberOrNull(entry?.startTime)
      }

      function ttfbTiming(entry: PerformanceNavigationTiming | undefined): number | null {
        if (!entry) {
          return null
        }
        return durationBetween(entry.requestStart, entry.responseStart) ?? relativeTiming(entry.responseStart)
      }

      function relativeTiming(value: unknown): number | null {
        const timing = finiteNumberOrNull(value)
        return timing !== null && timing >= 0 ? timing : null
      }

      function durationBetween(start: unknown, end: unknown): number | null {
        const startTime = finiteNumberOrNull(start)
        const endTime = finiteNumberOrNull(end)
        if (startTime === null || endTime === null || endTime < startTime) {
          return null
        }
        return endTime - startTime
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
      navigation: pageMetrics.navigation,
      paint: pageMetrics.paint,
      dom: {
        nodes: cdpMetrics.domCounters.nodes ?? pageMetrics.dom.nodes,
        documents: cdpMetrics.domCounters.documents ?? pageMetrics.dom.documents,
        iframes: pageMetrics.dom.iframes,
      },
      resources: pageMetrics.resources,
      longTasks: pageMetrics.longTasks,
      layoutShifts: pageMetrics.layoutShifts,
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
    navigation: emptyNavigationTimingSummary(),
    paint: emptyPaintTimingSummary(),
    dom: { nodes: 0, documents: 0, iframes: 0 },
    resources: { count: 0, transferSizeBytes: 0, encodedBodySizeBytes: 0, decodedBodySizeBytes: 0 },
    longTasks: { count: 0, totalDurationMs: 0, maxDurationMs: 0 },
    layoutShifts: { cls: 0, count: 0, totalCount: 0, max: 0, entries: [] },
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

function emptyNavigationTimingSummary() {
  return {
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
}

function emptyPaintTimingSummary() {
  return {
    firstPaintMs: null,
    firstContentfulPaintMs: null,
    largestContentfulPaintMs: null,
    largestContentfulPaintSize: null,
    largestContentfulPaintElement: null,
    largestContentfulPaintUrl: null,
  }
}
