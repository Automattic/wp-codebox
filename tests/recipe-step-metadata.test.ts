import assert from "node:assert/strict"

import { normalizeRecipeRunSummary, validateWorkspaceRecipeJsonSchema, type WorkspaceRecipe } from "../packages/runtime-core/src/index.js"
import { RecipeRunTimeoutError } from "../packages/cli/src/commands/recipe-run-output.js"
import { RecipeRunPhaseExecutor, recipeOperationTimeout } from "../packages/cli/src/commands/recipe-run-phase-executor.js"
import { recipeExecutionSpec } from "../packages/cli/src/agent-sandbox.js"
import { recipeStepFailure, withRecipeExecutionPhase } from "../packages/cli/src/commands/recipe-run-workflow-evidence.js"

const recipe: WorkspaceRecipe = {
  schema: "wp-codebox/workspace-recipe/v1",
  workflow: {
    steps: [{ command: "host/fixture", args: [], timeoutMs: 250, metadata: { fixture: "alpha", matrixIndex: 2 } }],
  },
}

assert.equal(validateWorkspaceRecipeJsonSchema(recipe).valid, true)
assert.equal(validateWorkspaceRecipeJsonSchema({ ...recipe, workflow: { steps: [{ command: "host/fixture", metadata: [] }] } }).valid, false)
assert.equal(validateWorkspaceRecipeJsonSchema({ ...recipe, workflow: { steps: [{ command: "host/fixture", timeoutMs: 0 }] } }).valid, false)

const executionSpec = await recipeExecutionSpec(recipe.workflow.steps[0]!, process.cwd())
assert.equal(executionSpec.timeoutMs, 250)

const execution = withRecipeExecutionPhase({ command: "host/fixture", args: [], exitCode: 0, stdout: "", stderr: "" }, "steps", 0, "host/fixture", undefined, recipe.workflow.steps[0]!.metadata)
assert.deepEqual(execution.recipeStepMetadata, { fixture: "alpha", matrixIndex: 2 })

const summary = normalizeRecipeRunSummary({
  success: true,
  schema: "wp-codebox/recipe-run/v1",
  executions: [execution],
})
assert.deepEqual(summary.commands[0]?.recipe_step_metadata, { fixture: "alpha", matrixIndex: 2 })

const startedAtMs = Date.UTC(2026, 0, 1, 0, 0, 0)
const timeout = new RecipeRunTimeoutError("workflow.steps[0]:host/fixture", 250, 250)
const wrapped = new Error("Recipe workflow steps[0] failed: timed out", { cause: timeout })
const failure = recipeStepFailure({ phase: "steps", index: 0, step: recipe.workflow.steps[0]! }, wrapped, startedAtMs, startedAtMs + 250)
assert.equal(failure.schema, "wp-codebox/recipe-step-failure/v1")
assert.equal(failure.phase, "steps")
assert.equal(failure.index, 0)
assert.equal(failure.command, "host/fixture")
assert.deepEqual(failure.metadata, { fixture: "alpha", matrixIndex: 2 })
assert.equal(failure.startedAt, "2026-01-01T00:00:00.000Z")
assert.equal(failure.finishedAt, "2026-01-01T00:00:00.250Z")
assert.equal(failure.durationMs, 250)
assert.equal(failure.classification, "timeout")
assert.equal(failure.timeoutMs, 250)

const now = Date.now()
assert.deepEqual(recipeOperationTimeout(now, 25_000, 250), { timeoutMs: 250, configuredTimeoutMs: 250 })
const globallyBounded = recipeOperationTimeout(now - 24_900, 25_000, 500)
assert.ok(globallyBounded.timeoutMs > 0 && globallyBounded.timeoutMs <= 100)
assert.equal(globallyBounded.configuredTimeoutMs, 25_000)

let destroyedRuntime = false
const phaseExecutor = new RecipeRunPhaseExecutor({
  context: { startedAtMs: Date.now(), artifactPointer: { update: async () => undefined } } as never,
  timeoutMs: 1_000,
  destroyActiveRuntime: async () => { destroyedRuntime = true },
})
const keepAlive = setTimeout(() => undefined, 100)
try {
  await assert.rejects(
    phaseExecutor.operation("workflow.steps[0]:wordpress.wp-cli", new Promise<never>(() => undefined), 10),
    (error: unknown) => error instanceof RecipeRunTimeoutError && error.timeoutMs === 10,
  )
} finally {
  clearTimeout(keepAlive)
}
assert.equal(destroyedRuntime, true)

console.log("recipe step metadata contract ok")
