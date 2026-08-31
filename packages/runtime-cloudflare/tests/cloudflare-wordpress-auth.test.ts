import assert from "node:assert/strict"
import test from "node:test"
import { deriveSiteCredential, deriveWordPressAuthConstants, WORDPRESS_AUTH_CONSTANTS } from "../src/wordpress-auth.js"

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

test("site credentials preserve default compatibility and cannot be reused across configured sites", async () => {
  const root = "test-root-credential"
  assert.equal(await deriveSiteCredential(root, "default", "operator-token"), root)
  assert.equal(await deriveSiteCredential(root, "alpha", "operator-token"), await deriveSiteCredential(root, "alpha", "operator-token"))
  assert.notEqual(await deriveSiteCredential(root, "alpha", "operator-token"), await deriveSiteCredential(root, "beta", "operator-token"))
  assert.notEqual(await deriveSiteCredential(root, "alpha", "operator-token"), await deriveSiteCredential(root, "alpha", "admin-password"))
  await assert.rejects(deriveSiteCredential("", "alpha", "operator-token"), /WORDPRESS_OPERATOR_TOKEN is required/)
})
