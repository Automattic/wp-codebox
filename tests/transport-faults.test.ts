import assert from "node:assert/strict"
import test from "node:test"

import { TransportFaultEngine, negotiateTransportFaults, redactTransportHeaders, transportFaultCapabilities, transportFaultModel } from "../packages/runtime-core/src/transport-faults.js"
import { getCommandDefinition } from "../packages/runtime-core/src/command-registry.js"
import { applyBrowserTransportFault, browserTransportFaultReport, createBrowserTransportFaultAdapter, installBrowserTransportFaults } from "../packages/runtime-playground/src/browser-transport-faults.js"

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

test("public browser commands expose the canonical transport fault model", () => {
  for (const command of ["wordpress.browser-actions", "wordpress.browser-scenario"]) {
    const argument = getCommandDefinition(command)?.acceptedArgs.find(({ name }) => name === "transport-faults-json")
    assert.equal(argument?.format, "JSON object or @path")
    assert.match(argument?.description ?? "", /wp-codebox\/transport-fault-model\/v1/)
  }
  assert.throws(() => transportFaultModel({ schema: "parallel/fault-model/v1", seed: "wrong", rules: [] }), /schema must be wp-codebox\/transport-fault-model\/v1/)
  assert.throws(() => transportFaultModel({ seed: "mixed", rules: [{ id: "mixed", match: {}, sequence: [{ passthrough: true, status: 200 }] }] }), /passthrough outcomes cannot declare another fault effect/)
})

test("browser adapter supports deterministic transient recovery and browser-emulated failures", async () => {
  const adapter = createBrowserTransportFaultAdapter(transportFaultModel({
    seed: "browser-sequences",
    rules: [
      { id: "recovery", match: { path: "/recover" }, sequence: [{ status: 503, body: "offline" }, { passthrough: true }], repeat: "none" },
      { id: "timeout", match: { path: "/timeout" }, sequence: [{ timeoutMs: 0 }] },
      { id: "refuse", match: { path: "/refuse" }, sequence: [{ connection: "refuse" }] },
      { id: "reset", match: { path: "/reset" }, sequence: [{ connection: "reset" }] },
      { id: "body", match: { path: "/body" }, sequence: [{ delayMs: 1, malformed: true, truncateAfterBytes: 3 }] },
      { id: "never", match: { path: "/never" }, sequence: [{ status: 500 }] },
    ],
  }))
  const calls: Array<{ method: string; input?: unknown }> = []
  const route = (path: string) => ({
    request: () => ({ url: () => `https://fixture.test${path}`, method: () => "GET", headers: () => ({}), postDataBuffer: () => null }),
    async fulfill(input: unknown) { calls.push({ method: "fulfill", input }) },
    async fallback(input: unknown) { calls.push({ method: "fallback", input }) },
    async abort(input: unknown) { calls.push({ method: "abort", input }) },
    async fetch() { return { body: async () => Buffer.from("abcdef"), status: () => 200, headers: () => ({ "content-type": "text/plain" }) } },
  }) as never

  await applyBrowserTransportFault(route("/recover"), adapter.engine)
  await applyBrowserTransportFault(route("/recover"), adapter.engine)
  await applyBrowserTransportFault(route("/timeout"), adapter.engine)
  await applyBrowserTransportFault(route("/refuse"), adapter.engine)
  await applyBrowserTransportFault(route("/reset"), adapter.engine)
  await applyBrowserTransportFault(route("/body"), adapter.engine)

  assert.deepEqual(calls.map(({ method }) => method), ["fulfill", "fallback", "abort", "abort", "abort", "fulfill"])
  assert.deepEqual(calls.filter(({ method }) => method === "abort").map(({ input }) => input), ["timedout", "connectionrefused", "connectionreset"])
  assert.deepEqual((calls.at(-1)?.input as { body: Buffer }).body, Buffer.from([0xff, 0xfe, 0x00]))
  const report = browserTransportFaultReport(adapter)
  assert.deepEqual(report.consumedSequenceEntries.slice(0, 2), [
    { ruleId: "recovery", sequenceIndex: 0, invocation: 0 },
    { ruleId: "recovery", sequenceIndex: 1, invocation: 1 },
  ])
  assert.deepEqual(report.unmatchedRules, ["never"])
  assert.equal(report.replay.seed, "browser-sequences")
  assert.equal(report.matchedRequests.at(-1)?.fault?.delayMs, 1)
  assert.equal(report.interception.wordpressHttp.fidelity, "unsupported")
})

test("browser transport reports persist only a canonical secret-safe schedule", async () => {
  const adapter = createBrowserTransportFaultAdapter(transportFaultModel({
    seed: "safe-replay",
    metadata: { opaqueSecret: "model-secret" },
    rules: [{
      id: "secret-rule",
      match: { path: "/secret", headers: { Authorization: "Bearer matcher-secret", Cookie: "session=matcher-cookie", "X-Custom-Secret": "custom-value" } },
      sequence: [{ status: 503, headers: { Authorization: "response-authorization", "Set-Cookie": "response-cookie", "X-Private": "response-private" }, body: "sensitive-response-body", metadata: { token: "outcome-secret" } }],
      metadata: { credential: "rule-secret" },
    }],
  }))
  const route = {
    request: () => ({ url: () => "https://fixture.test/secret", method: () => "GET", headers: () => ({ Authorization: "Bearer matcher-secret", Cookie: "session=matcher-cookie", "X-Custom-Secret": "custom-value" }), postDataBuffer: () => Buffer.from("sensitive-request-body") }),
    async fulfill() {},
  } as never
  await applyBrowserTransportFault(route, adapter.engine)

  const report = browserTransportFaultReport(adapter)
  const serialized = JSON.stringify(report)
  assert.doesNotMatch(serialized, /matcher-secret|matcher-cookie|custom-value|response-authorization|response-cookie|response-private|sensitive-response-body|sensitive-request-body|model-secret|outcome-secret|rule-secret/)
  assert.deepEqual(report.schedule.rules[0]?.match.headerNames, ["authorization", "cookie", "x-custom-secret"])
  assert.deepEqual(report.schedule.rules[0]?.sequence[0]?.headerNames, ["authorization", "set-cookie", "x-private"])
  assert.deepEqual(report.schedule.rules[0]?.sequence[0]?.body, { encoding: "utf8", bytes: 23, redacted: true })
  assert.equal(report.schedule.rules[0]?.metadataRedacted, true)
  assert.equal(report.schedule.rules[0]?.sequence[0]?.metadataRedacted, true)
  assert.equal(report.matchedRequests[0]?.request.headers["X-Custom-Secret"], "[redacted]")
  assert.equal(report.replay.structuralScheduleFingerprint, report.schedule.structuralFingerprint)
  assert.equal(report.replay.fidelity, "identity-only-redacted")
})

test("direct installer reports bounded underlying route fetch drain timeouts honestly", async () => {
  let handler: ((route: never) => Promise<void>) | undefined
  const context = {
    async route(_pattern: string, callback: (route: never) => Promise<void>) { handler = callback },
    async unroute() {},
  } as never
  const installed = await installBrowserTransportFaults(context, transportFaultModel({
    seed: "uncancellable-fetch",
    rules: [{ id: "transform", match: { path: "/transform" }, sequence: [{ truncateAfterBytes: 2 }] }],
  }), { drainTimeoutMs: 20 })
  const route = {
    request: () => ({ url: () => "https://fixture.test/transform", method: () => "GET", headers: () => ({}), postDataBuffer: () => null }),
    async fetch() { return await new Promise<never>(() => undefined) },
    async abort() {},
    async fallback() {},
    async fulfill() {},
  } as never
  void handler!(route)
  await new Promise((resolve) => setImmediate(resolve))
  const report = await installed.dispose()
  assert.equal(report.teardown?.status, "timed-out")
  assert.equal(report.teardown?.timeoutMs, 20)
  assert.equal(report.teardown?.pendingHandlers, 0)
  assert.equal(report.teardown?.pendingRouteFetches, 1)
  assert.equal(report.teardown?.routeFetchCancellation.fidelity, "emulated")
  assert.match(report.teardown?.routeFetchCancellation.reason ?? "", /no AbortSignal/)
})

test("direct installer reports settled upstream route fetches as drained", async () => {
  let handler: ((route: never) => Promise<void>) | undefined
  const context = {
    async route(_pattern: string, callback: (route: never) => Promise<void>) { handler = callback },
    async unroute() {},
  } as never
  const installed = await installBrowserTransportFaults(context, transportFaultModel({
    seed: "settled-fetch",
    rules: [{ id: "transform", match: { path: "/transform" }, sequence: [{ truncateAfterBytes: 2 }] }],
  }), { drainTimeoutMs: 20 })
  const route = {
    request: () => ({ url: () => "https://fixture.test/transform", method: () => "GET", headers: () => ({}), postDataBuffer: () => null }),
    async fetch() { return { body: async () => Buffer.from("response"), status: () => 200, headers: () => ({ "content-type": "text/plain" }) } },
    async abort() {},
    async fallback() {},
    async fulfill() {},
  } as never
  await handler!(route)
  const report = await installed.dispose()
  assert.equal(report.teardown?.status, "drained")
  assert.equal(report.teardown?.pendingHandlers, 0)
  assert.equal(report.teardown?.pendingRouteFetches, 0)
  assert.equal(report.matchedRequests.length, 1)
})
