import assert from "node:assert/strict"

import { assertWorkspaceRecipeJsonSchema, type WorkspaceRecipe } from "../packages/runtime-core/src/index.js"
import { recipeFuzzRunResult } from "../packages/cli/src/commands/recipe-run.js"
import { recipeWorkflowSteps, validateWorkspaceRecipeShape, validateWorkspaceRecipeSemantics } from "../packages/cli/src/recipe-validation.js"
import type { RecipeExecutionResult } from "../packages/cli/src/commands/recipe-run-types.js"

const recipe: WorkspaceRecipe = {
  schema: "wp-codebox/workspace-recipe/v1",
  workflow: {
    steps: [{ command: "inspect-mounted-inputs" }],
  },
  fuzzRun: {
    schema: "wp-codebox/fuzz-run/v1",
    cases: [
      {
        case_id: "case-001",
        input: { path: "/example" },
        inputHash: { algorithm: "sha256", value: "abc123" },
        metadata: { source: "fixture" },
        phases: {
          setup: [{ command: "wordpress.run-php", args: ["code=update_option('fuzz_case','case-001');"] }],
          action: [{ command: "wordpress.wp-cli", args: ["command=option get fuzz_case"] }],
          assert: [{ command: "wordpress.run-php", args: ["code=if (get_option('fuzz_case') !== 'case-001') { exit(1); }"] }],
          teardown: [{ command: "wordpress.run-php", args: ["code=delete_option('fuzz_case');"] }],
        },
        artifacts: [{ name: "case-log", path: "/tmp/wp-codebox/fuzz/case-001.json", required: false }],
        replay: { seed: "seed-001", inputRef: "fixtures/cases/case-001.json" },
      },
    ],
  },
}

assertWorkspaceRecipeJsonSchema(recipe, { recipeCommandIds: ["inspect-mounted-inputs", "wordpress.run-php", "wordpress.wp-cli"] })
validateWorkspaceRecipeShape(recipe, "recipe.json")
assert.deepEqual(await validateWorkspaceRecipeSemantics(recipe, "recipe.json"), [])

const fuzzWorkflowSteps = recipeWorkflowSteps(recipe).filter((step) => step.fuzzCaseId === "case-001")
assert.deepEqual(fuzzWorkflowSteps.map((step) => step.phase), ["fuzz:setup", "fuzz:action", "fuzz:assert", "fuzz:teardown"])
assert.deepEqual(fuzzWorkflowSteps.map((step) => step.fuzzStepIndex), [0, 0, 0, 0])

const executions: RecipeExecutionResult[] = fuzzWorkflowSteps.map((workflowStep, index) => ({
  id: `exec-${index}`,
  command: workflowStep.step.command,
  args: workflowStep.step.args ?? [],
  exitCode: 0,
  stdout: index === 1 ? "case-001\n" : "",
  stderr: "",
  startedAt: `2026-01-01T00:00:0${index}.000Z`,
  finishedAt: `2026-01-01T00:00:0${index + 1}.000Z`,
  recipePhase: workflowStep.phase,
  recipeStepIndex: workflowStep.index,
  recipeCommand: workflowStep.step.command,
  fuzzCaseId: workflowStep.fuzzCaseId,
  fuzzCaseIndex: workflowStep.fuzzCaseIndex,
  fuzzPhase: workflowStep.fuzzPhase,
  fuzzStepIndex: workflowStep.fuzzStepIndex,
}))

const result = recipeFuzzRunResult(recipe, executions)
assert.equal(result?.schema, "wp-codebox/fuzz-run-result/v1")
assert.equal(result?.status, "passed")
assert.equal(result?.totalCases, 1)
assert.equal(result?.cases[0]?.case_id, "case-001")
assert.equal(result?.cases[0]?.status, "passed")
assert.equal(result?.cases[0]?.timing.durationMs, 4000)
assert.equal(result?.cases[0]?.commandRefs.length, 4)
assert.equal(result?.cases[0]?.artifactRefs[0]?.path, "/tmp/wp-codebox/fuzz/case-001.json")
assert.deepEqual(result?.cases[0]?.replay, { seed: "seed-001", inputRef: "fixtures/cases/case-001.json" })

const failedResult = recipeFuzzRunResult(recipe, [{ ...executions[1]!, exitCode: 1, stderr: "failed" }])
assert.equal(failedResult?.status, "failed")
assert.equal(failedResult?.cases[0]?.diagnostics[0]?.message, "wordpress.wp-cli exited with 1")

console.log("fuzz run recipe contract ok")
