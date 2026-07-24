import assert from "node:assert/strict"
import test from "node:test"

import { PLAYWRIGHT_CLOCK_CONTROL_CAPABILITIES, createBrowserClockController } from "../packages/runtime-playground/src/browser-clock-control.js"

test("browser clock control is executable and reports server surfaces unsupported", async () => {
  const calls: Array<[string, unknown?]> = []
  const page = { clock: {
    async install(options: unknown) { calls.push(["install", options]) },
    async pauseAt(time: unknown) { calls.push(["pauseAt", time]) },
    async fastForward(time: unknown) { calls.push(["fastForward", time]) },
    async setSystemTime(time: unknown) { calls.push(["setSystemTime", time]) },
    async resume() { calls.push(["resume"]) },
  } } as never
  const controller = createBrowserClockController(page, "2026-01-01T00:00:00Z")
  await controller.freeze("2026-01-02T00:00:00Z")
  await controller.advance(5_000)
  await controller.skew("2026-02-01T00:00:00Z")
  await controller.restore()
  assert.deepEqual(calls.map(([method]) => method), ["install", "pauseAt", "fastForward", "setSystemTime", "resume"])
  assert.equal(PLAYWRIGHT_CLOCK_CONTROL_CAPABILITIES.capabilities.find((item) => item.surface === "browser")?.fidelity, "exact")
  assert.equal(PLAYWRIGHT_CLOCK_CONTROL_CAPABILITIES.capabilities.find((item) => item.surface === "runtime")?.fidelity, "unsupported")
})
