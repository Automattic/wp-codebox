import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { chromium } from "playwright"

import type { TransportFaultModel } from "../packages/runtime-core/src/index.js"
import { runBrowserActionsCommand, runBrowserScenarioCommand } from "../packages/runtime-playground/src/browser-actions-runner.js"
import { isBrowserCommandArtifactError } from "../packages/runtime-playground/src/browser-command-artifact-error.js"
import { installBrowserTransportFaults } from "../packages/runtime-playground/src/browser-transport-faults.js"
import type { PlaygroundCliServer } from "../packages/runtime-playground/src/preview-server.js"
import { wordpressRuntimeSpec } from "../scripts/test-kit.js"

const runtimeSpec = wordpressRuntimeSpec({ commands: ["wordpress.browser-actions", "wordpress.browser-actions.evaluate", "wordpress.browser-scenario"] })

test("real browser faults cover delay, timeout, refusal, reset, malformed, truncation, recovery, and unmatched rules", async () => {
  const fixture = await browserFixture()
  const artifactRoot = await mkdtemp(join(tmpdir(), "wp-codebox-browser-fault-semantics-"))
  const schedule: TransportFaultModel = {
    schema: "wp-codebox/transport-fault-model/v1",
    seed: "browser-semantics",
    rules: [
      { id: "delay", match: { path: "/delay" }, sequence: [{ delayMs: 120 }] },
      { id: "timeout", match: { path: "/timeout" }, sequence: [{ timeoutMs: 10 }] },
      { id: "refuse", match: { path: "/refuse" }, sequence: [{ connection: "refuse" }] },
      { id: "reset", match: { path: "/reset" }, sequence: [{ connection: "reset" }] },
      { id: "malformed", match: { path: "/malformed" }, sequence: [{ malformed: true }] },
      { id: "truncated", match: { path: "/truncated" }, sequence: [{ truncateAfterBytes: 4 }] },
      { id: "recovery", match: { method: "POST", path: "/api" }, sequence: [{ status: 503, body: "fault" }, { passthrough: true }], repeat: "none" },
      { id: "unmatched", match: { path: "/never" }, sequence: [{ status: 500 }] },
    ],
  }
  try {
    const steps = [
      { kind: "evaluate", expression: "await Promise.all([Date.now(), fetch('/delay')]).then(([started, response]) => ({ status: response.status, delayed: Date.now() - started >= 80 }))", assert: { status: 200, delayed: true } },
      ...["timeout", "refuse", "reset"].map((name) => ({ kind: "evaluate", expression: `await fetch('/${name}').then(() => false, () => true)`, assert: true })),
      { kind: "evaluate", expression: "[...new Uint8Array(await fetch('/malformed').then(r => r.arrayBuffer()))].slice(0, 3)", assert: [255, 254, 0] },
      { kind: "evaluate", expression: "await fetch('/truncated').then(r => r.text())", assert: "runt" },
      { kind: "evaluate", expression: "[await fetch('/api', { method: 'POST' }).then(r => r.status), await fetch('/api', { method: 'POST' }).then(r => r.status)]", assert: [503, 200] },
      { kind: "evaluate", expression: "await navigator.serviceWorker.register('/sw.js').then(registration => registration ? Promise.race([new Promise(resolve => { const worker = registration.installing ?? registration.waiting ?? registration.active; if (worker?.state === 'activated') resolve(true); else worker?.addEventListener('statechange', () => worker.state === 'activated' && resolve(true)); }), new Promise(resolve => setTimeout(() => resolve(false), 500))]).then(activated => ({ registered: true, activated })) : ({ registered: false, activated: false }), () => ({ registered: false, activated: false }))", assert: { registered: false, activated: false } },
    ]
    const result = await runBrowserScenarioCommand({
      artifactRoot,
      runtimeSpec,
      server: fixture.server,
      spec: { command: "wordpress.browser-scenario", args: [`scenario-json=${JSON.stringify({ url: "/", transportFaults: schedule, captures: ["steps", "network"], steps })}`] },
    })
    assert.equal(result.artifact.summary.transportFaults?.matchedRequests, 8)
    assert.deepEqual(result.artifact.summary.transportFaults?.unmatchedRules, ["unmatched"])
    const report = JSON.parse(await readFile(join(artifactRoot, "files/browser/transport-faults.json"), "utf8"))
    assert.deepEqual(report.consumedSequenceEntries.filter(({ ruleId }: { ruleId: string }) => ruleId === "recovery").map(({ sequenceIndex }: { sequenceIndex: number }) => sequenceIndex), [0, 1])
    assert.equal(report.interception.browserHttp.fidelity, "exact")
    assert.equal(report.interception.browserHttp.serviceWorkers, "blocked")
    assert.equal(report.interception.wordpressHttp.fidelity, "unsupported")
    assert.equal(report.replay.fidelity, "identity-only-redacted")
    assert.equal(report.replay.structuralScheduleFingerprint, report.schedule.structuralFingerprint)
    assert.equal(fixture.requests.filter(({ url }) => url === "/sw.js").length, 0)
  } finally {
    await fixture.close()
    await rm(artifactRoot, { recursive: true, force: true })
  }
})

test("response transforms preserve blocked-host enforcement and routed preview remapping", async () => {
  const fixture = await browserFixture()
  const blocked = await browserFixture()
  const artifactRoot = await mkdtemp(join(tmpdir(), "wp-codebox-browser-fault-routing-"))
  const routedHost = "routed-fault.test"
  const blockedUrl = `http://localhost:${blocked.port}/truncated`
  const routedUrl = `http://${routedHost}:${fixture.port}/truncated`
  const schedule: TransportFaultModel = {
    schema: "wp-codebox/transport-fault-model/v1",
    seed: "routing-policy",
    rules: [
      { id: "blocked-transform", match: { host: `localhost:${blocked.port}`, path: "/truncated" }, sequence: [{ truncateAfterBytes: 4 }] },
      { id: "routed-transform", match: { host: `${routedHost}:${fixture.port}`, method: "POST", path: "/truncated" }, sequence: [{ requestCorruption: "truncate", truncateAfterBytes: 4 }] },
    ],
  }
  try {
    const result = await runBrowserActionsCommand({
      artifactRoot,
      runtimeSpec,
      server: fixture.server,
      spec: { command: "wordpress.browser-actions", args: [
        "url=/",
        `route-host=${routedHost}`,
        "block-host=localhost",
        `transport-faults-json=${JSON.stringify(schedule)}`,
        `steps-json=${JSON.stringify([{ kind: "evaluate", expression: `({ blocked: await fetch(${JSON.stringify(blockedUrl)}).then(() => false, () => true), routed: await fetch(${JSON.stringify(routedUrl)}, { method: 'POST', body: 'abcdefgh' }).then(r => r.text()) })`, assert: { blocked: true, routed: "runt" } }])}`,
        "capture=steps,network",
      ] },
    })
    assert.equal(blocked.requests.filter(({ url }) => url === "/truncated").length, 0)
    assert(fixture.requests.some(({ host, url }) => host === `${routedHost}:${fixture.port}` && url === "/truncated"), JSON.stringify(fixture.requests))
    assert.equal(fixture.requests.find(({ host, url }) => host === `${routedHost}:${fixture.port}` && url === "/truncated")?.body, "abcd")
    assert.equal(result.artifact.summary.networkPolicy?.blockedRequests, 1)
    assert.equal(result.artifact.summary.transportFaults?.matchedRequests, 1)
    assert.deepEqual(result.artifact.summary.transportFaults?.unmatchedRules, ["blocked-transform"])
  } finally {
    await Promise.all([fixture.close(), blocked.close()])
    await rm(artifactRoot, { recursive: true, force: true })
  }
})

test("fault disposal cancels delayed background requests and freezes sequence evidence", async () => {
  const fixture = await browserFixture()
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ serviceWorkers: "block" })
  const page = await context.newPage()
  const installed = await installBrowserTransportFaults(context, {
    schema: "wp-codebox/transport-fault-model/v1",
    seed: "dispose-delayed",
    rules: [{ id: "slow", match: { path: "/slow" }, sequence: [{ delayMs: 10_000 }], repeat: "cycle" }],
  }, { serviceWorkersBlocked: true })
  try {
    await page.goto(fixture.server.serverUrl)
    await page.evaluate(() => { void fetch("/slow").catch(() => undefined) })
    await waitFor(() => installed.inFlight() === 1)
    const report = await installed.dispose()
    const evidenceCount = installed.adapter.evidence().length
    await page.evaluate(() => fetch("/slow").then((response) => response.text()))
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(report.matchedRequests.length, evidenceCount)
    assert.equal(installed.adapter.evidence().length, evidenceCount)
    assert.deepEqual(installed.report(), report)
    assert.equal(fixture.requests.filter(({ url }) => url === "/slow").length, 1)
  } finally {
    await context.close()
    await browser.close()
    await fixture.close()
  }
})

test("failed and sequential browser runs tear down fault routes", async () => {
  const fixture = await browserFixture()
  const failedRoot = await mkdtemp(join(tmpdir(), "wp-codebox-browser-fault-failed-"))
  const cleanRoot = await mkdtemp(join(tmpdir(), "wp-codebox-browser-fault-clean-"))
  try {
    await assert.rejects(runBrowserActionsCommand({
      artifactRoot: failedRoot,
      runtimeSpec,
      server: fixture.server,
      spec: { command: "wordpress.browser-actions", args: ["url=/", `transport-faults-json=${JSON.stringify(faultModel("failed-run", 599))}`, `steps-json=${JSON.stringify([{ kind: "evaluate", expression: "await fetch('/api', { method: 'POST' }).then(r => r.status)", assert: 599 }, { kind: "expect", selector: "#missing", state: "visible", timeout: "50ms" }])}`, "capture=steps"] },
    }), (error: unknown) => isBrowserCommandArtifactError(error))
    const clean = await runBrowserActionsCommand({
      artifactRoot: cleanRoot,
      runtimeSpec,
      server: fixture.server,
      spec: { command: "wordpress.browser-actions", args: ["url=/", `steps-json=${JSON.stringify([{ kind: "evaluate", expression: "await fetch('/api', { method: 'POST' }).then(r => r.status)", assert: 200 }])}`, "capture=steps"] },
    })
    assert.equal(clean.artifact.summary.transportFaults, undefined)
  } finally {
    await fixture.close()
    await Promise.all([rm(failedRoot, { recursive: true, force: true }), rm(cleanRoot, { recursive: true, force: true })])
  }
})

test("parallel browser fault schedules remain context-local", async () => {
  const fixture = await browserFixture()
  const roots = await Promise.all([451, 452].map(() => mkdtemp(join(tmpdir(), "wp-codebox-browser-fault-parallel-"))))
  try {
    const results = await Promise.all([451, 452].map((status, index) => runBrowserActionsCommand({
      artifactRoot: roots[index]!,
      runtimeSpec,
      server: fixture.server,
      spec: { command: "wordpress.browser-actions", args: ["url=/", `transport-faults-json=${JSON.stringify(faultModel(`parallel-${status}`, status))}`, `steps-json=${JSON.stringify([{ kind: "evaluate", expression: "await fetch('/api', { method: 'POST' }).then(r => r.status)", assert: status }])}`, "capture=steps"] },
    })))
    assert.deepEqual(results.map(({ artifact }) => artifact.summary.transportFaults?.seed), ["parallel-451", "parallel-452"])
    assert.deepEqual(results.map(({ artifact }) => artifact.summary.transportFaults?.matchedRequests), [1, 1])
  } finally {
    await fixture.close()
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
  }
})

function faultModel(seed: string, status: number): TransportFaultModel {
  return { schema: "wp-codebox/transport-fault-model/v1", seed, rules: [{ id: "api-recovery", match: { method: "POST", path: "/api" }, sequence: [{ status, body: "fault" }, { passthrough: true }], repeat: "none" }] }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for browser transport fault lifecycle state.")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function browserFixture(): Promise<{ port: number; requests: Array<{ host?: string; url?: string; body: string }>; server: PlaygroundCliServer; close(): Promise<void> }> {
  const requests: Array<{ host?: string; url?: string; body: string }> = []
  const httpServer = createServer(async (request, response) => {
    const body = await requestBody(request)
    requests.push({ host: request.headers.host, url: request.url, body })
    if (request.url === "/sw.js") {
      response.setHeader("content-type", "application/javascript")
      response.end("self.addEventListener('install', () => self.skipWaiting()); self.addEventListener('activate', event => event.waitUntil(self.clients.claim())); self.addEventListener('fetch', event => event.respondWith(new Response('service-worker')))" )
      return
    }
    if (["/api", "/delay", "/timeout", "/refuse", "/reset", "/malformed", "/truncated", "/slow"].includes(request.url ?? "")) {
      response.statusCode = 200
      response.end("runtime-response")
      return
    }
    response.setHeader("content-type", "text/html")
    response.end("<!doctype html><title>Transport faults</title><main id=ready>ready</main>")
  })
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve))
  const address = httpServer.address()
  assert(address && typeof address === "object")
  return {
    port: address.port,
    requests,
    server: { serverUrl: `http://127.0.0.1:${address.port}`, playground: { async run() { return { text: "", exitCode: 0 } } }, async [Symbol.asyncDispose]() {} },
    close: () => new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve())),
  }
}

async function requestBody(request: import("node:http").IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString("utf8")
}
