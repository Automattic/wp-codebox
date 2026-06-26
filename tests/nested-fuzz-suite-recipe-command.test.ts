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

console.log("nested fuzz suite recipe command ok")
