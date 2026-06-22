import assert from "node:assert/strict"
import { buildWordPressBenchRecipe } from "../packages/runtime-core/src/recipe-builders.js"

const recipe = buildWordPressBenchRecipe({
  pluginSlug: "fixture-plugin",
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

console.log("recipe builder bench steps ok")
