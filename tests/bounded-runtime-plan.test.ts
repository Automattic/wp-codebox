import assert from "node:assert/strict"
import { executeBoundedRuntimePlan, retryBoundedRuntimePlan, type BoundedRuntimePlan, type BoundedRuntimePlanAdapter } from "../packages/runtime-core/src/index.js"

const plan: BoundedRuntimePlan = {
  schema: "wp-codebox/bounded-runtime-plan/v1",
  concurrency: 2,
  entries: [
    { id: "first", argv: ["phpunit", "first"], environment: { DB_NAME: "suite_first" }, timeoutMs: 100, processIdentity: "phpunit-first", artifactNamespace: "phpunit/first", inputIndex: 0 },
    { id: "failed", argv: ["phpunit", "failed"], environment: { DB_NAME: "suite_failed" }, timeoutMs: 100, processIdentity: "phpunit-failed", artifactNamespace: "phpunit/failed", inputIndex: 1 },
    { id: "slow", argv: ["phpunit", "slow"], environment: { DB_NAME: "suite_slow" }, timeoutMs: 5, processIdentity: "phpunit-slow", artifactNamespace: "phpunit/slow", inputIndex: 2 },
    { id: "last", argv: ["phpunit", "last"], environment: { DB_NAME: "suite_last" }, timeoutMs: 100, processIdentity: "phpunit-last", artifactNamespace: "phpunit/last", inputIndex: 3 },
  ],
}

const lifecycle: string[] = []
let active = 0
let maximumActive = 0
const executed: string[] = []
const adapter: BoundedRuntimePlanAdapter<{ root: string }, { id: string }, { id: string }> = {
  async materialize() { lifecycle.push("materialize"); return { workspace: { root: "/workspace" }, runtime: { id: "runtime" } } },
  async startServices() { lifecycle.push("start-services"); return { id: "mariadb-allocation" } },
  async execute({ entry, signal }) {
    executed.push(entry.id)
    active++
    maximumActive = Math.max(maximumActive, active)
    try {
      if (entry.id === "slow") await new Promise<void>((resolve) => signal.addEventListener("abort", resolve, { once: true }))
      else await new Promise((resolve) => setTimeout(resolve, entry.id === "first" ? 15 : 1))
      return { success: entry.id !== "failed", exitCode: entry.id === "failed" ? 1 : 0 }
    } finally {
      active--
    }
  },
  async stopServices() { lifecycle.push("stop-services") },
  async dispose() { lifecycle.push("dispose") },
}

const result = await executeBoundedRuntimePlan(plan, adapter)
assert.equal(result.success, false)
assert.equal(maximumActive, 2, "execution never exceeds the declared concurrency")
assert.deepEqual(result.entries.map((entry) => entry.id), ["first", "failed", "slow", "last"], "aggregate order is input order rather than completion order")
assert.deepEqual(result.entries.map((entry) => entry.status), ["succeeded", "failed", "timed_out", "succeeded"])
assert.deepEqual(result.counts, { total: 4, succeeded: 2, failed: 1, timedOut: 1, cancelled: 0 })
assert.equal(result.entries.every((entry) => Number.isInteger(entry.durationMs) && entry.durationMs >= 0), true)
assert.deepEqual(lifecycle, ["materialize", "start-services", "stop-services", "dispose"], "workspace, service, and runtime lifecycles are each owned once")
assert.deepEqual(executed.sort(), ["failed", "first", "last", "slow"], "one failed entry does not isolate unrelated entries")

const retry = retryBoundedRuntimePlan(plan, result)
assert.deepEqual(retry.entries.map((entry) => entry.id), ["failed", "slow"], "retry selects only unsuccessful prior entries")
assert.equal(retry.concurrency, 2)

const redacted = await executeBoundedRuntimePlan({
  schema: "wp-codebox/bounded-runtime-plan/v1",
  concurrency: 1,
  entries: [{ id: "secret", argv: ["phpunit"], environment: { DB_PASSWORD: "not-for-review" }, processIdentity: "phpunit-secret", artifactNamespace: "phpunit/secret", inputIndex: 0 }],
}, {
  async materialize() { return { workspace: undefined, runtime: undefined } },
  async startServices() { return undefined },
  async execute() { return { success: false, message: "database password=not-for-review" } },
  async stopServices() {},
  async dispose() {},
})
assert.equal(redacted.entries[0]?.error?.message, "database password=[redacted]", "reviewer-facing results redact entry environment values")

const failFastPlan = { ...plan, failFast: true, concurrency: 1, entries: plan.entries.slice(1) }
const failFast = await executeBoundedRuntimePlan(failFastPlan, adapter)
assert.deepEqual(failFast.entries.map((entry) => entry.status), ["failed", "cancelled", "cancelled"], "explicit fail-fast leaves later entries unstarted")

let timedOutProcessActive = false
const timeoutOrder: string[] = []
const timeoutResult = await executeBoundedRuntimePlan({
  schema: "wp-codebox/bounded-runtime-plan/v1",
  concurrency: 1,
  entries: [
    { id: "timeout", argv: ["phpunit"], timeoutMs: 5, processIdentity: "timeout", artifactNamespace: "timeout", inputIndex: 0 },
    { id: "after-timeout", argv: ["phpunit"], processIdentity: "after-timeout", artifactNamespace: "after-timeout", inputIndex: 1 },
  ],
}, {
  async materialize() { return { workspace: undefined, runtime: undefined } },
  async startServices() { return undefined },
  async execute({ entry, signal }) {
    if (entry.id === "timeout") {
      timedOutProcessActive = true
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => setTimeout(resolve, 10), { once: true }))
      timedOutProcessActive = false
      timeoutOrder.push("timeout-stopped")
      return { success: false }
    }
    assert.equal(timedOutProcessActive, false, "the next entry starts only after the timed-out process stops")
    timeoutOrder.push("next-started")
    return { success: true }
  },
  async stopServices() { timeoutOrder.push("services-stopped") },
  async dispose() { timeoutOrder.push("runtime-disposed") },
})
assert.deepEqual(timeoutResult.entries.map((entry) => entry.status), ["timed_out", "succeeded"])
assert.deepEqual(timeoutOrder, ["timeout-stopped", "next-started", "services-stopped", "runtime-disposed"])

const teardownOrder: string[] = []
await assert.rejects(executeBoundedRuntimePlan({
  schema: "wp-codebox/bounded-runtime-plan/v1",
  concurrency: 1,
  entries: [{ id: "teardown", argv: ["phpunit"], processIdentity: "teardown", artifactNamespace: "teardown", inputIndex: 0 }],
}, {
  async materialize() { return { workspace: undefined, runtime: undefined } },
  async startServices() { return undefined },
  async execute() { return { success: true } },
  async stopServices() { teardownOrder.push("services-stopped"); throw new Error("service cleanup failed") },
  async dispose() { teardownOrder.push("runtime-disposed") },
}), /service cleanup failed/)
assert.deepEqual(teardownOrder, ["services-stopped", "runtime-disposed"], "runtime disposal survives service cleanup failure")

console.log("bounded runtime plan tests passed")
