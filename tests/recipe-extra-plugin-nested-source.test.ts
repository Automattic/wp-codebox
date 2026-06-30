import assert from "node:assert/strict"
import { mkdir, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { validateWorkspaceRecipeSemantics } from "../packages/cli/src/recipe-validation.js"
import { prepareRecipeExtraPlugins } from "../packages/cli/src/recipe-sources.js"
import { assertWorkspaceRecipeJsonSchema, type WorkspaceRecipe } from "../packages/runtime-core/src/index.js"
import { withTempDir } from "../scripts/test-kit.js"

await withTempDir("wp-codebox-nested-extra-plugin-", async (recipeDirectory) => {
  const repo = join(recipeDirectory, "repo")
  await mkdir(join(repo, "packages", "example-plugin", "includes"), { recursive: true })
  await writeFile(join(repo, "packages", "example-plugin", "example-plugin.php"), "<?php\n/* Plugin Name: Example Plugin */\n")
  await writeFile(join(repo, "packages", "example-plugin", "includes", "class-example.php"), "<?php\n")

  const recipe: WorkspaceRecipe = {
    schema: "wp-codebox/workspace-recipe/v1",
    inputs: {
      extra_plugins: [{
        sourcePath: "repo",
        sourceSubdir: "packages/example-plugin",
        mountSlug: "example-plugin",
        pluginFile: "example-plugin/example-plugin.php",
      }],
    },
    workflow: { steps: [{ command: "inspect-mounted-inputs" }] },
  }

  assertWorkspaceRecipeJsonSchema(recipe)
  assert.deepEqual(await validateWorkspaceRecipeSemantics(recipe, join(recipeDirectory, "recipe.json")), [])

  const [plugin] = await prepareRecipeExtraPlugins(recipe, recipeDirectory)
  assert.ok(plugin)
  assert.equal(plugin.slug, "example-plugin")
  assert.equal(plugin.target, "/wordpress/wp-content/plugins/example-plugin")
  assert.equal(plugin.pluginFile, "example-plugin/example-plugin.php")
  assert.equal(plugin.metadata?.sourceRoot, "repo")
  assert.equal(plugin.metadata?.sourceSubpath, "packages/example-plugin")
  assert.equal((await stat(join(plugin.source, "example-plugin.php"))).isFile(), true)
})

await withTempDir("wp-codebox-nested-extra-plugin-invalid-", async (recipeDirectory) => {
  const repo = join(recipeDirectory, "repo")
  await mkdir(join(repo, "plugins", "nested-plugin"), { recursive: true })
  await writeFile(join(repo, "plugins", "nested-plugin", "nested-plugin.php"), "<?php\n/* Plugin Name: Nested Plugin */\n")

  const baseRecipe = (extraPlugin: WorkspaceRecipe["inputs"] extends infer Inputs ? Inputs extends { extra_plugins?: Array<infer Plugin> } ? Plugin : never : never): WorkspaceRecipe => ({
    schema: "wp-codebox/workspace-recipe/v1",
    inputs: { extra_plugins: [extraPlugin] },
    workflow: { steps: [{ command: "inspect-mounted-inputs" }] },
  })

  const cases: Array<{ name: string, plugin: NonNullable<WorkspaceRecipe["inputs"]>["extra_plugins"][number], issue: string }> = [
    {
      name: "path traversal sourceSubdir",
      plugin: { sourcePath: "repo", sourceSubdir: "../outside", mountSlug: "nested-plugin", pluginFile: "nested-plugin/nested-plugin.php" },
      issue: "invalid-source-subdir",
    },
    {
      name: "missing sourceSubdir",
      plugin: { sourcePath: "repo", sourceSubdir: "plugins/missing-plugin", mountSlug: "nested-plugin", pluginFile: "nested-plugin/nested-plugin.php" },
      issue: "missing-path",
    },
    {
      name: "pluginFile outside mount slug",
      plugin: { sourcePath: "repo", sourceSubdir: "plugins/nested-plugin", mountSlug: "nested-plugin", pluginFile: "other-plugin/nested-plugin.php" },
      issue: "invalid-plugin-file",
    },
  ]

  for (const testCase of cases) {
    const issues = await validateWorkspaceRecipeSemantics(baseRecipe(testCase.plugin), join(recipeDirectory, `${testCase.name}.json`))
    assert.ok(issues.some((issue) => issue.code === testCase.issue), `${testCase.name} reports ${testCase.issue}`)
  }
})

console.log("recipe extra plugin nested source ok")
