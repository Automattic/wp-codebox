import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { chromium } from "playwright"

import { browserEnvironmentMatrix } from "../packages/runtime-core/src/browser-environment-matrix.js"
import { createPlaywrightBrowserEnvironmentContext, observePlaywrightBrowserEnvironment, resolvePlaywrightBrowserEnvironment, runPlaywrightBrowserEnvironmentMatrix } from "../packages/runtime-playground/src/browser-environment-matrix.js"

test("real browser observes the mobile touch contract without overstating isMobile fidelity", async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const requested = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
    const resolved = await resolvePlaywrightBrowserEnvironment({ id: "mobile", index: 0, seed: "mobile", selections: {}, requested, requiredCapabilities: [], optionalCapabilities: [] }, browser)
    const runtime = await createPlaywrightBrowserEnvironmentContext(browser, resolved)
    try {
      await runtime.page.goto("data:text/html,<meta name=viewport content='width=device-width'><main>mobile</main>")
      const evidence = await observePlaywrightBrowserEnvironment(runtime.page, requested, resolved)
      assert.deepEqual(evidence.observed?.viewport, requested.viewport)
      assert.equal(evidence.observed?.hasTouch, true)
      assert.equal(evidence.capabilities.find(({ id }) => id === "browser.environment.touch")?.fidelity, "exact")
      assert.equal(evidence.capabilities.find(({ id }) => id === "browser.environment.mobile")?.fidelity, "emulated")
      assert.deepEqual(evidence.unsupported, [])
      assert.deepEqual(evidence.inconclusive, ["browser.environment.mobile"])
    } finally {
      await runtime.close()
    }
  } finally {
    await browser.close()
  }
})

test("real browser matrix applies viewport, media, locale, timezone, touch, zoom, and throttling", async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), "wp-codebox-browser-matrix-"))
  const browser = await chromium.launch({ headless: true })
  try {
    const matrix = browserEnvironmentMatrix({
      id: "browser-smoke",
      seed: "browser-smoke-seed",
      dimensions: [
        { id: "device", values: [{ id: "narrow-touch", environment: { viewport: { width: 320, height: 640 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, orientation: "portrait", zoom: 2 }, requiredCapabilities: ["browser.environment.viewport", "browser.environment.touch", "browser.environment.zoom"] }] },
        { id: "locale", values: [{ id: "french", environment: { locale: "fr-FR", timezone: "Europe/Paris" }, requiredCapabilities: ["browser.environment.locale", "browser.environment.timezone"] }] },
        { id: "media", values: [{ id: "hostile", environment: { colorScheme: "dark", reducedMotion: "reduce", forcedColors: "active", contrast: "more" }, requiredCapabilities: ["browser.environment.color-scheme", "browser.environment.reduced-motion", "browser.environment.forced-colors"] }] },
        { id: "resources", values: [{ id: "slow", environment: { networkProfile: "slow", cpuProfile: "slow" }, optionalCapabilities: ["browser.environment.network-profile", "browser.environment.cpu-profile"] }] },
      ],
      limits: { maxCells: 1, maxDurationMs: 30_000, maxCellDurationMs: 30_000, maxArtifactBytes: 1_048_576 },
    })
    const report = await runPlaywrightBrowserEnvironmentMatrix({
      matrix,
      runId: "smoke",
      artifactRoot,
      browser,
      options: {
        networkProfiles: { slow: { latencyMs: 20, downloadThroughputBytesPerSecond: 100_000, uploadThroughputBytesPerSecond: 50_000 } },
        cpuProfiles: { slow: { slowdownRate: 2 } },
      },
      execute: async ({ page }) => {
        await page.goto("data:text/html,<meta name=viewport content='width=device-width'><main>matrix</main>")
        const observed = await page.evaluate(() => ({
          width: innerWidth,
          language: navigator.language,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          touch: navigator.maxTouchPoints,
          dark: matchMedia("(prefers-color-scheme: dark)").matches,
          reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
          forced: matchMedia("(forced-colors: active)").matches,
          contrast: matchMedia("(prefers-contrast: more)").matches,
        }))
        assert.equal(observed.width, 320)
        assert.equal(observed.language, "fr-FR")
        assert.equal(observed.timezone, "Europe/Paris")
        assert(observed.touch > 0)
        assert.equal(observed.dark, true)
        assert.equal(observed.reduced, true)
        assert.equal(observed.forced, true)
        assert.equal(observed.contrast, true)
        return { status: "passed" }
      },
    })
    assert.equal(report.status, "passed")
    assert.equal(report.cells[0]?.effective.zoom, 2)
    assert.equal(report.cells[0]?.capabilities.find(({ id }) => id === "browser.environment.zoom")?.fidelity, "emulated")
    assert.equal(report.cells[0]?.capabilities.find(({ id }) => id === "browser.environment.cpu-profile")?.fidelity, "emulated")
    const persisted = JSON.parse(await readFile(join(artifactRoot, "browser-matrices/browser-smoke/smoke/matrix-report.json"), "utf8"))
    assert.deepEqual(persisted, report)
  } finally {
    await browser.close()
    await rm(artifactRoot, { recursive: true, force: true })
  }
})

test("real browser matrix refuses a colliding run artifact namespace", async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), "wp-codebox-browser-matrix-collision-"))
  const browser = await chromium.launch({ headless: true })
  const matrix = browserEnvironmentMatrix({ id: "collision", seed: "seed", dimensions: [{ id: "default", values: [{ id: "default", environment: {} }] }], limits: { maxCells: 1, maxDurationMs: 10_000, maxCellDurationMs: 10_000, maxArtifactBytes: 1024 } })
  try {
    const run = () => runPlaywrightBrowserEnvironmentMatrix({ matrix, runId: "same", artifactRoot, browser, execute: async () => ({ status: "passed" }) })
    await run()
    await assert.rejects(run(), (error: NodeJS.ErrnoException) => error.code === "EEXIST")
  } finally {
    await browser.close()
    await rm(artifactRoot, { recursive: true, force: true })
  }
})

test("real browser contexts apply and isolate granted, denied, and prompt geolocation", async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), "wp-codebox-browser-geolocation-"))
  const browser = await chromium.launch({ headless: true })
  const server = createServer((_request, response) => response.end("geolocation"))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert(address && typeof address === "object")
  const url = `http://127.0.0.1:${address.port}`
  const observed: Array<{ cell: string; requested: string; permission: string; latitude?: number; longitude?: number; accuracy?: number; error?: number }> = []
  try {
    const matrix = browserEnvironmentMatrix({
      id: "geolocation",
      seed: "geolocation-seed",
      dimensions: [{ id: "location", values: [
        { id: "denied", environment: { geolocation: { latitude: 40.7128, longitude: -74.006, permission: "denied" } }, requiredCapabilities: ["browser.environment.geolocation"] },
        { id: "granted", environment: { geolocation: { latitude: 32.7765, longitude: -79.9311, accuracy: 9, permission: "granted" } }, requiredCapabilities: ["browser.environment.geolocation"] },
        { id: "prompt", environment: { geolocation: { latitude: 51.5072, longitude: -0.1276, permission: "prompt" } }, requiredCapabilities: ["browser.environment.geolocation"] },
      ] }],
      limits: { maxCells: 3, maxDurationMs: 30_000, maxCellDurationMs: 10_000, maxArtifactBytes: 1_048_576 },
    })
    const report = await runPlaywrightBrowserEnvironmentMatrix({ matrix, runId: "states", artifactRoot, browser, execute: async ({ page, cell, resolved }) => {
      await page.goto(url)
      observed.push(await page.evaluate(async ({ cell, requested }) => {
        const permission = (await navigator.permissions.query({ name: "geolocation" })).state
        if (permission === "prompt") return { cell, requested, permission }
        return await new Promise((resolve) => navigator.geolocation.getCurrentPosition(
          ({ coords }) => resolve({ cell, requested, permission, latitude: coords.latitude, longitude: coords.longitude, accuracy: coords.accuracy }),
          ({ code }) => resolve({ cell, requested, permission, error: code }),
          { timeout: 1_000 },
        ))
      }, { cell: cell.selections.location!, requested: resolved.effective.geolocation!.permission }))
      return { status: "passed" }
    } })
    assert.equal(report.status, "passed")
    assert.deepEqual(observed, [
      { cell: "denied", requested: "denied", permission: "denied", error: 1 },
      { cell: "granted", requested: "granted", permission: "granted", latitude: 32.7765, longitude: -79.9311, accuracy: 9 },
      { cell: "prompt", requested: "prompt", permission: "prompt" },
    ])
    assert.deepEqual(report.cells.map((cell) => cell.effective.permissions), [[], ["geolocation"], []])

    const cells = matrix.dimensions[0]!.values.slice(1).map((value, index) => ({ id: value.id, index, seed: value.id, selections: { location: value.id }, requested: value.environment, requiredCapabilities: [], optionalCapabilities: [] }))
    const parallel = await Promise.all(cells.map(async (cell) => {
      const resolved = await resolvePlaywrightBrowserEnvironment(cell, browser)
      const runtime = await createPlaywrightBrowserEnvironmentContext(browser, resolved)
      try {
        await runtime.page.goto(url)
        return await runtime.page.evaluate(async () => ({ permission: (await navigator.permissions.query({ name: "geolocation" })).state, result: await new Promise((resolve) => navigator.geolocation.getCurrentPosition(({ coords }) => resolve([coords.latitude, coords.longitude]), ({ code }) => resolve(code), { timeout: 500 })) }))
      } finally {
        await runtime.close()
      }
    }))
    assert.deepEqual(parallel, [
      { permission: "granted", result: [32.7765, -79.9311] },
      { permission: "prompt", result: 1 },
    ])
  } finally {
    await browser.close()
    server.close()
    await rm(artifactRoot, { recursive: true, force: true })
  }
})

test("unsupported denied permission is reported by provider capability resolution", async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), "wp-codebox-browser-geolocation-unsupported-"))
  const matrix = browserEnvironmentMatrix({ id: "unsupported-geolocation", seed: "seed", dimensions: [{ id: "location", values: [{ id: "denied", environment: { geolocation: { latitude: 0, longitude: 0, permission: "denied" } } }] }] })
  const [cell] = (await import("../packages/runtime-core/src/browser-environment-matrix.js")).expandBrowserEnvironmentMatrix(matrix)
  const provider = { browserType: () => ({ name: () => "firefox" }), version: () => "fixture" } as unknown as import("playwright").Browser
  const resolved = await resolvePlaywrightBrowserEnvironment(cell!, provider)
  assert.deepEqual(resolved.capabilities.find(({ id }) => id === "browser.environment.geolocation"), { id: "browser.environment.geolocation", fidelity: "unsupported", reason: "This provider cannot express an explicit denied geolocation permission without Chromium browser permission controls." })
  try {
    const report = await runPlaywrightBrowserEnvironmentMatrix({ matrix, runId: "unsupported", artifactRoot, browser: provider, execute: async () => { throw new Error("unsupported cells must not execute") } })
    assert.equal(report.cells[0]?.status, "error")
    assert.deepEqual(report.cells[0]?.unsupported, ["browser.environment.geolocation"])
  } finally {
    await rm(artifactRoot, { recursive: true, force: true })
  }
})
