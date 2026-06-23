import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

const abilitiesPhp = await readFile("packages/wordpress-plugin/src/class-wp-codebox-abilities.php", "utf8")
const apiPhp = await readFile("packages/wordpress-plugin/src/class-wp-codebox-api.php", "utf8")
const executionPhp = await readFile("packages/wordpress-plugin/src/trait-wp-codebox-abilities-execution.php", "utf8")
const registryPhp = await readFile("packages/wordpress-plugin/src/class-wp-codebox-runtime-provider-registry.php", "utf8")
const bridgePhp = await readFile("packages/wordpress-plugin/src/class-wp-codebox-browser-provider-bridge.php", "utf8")
const connectorPhp = await readFile("packages/wordpress-plugin/src/class-wp-codebox-connector-credential-resolvers.php", "utf8")

assert.match(abilitiesPhp, /wp_register_ability\(\s*'wp-codebox\/resolve-runtime-requirements'/)
assert.match(abilitiesPhp, /'execute_callback'\s*=>\s*array\(\s*self::class,\s*'resolve_runtime_requirements'\s*\)/)
assert.match(apiPhp, /'wp-codebox\/resolve-runtime-requirements'\s*=>\s*'resolve_runtime_requirements'/)
assert.match(executionPhp, /function resolve_runtime_requirements\( array \$input \)/)
assert.match(registryPhp, /'schema'\s*=>\s*'wp-codebox\/runtime-requirements-readiness\/v1'/)
assert.match(registryPhp, /'provider_auth_strategies'/)
assert.match(registryPhp, /'missing_adapters'/)
assert.match(registryPhp, /'installable_components'/)
assert.match(bridgePhp, /WP_Codebox_Browser_Provider_Auth_Strategies::authenticate/)
assert.doesNotMatch(bridgePhp, /authentication'\s*=>\s*\(string\) \( \$bridge\['authentication'\] \?\? 'php-ai-client' \)/)
assert.doesNotMatch(connectorPhp, /php-ai-client|WordPress\\AiClient/)

console.log("runtime requirements readiness contract ok")
