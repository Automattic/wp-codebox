import assert from "node:assert/strict"

import { validateWorkspaceRecipeJsonSchema, type ExecutionResult, type WorkspaceRecipe } from "../packages/runtime-core/src/index.js"
import { recipeStepFailureFromExecution, recipeWorkflowStepContinuesOnError } from "../packages/cli/src/commands/recipe-run-workflow-evidence.js"

const recipe: WorkspaceRecipe = {
  schema: "wp-codebox/workspace-recipe/v1",
  workflow: {
    steps: [
      { command: "host/first" },
      { command: "host/fails", continue_on_error: true, metadata: { fixture_id: "fixture-b" } },
      { command: "host/third" },
      { command: "host/fourth" },
    ],
  },
}

assert.equal(validateWorkspaceRecipeJsonSchema(recipe).valid, true)
assert.equal(validateWorkspaceRecipeJsonSchema({ ...recipe, workflow: { steps: [{ command: "host/fails", continue_on_error: "yes" }] } }).valid, false)
assert.equal(recipeWorkflowStepContinuesOnError(recipe.workflow.steps[1]!), true)
assert.equal(recipeWorkflowStepContinuesOnError({ command: "host/fails" }), false)

const executions: ExecutionResult[] = [
  execution("host/first", 0),
  execution("host/fails", 1, "boom"),
  execution("host/third", 0),
  execution("host/fourth", 0),
]
const completed = runSteps(recipe, executions)
assert.equal(completed.length, 4)
assert.equal(completed[1]?.exitCode, 1)

const failure = recipeStepFailureFromExecution({ phase: "steps", index: 1, step: recipe.workflow.steps[1]! }, completed[1]!)
assert.equal(failure.phase, "steps")
assert.equal(failure.index, 1)
assert.equal(failure.command, "host/fails")
assert.deepEqual(failure.metadata, { fixture_id: "fixture-b" })
assert.equal(failure.error.message, "boom")

const fatalRecipe: WorkspaceRecipe = {
  ...recipe,
  workflow: { steps: recipe.workflow.steps.map((step) => ({ ...step, continue_on_error: undefined })) },
}
assert.throws(() => runSteps(fatalRecipe, executions), /Recipe workflow steps\[1\] failed/)

function runSteps(input: WorkspaceRecipe, results: ExecutionResult[]): ExecutionResult[] {
  const completed: ExecutionResult[] = []
  for (const [index, step] of input.workflow.steps.entries()) {
    const result = results[index]!
    completed.push(result)
    if (result.exitCode !== 0 && !recipeWorkflowStepContinuesOnError(step)) {
      throw new Error(`Recipe workflow steps[${index}] failed: command exited with code ${result.exitCode}`)
    }
  }
  return completed
}

function execution(command: string, exitCode: number, stderr = ""): ExecutionResult {
  return {
    id: command,
    command,
    args: [],
    exitCode,
    stdout: "",
    stderr,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:00.010Z",
  }
}

console.log("recipe step continue_on_error contract ok")
