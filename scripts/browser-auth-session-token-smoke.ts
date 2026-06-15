import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

const repoRoot = resolve(import.meta.dirname, "..")
const source = await readFile(resolve(repoRoot, "packages/runtime-playground/src/browser-command-runners.ts"), "utf8")
const helper = source.slice(source.indexOf("function wordpressAdminAuthCookiePhpCode"), source.indexOf("function browserAuthCookieUrls"))

assert.match(helper, /WP_Session_Tokens::get_instance\( \$user_id \)->create\( \$expiration \)/, "browser admin auth must create a persisted WordPress session token")
assert.match(helper, /array\( AUTH_COOKIE, 'auth', false \), array\( SECURE_AUTH_COOKIE, 'secure_auth', true \)/, "browser admin auth must install both non-secure and secure admin cookie schemes")
assert.match(helper, /wp_generate_auth_cookie\( \$user_id, \$expiration, \$admin_cookie\[1\], \$token \)/, "browser admin auth cookies must reuse the persisted token")
assert.match(helper, /wp_generate_auth_cookie\( \$user_id, \$expiration, 'logged_in', \$token \)/, "logged-in browser auth cookies must reuse the persisted token")
assert.doesNotMatch(helper, /echo\s+\$token|token_printed|value_printed/i, "browser auth helper must not expose session token values")

console.log("Browser auth session token smoke passed.")
