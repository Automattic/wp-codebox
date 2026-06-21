<?php
/**
 * WP_Codebox_Abilities_Provider_Adapter implementation.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

trait WP_Codebox_Abilities_Provider_Adapter {
	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public static function execute_browser_provider_request( array $input ): array|WP_Error {
		$operation = trim( (string) ( $input['operation'] ?? '' ) );
		if ( '' === $operation ) {
			return new WP_Error( 'wp_codebox_browser_provider_operation_required', 'Browser provider requests must include an operation.', array( 'status' => 400, 'schema' => 'wp-codebox/browser-provider-error/v1' ) );
		}

		$request_payload = is_array( $input['request'] ?? null ) ? $input['request'] : array();
		if ( empty( $request_payload ) ) {
			return new WP_Error( 'wp_codebox_browser_provider_request_required', 'Browser provider requests must include a generic request object.', array( 'status' => 400, 'schema' => 'wp-codebox/browser-provider-error/v1' ) );
		}

		$inheritance_payload = self::browser_inheritance_resolution_payload( $input );
		if ( is_wp_error( $inheritance_payload ) ) {
			return $inheritance_payload;
		}

		$inheritance = $inheritance_payload['inheritance'];
		$raw_connector = self::browser_provider_request_connector_raw( $input, $inheritance );
		$connector   = self::redact_provider_metadata( $raw_connector );
		if ( empty( $connector ) ) {
			return new WP_Error( 'wp_codebox_browser_provider_connector_required', 'Browser provider requests require a resolved connector scope.', array( 'status' => 403, 'schema' => 'wp-codebox/browser-provider-error/v1' ) );
		}

		$adapter_request = array(
			'schema'    => 'wp-codebox/browser-provider-adapter-request/v1',
			'operation' => $operation,
			'provider'  => self::browser_provider( $input, $inheritance ),
			'model'     => self::browser_model( $input, $inheritance ),
			'connector' => $connector,
			'context'   => self::browser_provider_request_context( $input ),
			'request'   => self::redact_provider_metadata( $request_payload ),
		);

		/**
		 * Executes a connector-scoped browser provider request on the parent site.
		 *
		 * Adapters must resolve credentials server-side from the connector/context they
		 * trust. WP Codebox passes only redacted connector provenance and request data;
		 * raw provider credentials must not be returned in the response envelope.
		 *
		 * @param mixed               $response        Adapter response, or null when unhandled.
		 * @param array<string,mixed> $adapter_request Generic redacted provider request.
		 * @param array<string,mixed> $input           Original ability input.
		 */
		$response = apply_filters( 'wp_codebox_browser_provider_request', null, $adapter_request, $input );
		if ( null === $response ) {
			$response = self::default_browser_provider_request( $adapter_request, $raw_connector );
		}

		if ( null === $response ) {
			return new WP_Error( 'wp_codebox_browser_provider_adapter_missing', 'No browser provider adapter handled this connector-scoped request.', array( 'status' => 501, 'schema' => 'wp-codebox/browser-provider-error/v1', 'operation' => $operation, 'provider' => $adapter_request['provider'], 'model' => $adapter_request['model'], 'connector' => $connector ) );
		}

		if ( is_wp_error( $response ) ) {
			return new WP_Error( $response->get_error_code(), $response->get_error_message(), self::redact_provider_metadata( array_merge( array( 'schema' => 'wp-codebox/browser-provider-error/v1' ), is_array( $response->get_error_data() ) ? $response->get_error_data() : array() ) ) );
		}

		if ( ! is_array( $response ) ) {
			return new WP_Error( 'wp_codebox_browser_provider_adapter_invalid_response', 'Browser provider adapters must return an array response envelope or WP_Error.', array( 'status' => 502, 'schema' => 'wp-codebox/browser-provider-error/v1' ) );
		}

		return self::normalize_browser_provider_response( $response, $adapter_request );
	}

	/** @param array<string,mixed> $adapter_request Generic redacted provider request. @return array<string,mixed>|WP_Error|null */
	private static function default_browser_provider_request( array $adapter_request, array $raw_connector ): array|WP_Error|null {
		if ( 'http.request' !== (string) ( $adapter_request['operation'] ?? '' ) ) {
			return null;
		}

		$request = is_array( $adapter_request['request'] ?? null ) ? $adapter_request['request'] : array();
		$uri     = trim( (string) ( $request['uri'] ?? '' ) );
		$scheme  = '' !== $uri ? wp_parse_url( $uri, PHP_URL_SCHEME ) : '';
		if ( 'https' !== $scheme ) {
			return new WP_Error( 'wp_codebox_browser_provider_uri_invalid', 'Browser provider HTTP requests must use HTTPS URLs.', array( 'status' => 400, 'schema' => 'wp-codebox/browser-provider-error/v1' ) );
		}

		$method  = strtoupper( trim( (string) ( $request['method'] ?? 'POST' ) ) );
		$headers = is_array( $request['headers'] ?? null ) ? $request['headers'] : array();
		$headers = array_filter(
			array_map( static fn( mixed $value ): string => is_scalar( $value ) ? (string) $value : '', $headers ),
			static fn( string $value ): bool => '' !== $value
		);
		$authorization_header = (string) ( $headers['Authorization'] ?? $headers['authorization'] ?? '' );
		if ( '' === $authorization_header || str_contains( strtolower( $authorization_header ), '[redacted]' ) ) {
			$secret = self::browser_provider_connector_secret( $raw_connector, (string) ( $adapter_request['provider'] ?? '' ) );
			if ( '' === $secret ) {
				return new WP_Error( 'wp_codebox_browser_provider_secret_unavailable', 'Browser provider request could not resolve connector credentials.', array( 'status' => 403, 'schema' => 'wp-codebox/browser-provider-error/v1' ) );
			}

			unset( $headers['authorization'] );
			$headers['Authorization'] = 'Bearer ' . $secret;
		}

		$body = null;
		if ( array_key_exists( 'body', $request ) ) {
			if ( is_scalar( $request['body'] ) ) {
				$body = (string) $request['body'];
				$trimmed_body = trim( $body );
				if ( str_starts_with( $trimmed_body, '{' ) || str_starts_with( $trimmed_body, '[' ) ) {
					foreach ( array_keys( $headers ) as $header_name ) {
						if ( 'content-type' === strtolower( (string) $header_name ) ) {
							unset( $headers[ $header_name ] );
						}
					}
					$headers['Content-Type'] = 'application/json';
				}
			} elseif ( is_array( $request['body'] ) ) {
				$encoded_body = wp_json_encode( $request['body'] );
				if ( false === $encoded_body ) {
					return new WP_Error( 'wp_codebox_browser_provider_body_invalid', 'Browser provider HTTP request body could not be encoded as JSON.', array( 'status' => 400, 'schema' => 'wp-codebox/browser-provider-error/v1' ) );
				}

				$body = $encoded_body;
				foreach ( array_keys( $headers ) as $header_name ) {
					if ( 'content-type' === strtolower( (string) $header_name ) ) {
						unset( $headers[ $header_name ] );
					}
				}
				$headers['Content-Type'] = 'application/json';
			}
		}

		$response = wp_remote_request( $uri, array(
			'method'      => in_array( $method, array( 'GET', 'POST', 'PUT', 'PATCH', 'DELETE' ), true ) ? $method : 'POST',
			'headers'     => $headers,
			'body'        => $body,
			'timeout'     => 120,
			'redirection' => 0,
		) );

		if ( is_wp_error( $response ) ) {
			return new WP_Error( $response->get_error_code(), $response->get_error_message(), array( 'status' => 502, 'schema' => 'wp-codebox/browser-provider-error/v1' ) );
		}

		return array(
			'response' => array(
				'http' => array(
					'status'  => (int) wp_remote_retrieve_response_code( $response ),
					'headers' => wp_remote_retrieve_headers( $response )->getAll(),
					'body'    => (string) wp_remote_retrieve_body( $response ),
				),
			),
		);
	}

	/** @param array<string,mixed> $connector Redacted connector metadata. */
	private static function browser_provider_connector_secret( array $connector, string $provider = '' ): string {
		$names = array();
		foreach ( is_array( $connector['secretEnv'] ?? null ) ? $connector['secretEnv'] : array() as $name ) {
			$names[] = (string) $name;
		}
		$credentials = is_array( $connector['credentials'] ?? null ) ? $connector['credentials'] : array();
		foreach ( is_array( $credentials['secrets'] ?? null ) ? $credentials['secrets'] : array() as $secret ) {
			if ( is_array( $secret ) && 'available' === (string) ( $secret['status'] ?? '' ) ) {
				$names[] = (string) ( $secret['name'] ?? '' );
			}
		}
		$provider_key = strtoupper( preg_replace( '/[^A-Za-z0-9]+/', '_', trim( $provider ) ) );
		if ( '' !== $provider_key ) {
			$names[] = $provider_key . '_API_KEY';
		}

		foreach ( array_values( array_unique( array_filter( $names ) ) ) as $name ) {
			if ( 1 !== preg_match( '/^[A-Z_][A-Z0-9_]*$/', $name ) ) {
				continue;
			}
			$value = getenv( $name );
			if ( is_string( $value ) && '' !== trim( $value ) ) {
				return trim( $value );
			}
		}

		$provider_key = strtolower( preg_replace( '/[^A-Za-z0-9]+/', '_', trim( $provider ) ) );
		if ( '' !== $provider_key && function_exists( 'get_option' ) ) {
			$value = get_option( 'connectors_ai_' . $provider_key . '_api_key', '' );
			if ( is_string( $value ) && '' !== trim( $value ) ) {
				return trim( $value );
			}
		}

		return '';
	}

	/** @param array<string,mixed> $input Ability input. @param array{connectors:array<int,array<string,mixed>>,settings:array<int,array<string,mixed>>} $inheritance @return array<string,mixed> */
	private static function browser_provider_request_connector( array $input, array $inheritance ): array {
		return self::redact_provider_metadata( self::browser_provider_request_connector_raw( $input, $inheritance ) );
	}

	/** @param array<string,mixed> $input Ability input. @param array{connectors:array<int,array<string,mixed>>,settings:array<int,array<string,mixed>>} $inheritance @return array<string,mixed> */
	private static function browser_provider_request_connector_raw( array $input, array $inheritance ): array {
		$requested_name = trim( (string) ( $input['connector'] ?? '' ) );
		foreach ( $inheritance['connectors'] as $connector ) {
			$name = trim( (string) ( $connector['name'] ?? '' ) );
			if ( '' === $name ) {
				continue;
			}

			if ( '' !== $requested_name && $name !== $requested_name ) {
				continue;
			}

			return $connector;
		}

		return array();
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed> */
	private static function browser_provider_request_context( array $input ): array {
		$authorization = self::browser_session_authorization( $input );
		$context       = array_filter(
			array(
				'session_id'         => trim( (string) ( $input['sandbox_session_id'] ?? $input['session_id'] ?? '' ) ),
				'caller_session_id'  => trim( (string) ( $input['caller_session_id'] ?? '' ) ),
				'job_id'             => trim( (string) ( $input['job_id'] ?? '' ) ),
				'caller'             => (string) ( $authorization['caller'] ?? '' ),
				'authorization_scope' => (string) ( $authorization['scope'] ?? '' ),
				'orchestrator'       => is_array( $input['orchestrator'] ?? null ) ? $input['orchestrator'] : array(),
			),
			static fn( mixed $value ): bool => '' !== $value && array() !== $value
		);

		return self::redact_provider_metadata( $context );
	}

	/** @param array<string,mixed> $response Adapter response. @param array<string,mixed> $adapter_request Adapter request. @return array<string,mixed> */
	private static function normalize_browser_provider_response( array $response, array $adapter_request ): array {
		$redacted_response = self::redact_provider_metadata( $response );

		return array_filter(
			array(
				'success'   => true,
				'schema'    => 'wp-codebox/browser-provider-adapter-response/v1',
				'operation' => $adapter_request['operation'],
				'provider'  => $adapter_request['provider'],
				'model'     => $adapter_request['model'],
				'connector' => is_array( $adapter_request['connector'] ?? null ) ? $adapter_request['connector'] : array(),
				'response'  => is_array( $redacted_response['response'] ?? null ) ? $redacted_response['response'] : $redacted_response,
				'audit'     => array(
					'schema'    => 'wp-codebox/browser-provider-audit/v1',
					'operation' => $adapter_request['operation'],
					'provider'  => $adapter_request['provider'],
					'model'     => $adapter_request['model'],
					'connector' => is_array( $adapter_request['connector'] ?? null ) ? $adapter_request['connector'] : array(),
					'request'   => is_array( $adapter_request['request'] ?? null ) ? $adapter_request['request'] : array(),
					'response'  => $redacted_response,
				),
			),
			static fn( mixed $value ): bool => '' !== $value && array() !== $value
		);
	}

	private static function redact_provider_metadata( mixed $value ): mixed {
		if ( ! is_array( $value ) ) {
			return $value;
		}

		$redacted = array();
		foreach ( $value as $key => $item ) {
			$normalized_key = strtolower( (string) $key );
			if ( self::is_sensitive_provider_metadata_key( $normalized_key ) ) {
				$redacted[ $key ] = '[redacted]';
				continue;
			}

			$redacted[ $key ] = self::redact_provider_metadata( $item );
		}

		return $redacted;
	}

	private static function is_sensitive_provider_metadata_key( string $key ): bool {
		if ( in_array( $key, array( 'authorization', 'key', 'value' ), true ) ) {
			return true;
		}

		foreach ( array( 'secret', 'token', 'password', 'credential', 'private_key', 'api_key' ) as $needle ) {
			if ( str_contains( $key, $needle ) ) {
				return true;
			}
		}

		return false;
	}
}
