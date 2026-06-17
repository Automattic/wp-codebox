import assert from "node:assert/strict"
import { ALLOWED_DOWNLOAD_HOSTS_ENV, ALLOW_NETWORK_DOWNLOADS_ENV, evaluateSourcePolicy, REQUIRE_SOURCE_SHA256_ENV, sourcePolicySnapshot } from "../packages/cli/src/source-policy.js"

const originalEnv = {
  [ALLOW_NETWORK_DOWNLOADS_ENV]: process.env[ALLOW_NETWORK_DOWNLOADS_ENV],
  [ALLOWED_DOWNLOAD_HOSTS_ENV]: process.env[ALLOWED_DOWNLOAD_HOSTS_ENV],
  [REQUIRE_SOURCE_SHA256_ENV]: process.env[REQUIRE_SOURCE_SHA256_ENV],
}

try {
  delete process.env[ALLOW_NETWORK_DOWNLOADS_ENV]
  delete process.env[ALLOWED_DOWNLOAD_HOSTS_ENV]
  delete process.env[REQUIRE_SOURCE_SHA256_ENV]

  assert.deepEqual(evaluateSourcePolicy({ type: "local", host: "" }), [])
  assert.deepEqual(evaluateSourcePolicy({ type: "https_zip", host: "downloads.wordpress.org" }).map((issue) => issue.code), ["network-downloads-disabled"])
  assert.deepEqual(evaluateSourcePolicy({ type: "https_zip", host: "example.com" }).map((issue) => issue.code), ["network-downloads-disabled", "download-host-not-allowed"])

  process.env[ALLOW_NETWORK_DOWNLOADS_ENV] = "1"
  process.env[ALLOWED_DOWNLOAD_HOSTS_ENV] = " Example.com , downloads.wordpress.org "
  process.env[REQUIRE_SOURCE_SHA256_ENV] = "1"

  assert.deepEqual(evaluateSourcePolicy({ type: "https_zip", host: "example.com" }).map((issue) => issue.code), ["missing-source-sha256"])
  assert.deepEqual(evaluateSourcePolicy({ type: "https_zip", host: "example.com" }, "not-a-digest").map((issue) => issue.code), ["invalid-source-sha256"])
  assert.deepEqual(evaluateSourcePolicy({ type: "https_zip", host: "example.com" }, "a".repeat(64)), [])
  assert.equal(sourcePolicySnapshot("example.com").host, "example.com")
  assert.equal(sourcePolicySnapshot("example.com").sha256Required, true)
} finally {
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[name]
    } else {
      process.env[name] = value
    }
  }
}

console.log("Source policy smoke passed")
