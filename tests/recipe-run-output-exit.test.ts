import assert from "node:assert/strict"
import { exitAfterTerminalRecipePhaseFailure } from "../packages/cli/src/commands/recipe-run-output.js"

const originalExit = process.exit
const originalExitCode = process.exitCode
let exitCalled = false

process.exit = ((code?: string | number | null | undefined) => {
  exitCalled = true
  throw new Error(`process.exit called with ${code}`)
}) as typeof process.exit

try {
  process.exitCode = undefined
  exitAfterTerminalRecipePhaseFailure({
    schema: "wp-codebox/recipe-run/v1",
    success: false,
    error: { name: "RecipePhaseError", message: "failed", code: "recipe-phase-failed" },
  } as never)

  assert.equal(exitCalled, false)
  assert.equal(process.exitCode, 1)
} finally {
  process.exit = originalExit
  process.exitCode = originalExitCode
}
