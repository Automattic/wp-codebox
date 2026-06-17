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
		$connector   = self::browser_provider_request_connector( $input, $inheritance );
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

	/** @param array<string,mixed> $input Ability input. @param array{connectors:array<int,array<string,mixed>>,settings:array<int,array<string,mixed>>} $inheritance @return array<string,mixed> */
	private static function browser_provider_request_connector( array $input, array $inheritance ): array {
		$requested_name = trim( (string) ( $input['connector'] ?? '' ) );
		foreach ( $inheritance['connectors'] as $connector ) {
			$name = trim( (string) ( $connector['name'] ?? '' ) );
			if ( '' === $name ) {
				continue;
			}

			if ( '' !== $requested_name && $name !== $requested_name ) {
				continue;
			}

			return self::redact_provider_metadata( $connector );
		}

		return array();
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed> */
	private static function browser_provider_request_context( array $input ): array {
		$authorization = self::trusted_orchestrator_authorization( $input, self::BROWSER_CONNECTOR_REQUEST_SCOPE );
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
		return WP_Codebox_Redaction_Policy::redact_array( 'provider_proxy', $value );
	}
}
