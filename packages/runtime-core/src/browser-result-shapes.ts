import { isPlainObject as isRecord, stringValue } from "./object-utils.js"

export const BROWSER_RESULT_SCHEMA_VERSION = 1 as const

const VALID_TRACE_ENVELOPE_STATUSES = new Set(["pass", "fail", "error", "skip", "unknown"])

export interface BrowserResultShapeOptions {
  normalizeUrl?: (url: string, options: BrowserResultShapeOptions) => string
  normalizePhaseName?: (name: unknown) => string
}

export interface BrowserTraceEvent {
  data: Record<string, unknown> | { value: unknown }
  event: string
  source: string
  t_ms: number
}

export interface BrowserTraceEnvelope {
  artifacts: BrowserArtifactRef[]
  assertions: unknown[]
  component_id: string
  failure?: unknown
  scenario_id: string
  status: string
  summary: string
  timeline: unknown[]
}

export interface BrowserArtifactRef {
  kind?: string
  label?: string
  path: string
}

export interface BrowserNetworkRequest {
  duration_ms: number | null
  failed: boolean
  failure_text?: string
  method: string
  resource_type: string
  start_time_ms: number | null
  status: number | null
  url: string
}

export interface BrowserTimingRow {
  durationMs?: number
  failed?: boolean
  initiatorType?: string
  method?: string
  normalizedUrl: string
  phase?: string
  raw: Record<string, unknown>
  startTime?: number
  status?: number
  ttfbMs?: number
  url: string
}

export interface BrowserPhaseMark {
  name: string
  start_time_ms: number
}

export interface BrowserPhaseWindow {
  duration_ms: number
  end_time_ms: number | null
  start_time_ms: number
}

interface PhaseRange {
  name: string
  startMs: number
  endMs?: number
}

export function normalizeBrowserTraceEvent(sourceOrEvent: unknown, event?: unknown, data: unknown = {}, timestampMs?: unknown): BrowserTraceEvent {
  if (isRecord(sourceOrEvent) && event === undefined) {
    return stableJson({
      t_ms: finiteNumber(sourceOrEvent.t_ms ?? sourceOrEvent.timestampMs ?? sourceOrEvent.timestamp_ms),
      source: stringValue(sourceOrEvent.source) || "scenario",
      event: stringValue(sourceOrEvent.event),
      data: normalizeTraceData(sourceOrEvent.data),
    })
  }

  return stableJson({
    t_ms: finiteNumber(timestampMs),
    source: stringValue(sourceOrEvent) || "scenario",
    event: stringValue(event),
    data: normalizeTraceData(data),
  })
}

export function normalizeBrowserTraceEnvelope(envelope: unknown): BrowserTraceEnvelope {
  const source = isRecord(envelope) ? envelope : {}
  const status = stringValue(source.status)
  const normalized = {
    component_id: stringValue(source.component_id ?? source.componentId) || "unknown",
    scenario_id: stringValue(source.scenario_id ?? source.scenarioId) || "unknown",
    status: VALID_TRACE_ENVELOPE_STATUSES.has(status) ? status : "unknown",
    summary: stringValue(source.summary),
    timeline: Array.isArray(source.timeline) ? source.timeline.map((entry) => stableJson(entry)) : [],
    assertions: Array.isArray(source.assertions) ? source.assertions.map((assertion) => stableJson(assertion)) : [],
    artifacts: Array.isArray(source.artifacts) ? source.artifacts.map(normalizeBrowserArtifact).filter((artifact) => artifact.path.length > 0) : [],
    failure: source.failure,
  }

  return stripUndefined(stableJson(normalized))
}

export function normalizeBrowserPerformanceProfile(profile: unknown, options: BrowserResultShapeOptions = {}): Record<string, unknown> {
  const source = isRecord(profile) ? profile : {}
  const phaseMarks = Array.isArray(source.phase_marks)
    ? source.phase_marks.map((mark) => normalizeBrowserPhaseMark(mark, options)).filter((mark) => mark.name.length > 0).sort(comparePhaseMarks)
    : []

  return stableJson({
    schema_version: finiteNumber(source.schema_version) || BROWSER_RESULT_SCHEMA_VERSION,
    page_url: stringValue(source.page_url ?? source.url),
    summary: isRecord(source.summary) ? stableJson(source.summary) : {},
    navigation: normalizeRecordArray(source.navigation),
    resources: normalizeRecordArray(source.resources),
    network: normalizeRecordArray(source.network),
    console_messages: normalizeRecordArray(source.console_messages ?? source.consoleMessages),
    page_errors: normalizeRecordArray(source.page_errors ?? source.pageErrors),
    paints: normalizeRecordArray(source.paints),
    largest_contentful_paint: normalizeRecordArray(source.largest_contentful_paint ?? source.largestContentfulPaint),
    layout_shifts: normalizeRecordArray(source.layout_shifts ?? source.layoutShifts),
    long_tasks: normalizeRecordArray(source.long_tasks ?? source.longTasks),
    phase_marks: phaseMarks,
    phases: normalizePhaseMap(source.phases, phaseMarks, options),
  })
}

export function normalizeBrowserTimingRows(profile: unknown, options: BrowserResultShapeOptions = {}): BrowserTimingRow[] {
  if (!isRecord(profile)) {
    return []
  }

  const normalizeUrl = options.normalizeUrl ?? defaultNormalizeUrl
  const phases = normalizeProfilePhases(profile, options)
  const resources = Array.isArray(profile.resources) ? profile.resources.filter(isRecord) : []
  const network = Array.isArray(profile.network) ? profile.network.filter(isRecord) : []
  const resourcesByUrl = new Map<string, Record<string, unknown>[]>()

  for (const resource of resources) {
    const rawUrl = pickFirstString(resource, ["name", "url"])
    const normalizedUrl = rawUrl ? normalizeUrl(rawUrl, options) : ""
    if (!normalizedUrl) {
      continue
    }
    if (!resourcesByUrl.has(normalizedUrl)) {
      resourcesByUrl.set(normalizedUrl, [])
    }
    resourcesByUrl.get(normalizedUrl)?.push(resource)
  }

  const rows: BrowserTimingRow[] = []
  for (const entry of network) {
    const rawUrl = pickFirstString(entry, ["url", "name"])
    const normalizedUrl = rawUrl ? normalizeUrl(rawUrl, options) : ""
    const resource = normalizedUrl ? resourcesByUrl.get(normalizedUrl)?.shift() : undefined
    rows.push(normalizeBrowserTiming({ ...resource, ...entry }, phases, options))
  }

  for (const entries of resourcesByUrl.values()) {
    for (const resource of entries) {
      rows.push(normalizeBrowserTiming(resource, phases, options))
    }
  }

  return rows.filter((row) => row.url.length > 0)
}

export function normalizeBrowserNetworkRequest(entry: unknown): BrowserNetworkRequest {
  const source = isRecord(entry) ? entry : {}
  const failed = pickFirstBoolean(source, ["failed", "error"])
  const failureText = stringValue(source.failure_text ?? source.failureText)
  return stripUndefined(stableJson({
    url: stringValue(source.url ?? source.name),
    method: stringValue(source.method ?? source.request_method ?? source.requestMethod).toUpperCase(),
    resource_type: stringValue(source.resource_type ?? source.resourceType ?? source.initiator_type ?? source.initiatorType),
    status: finiteOrNull(source.status ?? source.statusCode ?? source.status_code ?? source.http_status),
    failed: failed ?? false,
    start_time_ms: finiteOrNull(source.start_time_ms ?? source.startTime ?? source.start_ms ?? source.startMs),
    duration_ms: finiteOrNull(source.duration_ms ?? source.durationMs ?? source.duration),
    failure_text: failureText || undefined,
  }))
}

function normalizeBrowserArtifact(artifact: unknown): BrowserArtifactRef {
  const source = isRecord(artifact) ? artifact : {}
  return stripUndefined(stableJson({
    path: stringValue(source.path ?? source.relativePath),
    kind: stringValue(source.kind) || undefined,
    label: stringValue(source.label) || undefined,
  }))
}

function normalizeBrowserTiming(entry: Record<string, unknown>, phases: PhaseRange[], options: BrowserResultShapeOptions): BrowserTimingRow {
  const normalizeUrl = options.normalizeUrl ?? defaultNormalizeUrl
  const rawUrl = pickFirstString(entry, ["name", "url", "request_url", "requestUrl"]) ?? ""
  const startTime = pickFirstNumber(entry, ["startTime", "fetchStart", "requestStart", "start_time_ms", "start_ms", "startMs"])
  const responseStart = pickFirstNumber(entry, ["responseStart", "ttfb_ms", "ttfbMs", "response_start"])
  const responseEnd = pickFirstNumber(entry, ["responseEnd", "response_end", "endMs", "end_ms", "response_end_ms"])
  const duration = pickFirstNumber(entry, ["duration", "duration_ms", "durationMs"])
  const computedDuration = duration ?? (startTime !== undefined && responseEnd !== undefined ? Math.max(0, responseEnd - startTime) : undefined)
  const computedTtfb = responseStart !== undefined && startTime !== undefined
    ? Math.max(0, responseStart - startTime)
    : pickFirstNumber(entry, ["ttfb", "ttfb_ms", "ttfbMs"])
  const phase = pickFirstString(entry, ["phase", "phase_label", "phaseLabel"]) ?? phaseForStartTime(phases, startTime)
  const method = pickFirstString(entry, ["method", "request_method", "requestMethod"])
  const status = pickFirstNumber(entry, ["status", "statusCode", "status_code", "http_status"])

  return stripUndefined({
    url: rawUrl,
    normalizedUrl: rawUrl ? normalizeUrl(rawUrl, options) : "",
    method: method ? method.toUpperCase() : undefined,
    status,
    failed: pickFirstBoolean(entry, ["failed", "error"]),
    startTime,
    ttfbMs: computedTtfb,
    durationMs: computedDuration,
    initiatorType: pickFirstString(entry, ["initiatorType", "initiator_type", "initiator", "resourceType"]),
    phase,
    raw: entry,
  })
}

function normalizeBrowserPhaseMark(mark: unknown, options: BrowserResultShapeOptions): BrowserPhaseMark {
  const source = isRecord(mark) ? mark : {}
  return stableJson({
    name: normalizePhaseName(source.name ?? source.phase ?? source.label, options),
    start_time_ms: finiteNumber(source.start_time_ms ?? source.startTime ?? source.start_ms ?? source.startMs),
  })
}

function normalizePhaseMap(phases: unknown, phaseMarks: BrowserPhaseMark[], options: BrowserResultShapeOptions): Record<string, BrowserPhaseWindow> {
  if (!isRecord(phases)) {
    return collectBrowserPhases(phaseMarks)
  }

  const normalized: Record<string, BrowserPhaseWindow> = {}
  for (const [name, phase] of Object.entries(phases).sort(([a], [b]) => a.localeCompare(b))) {
    if (!isRecord(phase)) {
      continue
    }
    normalized[normalizePhaseName(name, options)] = {
      start_time_ms: finiteNumber(phase.start_time_ms ?? phase.startTime ?? phase.start_ms ?? phase.startMs),
      end_time_ms: finiteOrNull(phase.end_time_ms ?? phase.endTime ?? phase.end_ms ?? phase.endMs),
      duration_ms: finiteNumber(phase.duration_ms ?? phase.durationMs ?? phase.duration),
    }
  }

  return stableJson(normalized)
}

function collectBrowserPhases(phaseMarks: BrowserPhaseMark[]): Record<string, BrowserPhaseWindow> {
  const phases: Record<string, BrowserPhaseWindow> = {}
  const marks = [...phaseMarks].sort(comparePhaseMarks)
  for (const [index, current] of marks.entries()) {
    const next = marks[index + 1]
    phases[current.name] = {
      start_time_ms: current.start_time_ms,
      end_time_ms: next ? next.start_time_ms : null,
      duration_ms: next ? Math.max(0, roundNumber(next.start_time_ms - current.start_time_ms)) : 0,
    }
  }
  return stableJson(phases)
}

function normalizeProfilePhases(profile: Record<string, unknown>, options: BrowserResultShapeOptions): PhaseRange[] {
  const phases: PhaseRange[] = []
  if (isRecord(profile.phases)) {
    for (const [name, phase] of Object.entries(profile.phases)) {
      if (!isRecord(phase)) {
        continue
      }
      const startMs = pickFirstNumber(phase, ["start_time_ms", "startTime", "start_ms", "startMs"])
      const endMs = pickFirstNumber(phase, ["end_time_ms", "endTime", "end_ms", "endMs"])
      if (startMs !== undefined) {
        phases.push({ name: normalizePhaseName(name, options), startMs, endMs })
      }
    }
  } else if (Array.isArray(profile.phase_marks)) {
    const marks = profile.phase_marks
      .map((mark) => normalizeBrowserPhaseMark(mark, options))
      .filter((mark) => mark.name.length > 0)
      .sort(comparePhaseMarks)
    for (const [index, mark] of marks.entries()) {
      phases.push({ name: mark.name, startMs: mark.start_time_ms, endMs: marks[index + 1]?.start_time_ms })
    }
  }

  return phases.sort((a, b) => a.startMs - b.startMs)
}

function phaseForStartTime(phases: PhaseRange[], startTime: number | undefined): string | undefined {
  if (startTime === undefined) {
    return undefined
  }

  let matched: string | undefined
  for (const phase of phases) {
    const endMs = phase.endMs ?? Infinity
    if (startTime >= phase.startMs && startTime < endMs) {
      matched = phase.name
    }
  }
  return matched
}

function normalizeRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord).map((entry) => stableJson(entry)) : []
}

function normalizeTraceData(data: unknown): Record<string, unknown> | { value: unknown } {
  return isRecord(data) ? stableJson(data) : { value: data }
}

function defaultNormalizeUrl(url: string): string {
  if (url.trim().length === 0) {
    return ""
  }
  try {
    const parsed = new URL(url.trim(), "http://__wp_codebox_stub__")
    return `${parsed.pathname}${parsed.search}`
  } catch {
    return url.trim()
  }
}

function pickFirstNumber(source: Record<string, unknown> | undefined, keys: string[]): number | undefined {
  if (!source) {
    return undefined
  }
  for (const key of keys) {
    const value = source[key]
    if (typeof value === "number" && Number.isFinite(value)) {
      return roundNumber(value)
    }
  }
  return undefined
}

function pickFirstString(source: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!source) {
    return undefined
  }
  for (const key of keys) {
    const value = source[key]
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim()
    }
  }
  return undefined
}

function pickFirstBoolean(source: Record<string, unknown> | undefined, keys: string[]): boolean | undefined {
  if (!source) {
    return undefined
  }
  for (const key of keys) {
    const value = source[key]
    if (typeof value === "boolean") {
      return value
    }
  }
  return undefined
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? roundNumber(value) : 0
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? roundNumber(value) : null
}

function roundNumber(value: number): number {
  return Math.round(value * 1000) / 1000
}

function normalizePhaseName(name: unknown, options: BrowserResultShapeOptions): string {
  if (options.normalizePhaseName) {
    return options.normalizePhaseName(name)
  }
  return String(name || "").trim().toLowerCase().replace(/[^a-z0-9_.:-]+/g, "_").replace(/^_+|_+$/g, "") || "phase"
}

function comparePhaseMarks(a: BrowserPhaseMark, b: BrowserPhaseMark): number {
  return a.start_time_ms - b.start_time_ms || a.name.localeCompare(b.name)
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T
}

function stableJson<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(stableJson) as T
  }
  if (!isRecord(value)) {
    return value
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, stableJson(item)]),
  ) as T
}
