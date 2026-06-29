import type { FuzzSuiteArtifactRef } from "./fuzz-suite-contracts.js"
import { stripUndefined } from "./object-utils.js"

export const WORDPRESS_DB_WRITE_SET_SCHEMA = "wp-codebox/wordpress-db-write-set/v1" as const
export const WORDPRESS_DB_WRITE_SET_ARTIFACT_KIND = "wordpress-db-write-set" as const

export type WordPressDbWriteOperation = "insert" | "update" | "delete" | "replace"

export interface WordPressDbWriteSetEntry {
  table: string
  operation: WordPressDbWriteOperation
  rowsAffected?: number | null
  rowCountBefore?: number | null
  rowCountAfter?: number | null
  resource?: Record<string, unknown>
  object?: { kind?: string; type?: string; id?: string | number }
  key?: string
  repeatedWritesToSameKey?: number
  source?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export interface WordPressDbWriteSetArtifact {
  schema: typeof WORDPRESS_DB_WRITE_SET_SCHEMA
  artifactKind: typeof WORDPRESS_DB_WRITE_SET_ARTIFACT_KIND
  generatedAt: string
  suiteId?: string
  caseId?: string
  action?: string
  target?: string
  entries: WordPressDbWriteSetEntry[]
  repeatedWrites: WordPressDbWriteSetEntry[]
  totals: {
    writes: number
    rowsAffected: number | null
    tables: number
    repeatedWriteKeys: number
  }
  artifactRefs?: FuzzSuiteArtifactRef[]
  metadata?: Record<string, unknown>
}

export const WORDPRESS_DB_WRITE_SET_JSON_SCHEMA = {
  $id: WORDPRESS_DB_WRITE_SET_SCHEMA,
  type: "object",
  additionalProperties: true,
  required: ["schema", "artifactKind", "generatedAt", "entries", "repeatedWrites", "totals"],
  properties: {
    schema: { const: WORDPRESS_DB_WRITE_SET_SCHEMA },
    artifactKind: { const: WORDPRESS_DB_WRITE_SET_ARTIFACT_KIND },
    generatedAt: { type: "string" },
    suiteId: { type: "string" },
    caseId: { type: "string" },
    action: { type: "string" },
    target: { type: "string" },
    entries: { type: "array" },
    repeatedWrites: { type: "array" },
    totals: { type: "object" },
    artifactRefs: { type: "array" },
    metadata: { type: "object", additionalProperties: true },
  },
} as const

export function wordpressDbWriteSetArtifact(input: Omit<WordPressDbWriteSetArtifact, "schema" | "artifactKind" | "generatedAt" | "repeatedWrites" | "totals"> & { generatedAt?: string; repeatedWrites?: WordPressDbWriteSetEntry[]; totals?: Partial<WordPressDbWriteSetArtifact["totals"]> }): WordPressDbWriteSetArtifact {
  const entries = input.entries.map(normalizeWriteSetEntry)
  const repeatedWrites = input.repeatedWrites?.map(normalizeWriteSetEntry) ?? entries.filter((entry) => (entry.repeatedWritesToSameKey ?? 0) > 1)
  const rowCounts = entries.map((entry) => entry.rowsAffected).filter((value): value is number => typeof value === "number")
  return stripUndefined({
    schema: WORDPRESS_DB_WRITE_SET_SCHEMA,
    artifactKind: WORDPRESS_DB_WRITE_SET_ARTIFACT_KIND,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    suiteId: input.suiteId,
    caseId: input.caseId,
    action: input.action,
    target: input.target,
    entries,
    repeatedWrites,
    totals: {
      writes: input.totals?.writes ?? entries.length,
      rowsAffected: input.totals?.rowsAffected ?? (rowCounts.length === entries.length ? rowCounts.reduce((sum, value) => sum + value, 0) : null),
      tables: input.totals?.tables ?? new Set(entries.map((entry) => entry.table)).size,
      repeatedWriteKeys: input.totals?.repeatedWriteKeys ?? repeatedWrites.length,
    },
    artifactRefs: input.artifactRefs,
    metadata: input.metadata,
  })
}

function normalizeWriteSetEntry(input: WordPressDbWriteSetEntry): WordPressDbWriteSetEntry {
  return stripUndefined({
    table: input.table,
    operation: input.operation,
    rowsAffected: input.rowsAffected,
    rowCountBefore: input.rowCountBefore,
    rowCountAfter: input.rowCountAfter,
    resource: input.resource,
    object: input.object,
    key: input.key,
    repeatedWritesToSameKey: input.repeatedWritesToSameKey,
    source: input.source,
    metadata: input.metadata,
  })
}
