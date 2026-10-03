import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"

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
    assert.equal(result.artifact.summary.errors, 0, "a finalized recording should not add capture errors")

    const recording = join(artifactRoot, "files/browser/video.webm")
    const recorded = await stat(recording)
    assert(recorded.isFile(), "the recording must be adopted as video.webm")
    assert(recorded.size > 0, "the recording must not be empty")
    assert(recorded.size > 1_000, "the recording must contain finalized video data")
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

test("browser actions records high-density viewport video without padding", async () => {
  const fixture = await pageFixture(false, true)
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
    assert.deepEqual({ width: summary.video.width, height: summary.video.height }, { width: 430, height: 932 })

    const pixel = bottomRightVideoPixel(join(artifactRoot, "files/browser/video.webm"))
    if (pixel) {
      assert(pixel[2]! > 200 && pixel[0]! < 50, `bottom-right pixel should be blue page content, got ${pixel}`)
    } else {
      test.diagnostic?.("ffmpeg unavailable; skipped bottom-right pixel padding check")
    }
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

async function pageFixture(tall = false, fullBleed = false) {
  const httpServer = createServer((_request, response) => {
    response.setHeader("content-type", "text/html")
    response.end(`<!doctype html><title>video fixture</title><body style="margin:0;${fullBleed ? "background:rgb(0,0,255)" : ""}"><button id="target">press</button><main style="height:${tall ? 10000 : 500}px">ready</main></body>`)
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

function bottomRightVideoPixel(videoPath: string): number[] | undefined {
  const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(process.env.HOME ?? "", ".cache/ms-playwright")
  const candidates = [process.env.FFMPEG_PATH, "ffmpeg", join(browsers, "ffmpeg-1011", "ffmpeg-linux")].filter((value): value is string => Boolean(value))
  for (const ffmpeg of candidates) {
    if (ffmpeg !== "ffmpeg" && !existsSync(ffmpeg)) continue
    const result = spawnSync(ffmpeg, ["-v", "error", "-ss", "0.4", "-i", videoPath, "-frames:v", "1", "-vf", "crop=1:1:iw-2:ih-2", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { timeout: 30_000 })
    if (result.status === 0 && result.stdout.length >= 3) return [...result.stdout.subarray(0, 3)]
  }
  return undefined
}
