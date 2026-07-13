import assert from "node:assert/strict"
import { once } from "node:events"
import { readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { join } from "node:path"

import { PNG } from "pngjs"

import { runVisualCompareCommand } from "../packages/runtime-playground/dist/browser-visual-compare.js"
import { withTempDir } from "../scripts/test-kit.js"

const snapshot = (url: string, title: string) => ({
  url,
  title,
  elementCount: 1,
  capturedElements: [{ path: "main", tag: "main", text: title, attributes: {}, boundingBox: { x: 0, y: 0, width: 1, height: 1 }, styles: { display: "block" } }],
  truncated: false,
})

const domSnapshotArtifact = (url: string, title: string) => ({
  schema: "wp-codebox/browser-dom-snapshot/v1" as const,
  command: "wordpress.browser-actions" as const,
  screenshot: "input.png",
  finalUrl: url,
  viewport: null,
  capturedAt: "2026-01-01T00:00:00.000Z",
  limits: { maxElements: 1 },
  summary: { elementCount: 1, capturedElements: 1, truncated: false },
  snapshot: snapshot(url, title),
})

async function writePng(path: string): Promise<void> {
  const png = new PNG({ width: 1, height: 1 })
  png.data.set([255, 255, 255, 255])
  await writeFile(path, PNG.sync.write(png))
}

async function visualCompare(artifactRoot: string, args: string[]) {
  return runVisualCompareCommand({
    artifactRoot,
    server: {
      serverUrl: "http://127.0.0.1:1",
      playground: { run: async () => ({ text: "" }) },
      async [Symbol.asyncDispose]() {},
    },
    spec: { command: "wordpress.visual-compare", args },
  })
}

await withTempDir("wp-codebox-visual-dom-snapshots-", async (artifactRoot) => {
  const sourceScreenshot = join(artifactRoot, "input-source.png")
  const candidateScreenshot = join(artifactRoot, "input-candidate.png")
  const sourceSidecar = join(artifactRoot, "source-sidecar.json")
  const candidateSidecar = join(artifactRoot, "candidate-sidecar.json")
  await Promise.all([writePng(sourceScreenshot), writePng(candidateScreenshot)])
  await writeFile(sourceSidecar, JSON.stringify(domSnapshotArtifact("https://source.example.test/", "Source")))
  await writeFile(candidateSidecar, JSON.stringify(domSnapshotArtifact("https://candidate.example.test/", "Candidate")))

  const supplied = await visualCompare(artifactRoot, [
    `source-screenshot=${sourceScreenshot}`,
    `candidate-screenshot=${candidateScreenshot}`,
    `source-dom-snapshot=${sourceSidecar}`,
    `candidate-dom-snapshot=${candidateSidecar}`,
  ])
  const suppliedSummary = JSON.parse(supplied.output)
  assert.equal(suppliedSummary.schema, "wp-codebox/visual-compare/v1")
  assert.equal(suppliedSummary.files.sourceDomSnapshot, "files/browser/visual-compare/source-dom-snapshot.json")
  assert.equal(suppliedSummary.files.candidateDomSnapshot, "files/browser/visual-compare/candidate-dom-snapshot.json")
  const persistedSource = JSON.parse(await readFile(join(artifactRoot, suppliedSummary.files.sourceDomSnapshot), "utf8"))
  const persistedCandidate = JSON.parse(await readFile(join(artifactRoot, suppliedSummary.files.candidateDomSnapshot), "utf8"))
  assert.equal(persistedSource.schema, "wp-codebox/browser-dom-snapshot/v1")
  assert.equal(persistedSource.command, "wordpress.visual-compare")
  assert.equal(persistedSource.screenshot, "files/browser/visual-compare/source.png")
  assert.deepEqual(persistedSource.snapshot, snapshot("https://source.example.test/", "Source"))
  assert.equal(persistedCandidate.schema, "wp-codebox/browser-dom-snapshot/v1")
  assert.equal(persistedCandidate.screenshot, "files/browser/visual-compare/candidate.png")
  assert.equal(persistedCandidate.finalUrl, "https://candidate.example.test/")

  await withTempDir("wp-codebox-visual-dom-snapshots-screenshot-only-", async (screenshotOnlyRoot) => {
    const screenshotOnly = await visualCompare(screenshotOnlyRoot, [`source-screenshot=${sourceScreenshot}`, `candidate-screenshot=${candidateScreenshot}`])
    const screenshotOnlySummary = JSON.parse(screenshotOnly.output)
    assert.equal("sourceDomSnapshot" in screenshotOnlySummary.files, false)
    assert.equal("candidateDomSnapshot" in screenshotOnlySummary.files, false)
  })
})

const page = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html" })
  response.end("<!doctype html><title>URL snapshot</title><main>URL snapshot</main>")
})
page.listen(0, "127.0.0.1")
await once(page, "listening")
try {
  const address = page.address()
  if (!address || typeof address === "string") {
    throw new Error("test server did not expose a TCP address")
  }
  await withTempDir("wp-codebox-visual-dom-url-capture-", async (artifactRoot) => {
    const url = `http://127.0.0.1:${address.port}/`
    const result = await visualCompare(artifactRoot, [`source-url=${url}`, `candidate-url=${url}`])
    const summary = JSON.parse(result.output)
    const source = JSON.parse(await readFile(join(artifactRoot, summary.files.sourceDomSnapshot), "utf8"))
    const candidate = JSON.parse(await readFile(join(artifactRoot, summary.files.candidateDomSnapshot), "utf8"))
    assert.equal(source.schema, "wp-codebox/browser-dom-snapshot/v1")
    assert.equal(source.finalUrl, url)
    assert.equal(source.snapshot.title, "URL snapshot")
    assert.equal(candidate.snapshot.url, url)
  })
} finally {
  page.close()
}

console.log("browser visual compare DOM snapshots passed")
