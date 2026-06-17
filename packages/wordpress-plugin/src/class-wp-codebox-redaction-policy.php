<?php
/**
 * Shared redaction policy profiles for WordPress-side DTOs and proxies.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

class WP_Codebox_Redaction_Policy {
	public const REDACTED_VALUE = '[redacted]';

	/** @return array<string,array{exact_keys:array<int,string>,sensitive_key_tokens:array<int,string>,allowed_keys?:array<int,string>}> */
	private static function profiles(): array {
		return array(
			'audit_metadata'      => array(
				'exact_keys'           => array( 'authorization', 'key', 'value' ),
				'sensitive_key_tokens' => array( 'secret', 'token', 'password', 'credential', 'private_key', 'api_key' ),
			),
			'provider_proxy'      => array(
				'exact_keys'           => array( 'authorization', 'key', 'value' ),
				'sensitive_key_tokens' => array( 'secret', 'token', 'password', 'credential', 'private_key', 'api_key' ),
			),
			'browser_event'       => array(
				'exact_keys'           => array( 'authorization' ),
				'sensitive_key_tokens' => array( 'secret', 'token', 'password', 'credential', 'private_key', 'api_key', 'cookie' ),
			),
			'public_session_dto' => array(
				'exact_keys'           => array(),
				'sensitive_key_tokens' => array( 'secret', 'token', 'password', 'private_key', 'api_key', 'credential' ),
				'allowed_keys'          => array( 'secret_env', 'secretenv', 'secret_env_names' ),
			),
		);
	}

	public static function key_should_redact( string $profile_name, string $key ): bool {
		$profile = self::profiles()[ $profile_name ] ?? null;
		if ( null === $profile ) {
			return false;
		}

		$normalized_key = strtolower( $key );
		if ( in_array( $normalized_key, $profile['allowed_keys'] ?? array(), true ) ) {
			return false;
		}

		if ( in_array( $normalized_key, $profile['exact_keys'], true ) ) {
			return true;
		}

		foreach ( $profile['sensitive_key_tokens'] as $token ) {
			if ( str_contains( $normalized_key, $token ) ) {
				return true;
			}
		}

		return false;
	}

	public static function redact_array( string $profile_name, mixed $value ): mixed {
		if ( ! is_array( $value ) ) {
			return $value;
		}

		$redacted = array();
		foreach ( $value as $key => $item ) {
			if ( self::key_should_redact( $profile_name, (string) $key ) ) {
				$redacted[ $key ] = self::REDACTED_VALUE;
				continue;
			}

			$redacted[ $key ] = self::redact_array( $profile_name, $item );
		}

		return $redacted;
	}
}
