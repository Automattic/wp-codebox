import assert from "node:assert/strict"
import { performanceObservation } from "../packages/runtime-core/src/performance-observation.js"
import { runHttpRequest } from "../packages/runtime-playground/src/http-request-command-handlers.js"
import { pageLoadPhpCode } from "../packages/runtime-playground/src/page-load-command-handlers.js"
import { restRequestPhpCode } from "../packages/runtime-playground/src/rest-request-command-handlers.js"

const observation = performanceObservation({
  command: "wordpress.rest-request",
  target: "/wp/v2/posts",
  timing: { status: "captured", durationMs: 12.5 },
  memory: { status: "captured", deltaBytes: 1024, peakBytes: 2048 },
  database: { status: "uncaptured", reason: "wpdb_queries_unavailable", queryCount: 0, fingerprints: [], repeatedQueries: [] },
  hooks: { status: "unsupported", reason: "hook_timing_not_instrumented", timings: [] },
  network: { status: "unsupported", reason: "in_process_rest_request" },
  browser: { status: "unsupported", reason: "not_a_browser_observation" },
  metadata: { runner: "wp-codebox/runtime-playground" },
})

assert.equal(observation.schema, "wp-codebox/performance-observation/v1")
assert.equal(observation.timing?.status, "captured")
assert.equal(observation.memory?.status, "captured")
assert.equal(observation.database?.status, "uncaptured")
assert.equal(observation.database?.reason, "wpdb_queries_unavailable")
assert.equal(observation.hooks?.status, "unsupported")
assert.equal(observation.hooks?.reason, "hook_timing_not_instrumented")
assert.equal(observation.network?.reason, "in_process_rest_request")
assert.equal(observation.browser?.reason, "not_a_browser_observation")
assert.equal(observation.metadata?.runner, "wp-codebox/runtime-playground")

const pageLoadCode = pageLoadPhpCode({
  command: "wordpress.frontend-page-load",
  surface: "frontend",
  method: "GET",
  path: "/",
  query: {},
  body: {},
  captureDiagnostics: ["wpdb-queries"],
})
assert.match(pageLoadCode, /'timing' => array\('status' => 'captured'/)
assert.match(pageLoadCode, /'memory' => array\('status' => 'captured'/)
assert.match(pageLoadCode, /'status' => \$wp_codebox_page_load_queries_available \? 'captured' : 'uncaptured'/)
assert.match(pageLoadCode, /'reason' => 'hook_timing_not_instrumented'/)
assert.match(pageLoadCode, /'reason' => 'not_a_browser_observation'/)
assert.match(pageLoadCode, /'metadata' => array\('runner' => 'wp-codebox\/runtime-playground'/)

const restCode = restRequestPhpCode({ method: "GET", path: "/wp/v2/posts", headers: {}, params: {}, body: "" })
assert.match(restCode, /'timing' => array\(\n        'status' => 'captured'/)
assert.match(restCode, /'memory' => array\(\n        'status' => 'captured'/)
assert.match(restCode, /'status' => \$wp_codebox_queries_available \? 'captured' : 'uncaptured'/)
assert.match(restCode, /'reason' => \$wp_codebox_queries_available \? null : 'wpdb_queries_unavailable'/)
assert.match(restCode, /'network' => array\( 'status' => 'unsupported', 'reason' => 'in_process_rest_request' \)/)

const previousFetch = globalThis.fetch
globalThis.fetch = async () =>
  new Response("ok", {
    status: 200,
    headers: { "content-type": "text/plain" },
  })
try {
  const httpResult = JSON.parse(await runHttpRequest({ method: "GET", url: "/", headers: {}, body: undefined, expectStatus: undefined, command: "wordpress.server-page-load" }, "https://example.test"))
  assert.equal(httpResult.performance.timing.status, "captured")
  assert.equal(httpResult.performance.network.status, "captured")
  assert.equal(httpResult.performance.database.status, "unsupported")
  assert.equal(httpResult.performance.database.reason, "server_http_request_runs_outside_php_process")
  assert.equal(httpResult.performance.hooks.reason, "hook_timing_not_instrumented")
  assert.equal(httpResult.performance.browser.reason, "not_a_browser_observation")
  assert.equal(httpResult.performance.metadata.surface, "server-page")
} finally {
  globalThis.fetch = previousFetch
}

console.log("performance observation contracts passed")
