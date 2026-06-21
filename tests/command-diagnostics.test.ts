import assert from "node:assert/strict"
import { createWorkspaceRecipeJsonSchema, commandDiagnosticsCaptureArgs, commandDiagnosticsCaptureSpecFromArgs, normalizeCommandDiagnosticsCaptureSpec } from "../packages/runtime-core/src/index.js"
import { recipeExecutionSpec } from "../packages/cli/src/agent-sandbox.js"

assert.equal(normalizeCommandDiagnosticsCaptureSpec(), undefined)
assert.equal(commandDiagnosticsCaptureSpecFromArgs([]), undefined)

assert.deepEqual(commandDiagnosticsCaptureSpecFromArgs(["capture-diagnostics=wpdb-queries", "diagnostics-max-items=2", "diagnostics-max-bytes=1000"]), {
  capture: ["wpdb-queries"],
  maxItems: 2,
  maxBytes: 1000,
})

assert.deepEqual(commandDiagnosticsCaptureSpecFromArgs(["capture-diagnostics=wpdb-queries", "diagnostics-max-items=9999", "diagnostics-max-bytes=999999"]), {
  capture: ["wpdb-queries"],
  maxItems: 500,
  maxBytes: 524288,
})

assert.deepEqual(commandDiagnosticsCaptureArgs({ capture: ["wpdb-queries"], maxItems: 3, maxBytes: 256 }), [
  "capture-diagnostics=wpdb-queries",
  "diagnostics-max-items=3",
  "diagnostics-max-bytes=256",
])

const schema = createWorkspaceRecipeJsonSchema({ recipeCommandIds: ["wordpress.run-php"] })
const stepProperties = ((schema.$defs as Record<string, unknown>).step as { properties: Record<string, unknown> }).properties
assert.ok(stepProperties.diagnostics, "recipe step schema exposes diagnostics capture")

const noCapture = await recipeExecutionSpec({ command: "wordpress.run-php", args: ["code=echo 'ok';"] }, process.cwd())
assert.deepEqual(noCapture, { command: "wordpress.run-php", args: ["code=echo 'ok';"], diagnostics: undefined })

const withCapture = await recipeExecutionSpec({ command: "wordpress.run-php", args: ["code=echo 'ok';"], diagnostics: { capture: ["wpdb-queries"], maxItems: 1, maxBytes: 128 } }, process.cwd())
assert.deepEqual(withCapture, {
  command: "wordpress.run-php",
  args: ["code=echo 'ok';", "capture-diagnostics=wpdb-queries", "diagnostics-max-items=1", "diagnostics-max-bytes=128"],
  diagnostics: { capture: ["wpdb-queries"], maxItems: 1, maxBytes: 128 },
})
