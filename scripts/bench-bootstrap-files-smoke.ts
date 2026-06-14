import assert from "node:assert/strict"
import { benchRunCode } from "../packages/runtime-playground/src/bench-command-handlers.js"

const code = benchRunCode({
  componentId: "fixture-plugin",
  pluginSlug: "fixture-plugin",
  iterations: 1,
  warmupIterations: 0,
  dependencySlugs: [],
  env: {},
  bootstrapFiles: ["lib/compat/new.php", "lib/compat/old.php"],
  workloads: [{ id: "php-variable", code: "$value = 1; return array('metrics' => array('value' => $value));" }],
  scenarioIds: ["discovered-only"],
  lifecycle: {},
  resetPolicy: {},
})

assert.match(code, /\$bootstrap_files = json_decode\(base64_decode/)
assert.match(code, new RegExp(Buffer.from(JSON.stringify(["lib/compat/new.php", "lib/compat/old.php"]), "utf8").toString("base64")))
assert.doesNotMatch(code, /\$value = 1/)
assert.match(code, /foreach \(is_array\(\$bootstrap_files\)/)
assert.match(code, /require_once \$bootstrap_path/)
assert.match(code, /break;/)
assert.match(code, /wp_codebox_bench_run_deferred_wordpress_hook_callbacks\(\$deferred_plugins_loaded_callbacks, array\(\), 'plugins_loaded'\)/)
assert.match(code, /wp_codebox_bench_run_deferred_wordpress_hook_callbacks\(\$deferred_init_callbacks, array\(\), 'init'\)/)
assert.match(code, /wp-codebox\/bench-plugin-load-diagnostic\/v1/)
assert.match(code, /expected_file_path/)
assert.match(code, /'active' => function_exists\('is_plugin_active'\) \? is_plugin_active\(\$plugin_basename\) : null/)
assert.match(code, /'included' => \$included/)
assert.match(code, /\$selected_scenario_ids = json_decode\(base64_decode/)
assert.match(code, new RegExp(Buffer.from(JSON.stringify(["discovered-only"]), "utf8").toString("base64")))
assert.match(code, /wp_codebox_bench_scenario_selected\(string \$scenario_id, array \$selected_ids\): bool/)
assert.ok(
  code.indexOf("if (!wp_codebox_bench_scenario_selected($scenario_id, $selected_scenario_ids))") < code.indexOf("$callable = require $workload_file"),
  "discovered tests/bench workload files should be filtered before require/execution"
)
assert.ok(
  code.indexOf("$scenario_id = isset($workload['id'])") < code.indexOf("$payload = wp_codebox_bench_run_configured_workload($workload, $plugin_path)"),
  "configured workloads should be filtered before execution"
)
assert.ok(
  code.indexOf("require_once $bootstrap_path") < code.indexOf("wp_codebox_bench_run_deferred_wordpress_hook_callbacks($deferred_plugins_loaded_callbacks"),
  "bootstrap files should load before synthetic plugins_loaded/init hooks"
)
const componentIncludeIndex = code.indexOf("wp_codebox_bench_include_plugin_file($plugin_file")
const dependencyActivationLoopIndex = code.indexOf("foreach ($plugins_to_activate as $plugin_to_activate)", componentIncludeIndex)
assert.ok(
  componentIncludeIndex < code.indexOf("$activation = activate_plugin($plugin_to_activate)", dependencyActivationLoopIndex),
  "component plugin should be loaded before dependency activation"
)

console.log("Bench bootstrap files smoke passed")
