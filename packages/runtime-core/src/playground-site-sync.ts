import { sha256StableJson, stableJson } from "./object-utils.js"

export const PLAYGROUND_SITE_SYNC_DELEGATION_SCHEMA = "wp-codebox/playground-site-sync-delegation/v1" as const
export const PLAYGROUND_SITE_SYNC_ERROR_SCHEMA = "wp-codebox/playground-site-sync-error/v1" as const
export const PLAYGROUND_SITE_SYNC_PACKAGE_SCHEMA = "wp-codebox/playground-site-sync-package/v1" as const
export const PLAYGROUND_SITE_SYNC_REDACTION_POLICY_SCHEMA = "wp-codebox/playground-site-sync-redaction-policy/v1" as const
export const PLAYGROUND_SITE_SYNC_REDACTION_METADATA_SCHEMA = "wp-codebox/playground-site-sync-redaction-metadata/v1" as const
export const PLAYGROUND_SITE_SYNC_HYDRATION_RESULT_SCHEMA = "wp-codebox/playground-site-sync-hydration-result/v1" as const

export type PlaygroundSiteSyncRouteName =
  | "manifest"
  | "resources"
  | "export"
  | "snapshots"
  | "snapshot"
  | "apply_plan_generate"
  | "apply_plan_validate"
  | "apply_plan_apply"

export type PlaygroundSiteSyncRouteMethod = "GET" | "POST"

export interface PlaygroundSiteSyncRouteDescriptor {
  name: PlaygroundSiteSyncRouteName
  path: string
  method: PlaygroundSiteSyncRouteMethod
}

export interface PlaygroundSiteSyncDelegationDescriptor {
  schema: typeof PLAYGROUND_SITE_SYNC_DELEGATION_SCHEMA
  namespace: string
  transport: "same-origin-rest"
  routes: PlaygroundSiteSyncRouteDescriptor[]
  manifest?: Record<string, unknown>
  auth?: {
    mode: "ambient-user-session" | "runtime-supplied"
    required: boolean
  }
}

export interface PlaygroundSiteSyncError {
  schema: typeof PLAYGROUND_SITE_SYNC_ERROR_SCHEMA
  code: string
  message: string
  status: number
  authRequired?: boolean
  details?: Record<string, unknown>
}

export interface PlaygroundSiteSyncRemoteConnection {
  siteUrl: string
  bearerToken?: string
  username?: string
  applicationPassword?: string
}

export interface PlaygroundSiteSyncRemoteAuthResult {
  status: "ok" | "error"
  siteUrl: string
  headers?: Record<string, string>
  error?: PlaygroundSiteSyncError
}

export interface PlaygroundSiteSyncRedactionRuleSet {
  exact?: string[]
  patterns?: string[]
}

export interface PlaygroundSiteSyncRedactionPolicy {
  schema: typeof PLAYGROUND_SITE_SYNC_REDACTION_POLICY_SCHEMA
  version: string
  defaultMode: "deny-sensitive-identifiers"
  deniedPaths: PlaygroundSiteSyncRedactionRuleSet
  deniedOptions: PlaygroundSiteSyncRedactionRuleSet
  deniedMetaKeys: PlaygroundSiteSyncRedactionRuleSet
  privateDataHandling: Record<string, unknown>
}

export interface PlaygroundSiteSyncRedactionMetadata {
  schema: typeof PLAYGROUND_SITE_SYNC_REDACTION_METADATA_SCHEMA
  policySchema: typeof PLAYGROUND_SITE_SYNC_REDACTION_POLICY_SCHEMA
  policyVersion: string
  applied: boolean
  valueCaptureAllowed: false
  evidence: {
    deniedPathRules: PlaygroundSiteSyncRedactionRuleCounts
    deniedOptionRules: PlaygroundSiteSyncRedactionRuleCounts
    deniedMetaKeyRules: PlaygroundSiteSyncRedactionRuleCounts
    leaksValues: false
    note: string
  }
  privateDataHandling: Record<string, unknown>
}

export interface PlaygroundSiteSyncRedactionRuleCounts {
  exact: number
  patterns: number
  total: number
}

export interface PlaygroundSiteSyncPackageDescriptorInput {
  id?: string
  generated?: string
  manifest?: Record<string, unknown>
  resources?: Record<string, unknown>
  blueprint?: Record<string, unknown>
  redaction?: PlaygroundSiteSyncRedactionMetadata
  limitations?: string[]
}

export interface PlaygroundSiteSyncPackageDescriptor {
  schema: typeof PLAYGROUND_SITE_SYNC_PACKAGE_SCHEMA
  status: "ready"
  generated: string
  descriptor: {
    id: string
    format: "playground-blueprint-descriptor"
    packaged: false
    archive: false
    bootable: boolean
    status: "ready"
    generated: string
    sizeBytes: number
    checksum: string
  }
  security: {
    redaction: PlaygroundSiteSyncRedactionMetadata
  }
  includes: {
    manifest: boolean
    resourceInventory: boolean
    blueprint: boolean
    database: false
    uploads: false
    themes: false
    plugins: false
  }
  wpContent: {
    included: string[]
    omitted: Record<string, string>
  }
  limitations: string[]
  checksums: Record<string, string>
  manifest: Record<string, unknown>
  resources: Record<string, unknown>
  blueprint: Record<string, unknown>
}

export interface PlaygroundSiteSyncHydrationUnsupportedResult {
  schema: typeof PLAYGROUND_SITE_SYNC_HYDRATION_RESULT_SCHEMA
  status: "unsupported"
  packageId?: string
  error: PlaygroundSiteSyncError
}

const DEFAULT_NAMESPACE = "playground-site-sync/v1"
const MAX_NAMESPACE_LENGTH = 80
const MAX_ROUTE_PATH_LENGTH = 160

const DEFAULT_ROUTE_PATHS: Record<PlaygroundSiteSyncRouteName, { path: string, method: PlaygroundSiteSyncRouteMethod }> = {
  manifest: { path: "/manifest", method: "GET" },
  resources: { path: "/resources", method: "GET" },
  export: { path: "/export", method: "POST" },
  snapshots: { path: "/snapshots", method: "GET" },
  snapshot: { path: "/snapshots/:id", method: "GET" },
  apply_plan_generate: { path: "/apply-plan/generate", method: "POST" },
  apply_plan_validate: { path: "/apply-plan/validate", method: "POST" },
  apply_plan_apply: { path: "/apply-plan/apply", method: "POST" },
}

export function createPlaygroundSiteSyncDelegationDescriptor(input: {
  namespace?: string
  routes?: Partial<Record<PlaygroundSiteSyncRouteName, string | { path: string, method?: PlaygroundSiteSyncRouteMethod }>>
  manifest?: Record<string, unknown>
  auth?: PlaygroundSiteSyncDelegationDescriptor["auth"]
} = {}): PlaygroundSiteSyncDelegationDescriptor {
  const namespace = normalizePlaygroundSiteSyncNamespace(input.namespace ?? DEFAULT_NAMESPACE)
  const routes = normalizePlaygroundSiteSyncRoutes(input.routes)

  return {
    schema: PLAYGROUND_SITE_SYNC_DELEGATION_SCHEMA,
    namespace,
    transport: "same-origin-rest",
    routes,
    ...(input.manifest ? { manifest: input.manifest } : {}),
    auth: input.auth ?? { mode: "ambient-user-session", required: true },
  }
}

export function normalizePlaygroundSiteSyncRoutes(
  routes: Partial<Record<PlaygroundSiteSyncRouteName, string | { path: string, method?: PlaygroundSiteSyncRouteMethod }>> = {},
): PlaygroundSiteSyncRouteDescriptor[] {
  const descriptors: PlaygroundSiteSyncRouteDescriptor[] = []
  for (const name of Object.keys(DEFAULT_ROUTE_PATHS) as PlaygroundSiteSyncRouteName[]) {
    const defaultRoute = DEFAULT_ROUTE_PATHS[name]
    const override = routes[name]
    const path = typeof override === "string" ? override : override?.path ?? defaultRoute.path
    const method = typeof override === "object" && override.method ? override.method : defaultRoute.method
    descriptors.push({ name, path: normalizePlaygroundSiteSyncRoutePath(path), method: normalizePlaygroundSiteSyncRouteMethod(method) })
  }

  return descriptors
}

export function createPlaygroundSiteSyncRemoteAuth(connection: PlaygroundSiteSyncRemoteConnection): PlaygroundSiteSyncRemoteAuthResult {
  const siteUrl = String(connection.siteUrl ?? "").trim()
  if (!siteUrl) {
    return {
      status: "error",
      siteUrl: "",
      error: playgroundSiteSyncError("site_url_missing", "A remote site URL is required.", 400),
    }
  }

  const bearerToken = String(connection.bearerToken ?? "").trim()
  const username = String(connection.username ?? "").trim()
  const applicationPassword = String(connection.applicationPassword ?? "").trim()

  if (bearerToken) {
    return { status: "ok", siteUrl, headers: { Accept: "application/json", Authorization: `Bearer ${bearerToken}` } }
  }

  if (username && applicationPassword) {
    return { status: "ok", siteUrl, headers: { Accept: "application/json", Authorization: `Basic ${Buffer.from(`${username}:${applicationPassword}`).toString("base64")}` } }
  }

  return {
    status: "error",
    siteUrl,
    error: playgroundSiteSyncError("auth_missing", "Remote Playground site sync requires runtime credentials.", 401, { authRequired: true }),
  }
}

export function playgroundSiteSyncError(code: string, message: string, status: number, options: { authRequired?: boolean, details?: Record<string, unknown> } = {}): PlaygroundSiteSyncError {
  return {
    schema: PLAYGROUND_SITE_SYNC_ERROR_SCHEMA,
    code,
    message,
    status,
    ...(options.authRequired ? { authRequired: true } : {}),
    ...(options.details ? { details: options.details } : {}),
  }
}

export function defaultPlaygroundSiteSyncRedactionPolicy(): PlaygroundSiteSyncRedactionPolicy {
  return {
    schema: PLAYGROUND_SITE_SYNC_REDACTION_POLICY_SCHEMA,
    version: "2026-06-01",
    defaultMode: "deny-sensitive-identifiers",
    deniedPaths: {
      exact: [".env", ".env.local", ".env.production", "auth.json", "credentials.json", "cookies.txt", "wp-config.php", "wp-content/debug.log"],
      patterns: ["/(^|/|\\\\)\\.env(\\.|$)/i", "/(_auth|auth[-_]?token|access[-_]?token|refresh[-_]?token|session|cookie|credential|secret|private[-_]?key|api[-_]?key)/i", "/(^|/|\\\\)(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\\.|$)?/i", "/\\.(pem|key|p12|pfx)$/i"],
    },
    deniedOptions: {
      exact: ["auth_key", "secure_auth_key", "logged_in_key", "nonce_key", "auth_salt", "secure_auth_salt", "logged_in_salt", "nonce_salt", "ftp_credentials", "wpcom_auth_access_token"],
      patterns: ["/(^|_)(password|passphrase|credential|secret|token|cookie|session|private_key|api_key|client_secret)(_|$)/i", "/(oauth|bearer|jwt|application_password|smtp_pass|mail_password|openai|anthropic|stripe|github|wpcom)/i"],
    },
    deniedMetaKeys: {
      exact: ["application_passwords", "_application_passwords", "_session_tokens", "session_tokens", "wpcom_auth_access_token"],
      patterns: ["/(^|_)(password|passphrase|credential|secret|token|cookie|session|private_key|api_key|client_secret)(_|$)/i", "/(oauth|bearer|jwt|application_password|auth_cookie|recovery_key)/i"],
    },
    privateDataHandling: {
      database: { status: "required-before-export" },
      uploads: { status: "required-before-export" },
    },
  }
}

export function createPlaygroundSiteSyncRedactionMetadata(policy = defaultPlaygroundSiteSyncRedactionPolicy()): PlaygroundSiteSyncRedactionMetadata {
  return {
    schema: PLAYGROUND_SITE_SYNC_REDACTION_METADATA_SCHEMA,
    policySchema: policy.schema,
    policyVersion: policy.version,
    applied: true,
    valueCaptureAllowed: false,
    evidence: {
      deniedPathRules: countPlaygroundSiteSyncRedactionRules(policy.deniedPaths),
      deniedOptionRules: countPlaygroundSiteSyncRedactionRules(policy.deniedOptions),
      deniedMetaKeyRules: countPlaygroundSiteSyncRedactionRules(policy.deniedMetaKeys),
      leaksValues: false,
      note: "Descriptor evidence reports policy coverage only; package execution must report counts and rule IDs without original values.",
    },
    privateDataHandling: policy.privateDataHandling,
  }
}

export function countPlaygroundSiteSyncRedactionRules(rules: PlaygroundSiteSyncRedactionRuleSet): PlaygroundSiteSyncRedactionRuleCounts {
  const exact = Array.isArray(rules.exact) ? rules.exact.length : 0
  const patterns = Array.isArray(rules.patterns) ? rules.patterns.length : 0
  return { exact, patterns, total: exact + patterns }
}

export function createPlaygroundSiteSyncPackageDescriptor(input: PlaygroundSiteSyncPackageDescriptorInput = {}): PlaygroundSiteSyncPackageDescriptor {
  const generated = input.generated ?? new Date().toISOString()
  const manifest = input.manifest ?? {}
  const resources = input.resources ?? {}
  const blueprint = input.blueprint ?? { landingPage: "/wp-admin/", steps: [] }
  const redaction = input.redaction ?? createPlaygroundSiteSyncRedactionMetadata()
  const packageId = input.id ?? `playground_site_sync_${sha256StableJson({ generated, manifest, resources, blueprint }).slice(0, 24)}`
  const basePackage: PlaygroundSiteSyncPackageDescriptor = {
    schema: PLAYGROUND_SITE_SYNC_PACKAGE_SCHEMA,
    status: "ready",
    generated,
    descriptor: {
      id: packageId,
      format: "playground-blueprint-descriptor",
      packaged: false,
      archive: false,
      bootable: true,
      status: "ready",
      generated,
      sizeBytes: 0,
      checksum: "sha256:pending",
    },
    security: { redaction },
    includes: {
      manifest: true,
      resourceInventory: true,
      blueprint: true,
      database: false,
      uploads: false,
      themes: false,
      plugins: false,
    },
    wpContent: {
      included: [],
      omitted: {
        plugins: "Plugin files are not packaged by this descriptor.",
        themes: "Theme files are not packaged by this descriptor.",
        uploads: "Upload files are not packaged by this descriptor.",
        mu_plugins: "Must-use plugins are not packaged by this descriptor.",
      },
    },
    limitations: input.limitations ?? [
      "No full database dump is included; callers must opt into private data export explicitly.",
      "wp-content files are omitted until a package writer applies redaction rules before writing artifacts.",
    ],
    checksums: {
      manifest: `sha256:${sha256StableJson(manifest)}`,
      resourceInventory: `sha256:${sha256StableJson(resources)}`,
      blueprint: `sha256:${sha256StableJson(blueprint)}`,
    },
    manifest,
    resources,
    blueprint,
  }

  basePackage.descriptor.sizeBytes = stableJson(basePackage).length
  basePackage.descriptor.checksum = `sha256:${sha256StableJson({ ...basePackage, descriptor: { ...basePackage.descriptor, checksum: "sha256:pending" } })}`
  basePackage.descriptor.sizeBytes = stableJson(basePackage).length
  return basePackage
}

export function unsupportedPlaygroundSiteSyncHydration(packageDescriptor?: { descriptor?: { id?: unknown } }): PlaygroundSiteSyncHydrationUnsupportedResult {
  const packageId = typeof packageDescriptor?.descriptor?.id === "string" ? packageDescriptor.descriptor.id : undefined
  return {
    schema: PLAYGROUND_SITE_SYNC_HYDRATION_RESULT_SCHEMA,
    status: "unsupported",
    ...(packageId ? { packageId } : {}),
    error: playgroundSiteSyncError("hydration_unsupported", "WP Codebox exposes package descriptors; in-place site hydration is intentionally caller-provided.", 501, {
      details: {
        supportedPrimitive: "playground-blueprint-descriptor",
        mutationPolicy: "caller-owned",
      },
    }),
  }
}

function normalizePlaygroundSiteSyncNamespace(namespace: string): string {
  const normalized = namespace.trim().replace(/^\/+|\/+$/g, "")
  if (!/^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)+$/.test(normalized) || normalized.length > MAX_NAMESPACE_LENGTH) {
    throw new Error(`Invalid Playground site sync namespace: ${namespace}`)
  }

  return normalized
}

function normalizePlaygroundSiteSyncRoutePath(path: string): string {
  const normalized = path.trim()
  if (!normalized.startsWith("/") || normalized.length > MAX_ROUTE_PATH_LENGTH || normalized.includes("..") || normalized.includes("://") || normalized.includes("?") || normalized.includes("#")) {
    throw new Error(`Invalid Playground site sync route path: ${path}`)
  }

  return normalized.replace(/\/+/g, "/")
}

function normalizePlaygroundSiteSyncRouteMethod(method: string): PlaygroundSiteSyncRouteMethod {
  if (method !== "GET" && method !== "POST") {
    throw new Error(`Invalid Playground site sync route method: ${method}`)
  }

  return method
}
