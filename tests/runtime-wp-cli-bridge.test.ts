import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { runRuntimeExternalHttpLoad } from "../packages/runtime-playground/src/external-http-load.js"
import { createRuntimeWpCliBridge } from "../packages/runtime-playground/src/runtime-wp-cli-bridge.js"

const bridge = await createRuntimeWpCliBridge(async () => ({ exitCode: 0, text: "", errors: "" }))
try {
  const literal = "literal;touch shell-expanded"
  const noShellResponse = await postBridgeAction(bridge.url, bridge.token, {
    type: "host_node",
    args: ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", literal],
  })
  assert.equal(noShellResponse.success, true)
  assert.deepEqual(JSON.parse(noShellResponse.stdout), [literal])
  assert.equal(noShellResponse.command, "node")
  assert.deepEqual(noShellResponse.args, ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", literal])

  const originalExecPath = process.execPath
  const fallbackDirectory = await mkdtemp(join(tmpdir(), "wp-codebox-node-fallback-"))
  try {
    const nodeShim = join(fallbackDirectory, "node")
    await writeFile(nodeShim, `#!/bin/sh\nprintf 'fallback-node:%s\\n' "$1"\n`, { mode: 0o755 })
    Object.defineProperty(process, "execPath", { value: join(fallbackDirectory, "missing-node"), configurable: true, writable: true })
    const fallbackResponse = await postBridgeAction(bridge.url, bridge.token, {
      type: "host_node",
      args: ["helper.mjs"],
      env: { PATH: `${fallbackDirectory}${delimiter}${process.env.PATH ?? ""}` },
    })
    assert.equal(fallbackResponse.success, true)
    assert.equal(fallbackResponse.stdout, "fallback-node:helper.mjs\n")
  } finally {
    Object.defineProperty(process, "execPath", { value: originalExecPath, configurable: true, writable: true })
    await rm(fallbackDirectory, { recursive: true, force: true })
  }

  const originalExecPathForFailure = process.execPath
  const emptyPathDirectory = await mkdtemp(join(tmpdir(), "wp-codebox-node-missing-"))
  try {
    Object.defineProperty(process, "execPath", { value: join(emptyPathDirectory, "missing-node"), configurable: true, writable: true })
    const missingNodeResponse = await postBridgeAction(bridge.url, bridge.token, {
      type: "host_node",
      args: ["helper.mjs"],
      env: { PATH: emptyPathDirectory },
    })
    assert.equal(missingNodeResponse.success, false)
    assert.equal(missingNodeResponse.exitCode, 127)
    assert.match(missingNodeResponse.error, /process\.execPath/)
    assert.match(missingNodeResponse.error, /node was not found on PATH/)
  } finally {
    Object.defineProperty(process, "execPath", { value: originalExecPathForFailure, configurable: true, writable: true })
    await rm(emptyPathDirectory, { recursive: true, force: true })
  }
} finally {
  await bridge.close()
}

let activeRequests = 0
let maxActiveRequests = 0
const target = createServer(async (_request, response) => {
  activeRequests++
  maxActiveRequests = Math.max(maxActiveRequests, activeRequests)
  await delay(30)
  activeRequests--
  response.writeHead(204).end()
})
await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve))
const address = target.address()
assert.ok(address && typeof address === "object")
const targetUrl = `http://127.0.0.1:${address.port}`
try {
  await assert.rejects(
    runRuntimeExternalHttpLoad({ requestCount: 101, concurrency: 1, expectedStatuses: [200] }, targetUrl),
    /requestCount must be an integer between 1 and 100/,
  )
  await assert.rejects(
    runRuntimeExternalHttpLoad({ requestCount: 2, concurrency: 3, expectedStatuses: [200] }, targetUrl),
    /concurrency must not exceed requestCount/,
  )
  await assert.rejects(
    runRuntimeExternalHttpLoad({ url: "https://example.com/", requestCount: 1, concurrency: 1, expectedStatuses: [200] }, targetUrl),
    /must resolve to the active runtime preview origin/,
  )

  const loadResponse = await runRuntimeExternalHttpLoad({
    url: "/load",
    method: "POST",
    body: "payload",
    requestCount: 8,
    concurrency: 3,
    expectedStatuses: [204],
  }, targetUrl)
  assert.equal(loadResponse.success, true)
  assert.equal(loadResponse.schema, "wp-codebox/wordpress-external-http-load/v1")
  assert.equal(loadResponse.completedCount, 8)
  assert.equal(loadResponse.successCount, 8)
  assert.equal(loadResponse.failureCount, 0)
  assert.equal(loadResponse.maxObservedConcurrency, 3)
  assert.equal(maxActiveRequests, 3)
  assert.deepEqual(loadResponse.statusDistribution, { 204: 8 })
  assert.equal(loadResponse.latenciesMs.length, 8)
  assert.equal(loadResponse.provenance.source, "host-side-external-http")
  assert.equal(loadResponse.provenance.runtimeScope, "single-runtime")

  const statusFailure = await runRuntimeExternalHttpLoad({
    url: "/load",
    requestCount: 2,
    concurrency: 1,
    expectedStatuses: [200],
  }, targetUrl)
  assert.equal(statusFailure.success, false)
  assert.equal(statusFailure.failureCount, 2)
  assert.equal(statusFailure.diagnostics[0].code, "unexpected_status")
} finally {
  await new Promise<void>((resolve, reject) => target.close((error) => error ? reject(error) : resolve()))
}

async function postBridgeAction(url: string, token: string, action: Record<string, unknown>): Promise<Record<string, any>> {
  const response = await fetch(`${url}/execute`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(action),
  })
  assert.equal(response.status, 200)
  return await response.json() as Record<string, any>
}
