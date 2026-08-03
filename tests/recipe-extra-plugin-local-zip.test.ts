import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

import { validateWorkspaceRecipeSemantics } from "../packages/cli/src/recipe-validation.js"
import { cleanupRecipePreparedSources, prepareRecipeExtraPlugins } from "../packages/cli/src/recipe-sources.js"
import type { WorkspaceRecipe } from "../packages/runtime-core/src/index.js"
import { withTempDir } from "../scripts/test-kit.js"

const execFileAsync = promisify(execFile)

async function zip(directory: string, archive: string, entries: string[]): Promise<void> {
  await execFileAsync("zip", ["-q", archive, ...entries], { cwd: directory })
}

function recipe(source: string, slug: string, sha256?: string): WorkspaceRecipe {
  return {
    schema: "wp-codebox/workspace-recipe/v1",
    inputs: { extra_plugins: [{ source, slug, pluginFile: `${slug}/${slug}.php`, ...(sha256 ? { sha256 } : {}) }] },
    workflow: { steps: [{ command: "inspect-mounted-inputs" }] },
  }
}

await withTempDir("wp-codebox-local-zip-plugin-", async (recipeDirectory) => {
  await mkdir(join(recipeDirectory, "nested-plugin"))
  await writeFile(join(recipeDirectory, "nested-plugin", "nested-plugin.php"), "<?php\n/* Plugin Name: Nested */\n")
  await zip(recipeDirectory, "nested.zip", ["nested-plugin/nested-plugin.php"])
  const digest = createHash("sha256").update(await readFile(join(recipeDirectory, "nested.zip"))).digest("hex")
  const nestedRecipe = recipe("nested.zip", "nested-plugin", digest)

  assert.deepEqual(await validateWorkspaceRecipeSemantics(nestedRecipe, join(recipeDirectory, "recipe.json")), [])
  const [nested] = await prepareRecipeExtraPlugins(nestedRecipe, recipeDirectory)
  assert.equal((await stat(join(nested.source, "nested-plugin.php"))).isFile(), true)
  assert.deepEqual(nested.provenance.digest, { sha256: digest, expected: digest, verified: true })
  assert.equal(nested.provenance.kind, "local")
  assert.equal(nested.cleanupPaths.length, 1)
  await cleanupRecipePreparedSources([], [nested])

  await writeFile(join(recipeDirectory, "flat-plugin.php"), "<?php\n/* Plugin Name: Flat */\n")
  await zip(recipeDirectory, "flat.zip", ["flat-plugin.php"])
  const flatRecipe = recipe("flat.zip", "flat-plugin")
  assert.deepEqual(await validateWorkspaceRecipeSemantics(flatRecipe, join(recipeDirectory, "flat.json")), [])
  const [flat] = await prepareRecipeExtraPlugins(flatRecipe, recipeDirectory)
  assert.equal((await stat(join(flat.source, "flat-plugin.php"))).isFile(), true)
  await cleanupRecipePreparedSources([], [flat])

  await assert.rejects(() => prepareRecipeExtraPlugins(recipe("nested.zip", "nested-plugin", "0".repeat(64)), recipeDirectory), /sha256 mismatch/)
})

await withTempDir("wp-codebox-local-zip-rejections-", async (recipeDirectory) => {
  await writeFile(join(recipeDirectory, "outside.php"), "<?php\n")
  await mkdir(join(recipeDirectory, "inside"))
  await execFileAsync("zip", ["-q", "unsafe.zip", "../outside.php"], { cwd: join(recipeDirectory, "inside") })
  await assert.rejects(() => prepareRecipeExtraPlugins(recipe("inside/unsafe.zip", "unsafe"), recipeDirectory), /unsafe path/)

  await writeFile(join(recipeDirectory, "large-plugin.php"), Buffer.alloc(2048, "x"))
  await zip(recipeDirectory, "large.zip", ["large-plugin.php"])
  const previousLimit = process.env.WP_CODEBOX_MAX_EXTRACTED_BYTES
  process.env.WP_CODEBOX_MAX_EXTRACTED_BYTES = "1024"
  try {
    await assert.rejects(() => prepareRecipeExtraPlugins(recipe("large.zip", "large-plugin"), recipeDirectory), /extraction exceeds 1024 bytes/)
  } finally {
    if (previousLimit === undefined) delete process.env.WP_CODEBOX_MAX_EXTRACTED_BYTES
    else process.env.WP_CODEBOX_MAX_EXTRACTED_BYTES = previousLimit
  }

  await mkdir(join(recipeDirectory, "directory.zip"))
  const issues = await validateWorkspaceRecipeSemantics(recipe("directory.zip", "directory"), join(recipeDirectory, "directory.json"))
  assert.ok(issues.some((issue) => issue.code === "not-file"))
  await assert.rejects(() => prepareRecipeExtraPlugins(recipe("directory.zip", "directory"), recipeDirectory), /regular file/)

  await symlink(join(recipeDirectory, "large.zip"), join(recipeDirectory, "symlink.zip"))
  await assert.rejects(() => prepareRecipeExtraPlugins(recipe("symlink.zip", "symlink"), recipeDirectory), /regular file/)
})

await withTempDir("wp-codebox-local-zip-policy-", async (recipeDirectory) => {
  await writeFile(join(recipeDirectory, "plugin.php"), "<?php\n")
  await zip(recipeDirectory, "plugin.zip", ["plugin.php"])
  const previousRequirement = process.env.WP_CODEBOX_REQUIRE_SOURCE_SHA256
  process.env.WP_CODEBOX_REQUIRE_SOURCE_SHA256 = "1"
  try {
    const issues = await validateWorkspaceRecipeSemantics(recipe("plugin.zip", "plugin"), join(recipeDirectory, "recipe.json"))
    assert.ok(issues.some((issue) => issue.code === "missing-source-sha256"))
    await assert.rejects(() => prepareRecipeExtraPlugins(recipe("plugin.zip", "plugin"), recipeDirectory), /require sha256/)
  } finally {
    if (previousRequirement === undefined) delete process.env.WP_CODEBOX_REQUIRE_SOURCE_SHA256
    else process.env.WP_CODEBOX_REQUIRE_SOURCE_SHA256 = previousRequirement
  }
})

console.log("recipe extra plugin local ZIP sources ok")
