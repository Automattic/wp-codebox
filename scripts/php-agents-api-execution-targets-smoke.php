<?php
declare(strict_types=1);

define( 'ABSPATH', __DIR__ );

$GLOBALS['wp_codebox_test_filters'] = array();

function add_filter( string $hook, callable $callback, int $priority = 10, int $accepted_args = 1 ): void {
	unset( $priority, $accepted_args );
	$GLOBALS['wp_codebox_test_filters'][ $hook ][] = $callback;
}

function apply_filters( string $hook, mixed $value, mixed ...$args ): mixed {
	foreach ( $GLOBALS['wp_codebox_test_filters'][ $hook ] ?? array() as $callback ) {
		$value = $callback( $value, ...$args );
	}

	return $value;
}

require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-task-input-contract.php';
require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-abilities.php';

function assert_same_contract( mixed $expected, mixed $actual, string $label ): void {
	if ( $expected !== $actual ) {
		fwrite( STDERR, $label . " failed.\nExpected: " . json_encode( $expected, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT ) . "\nActual: " . json_encode( $actual, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT ) . "\n" );
		exit( 1 );
	}
}

$reflection = new ReflectionClass( WP_Codebox_Abilities::class );
$abilities  = $reflection->newInstanceWithoutConstructor();
$method     = $reflection->getMethod( 'register_agents_api_executor_adapters' );
$method->invoke( $abilities );

$targets = apply_filters( 'wp_agent_execution_targets', array() );

assert_same_contract( true, isset( $targets['wp-codebox/browser-playground'] ), 'browser target registered on canonical Agents API hook' );
assert_same_contract( true, isset( $targets['wp-codebox/host-playground'] ), 'host target registered on canonical Agents API hook' );
assert_same_contract( 'agents-api/executor-target/v1', $targets['wp-codebox/browser-playground']['schema'] ?? null, 'browser target schema' );
assert_same_contract( 'agents-api/task-input/v1', $targets['wp-codebox/browser-playground']['input_schema']['$id'] ?? null, 'browser target input schema id' );
assert_same_contract( 'wp-codebox', $targets['wp-codebox/host-playground']['provider'] ?? null, 'host target provider' );

$legacy_targets = apply_filters( 'wp_agent_executor_targets', array() );
assert_same_contract( true, isset( $legacy_targets['wp-codebox/browser-playground'] ), 'browser target registered on legacy Codebox hook' );

fwrite( STDOUT, "PHP Agents API execution targets smoke passed\n" );
