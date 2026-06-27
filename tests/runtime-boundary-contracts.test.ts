import assert from "node:assert/strict"

import { BROWSER_CONTAINED_SITE_OPEN_SCHEMA, BROWSER_CONTAINED_SITE_STATUS_SCHEMA, BROWSER_CONTAINED_SITE_SYNC_DELEGATION_SCHEMA, BROWSER_CONTAINED_SITE_SYNC_EXPORT_SCHEMA, BROWSER_SESSION_PRODUCT_DTO_SCHEMA, PREVIEW_LEASE_SCHEMA, RUNTIME_ACCESS_SCHEMA, RUNTIME_PROFILE_SCHEMA, browserContainedSiteOpenEnvelope, browserContainedSiteStatus, compileRuntimeProfile, normalizeRuntimeAccess, normalizeRuntimeProfile, previewLease, previewLeaseStatus, runtimeProfile, runtimeProfilePreflight } from "../packages/runtime-core/src/index.js"

const profile = runtimeProfile({
  schema: RUNTIME_PROFILE_SCHEMA,
  capabilities: ["agents.runtime", "provider.openai", "agents.runtime"],
  components: [{ kind: "component", slug: "agent-runtime", required: true, readiness: "ready", provenance: { source: "registry" } }],
  plugins: [{ kind: "plugin", slug: "wp-codebox", target: "/wordpress/wp-content/plugins/wp-codebox", activate: true }],
  mu_plugins: [{ kind: "mu_plugin", slug: "loader" }],
  themes: [{ kind: "theme", slug: "twentytwentyfour" }],
  bootstrap: { mode: "playground-blueprint", blueprint_ref: "runtime-cache-key", steps: ["install", "activate", "install"] },
  overlays: [{ kind: "overlay", slug: "provider-runtime", source: "/tmp/provider.zip" }],
  env: { WP_ENVIRONMENT_TYPE: "local" },
  readiness: { status: "ready", checks: { components: true }, missing: [] },
  diagnostics: [{ code: "runtime_profile.resolved", status: "ready", severity: "info", message: "resolved" }],
  provenance: { generated_by: "test" },
})

assert.equal(profile.schema, "wp-codebox/runtime-profile/v1")
assert.deepEqual(profile.capabilities, ["agents.runtime", "provider.openai"])
assert.equal(profile.components[0].slug, "agent-runtime")
assert.deepEqual(profile.bootstrap?.steps, ["install", "activate"])
assert.deepEqual(profile.env, { WP_ENVIRONMENT_TYPE: "local" })
assert.deepEqual(normalizeRuntimeProfile({ schema: RUNTIME_PROFILE_SCHEMA, components: [] }).components, [])

const executionPlan = compileRuntimeProfile({
  schema: RUNTIME_PROFILE_SCHEMA,
  components: [{ kind: "component", slug: "runtime-component", source: "/workspace/runtime-component", required: true }],
  plugins: [{ kind: "plugin", slug: "runtime-plugin", source: "/workspace/runtime-plugin", activate: false, metadata: { pluginFile: "runtime-plugin/runtime-plugin.php" } }],
  mu_plugins: [{ kind: "mu_plugin", slug: "runtime-loader", source: "/workspace/runtime-loader" }],
  overlays: [{ kind: "overlay", slug: "runtime-overlay", source: "/workspace/runtime-overlay", target: "/runtime/overlay" }],
  runtime_overlays: [{ kind: "library", library: "generic-runtime", source: "/workspace/overlay", strategy: "copy" }],
  env: { WP_ENVIRONMENT_TYPE: "local" },
  capabilities: ["wordpress.playground", "agents.runtime"],
  diagnostics: [{ code: "runtime_profile.resolved", status: "ready" }],
  provenance: { owner: "wp-codebox" },
})

assert.deepEqual(executionPlan.capabilities, ["wordpress.playground", "agents.runtime"])
assert.deepEqual(executionPlan.diagnostics, [{ code: "runtime_profile.resolved", status: "ready", message: undefined, severity: undefined, evidence: undefined }])
assert.deepEqual(executionPlan.provenance, { owner: "wp-codebox" })
assert.deepEqual(executionPlan.extra_plugins, [
  {
    source: "/workspace/runtime-component",
    slug: "runtime-component",
    activate: true,
    loadAs: "plugin",
    metadata: { runtimeProfileDependency: { kind: "component", required: true } },
  },
  {
    source: "/workspace/runtime-plugin",
    slug: "runtime-plugin",
    pluginFile: "runtime-plugin/runtime-plugin.php",
    activate: false,
    loadAs: "plugin",
    metadata: { runtimeProfileDependency: { kind: "plugin" }, pluginFile: "runtime-plugin/runtime-plugin.php" },
  },
  {
    source: "/workspace/runtime-loader",
    slug: "runtime-loader",
    loadAs: "mu-plugin",
    metadata: { runtimeProfileDependency: { kind: "mu_plugin" } },
  },
])
assert.deepEqual(executionPlan.dependency_plan.component_plugins, executionPlan.extra_plugins)
assert.deepEqual(executionPlan.dependency_plan.runtime_overlays, [
  { kind: "overlay", slug: "runtime-overlay", source: "/workspace/runtime-overlay", target: "/runtime/overlay" },
  { kind: "library", library: "generic-runtime", source: "/workspace/overlay", strategy: "copy" },
])
assert.deepEqual(runtimeProfilePreflight({ schema: RUNTIME_PROFILE_SCHEMA, components: [{ kind: "component", slug: "missing-runtime-component", required: true }] }).readiness.status, "missing")

const lease = previewLease({
  schema: PREVIEW_LEASE_SCHEMA,
  public_url: "https://preview.example.test",
  site_url: "https://site.example.test",
  local_url: "http://127.0.0.1:8881",
  lease: { id: "lease-1", status: "active", provider: "preview-service", owner: "runtime-loop" },
  reachability: { status: "reachable", http_status: 200, probes: [{ kind: "http", status: "passed" }], evidence_refs: [{ kind: "probe-log", path: "files/probe.json" }] },
  alignment: { status: "aligned", preview_matches_site: true, preview_matches_local: true },
  evidence_refs: [{ kind: "preview-evidence", path: "files/browser/summary.json" }],
})

assert.equal(lease.schema, "wp-codebox/preview-lease/v1")
assert.equal(lease.public_url, "https://preview.example.test")
assert.equal(lease.preview_public_url, "https://preview.example.test")
assert.equal(lease.local_url, "http://127.0.0.1:8881")
assert.equal(lease.reachability?.status, "reachable")
assert.equal(lease.alignment?.status, "aligned")
assert.equal(lease.lease?.owner, "runtime-loop")
assert.equal(previewLeaseStatus(lease), "active")
assert.equal(previewLeaseStatus({ schema: PREVIEW_LEASE_SCHEMA, local_url: "http://127.0.0.1:8881", lease: { status: "active", expires_at: "2020-01-01T00:00:00.000Z" } }), "expired")

const runtimeAccess = normalizeRuntimeAccess({
  schema: RUNTIME_ACCESS_SCHEMA,
  preview_url: "https://preview.example.test",
  public_url: "https://preview.example.test",
  site_url: "https://site.example.test",
  admin_url: "https://site.example.test/wp-admin/",
  lease,
  reviewer_access: { schema: "wp-codebox/preview-reviewer-access/v1", status: "ready", openUrl: "https://preview.example.test" },
})
assert.equal(runtimeAccess.schema, "wp-codebox/runtime-access/v1")
assert.equal(runtimeAccess.preview_url, "https://preview.example.test")
assert.equal(runtimeAccess.site_url, "https://site.example.test")
assert.equal(runtimeAccess.local_url, "http://127.0.0.1:8881")
assert.equal(runtimeAccess.lease?.preview_public_url, "https://preview.example.test")
assert.equal(runtimeAccess.reviewer_access?.openUrl, "https://preview.example.test")

const localOnlyRuntimeAccess = normalizeRuntimeAccess({
  schema: RUNTIME_ACCESS_SCHEMA,
  lease: {
    schema: PREVIEW_LEASE_SCHEMA,
    local_url: "http://127.0.0.1:9400/",
    lease: { status: "active", provider: "local-preview" },
  },
})
assert.equal(localOnlyRuntimeAccess.preview_url, "http://127.0.0.1:9400/")
assert.equal(localOnlyRuntimeAccess.local_url, "http://127.0.0.1:9400/")

const publicRuntimeAccess = normalizeRuntimeAccess({
  schema: RUNTIME_ACCESS_SCHEMA,
  public_url: "https://review.example.test/",
  lease: {
    schema: PREVIEW_LEASE_SCHEMA,
    local_url: "http://127.0.0.1:9400/",
  },
})
assert.equal(publicRuntimeAccess.preview_url, "https://review.example.test/")
assert.equal(publicRuntimeAccess.local_url, "http://127.0.0.1:9400/")

const containedSiteSyncDelegation = {
  success: true,
  schema: BROWSER_CONTAINED_SITE_SYNC_DELEGATION_SCHEMA,
  status: "available",
  routes: {
    source_connect: "/wp-codebox/v1/browser-contained-site-sync/source-connect",
    manifest: "/wp-codebox/v1/browser-contained-site-sync/manifest",
    export: "/wp-codebox/v1/browser-contained-site-sync/export",
    apply_plan_generate: "/wp-codebox/v1/browser-contained-site-sync/apply-plan/generate",
    apply_plan_validate: "/wp-codebox/v1/browser-contained-site-sync/apply-plan/validate",
    apply: "/wp-codebox/v1/browser-contained-site-sync/apply",
  },
  abilities: {
    manifest: "wp-codebox/browser-contained-site-sync-manifest",
    export: "wp-codebox/browser-contained-site-sync-export",
  },
}
assert.equal(containedSiteSyncDelegation.schema, "wp-codebox/browser-contained-site-sync-delegation/v1")
assert.equal(containedSiteSyncDelegation.routes.export, "/wp-codebox/v1/browser-contained-site-sync/export")

const containedSiteSyncExport = {
  success: true,
  schema: BROWSER_CONTAINED_SITE_SYNC_EXPORT_SCHEMA,
  status: "available",
  operation: "export",
  package: { schema: "backend-package/v1", descriptor: { bootable: true } },
}
assert.equal(containedSiteSyncExport.schema, "wp-codebox/browser-contained-site-sync-export/v1")

const containedSiteStatus = browserContainedSiteStatus({
  schema: BROWSER_CONTAINED_SITE_STATUS_SCHEMA,
  success: true,
  site_id: "site-1",
  status: "recoverable_prepared_runtime",
  source_digest: { algorithm: "sha256", value: "a".repeat(64) },
  resolution: { prepared_runtime_recoverable: true, live: false, current: false, materialized: false },
})
assert.equal(containedSiteStatus.schema, "wp-codebox/browser-contained-site-status/v1")
assert.equal(containedSiteStatus.success, true)
assert.equal(containedSiteStatus.status, "recoverable_prepared_runtime")
assert.equal(containedSiteStatus.resolution?.live, false)

const containedSiteOpen = browserContainedSiteOpenEnvelope({
  schema: BROWSER_CONTAINED_SITE_OPEN_SCHEMA,
  success: true,
  site_id: "site-1",
  status: "recoverable_prepared_runtime",
  resolution: { prepared_runtime_recoverable: true, live: false, current: false, materialized: false },
  contained_site: {
    schema: "wp-codebox/browser-contained-site/v1",
    site_id: "site-1",
    status: "recoverable_prepared_runtime",
    source_digest: { algorithm: "sha256", value: "a".repeat(64) },
  },
  preview_session: {
    schema: BROWSER_SESSION_PRODUCT_DTO_SCHEMA,
    success: true,
    status: "recoverable_prepared_runtime",
    session_id: "session-1",
  },
})
assert.equal(containedSiteOpen.schema, "wp-codebox/browser-contained-site-open/v1")
assert.equal(containedSiteOpen.preview_session?.status, "recoverable_prepared_runtime")

assert.throws(() => runtimeProfile({ schema: RUNTIME_PROFILE_SCHEMA, components: [{ kind: "component" }] }), /slug/)
assert.throws(() => previewLease({ schema: PREVIEW_LEASE_SCHEMA }), /public_url/)
assert.throws(() => browserContainedSiteStatus({ schema: BROWSER_CONTAINED_SITE_STATUS_SCHEMA, success: true, site_id: "site-1", status: "recoverable_prepared_runtime", source_digest: { value: "bad" } }), /source_digest/)

const publicContractEnvelopes = [profile, lease, runtimeAccess, containedSiteStatus, containedSiteOpen, containedSiteSyncDelegation, containedSiteSyncExport]
const forbiddenPublicContractTerms = [
  /data[-_ ]?machine/i,
  /datamachine/i,
  /agents[-_ ]?api/i,
  /wordpress[-_ ]?playground/i,
  /\bplayground\b/i,
  /homeboy/i,
]

for (const contract of publicContractEnvelopes) {
  for (const publicName of publicContractNames(contract)) {
    for (const forbidden of forbiddenPublicContractTerms) {
      assert.doesNotMatch(publicName, forbidden, `${publicName} exposes raw upstream vocabulary in a public boundary contract`)
    }
  }
}

console.log("runtime boundary contracts ok")

function publicContractNames(input: unknown, prefix = ""): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return []

  const names: string[] = []
  for (const [key, value] of Object.entries(input)) {
    const path = prefix ? `${prefix}.${key}` : key
    names.push(path)
    if (key === "schema" && typeof value === "string") names.push(value)
    if (value && typeof value === "object" && !Array.isArray(value) && !opaquePublicContractField(key)) {
      names.push(...publicContractNames(value, path))
    }
  }
  return names
}

function opaquePublicContractField(key: string): boolean {
  return key === "metadata" || key === "provenance" || key === "evidence" || key === "signals" || key === "error" || key === "artifacts"
}
