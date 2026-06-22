import type { BackendNeutralArtifactRef } from "./runtime-neutral-contracts.js"

export const WORDPRESS_DB_OPERATION_SCHEMA = "wp-codebox/wordpress-db-operation/v1" as const
export const WORDPRESS_DB_RESULT_SCHEMA = "wp-codebox/wordpress-db-result/v1" as const

export type WordPressDbVerb = "schema" | "read" | "query-summary" | "write"
export type WordPressDbResultStatus = "ok" | "unsupported" | "error"

export interface WordPressDbResourceRef {
  table?: string
  identifiers?: Record<string, string | number | boolean | null>
}

export interface WordPressDbOperation {
  schema: typeof WORDPRESS_DB_OPERATION_SCHEMA
  operation: WordPressDbVerb
  resource?: WordPressDbResourceRef
  query?: WordPressDbQuery
  options?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export interface WordPressDbQuery {
  table?: string
  columns?: string[]
  where?: Record<string, string | number | boolean | null>
  limit?: number
  sql?: string
  [key: string]: unknown
}

export interface WordPressDbDiagnostic {
  code: string
  message: string
  severity?: "info" | "warning" | "error"
  metadata?: Record<string, unknown>
}

export interface WordPressDbResult {
  schema: typeof WORDPRESS_DB_RESULT_SCHEMA
  command: "wordpress.db-operation"
  status: WordPressDbResultStatus
  operation: WordPressDbOperation
  item?: unknown
  items?: unknown[]
  diagnostics?: WordPressDbDiagnostic[]
  errors?: WordPressDbDiagnostic[]
  artifactRefs?: BackendNeutralArtifactRef[]
  metadata?: Record<string, unknown>
}

export const WORDPRESS_DB_OPERATION_JSON_SCHEMA = {
  $id: WORDPRESS_DB_OPERATION_SCHEMA,
  type: "object",
  additionalProperties: false,
  required: ["schema", "operation"],
  properties: {
    schema: { const: WORDPRESS_DB_OPERATION_SCHEMA },
    operation: { enum: ["schema", "read", "query-summary", "write"] },
    resource: {
      type: "object",
      additionalProperties: false,
      properties: {
        table: { type: "string", minLength: 1 },
        identifiers: {
          type: "object",
          additionalProperties: { type: ["string", "number", "boolean", "null"] },
        },
      },
    },
    query: {
      type: "object",
      additionalProperties: true,
      properties: {
        table: { type: "string", minLength: 1 },
        columns: { type: "array", items: { type: "string", minLength: 1 } },
        where: { type: "object", additionalProperties: { type: ["string", "number", "boolean", "null"] } },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        sql: { type: "string", minLength: 1 },
      },
    },
    options: { type: "object", additionalProperties: true },
    metadata: { type: "object", additionalProperties: true },
  },
} as const

export const WORDPRESS_DB_RESULT_JSON_SCHEMA = {
  $id: WORDPRESS_DB_RESULT_SCHEMA,
  type: "object",
  additionalProperties: true,
  required: ["schema", "command", "status", "operation"],
  properties: {
    schema: { const: WORDPRESS_DB_RESULT_SCHEMA },
    command: { const: "wordpress.db-operation" },
    status: { enum: ["ok", "unsupported", "error"] },
    operation: WORDPRESS_DB_OPERATION_JSON_SCHEMA,
    item: {},
    items: { type: "array" },
    diagnostics: { type: "array" },
    errors: { type: "array" },
    artifactRefs: { type: "array" },
    metadata: { type: "object", additionalProperties: true },
  },
} as const

export function normalizeWordPressDbOperation(input: unknown): WordPressDbOperation {
  const value = requireObject(input, "wordpress.db-operation") as Partial<WordPressDbOperation>
  const operation = requiredString(value.operation, "wordpress.db-operation.operation")
  if (!isWordPressDbVerb(operation)) {
    throw new Error("wordpress.db-operation.operation must be schema, read, query-summary, or write.")
  }

  return stripUndefined({
    schema: WORDPRESS_DB_OPERATION_SCHEMA,
    operation,
    resource: normalizeOptionalDbResourceRef(value.resource),
    query: normalizeOptionalDbQuery(value.query),
    options: normalizeOptionalObject(value.options, "wordpress.db-operation.options"),
    metadata: normalizeOptionalObject(value.metadata, "wordpress.db-operation.metadata"),
  })
}

export function createUnsupportedWordPressDbResult(operation: WordPressDbOperation, message = "wordpress.db-operation is not implemented by this runtime backend."): WordPressDbResult {
  return {
    schema: WORDPRESS_DB_RESULT_SCHEMA,
    command: "wordpress.db-operation",
    status: "unsupported",
    operation,
    diagnostics: [{ code: "db-operation-unsupported", message, severity: "warning" }],
    artifactRefs: [],
  }
}

function normalizeOptionalDbResourceRef(input: unknown): WordPressDbResourceRef | undefined {
  if (input === undefined) return undefined
  const value = requireObject(input, "wordpress.db-operation.resource") as Partial<WordPressDbResourceRef>
  return stripUndefined({
    table: optionalString(value.table, "wordpress.db-operation.resource.table"),
    identifiers: normalizeDbIdentifiers(value.identifiers),
  })
}

function normalizeDbIdentifiers(input: unknown): WordPressDbResourceRef["identifiers"] | undefined {
  if (input === undefined) return undefined
  const value = requireObject(input, "wordpress.db-operation.resource.identifiers")
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (typeof entry !== "string" && typeof entry !== "number" && typeof entry !== "boolean" && entry !== null) {
      throw new Error(`wordpress.db-operation.resource.identifiers.${key} must be a scalar value.`)
    }
    return [key, entry]
  }))
}

function normalizeOptionalDbQuery(input: unknown): WordPressDbQuery | undefined {
  if (input === undefined) return undefined
  const value = requireObject(input, "wordpress.db-operation.query") as Partial<WordPressDbQuery>
  const where = value.where === undefined ? undefined : normalizeDbScalars(value.where, "wordpress.db-operation.query.where")
  return stripUndefined({
    ...value,
    table: optionalString(value.table, "wordpress.db-operation.query.table"),
    columns: normalizeOptionalStringList(value.columns, "wordpress.db-operation.query.columns"),
    where,
    limit: normalizeOptionalLimit(value.limit),
    sql: optionalString(value.sql, "wordpress.db-operation.query.sql"),
  })
}

function normalizeDbScalars(input: unknown, label: string): Record<string, string | number | boolean | null> {
  const value = requireObject(input, label)
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (typeof entry !== "string" && typeof entry !== "number" && typeof entry !== "boolean" && entry !== null) {
      throw new Error(`${label}.${key} must be a scalar value.`)
    }
    return [key, entry]
  }))
}

function normalizeOptionalStringList(input: unknown, label: string): string[] | undefined {
  if (input === undefined) return undefined
  if (!Array.isArray(input)) throw new Error(`${label} must be an array.`)
  const normalized = input.map((entry, index) => requiredString(entry, `${label}.${index}`))
  return normalized.length ? normalized : undefined
}

function normalizeOptionalLimit(input: unknown): number | undefined {
  if (input === undefined) return undefined
  if (typeof input !== "number" || !Number.isInteger(input)) throw new Error("wordpress.db-operation.query.limit must be an integer.")
  return Math.max(1, Math.min(100, input))
}

function isWordPressDbVerb(value: string): value is WordPressDbVerb {
  return value === "schema" || value === "read" || value === "query-summary" || value === "write"
}

function normalizeOptionalObject(value: unknown, label: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  return requireObject(value, label)
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`)
  return value as Record<string, unknown>
}

function requiredString(value: unknown, label: string): string {
  const normalized = optionalString(value, label)
  if (!normalized) throw new Error(`${label} must be a non-empty string.`)
  return normalized
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string") throw new Error(`${label} must be a string.`)
  const normalized = value.trim()
  return normalized === "" ? undefined : normalized
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T
}
