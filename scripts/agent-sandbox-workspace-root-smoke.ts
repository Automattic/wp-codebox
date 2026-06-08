import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

async function main() {
  const source = await readFile("packages/cli/src/agent-code.ts", "utf8")
  const defineNeedle = "define('DATAMACHINE_WORKSPACE_PATH'"
  const mkdirNeedle = "wp_mkdir_p(DATAMACHINE_WORKSPACE_PATH)"
  const importNeedle = "wp_codebox_import_sandbox_agent_bundles"

  assert.match(source, /define\('DATAMACHINE_WORKSPACE_PATH'/, "sandbox code should define the DMC workspace path")
  assert.match(source, /wp_mkdir_p\(DATAMACHINE_WORKSPACE_PATH\)/, "sandbox code should create the DMC workspace path")
  assert.ok(source.indexOf(defineNeedle) < source.indexOf(mkdirNeedle), "workspace root should be defined before creation")
  assert.ok(source.indexOf(mkdirNeedle) < source.indexOf(importNeedle), "workspace root should exist before runtime bundle imports")

  console.log("agent sandbox workspace root smoke ok")
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
