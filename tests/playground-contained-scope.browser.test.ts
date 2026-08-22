import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer, request as httpRequest } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { chromium } from "playwright"

import type { RuntimeCreateSpec } from "../packages/runtime-core/src/index.js"
import { startPlaygroundCliServer, type PlaygroundCliModule } from "../packages/runtime-playground/src/playground-cli-runner.js"
import { closeHttpServer, listenLocalHttpServer, type PlaygroundCliServer } from "../packages/runtime-playground/src/preview-server.js"

test("CLI-started previews preserve browser sessions while credential-less worker scopes load their module closures", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "wp-codebox-contained-scope-"))
  const sessions = new Map<string, string>()
  const workerCookies: string[] = []
  const applicationCookies: string[] = []
  const absoluteAssetCookies: string[] = []
  const emptyDestinationCookies: string[] = []
  const upstream = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost")
    const cookie = request.headers.cookie ?? ""
    if (url.pathname === "/login") {
      const user = url.searchParams.get("user") ?? ""
      sessions.set(user, `session-${user}`)
      response.writeHead(200, { "content-type": "text/plain", "set-cookie": `browser_session=${sessions.get(user)}; Path=/; HttpOnly` })
      response.end(`logged-in:${user}`)
      return
    }
    if (url.pathname === "/session") {
      const user = [...sessions].find(([, session]) => cookie.includes(`browser_session=${session}`))?.[0] ?? "anonymous"
      response.writeHead(200, { "content-type": "text/plain" })
      response.end(user)
      return
    }
    if (url.pathname.endsWith("/assets/sw.js")) {
      workerCookies.push(cookie)
      if (!cookie.includes("playground_auto_login_already_happened=1")) {
        response.writeHead(302, { location: "/login?token=PRIVATE_WORKER_TOKEN" })
        response.end()
        return
      }
      response.writeHead(200, { "content-type": "application/javascript", "service-worker-allowed": url.pathname.replace(/assets\/sw\.js$/, "") })
      response.end("self.addEventListener('install', () => self.skipWaiting()); self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));")
      return
    }
    if (url.pathname === "/application.js") {
      applicationCookies.push(cookie)
      response.writeHead(200, { "content-type": "application/javascript" })
      response.end("export default 'application-module'")
      return
    }
    if (url.pathname === "/assets/absolute.js") {
      absoluteAssetCookies.push(cookie)
      response.writeHead(200, { "content-type": "application/javascript" })
      response.end("export default 'absolute-module'")
      return
    }
    if (url.pathname === "/assets/empty.js") {
      emptyDestinationCookies.push(cookie)
      response.writeHead(200, { "content-type": "application/javascript" })
      response.end("export default 'empty-destination-module'")
      return
    }
    if (url.pathname.endsWith("/assets/entry.js")) {
      if (!cookie.includes("playground_auto_login_already_happened=1")) {
        response.writeHead(401, { "content-type": "application/javascript" })
        response.end("missing bootstrap cookie")
        return
      }
      response.writeHead(200, { "content-type": "application/javascript" })
      response.end("export default import('./nested.js').then(({ value }) => value)")
      return
    }
    if (url.pathname.endsWith("/assets/nested.js")) {
      response.writeHead(200, { "content-type": "application/javascript" })
      response.end("export const value = 'contained-module-ready'")
      return
    }
    if (url.pathname.endsWith("/assets/failure.js")) {
      response.writeHead(503, { "content-type": "application/javascript" })
      response.end("unavailable")
      return
    }
    response.writeHead(200, { "content-type": "text/html" })
    response.end("<!doctype html><title>contained scope</title>")
  })
  const upstreamUrl = await listenLocalHttpServer(upstream)
  const cliModule: PlaygroundCliModule = {
    async runCLI() {
      return { serverUrl: upstreamUrl, playground: { async run() { return { text: "", exitCode: 0 } } }, async [Symbol.asyncDispose]() {} }
    },
  }
  const spec: RuntimeCreateSpec = {
    backend: "wordpress-playground",
    environment: { version: "mounted", phpVersion: "8.4", assets: { wordpressDirectory: workspace }, wordpressInstallMode: "do-not-attempt-installing", databaseSetup: "external", blueprint: {} },
    policy: { network: "deny", filesystem: "sandbox", commands: [], secrets: "none", approvals: "never" },
  }
  const server = await startPlaygroundCliServer(spec, [], { cliModule })
  const browser = await chromium.launch({ headless: true })
  try {
    const first = await browser.newContext()
    const second = await browser.newContext()
    const firstPage = await first.newPage()
    const secondPage = await second.newPage()
    assert.equal(await (await firstPage.goto(`${server.serverUrl}/login?user=first`))?.text(), "logged-in:first")
    assert.equal(await (await secondPage.goto(`${server.serverUrl}/login?user=second`))?.text(), "logged-in:second")
    assert.equal(await firstPage.evaluate(() => fetch("/session").then((response) => response.text())), "first")
    assert.equal(await secondPage.evaluate(() => fetch("/session").then((response) => response.text())), "second")
    await Promise.all([first.close(), second.close()])

    for (let scope = 0; scope < 3; scope += 1) {
      const context = await browser.newContext()
      const page = await context.newPage()
      const scopePath = `/contained-${scope}/`
      await page.goto(new URL(scopePath, server.serverUrl).toString())
      const result = await page.evaluate(async (path) => {
        const registration = await navigator.serviceWorker.register(`${path}assets/sw.js`, { scope: path })
        await navigator.serviceWorker.ready
        return { active: Boolean(registration.active), value: await import(`${path}assets/entry.js`).then((module) => module.default) }
      }, scopePath)
      assert.deepEqual(result, { active: true, value: "contained-module-ready" })
      await context.close()
    }

    const context = await browser.newContext()
    const page = await context.newPage()
    await page.goto(server.serverUrl)
    assert.equal(await page.evaluate(() => import("/application.js").then((module) => module.default)), "application-module")
    await assert.rejects(page.evaluate(() => import("/assets/failure.js?token=PRIVATE_DYNAMIC_IMPORT_TOKEN")))
    await context.close()

    await requestThroughProxy(server.serverUrl, `${upstreamUrl}/assets/absolute.js`)
    await requestThroughProxy(server.serverUrl, "/assets/empty.js")

    assert.equal(workerCookies.length, 3)
    assert(workerCookies.every((cookie) => cookie === "playground_auto_login_already_happened=1"), workerCookies.join("\n"))
    assert.deepEqual(applicationCookies, [""], "application scripts remain outside the auto-login marker scope")
    assert.deepEqual(absoluteAssetCookies, [""], "absolute-form targets remain outside the auto-login marker scope")
    assert.deepEqual(emptyDestinationCookies, [""], "asset requests without worker provenance remain outside the auto-login marker scope")
    const trace = server.previewProxyDiagnostics?.requestTrace
    assert.deepEqual(trace?.entries.at(-1), {
      sequence: 4,
      method: "GET",
      path: "/assets/failure.js?token=[redacted]",
      destination: "script",
      serviceWorker: false,
      outcome: "response",
      status: 503,
    })
    assert.doesNotMatch(JSON.stringify(trace), /PRIVATE_WORKER_TOKEN|PRIVATE_DYNAMIC_IMPORT_TOKEN|browser_session/)
  } finally {
    await browser.close()
    await server[Symbol.asyncDispose]()
    await closeHttpServer(upstream)
    await rm(workspace, { recursive: true, force: true })
  }
})

function requestThroughProxy(proxyUrl: string, target: string): Promise<void> {
  const proxy = new URL(proxyUrl)
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: proxy.hostname, port: proxy.port, path: target, headers: target.startsWith("/") ? {} : { "sec-fetch-dest": "script" } }, (response) => {
      response.resume()
      response.on("end", () => response.statusCode === 200 ? resolve() : reject(new Error(`Unexpected proxy status: ${response.statusCode}`)))
    })
    request.on("error", reject)
    request.end()
  })
}
