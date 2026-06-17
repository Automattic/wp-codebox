import assert from "node:assert/strict"
import { join } from "node:path"

import { validateWorkspaceRecipeSemantics } from "../packages/cli/src/recipe-validation.js"
import type { WorkspaceRecipe } from "../packages/runtime-core/src/index.js"
import { withTempDir } from "../scripts/test-kit.js"

await withTempDir("wp-codebox-recipe-validation-descriptors-", async (recipeDirectory) => {
  const recipePath = join(recipeDirectory, "recipe.json")
  const recipe: WorkspaceRecipe = {
    schema: "wp-codebox/workspace-recipe/v1",
    workflow: {
      steps: [
        { command: "wordpress.browser-probe", args: ["capture=console,bogus", "duration=forever", "profile=desktop-webkit"] },
        { command: "wordpress.browser-actions", args: ["capture=steps,bogus", "timeout=forever"] },
        { command: "wordpress.browser-scenario", args: ["capture=performance,bogus", "step-timeout=forever"] },
        { command: "wordpress.editor-actions", args: ["capture=steps,bogus", "wait-timeout=forever"] },
      ],
    },
  }

  const issues = await validateWorkspaceRecipeSemantics(recipe, recipePath)
  assert.deepEqual(issues.filter((issue) => issue.path === "$.workflow.steps[0].args"), [
    { code: "missing-url", path: "$.workflow.steps[0].args", message: "wordpress.browser-probe requires url=<path-or-url>." },
    { code: "invalid-duration", path: "$.workflow.steps[0].args", message: "wordpress.browser-probe duration must look like 500ms or 2s." },
    { code: "invalid-profile", path: "$.workflow.steps[0].args", message: "wordpress.browser-probe profile is unsupported: desktop-webkit" },
    { code: "invalid-capture", path: "$.workflow.steps[0].args", message: "wordpress.browser-probe capture does not support: bogus" },
  ])
  assert.deepEqual(issues.filter((issue) => issue.path === "$.workflow.steps[1].args"), [
    { code: "missing-steps", path: "$.workflow.steps[1].args", message: "wordpress.browser-actions requires steps-json=<array> or url=<path-or-url>." },
    { code: "invalid-duration", path: "$.workflow.steps[1].args", message: "wordpress.browser-actions timeout must look like 500ms or 2s." },
    { code: "invalid-capture", path: "$.workflow.steps[1].args", message: "wordpress.browser-actions capture does not support: bogus" },
  ])
  assert.deepEqual(issues.filter((issue) => issue.path === "$.workflow.steps[2].args"), [
    { code: "missing-scenario", path: "$.workflow.steps[2].args", message: "wordpress.browser-scenario requires scenario-json=<object> or url=<path-or-url>." },
    { code: "invalid-duration", path: "$.workflow.steps[2].args", message: "wordpress.browser-scenario step-timeout must look like 500ms or 2s." },
    { code: "invalid-capture", path: "$.workflow.steps[2].args", message: "wordpress.browser-scenario capture does not support: bogus" },
  ])
  assert.deepEqual(issues.filter((issue) => issue.path === "$.workflow.steps[3].args"), [
    { code: "missing-steps", path: "$.workflow.steps[3].args", message: "wordpress.editor-actions requires steps-json=<array>." },
    { code: "invalid-duration", path: "$.workflow.steps[3].args", message: "wordpress.editor-actions wait-timeout must look like 500ms or 2s." },
    { code: "invalid-capture", path: "$.workflow.steps[3].args", message: "wordpress.editor-actions capture does not support: bogus" },
  ])
})

console.log("recipe validation descriptors ok")
