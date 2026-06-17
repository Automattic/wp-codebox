import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

const abilitiesPhp = await readFile("packages/wordpress-plugin/src/class-wp-codebox-abilities.php", "utf8")
const permissionsPhp = await readFile("packages/wordpress-plugin/src/trait-wp-codebox-abilities-permissions.php", "utf8")
const providerAdapterPhp = await readFile("packages/wordpress-plugin/src/trait-wp-codebox-abilities-provider-adapter.php", "utf8")

const providerAbility = abilityRegistrationBlock(abilitiesPhp, "wp-codebox/execute-browser-provider-request")

assert.match(providerAbility, /'permission_callback'\s*=>\s*array\(\s*self::class,\s*'can_request_browser_connector'\s*\)/)
assert.doesNotMatch(providerAbility, /can_create_browser_playground_session/)
assert.match(providerAbility, /browser_connector_authorization_schema\(\)/)
assert.doesNotMatch(providerAbility, /browser_session_authorization_schema\(\)/)

const connectorPermission = methodBlock(permissionsPhp, "can_request_browser_connector")
assert.match(connectorPermission, /current_user_can\(\s*'manage_options'\s*\)/)
assert.match(connectorPermission, /trusted_orchestrator_authorization\(\s*\$input,\s*self::BROWSER_CONNECTOR_REQUEST_SCOPE\s*\)/)
assert.doesNotMatch(connectorPermission, /BROWSER_SESSION_CREATE_SCOPE/)

const sessionPermission = methodBlock(permissionsPhp, "can_create_browser_playground_session")
assert.match(sessionPermission, /trusted_orchestrator_authorization\(\s*\$input,\s*self::BROWSER_SESSION_CREATE_SCOPE\s*\)/)

assert.match(providerAdapterPhp, /trusted_orchestrator_authorization\(\s*\$input,\s*self::BROWSER_CONNECTOR_REQUEST_SCOPE\s*\)/)
assert.doesNotMatch(methodBlock(providerAdapterPhp, "browser_provider_request_context"), /browser_session_authorization\(\s*\$input\s*\)/)

function abilityRegistrationBlock(source: string, ability: string): string {
  const start = source.indexOf(`wp_register_ability(\n\t\t\t\t'${ability}'`)
  assert.notEqual(start, -1, `${ability} registration exists`)

  const next = source.indexOf("\n\t\t\twp_register_ability(", start + 1)
  assert.notEqual(next, -1, `${ability} registration has a closing boundary`)

  return source.slice(start, next)
}

function methodBlock(source: string, method: string): string {
  const start = source.indexOf(`function ${method}(`)
  assert.notEqual(start, -1, `${method} method exists`)

  const nextFunction = source.indexOf("\npublic static function ", start + 1)
  const nextPrivateFunction = source.indexOf("\nprivate static function ", start + 1)
  const nextCandidates = [nextFunction, nextPrivateFunction].filter((candidate) => candidate !== -1)
  const next = Math.min(...nextCandidates)
  assert.notEqual(next, -1, `${method} method has a closing boundary`)

  return source.slice(start, next)
}
