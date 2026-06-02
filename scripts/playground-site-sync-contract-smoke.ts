import assert from "node:assert/strict"
import {
  createPlaygroundSiteSyncDelegationDescriptor,
  createPlaygroundSiteSyncPackageDescriptor,
  createPlaygroundSiteSyncRedactionMetadata,
  createPlaygroundSiteSyncRemoteAuth,
  defaultPlaygroundSiteSyncRedactionPolicy,
  unsupportedPlaygroundSiteSyncHydration,
} from "../packages/runtime-core/src/playground-site-sync.js"

const delegation = createPlaygroundSiteSyncDelegationDescriptor({ namespace: "playground-site-sync/v1" })
assert.equal(delegation.schema, "wp-codebox/playground-site-sync-delegation/v1")
assert.equal(delegation.transport, "same-origin-rest")
assert.equal(delegation.routes.length, 8)
assert.deepEqual(delegation.routes.find((route) => route.name === "manifest"), { name: "manifest", path: "/manifest", method: "GET" })
assert.deepEqual(delegation.routes.find((route) => route.name === "export"), { name: "export", path: "/export", method: "POST" })

assert.throws(() => createPlaygroundSiteSyncDelegationDescriptor({ routes: { manifest: "https://example.com/wp-json/playground-site-sync/v1/manifest" } }))
assert.throws(() => createPlaygroundSiteSyncDelegationDescriptor({ routes: { manifest: "/../manifest" } }))
assert.throws(() => createPlaygroundSiteSyncDelegationDescriptor({ namespace: "studio-web" }))

const missingAuth = createPlaygroundSiteSyncRemoteAuth({ siteUrl: "https://example.test" })
assert.equal(missingAuth.status, "error")
assert.equal(missingAuth.error?.schema, "wp-codebox/playground-site-sync-error/v1")
assert.equal(missingAuth.error?.code, "auth_missing")
assert.equal(missingAuth.error?.status, 401)
assert.equal(missingAuth.error?.authRequired, true)

const bearerAuth = createPlaygroundSiteSyncRemoteAuth({ siteUrl: "https://example.test", bearerToken: "runtime-token" })
assert.equal(bearerAuth.status, "ok")
assert.equal(bearerAuth.headers?.Authorization, "Bearer runtime-token")

const basicAuth = createPlaygroundSiteSyncRemoteAuth({ siteUrl: "https://example.test", username: "admin", applicationPassword: "app-pass" })
assert.equal(basicAuth.status, "ok")
assert.match(basicAuth.headers?.Authorization ?? "", /^Basic /)

const redactionPolicy = defaultPlaygroundSiteSyncRedactionPolicy()
const redaction = createPlaygroundSiteSyncRedactionMetadata(redactionPolicy)
assert.equal(redaction.schema, "wp-codebox/playground-site-sync-redaction-metadata/v1")
assert.equal(redaction.applied, true)
assert.equal(redaction.valueCaptureAllowed, false)
assert.equal(redaction.evidence.leaksValues, false)
assert.equal(redaction.evidence.deniedPathRules.total, redactionPolicy.deniedPaths.exact!.length + redactionPolicy.deniedPaths.patterns!.length)
assert.equal(JSON.stringify(redaction).includes("runtime-token"), false)

const packageDescriptor = createPlaygroundSiteSyncPackageDescriptor({
  id: "playground_site_sync_test",
  generated: "2026-06-01T00:00:00.000Z",
  manifest: { schema: "playground-site-sync/manifest/v1", site: { url: "https://example.test" } },
  resources: { schema: "playground-site-sync/resources/v1", items: [] },
  blueprint: { landingPage: "/wp-admin/", steps: [{ step: "login" }] },
  redaction,
})
assert.equal(packageDescriptor.schema, "wp-codebox/playground-site-sync-package/v1")
assert.equal(packageDescriptor.descriptor.format, "playground-blueprint-descriptor")
assert.equal(packageDescriptor.descriptor.packaged, false)
assert.equal(packageDescriptor.descriptor.archive, false)
assert.equal(packageDescriptor.descriptor.bootable, true)
assert.equal(packageDescriptor.includes.database, false)
assert.equal(packageDescriptor.includes.uploads, false)
assert.match(packageDescriptor.descriptor.checksum, /^sha256:[a-f0-9]{64}$/)
assert.match(packageDescriptor.checksums.manifest, /^sha256:[a-f0-9]{64}$/)

const unsupportedHydration = unsupportedPlaygroundSiteSyncHydration(packageDescriptor)
assert.equal(unsupportedHydration.schema, "wp-codebox/playground-site-sync-hydration-result/v1")
assert.equal(unsupportedHydration.status, "unsupported")
assert.equal(unsupportedHydration.packageId, "playground_site_sync_test")
assert.equal(unsupportedHydration.error.status, 501)
assert.equal(unsupportedHydration.error.code, "hydration_unsupported")
