import assert from "node:assert/strict"
import { resolve } from "node:path"
import { normalizeRuntimeMountTarget, safeArtifactRelativePath } from "../packages/runtime-core/src/index.js"
import { parseWorkspaceRecipe, validateWorkspaceRecipeSemantics } from "../packages/cli/src/recipe-validation.js"
import { withTempDir } from "../scripts/test-kit.js"

assert.equal(normalizeRuntimeMountTarget("//wordpress//wp-content/plugins/plugin"), "/wordpress/wp-content/plugins/plugin")
assert.throws(() => normalizeRuntimeMountTarget("/wordpress/../escape"), /parent-directory/)
assert.equal(safeArtifactRelativePath("/files//output.json"), "files/output.json")
assert.throws(() => safeArtifactRelativePath("files/../secret.txt"), /parent-directory/)

await withTempDir("wp-codebox-path-policy-source-", async (source) => {
const recipePath = resolve(source, "recipe.json")
const recipe = parseWorkspaceRecipe(JSON.stringify({
  schema: "wp-codebox/workspace-recipe/v1",
  runtime: { stack: { mounts: [{ source, target: "//runtime//state" }] } },
  inputs: { mounts: [{ source, target: "//wordpress//wp-content/plugins/plugin" }] },
  distribution: {
    name: "path-policy",
    wordpress: { root: "/wordpress" },
    artifacts: [{ path: "/files//summary.json" }],
  },
  workflow: { steps: [{ command: "inspect-mounted-inputs" }] },
}), recipePath)

assert.deepEqual(await validateWorkspaceRecipeSemantics(recipe, recipePath), [])
assert.throws(() => parseWorkspaceRecipe(JSON.stringify({
  schema: "wp-codebox/workspace-recipe/v1",
  inputs: { mounts: [{ source, target: "/wordpress/../escape" }] },
  workflow: { steps: [{ command: "inspect-mounted-inputs" }] },
}), recipePath), /parent-directory/)

const artifactTraversalRecipe = parseWorkspaceRecipe(JSON.stringify({
  schema: "wp-codebox/workspace-recipe/v1",
  distribution: {
    name: "path-policy",
    wordpress: { root: "/wordpress" },
    artifacts: [{ path: "files/../secret.json" }],
  },
  workflow: { steps: [{ command: "inspect-mounted-inputs" }] },
}), recipePath)
const traversalIssues = await validateWorkspaceRecipeSemantics(artifactTraversalRecipe, recipePath)
assert.equal(traversalIssues[0]?.code, "invalid-distribution-artifact")
})
