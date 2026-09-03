import assert from "node:assert/strict"
import { mkdtemp, rm, stat } from "node:fs/promises"
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
          { kind: "click", selector: "#target" },
        ],
        capture: new Set(["steps", "video"]),
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

async function pageFixture() {
  const httpServer = createServer((_request, response) => {
    response.setHeader("content-type", "text/html")
    response.end("<!doctype html><title>video fixture</title><button id=\"target\">press</button><main>ready</main>")
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
