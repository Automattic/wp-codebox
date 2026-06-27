import assert from "node:assert/strict"
import { getCommandDefinition } from "../packages/runtime-core/src/command-registry.js"
import { performanceObservation } from "../packages/runtime-core/src/performance-observation.js"
import { runHttpRequest } from "../packages/runtime-playground/src/http-request-command-handlers.js"
import { pageLoadPhpCode } from "../packages/runtime-playground/src/page-load-command-handlers.js"
import { restPerformanceObservationInputFromArgs, restPerformanceObservationPhpCode } from "../packages/runtime-playground/src/performance-observation-command-handlers.js"
import { restRequestPhpCode } from "../packages/runtime-playground/src/rest-request-command-handlers.js"
import { runPhpJson } from "../scripts/test-kit.js"

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

const hotspotObservation = performanceObservation({
  command: "wordpress.rest-performance-observation",
  target: "/wp/v2/status",
  source: "in-process",
  kind: "rest-request",
  database: {
    status: "captured",
    queryCount: 3,
    totalTimeMs: 4.25,
    fingerprints: [{ fingerprint: "select * from wp_posts where id = ?", count: 2, totalTimeMs: 3.5, sampleMs: 1.75, caller: "WP_Query" }],
    repeatedQueries: [{ fingerprint: "select * from wp_posts where id = ?", count: 2, totalTimeMs: 3.5, caller: "WP_Query" }],
  },
  hooks: { status: "captured", timings: [{ hook: "rest_api_init", count: 2, totalTimeMs: 1.5 }] },
})
assert.equal(hotspotObservation.schema, "wp-codebox/performance-observation/v1")
assert.equal(hotspotObservation.command, "wordpress.rest-performance-observation")
assert.equal(hotspotObservation.database?.fingerprints?.[0]?.fingerprint, "select * from wp_posts where id = ?")
assert.equal(hotspotObservation.database?.repeatedQueries?.[0]?.count, 2)
assert.equal(hotspotObservation.hooks?.timings[0]?.hook, "rest_api_init")

const restObservationDefinition = getCommandDefinition("wordpress.rest-performance-observation")
assert.equal(restObservationDefinition?.outputSchema?.id, "wp-codebox/performance-observation/v1")
assert.equal(restObservationDefinition?.handler.kind, "playground")
assert.equal(restObservationDefinition?.handler.kind === "playground" ? restObservationDefinition.handler.method : undefined, "runRestPerformanceObservation")
assert.equal(restObservationDefinition?.acceptedArgs.some((arg) => arg.name === "hook-sample-limit"), true)

const restObservationInput = restPerformanceObservationInputFromArgs(["path=/wp-json/wp/v2/status", "method=POST", "params-json={\"context\":\"view\"}", "query-fingerprint-limit=3", "hook-sample-limit=2"])
assert.equal(restObservationInput.path, "/wp-json/wp/v2/status")
assert.equal(restObservationInput.method, "POST")
assert.equal(restObservationInput.queryFingerprintLimit, 3)
assert.equal(restObservationInput.hookSampleLimit, 2)

const restObservationCode = restPerformanceObservationPhpCode(restObservationInput)
assert.match(restObservationCode, /'schema' => 'wp-codebox\/performance-observation\/v1'/)
assert.match(restObservationCode, /'command' => 'wordpress.rest-performance-observation'/)
assert.match(restObservationCode, /wp_codebox_query_recorder_start\( 'rest-performance-observation'/)
assert.match(restObservationCode, /'database' => array\( 'status' => \$wp_codebox_query_capture_status/)
assert.match(restObservationCode, /'hooks' => array\( 'status' => 'captured'/)
assert.match(restObservationCode, /add_filter\( 'all', \$wp_codebox_hook_sampler, PHP_INT_MIN, 0 \)/)

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
assert.match(pageLoadCode, /'mode' => 'simulated'/)
assert.match(pageLoadCode, /'memory' => array\('status' => 'captured'/)
assert.match(pageLoadCode, /wp_codebox_query_recorder_start\('page-load'/)
assert.match(pageLoadCode, /'status' => \$wp_codebox_page_load_query_capture_status/)
assert.match(pageLoadCode, /'reason' => 'hook_timing_not_instrumented'/)
assert.match(pageLoadCode, /'reason' => 'not_a_browser_observation'/)
assert.match(pageLoadCode, /'metadata' => array\('runner' => 'wp-codebox\/runtime-playground'/)

const restCode = restRequestPhpCode({ method: "GET", path: "/wp/v2/posts", headers: {}, params: {}, body: "", capture: {} })
assert.match(restCode, /'timing' => array\(\n        'status' => 'captured'/)
assert.match(restCode, /'memory' => array\(\n        'status' => 'captured'/)
assert.match(restCode, /wp_codebox_query_recorder_start\( 'rest-request'/)
assert.match(restCode, /'status' => \$wp_codebox_query_capture_status/)
assert.match(restCode, /'network' => array\( 'status' => 'unsupported', 'reason' => 'in_process_rest_request' \)/)

const capturedRestCode = restRequestPhpCode({ method: "GET", path: "/wp/v2/posts", headers: {}, params: {}, body: "", capture: { queries: true } })
const capturedRest = await runPhpJson<any>(`
$GLOBALS['wp_codebox_test_filters'] = array();
function add_filter( $hook, $callback, $priority = 10, $accepted_args = 1 ) { $GLOBALS['wp_codebox_test_filters'][ $hook ][] = $callback; }
function remove_filter( $hook, $callback, $priority = 10 ) { $GLOBALS['wp_codebox_test_filters'][ $hook ] = array_values( array_filter( $GLOBALS['wp_codebox_test_filters'][ $hook ] ?? array(), static fn( $item ) => $item !== $callback ) ); }
function apply_filters( $hook, $value ) { foreach ( $GLOBALS['wp_codebox_test_filters'][ $hook ] ?? array() as $callback ) { $value = $callback( $value ); } return $value; }
class WP_REST_Request { public string $method; public string $route; public array $params = array(); public function __construct( $method, $route ) { $this->method = $method; $this->route = $route; } public function set_header( $name, $value ) {} public function set_param( $name, $value ) { $this->params[ $name ] = $value; } public function has_param( $name ) { return array_key_exists( $name, $this->params ); } public function set_body( $body ) {} }
class WP_Codebox_Test_REST_Response { public function get_status() { return 200; } public function get_headers() { return array(); } public function get_data() { return array( 'ok' => true ); } }
function rest_do_request( $request ) { apply_filters( 'query', 'SELECT * FROM wp_posts WHERE ID = 123' ); apply_filters( 'query', 'SELECT * FROM wp_posts WHERE ID = 456' ); return new WP_Codebox_Test_REST_Response(); }
function rest_get_server() { return new class { public function response_to_data( $response, $embed ) { return $response->get_data(); } }; }
function wp_json_encode( $data, $flags = 0 ) { return json_encode( $data, $flags ); }
${capturedRestCode}
`)
assert.equal(capturedRest.performance.database.status, "captured")
assert.equal(capturedRest.performance.database.queryCount, 2)
assert.equal(capturedRest.performance.database.fingerprints[0].fingerprint, "select * from wp_posts where id = ?")
assert.equal(capturedRest.performance.database.fingerprints[0].count, 2)
assert.equal(capturedRest.performance.database.repeatedQueries[0].count, 2)

const unavailableObservationCode = restPerformanceObservationPhpCode(restPerformanceObservationInputFromArgs(["path=/wp/v2/posts", "capture-queries=true"]))
const unavailableObservation = await runPhpJson<any>(`
class WP_REST_Request { public function __construct( $method, $route ) {} public function set_param( $name, $value ) {} }
class WP_Codebox_Test_REST_Response { public function get_status() { return 200; } }
function rest_do_request( $request ) { return new WP_Codebox_Test_REST_Response(); }
function wp_json_encode( $data, $flags = 0 ) { return json_encode( $data, $flags ); }
${unavailableObservationCode}
`)
assert.equal(unavailableObservation.database.status, "unavailable")
assert.equal(unavailableObservation.database.reason, "wordpress_filter_api_unavailable")
assert.equal(unavailableObservation.database.queryCount, 0)

const previousFetch = globalThis.fetch
globalThis.fetch = async () =>
  new Response("ok", {
    status: 200,
    headers: { "content-type": "text/plain" },
  })
try {
  const httpResult = JSON.parse(await runHttpRequest({ method: "GET", url: "/", headers: {}, body: undefined, expectStatus: undefined, command: "wordpress.server-page-load", pageLoadTarget: { kind: "frontend", path: "/" } }, "https://example.test"))
  assert.equal(httpResult.schema, "wp-codebox/wordpress-page-load-result/v1")
  assert.equal(httpResult.mode, "server-http")
  assert.equal(httpResult.status, "ok")
  assert.equal(httpResult.statusCode, 200)
  assert.equal(httpResult.target.kind, "frontend")
  assert.equal(httpResult.http.status, 200)
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
