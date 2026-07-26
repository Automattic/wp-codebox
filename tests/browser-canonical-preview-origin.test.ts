import assert from "node:assert/strict"
import { createServer } from "node:http"
import { launchChromiumBrowser } from "../packages/runtime-playground/src/browser-capture-session.js"
import { browserPreviewTopology, routeBrowserPreviewContextNetwork } from "../packages/runtime-playground/src/browser-preview-routing.js"
import { closeHttpServer, listenLocalHttpServer, withPreviewProxy, type PlaygroundCliServer } from "../packages/runtime-playground/src/preview-server.js"

const requests: Array<{ host?: string; method?: string; url?: string; body: string }> = []
const upstream = createServer((request, response) => {
  let body = ""
  request.on("data", (chunk) => { body += chunk.toString() })
  request.on("end", () => {
    requests.push({ host: request.headers.host, method: request.method, url: request.url, body })
    if (request.url === "/events/redirect/") {
      response.writeHead(302, { location: "http://localhost/events/final/" })
      response.end()
      return
    }
    if (request.url === "/events/local-redirect/") {
      response.writeHead(302, { location: `${upstreamUrl}/events/final/` })
      response.end()
      return
    }
    if (request.url === "/events/external-redirect/") {
      response.writeHead(302, { location: "https://undeclared.example/escape/" })
      response.end()
      return
    }

    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "set-cookie": "canonical_cookie=present; Path=/events/; SameSite=Lax",
    })
    response.end(`<!doctype html>
      <title>Canonical preview</title>
      <form id="canonical-form" method="post" action="http://localhost/events/form/"><input name="value" value="canonical"><button>Submit</button></form>
      <a id="subsite" href="http://localhost/events/subsite/">Subsite</a>
      <script>localStorage.setItem("canonical-storage", "present")</script>`)
  })
})
const upstreamUrl = await listenLocalHttpServer(upstream)
const proxy = await withPreviewProxy({
  playground: { async run() { return { text: "" } } },
  serverUrl: upstreamUrl,
  async [Symbol.asyncDispose]() {},
} satisfies PlaygroundCliServer, 0)
const topology = browserPreviewTopology(
  ["route-host=localhost"],
  { preview: { siteUrl: "http://localhost/events/" } },
  proxy.serverUrl,
  proxy.previewProxyDiagnostics?.targetOrigin,
)
const browser = await launchChromiumBrowser()

try {
  const context = await browser.newContext(topology.contextOptions())
  await routeBrowserPreviewContextNetwork(context, topology.networkPolicy, topology.origins.localProxyOrigin)
  const page = await context.newPage()

  await page.goto(topology.resolveUrl("/events/"), { waitUntil: "load" })
  assert.equal(new URL(page.url()).origin, "http://localhost")
  assert.deepEqual(await page.evaluate(() => {
    history.pushState({}, "", "http://localhost/events/pushed/")
    history.replaceState({}, "", "http://localhost/events/replaced/")
    return {
      cookie: document.cookie,
      origin: location.origin,
      pathname: location.pathname,
      storage: localStorage.getItem("canonical-storage"),
    }
  }), {
    cookie: "canonical_cookie=present",
    origin: "http://localhost",
    pathname: "/events/replaced/",
    storage: "present",
  })

  await page.goto("http://localhost/events/")
  await Promise.all([page.waitForURL("http://localhost/events/form/"), page.click("#canonical-form button")])
  assert(requests.some((request) => request.host === "localhost" && request.method === "POST" && request.url === "/events/form/" && request.body === "value=canonical"))

  await page.goto("http://localhost/events/redirect/")
  assert.equal(page.url(), "http://localhost/events/final/")
  await page.goto("http://localhost/events/local-redirect/")
  assert.equal(page.url(), "http://localhost/events/final/")

  await page.goto("http://localhost/events/")
  await Promise.all([page.waitForURL("http://localhost/events/subsite/"), page.click("#subsite")])
  assert.equal(page.url(), "http://localhost/events/subsite/")

  await assert.rejects(page.goto("https://undeclared.example/escape/"))
  await assert.rejects(page.goto("http://localhost/events/external-redirect/"))

  assert.deepEqual(topology.origins, {
    localPreviewOrigin: proxy.serverUrl,
    effectivePreviewOrigin: "http://localhost/events/",
    canonicalBrowserOrigin: "http://localhost",
    localProxyOrigin: new URL(proxy.serverUrl).origin,
    upstreamRuntimeOrigin: new URL(upstreamUrl).origin,
  })
  await context.close()
} finally {
  await browser.close()
  await proxy[Symbol.asyncDispose]()
  await closeHttpServer(upstream)
}
