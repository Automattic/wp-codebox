import { access, readFile } from "node:fs/promises"
import { join } from "node:path"
import type { ArtifactManifest } from "@automattic/wp-codebox-core"
import type { ConsoleMessage, Request, Response } from "playwright"
import type {
  BrowserArtifact,
  BrowserProbeCheckpointRecord,
  BrowserProbeErrorRecord,
  BrowserProbeMemoryArtifact,
  BrowserProbeMemorySummary,
  BrowserProbeMetricDigest,
  BrowserProbeNetworkRecord,
  BrowserProbeNetworkSizes,
  BrowserProbePhaseFirstRequest,
  BrowserProbePhaseMetric,
  BrowserProbePhaseMetricsArtifact,
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
    ...browserProbePhaseBenchMetrics(performanceArtifact?.phaseMetrics),
  }
}

export function browserProbePhaseMetrics(input: {
  checkpoints: BrowserProbeCheckpointRecord[]
  consoleMessages: Record<string, unknown>[]
  errors: BrowserProbeErrorRecord[]
  network: BrowserProbeNetworkRecord[]
  startedAt: string
}): BrowserProbePhaseMetricsArtifact | undefined {
  const phases = browserProbePhaseBoundaries(input.checkpoints).map((checkpoint): BrowserProbePhaseMetric => {
    const network = recordsBefore(input.network, checkpoint.timestamp)
    const consoleErrors = recordsBefore(input.consoleMessages, checkpoint.timestamp).filter((message) => message.type === "error").length
    const pageErrors = recordsBefore(input.errors, checkpoint.timestamp).filter((error) => error.type === "pageerror").length
    const probeErrors = recordsBefore(input.errors, checkpoint.timestamp).filter((error) => error.type === "probe-error").length
    const firstRequest = firstNetworkRequest(network, input.startedAt)
    return {
      name: phaseNameForCheckpoint(checkpoint.name),
      checkpoint: checkpoint.name,
      timestamp: checkpoint.timestamp,
      elapsedMs: elapsedMs(input.startedAt, checkpoint.timestamp),
      network: {
        requests: network.length,
        responses: network.filter((record) => record.type === "response").length,
        failures: network.filter((record) => record.type === "requestfailed").length,
        transferSizeBytes: sumNetworkField(network, "transferSize"),
        responseBodySizeBytes: sumNetworkField(network, "responseBodySize"),
        firstRequest,
        firstRequestByHost: firstNetworkRequestByHost(network, input.startedAt),
      },
      errors: {
        console: consoleErrors,
        page: pageErrors,
        probe: probeErrors,
      },
      performance: {
        resources: checkpoint.metrics.performance.resources.count,
        transferSizeBytes: checkpoint.metrics.performance.resources.transferSizeBytes,
        domNodes: checkpoint.metrics.performance.dom.nodes,
        firstContentfulPaintMs: checkpoint.metrics.performance.paint.firstContentfulPaintMs,
        largestContentfulPaintMs: checkpoint.metrics.performance.paint.largestContentfulPaintMs,
      },
    }
  })

  if (phases.length === 0) {
    return undefined
  }

  return {
    schema: "wp-codebox/browser-phase-metrics/v1",
    version: 1,
    capturedAt: now(),
    phases,
  }
}

function browserProbePhaseBenchMetrics(phaseMetrics: BrowserProbePhaseMetricsArtifact | undefined): Record<string, number> {
  if (!phaseMetrics) {
    return {}
  }

  const metrics: Record<string, number> = {}
  for (const phase of phaseMetrics.phases) {
    const prefix = `browser_phase_${metricNameFragment(phase.name)}`
    metrics[`${prefix}_elapsed_ms`] = phase.elapsedMs ?? 0
    metrics[`${prefix}_request_count`] = phase.network.requests
    metrics[`${prefix}_response_count`] = phase.network.responses
    metrics[`${prefix}_failure_count`] = phase.network.failures
    metrics[`${prefix}_transfer_size_bytes`] = phase.network.transferSizeBytes
    metrics[`${prefix}_response_body_size_bytes`] = phase.network.responseBodySizeBytes
    metrics[`${prefix}_console_error_count`] = phase.errors.console
    metrics[`${prefix}_page_error_count`] = phase.errors.page
    metrics[`${prefix}_probe_error_count`] = phase.errors.probe
    metrics[`${prefix}_resource_count`] = phase.performance.resources
    metrics[`${prefix}_resource_transfer_size_bytes`] = phase.performance.transferSizeBytes
    metrics[`${prefix}_dom_node_count`] = phase.performance.domNodes
    metrics[`${prefix}_fcp_ms`] = phase.performance.firstContentfulPaintMs ?? 0
    metrics[`${prefix}_lcp_ms`] = phase.performance.largestContentfulPaintMs ?? 0
  }
  return metrics
}

function browserProbePhaseBoundaries(checkpoints: BrowserProbeCheckpointRecord[]): BrowserProbeCheckpointRecord[] {
  const seen = new Set<string>()
  const boundaries: BrowserProbeCheckpointRecord[] = []
  for (const checkpoint of checkpoints) {
    const name = phaseNameForCheckpoint(checkpoint.name)
    if (!name || seen.has(name)) {
      continue
    }
    seen.add(name)
    boundaries.push(checkpoint)
  }
  return boundaries
}

function phaseNameForCheckpoint(name: string): string {
  if (name.startsWith("after-")) {
    return `before-${name.slice("after-".length)}-complete`
  }
  if (name === "final") {
    return "before-final"
  }
  return `before-${name}`
}

function recordsBefore<T extends { timestamp?: unknown }>(records: T[], timestamp: string): T[] {
  const boundary = Date.parse(timestamp)
  if (!Number.isFinite(boundary)) {
    return []
  }
  return records.filter((record) => {
    const value = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN
    return Number.isFinite(value) && value <= boundary
  })
}

function firstNetworkRequest(records: BrowserProbeNetworkRecord[], startedAt: string): BrowserProbePhaseFirstRequest | null {
  const sorted = [...records].sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))
  const first = sorted[0]
  return first ? networkRequestSummary(first, startedAt) : null
}

function firstNetworkRequestByHost(records: BrowserProbeNetworkRecord[], startedAt: string): Record<string, BrowserProbePhaseFirstRequest> {
  const byHost: Record<string, BrowserProbePhaseFirstRequest> = {}
  for (const record of [...records].sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))) {
    const host = requestHost(record.url) || "unknown"
    if (!byHost[host]) {
      byHost[host] = networkRequestSummary(record, startedAt, host)
    }
  }
  return Object.fromEntries(Object.entries(byHost).sort(([left], [right]) => left.localeCompare(right)))
}

function networkRequestSummary(record: BrowserProbeNetworkRecord, startedAt: string, host = requestHost(record.url) || "unknown"): BrowserProbePhaseFirstRequest {
  return {
    url: record.url,
    host,
    method: record.method,
    resourceType: record.resourceType,
    timestamp: record.timestamp,
    elapsedMs: elapsedMs(startedAt, record.timestamp),
    ...(typeof record.status === "number" ? { status: record.status } : {}),
  }
}

function sumNetworkField(records: BrowserProbeNetworkRecord[], field: "transferSize" | "responseBodySize"): number {
  return records.reduce((total, record) => {
    const value = record[field]
    return total + (typeof value === "number" && Number.isFinite(value) ? value : 0)
  }, 0)
}

function requestHost(url: string): string | undefined {
  try {
    return new URL(url).host
  } catch {
    return undefined
  }
}

function elapsedMs(startedAt: string, timestamp: string): number | null {
  const start = Date.parse(startedAt)
  const end = Date.parse(timestamp)
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null
}

function metricNameFragment(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase()
}

export function promoteBrowserMetricsToBenchResults(raw: string, probes: BrowserArtifact[]): string {
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
  const artifacts: BrowserArtifactMetricsResult["artifacts"] = {}

  const summaryPaths = await browserSummaryArtifactPaths(bundleDirectory)
  for (const [index, summaryPath] of summaryPaths.entries()) {
    artifacts[index === 0 ? "summary" : `summary_${index + 1}`] = { path: summaryPath, kind: "json" }
  }

  await addBrowserArtifactIfPresent(artifacts, bundleDirectory, "lifecycle", "lifecycle.json", "json")
  await addBrowserArtifactIfPresent(artifacts, bundleDirectory, "memory", "memory.json", "json")
  await addBrowserArtifactIfPresent(artifacts, bundleDirectory, "performance", "performance.json", "json")
  await addBrowserArtifactIfPresent(artifacts, bundleDirectory, "checkpoints", "checkpoints.jsonl", "jsonl")

  let metrics: Record<string, number> = {}
  for (const summaryPath of summaryPaths) {
    try {
      const summary = JSON.parse(await readFile(join(bundleDirectory, summaryPath), "utf8")) as Record<string, unknown>
      const browserSummary = isRecord(summary.summary) ? summary.summary : {}
      if (isNumericMetricRecord(browserSummary.metrics)) {
        metrics = { ...metrics, ...browserSummary.metrics }
      }
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error
      }
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

async function browserSummaryArtifactPaths(bundleDirectory: string): Promise<string[]> {
  const paths = new Set<string>()

  try {
    const manifest = JSON.parse(await readFile(join(bundleDirectory, "manifest.json"), "utf8")) as ArtifactManifest
    for (const file of Array.isArray(manifest.files) ? manifest.files : []) {
      if (file.kind === "browser-summary" && typeof file.path === "string" && file.path.length > 0) {
        paths.add(file.path)
      }
    }
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error
    }
  }

  try {
    await access(join(bundleDirectory, "files", "browser", "summary.json"))
    paths.add("files/browser/summary.json")
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error
    }
  }

  return [...paths]
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

function combinedBrowserBenchMetrics(probes: BrowserArtifact[]): Record<string, number> | undefined {
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
    ...finalPhaseBenchMetrics(finalMetrics),
  }
}

function finalPhaseBenchMetrics(metrics: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(metrics).filter(([name]) => name.startsWith("browser_phase_")))
}

function sumMetric(metricSets: Array<Record<string, number>>, name: string): number {
  return metricSets.reduce((total, metrics) => total + (metrics[name] ?? 0), 0)
}

function maxMetric(metricSets: Array<Record<string, number>>, name: string): number {
  return Math.max(...metricSets.map((metrics) => metrics[name] ?? 0))
}

export async function serializeBrowserFinishedRequest(request: Request, timestamp = now()): Promise<BrowserProbeNetworkRecord> {
  const response = await request.response()
  if (!response) {
    return {
      type: "response",
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      timestamp,
      timing: browserRequestTiming(request),
    }
  }

  return serializeBrowserResponse(response, timestamp)
}

export async function serializeBrowserResponse(response: Response, timestamp = now()): Promise<BrowserProbeNetworkRecord> {
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
    timestamp,
  }
}

export function serializeBrowserRequestFailure(request: Request, timestamp = now()): BrowserProbeNetworkRecord {
  return {
    type: "requestfailed",
    url: request.url(),
    method: request.method(),
    resourceType: request.resourceType(),
    timing: browserRequestTiming(request),
    failure: request.failure(),
    timestamp,
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
