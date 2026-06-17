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

function add_action( string $hook, callable $callback, int $priority = 10, int $accepted_args = 1 ): void {
	add_filter( $hook, $callback, $priority, $accepted_args );
}

function sanitize_key( string $key ): string {
	return strtolower( preg_replace( '/[^a-zA-Z0-9_-]/', '', $key ) ?? '' );
}

function wp_parse_url( string $url ): array|false {
	return parse_url( $url );
}

function is_wp_error( mixed $value ): bool {
	return $value instanceof WP_Error;
}

function current_user_can( string $capability ): bool {
	unset( $capability );
	return false;
}

function wp_get_ability( string $name ): ?WP_Ability {
	return 'example/browser-callback' === $name ? new WP_Ability() : null;
}

final class WP_Error {
	public function __construct( private string $code, private string $message, private array $data = array() ) {}
	public function get_error_code(): string { return $this->code; }
	public function get_error_message(): string { return $this->message; }
	public function get_error_data(): array { return $this->data; }
}

final class WP_REST_Request {
	/** @param array<string,string> $headers @param array<string,mixed> $params @param array<string,mixed> $json */
	public function __construct( private string $method, private string $route, private string $body = '', private array $headers = array(), private array $params = array(), private array $json = array() ) {}
	public function get_method(): string { return $this->method; }
	public function get_route(): string { return $this->route; }
	public function get_body(): string { return $this->body; }
	public function get_json_params(): array { return $this->json; }
	public function get_param( string $key ): mixed { return $this->params[ $key ] ?? null; }
	public function get_header( string $key ): string { return $this->headers[ strtolower( $key ) ] ?? ''; }
}

final class WP_REST_Server {}

final class WP_REST_Response {
	/** @var array<string,string> */
	public array $headers = array();
	public function __construct( public mixed $data = null, public int $status = 200 ) {}
	public function header( string $key, string $value ): void { $this->headers[ $key ] = $value; }
}

class WP_Ability {
	/** @param array<string,mixed> $input @return array<string,mixed> */
	public function execute( array $input ): array {
		return array(
			'success'          => true,
			'artifact_ref'     => array(
				'artifact_id'    => 'artifact-bundle-sha256-abc',
				'content_digest' => 'abc',
				'artifacts_path' => '/tmp/artifacts/artifact-bundle-sha256-abc',
			),
			'persisted_bundle' => array(
				'files' => array(
					array(
						'path'          => 'website/index.html',
						'artifact_path' => 'files/browser/website/index.html',
						'kind'          => 'browser-html',
						'sha256'        => array( 'algorithm' => 'sha256', 'value' => 'def' ),
					),
				),
			),
			'authorization'    => $input['authorization'] ?? array(),
		);
	}
}

require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-abilities.php';

add_filter(
	'wp_codebox_browser_callback_capabilities',
	static function ( array $capabilities ): array {
		$capabilities['persist-browser-artifact'] = array(
			'ability'          => 'example/browser-callback',
			'caller'           => 'studio-web',
			'scope'            => 'artifact:write',
			'secret'           => 'secret',
			'allowed_origins'  => array( 'https://playground.wordpress.net/editor' ),
			'max_age_seconds'  => 0,
		);

		return $capabilities;
	}
);

$body      = '{"files":[{"path":"website/index.html","content":"ok"}]}';
$timestamp = '2026-01-02T03:04:05.000Z';
$signature = 'sha256=' . hash_hmac( 'sha256', $timestamp . '.' . $body, 'secret' );
$request   = new WP_REST_Request(
	'POST',
	'/wp-codebox/v1/browser-callback/persist-browser-artifact',
	$body,
	array(
		'x-wp-codebox-callback-signature' => $signature,
		'x-wp-codebox-callback-timestamp' => $timestamp,
	),
	array( 'capability' => 'persist-browser-artifact' ),
	json_decode( $body, true )
);

$result = WP_Codebox_Abilities::rest_browser_callback( $request );
assert( ! is_wp_error( $result ) );
assert( 'wp-codebox/browser-callback-result/v1' === $result['schema'] );
assert( 'wp-codebox/materialization-result/v1' === $result['materialization']['schema'] );
assert( 'studio-web' === $result['result']['authorization']['caller'] );
assert( 'artifact-bundle' === $result['artifact_refs'][0]['kind'] );
assert( 'browser-html' === $result['artifact_refs'][1]['kind'] );

$_SERVER['HTTP_ORIGIN'] = 'https://playground.wordpress.net';
$preflight = WP_Codebox_Abilities::rest_handle_browser_callback_cors_preflight(
	null,
	new WP_REST_Server(),
	new WP_REST_Request( 'OPTIONS', '/wp-codebox/v1/browser-callback/persist-browser-artifact', '', array(), array( 'capability' => 'persist-browser-artifact' ) )
);
assert( $preflight instanceof WP_REST_Response );
assert( 204 === $preflight->status );
assert( 'https://playground.wordpress.net' === $preflight->headers['Access-Control-Allow-Origin'] );

$bad = WP_Codebox_Abilities::rest_browser_callback(
	new WP_REST_Request(
		'POST',
		'/wp-codebox/v1/browser-callback/persist-browser-artifact',
		$body,
		array(
			'x-wp-codebox-callback-signature' => 'sha256=bad',
			'x-wp-codebox-callback-timestamp' => $timestamp,
		),
		array( 'capability' => 'persist-browser-artifact' ),
		json_decode( $body, true )
	)
);
assert( is_wp_error( $bad ) );
assert( 'wp_codebox_browser_callback_signature_invalid' === $bad->get_error_code() );
