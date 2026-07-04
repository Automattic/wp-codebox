import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { captureStdout } from "../packages/cli/src/output.js"
import { runRecipeRunCommand } from "../packages/cli/src/commands/recipe-run.js"
import { withTempDir } from "../scripts/test-kit.js"

await withTempDir("wp-codebox-recipe-run-output-file-", async (directory) => {
  const recipePath = join(directory, "recipe.json")
  const outputPath = join(directory, "nested", "recipe-run-output.json")
  await writeFile(recipePath, `${JSON.stringify({
    schema: "wp-codebox/workspace-recipe/v1",
    workflow: { steps: [{ command: "host/test", args: ["--ok"] }] },
  }, null, 2)}\n`)

  const withoutOutput = await captureStdout(async () => await runRecipeRunCommand(["--recipe", recipePath, "--dry-run", "--json"]))
  assert.equal(withoutOutput.result, 0)
  assert.equal(withoutOutput.logs.length, 1)
  const stdoutEnvelope = JSON.parse(withoutOutput.logs[0])
  assert.equal(stdoutEnvelope.schema, "wp-codebox/recipe-run-dry-run/v1")
  assert.equal(stdoutEnvelope.recipePath, recipePath)

  const withOutput = await captureStdout(async () => await runRecipeRunCommand(["--recipe", recipePath, "--dry-run", "--json", "--output", outputPath]))
  assert.equal(withOutput.result, 0)
  assert.equal(withOutput.logs.length, 1)
  const summary = JSON.parse(withOutput.logs[0])
  assert.equal(summary.schema, "wp-codebox/recipe-run-output/v1")
  assert.equal(summary.success, true)
  assert.equal(summary.output, outputPath)

  const fileEnvelope = JSON.parse(await readFile(outputPath, "utf8"))
  assert.deepEqual(fileEnvelope, stdoutEnvelope)
})

console.log("recipe run output file ok")
