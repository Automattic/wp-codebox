import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

import { phpFunctionBlock } from "../scripts/test-kit.js"

const abilityDescriptorsPhp = await readFile("packages/wordpress-plugin/src/class-wp-codebox-browser-ability-descriptors.php", "utf8")
const permissionsPhp = await readFile("packages/wordpress-plugin/src/trait-wp-codebox-abilities-permissions.php", "utf8")
const providerAdapterPhp = await readFile("packages/wordpress-plugin/src/trait-wp-codebox-abilities-provider-adapter.php", "utf8")

const providerAbilityPattern = /'wp-codebox\/execute-browser-provider-request'\s*=>\s*array\([\s\S]*?'execute_callback'\s*=>\s*array\(\s*WP_Codebox_Abilities::class,\s*'execute_browser_provider_request'\s*\)[\s\S]*?\),\n\s*'wp-codebox\/list-artifacts'/
const connectorAbilityPattern = /'wp-codebox\/browser-connector-request'\s*=>\s*array\([\s\S]*?'execute_callback'\s*=>\s*array\(\s*WP_Codebox_Abilities::class,\s*'browser_connector_request'\s*\)[\s\S]*?\),\n\s*'wp-codebox\/execute-browser-provider-request'/
assert.match(abilityDescriptorsPhp, providerAbilityPattern)
assert.match(abilityDescriptorsPhp, connectorAbilityPattern)

assert.match(abilityDescriptorsPhp, /'wp-codebox\/execute-browser-provider-request'[\s\S]*?'permission_callback'\s*=>\s*array\(\s*WP_Codebox_Abilities::class,\s*'can_request_browser_connector'\s*\)/)
assert.doesNotMatch(abilityDescriptorsPhp.match(providerAbilityPattern)?.[0] ?? "", /can_create_browser_playground_session/)
assert.match(abilityDescriptorsPhp.match(providerAbilityPattern)?.[0] ?? "", /browser_connector_authorization_schema/)
assert.doesNotMatch(abilityDescriptorsPhp.match(providerAbilityPattern)?.[0] ?? "", /browser_session_authorization_schema/)
assert.match(abilityDescriptorsPhp.match(connectorAbilityPattern)?.[0] ?? "", /'canonical_ability'\s*=>\s*'wp-codebox\/browser-connector-request'/)
assert.match(abilityDescriptorsPhp.match(providerAbilityPattern)?.[0] ?? "", /'preferred_ability'\s*=>\s*'wp-codebox\/browser-connector-request'/)
assert.doesNotMatch(abilityDescriptorsPhp.match(providerAbilityPattern)?.[0] ?? "", /'alias_of'/)

const connectorPermission = phpFunctionBlock(permissionsPhp, "can_request_browser_connector")
assert.match(connectorPermission, /current_user_can\(\s*'manage_options'\s*\)/)
assert.match(connectorPermission, /trusted_orchestrator_authorization\(\s*\$input,\s*self::BROWSER_CONNECTOR_REQUEST_SCOPE\s*\)/)
assert.doesNotMatch(connectorPermission, /BROWSER_SESSION_CREATE_SCOPE/)

const sessionPermission = phpFunctionBlock(permissionsPhp, "can_create_browser_playground_session")
assert.match(sessionPermission, /trusted_orchestrator_authorization\(\s*\$input,\s*self::BROWSER_SESSION_CREATE_SCOPE\s*\)/)

assert.match(providerAdapterPhp, /trusted_orchestrator_authorization\(\s*\$input,\s*self::BROWSER_CONNECTOR_REQUEST_SCOPE\s*\)/)
assert.doesNotMatch(phpFunctionBlock(providerAdapterPhp, "browser_provider_request_context"), /browser_session_authorization\(\s*\$input\s*\)/)
