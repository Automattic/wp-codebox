export const BROWSER_CONTAINED_SITE_SCHEMA = "wp-codebox/browser-contained-site/v1" as const
export const BROWSER_CONTAINED_SITE_SESSION_SCHEMA = "wp-codebox/browser-contained-site-session/v1" as const
export const BROWSER_CONTAINED_SITE_BOOT_SCHEMA = "wp-codebox/browser-contained-site-boot/v1" as const
export const BROWSER_CONTAINED_SITE_DESTROY_SCHEMA = "wp-codebox/browser-contained-site-destroy/v1" as const
export const BROWSER_CONTAINED_SITE_PREVIEW_LEASE_SCHEMA = "wp-codebox/preview-lease/v1" as const
export const STARTUP_DIAGNOSTICS_SCHEMA = "wp-codebox/browser-contained-site-startup-diagnostics/v1" as const

export type BrowserContainedSiteFacadeStatus = "ready" | "recoverable_prepared_runtime" | "current" | "live" | "materialized" | "miss" | "blocked" | "disabled" | "incompatible" | "unusable" | "destroyed"

export interface BrowserDigestRef {
  algorithm: "sha256" | string
  value: string
}

export interface BrowserContainedSite {
  schema: typeof BROWSER_CONTAINED_SITE_SCHEMA
  site_id: string
  preview_id?: string
  session_id?: string
  status: BrowserContainedSiteFacadeStatus
  source_digest?: BrowserDigestRef
  open_mode?: "reuse_current" | "reuse_live" | "reuse_materialized" | "reuse_prepared_runtime" | "materialize" | "unavailable"
  reuse_level?: "current" | "live" | "materialized" | "prepared_runtime" | "none"
  recovery?: {
    ability: string
    input: Record<string, unknown>
  }
  recovery_handle?: string
}

export interface BrowserPreviewLease {
  schema: typeof BROWSER_CONTAINED_SITE_PREVIEW_LEASE_SCHEMA
  preview_public_url?: string
  site_url?: string
  local_url?: string
  lease?: {
    status?: "active" | "released" | "expired" | "unknown" | string
    expires_at?: string
  }
  alignment?: Record<string, unknown>
}

export interface BrowserContainedSiteBootDescriptor {
  schema: typeof BROWSER_CONTAINED_SITE_BOOT_SCHEMA
  session_id?: string
  site_id?: string
  status?: BrowserContainedSiteFacadeStatus
  preview?: BrowserPreviewLease
  contained_site?: BrowserContainedSite
  blueprint_ref?: {
    schema?: "wp-codebox/browser-blueprint-ref/v1" | string
    ref?: string
    hydration_endpoint?: string
    hydrator_ability?: string
  }
  debug?: Record<string, unknown>
}

export interface BrowserContainedSiteStartupDiagnostics {
  schema: typeof STARTUP_DIAGNOSTICS_SCHEMA
  status: BrowserContainedSiteFacadeStatus | "unknown"
  open_mode?: BrowserContainedSite["open_mode"]
  reuse_level?: BrowserContainedSite["reuse_level"]
  preview_lease_status?: string
  boot_contract?: {
    valid: boolean
    reason: string
  }
  recovery_handle?: string
}

export interface BrowserContainedSiteSession {
  success: boolean
  schema: typeof BROWSER_CONTAINED_SITE_SESSION_SCHEMA
  action: "created" | "opened" | "blocked" | "unavailable"
  contained_site?: BrowserContainedSite
  boot?: BrowserContainedSiteBootDescriptor
  preview_lease?: BrowserPreviewLease
  startup_diagnostics?: BrowserContainedSiteStartupDiagnostics
  session?: Record<string, unknown>
  debug?: Record<string, unknown>
}

export interface DestroyBrowserContainedSiteSessionResult {
  success: boolean
  schema: typeof BROWSER_CONTAINED_SITE_DESTROY_SCHEMA
  action: "released" | "noop"
  contained_site?: BrowserContainedSite
  preview_lease?: BrowserPreviewLease
  startup_diagnostics?: BrowserContainedSiteStartupDiagnostics
}

export function browserContainedSiteRecoveryInput(site: BrowserContainedSite): Record<string, unknown> {
  if (site.recovery && typeof site.recovery.input === "object" && site.recovery.input !== null) {
    return site.recovery.input
  }

  return stripUndefined({
    site_id: site.site_id,
    source_digest: site.source_digest?.value,
  })
}

export function browserContainedSiteCanBoot(boot: BrowserContainedSiteBootDescriptor): boolean {
  const ref = boot.blueprint_ref?.ref?.trim()
  const endpoint = boot.blueprint_ref?.hydration_endpoint?.trim()
  return Boolean(boot.preview && boot.contained_site && ref && endpoint)
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== "")) as T
}
