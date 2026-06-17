import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

import { phpCallBlock, phpFunctionBlock } from "../scripts/test-kit.js"

const abilitiesPhp = await readFile("packages/wordpress-plugin/src/class-wp-codebox-abilities.php", "utf8")
const permissionsPhp = await readFile("packages/wordpress-plugin/src/trait-wp-codebox-abilities-permissions.php", "utf8")
const providerAdapterPhp = await readFile("packages/wordpress-plugin/src/trait-wp-codebox-abilities-provider-adapter.php", "utf8")

const providerAbility = phpCallBlock(abilitiesPhp, "wp_register_ability", "wp-codebox/execute-browser-provider-request")

assert.match(providerAbility, /'permission_callback'\s*=>\s*array\(\s*self::class,\s*'can_request_browser_connector'\s*\)/)
assert.doesNotMatch(providerAbility, /can_create_browser_playground_session/)
assert.match(providerAbility, /browser_connector_authorization_schema\(\)/)
assert.doesNotMatch(providerAbility, /browser_session_authorization_schema\(\)/)

const connectorPermission = phpFunctionBlock(permissionsPhp, "can_request_browser_connector")
assert.match(connectorPermission, /current_user_can\(\s*'manage_options'\s*\)/)
assert.match(connectorPermission, /trusted_orchestrator_authorization\(\s*\$input,\s*self::BROWSER_CONNECTOR_REQUEST_SCOPE\s*\)/)
assert.doesNotMatch(connectorPermission, /BROWSER_SESSION_CREATE_SCOPE/)

const sessionPermission = phpFunctionBlock(permissionsPhp, "can_create_browser_playground_session")
assert.match(sessionPermission, /trusted_orchestrator_authorization\(\s*\$input,\s*self::BROWSER_SESSION_CREATE_SCOPE\s*\)/)

assert.match(providerAdapterPhp, /trusted_orchestrator_authorization\(\s*\$input,\s*self::BROWSER_CONNECTOR_REQUEST_SCOPE\s*\)/)
assert.doesNotMatch(phpFunctionBlock(providerAdapterPhp, "browser_provider_request_context"), /browser_session_authorization\(\s*\$input\s*\)/)
