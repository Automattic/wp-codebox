import assert from "node:assert/strict"
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
const stdout = logs.join("\n")
assert.ok(Buffer.byteLength(stdout) <= MAX_ERROR_OUTPUT_BYTES)
assert.doesNotMatch(stdout, new RegExp(secret))

const output = JSON.parse(stdout) as {
  error: { message: string, code: string, failureClassification: string, response: { bytes: { type: string, byteLength: number, omitted: boolean }, uint8: { type: string }, arrayBuffer: { type: string }, text: string, artifactRefs: Array<{ path: string }> }, cause: { cause: { reason: string } }, broadPayload: { serialization: { reason: string } }, hugeInteger: { value: string, truncated: boolean, originalByteLength: number }, hostileUint8: { type: string, byteLength: number }, throwingGetter: { reason: string }, "[redacted]": string }
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

console.log("bounded error JSON serialization ok")
