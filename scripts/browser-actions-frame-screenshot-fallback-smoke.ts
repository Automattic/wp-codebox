import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { browserStepRecord, executeBrowserInteractionStep } from "../packages/runtime-playground/src/browser-interactions.js"

const workspace = await mkdtemp(join(tmpdir(), "wp-codebox-frame-screenshot-fallback-"))
const screenshotPath = join(workspace, "screenshot.png")

let frameScreenshotAttempted = false
let pageScreenshotAttempted = false

const frame = {
  url: () => "https://example.test/frame",
  locator: () => ({
    first: () => ({
      screenshot: async () => {
        frameScreenshotAttempted = true
        throw new Error("locator.screenshot: Timeout 1000ms exceeded. waiting for element to be stable")
      },
    }),
  }),
}

const page = {
  locator: () => ({
    first: () => ({
      waitFor: async () => undefined,
      elementHandle: async () => ({ contentFrame: async () => frame }),
    }),
  }),
  screenshot: async ({ path, fullPage }: { path: string; fullPage?: boolean }) => {
    pageScreenshotAttempted = path === join(workspace, "screenshot-frame.png") && fullPage === true
  },
}

try {
  const outcome = await executeBrowserInteractionStep(
    page as never,
    { kind: "screenshot", frameSelector: "iframe", name: "frame" } as never,
    "https://example.test/",
    1000,
    screenshotPath,
    workspace,
  )

  assert.equal(frameScreenshotAttempted, true, "frame locator screenshot should be attempted first")
  assert.equal(pageScreenshotAttempted, true, "page screenshot fallback should be used after locator instability")
  assert.equal(outcome.screenshot, "files/browser/screenshot-frame.png")
  assert.equal(outcome.screenshotFallback?.mode, "page-screenshot")
  assert.match(outcome.screenshotFallback?.reason ?? "", /waiting for element to be stable/)

  const record = browserStepRecord(0, { kind: "screenshot", frameSelector: "iframe", name: "frame" } as never, "ok", new Date().toISOString(), Date.now(), "https://example.test/", outcome)
  assert.equal(record.screenshotFallback?.mode, "page-screenshot")
  assert.match(record.screenshotFallback?.reason ?? "", /waiting for element to be stable/)

  console.log("Browser actions frame screenshot fallback smoke passed")
} finally {
  await rm(workspace, { recursive: true, force: true })
}
