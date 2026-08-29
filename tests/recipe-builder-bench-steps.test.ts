import assert from "node:assert/strict"
import { buildWordPressBenchRecipe } from "../packages/runtime-core/src/recipe-builders.js"

const recipe = buildWordPressBenchRecipe({
  pluginSlug: "fixture-plugin",
  extra_plugins: [{
    source: "/tmp/monorepo",
    sourceRoot: "/tmp/monorepo",
    sourceSubpath: "plugins/fixture-plugin",
    originalSource: "/tmp/monorepo/plugins/fixture-plugin",
    slug: "fixture-plugin",
  }],
  prepareSteps: [{ command: "wordpress.wp-cli", args: ["command=option update fixture_prepare yes"] }],
  postSteps: [{ command: "wordpress.browser-probe", args: ["url=/", "capture=html,screenshot"] }],
})

assert.deepEqual(recipe.workflow.before, [
  { command: "wordpress.wp-cli", args: ["command=option update fixture_prepare yes"] },
])
assert.deepEqual(recipe.workflow.steps.map((step) => step.command), [
  "wordpress.bench",
  "wordpress.browser-probe",
])
assert.deepEqual(recipe.workflow.steps[1], {
  command: "wordpress.browser-probe",
  args: ["url=/", "capture=html,screenshot"],
})
assert.deepEqual(recipe.inputs.extra_plugins?.[0], {
  source: "/tmp/monorepo",
  sourceRoot: "/tmp/monorepo",
  sourceSubpath: "plugins/fixture-plugin",
  originalSource: "/tmp/monorepo/plugins/fixture-plugin",
  slug: "fixture-plugin",
})
assert.equal(recipe.runtime.databaseSetup, undefined)

const customDropInRecipe = buildWordPressBenchRecipe({
  pluginSlug: "fixture-plugin",
  mounts: [{
    type: "file",
    source: "/tmp/db.php",
    target: "//wordpress//wp-content//db.php",
    phase: "pre-install",
  }],
})
assert.equal(customDropInRecipe.runtime.databaseSetup, "custom-drop-in")
assert.equal(customDropInRecipe.inputs.mounts?.[0]?.target, "/wordpress/wp-content/db.php")

const postInstallDropInRecipe = buildWordPressBenchRecipe({
  pluginSlug: "fixture-plugin",
  mounts: [{
    type: "file",
    source: "/tmp/db.php",
    target: "/wordpress/wp-content/db.php",
    phase: "post-install",
  }],
})
assert.equal(postInstallDropInRecipe.runtime.databaseSetup, undefined)

console.log("recipe builder bench steps ok")
