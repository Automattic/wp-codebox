import { stripUndefined } from "./object-utils.js"

export const PERFORMANCE_OBSERVATION_SCHEMA = "wp-codebox/performance-observation/v1" as const

export interface PerformanceObservationTiming {
  startedAt?: string
  finishedAt?: string
  durationMs?: number
}

export interface PerformanceObservationMemory {
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
  queryCount?: number
  totalTimeMs?: number
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
  timings: PerformanceObservationHookTiming[]
}

export interface PerformanceObservationNetwork {
  requests?: number
  responses?: number
  failures?: number
  transferSizeBytes?: number
}

export interface PerformanceObservationBrowser {
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
  timing?: PerformanceObservationTiming
  memory?: PerformanceObservationMemory
  database?: PerformanceObservationDatabase
  hooks?: PerformanceObservationHooks
  network?: PerformanceObservationNetwork
  browser?: PerformanceObservationBrowser
  artifactRefs?: PerformanceObservationArtifactRef[]
  metadata?: Record<string, unknown>
}

export function performanceObservation(input: Omit<PerformanceObservation, "schema"> = {}): PerformanceObservation {
  return stripUndefined({
    schema: PERFORMANCE_OBSERVATION_SCHEMA,
    command: input.command,
    target: input.target,
    timing: input.timing,
    memory: input.memory,
    database: input.database,
    hooks: input.hooks,
    network: input.network,
    browser: input.browser,
    artifactRefs: input.artifactRefs,
    metadata: input.metadata,
  })
}
