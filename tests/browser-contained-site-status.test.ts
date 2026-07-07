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
function apply_filters( $tag, $value, ...$args ) {
	if ( 'wp_codebox_browser_preview_boot_config' === $tag && ! empty( $GLOBALS['wp_codebox_test_strip_preview_boot_ref'] ) && is_array( $value ) ) {
		unset( $value['blueprint_ref_dto'] );
	}
	return $value;
}

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
	'artifact_digest' => array( 'algorithm' => 'sha256', 'value' => str_repeat( 'a', 64 ) ),
	'materialization_digest' => array( 'algorithm' => 'sha256', 'value' => str_repeat( 'b', 64 ) ),
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
$mismatch_hash = str_repeat( 'f', 64 );
$mismatch_transient_key = 'wp_codebox_browser_prepared_runtime_' . substr( hash( 'sha256', $cache_key . ':' . $mismatch_hash ), 0, 24 );
$GLOBALS['wp_codebox_test_transients'][ $mismatch_transient_key ] = array(
	'schema' => 'wp-codebox/browser-prepared-runtime-artifact/v1',
	'cache_key' => $cache_key,
	'input_hash' => $bad_hash,
	'created_at' => '2026-06-18T00:00:00+00:00',
	'blueprint' => array( 'steps' => array( array( 'step' => 'login' ) ) ),
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
$mismatch = WP_Codebox_Test_Browser_Contained_Site_Abilities::get_browser_contained_site_status( array(
	'site_id' => $cache_key,
	'input_hash' => $mismatch_hash,
) );
$missing_ref = WP_Codebox_Test_Browser_Contained_Site_Abilities::get_browser_contained_site_status( array(
	'site_id' => $cache_key,
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
$open_or_create_miss_no_fallback = WP_Codebox_Test_Browser_Contained_Site_Abilities::open_or_create_browser_contained_site( array(
	'mode' => 'open-only',
	'contained_site' => array(
		'schema' => 'wp-codebox/browser-contained-site/v1',
		'site_id' => $cache_key,
		'cache_key' => $cache_key,
		'source_digest' => array( 'algorithm' => 'sha256', 'value' => str_repeat( 'd', 64 ) ),
	),
) );
$open_or_create_missing_mode = WP_Codebox_Test_Browser_Contained_Site_Abilities::open_or_create_browser_contained_site( array(
	'contained_site' => array(
		'schema' => 'wp-codebox/browser-contained-site/v1',
		'site_id' => $cache_key,
	),
) );
$open_or_create_invalid_mode = WP_Codebox_Test_Browser_Contained_Site_Abilities::open_or_create_browser_contained_site( array(
	'mode' => 'fallback-create',
	'contained_site' => array(
		'schema' => 'wp-codebox/browser-contained-site/v1',
		'site_id' => $cache_key,
	),
) );
$GLOBALS['wp_codebox_test_strip_preview_boot_ref'] = true;
$open_unbootable = WP_Codebox_Test_Browser_Contained_Site_Abilities::open_browser_contained_site( array(
	'contained_site' => array(
		'schema' => 'wp-codebox/browser-contained-site/v1',
		'site_id' => $cache_key,
		'source_digest' => array( 'algorithm' => 'sha256', 'value' => $input_hash ),
		'recovery' => array( 'input' => array( 'cache_key' => $cache_key, 'input_hash' => $input_hash ) ),
	),
) );
$contained_site_for_snapshot = array(
	'schema' => 'wp-codebox/browser-contained-site/v1',
	'site_id' => $cache_key,
	'preview_id' => 'preview-proof',
	'session_id' => 'session-proof',
	'source_digest' => array( 'algorithm' => 'sha256', 'value' => $input_hash ),
	'preview' => array( 'scope' => 'session-proof' ),
);
$snapshot = WP_Codebox_Test_Browser_Contained_Site_Abilities::snapshot_browser_contained_site( array(
	'contained_site' => $contained_site_for_snapshot,
	'source_digest' => array( 'algorithm' => 'sha256', 'value' => $input_hash ),
	'session_id' => 'session-proof',
	'scope' => 'session-proof',
) );
$export = WP_Codebox_Test_Browser_Contained_Site_Abilities::export_browser_contained_site( array( 'contained_site' => $contained_site_for_snapshot ) );
$apply_plan = WP_Codebox_Test_Browser_Contained_Site_Abilities::plan_browser_contained_site_apply( array(
	'contained_site' => $contained_site_for_snapshot,
	'changes' => array( array( 'path' => 'wp-content/themes/example/style.css', 'action' => 'update' ) ),
) );
$apply_result = WP_Codebox_Test_Browser_Contained_Site_Abilities::apply_browser_contained_site_plan( array( 'plan' => $apply_plan ) );
$stale_snapshot = WP_Codebox_Test_Browser_Contained_Site_Abilities::snapshot_browser_contained_site( array(
	'contained_site' => $contained_site_for_snapshot,
	'source_digest' => str_repeat( 'd', 64 ),
) );
$scope_mismatch_plan = WP_Codebox_Test_Browser_Contained_Site_Abilities::plan_browser_contained_site_apply( array(
	'contained_site' => $contained_site_for_snapshot,
	'scope' => 'other-scope',
) );

echo json_encode( array( 'hit' => $hit, 'miss' => $miss, 'incompatible' => $incompatible, 'mismatch' => $mismatch, 'missing_ref' => array( 'code' => $missing_ref->code ?? null, 'message' => $missing_ref->message ?? null, 'data' => $missing_ref->data ?? null ), 'open_hit' => $open_hit, 'open_miss' => $open_miss, 'open_or_create_miss_no_fallback' => $open_or_create_miss_no_fallback, 'open_or_create_missing_mode' => $open_or_create_missing_mode, 'open_or_create_invalid_mode' => $open_or_create_invalid_mode, 'open_unbootable' => $open_unbootable, 'snapshot' => $snapshot, 'export' => $export, 'apply_plan' => $apply_plan, 'apply_result' => $apply_result, 'stale_snapshot' => $stale_snapshot, 'scope_mismatch_plan' => $scope_mismatch_plan ), JSON_UNESCAPED_SLASHES );
`)

assert.equal(result.hit.schema, "wp-codebox/browser-contained-site-status/v1")
assert.equal(result.hit.success, true)
assert.equal(result.hit.site_id, "browser-site-proof")
assert.equal(result.hit.status, "recoverable_prepared_runtime")
assert.equal(result.hit.resolution.outcome, "recoverable_prepared_runtime")
assert.equal(result.hit.resolution.reason, "prepared-runtime-cache-hit")
assert.equal(result.hit.resolution.recoverable, true)
assert.equal(result.hit.resolution.prepared_runtime_recoverable, true)
assert.equal(result.hit.resolution.live, false)
assert.equal(result.hit.resolution.current, false)
assert.equal(result.hit.resolution.materialized, false)
assert.equal(result.hit.resolution.reused, false)
assert.equal(result.hit.resolution.created, false)
assert.equal(result.hit.resolution.miss, false)
assert.equal(result.hit.open_mode, "reuse_prepared_runtime")
assert.equal(result.hit.reuse_level, "prepared_runtime")
assert.equal(result.hit.requires_materialization, false)
assert.equal(result.hit.prepared_runtime_recoverable, true)
assert.equal(result.hit.live, false)
assert.equal(result.hit.current, false)
assert.equal(result.hit.materialized, false)
assert.equal(result.hit.source_digest.value, "c".repeat(64))
assert.equal(result.hit.artifact_digest.value, "a".repeat(64))
assert.equal(result.hit.materialization_digest.value, "b".repeat(64))
assert.equal(result.hit.blueprint_ref.ref, `prepared:browser-site-proof:${"c".repeat(64)}`)
assert.equal(result.hit.recovery_handle, `browser-contained-site:browser-site-proof:${"c".repeat(64)}`)
assert.equal(result.miss.success, false)
assert.equal(result.miss.status, "expired_transient")
assert.equal(result.miss.preview_state, "expired-transient")
assert.equal(result.miss.prepare_new_required, true)
assert.equal(result.miss.resolution.outcome, "expired_transient")
assert.equal(result.miss.resolution.reason, "expired-transient")
assert.equal(result.miss.open_mode, "materialize")
assert.equal(result.miss.reuse_level, "none")
assert.equal(result.miss.requires_materialization, true)
assert.equal(result.incompatible.success, false)
assert.equal(result.incompatible.status, "cache_miss")
assert.equal(result.incompatible.preview_state, "cache-miss")
assert.equal(result.incompatible.resolution.reason, "cache-miss")
assert.equal(result.incompatible.open_mode, "materialize")
assert.equal(result.incompatible.requires_materialization, true)
assert.equal(result.mismatch.success, false)
assert.equal(result.mismatch.status, "input_hash_mismatch")
assert.equal(result.mismatch.preview_state, "input-hash-mismatch")
assert.equal(result.mismatch.resolution.incompatible, true)
assert.equal(result.mismatch.open_mode, "unavailable")
assert.equal(result.mismatch.prepare_new_required, true)
assert.equal(result.missing_ref.code, "wp_codebox_browser_contained_site_ref_missing")
assert.equal(result.missing_ref.data.preview_state, "hydratable-ref-missing")
assert.equal(result.missing_ref.data.prepare_new_required, true)
assert.equal(result.open_hit.schema, "wp-codebox/browser-contained-site-open/v1")
assert.equal(result.open_hit.success, true)
assert.equal(result.open_hit.status, "recoverable_prepared_runtime")
assert.equal(result.open_hit.resolution.prepared_runtime_recoverable, true)
assert.equal(result.open_hit.resolution.live, false)
assert.equal(result.open_hit.resolution.current, false)
assert.equal(result.open_hit.resolution.materialized, false)
assert.equal(result.open_hit.resolution.reused, false)
assert.equal(result.open_hit.open_mode, "reuse_prepared_runtime")
assert.equal(result.open_hit.reuse_level, "prepared_runtime")
assert.equal(result.open_hit.requires_materialization, false)
assert.equal(result.open_hit.prepared_runtime_recoverable, true)
assert.equal(result.open_hit.live, false)
assert.equal(result.open_hit.current, false)
assert.equal(result.open_hit.materialized, false)
assert.equal(result.open_hit.artifact_digest.value, "a".repeat(64))
assert.equal(result.open_hit.materialization_digest.value, "b".repeat(64))
assert.equal(result.open_hit.contained_site.schema, "wp-codebox/browser-contained-site/v1")
assert.equal(result.open_hit.contained_site.status, "recoverable_prepared_runtime")
assert.equal(result.open_hit.contained_site.resolution.outcome, "recoverable_prepared_runtime")
assert.equal(result.open_hit.contained_site.open_mode, "reuse_prepared_runtime")
assert.equal(result.open_hit.contained_site.reuse_level, "prepared_runtime")
assert.equal(result.open_hit.contained_site.requires_materialization, false)
assert.equal(result.open_hit.contained_site.artifact_seed, "seed-proof")
assert.equal(result.open_hit.contained_site.artifact_revision, "revision-proof")
assert.equal(result.open_hit.blueprint_ref.ref, `prepared:browser-site-proof:${"c".repeat(64)}`)
assert.equal(result.open_hit.blueprint_ref.hydrator_ability, "wp-codebox/hydrate-browser-blueprint-ref")
assert.equal(result.open_hit.blueprint_ref.hydration_endpoint.includes("/wp-codebox/v1/browser-blueprint-ref"), true)
assert.equal(result.open_hit.preview_boot.schema, "wp-codebox/browser-preview-boot-config/v1")
assert.equal(result.open_hit.preview_boot.blueprint_ref, `prepared:browser-site-proof:${"c".repeat(64)}`)
assert.equal(result.open_hit.preview_boot.blueprint_ref_dto.ref, `prepared:browser-site-proof:${"c".repeat(64)}`)
assert.equal(result.open_hit.preview_boot.blueprint_ref_dto.hydration_endpoint.includes("/wp-codebox/v1/browser-blueprint-ref"), true)
assert.equal(result.open_hit.preview_boot.preview.preview_public_url, "https://preview.example.test")
assert.equal(result.open_hit.preview_lease.schema, "wp-codebox/preview-lease/v1")
assert.equal(result.open_hit.preview_lease.lease.status, "active")
assert.equal(result.open_hit.preview_session.schema, "wp-codebox/browser-session-product-dto/v1")
assert.equal(result.open_hit.preview_session.status, "recoverable_prepared_runtime")
assert.equal(result.open_hit.preview_session.session_id, "session-proof")
assert.equal(result.open_hit.preview_session.contained_site.status, "recoverable_prepared_runtime")
assert.equal(result.open_hit.preview_session.preview_boot.schema, "wp-codebox/browser-preview-boot-config/v1")
assert.equal(result.open_hit.session.schema, "wp-codebox/browser-session-identity/v1")
assert.equal(result.open_hit.session.session_id, "session-proof")
assert.equal(result.open_hit.recovery.ability, "wp-codebox/open-browser-contained-site")
assert.equal(result.open_hit.recovery_handle, `browser-contained-site:browser-site-proof:${"c".repeat(64)}`)
assert.equal(JSON.stringify(result.open_hit).includes('"blueprint"'), false)
assert.equal(JSON.stringify(result.open_hit).includes("must-not-leak"), false)
assert.equal(result.open_miss.success, false)
assert.equal(result.open_miss.status, "expired_transient")
assert.equal(result.open_miss.preview_state, "expired-transient")
assert.equal(result.open_miss.open_mode, "materialize")
assert.equal(result.open_miss.requires_materialization, true)
assert.equal(result.open_miss.blueprint_ref, undefined)
assert.equal(result.open_or_create_miss_no_fallback.schema, "wp-codebox/browser-contained-site-open-or-create/v1")
assert.equal(result.open_or_create_miss_no_fallback.success, false)
assert.equal(result.open_or_create_miss_no_fallback.mode, "open-only")
assert.equal(result.open_or_create_miss_no_fallback.action, "unavailable")
assert.equal(result.open_or_create_miss_no_fallback.reload_required, true)
assert.equal(result.open_or_create_miss_no_fallback.decision.action, "prepare-new")
assert.equal(result.open_or_create_miss_no_fallback.decision.preview_state, "expired-transient")
assert.equal(result.open_or_create_miss_no_fallback.decision.prepare_new_required, true)
assert.equal(result.open_or_create_miss_no_fallback.error.code, "wp_codebox_browser_contained_site_unavailable")
assert.equal(result.open_or_create_miss_no_fallback.created, undefined)
assert.equal(result.open_or_create_missing_mode.code, "wp_codebox_browser_contained_site_mode_required")
assert.equal(result.open_or_create_invalid_mode.code, "wp_codebox_browser_contained_site_mode_invalid")
assert.equal(result.open_unbootable.success, false)
assert.equal(result.open_unbootable.status, "unusable")
assert.equal(result.open_unbootable.resolution.outcome, "unusable")
assert.equal(result.open_unbootable.resolution.reused, false)
assert.equal(result.open_unbootable.resolution.reason, "preview-boot-blueprint-ref-dto-missing")
assert.equal(result.open_unbootable.open_mode, "unavailable")
assert.equal(result.open_unbootable.requires_materialization, true)
assert.equal(result.open_unbootable.contained_site.status, "unusable")
assert.equal(result.open_unbootable.preview_boot.blueprint_ref, `prepared:browser-site-proof:${"c".repeat(64)}`)
assert.equal(result.open_unbootable.preview_boot.blueprint_ref_dto, undefined)
assert.equal(result.snapshot.schema, "wp-codebox/browser-contained-site-snapshot/v1")
assert.equal(result.snapshot.success, true)
assert.equal(result.snapshot.snapshot.schema, "wp-codebox/wordpress-runtime-snapshot/v1")
assert.equal(result.snapshot.snapshot.status, "preview-contract")
assert.equal(result.snapshot.source_digest.value, "c".repeat(64))
assert.equal(result.export.schema, "wp-codebox/browser-contained-site-export/v1")
assert.equal(result.export.success, true)
assert.equal(result.export.export.schema, "wp-codebox/replayable-wordpress-site/v1")
assert.equal(result.export.export.blueprint.schema, "wp-codebox/replay-export-blueprint/v1")
assert.equal(result.apply_plan.schema, "wp-codebox/browser-contained-site-apply-plan/v1")
assert.equal(result.apply_plan.success, true)
assert.equal(result.apply_plan.mode, "preview")
assert.equal(result.apply_plan.host_mutation, false)
assert.equal(result.apply_plan.plan.preview_only, true)
assert.equal(result.apply_plan.plan.operation_count, 1)
assert.equal(result.apply_result.schema, "wp-codebox/browser-contained-site-apply-result/v1")
assert.equal(result.apply_result.success, true)
assert.equal(result.apply_result.mode, "preview")
assert.equal(result.apply_result.host_mutation, false)
assert.equal(result.apply_result.result.status, "previewed")
assert.equal(result.stale_snapshot.schema, "wp-codebox/browser-contained-site-snapshot/v1")
assert.equal(result.stale_snapshot.success, false)
assert.equal(result.stale_snapshot.error.code, "wp_codebox_browser_contained_site_stale_digest")
assert.equal(result.scope_mismatch_plan.schema, "wp-codebox/browser-contained-site-apply-plan/v1")
assert.equal(result.scope_mismatch_plan.success, false)
assert.equal(result.scope_mismatch_plan.error.code, "wp_codebox_browser_contained_site_scope_mismatch")

console.log("browser contained site status ok")
