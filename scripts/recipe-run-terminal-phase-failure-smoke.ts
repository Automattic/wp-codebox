import assert from "node:assert/strict"
import { exitAfterTerminalRecipePhaseFailure } from "../packages/cli/src/commands/recipe-run-output.js"

const originalExit = process.exit
const originalExitCode = process.exitCode
let exitCode: string | number | null | undefined

process.exit = ((code?: string | number | null | undefined): never => {
  exitCode = code
  throw new Error("process.exit stub")
}) as typeof process.exit

try {
  exitAfterTerminalRecipePhaseFailure({
    success: false,
    schema: "wp-codebox/recipe-run/v1",
    executions: [],
    phaseEvidence: [{
      schema: "wp-codebox/recipe-phase-evidence/v1",
      name: "activate_plugins",
      status: "failed",
      startedAt: "2026-06-15T00:00:00.000Z",
      endedAt: "2026-06-15T00:00:01.000Z",
      durationMs: 1000,
      error: {
        name: "RecipePhaseError",
        message: "Recipe phase activate_plugins failed",
        code: "recipe-phase-failed",
        phase: "activate_plugins",
      },
    }],
  })
  assert.equal(exitCode, undefined)
  assert.equal(process.exitCode, 1)

  exitCode = undefined
  process.exitCode = undefined
  exitAfterTerminalRecipePhaseFailure({
    success: false,
    schema: "wp-codebox/recipe-run/v1",
    executions: [],
    error: { name: "Error", message: "plain failure" },
  })
  assert.equal(exitCode, undefined)
  assert.equal(process.exitCode, undefined)
} finally {
  process.exit = originalExit
  process.exitCode = originalExitCode
}

console.log("recipe-run-terminal-phase-failure-smoke: ok")
