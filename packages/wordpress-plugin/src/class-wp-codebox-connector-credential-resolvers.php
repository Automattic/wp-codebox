<?php
/**
 * Connector credential resolver registry.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_Connector_Credential_Resolvers {

	/** @param array<string,mixed> $resolution Existing inheritance resolution. @param array{connectors:string[],settings:string[]} $request Requested inheritance. @param array<string,mixed> $input Ability input. */
	public static function resolve( array $resolution, array $request, array $input ): array {
		$requested = array_values( array_unique( array_filter( array_map( 'strval', $request['connectors'] ?? array() ) ) ) );
		if ( empty( $requested ) ) {
			return $resolution;
		}

		foreach ( $requested as $connector_name ) {
			$connector = self::default_connector( $connector_name, $input );
			if ( ! empty( $connector ) ) {
				$resolution['connectors'] = self::replace_connector( is_array( $resolution['connectors'] ?? null ) ? $resolution['connectors'] : array(), $connector_name, $connector );
			}
		}

		if ( ! function_exists( 'apply_filters' ) ) {
			return $resolution;
		}

		/**
		 * Registers generic connector credential resolvers.
		 *
		 * Resolver entries may be keyed by connector name. Each resolver can be a
		 * callable returning a connector row, or a spec array with provider, model,
		 * secret_env, secret_values, and secret_sources. Raw secret values are kept
		 * only in secret_env_values for the parent process and are omitted from the
		 * sanitized inheritance payload returned to callers.
		 *
		 * @param array<string,mixed> $resolvers Connector resolver map.
		 * @param array{connectors:string[],settings:string[]} $request Requested inheritance.
		 * @param array<string,mixed> $input Ability input.
		 */
		$resolvers = apply_filters( 'wp_codebox_connector_credential_resolvers', array(), $request, $input );
		if ( ! is_array( $resolvers ) || empty( $resolvers ) ) {
			return $resolution;
		}

		foreach ( $requested as $connector_name ) {
			$connector = self::resolve_connector( $connector_name, $resolvers, $request, $input );
			if ( empty( $connector ) || is_wp_error( $connector ) ) {
				continue;
			}

			$resolution['connectors'] = self::replace_connector( is_array( $resolution['connectors'] ?? null ) ? $resolution['connectors'] : array(), $connector_name, $connector );
		}

		return $resolution;
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed> */
	private static function default_connector( string $connector_name, array $input ): array {
		$provider = sanitize_key( $connector_name );
		if ( '' === $provider || ! self::provider_registered( $provider ) ) {
			return array();
		}

		$connector = array(
			'name'           => $connector_name,
			'status'         => 'resolved',
			'provider'       => $provider,
			'bridge'         => array(
				'schema'         => 'wp-codebox/browser-provider-bridge-connector/v1',
				'authentication' => 'php-ai-client',
				'baseUrls'       => self::provider_base_urls( $provider, $input ),
			),
			'capabilityScope' => array(
				'browser-connector:request',
			),
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

	/** @param array<string,mixed> $input Ability input. @return string[] */
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

		if ( is_object( $registry ) && method_exists( $registry, 'getProviderClassName' ) ) {
			try {
				$class_name = $registry->getProviderClassName( $provider );
				if ( is_string( $class_name ) && class_exists( $class_name ) && method_exists( $class_name, 'baseUrl' ) ) {
					$base_url = new ReflectionMethod( $class_name, 'baseUrl' );
					if ( $base_url->isStatic() && 0 === $base_url->getNumberOfRequiredParameters() ) {
						$base_url->setAccessible( true );
						$candidates[] = $base_url->invoke( null );
					}
				}
			} catch ( Throwable $throwable ) {
				unset( $throwable );
			}
		}

		$provider_config = null;
		foreach ( array( 'getProvider', 'provider' ) as $method ) {
			if ( is_object( $registry ) && method_exists( $registry, $method ) ) {
				try {
					$provider_config = $registry->{$method}( $provider );
					break;
				} catch ( Throwable $throwable ) {
					unset( $throwable );
				}
			}
		}

		foreach ( array( 'getBaseUrl', 'getBaseURL', 'getApiBaseUrl', 'getApiBaseURL', 'baseUrl', 'baseURL', 'apiBaseUrl', 'apiBaseURL' ) as $method ) {
			if ( is_object( $provider_config ) && method_exists( $provider_config, $method ) ) {
				$candidates[] = $provider_config->{$method}();
			}
		}

		foreach ( array( 'base_url', 'baseUrl', 'api_base_url', 'apiBaseUrl' ) as $field ) {
			if ( is_array( $provider_config ) && isset( $provider_config[ $field ] ) ) {
				$candidates[] = $provider_config[ $field ];
			} elseif ( is_object( $provider_config ) && isset( $provider_config->{$field} ) ) {
				$candidates[] = $provider_config->{$field};
			}
		}

		if ( is_array( $input['provider_base_urls'] ?? null ) ) {
			$candidates = array_merge( $candidates, $input['provider_base_urls'] );
		}

		/**
		 * Filters provider base URLs allowed for generic browser provider forwarding.
		 *
		 * Products can add provider-specific endpoints without owning request
		 * forwarding, authentication, or credential transport.
		 *
		 * @param array<int,mixed>     $candidates Candidate base URLs.
		 * @param string              $provider   Provider ID.
		 * @param array<string,mixed> $input      Ability input.
		 */
		if ( function_exists( 'apply_filters' ) ) {
			$candidates = apply_filters( 'wp_codebox_browser_provider_base_urls', $candidates, $provider, $input );
		}

		$base_urls = array();
		foreach ( is_array( $candidates ) ? $candidates : array() as $candidate ) {
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

	/** @param array<string,mixed> $resolvers Resolver registry. @param array{connectors:string[],settings:string[]} $request Requested inheritance. @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error|null */
	private static function resolve_connector( string $connector_name, array $resolvers, array $request, array $input ): array|WP_Error|null {
		$resolver = $resolvers[ $connector_name ] ?? null;
		if ( null === $resolver ) {
			foreach ( $resolvers as $candidate ) {
				if ( is_array( $candidate ) && $connector_name === (string) ( $candidate['name'] ?? $candidate['connector'] ?? $candidate['provider'] ?? '' ) ) {
					$resolver = $candidate;
					break;
				}
			}
		}

		if ( is_callable( $resolver ) ) {
			$resolved = call_user_func( $resolver, $connector_name, $request, $input );
			return is_array( $resolved ) || is_wp_error( $resolved ) ? $resolved : null;
		}

		return is_array( $resolver ) ? self::connector_from_spec( $connector_name, $resolver ) : null;
	}

	/** @param array<string,mixed> $spec Resolver spec. @return array<string,mixed> */
	private static function connector_from_spec( string $connector_name, array $spec ): array {
		$provider = trim( (string) ( $spec['provider'] ?? $connector_name ) );
		$model    = trim( (string) ( $spec['model'] ?? '' ) );
		$secrets  = self::secret_names( $spec['secret_env'] ?? $spec['secretEnv'] ?? array() );
		$values   = self::secret_values( $spec['secret_values'] ?? $spec['secretEnvValues'] ?? $spec['secret_env_values'] ?? array() );
		$sources  = self::secret_values( $spec['secret_sources'] ?? $spec['secretSources'] ?? array() );

		$connector = array(
			'name'        => $connector_name,
			'status'      => 'resolved',
			'provider'    => '' !== $provider ? $provider : $connector_name,
			'credentials' => array(
				'schema'    => 'wp-codebox/connector-credentials/v1',
				'connector' => $connector_name,
				'scope'     => 'connector',
				'status'    => 'available',
				'secrets'   => array(),
			),
		);

		if ( '' !== $model ) {
			$connector['model'] = $model;
		}
		if ( ! empty( $secrets ) ) {
			$connector['secret_env'] = $secrets;
		}

		$secret_values = array();
		foreach ( $secrets as $name ) {
			$available = isset( $values[ $name ] ) && '' !== (string) $values[ $name ];
			if ( $available ) {
				$secret_values[ $name ] = (string) $values[ $name ];
			}

			$connector['credentials']['secrets'][] = array_filter(
				array(
					'name'   => $name,
					'status' => $available ? 'available' : 'missing',
					'scope'  => $provider,
					'source' => $sources[ $name ] ?? '',
				),
				static fn( mixed $value ): bool => '' !== $value
			);
		}

		if ( empty( $secret_values ) && ! empty( $secrets ) ) {
			$connector['credentials']['status'] = 'missing';
		} elseif ( ! empty( $secret_values ) ) {
			$connector['secret_env_values'] = $secret_values;
		}

		return $connector;
	}

	/** @param array<int,mixed> $connectors Existing connectors. @param array<string,mixed> $connector Resolved connector. @return array<int,mixed> */
	private static function replace_connector( array $connectors, string $connector_name, array $connector ): array {
		$connectors = array_values(
			array_filter(
				$connectors,
				static fn( mixed $existing ): bool => ! is_array( $existing ) || $connector_name !== (string) ( $existing['name'] ?? '' )
			)
		);
		$connectors[] = $connector;

		return $connectors;
	}

	/** @return string[] */
	private static function secret_names( mixed $value ): array {
		return array_values( array_unique( array_filter( WP_Codebox_Agent_Task::string_list( $value ), static fn( string $name ): bool => 1 === preg_match( '/^[A-Z_][A-Z0-9_]*$/', $name ) ) ) );
	}

	/** @return array<string,string> */
	private static function secret_values( mixed $value ): array {
		if ( is_callable( $value ) ) {
			$value = call_user_func( $value );
		}
		if ( ! is_array( $value ) ) {
			return array();
		}

		$values = array();
		foreach ( $value as $name => $secret ) {
			$name = (string) $name;
			if ( 1 === preg_match( '/^[A-Z_][A-Z0-9_]*$/', $name ) && is_scalar( $secret ) ) {
				$values[ $name ] = (string) $secret;
			}
		}

		return $values;
	}
}
