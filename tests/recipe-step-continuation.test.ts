import assert from "node:assert/strict"

import { validateWorkspaceRecipeJsonSchema, type ExecutionResult, type Runtime, type WorkspaceRecipe } from "../packages/runtime-core/src/index.js"
import { RecipeContinuationError, executeRecipeWorkflowStep, recipeStepFailure } from "../packages/cli/src/commands/recipe-run-workflow-evidence.js"

class FakeRuntime {
  readonly calls: Array<{ args: string[] }> = []

  constructor(private readonly executeResult: (args: string[], iteration: number) => ExecutionResult) {}

  async execute(spec: { args?: string[] }): Promise<ExecutionResult> {
    const args = [...(spec.args ?? [])]
    this.calls.push({ args })
    return this.executeResult(args, this.calls.length)
  }
}

const resumableStep: WorkspaceRecipe["workflow"]["steps"][number] = {
  command: "example/resumable",
  args: ["name=example", "input={\"cursor\":\"initial\",\"nested\":{\"a/b\":[{\"~key\":null}]}}", "mode=preserved"],
  continuation: {
    maxIterations: 5,
    while: { pointer: "/result/more", equals: true },
    inputMappings: [
      { from: "/result/cursor", to: { arg: "input", pointer: "/cursor" } },
      { from: "/result/a~1b/0/~0key", to: { arg: "input", pointer: "/nested/a~1b/0/~0key" } },
      { from: "/result/newToken", to: { arg: "input", pointer: "/nextToken" } },
    ],
  },
}

const runtime = new FakeRuntime((args, iteration) => ({
  command: "example/resumable",
  args,
  exitCode: 0,
  stdout: "not-json",
  stderr: "",
  result: { json: { result: { more: iteration < 3, cursor: `opaque-${iteration}`, newToken: `new-${iteration}`, "a/b": [{ "~key": { iteration } }] } } },
}))
const execution = await executeRecipeWorkflowStep(runtime as unknown as Runtime, { phase: "steps", index: 0, step: resumableStep }, process.cwd())
assert.equal(runtime.calls.length, 3)
assert.deepEqual(runtime.calls.map(({ args }) => JSON.parse(args.find((arg) => arg.startsWith("input="))!.slice(6))), [
  { cursor: "initial", nested: { "a/b": [{ "~key": null }] } },
  { cursor: "opaque-1", nested: { "a/b": [{ "~key": { iteration: 1 } }] }, nextToken: "new-1" },
  { cursor: "opaque-2", nested: { "a/b": [{ "~key": { iteration: 2 } }] }, nextToken: "new-2" },
])
assert.ok(runtime.calls.every(({ args }) => args.includes("mode=preserved")), "unmapped arguments remain unchanged")
assert.equal(execution.result?.json && (execution.result.json as { result: { more: boolean } }).result.more, false)
assert.equal(execution.continuationEvidence?.status, "completed")
assert.equal(execution.continuationEvidence?.iterations, 3)
assert.equal(execution.continuationEvidence?.executions.length, 3)
assert.deepEqual(execution.continuationEvidence?.executions.map(({ iteration, exitCode }) => ({ iteration, exitCode })), [{ iteration: 1, exitCode: 0 }, { iteration: 2, exitCode: 0 }, { iteration: 3, exitCode: 0 }])
assert.ok(execution.continuationEvidence?.executions.every(({ argsSha256, resultSha256 }) => /^[a-f0-9]{64}$/.test(argsSha256) && /^[a-f0-9]{64}$/.test(resultSha256)))
assert.equal(execution.continuationEvidence?.executions.every(({ resultTruncated }) => resultTruncated === undefined), true)
assert.equal(execution.continuationEvidence?.policy.while.equals, true)
assert.equal(execution.continuationEvidence?.policy.while.equalsBytes, 4)
assert.match(execution.continuationEvidence?.policy.while.equalsSha256 ?? "", /^[a-f0-9]{64}$/)

const largeResultRuntime = new FakeRuntime((args, iteration) => ({
  command: "example/resumable",
  args,
  exitCode: 0,
  stdout: "",
  stderr: "",
  result: { json: { result: { more: iteration < 2, cursor: `opaque-${iteration}`, newToken: `new-${iteration}`, "a/b": [{ "~key": {} }], payload: "x".repeat(8192) } } },
}))
const largeResultExecution = await executeRecipeWorkflowStep(largeResultRuntime as unknown as Runtime, { phase: "steps", index: 0, step: resumableStep }, process.cwd())
assert.equal(largeResultExecution.continuationEvidence?.executions[0]?.result, undefined)
assert.equal(largeResultExecution.continuationEvidence?.executions[0]?.resultTruncated, true)
assert.ok((largeResultExecution.continuationEvidence?.executions[0]?.resultBytes ?? 0) > 4096)

async function continuationFailure(step: WorkspaceRecipe["workflow"]["steps"][number], executionResult: ExecutionResult, code: string): Promise<void> {
  await assert.rejects(
    () => executeRecipeWorkflowStep(new FakeRuntime(() => executionResult) as unknown as Runtime, { phase: "steps", index: 0, step }, process.cwd()),
    (error: unknown) => {
      const cause = error instanceof Error ? error.cause : undefined
      assert.ok(cause instanceof RecipeContinuationError)
      assert.equal(cause.code, "recipe-continuation-failed")
      assert.equal(cause.continuationEvidence.diagnostics?.code, code)
      assert.ok(cause.continuationEvidence.iterations <= step.continuation!.maxIterations)
      assert.equal(recipeStepFailure({ phase: "steps", index: 0, step }, error, Date.now()).continuationEvidence?.diagnostics?.code, code)
      return true
    },
  )
}

const continuing = (json: unknown, exitCode = 0): ExecutionResult => ({ command: "example/resumable", args: [], exitCode, stdout: JSON.stringify(json), stderr: "", result: exitCode === 0 ? undefined : { json } })
await continuationFailure({ ...resumableStep, continuation: { ...resumableStep.continuation!, while: { pointer: "/result/~2bad", equals: true } } }, continuing({ result: { more: true } }), "predicate-value-missing")
await continuationFailure({ ...resumableStep, args: ["input=not-json"], continuation: { ...resumableStep.continuation!, inputMappings: [{ from: "/result/cursor", to: { arg: "input", pointer: "/cursor" } }] } }, continuing({ result: { more: true, cursor: "next" } }), "target-argument-not-json")
await continuationFailure({ ...resumableStep, continuation: { ...resumableStep.continuation!, inputMappings: [{ from: "/result/missing", to: { arg: "input", pointer: "/cursor" } }] } }, continuing({ result: { more: true } }), "mapping-source-missing")
await continuationFailure({ ...resumableStep, continuation: { ...resumableStep.continuation!, inputMappings: [{ from: "/result/cursor", to: { arg: "missing", pointer: "/cursor" } }] } }, continuing({ result: { more: true, cursor: "next" } }), "target-argument-missing")
await continuationFailure({ ...resumableStep, continuation: { ...resumableStep.continuation!, inputMappings: [{ from: "/result/cursor", to: { arg: "input", pointer: "/__proto__" } }] } }, continuing({ result: { more: true, cursor: "next" } }), "target-pointer-missing")
await continuationFailure({ ...resumableStep, continuation: { ...resumableStep.continuation!, maxIterations: 2 } }, continuing({ result: { more: true, cursor: "next", newToken: "new", "a/b": [{ "~key": {} }] } }), "max-iterations-exhausted")
await continuationFailure(resumableStep, continuing({ result: { more: true } }, 1), "command-failed")

const schemaRecipe: WorkspaceRecipe = { schema: "wp-codebox/workspace-recipe/v1", workflow: { steps: [resumableStep] } }
assert.equal(validateWorkspaceRecipeJsonSchema(schemaRecipe).valid, true)
assert.equal(validateWorkspaceRecipeJsonSchema({ ...schemaRecipe, workflow: { steps: [{ ...resumableStep, continuation: { ...resumableStep.continuation!, maxIterations: 1 } }] } }).valid, false)
assert.equal(validateWorkspaceRecipeJsonSchema({ ...schemaRecipe, workflow: { steps: [{ ...resumableStep, continuation: { ...resumableStep.continuation!, inputMappings: [] } }] } }).valid, false)
assert.equal(validateWorkspaceRecipeJsonSchema({ ...schemaRecipe, workflow: { steps: [{ ...resumableStep, continuation: { ...resumableStep.continuation!, while: { pointer: "/bad~2pointer", equals: true } } }] } }).valid, false)
for (const command of [
  "wordpress.collect-workload-result",
  "wordpress.run-workload",
  "wp-codebox.agent-fanout",
  "wp-codebox.bounded-runtime-plan",
  "wp-codebox.checkpoint-create",
  "wp-codebox.checkpoint-restore",
  "wp-codebox.checkpoint-list",
  "wp-codebox/run-fuzz-suite",
]) {
  assert.equal(validateWorkspaceRecipeJsonSchema({ ...schemaRecipe, workflow: { steps: [{ ...resumableStep, command }] } }).valid, false, command)
}
assert.equal(validateWorkspaceRecipeJsonSchema({ ...schemaRecipe, workflow: { steps: [{ ...resumableStep, continuation: { ...resumableStep.continuation!, inputMappings: Array.from({ length: 65 }, () => resumableStep.continuation!.inputMappings[0]!) } }] } }).valid, false)

await assert.rejects(
  () => executeRecipeWorkflowStep(runtime as unknown as Runtime, { phase: "steps", index: 0, step: { ...resumableStep, command: "wp-codebox.agent-fanout" } }, process.cwd()),
  /Continuation is unavailable for recipe command wp-codebox\.agent-fanout/,
)

const largePolicyRuntime = new FakeRuntime((args) => ({
  command: "example/resumable",
  args,
  exitCode: 0,
  stdout: "",
  stderr: "",
  result: { json: { result: { more: false } } },
}))
const largePolicyExecution = await executeRecipeWorkflowStep(largePolicyRuntime as unknown as Runtime, {
  phase: "steps",
  index: 0,
  step: { ...resumableStep, continuation: { ...resumableStep.continuation!, while: { pointer: "/result/more", equals: "x".repeat(8192) } } },
}, process.cwd())
assert.equal(largePolicyExecution.continuationEvidence?.policy.while.equals, undefined)
assert.equal(largePolicyExecution.continuationEvidence?.policy.while.equalsTruncated, true)
assert.equal(largePolicyExecution.continuationEvidence?.policy.while.equalsBytes, 8194)

console.log("recipe step continuation contract ok")
