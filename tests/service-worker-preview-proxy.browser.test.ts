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
      contentType: "application/javascript",
      bodyRewritten: true,
    }])
  } finally {
    await browser.close()
    await proxy[Symbol.asyncDispose]()
    await closeHttpServer(upstream)
  }
})

test("the preview proxy returns a connected client from the packaged Playground remote", { timeout: 60_000 }, async () => {
  const app = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" })
    response.end("<!doctype html><title>Playground proxy integration</title>")
  })
  const appUrl = await listenLocalHttpServer(app)
  const proxy = await withPreviewProxy({
    playground: { async run() { return { text: "", exitCode: 0 } } },
    serverUrl: "https://playground.wordpress.net",
    async [Symbol.asyncDispose]() {},
  } satisfies PlaygroundCliServer, 5400)
  const browser = await chromium.launch({ headless: true })
  const consoleMessages: string[] = []
  const pageErrors: string[] = []
  try {
    const page = await browser.newPage()
    page.on("console", (message) => {
      if (consoleMessages.length < 32) consoleMessages.push(`${message.type()}: ${message.text()}`)
    })
    page.on("pageerror", (error) => {
      if (pageErrors.length < 32) pageErrors.push(error.message)
    })
    await page.goto(appUrl)
    const startup = page.evaluate(async (remoteUrl) => {
      const { startPlaygroundWeb } = await import("https://playground.wordpress.net/client/index.js")
      const iframe = document.createElement("iframe")
      document.body.append(iframe)
      const client = await startPlaygroundWeb({
        iframe,
        remoteUrl,
        corsProxyUrl: "https://wordpress-playground-cors-proxy.net/?",
        blueprint: { steps: [] },
      })
      await client.isConnected()
      return { connected: true, url: await client.getCurrentURL() }
    }, `${proxy.serverUrl}/remote.html`)
    const result: { connected?: boolean; url?: string; error?: string; timeout?: true } = await Promise.race([
      startup.catch((error: Error) => ({ error: error.message })),
      new Promise<{ timeout: true }>((resolve) => setTimeout(() => resolve({ timeout: true }), 45_000)),
    ])
    const trace = proxy.previewProxyDiagnostics?.requestTrace

    assert.equal(result.connected, true, JSON.stringify({ consoleMessages, pageErrors, trace }, null, 2))
    assert.equal(typeof result.url, "string", JSON.stringify({ consoleMessages, pageErrors, trace }, null, 2))
    assert.deepEqual(pageErrors, [], JSON.stringify({ consoleMessages, trace }, null, 2))
    assert.deepEqual(consoleMessages.filter((message) => /service worker|worker script|failed to load/i.test(message)), [], JSON.stringify({ pageErrors, trace }, null, 2))
    const workerResponse = trace?.entries.find((entry) => entry.path === "/sw.js" && entry.serviceWorker)
    assert.deepEqual(workerResponse && {
      status: workerResponse.status,
      contentType: workerResponse.contentType,
      bodyRewritten: workerResponse.bodyRewritten,
    }, {
      status: 200,
      contentType: "application/javascript",
      bodyRewritten: true,
    })
  } finally {
    await browser.close()
    await proxy[Symbol.asyncDispose]()
    await closeHttpServer(app)
  }
})
