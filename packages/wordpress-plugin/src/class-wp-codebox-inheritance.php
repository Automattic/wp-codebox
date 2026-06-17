<?php
/**
 * Shared inheritance request and audit normalization.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_Inheritance {
	/** @param array<string,mixed> $input Ability input. @return array{connectors:string[],settings:string[]} */
	public static function request( array $input ): array {
		$inherit = is_array( $input['inherit'] ?? null ) ? $input['inherit'] : array();

		return array(
			'connectors' => self::string_list( $inherit['connectors'] ?? array() ),
			'settings'   => self::string_list( $inherit['settings'] ?? array() ),
		);
	}

	/** @param array<string,mixed> $input Ability input. @return array{request:array{connectors:string[],settings:string[]},resolution:array<string,mixed>} */
	public static function resolve( array $input ): array {
		$request    = self::request( $input );
		$resolution = array(
			'connectors' => array_map(
				static fn( string $name ): array => array(
					'name'   => $name,
					'status' => 'unresolved',
				),
				$request['connectors']
			),
			'settings'   => array_map(
				static fn( string $name ): array => array(
					'name'   => $name,
					'status' => 'unresolved',
				),
				$request['settings']
			),
		);

		if ( function_exists( 'apply_filters' ) && ( ! empty( $request['connectors'] ) || ! empty( $request['settings'] ) ) ) {
			if ( class_exists( 'WP_Codebox_Connector_Credential_Resolvers' ) ) {
				$resolution = WP_Codebox_Connector_Credential_Resolvers::resolve( $resolution, $request, $input );
			}

			$filtered = apply_filters( 'wp_codebox_resolve_inheritance', $resolution, $request, $input );
			if ( is_array( $filtered ) ) {
				$resolution = $filtered;
			}
		}

		return array(
			'request'    => $request,
			'resolution' => $resolution,
		);
	}

	/** @param array<string,mixed> $resolution Raw inheritance resolution. @param callable|null $clean_path Path cleaner. @return array{connectors:array<int,array<string,mixed>>,settings:array<int,array<string,mixed>>} */
	public static function sanitize_resolution( array $resolution, ?callable $clean_path = null ): array {
		return array(
			'connectors' => self::sanitize_connectors( $resolution['connectors'] ?? array(), $clean_path ),
			'settings'   => self::sanitize_settings( $resolution['settings'] ?? array() ),
		);
	}

	/** @param array<string,mixed> $input Ability input. @param callable|null $clean_path Path cleaner. @return array{request:array{connectors:string[],settings:string[]},resolution:array<string,mixed>,inheritance:array{connectors:array<int,array<string,mixed>>,settings:array<int,array<string,mixed>>}} */
	public static function resolution_payload( array $input, ?callable $clean_path = null ): array {
		$resolved = self::resolve( $input );

		return array(
			'request'     => $resolved['request'],
			'resolution'  => $resolved['resolution'],
			'inheritance' => self::sanitize_resolution( $resolved['resolution'], $clean_path ),
		);
	}

	/** @param array<int,mixed> $connectors Inheritance connector rows. @param callable|null $clean_path Path cleaner. @return array<int,array<string,mixed>> */
	public static function sanitize_connectors( array $connectors, ?callable $clean_path = null ): array {
		$sanitized = array();
		foreach ( $connectors as $connector ) {
			if ( ! is_array( $connector ) ) {
				continue;
			}

			$name = trim( (string) ( $connector['name'] ?? '' ) );
			if ( '' === $name ) {
				continue;
			}

			$entry = array(
				'name'   => $name,
				'status' => trim( (string) ( $connector['status'] ?? 'resolved' ) ),
			);
			foreach ( array( 'provider', 'model' ) as $field ) {
				$value = trim( (string) ( $connector[ $field ] ?? '' ) );
				if ( '' !== $value ) {
					$entry[ $field ] = $value;
				}
			}

			$provider_plugin_paths = array_values(
				array_filter(
					array_map(
						static fn( string $path ): string => null !== $clean_path ? (string) $clean_path( $path ) : $path,
						self::string_list( $connector['provider_plugin_paths'] ?? $connector['providerPluginPaths'] ?? array() )
					),
					static fn( string $path ): bool => '' !== $path && is_dir( $path )
				)
			);
			if ( ! empty( $provider_plugin_paths ) ) {
				$entry['providerPluginPaths'] = array_values( array_unique( $provider_plugin_paths ) );
			}

			$secret_env = array_values( array_filter( self::string_list( $connector['secret_env'] ?? $connector['secretEnv'] ?? array() ), static fn( string $name ): bool => 1 === preg_match( '/^[A-Z_][A-Z0-9_]*$/', $name ) ) );
			if ( ! empty( $secret_env ) ) {
				$entry['secretEnv'] = array_values( array_unique( $secret_env ) );
			}

			$credentials = self::sanitize_connector_credentials( $connector['credentials'] ?? null, $name );
			if ( ! empty( $credentials ) ) {
				$entry['credentials'] = $credentials;
			}

			$bridge = self::sanitize_connector_bridge( $connector['bridge'] ?? null );
			if ( ! empty( $bridge ) ) {
				$entry['bridge'] = $bridge;
			}

			$capability_scope = array_values( array_filter( self::string_list( $connector['capability_scope'] ?? $connector['capabilityScope'] ?? array() ) ) );
			if ( ! empty( $capability_scope ) ) {
				$entry['capabilityScope'] = array_values( array_unique( $capability_scope ) );
			}

			$sanitized[] = $entry;
		}

		return $sanitized;
	}

	/** @return array<string,mixed> */
	public static function sanitize_connector_credentials( mixed $credentials, string $connector_name ): array {
		if ( ! is_array( $credentials ) ) {
			return array();
		}

		$status = self::credential_status( (string) ( $credentials['status'] ?? 'missing' ) );
		$entry  = array(
			'schema'    => 'wp-codebox/connector-credentials/v1',
			'connector' => $connector_name,
			'scope'     => 'connector',
			'status'    => $status,
			'secrets'   => array(),
		);
		$reason = self::redacted_reason( $credentials['reason'] ?? '' );
		if ( '' !== $reason ) {
			$entry['reason'] = $reason;
		}

		foreach ( is_array( $credentials['secrets'] ?? null ) ? $credentials['secrets'] : array() as $secret ) {
			if ( ! is_array( $secret ) ) {
				continue;
			}

			$name = trim( (string) ( $secret['name'] ?? '' ) );
			if ( 1 !== preg_match( '/^[A-Z_][A-Z0-9_]*$/', $name ) ) {
				continue;
			}

			$secret_entry = array(
				'name'   => $name,
				'status' => self::credential_status( (string) ( $secret['status'] ?? $status ) ),
			);
			foreach ( array( 'scope', 'source', 'reason' ) as $field ) {
				$value = 'reason' === $field ? self::redacted_reason( $secret[ $field ] ?? '' ) : trim( (string) ( $secret[ $field ] ?? '' ) );
				if ( '' !== $value ) {
					$secret_entry[ $field ] = $value;
				}
			}

			$entry['secrets'][] = $secret_entry;
		}

		return $entry;
	}

	/** @return array<string,mixed> */
	private static function sanitize_connector_bridge( mixed $bridge ): array {
		if ( ! is_array( $bridge ) ) {
			return array();
		}

		$entry = array(
			'schema' => 'wp-codebox/browser-provider-bridge-connector/v1',
		);
		$authentication = trim( (string) ( $bridge['authentication'] ?? '' ) );
		if ( '' !== $authentication ) {
			$entry['authentication'] = $authentication;
		}

		$base_urls = array();
		foreach ( is_array( $bridge['base_urls'] ?? null ) ? $bridge['base_urls'] : ( is_array( $bridge['baseUrls'] ?? null ) ? $bridge['baseUrls'] : array() ) as $candidate ) {
			if ( ! is_scalar( $candidate ) ) {
				continue;
			}

			$base_url = trim( (string) $candidate );
			if ( '' === $base_url || ! in_array( strtolower( (string) wp_parse_url( $base_url, PHP_URL_SCHEME ) ), array( 'http', 'https' ), true ) ) {
				continue;
			}

			$base_urls[] = rtrim( $base_url, '/' ) . '/';
		}

		if ( ! empty( $base_urls ) ) {
			$entry['baseUrls'] = array_values( array_unique( $base_urls ) );
		}

		$timeout = isset( $bridge['timeout'] ) && is_numeric( $bridge['timeout'] ) ? (int) $bridge['timeout'] : 0;
		if ( $timeout > 0 ) {
			$entry['timeout'] = $timeout;
		}

		return $entry;
	}

	/** @param array{connectors:array<int,array<string,mixed>>,settings:array<int,array<string,mixed>>} $inheritance @return string[] */
	public static function secret_env_names( array $inheritance ): array {
		$names = array();
		foreach ( $inheritance['connectors'] as $connector ) {
			$names       = array_merge( $names, self::string_list( $connector['secretEnv'] ?? array() ) );
			$credentials = is_array( $connector['credentials'] ?? null ) ? $connector['credentials'] : array();
			foreach ( is_array( $credentials['secrets'] ?? null ) ? $credentials['secrets'] : array() as $secret ) {
				if ( is_array( $secret ) && 'available' === ( $secret['status'] ?? '' ) ) {
					$names[] = (string) ( $secret['name'] ?? '' );
				}
			}
		}

		return array_values( array_unique( array_filter( $names ) ) );
	}

	/** @param array<int,array<string,mixed>> $connectors Resolved connectors. @return array<string,mixed> */
	public static function resolved_connector( array $connectors, string $connector_name ): array {
		foreach ( $connectors as $connector ) {
			if ( $connector_name === (string) ( $connector['name'] ?? '' ) ) {
				return $connector;
			}
		}

		return array();
	}

	/** @param array{connectors:array<int,array<string,mixed>>,settings:array<int,array<string,mixed>>} $inheritance */
	public static function connector_credentials_error( array $inheritance, string $message ): WP_Error|null {
		$failures = array();
		foreach ( $inheritance['connectors'] as $connector ) {
			$credentials = is_array( $connector['credentials'] ?? null ) ? $connector['credentials'] : array();
			if ( empty( $credentials ) ) {
				continue;
			}

			$status  = (string) ( $credentials['status'] ?? 'missing' );
			$secrets = array_filter( is_array( $credentials['secrets'] ?? null ) ? $credentials['secrets'] : array(), static fn( mixed $secret ): bool => is_array( $secret ) && in_array( (string) ( $secret['status'] ?? '' ), array( 'missing', 'denied' ), true ) );
			if ( in_array( $status, array( 'missing', 'denied' ), true ) || ! empty( $secrets ) ) {
				$failures[] = array(
					'name'        => (string) ( $connector['name'] ?? '' ),
					'status'      => (string) ( $connector['status'] ?? '' ),
					'credentials' => $credentials,
				);
			}
		}

		return empty( $failures ) ? null : new WP_Error( 'wp_codebox_connector_credentials_unavailable', $message, array( 'status' => 403, 'schema' => 'wp-codebox/connector-credential-failure/v1', 'connectors' => $failures ) );
	}

	/** @param array<int,mixed> $settings Inheritance setting rows. @return array<int,array<string,mixed>> */
	public static function sanitize_settings( array $settings ): array {
		$sanitized = array();
		foreach ( $settings as $setting ) {
			if ( ! is_array( $setting ) ) {
				continue;
			}
			$name = trim( (string) ( $setting['name'] ?? '' ) );
			if ( '' === $name ) {
				continue;
			}
			$entry = array(
				'name'   => $name,
				'status' => trim( (string) ( $setting['status'] ?? 'resolved' ) ),
			);
			$scope = trim( (string) ( $setting['scope'] ?? '' ) );
			if ( '' !== $scope ) {
				$entry['scope'] = $scope;
			}
			$sanitized[] = $entry;
		}

		return $sanitized;
	}

	private static function credential_status( string $status ): string {
		return in_array( $status, array( 'available', 'missing', 'denied' ), true ) ? $status : 'missing';
	}

	private static function redacted_reason( mixed $reason ): string {
		$reason = trim( (string) $reason );
		return '' === $reason ? '' : substr( preg_replace( '/[^A-Za-z0-9 .:_-]/', '', $reason ) ?? '', 0, 160 );
	}

	/** @return string[] */
	private static function string_list( mixed $value ): array {
		return WP_Codebox_Agent_Task::string_list( $value );
	}
}
