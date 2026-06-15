import assert from "node:assert/strict"
import { runCliEntrypoint } from "../packages/cli/src/cli-main.js"

const originalExitCode = process.exitCode
const originalStderrWrite = process.stderr.write.bind(process.stderr)
let stderr = ""
let hijackedStderr = ""

process.exitCode = undefined
;(process.stderr.write as typeof process.stderr.write) = ((chunk: unknown, ..._args: unknown[]) => {
  stderr += String(chunk)
  return true
}) as typeof process.stderr.write

try {
  runCliEntrypoint(["agent-task-run"], async () => {
    ;(process.stderr.write as typeof process.stderr.write) = ((chunk: unknown, ..._args: unknown[]) => {
      hijackedStderr += String(chunk)
      return true
    }) as typeof process.stderr.write
    return new Promise<number>(() => undefined)
  })
  process.emit("beforeExit", 0)

  assert.equal(process.exitCode, 1)
  assert.match(stderr, /did not settle before the Node\.js event loop drained/)
  assert.equal(hijackedStderr, "")
} finally {
  process.stderr.write = originalStderrWrite
  process.exitCode = originalExitCode
}

console.log("cli-unsettled-command-smoke: ok")
