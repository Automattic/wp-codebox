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
  workloads: [],
})

assert.match(code, /\$bootstrap_files = json_decode/)
assert.match(code, /lib\/compat\/new\.php/)
assert.match(code, /lib\/compat\/old\.php/)
assert.match(code, /foreach \(is_array\(\$bootstrap_files\)/)
assert.match(code, /require_once \$bootstrap_path/)
assert.match(code, /break;/)
assert.match(code, /wp_codebox_bench_run_deferred_wordpress_hook_callbacks\(\$deferred_plugins_loaded_callbacks, array\(\), 'plugins_loaded'\)/)
assert.match(code, /wp_codebox_bench_run_deferred_wordpress_hook_callbacks\(\$deferred_init_callbacks, array\(\), 'init'\)/)
assert.ok(
  code.indexOf("require_once $bootstrap_path") < code.indexOf("wp_codebox_bench_run_deferred_wordpress_hook_callbacks($deferred_plugins_loaded_callbacks"),
  "bootstrap files should load before synthetic plugins_loaded/init hooks"
)

console.log("Bench bootstrap files smoke passed")
