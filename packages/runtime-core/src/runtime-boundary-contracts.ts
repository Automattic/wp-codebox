export const RUNTIME_PROFILE_SCHEMA = "wp-codebox/runtime-profile/v1" as const
export const PREVIEW_LEASE_SCHEMA = "wp-codebox/preview-lease/v1" as const
export const BROWSER_CONTAINED_SITE_STATUS_SCHEMA = "wp-codebox/browser-contained-site-status/v1" as const
export const BROWSER_SESSION_PRODUCT_DTO_SCHEMA = "wp-codebox/browser-session-product-dto/v1" as const
export const BROWSER_PREVIEW_BOOT_CONFIG_SCHEMA = "wp-codebox/browser-preview-boot-config/v1" as const

export type RuntimeProfileDependencyKind = "component" | "plugin" | "mu_plugin" | "theme" | "bootstrap" | "overlay" | (string & {})
export type RuntimeProfileReadinessStatus = "ready" | "pending" | "blocked" | "missing" | "unknown" | (string & {})

export interface RuntimeProfileDependency {
  kind: RuntimeProfileDependencyKind
  slug: string
  name?: string
  source?: string
  target?: string
  version?: string
  activate?: boolean
  required?: boolean
  readiness?: RuntimeProfileReadinessStatus
  provenance?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export interface RuntimeProfileBootstrap {
  mode?: string
  entrypoint?: string
  blueprint_ref?: string
  steps?: string[]
  provenance?: Record<string, unknown>
}

export interface RuntimeProfileReadiness {
  status: RuntimeProfileReadinessStatus
  checks?: Record<string, boolean>
  missing?: string[]
  evidence?: Record<string, unknown>
}

export interface RuntimeProfile {
  schema: typeof RUNTIME_PROFILE_SCHEMA
  id?: string
  component_contracts?: Record<string, unknown>[]
  extra_plugins?: Record<string, unknown>[]
  provider_plugins?: Record<string, unknown>[]
  components: RuntimeProfileDependency[]
  plugins?: RuntimeProfileDependency[]
  mu_plugins?: RuntimeProfileDependency[]
  themes?: RuntimeProfileDependency[]
  bootstrap?: RuntimeProfileBootstrap
  overlays?: RuntimeProfileDependency[]
  runtime_overlays?: Record<string, unknown>[]
  runtime_state_mounts?: Record<string, unknown>[]
  runtime_config_mounts?: Record<string, unknown>[]
  env?: Record<string, string>
  readiness?: RuntimeProfileReadiness
  provenance?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export interface PreviewLeaseMetadata {
  id?: string
  status?: "active" | "expired" | "released" | "unknown" | (string & {})
  acquired_at?: string
  expires_at?: string
  owner?: string
  provider?: string
  provenance?: Record<string, unknown>
}

export interface PreviewAlignmentEvidence {
  status: "aligned" | "misaligned" | "unknown" | (string & {})
  checked_at?: string
  preview_matches_site?: boolean
  preview_matches_local?: boolean
  evidence?: Record<string, unknown>
}

export interface PreviewLease {
  schema: typeof PREVIEW_LEASE_SCHEMA
  preview_public_url?: string
  site_url?: string
  local_url?: string
  lease?: PreviewLeaseMetadata
  alignment?: PreviewAlignmentEvidence
  provenance?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export type PreviewLeaseLifecycleStatus = "active" | "expired" | "released" | "unknown"

export interface BrowserContainedSiteStatus {
  schema: typeof BROWSER_CONTAINED_SITE_STATUS_SCHEMA
  success: boolean
  site_id: string
  status: "recoverable" | "miss" | "expired" | "blocked" | "unknown" | (string & {})
  source_digest: {
    algorithm: "sha256" | (string & {})
    value: string
  }
  prepared_runtime?: Record<string, unknown>
  blueprint_ref?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export interface BrowserPreviewBootConfig {
  schema: typeof BROWSER_PREVIEW_BOOT_CONFIG_SCHEMA
  session_id?: string
  scope?: string
  client_module_url?: string
  remote_url?: string
  cors_proxy_url?: string
  blueprint_ref?: string
  blueprint_ref_dto?: Record<string, unknown>
  preview?: PreviewLease
  contained_site?: Record<string, unknown>
  artifacts?: Record<string, unknown>
  provenance?: Record<string, unknown>
}

export interface BrowserSessionProductDto {
  schema: typeof BROWSER_SESSION_PRODUCT_DTO_SCHEMA
  source_schema?: string
  success: boolean
  status?: string
  execution?: string
  execution_scope?: string
  permission_model?: string
  session_id?: string
  contained_site?: Record<string, unknown>
  task?: string
  target?: Record<string, unknown>
  agent?: string
  provider?: string
  model?: string
  preview_boot?: BrowserPreviewBootConfig
  signals?: Record<string, unknown>
  artifacts?: Record<string, unknown>
  error?: Record<string, unknown>
}

export function runtimeProfile(input: unknown): RuntimeProfile {
  const value = requireObject(input, "Runtime profile") as Partial<RuntimeProfile>
  if (value.schema !== RUNTIME_PROFILE_SCHEMA) throw new Error(`Runtime profile schema must be ${RUNTIME_PROFILE_SCHEMA}.`)
  return {
    schema: RUNTIME_PROFILE_SCHEMA,
    id: optionalString(value.id, "id"),
    component_contracts: normalizeObjectList(value.component_contracts, "component_contracts"),
    extra_plugins: normalizeObjectList(value.extra_plugins, "extra_plugins"),
    provider_plugins: normalizeObjectList(value.provider_plugins, "provider_plugins"),
    components: normalizeDependencies(value.components, "components", true) ?? [],
    plugins: normalizeDependencies(value.plugins, "plugins", true),
    mu_plugins: normalizeDependencies(value.mu_plugins, "mu_plugins", true),
    themes: normalizeDependencies(value.themes, "themes", true),
    bootstrap: value.bootstrap === undefined ? undefined : normalizeBootstrap(value.bootstrap),
    overlays: normalizeDependencies(value.overlays, "overlays", true),
    runtime_overlays: normalizeObjectList(value.runtime_overlays, "runtime_overlays"),
    runtime_state_mounts: normalizeObjectList(value.runtime_state_mounts, "runtime_state_mounts"),
    runtime_config_mounts: normalizeObjectList(value.runtime_config_mounts, "runtime_config_mounts"),
    env: normalizeEnv(value.env),
    readiness: value.readiness === undefined ? undefined : normalizeReadiness(value.readiness),
    provenance: normalizeOptionalObject(value.provenance, "Runtime profile provenance"),
    metadata: normalizeOptionalObject(value.metadata, "Runtime profile metadata"),
  }
}

export function previewLease(input: unknown): PreviewLease {
  const value = requireObject(input, "Preview lease") as Partial<PreviewLease>
  if (value.schema !== PREVIEW_LEASE_SCHEMA) throw new Error(`Preview lease schema must be ${PREVIEW_LEASE_SCHEMA}.`)
  const lease: PreviewLease = {
    schema: PREVIEW_LEASE_SCHEMA,
    preview_public_url: optionalString(value.preview_public_url, "preview_public_url"),
    site_url: optionalString(value.site_url, "site_url"),
    local_url: optionalString(value.local_url, "local_url"),
    lease: value.lease === undefined ? undefined : (normalizeOptionalObject(value.lease, "Preview lease metadata") as PreviewLeaseMetadata),
    alignment: value.alignment === undefined ? undefined : normalizeAlignment(value.alignment),
    provenance: normalizeOptionalObject(value.provenance, "Preview lease provenance"),
    metadata: normalizeOptionalObject(value.metadata, "Preview lease metadata"),
  }
  if (!lease.preview_public_url && !lease.site_url && !lease.local_url) {
    throw new Error("Preview lease must include preview_public_url, site_url, or local_url.")
  }
  return lease
}

export function previewLeaseStatus(input: PreviewLease | unknown, now = new Date()): PreviewLeaseLifecycleStatus {
  const lease = isPreviewLease(input) ? input : previewLease(input)
  const declaredStatus = typeof lease.lease?.status === "string" ? lease.lease.status : ""
  if (declaredStatus === "released") return "released"

  const expiresAt = lease.lease?.expires_at
  if (typeof expiresAt === "string" && expiresAt.trim() !== "") {
    const expires = Date.parse(expiresAt)
    if (!Number.isNaN(expires) && expires <= now.getTime()) return "expired"
  }

  if (declaredStatus === "active" || lease.preview_public_url || lease.site_url || lease.local_url) return "active"
  if (declaredStatus === "expired") return "expired"
  return "unknown"
}

export function isPreviewLease(input: unknown): input is PreviewLease {
  return Boolean(input && typeof input === "object" && !Array.isArray(input) && (input as { schema?: unknown }).schema === PREVIEW_LEASE_SCHEMA)
}

export function browserContainedSiteStatus(input: unknown): BrowserContainedSiteStatus {
  const value = requireObject(input, "Browser contained site status") as Partial<BrowserContainedSiteStatus>
  if (value.schema !== BROWSER_CONTAINED_SITE_STATUS_SCHEMA) throw new Error(`Browser contained site status schema must be ${BROWSER_CONTAINED_SITE_STATUS_SCHEMA}.`)
  const digest = requireObject(value.source_digest, "Browser contained site status source_digest") as { algorithm?: unknown; value?: unknown }
  const digestValue = optionalString(digest.value, "source_digest.value")
  if (!digestValue || !/^[a-f0-9]{64}$/.test(digestValue)) throw new Error("source_digest.value must be a 64-character sha256 digest.")

  return {
    schema: BROWSER_CONTAINED_SITE_STATUS_SCHEMA,
    success: value.success === true,
    site_id: requiredIdentifier(value.site_id, "site_id"),
    status: requiredIdentifier(value.status, "status") as BrowserContainedSiteStatus["status"],
    source_digest: {
      algorithm: optionalString(digest.algorithm, "source_digest.algorithm") ?? "sha256",
      value: digestValue,
    },
    prepared_runtime: normalizeOptionalObject(value.prepared_runtime, "prepared_runtime"),
    blueprint_ref: normalizeOptionalObject(value.blueprint_ref, "blueprint_ref"),
    metadata: normalizeOptionalObject(value.metadata, "metadata"),
  }
}

function normalizeDependencies(value: unknown, label: string, optional = false): RuntimeProfileDependency[] | undefined {
  if (value === undefined && optional) return undefined
  if (!Array.isArray(value)) throw new Error(`Runtime profile ${label} must be an array.`)
  return value.map((entry, index) => normalizeDependency(entry, `${label}[${index}]`))
}

function normalizeObjectList(value: unknown, label: string): Record<string, unknown>[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error(`Runtime profile ${label} must be an array.`)
  return value.map((entry, index) => requireObject(entry, `Runtime profile ${label}[${index}]`))
}

function normalizeDependency(input: unknown, label: string): RuntimeProfileDependency {
  const value = requireObject(input, `Runtime profile ${label}`) as Partial<RuntimeProfileDependency>
  const kind = requiredIdentifier(value.kind, `${label}.kind`)
  const slug = requiredIdentifier(value.slug, `${label}.slug`)
  return {
    kind,
    slug,
    name: optionalString(value.name, `${label}.name`),
    source: optionalString(value.source, `${label}.source`),
    target: optionalString(value.target, `${label}.target`),
    version: optionalString(value.version, `${label}.version`),
    activate: typeof value.activate === "boolean" ? value.activate : undefined,
    required: typeof value.required === "boolean" ? value.required : undefined,
    readiness: optionalString(value.readiness, `${label}.readiness`) as RuntimeProfileReadinessStatus | undefined,
    provenance: normalizeOptionalObject(value.provenance, `${label}.provenance`),
    metadata: normalizeOptionalObject(value.metadata, `${label}.metadata`),
  }
}

function normalizeBootstrap(input: unknown): RuntimeProfileBootstrap {
  const value = requireObject(input, "Runtime profile bootstrap") as Partial<RuntimeProfileBootstrap>
  return {
    mode: optionalString(value.mode, "bootstrap.mode"),
    entrypoint: optionalString(value.entrypoint, "bootstrap.entrypoint"),
    blueprint_ref: optionalString(value.blueprint_ref, "bootstrap.blueprint_ref"),
    steps: normalizeStringList(value.steps, "bootstrap.steps"),
    provenance: normalizeOptionalObject(value.provenance, "bootstrap.provenance"),
  }
}

function normalizeReadiness(input: unknown): RuntimeProfileReadiness {
  const value = requireObject(input, "Runtime profile readiness") as Partial<RuntimeProfileReadiness>
  const checks = normalizeBooleanMap(value.checks, "readiness.checks")
  return {
    status: requiredIdentifier(value.status, "readiness.status") as RuntimeProfileReadinessStatus,
    checks,
    missing: normalizeStringList(value.missing, "readiness.missing"),
    evidence: normalizeOptionalObject(value.evidence, "readiness.evidence"),
  }
}

function normalizeAlignment(input: unknown): PreviewAlignmentEvidence {
  const value = requireObject(input, "Preview alignment") as Partial<PreviewAlignmentEvidence>
  return {
    status: requiredIdentifier(value.status, "alignment.status") as PreviewAlignmentEvidence["status"],
    checked_at: optionalString(value.checked_at, "alignment.checked_at"),
    preview_matches_site: typeof value.preview_matches_site === "boolean" ? value.preview_matches_site : undefined,
    preview_matches_local: typeof value.preview_matches_local === "boolean" ? value.preview_matches_local : undefined,
    evidence: normalizeOptionalObject(value.evidence, "alignment.evidence"),
  }
}

function normalizeEnv(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined
  const env = requireObject(value, "Runtime profile env")
  return Object.fromEntries(
    Object.entries(env).map(([key, entry]) => {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error(`Runtime profile env key is invalid: ${key}.`)
      if (typeof entry !== "string") throw new Error(`Runtime profile env ${key} must be a string.`)
      return [key, entry]
    }),
  )
}

function normalizeBooleanMap(value: unknown, label: string): Record<string, boolean> | undefined {
  if (value === undefined) return undefined
  const map = requireObject(value, label)
  return Object.fromEntries(Object.entries(map).map(([key, entry]) => [key, Boolean(entry)]))
}

function normalizeStringList(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`)
  return [...new Set(value.map((entry) => String(entry).trim()).filter(Boolean))]
}

function normalizeOptionalObject(value: unknown, label: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  return requireObject(value, label)
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`)
  return value as Record<string, unknown>
}

function requiredIdentifier(value: unknown, label: string): string {
  const normalized = optionalString(value, label)
  if (!normalized || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(normalized)) throw new Error(`${label} must be a stable identifier.`)
  return normalized
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string") throw new Error(`${label} must be a string.`)
  const normalized = value.trim()
  return normalized === "" ? undefined : normalized
}
