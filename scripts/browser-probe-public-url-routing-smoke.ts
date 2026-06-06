import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RuntimeCreateSpec } from "@automattic/wp-codebox-core"
import { runBrowserProbeCommand } from "../packages/runtime-playground/src/browser-command-runners.js"
import type { PlaygroundCliServer } from "../packages/runtime-playground/src/preview-server.js"

const workspace = await mkdtemp(join(tmpdir(), "wp-codebox-browser-probe-public-url-routing-"))
let server: Server | undefined

try {
  server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    response.end(`<!doctype html><title>Probe</title><main data-path="${request.url ?? "/"}">OK</main>`)
  })
  await new Promise<void>((resolve, reject) => {
    server?.once("error", reject)
    server?.listen(0, "127.0.0.1", resolve)
  })

  const address = server.address()
  assert.ok(address && typeof address === "object")

  const localUrl = `http://127.0.0.1:${address.port}/local-route/`
  const publicUrl = `http://127.0.0.1:${address.port}/public-route/`
  const runtimeSpec: RuntimeCreateSpec = { preview: { publicUrl } }
  const serverRef: PlaygroundCliServer = {
    playground: {
      async run() {
        return { text: "" }
      },
    },
    serverUrl: localUrl,
    async [Symbol.asyncDispose]() {},
  }

  const publicProbe = await runBrowserProbeCommand({
    artifactRoot: join(workspace, "public"),
    runtimeSpec,
    server: serverRef,
    spec: { command: "wordpress.browser-probe", args: ["url=relative-probe", "wait-for=domcontentloaded", "capture=html"] },
  })
  assert.equal(publicProbe.artifact.requestedUrl, `${publicUrl}relative-probe`)
  assert.equal(publicProbe.artifact.preview.requestedMode, "public")
  assert.equal(publicProbe.artifact.preview.effectiveMode, "public")
  assert.equal(publicProbe.artifact.preview.publicOrigin, publicUrl)
  assert.equal(publicProbe.artifact.preview.effectiveOrigin, publicUrl)
  assert.equal(publicProbe.artifact.summary.windowLocationOrigin, new URL(publicUrl).origin)

  const localProbe = await runBrowserProbeCommand({
    artifactRoot: join(workspace, "local"),
    runtimeSpec,
    server: serverRef,
    spec: { command: "wordpress.browser-probe", args: ["url=relative-probe", "wait-for=domcontentloaded", "capture=html", "preview-mode=local"] },
  })
  assert.equal(localProbe.artifact.requestedUrl, `${localUrl}relative-probe`)
  assert.equal(localProbe.artifact.preview.requestedMode, "local")
  assert.equal(localProbe.artifact.preview.effectiveMode, "local")
  assert.equal(localProbe.artifact.preview.publicOrigin, publicUrl)
  assert.equal(localProbe.artifact.preview.effectiveOrigin, localUrl)
  assert.equal(localProbe.artifact.summary.windowLocationOrigin, new URL(localUrl).origin)

  console.log("Browser probe public URL routing smoke passed")
} finally {
  await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve())
  await rm(workspace, { recursive: true, force: true })
}
