import assert from "node:assert/strict"
import { mkdir, stat, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import { captureStdout } from "../packages/cli/src/output.js"
import { runRecipeRunCommand } from "../packages/cli/src/commands/recipe-run.js"
import { recipeArtifactsMountConflict } from "../packages/cli/src/commands/recipe-run-artifacts-mount-guard.js"
import type { WorkspaceRecipe } from "../packages/runtime-core/src/index.js"
import { withTempDir } from "../scripts/test-kit.js"

await withTempDir("wp-codebox-recipe-artifacts-mount-guard-", async (recipeDirectory) => {
  const mountedSource = join(recipeDirectory, "mounted-source")
  const outsideArtifacts = join(recipeDirectory, "artifacts-outside")
  await mkdir(join(mountedSource, "nested"), { recursive: true })
  await mkdir(outsideArtifacts, { recursive: true })

  const recipe: WorkspaceRecipe = {
    schema: "wp-codebox/workspace-recipe/v1",
    inputs: {
      mounts: [
        { source: "mounted-source", target: "/wordpress/wp-content/plugins/example", mode: "readwrite" },
      ],
    },
    workflow: { steps: [{ command: "host/test", args: [] }] },
  }

  assert.equal(recipeArtifactsMountConflict(recipe, recipeDirectory, outsideArtifacts), undefined)

  assert.deepEqual(recipeArtifactsMountConflict(recipe, recipeDirectory, mountedSource), {
    artifactsDirectory: resolve(mountedSource),
    mountSource: resolve(mountedSource),
    mountPath: "$.inputs.mounts[0].source",
    mountKind: "input-mount",
  })

  assert.deepEqual(recipeArtifactsMountConflict(recipe, recipeDirectory, join(mountedSource, "nested", "artifacts")), {
    artifactsDirectory: resolve(mountedSource, "nested", "artifacts"),
    mountSource: resolve(mountedSource),
    mountPath: "$.inputs.mounts[0].source",
    mountKind: "input-mount",
  })

  const recipePath = join(recipeDirectory, "recipe.json")
  const conflictingArtifacts = join(mountedSource, "nested", "command-artifacts")
  await writeFile(recipePath, `${JSON.stringify(recipe, null, 2)}\n`)

  const { result: exitCode, logs } = await captureStdout(async () => await runRecipeRunCommand(["--recipe", recipePath, "--artifacts", conflictingArtifacts, "--json"]))
  assert.equal(exitCode, 1)
  const output = JSON.parse(logs[0])
  assert.equal(output.success, false)
  assert.equal(output.error.code, "recipe-artifacts-mount-conflict")
  assert.equal(output.error.conflict.artifactsDirectory, resolve(conflictingArtifacts))
  assert.equal(output.error.conflict.mountSource, resolve(mountedSource))
  assert.equal(await pathExists(conflictingArtifacts), false)
})

console.log("recipe run artifacts mount guard ok")

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
