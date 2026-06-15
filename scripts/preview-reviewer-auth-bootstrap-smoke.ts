import assert from "node:assert/strict"
import { createServer } from "node:http"
import { createServer as createNetServer } from "node:net"
import { withPreviewProxy, type PlaygroundCliServer } from "../packages/runtime-playground/src/preview-server.js"
import type { RuntimeCreateSpec } from "@automattic/wp-codebox-core"

const target = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/plain" })
  response.end("target ok")
})
await listen(target, 0)
const targetAddress = target.address()
assert.ok(targetAddress && typeof targetAddress === "object")

const fakeServer: PlaygroundCliServer = {
  playground: {
    async run() {
      return {
        text: JSON.stringify([
          {
            name: "wordpress_logged_in_smoke",
            value: "fixture-cookie-value",
            path: "/",
            expires: Math.floor(Date.now() / 1000) + 60,
            httpOnly: true,
            secure: false,
            sameSite: "Lax",
          },
        ]),
      }
    },
  },
  serverUrl: `http://127.0.0.1:${targetAddress.port}`,
  async [Symbol.asyncDispose]() {},
}

const proxyPort = await reserveFreePort()
const runtimeSpec = { backend: "wordpress-playground", environment: { kind: "wordpress" }, policy: {} } as RuntimeCreateSpec
const proxy = await withPreviewProxy(fakeServer, proxyPort, "127.0.0.1", runtimeSpec)

try {
  assert.equal(typeof proxy.createReviewerAuthBootstrap, "function")
  const reviewerAuth = await proxy.createReviewerAuthBootstrap?.({
    runtimeId: "runtime-smoke",
    targetPath: "/wp-admin/post.php?post=1&action=edit",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    holdSeconds: 60,
    userId: 1,
  })

  assert.equal(reviewerAuth?.schema, "wp-codebox/preview-reviewer-auth/v1")
  assert.equal(reviewerAuth?.reviewerSafe, true)
  assert.equal(reviewerAuth?.scope.origin, `http://127.0.0.1:${proxyPort}`)
  assert.ok(reviewerAuth?.url.includes("/_wp-codebox/reviewer-auth/bootstrap?token="))

  const response = await fetch(reviewerAuth!.url, { redirect: "manual" })
  assert.equal(response.status, 302)
  assert.equal(response.headers.get("location"), "/wp-admin/post.php?post=1&action=edit")
  assert.match(response.headers.get("set-cookie") ?? "", /wordpress_logged_in_smoke=fixture-cookie-value/)
  assert.match(response.headers.get("cache-control") ?? "", /no-store/)
} finally {
  await proxy[Symbol.asyncDispose]()
  await close(target)
}

console.log("Preview reviewer auth bootstrap smoke passed")

async function reserveFreePort(): Promise<number> {
  const server = createNetServer()
  await listen(server, 0)
  const address = server.address()
  assert.ok(address && typeof address === "object")
  const port = address.port
  await close(server)
  return port
}

function listen(server: ReturnType<typeof createServer> | ReturnType<typeof createNetServer>, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => resolve())
  })
}

function close(server: ReturnType<typeof createServer> | ReturnType<typeof createNetServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
}
