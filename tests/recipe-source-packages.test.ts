import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseWorkspaceRecipe, validateWorkspaceRecipe } from "../packages/cli/src/recipe-validation.js"
import { prepareRecipeStagedFiles } from "../packages/cli/src/recipe-sources.js"
import { compileRecipeTemplate } from "../packages/runtime-core/src/index.js"

const recipeDirectory = mkdtempSync(join(tmpdir(), "wp-codebox-source-package-test-"))
const sourceDirectory = join(recipeDirectory, "source")
mkdirSync(join(sourceDirectory, "src", "secrets"), { recursive: true })
writeFileSync(join(sourceDirectory, "src", "index.php"), "<?php echo 'ok';\n")
writeFileSync(join(sourceDirectory, "src", "secrets", "key.php"), "<?php echo 'secret';\n")
writeFileSync(join(sourceDirectory, ".env"), "TOKEN=secret\n")

const compiled = compileRecipeTemplate({
  recipe: {
    schema: "wp-codebox/workspace-recipe/v1",
    workflow: { steps: [{ command: "inspect-mounted-inputs" }] },
  },
  sourcePackages: [{ name: "fixture", source: "./source", target: "fixtures/plugin", allow: ["src*"], deny: ["src/secrets*"], artifact: true }],
})

assert.deepEqual(compiled.blockers, [])
assert.equal(compiled.recipe.inputs?.sourcePackages?.[0]?.target, "fixtures/plugin")
assert.equal(compiled.sourcePackages[0]?.stagedFile.target, "/workspace/fixtures/plugin")
assert.equal(compiled.recipe.artifacts?.paths?.[0]?.path, "/workspace/fixtures/plugin/.wp-codebox-source-package.json")

const recipe = parseWorkspaceRecipe(JSON.stringify(compiled.recipe), join(recipeDirectory, "recipe.json"))
const issues = await validateWorkspaceRecipe(recipe, join(recipeDirectory, "recipe.json"))
assert.deepEqual(issues, [])

const stagedFiles = await prepareRecipeStagedFiles(recipe, recipeDirectory)
const sourcePackage = stagedFiles.find((stagedFile) => stagedFile.metadata.kind === "source-package")
assert.ok(sourcePackage)
assert.equal(sourcePackage.target, "/workspace/fixtures/plugin")
assert.equal(sourcePackage.type, "directory")
assert.ok((sourcePackage.metadata.digest as { sha256?: string }).sha256)
assert.equal((await stat(join(sourcePackage.source, "src", "index.php"))).isFile(), true)
await assert.rejects(stat(join(sourcePackage.source, "src", "secrets", "key.php")))
await assert.rejects(stat(join(sourcePackage.source, ".env")))

const provenance = JSON.parse(await readFile(join(sourcePackage.source, ".wp-codebox-source-package.json"), "utf8"))
assert.equal(provenance.schema, "wp-codebox/source-package-provenance/v1")
assert.equal(provenance.name, "fixture")
assert.equal(provenance.target, "/workspace/fixtures/plugin")
