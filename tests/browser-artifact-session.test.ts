import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { BrowserArtifactSession } from "../packages/runtime-playground/src/browser-artifact-session.js"

const artifactRoot = mkdtempSync(resolve(tmpdir(), "wp-codebox-browser-artifact-session-"))
const session = new BrowserArtifactSession(artifactRoot, "files/browser", { source: "wordpress.browser-probe", operation: "browser-probe" })

assert.equal(session.path("snapshot.html"), "files/browser/snapshot.html")
assert.equal(session.path("/tmp/snapshot.html"), "files/browser/snapshot.html")

await session.writeText("html", "snapshot.html", "<html><body>secret</body></html>")
await session.writeJsonLines("console", "console.jsonl", [{ type: "log", text: "visible" }])
await session.writeJson("summary", "summary.json", { schema: "wp-codebox/browser-probe/v1", ok: true })
await session.writeBuffer("screenshot", "screenshot.png", Buffer.from([0, 1, 2]))

assert.equal(await readFile(resolve(artifactRoot, "files/browser/snapshot.html"), "utf8"), "<html><body>secret</body></html>")
assert.equal(await readFile(resolve(artifactRoot, "files/browser/console.jsonl"), "utf8"), '{"type":"log","text":"visible"}\n')
assert.equal(await readFile(resolve(artifactRoot, "files/browser/summary.json"), "utf8"), '{\n  "schema": "wp-codebox/browser-probe/v1",\n  "ok": true\n}\n')

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
