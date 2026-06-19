<?php
declare(strict_types=1);

define( 'ABSPATH', __DIR__ );

$GLOBALS['wp_codebox_test_transient'] = false;

final class WP_Error {
	/** @param array<string,mixed> $data */
	public function __construct( private string $code = '', private string $message = '', private array $data = array() ) {}
	public function get_error_code(): string { return $this->code; }
	public function get_error_message(): string { return $this->message; }
	/** @return array<string,mixed> */
	public function get_error_data(): array { return $this->data; }
}

function is_wp_error( mixed $value ): bool {
	return $value instanceof WP_Error;
}

function apply_filters( string $hook_name, mixed $value, mixed ...$args ): mixed {
	unset( $hook_name, $args );
	return $value;
}

function sanitize_key( string $key ): string {
	return strtolower( preg_replace( '/[^a-zA-Z0-9_-]/', '', $key ) ?? '' );
}

function get_transient( string $transient ): mixed {
	unset( $transient );
	return $GLOBALS['wp_codebox_test_transient'];
}

function fail( string $message ): void {
	fwrite( STDERR, $message . PHP_EOL );
	exit( 1 );
}

function expect( bool $condition, string $message ): void {
	if ( ! $condition ) {
		fail( $message );
	}
}

require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-agent-task.php';
require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-browser-task-builder.php';
require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-abilities.php';

$source_digest = str_repeat( 'a', 64 );
$artifact_digest = str_repeat( 'b', 64 );
$materialization_digest = str_repeat( 'c', 64 );

$miss = WP_Codebox_Abilities::get_browser_contained_site_status(
	array(
		'cache_key'     => 'studio-native-preview',
		'source_digest' => $source_digest,
	)
);

expect( ! is_wp_error( $miss ), 'Expected miss status lookup to return an envelope.' );
expect( 'wp-codebox/browser-contained-site-status/v1' === $miss['schema'], 'Expected status schema.' );
expect( false === $miss['success'], 'Expected miss success=false.' );
expect( 'materialize' === $miss['open_mode'], 'Expected miss open_mode=materialize.' );
expect( 'none' === $miss['reuse_level'], 'Expected miss reuse_level=none.' );
expect( true === $miss['requires_materialization'], 'Expected miss to require materialization.' );
expect( false === $miss['prepared_runtime_recoverable'], 'Expected miss prepared_runtime_recoverable=false.' );
expect( false === $miss['live'], 'Expected miss live=false.' );
expect( false === $miss['current'], 'Expected miss current=false.' );
expect( false === $miss['materialized'], 'Expected miss materialized=false.' );
expect( 'browser-contained-site:studio-native-preview:' . $source_digest === $miss['recovery_handle'], 'Expected stable miss recovery handle.' );

$miss_decision = WP_Codebox_Abilities::preview_reuse_decision(
	array(
		'cache_key'     => 'studio-native-preview',
		'source_digest' => $source_digest,
	)
);

expect( ! is_wp_error( $miss_decision ), 'Expected miss preview reuse decision to return an envelope.' );
expect( 'wp-codebox/preview-reuse-decision/v1' === $miss_decision['schema'], 'Expected preview reuse decision schema.' );
expect( 'create-new' === $miss_decision['action'], 'Expected miss preview decision to create a new contained site.' );
expect( true === $miss_decision['reload_required'], 'Expected miss preview decision to require reload/materialization.' );
expect( 'materialize' === $miss_decision['open_mode'], 'Expected miss preview decision open_mode=materialize.' );
expect( isset( $miss_decision['identity_key'] ) && 64 === strlen( $miss_decision['identity_key'] ), 'Expected stable decision identity key.' );

$GLOBALS['wp_codebox_test_transient'] = array(
	'schema'                 => 'wp-codebox/browser-prepared-runtime-artifact/v1',
	'cache_key'              => 'studio-native-preview',
	'input_hash'             => $source_digest,
	'source_digest'          => array( 'algorithm' => 'sha256', 'value' => $source_digest ),
	'artifact_digest'        => array( 'algorithm' => 'sha256', 'value' => $artifact_digest ),
	'materialization_digest' => array( 'algorithm' => 'sha256', 'value' => $materialization_digest ),
	'created_at'             => '2026-01-02T03:04:05+00:00',
	'blueprint'              => array( 'steps' => array() ),
);

$status = WP_Codebox_Abilities::get_browser_contained_site_status(
	array(
		'cache_key'     => 'studio-native-preview',
		'source_digest' => $source_digest,
	)
);

expect( ! is_wp_error( $status ), 'Expected recoverable status lookup to return an envelope.' );
expect( true === $status['success'], 'Expected recoverable success=true.' );
expect( 'reuse_prepared_runtime' === $status['open_mode'], 'Expected recoverable open_mode=reuse_prepared_runtime.' );
expect( 'prepared_runtime' === $status['reuse_level'], 'Expected recoverable reuse_level=prepared_runtime.' );
expect( false === $status['requires_materialization'], 'Expected recoverable runtime not to require materialization.' );
expect( true === $status['prepared_runtime_recoverable'], 'Expected prepared runtime to be recoverable.' );
expect( $artifact_digest === $status['artifact_digest']['value'], 'Expected artifact digest to be surfaced.' );
expect( $materialization_digest === $status['materialization_digest']['value'], 'Expected materialization digest to be surfaced.' );

$open = WP_Codebox_Abilities::open_browser_contained_site(
	array(
		'cache_key'     => 'studio-native-preview',
		'source_digest' => $source_digest,
		'playground'    => array(
			'preview_public_url' => 'https://preview.example.test',
			'site_url'           => 'https://preview.example.test/wp',
			'local_url'          => 'http://localhost:8881/preview',
			'lease'              => array( 'status' => 'active' ),
		),
	)
);

expect( ! is_wp_error( $open ), 'Expected open to return an envelope.' );
expect( true === $open['success'], 'Expected open success=true.' );
expect( 'wp-codebox/browser-contained-site-open/v1' === $open['schema'], 'Expected open schema.' );
expect( 'reuse_prepared_runtime' === $open['open_mode'], 'Expected open open_mode=reuse_prepared_runtime.' );
expect( 'prepared_runtime' === $open['reuse_level'], 'Expected open reuse_level=prepared_runtime.' );
expect( false === $open['requires_materialization'], 'Expected open not to require materialization.' );
expect( isset( $open['preview_boot']['blueprint_ref_dto']['hydration_endpoint'] ), 'Expected preview boot hydration endpoint.' );
expect( 'wp-codebox/preview-lease/v1' === $open['preview_lease']['schema'], 'Expected preview lease DTO.' );
expect( 'active' === $open['preview_lease']['lease']['status'], 'Expected active preview lease.' );
expect( 'browser-contained-site:studio-native-preview:' . $source_digest === $open['recovery_handle'], 'Expected stable open recovery handle.' );
expect( 'reuse_prepared_runtime' === $open['contained_site']['open_mode'], 'Expected contained site lifecycle fields.' );

$reuse_decision = WP_Codebox_Abilities::preview_reuse_decision(
	array(
		'cache_key'     => 'studio-native-preview',
		'source_digest' => $source_digest,
	)
);

expect( ! is_wp_error( $reuse_decision ), 'Expected recoverable preview reuse decision to return an envelope.' );
expect( 'hydrate-ref' === $reuse_decision['action'], 'Expected recoverable preview decision to hydrate a prepared ref.' );
expect( false === $reuse_decision['reload_required'], 'Expected recoverable preview decision not to require reload.' );
expect( 'prepared_runtime' === $reuse_decision['reuse_level'], 'Expected recoverable preview decision reuse level.' );
expect( true === $reuse_decision['prepared_runtime_recoverable'], 'Expected recoverable preview decision to surface prepared runtime recovery.' );

$open_or_create = WP_Codebox_Abilities::open_or_create_browser_contained_site(
	array(
		'cache_key'     => 'studio-native-preview',
		'source_digest' => $source_digest,
		'playground'    => array(
			'preview_public_url' => 'https://preview.example.test',
			'site_url'           => 'https://preview.example.test/wp',
			'local_url'          => 'http://localhost:8881/preview',
			'lease'              => array( 'status' => 'active' ),
		),
	)
);

expect( ! is_wp_error( $open_or_create ), 'Expected open-or-create to return an envelope.' );
expect( true === $open_or_create['success'], 'Expected open-or-create success=true for reusable prepared runtime.' );
expect( 'wp-codebox/browser-contained-site-open-or-create/v1' === $open_or_create['schema'], 'Expected open-or-create schema.' );
expect( 'opened' === $open_or_create['action'], 'Expected open-or-create to open reusable prepared runtime.' );
expect( false === $open_or_create['reload_required'], 'Expected opened reusable runtime not to require reload.' );
expect( 'hydrate-ref' === $open_or_create['decision']['action'], 'Expected open-or-create decision to hydrate ref.' );
expect( isset( $open_or_create['preview_boot']['blueprint_ref_dto']['hydration_endpoint'] ), 'Expected open-or-create preview boot hydration endpoint.' );
expect( 'wp-codebox/preview-lease/v1' === $open_or_create['preview_lease']['schema'], 'Expected open-or-create preview lease DTO.' );

fwrite( STDOUT, "PHP browser contained site contract smoke passed\n" );
