import assert from "node:assert/strict"
import test from "node:test"
import { attachServerTiming, CloudflarePhaseTrace, CLOUDFLARE_PHASE_TRACE_SCHEMA, serverTiming } from "../packages/runtime-cloudflare/src/phase-trace.js"

test("Cloudflare phase traces use bounded, non-overlapping leaves and independent dimensions", async () => {
  let clock = 0
  const trace = new CloudflarePhaseTrace(() => clock)
  trace.start("lease.acquire", { count: 2, path: "/private", secret: "redacted", tokenCount: 3, siteId: 42, revision: 7, ...Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`extra${index}`, index])) })
  clock = 10
  trace.end()
  assert.throws(() => { trace.start("runtime.one"); trace.start("runtime.two") }, /non-overlapping leaf/)
  trace.end()
  clock = 20
  await assert.rejects(trace.measure("request.php", async () => { clock = 30; throw new Error("expected") }), /expected/)
  clock = 31
  const summary = trace.complete("mutation", "shared-initialization", "miss", false)
  assert.equal(summary.schema, CLOUDFLARE_PHASE_TRACE_SCHEMA)
  assert.equal(summary.operation, "mutation")
  assert.equal(summary.runtime, "shared-initialization")
  assert.equal(summary.pageCache, "miss")
  assert.equal(summary.phases[0].evidence?.count, 2)
  assert.equal("path" in (summary.phases[0].evidence ?? {}), false)
  assert.equal("tokenCount" in (summary.phases[0].evidence ?? {}), false)
  assert.equal("siteId" in (summary.phases[0].evidence ?? {}), false)
  assert.equal("revision" in (summary.phases[0].evidence ?? {}), false)
  assert.ok(Object.keys(summary.phases[0].evidence ?? {}).length <= 16)
  assert.equal(summary.phases.at(-1)?.evidence?.failed, true)
  assert.ok(summary.phases.reduce((total, phase) => total + phase.durationMs, 0) <= summary.totalMs + 0.001)
  assert.equal(trace.complete("read", "warm", "hit"), summary, "finalization is exact-once")
})

test("Cloudflare composite phases report only their unmeasured gap", async () => {
  let clock = 0
  const trace = new CloudflarePhaseTrace(() => clock)
  await trace.measureComposite("playground.opaque", async () => {
    clock = 4
    await trace.measure("php.runtime.create", async () => { clock = 10 })
    clock = 20
  })
  const summary = trace.complete("diagnostic", "cold", "not-applicable")
  assert.deepEqual(summary.phases.map(({ name, durationMs, aggregateGap }) => ({ name, durationMs, aggregateGap })), [
    { name: "php.runtime.create", durationMs: 6, aggregateGap: undefined },
    { name: "playground.opaque", durationMs: 14, aggregateGap: true },
  ])
  assert.equal(summary.phases.reduce((total, phase) => total + phase.durationMs, 0), summary.totalMs)
})

test("Cloudflare diagnostic Server-Timing serializes only completed leaf phases", () => {
  let clock = 0
  const trace = new CloudflarePhaseTrace(() => clock)
  trace.start("playground.opaque.finalize")
  clock = 4
  trace.end()
  const summary = trace.complete("diagnostic", "cold", "not-applicable")
  assert.match(serverTiming(summary), /^playground-opaque-finalize;dur=4/)
  const response = attachServerTiming(Response.json({ ok: true }), summary)
  assert.match(response.headers.get("server-timing") ?? "", /^playground-opaque-finalize;dur=/)
})
