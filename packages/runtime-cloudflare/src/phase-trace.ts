export const CLOUDFLARE_PHASE_TRACE_SCHEMA = "wp-codebox/cloudflare-runtime-phase-trace/v1"

export type TraceOperation = "read" | "mutation" | "diagnostic"
export type RuntimeDisposition = "cold" | "warm" | "shared-initialization" | "invalidated" | "not-used"
export type PageCacheDisposition = "hit" | "miss" | "bypass" | "not-applicable"

export interface PhaseTraceEntry {
  name: string
  durationMs: number
  aggregateGap?: boolean
  evidence?: Record<string, number | boolean>
}

export interface PhaseTraceSummary {
  schema: typeof CLOUDFLARE_PHASE_TRACE_SCHEMA
  operation: TraceOperation
  runtime: RuntimeDisposition
  pageCache: PageCacheDisposition
  completed: boolean
  totalMs: number
  phases: PhaseTraceEntry[]
}

const MAX_DURATION_MS = 600_000
const MAX_EVIDENCE_VALUE = Number.MAX_SAFE_INTEGER
const MAX_PHASES = 64
const MAX_EVIDENCE_ENTRIES = 16
const SENSITIVE_EVIDENCE_KEY = /(?:authorization|cookie|credential|digest|host|key|password|path|revision|secret|token|url|(?:^id$|Id$|_id$|\.id$|-id$))/i
const PHASE_NAME = /^[a-z][a-z0-9_.-]{0,63}$/i

function defaultNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now()
}

function boundedMs(value: number): number {
  return Math.min(MAX_DURATION_MS, Math.max(0, Math.round(value * 1000) / 1000))
}

function boundedEvidence(evidence: Record<string, unknown> | undefined): Record<string, number | boolean> | undefined {
  if (!evidence) return undefined
  const safe: Array<[string, number | boolean]> = []
  for (const [key, value] of Object.entries(evidence)) {
    if (safe.length === MAX_EVIDENCE_ENTRIES) break
    if (!PHASE_NAME.test(key) || SENSITIVE_EVIDENCE_KEY.test(key)) continue
    if (typeof value === "boolean") safe.push([key, value])
    if (typeof value === "number" && Number.isFinite(value)) safe.push([key, Math.min(MAX_EVIDENCE_VALUE, Math.max(0, Math.round(value)))])
  }
  return safe.length ? Object.fromEntries(safe) : undefined
}

export class CloudflarePhaseTrace {
  private readonly startedAt: number
  private readonly phases: PhaseTraceEntry[] = []
  private active: { name: string; startedAt: number; evidence?: Record<string, unknown> } | undefined
  private summary: PhaseTraceSummary | undefined
  private reservedPhases = 0
  private compositeActive = false

  constructor(private readonly clock: () => number = defaultNow) {
    this.startedAt = clock()
  }

  start(name: string, evidence?: Record<string, unknown>): void {
    if (this.summary) throw new Error("Cloudflare phase trace is already complete.")
    if (this.active || !PHASE_NAME.test(name) || this.phases.length + this.reservedPhases >= MAX_PHASES) throw new Error("Cloudflare phase must be a bounded, non-overlapping leaf.")
    this.active = { name, startedAt: this.clock(), evidence }
  }

  end(evidence?: Record<string, unknown>): void {
    if (!this.active) throw new Error("Cloudflare phase completion has no active leaf.")
    const active = this.active
    this.active = undefined
    this.phases.push({ name: active.name, durationMs: boundedMs(this.clock() - active.startedAt), evidence: boundedEvidence({ ...active.evidence, ...evidence }) })
  }

  async measure<T>(name: string, work: () => Promise<T>, evidence?: Record<string, unknown>): Promise<T> {
    this.start(name, evidence)
    try {
      const result = await work()
      this.end()
      return result
    } catch (error) {
      this.end({ failed: true })
      throw error
    }
  }

  async measureComposite<T>(name: string, work: () => Promise<T>, evidence?: Record<string, unknown>): Promise<T> {
    if (this.summary || this.active || this.compositeActive || !PHASE_NAME.test(name) || this.phases.length + this.reservedPhases >= MAX_PHASES) throw new Error("Cloudflare composite phase is invalid.")
    this.compositeActive = true
    this.reservedPhases++
    const startedAt = this.clock()
    const measuredBefore = this.phases.reduce((total, phase) => total + phase.durationMs, 0)
    let failed = false
    try {
      return await work()
    } catch (error) {
      failed = true
      throw error
    } finally {
      const measuredAfter = this.phases.reduce((total, phase) => total + phase.durationMs, 0)
      const gap = boundedMs(this.clock() - startedAt - (measuredAfter - measuredBefore))
      this.reservedPhases--
      this.compositeActive = false
      this.phases.push({ name, durationMs: gap, aggregateGap: true, evidence: boundedEvidence({ ...evidence, failed }) })
    }
  }

  complete(operation: TraceOperation, runtime: RuntimeDisposition, pageCache: PageCacheDisposition, completed = true, evidence?: Record<string, unknown>): PhaseTraceSummary {
    if (this.summary) return this.summary
    if (this.active) this.end({ failed: !completed, ...evidence })
    this.summary = { schema: CLOUDFLARE_PHASE_TRACE_SCHEMA, operation, runtime, pageCache, completed, totalMs: boundedMs(this.clock() - this.startedAt), phases: this.phases.map((phase) => ({ ...phase, evidence: phase.evidence && { ...phase.evidence } })) }
    return this.summary
  }
}

export function logPhaseTrace(summary: PhaseTraceSummary): void {
  console.log(JSON.stringify(summary))
}

export function serverTiming(summary: PhaseTraceSummary): string {
  return summary.phases.slice(0, 8).map((phase) => `${phase.name.replace(/[^a-z0-9_-]/gi, "-")};dur=${boundedMs(phase.durationMs)}`).join(", ")
}

export function attachServerTiming(response: Response, summary: PhaseTraceSummary): Response {
  const headers = new Headers(response.headers)
  const value = serverTiming(summary)
  if (value) headers.set("server-timing", value)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}
