<?php
/**
 * WP_Codebox_Abilities_Browser_Connectors implementation.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

trait WP_Codebox_Abilities_Browser_Connectors {
	/** @return array<string,mixed> */
	private static function browser_connector_request_schema(): array {
		return array(
			'type'       => 'object',
			'required'   => array( 'connector', 'operation' ),
			'properties' => array(
				'schema'       => array( 'type' => 'string', 'const' => 'wp-codebox/browser-connector-request/v1' ),
				'connector'    => array( 'type' => 'string' ),
				'provider'     => array( 'type' => 'string' ),
				'model'        => array( 'type' => 'string' ),
				'operation'    => array( 'type' => 'string' ),
				'payload'      => array( 'type' => 'object' ),
				'session'      => array( 'type' => 'object' ),
				'context'      => array( 'type' => 'object' ),
				'authorization' => self::trusted_orchestrator_authorization_schema( self::BROWSER_CONNECTOR_REQUEST_SCOPE, 'Explicit trusted orchestrator authorization for browser connector requests. Callers must provide a caller id and the browser-connector:request scope; sites grant trust through wp_codebox_trusted_browser_session_callers.' ),
			),
		);
	}

	/** @return array<string,mixed> */
	private static function browser_connector_response_schema(): array {
		return array(
			'type'       => 'object',
			'properties' => array(
				'success'     => array( 'type' => 'boolean' ),
				'schema'      => array( 'type' => 'string', 'const' => 'wp-codebox/browser-connector-response/v1' ),
				'status'      => array( 'type' => 'string' ),
				'connector'   => array( 'type' => 'string' ),
				'provider'    => array( 'type' => 'string' ),
				'model'       => array( 'type' => 'string' ),
				'operation'   => array( 'type' => 'string' ),
				'response'    => array( 'type' => 'object' ),
				'error'       => array( 'type' => 'object' ),
				'credentials' => array( 'type' => 'object' ),
				'audit'       => array( 'type' => 'object' ),
			),
		);
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public static function browser_connector_request( array $input ): array|WP_Error {
		$connector_name = trim( (string) ( $input['connector'] ?? '' ) );
		$operation      = trim( (string) ( $input['operation'] ?? '' ) );
		if ( '' === $connector_name || '' === $operation ) {
			return new WP_Error( 'wp_codebox_browser_connector_request_invalid', 'Browser connector requests require connector and operation.', array( 'status' => 400, 'schema' => 'wp-codebox/browser-connector-response/v1' ) );
		}

		$inheritance_payload = WP_Codebox_Inheritance::resolution_payload( array_merge( $input, array( 'inherit' => array( 'connectors' => array( $connector_name ) ) ) ), static fn( string $path ): string => self::browser_clean_path( $path ) );
		$raw_resolution      = array_values( array_filter( is_array( $inheritance_payload['resolution']['connectors'] ?? null ) ? $inheritance_payload['resolution']['connectors'] : array(), 'is_array' ) );
		$credential_error    = self::browser_connector_credentials_error( $inheritance_payload['inheritance'] );
		if ( null !== $credential_error ) {
			$error_data       = $credential_error->get_error_data();
			$error_connectors = is_array( $error_data['connectors'] ?? null ) ? $error_data['connectors'] : array();
			$error_connector  = is_array( $error_connectors[0] ?? null ) ? $error_connectors[0] : array();
			return self::browser_connector_error_response( $input, $connector_name, $operation, $credential_error, $error_connector );
		}

		$connector = WP_Codebox_Inheritance::resolved_connector( $inheritance_payload['inheritance']['connectors'] ?? array(), $connector_name );
		if ( empty( $connector ) || 'resolved' !== (string) ( $connector['status'] ?? '' ) ) {
			return self::browser_connector_error_response( $input, $connector_name, $operation, new WP_Error( 'wp_codebox_browser_connector_unresolved', 'Requested browser connector is not available for this scope.', array( 'status' => 403 ) ) );
		}

		$provider = trim( (string) ( $input['provider'] ?? $connector['provider'] ?? '' ) );
		$model    = trim( (string) ( $input['model'] ?? $connector['model'] ?? '' ) );
		if ( '' !== trim( (string) ( $connector['provider'] ?? '' ) ) && '' !== $provider && $provider !== (string) $connector['provider'] ) {
			return self::browser_connector_error_response( $input, $connector_name, $operation, new WP_Error( 'wp_codebox_browser_connector_provider_mismatch', 'Browser connector request provider does not match the resolved connector provider.', array( 'status' => 403 ) ) );
		}
		if ( '' !== trim( (string) ( $connector['model'] ?? '' ) ) && '' !== $model && $model !== (string) $connector['model'] ) {
			return self::browser_connector_error_response( $input, $connector_name, $operation, new WP_Error( 'wp_codebox_browser_connector_model_mismatch', 'Browser connector request model does not match the resolved connector model.', array( 'status' => 403 ) ) );
		}

		$credential_values = self::browser_connector_secret_values( $connector, $raw_resolution );
		if ( empty( $credential_values ) ) {
			return self::browser_connector_error_response( $input, $connector_name, $operation, new WP_Error( 'wp_codebox_browser_connector_credentials_unavailable', 'Requested browser connector credentials are unavailable for this scope.', array( 'status' => 403 ) ) );
		}

		$request = array(
			'schema'      => 'wp-codebox/browser-connector-request/v1',
			'connector'   => $connector_name,
			'provider'    => $provider,
			'model'       => $model,
			'operation'   => $operation,
			'payload'     => is_array( $input['payload'] ?? null ) ? $input['payload'] : array(),
			'session'     => is_array( $input['session'] ?? null ) ? $input['session'] : array(),
			'context'     => is_array( $input['context'] ?? null ) ? $input['context'] : array(),
			'credentials' => $credential_values,
			'audit'       => self::browser_connector_audit( $input, $connector, $operation ),
		);

		$response = apply_filters( 'wp_codebox_browser_connector_request', null, $request, $input );
		if ( null === $response ) {
			return self::browser_connector_error_response( $input, $connector_name, $operation, new WP_Error( 'wp_codebox_browser_connector_handler_missing', 'No browser connector request handler is registered.', array( 'status' => 501 ) ), $connector );
		}

		return self::sanitize_browser_connector_response( $response, $connector, $operation, $input );
	}

	/** @param array<string,mixed> $connector Resolved connector. @return array<string,string> */
	private static function browser_connector_secret_values( array $connector, array $raw_connectors ): array {
		$values = array();
		foreach ( $raw_connectors as $raw_connector ) {
			if ( (string) ( $connector['name'] ?? '' ) === (string) ( $raw_connector['name'] ?? '' ) ) {
				$values = is_array( $raw_connector['secret_env_values'] ?? null ) ? $raw_connector['secret_env_values'] : ( is_array( $raw_connector['secretEnvValues'] ?? null ) ? $raw_connector['secretEnvValues'] : array() );
				break;
			}
		}
		$allowed = self::browser_inheritance_secret_env_names( array( 'connectors' => array( $connector ), 'settings' => array() ) );
		$secrets = array();
		foreach ( $allowed as $name ) {
			if ( isset( $values[ $name ] ) && '' !== (string) $values[ $name ] ) {
				$secrets[ $name ] = (string) $values[ $name ];
			}
		}

		return $secrets;
	}

	/** @param array<string,mixed> $input Ability input. @param array<string,mixed> $connector Resolved connector. @return array<string,mixed> */
	private static function browser_connector_audit( array $input, array $connector, string $operation ): array {
		$credentials = is_array( $connector['credentials'] ?? null ) ? $connector['credentials'] : array();
		return array(
			'schema'              => 'wp-codebox/browser-connector-audit/v1',
			'operation'           => $operation,
			'credential_status'   => (string) ( $credentials['status'] ?? 'missing' ),
			'credential_names'    => self::browser_inheritance_secret_env_names( array( 'connectors' => array( $connector ), 'settings' => array() ) ),
			'authorization'       => self::trusted_orchestrator_authorization( $input, self::BROWSER_CONNECTOR_REQUEST_SCOPE ),
			'secrets_redacted'    => true,
			'generated_by'        => 'wp-codebox/browser-connector-request',
		);
	}

	/** @param array<string,mixed> $input Ability input. @param array<string,mixed> $connector Resolved connector. @return array<string,mixed> */
	private static function browser_connector_error_response( array $input, string $connector_name, string $operation, WP_Error $error, array $connector = array() ): array {
		return array(
			'success'     => false,
			'schema'      => 'wp-codebox/browser-connector-response/v1',
			'status'      => 'failed-closed',
			'connector'   => $connector_name,
			'provider'    => (string) ( $input['provider'] ?? $connector['provider'] ?? '' ),
			'model'       => (string) ( $input['model'] ?? $connector['model'] ?? '' ),
			'operation'   => $operation,
			'credentials' => is_array( $connector['credentials'] ?? null ) ? $connector['credentials'] : array(),
			'error'       => array(
				'code'    => $error->get_error_code(),
				'message' => $error->get_error_message(),
			),
			'audit'       => self::browser_connector_audit( $input, $connector, $operation ),
		);
	}

	/** @param mixed $response Filter response. @param array<string,mixed> $connector Resolved connector. @param array<string,mixed> $input Ability input. @return array<string,mixed> */
	private static function sanitize_browser_connector_response( mixed $response, array $connector, string $operation, array $input ): array {
		$response = is_array( $response ) ? $response : array( 'value' => $response );
		unset( $response['credentials'], $response['secret_env_values'], $response['_secretEnvValues'] );

		return array_filter(
			array(
				'success'     => true,
				'schema'      => 'wp-codebox/browser-connector-response/v1',
				'status'      => 'completed',
				'connector'   => (string) ( $connector['name'] ?? '' ),
				'provider'    => (string) ( $input['provider'] ?? $connector['provider'] ?? '' ),
				'model'       => (string) ( $input['model'] ?? $connector['model'] ?? '' ),
				'operation'   => $operation,
				'response'    => $response,
				'credentials' => is_array( $connector['credentials'] ?? null ) ? $connector['credentials'] : array(),
				'audit'       => self::browser_connector_audit( $input, $connector, $operation ),
			),
			static fn( mixed $value ): bool => array() !== $value && '' !== $value
		);
	}
}
