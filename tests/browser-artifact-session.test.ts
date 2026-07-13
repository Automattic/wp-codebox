import assert from "node:assert/strict"
import { resolve } from "node:path"

import { BrowserArtifactSession } from "../packages/runtime-playground/src/browser-artifact-session.js"
import { browserReviewSummary, type BrowserArtifact } from "../packages/runtime-playground/src/browser-artifacts.js"
import { browserWebSocketPayloadBytes, createBrowserWebSocketRecord } from "../packages/runtime-playground/src/browser-capture-session.js"
import { browserProbeWebSocketArtifact, browserRequestCoverageArtifact } from "../packages/runtime-playground/src/browser-probe-support.js"
import { assertJsonFile, assertTextFile, withTempDir } from "../scripts/test-kit.js"

await withTempDir("wp-codebox-browser-artifact-session-", async (artifactRoot) => {
const session = new BrowserArtifactSession(artifactRoot, "files/browser", { source: "wordpress.browser-probe", operation: "browser-probe" })

assert.equal(session.path("snapshot.html"), "files/browser/snapshot.html")
assert.equal(session.path("/tmp/snapshot.html"), "files/browser/snapshot.html")

await session.writeText("html", "snapshot.html", "<html><body>secret</body></html>")
await session.writeJsonLines("console", "console.jsonl", [{ type: "log", text: "visible" }])
await session.writeJson("requestCoverage", "request-coverage.json", { schema: "wp-codebox/browser-request-coverage/v1", totals: { requests: 1 } })
await session.writeJson("waterfall", "waterfall.json", { schema: "wp-codebox/browser-waterfall/v1", log: { entries: [] } })
await session.writeJson("websocket", "websocket.json", { schema: "wp-codebox/browser-websocket/v1", summary: { sockets: 0 } })
await session.writeJson("summary", "summary.json", { schema: "wp-codebox/browser-probe/v1", ok: true })
await session.writeBuffer("screenshot", "screenshot.png", Buffer.from([0, 1, 2]))

await assertTextFile(resolve(artifactRoot, "files/browser/snapshot.html"), "<html><body>secret</body></html>")
await assertTextFile(resolve(artifactRoot, "files/browser/console.jsonl"), '{"type":"log","text":"visible"}\n')
await assertJsonFile(resolve(artifactRoot, "files/browser/summary.json"), { schema: "wp-codebox/browser-probe/v1", ok: true })

const files = new Map(session.writer.artifacts.files().map((file) => [file.path, file]))

assert.equal(files.get("files/browser/snapshot.html")?.kind, "browser-html-snapshot")
assert.equal(files.get("files/browser/snapshot.html")?.contentType, "text/html; charset=utf-8")
assert.deepEqual(files.get("files/browser/snapshot.html")?.redaction, {
  policy: "required",
  sensitive: true,
  reason: "Browser artifacts can include page content, URLs, user data, headers, or runtime diagnostics.",
})
assert.deepEqual(files.get("files/browser/snapshot.html")?.provenance, { source: "wordpress.browser-probe", operation: "browser-probe" })

assert.equal(files.get("files/browser/console.jsonl")?.kind, "browser-console")
assert.equal(files.get("files/browser/console.jsonl")?.contentType, "application/x-ndjson")
assert.equal(files.get("files/browser/console.jsonl")?.redaction?.policy, "required")

assert.equal(files.get("files/browser/request-coverage.json")?.kind, "browser-request-coverage")
assert.equal(files.get("files/browser/request-coverage.json")?.contentType, "application/json")
assert.equal(files.get("files/browser/request-coverage.json")?.redaction?.policy, "required")

assert.equal(files.get("files/browser/waterfall.json")?.kind, "browser-waterfall")
assert.equal(files.get("files/browser/waterfall.json")?.contentType, "application/json")
assert.equal(files.get("files/browser/waterfall.json")?.redaction?.policy, "required")

assert.equal(files.get("files/browser/websocket.json")?.kind, "browser-websocket")
assert.equal(files.get("files/browser/websocket.json")?.contentType, "application/json")
assert.equal(files.get("files/browser/websocket.json")?.redaction?.policy, "required")

assert.equal(files.get("files/browser/screenshot.png")?.kind, "browser-screenshot")
assert.equal(files.get("files/browser/screenshot.png")?.contentType, "image/png")
assert.deepEqual(files.get("files/browser/screenshot.png")?.redaction, { policy: "none", sensitive: false })

const visualSession = new BrowserArtifactSession(artifactRoot, "files/browser/visual-compare/mobile", { source: "wordpress.visual-compare", operation: "visual-compare" })
await visualSession.writeJson("visualDiff", "visual-diff.json", { schema: "wp-codebox/visual-compare/v1", status: "different" })
await visualSession.writeBuffer("sourceScreenshot", "source.png", Buffer.from([3, 4, 5]))
await visualSession.writeJson("sourceDomSnapshot", "source-dom-snapshot.json", { schema: "wp-codebox/browser-dom-snapshot/v1" })
await visualSession.writeJson("candidateDomSnapshot", "candidate-dom-snapshot.json", { schema: "wp-codebox/browser-dom-snapshot/v1" })

assert.equal(visualSession.path("/tmp/source.png"), "files/browser/visual-compare/mobile/source.png")
const visualFiles = new Map(visualSession.writer.artifacts.files().map((file) => [file.path, file]))
assert.equal(visualFiles.get("files/browser/visual-compare/mobile/visual-diff.json")?.kind, "browser-visual-diff")
assert.equal(visualFiles.get("files/browser/visual-compare/mobile/visual-diff.json")?.redaction?.policy, "required")
assert.equal(visualFiles.get("files/browser/visual-compare/mobile/source.png")?.kind, "browser-visual-source-screenshot")
assert.deepEqual(visualFiles.get("files/browser/visual-compare/mobile/source.png")?.redaction, { policy: "none", sensitive: false })
assert.equal(visualFiles.get("files/browser/visual-compare/mobile/source-dom-snapshot.json")?.kind, "browser-visual-source-dom-snapshot")
assert.equal(visualFiles.get("files/browser/visual-compare/mobile/source-dom-snapshot.json")?.contentType, "application/json")
assert.equal(visualFiles.get("files/browser/visual-compare/mobile/source-dom-snapshot.json")?.redaction?.policy, "required")
assert.equal(visualFiles.get("files/browser/visual-compare/mobile/candidate-dom-snapshot.json")?.kind, "browser-visual-candidate-dom-snapshot")

const review = browserReviewSummary([{
  artifactType: "probe",
  requestedUrl: "https://example.test/",
  url: "https://example.test/",
  preview: { requestedMode: "local", effectiveMode: "local", localOrigin: "https://example.test", effectiveOrigin: "https://example.test", diagnostics: [] },
  files: { network: "files/browser/network.jsonl", waterfall: "files/browser/waterfall.json", websocket: "files/browser/websocket.json", summary: "files/browser/summary.json" },
  summary: { consoleMessages: 0, errors: 0, finalUrl: "https://example.test/", htmlSnapshot: false, networkEvents: 1, webSockets: { sockets: 1, closed: 1, errors: 0, framesSent: 1, framesReceived: 1, bytesSent: 4, bytesReceived: 2 }, replayability: "partial", screenshot: false, viewport: null },
} satisfies BrowserArtifact])
assert.equal(review?.probes[0]?.waterfall, "files/browser/waterfall.json")
assert.equal(review?.probes[0]?.websocket, "files/browser/websocket.json")
})

const requestCoverage = browserRequestCoverageArtifact([{
  type: "response",
  method: "GET",
  url: "https://example.test/wp-json/wp/v2/posts?search=secret#hash",
  resourceType: "fetch",
  status: 200,
  ok: true,
  transferSize: 120,
  responseBodySize: 80,
  timestamp: "2026-01-01T00:00:01.000Z",
}, {
  type: "requestfailed",
  method: "POST",
  url: "https://api.example.test/submit?token=secret",
  resourceType: "xhr",
  timestamp: "2026-01-01T00:00:02.000Z",
}], "2026-01-01T00:00:00.000Z")

assert.equal(requestCoverage.schema, "wp-codebox/browser-request-coverage/v1")
assert.equal(requestCoverage.totals.requests, 2)
assert.equal(requestCoverage.totals.responses, 1)
assert.equal(requestCoverage.totals.failures, 1)
assert.equal(requestCoverage.totals.hosts, 2)
assert.equal(requestCoverage.byResourceType.fetch.responses, 1)
assert.equal(requestCoverage.byMethod.POST.failures, 1)
assert.equal(requestCoverage.requests[0].url, "https://example.test/wp-json/wp/v2/posts?search=[redacted]#[redacted]")
assert.equal(requestCoverage.requests[1].url, "https://api.example.test/submit?token=[redacted]")

const webSocketRecord = createBrowserWebSocketRecord("wss://example.test/socket?token=secret#debug", "2026-01-01T00:00:00.000Z")
webSocketRecord.framesSent += 1
webSocketRecord.bytesSent += browserWebSocketPayloadBytes("ping")
webSocketRecord.framesReceived += 1
webSocketRecord.bytesReceived += browserWebSocketPayloadBytes(Buffer.from([1, 2]))
webSocketRecord.closedAt = "2026-01-01T00:00:01.000Z"
const webSocketArtifact = browserProbeWebSocketArtifact([webSocketRecord], "2026-01-01T00:00:00.000Z")

assert.equal(webSocketArtifact.schema, "wp-codebox/browser-websocket/v1")
assert.equal(webSocketArtifact.sockets[0]?.url, "wss://example.test/socket?token=[redacted]#[redacted]")
assert.deepEqual(webSocketArtifact.summary, { sockets: 1, closed: 1, errors: 0, framesSent: 1, framesReceived: 1, bytesSent: 4, bytesReceived: 2 })
