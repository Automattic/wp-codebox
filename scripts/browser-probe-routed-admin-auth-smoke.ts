import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RuntimeCreateSpec } from "@automattic/wp-codebox-core"
import { runBrowserProbeCommand } from "../packages/runtime-playground/src/browser-command-runners.js"
import type { PlaygroundCliServer } from "../packages/runtime-playground/src/preview-server.js"

const workspace = await mkdtemp(join(tmpdir(), "wp-codebox-routed-admin-auth-"))
let server: Server | undefined

try {
  server = createServer((request, response) => {
    const cookieHeader = request.headers.cookie ?? ""
    if (request.url === "/wp-admin/" && !cookieHeader.includes("wp_codebox_logged_in=1")) {
      response.writeHead(302, { location: "https://wordpress.com/log-in?redirect_to=https%3A%2F%2Fwordpress.com%2Fwp-admin%2F" })
      response.end("missing auth")
      return
    }

    response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    response.end(`<!doctype html><title>Admin</title><main data-path="${request.url ?? "/"}" data-authenticated="${cookieHeader.includes("wp_codebox_logged_in=1")}">WP Admin</main>`)
  })
  await new Promise<void>((resolve, reject) => {
    server?.once("error", reject)
    server?.listen(0, "127.0.0.1", resolve)
  })

  const address = server.address()
  assert.ok(address && typeof address === "object")

  const localUrl = `http://127.0.0.1:${address.port}/`
  const targetUrl = "https://wordpress.com/wp-admin/"
  const runtimeSpec: RuntimeCreateSpec = { preview: { publicUrl: targetUrl } }
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
    runPlaygroundCommand: async (_command, _server, options) => ({ text: mockedAuthCookieResponse("code" in options ? options.code : "") }),
    server: serverRef,
    spec: {
      command: "wordpress.browser-probe",
      args: [
        `url=${targetUrl}`,
        "route-host=wordpress.com",
        "auth=wordpress-admin",
        "wait-for=domcontentloaded",
        "capture=html,network",
      ],
    },
  })

  assert.equal(probe.artifact.requestedUrl, targetUrl)
  assert.equal(probe.artifact.summary.finalUrl, targetUrl)
  assert.equal(probe.artifact.summary.auth?.mode, "wordpress-admin")
  assert.deepEqual(probe.artifact.summary.auth?.cookieHosts.map((host) => host.host).sort(), ["127.0.0.1", "wordpress.com"])
  assert.equal(probe.artifact.summary.networkPolicy?.routeHosts.includes("wordpress.com"), true)

  const html = await readFile(join(workspace, "files", "browser", "snapshot.html"), "utf8")
  assert.match(html, /data-path="\/wp-admin\/"/)
  assert.match(html, /data-authenticated="true"/)
  assert.doesNotMatch(probe.artifact.summary.finalUrl, /log-in/)

  const summary = JSON.parse(await readFile(join(workspace, "files", "browser", "summary.json"), "utf8"))
  assert.deepEqual(summary.summary.auth.cookieHosts.map((host: { host: string }) => host.host).sort(), ["127.0.0.1", "wordpress.com"])
  assert.doesNotMatch(JSON.stringify(summary), /wp_codebox_logged_in|secret-cookie-value/i, "artifact summary should list cookie hosts without cookie names or values")

  console.log("Browser probe routed admin auth smoke passed")
} finally {
  await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve())
  await rm(workspace, { recursive: true, force: true })
}

function mockedAuthCookieResponse(source: string): string {
  const urls = parseBrowserUrlsFromPhp(source)
  const expires = Math.floor(Date.now() / 1000) + 3600
  return `${JSON.stringify(urls.flatMap((url) => {
    const parsed = new URL(url)
    return [
      { name: "wp_codebox_admin", value: "secret-cookie-value", domain: parsed.hostname, path: "/wp-admin", expires, httpOnly: true, secure: parsed.protocol === "https:", sameSite: "Lax" },
      { name: "wp_codebox_logged_in", value: "1", domain: parsed.hostname, path: "/", expires, httpOnly: true, secure: parsed.protocol === "https:", sameSite: "Lax" },
    ]
  }))}\n`
}

function parseBrowserUrlsFromPhp(source: string): string[] {
  const match = source.match(/\$browser_urls = (\[[^;]+\]);/)
  assert.ok(match?.[1], "auth PHP should embed browser_urls")
  const parsed = JSON.parse(match[1]) as unknown
  assert.ok(Array.isArray(parsed), "browser_urls should be an array")
  return parsed.map(String)
}
