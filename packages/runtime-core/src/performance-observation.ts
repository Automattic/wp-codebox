import { stripUndefined } from "./object-utils.js"

export const PERFORMANCE_OBSERVATION_SCHEMA = "wp-codebox/performance-observation/v1" as const

export type PerformanceObservationCaptureStatus = "captured" | "unavailable" | "partial" | "uncaptured"

export interface PerformanceObservationCaptureRequest {
  queries?: boolean
}

export interface PerformanceObservationCaptureReport {
  requested: PerformanceObservationCaptureRequest
  queries: {
    requested: boolean
    status: PerformanceObservationCaptureStatus
    reason?: string
  }
}

export interface PerformanceObservationTiming {
  status?: "captured" | "uncaptured" | "unsupported" | (string & {})
  reason?: string
  startedAt?: string
  finishedAt?: string
  durationMs?: number
}

export interface PerformanceObservationMemory {
  status?: "captured" | "uncaptured" | "unsupported" | (string & {})
  reason?: string
  startBytes?: number
  endBytes?: number
  deltaBytes?: number
  peakBytes?: number
}

export interface PerformanceObservationQueryFingerprint {
  fingerprint: string
  count: number
  totalTimeMs?: number
  sampleMs?: number
  caller?: string
}

export interface PerformanceObservationRepeatedQuerySummary {
  fingerprint: string
  count: number
  totalTimeMs?: number
  caller?: string
}

export interface PerformanceObservationDatabase {
  status?: "captured" | "uncaptured" | "unavailable" | "partial" | "unsupported" | (string & {})
  reason?: string
  queryCount?: number
  totalTimeMs?: number | null
  timingStatus?: "captured" | "unavailable" | "unsupported" | (string & {})
  timingReason?: string
  fingerprints?: PerformanceObservationQueryFingerprint[]
  repeatedQueries?: PerformanceObservationRepeatedQuerySummary[]
}

export interface PerformanceObservationHookTiming {
  hook: string
  count?: number
  totalTimeMs?: number
  maxTimeMs?: number
}

export interface PerformanceObservationHooks {
  status?: "captured" | "uncaptured" | "unsupported" | (string & {})
  reason?: string
  timings: PerformanceObservationHookTiming[]
}

export interface PerformanceObservationNetwork {
  status?: "captured" | "uncaptured" | "unsupported" | (string & {})
  reason?: string
  requests?: number
  responses?: number
  failures?: number
  transferSizeBytes?: number
}

export interface PerformanceObservationBrowser {
  status?: "captured" | "uncaptured" | "unsupported" | (string & {})
  reason?: string
  metrics?: Record<string, number>
  admin?: Record<string, unknown>
}

export interface PerformanceObservationArtifactRef {
  kind?: string
  id?: string
  path?: string
  digest?: unknown
}

export interface PerformanceObservation {
  schema: typeof PERFORMANCE_OBSERVATION_SCHEMA
  command?: string
  target?: string
  source?: "in-process" | "server-http" | "browser" | (string & {})
  kind?: "simulated-page-load" | "server-page-load" | "browser-page-load" | "rest-request" | (string & {})
  timing?: PerformanceObservationTiming
  memory?: PerformanceObservationMemory
  database?: PerformanceObservationDatabase
  hooks?: PerformanceObservationHooks
  network?: PerformanceObservationNetwork
  browser?: PerformanceObservationBrowser
  artifactRefs?: PerformanceObservationArtifactRef[]
  capture?: PerformanceObservationCaptureReport
  metadata?: Record<string, unknown>
}

export function performanceObservation(input: Omit<PerformanceObservation, "schema"> = {}): PerformanceObservation {
  return stripUndefined({
    schema: PERFORMANCE_OBSERVATION_SCHEMA,
    command: input.command,
    target: input.target,
    source: input.source,
    kind: input.kind,
    timing: input.timing,
    memory: input.memory,
    database: input.database,
    hooks: input.hooks,
    network: input.network,
    browser: input.browser,
    artifactRefs: input.artifactRefs,
    capture: input.capture,
    metadata: input.metadata,
  })
}

export function performanceObservationCaptureRequest(input: unknown): PerformanceObservationCaptureRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {}
  }
  const record = input as Record<string, unknown>
  return stripUndefined({
    queries: typeof record.queries === "boolean" ? record.queries : undefined,
  })
}
