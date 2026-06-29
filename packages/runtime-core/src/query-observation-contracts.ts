import { stripUndefined } from "./object-utils.js"

export const QUERY_OBSERVATION_SCHEMA = "wp-codebox/query-observation/v1" as const

export type QueryObservationOperation = "select" | "insert" | "update" | "delete" | "replace" | "create" | "alter" | "drop" | "truncate" | "other" | (string & {})
export type QueryObservationStatus = "captured" | "partial" | "unavailable"

export interface QueryObservationTableRef {
  name: string
  source?: "fingerprint" | "recorder" | "summary" | (string & {})
  operation?: QueryObservationOperation
}

export interface QueryObservationFingerprint {
  fingerprint: string
  hash?: string
  count: number
  operation?: QueryObservationOperation
  tables?: QueryObservationTableRef[]
  sampleMs?: number | null
  totalTimeMs?: number | null
  caller?: string
  rowCount?: number | null
  rowsAffected?: number | null
  metadata?: Record<string, unknown>
}

export interface QueryObservationDuplicateGroup {
  fingerprint: string
  hash?: string
  count: number
  operation?: QueryObservationOperation
  tables?: QueryObservationTableRef[]
  totalTimeMs?: number | null
  caller?: string
}

export interface QueryObservationArtifactRef {
  path: string
  kind?: string
  contentType?: string
  sha256?: string
  bytes?: number
  name?: string
  metadata?: Record<string, unknown>
}

export interface QueryObservationArtifact {
  schema: typeof QUERY_OBSERVATION_SCHEMA
  generatedAt?: string
  source?: string
  suiteId?: string
  caseId?: string
  actionId?: string
  command?: string
  target?: string
  status: QueryObservationStatus
  reason?: string | null
  queryCount: number
  totalTimeMs?: number | null
  operationBreakdown: Record<string, number>
  tables: QueryObservationTableRef[]
  fingerprints: QueryObservationFingerprint[]
  duplicateGroups: QueryObservationDuplicateGroup[]
  artifactRefs?: QueryObservationArtifactRef[]
  metadata?: Record<string, unknown>
}

export function queryObservationArtifact(input: Omit<QueryObservationArtifact, "schema" | "status" | "queryCount" | "operationBreakdown" | "tables" | "fingerprints" | "duplicateGroups"> & Partial<Pick<QueryObservationArtifact, "status" | "queryCount" | "operationBreakdown" | "tables" | "fingerprints" | "duplicateGroups">>): QueryObservationArtifact {
  const fingerprints = dedupeQueryFingerprints(input.fingerprints ?? [])
  const duplicateGroups = input.duplicateGroups ?? fingerprints.filter((item) => item.count > 1).map((item) => stripUndefined({
    fingerprint: item.fingerprint,
    hash: item.hash,
    count: item.count,
    operation: item.operation,
    tables: item.tables,
    totalTimeMs: item.totalTimeMs,
    caller: item.caller,
  }))
  const tables = dedupeQueryTables([...(input.tables ?? []), ...fingerprints.flatMap((item) => item.tables ?? [])])
  return stripUndefined({
    schema: QUERY_OBSERVATION_SCHEMA,
    generatedAt: input.generatedAt,
    source: input.source,
    suiteId: input.suiteId,
    caseId: input.caseId,
    actionId: input.actionId,
    command: input.command,
    target: input.target,
    status: input.status ?? (fingerprints.length > 0 || (input.queryCount ?? 0) > 0 ? "captured" : "unavailable"),
    reason: input.reason,
    queryCount: input.queryCount ?? fingerprints.reduce((sum, item) => sum + item.count, 0),
    totalTimeMs: input.totalTimeMs,
    operationBreakdown: input.operationBreakdown ?? operationBreakdown(fingerprints),
    tables,
    fingerprints,
    duplicateGroups,
    artifactRefs: input.artifactRefs,
    metadata: input.metadata,
  })
}

function operationBreakdown(fingerprints: readonly QueryObservationFingerprint[]): Record<string, number> {
  return fingerprints.reduce<Record<string, number>>((summary, item) => {
    const operation = item.operation ?? "other"
    summary[operation] = (summary[operation] ?? 0) + item.count
    return summary
  }, {})
}

function dedupeQueryFingerprints(fingerprints: readonly QueryObservationFingerprint[]): QueryObservationFingerprint[] {
  const seen = new Set<string>()
  const out: QueryObservationFingerprint[] = []
  for (const fingerprint of fingerprints) {
    const key = fingerprint.hash ?? fingerprint.fingerprint
    if (!fingerprint.fingerprint || seen.has(key)) continue
    seen.add(key)
    out.push(stripUndefined({ ...fingerprint, tables: fingerprint.tables ? dedupeQueryTables(fingerprint.tables) : undefined }))
  }
  return out
}

function dedupeQueryTables(tables: readonly QueryObservationTableRef[]): QueryObservationTableRef[] {
  const seen = new Set<string>()
  const out: QueryObservationTableRef[] = []
  for (const table of tables) {
    if (!table.name || seen.has(`${table.name}:${table.operation ?? ""}`)) continue
    seen.add(`${table.name}:${table.operation ?? ""}`)
    out.push(stripUndefined({ name: table.name, source: table.source, operation: table.operation }))
  }
  return out
}
