<?php
/**
 * Browser provider authentication strategy registry.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_Browser_Provider_Auth_Strategies {

	/** @var array<string,array{callback:callable,metadata:array<string,mixed>}> */
	private static array $strategies = array();

	/** @param array<string,mixed> $metadata Public strategy metadata. */
	public static function register( string $id, callable $callback, array $metadata = array() ): void {
		$id = self::normalize_id( $id );
		if ( '' === $id ) {
			return;
		}

		self::$strategies[ $id ] = array(
			'callback' => $callback,
			'metadata' => self::public_metadata( $id, $metadata ),
		);
	}

	/** @return array<string,array<string,mixed>> */
	public static function strategies(): array {
		return array_map( static fn( array $strategy ): array => $strategy['metadata'], self::$strategies );
	}

	public static function has( string $id ): bool {
		return isset( self::$strategies[ self::normalize_id( $id ) ] );
	}

	/** @param array{url:string,method:string,headers:array<string,string>,body:string} $prepared @param array<string,mixed> $request @param array<string,mixed> $input @return array{url:string,method:string,headers:array<string,string>,body:string}|WP_Error */
	public static function authenticate( string $id, string $provider, array $prepared, array $request, array $input ): array|WP_Error {
		$id = self::normalize_id( $id );
		if ( '' === $id || ! isset( self::$strategies[ $id ] ) ) {
			return new WP_Error( 'wp_codebox_browser_provider_bridge_authentication_strategy_missing', 'Browser provider bridge authentication strategy is not registered.', array( 'status' => 403, 'provider' => $provider, 'authentication' => $id ) );
		}

		$result = call_user_func( self::$strategies[ $id ]['callback'], $prepared, $provider, $request, $input );
		return is_array( $result ) || is_wp_error( $result ) ? $result : new WP_Error( 'wp_codebox_browser_provider_bridge_authentication_strategy_invalid', 'Browser provider bridge authentication strategy returned an invalid request.', array( 'status' => 500, 'provider' => $provider, 'authentication' => $id ) );
	}

	/** @param array<string,mixed> $metadata */
	private static function public_metadata( string $id, array $metadata ): array {
		return array_filter(
			array(
				'id'                  => $id,
				'label'               => is_string( $metadata['label'] ?? null ) ? $metadata['label'] : $id,
				'adapter'             => is_string( $metadata['adapter'] ?? null ) ? $metadata['adapter'] : '',
				'installable_plugins' => is_array( $metadata['installable_plugins'] ?? null ) ? array_values( array_filter( array_map( 'strval', $metadata['installable_plugins'] ) ) ) : array(),
				'secret_env'          => is_array( $metadata['secret_env'] ?? null ) ? array_values( array_filter( array_map( 'strval', $metadata['secret_env'] ) ) ) : array(),
			),
			static fn( mixed $value ): bool => '' !== $value && array() !== $value
		);
	}

	private static function normalize_id( string $id ): string {
		$id = strtolower( trim( $id ) );
		return preg_replace( '/[^a-z0-9_-]+/', '-', $id ) ?? '';
	}
}
