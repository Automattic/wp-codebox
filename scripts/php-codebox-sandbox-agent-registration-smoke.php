<?php

declare(strict_types=1);

define( 'ABSPATH', __DIR__ );

$registered_agents = array();

function doing_action( string $hook_name ): bool {
	return ( $GLOBALS['current_action'] ?? '' ) === $hook_name;
}

function wp_has_agent( string $slug ): bool {
	return isset( $GLOBALS['registered_agents'][ $slug ] );
}

function wp_register_agent( string $slug, array $args = array() ): ?array {
	if ( ! doing_action( 'wp_agents_api_init' ) ) {
		return null;
	}
	$GLOBALS['registered_agents'][ $slug ] = $args;
	return $args;
}

function smoke_assert( bool $condition, string $message ): void {
	if ( ! $condition ) {
		fwrite( STDERR, $message . PHP_EOL );
		exit( 1 );
	}
}

require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-agents-api-adapter.php';

$bootstrap = (string) file_get_contents( __DIR__ . '/../packages/wordpress-plugin/wp-codebox.php' );
smoke_assert( str_contains( $bootstrap, "add_action( 'wp_agents_api_init', array( WP_Codebox_Agents_API_Adapter::class, 'register_sandbox_agent' ) );" ), 'sandbox agent registration callback is hooked' );

$GLOBALS['current_action'] = 'wp_agents_api_init';
WP_Codebox_Agents_API_Adapter::register_sandbox_agent();
$GLOBALS['current_action'] = '';

smoke_assert( isset( $registered_agents['wp-codebox-sandbox'] ), 'wp-codebox-sandbox agent is registered' );
smoke_assert( 'WP Codebox Sandbox' === $registered_agents['wp-codebox-sandbox']['label'], 'sandbox agent label is stable' );
smoke_assert( 'wp-codebox' === $registered_agents['wp-codebox-sandbox']['meta']['source_plugin'], 'sandbox agent provenance is Codebox-owned' );

echo "codebox sandbox agent registration smoke passed\n";
