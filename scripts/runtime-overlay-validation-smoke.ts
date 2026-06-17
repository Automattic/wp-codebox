import assert from "node:assert/strict"
import { parseWorkspaceRecipe } from "../packages/cli/src/recipe-validation.js"

const recipePath = "/tmp/wp-codebox-runtime-overlay-recipe.json"

function recipeWithOverlay(overlay: Record<string, unknown>): string {
  return JSON.stringify({
    schema: "wp-codebox/workspace-recipe/v1",
    runtime: {
      overlays: [overlay],
    },
    workflow: {
      steps: [
        {
          command: "inspect-mounted-inputs",
        },
      ],
    },
  })
}

assert.throws(
  () => parseWorkspaceRecipe(recipeWithOverlay({
    type: "bundled-library",
    library: "php-ai-client",
    source: "./vendor/php-ai-client",
    strategy: "wordpress-scoped-bundle",
  }), recipePath),
  (error) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /runtime_overlays\[0\]/)
    assert.match(error.message, /\$\.runtime\.overlays\[0\]/)
    assert.match(error.message, /field kind must be a non-empty string/)
    assert.match(error.message, /accepted canonical kind values: bundled-library/)
    assert.match(error.message, new RegExp(recipePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    return true
  },
)

assert.throws(
  () => parseWorkspaceRecipe(recipeWithOverlay({
    kind: "provider-plugin",
    library: "php-ai-client",
    source: "./vendor/php-ai-client",
    strategy: "wordpress-scoped-bundle",
  }), recipePath),
  (error) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /runtime_overlays\[0\]/)
    assert.match(error.message, /field descriptor must match a registered runtime overlay descriptor/)
    assert.match(error.message, /bundled-library\/php-ai-client\/wordpress-scoped-bundle/)
    assert.match(error.message, /accepted canonical kind values: bundled-library/)
    assert.match(error.message, /recipe: \/tmp\/wp-codebox-runtime-overlay-recipe\.json/)
    return true
  },
)

console.log("Runtime overlay validation smoke passed")
