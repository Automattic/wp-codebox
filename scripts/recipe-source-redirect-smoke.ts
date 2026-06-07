import assert from "node:assert/strict"

import { recipeRedirectSource, recipeSource } from "../packages/cli/src/recipe-sources.js"

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
