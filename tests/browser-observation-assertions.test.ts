import assert from "node:assert/strict"

import { validateBrowserInteractionScript } from "../packages/runtime-core/src/browser-interaction.js"
import { executeBrowserObservationAssertion } from "../packages/runtime-playground/src/browser-observation-assertions.js"
import type { BrowserProbeNetworkRecord } from "../packages/runtime-playground/src/browser-artifacts.js"

const valid = validateBrowserInteractionScript([
  { kind: "navigate", url: "/" },
  { kind: "assertObservation", assertion: "request-count-by-host:example.test<=2" },
  { kind: "assertObservation", assertion: "request-count-by-type:script=1" },
  { kind: "assertObservation", assertion: "no-page-errors" },
  { kind: "assertObservation", assertion: "no-console-errors" },
])
assert.equal(valid.valid, true)
assert.equal(valid.issues.length, 0)

const invalid = validateBrowserInteractionScript([
  { kind: "assertObservation" },
  { kind: "assertObservation", assertion: "total-transfer-size<=100" },
])
assert.equal(invalid.valid, false)
assert.deepEqual(invalid.issues.map((issue) => issue.message), [
  "assertObservation step requires assertion",
  "assertObservation supports no-console-errors, no-page-errors, request-count-by-host:<host><op><number>, and request-count-by-type:<type><op><number>",
])

const network: BrowserProbeNetworkRecord[] = [
  { type: "response", url: "https://example.test/app.js", method: "GET", resourceType: "script", timestamp: "2026-06-29T00:00:00.000Z" },
  { type: "response", url: "https://example.test/style.css", method: "GET", resourceType: "stylesheet", timestamp: "2026-06-29T00:00:00.000Z" },
  { type: "response", url: "https://cdn.example.test/app.js", method: "GET", resourceType: "script", timestamp: "2026-06-29T00:00:00.000Z" },
]

assert.deepEqual(executeBrowserObservationAssertion({ kind: "assertObservation", assertion: "request-count-by-host:example.test=2" }, [], [], network), {
  kind: "probe",
  id: "request-count-by-host:example.test=2",
  assertion: "request-count-by-host:example.test=2",
  name: "example.test",
  state: "request-count-by-host",
  operator: "=",
  expected: 2,
  status: "pass",
  expectedBudget: 2,
  actual: 2,
  observed: 2,
  supportingArtifacts: ["files/browser/network.jsonl"],
  passed: true,
})

assert.equal(executeBrowserObservationAssertion({ kind: "assertObservation", assertion: "request-count-by-type:script<2" }, [], [], network).passed, false)
assert.equal(executeBrowserObservationAssertion({ kind: "assertObservation", assertion: "no-console-errors" }, [{ type: "log" }, { type: "error" }], [], network).passed, false)
assert.equal(executeBrowserObservationAssertion({ kind: "assertObservation", assertion: "no-page-errors" }, [], [{ type: "pageerror", name: "Error", message: "boom", timestamp: "2026-06-29T00:00:00.000Z" }], network).passed, false)

console.log("browser observation assertions ok")
