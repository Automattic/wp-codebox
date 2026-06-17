<?php
/**
 * WP_Codebox_Abilities_Browser_Callbacks implementation.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

trait WP_Codebox_Abilities_Browser_Callbacks {
	/** @param WP_REST_Request $request REST request. @return array<string,mixed>|WP_Error */
	public static function rest_browser_callback( WP_REST_Request $request ): array|WP_Error {
		$capability_id = sanitize_key( (string) $request->get_param( 'capability' ) );
		$capability    = self::browser_callback_capability( $capability_id );
		if ( is_wp_error( $capability ) ) {
			return $capability;
		}

		$signature = self::browser_callback_signature_header( $request, (string) ( $capability['signature_header'] ?? 'x-wp-codebox-callback-signature' ) );
		$timestamp = self::browser_callback_signature_header( $request, (string) ( $capability['timestamp_header'] ?? 'x-wp-codebox-callback-timestamp' ) );
		$secret    = self::browser_callback_secret( $capability, $request );
		if ( is_wp_error( $secret ) ) {
			return $secret;
		}

		$verification = self::verify_browser_callback_signature( $request->get_body(), $secret, $signature, $timestamp, (int) ( $capability['max_age_seconds'] ?? 300 ) );
		if ( is_wp_error( $verification ) ) {
			return $verification;
		}

		$input = $request->get_json_params();
		if ( ! is_array( $input ) ) {
			return new WP_Error( 'wp_codebox_browser_callback_payload_invalid', 'Browser callbacks must send a JSON object.', array( 'status' => 400 ) );
		}

		if ( is_array( $capability['authorization'] ?? null ) && ! is_array( $input['authorization'] ?? null ) ) {
			$input['authorization'] = $capability['authorization'];
		}

		$result = self::execute_browser_callback_capability( $capability, $input );
		if ( is_wp_error( $result ) ) {
			return $result;
		}

		return self::browser_callback_result_envelope( $capability_id, (string) $capability['ability'], $result );
	}

	/** @param mixed $result Existing pre-dispatch result. */
	public static function rest_handle_browser_callback_cors_preflight( mixed $result, WP_REST_Server $server, WP_REST_Request $request ): mixed {
		unset( $server );

		if ( 'OPTIONS' !== $request->get_method() || ! self::is_browser_callback_route( $request ) ) {
			return $result;
		}

		$response = new WP_REST_Response( null, 204 );
		self::add_browser_callback_cors_headers( $response, $request );
		return $response;
	}

	/** @param bool $served Whether the request has already been served. */
	public static function rest_send_browser_callback_cors_headers( bool $served, mixed $result, WP_REST_Request $request, WP_REST_Server $server ): bool {
		unset( $result, $server );

		if ( self::is_browser_callback_route( $request ) ) {
			self::send_browser_callback_cors_headers( $request );
		}

		return $served;
	}

	private static function is_browser_callback_route( WP_REST_Request $request ): bool {
		return str_starts_with( $request->get_route(), '/wp-codebox/v1/browser-callback/' );
	}

	/** @return array<string,mixed>|WP_Error */
	private static function browser_callback_capability( string $capability_id ): array|WP_Error {
		if ( '' === $capability_id ) {
			return new WP_Error( 'wp_codebox_browser_callback_capability_missing', 'Browser callback capability is required.', array( 'status' => 400 ) );
		}

		/**
		 * Filters browser callback capabilities.
		 *
		 * Products register named callbacks without adding product projections to Codebox.
		 * Each capability should provide ability, caller, secret, and optional scope/origins.
		 *
		 * @param array<string,array<string,mixed>> $capabilities Browser callback capabilities keyed by id.
		 */
		$capabilities = apply_filters( 'wp_codebox_browser_callback_capabilities', array() );
		$capabilities = is_array( $capabilities ) ? $capabilities : array();
		$capability   = is_array( $capabilities[ $capability_id ] ?? null ) ? $capabilities[ $capability_id ] : array();
		if ( empty( $capability ) ) {
			return new WP_Error( 'wp_codebox_browser_callback_capability_unknown', 'Browser callback capability is not registered.', array( 'status' => 404, 'capability' => $capability_id ) );
		}

		$ability = trim( (string) ( $capability['ability'] ?? '' ) );
		$caller  = trim( (string) ( $capability['caller'] ?? '' ) );
		$scope   = trim( (string) ( $capability['scope'] ?? self::BROWSER_ARTIFACT_WRITE_SCOPE ) );
		if ( '' === $ability || '' === $caller || '' === $scope ) {
			return new WP_Error( 'wp_codebox_browser_callback_capability_invalid', 'Browser callback capabilities must include ability, caller, and scope.', array( 'status' => 500, 'capability' => $capability_id ) );
		}

		$origins = is_array( $capability['allowed_origins'] ?? null ) ? array_values( array_map( 'strval', $capability['allowed_origins'] ) ) : array( 'https://playground.wordpress.net' );

		return array(
			'schema'            => 'wp-codebox/browser-callback-capability/v1',
			'capability'        => $capability_id,
			'ability'           => $ability,
			'authorization'    => array(
				'schema' => 'wp-codebox/trusted-orchestrator-authorization/v1',
				'caller' => $caller,
				'scope'  => $scope,
			),
			'allowed_origins'   => self::normalize_browser_callback_origins( $origins ),
			'signature_header'  => strtolower( trim( (string) ( $capability['signature_header'] ?? 'x-wp-codebox-callback-signature' ) ) ),
			'timestamp_header'  => strtolower( trim( (string) ( $capability['timestamp_header'] ?? 'x-wp-codebox-callback-timestamp' ) ) ),
			'max_age_seconds'   => max( 0, (int) ( $capability['max_age_seconds'] ?? 300 ) ),
			'secret'            => $capability['secret'] ?? '',
			'secret_callback'   => $capability['secret_callback'] ?? null,
		);
	}

	/** @param array<string,mixed> $capability Browser callback capability. */
	private static function browser_callback_secret( array $capability, WP_REST_Request $request ): string|WP_Error {
		$callback = $capability['secret_callback'] ?? null;
		$secret   = is_callable( $callback ) ? (string) call_user_func( $callback, $request, $capability ) : (string) ( $capability['secret'] ?? '' );
		$secret   = trim( $secret );
		if ( '' === $secret ) {
			return new WP_Error( 'wp_codebox_browser_callback_secret_missing', 'Browser callback capability secret is not configured.', array( 'status' => 500, 'capability' => $capability['capability'] ?? '' ) );
		}

		return $secret;
	}

	private static function verify_browser_callback_signature( string $body, string $secret, string $signature, string $timestamp, int $max_age_seconds ): true|WP_Error {
		if ( '' === trim( $signature ) ) {
			return new WP_Error( 'wp_codebox_browser_callback_signature_missing', 'Browser callback signature is required.', array( 'status' => 401 ) );
		}

		if ( $max_age_seconds > 0 && '' === trim( $timestamp ) ) {
			return new WP_Error( 'wp_codebox_browser_callback_timestamp_missing', 'Browser callback signature timestamp is required.', array( 'status' => 401 ) );
		}

		if ( '' !== trim( $timestamp ) && $max_age_seconds > 0 ) {
			$timestamp_seconds = strtotime( $timestamp );
			if ( false === $timestamp_seconds || abs( time() - $timestamp_seconds ) > $max_age_seconds ) {
				return new WP_Error( 'wp_codebox_browser_callback_signature_expired', 'Browser callback signature timestamp is outside the allowed window.', array( 'status' => 401 ) );
			}
		}

		$signed_payload = '' === trim( $timestamp ) ? $body : trim( $timestamp ) . '.' . $body;
		$expected       = 'sha256=' . hash_hmac( 'sha256', $signed_payload, $secret );
		if ( ! hash_equals( $expected, trim( $signature ) ) ) {
			return new WP_Error( 'wp_codebox_browser_callback_signature_invalid', 'Browser callback signature is invalid.', array( 'status' => 401 ) );
		}

		return true;
	}

	/** @param array<string,mixed> $capability Browser callback capability. @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	private static function execute_browser_callback_capability( array $capability, array $input ): array|WP_Error {
		$ability_name = (string) $capability['ability'];
		if ( 'wp-codebox/persist-browser-artifact' === $ability_name ) {
			return self::persist_browser_artifact( $input );
		}

		if ( ! function_exists( 'wp_get_ability' ) ) {
			return new WP_Error( 'wp_codebox_abilities_unavailable', 'The WordPress Abilities API is not available on this site.', array( 'status' => 501 ) );
		}

		$ability = wp_get_ability( $ability_name );
		if ( ! $ability instanceof WP_Ability ) {
			return new WP_Error( 'wp_codebox_browser_callback_ability_unavailable', 'The browser callback ability is not registered.', array( 'status' => 501, 'ability' => $ability_name ) );
		}

		$result = $ability->execute( $input );
		return is_wp_error( $result ) ? $result : ( is_array( $result ) ? $result : array( 'result' => $result ) );
	}

	/** @param array<string,mixed> $result Ability result. @return array<string,mixed> */
	private static function browser_callback_result_envelope( string $capability, string $ability, array $result ): array {
		$materialization = self::materialization_result_envelope( $ability, $result );

		return array(
			'schema'        => 'wp-codebox/browser-callback-result/v1',
			'success'       => true,
			'capability'    => $capability,
			'ability'       => $ability,
			'result'        => $result,
			'materialization' => $materialization,
			'artifact_refs' => self::browser_callback_artifact_refs( $result ),
		);
	}

	/** @param array<string,mixed> $result Ability result. @return array<string,mixed> */
	private static function materialization_result_envelope( string $task, array $result ): array {
		return array(
			'schema'  => 'wp-codebox/materialization-result/v1',
			'success' => true,
			'task'    => $task,
			'result'  => $result,
			'report'  => null,
			'response' => array(
				'success' => true,
				'task'    => $task,
				'result'  => $result,
			),
			'codebox_materialization' => $result,
		);
	}

	/** @param array<string,mixed> $result Ability result. @return array<int,array<string,mixed>> */
	private static function browser_callback_artifact_refs( array $result ): array {
		$refs         = array();
		$artifact_ref = is_array( $result['artifact_ref'] ?? null ) ? $result['artifact_ref'] : ( is_array( $result['persisted_bundle']['artifact_ref'] ?? null ) ? $result['persisted_bundle']['artifact_ref'] : array() );
		if ( ! empty( $artifact_ref ) ) {
			$refs[] = self::strip_empty_browser_callback_ref(
				array(
					'kind'   => 'artifact-bundle',
					'id'     => (string) ( $artifact_ref['artifact_id'] ?? '' ),
					'path'   => (string) ( $artifact_ref['artifacts_path'] ?? '' ),
					'digest' => self::browser_callback_digest( $artifact_ref['content_digest'] ?? null ),
				)
			);
		}

		$files = is_array( $result['persisted_bundle']['files'] ?? null ) ? $result['persisted_bundle']['files'] : array();
		foreach ( $files as $file ) {
			if ( ! is_array( $file ) ) {
				continue;
			}
			$refs[] = self::strip_empty_browser_callback_ref(
				array(
					'kind'   => (string) ( $file['kind'] ?? 'browser-artifact' ),
					'path'   => (string) ( $file['artifact_path'] ?? $file['path'] ?? '' ),
					'digest' => self::browser_callback_digest( $file['sha256'] ?? null ),
				)
			);
		}

		return array_values( array_filter( $refs ) );
	}

	private static function browser_callback_digest( mixed $input ): ?array {
		if ( is_string( $input ) && '' !== trim( $input ) ) {
			return array( 'algorithm' => 'sha256', 'value' => trim( $input ) );
		}
		if ( is_array( $input ) && '' !== trim( (string) ( $input['value'] ?? '' ) ) ) {
			return array( 'algorithm' => (string) ( $input['algorithm'] ?? 'sha256' ), 'value' => (string) $input['value'] );
		}

		return null;
	}

	/** @param array<string,mixed> $ref Artifact ref. @return array<string,mixed> */
	private static function strip_empty_browser_callback_ref( array $ref ): array {
		return array_filter( $ref, static fn( mixed $value ): bool => null !== $value && '' !== $value && array() !== $value );
	}

	/** @param array<int,string> $origins Raw origins. @return array<int,string> */
	private static function normalize_browser_callback_origins( array $origins ): array {
		$normalized = array();
		foreach ( $origins as $origin ) {
			$parts = wp_parse_url( $origin );
			if ( ! is_array( $parts ) || empty( $parts['scheme'] ) || empty( $parts['host'] ) ) {
				continue;
			}
			$port         = empty( $parts['port'] ) ? '' : ':' . (string) $parts['port'];
			$normalized[] = strtolower( (string) $parts['scheme'] ) . '://' . strtolower( (string) $parts['host'] ) . $port;
		}

		return array_values( array_unique( $normalized ) );
	}

	private static function browser_callback_allowed_origin( WP_REST_Request $request ): string {
		$origin = trim( (string) ( $_SERVER['HTTP_ORIGIN'] ?? '' ) );
		if ( '' === $origin ) {
			return '';
		}

		$capability_id = sanitize_key( (string) $request->get_param( 'capability' ) );
		$capability    = self::browser_callback_capability( $capability_id );
		if ( is_wp_error( $capability ) ) {
			return '';
		}

		$allowed = is_array( $capability['allowed_origins'] ?? null ) ? $capability['allowed_origins'] : array();
		$origin  = self::normalize_browser_callback_origins( array( $origin ) )[0] ?? '';
		return in_array( $origin, $allowed, true ) ? $origin : '';
	}

	private static function send_browser_callback_cors_headers( WP_REST_Request $request ): void {
		$origin = self::browser_callback_allowed_origin( $request );
		if ( '' === $origin ) {
			return;
		}

		header( 'Access-Control-Allow-Origin: ' . $origin );
		header( 'Vary: Origin', false );
		header( 'Access-Control-Allow-Methods: POST, OPTIONS' );
		header( 'Access-Control-Allow-Headers: ' . implode( ', ', self::browser_callback_allowed_headers( $request ) ) );
		header( 'Access-Control-Max-Age: 600' );
	}

	private static function add_browser_callback_cors_headers( WP_REST_Response $response, WP_REST_Request $request ): void {
		$origin = self::browser_callback_allowed_origin( $request );
		if ( '' === $origin ) {
			return;
		}

		$response->header( 'Access-Control-Allow-Origin', $origin );
		$response->header( 'Vary', 'Origin' );
		$response->header( 'Access-Control-Allow-Methods', 'POST, OPTIONS' );
		$response->header( 'Access-Control-Allow-Headers', implode( ', ', self::browser_callback_allowed_headers( $request ) ) );
		$response->header( 'Access-Control-Max-Age', '600' );
	}

	/** @return array<int,string> */
	private static function browser_callback_allowed_headers( WP_REST_Request $request ): array {
		$headers       = array( 'Content-Type', 'X-WP-Codebox-Callback-Signature', 'X-WP-Codebox-Callback-Timestamp' );
		$capability_id = sanitize_key( (string) $request->get_param( 'capability' ) );
		$capability    = self::browser_callback_capability( $capability_id );
		if ( is_wp_error( $capability ) ) {
			return $headers;
		}

		foreach ( array( 'signature_header', 'timestamp_header' ) as $field ) {
			$header = trim( (string) ( $capability[ $field ] ?? '' ) );
			if ( '' !== $header ) {
				$headers[] = $header;
			}
		}

		return array_values( array_unique( $headers ) );
	}

	private static function browser_callback_signature_header( WP_REST_Request $request, string $header ): string {
		$value = $request->get_header( $header );
		return is_string( $value ) ? trim( $value ) : '';
	}
}
