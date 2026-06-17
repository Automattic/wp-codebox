import assert from "node:assert/strict"
import { runCli } from "../packages/cli/src/cli-entry.js"

const originalStdoutWrite = process.stdout.write.bind(process.stdout)
let stdout = ""

process.stdout.write = ((chunk: unknown, ..._args: unknown[]) => {
  stdout += String(chunk)
  return true
}) as typeof process.stdout.write

try {
  const exitCode = await runCli(["not-a-command", "--json"])
  assert.equal(exitCode, 1)

  const output = JSON.parse(stdout)
  assert.equal(output.schema, "wp-codebox/cli-failure/v1")
  assert.equal(output.success, false)
  assert.equal(output.command, "not-a-command")
  assert.match(output.error.message, /Unknown command/)
  assert.equal(output.diagnostics[0].code, "unknown-command")
} finally {
  process.stdout.write = originalStdoutWrite
}

console.log("cli-json-failure-smoke: ok")
