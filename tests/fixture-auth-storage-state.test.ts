import assert from "node:assert/strict"
import { browserStorageStateFromWordPressAuthCookies, wordpressFixtureUserStorageStatePhpCode } from "../packages/runtime-playground/src/browser-auth-storage-state.js"

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

console.log("fixture auth storage state ok")
