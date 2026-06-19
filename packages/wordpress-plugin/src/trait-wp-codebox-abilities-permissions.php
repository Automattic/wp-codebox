<?php
/**
 * WP_Codebox_Abilities_Permissions implementation.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

trait WP_Codebox_Abilities_Permissions {
public static function can_run_agent_task(): bool {
	$allowed = current_user_can( 'manage_options' );

	return (bool) apply_filters( 'wp_codebox_can_run_agent_task', $allowed );
}

/** @param mixed $input Ability input or request-like object. */
public static function can_create_browser_playground_session( mixed $input = null ): bool {
	$allowed          = current_user_can( 'manage_options' );
	$filtered_allowed = (bool) apply_filters( 'wp_codebox_can_run_agent_task', $allowed );
	if ( $filtered_allowed ) {
		return true;
	}

	if ( $allowed ) {
		return false;
	}

	$input = self::permission_input_array( $input );
	if ( empty( $input ) ) {
		return false;
	}

	$authorization = self::trusted_orchestrator_authorization( $input, self::BROWSER_SESSION_CREATE_SCOPE );

	return true === ( $authorization['authorized'] ?? false );
}

/** @param mixed $input Ability input or request-like object. */
public static function can_persist_browser_artifact( mixed $input = null ): bool {
	if ( current_user_can( 'manage_options' ) ) {
		return true;
	}

	$input = self::permission_input_array( $input );
	if ( empty( $input ) ) {
		return false;
	}

	$authorization = self::trusted_orchestrator_authorization( $input, self::BROWSER_ARTIFACT_WRITE_SCOPE );

	return true === ( $authorization['authorized'] ?? false );
}

/** @param mixed $input Ability input or request-like object. */
public static function can_request_browser_connector( mixed $input = null ): bool {
	if ( current_user_can( 'manage_options' ) ) {
		return true;
	}

	$input = self::permission_input_array( $input );
	if ( empty( $input ) ) {
		return false;
	}

	$authorization = self::trusted_orchestrator_authorization( $input, self::BROWSER_CONNECTOR_REQUEST_SCOPE );

	return true === ( $authorization['authorized'] ?? false );
}

/** @param mixed $input Ability input or request-like object. @return array<string,mixed> */
private static function permission_input_array( mixed $input ): array {
	if ( is_array( $input ) ) {
		return $input;
	}

	if ( is_object( $input ) && is_callable( array( $input, 'get_json_params' ) ) ) {
		$params = $input->get_json_params();
		return is_array( $params ) ? $params : array();
	}

	if ( is_object( $input ) && is_callable( array( $input, 'get_params' ) ) ) {
		$params = $input->get_params();
		return is_array( $params ) ? $params : array();
	}

	return array();
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed> */
private static function browser_session_authorization( array $input ): array {
	return self::trusted_orchestrator_authorization( $input, self::BROWSER_SESSION_CREATE_SCOPE );
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed> */
private static function trusted_orchestrator_authorization( array $input, string $required_scope ): array {
	$authorization = is_array( $input['authorization'] ?? null ) ? $input['authorization'] : array();
	$caller        = trim( (string) ( $authorization['caller'] ?? '' ) );
	$scope         = trim( (string) ( $authorization['scope'] ?? '' ) );
	$result        = array_filter(
		array(
			'schema'     => 'wp-codebox/trusted-orchestrator-authorization/v1',
			'caller'     => $caller,
			'scope'      => $scope,
			'authorized' => false,
			'method'     => 'trusted-orchestrator',
			'reason'     => 'missing-authorization',
		),
		static fn( mixed $value ): bool => '' !== $value
	);

	if ( '' === $caller ) {
		return $result;
	}

	if ( $required_scope !== $scope ) {
		$result['reason'] = 'missing-scope';
		return $result;
	}

	/**
	 * Filters trusted browser-session callers.
	 *
	 * Return either a map of caller ids to scopes, or a list of grant arrays:
	 * [ 'browser-client' => [ 'browser-session:create' ] ]
	 * [ [ 'caller' => 'browser-client', 'scopes' => [ 'browser-session:create' ] ] ]
	 *
	 * @param array<int|string,mixed> $trusted_callers Trusted caller grants.
	 * @param array<string,mixed>     $authorization   Explicit caller authorization payload.
	 * @param array<string,mixed>     $input           Ability input.
	 */
	$trusted_callers = apply_filters( 'wp_codebox_trusted_browser_session_callers', array(), $authorization, $input );
	$trusted_callers = is_array( $trusted_callers ) ? $trusted_callers : array();

	if ( self::trusted_browser_session_caller_has_scope( $trusted_callers, $caller, $scope ) ) {
		$result['authorized'] = true;
		$result['reason']     = 'trusted-caller-grant';
		return $result;
	}

	$result['reason'] = 'caller-not-trusted';

	return $result;
}

/** @param array<int|string,mixed> $trusted_callers Trusted caller grants. */
private static function trusted_browser_session_caller_has_scope( array $trusted_callers, string $caller, string $scope ): bool {
	foreach ( $trusted_callers as $key => $grant ) {
		if ( is_string( $key ) && $caller === $key ) {
			$scopes = is_array( $grant ) ? $grant : array( $grant );
			return in_array( $scope, array_map( 'strval', $scopes ), true );
		}

		if ( ! is_array( $grant ) || $caller !== (string) ( $grant['caller'] ?? '' ) ) {
			continue;
		}

		$scopes = is_array( $grant['scopes'] ?? null ) ? $grant['scopes'] : array( $grant['scope'] ?? '' );
		if ( in_array( $scope, array_map( 'strval', $scopes ), true ) ) {
			return true;
		}
	}

	return false;
}
}
