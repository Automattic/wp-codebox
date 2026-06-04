import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdir, readFile, rm } from "node:fs/promises"
import { resolve } from "node:path"
import { runBrowserProbeCommand } from "../packages/runtime-playground/src/browser-command-runners.js"
import type { PlaygroundCliServer } from "../packages/runtime-playground/src/preview-server.js"

const repoRoot = resolve(import.meta.dirname, "..")
const artifactRoot = resolve(repoRoot, "artifacts", "browser-probe-pre-page-script-smoke")
const prePageScript = 'window.__wpCodeboxPrePageMarker = "before-app-scripts"; window.ApplePaySession = class { static canMakePayments() { return true; } }; window.PaymentRequest = class {};'

await rm(artifactRoot, { recursive: true, force: true })
await mkdir(artifactRoot, { recursive: true })

const httpServer = createServer((_request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8")
  response.end(`<!doctype html>
    <html>
      <head>
        <script>
          window.__wpCodeboxObservedCapabilities = {
            applePay: typeof window.ApplePaySession === "function" && window.ApplePaySession.canMakePayments(),
            paymentRequest: typeof window.PaymentRequest === "function",
            marker: window.__wpCodeboxPrePageMarker,
          };
        </script>
      </head>
      <body>Browser capability fixture</body>
    </html>`)
})

await new Promise<void>((resolveListen, rejectListen) => {
  httpServer.once("error", rejectListen)
  httpServer.listen(0, "127.0.0.1", () => resolveListen())
})

try {
  const address = httpServer.address()
  assert.ok(address && typeof address === "object", "fixture server should expose an address")
  const serverUrl = `http://127.0.0.1:${address.port}`
  const server: PlaygroundCliServer = {
    serverUrl,
    playground: {
      async run() {
        return { text: "" }
      },
    },
    async [Symbol.asyncDispose]() {},
  }

  const result = await runBrowserProbeCommand({
    artifactRoot,
    server,
    spec: {
      command: "wordpress.browser-probe",
      args: [
        "url=/",
        "wait-for=load",
        "capture=html,console,errors",
        `pre-page-script=${prePageScript}`,
        "script=return window.__wpCodeboxObservedCapabilities;",
      ],
    },
  })

  assert.deepEqual(result.artifact.summary.scriptResult, {
    applePay: true,
    paymentRequest: true,
    marker: "before-app-scripts",
  })
  assert.match(result.artifact.prePageScript?.sha256 ?? "", /^[a-f0-9]{64}$/)
  assert.equal(result.artifact.prePageScript?.bytes, Buffer.byteLength(prePageScript, "utf8"))

  const summary = JSON.parse(await readFile(resolve(artifactRoot, "files", "browser", "summary.json"), "utf8")) as {
    prePageScript?: { sha256?: string; bytes?: number }
    summary?: { scriptResult?: unknown }
  }
  assert.deepEqual(summary.summary?.scriptResult, result.artifact.summary.scriptResult)
  assert.equal(summary.prePageScript?.sha256, result.artifact.prePageScript?.sha256)
  assert.equal(summary.prePageScript?.bytes, Buffer.byteLength(prePageScript, "utf8"))
} finally {
  await new Promise<void>((resolveClose, rejectClose) => {
    httpServer.close((error) => error ? rejectClose(error) : resolveClose())
  })
}

console.log(`Browser probe pre-page script smoke passed: ${artifactRoot}`)
