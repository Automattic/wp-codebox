import assert from "node:assert/strict"
import { createServer } from "node:http"
import { launchChromiumBrowser } from "../packages/runtime-playground/src/browser-capture-session.js"
import { browserPreviewNetworkPolicySummary, browserPreviewTopology, routeBrowserPreviewContextNetwork } from "../packages/runtime-playground/src/browser-preview-routing.js"
import { closeHttpServer, listenLocalHttpServer, withPreviewProxy, type PlaygroundCliServer } from "../packages/runtime-playground/src/preview-server.js"

const requests: Array<{ host?: string; method?: string; url?: string; body: string; forwardedHost?: string; forwardedPort?: string; forwardedProto?: string }> = []
const upstream = createServer((request, response) => {
  let body = ""
  request.on("data", (chunk) => { body += chunk.toString() })
  request.on("end", () => {
    requests.push({
      host: request.headers.host,
      method: request.method,
      url: request.url,
      body,
      forwardedHost: request.headers["x-forwarded-host"] as string | undefined,
      forwardedPort: request.headers["x-forwarded-port"] as string | undefined,
      forwardedProto: request.headers["x-forwarded-proto"] as string | undefined,
    })
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
      response.writeHead(302, { location: "http://undeclared.example/escape/" })
      response.end()
      return
    }
    if (request.url === "/community/generated.js") {
      response.writeHead(200, { "content-type": "application/javascript" })
      response.end("window.generatedAssetLoaded = true")
      return
    }
    if (request.url === "/community/wp-login.php") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      response.end("<!doctype html><title>Community login</title><main>Login loaded</main>")
      return
    }
    if (request.url === "/community/") {
      const body = `<!doctype html><script src="${upstreamUrl}/community/generated.js"></script><a id="login" href="${upstreamUrl}/community/wp-login.php">Log in</a><a id="hostname-only" href="http://127.0.0.1/community/">Community</a><a id="unrelated-port" href="http://127.0.0.1:9999/">Unrelated</a>`
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": String(Buffer.byteLength(body)),
        etag: "internal-authority-body",
      })
      const splitOrigin = Buffer.from(upstreamUrl)
      response.write(Buffer.concat([Buffer.from("<!doctype html><script src=\""), splitOrigin.subarray(0, splitOrigin.length - 2)]))
      response.end(`${splitOrigin.subarray(splitOrigin.length - 2).toString()}/community/generated.js\"></script><a id=\"login\" href=\"${upstreamUrl}/community/wp-login.php\">Log in</a><a id=\"hostname-only\" href=\"http://127.0.0.1/community/\">Community</a><a id=\"unrelated-port\" href=\"http://127.0.0.1:9999/\">Unrelated</a>`)
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
  const directResponse = await fetch(`${proxy.serverUrl}/direct-preview/`)
  assert.equal(directResponse.status, 200)
  const proxyOrigin = new URL(proxy.serverUrl)
  const upstreamOrigin = new URL(upstreamUrl)
  assert(requests.some((request) => request.url === "/direct-preview/" && request.host === upstreamOrigin.host && request.forwardedHost === proxyOrigin.host && request.forwardedPort === proxyOrigin.port && request.forwardedProto === "http"))

  const pathContext = await browser.newContext()
  const pathPage = await pathContext.newPage()
  await pathPage.goto(`${proxy.serverUrl}/community/`, { waitUntil: "load" })
  assert.equal(await pathPage.evaluate(() => (window as typeof window & { generatedAssetLoaded?: boolean }).generatedAssetLoaded), true)
  assert.equal(await pathPage.locator("script").getAttribute("src"), `${proxy.serverUrl}/community/generated.js`)
  assert.equal(await pathPage.locator("#login").getAttribute("href"), `${proxy.serverUrl}/community/wp-login.php`)
  assert.equal(await pathPage.locator("#hostname-only").getAttribute("href"), `${proxy.serverUrl}/community/`)
  assert.equal(await pathPage.locator("#unrelated-port").getAttribute("href"), "http://127.0.0.1:9999/")
  await Promise.all([pathPage.waitForURL(`${proxy.serverUrl}/community/wp-login.php`), pathPage.click("#login")])
  assert.equal(await pathPage.locator("main").textContent(), "Login loaded")
  assert(requests.some((request) => request.url === "/community/generated.js" && request.host === upstreamOrigin.host && request.forwardedHost === proxyOrigin.host))
  assert(requests.some((request) => request.url === "/community/wp-login.php" && request.host === upstreamOrigin.host && request.forwardedHost === proxyOrigin.host))
  await pathContext.close()

  const context = await browser.newContext({
    ...topology.contextOptions(),
    extraHTTPHeaders: {
      "x-forwarded-host": "spoofed.example",
      "x-forwarded-port": "443",
      "x-forwarded-proto": "https",
    },
  })
  await routeBrowserPreviewContextNetwork(context, topology.networkPolicy, topology.origins.localProxyOrigin)
  const page = await context.newPage()

  await page.goto(topology.resolveUrl("/events/"), { waitUntil: "load" })
  assert.equal(new URL(page.url()).origin, "http://localhost")
  assert(requests.some((request) => request.url === "/events/" && request.host === "localhost" && request.forwardedHost === "localhost" && request.forwardedPort === "80" && request.forwardedProto === "http"))
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

  await assert.rejects(page.goto("http://undeclared.example/escape/"))
  await assert.rejects(page.goto("http://localhost/events/external-redirect/"))
  const policyEvidence = browserPreviewNetworkPolicySummary(topology.networkPolicy)
  assert((policyEvidence.hosts["undeclared.example"]?.blocked ?? 0) >= 1, JSON.stringify(policyEvidence))
  assert(policyEvidence.blockedRequests >= 1)

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
