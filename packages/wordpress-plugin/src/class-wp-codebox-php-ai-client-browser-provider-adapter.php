<?php
/**
 * php-ai-client adapter for browser provider authentication.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_Php_Ai_Client_Browser_Provider_Adapter {

	public static function register(): void {
		WP_Codebox_Browser_Provider_Auth_Strategies::register(
			'php-ai-client',
			array( self::class, 'authenticate_request' ),
			array(
				'label'               => 'PHP AI Client',
				'adapter'             => self::class,
				'installable_plugins' => array( 'php-ai-client' ),
			)
		);

		add_filter( 'wp_codebox_connector_credential_resolvers', array( self::class, 'register_connector_resolver' ), 10, 3 );
	}

	/** @param array<string,mixed> $resolvers @param array{connectors:string[],settings:string[]} $request @param array<string,mixed> $input */
	public static function register_connector_resolver( array $resolvers, array $request, array $input ): array {
		foreach ( array_values( array_unique( array_filter( array_map( 'strval', $request['connectors'] ?? array() ) ) ) ) as $connector_name ) {
			$provider = sanitize_key( $connector_name );
			if ( '' === $provider || ! self::provider_registered( $provider ) ) {
				continue;
			}

			$resolvers[ $connector_name ] = self::connector( $connector_name, $provider, $input );
		}

		return $resolvers;
	}

	/** @param array{url:string,method:string,headers:array<string,string>,body:string} $prepared @return array{url:string,method:string,headers:array<string,string>,body:string}|WP_Error */
	public static function authenticate_request( array $prepared, string $provider ): array|WP_Error {
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

	/** @param array<string,mixed> $input @return array<string,mixed> */
	private static function connector( string $connector_name, string $provider, array $input ): array {
		$connector = array(
			'name'           => $connector_name,
			'status'         => 'resolved',
			'provider'       => $provider,
			'bridge'         => array(
				'schema'         => 'wp-codebox/browser-provider-bridge-connector/v1',
				'authentication' => 'php-ai-client',
				'baseUrls'       => self::provider_base_urls( $provider, $input ),
			),
			'capabilityScope' => array( 'browser-connector:request' ),
		);

		$model = trim( (string) ( $input['model'] ?? '' ) );
		if ( '' !== $model ) {
			$connector['model'] = $model;
		}

		return $connector;
	}

	private static function provider_registered( string $provider ): bool {
		if ( ! class_exists( '\WordPress\AiClient\AiClient' ) ) {
			return false;
		}

		try {
			$registry = \WordPress\AiClient\AiClient::defaultRegistry();
			if ( method_exists( $registry, 'hasProvider' ) && $registry->hasProvider( $provider ) ) {
				return true;
			}

			return method_exists( $registry, 'getProviderRequestAuthentication' ) && null !== $registry->getProviderRequestAuthentication( $provider );
		} catch ( Throwable $throwable ) {
			unset( $throwable );
			return false;
		}
	}

	/** @param array<string,mixed> $input @return string[] */
	private static function provider_base_urls( string $provider, array $input ): array {
		$candidates = array();
		$registry   = null;

		try {
			$registry = class_exists( '\WordPress\AiClient\AiClient' ) ? \WordPress\AiClient\AiClient::defaultRegistry() : null;
		} catch ( Throwable $throwable ) {
			unset( $throwable );
		}

		foreach ( array( 'getProviderBaseUrl', 'getProviderBaseURL', 'getProviderApiBaseUrl', 'getProviderApiBaseURL' ) as $method ) {
			if ( is_object( $registry ) && method_exists( $registry, $method ) ) {
				$candidates[] = $registry->{$method}( $provider );
			}
		}

		if ( is_array( $input['provider_base_urls'] ?? null ) ) {
			$candidates = array_merge( $candidates, $input['provider_base_urls'] );
		}

		if ( function_exists( 'apply_filters' ) ) {
			$candidates = apply_filters( 'wp_codebox_browser_provider_base_urls', $candidates, $provider, $input );
		}

		$base_urls = array();
		foreach ( is_array( $candidates ) ? $candidates : array() as $candidate ) {
			if ( ! is_scalar( $candidate ) ) {
				continue;
			}

			$base_url = trim( (string) $candidate );
			if ( '' !== $base_url && in_array( strtolower( (string) wp_parse_url( $base_url, PHP_URL_SCHEME ) ), array( 'http', 'https' ), true ) ) {
				$base_urls[] = rtrim( $base_url, '/' ) . '/';
			}
		}

		return array_values( array_unique( $base_urls ) );
	}

	/** @param array<string,array<int,string>|string> $headers @return array<string,string> */
	private static function flat_headers( array $headers ): array {
		$flat = array();
		foreach ( $headers as $name => $values ) {
			$flat[ (string) $name ] = is_array( $values ) ? implode( ', ', array_map( 'strval', $values ) ) : (string) $values;
		}

		return $flat;
	}
}
