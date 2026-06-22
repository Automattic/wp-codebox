<?php
/**
 * Runtime provider registry for WP Codebox package execution.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

/**
 * Generic runtime provider registry used by wp-codebox/run-runtime-package.
 *
 * Providers are adapters behind the Codebox ability contract. The public ability
 * remains runtime-neutral and does not expose upstream provider ability names.
 */
final class WP_Codebox_Runtime_Provider_Registry {

	/** @var array<string,array{callback:callable,metadata:array<string,mixed>}> */
	private static array $providers = array();

	private static string $default_provider = '';

	/** @param array<string,mixed> $metadata Provider metadata. */
	public static function register( string $id, callable $callback, array $metadata = array() ): void {
		$id = self::normalize_provider_id( $id );
		if ( '' === $id ) {
			return;
		}

		self::$providers[ $id ] = array(
			'callback' => $callback,
			'metadata' => self::public_metadata( $id, $metadata ),
		);

		if ( '' === self::$default_provider || true === ( $metadata['default'] ?? false ) ) {
			self::$default_provider = $id;
		}
	}

	/** @return array<string,array<string,mixed>> */
	public static function providers(): array {
		return array_map(
			static fn( array $provider ): array => $provider['metadata'],
			self::$providers
		);
	}

	public static function default_provider(): string {
		return self::$default_provider;
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public static function invoke( array $input ): array|WP_Error {
		$provider_id = self::requested_provider_id( $input );
		if ( '' === $provider_id ) {
			$provider_id = self::$default_provider;
		}

		if ( '' === $provider_id || ! isset( self::$providers[ $provider_id ] ) ) {
			return new WP_Error(
				'wp_codebox_runtime_provider_unavailable',
				'The requested runtime provider is unavailable.',
				array(
					'status' => 500,
					'provider' => $provider_id,
					'available_providers' => array_keys( self::$providers ),
				)
			);
		}

		$result = call_user_func( self::$providers[ $provider_id ]['callback'], $input );
		if ( is_wp_error( $result ) ) {
			return $result;
		}

		if ( ! is_array( $result ) ) {
			return new WP_Error( 'wp_codebox_runtime_provider_invalid_result', 'The runtime provider returned an invalid result.', array( 'status' => 500, 'provider' => $provider_id ) );
		}

		$result['runtime_provider'] = self::$providers[ $provider_id ]['metadata'];
		return $result;
	}

	/** @param array<string,mixed> $input Ability input. */
	private static function requested_provider_id( array $input ): string {
		foreach ( array( 'runtime_provider', 'runtime_provider_id' ) as $field ) {
			$value = $input[ $field ] ?? null;
			if ( is_array( $value ) ) {
				$value = $value['id'] ?? $value['provider'] ?? '';
			}
			$id = self::normalize_provider_id( is_string( $value ) ? $value : '' );
			if ( '' !== $id ) {
				return $id;
			}
		}

		return '';
	}

	private static function normalize_provider_id( string $id ): string {
		$id = strtolower( trim( $id ) );
		return preg_replace( '/[^a-z0-9_-]+/', '-', $id ) ?? '';
	}

	/** @param array<string,mixed> $metadata Provider metadata. @return array<string,mixed> */
	private static function public_metadata( string $id, array $metadata ): array {
		return array_filter(
			array(
				'id' => $id,
				'label' => is_string( $metadata['label'] ?? null ) ? $metadata['label'] : $id,
				'kind' => is_string( $metadata['kind'] ?? null ) ? $metadata['kind'] : 'adapter',
				'capabilities' => is_array( $metadata['capabilities'] ?? null ) ? array_values( $metadata['capabilities'] ) : array(),
			),
			static fn( mixed $value ): bool => array() !== $value && '' !== $value
		);
	}
}
