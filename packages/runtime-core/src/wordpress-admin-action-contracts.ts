import type { PerformanceObservation } from "./performance-observation.js"

export const WORDPRESS_ADMIN_ACTION_CONTRACT_SCHEMA = "wp-codebox/wordpress-admin-action/v1" as const
export const WORDPRESS_ADMIN_ACTION_RESULT_SCHEMA = "wp-codebox/wordpress-admin-action-result/v1" as const

export const WORDPRESS_ADMIN_ACTION_FAMILIES = ["admin-hook", "ajax", "admin-post", "editor", "browser-random-walk"] as const
export type WordPressAdminActionFamily = typeof WORDPRESS_ADMIN_ACTION_FAMILIES[number]

export const WORDPRESS_ADMIN_ACTION_SUPPORTED_FAMILIES = ["admin-hook", "ajax", "admin-post"] as const
export type WordPressAdminActionSupportedFamily = typeof WORDPRESS_ADMIN_ACTION_SUPPORTED_FAMILIES[number]

export const WORDPRESS_ADMIN_ACTION_UNSUPPORTED_FAMILIES = ["editor", "browser-random-walk"] as const
export type WordPressAdminActionUnsupportedFamily = typeof WORDPRESS_ADMIN_ACTION_UNSUPPORTED_FAMILIES[number]

export interface WordPressDisposableDestructiveBoundary {
  disposableRuntime: true
  destructive: true
  artifactPolicy: "capture"
  teardown: "discard-runtime"
  reason?: string
  metadata?: Record<string, unknown>
}

export interface WordPressAdminActionContract {
  schema: typeof WORDPRESS_ADMIN_ACTION_CONTRACT_SCHEMA
  family: WordPressAdminActionFamily
  hook?: string
  action?: string
  method?: "POST" | "GET"
  query?: Record<string, unknown>
  body?: Record<string, unknown>
  user?: string
  destructiveBoundary: WordPressDisposableDestructiveBoundary
  metadata?: Record<string, unknown>
}

export interface WordPressAdminActionFamilyDescriptor {
  family: WordPressAdminActionFamily
  status: "supported" | "unsupported"
  reason?: string
}

export interface WordPressAdminActionResult {
  schema: typeof WORDPRESS_ADMIN_ACTION_RESULT_SCHEMA
  command: "wordpress.admin-action"
  status: "ok" | "error" | "unsupported"
  action: WordPressAdminActionContract
  disposableDestructiveBoundary: WordPressDisposableDestructiveBoundary
  familyDescriptors: WordPressAdminActionFamilyDescriptor[]
  executed?: {
    family: WordPressAdminActionSupportedFamily
    hook: string
    method: "POST" | "GET"
  }
  diagnostics: { code: string; message: string; severity?: "info" | "warning" | "error"; metadata?: Record<string, unknown> }[]
  errors: { code: string; message: string; metadata?: Record<string, unknown> }[]
  artifacts: Record<string, unknown>
  artifactRefs: unknown[]
  performance?: PerformanceObservation
  metadata?: Record<string, unknown>
}

export const WORDPRESS_ADMIN_ACTION_RESULT_JSON_SCHEMA = {
  $id: WORDPRESS_ADMIN_ACTION_RESULT_SCHEMA,
  type: "object",
  additionalProperties: true,
  required: ["schema", "command", "status", "action", "disposableDestructiveBoundary", "familyDescriptors", "diagnostics", "errors", "artifacts", "artifactRefs"],
  properties: {
    schema: { const: WORDPRESS_ADMIN_ACTION_RESULT_SCHEMA },
    command: { const: "wordpress.admin-action" },
    status: { enum: ["ok", "error", "unsupported"] },
    action: { type: "object" },
    disposableDestructiveBoundary: { type: "object" },
    familyDescriptors: { type: "array" },
    executed: { type: "object" },
    diagnostics: { type: "array" },
    errors: { type: "array" },
    artifacts: { type: "object" },
    artifactRefs: { type: "array" },
    performance: { type: "object" },
    metadata: { type: "object" },
  },
} as const

export const WORDPRESS_ADMIN_ACTION_FAMILY_DESCRIPTORS: readonly WordPressAdminActionFamilyDescriptor[] = [
  { family: "admin-hook", status: "supported" },
  { family: "ajax", status: "supported" },
  { family: "admin-post", status: "supported" },
  { family: "editor", status: "unsupported", reason: "Use wordpress.editor-actions for real browser-backed editor mutations." },
  { family: "browser-random-walk", status: "unsupported", reason: "The public planning contract exists in browser-interaction; runtime execution is not implemented." },
] as const

export function normalizeWordPressAdminActionContract(input: Partial<WordPressAdminActionContract> & { family?: unknown; destructiveBoundary?: unknown }): WordPressAdminActionContract {
  const family = normalizeFamily(input.family)
  const destructiveBoundary = normalizeBoundary(input.destructiveBoundary)

  return {
    schema: WORDPRESS_ADMIN_ACTION_CONTRACT_SCHEMA,
    family,
    ...(typeof input.hook === "string" && input.hook.length > 0 ? { hook: input.hook } : {}),
    ...(typeof input.action === "string" && input.action.length > 0 ? { action: input.action } : {}),
    method: input.method === "GET" ? "GET" : "POST",
    ...(isRecord(input.query) ? { query: input.query } : {}),
    ...(isRecord(input.body) ? { body: input.body } : {}),
    ...(typeof input.user === "string" && input.user.length > 0 ? { user: input.user } : {}),
    destructiveBoundary,
    ...(isRecord(input.metadata) ? { metadata: input.metadata } : {}),
  }
}

function normalizeFamily(family: unknown): WordPressAdminActionFamily {
  if (typeof family === "string" && (WORDPRESS_ADMIN_ACTION_FAMILIES as readonly string[]).includes(family)) {
    return family as WordPressAdminActionFamily
  }
  throw new Error(`WordPress admin action family must be one of ${WORDPRESS_ADMIN_ACTION_FAMILIES.join(", ")}: ${String(family ?? "")}`)
}

function normalizeBoundary(boundary: unknown): WordPressDisposableDestructiveBoundary {
  if (!isRecord(boundary) || boundary.disposableRuntime !== true || boundary.destructive !== true || boundary.artifactPolicy !== "capture" || boundary.teardown !== "discard-runtime") {
    throw new Error("WordPress admin action requires destructiveBoundary={ disposableRuntime:true, destructive:true, artifactPolicy:'capture', teardown:'discard-runtime' }.")
  }
  return {
    disposableRuntime: true,
    destructive: true,
    artifactPolicy: "capture",
    teardown: "discard-runtime",
    ...(typeof boundary.reason === "string" ? { reason: boundary.reason } : {}),
    ...(isRecord(boundary.metadata) ? { metadata: boundary.metadata } : {}),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}
