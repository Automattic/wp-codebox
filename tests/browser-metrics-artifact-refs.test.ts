import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { browserArtifactMetrics } from "../packages/runtime-playground/src/browser-metrics.js"

const bundle = await mkdtemp(join(tmpdir(), "wp-codebox-browser-metrics-"))
await mkdir(join(bundle, "files", "browser"), { recursive: true })
await writeFile(join(bundle, "files", "browser", "summary.json"), JSON.stringify({ summary: { metrics: { browser_dom_node_count: 12 } } }))
await writeFile(join(bundle, "files", "browser", "snapshot.html"), "<!doctype html><title>Fixture</title>")
await writeFile(join(bundle, "files", "browser", "screenshot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]))

const result = await browserArtifactMetrics(bundle)

assert.equal(result.metrics.browser_dom_node_count, 12)
assert.deepEqual(result.artifacts.html, { path: "files/browser/snapshot.html", kind: "html" })
assert.deepEqual(result.artifacts.screenshot, { path: "files/browser/screenshot.png", kind: "png" })

console.log("browser metrics artifact refs ok")
