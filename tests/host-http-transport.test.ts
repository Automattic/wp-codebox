import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import test from "node:test"
import { executeHostHttpTransportRequest, installHostHttpTransportRoute, parseHostHttpTransportMessage } from "../packages/runtime-playground/src/host-http-transport.js"
import type { PlaygroundCliServer, PlaygroundPreviewRouteHandler } from "../packages/runtime-playground/src/preview-server.js"

test("host HTTP messages reject private and malformed targets", () => {
  const base = { schema: "wp-codebox/host-http-transport-request/v1", id: "request-1", method: "GET", url: "https://example.com/", ips: ["93.184.216.34"], timeoutMs: 1000, maxBytes: 1024 }
  assert.ok(parseHostHttpTransportMessage(JSON.stringify(base)))
  for (const ip of ["127.0.0.1", "10.0.0.1", "::1", "0:0:0:0:0:0:0:1", "::127.0.0.1", "0:0:0:0:0:ffff:7f00:1", "0:0:0:0:0:0:0:0", "64:ff9b:1::a9fe:a9fe", "fc00::1", "fe80::1", "fec0::1", "fedf:ffff::1", "2001:db8::1"]) {
    assert.equal(parseHostHttpTransportMessage(JSON.stringify({ ...base, ips: [ip] })), undefined, ip)
  }
  assert.equal(parseHostHttpTransportMessage(JSON.stringify({ ...base, method: "POST" })), undefined)
  assert.equal(parseHostHttpTransportMessage(JSON.stringify({ ...base, timeoutMs: 60_001 })), undefined)
})

test("host HTTP requests enforce policy, pin public IPs, and preserve raw bytes", async () => {
  const message = { schema: "wp-codebox/host-http-transport-request/v1" as const, id: "request-2", method: "GET" as const, url: "https://example.com/payload", ips: ["93.184.216.34"], timeoutMs: 1000, maxBytes: 1024 }
  const denied = await executeHostHttpTransportRequest(message, "deny")
  assert.equal(denied.error?.code, "network_denied")
  const hostDenied = await executeHostHttpTransportRequest(message, { allowHosts: ["other.example"] })
  assert.equal(hostDenied.error?.code, "network_denied")

  const result = await executeHostHttpTransportRequest(message, { allowHosts: ["example.com"] }, {
    resolveHost: async () => [message.ips[0]],
    requester: async (url, ip, maxBytes, signal) => {
      assert.equal(url.toString(), message.url)
      assert.equal(ip, message.ips[0])
      assert.equal(maxBytes, message.maxBytes)
      assert.equal(signal.aborted, false)
      return { statusCode: 200, headers: { "x-test": ["pinned"] }, bodyBase64: Buffer.from([0, 1, 2, 255]).toString("base64") }
    },
  })
  assert.equal(result.success, true)
  assert.equal(result.response?.statusCode, 200)
  assert.equal(result.response?.headers["x-test"]?.[0], "pinned")
  assert.deepEqual(Buffer.from(result.response?.bodyBase64 ?? "", "base64"), Buffer.from([0, 1, 2, 255]))

  const privateResult = await executeHostHttpTransportRequest({ ...message, ips: ["127.0.0.1"] }, "allow")
  assert.equal(privateResult.error?.code, "invalid_request")
  const mismatch = await executeHostHttpTransportRequest(message, { allowHosts: ["example.com"] }, { resolveHost: async () => ["1.1.1.1"] })
  assert.equal(mismatch.error?.code, "target_ip_mismatch")
})

test("host HTTP requests abort at the absolute timeout", async () => {
  const started = Date.now()
  const result = await executeHostHttpTransportRequest(
    { schema: "wp-codebox/host-http-transport-request/v1", id: "request-3", method: "GET", url: "https://example.com/stream", ips: ["93.184.216.34"], timeoutMs: 100, maxBytes: 1024 },
    "allow",
    { requester: async (_url, _ip, _maxBytes, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })) },
  )
  assert.equal(result.success, false)
  assert.equal(result.error?.code, "deadline_exhausted")
  assert.ok(Date.now() - started < 500)
})

test("command cancellation aborts in-flight host HTTP work", async () => {
  const controller = new AbortController()
  const pending = executeHostHttpTransportRequest(
    { schema: "wp-codebox/host-http-transport-request/v1", id: "request-4", method: "GET", url: "https://example.com/stream", ips: ["93.184.216.34"], timeoutMs: 10_000, maxBytes: 1024 },
    "allow",
    { signal: controller.signal, requester: async (_url, _ip, _maxBytes, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })) },
  )
  controller.abort(new Error("command ended"))
  const result = await pending
  assert.equal(result.error?.code, "deadline_exhausted")
})

test("local host HTTP route authenticates worker-backed PHP requests and applies runtime policy", async () => {
  const handlers = new Set<PlaygroundPreviewRouteHandler>()
  const httpServer = createServer(async (incoming, outgoing) => {
    for (const handler of handlers) {
      if (await handler(incoming, outgoing)) return
    }
    outgoing.writeHead(404).end()
  })
  httpServer.listen(0, "127.0.0.1")
  await once(httpServer, "listening")
  const address = httpServer.address()
  assert.ok(address && typeof address === "object")
  const server = {
    serverUrl: `http://127.0.0.1:${address.port}`,
    playground: { run: async () => ({ text: "" }) },
    previewRoutes: { add: (handler: PlaygroundPreviewRouteHandler) => { handlers.add(handler); return () => handlers.delete(handler) } },
    async [Symbol.asyncDispose]() {},
  } satisfies PlaygroundCliServer
  const endpoint = installHostHttpTransportRoute(server, "deny")
  assert.ok(endpoint)
  const message = { schema: "wp-codebox/host-http-transport-request/v1", id: "route-1", method: "GET", url: "https://example.com/", ips: ["93.184.216.34"], timeoutMs: 1000, maxBytes: 1024 }
  try {
    const unauthenticated = await fetch(endpoint.url, { method: "POST", body: JSON.stringify(message) })
    assert.equal(unauthenticated.status, 404)
    const authenticated = await fetch(endpoint.url, { method: "POST", headers: { authorization: `Bearer ${endpoint.token}` }, body: JSON.stringify(message) })
    assert.equal(authenticated.status, 200)
    assert.equal((await authenticated.json() as { error?: { code?: string } }).error?.code, "network_denied")
  } finally {
    httpServer.close()
    await once(httpServer, "close")
  }
})
