import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

async function main() {
  const source = await readFile("packages/cli/src/agent-code.ts", "utf8")
  const pluginsLoadedNeedle = "do_action('plugins_loaded')"
  const initNeedle = "do_action('init')"
  const abilitiesNeedle = "do_action('wp_abilities_api_init')"

  assert.doesNotMatch(source, /DATAMACHINE_WORKSPACE_PATH/, "sandbox boot should not define a Data Machine workspace path")
  assert.doesNotMatch(source, /datamachine_code_remote_workspace_backend_should_handle/, "sandbox boot should not set Data Machine workspace backend filters")
  assert.doesNotMatch(source, /datamachine-code\/workspace-adopt/, "sandbox boot should not adopt Data Machine workspaces")
  assert.ok(source.indexOf(pluginsLoadedNeedle) < source.indexOf(initNeedle), "mounted components should see plugins_loaded before init")
  assert.ok(source.indexOf(initNeedle) < source.indexOf(abilitiesNeedle), "mounted components should self-configure before abilities initialize")

  console.log("agent sandbox generic boot seam smoke ok")
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
