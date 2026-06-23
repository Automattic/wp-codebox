<?php
declare(strict_types=1);

define( 'ABSPATH', __DIR__ );

$GLOBALS['wp_codebox_test_filters'] = array();

final class WP_Error {
	public function __construct( private string $code, private string $message = '', private array $data = array() ) {}
	public function get_error_code(): string { return $this->code; }
	public function get_error_message(): string { return $this->message; }
	public function get_error_data(): array { return $this->data; }
}

function is_wp_error( mixed $value ): bool { return $value instanceof WP_Error; }
function sanitize_key( string $key ): string { return preg_replace( '/[^a-z0-9_-]+/', '-', strtolower( trim( $key ) ) ) ?? ''; }
function wp_parse_url( string $url, int $component = -1 ): mixed {
	$parts = parse_url( $url );
	return -1 === $component ? $parts : ( $parts[ array( PHP_URL_SCHEME => 'scheme', PHP_URL_HOST => 'host', PHP_URL_PORT => 'port', PHP_URL_USER => 'user', PHP_URL_PASS => 'pass', PHP_URL_PATH => 'path' )[ $component ] ?? '' ] ?? null );
}
function wp_json_encode( mixed $value, int $flags = 0 ): string|false { return json_encode( $value, $flags ); }
function add_filter( string $hook, callable $callback, int $priority = 10, int $accepted_args = 1 ): void { $GLOBALS['wp_codebox_test_filters'][ $hook ][] = array( $callback, $accepted_args ); }
function apply_filters( string $hook, mixed $value, mixed ...$args ): mixed {
	foreach ( $GLOBALS['wp_codebox_test_filters'][ $hook ] ?? array() as $entry ) {
		$value = $entry[0]( ...array_slice( array_merge( array( $value ), $args ), 0, $entry[1] ) );
	}
	return $value;
}
function add_action( string $hook, callable $callback, int $priority = 10, int $accepted_args = 1 ): void { add_filter( $hook, $callback, $priority, $accepted_args ); }
function remove_action(): void {}
function wp_remote_request( string $url, array $args ): array { return array( 'response' => array( 'code' => 200 ), 'body' => $args['body'] ?? '', 'headers' => array( 'x-url' => $url ) ); }
function wp_remote_retrieve_response_code( array $response ): int { return (int) ( $response['response']['code'] ?? 0 ); }
function wp_remote_retrieve_body( array $response ): string { return (string) ( $response['body'] ?? '' ); }
function wp_remote_retrieve_headers( array $response ): array { return is_array( $response['headers'] ?? null ) ? $response['headers'] : array(); }

require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-agent-task.php';
require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-browser-provider-auth-strategies.php';
require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-browser-provider-bridge.php';

$request = array(
	'provider'  => 'example-provider',
	'operation' => 'http.request',
	'connector' => array(
		'provider'        => 'example-provider',
		'capabilityScope' => array( 'browser-connector:request' ),
		'bridge'          => array(
			'schema'   => 'wp-codebox/browser-provider-bridge-connector/v1',
			'baseUrls' => array( 'https://api.example.com/v1/' ),
		),
	),
);

$input = array( 'request' => array( 'path' => '/v1/messages', 'body' => array( 'ok' => true ) ) );
$missing = WP_Codebox_Browser_Provider_Bridge::handle_provider_request( null, $request, $input );
assert( is_wp_error( $missing ) );
assert( 'wp_codebox_browser_provider_bridge_authentication_missing' === $missing->get_error_code() );

$request['connector']['bridge']['authentication'] = 'missing-auth';
$unregistered = WP_Codebox_Browser_Provider_Bridge::handle_provider_request( null, $request, $input );
assert( is_wp_error( $unregistered ) );
assert( 'wp_codebox_browser_provider_bridge_authentication_strategy_missing' === $unregistered->get_error_code() );

WP_Codebox_Browser_Provider_Auth_Strategies::register(
	'example-auth',
	static function ( array $prepared ): array {
		$prepared['headers']['Authorization'] = 'Bearer redacted';
		return $prepared;
	},
	array( 'label' => 'Example Auth', 'installable_plugins' => array( 'example-provider' ), 'secret_env' => array( 'EXAMPLE_TOKEN' ) )
);

$request['connector']['bridge']['authentication'] = 'example-auth';
$handled = WP_Codebox_Browser_Provider_Bridge::handle_provider_request( null, $request, $input );
assert( ! is_wp_error( $handled ) );
assert( 200 === $handled['response']['http']['status'] );
assert( 'example-provider' === $handled['audit']['provider'] );

echo "browser provider auth strategy smoke passed\n";
