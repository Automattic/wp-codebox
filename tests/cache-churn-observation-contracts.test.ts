import assert from "node:assert/strict"
import { getCommandDefinition } from "../packages/runtime-core/src/command-registry.js"
import { cacheChurnObservation, CACHE_CHURN_OBSERVATION_ARTIFACT_KIND, CACHE_CHURN_OBSERVATION_SCHEMA } from "../packages/runtime-core/src/cache-churn-observation.js"
import { RUNTIME_BACKED_FUZZ_SUITE_RUNNER_CAPABILITIES, WORDPRESS_FUZZ_RUNTIME_CONTRACT } from "../packages/runtime-core/src/fuzz-suite-contracts.js"
import { cacheChurnObservationInputFromArgs, cacheChurnObservationPhpCode } from "../packages/runtime-playground/src/cache-churn-observation-command-handlers.js"
import { runPhpJson } from "../scripts/test-kit.js"

const observation = cacheChurnObservation({
  command: "wordpress.cache-churn-observation",
  target: "/wp/v2/posts/1",
  source: "in-process",
  kind: "rest-request",
  correlation: { caseId: "case-1", actionId: "action-1", correlationId: "run-1" },
  transients: { status: "captured", operations: { get: 1, set: 1, delete: 1 }, names: [{ name: "foo", operations: { get: 1, set: 1, delete: 1 } }] },
  siteTransients: { status: "captured", operations: { get: 1 }, names: [{ name: "network", operations: { get: 1 } }] },
  options: { status: "captured", operations: { get: 1, update: 1 }, names: [{ name: "blogname", operations: { get: 1, update: 1 } }] },
  objectCache: { status: "unsupported", reason: "wp_cache_functions_do_not_emit_operation_hooks" },
})

assert.equal(observation.schema, CACHE_CHURN_OBSERVATION_SCHEMA)
assert.equal(observation.artifactKind, CACHE_CHURN_OBSERVATION_ARTIFACT_KIND)
assert.equal(observation.objectCache.status, "unsupported")
assert.equal(observation.correlation?.caseId, "case-1")

const definition = getCommandDefinition("wordpress.cache-churn-observation")
assert.equal(definition?.outputSchema?.id, CACHE_CHURN_OBSERVATION_SCHEMA)
assert.equal(definition?.handler.kind, "playground")
assert.equal(definition?.handler.kind === "playground" ? definition.handler.method : undefined, "runCacheChurnObservation")
assert.equal(definition?.acceptedArgs.some((arg) => arg.name === "correlation-id"), true)

assert.ok(RUNTIME_BACKED_FUZZ_SUITE_RUNNER_CAPABILITIES.commands?.includes("wordpress.cache-churn-observation"))
assert.ok(RUNTIME_BACKED_FUZZ_SUITE_RUNNER_CAPABILITIES.capabilities.includes("cache-churn-observation"))
assert.equal(WORDPRESS_FUZZ_RUNTIME_CONTRACT.artifactExpectations.some((artifact) => artifact.id === "cache-churn-observation"), true)
assert.equal(WORDPRESS_FUZZ_RUNTIME_CONTRACT.hbex.schemaIds.cacheChurnObservation, CACHE_CHURN_OBSERVATION_SCHEMA)

const input = cacheChurnObservationInputFromArgs([
  "path=/wp-json/wp/v2/posts/1",
  "method=POST",
  "params-json={\"title\":\"Draft\"}",
  "sample-limit=5",
  "case-id=case-1",
  "action-id=action-1",
  "correlation-id=run-1",
])
assert.equal(input.path, "/wp-json/wp/v2/posts/1")
assert.equal(input.method, "POST")
assert.equal(input.sampleLimit, 5)
assert.equal(input.correlation.caseId, "case-1")

const code = cacheChurnObservationPhpCode(input)
assert.match(code, /'schema' => 'wp-codebox\/cache-churn-observation\/v1'/)
assert.match(code, /'artifactKind' => 'cache-churn-observation'/)
assert.match(code, /'reason' => 'wp_cache_functions_do_not_emit_operation_hooks'/)

const captured = await runPhpJson<any>(`
$GLOBALS['wp_codebox_test_filters'] = array();
$GLOBALS['wp_codebox_current_filter'] = null;
$GLOBALS['wp_codebox_autoload_options'] = array( 'existing' => '1' );
function add_filter( $hook, $callback, $priority = 10, $accepted_args = 1 ) { $GLOBALS['wp_codebox_test_filters'][ $hook ][] = $callback; }
function add_action( $hook, $callback, $priority = 10, $accepted_args = 1 ) { add_filter( $hook, $callback, $priority, $accepted_args ); }
function current_filter() { return $GLOBALS['wp_codebox_current_filter']; }
function wp_json_encode( $data, $flags = 0 ) { return json_encode( $data, $flags ); }
function wp_load_alloptions() { return $GLOBALS['wp_codebox_autoload_options']; }
function wp_codebox_test_fire( $hook, ...$args ) { $GLOBALS['wp_codebox_current_filter'] = $hook; foreach ( $GLOBALS['wp_codebox_test_filters']['all'] ?? array() as $callback ) { $callback( ...$args ); } foreach ( $GLOBALS['wp_codebox_test_filters'][ $hook ] ?? array() as $callback ) { $callback( ...$args ); } $GLOBALS['wp_codebox_current_filter'] = null; }
class WP_REST_Request { public array $params = array(); public function __construct( public string $method, public string $route ) {} public function set_param( $name, $value ) { $this->params[ $name ] = $value; } }
class WP_Codebox_Test_REST_Response { public function get_status() { return 200; } }
function rest_do_request( $request ) {
  wp_codebox_test_fire( 'pre_transient_fuzz_payload' );
  wp_codebox_test_fire( 'set_transient_fuzz_payload' );
  wp_codebox_test_fire( 'delete_transient_fuzz_payload' );
  wp_codebox_test_fire( 'pre_site_transient_network_payload' );
  wp_codebox_test_fire( 'option_blogname' );
  wp_codebox_test_fire( 'updated_option', 'blogname' );
  $GLOBALS['wp_codebox_autoload_options']['new_autoloaded'] = '1';
  return new WP_Codebox_Test_REST_Response();
}
${code}
`)

assert.equal(captured.schema, CACHE_CHURN_OBSERVATION_SCHEMA)
assert.equal(captured.artifactKind, CACHE_CHURN_OBSERVATION_ARTIFACT_KIND)
assert.equal(captured.target, "/wp/v2/posts/1")
assert.equal(captured.correlation.caseId, "case-1")
assert.equal(captured.transients.operations.get, 1)
assert.equal(captured.transients.operations.set, 1)
assert.equal(captured.transients.operations.delete, 1)
assert.deepEqual(captured.transients.names[0], { name: "fuzz_payload", operations: { get: 1, set: 1, delete: 1 } })
assert.equal(captured.siteTransients.operations.get, 1)
assert.equal(captured.options.operations.get >= 1, true)
assert.equal(captured.options.operations.update, 1)
assert.equal(captured.options.autoload.beforeCount, 1)
assert.equal(captured.options.autoload.afterCount, 2)
assert.deepEqual(captured.options.autoload.added, ["new_autoloaded"])
assert.equal(captured.objectCache.status, "unsupported")
assert.equal(captured.objectCache.reason, "wp_cache_functions_do_not_emit_operation_hooks")

console.log("cache churn observation contracts passed")
