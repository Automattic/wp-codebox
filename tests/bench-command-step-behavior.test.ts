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
const commandStepRecord = phpFunctionBlock(benchRunner, "wp_codebox_bench_command_step_record")
assert.match(runCommandStep, /function wp_codebox_bench_run_command_step\(array \$step, string \$type, callable \$runner\): array/)
assert.match(runAbilityStep, /wp_codebox_bench_run_command_step\(\$step, 'ability'/)
assert.match(commandStepRecord, /'schema' => 'wp-codebox\/bench-command-step\/v1'/)
assert.doesNotMatch(runCommandStep, /\$type === 'ability'/)

const commandStepHelpers = [
  "wp_codebox_bench_metric_prefix",
  "wp_codebox_bench_command_step_record",
  "wp_codebox_bench_run_command_step",
  "wp_codebox_bench_command_step_payload",
  "wp_codebox_bench_workload_run_steps",
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
