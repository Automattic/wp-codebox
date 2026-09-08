import assert from "node:assert/strict"
import { createServer } from "node:http"
import { runRuntimeExternalHttpLoad, waitForRuntimePreviewReady } from "../packages/runtime-playground/src/external-http-load.ts"

let activeRequests = 0
let maxActiveRequests = 0
let requestCount = 0
let receivedMethod = ""
let receivedBody = ""
let receivedSecret = ""
let redirectTargetRequests = 0
let readinessRequests = 0

const redirectTarget = createServer((_request, response) => {
  redirectTargetRequests++
  response.writeHead(204).end()
})
await listen(redirectTarget)
const redirectTargetAddress = redirectTarget.address()
assert.ok(redirectTargetAddress && typeof redirectTargetAddress === "object")

const readinessRedirector = createServer((_request, response) => {
  response.writeHead(302, { location: `http://127.0.0.1:${redirectTargetAddress.port}/outside` }).end()
})
await listen(readinessRedirector)
const readinessRedirectorAddress = readinessRedirector.address()
assert.ok(readinessRedirectorAddress && typeof readinessRedirectorAddress === "object")

const runtime = createServer(async (request, response) => {
  if (request.url === "/") {
    readinessRequests++
    if (readinessRequests === 1) {
      response.writeHead(302, { location: "/" }).end()
      return
    }
    response.writeHead(204).end()
    return
  }
  if (request.url === "/broken") {
    response.destroy()
    return
  }
  if (request.url === "/partial") {
    response.writeHead(200, { "content-length": "10" })
    response.end("x")
    return
  }
  if (request.url === "/redirect") {
    response.writeHead(302, { location: `http://127.0.0.1:${redirectTargetAddress.port}/outside` }).end()
    return
  }

  activeRequests++
  maxActiveRequests = Math.max(maxActiveRequests, activeRequests)
  requestCount++
  receivedMethod = request.method ?? ""
  receivedSecret = String(request.headers["x-test-secret"] ?? "")
  for await (const chunk of request) {
    receivedBody += chunk
  }
  await new Promise((resolve) => setTimeout(resolve, 20))
  activeRequests--
  response.writeHead(204).end()
})
await listen(runtime)
const runtimeAddress = runtime.address()
assert.ok(runtimeAddress && typeof runtimeAddress === "object")
const runtimeUrl = `http://127.0.0.1:${runtimeAddress.port}`

try {
  await waitForRuntimePreviewReady(runtimeUrl)
  assert.equal(readinessRequests, 2)
  await assert.rejects(waitForRuntimePreviewReady(`http://127.0.0.1:${readinessRedirectorAddress.port}`), /leaves the preview origin/)
  assert.equal(redirectTargetRequests, 0)

  const matched = await runRuntimeExternalHttpLoad({
    url: "/matched",
    method: "POST",
    headers: { "x-test-secret": "request-secret" },
    body: "request-body",
    requestCount: 6,
    concurrency: 3,
    expectedStatuses: [204],
  }, runtimeUrl)
  assert.equal(matched.success, true)
  assert.equal(matched.completedCount, 6)
  assert.equal(matched.successCount, 6)
  assert.equal(matched.failureCount, 0)
  assert.equal(matched.maxObservedConcurrency, 3)
  assert.equal(maxActiveRequests, 3)
  assert.equal(requestCount, 6)
  assert.equal(receivedMethod, "POST")
  assert.equal(receivedBody, "request-body".repeat(6))
  assert.equal(receivedSecret, "request-secret")
  assert.deepEqual(matched.statusDistribution, { 204: 6 })
  assert.deepEqual(matched.conditions, { expectedStatuses: [204] })
  assert.equal(matched.samples.length, 6)
  assert.ok(matched.samples.every((sample) => sample.status === 204 && sample.durationMs >= 0 && sample.outcome === "matched-status"))
  assert.equal(JSON.stringify(matched).includes("request-secret"), false)
  assert.equal(JSON.stringify(matched).includes("request-body"), false)

  const unexpected = await runRuntimeExternalHttpLoad({
    url: "/unexpected",
    requestCount: 2,
    concurrency: 1,
    expectedStatuses: [200],
  }, runtimeUrl)
  assert.equal(unexpected.success, false)
  assert.equal(unexpected.completedCount, 2)
  assert.equal(unexpected.failureCount, 2)
  assert.deepEqual(unexpected.samples.map((sample) => sample.outcome), ["unexpected-status", "unexpected-status"])
  assert.deepEqual(unexpected.samples.map((sample) => sample.status), [204, 204])

  const connectionError = await runRuntimeExternalHttpLoad({
    url: "/broken",
    requestCount: 1,
    concurrency: 1,
    expectedStatuses: [204],
  }, runtimeUrl)
  assert.equal(connectionError.success, false)
  assert.equal(connectionError.completedCount, 1)
  assert.deepEqual(connectionError.samples[0].outcome, "request-error")
  assert.equal(connectionError.samples[0].errorCode, "fetch-failed")
  assert.equal(connectionError.diagnostics[0].code, "request_failed")
  assert.equal(JSON.stringify(connectionError).includes(runtimeUrl), false)

  const partialBody = await runRuntimeExternalHttpLoad({
    url: "/partial",
    requestCount: 1,
    concurrency: 1,
    expectedStatuses: [200],
  }, runtimeUrl)
  assert.equal(partialBody.success, false)
  assert.equal(partialBody.completedCount, 1)
  assert.equal(partialBody.samples[0].outcome, "request-error")
  assert.ok(["fetch-failed", "response-read-failed"].includes(partialBody.samples[0].errorCode ?? ""))

  const redirect = await runRuntimeExternalHttpLoad({
    url: "/redirect",
    requestCount: 1,
    concurrency: 1,
    expectedStatuses: [204],
  }, runtimeUrl)
  assert.equal(redirect.success, false)
  assert.equal(redirect.samples[0].errorCode, "fetch-failed")
  assert.equal(redirectTargetRequests, 0)
} finally {
  await close(runtime)
  await close(readinessRedirector)
  await close(redirectTarget)
}

console.log("external HTTP load behavioral test passed")

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}
