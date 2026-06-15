import assert from "node:assert/strict"
import type { Page, Route } from "playwright"
import { routeBrowserPreviewPageNetwork, type BrowserPreviewNetworkPolicy } from "../packages/runtime-playground/src/browser-preview-routing.js"

const policy = createPolicy()
let handler: ((route: Route) => Promise<void>) | undefined
const page = {
  async route(_pattern: string, routeHandler: (route: Route) => Promise<void>) {
    handler = routeHandler
  },
} as Pick<Page, "route">

await routeBrowserPreviewPageNetwork(page as Page, policy, "http://127.0.0.1:9400/")
assert.ok(handler, "route handler should be registered")

const disposedRoute = createRoute(new Error("route.fetch: Request context disposed."))
await handler(disposedRoute as Route)
assert.equal(disposedRoute.abortCalls, 1, "disposed request context should abort the routed request")
assert.equal(disposedRoute.fulfillCalls, 0, "disposed request context should not fulfill")
assert.equal(disposedRoute.continueCalls, 0, "disposed request context should not continue")
assert.equal(policy.stats.get("wordpress.com")?.routed, 1)

const otherFetchError = new Error("route.fetch: socket hang up")
const failingRoute = createRoute(otherFetchError)
await assert.rejects(handler(failingRoute as Route), otherFetchError, "other route.fetch errors should still surface")
assert.equal(failingRoute.abortCalls, 0, "non-disposed route.fetch errors should not be converted to aborts")

console.log("Browser probe routed fetch disposed smoke passed")

function createPolicy(): BrowserPreviewNetworkPolicy {
  return {
    mode: "record",
    allowHosts: new Set(),
    blockHosts: new Set(),
    routeHosts: new Set(["wordpress.com"]),
    firstPartyHosts: new Set(["127.0.0.1"]),
    recordExternal: false,
    stats: new Map(),
  }
}

function createRoute(fetchError: Error) {
  return {
    abortCalls: 0,
    continueCalls: 0,
    fulfillCalls: 0,
    request() {
      return {
        url: () => "https://wordpress.com/wp-admin/admin-ajax.php",
        headers: () => ({ referer: "https://wordpress.com/wp-admin/site-editor.php" }),
      }
    },
    async fetch() {
      throw fetchError
    },
    async abort(reason?: string) {
      assert.equal(reason, "failed")
      this.abortCalls += 1
    },
    async continue() {
      this.continueCalls += 1
    },
    async fulfill() {
      this.fulfillCalls += 1
    },
  }
}
