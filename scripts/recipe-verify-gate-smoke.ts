import assert from "node:assert/strict"
import { recipeVerifyStepFailure } from "../packages/cli/src/recipe-evidence.js"

// A failing after-phase step (e.g. a red phpunit/smoke gate) must fail the run.
const failed = recipeVerifyStepFailure([
  { exitCode: 0, recipePhase: "steps", recipeCommand: "wp-codebox.agent-sandbox-run" },
  { exitCode: 1, recipePhase: "after", recipeCommand: "wordpress.phpunit" },
])
assert.ok(failed, "a non-zero after-phase step should produce a verify failure")
assert.equal(failed?.code, "verify-step-failed")
assert.match(failed?.message ?? "", /wordpress\.phpunit/)
assert.match(failed?.message ?? "", /exit code 1/)

// A green after-phase gate passes.
const passed = recipeVerifyStepFailure([
  { exitCode: 0, recipePhase: "steps", recipeCommand: "wp-codebox.agent-sandbox-run" },
  { exitCode: 0, recipePhase: "after", recipeCommand: "wordpress.phpunit" },
])
assert.equal(passed, undefined, "a green after-phase gate should not fail the run")

// A non-zero exit in a non-after phase (setup/steps) is NOT treated as a verify
// failure here; those are handled by their own failure signals.
const stepsExit = recipeVerifyStepFailure([
  { exitCode: 1, recipePhase: "steps", recipeCommand: "wp-codebox.agent-sandbox-run" },
])
assert.equal(stepsExit, undefined, "non-after phase exit codes are not verify-gate failures")

// No after steps at all → no gate failure (back-compat with current single-step runs).
const noAfter = recipeVerifyStepFailure([
  { exitCode: 0, recipePhase: "steps", recipeCommand: "wp-codebox.agent-sandbox-run" },
])
assert.equal(noAfter, undefined, "runs without an after phase should not fail the verify gate")

// First failing after step is reported when multiple exist.
const multi = recipeVerifyStepFailure([
  { exitCode: 0, recipePhase: "after", recipeCommand: "wordpress.run-php" },
  { exitCode: 2, recipePhase: "after", recipeCommand: "wordpress.phpunit" },
])
assert.match(multi?.message ?? "", /wordpress\.phpunit/)
assert.match(multi?.message ?? "", /exit code 2/)

console.log("recipe-verify-gate-smoke passed")
