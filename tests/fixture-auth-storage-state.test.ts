import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { commandRegistry } from "../packages/runtime-core/src/command-registry.js"
import { browserStorageStateFromWordPressAuthCookies, normalizeBrowserStorageStatePayload, wordpressFixtureUserStorageStatePhpCode } from "../packages/runtime-playground/src/browser-auth-storage-state.js"
import { browserStorageStateImportFromArgs } from "../packages/runtime-playground/src/browser-probe-support.js"

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

const exportCommand = commandRegistry.find((definition) => definition.id === "wordpress.export-browser-storage-state")
assert.ok(exportCommand, "storage-state export command is registered")
assert.equal(exportCommand?.outputSchema?.id, "wp-codebox/browser-storage-state-export/v1")
assert.ok(exportCommand?.acceptedArgs.some((arg) => arg.name === "browser-urls"), "export command accepts browser URLs")
assert.ok(exportCommand?.acceptedArgs.some((arg) => arg.name === "user-json"), "export command accepts a fixture user")
assert.ok(exportCommand?.acceptedArgs.some((arg) => arg.name === "storage-state"), "export command accepts caller-provided storage state")
assert.doesNotMatch(JSON.stringify(exportCommand), /wpcom|dolly|blog_id|site_id/i)

const artifactRoot = join(tmpdir(), `wp-codebox-storage-state-${process.pid}`)
const artifactStatePath = join(artifactRoot, "files/browser-storage-state/storage-state.json")
await mkdir(join(artifactRoot, "files/browser-storage-state"), { recursive: true })
await writeFile(artifactStatePath, `${JSON.stringify(imported.storageState)}\n`, "utf8")
const importedFromArtifactRef = await browserStorageStateImportFromArgs([
  "storage-state=@files/browser-storage-state/storage-state.json",
], "wordpress.browser-probe", artifactRoot)
assert.equal(importedFromArtifactRef?.summary.status, "ready")
assert.equal(importedFromArtifactRef?.summary.cookieCount, 1)

console.log("fixture auth storage state ok")
