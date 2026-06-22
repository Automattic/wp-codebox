import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { phpFunctionBlock, runPhpFileJson, withTempDir } from "../scripts/test-kit.js"
import { benchRunCode } from "../packages/runtime-playground/src/bench-command-handlers.js"

const benchRunner = benchRunCode({
  componentId: "component",
  pluginSlug: "component",
  iterations: 1,
  warmupIterations: 0,
  dependencySlugs: [],
  env: {},
  bootstrapFiles: [],
  workloads: [{ id: "ability-step", run: [{ type: "ability", name: "example/run" }] }],
  lifecycle: {},
  resetPolicy: {},
})

const runCommandStep = phpFunctionBlock(benchRunner, "wp_codebox_bench_run_command_step")
const runAbilityStep = phpFunctionBlock(benchRunner, "wp_codebox_bench_run_ability_step")
const runDbInventoryStep = phpFunctionBlock(benchRunner, "wp_codebox_bench_run_db_inventory_step")
const runRestDbQueryProfilerStep = phpFunctionBlock(benchRunner, "wp_codebox_bench_run_rest_db_query_profiler_step")
const runExternalHttpGuardrailStep = phpFunctionBlock(benchRunner, "wp_codebox_bench_run_external_http_guardrail_step")
const commandStepRecord = phpFunctionBlock(benchRunner, "wp_codebox_bench_command_step_record")
assert.match(runCommandStep, /function wp_codebox_bench_run_command_step\(array \$step, string \$type, callable \$runner\): array/)
assert.match(runAbilityStep, /wp_codebox_bench_run_command_step\(\$step, 'ability'/)
assert.match(runDbInventoryStep, /SHOW TABLE STATUS/)
assert.match(runDbInventoryStep, /SHOW FULL COLUMNS FROM/)
assert.match(runDbInventoryStep, /SHOW INDEX FROM/)
assert.match(runDbInventoryStep, /wp-codebox\/wordpress-db-inventory\/v1/)
assert.match(runDbInventoryStep, /\$payload\['artifacts'\]\['db-inventory'\] = \$inventory/)
assert.match(runRestDbQueryProfilerStep, /wp-codebox\/wordpress-rest-db-query-profile\/v1/)
assert.match(runRestDbQueryProfilerStep, /\$wpdb->save_queries = true/)
assert.match(runRestDbQueryProfilerStep, /\$payload\['artifacts'\]\['rest-db-query-profile'\] = \$artifact/)
assert.match(runExternalHttpGuardrailStep, /wp-codebox\/wordpress-external-http-guardrail\/v1/)
assert.match(runExternalHttpGuardrailStep, /wp_codebox_bench_install_external_http_guardrail/)
assert.match(commandStepRecord, /'schema' => 'wp-codebox\/bench-command-step\/v1'/)
assert.doesNotMatch(runCommandStep, /\$type === 'ability'/)
assert.ok(
  benchRunner.indexOf("$plugins_to_activate[] = $dependency_file") < benchRunner.indexOf("$plugins_to_activate[] = $plugin_file"),
  "wordpress.bench should activate dependency plugins before the component plugin",
)

const commandStepHelpers = [
  "wp_codebox_bench_metric_prefix",
  "wp_codebox_bench_command_step_record",
  "wp_codebox_bench_run_command_step",
  "wp_codebox_bench_command_step_payload",
  "wp_codebox_bench_workload_run_steps",
].map((functionName) => phpFunctionBlock(benchRunner, functionName)).join("\n\n")

const externalHttpGuardrailHelpers = [
  "wp_codebox_bench_metric_prefix",
  "wp_codebox_bench_command_step_record",
  "wp_codebox_bench_run_command_step",
  "wp_codebox_bench_command_step_payload",
  "wp_codebox_bench_external_http_guardrail_state",
  "wp_codebox_bench_normalize_external_http_guardrail_policy",
  "wp_codebox_bench_external_http_guardrail_redact_url",
  "wp_codebox_bench_external_http_guardrail_host_allowed",
  "wp_codebox_bench_external_http_guardrail_summary",
  "wp_codebox_bench_install_external_http_guardrail",
  "wp_codebox_bench_run_external_http_guardrail_step",
].map((functionName) => phpFunctionBlock(benchRunner, functionName)).join("\n\n")

const restDbQueryProfilerHelpers = [
  "wp_codebox_bench_percentile",
  "wp_codebox_bench_metric_prefix",
  "wp_codebox_bench_response_shape",
  "wp_codebox_bench_redacted_response_summary",
  "wp_codebox_bench_command_step_record",
  "wp_codebox_bench_run_command_step",
  "wp_codebox_bench_command_step_payload",
  "wp_codebox_bench_run_rest_request_step",
  "wp_codebox_bench_redact_sql_query",
  "wp_codebox_bench_rest_db_query_profile_summary",
  "wp_codebox_bench_rest_db_query_profile_case_step",
  "wp_codebox_bench_run_rest_db_query_profiler_step",
].map((functionName) => phpFunctionBlock(benchRunner, functionName)).join("\n\n")

const commandStepPayload = await withTempDir("wp-codebox-bench-step-", async (directory) => {
  const phpTestFile = join(directory, "command-step.php")
  await writeFile(
    phpTestFile,
    `<?php
${commandStepHelpers}
$execution = wp_codebox_bench_run_command_step(array('type' => 'ability', 'name' => 'example/run'), 'ability', static function (array $step): array {
    return array('metrics' => array('custom_count' => 2), 'metadata' => array('called' => $step['name']));
});
$payload = wp_codebox_bench_command_step_payload($execution, 'ability');
echo json_encode($payload, JSON_UNESCAPED_SLASHES);
`,
  )
  return runPhpFileJson<{ steps: Array<{ schema: string; type: string; name: string; timing: { duration_ms: number } }>; metrics: { ability_duration_ms: number; custom_count: number }; metadata: { called: string } }>(phpTestFile)
})
assert.equal(commandStepPayload.steps[0].schema, "wp-codebox/bench-command-step/v1")
assert.equal(commandStepPayload.steps[0].type, "ability")
assert.equal(commandStepPayload.steps[0].name, "example/run")
assert.equal(typeof commandStepPayload.steps[0].timing.duration_ms, "number")
assert.equal(typeof commandStepPayload.metrics.ability_duration_ms, "number")
assert.equal(commandStepPayload.metrics.custom_count, 2)
assert.deepEqual(commandStepPayload.metadata, { called: "example/run" })

const externalHttpGuardrailPayload = await withTempDir("wp-codebox-external-http-guardrail-", async (directory) => {
  const phpTestFile = join(directory, "external-http-guardrail.php")
  await writeFile(
    phpTestFile,
    `<?php
function wp_parse_url($url, $component = -1) { return parse_url($url, $component); }
$GLOBALS['wp_codebox_test_filters'] = array();
function add_filter($hook, $callback, $priority = 10, $accepted_args = 1) { $GLOBALS['wp_codebox_test_filters'][$hook][] = $callback; }
function wp_remote_get($url, $args = array()) {
    foreach ($GLOBALS['wp_codebox_test_filters']['pre_http_request'] ?? array() as $callback) {
        $preempt = $callback(false, array_merge(array('method' => 'GET'), $args), $url);
        if (false !== $preempt) {
            return $preempt;
        }
    }
    return array('response' => array('code' => 200, 'message' => 'OK'), 'body' => 'ok');
}
${externalHttpGuardrailHelpers}
wp_codebox_bench_run_external_http_guardrail_step(array(
    'type' => 'external-http-guardrail',
    'action' => 'install',
    'allowlistDomains' => array('api.wordpress.org'),
    'blockNetwork' => true,
));
wp_remote_get('https://api.wordpress.org/core/version-check/1.7/?token=secret');
wp_remote_get('https://tracker.example.test/pixel?email=a@example.test');
$payload = wp_codebox_bench_run_external_http_guardrail_step(array('type' => 'external-http-guardrail', 'action' => 'collect'));
echo json_encode($payload, JSON_UNESCAPED_SLASHES);
`,
  )
  return runPhpFileJson<{ metrics: Record<string, number>; artifacts: Record<string, { schema: string; summary: { event_count: number; allowed_count: number; blocked_count: number; hosts: Array<{ host: string; count: number; blocked: number }> }; events: Array<{ event: string; data: { url: string; blocked: boolean } }> }>; steps: Array<{ type: string; action: string }> }>(phpTestFile)
})
assert.equal(externalHttpGuardrailPayload.artifacts["external-http-guardrail"].schema, "wp-codebox/wordpress-external-http-guardrail/v1")
assert.equal(externalHttpGuardrailPayload.artifacts["external-http-guardrail"].summary.event_count, 2)
assert.equal(externalHttpGuardrailPayload.artifacts["external-http-guardrail"].summary.allowed_count, 1)
assert.equal(externalHttpGuardrailPayload.artifacts["external-http-guardrail"].summary.blocked_count, 1)
assert.equal(externalHttpGuardrailPayload.artifacts["external-http-guardrail"].events[0].data.url, "https://api.wordpress.org/core/version-check/1.7/?redacted=1")
assert.equal(externalHttpGuardrailPayload.artifacts["external-http-guardrail"].events[1].event, "http.blocked")
assert.equal(externalHttpGuardrailPayload.metrics.external_http_guardrail_event_count, 2)
assert.equal(externalHttpGuardrailPayload.steps[0].type, "external-http-guardrail")
assert.equal(externalHttpGuardrailPayload.steps[0].action, "collect")

const restDbQueryProfilerPayload = await withTempDir("wp-codebox-rest-db-query-profiler-", async (directory) => {
  const phpTestFile = join(directory, "rest-db-query-profiler.php")
  await writeFile(
    phpTestFile,
    `<?php
class WP_REST_Request {
    public string $method;
    public string $route;
    public function __construct($method, $route) { $this->method = $method; $this->route = $route; }
    public function set_header($name, $value) {}
    public function set_param($name, $value) {}
    public function set_body($body) {}
}
class WP_Codebox_Test_REST_Response { public function get_status() { return 200; } }
function is_wp_error($value) { return false; }
function rest_do_request($request) {
    global $wpdb;
    $wpdb->queries[] = array("SELECT * FROM wp_posts WHERE post_title = 'private title' AND ID = 123", 0.002, 'wpdb->get_results');
    $wpdb->queries[] = array("UPDATE wp_options SET option_value = 'secret' WHERE option_id = 45", 0.003, 'wpdb->query');
    return new WP_Codebox_Test_REST_Response();
}
function rest_get_server() { return new class { public function response_to_data($response, $embed) { return array('ok' => true); } }; }
$wpdb = (object) array('queries' => array(), 'save_queries' => false);
${restDbQueryProfilerHelpers}
$payload = wp_codebox_bench_run_rest_db_query_profiler_step(array(
    'type' => 'rest-db-query-profiler',
    'sampleLimit' => 1,
    'queryLengthLimit' => 120,
    'rest_request_cases' => array(array('id' => 'posts-list', 'method' => 'GET', 'path' => '/wp/v2/posts')),
));
echo json_encode($payload, JSON_UNESCAPED_SLASHES);
`,
  )
  return runPhpFileJson<{ metrics: Record<string, number>; artifacts: Record<string, { schema: string; summary: { case_count: number; query_count: number; sample_limit: number }; cases: Array<{ case_id: string; summary: { query_count: number; total_time_ms: number }; samples: Array<{ sql: string }> }> }>; steps: Array<{ type: string; queries?: number }> }>(phpTestFile)
})
assert.equal(restDbQueryProfilerPayload.artifacts["rest-db-query-profile"].schema, "wp-codebox/wordpress-rest-db-query-profile/v1")
assert.equal(restDbQueryProfilerPayload.artifacts["rest-db-query-profile"].summary.case_count, 1)
assert.equal(restDbQueryProfilerPayload.artifacts["rest-db-query-profile"].summary.query_count, 2)
assert.equal(restDbQueryProfilerPayload.artifacts["rest-db-query-profile"].summary.sample_limit, 1)
assert.equal(restDbQueryProfilerPayload.artifacts["rest-db-query-profile"].cases[0].case_id, "posts-list")
assert.equal(restDbQueryProfilerPayload.artifacts["rest-db-query-profile"].cases[0].samples.length, 1)
assert.equal(restDbQueryProfilerPayload.artifacts["rest-db-query-profile"].cases[0].samples[0].sql, "SELECT * FROM wp_posts WHERE post_title = '?' AND ID = ?")
assert.doesNotMatch(JSON.stringify(restDbQueryProfilerPayload), /private title|secret|123/)
assert.equal(restDbQueryProfilerPayload.metrics.rest_db_query_profile_cases_count, 1)
assert.equal(restDbQueryProfilerPayload.metrics.rest_db_query_profile_queries_count, 2)
assert.equal(restDbQueryProfilerPayload.steps[0].type, "rest-db-query-profiler")
assert.equal(restDbQueryProfilerPayload.steps[0].queries, 2)

const routeMatrixSteps = await withTempDir("wp-codebox-bench-route-matrix-", async (directory) => {
  const phpTestFile = join(directory, "route-matrix.php")
  await writeFile(
    phpTestFile,
    `<?php
${commandStepHelpers}
$steps = wp_codebox_bench_workload_run_steps(array(
    'id' => 'rest-catalog',
    'route_matrix' => array(
        array('id' => 'products-list', 'method' => 'GET', 'path' => '/wc/v3/products', 'params' => array('per_page' => 10)),
        array('method' => 'GET', 'route' => '/wc/v3/orders'),
    ),
    'artifacts' => array('route-summary' => array('path' => 'bench/rest-route-summary.json', 'kind' => 'json')),
));
echo json_encode($steps, JSON_UNESCAPED_SLASHES);
`,
  )
  return runPhpFileJson<Array<{ type: string; path?: string; route?: string; method: string; "metric-prefix"?: string; metadata: { route_matrix_index: number } }>>(phpTestFile)
})
assert.equal(routeMatrixSteps.length, 2)
assert.equal(routeMatrixSteps[0].type, "rest-request")
assert.equal(routeMatrixSteps[0].path, "/wc/v3/products")
assert.equal(routeMatrixSteps[0]["metric-prefix"], "rest_products-list")
assert.deepEqual(routeMatrixSteps[0].metadata, { route_matrix_index: 0 })
assert.equal(routeMatrixSteps[1].route, "/wc/v3/orders")
assert.deepEqual(routeMatrixSteps[1].metadata, { route_matrix_index: 1 })
assert.match(phpFunctionBlock(benchRunner, "wp_codebox_bench_run_rest_request_step"), /'route_matrix_index'\] = \(int\) \$step\['metadata'\]\['route_matrix_index'\]/)

const generatedCaseSteps = await withTempDir("wp-codebox-bench-rest-cases-", async (directory) => {
  const phpTestFile = join(directory, "rest-cases.php")
  await writeFile(
    phpTestFile,
    `<?php
${commandStepHelpers}
$steps = wp_codebox_bench_workload_run_steps(array(
    'id' => 'generated-rest-cases',
    'rest_request_cases' => array(
        array('id' => 'posts-page-1', 'method' => 'GET', 'route' => '/wp/v2/posts', 'params' => array('page' => 1)),
        array('case_id' => 'cart-context-view', 'method' => 'GET', 'path' => '/wc/store/v1/cart', 'params' => array('context' => 'view')),
    ),
));
echo json_encode($steps, JSON_UNESCAPED_SLASHES);
`,
  )
  return runPhpFileJson<Array<{ type: string; path?: string; route?: string; case_id?: string; method: string; "metric-prefix": string; metadata: { rest_request_case_index: number } }>>(phpTestFile)
})
assert.equal(generatedCaseSteps.length, 2)
assert.equal(generatedCaseSteps[0].type, "rest-request")
assert.equal(generatedCaseSteps[0].path, "/wp/v2/posts")
assert.equal(generatedCaseSteps[0].case_id, "posts-page-1")
assert.equal(generatedCaseSteps[0]["metric-prefix"], "rest_posts_page_1")
assert.deepEqual(generatedCaseSteps[0].metadata, { rest_request_case_index: 0 })
assert.equal(generatedCaseSteps[1].path, "/wc/store/v1/cart")
assert.equal(generatedCaseSteps[1].case_id, "cart-context-view")
assert.deepEqual(generatedCaseSteps[1].metadata, { rest_request_case_index: 1 })
assert.match(phpFunctionBlock(benchRunner, "wp_codebox_bench_run_rest_request_step"), /'rest_request_case_index'\] = \(int\) \$step\['metadata'\]\['rest_request_case_index'\]/)
assert.match(phpFunctionBlock(benchRunner, "wp_codebox_bench_run_rest_request_step"), /\$record\['case_id'\] = \(string\) \$step\['case_id'\]/)
assert.match(benchRunner, /\$type === 'db-inventory'/)
assert.match(benchRunner, /wp_codebox_bench_run_db_inventory_step\(\$step\)/)
assert.match(benchRunner, /\$type === 'rest-db-query-profiler'/)
assert.match(benchRunner, /wp_codebox_bench_run_rest_db_query_profiler_step\(\$step\)/)
assert.match(benchRunner, /\$type === 'external-http-guardrail'/)
assert.match(benchRunner, /wp_codebox_bench_run_external_http_guardrail_step\(\$step\)/)
