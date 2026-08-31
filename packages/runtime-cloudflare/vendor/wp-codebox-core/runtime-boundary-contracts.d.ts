export declare const RUNTIME_PROFILE_SCHEMA: "wp-codebox/runtime-profile/v1";
export declare const PREVIEW_LEASE_SCHEMA: "wp-codebox/preview-lease/v1";
export declare const PREVIEW_REVIEWER_ACCESS_SCHEMA: "wp-codebox/preview-reviewer-access/v1";
export declare const RUNTIME_ACCESS_SCHEMA: "wp-codebox/runtime-access/v1";
export declare const BROWSER_CONTAINED_SITE_STATUS_SCHEMA: "wp-codebox/browser-contained-site-status/v1";
export declare const BROWSER_CONTAINED_SITE_OPEN_SCHEMA: "wp-codebox/browser-contained-site-open/v1";
export declare const BROWSER_SESSION_PRODUCT_DTO_SCHEMA: "wp-codebox/browser-session-product-dto/v1";
export declare const BROWSER_PREVIEW_BOOT_CONFIG_SCHEMA: "wp-codebox/browser-preview-boot-config/v1";
export type RuntimeProfileDependencyKind = "component" | "plugin" | "mu_plugin" | "theme" | "bootstrap" | "overlay" | (string & {});
export type RuntimeProfileReadinessStatus = "ready" | "pending" | "blocked" | "missing" | "unknown" | (string & {});
export interface RuntimeProfileDependency {
    kind: RuntimeProfileDependencyKind;
    slug: string;
    name?: string;
    source?: string;
    target?: string;
    version?: string;
    activate?: boolean;
    required?: boolean;
    readiness?: RuntimeProfileReadinessStatus;
    provenance?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
}
export interface RuntimeProfileBootstrap {
    mode?: string;
    entrypoint?: string;
    blueprint_ref?: string;
    steps?: string[];
    provenance?: Record<string, unknown>;
}
export interface RuntimeProfileReadiness {
    status: RuntimeProfileReadinessStatus;
    checks?: Record<string, boolean>;
    missing?: string[];
    evidence?: Record<string, unknown>;
}
export interface RuntimeProfileDiagnostic {
    code: string;
    status?: RuntimeProfileReadinessStatus;
    message?: string;
    severity?: "info" | "warning" | "error" | (string & {});
    evidence?: Record<string, unknown>;
}
export interface RuntimeProfile {
    schema: typeof RUNTIME_PROFILE_SCHEMA;
    id?: string;
    capabilities?: string[];
    component_contracts?: Record<string, unknown>[];
    extra_plugins?: Record<string, unknown>[];
    provider_plugins?: Record<string, unknown>[];
    components: RuntimeProfileDependency[];
    plugins?: RuntimeProfileDependency[];
    mu_plugins?: RuntimeProfileDependency[];
    themes?: RuntimeProfileDependency[];
    bootstrap?: RuntimeProfileBootstrap;
    overlays?: RuntimeProfileDependency[];
    runtime_overlays?: Record<string, unknown>[];
    runtime_state_mounts?: Record<string, unknown>[];
    runtime_config_mounts?: Record<string, unknown>[];
    env?: Record<string, string>;
    readiness?: RuntimeProfileReadiness;
    diagnostics?: RuntimeProfileDiagnostic[];
    provenance?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
}
export interface PreviewLeaseMetadata {
    id?: string;
    status?: "active" | "expired" | "released" | "unknown" | (string & {});
    acquired_at?: string;
    expires_at?: string;
    owner?: string;
    owner_id?: string;
    provider?: string;
    provenance?: Record<string, unknown>;
}
export interface PreviewAlignmentEvidence {
    status: "aligned" | "misaligned" | "unknown" | (string & {});
    checked_at?: string;
    preview_matches_site?: boolean;
    preview_matches_local?: boolean;
    evidence?: Record<string, unknown>;
}
export interface PreviewReachabilityEvidence {
    status: "reachable" | "unreachable" | "unknown" | (string & {});
    checked_at?: string;
    http_status?: number;
    probes?: Record<string, unknown>[];
    evidence_refs?: Record<string, unknown>[];
    metadata?: Record<string, unknown>;
}
export interface PreviewLease {
    schema: typeof PREVIEW_LEASE_SCHEMA;
    public_url?: string;
    preview_public_url?: string;
    site_url?: string;
    local_url?: string;
    lease?: PreviewLeaseMetadata;
    reachability?: PreviewReachabilityEvidence;
    alignment?: PreviewAlignmentEvidence;
    evidence_refs?: Record<string, unknown>[];
    provenance?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
}
export interface RuntimeAccess {
    schema: typeof RUNTIME_ACCESS_SCHEMA;
    preview_url?: string;
    public_url?: string;
    site_url?: string;
    local_url?: string;
    admin_url?: string;
    lease?: PreviewLease;
    reviewer_access?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
}
export type PreviewLeaseLifecycleStatus = "active" | "expired" | "released" | "unknown";
export type BrowserContainedSiteLifecycleStatus = "recoverable_prepared_runtime" | "current" | "live" | "materialized" | "miss" | "expired" | "blocked" | "disabled" | "incompatible" | "unknown" | (string & {});
export interface BrowserContainedSiteIdentity {
    schema: "wp-codebox/browser-contained-site/v1";
    site_id: string;
    preview_id?: string;
    session_id?: string;
    status?: BrowserContainedSiteLifecycleStatus;
    source_digest?: {
        algorithm: "sha256" | (string & {});
        value: string;
    };
    resolution?: Record<string, unknown>;
    prepared_runtime?: Record<string, unknown>;
    blueprint_ref?: Record<string, unknown>;
    preview_boot?: BrowserPreviewBootConfig;
    preview_lease?: PreviewLease;
    runtime_access?: RuntimeAccess;
    session?: Record<string, unknown>;
    recovery?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
}
export interface BrowserContainedSiteStatus {
    schema: typeof BROWSER_CONTAINED_SITE_STATUS_SCHEMA;
    success: boolean;
    site_id: string;
    status: BrowserContainedSiteLifecycleStatus;
    source_digest: {
        algorithm: "sha256" | (string & {});
        value: string;
    };
    resolution?: Record<string, unknown>;
    prepared_runtime?: Record<string, unknown>;
    blueprint_ref?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
}
export interface BrowserPreviewBootConfig {
    schema: typeof BROWSER_PREVIEW_BOOT_CONFIG_SCHEMA;
    session_id?: string;
    scope?: string;
    client_module_url?: string;
    remote_url?: string;
    cors_proxy_url?: string;
    blueprint_ref: BrowserBlueprintRef;
    preview?: PreviewLease;
    runtime_access?: RuntimeAccess;
    contained_site?: Record<string, unknown>;
    artifacts?: Record<string, unknown>;
    provenance?: Record<string, unknown>;
}
/** The sole executable blueprint handoff in the public preview boot DTO. */
export interface BrowserBlueprintRef {
    schema: "wp-codebox/browser-blueprint-ref/v1";
    ref: string;
    hydratable: true;
    hydrator_ability: string;
    hydration_endpoint: string;
}
export interface BrowserSessionProductDto {
    schema: typeof BROWSER_SESSION_PRODUCT_DTO_SCHEMA;
    source_schema?: string;
    success: boolean;
    status?: string;
    execution?: string;
    execution_scope?: string;
    permission_model?: string;
    session_id?: string;
    contained_site?: Record<string, unknown>;
    task?: string;
    target?: Record<string, unknown>;
    agent?: string;
    provider?: string;
    model?: string;
    preview_boot?: BrowserPreviewBootConfig;
    runtime_access?: RuntimeAccess;
    signals?: Record<string, unknown>;
    artifacts?: Record<string, unknown>;
    error?: Record<string, unknown>;
}
export interface BrowserContainedSiteOpenEnvelope {
    schema: typeof BROWSER_CONTAINED_SITE_OPEN_SCHEMA;
    success: boolean;
    site_id: string;
    status: BrowserContainedSiteLifecycleStatus;
    resolution?: Record<string, unknown>;
    contained_site?: BrowserContainedSiteIdentity;
    source_digest?: {
        algorithm: "sha256" | (string & {});
        value: string;
    };
    prepared_runtime?: Record<string, unknown>;
    blueprint_ref?: Record<string, unknown>;
    preview_boot?: BrowserPreviewBootConfig;
    preview_lease?: PreviewLease;
    runtime_access?: RuntimeAccess;
    preview_session?: BrowserSessionProductDto;
    session?: Record<string, unknown>;
    recovery?: Record<string, unknown>;
}
export declare function runtimeProfile(input: unknown): RuntimeProfile;
export declare function normalizeRuntimeProfile(input: unknown): RuntimeProfile;
export declare function previewLease(input: unknown): PreviewLease;
export declare function runtimeAccess(input: unknown): RuntimeAccess;
export declare function normalizeRuntimeAccess(input: unknown): RuntimeAccess;
export declare function previewLeaseStatus(input: PreviewLease | unknown, now?: Date): PreviewLeaseLifecycleStatus;
export declare function isPreviewLease(input: unknown): input is PreviewLease;
export declare function previewReviewerAccess(preview: {
    status?: unknown;
    lifecycle?: unknown;
    publicUrl?: unknown;
    localUrl?: unknown;
    siteUrl?: unknown;
    url?: unknown;
    expiresAt?: unknown;
    lease?: unknown;
    reviewerAuthBootstrap?: unknown;
    blockers?: unknown;
} | undefined): import("./runtime-contracts.js").ArtifactPreviewReviewerAccess;
export declare const normalizePreviewReviewerAccess: typeof previewReviewerAccess;
export declare function previewLeaseSummary(lease: PreviewLease | undefined): import("./runtime-contracts.js").ArtifactPreviewLeaseSummary | undefined;
export declare function browserContainedSiteStatus(input: unknown): BrowserContainedSiteStatus;
export declare function browserContainedSiteOpenEnvelope(input: unknown): BrowserContainedSiteOpenEnvelope;
export declare function browserPreviewBootConfig(input: unknown): BrowserPreviewBootConfig;
export declare function normalizePreviewBootConfig(input: unknown): BrowserPreviewBootConfig;
//# sourceMappingURL=runtime-boundary-contracts.d.ts.map