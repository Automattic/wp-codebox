import assert from "node:assert/strict"
import test from "node:test"
import { deriveWordPressAuthConstants, WORDPRESS_AUTH_CONSTANTS } from "../packages/runtime-cloudflare/src/wordpress-auth.js"

test("WordPress auth constants are deterministic, site-scoped, and domain-separated", async () => {
  const first = await deriveWordPressAuthConstants("test-root-secret", "default")
  const second = await deriveWordPressAuthConstants("test-root-secret", "default")
  const otherSite = await deriveWordPressAuthConstants("test-root-secret", "other")

  assert.deepEqual(first, second)
  assert.deepEqual(Object.keys(first), WORDPRESS_AUTH_CONSTANTS)
  assert.equal(new Set(Object.values(first)).size, WORDPRESS_AUTH_CONSTANTS.length)
  assert.notEqual(first.AUTH_KEY, otherSite.AUTH_KEY)
  await assert.rejects(deriveWordPressAuthConstants("", "default"), /WORDPRESS_AUTH_SECRET is required/)
})
