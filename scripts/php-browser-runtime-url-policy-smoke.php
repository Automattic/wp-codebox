<?php

define( 'ABSPATH', __DIR__ );

final class WP_Error {
	/** @param array<string,mixed> $data */
	public function __construct(
		private string $code = '',
		private string $message = '',
		private array $data = array()
	) {}

	public function get_error_code(): string {
		return $this->code;
	}
}

function is_wp_error( mixed $value ): bool {
	return $value instanceof WP_Error;
}

/** @return array<string,mixed>|false */
function wp_parse_url( string $url ): array|false {
	return parse_url( $url );
}

function apply_filters( string $hook_name, mixed $value, mixed ...$args ): mixed {
	if ( ! empty( $GLOBALS['wp_codebox_deny_loopback_origin'] ) ) {
		return array_values( array_filter( $value, static fn( string $origin ): bool => ! str_starts_with( $origin, 'http://127.0.0.1:' ) ) );
	}

	return $value;
}

require_once __DIR__ . '/../packages/wordpress-plugin/src/trait-wp-codebox-abilities-browser-runtime.php';

final class WP_Codebox_Browser_Runtime_URL_Policy_Smoke {
	use WP_Codebox_Abilities_Browser_Runtime;

	/** @return array<string,mixed>|WP_Error */
	public static function normalize( string $url ): array|WP_Error {
		$method = new ReflectionMethod( self::class, 'browser_trusted_url' );
		return $method->invoke( null, $url, 'remote_url', 'wp_codebox_browser_playground_allowed_origins', array( 'https://playground.wordpress.net' ) );
	}

	/** @return array<int,string> */
	private static function string_list( mixed $value ): array {
		return is_array( $value ) ? array_values( array_filter( array_map( 'strval', $value ), static fn( string $item ): bool => '' !== trim( $item ) ) ) : array();
	}
}

function expect( bool $condition, string $message ): void {
	if ( ! $condition ) {
		fwrite( STDERR, $message . PHP_EOL );
		exit( 1 );
	}
}

foreach ( array( 'http://127.0.0.1:8888/remote.html', 'http://localhost:8888/remote.html', 'http://[::1]:8888/remote.html' ) as $url ) {
	$result = WP_Codebox_Browser_Runtime_URL_Policy_Smoke::normalize( $url );
	expect( ! is_wp_error( $result ), 'Expected loopback browser runtime URL to be allowed: ' . $url );
	expect( ( $result['origin'] ?? '' ) === preg_replace( '#/remote\.html$#', '', $url ), 'Expected exact loopback origin provenance.' );
}

$public = WP_Codebox_Browser_Runtime_URL_Policy_Smoke::normalize( 'https://playground.wordpress.net/remote.html' );
expect( ! is_wp_error( $public ), 'Expected trusted HTTPS Playground URL to remain allowed.' );

$insecure = WP_Codebox_Browser_Runtime_URL_Policy_Smoke::normalize( 'http://example.com/remote.html' );
expect( is_wp_error( $insecure ) && 'wp_codebox_browser_url_insecure' === $insecure->get_error_code(), 'Expected non-loopback HTTP runtime URL to remain rejected.' );

$untrusted = WP_Codebox_Browser_Runtime_URL_Policy_Smoke::normalize( 'https://example.com/remote.html' );
expect( is_wp_error( $untrusted ) && 'wp_codebox_browser_origin_not_allowed' === $untrusted->get_error_code(), 'Expected unapproved HTTPS runtime origin to remain rejected.' );

$GLOBALS['wp_codebox_deny_loopback_origin'] = true;
$denied = WP_Codebox_Browser_Runtime_URL_Policy_Smoke::normalize( 'http://127.0.0.1:8888/remote.html' );
expect( is_wp_error( $denied ) && 'wp_codebox_browser_origin_not_allowed' === $denied->get_error_code(), 'Expected the origin filter to retain authority over loopback defaults.' );

fwrite( STDOUT, "PHP browser runtime URL policy smoke passed\n" );
