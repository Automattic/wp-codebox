import type { PerformanceObservation } from "./performance-observation.js"
import type { BackendNeutralArtifactRef } from "./runtime-neutral-contracts.js"

export const WORDPRESS_PAGE_LOAD_RESULT_SCHEMA = "wp-codebox/wordpress-page-load-result/v1" as const

export type WordPressPageLoadCommand = "wordpress.admin-page-load" | "wordpress.frontend-page-load" | "wordpress.simulated-admin-page-load" | "wordpress.simulated-frontend-page-load" | "wordpress.server-page-load" | "wordpress.browser-page-load"
export type WordPressPageLoadMode = "simulated" | "server-http" | "browser"
export type WordPressPageLoadTargetKind = "admin" | "frontend"
export type WordPressPageLoadStatus = "ok" | "redirect" | "error"

export interface WordPressPageLoadNotice {
  channel: "admin_notices" | "all_admin_notices" | "doing_it_wrong" | "deprecated" | "php" | (string & {})
  message?: string
  severity?: "info" | "warning" | "error"
  metadata?: Record<string, unknown>
}

export interface WordPressPageLoadRedirect {
  location: string
  status?: number
  source?: "wp_redirect" | "header" | (string & {})
}

export interface WordPressPageLoadError {
  code: string
  message: string
  severity?: "warning" | "error"
  metadata?: Record<string, unknown>
}

export interface WordPressPageLoadIdentity {
  url?: string
  path?: string
  screenId?: string
  screenBase?: string
  hookSuffix?: string
  adminPage?: string
  postId?: number
  postType?: string
  queriedObjectId?: number
  queriedObjectType?: string
  template?: string
  queryVars?: Record<string, unknown>
  bodyClasses?: string[]
}

export interface WordPressPageLoadTarget {
  kind: WordPressPageLoadTargetKind
  path?: string
  url?: string
  method?: "GET" | "POST" | (string & {})
  query?: Record<string, unknown>
  body?: Record<string, unknown>
  userSession?: Record<string, unknown> | null
}

export interface WordPressPageLoadResult {
  schema: typeof WORDPRESS_PAGE_LOAD_RESULT_SCHEMA
  mode: WordPressPageLoadMode
  command: WordPressPageLoadCommand
  status: WordPressPageLoadStatus
  target: WordPressPageLoadTarget
  identity?: WordPressPageLoadIdentity
  http?: { status?: number; headers?: Record<string, unknown> }
  redirect?: WordPressPageLoadRedirect
  notices?: WordPressPageLoadNotice[]
  errors?: WordPressPageLoadError[]
  performance?: PerformanceObservation
  artifactRefs?: BackendNeutralArtifactRef[]
  diagnostics?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export const WORDPRESS_PAGE_LOAD_RESULT_JSON_SCHEMA = {
  $id: WORDPRESS_PAGE_LOAD_RESULT_SCHEMA,
  type: "object",
  additionalProperties: true,
  required: ["schema", "mode", "command", "status", "target"],
  properties: {
    schema: { const: WORDPRESS_PAGE_LOAD_RESULT_SCHEMA },
    mode: { enum: ["simulated", "server-http", "browser"] },
    command: { enum: ["wordpress.admin-page-load", "wordpress.frontend-page-load", "wordpress.simulated-admin-page-load", "wordpress.simulated-frontend-page-load", "wordpress.server-page-load", "wordpress.browser-page-load"] },
    status: { enum: ["ok", "redirect", "error"] },
    target: {
      type: "object",
      additionalProperties: true,
      required: ["kind"],
      properties: {
        kind: { enum: ["admin", "frontend"] },
        path: { type: "string" },
        url: { type: "string" },
        method: { type: "string" },
        query: { type: "object", additionalProperties: true },
        body: { type: "object", additionalProperties: true },
        userSession: { type: ["object", "null"], additionalProperties: true },
      },
    },
    identity: { type: "object", additionalProperties: true },
    http: { type: "object", additionalProperties: true },
    redirect: { type: "object", additionalProperties: true },
    notices: { type: "array" },
    errors: { type: "array" },
    performance: { type: "object", additionalProperties: true },
    artifactRefs: { type: "array" },
    diagnostics: { type: "object", additionalProperties: true },
    metadata: { type: "object", additionalProperties: true },
  },
} as const

export function wordpressPageLoadResult(input: Omit<WordPressPageLoadResult, "schema">): WordPressPageLoadResult {
  return stripUndefined({
    schema: WORDPRESS_PAGE_LOAD_RESULT_SCHEMA,
    mode: input.mode,
    command: input.command,
    status: input.status,
    target: input.target,
    identity: input.identity,
    http: input.http,
    redirect: input.redirect,
    notices: input.notices,
    errors: input.errors,
    performance: input.performance,
    artifactRefs: input.artifactRefs,
    diagnostics: input.diagnostics,
    metadata: input.metadata,
  })
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T
}
