import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"

import type { BrowserContext, Request, Response, Route } from "playwright"

import { BrowserArtifactSession } from "../packages/runtime-playground/src/browser-artifact-session.js"
import { serializeBrowserError, serializeBrowserRequestFailure, serializeBrowserResponse } from "../packages/runtime-playground/src/browser-metrics.js"
import { browserPreviewNetworkPolicy, browserPreviewRouting, createBrowserPreviewRouteTracker, drainBrowserPreviewRouteTracker, isBrowserPreviewRouteClosedError, isBrowserPreviewRouteFetchContentDecodingError, isBrowserPreviewRouteFetchRecoverableError, isBrowserPreviewRouteFetchRequestContextDisposedError, isBrowserPreviewRouteFetchTransientTransportError, routeBrowserPreviewContextNetwork } from "../packages/runtime-playground/src/browser-preview-routing.js"
import { BrowserProbeSessionResultBuilder, type BrowserProbeSessionResultInput } from "../packages/runtime-playground/src/browser-probe-session-result-builder.js"
import { createBrowserProbeProgressTracker } from "../packages/runtime-playground/src/browser-probe-support.js"
import { withTempDir } from "../scripts/test-kit.js"

const SENTINELS = ["SENTINEL_COOKIE_2094", "SENTINEL_AUTH_2094", "SENTINEL_NONCE_2094", "SENTINEL_TOKEN_2094"]
const ROUTED_URL = "http://routed.test/wp-includes/app.js?token=SENTINEL_TOKEN_2094"

test("routed fetch classifiers include transport resets and preserve disposal/decompression recovery", () => {
  assert.equal(isBrowserPreviewRouteFetchTransientTransportError(routeFetchError("read ECONNRESET")), true)
  assert.equal(isBrowserPreviewRouteFetchTransientTransportError(routeFetchError("connect ECONNREFUSED")), true)
  assert.equal(isBrowserPreviewRouteFetchTransientTransportError(routeFetchError("socket hang up")), true)
  assert.equal(isBrowserPreviewRouteFetchRequestContextDisposedError(routeFetchError("Request context disposed.")), true)
  assert.equal(isBrowserPreviewRouteFetchContentDecodingError(routeFetchError("failed to decompress 'br' encoding")), true)
  assert.equal(isBrowserPreviewRouteFetchRecoverableError(routeFetchError("read ECONNRESET")), true)
  assert.equal(isBrowserPreviewRouteClosedError(new Error("route.continue: Target page, context or browser has been closed")), true)
})

test("subresource resets retry once, abort safely, and never reject the route callback", async () => {
  const fixture = await routedFixture("script", [routeFetchError("read ECONNRESET"), routeFetchError("socket closed")])
  await assert.doesNotReject(fixture.run())
  assert.equal(fixture.fetchCalls(), 2)
  assert.equal(fixture.abortCalls(), 1)
  assert.equal(fixture.tracker.errors.length, 0)
  assert.equal(fixture.tracker.pending.size, 0)
})

test("document resets retry deterministically and fulfill after recovery", async () => {
  const response = routedResponse()
  const fixture = await routedFixture("document", [routeFetchError("connect ECONNREFUSED"), routeFetchError("read ECONNRESET"), response])
  await assert.doesNotReject(fixture.run())
  await assert.doesNotReject(drainBrowserPreviewRouteTracker(fixture.tracker))
  assert.equal(fixture.fetchCalls(), 3)
  assert.equal(fixture.fulfilledResponse(), response)
  assert.equal(fixture.abortCalls(), 0)
})

test("exhausted document resets fail through a sanitized tracker error", async () => {
  const fixture = await routedFixture("document", [routeFetchError("read ECONNRESET"), routeFetchError("read ECONNRESET"), routeFetchError("read ECONNRESET")])
  await assert.doesNotReject(fixture.run())
  assert.equal(fixture.fetchCalls(), 3)
  assert.equal(fixture.abortCalls(), 1)
  assert.equal(fixture.tracker.pending.size, 0)
  assert.equal(fixture.tracker.errors.length, 1)

  await assert.rejects(drainBrowserPreviewRouteTracker(fixture.tracker), /classification=upstream-transport.*resourceType=document.*token=\[redacted\]/)
})

test("POST document and subresource resets are never replayed", async () => {
  const document = await routedFixture("document", [routeFetchError("read ECONNRESET"), routedResponse()], undefined, { method: "POST" })
  await assert.doesNotReject(document.run())
  assert.equal(document.fetchCalls(), 1)
  assert.equal(document.fulfilledResponse(), undefined)
  await assert.rejects(drainBrowserPreviewRouteTracker(document.tracker), /method=POST.*resourceType=document/)

  const subresource = await routedFixture("fetch", [routeFetchError("read ECONNRESET"), routedResponse()], undefined, { method: "POST" })
  await assert.doesNotReject(subresource.run())
  await assert.doesNotReject(drainBrowserPreviewRouteTracker(subresource.tracker))
  assert.equal(subresource.fetchCalls(), 1)
  assert.equal(subresource.abortCalls(), 1)
  assert.equal(subresource.fulfilledResponse(), undefined)

  const redirect = routedResponse(307, { location: "http://routed.test/after-mutation" })
  const redirectedPost = await routedFixture("document", [redirect], undefined, { method: "POST" })
  await assert.doesNotReject(redirectedPost.run())
  assert.equal(redirectedPost.fetchCalls(), 1)
  assert.equal(redirectedPost.fulfilledResponse(), redirect)
})

test("concurrent routed requests drain after independent retry and cleanup", async () => {
  const first = await routedFixture("script", [routeFetchError("read ECONNRESET"), routedResponse()])
  const second = await routedFixture("image", [routeFetchError("socket ended"), routeFetchError("socket ended")], first.tracker)
  await Promise.all([first.run(), second.run()])
  await assert.doesNotReject(drainBrowserPreviewRouteTracker(first.tracker))
  assert.equal(first.tracker.pending.size, 0)
  assert.equal(first.fetchCalls(), 2)
  assert.equal(second.fetchCalls(), 2)
  assert.equal(second.abortCalls(), 1)
})

test("drain observes a routed request registered while another request is settling", async () => {
  let resolveFirst!: (response: ReturnType<typeof routedResponse>) => void
  let resolveSecond!: (response: ReturnType<typeof routedResponse>) => void
  const firstResponse = new Promise<ReturnType<typeof routedResponse>>((resolve) => { resolveFirst = resolve })
  const secondResponse = new Promise<ReturnType<typeof routedResponse>>((resolve) => { resolveSecond = resolve })
  const tracker = createBrowserPreviewRouteTracker()
  const first = await routedFixture("script", [firstResponse], tracker)
  const second = await routedFixture("image", [secondResponse], tracker)
  const firstRun = first.run()
  const drain = drainBrowserPreviewRouteTracker(tracker)
  const secondRun = second.run()
  resolveFirst(routedResponse())
  await firstRun
  await new Promise((resolve) => setTimeout(resolve, 5))
  let drained = false
  void drain.then(() => { drained = true })
  assert.equal(drained, false)
  resolveSecond(routedResponse())
  await Promise.all([secondRun, drain])
  assert.equal(tracker.pending.size, 0)
})

test("the complete route callback contains continue and policy abort failures", async () => {
  const cases = [
    { name: "invalid URL continue", options: { url: "not-a-url", continueErrors: [routeFetchError("continue failed")] }, operation: "continue-invalid-url" },
    { name: "ordinary continue", options: { url: "https://ordinary.test/path?token=SENTINEL_TOKEN_2094", continueErrors: [routeFetchError("continue failed")] }, operation: "continue-unrouted" },
    { name: "policy abort", options: { url: "https://blocked.test/path?token=SENTINEL_TOKEN_2094", policyArgs: ["network-policy=block"], abortErrors: [routeFetchError("abort failed")] }, operation: "abort-policy-block" },
  ]
  for (const item of cases) {
    const fixture = await routedFixture("script", [], undefined, item.options)
    await assert.doesNotReject(fixture.run(), item.name)
    await assert.rejects(drainBrowserPreviewRouteTracker(fixture.tracker), new RegExp(`operation=${item.operation}.*token=\\[redacted\\]`))
    assertNoSentinels(JSON.stringify(fixture.tracker.errors), item.name)
  }
})

test("closed-context failures across the route callback are swallowed during cleanup", async () => {
  const closed = new Error("route.continue: Target page, context or browser has been closed")
  const fixture = await routedFixture("script", [], undefined, { url: "https://ordinary.test/", continueErrors: [closed], abortErrors: [closed] })
  await assert.doesNotReject(fixture.run())
  await assert.doesNotReject(drainBrowserPreviewRouteTracker(fixture.tracker))
  assert.equal(fixture.tracker.errors.length, 0)
})

test("disposed contexts and decompression failures abort without retrying or tracking errors", async () => {
  for (const message of ["Request context disposed.", "failed to decompress 'gzip' encoding"]) {
    const fixture = await routedFixture("document", [routeFetchError(message)])
    await assert.doesNotReject(fixture.run())
    await assert.doesNotReject(drainBrowserPreviewRouteTracker(fixture.tracker))
    assert.equal(fixture.fetchCalls(), 1)
    assert.equal(fixture.abortCalls(), 1)
  }
})

test("real network serialization and artifact composition remove synthetic request secrets", async () => {
  const rawUrl = ROUTED_URL
  const rawError = routeFetchError("read ECONNRESET")
  const networkRecord = serializeBrowserRequestFailure({
    url: () => rawUrl,
    method: () => "GET",
    resourceType: () => "script",
    timing: () => ({}),
    failure: () => ({ errorText: rawError.message }),
  } as unknown as Request, "2026-01-01T00:00:00.000Z")
  assertNoSentinels(JSON.stringify(networkRecord), "serialized network record")
  const responseRecord = await serializeBrowserResponse({
    url: () => rawUrl,
    request: () => ({ method: () => "GET", resourceType: () => "script", timing: () => ({}) }),
    status: () => 200,
    statusText: () => "OK",
    ok: () => true,
    headers: () => ({ "content-type": "application/javascript" }),
  } as unknown as Response, "2026-01-01T00:00:01.000Z")
  assertNoSentinels(JSON.stringify(responseRecord), "serialized response record")

  const serializedError = serializeBrowserError("probe-error", rawError)
  const result = new BrowserProbeSessionResultBuilder().compose(resultBuilderInput([networkRecord, responseRecord], serializedError))
  await withTempDir("wp-codebox-route-redaction-", async (artifactRoot) => {
    const session = new BrowserArtifactSession(artifactRoot, "files/browser", { source: "wordpress.browser-probe", operation: "browser-probe" })
    await session.writeJsonLines("network", "network.jsonl", [networkRecord, responseRecord])
    await session.writeJsonLines("errors", "errors.jsonl", [serializedError])
    await session.writeJson("review", "review.json", result.review)
    await session.writeJson("summary", "summary.json", result.summary)
    const persisted = {
      network: await readFile(join(artifactRoot, "files/browser/network.jsonl"), "utf8"),
      review: await readFile(join(artifactRoot, "files/browser/review.json"), "utf8"),
      summary: await readFile(join(artifactRoot, "files/browser/summary.json"), "utf8"),
      errors: await readFile(join(artifactRoot, "files/browser/errors.jsonl"), "utf8"),
      artifact: JSON.stringify(result.artifact),
      stdout: result.output,
      stderr: `${serializedError.message}\n${serializedError.stack}`,
    }
    for (const [surface, contents] of Object.entries(persisted)) assertNoSentinels(contents, surface)
    assert.match(persisted.network, /token=\[redacted\]/)
    assert.match(persisted.stdout, /token=\[redacted\]/)
  })
})

async function routedFixture(resourceType: string, outcomes: unknown[], tracker = createBrowserPreviewRouteTracker(), options: { method?: string; url?: string; policyArgs?: string[]; continueErrors?: Error[]; abortErrors?: Error[] } = {}) {
  let handler: ((route: Route) => Promise<void>) | undefined
  let fetchCalls = 0
  let abortCalls = 0
  let continueCalls = 0
  let fulfilled: unknown
  const context = {
    route: async (_pattern: string, nextHandler: (route: Route) => Promise<void>) => {
      handler = nextHandler
    },
  } as BrowserContext
  const preview = browserPreviewRouting([], undefined, "http://127.0.0.1:9400")
  const policy = browserPreviewNetworkPolicy(options.policyArgs ?? [], ["routed.test"], preview)
  await routeBrowserPreviewContextNetwork(context, policy, preview.effectiveOrigin, tracker)

  const route = {
    request: () => ({
      url: () => options.url ?? ROUTED_URL,
      method: () => options.method ?? "GET",
      resourceType: () => resourceType,
      headers: () => ({
        cookie: `wordpress_logged_in=${SENTINELS[0]}`,
        authorization: `Bearer ${SENTINELS[1]}`,
        "x-wp-nonce": SENTINELS[2],
        "x-session-token": SENTINELS[3],
      }),
    }),
    fetch: async () => {
      const outcome = outcomes[Math.min(fetchCalls, outcomes.length - 1)]
      fetchCalls += 1
      if (outcome instanceof Error) throw outcome
      return outcome
    },
    abort: async () => {
      const error = options.abortErrors?.[abortCalls]
      abortCalls += 1
      if (error) throw error
    },
    fulfill: async ({ response }: { response: unknown }) => {
      fulfilled = response
    },
    continue: async () => {
      const error = options.continueErrors?.[continueCalls]
      continueCalls += 1
      if (error) throw error
    },
  } as unknown as Route

  return {
    tracker,
    run: async () => {
      assert(handler)
      await handler(route)
    },
    fetchCalls: () => fetchCalls,
    abortCalls: () => abortCalls,
    fulfilledResponse: () => fulfilled,
  }
}

function resultBuilderInput(network: BrowserProbeSessionResultInput["network"], error: ReturnType<typeof serializeBrowserError>): BrowserProbeSessionResultInput {
  return {
    assertions: [],
    browser: { name: "chromium", channel: "bundled", version: null },
    browserFilesDirectory: "files/browser",
    capture: new Set(["network", "errors"]),
    captureSelection: { console: false, errors: true, network: true, metrics: false, consoleForAssertions: false, errorsForAssertions: false, networkForAssertions: false },
    checkpoints: [],
    command: "wordpress.browser-probe",
    consoleMessages: [],
    durationMs: 0,
    errors: [error],
    failFast: false,
    finalUrl: ROUTED_URL,
    hashes: {},
    lifecycleSelectors: [],
    liveness: { wallTimeoutMs: 30_000, stallTimeoutMs: 0, networkSettleTimeoutMs: 500 },
    network,
    preview: { requestedMode: "local", effectiveMode: "local", localOrigin: "http://127.0.0.1:9400", effectiveOrigin: "http://127.0.0.1:9400", diagnostics: [] },
    progress: createBrowserProbeProgressTracker("2026-01-01T00:00:00.000Z", 0),
    requestedUrl: ROUTED_URL,
    startedAt: "2026-01-01T00:00:00.000Z",
    startedAtMs: Date.now(),
    throttleId: null,
    topologyOrigins: { localPreviewOrigin: "http://127.0.0.1:9400", effectivePreviewOrigin: "http://127.0.0.1:9400" },
    viewport: null,
    waitFor: "domcontentloaded",
    webSockets: [],
  }
}

function assertNoSentinels(contents: string, surface: string): void {
  for (const sentinel of SENTINELS) assert.doesNotMatch(contents, new RegExp(sentinel), `${surface} must not contain ${sentinel}`)
}

function routeFetchError(reason: string): Error {
  const message = `route.fetch: ${reason}\nCall log:\n  - → GET ${ROUTED_URL}\n    cookie: wordpress_logged_in=${SENTINELS[0]}\n    authorization: Bearer ${SENTINELS[1]}\n    x-wp-nonce: ${SENTINELS[2]}\n    x-session-token: ${SENTINELS[3]}`
  const error = new Error(message)
  error.stack = `Error: ${message}`
  return error
}

function routedResponse(status = 200, headers: Record<string, string> = {}) {
  return {
    status: () => status,
    headers: () => headers,
  }
}
