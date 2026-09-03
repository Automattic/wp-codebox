import assert from "node:assert/strict"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { WorkspaceRecipe } from "../packages/runtime-core/src/index.js"
import { captureStdout } from "../packages/cli/src/output.js"
import { createRecipeRunOptions, executeRecipeRun, runRecipeRunCommand } from "../packages/cli/src/commands/recipe-run.js"
import { withTempDir } from "../scripts/test-kit.js"

await withTempDir("wp-codebox-recipe-execution-boundary-", async (directory) => {
  const mountedSource = join(directory, "mounted-source")
  const artifactsDirectory = join(mountedSource, "artifacts")
  const recipePath = join(directory, "recipe.json")
  const recipe: WorkspaceRecipe = {
    schema: "wp-codebox/workspace-recipe/v1",
    inputs: {
      mounts: [{ source: "mounted-source", target: "/wordpress/wp-content/plugins/example", mode: "readwrite" }],
    },
    workflow: { steps: [{ command: "host/test", args: [] }] },
  }
  await mkdir(mountedSource, { recursive: true })
  await writeFile(recipePath, `${JSON.stringify(recipe, null, 2)}\n`)

  const cli = await captureStdout(() => runRecipeRunCommand(["--recipe", recipePath, "--artifacts", artifactsDirectory, "--json"]))
  assert.equal(cli.result, 1)
  const cliOutput = JSON.parse(cli.logs.join(""))

  await rm(recipePath)
  const options = createRecipeRunOptions({ recipePath, recipe, recipeDirectory: directory, artifactsDirectory })
  const typedOutput = await executeRecipeRun(options)

  assert.equal(options.timeoutMs, 25 * 60 * 1000)
  assert.equal(typedOutput.success, false)
  assert.deepEqual(typedOutput, cliOutput)
})

console.log("recipe execution boundary ok")
