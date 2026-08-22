import assert from "node:assert/strict"
import { createServer } from "node:http"
import test from "node:test"

import { chromium } from "playwright"

import { closeHttpServer, listenLocalHttpServer, withPreviewProxy, type PlaygroundCliServer } from "../packages/runtime-playground/src/preview-server.js"

test("the preview proxy registers a service worker after transient upstream redirects", async () => {
  let workerRequests = 0
  const forwardedWorkerHeaders: Array<{ serviceWorker: string | string[] | undefined; destination: string | string[] | undefined }> = []
  const upstream = createServer((request, response) => {
    if (request.url === "/sw.js") {
      workerRequests += 1
      forwardedWorkerHeaders.push({ serviceWorker: request.headers["service-worker"], destination: request.headers["sec-fetch-dest"] })
      if (workerRequests < 3) {
        response.writeHead(302, { location: "/sw.js" })
        response.end()
        return
      }
      response.writeHead(200, { "content-type": "application/javascript" })
      response.end("self.addEventListener('install', () => self.skipWaiting()); self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));")
      return
    }
    response.writeHead(200, { "content-type": "text/html" })
    response.end("<!doctype html><title>preview</title>")
  })
  const upstreamUrl = await listenLocalHttpServer(upstream)
  const proxy = await withPreviewProxy({
    playground: { async run() { return { text: "", exitCode: 0 } } },
    serverUrl: upstreamUrl,
    async [Symbol.asyncDispose]() {},
  } satisfies PlaygroundCliServer, 0)
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.goto(proxy.serverUrl)
    const registration = await page.evaluate(async () => {
      const registered = await navigator.serviceWorker.register("/sw.js")
      await navigator.serviceWorker.ready
      return { scope: registered.scope, active: !!registered.active }
    })

    assert.equal(registration.scope, `${proxy.serverUrl}/`)
    assert.equal(registration.active, true)
    assert.equal(workerRequests, 3)
    assert.deepEqual(forwardedWorkerHeaders, [
      { serviceWorker: undefined, destination: undefined },
      { serviceWorker: undefined, destination: undefined },
      { serviceWorker: undefined, destination: undefined },
    ])
    assert.deepEqual(proxy.previewProxyDiagnostics?.requestTrace.entries, [{
      sequence: 1,
      method: "GET",
      path: "/sw.js",
      destination: "serviceworker",
      serviceWorker: true,
      outcome: "response",
      status: 200,
    }])
  } finally {
    await browser.close()
    await proxy[Symbol.asyncDispose]()
    await closeHttpServer(upstream)
  }
})
