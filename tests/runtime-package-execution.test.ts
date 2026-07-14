import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { runRecipeBuildCommand } from "../packages/cli/src/commands/recipe-build.js"
import {
  buildRuntimePackageRunRecipe,
  CODEBOX_RUN_RUNTIME_PACKAGE_ABILITY,
  normalizeRuntimePackageArtifactDeclarations,
  normalizeRuntimePackageOutputProjections,
  normalizeRuntimePackageResult,
  normalizeRuntimePackageTask,
  RUNTIME_PACKAGE_ARTIFACT_DECLARATION_SCHEMA,
  RUNTIME_PACKAGE_EXECUTION_INPUT_SCHEMA,
  RUNTIME_PACKAGE_OUTPUT_PROJECTION_SCHEMA,
  RUNTIME_PACKAGE_RESULT_SCHEMA,
  RUNTIME_PACKAGE_TASK_SCHEMA,
  runtimePackageExecutionInput,
  validateRuntimePackageTask,
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

const task = normalizeRuntimePackageTask({
  package: { slug: "example-agent", source: "bundles/example-agent" },
  workspaceRoot: "/workspace/example-project",
  input: { prompt: "collect typed outputs" },
  artifact_declarations: [{ name: "report", type: "markdown", required: true, path: "files/report.md" }],
  output_projections: [{ name: "summary", source: "result.summary", type: "text", required: true }],
  metadata: { caller: "contract-test" },
})
assert.equal(task.schema, RUNTIME_PACKAGE_TASK_SCHEMA)
assert.deepEqual(task.package, { slug: "example-agent", source: "/workspace/example-project/bundles/example-agent" })
assert.deepEqual(task.workflow, { id: "example-agent" })
assert.deepEqual(task.required_artifacts, ["report"])
assert.deepEqual(validateRuntimePackageTask(task), { valid: true, task, diagnostics: [] })

const optionalArtifactTask = normalizeRuntimePackageTask({
  package: { slug: "example-agent", source: "/workspace/example-agent" },
  input: {},
  artifact_declarations: [
    { name: "optional-report", type: "markdown", required: false },
    { name: "required-report", type: "markdown", required: true },
  ],
  required_artifacts: ["optional-report"],
})
assert.deepEqual(optionalArtifactTask.required_artifacts, ["required-report"], "required artifacts derive only from required declarations")
const undeclaredRequired = validateRuntimePackageTask({ ...optionalArtifactTask, required_artifacts: ["optional-report"] })
assert.equal(undeclaredRequired.valid, false)
assert.equal(undeclaredRequired.diagnostics.at(-1)?.code, "undeclared_required_artifact")

const missingPublicFields = validateRuntimePackageTask({ schema: RUNTIME_PACKAGE_TASK_SCHEMA, package: { slug: "example-agent" } })
assert.equal(missingPublicFields.valid, false)
assert.deepEqual(missingPublicFields.diagnostics.map((diagnostic) => diagnostic.code), [
  "missing_package_source",
  "missing_workflow_id",
  "missing_input",
  "missing_artifact_declarations",
  "missing_required_artifacts",
])

const unnormalizedTask = { ...task, package: { slug: "example-agent", source: "bundles/example-agent" } }
const unnormalizedValidation = validateRuntimePackageTask(unnormalizedTask)
assert.equal(unnormalizedValidation.valid, false)
assert.equal(unnormalizedValidation.diagnostics[0].code, "workspace_root_required")

const validFixture = JSON.parse(await readFile(new URL("./fixtures/runtime-package-valid-task-result.json", import.meta.url), "utf8"))
assert.deepEqual(validateRuntimePackageTask(validFixture.task), { valid: true, task: validFixture.task, diagnostics: [] })
assert.deepEqual(normalizeRuntimePackageResult(validFixture.result), validFixture.result)

const missingBundleFixture = JSON.parse(await readFile(new URL("./fixtures/runtime-package-missing-bundle-failure.json", import.meta.url), "utf8"))
assert.equal(normalizeRuntimePackageResult(missingBundleFixture).schema, RUNTIME_PACKAGE_RESULT_SCHEMA)
assert.equal(normalizeRuntimePackageResult(missingBundleFixture).diagnostics[0].code, "runtime_package_import_failed")

const missingArtifactFixture = JSON.parse(await readFile(new URL("./fixtures/runtime-package-missing-required-artifact-failure.json", import.meta.url), "utf8"))
const missingArtifactResult = normalizeRuntimePackageResult(missingArtifactFixture)
assert.equal(missingArtifactResult.success, false)
assert.equal(missingArtifactResult.outputs.summary, "The semantic result is still preserved when artifact validation fails.")
assert.equal(missingArtifactResult.diagnostics[0].code, "runtime_package_required_artifact_missing")

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
