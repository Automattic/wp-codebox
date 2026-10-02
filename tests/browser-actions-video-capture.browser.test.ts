import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { runBrowserActionsCommand } from "../packages/runtime-playground/src/browser-actions-runner.js"
import { wordpressRuntimeSpec } from "../scripts/test-kit.js"

const runtimeSpec = wordpressRuntimeSpec({ commands: ["wordpress.browser-actions"] })

test("browser actions capture=video records the session and adopts it as a named artifact", async () => {
  const fixture = await pageFixture()
  const artifactRoot = await mkdtemp(join(tmpdir(), "wp-codebox-browser-video-"))
  try {
    const result = await runBrowserActionsCommand({
      artifactRoot,
      runtimeSpec,
      server: fixture.server,
      spec: { command: "wordpress.browser-actions", args: [] },
      plan: {
        steps: [
          { kind: "navigate", url: fixture.url, waitFor: "load" },
          { kind: "click", selector: "#target", marker: "button pressed" },
          { kind: "screenshot", name: "after-action" },
        ],
        capture: new Set(["steps", "video"]),
        requestedEnvironment: { viewport: { width: 430, height: 932 }, deviceScaleFactor: 2 },
        videoSize: { width: 860, height: 1864 },
        stepTimeoutMs: 2_000,
        totalTimeoutMs: 10_000,
        networkSettleTimeoutMs: 100,
        maxDomSnapshotElements: 20,
      },
    })

    assert.equal(result.artifact.summary.video, true, "the summary must report the recording")

    const recording = join(artifactRoot, "files/browser/video.webm")
    const recorded = await stat(recording)
    assert(recorded.isFile(), "the recording must be adopted as video.webm")
    assert(recorded.size > 0, "the recording must not be empty")
    const summary = JSON.parse(await readFile(join(artifactRoot, "files/browser/action-summary.json"), "utf8"))
    assert.deepEqual({ width: summary.video.width, height: summary.video.height }, { width: 860, height: 1864 })
    assert.deepEqual(summary.video.markers.map((marker: { index: number; name: string }) => [marker.index, marker.name]), [[1, "button pressed"], [2, "after-action"]])
    assert(summary.video.markers.every((marker: { startMs: number; endMs: number }, index: number, markers: Array<{ startMs: number }>) => marker.startMs >= 0 && marker.endMs >= marker.startMs && (index === 0 || marker.startMs >= markers[index - 1]!.startMs)))
    const records = (await readFile(join(artifactRoot, "files/browser/steps.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    assert(records.every((record) => record.videoOffsetMs && record.videoOffsetMs.endMs >= record.videoOffsetMs.startMs))
  } finally {
    await rm(artifactRoot, { recursive: true, force: true })
    await fixture.close()
  }
})

test("screenshot steps during video capture default to viewport-sized captures", async () => {
  const fixture = await pageFixture(true)
  const artifactRoot = await mkdtemp(join(tmpdir(), "wp-codebox-browser-video-"))
  try {
    await runBrowserActionsCommand({
      artifactRoot,
      runtimeSpec,
      server: fixture.server,
      spec: { command: "wordpress.browser-actions", args: [] },
      plan: {
        steps: [{ kind: "navigate", url: fixture.url, waitFor: "load" }, { kind: "screenshot" }],
        capture: new Set(["steps", "video"]),
        requestedEnvironment: { viewport: { width: 430, height: 932 } },
        stepTimeoutMs: 2_000,
        totalTimeoutMs: 10_000,
        networkSettleTimeoutMs: 100,
        maxDomSnapshotElements: 20,
      },
    })

    const screenshot = await readFile(join(artifactRoot, "files/browser/screenshot.png"))
    assert.equal(screenshot.readUInt32BE(20), 932, "screenshot height should remain the configured viewport, not the document height")
    const records = (await readFile(join(artifactRoot, "files/browser/steps.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    assert.equal(records[1].fullPage, undefined, "the step record omits an unspecified option")
  } finally {
    await rm(artifactRoot, { recursive: true, force: true })
    await fixture.close()
  }
})

test("browser actions scales video dimensions from a high-density viewport by default", async () => {
  const fixture = await pageFixture()
  const artifactRoot = await mkdtemp(join(tmpdir(), "wp-codebox-browser-video-"))
  try {
    await runBrowserActionsCommand({
      artifactRoot,
      runtimeSpec,
      server: fixture.server,
      spec: { command: "wordpress.browser-actions", args: [] },
      plan: {
        steps: [{ kind: "navigate", url: fixture.url, waitFor: "load" }],
        capture: new Set(["steps", "video"]),
        requestedEnvironment: { viewport: { width: 430, height: 932 }, deviceScaleFactor: 2.5 },
        stepTimeoutMs: 2_000,
        totalTimeoutMs: 10_000,
        networkSettleTimeoutMs: 100,
        maxDomSnapshotElements: 20,
      },
    })

    const summary = JSON.parse(await readFile(join(artifactRoot, "files/browser/action-summary.json"), "utf8"))
    assert.deepEqual({ width: summary.video.width, height: summary.video.height }, { width: 1075, height: 2330 })
  } finally {
    await rm(artifactRoot, { recursive: true, force: true })
    await fixture.close()
  }
})

test("browser actions rejects an unsupported capture value", async () => {
  const fixture = await pageFixture()
  const artifactRoot = await mkdtemp(join(tmpdir(), "wp-codebox-browser-video-"))
  try {
    await assert.rejects(
      runBrowserActionsCommand({
        artifactRoot,
        runtimeSpec,
        server: fixture.server,
        spec: { command: "wordpress.browser-actions", args: [] },
        plan: {
          steps: [{ kind: "navigate", url: fixture.url, waitFor: "load" }],
          capture: new Set(["recording"]),
          stepTimeoutMs: 500,
          totalTimeoutMs: 2_000,
          networkSettleTimeoutMs: 100,
          maxDomSnapshotElements: 20,
        },
      }),
      /capture supports .*video/,
    )
  } finally {
    await rm(artifactRoot, { recursive: true, force: true })
    await fixture.close()
  }
})

async function pageFixture(tall = false) {
  const httpServer = createServer((_request, response) => {
    response.setHeader("content-type", "text/html")
    response.end(`<!doctype html><title>video fixture</title><button id="target">press</button><main style="height:${tall ? 10000 : 500}px">ready</main>`)
  })
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve))
  const address = httpServer.address()
  assert(address && typeof address === "object")
  const url = `http://127.0.0.1:${address.port}`
  return {
    url,
    server: {
      serverUrl: url,
      playground: { async run() { return { text: "", exitCode: 0 } } },
      async [Symbol.asyncDispose]() {},
    },
    close: () => new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve())),
  }
}
