import { access, readFile } from "node:fs/promises"
import { join } from "node:path"
import type { ConsoleMessage, Request, Response } from "playwright"
import type {
  BrowserProbeArtifact,
  BrowserProbeCheckpointRecord,
  BrowserProbeErrorRecord,
  BrowserProbeMemoryArtifact,
  BrowserProbeMemorySummary,
  BrowserProbeMetricDigest,
  BrowserProbeNetworkRecord,
  BrowserProbeNetworkSizes,
  BrowserProbePerformanceArtifact,
  BrowserProbePerformanceSummary,
} from "./browser-artifacts.js"

export interface BrowserArtifactMetricsResult {
  schema: "wp-codebox/browser-metrics/v1"
  bundleDirectory: string
  hasBrowserMetrics: boolean
  metrics: Record<string, number>
  artifacts: Record<string, { path: string; kind: "json" | "jsonl" }>
}

function now(): string {
  return new Date().toISOString()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function browserProbeMemorySummary(checkpoints: BrowserProbeCheckpointRecord[]): BrowserProbeMemorySummary {
  return {
    usedJSHeapSize: metricDigest(checkpoints.map((checkpoint) => checkpoint.metrics.memory.performanceMemory.usedJSHeapSize ?? checkpoint.metrics.memory.cdpHeap.usedSize)),
    totalJSHeapSize: metricDigest(checkpoints.map((checkpoint) => checkpoint.metrics.memory.performanceMemory.totalJSHeapSize ?? checkpoint.metrics.memory.cdpHeap.totalSize)),
    jsHeapSizeLimit: lastNumber(checkpoints.map((checkpoint) => checkpoint.metrics.memory.performanceMemory.jsHeapSizeLimit)),
    domNodes: metricDigest(checkpoints.map((checkpoint) => checkpoint.metrics.memory.domCounters.nodes ?? checkpoint.metrics.performance.dom.nodes)),
    documents: metricDigest(checkpoints.map((checkpoint) => checkpoint.metrics.memory.domCounters.documents ?? checkpoint.metrics.performance.dom.documents)),
    jsEventListeners: metricDigest(checkpoints.map((checkpoint) => checkpoint.metrics.memory.domCounters.jsEventListeners)),
  }
}

export function browserProbePerformanceSummary(checkpoints: BrowserProbeCheckpointRecord[]): BrowserProbePerformanceSummary {
  const final = checkpoints.at(-1)?.metrics.performance
  const metricNames = new Set<string>()
  for (const checkpoint of checkpoints) {
    for (const key of Object.keys(checkpoint.metrics.performance.cdpMetrics)) {
      metricNames.add(key)
    }
  }

  return {
    navigation: final?.navigation ?? {
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
    },
    paint: final?.paint ?? {
      firstPaintMs: null,
      firstContentfulPaintMs: null,
      largestContentfulPaintMs: null,
      largestContentfulPaintSize: null,
      largestContentfulPaintElement: null,
      largestContentfulPaintUrl: null,
    },
    resources: final?.resources.count ?? 0,
    transferSizeBytes: final?.resources.transferSizeBytes ?? 0,
    encodedBodySizeBytes: final?.resources.encodedBodySizeBytes ?? 0,
    decodedBodySizeBytes: final?.resources.decodedBodySizeBytes ?? 0,
    longTasks: final?.longTasks.count ?? 0,
    longTaskDurationMs: final?.longTasks.totalDurationMs ?? 0,
    layoutShifts: {
      cls: final?.layoutShifts.cls ?? 0,
      count: final?.layoutShifts.count ?? 0,
      totalCount: final?.layoutShifts.totalCount ?? 0,
      max: final?.layoutShifts.max ?? 0,
    },
    domNodes: metricDigest(checkpoints.map((checkpoint) => checkpoint.metrics.performance.dom.nodes)),
    cdpMetrics: Object.fromEntries([...metricNames].sort().map((name) => [name, metricDigest(checkpoints.map((checkpoint) => checkpoint.metrics.performance.cdpMetrics[name]))])),
  }
}

export function cdpPerformanceMetrics(value: unknown): Record<string, number> {
  if (!isRecord(value) || !Array.isArray(value.metrics)) {
    return {}
  }

  return Object.fromEntries(value.metrics.flatMap((metric) => {
    if (!isRecord(metric) || typeof metric.name !== "string" || typeof metric.value !== "number" || !Number.isFinite(metric.value)) {
      return []
    }
    return [[metric.name, metric.value]]
  }))
}

export function cdpDomCounters(value: unknown): { documents: number | null; nodes: number | null; jsEventListeners: number | null } {
  return {
    documents: recordNumberOrNull(value, "documents"),
    nodes: recordNumberOrNull(value, "nodes"),
    jsEventListeners: recordNumberOrNull(value, "jsEventListeners"),
  }
}

export function cdpHeapUsage(value: unknown): { usedSize: number | null; totalSize: number | null } {
  return {
    usedSize: recordNumberOrNull(value, "usedSize"),
    totalSize: recordNumberOrNull(value, "totalSize"),
  }
}

function recordNumberOrNull(value: unknown, key: string): number | null {
  if (!isRecord(value)) {
    return null
  }
  const field = value[key]
  return typeof field === "number" && Number.isFinite(field) ? field : null
}

function metricDigest(values: Array<number | null | undefined>): BrowserProbeMetricDigest {
  const numbers = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value))
  return {
    final: numbers.at(-1) ?? null,
    peak: numbers.length > 0 ? Math.max(...numbers) : null,
  }
}

function lastNumber(values: Array<number | null | undefined>): number | null {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index]
    if (typeof value === "number" && Number.isFinite(value)) {
      return value
    }
  }

  return null
}

export function browserProbeBenchMetrics(memoryArtifact?: BrowserProbeMemoryArtifact, performanceArtifact?: BrowserProbePerformanceArtifact): Record<string, number> {
  const memory = memoryArtifact?.peak
  const performance = performanceArtifact?.final
  return {
    browser_peak_used_js_heap_bytes: memory?.usedJSHeapSize.peak ?? 0,
    browser_final_used_js_heap_bytes: memory?.usedJSHeapSize.final ?? 0,
    browser_checkpoint_count: performanceArtifact?.checkpoints.length ?? memoryArtifact?.checkpoints.length ?? 0,
    browser_dom_node_count: performance?.dom.nodes ?? memory?.domNodes.final ?? 0,
    browser_iframe_count: performance?.dom.iframes ?? 0,
    browser_resource_count: performance?.resources.count ?? 0,
    browser_transfer_size_bytes: performance?.resources.transferSizeBytes ?? 0,
    browser_nav_duration_ms: performance?.navigation.durationMs ?? 0,
    browser_dom_content_loaded_ms: performance?.navigation.domContentLoadedMs ?? 0,
    browser_load_event_ms: performance?.navigation.loadEventMs ?? 0,
    browser_response_start_ms: performance?.navigation.responseStartMs ?? 0,
    browser_response_end_ms: performance?.navigation.responseEndMs ?? 0,
    browser_request_start_ms: performance?.navigation.requestStartMs ?? 0,
    browser_ttfb_ms: performance?.navigation.ttfbMs ?? 0,
    browser_redirect_ms: performance?.navigation.redirectMs ?? 0,
    browser_first_paint_ms: performance?.paint.firstPaintMs ?? 0,
    browser_fcp_ms: performance?.paint.firstContentfulPaintMs ?? 0,
    browser_lcp_ms: performance?.paint.largestContentfulPaintMs ?? 0,
    browser_lcp_size: performance?.paint.largestContentfulPaintSize ?? 0,
    browser_long_task_count: performance?.longTasks.count ?? 0,
    browser_long_task_total_ms: performance?.longTasks.totalDurationMs ?? 0,
    browser_cls: performance?.layoutShifts.cls ?? 0,
    browser_layout_shift_count: performance?.layoutShifts.count ?? 0,
    browser_layout_shift_max: performance?.layoutShifts.max ?? 0,
  }
}

export function promoteBrowserMetricsToBenchResults(raw: string, probes: BrowserProbeArtifact[]): string {
  const metrics = combinedBrowserBenchMetrics(probes)
  if (!metrics) {
    return raw
  }

  const parsed = JSON.parse(raw) as Record<string, unknown>
  const scenarios = Array.isArray(parsed.scenarios) ? parsed.scenarios : []
  for (const scenario of scenarios) {
    if (!isRecord(scenario)) {
      continue
    }

    const existingMetrics = isRecord(scenario.metrics) ? scenario.metrics : {}
    scenario.metrics = {
      ...existingMetrics,
      ...Object.fromEntries(Object.entries(metrics).map(([name, value]) => [name, benchMetricRecord(name, value)])),
    }
  }

  return `${JSON.stringify(parsed, null, 2)}\n`
}

function benchMetricRecord(name: string, value: number): { unit: string; samples: Record<string, number> } {
  return {
    unit: benchMetricUnit(name),
    samples: {
      count: 1,
      mean: value,
      p50: value,
      p95: value,
      p99: value,
      min: value,
      max: value,
    },
  }
}

function benchMetricUnit(name: string): string {
  if (name.endsWith("_ms")) {
    return "ms"
  }
  if (name.endsWith("_bytes")) {
    return "bytes"
  }
  if (name.endsWith("_count")) {
    return "count"
  }
  return "unitless"
}

export async function browserArtifactMetrics(bundleDirectory: string): Promise<BrowserArtifactMetricsResult> {
  const summaryPath = join(bundleDirectory, "files", "browser", "summary.json")
  const artifacts: BrowserArtifactMetricsResult["artifacts"] = {}

  await addBrowserArtifactIfPresent(artifacts, bundleDirectory, "summary", "summary.json", "json")
  await addBrowserArtifactIfPresent(artifacts, bundleDirectory, "lifecycle", "lifecycle.json", "json")
  await addBrowserArtifactIfPresent(artifacts, bundleDirectory, "memory", "memory.json", "json")
  await addBrowserArtifactIfPresent(artifacts, bundleDirectory, "performance", "performance.json", "json")
  await addBrowserArtifactIfPresent(artifacts, bundleDirectory, "checkpoints", "checkpoints.jsonl", "jsonl")

  let metrics: Record<string, number> = {}
  try {
    const summary = JSON.parse(await readFile(summaryPath, "utf8")) as Record<string, unknown>
    const browserSummary = isRecord(summary.summary) ? summary.summary : {}
    metrics = isNumericMetricRecord(browserSummary.metrics) ? browserSummary.metrics : {}
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error
    }
  }

  return {
    schema: "wp-codebox/browser-metrics/v1",
    bundleDirectory,
    hasBrowserMetrics: Object.keys(metrics).length > 0,
    metrics,
    artifacts,
  }
}

async function addBrowserArtifactIfPresent(artifacts: BrowserArtifactMetricsResult["artifacts"], bundleDirectory: string, name: string, file: string, kind: "json" | "jsonl"): Promise<void> {
  const relativePath = `files/browser/${file}`
  try {
    await access(join(bundleDirectory, relativePath))
  } catch (error) {
    if (isMissingFileError(error)) {
      return
    }
    throw error
  }

  artifacts[name] = { path: relativePath, kind }
}

function isNumericMetricRecord(value: unknown): value is Record<string, number> {
  if (!isRecord(value)) {
    return false
  }

  return Object.values(value).every((metric) => typeof metric === "number" && Number.isFinite(metric))
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT"
}

function combinedBrowserBenchMetrics(probes: BrowserProbeArtifact[]): Record<string, number> | undefined {
  const metricSets = probes.map((probe) => probe.summary.metrics).filter((metrics): metrics is Record<string, number> => isRecord(metrics))
  if (metricSets.length === 0) {
    return undefined
  }

  const finalMetrics = metricSets.at(-1) ?? {}
  return {
    browser_peak_used_js_heap_bytes: Math.max(...metricSets.map((metrics) => metrics.browser_peak_used_js_heap_bytes ?? 0)),
    browser_final_used_js_heap_bytes: finalMetrics.browser_final_used_js_heap_bytes ?? 0,
    browser_checkpoint_count: sumMetric(metricSets, "browser_checkpoint_count"),
    browser_dom_node_count: finalMetrics.browser_dom_node_count ?? 0,
    browser_iframe_count: finalMetrics.browser_iframe_count ?? 0,
    browser_resource_count: finalMetrics.browser_resource_count ?? 0,
    browser_transfer_size_bytes: finalMetrics.browser_transfer_size_bytes ?? 0,
    browser_long_task_count: sumMetric(metricSets, "browser_long_task_count"),
    browser_long_task_total_ms: sumMetric(metricSets, "browser_long_task_total_ms"),
    browser_cls: sumMetric(metricSets, "browser_cls"),
    browser_layout_shift_count: sumMetric(metricSets, "browser_layout_shift_count"),
    browser_layout_shift_max: maxMetric(metricSets, "browser_layout_shift_max"),
  }
}

function sumMetric(metricSets: Array<Record<string, number>>, name: string): number {
  return metricSets.reduce((total, metrics) => total + (metrics[name] ?? 0), 0)
}

function maxMetric(metricSets: Array<Record<string, number>>, name: string): number {
  return Math.max(...metricSets.map((metrics) => metrics[name] ?? 0))
}

export async function serializeBrowserFinishedRequest(request: Request): Promise<BrowserProbeNetworkRecord> {
  const response = await request.response()
  if (!response) {
    return {
      type: "response",
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      timestamp: now(),
      timing: browserRequestTiming(request),
    }
  }

  return serializeBrowserResponse(response)
}

export async function serializeBrowserResponse(response: Response): Promise<BrowserProbeNetworkRecord> {
  const request = response.request()
  const sizes = await browserRequestSizes(request)
  const transferSize = sizes ? sizes.responseHeadersSize + sizes.responseBodySize : undefined
  return {
    type: "response",
    url: response.url(),
    method: request.method(),
    resourceType: request.resourceType(),
    status: response.status(),
    statusText: response.statusText(),
    ok: response.ok(),
    contentType: response.headers()["content-type"] ?? null,
    timing: browserRequestTiming(request),
    ...(sizes ? { sizes } : {}),
    ...(typeof transferSize === "number" ? { transferSize } : {}),
    ...(sizes ? { bodySize: sizes.responseBodySize } : {}),
    ...(sizes ? { requestBodySize: sizes.requestBodySize } : {}),
    ...(sizes ? { responseBodySize: sizes.responseBodySize } : {}),
    timestamp: now(),
  }
}

export function serializeBrowserRequestFailure(request: Request): BrowserProbeNetworkRecord {
  return {
    type: "requestfailed",
    url: request.url(),
    method: request.method(),
    resourceType: request.resourceType(),
    timing: browserRequestTiming(request),
    failure: request.failure(),
    timestamp: now(),
  }
}

function browserRequestTiming(request: Request): Record<string, number> {
  return Object.fromEntries(
    Object.entries(request.timing()).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])),
  )
}

async function browserRequestSizes(request: Request): Promise<BrowserProbeNetworkSizes | undefined> {
  const maybeSizedRequest = request as Request & { sizes?: () => Promise<BrowserProbeNetworkSizes> }
  if (typeof maybeSizedRequest.sizes !== "function") {
    return undefined
  }

  try {
    return await maybeSizedRequest.sizes()
  } catch {
    return undefined
  }
}

export function serializeBrowserConsoleMessage(message: ConsoleMessage): Record<string, unknown> {
  return {
    type: message.type(),
    text: message.text(),
    location: message.location(),
    timestamp: now(),
  }
}

export function serializeBrowserError(type: BrowserProbeErrorRecord["type"], error: unknown): BrowserProbeErrorRecord {
  if (error instanceof Error) {
    return { type, name: error.name, message: error.message, stack: error.stack, timestamp: now() }
  }

  return { type, name: "Error", message: String(error), timestamp: now() }
}

export function jsonLines(records: unknown[]): string {
  return records.length > 0 ? `${records.map((record) => JSON.stringify(record)).join("\n")}\n` : ""
}
