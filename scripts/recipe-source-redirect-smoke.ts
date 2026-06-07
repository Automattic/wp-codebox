import assert from "node:assert/strict"

import { evaluateRecipeSourcePolicy, prepareRecipeExtraPlugins, recipeRedirectSource, recipeSource } from "../packages/cli/src/recipe-sources.js"

const source = recipeSource(
  "https://github.com/Extra-Chill/data-machine/releases/download/v0.140.1/data-machine.zip",
  "2259c9cbf24d9ad199e4b5d64f1fe314640e75b5bf9a4ac4c2dae5360afebc12",
)

const redirected = recipeRedirectSource(
  source,
  "https://release-assets.githubusercontent.com/github-production-release-asset/123/asset-id?response-content-disposition=attachment%3B%20filename%3Ddata-machine.zip&response-content-type=application%2Foctet-stream",
)

assert.equal(redirected.type, "https_zip")
assert.equal(redirected.host, "release-assets.githubusercontent.com")
assert.equal(redirected.expectedSha256, source.expectedSha256)

assert.throws(
  () => recipeRedirectSource(source, "https://release-assets.githubusercontent.com/github-production-release-asset/123/asset-id?response-content-disposition=attachment%3B%20filename%3Ddata-machine.tar.gz"),
  /does not identify a zip archive/,
)

assert.throws(
  () => recipeRedirectSource(source, "http://release-assets.githubusercontent.com/github-production-release-asset/123/data-machine.zip"),
  /non-HTTPS URL/,
)

const originalAllowNetworkDownloads = process.env.WP_CODEBOX_ALLOW_NETWORK_DOWNLOADS
const originalAllowedDownloadHosts = process.env.WP_CODEBOX_ALLOWED_DOWNLOAD_HOSTS
const originalRequireSourceSha256 = process.env.WP_CODEBOX_REQUIRE_SOURCE_SHA256

try {
  process.env.WP_CODEBOX_ALLOW_NETWORK_DOWNLOADS = ""
  process.env.WP_CODEBOX_ALLOWED_DOWNLOAD_HOSTS = "downloads.wordpress.org"
  process.env.WP_CODEBOX_REQUIRE_SOURCE_SHA256 = ""
  assert.deepEqual(evaluateRecipeSourcePolicy(source, source.expectedSha256).map((issue) => issue.code), [
    "network-downloads-disabled",
    "download-host-not-allowed",
  ])

  process.env.WP_CODEBOX_ALLOW_NETWORK_DOWNLOADS = "1"
  process.env.WP_CODEBOX_ALLOWED_DOWNLOAD_HOSTS = "github.com"
  process.env.WP_CODEBOX_REQUIRE_SOURCE_SHA256 = "1"
  assert.deepEqual(evaluateRecipeSourcePolicy(recipeSource("https://github.com/example/plugin.zip")).map((issue) => issue.code), [
    "missing-source-sha256",
  ])

  assert.deepEqual(evaluateRecipeSourcePolicy(recipeSource("https://github.com/example/plugin.zip", "not-a-digest"), "not-a-digest").map((issue) => issue.code), [
    "invalid-source-sha256",
  ])

  process.env.WP_CODEBOX_ALLOWED_DOWNLOAD_HOSTS = "downloads.wordpress.org"
  await assert.rejects(
    () => prepareRecipeExtraPlugins({
      schema: "wp-codebox/workspace-recipe/v1",
      inputs: {
        extraPlugins: [
          {
            source: "https://downloads.wordpress.org/plugin/bbpress.latest-stable.zip",
            pluginFile: "bbpress/bbpress.php",
          },
        ],
      },
      workflow: { steps: [{ command: "wordpress.run-php", args: ["code=echo 'source policy';"] }] },
    }, process.cwd()),
    /External recipe sources require sha256 when WP_CODEBOX_REQUIRE_SOURCE_SHA256=1\./,
  )

  process.env.WP_CODEBOX_ALLOW_NETWORK_DOWNLOADS = ""
  process.env.WP_CODEBOX_ALLOWED_DOWNLOAD_HOSTS = "downloads.wordpress.org"
  process.env.WP_CODEBOX_REQUIRE_SOURCE_SHA256 = ""
  await assert.rejects(
    () => prepareRecipeExtraPlugins({
      schema: "wp-codebox/workspace-recipe/v1",
      inputs: {
        extraPlugins: [
          {
            source: "https://downloads.wordpress.org/plugin/bbpress.latest-stable.zip",
            pluginFile: "bbpress/bbpress.php",
          },
        ],
      },
      workflow: { steps: [{ command: "wordpress.run-php", args: ["code=echo 'source policy';"] }] },
    }, process.cwd()),
    /External recipe sources require WP_CODEBOX_ALLOW_NETWORK_DOWNLOADS=1 before WP Codebox downloads anything\./,
  )
} finally {
  if (originalAllowNetworkDownloads === undefined) {
    delete process.env.WP_CODEBOX_ALLOW_NETWORK_DOWNLOADS
  } else {
    process.env.WP_CODEBOX_ALLOW_NETWORK_DOWNLOADS = originalAllowNetworkDownloads
  }
  if (originalAllowedDownloadHosts === undefined) {
    delete process.env.WP_CODEBOX_ALLOWED_DOWNLOAD_HOSTS
  } else {
    process.env.WP_CODEBOX_ALLOWED_DOWNLOAD_HOSTS = originalAllowedDownloadHosts
  }
  if (originalRequireSourceSha256 === undefined) {
    delete process.env.WP_CODEBOX_REQUIRE_SOURCE_SHA256
  } else {
    process.env.WP_CODEBOX_REQUIRE_SOURCE_SHA256 = originalRequireSourceSha256
  }
}
