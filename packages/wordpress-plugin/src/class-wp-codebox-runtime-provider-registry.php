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

		if ( true === ( $metadata['default'] ?? false ) ) {
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
		return self::configured_default_provider();
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed> */
	public static function resolve_runtime_requirements( array $input ): array {
		$provider_id = self::requested_provider_id( $input );
		if ( '' === $provider_id ) {
			$provider_id = self::configured_default_provider();
		}

		$model            = trim( (string) ( $input['model'] ?? ( is_array( $input['input'] ?? null ) ? ( $input['input']['model'] ?? '' ) : '' ) ) );
		$secret_env       = array_values( array_unique( array_filter( array_map( 'strval', is_array( $input['secret_env'] ?? null ) ? $input['secret_env'] : array() ) ) ) );
		$components       = self::component_slugs( $input );
		$auth_strategies  = WP_Codebox_Browser_Provider_Auth_Strategies::strategies();
		$connector_status = self::connector_status( $input );
		$missing_adapters = $connector_status['missing_adapters'];
		$pending_connectors = $connector_status['pending_connectors'];
		$installable      = array();

		foreach ( $auth_strategies as $strategy ) {
			foreach ( is_array( $strategy['installable_plugins'] ?? null ) ? $strategy['installable_plugins'] : array() as $plugin ) {
				$installable[] = array( 'type' => 'plugin', 'slug' => (string) $plugin, 'source' => (string) ( $strategy['id'] ?? '' ) );
			}
		}

		$provider_available = '' !== $provider_id && isset( self::$providers[ $provider_id ] );
		$pending            = ! empty( $pending_connectors );
		$available          = $provider_available && empty( $missing_adapters ) && ! $pending;

		return array(
			'schema'                   => 'wp-codebox/runtime-requirements-readiness/v1',
			'provider'                 => $provider_available ? self::$providers[ $provider_id ]['metadata'] : ( '' !== $provider_id ? array( 'id' => $provider_id, 'available' => false ) : null ),
			'model'                    => $model,
			'plugins'                  => array_map( static fn( string $slug ): array => array( 'slug' => $slug, 'required' => true ), $components ),
			'components'               => array_map( static fn( string $slug ): array => array( 'slug' => $slug, 'required' => true ), $components ),
			'secret_env'               => $secret_env,
			'provider_auth_strategies' => array_values( $auth_strategies ),
			'availability'             => array(
				'available'          => $available,
				'status'             => $pending ? 'pending' : ( $available ? 'available' : 'unavailable' ),
				'provider_available' => $provider_available,
				'missing_adapters'   => $missing_adapters,
				'pending_connectors' => $pending_connectors,
			),
			'missing_adapters'         => $missing_adapters,
			'pending_connectors'       => $pending_connectors,
			'installable_components'   => array_values( array_unique( $installable, SORT_REGULAR ) ),
		);
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public static function invoke( array $input ): array|WP_Error {
		$provider_id = self::requested_provider_id( $input );
		if ( '' === $provider_id ) {
			$provider_id = self::configured_default_provider();
		}

		if ( '' === $provider_id ) {
			return new WP_Error(
				'wp_codebox_runtime_provider_default_missing',
				'No runtime provider was requested and no default runtime provider is configured.',
				array(
					'status'              => 500,
					'available_providers' => array_keys( self::$providers ),
				)
			);
		}

		if ( ! isset( self::$providers[ $provider_id ] ) ) {
			return new WP_Error(
				'wp_codebox_runtime_provider_unavailable',
				'The requested or configured runtime provider is unavailable.',
				array(
					'status'              => 500,
					'provider'            => $provider_id,
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

	/** @param array<string,mixed> $input @return string[] */
	private static function component_slugs( array $input ): array {
		$components = array();
		foreach ( is_array( $input['components'] ?? null ) ? $input['components'] : array() as $component ) {
			$slug = is_array( $component ) ? (string) ( $component['slug'] ?? $component['name'] ?? '' ) : (string) $component;
			$slug = self::normalize_provider_id( $slug );
			if ( '' !== $slug ) {
				$components[] = $slug;
			}
		}

		return array_values( array_unique( $components ) );
	}

	/** @param array<string,mixed> $input @return array{missing_adapters:string[],pending_connectors:string[]} */
	private static function connector_status( array $input ): array {
		$missing            = array();
		$pending_connectors = array();
		foreach ( self::resolved_connectors( $input ) as $connector ) {
			$name   = trim( (string) ( $connector['name'] ?? '' ) );
			$status = trim( (string) ( $connector['status'] ?? '' ) );
			if ( '' !== $name && 'unresolved' === $status ) {
				$pending_connectors[] = $name;
				continue;
			}

			$bridge         = is_array( $connector['bridge'] ?? null ) ? $connector['bridge'] : array();
			$authentication = (string) ( $bridge['authentication'] ?? '' );
			if ( '' !== $authentication && ! WP_Codebox_Browser_Provider_Auth_Strategies::has( $authentication ) ) {
				$missing[] = $authentication;
			}
		}

		return array(
			'missing_adapters'   => array_values( array_unique( $missing ) ),
			'pending_connectors' => array_values( array_unique( $pending_connectors ) ),
		);
	}

	/** @param array<string,mixed> $input @return array<int,array<string,mixed>> */
	private static function resolved_connectors( array $input ): array {
		$inherit    = is_array( $input['inherit'] ?? null ) ? $input['inherit'] : array();
		$connectors = is_array( $inherit['connectors'] ?? null ) ? $inherit['connectors'] : array();
		if ( ! empty( $connectors ) && array_filter( $connectors, 'is_array' ) === $connectors && class_exists( 'WP_Codebox_Inheritance' ) ) {
			return WP_Codebox_Inheritance::sanitize_resolution( array( 'connectors' => $connectors ) )['connectors'];
		}

		if ( class_exists( 'WP_Codebox_Inheritance' ) ) {
			return WP_Codebox_Inheritance::resolution_payload( $input )['inheritance']['connectors'];
		}

		return array();
	}

	private static function configured_default_provider(): string {
		$provider = self::$default_provider;
		if ( function_exists( 'apply_filters' ) ) {
			$provider = (string) apply_filters( 'wp_codebox_default_runtime_provider', $provider );
		}

		return self::normalize_provider_id( $provider );
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
