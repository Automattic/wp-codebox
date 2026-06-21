export const RUNTIME_PROFILE_SCHEMA = "wp-codebox/runtime-profile/v1" as const
export const PREVIEW_LEASE_SCHEMA = "wp-codebox/preview-lease/v1" as const
export const BROWSER_CONTAINED_SITE_STATUS_SCHEMA = "wp-codebox/browser-contained-site-status/v1" as const
export const BROWSER_CONTAINED_SITE_OPEN_SCHEMA = "wp-codebox/browser-contained-site-open/v1" as const
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

export interface RuntimeProfileDiagnostic {
  code: string
  status?: RuntimeProfileReadinessStatus
  message?: string
  severity?: "info" | "warning" | "error" | (string & {})
  evidence?: Record<string, unknown>
}

export interface RuntimeProfile {
  schema: typeof RUNTIME_PROFILE_SCHEMA
  id?: string
  capabilities?: string[]
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
  diagnostics?: RuntimeProfileDiagnostic[]
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
export type BrowserContainedSiteLifecycleStatus = "recoverable_prepared_runtime" | "current" | "live" | "materialized" | "miss" | "expired" | "blocked" | "disabled" | "incompatible" | "unknown" | (string & {})

export interface BrowserContainedSiteIdentity {
  schema: "wp-codebox/browser-contained-site/v1"
  site_id: string
  preview_id?: string
  session_id?: string
  status?: BrowserContainedSiteLifecycleStatus
  source_digest?: {
    algorithm: "sha256" | (string & {})
    value: string
  }
  resolution?: Record<string, unknown>
  prepared_runtime?: Record<string, unknown>
  blueprint_ref?: Record<string, unknown>
  preview_boot?: BrowserPreviewBootConfig
  preview_lease?: PreviewLease
  session?: Record<string, unknown>
  recovery?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export interface BrowserContainedSiteStatus {
  schema: typeof BROWSER_CONTAINED_SITE_STATUS_SCHEMA
  success: boolean
  site_id: string
  status: BrowserContainedSiteLifecycleStatus
  source_digest: {
    algorithm: "sha256" | (string & {})
    value: string
  }
  resolution?: Record<string, unknown>
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

export interface BrowserContainedSiteOpenEnvelope {
  schema: typeof BROWSER_CONTAINED_SITE_OPEN_SCHEMA
  success: boolean
  site_id: string
  status: BrowserContainedSiteLifecycleStatus
  resolution?: Record<string, unknown>
  contained_site?: BrowserContainedSiteIdentity
  source_digest?: {
    algorithm: "sha256" | (string & {})
    value: string
  }
  prepared_runtime?: Record<string, unknown>
  blueprint_ref?: Record<string, unknown>
  preview_boot?: BrowserPreviewBootConfig
  preview_lease?: PreviewLease
  preview_session?: BrowserSessionProductDto
  session?: Record<string, unknown>
  recovery?: Record<string, unknown>
}

export function runtimeProfile(input: unknown): RuntimeProfile {
  const value = requireObject(input, "Runtime profile") as Partial<RuntimeProfile>
  if (value.schema !== RUNTIME_PROFILE_SCHEMA) throw new Error(`Runtime profile schema must be ${RUNTIME_PROFILE_SCHEMA}.`)
  return {
    schema: RUNTIME_PROFILE_SCHEMA,
    id: optionalString(value.id, "id"),
    capabilities: normalizeStringList(value.capabilities, "capabilities"),
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
    diagnostics: normalizeDiagnostics(value.diagnostics),
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
    resolution: normalizeOptionalObject(value.resolution, "resolution"),
    prepared_runtime: normalizeOptionalObject(value.prepared_runtime, "prepared_runtime"),
    blueprint_ref: normalizeOptionalObject(value.blueprint_ref, "blueprint_ref"),
    metadata: normalizeOptionalObject(value.metadata, "metadata"),
  }
}

export function browserContainedSiteOpenEnvelope(input: unknown): BrowserContainedSiteOpenEnvelope {
  const value = requireObject(input, "Browser contained site open envelope") as Partial<BrowserContainedSiteOpenEnvelope>
  if (value.schema !== BROWSER_CONTAINED_SITE_OPEN_SCHEMA) throw new Error(`Browser contained site open schema must be ${BROWSER_CONTAINED_SITE_OPEN_SCHEMA}.`)
  return {
    schema: BROWSER_CONTAINED_SITE_OPEN_SCHEMA,
    success: value.success === true,
    site_id: requiredIdentifier(value.site_id, "site_id"),
    status: requiredIdentifier(value.status, "status") as BrowserContainedSiteLifecycleStatus,
    resolution: normalizeOptionalObject(value.resolution, "resolution"),
    contained_site: value.contained_site === undefined ? undefined : normalizeContainedSiteIdentity(value.contained_site),
    source_digest: value.source_digest === undefined ? undefined : normalizeSourceDigest(value.source_digest),
    prepared_runtime: normalizeOptionalObject(value.prepared_runtime, "prepared_runtime"),
    blueprint_ref: normalizeOptionalObject(value.blueprint_ref, "blueprint_ref"),
    preview_boot: value.preview_boot === undefined ? undefined : normalizePreviewBootConfig(value.preview_boot),
    preview_lease: value.preview_lease === undefined ? undefined : previewLease(value.preview_lease),
    preview_session: value.preview_session === undefined ? undefined : normalizeBrowserSessionProductDto(value.preview_session),
    session: normalizeOptionalObject(value.session, "session"),
    recovery: normalizeOptionalObject(value.recovery, "recovery"),
  }
}

function normalizeContainedSiteIdentity(input: unknown): BrowserContainedSiteIdentity {
  const value = requireObject(input, "Browser contained site identity") as Partial<BrowserContainedSiteIdentity>
  if (value.schema !== "wp-codebox/browser-contained-site/v1") throw new Error("Browser contained site identity schema must be wp-codebox/browser-contained-site/v1.")
  return {
    schema: "wp-codebox/browser-contained-site/v1",
    site_id: requiredIdentifier(value.site_id, "contained_site.site_id"),
    preview_id: optionalString(value.preview_id, "contained_site.preview_id"),
    session_id: optionalString(value.session_id, "contained_site.session_id"),
    status: optionalString(value.status, "contained_site.status") as BrowserContainedSiteLifecycleStatus | undefined,
    source_digest: value.source_digest === undefined ? undefined : normalizeSourceDigest(value.source_digest),
    resolution: normalizeOptionalObject(value.resolution, "contained_site.resolution"),
    prepared_runtime: normalizeOptionalObject(value.prepared_runtime, "contained_site.prepared_runtime"),
    blueprint_ref: normalizeOptionalObject(value.blueprint_ref, "contained_site.blueprint_ref"),
    preview_boot: value.preview_boot === undefined ? undefined : normalizePreviewBootConfig(value.preview_boot),
    preview_lease: value.preview_lease === undefined ? undefined : previewLease(value.preview_lease),
    session: normalizeOptionalObject(value.session, "contained_site.session"),
    recovery: normalizeOptionalObject(value.recovery, "contained_site.recovery"),
    metadata: normalizeOptionalObject(value.metadata, "contained_site.metadata"),
  }
}

function normalizeSourceDigest(input: unknown): { algorithm: "sha256" | (string & {}); value: string } {
  const digest = requireObject(input, "source_digest") as { algorithm?: unknown; value?: unknown }
  const digestValue = optionalString(digest.value, "source_digest.value")
  if (!digestValue || !/^[a-f0-9]{64}$/.test(digestValue)) throw new Error("source_digest.value must be a 64-character sha256 digest.")
  return {
    algorithm: optionalString(digest.algorithm, "source_digest.algorithm") ?? "sha256",
    value: digestValue,
  }
}

function normalizePreviewBootConfig(input: unknown): BrowserPreviewBootConfig {
  const value = requireObject(input, "Browser preview boot config") as Partial<BrowserPreviewBootConfig>
  if (value.schema !== BROWSER_PREVIEW_BOOT_CONFIG_SCHEMA) throw new Error(`Browser preview boot config schema must be ${BROWSER_PREVIEW_BOOT_CONFIG_SCHEMA}.`)
  return {
    schema: BROWSER_PREVIEW_BOOT_CONFIG_SCHEMA,
    session_id: optionalString(value.session_id, "preview_boot.session_id"),
    scope: optionalString(value.scope, "preview_boot.scope"),
    client_module_url: optionalString(value.client_module_url, "preview_boot.client_module_url"),
    remote_url: optionalString(value.remote_url, "preview_boot.remote_url"),
    cors_proxy_url: optionalString(value.cors_proxy_url, "preview_boot.cors_proxy_url"),
    blueprint_ref: optionalString(value.blueprint_ref, "preview_boot.blueprint_ref"),
    blueprint_ref_dto: normalizeOptionalObject(value.blueprint_ref_dto, "preview_boot.blueprint_ref_dto"),
    preview: value.preview === undefined ? undefined : previewLease(value.preview),
    contained_site: normalizeOptionalObject(value.contained_site, "preview_boot.contained_site"),
    artifacts: normalizeOptionalObject(value.artifacts, "preview_boot.artifacts"),
    provenance: normalizeOptionalObject(value.provenance, "preview_boot.provenance"),
  }
}

function normalizeBrowserSessionProductDto(input: unknown): BrowserSessionProductDto {
  const value = requireObject(input, "Browser session product DTO") as Partial<BrowserSessionProductDto>
  if (value.schema !== BROWSER_SESSION_PRODUCT_DTO_SCHEMA) throw new Error(`Browser session product DTO schema must be ${BROWSER_SESSION_PRODUCT_DTO_SCHEMA}.`)
  return {
    schema: BROWSER_SESSION_PRODUCT_DTO_SCHEMA,
    source_schema: optionalString(value.source_schema, "preview_session.source_schema"),
    success: value.success === true,
    status: optionalString(value.status, "preview_session.status"),
    execution: optionalString(value.execution, "preview_session.execution"),
    execution_scope: optionalString(value.execution_scope, "preview_session.execution_scope"),
    permission_model: optionalString(value.permission_model, "preview_session.permission_model"),
    session_id: optionalString(value.session_id, "preview_session.session_id"),
    contained_site: normalizeOptionalObject(value.contained_site, "preview_session.contained_site"),
    task: optionalString(value.task, "preview_session.task"),
    target: normalizeOptionalObject(value.target, "preview_session.target"),
    agent: optionalString(value.agent, "preview_session.agent"),
    provider: optionalString(value.provider, "preview_session.provider"),
    model: optionalString(value.model, "preview_session.model"),
    preview_boot: value.preview_boot === undefined ? undefined : normalizePreviewBootConfig(value.preview_boot),
    signals: normalizeOptionalObject(value.signals, "preview_session.signals"),
    artifacts: normalizeOptionalObject(value.artifacts, "preview_session.artifacts"),
    error: normalizeOptionalObject(value.error, "preview_session.error"),
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

function normalizeDiagnostics(input: unknown): RuntimeProfileDiagnostic[] | undefined {
  if (input === undefined) return undefined
  if (!Array.isArray(input)) throw new Error("Runtime profile diagnostics must be an array.")
  return input.map((entry, index) => {
    const value = requireObject(entry, `Runtime profile diagnostics[${index}]`) as Partial<RuntimeProfileDiagnostic>
    return {
      code: requiredIdentifier(value.code, `diagnostics[${index}].code`),
      status: optionalString(value.status, `diagnostics[${index}].status`) as RuntimeProfileReadinessStatus | undefined,
      message: optionalString(value.message, `diagnostics[${index}].message`),
      severity: optionalString(value.severity, `diagnostics[${index}].severity`) as RuntimeProfileDiagnostic["severity"],
      evidence: normalizeOptionalObject(value.evidence, `diagnostics[${index}].evidence`),
    }
  })
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
