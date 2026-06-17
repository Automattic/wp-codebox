import assert from "node:assert/strict"
import { parseWorkspaceRecipe, recipePolicy } from "../packages/cli/src/recipe-validation.js"

const recipePath = "/tmp/wp-codebox-artifacts-policy-recipe.json"

assert.throws(
  () => parseWorkspaceRecipe(JSON.stringify({
    schema: "wp-codebox/workspace-recipe/v1",
    workflow: { steps: [{ command: "inspect-mounted-inputs" }] },
    artifacts: {
      typed: [{ name: "summary", path: "/tmp/summary.json" }],
    },
  }), recipePath),
  (error) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /Recipe JSON schema validation failed/)
    assert.match(error.message, /\$\.artifacts\.typed\[0\]\.type/)
    return true
  },
)

const typedOnlyRecipe = parseWorkspaceRecipe(JSON.stringify({
  schema: "wp-codebox/workspace-recipe/v1",
  workflow: { steps: [{ command: "inspect-mounted-inputs" }] },
  artifacts: {
    typed: [{ name: "summary", type: "example.summary", path: "/tmp/summary.json" }],
  },
}), recipePath)

assert.equal(recipePolicy(typedOnlyRecipe).commands.includes("wordpress.run-php"), true)

console.log("Recipe artifacts policy smoke passed")
