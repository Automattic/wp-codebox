import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { runRecipeBuildCommand } from "../packages/cli/src/commands/recipe-build.js"
import {
  buildRuntimePackageRunRecipe,
  CODEBOX_RUN_RUNTIME_PACKAGE_ABILITY,
  normalizeRuntimePackageArtifactDeclarations,
  normalizeRuntimePackageOutputProjections,
  RUNTIME_PACKAGE_ARTIFACT_DECLARATION_SCHEMA,
  RUNTIME_PACKAGE_EXECUTION_INPUT_SCHEMA,
  RUNTIME_PACKAGE_OUTPUT_PROJECTION_SCHEMA,
  runtimePackageExecutionInput,
} from "../packages/runtime-core/src/public.js"
import { withTempDir } from "../scripts/test-kit.js"

const executionInput = runtimePackageExecutionInput({
  runtimePackage: "example/runtime-package",
  input: { prompt: "collect typed outputs" },
  expectedResultSchema: "example/runtime-result/v1",
  artifactDeclarations: [{ name: "report", type: "markdown", path: "files/report.md", required: true, payloadSchema: "example/report/v1" }],
  outputProjections: [{ name: "summary", source: "result.summary", type: "text", required: true }],
  metadata: { caller: "contract-test" },
})

assert.equal(executionInput.schema, RUNTIME_PACKAGE_EXECUTION_INPUT_SCHEMA)
assert.equal(executionInput.runtime_package, "example/runtime-package")
assert.equal(executionInput.artifact_declarations[0].schema, RUNTIME_PACKAGE_ARTIFACT_DECLARATION_SCHEMA)
assert.equal(executionInput.artifact_declarations[0].direction, "output")
assert.equal(executionInput.artifact_declarations[0].payloadSchema, "example/report/v1")
assert.equal(executionInput.output_projections[0].schema, RUNTIME_PACKAGE_OUTPUT_PROJECTION_SCHEMA)
assert.equal(executionInput.output_projections[0].source, "result.summary")

assert.deepEqual(normalizeRuntimePackageArtifactDeclarations([
  { name: "dataset", type: "json", direction: "input", content_type: "application/json", artifact_schema: { type: "object" } },
  { name: "", type: "ignored" },
]), [{
  schema: RUNTIME_PACKAGE_ARTIFACT_DECLARATION_SCHEMA,
  name: "dataset",
  type: "json",
  direction: "input",
  contentType: "application/json",
  payloadSchema: { type: "object" },
  metadata: {},
}])

assert.deepEqual(normalizeRuntimePackageOutputProjections([{ name: "artifactIndex", source: "artifacts.index", path: "files/typed/index.json" }]), [{
  schema: RUNTIME_PACKAGE_OUTPUT_PROJECTION_SCHEMA,
  name: "artifactIndex",
  source: "artifacts.index",
  path: "files/typed/index.json",
  metadata: {},
}])

const recipe = buildRuntimePackageRunRecipe({
  runtimePackage: "example/runtime-package",
  input: { prompt: "collect typed outputs" },
  expectedResultSchema: "example/runtime-result/v1",
  artifactDeclarations: [{ name: "report", type: "markdown" }],
  outputProjections: [{ name: "summary", source: "result.summary" }],
  runtimeEnv: { EXAMPLE_FLAG: true, ignored: "nope" },
  secretEnv: ["EXAMPLE_TOKEN"],
})

assert.equal(recipe.workflow.steps[0].command, "wordpress.ability")
assert.ok(recipe.workflow.steps[0].args?.includes(`name=${CODEBOX_RUN_RUNTIME_PACKAGE_ABILITY}`))
assert.ok(recipe.workflow.steps[0].args?.includes("expected-result-schema=\"example/runtime-result/v1\""))
assert.deepEqual(recipe.inputs?.runtimeEnv, { EXAMPLE_FLAG: "1" })
assert.deepEqual(recipe.inputs?.secretEnv, ["EXAMPLE_TOKEN"])

const inputArg = recipe.workflow.steps[0].args?.find((arg) => arg.startsWith("input="))
assert.ok(inputArg)
const recipeInput = JSON.parse(inputArg.slice("input=".length))
assert.equal(recipeInput.schema, RUNTIME_PACKAGE_EXECUTION_INPUT_SCHEMA)
assert.equal(recipeInput.runtime_package, "example/runtime-package")
assert.equal(recipeInput.artifact_declarations[0].schema, RUNTIME_PACKAGE_ARTIFACT_DECLARATION_SCHEMA)
assert.equal(recipeInput.output_projections[0].schema, RUNTIME_PACKAGE_OUTPUT_PROJECTION_SCHEMA)
assert.doesNotMatch(JSON.stringify(recipe), /agents\/run-runtime-package|datamachine|data machine|homeboy|wpsg|wp-site-generator|wp site generator/i)

await withTempDir("wp-codebox-runtime-package-run-", async (root) => {
  await mkdir(root, { recursive: true })
  const cliOptionsPath = join(root, "runtime-package-options.json")
  const cliRecipePath = join(root, "runtime-package.recipe.json")
  await writeFile(cliOptionsPath, JSON.stringify({
    runtimePackage: "example/runtime-package",
    input: { prompt: "collect typed outputs" },
    artifactDeclarations: [{ name: "report", type: "markdown" }],
    outputProjections: [{ name: "summary", source: "result.summary" }],
  }))

  assert.equal(await runRecipeBuildCommand(["runtime-package-run", "--options", cliOptionsPath, "--output", cliRecipePath]), 0)
  const cliRecipe = JSON.parse(await readFile(cliRecipePath, "utf8"))
  assert.ok(cliRecipe.workflow.steps[0].args.includes(`name=${CODEBOX_RUN_RUNTIME_PACKAGE_ABILITY}`))
})

console.log("runtime package execution ok")
