import assert from "node:assert/strict"
import test from "node:test"

import type { BrowserContext, Route } from "playwright"

import { browserPreviewNetworkPolicy, browserPreviewRouting, createBrowserPreviewRouteTracker, drainBrowserPreviewRouteTracker, isBrowserPreviewRouteFetchContentDecodingError, isBrowserPreviewRouteFetchRecoverableError, isBrowserPreviewRouteFetchRequestContextDisposedError, isBrowserPreviewRouteFetchTransientTransportError, routeBrowserPreviewContextNetwork } from "../packages/runtime-playground/src/browser-preview-routing.js"
import { jsonLines, serializeBrowserError } from "../packages/runtime-playground/src/browser-metrics.js"

const SENTINELS = ["SENTINEL_COOKIE_2094", "SENTINEL_AUTH_2094", "SENTINEL_NONCE_2094", "SENTINEL_TOKEN_2094"]
const ROUTED_URL = "http://routed.test/wp-includes/app.js?token=SENTINEL_TOKEN_2094"

test("routed fetch classifiers include transport resets and preserve disposal/decompression recovery", () => {
  assert.equal(isBrowserPreviewRouteFetchTransientTransportError(routeFetchError("read ECONNRESET")), true)
  assert.equal(isBrowserPreviewRouteFetchTransientTransportError(routeFetchError("connect ECONNREFUSED")), true)
  assert.equal(isBrowserPreviewRouteFetchTransientTransportError(routeFetchError("socket hang up")), true)
  assert.equal(isBrowserPreviewRouteFetchRequestContextDisposedError(routeFetchError("Request context disposed.")), true)
  assert.equal(isBrowserPreviewRouteFetchContentDecodingError(routeFetchError("failed to decompress 'br' encoding")), true)
  assert.equal(isBrowserPreviewRouteFetchRecoverableError(routeFetchError("read ECONNRESET")), true)
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

test("exhausted document resets fail through a sanitized tracker error without leaking to persisted surfaces", async () => {
  const fixture = await routedFixture("document", [routeFetchError("read ECONNRESET"), routeFetchError("read ECONNRESET"), routeFetchError("read ECONNRESET")])
  await assert.doesNotReject(fixture.run())
  assert.equal(fixture.fetchCalls(), 3)
  assert.equal(fixture.abortCalls(), 1)
  assert.equal(fixture.tracker.pending.size, 0)
  assert.equal(fixture.tracker.errors.length, 1)

  const tracked = fixture.tracker.errors[0]
  await assert.rejects(drainBrowserPreviewRouteTracker(fixture.tracker), /classification=upstream-transport.*resourceType=document.*token=\[redacted\]/)
  const serialized = serializeBrowserError("probe-error", tracked)
  const persistedSurfaces = {
    stdout: JSON.stringify(serialized),
    stderr: tracked instanceof Error ? `${tracked.message}\n${tracked.stack}` : String(tracked),
    diagnostics: JSON.stringify({ errors: [serialized] }),
    manifest: JSON.stringify({ files: [{ diagnostics: serialized }] }),
    artifact: jsonLines([serialized]),
    tracker: JSON.stringify(fixture.tracker.errors.map((error) => serializeBrowserError("probe-error", error))),
    snapshot: JSON.stringify(serialized),
  }
  for (const [surface, contents] of Object.entries(persistedSurfaces)) {
    for (const sentinel of SENTINELS) assert.doesNotMatch(contents, new RegExp(sentinel), `${surface} must not contain ${sentinel}`)
  }
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

test("disposed contexts and decompression failures abort without retrying or tracking errors", async () => {
  for (const message of ["Request context disposed.", "failed to decompress 'gzip' encoding"]) {
    const fixture = await routedFixture("document", [routeFetchError(message)])
    await assert.doesNotReject(fixture.run())
    await assert.doesNotReject(drainBrowserPreviewRouteTracker(fixture.tracker))
    assert.equal(fixture.fetchCalls(), 1)
    assert.equal(fixture.abortCalls(), 1)
  }
})

async function routedFixture(resourceType: string, outcomes: unknown[], tracker = createBrowserPreviewRouteTracker()) {
  let handler: ((route: Route) => Promise<void>) | undefined
  let fetchCalls = 0
  let abortCalls = 0
  let fulfilled: unknown
  const context = {
    route: async (_pattern: string, nextHandler: (route: Route) => Promise<void>) => {
      handler = nextHandler
    },
  } as BrowserContext
  const preview = browserPreviewRouting([], undefined, "http://127.0.0.1:9400")
  const policy = browserPreviewNetworkPolicy([], ["routed.test"], preview)
  await routeBrowserPreviewContextNetwork(context, policy, preview.effectiveOrigin, tracker)

  const route = {
    request: () => ({
      url: () => ROUTED_URL,
      method: () => "GET",
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
      abortCalls += 1
    },
    fulfill: async ({ response }: { response: unknown }) => {
      fulfilled = response
    },
    continue: async () => {},
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

function routeFetchError(reason: string): Error {
  const message = `route.fetch: ${reason}\nCall log:\n  - → GET ${ROUTED_URL}\n    cookie: wordpress_logged_in=${SENTINELS[0]}\n    authorization: Bearer ${SENTINELS[1]}\n    x-wp-nonce: ${SENTINELS[2]}\n    x-session-token: ${SENTINELS[3]}`
  const error = new Error(message)
  error.stack = `Error: ${message}`
  return error
}

function routedResponse() {
  return {
    status: () => 200,
    headers: () => ({}),
  }
}
