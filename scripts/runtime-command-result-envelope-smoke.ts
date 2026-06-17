import { RUNTIME_COMMAND_RESULT_SCHEMA } from "../packages/runtime-core/src/index.js"
import { abilityResponseToCommandEnvelope, WORDPRESS_ABILITY_RESULT_SCHEMA } from "../packages/runtime-playground/src/ability-command-handlers.js"
import { executePlaygroundCommand } from "../packages/runtime-playground/src/command-router.js"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

const errorEnvelope = abilityResponseToCommandEnvelope(JSON.stringify({
  schema: WORDPRESS_ABILITY_RESULT_SCHEMA,
  command: "wordpress.ability",
  status: "error",
  name: "demo/error",
  input: { id: 123 },
  error: {
    code: "demo_error",
    message: "Demo failed",
    data: { status: 418, details: ["preserved"] },
  },
}), "demo/error", { id: 123 })

assert(errorEnvelope.schema === RUNTIME_COMMAND_RESULT_SCHEMA, "ability errors should map to the runtime command result schema")
assert(errorEnvelope.status === "error", "ability WP_Error responses should keep error status")
assert(errorEnvelope.error?.code === "demo_error", "WP_Error code should be preserved")
assert(errorEnvelope.error?.message === "Demo failed", "WP_Error message should be preserved")
assert(JSON.stringify(errorEnvelope.error?.data) === JSON.stringify({ status: 418, details: ["preserved"] }), "WP_Error data should be preserved")
assert(errorEnvelope.json && typeof errorEnvelope.json === "object", "ability response should remain available as structured JSON")

const stringOutput = await executePlaygroundCommand({
  inspectMountedInputs: async () => "legacy stdout",
  runPhp: async () => "",
  runWpCli: async () => "",
  runCaptureStateBundle: async () => "",
  runExportReplayPackage: async () => "",
  runRestRequest: async () => "",
  runAbility: async () => errorEnvelope,
  runBench: async () => "",
  runPhpunit: async () => "",
  runPluginCheck: async () => "",
  runCorePhpunit: async () => "",
  runThemeCheck: async () => "",
  runBrowserProbe: async () => "",
  runHtmlCapture: async () => "",
  runEditorCanvasProbe: async () => "",
  runBrowserActions: async () => "",
  runBrowserScenario: async () => "",
  runVisualCompare: async () => "",
  runEditorOpen: async () => "",
  runEditorActions: async () => "",
}, { command: "inspect-mounted-inputs" })

assert(stringOutput === "legacy stdout", "string command handlers should keep returning raw stdout")

console.log("runtime command result envelope smoke passed")
