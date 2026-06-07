import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RuntimeCreateSpec } from "@automattic/wp-codebox-core"
import { runBrowserProbeCommand } from "../packages/runtime-playground/src/browser-command-runners.js"
import type { PlaygroundCliServer } from "../packages/runtime-playground/src/preview-server.js"

const workspace = await mkdtemp(join(tmpdir(), "wp-codebox-browser-probe-network-policy-"))
let server: Server | undefined

try {
  server = createServer((request, response) => {
    const host = request.headers.host ?? ""
    if (request.url === "/allowed-pixel") {
      response.writeHead(200, { "content-type": "image/svg+xml" })
      response.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>')
      return
    }

    response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    response.end(`<!doctype html>
      <title>Network Policy Probe</title>
      <main data-host="${host}">Network Policy</main>
      <img id="allowed" src="https://allowed.test/allowed-pixel" alt="Allowed">
      <img id="blocked" src="https://blocked.test/blocked-pixel" alt="Blocked">
    `)
  })
  await new Promise<void>((resolve, reject) => {
    server?.once("error", reject)
    server?.listen(0, "127.0.0.1", resolve)
  })

  const address = server.address()
  assert.ok(address && typeof address === "object")

  const localUrl = `http://127.0.0.1:${address.port}/`
  const canonicalUrl = "https://page.test/"
  const runtimeSpec: RuntimeCreateSpec = { preview: { publicUrl: canonicalUrl } }
  const serverRef: PlaygroundCliServer = {
    playground: {
      async run() {
        return { text: "" }
      },
    },
    serverUrl: localUrl,
    async [Symbol.asyncDispose]() {},
  }

  const probe = await runBrowserProbeCommand({
    artifactRoot: workspace,
    runtimeSpec,
    server: serverRef,
    spec: {
      command: "wordpress.browser-probe",
      args: [
        `url=${canonicalUrl}`,
        "route-host=page.test,allowed.test",
        "network-policy=block",
        "allow-host=page.test,allowed.test",
        "block-host=blocked.test",
        "record-external=true",
        "wait-for=load",
        "capture=html,network",
      ],
    },
  })

  assert.equal(probe.artifact.summary.finalUrl, canonicalUrl)
  assert.equal(probe.artifact.networkPolicy?.mode, "block")
  assert.deepEqual(probe.artifact.networkPolicy?.allowHosts, ["allowed.test", "page.test"])
  assert.deepEqual(probe.artifact.networkPolicy?.blockHosts, ["blocked.test"])
  assert.deepEqual(probe.artifact.networkPolicy?.routeHosts, ["allowed.test", "page.test"])
  assert.equal(probe.artifact.networkPolicy?.hosts["allowed.test"]?.blocked, 0)
  assert.equal(probe.artifact.networkPolicy?.hosts["allowed.test"]?.routed, 1)
  assert.equal(probe.artifact.networkPolicy?.hosts["blocked.test"]?.blocked, 1)
  assert.equal(probe.artifact.networkPolicy?.blockedRequests, 1)

  const summary = JSON.parse(await readFile(join(workspace, "files", "browser", "summary.json"), "utf8"))
  assert.equal(summary.networkPolicy.mode, "block")
  assert.equal(summary.summary.networkPolicy.blockedRequests, 1)
  assert.equal(summary.summary.networkPolicy.hosts["blocked.test"].blocked, 1)

  const networkLog = await readFile(join(workspace, "files", "browser", "network.jsonl"), "utf8")
  assert.match(networkLog, /allowed\.test\/allowed-pixel/)
  assert.match(networkLog, /blocked\.test\/blocked-pixel/)

  console.log("Browser probe network policy smoke passed")
} finally {
  await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve())
  await rm(workspace, { recursive: true, force: true })
}
