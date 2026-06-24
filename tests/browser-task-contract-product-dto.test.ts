import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { repoRoot } from "../scripts/test-kit.js"

const execution = readFileSync(join(repoRoot, "packages/wordpress-plugin/src/trait-wp-codebox-abilities-execution.php"), "utf8")
const schemas = readFileSync(join(repoRoot, "packages/wordpress-plugin/src/trait-wp-codebox-abilities-schemas.php"), "utf8")
const descriptors = readFileSync(join(repoRoot, "packages/wordpress-plugin/src/class-wp-codebox-browser-ability-descriptors.php"), "utf8")

assert.match(execution, /'authorization'\s*=>\s*is_array\(\s*\$session_envelope\['authorization'\]/)
assert.match(execution, /'task_input'\s*=>\s*is_array\(\s*\$primary\['task_input'\]/)
assert.match(execution, /'authorization'\s*=>\s*is_array\(\s*\$contract\['authorization'\]/)
assert.match(execution, /'task_input'\s*=>\s*is_array\(\s*\$contract\['task_input'\]/)
assert.doesNotMatch(descriptors, /'source_digest'\s*=>\s*array\(\s*'description'/)
assert.match(descriptors, /'source_digest'\s*=>\s*array\(\s*'type'\s*=>\s*array\(\s*'string',\s*'object'\s*\)/)
assert.match(schemas, /private static function browser_materializer_contract_schema\(\): array \{\s*return self::browser_product_dto_schema\(\);\s*\}/)
assert.match(schemas, /private static function browser_task_contract_schema\(\): array \{\s*return self::browser_product_dto_schema\(\);\s*\}/)
assert.match(schemas, /private static function browser_executable_session_schema\(\): array \{[\s\S]*'const'\s*=>\s*'wp-codebox\/browser-executable-session\/v1'/)
assert.match(schemas, /'runtime_capabilities'\s*=>\s*self::browser_runtime_capabilities_schema\(\)/)
assert.match(schemas, /'runtime_readiness'\s*=>\s*self::browser_runtime_readiness_schema\(\)/)
assert.match(schemas, /private static function browser_internal_materializer_contract_schema\(\): array \{[\s\S]*'task_payload'\s*=>\s*array\( 'type' => 'object' \)/)
assert.doesNotMatch(schemas.match(/private static function browser_product_dto_schema\(\): array \{[\s\S]*?\n\}/)?.[0] ?? "", /'task_payload'|'playground'|'runtime'|'recipe'|'materialization'/)
assert.doesNotMatch(schemas.match(/private static function browser_executable_session_schema\(\): array \{[\s\S]*?\n\}/)?.[0] ?? "", /'task_payload'|'playground'|'runtime'|'recipe'|'materialization'/)

console.log("browser task contract product dto ok")
