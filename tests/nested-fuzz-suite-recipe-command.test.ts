import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { assertWorkspaceRecipeJsonSchema, fuzzSuiteContract, type ExecutionResult, type ExecutionSpec, type Runtime, type WorkspaceRecipe } from "../packages/runtime-core/src/index.js"
import { executeRecipeWorkflowStep } from "../packages/cli/src/commands/recipe-run-workflow-evidence.js"

const suite = fuzzSuiteContract({
  id: "nested-workload-suite",
  cases: [{
    id: "case-one",
    target: { kind: "runtime", id: "wordpress.run-workload", entrypoint: "wordpress.run-workload" },
    input: {
      schema: "wp-codebox/wordpress-workload-run/v1",
      steps: [{ command: "wordpress.run-php", args: ["code=echo 'ok';"] }],
    },
  }],
})

const recipe: WorkspaceRecipe = {
  schema: "wp-codebox/workspace-recipe/v1",
  workflow: {
    steps: [{ command: "wp-codebox/run-fuzz-suite", args: [`input-json=${JSON.stringify(suite)}`] }],
  },
}

assertWorkspaceRecipeJsonSchema(recipe, { recipeCommandIds: ["wp-codebox/run-fuzz-suite", "wordpress.run-php"] })

const executed: ExecutionSpec[] = []
const runtime = {
  async execute(spec: ExecutionSpec): Promise<ExecutionResult> {
    executed.push(spec)
    return {
      id: `exec-${executed.length}`,
      command: spec.command,
      args: spec.args ?? [],
      exitCode: 0,
      stdout: "ok\n",
      stderr: "",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
    }
  },
} as Runtime

const execution = await executeRecipeWorkflowStep(runtime, { phase: "steps", index: 0, step: recipe.workflow.steps[0]! }, process.cwd())
const result = JSON.parse(execution.stdout)

assert.equal(execution.command, "wp-codebox/run-fuzz-suite")
assert.equal(execution.exitCode, 0)
assert.equal(result.schema, "wp-codebox/fuzz-suite-result/v1")
assert.equal(result.status, "passed")
assert.deepEqual(executed.map((spec) => spec.command), ["wordpress.run-php"])

const suiteAliasDir = await mkdtemp(join(tmpdir(), "wp-codebox-nested-fuzz-suite-alias-"))
await writeFile(join(suiteAliasDir, "suite.json"), JSON.stringify(suite), "utf8")
const suiteAliasRecipe: WorkspaceRecipe = {
  schema: "wp-codebox/workspace-recipe/v1",
  workflow: {
    steps: [{ command: "wp-codebox/run-fuzz-suite", args: ["suite=suite.json"] }],
  },
}
assertWorkspaceRecipeJsonSchema(suiteAliasRecipe, { recipeCommandIds: ["wp-codebox/run-fuzz-suite", "wordpress.run-php"] })
const aliasExecution = await executeRecipeWorkflowStep(runtime, { phase: "steps", index: 0, step: suiteAliasRecipe.workflow.steps[0]! }, suiteAliasDir)
const aliasResult = JSON.parse(aliasExecution.stdout)

assert.equal(aliasExecution.command, "wp-codebox/run-fuzz-suite")
assert.equal(aliasExecution.exitCode, 0)
assert.equal(aliasResult.schema, "wp-codebox/fuzz-suite-result/v1")
assert.equal(aliasResult.status, "passed")

executed.length = 0
const phpWorkloadSuite = fuzzSuiteContract({
  id: "nested-php-workload-suite",
  cases: [{
    id: "php-file-case",
    target: { kind: "runtime", id: "wordpress.run-workload", entrypoint: "wordpress.run-workload" },
    input: {
      schema: "wp-codebox/wordpress-workload-run/v1",
      steps: [{ command: "wordpress.run-workload", args: ["path=/tmp/workload.php", "type=php"] }],
    },
  }],
})
const phpExecution = await executeRecipeWorkflowStep(runtime, { phase: "steps", index: 0, step: { command: "wp-codebox/run-fuzz-suite", args: [`input-json=${JSON.stringify(phpWorkloadSuite)}`] } }, process.cwd())
assert.equal(phpExecution.exitCode, 0)
assert.deepEqual(executed.map((spec) => spec.command), ["wordpress.run-php"])
assert.match(executed[0]?.args?.[0] ?? "", /require "\/tmp\/workload\.php"/)

executed.length = 0
const typedWorkloadSuite = fuzzSuiteContract({
  id: "nested-typed-workload-suite",
  metadata: { runtime_requirements: { extra_plugins: [{ slug: "woocommerce" }] } },
  cases: [{
    id: "typed-workload-case",
    target: { kind: "runtime", id: "wordpress.run-workload", entrypoint: "wordpress.run-workload" },
    input: {
      schema: "wp-codebox/wordpress-workload-run/v1",
      steps: [{ type: "php", code: "return array('ok' => true);" }],
    },
  }],
})
const typedExecution = await executeRecipeWorkflowStep(runtime, { phase: "steps", index: 0, step: { command: "wp-codebox/run-fuzz-suite", args: [`input-json=${JSON.stringify(typedWorkloadSuite)}`] } }, process.cwd())
assert.equal(typedExecution.exitCode, 0)
assert.deepEqual(executed.map((spec) => spec.command), ["wordpress.bench"])
assert.ok(executed[0]?.args?.includes("plugin-slug=woocommerce"))

executed.length = 0
const typedJsonPathWorkloadSuite = fuzzSuiteContract({
  id: "nested-typed-json-path-workload-suite",
  metadata: { runtime_requirements: { extra_plugins: [{ slug: "woocommerce" }] } },
  cases: [{
    id: "typed-json-path-workload-case",
    target: { kind: "runtime", id: "wordpress.run-workload", entrypoint: "wordpress.run-workload" },
    input: {
      schema: "wp-codebox/wordpress-workload-run/v1",
      steps: [{ type: "php", code: "return array('ok' => true);" }],
      metadata: { source_path: "/tmp/rest-db-query-profile.workload.json", source_entry: "rest-db-query-profile" },
    },
  }],
})
const typedJsonPathExecution = await executeRecipeWorkflowStep(runtime, { phase: "steps", index: 0, step: { command: "wp-codebox/run-fuzz-suite", args: [`input-json=${JSON.stringify(typedJsonPathWorkloadSuite)}`] } }, process.cwd())
assert.equal(typedJsonPathExecution.exitCode, 0)
assert.deepEqual(executed.map((spec) => spec.command), ["wordpress.bench"])
assert.ok(executed[0]?.args?.includes("plugin-slug=woocommerce"))

executed.length = 0
const directJsonWorkload: WorkspaceRecipe = {
  schema: "wp-codebox/workspace-recipe/v1",
  workflow: {
    steps: [{ command: "wordpress.run-workload", args: [`workload-json=${JSON.stringify({ schema: "wp-codebox/wordpress-workload-run/v1", steps: [{ command: "wordpress.run-php", args: ["code=echo 'json workload';"] }] })}`] }],
  },
}
assertWorkspaceRecipeJsonSchema(directJsonWorkload, { recipeCommandIds: ["wordpress.run-workload", "wordpress.run-php"] })
const directJsonExecution = await executeRecipeWorkflowStep(runtime, { phase: "steps", index: 0, step: directJsonWorkload.workflow.steps[0]! }, process.cwd())
const directJsonResult = JSON.parse(directJsonExecution.stdout)
assert.equal(directJsonExecution.command, "wordpress.run-workload")
assert.equal(directJsonExecution.exitCode, 0)
assert.equal(directJsonResult.schema, "wp-codebox/wordpress-workload-run-result/v1")
assert.equal(directJsonResult.steps, 1)
assert.deepEqual(executed.map((spec) => spec.command), ["wordpress.run-php"])

executed.length = 0
const nestedJsonWorkloadSuite = fuzzSuiteContract({
  id: "nested-json-workload-suite",
  cases: [{
    id: "json-workload-case",
    target: { kind: "runtime", id: "wordpress.run-workload", entrypoint: "wordpress.run-workload" },
    input: {
      schema: "wp-codebox/wordpress-workload-run/v1",
      steps: [{ command: "wordpress.run-workload", args: [`workload-json=${JSON.stringify({ schema: "wp-codebox/wordpress-workload-run/v1", steps: [{ command: "wordpress.run-php", args: ["code=echo 'nested json workload';"] }] })}`] }],
    },
  }],
})
const nestedJsonExecution = await executeRecipeWorkflowStep(runtime, { phase: "steps", index: 0, step: { command: "wp-codebox/run-fuzz-suite", args: [`input-json=${JSON.stringify(nestedJsonWorkloadSuite)}`] } }, process.cwd())
const nestedJsonResult = JSON.parse(nestedJsonExecution.stdout)
assert.equal(nestedJsonExecution.exitCode, 0)
assert.equal(nestedJsonResult.status, "passed")
assert.deepEqual(executed.map((spec) => spec.command), ["wordpress.run-php"])

console.log("nested fuzz suite recipe command ok")
