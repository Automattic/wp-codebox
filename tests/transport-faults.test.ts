import assert from "node:assert/strict"
import test from "node:test"

import { TransportFaultEngine, negotiateTransportFaults, redactTransportHeaders, transportFaultCapabilities, transportFaultModel } from "../packages/runtime-core/src/transport-faults.js"
import { applyBrowserTransportFault, createBrowserTransportFaultAdapter } from "../packages/runtime-playground/src/browser-transport-faults.js"

const model = transportFaultModel({
  seed: "fault-seed",
  redactHeaders: ["x-private"],
  rules: [{
    id: "verification-sequence",
    match: { host: "service.example", method: "POST", path: "/verify", headers: { "x-mode": "test" } },
    sequence: [{ status: 500 }, { delayMs: 25, jitterMs: 5, timeoutMs: 10 }, { status: 200, body: "malformed", truncateAfterBytes: 4 }],
    repeat: "cycle",
  }],
})

test("transport fault sequences and evidence are deterministic and redacted", () => {
  const capabilities = transportFaultCapabilities("fixture", [
    { semantic: "response-substitution", fidelity: "exact" },
    { semantic: "delay", fidelity: "exact" },
    { semantic: "jitter", fidelity: "exact" },
    { semantic: "timeout", fidelity: "exact" },
    { semantic: "truncated-response", fidelity: "emulated" },
  ])
  const first = new TransportFaultEngine(model, capabilities)
  const second = new TransportFaultEngine(model, capabilities)
  const request = { url: "https://service.example/verify?token=secret", method: "post", headers: { authorization: "Bearer secret", "x-private": "private", "x-mode": "test" }, body: "payload" }

  const firstDecisions = [first.decide(request), first.decide(request), first.decide(request), first.decide(request)]
  const secondDecisions = [second.decide(request), second.decide(request), second.decide(request), second.decide(request)]
  assert.deepEqual(firstDecisions, secondDecisions)
  assert.deepEqual(firstDecisions.map((decision) => decision?.sequenceIndex), [0, 1, 2, 0])
  assert.ok((firstDecisions[1]?.delayMs ?? 0) >= 25)

  const evidence = first.record(request, firstDecisions[0], { status: 500, headers: { "set-cookie": "session=secret" } })
  assert.equal(evidence.request.headers.authorization, "[redacted]")
  assert.equal(evidence.request.headers["x-private"], "[redacted]")
  assert.equal(evidence.response?.headers?.["set-cookie"], "[redacted]")
  assert.doesNotMatch(JSON.stringify(evidence), /Bearer secret|session=secret|token=secret/)
})

test("fault negotiation reports unsupported transport semantics honestly", () => {
  const capabilities = transportFaultCapabilities("limited", [{ semantic: "response-substitution", fidelity: "exact" }])
  const negotiation = negotiateTransportFaults(model, capabilities)
  assert.equal(negotiation.supported, false)
  assert.deepEqual(negotiation.unsupported.map((item) => item.semantic), ["delay", "jitter", "timeout", "truncated-response"])
  assert.deepEqual(redactTransportHeaders({ Cookie: "secret", Accept: "json" }), { Cookie: "[redacted]", Accept: "json" })
})

test("browser adapter applies response faults and rejects socket semantics it cannot provide", async () => {
  const adapter = createBrowserTransportFaultAdapter(transportFaultModel({ seed: "browser", rules: [{ id: "replace", match: { host: "fixture.test", path: "/api" }, sequence: [{ status: 503, body: "offline", headers: { "x-fixture": "yes" } }] }] }))
  const calls: Array<{ method: string; input?: unknown }> = []
  const route = {
    request: () => ({ url: () => "https://fixture.test/api", method: () => "GET", headers: () => ({}), postDataBuffer: () => null }),
    async fulfill(input: unknown) { calls.push({ method: "fulfill", input }) },
    async continue(input: unknown) { calls.push({ method: "continue", input }) },
    async abort(input: unknown) { calls.push({ method: "abort", input }) },
    async fetch() { throw new Error("substituted response must not fetch upstream") },
  } as never
  assert.equal(await applyBrowserTransportFault(route, adapter.engine), true)
  assert.equal((calls[0]?.input as { status?: number }).status, 503)
  assert.equal(adapter.evidence().length, 1)

  const unsupported = createBrowserTransportFaultAdapter(transportFaultModel({ seed: "socket", rules: [{ id: "half-close", match: { host: "fixture.test" }, sequence: [{ connection: "half-close" }] }] }))
  assert.equal(unsupported.negotiation.supported, false)
  await assert.rejects(applyBrowserTransportFault(route, unsupported.engine), /half-close/)
})
