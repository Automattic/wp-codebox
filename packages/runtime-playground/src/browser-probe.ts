import type { Page } from "playwright"
import type {
  BrowserProbeCheckpointRecord,
  BrowserProbeMemoryArtifact,
  BrowserProbeMetricsSnapshot,
  BrowserProbePerformanceArtifact,
  BrowserProbeReplayability,
  BrowserProbeViewport,
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
