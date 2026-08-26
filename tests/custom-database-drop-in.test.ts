import assert from "node:assert/strict"

import { planWorkspaceRecipe } from "../packages/cli/src/recipe-dry-run.js"
import { validateWorkspaceRecipeJsonSchema } from "../packages/runtime-core/src/recipe-schema.js"
import type { WorkspaceRecipe } from "../packages/runtime-core/src/runtime-contracts.js"

const recipe: WorkspaceRecipe = {
  schema: "wp-codebox/workspace-recipe/v1",
  runtime: { databaseSetup: "custom-drop-in" },
  inputs: {
    mounts: [{ type: "file", source: "db.php", target: "/wordpress/wp-content/db.php", mode: "readonly", phase: "pre-install" }],
  },
  workflow: { steps: [{ command: "wordpress.run-php", args: ["code=<?php echo get_class($wpdb);"] }] },
}

assert.equal(validateWorkspaceRecipeJsonSchema(recipe).valid, true)
assert.equal(validateWorkspaceRecipeJsonSchema({ ...recipe, runtime: { databaseSetup: "external" } }).valid, false)

const plan = await planWorkspaceRecipe(
  recipe,
  "/tmp",
  { recipePath: "/tmp/custom-db-recipe.json" },
  {
    defaultWordPressVersion: "latest",
    async resolveExecutionSpec(step) {
      return { command: step.command, args: step.args ?? [] }
    },
  },
)
assert.equal(plan.runtime.databaseSetup, "custom-drop-in")
assert.equal(plan.mounts.find((mount) => mount.target === "/wordpress/wp-content/db.php")?.phase, "pre-install")
