import assert from "node:assert/strict"
import { once } from "node:events"
import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import { join } from "node:path"

import { chromium } from "playwright"
import { PNG } from "pngjs"

import { runVisualCompareCommand, waitForVisualComparePaintReady } from "../packages/runtime-playground/dist/browser-visual-compare.js"
import { withTempDir } from "../scripts/test-kit.js"

const page = createServer((_request, response) => {
  if (_request.url === "/never.css") return
  if (_request.url === "/stalled") {
    response.writeHead(200, { "content-type": "text/html" })
    response.end("<!doctype html><main>stalled stylesheet</main>")
    return
  }
  response.writeHead(200, { "content-type": "text/html" })
  response.end(`<!doctype html>
    <title>Deterministic URL capture</title>
    <link rel="stylesheet" href="https://example.invalid/blocked.css">
    <style>
      @keyframes capture-color { from { background: rgb(255, 0, 0); } to { background: rgb(0, 0, 255); } }
      #animated { width: 20px; height: 20px; animation: capture-color 10s linear forwards; }
    </style>
    <div id="animated"></div>
    <p id="styled">Styled</p>
    <p id="state"></p>
    <script>
      document.querySelector("#state").textContent = [
        Date.now(),
        +new Date(),
        Date(),
        +new Date(2001, 1, 3),
        Date.parse("2001-02-03T00:00:00.000Z"),
        Date.UTC(2001, 1, 3),
        matchMedia("(prefers-reduced-motion: reduce)").matches,
      ].join("|")
    </script>`)
})

page.listen(0, "127.0.0.1")
await once(page, "listening")
try {
  const address = page.address()
  if (!address || typeof address === "string") throw new Error("test server did not expose a TCP address")
  const url = `http://127.0.0.1:${address.port}/`
  await withTempDir("wp-codebox-visual-url-capture-", async (artifactRoot) => {
    const result = await runVisualCompareCommand({
      artifactRoot,
      server: { serverUrl: url, playground: { run: async () => ({ text: "" }) }, async [Symbol.asyncDispose]() {} },
      spec: {
        command: "wordpress.visual-compare",
        args: [
          `source-url=${url}`,
          `candidate-url=${url}`,
          "viewport=320x240",
          "reduced-motion=true",
          "animations=freeze",
          "frozen-time=2020-01-01T00:00:00.000Z",
          "capture-style=#styled { color: rgb(1, 2, 3); }",
          "block-external-requests=true",
          "explain-selector=#animated",
          "explain-selector=#styled",
          "explain-selector=#state",
        ],
      },
    })
    const summary = JSON.parse(result.output)
    const source = summary.captureDiagnostics.source
    assert.equal(source.environment.viewport.width, 320)
    assert.equal(source.environment.reducedMotion, true)
    assert.equal(source.effectiveCapture.animations, "freeze")
    assert.equal(source.effectiveCapture.frozenTime, "2020-01-01T00:00:00.000Z")
    assert.equal(source.effectiveCapture.externalRequests, "block")
    assert.equal(source.effectiveCapture.requests.blockedTotal, 1)
    assert.equal(source.effectiveCapture.requests.blockedTruncated, false)
    assert.match(source.effectiveCapture.requests.blocked[0].url, /example\.invalid\/blocked\.css/)
    assert.equal(source.effectiveCapture.readiness.fonts, "ready")
    assert.ok(source.effectiveCapture.readiness.durationMs >= 0)

    const sourceSnapshot = JSON.parse(await readFile(join(artifactRoot, summary.files.sourceDomSnapshot), "utf8"))
    const byId = Object.fromEntries(sourceSnapshot.snapshot.capturedElements.map((element: { attributes: { id?: string } }) => [element.attributes.id, element])) as Record<string, { text: string; styles: Record<string, string> }>
    const dateState = byId.state.text.split("|")
    assert.equal(dateState[0], "1577836800000")
    assert.equal(dateState[1], "1577836800000")
    assert.equal(Date.parse(dateState[2] ?? ""), 1577836800000)
    assert.notEqual(dateState[3], dateState[1])
    assert.equal(dateState[4], dateState[5])
    assert.equal(dateState[6], "true")
    assert.equal(byId.styled.styles.color, "rgb(1, 2, 3)")
    assert.equal(byId.animated.styles["background-color"], "rgb(255, 0, 0)")

    const screenshot = PNG.sync.read(await readFile(join(artifactRoot, summary.files.sourceScreenshot)))
    const offset = (screenshot.width * 10 + 10) << 2
    assert.deepEqual([...screenshot.data.subarray(offset, offset + 3)], [255, 0, 0])
  })

  const browser = await chromium.launch({ headless: true })
  try {
    const stalled = await browser.newPage()
    await stalled.addInitScript(() => Object.defineProperty(Date, "now", { configurable: true, value: () => 0 }))
    await stalled.goto(`${url}stalled`, { waitUntil: "domcontentloaded" })
    await stalled.evaluate(() => {
      const link = document.createElement("link")
      link.rel = "stylesheet"
      link.href = "/never.css"
      document.head.append(link)
    })
    const startedAt = performance.now()
    await waitForVisualComparePaintReady(stalled, 1_000)
    const elapsedMs = performance.now() - startedAt
    assert.ok(elapsedMs >= 800 && elapsedMs < 2_500, `stalled stylesheet readiness must remain bounded under frozen Date.now(), got ${elapsedMs}ms`)
  } finally {
    await browser.close()
  }
} finally {
  page.close()
}

console.log("browser visual compare URL capture passed")
