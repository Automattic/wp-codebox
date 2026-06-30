import assert from "node:assert/strict"
import { normalizeRecipeRunSummary } from "@automattic/wp-codebox-core"
import { writeRecipeJsonOutput, writeRecipeSummaryHumanOutput } from "../packages/cli/src/commands/recipe-run-output.js"

const success = normalizeRecipeRunSummary({
  success: true,
  schema: "wp-codebox/recipe-run/v1",
  recipePath: "/tmp/recipe.json",
  runtime: { id: "runtime-ok", status: "ready" },
  run: { runId: "run-ok", status: "succeeded" },
  artifacts: { directory: "/tmp/artifacts/run-ok" },
  executions: [{ command: "wordpress.wp-cli option get siteurl", exitCode: 0, durationMs: 12, recipePhase: "run_workloads", recipeStepIndex: 0 }],
})

const successHuman = await captureStdout(() => writeRecipeSummaryHumanOutput(success))
assert.match(successHuman, /WP Codebox recipe summary/)
assert.match(successHuman, /Status: succeeded/)
assert.match(successHuman, /Recipe: \/tmp\/recipe\.json/)
assert.match(successHuman, /Run: run-ok \(succeeded\)/)
assert.match(successHuman, /Runtime: runtime-ok \(ready\)/)
assert.match(successHuman, /Artifacts: \/tmp\/artifacts\/run-ok/)
assert.match(successHuman, /Commands: 1/)
assert.match(successHuman, /#1 succeeded exit=0 phase=run_workloads/)

const failure = normalizeRecipeRunSummary({
  success: false,
  schema: "wp-codebox/recipe-run/v1",
  recipePath: "/tmp/failing.recipe.json",
  error: { message: "Workflow command failed" },
  runtime: { id: "runtime-fail", status: "stopped" },
  run: { runId: "run-fail", status: "failed" },
  artifacts: { directory: "/tmp/artifacts/run-fail" },
  phaseEvidence: [{ name: "run_workloads", status: "failed" }],
  diagnostics: [{ code: "workflow-command-failed", message: "Command exited non-zero" }],
  executions: [{ command: "wordpress.wp-cli eval 'broken'", exitCode: 1, stdout: "line 1\nline 2\n", stderr: "fatal detail\n", recipePhase: "run_workloads", recipeStepIndex: 0 }],
})

const failureHuman = await captureStdout(() => writeRecipeSummaryHumanOutput(failure))
assert.match(failureHuman, /Status: failed/)
assert.match(failureHuman, /Failed phase: run_workloads/)
assert.match(failureHuman, /Failure: run_workloads: Workflow command failed/)
assert.match(failureHuman, /#1 failed exit=1 phase=run_workloads/)
assert.match(failureHuman, /stderr: fatal detail/)
assert.match(failureHuman, /stdout: line 1 \| line 2/)
assert.match(failureHuman, /Diagnostics: 1/)

const failureJson = await captureStdout(() => writeRecipeJsonOutput(failure))
const parsed = JSON.parse(failureJson)
assert.equal(parsed.schema, "wp-codebox/recipe-run-summary/v1")
assert.equal(parsed.status, "failed")
assert.equal(parsed.failed_phase, "run_workloads")
assert.equal(parsed.commands[0].exit_code, 1)

async function captureStdout(callback: () => Promise<void>): Promise<string> {
  const originalWrite = process.stdout.write.bind(process.stdout)
  let output = ""
  process.stdout.write = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    output += typeof chunk === "string" ? chunk : chunk.toString()
    if (typeof encodingOrCallback === "function") encodingOrCallback()
    else callback?.()
    return true
  }) as typeof process.stdout.write

  try {
    await callback()
    return output
  } finally {
    process.stdout.write = originalWrite
  }
}
