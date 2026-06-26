import { type BrowserStartupProgressEvent } from "./runtime-contracts.js"
import { type FanoutLifecycleEvent } from "./fanout-contracts.js"

export const LIVE_PROGRESS_EVENT_SCHEMA = "wp-codebox/live-progress-event/v1" as const

export type LiveProgressStatus = "queued" | "running" | "succeeded" | "failed" | "skipped" | "cancelled" | "timed_out"

export interface LiveProgressCounts {
  current?: number
  total?: number
  active?: number
  completed?: number
  failed?: number
  skipped?: number
  cancelled?: number
  timed_out?: number
  percent?: number
  unit?: string
}

export interface LiveProgressEvent {
  schema: typeof LIVE_PROGRESS_EVENT_SCHEMA
  source_schema?: string
  source_event?: string
  phase: string
  status: LiveProgressStatus
  label?: string
  detail?: Record<string, unknown>
  progress?: LiveProgressCounts
  artifacts?: Record<string, unknown> | unknown[]
  diagnostics?: Record<string, unknown>
  timestamp: string
  run_id?: string
  session_id?: string
  fanout_id?: string
  worker_id?: string
}

export function normalizeLiveProgressEvent(input: (Partial<FanoutLifecycleEvent> | BrowserStartupProgressEvent) & {
  timestamp?: string
  run_id?: string
  session_id?: string
  label?: string
  detail?: Record<string, unknown>
  artifacts?: Record<string, unknown> | unknown[]
  diagnostics?: Record<string, unknown>
}): LiveProgressEvent {
  const event = stringValue((input as Partial<FanoutLifecycleEvent>).event)
  const phase = stringValue(input.phase) || event || "progress"
  const status = liveProgressStatus(input)
  const timestamp = stringValue(input.timestamp) || stringValue((input as Partial<FanoutLifecycleEvent>).time) || new Date().toISOString()
  const counts = liveProgressCounts(input as Partial<FanoutLifecycleEvent>)

  return stripUndefined({
    schema: LIVE_PROGRESS_EVENT_SCHEMA,
    source_schema: stringValue(input.schema),
    source_event: event || undefined,
    phase,
    status,
    label: stringValue(input.label) || liveProgressLabel(phase, status),
    detail: input.detail,
    progress: Object.keys(counts).length > 0 ? counts : undefined,
    artifacts: input.artifacts,
    diagnostics: input.diagnostics,
    timestamp,
    run_id: stringValue(input.run_id) || stringValue((input as Partial<FanoutLifecycleEvent>).fanout_id) || undefined,
    session_id: stringValue(input.session_id) || stringValue((input as Partial<FanoutLifecycleEvent>).fanout_id) || undefined,
    fanout_id: stringValue((input as Partial<FanoutLifecycleEvent>).fanout_id) || undefined,
    worker_id: stringValue((input as Partial<FanoutLifecycleEvent>).worker_id) || undefined,
  }) as LiveProgressEvent
}

function liveProgressStatus(input: Partial<FanoutLifecycleEvent> | BrowserStartupProgressEvent): LiveProgressStatus {
  const status = stringValue(input.status)
  if (["queued", "running", "succeeded", "failed", "skipped", "cancelled", "timed_out"].includes(status)) return status as LiveProgressStatus
  if (status === "complete" || status === "completed") return "succeeded"
  if (status === "timeout") return "timed_out"
  const event = stringValue((input as Partial<FanoutLifecycleEvent>).event)
  if (event.endsWith(".started")) return "running"
  if (event.endsWith(".completed")) return "succeeded"
  if (event.endsWith(".failed")) return "failed"
  if (event.endsWith(".skipped")) return "skipped"
  return "running"
}

function liveProgressCounts(input: Partial<FanoutLifecycleEvent>): LiveProgressCounts {
  const current = numberValue((input as Record<string, unknown>).current) ?? numberValue(input.completed)
  const total = numberValue(input.total)
  return stripUndefined({
    current,
    total,
    active: numberValue(input.active),
    completed: numberValue(input.completed),
    failed: numberValue(input.failed),
    skipped: numberValue(input.skipped),
    cancelled: numberValue(input.cancelled),
    timed_out: numberValue(input.timed_out),
    percent: normalizePercent(numberValue((input as Record<string, unknown>).percent) ?? (current !== undefined && total ? (current / total) * 100 : undefined)),
    unit: stringValue((input as Record<string, unknown>).unit) || undefined,
  })
}

function normalizePercent(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  const percent = value > 0 && value <= 1 ? value * 100 : value
  return Math.max(0, Math.min(100, percent))
}

function liveProgressLabel(phase: string, status: LiveProgressStatus): string {
  if (phase === "fanout.started") return "Fanout started"
  if (phase === "worker.started") return "Worker started"
  if (phase === "worker.completed") return "Worker completed"
  if (phase === "worker.failed") return "Worker failed"
  if (phase === "worker.skipped") return "Worker skipped"
  if (phase === "aggregation.started") return "Aggregating worker results"
  if (phase === "aggregation.completed") return "Aggregation complete"
  if (phase === "fanout.completed") return "Fanout complete"
  if (phase === "fanout.failed") return "Fanout failed"
  return status === "failed" ? "Progress failed" : status === "succeeded" ? "Progress complete" : "Progress update"
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T
}
