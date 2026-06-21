import assert from "node:assert/strict"

import { normalizeRuntimeBackendKind } from "../packages/runtime-core/src/index.js"
import { parseWorkspaceRecipe } from "../packages/cli/src/recipe-validation.js"

const recipeWithWordPressAlias = parseWorkspaceRecipe(JSON.stringify({
  schema: "wp-codebox/workspace-recipe/v1",
  runtime: { backend: "wordpress" },
  workflow: { steps: [{ command: "wordpress.run-php", args: ["code=<?php echo 'ok';"] }] },
}), "recipe-wordpress-alias.json")

assert.equal(recipeWithWordPressAlias.runtime?.backend, "wordpress-playground")
assert.equal(normalizeRuntimeBackendKind("wordpress"), "wordpress-playground")
assert.equal(normalizeRuntimeBackendKind(undefined), "wordpress-playground")

const recipeWithOmittedBackend = parseWorkspaceRecipe(JSON.stringify({
  schema: "wp-codebox/workspace-recipe/v1",
  runtime: { name: "default-wordpress-runtime" },
  workflow: { steps: [{ command: "wordpress.run-php", args: ["code=<?php echo 'ok';"] }] },
}), "recipe-omitted-backend.json")

assert.equal(recipeWithOmittedBackend.runtime?.backend, "wordpress-playground")

console.log("recipe runtime backend normalization ok")
