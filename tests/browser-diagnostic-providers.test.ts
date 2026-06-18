import assert from "node:assert/strict"

import { BrowserProbeSessionResultBuilder } from "../packages/runtime-playground/src/browser-probe-session-result-builder.js"
import type { BrowserProbeSessionResultInput } from "../packages/runtime-playground/src/browser-probe-session-result-builder.js"
import type { BrowserWordPressDiagnosticsSummary } from "../packages/runtime-playground/src/browser-artifacts.js"
import { createBrowserProbeProgressTracker } from "../packages/runtime-playground/src/browser-probe-support.js"
import { browserWordPressDiagnosticProvider } from "../packages/runtime-playground/src/browser-wordpress-diagnostic-provider.js"
import type { PlaygroundCliServer } from "../packages/runtime-playground/src/preview-server.js"

const baseInput = (): BrowserProbeSessionResultInput => ({
  assertions: [],
  browser: { name: "chromium", channel: "chromium", version: null },
  browserFilesDirectory: "files/browser",
  capture: new Set(["network"]),
  captureSelection: { console: false, errors: false, network: true, metrics: false, consoleForAssertions: false, errorsForAssertions: false, networkForAssertions: false },
  checkpoints: [],
  command: "browser.probe",
  consoleMessages: [],
  durationMs: 0,
  errors: [],
  failFast: false,
  finalUrl: "https://example.test/",
  hashes: {},
  lifecycleSelectors: [],
  liveness: { wallTimeoutMs: 30_000, stallTimeoutMs: 0, networkSettleTimeoutMs: 500 },
  network: [],
  preview: { requestedMode: "local", effectiveMode: "local", localOrigin: "https://example.test", effectiveOrigin: "https://example.test", diagnostics: [] },
  progress: createBrowserProbeProgressTracker("2026-01-01T00:00:00.000Z", 0),
  requestedUrl: "https://example.test/",
  startedAt: "2026-01-01T00:00:00.000Z",
  startedAtMs: Date.now(),
  throttleId: null,
  topologyOrigins: {},
  viewport: null,
  waitFor: "domcontentloaded",
})

const genericResult = new BrowserProbeSessionResultBuilder().compose(baseInput())
assert.equal(genericResult.artifact.files.wordpressDiagnostics, undefined)
assert.equal(genericResult.artifact.summary.wordpressDiagnostics, undefined)
assert.equal(genericResult.review.wordpressDiagnostics, undefined)
assert.doesNotMatch(genericResult.output, /wordpressDiagnostics/)

const wordpressSummary: BrowserWordPressDiagnosticsSummary = {
  status: "captured",
  artifact: "files/browser/wordpress-diagnostics.json",
  document5xxResponses: 1,
  diagnostics: 1,
  fatalErrors: 1,
  classifications: ["php-fatal"],
}

const wordpressResult = new BrowserProbeSessionResultBuilder().compose({
  ...baseInput(),
  command: "wordpress.browser-probe",
  wordpressDiagnostics: { summary: wordpressSummary },
})
assert.equal(wordpressResult.artifact.files.wordpressDiagnostics, "files/browser/wordpress-diagnostics.json")
assert.deepEqual(wordpressResult.artifact.summary.wordpressDiagnostics, wordpressSummary)
assert.deepEqual(wordpressResult.review.wordpressDiagnostics, wordpressSummary)
assert.match(wordpressResult.output, /wordpressDiagnostics/)

const server = {
  serverUrl: "https://example.test",
  playground: {
    readFileAsText: async () => `${JSON.stringify({
      schema: "wp-codebox/browser-wordpress-diagnostic-record/v1",
      classification: "php-fatal",
      message: "Fatal error",
      capturedAt: "2026-01-01T00:00:00.000Z",
    })}\n`,
  },
  async [Symbol.asyncDispose]() {},
} satisfies PlaygroundCliServer
const provider = browserWordPressDiagnosticProvider()
const providerArtifact = await provider.collect({
  artifactPath: "files/browser/wordpress-diagnostics.json",
  command: "wordpress.browser-probe",
  network: [{ type: "response", url: "https://example.test/", method: "GET", resourceType: "document", timestamp: "2026-01-01T00:00:00.000Z", status: 500, statusText: "Internal Server Error" }],
  server,
  setupResult: true,
})
assert.equal(providerArtifact?.key, "wordpressDiagnostics")
assert.equal(providerArtifact?.fileName, "wordpress-diagnostics.json")
assert.equal((providerArtifact?.summary as BrowserWordPressDiagnosticsSummary | undefined)?.status, "captured")

console.log("browser diagnostic providers ok")
