import { stripUndefined } from "./object-utils.js"

export const CACHE_CHURN_OBSERVATION_SCHEMA = "wp-codebox/cache-churn-observation/v1" as const
export const CACHE_CHURN_OBSERVATION_ARTIFACT_KIND = "cache-churn-observation" as const

export interface CacheChurnObservationUnsupportedSection {
  status: "unsupported"
  reason: string
}

export interface CacheChurnOperationCounts {
  get?: number
  set?: number
  delete?: number
}

export interface CacheChurnNameSample {
  name: string
  operations: CacheChurnOperationCounts
}

export interface CacheChurnTransientReport {
  status: "captured" | "partial" | "unsupported" | (string & {})
  reason?: string
  operations: CacheChurnOperationCounts
  names: CacheChurnNameSample[]
  truncated?: boolean
}

export interface CacheChurnOptionsReport {
  status: "captured" | "partial" | "unsupported" | (string & {})
  reason?: string
  operations: CacheChurnOperationCounts & { add?: number; update?: number }
  names: CacheChurnNameSample[]
  autoload?: {
    beforeCount?: number
    afterCount?: number
    added?: string[]
    removed?: string[]
    changed?: string[]
    truncated?: boolean
  }
  truncated?: boolean
}

export interface CacheChurnObservation {
  schema: typeof CACHE_CHURN_OBSERVATION_SCHEMA
  artifactKind: typeof CACHE_CHURN_OBSERVATION_ARTIFACT_KIND
  command?: string
  target?: string
  source?: "in-process" | (string & {})
  kind?: "rest-request" | (string & {})
  generatedAt?: string
  correlation?: {
    caseId?: string
    actionId?: string
    correlationId?: string
  }
  transients: CacheChurnTransientReport
  siteTransients: CacheChurnTransientReport
  options: CacheChurnOptionsReport
  objectCache: CacheChurnObservationUnsupportedSection | Record<string, unknown>
  metadata?: Record<string, unknown>
}

export function cacheChurnObservation(input: Omit<CacheChurnObservation, "schema" | "artifactKind">): CacheChurnObservation {
  return stripUndefined({
    schema: CACHE_CHURN_OBSERVATION_SCHEMA,
    artifactKind: CACHE_CHURN_OBSERVATION_ARTIFACT_KIND,
    command: input.command,
    target: input.target,
    source: input.source,
    kind: input.kind,
    generatedAt: input.generatedAt,
    correlation: input.correlation,
    transients: input.transients,
    siteTransients: input.siteTransients,
    options: input.options,
    objectCache: input.objectCache,
    metadata: input.metadata,
  })
}
