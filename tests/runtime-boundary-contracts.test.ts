import assert from "node:assert/strict"

import { BROWSER_CONTAINED_SITE_STATUS_SCHEMA, PREVIEW_LEASE_SCHEMA, RUNTIME_PROFILE_SCHEMA, browserContainedSiteStatus, previewLease, previewLeaseStatus, runtimeProfile } from "../packages/runtime-core/src/index.js"

const profile = runtimeProfile({
  schema: RUNTIME_PROFILE_SCHEMA,
  components: [{ kind: "component", slug: "agents-api", required: true, readiness: "ready", provenance: { source: "registry" } }],
  plugins: [{ kind: "plugin", slug: "wp-codebox", target: "/wordpress/wp-content/plugins/wp-codebox", activate: true }],
  mu_plugins: [{ kind: "mu_plugin", slug: "loader" }],
  themes: [{ kind: "theme", slug: "twentytwentyfour" }],
  bootstrap: { mode: "playground-blueprint", blueprint_ref: "runtime-cache-key", steps: ["install", "activate", "install"] },
  overlays: [{ kind: "overlay", slug: "provider-runtime", source: "/tmp/provider.zip" }],
  env: { WP_ENVIRONMENT_TYPE: "local" },
  readiness: { status: "ready", checks: { components: true }, missing: [] },
  provenance: { generated_by: "test" },
})

assert.equal(profile.schema, "wp-codebox/runtime-profile/v1")
assert.equal(profile.components[0].slug, "agents-api")
assert.deepEqual(profile.bootstrap?.steps, ["install", "activate"])
assert.deepEqual(profile.env, { WP_ENVIRONMENT_TYPE: "local" })

const lease = previewLease({
  schema: PREVIEW_LEASE_SCHEMA,
  preview_public_url: "https://preview.example.test",
  site_url: "https://site.example.test",
  local_url: "http://127.0.0.1:8881",
  lease: { id: "lease-1", status: "active", provider: "homeboy" },
  alignment: { status: "aligned", preview_matches_site: true, preview_matches_local: true },
})

assert.equal(lease.schema, "wp-codebox/preview-lease/v1")
assert.equal(lease.alignment?.status, "aligned")
assert.equal(previewLeaseStatus(lease), "active")
assert.equal(previewLeaseStatus({ schema: PREVIEW_LEASE_SCHEMA, local_url: "http://127.0.0.1:8881", lease: { status: "active", expires_at: "2020-01-01T00:00:00.000Z" } }), "expired")

const containedSiteStatus = browserContainedSiteStatus({
  schema: BROWSER_CONTAINED_SITE_STATUS_SCHEMA,
  success: true,
  site_id: "site-1",
  status: "recoverable",
  source_digest: { algorithm: "sha256", value: "a".repeat(64) },
})
assert.equal(containedSiteStatus.schema, "wp-codebox/browser-contained-site-status/v1")
assert.equal(containedSiteStatus.success, true)

assert.throws(() => runtimeProfile({ schema: RUNTIME_PROFILE_SCHEMA, components: [{ kind: "component" }] }), /slug/)
assert.throws(() => previewLease({ schema: PREVIEW_LEASE_SCHEMA }), /preview_public_url/)
assert.throws(() => browserContainedSiteStatus({ schema: BROWSER_CONTAINED_SITE_STATUS_SCHEMA, success: true, site_id: "site-1", status: "recoverable", source_digest: { value: "bad" } }), /source_digest/)

console.log("runtime boundary contracts ok")
