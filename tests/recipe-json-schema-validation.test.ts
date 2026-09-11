import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"

import { captureStdout } from "../packages/cli/src/output.js"
import { runRecipeRunCommand } from "../packages/cli/src/commands/recipe-run.js"
import { RecipeJsonSchemaValidationError, validateWorkspaceRecipeJsonSchema } from "../packages/runtime-core/src/index.js"
import { withTempDir } from "../scripts/test-kit.js"

const extraKeyRecipe = {
  schema: "wp-codebox/workspace-recipe/v1",
  inputs: {
    services: [{
      id: "mysql",
      kind: "mysql",
      configuration: { rootAuthentication: "empty-password", unexpectedFlag: true },
      outputs: { host: "DB_HOST", port: "DB_PORT" },
    }],
  },
  workflow: { steps: [{ command: "wordpress.run-php" }] },
}

const extraKeyResult = validateWorkspaceRecipeJsonSchema(extraKeyRecipe)
assert.equal(extraKeyResult.valid, false)
assert.ok(extraKeyResult.issues.some((issue) => issue.path === "$.inputs.services[0].configuration.unexpectedFlag"), extraKeyResult.issues.map((issue) => issue.path).join("; "))

assert.throws(
  () => {
    throw new RecipeJsonSchemaValidationError("Recipe JSON schema validation failed: $.inputs.services[0].configuration.unexpectedFlag must NOT have additional properties", extraKeyResult.issues)
  },
  (error: unknown) => error instanceof RecipeJsonSchemaValidationError && error.code === "recipe-json-schema-validation-failed",
)

await withTempDir("wp-codebox-recipe-schema-failure-envelope-", async (directory) => {
  const recipePath = join(directory, "recipe.json")
  await writeFile(recipePath, `${JSON.stringify(extraKeyRecipe, null, 2)}\n`)
  const { result: exitCode, logs } = await captureStdout(async () => await runRecipeRunCommand(["--recipe", recipePath, "--json"]))
  assert.equal(exitCode, 1)
  const output = JSON.parse(logs[0])
  assert.equal(output.schema, "wp-codebox/recipe-run/v1")
  assert.equal(output.success, false)
  assert.equal(output.error.code, "recipe-json-schema-validation-failed")
  assert.equal(output.error.name, "RecipeJsonSchemaValidationError")
  assert.match(output.error.message, /configuration\.unexpectedFlag/)
  assert.ok((output.validation?.issues ?? []).some((issue: { path: string }) => issue.path === "$.inputs.services[0].configuration.unexpectedFlag"))
})

console.log("recipe json schema validation envelope ok")
