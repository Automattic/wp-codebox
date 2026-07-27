import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"

import { validateWorkspaceRecipeSemantics } from "../packages/cli/src/recipe-validation.js"
import type { RuntimeCreateSpec, WorkspaceRecipe } from "../packages/runtime-core/src/index.js"
import { playgroundRuntimeBlueprint } from "../packages/runtime-playground/src/blueprint.js"
import { browserPreviewTopology } from "../packages/runtime-playground/src/browser-preview-routing.js"
import { playgroundSiteSeedMultisiteTopology, playgroundSiteSeedPrimaryUrl } from "../packages/runtime-playground/src/site-seed-multisite.js"
import { withTempDir } from "../scripts/test-kit.js"

const recipe: WorkspaceRecipe = {
  schema: "wp-codebox/workspace-recipe/v1",
  runtime: { backend: "wordpress-playground" },
  inputs: {
    siteSeeds: [{
      type: "fixture",
      name: "mapped-network",
      source: "seed.json",
      scopes: { options: { names: ["blogdescription"] } },
      bootstrap: {
        multisite: {
          enabled: true,
          install: "subdomain",
          sites: [
            { domain: "alpha.example.test", path: "/", title: "Alpha" },
            { domain: "beta.example.test", path: "/", title: "Beta" },
          ],
        },
        domains: [
          { domain: "alpha.example.test", path: "/", primary: true },
          { domain: "beta.example.test", path: "/" },
        ],
      },
    }],
  },
  workflow: { steps: [] },
}

const spec = {
  backend: "wordpress-playground",
  environment: { version: "latest", blueprint: { steps: [{ step: "login" }] } },
  policy: { network: "deny", filesystem: "readwrite-mounts", commands: ["wordpress.run-php"], secrets: "none", approvals: "never" },
  metadata: { recipe },
} as RuntimeCreateSpec

assert.deepEqual(playgroundSiteSeedMultisiteTopology(spec), {
  install: "subdomain",
  primary: { domain: "alpha.example.test", path: "/", title: "Alpha", primary: true },
  sites: [
    { domain: "alpha.example.test", path: "/", title: "Alpha", primary: true },
    { domain: "beta.example.test", path: "/", title: "Beta", primary: false },
  ],
  routeHosts: ["alpha.example.test", "beta.example.test"],
})
assert.equal(playgroundSiteSeedPrimaryUrl(spec), "http://alpha.example.test/")

const blueprint = playgroundRuntimeBlueprint(spec) as { steps: Array<{ step: string; siteUrl?: string; code?: string }> }
assert.deepEqual(blueprint.steps.map((step) => step.step), ["defineSiteUrl", "enableMultisite", "runPHP", "login"])
assert.equal(blueprint.steps[0]?.siteUrl, "http://alpha.example.test/")
assert.match(blueprint.steps[2]?.code ?? "", /wp_insert_site/)
assert.match(blueprint.steps[2]?.code ?? "", /HTTP_HOST/)

const browser = browserPreviewTopology([], spec, "http://127.0.0.1:9400")
assert.deepEqual(browser.routedHosts, ["alpha.example.test", "beta.example.test"])
assert.equal(browser.preview.effectiveOrigin, "http://alpha.example.test/")
assert.deepEqual(browser.contextOptions(), { proxy: { server: "http://127.0.0.1:9400" } })
assert.equal(browser.networkPolicy.allowHosts.size, 0, "first-party route derivation must not broaden external host access")

const pathBasedSpec = { ...spec, metadata: { recipe: { ...recipe, inputs: {} } } } as RuntimeCreateSpec
assert.equal(playgroundSiteSeedMultisiteTopology(pathBasedSpec), undefined)
assert.deepEqual(playgroundRuntimeBlueprint(pathBasedSpec), { steps: [{ step: "login" }] })

const unsafeRuntimeSpec = structuredClone(spec)
const unsafeRecipe = unsafeRuntimeSpec.metadata!.recipe as WorkspaceRecipe
unsafeRecipe.inputs!.siteSeeds![0]!.bootstrap!.multisite!.sites![0]!.domain = "alpha.example.test'; phpinfo();"
assert.throws(() => playgroundSiteSeedMultisiteTopology(unsafeRuntimeSpec), /must be a hostname/)

await withTempDir("wp-codebox-site-seed-multisite-validation-", async (directory) => {
  await writeFile(join(directory, "seed.json"), JSON.stringify({ options: { blogdescription: "fixture" } }))
  const unsupported = structuredClone(recipe)
  unsupported.runtime = { backend: "custom-runtime" }
  const issues = await validateWorkspaceRecipeSemantics(unsupported, join(directory, "recipe.json"))
  assert.match(issues.find((issue) => issue.code === "unsupported-site-seed-multisite-bootstrap")?.message ?? "", /does not provide executable.*Select wordpress/i)

  const invalid = structuredClone(recipe)
  invalid.inputs!.siteSeeds![0]!.bootstrap!.domains![0]!.domain = "https://alpha.example.test:8443"
  const invalidIssues = await validateWorkspaceRecipeSemantics(invalid, join(directory, "recipe.json"))
  assert.ok(invalidIssues.some((issue) => issue.code === "invalid-site-seed-bootstrap-domain"))
  assert.ok(invalidIssues.some((issue) => issue.code === "unmatched-site-seed-bootstrap-domain"))
})

console.log("site seed mapped-domain multisite contract ok")
