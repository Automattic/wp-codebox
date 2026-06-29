import assert from "node:assert/strict"

import { BROWSER_TOOL_VERIFIER_RESULT_SCHEMA, browserInteractionScriptToolCalls, validateBrowserInteractionScript } from "../packages/runtime-core/src/index.js"
import { browserArtifactFileManifest } from "../packages/runtime-playground/src/browser-artifacts.js"
import { browserToolVerifierUnsupportedResult } from "../packages/runtime-playground/src/browser-actions-runner.js"

const valid = validateBrowserInteractionScript([
  { kind: "navigate", url: "/" },
  { kind: "callTool", tool: "client/check_status", input: { url: "https://example.test/?token=secret", expected: "ready" } },
])

assert.equal(valid.valid, true)
assert.deepEqual(browserInteractionScriptToolCalls(valid.steps), ["client/check_status"])

const missingInput = validateBrowserInteractionScript([{ kind: "callTool", tool: "client/check_status" }])
assert.equal(missingInput.valid, false)
assert.match(missingInput.issues[0]?.message ?? "", /requires input/)

const invalidTool = validateBrowserInteractionScript([{ kind: "callTool", tool: "check-status", input: {} }])
assert.equal(invalidTool.valid, false)
assert.match(invalidTool.issues[0]?.message ?? "", /stable canonical tool id/)

const unsupported = browserToolVerifierUnsupportedResult(valid.steps[1]!, 1, "2026-01-01T00:00:00.000Z")
assert.equal(unsupported.schema, BROWSER_TOOL_VERIFIER_RESULT_SCHEMA)
assert.equal(unsupported.status, "unsupported")
assert.equal(unsupported.tool, "client/check_status")
assert.equal(unsupported.inputSummary.type, "object")
assert.deepEqual(unsupported.inputSummary.keys, ["expected", "url"])
assert.equal(Object.prototype.hasOwnProperty.call(unsupported, "input"), false)
assert.equal(unsupported.evidence.rawInputSerialized, false)
assert.equal(unsupported.evidence.rawSecretsSerialized, false)
assert.equal(unsupported.error?.code, "browser-call-tool-bridge-unavailable")

const manifest = browserArtifactFileManifest("verifierResults")
assert.equal(manifest.kind, "browser-verifier-result")
assert.equal(manifest.contentType, "application/json")
assert.equal(manifest.redaction?.policy, "required")
assert.equal(manifest.redaction?.sensitive, true)
