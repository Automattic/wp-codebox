import assert from "node:assert/strict"
import { resolve } from "node:path"

import { BrowserArtifactSession } from "../packages/runtime-playground/src/browser-artifact-session.js"
import { assertJsonFile, assertTextFile, withTempDir } from "../scripts/test-kit.js"

await withTempDir("wp-codebox-browser-artifact-session-", async (artifactRoot) => {
const session = new BrowserArtifactSession(artifactRoot, "files/browser", { source: "wordpress.browser-probe", operation: "browser-probe" })

assert.equal(session.path("snapshot.html"), "files/browser/snapshot.html")
assert.equal(session.path("/tmp/snapshot.html"), "files/browser/snapshot.html")

await session.writeText("html", "snapshot.html", "<html><body>secret</body></html>")
await session.writeJsonLines("console", "console.jsonl", [{ type: "log", text: "visible" }])
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

assert.equal(files.get("files/browser/screenshot.png")?.kind, "browser-screenshot")
assert.equal(files.get("files/browser/screenshot.png")?.contentType, "image/png")
assert.deepEqual(files.get("files/browser/screenshot.png")?.redaction, { policy: "none", sensitive: false })
})
