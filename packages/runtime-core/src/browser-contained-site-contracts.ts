export const BROWSER_CONTAINED_SITE_SCHEMA = "wp-codebox/browser-contained-site/v1" as const
export const BROWSER_CONTAINED_SITE_SESSION_SCHEMA = "wp-codebox/browser-contained-site-session/v1" as const
export const BROWSER_CONTAINED_SITE_BOOT_SCHEMA = "wp-codebox/browser-contained-site-boot/v1" as const
export const BROWSER_CONTAINED_SITE_DESTROY_SCHEMA = "wp-codebox/browser-contained-site-destroy/v1" as const
export const BROWSER_CONTAINED_SITE_SNAPSHOT_SCHEMA = "wp-codebox/browser-contained-site-snapshot/v1" as const
export const BROWSER_CONTAINED_SITE_EXPORT_SCHEMA = "wp-codebox/browser-contained-site-export/v1" as const
export const BROWSER_CONTAINED_SITE_APPLY_PLAN_SCHEMA = "wp-codebox/browser-contained-site-apply-plan/v1" as const
export const BROWSER_CONTAINED_SITE_APPLY_RESULT_SCHEMA = "wp-codebox/browser-contained-site-apply-result/v1" as const
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
  public_url?: string
  preview_public_url?: string
  site_url?: string
  local_url?: string
  lease?: {
    status?: "active" | "released" | "expired" | "unknown" | string
    expires_at?: string
    owner?: string
    owner_id?: string
  }
  reachability?: Record<string, unknown>
  alignment?: Record<string, unknown>
  evidence_refs?: Record<string, unknown>[]
  provenance?: Record<string, unknown>
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

export interface BrowserContainedSiteValidationError {
  code: "wp_codebox_browser_contained_site_ref_invalid" | "wp_codebox_browser_contained_site_stale_digest" | "wp_codebox_browser_contained_site_scope_mismatch" | "wp_codebox_browser_contained_site_session_mismatch" | string
  message: string
  expected?: Record<string, unknown>
  actual?: Record<string, unknown>
}

export interface BrowserContainedSiteSnapshotContract {
  success: boolean
  schema: typeof BROWSER_CONTAINED_SITE_SNAPSHOT_SCHEMA
  contained_site?: BrowserContainedSite
  source_digest?: BrowserDigestRef
  session?: Record<string, unknown>
  snapshot?: Record<string, unknown>
  status?: Record<string, unknown>
  error?: BrowserContainedSiteValidationError
}

export interface BrowserContainedSiteExportContract {
  success: boolean
  schema: typeof BROWSER_CONTAINED_SITE_EXPORT_SCHEMA
  contained_site?: BrowserContainedSite
  source_digest?: BrowserDigestRef
  export?: Record<string, unknown>
  snapshot?: BrowserContainedSiteSnapshotContract
  error?: BrowserContainedSiteValidationError
}

export interface BrowserContainedSiteApplyPlanContract {
  success: boolean
  schema: typeof BROWSER_CONTAINED_SITE_APPLY_PLAN_SCHEMA
  mode: "preview" | "apply" | string
  host_mutation: boolean
  contained_site?: BrowserContainedSite
  source_digest?: BrowserDigestRef
  plan?: Record<string, unknown>
  error?: BrowserContainedSiteValidationError
}

export interface BrowserContainedSiteApplyResultContract {
  success: boolean
  schema: typeof BROWSER_CONTAINED_SITE_APPLY_RESULT_SCHEMA
  mode: "preview" | "apply" | string
  host_mutation: boolean
  contained_site?: BrowserContainedSite
  source_digest?: BrowserDigestRef
  result?: Record<string, unknown>
  error?: BrowserContainedSiteValidationError
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
