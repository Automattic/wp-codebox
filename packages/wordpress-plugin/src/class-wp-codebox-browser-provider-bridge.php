<?php
/**
 * Generic browser provider bridge for parent-site provider requests.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_Browser_Provider_Bridge {

	private static bool $registered = false;

	public static function register(): void {
		if ( self::$registered ) {
			return;
		}

		add_filter( 'wp_codebox_browser_provider_request', array( self::class, 'handle_provider_request' ), 10, 3 );
		self::$registered = true;
	}

	/** @param mixed $response Adapter response from earlier filters. @param array<string,mixed> $request Redacted adapter request. @param array<string,mixed> $input Original ability input. @return mixed */
	public static function handle_provider_request( mixed $response, array $request, array $input ): mixed {
		if ( null !== $response ) {
			return $response;
		}

		$provider = sanitize_key( (string) ( $request['provider'] ?? '' ) );
		if ( '' === $provider ) {
			return null;
		}

		$policy = self::provider_policy( $provider, $request, $input );
		if ( empty( $policy ) ) {
			return null;
		}
		if ( is_wp_error( $policy ) ) {
			return $policy;
		}

		$prepared = self::prepare_http_request( $provider, $policy, $request, $input );
		if ( is_wp_error( $prepared ) ) {
			return $prepared;
		}

		$timeout     = max( 1, (int) ( $policy['timeout'] ?? 60 ) );
		$curl_filter = static function ( $handle ) use ( $timeout ): void {
			if ( ! function_exists( 'curl_setopt' ) ) {
				return;
			}

			if ( defined( 'CURLOPT_TIMEOUT' ) ) {
				curl_setopt( $handle, CURLOPT_TIMEOUT, $timeout ); // phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_setopt -- WordPress exposes the cURL handle only through this hook.
			}

			if ( defined( 'CURLOPT_CONNECTTIMEOUT' ) ) {
				curl_setopt( $handle, CURLOPT_CONNECTTIMEOUT, min( 30, $timeout ) ); // phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_setopt -- WordPress exposes the cURL handle only through this hook.
			}
		};

		try {
			add_action( 'http_api_curl', $curl_filter, 10, 1 );
			$http_response = wp_remote_request(
				$prepared['url'],
				array(
					'method'  => $prepared['method'],
					'timeout' => $timeout,
					'headers' => $prepared['headers'],
					'body'    => $prepared['body'],
				)
			);
		} catch ( Throwable $throwable ) {
			return new WP_Error(
				'wp_codebox_browser_provider_bridge_exception',
				$throwable->getMessage(),
				array(
					'status'   => 500,
					'provider' => $provider,
					'type'     => get_class( $throwable ),
				)
			);
		} finally {
			remove_action( 'http_api_curl', $curl_filter, 10 );
		}

		if ( is_wp_error( $http_response ) ) {
			return $http_response;
		}

		$status = (int) wp_remote_retrieve_response_code( $http_response );
		$body   = (string) wp_remote_retrieve_body( $http_response );

		return array(
			'response' => array(
				'http' => array(
					'status'  => $status,
					'headers' => self::safe_response_headers( $http_response ),
					'body'    => $body,
				),
			),
			'audit'    => array(
				'schema'           => 'wp-codebox/browser-provider-bridge-audit/v1',
				'provider'         => $provider,
				'operation'        => (string) ( $request['operation'] ?? '' ),
				'uri_host'         => (string) wp_parse_url( $prepared['url'], PHP_URL_HOST ),
				'secrets_redacted' => true,
			),
		);
	}

	/** @param array<string,mixed> $request Redacted adapter request. @param array<string,mixed> $input Original ability input. @return array<string,mixed>|WP_Error */
	private static function provider_policy( string $provider, array $request, array $input ): array|WP_Error {
		/**
		 * Registers caller-owned policy for the generic browser provider bridge.
		 *
		 * Return an empty value to leave the request unhandled. Policy must include
		 * allowed_base_urls and either authenticate_request callback or
		 * authentication => php-ai-client.
		 *
		 * @param array<string,mixed>|null $policy   Provider bridge policy.
		 * @param string                  $provider Provider ID.
		 * @param array<string,mixed>     $request  Redacted adapter request.
		 * @param array<string,mixed>     $input    Original ability input.
		 */
		$policy = apply_filters( 'wp_codebox_browser_provider_bridge_policy', null, $provider, $request, $input );
		if ( empty( $policy ) ) {
			return array();
		}
		if ( is_wp_error( $policy ) ) {
			return $policy;
		}
		if ( ! is_array( $policy ) ) {
			return new WP_Error( 'wp_codebox_browser_provider_bridge_policy_invalid', 'Browser provider bridge policy must be an array.', array( 'status' => 500, 'provider' => $provider ) );
		}

		$policy_provider = sanitize_key( (string) ( $policy['provider'] ?? $provider ) );
		if ( $provider !== $policy_provider ) {
			return array();
		}

		return $policy;
	}

	/** @param array<string,mixed> $policy Provider policy. @param array<string,mixed> $request Redacted adapter request. @param array<string,mixed> $input Original ability input. @return array{url:string,method:string,headers:array<string,string>,body:string}|WP_Error */
	private static function prepare_http_request( string $provider, array $policy, array $request, array $input ): array|WP_Error {
		$operation = (string) ( $request['operation'] ?? $input['operation'] ?? '' );
		if ( 'http.request' !== $operation ) {
			return new WP_Error( 'wp_codebox_browser_provider_bridge_operation_unsupported', 'Browser provider bridge requires a generic HTTP request envelope.', array( 'status' => 400, 'operation' => $operation ) );
		}

		$payload = is_array( $input['request'] ?? null ) ? $input['request'] : ( is_array( $request['request'] ?? null ) ? $request['request'] : array() );
		$url     = self::request_url( $provider, $policy, $payload );
		if ( is_wp_error( $url ) ) {
			return $url;
		}

		if ( '' === $url || ! in_array( strtolower( (string) wp_parse_url( $url, PHP_URL_SCHEME ) ), array( 'http', 'https' ), true ) ) {
			return new WP_Error( 'wp_codebox_browser_provider_bridge_uri_invalid', 'Browser provider bridge requires an http(s) request URI.', array( 'status' => 400, 'provider' => $provider ) );
		}

		$allowed = self::url_allowed( $url, self::allowed_base_urls( $policy ) );
		if ( is_wp_error( $allowed ) ) {
			return $allowed;
		}

		$method  = strtoupper( (string) ( $payload['method'] ?? 'POST' ) );
		$headers = self::safe_headers( is_array( $payload['headers'] ?? null ) ? $payload['headers'] : array() );
		$body    = self::request_body( $payload );

		return self::authenticate_request( $provider, $policy, array( 'url' => $url, 'method' => $method, 'headers' => $headers, 'body' => $body ), $request, $input );
	}

	/** @param array<string,mixed> $policy Provider policy. @param array<string,mixed> $payload Request payload. @return string|WP_Error */
	private static function request_url( string $provider, array $policy, array $payload ): string|WP_Error {
		$url = trim( (string) ( $payload['uri'] ?? $payload['url'] ?? '' ) );
		if ( '' !== $url ) {
			return $url;
		}

		$path = trim( (string) ( $payload['path'] ?? '' ) );
		if ( '' === $path ) {
			return '';
		}

		if ( str_contains( $path, '://' ) || str_starts_with( $path, '//' ) ) {
			return new WP_Error( 'wp_codebox_browser_provider_bridge_path_invalid', 'Browser provider bridge requires a provider-relative request path.', array( 'status' => 400, 'provider' => $provider ) );
		}

		$base_urls = self::allowed_base_urls( $policy );
		$base_url  = reset( $base_urls );
		if ( ! is_string( $base_url ) || '' === $base_url ) {
			return new WP_Error( 'wp_codebox_browser_provider_bridge_base_url_missing', 'Browser provider bridge requires at least one allowed base URL for relative paths.', array( 'status' => 400, 'provider' => $provider ) );
		}

		return rtrim( $base_url, '/' ) . '/' . ltrim( $path, '/' );
	}

	/** @param array<string,mixed> $policy Provider policy. @return string[] */
	private static function allowed_base_urls( array $policy ): array {
		$base_urls = array();
		foreach ( is_array( $policy['allowed_base_urls'] ?? null ) ? $policy['allowed_base_urls'] : array() as $candidate ) {
			if ( ! is_scalar( $candidate ) ) {
				continue;
			}

			$base_url = trim( (string) $candidate );
			if ( '' === $base_url || ! in_array( strtolower( (string) wp_parse_url( $base_url, PHP_URL_SCHEME ) ), array( 'http', 'https' ), true ) ) {
				continue;
			}

			$base_urls[] = rtrim( $base_url, '/' ) . '/';
		}

		return array_values( array_unique( $base_urls ) );
	}

	/** @param string[] $base_urls Allowed base URLs. @return true|WP_Error */
	private static function url_allowed( string $url, array $base_urls ): true|WP_Error {
		foreach ( $base_urls as $base_url ) {
			if ( self::url_matches_base_url( $url, $base_url ) ) {
				return true;
			}
		}

		return new WP_Error( 'wp_codebox_browser_provider_bridge_uri_forbidden', 'Browser provider bridge only forwards requests to configured provider endpoints.', array( 'status' => 403, 'host' => (string) wp_parse_url( $url, PHP_URL_HOST ) ) );
	}

	private static function url_matches_base_url( string $url, string $base_url ): bool {
		$url_parts  = wp_parse_url( $url );
		$base_parts = wp_parse_url( $base_url );
		if ( ! is_array( $url_parts ) || ! is_array( $base_parts ) ) {
			return false;
		}

		foreach ( array( 'scheme', 'host' ) as $required ) {
			if ( empty( $url_parts[ $required ] ) || empty( $base_parts[ $required ] ) ) {
				return false;
			}
		}

		if ( ! empty( $url_parts['user'] ) || ! empty( $url_parts['pass'] ) ) {
			return false;
		}

		if ( strtolower( (string) $url_parts['scheme'] ) !== strtolower( (string) $base_parts['scheme'] ) ) {
			return false;
		}

		if ( strtolower( (string) $url_parts['host'] ) !== strtolower( (string) $base_parts['host'] ) ) {
			return false;
		}

		if ( (int) ( $url_parts['port'] ?? 0 ) !== (int) ( $base_parts['port'] ?? 0 ) ) {
			return false;
		}

		$base_path = '/' . trim( (string) ( $base_parts['path'] ?? '' ), '/' );
		$url_path  = '/' . ltrim( (string) ( $url_parts['path'] ?? '/' ), '/' );
		if ( '/' === $base_path ) {
			return true;
		}

		return $url_path === $base_path || str_starts_with( $url_path, rtrim( $base_path, '/' ) . '/' );
	}

	/** @param array{url:string,method:string,headers:array<string,string>,body:string} $prepared Prepared request. @param array<string,mixed> $policy Provider policy. @param array<string,mixed> $request Redacted adapter request. @param array<string,mixed> $input Original ability input. @return array{url:string,method:string,headers:array<string,string>,body:string}|WP_Error */
	private static function authenticate_request( string $provider, array $policy, array $prepared, array $request, array $input ): array|WP_Error {
		if ( is_callable( $policy['authenticate_request'] ?? null ) ) {
			$authenticated = call_user_func( $policy['authenticate_request'], $prepared, $provider, $request, $input );
			$authenticated = self::validated_prepared_request( $authenticated, $provider );
			if ( is_wp_error( $authenticated ) ) {
				return $authenticated;
			}

			$allowed = self::url_allowed( $authenticated['url'], self::allowed_base_urls( $policy ) );
			return is_wp_error( $allowed ) ? $allowed : $authenticated;
		}

		if ( 'php-ai-client' === (string) ( $policy['authentication'] ?? '' ) ) {
			$authenticated = self::authenticate_with_php_ai_client( $provider, $prepared );
			if ( is_wp_error( $authenticated ) ) {
				return $authenticated;
			}

			$allowed = self::url_allowed( $authenticated['url'], self::allowed_base_urls( $policy ) );
			return is_wp_error( $allowed ) ? $allowed : $authenticated;
		}

		return new WP_Error( 'wp_codebox_browser_provider_bridge_authentication_missing', 'Browser provider bridge policy requires an authentication callback or php-ai-client authentication.', array( 'status' => 403, 'provider' => $provider ) );
	}

	/** @param array{url:string,method:string,headers:array<string,string>,body:string} $prepared Prepared request. @return array{url:string,method:string,headers:array<string,string>,body:string}|WP_Error */
	private static function authenticate_with_php_ai_client( string $provider, array $prepared ): array|WP_Error {
		if ( ! class_exists( '\WordPress\AiClient\AiClient' ) || ! class_exists( '\WordPress\AiClient\Providers\Http\DTO\Request' ) || ! class_exists( '\WordPress\AiClient\Providers\Http\Enums\HttpMethodEnum' ) ) {
			return new WP_Error( 'wp_codebox_browser_provider_bridge_php_ai_client_unavailable', 'PHP AI Client request authentication is unavailable.', array( 'status' => 500, 'provider' => $provider ) );
		}

		try {
			$registry       = \WordPress\AiClient\AiClient::defaultRegistry();
			$authentication = method_exists( $registry, 'getProviderRequestAuthentication' ) ? $registry->getProviderRequestAuthentication( $provider ) : null;
			$method_enum    = \WordPress\AiClient\Providers\Http\Enums\HttpMethodEnum::tryFrom( $prepared['method'] );
			if ( null === $authentication || null === $method_enum ) {
				return new WP_Error( 'wp_codebox_browser_provider_bridge_php_ai_client_authentication_missing', 'PHP AI Client request authentication is not registered for this provider.', array( 'status' => 403, 'provider' => $provider ) );
			}

			$auth_request = new \WordPress\AiClient\Providers\Http\DTO\Request( $method_enum, $prepared['url'], $prepared['headers'], $prepared['body'] );
			$auth_request = $authentication->authenticateRequest( $auth_request );

			return array(
				'url'     => $auth_request->getUri(),
				'method'  => $auth_request->getMethod()->value,
				'headers' => self::flat_headers( $auth_request->getHeaders() ),
				'body'    => (string) $auth_request->getBody(),
			);
		} catch ( Throwable $throwable ) {
			return new WP_Error( 'wp_codebox_browser_provider_bridge_authentication_failed', $throwable->getMessage(), array( 'status' => 500, 'provider' => $provider, 'type' => get_class( $throwable ) ) );
		}
	}

	/** @param mixed $request Prepared request candidate. @return array{url:string,method:string,headers:array<string,string>,body:string}|WP_Error */
	private static function validated_prepared_request( mixed $request, string $provider ): array|WP_Error {
		if ( is_wp_error( $request ) ) {
			return $request;
		}
		if ( ! is_array( $request ) ) {
			return new WP_Error( 'wp_codebox_browser_provider_bridge_authenticated_request_invalid', 'Browser provider bridge authentication must return a prepared request array.', array( 'status' => 500, 'provider' => $provider ) );
		}

		return array(
			'url'     => trim( (string) ( $request['url'] ?? '' ) ),
			'method'  => strtoupper( (string) ( $request['method'] ?? 'POST' ) ),
			'headers' => self::flat_headers( is_array( $request['headers'] ?? null ) ? $request['headers'] : array() ),
			'body'    => is_scalar( $request['body'] ?? null ) ? (string) $request['body'] : '',
		);
	}

	/** @param array<string,mixed> $payload Request payload. */
	private static function request_body( array $payload ): string {
		$body = $payload['body'] ?? null;
		if ( is_string( $body ) ) {
			return $body;
		}
		if ( null !== $body ) {
			$encoded = wp_json_encode( $body, JSON_UNESCAPED_SLASHES );
			return is_string( $encoded ) ? $encoded : '';
		}

		$data = $payload['data'] ?? null;
		if ( null !== $data ) {
			$encoded = wp_json_encode( $data, JSON_UNESCAPED_SLASHES );
			return is_string( $encoded ) ? $encoded : '';
		}

		return '';
	}

	/** @param array<string,mixed> $headers Request headers. @return array<string,string> */
	private static function safe_headers( array $headers ): array {
		$safe = array();
		foreach ( $headers as $name => $value ) {
			$name = (string) $name;
			if ( self::is_sensitive_header( $name ) ) {
				continue;
			}

			if ( is_array( $value ) ) {
				$value = implode( ', ', array_filter( array_map( 'strval', $value ) ) );
			}

			if ( is_scalar( $value ) ) {
				$safe[ $name ] = (string) $value;
			}
		}

		return $safe;
	}

	/** @param array<string,array<int,string>|string> $headers Header lists. @return array<string,string> */
	private static function flat_headers( array $headers ): array {
		$flat = array();
		foreach ( $headers as $name => $values ) {
			$flat[ (string) $name ] = is_array( $values ) ? implode( ', ', array_map( 'strval', $values ) ) : (string) $values;
		}

		return $flat;
	}

	/** @param mixed $http_response WordPress HTTP response. @return array<string,mixed> */
	private static function safe_response_headers( mixed $http_response ): array {
		if ( ! is_array( $http_response ) ) {
			return array();
		}

		$headers = $http_response['headers'] ?? array();
		if ( is_object( $headers ) && method_exists( $headers, 'getAll' ) ) {
			$headers = $headers->getAll();
		}
		if ( ! is_array( $headers ) ) {
			return array();
		}

		$safe = array();
		foreach ( $headers as $name => $value ) {
			$name          = (string) $name;
			$safe[ $name ] = self::is_sensitive_header( $name ) ? '[redacted]' : $value;
		}

		return $safe;
	}

	private static function is_sensitive_header( string $name ): bool {
		return (bool) preg_match( '/authorization|api[-_ ]?key|token|secret|password|cookie/i', $name );
	}
}
