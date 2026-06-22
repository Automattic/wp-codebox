import type { BackendNeutralArtifactRef } from "./runtime-neutral-contracts.js"

export const WORDPRESS_CRUD_OPERATION_SCHEMA = "wp-codebox/wordpress-crud-operation/v1" as const
export const WORDPRESS_CRUD_RESULT_SCHEMA = "wp-codebox/wordpress-crud-result/v1" as const

export type WordPressCrudVerb = "create" | "read" | "update" | "delete" | "list"
export type WordPressCrudResultStatus = "ok" | "unsupported" | "error"

export interface WordPressCrudResourceRef {
  kind: string
  type?: string
  id?: string | number
  path?: string
  route?: string
  identifiers?: Record<string, string | number | boolean | null>
}

export interface WordPressCrudOperation {
  schema: typeof WORDPRESS_CRUD_OPERATION_SCHEMA
  operation: WordPressCrudVerb
  resource: WordPressCrudResourceRef
  data?: Record<string, unknown>
  query?: Record<string, unknown>
  options?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export interface WordPressCrudDiagnostic {
  code: string
  message: string
  severity?: "info" | "warning" | "error"
  metadata?: Record<string, unknown>
}

export interface WordPressCrudEffect {
  kind: string
  resource?: WordPressCrudResourceRef
  before?: unknown
  after?: unknown
  metadata?: Record<string, unknown>
}

export interface WordPressCrudResult {
  schema: typeof WORDPRESS_CRUD_RESULT_SCHEMA
  command: "wordpress.crud-operation"
  status: WordPressCrudResultStatus
  operation: WordPressCrudOperation
  item?: unknown
  items?: unknown[]
  effects?: WordPressCrudEffect[]
  diagnostics?: WordPressCrudDiagnostic[]
  errors?: WordPressCrudDiagnostic[]
  artifactRefs?: BackendNeutralArtifactRef[]
  metadata?: Record<string, unknown>
}

export const WORDPRESS_CRUD_OPERATION_JSON_SCHEMA = {
  $id: WORDPRESS_CRUD_OPERATION_SCHEMA,
  type: "object",
  additionalProperties: false,
  required: ["schema", "operation", "resource"],
  properties: {
    schema: { const: WORDPRESS_CRUD_OPERATION_SCHEMA },
    operation: { enum: ["create", "read", "update", "delete", "list"] },
    resource: {
      type: "object",
      additionalProperties: false,
      required: ["kind"],
      properties: {
        kind: { type: "string", minLength: 1 },
        type: { type: "string", minLength: 1 },
        id: { anyOf: [{ type: "string" }, { type: "number" }] },
        path: { type: "string", minLength: 1 },
        route: { type: "string", minLength: 1 },
        identifiers: {
          type: "object",
          additionalProperties: { type: ["string", "number", "boolean", "null"] },
        },
      },
    },
    data: { type: "object", additionalProperties: true },
    query: { type: "object", additionalProperties: true },
    options: { type: "object", additionalProperties: true },
    metadata: { type: "object", additionalProperties: true },
  },
} as const

export const WORDPRESS_CRUD_RESULT_JSON_SCHEMA = {
  $id: WORDPRESS_CRUD_RESULT_SCHEMA,
  type: "object",
  additionalProperties: true,
  required: ["schema", "command", "status", "operation"],
  properties: {
    schema: { const: WORDPRESS_CRUD_RESULT_SCHEMA },
    command: { const: "wordpress.crud-operation" },
    status: { enum: ["ok", "unsupported", "error"] },
    operation: WORDPRESS_CRUD_OPERATION_JSON_SCHEMA,
    item: {},
    items: { type: "array" },
    effects: { type: "array" },
    diagnostics: { type: "array" },
    errors: { type: "array" },
    artifactRefs: { type: "array" },
    metadata: { type: "object", additionalProperties: true },
  },
} as const

export function normalizeWordPressCrudOperation(input: unknown): WordPressCrudOperation {
  const value = requireObject(input, "wordpress.crud-operation") as Partial<WordPressCrudOperation>
  const operation = requiredString(value.operation, "wordpress.crud-operation.operation")
  if (!isWordPressCrudVerb(operation)) {
    throw new Error("wordpress.crud-operation.operation must be create, read, update, delete, or list.")
  }

  return stripUndefined({
    schema: WORDPRESS_CRUD_OPERATION_SCHEMA,
    operation,
    resource: normalizeWordPressCrudResourceRef(value.resource),
    data: normalizeOptionalObject(value.data, "wordpress.crud-operation.data"),
    query: normalizeOptionalObject(value.query, "wordpress.crud-operation.query"),
    options: normalizeOptionalObject(value.options, "wordpress.crud-operation.options"),
    metadata: normalizeOptionalObject(value.metadata, "wordpress.crud-operation.metadata"),
  })
}

export function createUnsupportedWordPressCrudResult(operation: WordPressCrudOperation, message = "wordpress.crud-operation is not implemented by this runtime backend."): WordPressCrudResult {
  return {
    schema: WORDPRESS_CRUD_RESULT_SCHEMA,
    command: "wordpress.crud-operation",
    status: "unsupported",
    operation,
    diagnostics: [{ code: "crud-operation-unsupported", message, severity: "warning" }],
    effects: [],
    artifactRefs: [],
  }
}

function normalizeWordPressCrudResourceRef(input: unknown): WordPressCrudResourceRef {
  const value = requireObject(input, "wordpress.crud-operation.resource") as Partial<WordPressCrudResourceRef>
  return stripUndefined({
    kind: requiredString(value.kind, "wordpress.crud-operation.resource.kind"),
    type: optionalString(value.type, "wordpress.crud-operation.resource.type"),
    id: normalizeOptionalStringOrNumber(value.id, "wordpress.crud-operation.resource.id"),
    path: optionalString(value.path, "wordpress.crud-operation.resource.path"),
    route: optionalString(value.route, "wordpress.crud-operation.resource.route"),
    identifiers: normalizeCrudIdentifiers(value.identifiers),
  })
}

function normalizeCrudIdentifiers(input: unknown): WordPressCrudResourceRef["identifiers"] | undefined {
  if (input === undefined) return undefined
  const value = requireObject(input, "wordpress.crud-operation.resource.identifiers")
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (typeof entry !== "string" && typeof entry !== "number" && typeof entry !== "boolean" && entry !== null) {
      throw new Error(`wordpress.crud-operation.resource.identifiers.${key} must be a scalar value.`)
    }
    return [key, entry]
  }))
}

function isWordPressCrudVerb(value: string): value is WordPressCrudVerb {
  return value === "create" || value === "read" || value === "update" || value === "delete" || value === "list"
}

function normalizeOptionalStringOrNumber(value: unknown, label: string): string | number | undefined {
  if (value === undefined) return undefined
  if (typeof value === "string") return value.trim() === "" ? undefined : value.trim()
  if (typeof value === "number") return value
  throw new Error(`${label} must be a string or number.`)
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
