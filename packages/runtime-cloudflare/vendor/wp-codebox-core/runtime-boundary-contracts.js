import { stripUndefined } from "./object-utils.js";
export const RUNTIME_PROFILE_SCHEMA = "wp-codebox/runtime-profile/v1";
export const PREVIEW_LEASE_SCHEMA = "wp-codebox/preview-lease/v1";
export const PREVIEW_REVIEWER_ACCESS_SCHEMA = "wp-codebox/preview-reviewer-access/v1";
export const RUNTIME_ACCESS_SCHEMA = "wp-codebox/runtime-access/v1";
export const BROWSER_CONTAINED_SITE_STATUS_SCHEMA = "wp-codebox/browser-contained-site-status/v1";
export const BROWSER_CONTAINED_SITE_OPEN_SCHEMA = "wp-codebox/browser-contained-site-open/v1";
export const BROWSER_SESSION_PRODUCT_DTO_SCHEMA = "wp-codebox/browser-session-product-dto/v1";
export const BROWSER_PREVIEW_BOOT_CONFIG_SCHEMA = "wp-codebox/browser-preview-boot-config/v1";
export function runtimeProfile(input) {
    const value = requireObject(input, "Runtime profile");
    if (value.schema !== RUNTIME_PROFILE_SCHEMA)
        throw new Error(`Runtime profile schema must be ${RUNTIME_PROFILE_SCHEMA}.`);
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
    };
}
export function normalizeRuntimeProfile(input) {
    return runtimeProfile(input);
}
export function previewLease(input) {
    const value = requireObject(input, "Preview lease");
    const publicUrl = optionalString(value.public_url ?? value.publicUrl, "public_url") ?? optionalString(value.preview_public_url ?? value.previewPublicUrl, "preview_public_url");
    if (value.schema !== PREVIEW_LEASE_SCHEMA)
        throw new Error(`Preview lease schema must be ${PREVIEW_LEASE_SCHEMA}.`);
    const lease = {
        schema: PREVIEW_LEASE_SCHEMA,
        public_url: publicUrl,
        preview_public_url: publicUrl,
        site_url: optionalString(value.site_url ?? value.siteUrl, "site_url"),
        local_url: optionalString(value.local_url ?? value.localUrl, "local_url"),
        lease: value.lease === undefined ? undefined : normalizeOptionalObject(value.lease, "Preview lease metadata"),
        reachability: value.reachability === undefined ? undefined : normalizeReachability(value.reachability),
        alignment: value.alignment === undefined ? undefined : normalizeAlignment(value.alignment),
        evidence_refs: normalizeObjectList(value.evidence_refs, "Preview lease evidence_refs"),
        provenance: normalizeOptionalObject(value.provenance, "Preview lease provenance"),
        metadata: normalizeOptionalObject(value.metadata, "Preview lease metadata"),
    };
    if (!lease.public_url && !lease.site_url && !lease.local_url) {
        throw new Error("Preview lease must include public_url, preview_public_url, site_url, or local_url.");
    }
    return lease;
}
export function runtimeAccess(input) {
    const value = requireObject(input, "Runtime access");
    const schema = optionalString(value.schema, "runtime_access.schema");
    if (schema && schema !== RUNTIME_ACCESS_SCHEMA)
        throw new Error(`Runtime access schema must be ${RUNTIME_ACCESS_SCHEMA}.`);
    const lease = value.lease === undefined ? undefined : previewLease(value.lease);
    const reviewerAccess = normalizeOptionalObject(value.reviewer_access ?? value.reviewerAccess, "runtime_access.reviewer_access");
    const previewUrl = optionalString(value.preview_url ?? value.previewUrl, "runtime_access.preview_url")
        ?? optionalString(value.public_url ?? value.publicUrl, "runtime_access.public_url")
        ?? optionalString(value.preview_public_url ?? value.previewPublicUrl, "runtime_access.preview_public_url")
        ?? optionalString(value.site_url ?? value.siteUrl, "runtime_access.site_url")
        ?? optionalString(reviewerAccess?.openUrl, "runtime_access.reviewer_access.openUrl")
        ?? optionalString(reviewerAccess?.targetUrl, "runtime_access.reviewer_access.targetUrl")
        ?? lease?.public_url
        ?? lease?.preview_public_url
        ?? lease?.site_url
        ?? optionalString(value.local_url ?? value.localUrl, "runtime_access.local_url")
        ?? lease?.local_url;
    const publicUrl = optionalString(value.public_url ?? value.publicUrl, "runtime_access.public_url")
        ?? optionalString(value.preview_public_url ?? value.previewPublicUrl, "runtime_access.preview_public_url")
        ?? lease?.public_url
        ?? lease?.preview_public_url;
    const siteUrl = optionalString(value.site_url ?? value.siteUrl, "runtime_access.site_url") ?? lease?.site_url;
    const localUrl = optionalString(value.local_url ?? value.localUrl, "runtime_access.local_url") ?? lease?.local_url;
    const access = {
        schema: RUNTIME_ACCESS_SCHEMA,
        preview_url: previewUrl,
        public_url: publicUrl,
        site_url: siteUrl,
        local_url: localUrl,
        admin_url: optionalString(value.admin_url ?? value.adminUrl, "runtime_access.admin_url"),
        lease,
        reviewer_access: reviewerAccess,
        metadata: normalizeOptionalObject(value.metadata, "runtime_access.metadata"),
    };
    if (!access.preview_url && !access.public_url && !access.site_url && !access.local_url && !access.admin_url && !access.lease && !access.reviewer_access) {
        throw new Error("Runtime access must include preview_url, public_url, site_url, local_url, admin_url, lease, or reviewer_access.");
    }
    return stripUndefined(access);
}
export function normalizeRuntimeAccess(input) {
    return runtimeAccess(input);
}
export function previewLeaseStatus(input, now = new Date()) {
    const lease = isPreviewLease(input) ? input : previewLease(input);
    const declaredStatus = typeof lease.lease?.status === "string" ? lease.lease.status : "";
    if (declaredStatus === "released")
        return "released";
    const expiresAt = lease.lease?.expires_at;
    if (typeof expiresAt === "string" && expiresAt.trim() !== "") {
        const expires = Date.parse(expiresAt);
        if (!Number.isNaN(expires) && expires <= now.getTime())
            return "expired";
    }
    if (declaredStatus === "active" || lease.public_url || lease.preview_public_url || lease.site_url || lease.local_url)
        return "active";
    if (declaredStatus === "expired")
        return "expired";
    return "unknown";
}
export function isPreviewLease(input) {
    return Boolean(input && typeof input === "object" && !Array.isArray(input) && input.schema === PREVIEW_LEASE_SCHEMA);
}
export function previewReviewerAccess(preview) {
    const lease = normalizedPreviewAccessLease(preview?.lease);
    const leaseSummary = previewLeaseSummary(lease);
    const expiresAt = optionalString(preview?.expiresAt, "expiresAt") ?? leaseSummary?.expiresAt;
    if (!preview || preview.status !== "available" || preview.lifecycle !== "held-after-run") {
        return {
            schema: PREVIEW_REVIEWER_ACCESS_SCHEMA,
            status: "unavailable",
            outcome: "blocked",
            mode: "none",
            reviewerSafe: false,
            ...(leaseSummary ? { lease: { ...leaseSummary, reviewerSafe: false } } : {}),
            reason: "preview-not-held",
        };
    }
    const reviewerAuthBootstrap = normalizeReviewerAuthBootstrap(preview.reviewerAuthBootstrap);
    if (reviewerAuthBootstrap) {
        return {
            schema: PREVIEW_REVIEWER_ACCESS_SCHEMA,
            status: "ready",
            outcome: "bootstrap",
            mode: "auth-bootstrap",
            reviewerSafe: true,
            openUrl: reviewerAuthBootstrap.bootstrapUrl,
            targetUrl: reviewerAuthBootstrap.redirectUrl,
            expiresAt: reviewerAuthBootstrap.expiresAt,
            ...(leaseSummary ? { lease: { ...leaseSummary, reviewerSafe: true } } : {}),
            bootstrap: reviewerAuthBootstrap,
        };
    }
    const blockers = normalizePreviewBlockers(preview.blockers);
    if (blockers.length > 0) {
        return {
            schema: PREVIEW_REVIEWER_ACCESS_SCHEMA,
            status: "blocked",
            outcome: blockers.some((blocker) => blocker.code === "external-wordpress-admin-auth-unavailable") ? "auth-required" : "blocked",
            mode: "none",
            reviewerSafe: false,
            blockers,
            ...(expiresAt ? { expiresAt } : {}),
            ...(leaseSummary ? { lease: { ...leaseSummary, reviewerSafe: false } } : {}),
            reason: blockers[0]?.code,
        };
    }
    const safeUrl = safeNonLocalPreviewUrl(optionalString(preview.publicUrl, "publicUrl")) ?? safeNonLocalPreviewUrl(lease?.public_url) ?? safeNonLocalPreviewUrl(lease?.preview_public_url) ?? safeNonLocalPreviewUrl(optionalString(preview.url, "url"));
    if (safeUrl) {
        return {
            schema: PREVIEW_REVIEWER_ACCESS_SCHEMA,
            status: "ready",
            outcome: "public",
            mode: "direct-url",
            reviewerSafe: true,
            openUrl: safeUrl,
            targetUrl: safeUrl,
            ...(expiresAt ? { expiresAt } : {}),
            ...(leaseSummary ? { lease: { ...leaseSummary, reviewerSafe: true } } : {}),
        };
    }
    return {
        schema: PREVIEW_REVIEWER_ACCESS_SCHEMA,
        status: "blocked",
        outcome: "local",
        mode: "none",
        reviewerSafe: false,
        ...(expiresAt ? { expiresAt } : {}),
        ...(leaseSummary ? { lease: { ...leaseSummary, reviewerSafe: false } } : {}),
        reason: "local-preview-requires-auth-bootstrap-or-public-url",
    };
}
export const normalizePreviewReviewerAccess = previewReviewerAccess;
function normalizedPreviewAccessLease(input) {
    if (input === undefined) {
        return undefined;
    }
    return previewLease(input);
}
export function previewLeaseSummary(lease) {
    if (!lease) {
        return undefined;
    }
    return {
        schema: "wp-codebox/preview-lease-summary/v1",
        status: previewLeaseStatus(lease),
        ...(lease.public_url ? { publicUrl: lease.public_url } : {}),
        ...(lease.local_url ? { localUrl: lease.local_url } : {}),
        ...(lease.site_url ? { siteUrl: lease.site_url } : {}),
        ...(lease.lease?.expires_at ? { expiresAt: lease.lease.expires_at } : {}),
        ...(lease.lease?.owner ? { owner: lease.lease.owner } : {}),
        ...(lease.lease?.provider ? { provider: lease.lease.provider } : {}),
        ...(lease.alignment?.status ? { alignmentStatus: lease.alignment.status } : {}),
        ...(lease.reachability?.status ? { reachabilityStatus: lease.reachability.status } : {}),
        reviewerSafe: Boolean(safeNonLocalPreviewUrl(lease.public_url) || safeNonLocalPreviewUrl(lease.preview_public_url)),
    };
}
export function browserContainedSiteStatus(input) {
    const value = requireObject(input, "Browser contained site status");
    if (value.schema !== BROWSER_CONTAINED_SITE_STATUS_SCHEMA)
        throw new Error(`Browser contained site status schema must be ${BROWSER_CONTAINED_SITE_STATUS_SCHEMA}.`);
    const digest = requireObject(value.source_digest, "Browser contained site status source_digest");
    const digestValue = optionalString(digest.value, "source_digest.value");
    if (!digestValue || !/^[a-f0-9]{64}$/.test(digestValue))
        throw new Error("source_digest.value must be a 64-character sha256 digest.");
    return {
        schema: BROWSER_CONTAINED_SITE_STATUS_SCHEMA,
        success: value.success === true,
        site_id: requiredIdentifier(value.site_id, "site_id"),
        status: requiredIdentifier(value.status, "status"),
        source_digest: {
            algorithm: optionalString(digest.algorithm, "source_digest.algorithm") ?? "sha256",
            value: digestValue,
        },
        resolution: normalizeOptionalObject(value.resolution, "resolution"),
        prepared_runtime: normalizeOptionalObject(value.prepared_runtime, "prepared_runtime"),
        blueprint_ref: normalizeOptionalObject(value.blueprint_ref, "blueprint_ref"),
        metadata: normalizeOptionalObject(value.metadata, "metadata"),
    };
}
export function browserContainedSiteOpenEnvelope(input) {
    const value = requireObject(input, "Browser contained site open envelope");
    if (value.schema !== BROWSER_CONTAINED_SITE_OPEN_SCHEMA)
        throw new Error(`Browser contained site open schema must be ${BROWSER_CONTAINED_SITE_OPEN_SCHEMA}.`);
    return {
        schema: BROWSER_CONTAINED_SITE_OPEN_SCHEMA,
        success: value.success === true,
        site_id: requiredIdentifier(value.site_id, "site_id"),
        status: requiredIdentifier(value.status, "status"),
        resolution: normalizeOptionalObject(value.resolution, "resolution"),
        contained_site: value.contained_site === undefined ? undefined : normalizeContainedSiteIdentity(value.contained_site),
        source_digest: value.source_digest === undefined ? undefined : normalizeSourceDigest(value.source_digest),
        prepared_runtime: normalizeOptionalObject(value.prepared_runtime, "prepared_runtime"),
        blueprint_ref: normalizeOptionalObject(value.blueprint_ref, "blueprint_ref"),
        preview_boot: value.preview_boot === undefined ? undefined : normalizePreviewBootConfig(value.preview_boot),
        preview_lease: value.preview_lease === undefined ? undefined : previewLease(value.preview_lease),
        runtime_access: value.runtime_access === undefined ? undefined : runtimeAccess(value.runtime_access),
        preview_session: value.preview_session === undefined ? undefined : normalizeBrowserSessionProductDto(value.preview_session),
        session: normalizeOptionalObject(value.session, "session"),
        recovery: normalizeOptionalObject(value.recovery, "recovery"),
    };
}
function normalizeContainedSiteIdentity(input) {
    const value = requireObject(input, "Browser contained site identity");
    if (value.schema !== "wp-codebox/browser-contained-site/v1")
        throw new Error("Browser contained site identity schema must be wp-codebox/browser-contained-site/v1.");
    return {
        schema: "wp-codebox/browser-contained-site/v1",
        site_id: requiredIdentifier(value.site_id, "contained_site.site_id"),
        preview_id: optionalString(value.preview_id, "contained_site.preview_id"),
        session_id: optionalString(value.session_id, "contained_site.session_id"),
        status: optionalString(value.status, "contained_site.status"),
        source_digest: value.source_digest === undefined ? undefined : normalizeSourceDigest(value.source_digest),
        resolution: normalizeOptionalObject(value.resolution, "contained_site.resolution"),
        prepared_runtime: normalizeOptionalObject(value.prepared_runtime, "contained_site.prepared_runtime"),
        blueprint_ref: normalizeOptionalObject(value.blueprint_ref, "contained_site.blueprint_ref"),
        preview_boot: value.preview_boot === undefined ? undefined : normalizePreviewBootConfig(value.preview_boot),
        preview_lease: value.preview_lease === undefined ? undefined : previewLease(value.preview_lease),
        runtime_access: value.runtime_access === undefined ? undefined : runtimeAccess(value.runtime_access),
        session: normalizeOptionalObject(value.session, "contained_site.session"),
        recovery: normalizeOptionalObject(value.recovery, "contained_site.recovery"),
        metadata: normalizeOptionalObject(value.metadata, "contained_site.metadata"),
    };
}
function normalizeSourceDigest(input) {
    const digest = requireObject(input, "source_digest");
    const digestValue = optionalString(digest.value, "source_digest.value");
    if (!digestValue || !/^[a-f0-9]{64}$/.test(digestValue))
        throw new Error("source_digest.value must be a 64-character sha256 digest.");
    return {
        algorithm: optionalString(digest.algorithm, "source_digest.algorithm") ?? "sha256",
        value: digestValue,
    };
}
export function browserPreviewBootConfig(input) {
    const value = requireObject(input, "Browser preview boot config");
    if (value.schema !== BROWSER_PREVIEW_BOOT_CONFIG_SCHEMA)
        throw new Error(`Browser preview boot config schema must be ${BROWSER_PREVIEW_BOOT_CONFIG_SCHEMA}.`);
    const blueprintRef = requireObject(value.blueprint_ref, "preview_boot.blueprint_ref");
    if (blueprintRef.schema !== "wp-codebox/browser-blueprint-ref/v1")
        throw new Error("preview_boot.blueprint_ref schema must be wp-codebox/browser-blueprint-ref/v1.");
    if (!requiredIdentifier(blueprintRef.ref, "preview_boot.blueprint_ref.ref"))
        throw new Error("preview_boot.blueprint_ref.ref is required.");
    if (blueprintRef.hydratable !== true)
        throw new Error("preview_boot.blueprint_ref must be hydratable.");
    if (!requiredIdentifier(blueprintRef.hydrator_ability, "preview_boot.blueprint_ref.hydrator_ability"))
        throw new Error("preview_boot.blueprint_ref.hydrator_ability is required.");
    if (!requiredIdentifier(blueprintRef.hydration_endpoint, "preview_boot.blueprint_ref.hydration_endpoint"))
        throw new Error("preview_boot.blueprint_ref.hydration_endpoint is required.");
    return {
        schema: BROWSER_PREVIEW_BOOT_CONFIG_SCHEMA,
        session_id: optionalString(value.session_id, "preview_boot.session_id"),
        scope: optionalString(value.scope, "preview_boot.scope"),
        client_module_url: optionalString(value.client_module_url, "preview_boot.client_module_url"),
        remote_url: optionalString(value.remote_url, "preview_boot.remote_url"),
        cors_proxy_url: optionalString(value.cors_proxy_url, "preview_boot.cors_proxy_url"),
        blueprint_ref: {
            schema: "wp-codebox/browser-blueprint-ref/v1",
            ref: requiredIdentifier(blueprintRef.ref, "preview_boot.blueprint_ref.ref"),
            hydratable: true,
            hydrator_ability: requiredIdentifier(blueprintRef.hydrator_ability, "preview_boot.blueprint_ref.hydrator_ability"),
            hydration_endpoint: requiredIdentifier(blueprintRef.hydration_endpoint, "preview_boot.blueprint_ref.hydration_endpoint"),
        },
        preview: value.preview === undefined ? undefined : previewLease(value.preview),
        runtime_access: value.runtime_access === undefined ? undefined : runtimeAccess(value.runtime_access),
        contained_site: normalizeOptionalObject(value.contained_site, "preview_boot.contained_site"),
        artifacts: normalizeOptionalObject(value.artifacts, "preview_boot.artifacts"),
        provenance: normalizeOptionalObject(value.provenance, "preview_boot.provenance"),
    };
}
export function normalizePreviewBootConfig(input) {
    return browserPreviewBootConfig(input);
}
function normalizeReachability(input) {
    const value = requireObject(input, "Preview reachability");
    return {
        status: (optionalString(value.status, "reachability.status") ?? "unknown"),
        checked_at: optionalString(value.checked_at, "reachability.checked_at"),
        http_status: typeof value.http_status === "number" ? value.http_status : undefined,
        probes: normalizeObjectList(value.probes, "reachability.probes"),
        evidence_refs: normalizeObjectList(value.evidence_refs, "reachability.evidence_refs"),
        metadata: normalizeOptionalObject(value.metadata, "reachability.metadata"),
    };
}
function normalizeBrowserSessionProductDto(input) {
    const value = requireObject(input, "Browser session product DTO");
    if (value.schema !== BROWSER_SESSION_PRODUCT_DTO_SCHEMA)
        throw new Error(`Browser session product DTO schema must be ${BROWSER_SESSION_PRODUCT_DTO_SCHEMA}.`);
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
        runtime_access: value.runtime_access === undefined ? undefined : runtimeAccess(value.runtime_access),
        signals: normalizeOptionalObject(value.signals, "preview_session.signals"),
        artifacts: normalizeOptionalObject(value.artifacts, "preview_session.artifacts"),
        error: normalizeOptionalObject(value.error, "preview_session.error"),
    };
}
function normalizeReviewerAuthBootstrap(input) {
    if (input === undefined)
        return undefined;
    const value = requireObject(input, "reviewerAuthBootstrap");
    const evidence = requireObject(value.evidence, "reviewerAuthBootstrap.evidence");
    return {
        schema: "wp-codebox/reviewer-auth-bootstrap/v1",
        kind: "local-wordpress-admin-fixture",
        reviewerSafe: true,
        bootstrapUrl: requiredUrl(value.bootstrapUrl, "reviewerAuthBootstrap.bootstrapUrl"),
        redirectUrl: requiredUrl(value.redirectUrl, "reviewerAuthBootstrap.redirectUrl"),
        expiresAt: requiredIdentifier(value.expiresAt, "reviewerAuthBootstrap.expiresAt"),
        evidence: {
            command: requiredIdentifier(evidence.command, "reviewerAuthBootstrap.evidence.command"),
            auth: "wordpress-admin",
            userId: typeof evidence.userId === "number" ? evidence.userId : Number(evidence.userId),
        },
    };
}
function normalizePreviewBlockers(input) {
    if (!Array.isArray(input))
        return [];
    return input.map((entry, index) => {
        const value = requireObject(entry, `preview.blockers[${index}]`);
        const evidence = requireObject(value.evidence, `preview.blockers[${index}].evidence`);
        return {
            schema: "wp-codebox/preview-blocker/v1",
            kind: "unsupported-preview",
            code: requiredIdentifier(value.code, `preview.blockers[${index}].code`),
            message: optionalString(value.message, `preview.blockers[${index}].message`) ?? value.code ?? "Preview is blocked.",
            retryable: false,
            reviewerSafe: false,
            evidence: {
                command: requiredIdentifier(evidence.command, `preview.blockers[${index}].evidence.command`),
                auth: requiredIdentifier(evidence.auth, `preview.blockers[${index}].evidence.auth`),
            },
        };
    });
}
function safeNonLocalPreviewUrl(url) {
    if (!url)
        return undefined;
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
            return undefined;
        return isLocalPreviewHost(parsed.hostname) ? undefined : url;
    }
    catch {
        return undefined;
    }
}
function isLocalPreviewHost(hostname) {
    const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return normalized === "localhost" || normalized === "0.0.0.0" || normalized === "127.0.0.1" || normalized === "::1" || normalized.startsWith("127.");
}
function requiredUrl(value, label) {
    const url = optionalString(value, label);
    if (!url)
        throw new Error(`${label} must be a URL.`);
    try {
        new URL(url);
        return url;
    }
    catch {
        throw new Error(`${label} must be a URL.`);
    }
}
function normalizeDependencies(value, label, optional = false) {
    if (value === undefined && optional)
        return undefined;
    if (!Array.isArray(value))
        throw new Error(`Runtime profile ${label} must be an array.`);
    return value.map((entry, index) => normalizeDependency(entry, `${label}[${index}]`));
}
function normalizeObjectList(value, label) {
    if (value === undefined)
        return undefined;
    if (!Array.isArray(value))
        throw new Error(`Runtime profile ${label} must be an array.`);
    return value.map((entry, index) => requireObject(entry, `Runtime profile ${label}[${index}]`));
}
function normalizeDependency(input, label) {
    const value = requireObject(input, `Runtime profile ${label}`);
    const kind = requiredIdentifier(value.kind, `${label}.kind`);
    const slug = requiredIdentifier(value.slug, `${label}.slug`);
    return {
        kind,
        slug,
        name: optionalString(value.name, `${label}.name`),
        source: optionalString(value.source, `${label}.source`),
        target: optionalString(value.target, `${label}.target`),
        version: optionalString(value.version, `${label}.version`),
        activate: typeof value.activate === "boolean" ? value.activate : undefined,
        required: typeof value.required === "boolean" ? value.required : undefined,
        readiness: optionalString(value.readiness, `${label}.readiness`),
        provenance: normalizeOptionalObject(value.provenance, `${label}.provenance`),
        metadata: normalizeOptionalObject(value.metadata, `${label}.metadata`),
    };
}
function normalizeBootstrap(input) {
    const value = requireObject(input, "Runtime profile bootstrap");
    return {
        mode: optionalString(value.mode, "bootstrap.mode"),
        entrypoint: optionalString(value.entrypoint, "bootstrap.entrypoint"),
        blueprint_ref: optionalString(value.blueprint_ref, "bootstrap.blueprint_ref"),
        steps: normalizeStringList(value.steps, "bootstrap.steps"),
        provenance: normalizeOptionalObject(value.provenance, "bootstrap.provenance"),
    };
}
function normalizeReadiness(input) {
    const value = requireObject(input, "Runtime profile readiness");
    const checks = normalizeBooleanMap(value.checks, "readiness.checks");
    return {
        status: requiredIdentifier(value.status, "readiness.status"),
        checks,
        missing: normalizeStringList(value.missing, "readiness.missing"),
        evidence: normalizeOptionalObject(value.evidence, "readiness.evidence"),
    };
}
function normalizeDiagnostics(input) {
    if (input === undefined)
        return undefined;
    if (!Array.isArray(input))
        throw new Error("Runtime profile diagnostics must be an array.");
    return input.map((entry, index) => {
        const value = requireObject(entry, `Runtime profile diagnostics[${index}]`);
        return {
            code: requiredIdentifier(value.code, `diagnostics[${index}].code`),
            status: optionalString(value.status, `diagnostics[${index}].status`),
            message: optionalString(value.message, `diagnostics[${index}].message`),
            severity: optionalString(value.severity, `diagnostics[${index}].severity`),
            evidence: normalizeOptionalObject(value.evidence, `diagnostics[${index}].evidence`),
        };
    });
}
function normalizeAlignment(input) {
    const value = requireObject(input, "Preview alignment");
    return {
        status: requiredIdentifier(value.status, "alignment.status"),
        checked_at: optionalString(value.checked_at, "alignment.checked_at"),
        preview_matches_site: typeof value.preview_matches_site === "boolean" ? value.preview_matches_site : undefined,
        preview_matches_local: typeof value.preview_matches_local === "boolean" ? value.preview_matches_local : undefined,
        evidence: normalizeOptionalObject(value.evidence, "alignment.evidence"),
    };
}
function normalizeEnv(value) {
    if (value === undefined)
        return undefined;
    const env = requireObject(value, "Runtime profile env");
    return Object.fromEntries(Object.entries(env).map(([key, entry]) => {
        if (!/^[A-Z_][A-Z0-9_]*$/.test(key))
            throw new Error(`Runtime profile env key is invalid: ${key}.`);
        if (typeof entry !== "string")
            throw new Error(`Runtime profile env ${key} must be a string.`);
        return [key, entry];
    }));
}
function normalizeBooleanMap(value, label) {
    if (value === undefined)
        return undefined;
    const map = requireObject(value, label);
    return Object.fromEntries(Object.entries(map).map(([key, entry]) => [key, Boolean(entry)]));
}
function normalizeStringList(value, label) {
    if (value === undefined)
        return undefined;
    if (!Array.isArray(value))
        throw new Error(`${label} must be an array.`);
    return [...new Set(value.map((entry) => String(entry).trim()).filter(Boolean))];
}
function normalizeOptionalObject(value, label) {
    if (value === undefined)
        return undefined;
    return requireObject(value, label);
}
function requireObject(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`${label} must be an object.`);
    return value;
}
function requiredIdentifier(value, label) {
    const normalized = optionalString(value, label);
    if (!normalized || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(normalized))
        throw new Error(`${label} must be a stable identifier.`);
    return normalized;
}
function optionalString(value, label) {
    if (value === undefined)
        return undefined;
    if (typeof value !== "string")
        throw new Error(`${label} must be a string.`);
    const normalized = value.trim();
    return normalized === "" ? undefined : normalized;
}
//# sourceMappingURL=runtime-boundary-contracts.js.map