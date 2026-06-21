import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

const abilitiesPhp = await readFile("packages/wordpress-plugin/src/class-wp-codebox-abilities.php", "utf8")
const schemasPhp = await readFile("packages/wordpress-plugin/src/trait-wp-codebox-abilities-schemas.php", "utf8")
const executionPhp = await readFile("packages/wordpress-plugin/src/trait-wp-codebox-abilities-execution.php", "utf8")

for (const ability of ["wp-codebox/run-wordpress-workload", "wp-codebox/run-fuzz-suite"]) {
  assert.match(abilitiesPhp, new RegExp(`wp_register_ability\\(\\s*'${ability}'`), `${ability} must be registered`)
  assert.match(abilitiesPhp, new RegExp(`'canonical_ability'\\s*=>\\s*'${ability}'`), `${ability} must mark its canonical id`)
  assert.match(abilitiesPhp, new RegExp(`'safe_stub'\\s*=>\\s*true`), `${ability} must be guarded until execution is implemented`)
}

assert.match(schemasPhp, /'const'\s*=>\s*'wp-codebox\/wordpress-workload-run\/v1'/)
assert.match(schemasPhp, /'const'\s*=>\s*'wp-codebox\/wordpress-workload-run-result\/v1'/)
assert.match(schemasPhp, /'const'\s*=>\s*'wp-codebox\/fuzz-suite\/v1'/)
assert.match(schemasPhp, /'const'\s*=>\s*'wp-codebox\/fuzz-suite-result\/v1'/)

assert.match(executionPhp, /function run_wordpress_workload\( array \$input \)/)
assert.match(executionPhp, /function run_fuzz_suite\( array \$input \)/)
assert.match(executionPhp, /unsafe_execution_fields/)
assert.match(executionPhp, /collect_unsafe_execution_fields/)
assert.match(executionPhp, /'code', 'php', 'php_code', 'raw_code', 'eval', 'shell'/)
assert.match(executionPhp, /array\( 'command' \)/)
assert.match(executionPhp, /wp_codebox_wordpress_workload_runner_unavailable/)
assert.match(executionPhp, /wp_codebox_fuzz_suite_runner_unavailable/)

assert.doesNotMatch(abilitiesPhp + schemasPhp + executionPhp, /WooCommerce|Jetpack|Data Machine/i)

console.log("wordpress plugin public runtime abilities contract ok")
