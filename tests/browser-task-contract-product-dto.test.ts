import assert from "node:assert/strict"

import { phpStringLiteral, repoRoot, runPhpJson } from "../scripts/test-kit.js"

const rootPath = phpStringLiteral(repoRoot)
const result = await runPhpJson<any>(`
define('ABSPATH', ${rootPath});
class WP_Error {
	public function __construct( public string $code = '', public string $message = '', public array $data = array() ) {}
}
function is_wp_error( $value ) { return $value instanceof WP_Error; }
function wp_json_encode( $value, $flags = 0 ) { return json_encode( $value, $flags ); }
function sanitize_key( $value ) { return strtolower( preg_replace( '/[^a-zA-Z0-9_-]/', '', (string) $value ) ); }
function rest_url( $path = '' ) { return 'https://example.test/wp-json/' . ltrim( (string) $path, '/' ); }
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-task-input-contract.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-agent-workload.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-agents-api-adapter.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-runtime-tool-policy-descriptor.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-sandbox-tool-policy-normalizer.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-agent-task.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-runtime-dependency-plan.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-runtime-recipe-resolver.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-browser-task-builder.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/trait-wp-codebox-abilities-schemas.php`)};

class WP_Codebox_Browser_DTO_Schema_Test {
	use WP_Codebox_Abilities_Schemas {
		browser_product_dto_schema as private trait_browser_product_dto_schema;
		browser_materializer_contract_schema as private trait_browser_materializer_contract_schema;
		browser_internal_materializer_contract_schema as private trait_browser_internal_materializer_contract_schema;
		browser_task_contract_schema as private trait_browser_task_contract_schema;
	}
	public static function browser_product_schema(): array { return self::trait_browser_product_dto_schema(); }
	public static function browser_materializer_schema(): array { return self::trait_browser_materializer_contract_schema(); }
	public static function browser_internal_materializer_schema(): array { return self::trait_browser_internal_materializer_contract_schema(); }
	public static function public_browser_task_contract_schema(): array { return self::trait_browser_task_contract_schema(); }
}

$session = array(
	'success' => true,
	'schema' => 'wp-codebox/browser-playground-session/v1',
	'execution' => 'browser-playground',
	'execution_scope' => 'disposable-playground',
	'permission_model' => 'runtime-principal',
	'session' => array( 'id' => 'session-123' ),
	'task_input' => array(
		'goal' => 'Build a browser artifact.',
		'target' => array( 'kind' => 'site', 'ref' => 'demo' ),
		'parent_tool_bridge' => array( 'schema' => 'wp-codebox/parent-tool-bridge/v1', 'tools' => array() ),
	),
	'task_payload' => array( 'secret' => 'must-not-leak', 'task_input' => array( 'raw' => true ) ),
	'recipe' => array( 'runtime' => array( 'filesystem' => '/tmp/must-not-leak' ) ),
	'playground' => array(
		'client_module_url' => 'https://example.test/client.js',
		'remote_url' => 'https://playground.wordpress.net/remote.html',
		'scope' => 'session-123',
		'preview_url' => '/?preview=1',
		'prepared_runtime' => array( 'cache_key' => 'runtime-cache-key', 'input_hash' => str_repeat( 'a', 64 ), 'status' => 'hit', 'blueprint' => array( 'raw' => 'must-not-leak' ) ),
	),
	'runtime' => array( 'filesystem_path' => '/tmp/runtime-must-not-leak' ),
	'materialization' => array( 'path' => '/tmp/materialization-must-not-leak' ),
	'artifacts' => array(
		'files' => array( array( 'path' => 'index.html', 'kind' => 'browser-html', 'content' => 'must-not-leak' ) ),
	),
);

echo json_encode( array(
	'product' => WP_Codebox_Browser_Task_Builder::product_browser_session_dto( $session ),
	'safe' => WP_Codebox_Browser_Task_Builder::safe_browser_session_dto( $session ),
	'product_schema' => WP_Codebox_Browser_DTO_Schema_Test::browser_product_schema(),
	'materializer_schema' => WP_Codebox_Browser_DTO_Schema_Test::browser_materializer_schema(),
	'internal_materializer_schema' => WP_Codebox_Browser_DTO_Schema_Test::browser_internal_materializer_schema(),
	'task_contract_schema' => WP_Codebox_Browser_DTO_Schema_Test::public_browser_task_contract_schema(),
), JSON_UNESCAPED_SLASHES );
`)

assert.equal(result.product.schema, "wp-codebox/browser-session-product-dto/v1")
assert.equal(result.safe.schema, "wp-codebox/browser-session-product-dto/v1")
assert.equal(result.product.dto_schema, "wp-codebox/browser-preview-boot-config/v1")
assert.equal(result.product.executable_session, undefined)
assert.equal(result.product.runtime_handoff, undefined)
assert.equal(result.product.preview_reference, undefined)
assert.equal(result.product.preview_boot.blueprint_ref, `prepared:runtime-cache-key:${"a".repeat(64)}`)
assert.equal(result.product.artifact_refs[0].path, "files/browser/index.html")

for (const dto of [result.product, result.safe]) {
  const encoded = JSON.stringify(dto)
  for (const raw of ['"task_payload"', '"task_input"', '"recipe"', '"playground"', '"materialization"', "filesystem", "must-not-leak", '"blueprint"']) {
    assert.equal(encoded.includes(raw), false, `public DTO leaked ${raw}`)
  }
}

assert.deepEqual(Object.keys(result.materializer_schema.properties), Object.keys(result.product_schema.properties))
assert.deepEqual(Object.keys(result.task_contract_schema.properties), Object.keys(result.product_schema.properties))
assert.equal(result.internal_materializer_schema.properties.task_payload.type, "object")
assert.equal(result.product_schema.properties.task_payload, undefined)
assert.equal(result.product_schema.properties.playground, undefined)
assert.equal(result.product_schema.properties.executable_session, undefined)
assert.equal(result.product_schema.properties.preview_reference, undefined)

console.log("browser task contract product dto ok")
