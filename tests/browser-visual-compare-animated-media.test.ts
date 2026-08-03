import assert from "node:assert/strict"
import { once } from "node:events"
import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import { join } from "node:path"

import sharp from "sharp"

import { runVisualCompareCommand } from "../packages/runtime-playground/dist/browser-visual-compare.js"
import { withTempDir } from "../scripts/test-kit.js"

const red = await sharp({ create: { width: 24, height: 24, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } }).png().toBuffer()
const blue = await sharp({ create: { width: 24, height: 24, channels: 4, background: { r: 0, g: 0, b: 255, alpha: 1 } } }).png().toBuffer()
const animated = await sharp([red, blue], { join: { animated: true, delay: [1, 1], loop: 0 } }).gif().toBuffer()
const staticImage = await sharp({ create: { width: 24, height: 24, channels: 4, background: { r: 0, g: 200, b: 0, alpha: 1 } } }).png().toBuffer()
const malformedImage = Buffer.from("GIF89a-not-an-image")

const server = createServer((request, response) => {
  if (request.url === "/media/source.gif" || request.url === "/media/candidate.gif") {
    response.writeHead(200, { "content-type": "image/gif", "cache-control": "no-store" })
    response.end(animated)
    return
  }
  if (request.url === "/media/static.png") {
    response.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" })
    response.end(staticImage)
    return
  }
  if (request.url === "/media/broken.gif") {
    response.writeHead(200, { "content-type": "image/gif", "cache-control": "no-store" })
    response.end(malformedImage)
    return
  }
  if (request.url === "/failure-source" || request.url === "/failure-candidate") {
    response.writeHead(200, { "content-type": "text/html" })
    response.end('<!doctype html><style>html,body{margin:0}</style><img src="/media/broken.gif">')
    return
  }
  const animatedPath = request.url === "/candidate" ? "/media/candidate.gif" : "/media/source.gif"
  response.writeHead(200, { "content-type": "text/html" })
  response.end(`<!doctype html><style>html,body{margin:0}img{display:block;width:24px;height:24px}</style><img src="${animatedPath}"><img src="/media/static.png">`)
})

server.listen(0, "127.0.0.1")
await once(server, "listening")
try {
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("test server did not expose a TCP address")
  const origin = `http://127.0.0.1:${address.port}`
  await withTempDir("wp-codebox-visual-animated-media-", async (artifactRoot) => {
    const capture = async () => JSON.parse((await runVisualCompareCommand({
      artifactRoot,
      server: { serverUrl: origin, playground: { run: async () => ({ text: "" }) }, async [Symbol.asyncDispose]() {} },
      spec: { command: "wordpress.visual-compare", args: [`source-url=${origin}/source`, `candidate-url=${origin}/candidate`, "viewport=120x80", "full-page=false", "animated-media=first-frame"] },
    })).output)

    const first = await capture()
    const second = await capture()
    for (const result of [first, second]) {
      assert.equal(result.comparison.mismatchPixels, 0)
      assert.equal(result.hashes.sourceScreenshot.value, result.hashes.candidateScreenshot.value)
      const source = result.captureDiagnostics.source.effectiveCapture.animatedMedia
      const candidate = result.captureDiagnostics.candidate.effectiveCapture.animatedMedia
      assert.deepEqual({ policy: source.policy, observed: source.observed, normalized: source.normalized, failed: source.failed, timedOut: source.timedOut }, { policy: "first-frame", observed: 1, normalized: 1, failed: 0, timedOut: 0 })
      assert.equal(source.details.length, 1)
      assert.equal(candidate.details.length, 1)
      assert.equal(source.details[0].contentDigest.value, candidate.details[0].contentDigest.value)
      assert.equal(source.details[0].normalizedFrameDigest.value, candidate.details[0].normalizedFrameDigest.value)
      assert.equal(source.details[0].contentAddress, candidate.details[0].contentAddress)
    }
    assert.equal(first.hashes.sourceScreenshot.value, second.hashes.sourceScreenshot.value)
    assert.equal(first.captureDiagnostics.source.effectiveCapture.animatedMedia.details[0].normalizedFrameDigest.value, second.captureDiagnostics.source.effectiveCapture.animatedMedia.details[0].normalizedFrameDigest.value)

    const screenshot = await sharp(await readFile(join(artifactRoot, first.files.sourceScreenshot))).raw().toBuffer({ resolveWithObject: true })
    assert.deepEqual([...screenshot.data.subarray(0, 3)], [255, 0, 0], "animated media must normalize to frame zero")
    const staticPixel = (24 * screenshot.info.width) * screenshot.info.channels
    assert.deepEqual([...screenshot.data.subarray(staticPixel, staticPixel + 3)], [0, 200, 0], "static image pixels must pass through unchanged")

    const failure = JSON.parse((await runVisualCompareCommand({
      artifactRoot,
      server: { serverUrl: origin, playground: { run: async () => ({ text: "" }) }, async [Symbol.asyncDispose]() {} },
      spec: { command: "wordpress.visual-compare", args: [`source-url=${origin}/failure-source`, `candidate-url=${origin}/failure-candidate`, "viewport=120x80", "full-page=false", "animated-media=first-frame"] },
    })).output)
    const failureEvidence = failure.captureDiagnostics.source.effectiveCapture.animatedMedia
    assert.equal(failureEvidence.normalized, 0)
    assert.equal(failureEvidence.failed, 1)
    assert.equal(failureEvidence.failures.length, 1)
    assert.equal(failureEvidence.failures[0].timeout, false)
    assert.match(failureEvidence.failures[0].contentDigest.value, /^[a-f0-9]{64}$/)
    assert.ok(failureEvidence.failures[0].error.length > 0 && failureEvidence.failures[0].error.length <= 500)
  })
} finally {
  server.close()
}

console.log("browser visual compare animated media passed")
