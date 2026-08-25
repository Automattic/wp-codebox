import assert from "node:assert/strict"
import { access, mkdtemp, readFile, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { browserAdaptiveExplorationContract } from "../packages/runtime-core/src/index.js"
import { runBrowserActionsCommand } from "../packages/runtime-playground/src/browser-actions-runner.js"
import { captureBrowserPageHtml, trackBrowserNavigation, type BrowserNavigationTracker } from "../packages/runtime-playground/src/browser-capture-session.js"
import { browserEnvironmentCell, resolvePlaywrightBrowserEnvironment } from "../packages/runtime-playground/src/browser-environment-matrix.js"
import { chromium } from "playwright"
import { wordpressRuntimeSpec } from "../scripts/test-kit.js"

const runtimeSpec = wordpressRuntimeSpec({ commands: ["wordpress.browser-actions"] })

test("HTML capture remains unchanged when no navigation is active", async () => {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  const navigation = trackBrowserNavigation(page)
  try {
    await page.setContent("<!doctype html><title>stable capture</title><main>ready</main>")
    const result = await captureBrowserPageHtml(page, navigation, 50)
    assert.equal(result.status, "captured")
    assert.equal(result.attempts, 1)
    assert.equal(result.navigationObserved, false)
    assert.match(result.html, /stable capture/)
  } finally {
    navigation.dispose()
    await browser.close()
  }
})

test("HTML capture waits boundedly for an active navigation and captures the settled document", async () => {
  const fixture = await navigationFixture(75)
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  const navigation = trackBrowserNavigation(page)
  try {
    await page.goto(fixture.url)
    const navigated = page.goto(`${fixture.url}/slow`)
    await fixture.navigationStarted
    const result = await captureBrowserPageHtml(page, navigation, 500)
    assert.equal(result.status, "captured")
    assert.equal(result.navigationObserved, true)
    assert.match(result.html, /settled destination/)
    await navigated
  } finally {
    navigation.dispose()
    await browser.close()
    await fixture.close()
  }
})

test("HTML capture contains a page.content navigation race and retries after settlement", async () => {
  let attempts = 0
  const page = {
    async waitForTimeout() {},
    async content() {
      attempts += 1
      if (attempts === 1) throw new Error("page.content: Unable to retrieve content because the page is navigating and changing the content.")
      return "<html>settled retry</html>"
    },
  }
  const navigation: BrowserNavigationTracker = {
    navigating: () => false,
    waitForSettlement: async () => true,
    dispose() {},
  }
  const result = await captureBrowserPageHtml(page as never, navigation, 50)
  assert.equal(result.status, "captured")
  assert.equal(result.attempts, 2)
  assert.equal(result.navigationObserved, true)
})

test("HTML capture bounds a page.content call that never settles", async () => {
  const page = {
    async content() { return await new Promise<string>(() => {}) },
  }
  const navigation: BrowserNavigationTracker = {
    navigating: () => false,
    waitForSettlement: async () => true,
    dispose() {},
  }
  const startedAt = Date.now()
  const result = await captureBrowserPageHtml(page as never, navigation, 25)
  assert.equal(result.status, "navigation_unsettled")
  assert(Date.now() - startedAt < 150)
})

test("adaptive capture classifies unresolved navigation and retains partial evidence", async () => {
  const fixture = await navigationFixture(10)
  const artifactRoot = await mkdtemp(join(tmpdir(), "wp-codebox-adaptive-navigation-capture-"))
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.addInitScript("globalThis.__name = value => value")
  ;(page as unknown as { content(): Promise<string> }).content = async () => {
    throw new Error("page.content: Unable to retrieve content because the page is navigating and changing the content.")
  }
  const resolved = await resolvePlaywrightBrowserEnvironment(browserEnvironmentCell({}), browser)
  const startedAt = Date.now()
  try {
    const result = await runBrowserActionsCommand({
      artifactRoot,
      runtimeSpec,
      server: fixture.server,
      session: { browser, requested: {}, resolved, runtime: { context, page, close: async () => context.close() } },
      spec: { command: "wordpress.browser-actions", args: [] },
      plan: {
        steps: [],
        capture: new Set(["steps", "html", "network", "screenshot"]),
        stepTimeoutMs: 500,
        totalTimeoutMs: 2_000,
        networkSettleTimeoutMs: 100,
        maxDomSnapshotElements: 20,
        adaptiveExploration: browserAdaptiveExplorationContract({
          seed: "active-navigation-capture",
          startUrl: fixture.url,
          actionFamilies: ["click"],
          resetPolicy: { mode: "none" },
          failOnFinding: false,
          budgets: { maxActions: 1, maxStates: 2, maxTransitions: 1, maxDurationMs: 1_000, maxArtifactBytes: 100_000, maxErrors: 5 },
          stabilization: { pollIntervalMs: 10, quietWindowMs: 10, maxWaitMs: 40, maxMutationRecords: 20 },
        }),
      },
    })
    const adaptive = JSON.parse(await readFile(join(artifactRoot, "files/browser/adaptive-exploration.json"), "utf8"))
    assert.equal(result.artifact.summary.adaptiveExploration?.status, "incomplete")
    assert.equal(result.artifact.summary.htmlSnapshot, false)
    assert.equal(adaptive.result.status, "incomplete")
    assert(adaptive.result.diagnostics.some(({ code }: { code: string }) => code === "browser_adaptive_capture_navigation_unsettled"))
    assert(Date.now() - startedAt < 1_500, "capture settlement must remain inside the command budget")
    await access(join(artifactRoot, "files/browser/steps.jsonl"))
    await access(join(artifactRoot, "files/browser/network.jsonl"))
    await access(join(artifactRoot, "files/browser/screenshot.png"))
    await assert.rejects(access(join(artifactRoot, "files/browser/snapshot.html")))
  } finally {
    await context.close()
    await browser.close()
    await rm(artifactRoot, { recursive: true, force: true })
    await fixture.close()
  }
})

async function navigationFixture(delayMs: number) {
  let resolveNavigationStarted!: () => void
  const navigationStarted = new Promise<void>((resolve) => { resolveNavigationStarted = resolve })
  const httpServer = createServer((request, response) => {
    if (request.url === "/slow") {
      resolveNavigationStarted()
      setTimeout(() => {
        response.setHeader("content-type", "text/html")
        response.end("<!doctype html><title>settled destination</title>")
      }, delayMs)
      return
    }
    response.setHeader("content-type", "text/html")
    response.end("<!doctype html><title>starting document</title>")
  })
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve))
  const address = httpServer.address()
  assert(address && typeof address === "object")
  const url = `http://127.0.0.1:${address.port}`
  return {
    url,
    navigationStarted,
    server: {
      serverUrl: url,
      playground: { async run() { return { text: "", exitCode: 0 } } },
      async [Symbol.asyncDispose]() {},
    },
    close: () => new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve())),
  }
}
