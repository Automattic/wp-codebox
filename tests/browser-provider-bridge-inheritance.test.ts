import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

const bridgePhp = await readFile("packages/wordpress-plugin/src/class-wp-codebox-browser-provider-bridge.php", "utf8")
const resolversPhp = await readFile("packages/wordpress-plugin/src/class-wp-codebox-connector-credential-resolvers.php", "utf8")
const authStrategiesPhp = await readFile("packages/wordpress-plugin/src/class-wp-codebox-browser-provider-auth-strategies.php", "utf8")
const phpAiClientAdapterPhp = await readFile("packages/wordpress-plugin/src/class-wp-codebox-php-ai-client-browser-provider-adapter.php", "utf8")
const inheritancePhp = await readFile("packages/wordpress-plugin/src/class-wp-codebox-inheritance.php", "utf8")

assert.match(bridgePhp, /default_provider_policy/)
assert.match(bridgePhp, /capabilityScope.*browser-connector:request/s)
assert.match(bridgePhp, /allowed_bridge_base_urls/)
assert.match(bridgePhp, /authentication'\s*=>\s*\(string\) \( \$bridge\['authentication'\] \?\? '' \)/)
assert.match(bridgePhp, /WP_Codebox_Browser_Provider_Auth_Strategies::authenticate/)
assert.doesNotMatch(bridgePhp, /authentication'\s*=>\s*\(string\) \( \$bridge\['authentication'\] \?\? 'php-ai-client' \)/)
assert.doesNotMatch(methodBlock(bridgePhp, "default_provider_policy"), /OPENAI|openai|Studio|studio_web/)
assert.doesNotMatch(methodBlock(bridgePhp, "default_provider_policy"), /secret_env|secret_values|api_key/i)

assert.doesNotMatch(resolversPhp, /default_connector|provider_registered|WordPress\\AiClient|php-ai-client/)
assert.match(authStrategiesPhp, /function register\( string \$id, callable \$callback/)
assert.match(authStrategiesPhp, /function authenticate\( string \$id, string \$provider/)
assert.match(phpAiClientAdapterPhp, /WP_Codebox_Browser_Provider_Auth_Strategies::register\(\s*'php-ai-client'/)
assert.match(phpAiClientAdapterPhp, /wp_codebox_connector_credential_resolvers/)
assert.match(phpAiClientAdapterPhp, /browser-provider-bridge-connector\/v1/)
assert.match(phpAiClientAdapterPhp, /WordPress\\AiClient\\AiClient/)
assert.doesNotMatch(methodBlock(phpAiClientAdapterPhp, "connector"), /OPENAI|openai|Studio|studio_web/)

assert.match(inheritancePhp, /sanitize_connector_bridge/)
assert.match(inheritancePhp, /capabilityScope/)
assert.match(inheritancePhp, /baseUrls/)

function methodBlock(source: string, method: string): string {
  const start = source.indexOf(`function ${method}(`)
  assert.notEqual(start, -1, `${method} method exists`)

  const nextPublic = source.indexOf("\n\tpublic ", start + 1)
  const nextPrivate = source.indexOf("\n\tprivate ", start + 1)
  const nextCandidates = [nextPublic, nextPrivate].filter((candidate) => candidate !== -1)
  const next = Math.min(...nextCandidates)
  assert.notEqual(next, -1, `${method} method has a closing boundary`)

  return source.slice(start, next)
}
