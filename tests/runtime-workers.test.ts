import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { runRecipeBuildCommand } from "../packages/cli/src/commands/recipe-build.js"
import { planWorkspaceRecipe } from "../packages/cli/src/recipe-dry-run.js"
import { buildWordPressPhpunitRecipe } from "../packages/runtime-core/src/recipe-builders.js"
import { normalizeRuntimeWordPressEnvironmentSpec, validateWorkspaceRecipeJsonSchema, type WorkspaceRecipe } from "../packages/runtime-core/src/index.js"
import { withTempDir } from "../scripts/test-kit.js"

const recipe: WorkspaceRecipe = {
  schema: "wp-codebox/workspace-recipe/v1",
  runtime: { workers: 1 },
  workflow: { steps: [{ command: "wordpress.run-php" }] },
}

assert.equal(validateWorkspaceRecipeJsonSchema(recipe).valid, true)
assert.equal(validateWorkspaceRecipeJsonSchema({ ...recipe, runtime: { workers: "auto" } }).valid, true)
assert.equal(validateWorkspaceRecipeJsonSchema({ ...recipe, runtime: { workers: 0 } }).valid, false)
assert.equal(validateWorkspaceRecipeJsonSchema({ ...recipe, runtime: { workers: 65 } }).valid, false)
assert.equal(validateWorkspaceRecipeJsonSchema({ ...recipe, runtime: { workers: 1.5 } }).valid, false)
assert.deepEqual(normalizeRuntimeWordPressEnvironmentSpec({ kind: "wordpress", workers: 1 }), { kind: "wordpress", workers: 1 })
assert.throws(() => normalizeRuntimeWordPressEnvironmentSpec({ kind: "wordpress", workers: 0 }), /workers must be an integer/)

assert.equal(buildWordPressPhpunitRecipe({ pluginSlug: "example", workers: 1 }).runtime?.workers, 1)
assert.equal(buildWordPressPhpunitRecipe({ pluginSlug: "example", workers: "auto" }).runtime?.workers, "auto")
assert.equal(buildWordPressPhpunitRecipe({ pluginSlug: "example" }).runtime?.workers, undefined)

const plan = await planWorkspaceRecipe(recipe, process.cwd(), { recipePath: "recipe.json" }, {
  defaultWordPressVersion: "latest",
  resolveExecutionSpec: async (step) => ({ command: step.command, args: step.args ?? [] }),
})
assert.equal(plan.runtime.workers, 1)

await withTempDir("wp-codebox-runtime-workers-", async (directory) => {
  const optionsPath = join(directory, "options.json")
  const recipePath = join(directory, "recipe.json")
  await writeFile(optionsPath, JSON.stringify({ pluginSlug: "example", workers: 1 }))
  assert.equal(await runRecipeBuildCommand(["phpunit", "--options", optionsPath, "--output", recipePath]), 0)
  assert.equal((JSON.parse(await readFile(recipePath, "utf8")) as WorkspaceRecipe).runtime?.workers, 1)

  await writeFile(optionsPath, JSON.stringify({ pluginSlug: "example", workers: 0 }))
  await assert.rejects(runRecipeBuildCommand(["phpunit", "--options", optionsPath, "--output", recipePath]), /workers must be an integer/)
})

console.log("runtime workers ok")
