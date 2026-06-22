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
	'runtime_requirements' => array( 'requires_provider' => false ),
	'playground' => array(
		'preview_url' => '/preview/index.html',
		'artifact_base_path' => '/wordpress/wp-content/uploads/wp-codebox/artifacts/session-public-dto',
		'artifact_base_url' => '/wp-content/uploads/wp-codebox/artifacts/session-public-dto',
	),
	'runtime' => array(
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

echo json_encode( array( 'public' => $public, 'raw' => $raw, 'materializer' => $materializer ), JSON_UNESCAPED_SLASHES );
`)

assert.equal(result.public.schema, "wp-codebox/browser-session-product-dto/v1")
assert.equal(result.public.source_schema, "wp-codebox/browser-playground-session/v1")
assert.equal(result.public.session_id, "session-public-dto")
assert.equal(result.public.preview_ref.schema, "wp-codebox/browser-preview-ref/v1")
assert.equal(result.public.preview_ref.preview_id.startsWith("preview-"), true)
assert.equal(result.public.preview_ref.site_id, "public-dto-site")
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
assert.equal(JSON.stringify(result.public).includes("must-not-leak"), false)

assert.equal(result.raw.schema, "wp-codebox/browser-playground-session/v1")
assert.equal(result.raw.product.schema, "wp-codebox/browser-session-product-dto/v1")
assert.equal(Array.isArray(result.raw.playground.blueprint.steps), true)
assert.equal(result.raw.recipe.runtime.backend, "wordpress-playground")

assert.equal(result.materializer.schema, "wp-codebox/browser-materializer-contract/v1")
assert.equal(Array.isArray(result.materializer.playground.blueprint.steps), true)
assert.equal(result.materializer.compact.schema, "wp-codebox/browser-materializer-product-dto/v1")

console.log("browser session public dto ok")
