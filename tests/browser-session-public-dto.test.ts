import assert from "node:assert/strict"

import { phpStringLiteral, repoRoot, runPhpJson } from "../scripts/test-kit.js"

const result = await runPhpJson<any>(`
define('ABSPATH', ${phpStringLiteral(repoRoot)});
define('WPINC', 'wp-includes');

class WP_Error {
	public function __construct( public string $code = '', public string $message = '', public array $data = array() ) {}
}
function is_wp_error( $value ) { return $value instanceof WP_Error; }
function plugin_dir_path( $file ) { return rtrim( dirname( $file ), '/' ) . '/'; }
function plugin_dir_url( $file ) { return 'https://example.test/wp-content/plugins/wp-codebox/'; }
function add_action( $hook, $callback, $priority = 10, $accepted_args = 1 ) {}
function add_filter( $hook, $callback, $priority = 10, $accepted_args = 1 ) {}
function apply_filters( $hook, $value, ...$args ) { return $value; }
function sanitize_key( $value ) { return strtolower( preg_replace( '/[^a-zA-Z0-9_-]/', '', (string) $value ) ); }
function sanitize_text_field( $value ) { return trim( (string) $value ); }
function wp_json_encode( $value, $flags = 0 ) { return json_encode( $value, $flags ); }
function wp_parse_url( $url ) { return parse_url( $url ); }
function wp_create_nonce( $action = -1 ) { return 'test-rest-nonce'; }
function wp_normalize_path( $path ) { return str_replace( chr( 92 ), '/', (string) $path ); }

require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/wp-codebox.php`)};

$input = array(
	'goal' => 'Build a product-safe browser artifact.',
	'sandbox_session_id' => 'session-public-dto',
	'orchestrator' => array( 'id' => 'studio-web' ),
	'parent_tool_bridge' => array(
		'schema' => 'wp-codebox/parent-tool-bridge/v1',
		'version' => 1,
		'allowed_tools' => array( 'workspace.read' ),
		'dispatcher' => array(
			'owner' => 'wp-codebox',
			'mode' => 'host_endpoint',
			'request_schema' => 'wp-codebox/parent-tool-request/v1',
			'result_schema' => 'wp-codebox/parent-tool-result/v1',
		),
		'sandbox_env' => array( 'mode' => 'metadata-only', 'secret_env' => array() ),
		'authorization' => array( 'mode' => 'allowlist' ),
		'redaction' => array( 'transcript_artifact_refs' => array() ),
		'metadata' => array( 'adapter' => 'test' ),
	),
	'runtime_requirements' => array( 'requires_provider' => false ),
	'playground' => array(
		'preview_url' => '/preview/index.html',
		'artifact_base_path' => '/wordpress/wp-content/uploads/wp-codebox/artifacts/session-public-dto',
		'artifact_base_url' => '/wp-content/uploads/wp-codebox/artifacts/session-public-dto',
	),
	'runtime_capabilities' => array( 'browser:preview' ),
	'runtime' => array(
		'capabilities' => array( 'browser:materialize' ),
		'prepared' => array(
			'enabled' => true,
			'cache' => false,
			'cache_key' => 'public-dto-site',
			'input_hash' => str_repeat( 'a', 64 ),
			'blueprint' => array( 'steps' => array( array( 'step' => 'runPHP', 'code' => 'must-not-leak' ) ) ),
		),
	),
	'artifact_files' => array(
		array( 'path' => 'index.html', 'kind' => 'browser-html', 'content' => '<h1>Preview</h1>' ),
	),
	'blueprint' => array( 'steps' => array( array( 'step' => 'runPHP', 'code' => 'must-not-leak' ) ) ),
);

$public = WP_Codebox_Abilities::create_browser_playground_session( $input );
$raw = WP_Codebox_Abilities::create_browser_playground_session( $input + array( 'include_raw_browser_session' => true ) );
$materializer = WP_Codebox_Abilities::create_browser_materializer_contract( $input );
$raw_materializer = WP_Codebox_Abilities::create_browser_materializer_contract( $input + array( 'include_raw_browser_materializer_contract' => true ) );
$task_contract = WP_Codebox_Abilities::create_browser_task_contract( $input );
$raw_task_contract = WP_Codebox_Abilities::create_browser_task_contract( $input + array( 'include_raw_browser_task_contract' => true ) );

echo json_encode( array(
	'public' => $public,
	'raw' => array(
		'schema' => $raw['schema'] ?? null,
		'product' => $raw['product'] ?? null,
		'playground_blueprint_steps_is_array' => is_array( $raw['playground']['blueprint']['steps'] ?? null ),
		'recipe_runtime_backend' => $raw['recipe']['runtime']['backend'] ?? null,
	),
	'materializer' => $materializer,
	'raw_materializer' => array(
		'schema' => $raw_materializer['schema'] ?? null,
		'compact' => $raw_materializer['compact'] ?? null,
		'playground_blueprint_steps_is_array' => is_array( $raw_materializer['playground']['blueprint']['steps'] ?? null ),
	),
	'task_contract' => $task_contract,
	'raw_task_contract' => array(
		'schema' => $raw_task_contract['schema'] ?? null,
		'compact' => $raw_task_contract['compact'] ?? null,
		'primary_playground_blueprint_steps_is_array' => is_array( $raw_task_contract['primary']['playground']['blueprint']['steps'] ?? null ),
	),
), JSON_UNESCAPED_SLASHES );
`)

function assertPublicDtoDoesNotExposeInternals(value: unknown) {
  const encoded = JSON.stringify(value)
  assert.equal(encoded.includes("must-not-leak"), false)
  assert.equal(encoded.includes("/wordpress/"), false, encoded)
  for (const key of ["playground", "runtime", "recipe", "task_payload", "materialization"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(value as Record<string, unknown>, key), false, `${key} must not be exposed`)
  }
}

assert.equal(result.public.schema, "wp-codebox/browser-session-product-dto/v1")
assert.equal(result.public.dto_schema, "wp-codebox/browser-executable-session/v1")
assert.equal(result.public.source_schema, "wp-codebox/browser-playground-session/v1")
assert.equal(result.public.session_id, "session-public-dto")
assert.equal(result.public.executable_session.schema, "wp-codebox/browser-executable-session/v1")
assert.equal(result.public.executable_session.session_id, "session-public-dto")
assert.equal(result.public.executable_session.status, "ready")
assert.equal(result.public.executable_session.preview_ref.schema, "wp-codebox/browser-preview-ref/v1")
assert.equal(result.public.executable_session.preview.schema, "wp-codebox/preview-lease/v1")
assert.equal(result.public.executable_session.preview_boot.blueprint_ref, result.public.preview_boot.blueprint_ref)
assert.equal(result.public.executable_session.blueprint_ref.ref, result.public.blueprint_ref.ref)
assert.equal(result.public.executable_session.runtime_access.schema, "wp-codebox/runtime-access/v1")
assert.equal(result.public.preview_ref.schema, "wp-codebox/browser-preview-ref/v1")
assert.equal(result.public.preview_ref.preview_id.startsWith("preview-"), true)
assert.equal(result.public.preview_ref.site_id, "public-dto-site")
assert.equal(result.public.runtime_access.schema, "wp-codebox/runtime-access/v1")
assert.equal(result.public.runtime_access.preview_url, "/preview/index.html")
assert.equal(result.public.runtime_access.lease.schema, "wp-codebox/preview-lease/v1")
assert.equal(result.public.runtime_capabilities.schema, "wp-codebox/browser-runtime-capabilities/v1")
assert.deepEqual([...result.public.runtime_capabilities.capabilities].sort(), ["browser:compile_blueprint", "browser:materialize", "browser:preview", "browser:run_blueprint", "browser:run_php", "browser:write_file"].sort())
assert.deepEqual(result.public.executable_session.runtime_capabilities, result.public.runtime_capabilities)
assert.equal(result.public.runtime_readiness.schema, "wp-codebox/browser-runtime-readiness/v1")
assert.equal(result.public.runtime_readiness.status, "ready")
assert.equal(result.public.runtime_readiness.ready, true)
assert.deepEqual(result.public.runtime_readiness.missing, undefined)
assert.deepEqual(result.public.executable_session.runtime_readiness, result.public.runtime_readiness)
assert.equal(result.public.executable_session.runtime_handoff.schema, "wp-codebox/browser-runtime-handoff/v1")
assert.equal(result.public.executable_session.runtime_handoff.owner, "wp-codebox")
assert.equal(result.public.executable_session.runtime_handoff.hydrator_ability, "wp-codebox/hydrate-browser-blueprint-ref")
assert.equal(result.public.executable_session.runtime_handoff.blueprint_ref.ref, result.public.blueprint_ref.ref)
assert.equal(result.public.executable_session.parent_tool_bridge.schema, "wp-codebox/parent-tool-bridge/v1")
assert.deepEqual(result.public.executable_session.parent_tool_bridge.allowed_tools, ["workspace.read"])
assert.match(result.public.preview_boot.blueprint_ref, /^prepared:public-dto-site:[a-f0-9]{64}$/)
assert.equal(result.public.preview_boot.blueprint_ref_dto.hydrator_ability, "wp-codebox/hydrate-browser-blueprint-ref")
assert.equal(result.public.preview_ref.boot_ref, result.public.preview_boot.blueprint_ref)
assert.deepEqual(result.public.artifact_refs, [{
  schema: "wp-codebox/browser-artifact-ref/v1",
  kind: "browser-html",
  path: "files/browser/index.html",
  digest: { algorithm: "sha256", value: "f6197bb99270f103a24a4556bca591ddfb76fdf471755f078390af2f5e605ba0" },
  size: 16,
}])
assert.equal(result.public.playground, undefined)
assert.equal(result.public.recipe, undefined)
assert.equal(result.public.task_payload, undefined)
assert.equal(result.public.parent_tool_bridge, undefined)
assert.equal(JSON.stringify(result.public).includes("must-not-leak"), false)
assert.equal(result.public.preview_boot.artifacts.base_path, undefined)
assert.equal(result.public.preview_boot.runtime_access.preview_url, "/preview/index.html")
assertPublicDtoDoesNotExposeInternals(result.public)
assertPublicDtoDoesNotExposeInternals(result.public.executable_session)

assert.equal(result.raw.schema, "wp-codebox/browser-playground-session/v1")
assert.equal(result.raw.product.schema, "wp-codebox/browser-session-product-dto/v1")
assert.equal(result.raw.playground_blueprint_steps_is_array, true)
assert.equal(result.raw.recipe_runtime_backend, "wordpress-playground")

assert.equal(result.materializer.schema, "wp-codebox/browser-materializer-product-dto/v1")
assert.equal(result.materializer.source_schema, "wp-codebox/browser-materializer-contract/v1")
assert.equal(result.materializer.preview_ref.schema, "wp-codebox/browser-preview-ref/v1")
assert.deepEqual(result.materializer.artifact_refs, result.public.artifact_refs)
assertPublicDtoDoesNotExposeInternals(result.materializer)

assert.equal(result.raw_materializer.schema, "wp-codebox/browser-materializer-contract/v1")
assert.equal(result.raw_materializer.playground_blueprint_steps_is_array, true)
assert.equal(result.raw_materializer.compact.schema, "wp-codebox/browser-materializer-product-dto/v1")

assert.equal(result.task_contract.schema, "wp-codebox/browser-task-product-dto/v1")
assert.equal(result.task_contract.primary.schema, "wp-codebox/browser-session-product-dto/v1")
assertPublicDtoDoesNotExposeInternals(result.task_contract)

assert.equal(result.raw_task_contract.schema, "wp-codebox/browser-task-contract/v1")
assert.equal(result.raw_task_contract.compact.schema, "wp-codebox/browser-task-product-dto/v1")
assert.equal(result.raw_task_contract.primary_playground_blueprint_steps_is_array, true)

console.log("browser session public dto ok")
