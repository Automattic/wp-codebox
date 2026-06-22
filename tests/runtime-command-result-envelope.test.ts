import assert from "node:assert/strict"

import { RUNTIME_COMMAND_RESULT_SCHEMA, runtimeCommandResultEnvelopeFromOutput } from "../packages/runtime-core/src/index.js"

const plain = runtimeCommandResultEnvelopeFromOutput({ stdout: "plain output\n" })
assert.equal(plain.schema, RUNTIME_COMMAND_RESULT_SCHEMA)
assert.equal(plain.status, "ok")
assert.equal(plain.stdout, "plain output\n")
assert.equal(plain.stderr, "")
assert.equal(plain.json, undefined)

const parsed = runtimeCommandResultEnvelopeFromOutput({
  stdout: '{"ok":true,"items":[1,2]}\n',
  diagnostics: { command: "wordpress.runtime-discovery", timing: { startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:00.125Z", durationMs: 125 } },
})
assert.deepEqual(parsed.json, { ok: true, items: [1, 2] })
assert.deepEqual(parsed.diagnostics, { command: "wordpress.runtime-discovery", timing: { startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:00.125Z", durationMs: 125 } })

const failure = runtimeCommandResultEnvelopeFromOutput({
  status: "error",
  stdout: "",
  stderr: "nope",
  error: { code: "command-failed", message: "Command failed" },
  artifactRefs: [{ kind: "command-log", id: "stderr", path: "files/stderr.txt" }],
})
assert.equal(failure.status, "error")
assert.equal(failure.stderr, "nope")
assert.deepEqual(failure.error, { code: "command-failed", message: "Command failed" })
assert.deepEqual(failure.artifactRefs, [{ kind: "command-log", id: "stderr", path: "files/stderr.txt" }])

console.log("runtime command result envelope ok")
