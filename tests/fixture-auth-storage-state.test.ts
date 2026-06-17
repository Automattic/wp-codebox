import assert from "node:assert/strict"
import { commandRegistry } from "../packages/runtime-core/src/command-registry.js"
import { browserStorageStateFromWordPressAuthCookies, normalizeBrowserStorageStatePayload, wordpressFixtureUserStorageStatePhpCode } from "../packages/runtime-playground/src/browser-auth-storage-state.js"

const state = browserStorageStateFromWordPressAuthCookies([
  { name: "wordpress_logged_in", value: "token", domain: "localhost", path: "/", expires: 1_800_000_000, httpOnly: true },
])

assert.deepEqual(state, {
  cookies: [{ name: "wordpress_logged_in", value: "token", domain: "localhost", path: "/", expires: 1_800_000_000, httpOnly: true, secure: false, sameSite: "Lax" }],
  origins: [],
})

const php = wordpressFixtureUserStorageStatePhpCode({
  browserUrls: ["http://127.0.0.1:9400/wp-admin/", "https://preview.example.test/wp-admin/"],
  user: { username: "fixture-admin", email: "fixture-admin@example.test", role: "administrator", displayName: "Fixture Admin" },
})

assert.match(php, /wp-codebox\/browser-auth-storage-state\/v1/)
assert.match(php, /wp-codebox-fixture-admin/)
assert.match(php, /wp_insert_user/)
assert.match(php, /WP_Session_Tokens::get_instance/)
assert.match(php, /storageState/)
assert.match(php, /preview\.example\.test/)
assert.doesNotMatch(php, /wpcom|blog_id|site_id/i)

const imported = normalizeBrowserStorageStatePayload({
  schema: "wp-codebox/browser-auth-storage-state/v1",
  kind: "wordpress-fixture-user-admin-auth",
  storageState: {
    cookies: [{ name: "wordpress_logged_in", value: "super-secret-token", domain: "example.test", path: "/", expires: 1_800_000_000, httpOnly: true }],
    origins: [{ origin: "https://example.test", localStorage: [{ name: "token", value: "secret-local-storage" }] }],
  },
}, "inline")

assert.equal(imported.summary.status, "ready")
assert.equal(imported.summary.schema, "wp-codebox/browser-auth-storage-state/v1")
assert.equal(imported.summary.kind, "wordpress-fixture-user-admin-auth")
assert.equal(imported.summary.cookieCount, 1)
assert.deepEqual(imported.summary.cookieHosts, [{ host: "example.test", cookieCount: 1 }])
assert.equal(imported.summary.originCount, 1)
assert.doesNotMatch(JSON.stringify(imported.summary), /super-secret-token|secret-local-storage/)

const unsupported = normalizeBrowserStorageStatePayload({ schema: "example/unsupported/v1", storageState: { cookies: [{ name: "missing-domain" }], origins: [] } }, "file")
assert.equal(unsupported.summary.status, "unsupported")
assert.deepEqual(unsupported.summary.diagnostics.map((diagnostic) => diagnostic.code), ["storage-state-schema-unsupported", "storage-state-cookie-unsupported"])

for (const commandId of ["wordpress.browser-probe", "wordpress.browser-actions"]) {
  const command = commandRegistry.find((definition) => definition.id === commandId)
  assert.ok(command?.acceptedArgs.some((arg) => arg.name === "storage-state"), `${commandId} exposes storage-state argument`)
}

console.log("fixture auth storage state ok")
