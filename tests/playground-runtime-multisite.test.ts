import assert from "node:assert/strict"

import type { RuntimeCreateSpec } from "../packages/runtime-core/src/index.js"
import { playgroundRuntimeBlueprint, playgroundRuntimeSiteUrl } from "../packages/runtime-playground/src/blueprint.js"

const spec = {
  backend: "wordpress-playground",
  environment: { version: "latest", blueprint: { steps: [{ step: "enableMultisite" }] } },
  policy: { network: "deny", filesystem: "sandbox", commands: ["wordpress.wp-cli"], secrets: "none", approvals: "never" },
} as RuntimeCreateSpec

assert.equal(playgroundRuntimeSiteUrl(spec), "http://127.0.0.1")
assert.deepEqual(playgroundRuntimeBlueprint(spec), {
  extraLibraries: ["wp-cli"],
  steps: [
    { step: "defineSiteUrl", siteUrl: "http://127.0.0.1" },
    { step: "enableMultisite" },
  ],
})

const explicitSiteUrlSpec = structuredClone(spec)
explicitSiteUrlSpec.environment.blueprint = {
  steps: [
    { step: "defineSiteUrl", siteUrl: "http://network.example.test" },
    { step: "enableMultisite" },
  ],
}
assert.equal(playgroundRuntimeSiteUrl(explicitSiteUrlSpec), undefined, "an explicit pre-multisite URL remains authoritative")

const explicitPreviewSpec = { ...spec, preview: { siteUrl: "http://preview.example.test" } }
assert.equal(playgroundRuntimeSiteUrl(explicitPreviewSpec), "http://preview.example.test")

console.log("playground runtime multisite URL contract ok")
