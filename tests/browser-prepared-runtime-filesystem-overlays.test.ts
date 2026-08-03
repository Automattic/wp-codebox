import assert from "node:assert/strict"

import { phpStringLiteral, repoRoot, runPhpJson } from "../scripts/test-kit.js"

const result = await runPhpJson<any>(`
define('ABSPATH', ${phpStringLiteral(repoRoot)});
class WP_Error {
	public function __construct( public string $code = '', public string $message = '', public array $data = array() ) {}
}
function is_wp_error( $value ) { return $value instanceof WP_Error; }
function sanitize_key( $value ) { return strtolower( preg_replace( '/[^a-zA-Z0-9_-]/', '', (string) $value ) ); }
function apply_filters( $hook, $value, ...$args ) { return $value; }
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-path-policy.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/trait-wp-codebox-abilities-browser-runtime.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/trait-wp-codebox-abilities-browser-blueprint.php`)};
class WP_Codebox_Filesystem_Overlay_Test_Abilities {
	use WP_Codebox_Abilities_Browser_Runtime;
	use WP_Codebox_Abilities_Browser_Blueprint;
	public static function safe_key( $value ) { return sanitize_key( (string) $value ); }
	public static function stable_json( $value ) { return json_encode( $value, JSON_UNESCAPED_SLASHES ); }
}
$normalize = new ReflectionMethod( WP_Codebox_Filesystem_Overlay_Test_Abilities::class, 'normalize_browser_wordpress_filesystem_overlays' );
$prepared = new ReflectionMethod( WP_Codebox_Filesystem_Overlay_Test_Abilities::class, 'browser_prepared_runtime_contract' );
$blueprint = new ReflectionMethod( WP_Codebox_Filesystem_Overlay_Test_Abilities::class, 'browser_blueprint_with_runtime' );
$readiness = new ReflectionMethod( WP_Codebox_Filesystem_Overlay_Test_Abilities::class, 'browser_runtime_readiness_metadata' );
$input = array(
	'runtime' => array(
		'prepared' => array( 'enabled' => true, 'cache_key' => 'overlay-fixture' ),
		'filesystem_overlays' => array(
			array( 'target' => '/wordpress/wp-content/mu-plugins/fixture-overlay.php', 'content' => "<?php\nfunction fixture_overlay_loaded() { return true; }\n", 'overwrite' => false, 'purpose' => 'fixture mu plugin' ),
		),
	),
	'blueprint' => array( 'steps' => array( array( 'step' => 'runPHP', 'code' => '<?php /* caller step */' ) ) ),
);
$overlays = $normalize->invoke( null, $input['runtime']['filesystem_overlays'] );
$first_prepared = $prepared->invoke( null, $input['runtime'], array(), array(), array(), array(), $overlays, $input );
$second_prepared = $prepared->invoke( null, $input['runtime'], array(), array(), array(), array(), $overlays, $input );
$changed = $input;
$changed['runtime']['filesystem_overlays'][0]['content'] .= "// changed\n";
$changed_overlays = $normalize->invoke( null, $changed['runtime']['filesystem_overlays'] );
$changed_prepared = $prepared->invoke( null, $changed['runtime'], array(), array(), array(), array(), $changed_overlays, $changed );
$runtime = array(
	'plugins' => array(),
	'mu_plugins' => array(
		array(
			'slug' => 'packaged-fixture',
			'file' => 'packaged-fixture.php',
			'path' => '/wordpress/wp-content/mu-plugins/packaged-fixture.php',
			'url' => 'data:application/zip;base64,' . base64_encode( 'PKfixture' ),
			'sha256' => hash( 'sha256', 'PKfixture' ),
			'targetFolderName' => 'packaged-fixture',
			'entry' => 'packaged-fixture/packaged-fixture.php',
			'local_package' => true,
		),
	),
	'themes' => array(),
	'bootstrap' => array(),
	'filesystem_overlays' => $overlays,
);
$compiled = $blueprint->invoke( null, $input['blueprint'], $runtime, array() );
$traversal = $normalize->invoke( null, array( array( 'target' => '/wordpress/../escape.php', 'content' => '<?php', 'overwrite' => false ) ) );
$collision = $normalize->invoke( null, array( array( 'target' => '/wordpress/wp-content/mu-plugins/a.php', 'content' => '<?php', 'overwrite' => false ), array( 'target' => '/wordpress/wp-content/mu-plugins/a.php', 'content' => '<?php', 'overwrite' => false ) ) );
$undeclared_overwrite = $normalize->invoke( null, array( array( 'target' => '/wordpress/wp-content/mu-plugins/undeclared.php', 'content' => '<?php' ) ) );
echo json_encode( array(
	'overlays' => $overlays,
	'first_hash' => $first_prepared['input_hash'],
	'second_hash' => $second_prepared['input_hash'],
	'changed_hash' => $changed_prepared['input_hash'],
	'compiled' => $compiled,
	'readiness' => $readiness->invoke( null, $runtime ),
	'traversal' => is_wp_error( $traversal ) ? $traversal->code : '',
	'collision' => is_wp_error( $collision ) ? $collision->code : '',
	'undeclared_overwrite' => is_wp_error( $undeclared_overwrite ) ? $undeclared_overwrite->code : '',
), JSON_UNESCAPED_SLASHES);
`)

const overlay = result.overlays[0]
assert.equal(overlay.target, "/wordpress/wp-content/mu-plugins/fixture-overlay.php")
assert.equal(overlay.provenance.source, "runtime.filesystem_overlays[0]")
assert.match(overlay.source_digest.value, /^[a-f0-9]{64}$/)
assert.match(overlay.materialized_digest.value, /^[a-f0-9]{64}$/)
const overlayIndex = result.compiled.steps.findIndex((step: { code?: string }) => /fixture-overlay\.php/.test(step.code ?? ""))
const packageIndex = result.compiled.steps.findIndex((step: { code?: string }) => /packaged-fixture/.test(step.code ?? ""))
const callerIndex = result.compiled.steps.findIndex((step: { code?: string }) => /caller step/.test(step.code ?? ""))
assert.equal(result.compiled.steps[0].step, "runPHP")
assert.ok(overlayIndex > -1 && overlayIndex < callerIndex, "filesystem overlays are materialized before any caller Blueprint step")
assert.ok(packageIndex > overlayIndex && packageIndex < callerIndex, "packaged MU plugins are materialized before caller Blueprint steps")
assert.equal(result.compiled.steps.some((step: { step?: string }) => step.step === "installPlugin"), false, "runtime MU plugins must not emit an installPlugin download")
assert.deepEqual(result.readiness.filesystem_overlays, [{
  target: "/wordpress/wp-content/mu-plugins/fixture-overlay.php",
  overwrite: false,
  source_digest: overlay.source_digest,
  materialized_digest: overlay.materialized_digest,
  provenance: overlay.provenance,
  readiness: "compiled",
}])
assert.equal(result.first_hash, result.second_hash, "stable overlay bytes and target reuse prepared runtime identity")
assert.notEqual(result.first_hash, result.changed_hash, "changed overlay bytes invalidate prepared runtime identity")
assert.equal(result.traversal, "wp_codebox_browser_filesystem_overlay_target_invalid")
assert.equal(result.collision, "wp_codebox_browser_filesystem_overlay_target_collision")
assert.equal(result.undeclared_overwrite, "wp_codebox_browser_filesystem_overlay_overwrite_invalid")

console.log("browser prepared runtime filesystem overlays ok")
