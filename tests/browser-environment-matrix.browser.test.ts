import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { chromium } from "playwright"

import { browserEnvironmentMatrix } from "../packages/runtime-core/src/browser-environment-matrix.js"
import { runPlaywrightBrowserEnvironmentMatrix } from "../packages/runtime-playground/src/browser-environment-matrix.js"

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
