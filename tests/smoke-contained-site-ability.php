<?php
/**
 * Smoke coverage for the browser contained-site open-or-create ability contract.
 */

$root      = dirname( __DIR__ );
$abilities = file_get_contents( $root . '/packages/wordpress-plugin/src/class-wp-codebox-abilities.php' );
$execution = file_get_contents( $root . '/packages/wordpress-plugin/src/trait-wp-codebox-abilities-execution.php' );

$assert = static function ( bool $condition, string $message ): void {
	if ( ! $condition ) {
		fwrite( STDERR, "FAIL: {$message}\n" );
		exit( 1 );
	}
	echo "PASS: {$message}\n";
};

$assert( false !== $abilities, 'abilities-source-readable' );
$assert( false !== $execution, 'execution-source-readable' );
$assert( str_contains( $abilities, "'wp-codebox/open-or-create-browser-contained-site'" ), 'ability-registered' );
$assert( str_contains( $abilities, "'contained_site'" ) && str_contains( $abilities, "'fallback_create'" ), 'ability-input-contract-declared' );
$assert( str_contains( $abilities, "array( 'type' => 'null' )" ), 'ability-preview-lease-accepts-null' );
$assert( str_contains( $abilities, "'execute_callback'    => array( self::class, 'open_or_create_browser_contained_site' )" ), 'ability-execute-callback-declared' );
$assert( str_contains( $abilities, "'permission_callback' => array( self::class, 'can_create_browser_playground_session' )" ), 'ability-reuses-browser-session-permission' );
$assert( str_contains( $execution, 'function open_or_create_browser_contained_site' ), 'ability-callback-implemented' );
$assert( str_contains( $execution, 'self::create_browser_playground_session( $input )' ), 'ability-uses-browser-session-contract' );
$assert( str_contains( $execution, "'schema'         => 'wp-codebox/browser-contained-site-open-or-create/v1'" ), 'ability-returns-open-or-create-schema' );
$assert( str_contains( $execution, "'schema'         => 'wp-codebox/browser-contained-site-open/v1'" ), 'ability-returns-open-schema' );
$assert( str_contains( $execution, "'preview_boot'" ) && str_contains( $execution, "'preview_lease'" ), 'ability-returns-preview-boot-and-lease' );
$assert( str_contains( $execution, "? 'created'" ) && ! str_contains( $execution, "? 'materialized'" ), 'fallback-create-does-not-claim-materialized-site' );
$assert( str_contains( $execution, 'browser_contained_site_open_unavailable' ), 'ability-has-open-unavailable-path' );
$assert( str_contains( $execution, "'fallback-create-not-requested'" ) && str_contains( $execution, "'fallback-create-missing-goal'" ), 'ability-does-not-require-create-goal-for-open-miss' );

echo "Contained-site ability smoke passed.\n";
