import assert from "node:assert/strict"

import { BROWSER_TOOL_VERIFIER_RESULT_SCHEMA, HOST_TOOL_RESULT_SCHEMA, createHostToolRegistry, browserInteractionScriptToolCalls, validateBrowserInteractionScript, type RuntimeCreateSpec } from "../packages/runtime-core/src/index.js"
import { browserArtifactFileManifest } from "../packages/runtime-playground/src/browser-artifacts.js"
import { browserToolVerifierResult, browserToolVerifierUnsupportedResult } from "../packages/runtime-playground/src/browser-actions-runner.js"

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

let calls = 0
const registry = createHostToolRegistry([{
  name: "client/check_status",
  description: "Check status",
  inputSchema: { type: "object", required: ["expected"] },
  outputSchema: { type: "object", required: ["status"] },
  policy: { capability: "client/check_status", risk: "read" },
  handler: (input, context) => {
    calls++
    assert.equal(context.tool, "client/check_status")
    assert.equal(context.policyCommand, "client/check_status")
    assert.deepEqual(input, { expected: "ready" })
    return { status: "ready" }
  },
}])

const runtimeSpec: RuntimeCreateSpec = {
  backend: "wordpress-playground",
  environment: {},
  policy: {
    network: "deny",
    filesystem: "sandbox",
    commands: ["wordpress.browser-actions", "client/check_status"],
    secrets: "none",
    approvals: "never",
  },
  hostTools: registry,
}

const executed = await browserToolVerifierResult({ kind: "callTool", tool: "client/check_status", input: { expected: "ready" } }, 2, "2026-01-01T00:00:00.000Z", runtimeSpec)
assert.equal(executed.status, "ok")
assert.equal(executed.tool, "client/check_status")
assert.equal(calls, 1)
assert.equal((executed.result as Record<string, unknown>).schema, HOST_TOOL_RESULT_SCHEMA)
assert.equal((executed.result as Record<string, unknown>).status, "ok")
assert.equal(Object.prototype.hasOwnProperty.call(executed, "input"), false)
assert.equal(executed.evidence.redaction.policy, "required")

const missingTool = await browserToolVerifierResult({ kind: "callTool", tool: "client/missing", input: {} }, 3, "2026-01-01T00:00:00.000Z", {
  ...runtimeSpec,
  policy: { ...runtimeSpec.policy, commands: ["wordpress.browser-actions", "client/missing"] },
})
assert.equal(missingTool.status, "unsupported")
assert.equal(missingTool.error?.code, "browser-call-tool-unregistered")

const denied = await browserToolVerifierResult({ kind: "callTool", tool: "client/check_status", input: { expected: "ready" } }, 4, "2026-01-01T00:00:00.000Z", {
  ...runtimeSpec,
  policy: { ...runtimeSpec.policy, commands: ["wordpress.browser-actions"] },
})
assert.equal(denied.status, "unsupported")
assert.equal(denied.error?.code, "browser-call-tool-policy-denied")
assert.equal(calls, 1)
