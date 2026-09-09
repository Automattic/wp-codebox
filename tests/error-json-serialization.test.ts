import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { runCliEntrypoint } from "../packages/cli/src/cli-main.js"
import { captureStdout, MAX_ERROR_OUTPUT_BYTES } from "../packages/cli/src/output.js"

const secret = "ghp_error_serialization_canary_1234567890"
const responseBytes = Buffer.from(secret.repeat(65536))
const root = Object.assign(new Error("PHPUnit failed after retaining files/test-results.json"), {
  name: "PlaygroundCommandError",
  code: "wp-codebox-playground-command-failed",
  failureClassification: "runtime-command-failure",
  response: {
    bytes: responseBytes,
    uint8: new Uint8Array(responseBytes),
    arrayBuffer: responseBytes.buffer.slice(responseBytes.byteOffset, responseBytes.byteOffset + responseBytes.byteLength),
    text: "PHPUnit summary: 883 passed, 161 failed, 9 skipped",
    artifactRefs: [{ path: "runtime-1/files/test-results.json", kind: "test-results" }],
  },
})
const nested = Object.assign(new Error("Nested runtime failure"), { response: { bytes: responseBytes } })
root.cause = nested
nested.cause = root
Object.defineProperty(root, "throwingGetter", { enumerable: true, get: () => { throw new Error("must not run") } })
Object.defineProperty(root, "token", { enumerable: true, get: () => { throw new Error("sensitive accessors must not run") } })
const broadPayload = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`entry-${index}`, "x".repeat(32 * 1024)]))
const hostileUint8 = new Uint8Array(responseBytes)
Object.defineProperties(hostileUint8, {
  constructor: { get: () => { throw new Error("constructor must not run") } },
  byteLength: { get: () => { throw new Error("byteLength must not run") } },
})
Object.assign(root, { hostileUint8, hugeInteger: BigInt("9".repeat(65536)), broadPayload })

let exitCode: number | undefined
const { logs } = await captureStdout(async () => await new Promise<void>((resolve) => {
  runCliEntrypoint(["recipe-run", "--json"], async () => { throw root }, ((code) => {
    exitCode = code
    resolve()
    return undefined as never
  }))
}))

assert.equal(exitCode, 1)
// The test simulates a failing CLI process but must not make this test process fail.
process.exitCode = undefined
const stdout = logs.join("\n")
assert.ok(Buffer.byteLength(stdout) <= MAX_ERROR_OUTPUT_BYTES)
assert.doesNotMatch(stdout, new RegExp(secret))

const output = JSON.parse(stdout) as {
  error: { message: string, code: string, failureClassification: string, response: { bytes: { type: string, byteLength: number, omitted: boolean }, uint8: { type: string }, arrayBuffer: { type: string }, text: string, artifactRefs: Array<{ path: string }> }, cause: { cause: { reason: string } }, broadPayload: { serialization: { reason: string } }, hugeInteger: { value: string, truncated: boolean, originalByteLength: number }, hostileUint8: { type: string, byteLength: number }, throwingGetter: { reason: string }, "[redacted]": string }
}
if (process.env.ERROR_JSON_EVIDENCE_DIR) {
  const evidenceDirectory = resolve(process.env.ERROR_JSON_EVIDENCE_DIR)
  await mkdir(evidenceDirectory, { recursive: true })
  await writeFile(resolve(evidenceDirectory, "cli-failure.json"), `${stdout}\n`)
  await writeFile(resolve(evidenceDirectory, "cli-failure-summary.json"), `${JSON.stringify({ byteLength: Buffer.byteLength(stdout), output }, null, 2)}\n`)
}
assert.equal(output.error.message, "PHPUnit failed after retaining files/test-results.json")
assert.equal(output.error.code, "wp-codebox-playground-command-failed")
assert.equal(output.error.failureClassification, "runtime-command-failure")
assert.deepEqual(output.error.response.bytes, { type: "Buffer", byteLength: Buffer.byteLength(secret) * 65536, omitted: true })
assert.equal(output.error.response.uint8.type, "Uint8Array")
assert.equal(output.error.response.arrayBuffer.type, "ArrayBuffer")
assert.equal(output.error.response.text, "PHPUnit summary: 883 passed, 161 failed, 9 skipped")
assert.equal(output.error.response.artifactRefs[0]?.path, "runtime-1/files/test-results.json")
assert.equal(output.error.hostileUint8.type, "Uint8Array")
assert.equal(output.error.hostileUint8.byteLength, responseBytes.byteLength)
assert.equal(output.error.hugeInteger.truncated, true)
assert.equal(output.error.hugeInteger.originalByteLength, 65537)
assert.equal(output.error.cause.cause.reason, "circular-reference")
assert.equal(output.error.broadPayload.serialization.reason, "output-budget")
assert.equal(output.error.throwingGetter.reason, "accessor-property")
assert.equal(output.error["[redacted]"], "[redacted]")

const longRoot = Object.assign(new Error("x".repeat(8192)), Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`field${index}`, "y".repeat(8192)])))
let longExitCode: number | undefined
const { logs: longLogs } = await captureStdout(async () => await new Promise<void>((resolve) => {
  runCliEntrypoint(["recipe-run", "--json"], async () => { throw longRoot }, ((code) => {
    longExitCode = code
    resolve()
    return undefined as never
  }))
}))

assert.equal(longExitCode, 1)
process.exitCode = undefined
const longStdout = longLogs.join("\n")
assert.ok(Buffer.byteLength(longStdout) <= MAX_ERROR_OUTPUT_BYTES)
const longOutput = JSON.parse(longStdout) as { error: { message: string, serialization: { omitted: boolean, reason: string } } }
assert.equal(longOutput.error.message, longRoot.message)
assert.deepEqual(longOutput.error.serialization, { omitted: true, reason: "output-budget" })

console.log("bounded error JSON serialization ok")
