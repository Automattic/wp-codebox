import assert from "node:assert/strict"

import { phpStringLiteral, repoRoot, runPhpJson } from "../scripts/test-kit.js"

const result = await runPhpJson<any>(`
define('ABSPATH', ${phpStringLiteral(repoRoot)});

class WP_Error {
	public function __construct( public string $code = '', public string $message = '', public array $data = array() ) {}
}
function is_wp_error( $value ) { return $value instanceof WP_Error; }
function sanitize_key( $value ) { return strtolower( preg_replace( '/[^a-zA-Z0-9_-]/', '', (string) $value ) ); }
function wp_create_nonce( $action = -1 ) { return 'test-rest-nonce'; }

$GLOBALS['wp_codebox_test_transients'] = array();
function get_transient( $key ) { return $GLOBALS['wp_codebox_test_transients'][ $key ] ?? false; }

require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-browser-task-builder.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/trait-wp-codebox-abilities-browser-runtime.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/trait-wp-codebox-abilities-browser-blueprint.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/trait-wp-codebox-abilities-execution.php`)};

class WP_Codebox_Test_Browser_Contained_Site_Abilities {
	use WP_Codebox_Abilities_Browser_Runtime;
	use WP_Codebox_Abilities_Browser_Blueprint;
	use WP_Codebox_Abilities_Execution;
}

$cache_key = 'browser-site-proof';
$input_hash = str_repeat( 'c', 64 );
$transient_key = 'wp_codebox_browser_prepared_runtime_' . substr( hash( 'sha256', $cache_key . ':' . $input_hash ), 0, 24 );
$GLOBALS['wp_codebox_test_transients'][ $transient_key ] = array(
	'schema' => 'wp-codebox/browser-prepared-runtime-artifact/v1',
	'cache_key' => $cache_key,
	'input_hash' => $input_hash,
	'created_at' => '2026-06-18T00:00:00+00:00',
	'blueprint' => array( 'steps' => array( array( 'step' => 'login' ) ) ),
);
$bad_hash = str_repeat( 'e', 64 );
$bad_transient_key = 'wp_codebox_browser_prepared_runtime_' . substr( hash( 'sha256', $cache_key . ':' . $bad_hash ), 0, 24 );
$GLOBALS['wp_codebox_test_transients'][ $bad_transient_key ] = array(
	'schema' => 'wp-codebox/browser-prepared-runtime-artifact/v1',
	'cache_key' => $cache_key,
	'input_hash' => $bad_hash,
	'created_at' => '2026-06-18T00:00:00+00:00',
);

$hit = WP_Codebox_Test_Browser_Contained_Site_Abilities::get_browser_contained_site_status( array(
	'contained_site' => array(
		'site_id' => $cache_key,
		'source_digest' => array( 'algorithm' => 'sha256', 'value' => $input_hash ),
		'recovery' => array( 'input' => array( 'cache_key' => $cache_key, 'input_hash' => $input_hash ) ),
	),
) );
$miss = WP_Codebox_Test_Browser_Contained_Site_Abilities::get_browser_contained_site_status( array(
	'site_id' => $cache_key,
	'input_hash' => str_repeat( 'd', 64 ),
) );
$incompatible = WP_Codebox_Test_Browser_Contained_Site_Abilities::get_browser_contained_site_status( array(
	'site_id' => $cache_key,
	'input_hash' => $bad_hash,
) );
$open_hit = WP_Codebox_Test_Browser_Contained_Site_Abilities::open_browser_contained_site( array(
	'contained_site' => array(
		'schema' => 'wp-codebox/browser-contained-site/v1',
		'site_id' => $cache_key,
		'preview_id' => 'preview-proof',
		'session_id' => 'session-proof',
		'artifact_seed' => 'seed-proof',
		'artifact_revision' => 'revision-proof',
		'source_digest' => array( 'algorithm' => 'sha256', 'value' => $input_hash ),
		'preview' => array(
			'preview_public_url' => 'https://preview.example.test',
			'local_url' => '/?preview=1',
			'scope' => 'session-proof',
		),
		'blueprint' => array( 'must' => 'not leak' ),
		'secret' => 'must-not-leak',
		'recovery' => array( 'input' => array( 'cache_key' => $cache_key, 'input_hash' => $input_hash ) ),
	),
	'preview_lease' => array( 'status' => 'active', 'expires_at' => '2099-01-01T00:00:00+00:00' ),
	'runtime_profile' => array( 'id' => 'browser-preview', 'env' => array( 'SECRET' => 'must-not-leak' ) ),
) );
$open_miss = WP_Codebox_Test_Browser_Contained_Site_Abilities::open_browser_contained_site( array(
	'site_id' => $cache_key,
	'input_hash' => str_repeat( 'd', 64 ),
) );

echo json_encode( array( 'hit' => $hit, 'miss' => $miss, 'incompatible' => $incompatible, 'open_hit' => $open_hit, 'open_miss' => $open_miss ), JSON_UNESCAPED_SLASHES );
`)

assert.equal(result.hit.schema, "wp-codebox/browser-contained-site-status/v1")
assert.equal(result.hit.success, true)
assert.equal(result.hit.site_id, "browser-site-proof")
assert.equal(result.hit.status, "recoverable")
assert.equal(result.hit.resolution.outcome, "recoverable")
assert.equal(result.hit.resolution.reused, true)
assert.equal(result.hit.resolution.created, false)
assert.equal(result.hit.resolution.miss, false)
assert.equal(result.hit.source_digest.value, "c".repeat(64))
assert.equal(result.hit.blueprint_ref.ref, `prepared:browser-site-proof:${"c".repeat(64)}`)
assert.equal(result.miss.success, false)
assert.equal(result.miss.status, "miss")
assert.equal(result.miss.resolution.outcome, "miss")
assert.equal(result.miss.resolution.miss, true)
assert.equal(result.miss.resolution.reason, "prepared-runtime-not-found-or-expired")
assert.equal(result.incompatible.success, false)
assert.equal(result.incompatible.status, "incompatible")
assert.equal(result.incompatible.resolution.incompatible, true)
assert.equal(result.incompatible.resolution.reason, "source-digest-mismatch")
assert.equal(result.open_hit.schema, "wp-codebox/browser-contained-site-open/v1")
assert.equal(result.open_hit.success, true)
assert.equal(result.open_hit.status, "recoverable")
assert.equal(result.open_hit.resolution.reused, true)
assert.equal(result.open_hit.contained_site.schema, "wp-codebox/browser-contained-site/v1")
assert.equal(result.open_hit.contained_site.status, "recoverable")
assert.equal(result.open_hit.contained_site.resolution.outcome, "recoverable")
assert.equal(result.open_hit.contained_site.artifact_seed, "seed-proof")
assert.equal(result.open_hit.contained_site.artifact_revision, "revision-proof")
assert.equal(result.open_hit.blueprint_ref.ref, `prepared:browser-site-proof:${"c".repeat(64)}`)
assert.equal(result.open_hit.blueprint_ref.hydrator_ability, "wp-codebox/hydrate-browser-blueprint-ref")
assert.equal(result.open_hit.blueprint_ref.hydration_endpoint.includes("/wp-codebox/v1/browser-blueprint-ref"), true)
assert.equal(result.open_hit.preview_boot.schema, "wp-codebox/browser-preview-boot-config/v1")
assert.equal(result.open_hit.preview_boot.blueprint_ref, `prepared:browser-site-proof:${"c".repeat(64)}`)
assert.equal(result.open_hit.preview_boot.preview.preview_public_url, "https://preview.example.test")
assert.equal(result.open_hit.preview_lease.schema, "wp-codebox/preview-lease/v1")
assert.equal(result.open_hit.preview_lease.lease.status, "active")
assert.equal(result.open_hit.session.schema, "wp-codebox/browser-session-identity/v1")
assert.equal(result.open_hit.session.session_id, "session-proof")
assert.equal(result.open_hit.recovery.ability, "wp-codebox/open-browser-contained-site")
assert.equal(JSON.stringify(result.open_hit).includes('"blueprint"'), false)
assert.equal(JSON.stringify(result.open_hit).includes("must-not-leak"), false)
assert.equal(result.open_miss.success, false)
assert.equal(result.open_miss.status, "miss")
assert.equal(result.open_miss.resolution.miss, true)
assert.equal(result.open_miss.blueprint_ref, undefined)

console.log("browser contained site status ok")
