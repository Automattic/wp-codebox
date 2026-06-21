<?php
/**
 * Generic provider credential boundary contracts.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_Provider_Credentials {
	public const REQUIREMENTS_SCHEMA = 'wp-codebox/provider-credential-requirements/v1';
	public const PREFLIGHT_SCHEMA    = 'wp-codebox/provider-credential-preflight/v1';

	/** @param array<string,mixed> $selection Provider/model/runtime selection metadata. @param array<string,mixed> $input Ability input. @param array<string,mixed> $inheritance Sanitized inheritance metadata. @return array<string,mixed>|WP_Error */
	public static function resolve( array $selection, array $input = array(), array $inheritance = array() ): array|WP_Error {
		$requirements = self::requirements( $selection, $input, $inheritance );
		$preflight    = self::preflight( $requirements, $selection, $input, $inheritance );
		if ( in_array( (string) ( $preflight['status'] ?? '' ), array( 'missing', 'denied' ), true ) ) {
			return new WP_Error( 'wp_codebox_provider_credentials_unavailable', 'Provider credentials are missing or denied for this sandbox scope.', array( 'status' => 403, 'schema' => self::PREFLIGHT_SCHEMA, 'preflight' => $preflight ) );
		}

		return array(
			'requirements' => $requirements,
			'preflight'    => $preflight,
			'secret_env'   => self::secret_env_names( $preflight ),
		);
	}

	/** @param array<string,mixed> $selection Provider/model/runtime selection metadata. @param array<string,mixed> $input Ability input. @param array<string,mixed> $inheritance Sanitized inheritance metadata. @return array<string,mixed> */
	public static function requirements( array $selection, array $input = array(), array $inheritance = array() ): array {
		$requirements = array(
			'schema'       => self::REQUIREMENTS_SCHEMA,
			'provider'     => self::safe_slug( $selection['provider'] ?? '' ),
			'model'        => self::safe_label( $selection['model'] ?? '' ),
			'requirements' => array(),
		);

		if ( function_exists( 'apply_filters' ) ) {
			$filtered = apply_filters( 'wp_codebox_provider_credential_requirements', $requirements, $selection, $input, $inheritance );
			if ( is_array( $filtered ) ) {
				$requirements = $filtered;
			}
		}

		return self::sanitize_requirements( $requirements, $selection );
	}

	/** @param array<string,mixed> $requirements Redacted requirement contract. @param array<string,mixed> $selection Provider/model/runtime selection metadata. @param array<string,mixed> $input Ability input. @param array<string,mixed> $inheritance Sanitized inheritance metadata. @return array<string,mixed> */
	public static function preflight( array $requirements, array $selection, array $input = array(), array $inheritance = array() ): array {
		$preflight = array(
			'schema'       => self::PREFLIGHT_SCHEMA,
			'provider'     => self::safe_slug( $selection['provider'] ?? $requirements['provider'] ?? '' ),
			'model'        => self::safe_label( $selection['model'] ?? $requirements['model'] ?? '' ),
			'status'       => self::has_required_requirements( $requirements ) ? 'missing' : 'not-required',
			'requirements' => $requirements['requirements'] ?? array(),
			'secret_env'   => array(),
			'diagnostics'  => array(),
			'redacted'     => true,
		);

		if ( function_exists( 'apply_filters' ) ) {
			$filtered = apply_filters( 'wp_codebox_resolve_provider_credentials', $preflight, $requirements, $selection, $input, $inheritance );
			if ( is_array( $filtered ) ) {
				$preflight = $filtered;
			}
		}

		return self::sanitize_preflight( $preflight, $requirements, $selection );
	}

	/** @param array<string,mixed> $preflight Sanitized preflight contract. @return string[] */
	public static function secret_env_names( array $preflight ): array {
		return self::env_names( $preflight['secret_env'] ?? array() );
	}

	/** @param array<string,mixed> $requirements Raw requirements. @param array<string,mixed> $selection Provider/model/runtime selection metadata. @return array<string,mixed> */
	private static function sanitize_requirements( array $requirements, array $selection ): array {
		$entries = array();
		foreach ( is_array( $requirements['requirements'] ?? null ) ? $requirements['requirements'] : array() as $requirement ) {
			if ( ! is_array( $requirement ) ) {
				continue;
			}
			$name = self::safe_key( $requirement['name'] ?? '' );
			if ( '' === $name ) {
				continue;
			}

			$entry = array(
				'name'     => $name,
				'required' => array_key_exists( 'required', $requirement ) ? (bool) $requirement['required'] : true,
			);
			foreach ( array( 'kind', 'scope', 'source' ) as $field ) {
				$value = self::safe_label( $requirement[ $field ] ?? '' );
				if ( '' !== $value ) {
					$entry[ $field ] = $value;
				}
			}
			$env = self::env_names( $requirement['secret_env'] ?? $requirement['secretEnv'] ?? array() );
			if ( ! empty( $env ) ) {
				$entry['secretEnv'] = $env;
			}

			$entries[] = $entry;
		}

		return array(
			'schema'       => self::REQUIREMENTS_SCHEMA,
			'provider'     => self::safe_slug( $selection['provider'] ?? $requirements['provider'] ?? '' ),
			'model'        => self::safe_label( $selection['model'] ?? $requirements['model'] ?? '' ),
			'requirements' => $entries,
			'redacted'     => true,
		);
	}

	/** @param array<string,mixed> $preflight Raw preflight. @param array<string,mixed> $requirements Sanitized requirements. @param array<string,mixed> $selection Provider/model/runtime selection metadata. @return array<string,mixed> */
	private static function sanitize_preflight( array $preflight, array $requirements, array $selection ): array {
		$status = self::status( (string) ( $preflight['status'] ?? '' ), ! self::has_required_requirements( $requirements ) );
		return array(
			'schema'       => self::PREFLIGHT_SCHEMA,
			'provider'     => self::safe_slug( $selection['provider'] ?? $preflight['provider'] ?? $requirements['provider'] ?? '' ),
			'model'        => self::safe_label( $selection['model'] ?? $preflight['model'] ?? $requirements['model'] ?? '' ),
			'status'       => $status,
			'requirements' => is_array( $requirements['requirements'] ?? null ) ? $requirements['requirements'] : array(),
			'secret_env'   => self::env_names( $preflight['secret_env'] ?? $preflight['secretEnv'] ?? array() ),
			'diagnostics'  => self::diagnostics( $preflight['diagnostics'] ?? array() ),
			'redacted'     => true,
		);
	}

	private static function status( string $status, bool $empty_requirements ): string {
		if ( in_array( $status, array( 'available', 'missing', 'denied', 'not-required' ), true ) ) {
			return $status;
		}

		return $empty_requirements ? 'not-required' : 'missing';
	}

	/** @param array<string,mixed> $requirements Sanitized requirements. */
	private static function has_required_requirements( array $requirements ): bool {
		foreach ( is_array( $requirements['requirements'] ?? null ) ? $requirements['requirements'] : array() as $requirement ) {
			if ( is_array( $requirement ) && (bool) ( $requirement['required'] ?? true ) ) {
				return true;
			}
		}

		return false;
	}

	/** @return array<int,array<string,string>> */
	private static function diagnostics( mixed $diagnostics ): array {
		$entries = array();
		foreach ( is_array( $diagnostics ) ? $diagnostics : array() as $diagnostic ) {
			if ( ! is_array( $diagnostic ) ) {
				continue;
			}
			$code    = self::safe_key( $diagnostic['code'] ?? '' );
			$message = self::safe_reason( $diagnostic['message'] ?? '' );
			if ( '' === $code && '' === $message ) {
				continue;
			}

			$entry = array();
			if ( '' !== $code ) {
				$entry['code'] = $code;
			}
			if ( '' !== $message ) {
				$entry['message'] = $message;
			}
			$severity = self::safe_key( $diagnostic['severity'] ?? '' );
			if ( in_array( $severity, array( 'info', 'warning', 'error' ), true ) ) {
				$entry['severity'] = $severity;
			}
			$entries[] = $entry;
		}

		return $entries;
	}

	/** @return string[] */
	private static function env_names( mixed $value ): array {
		$names = array();
		foreach ( WP_Codebox_Agent_Task::string_list( $value ) as $name ) {
			if ( 1 === preg_match( '/^[A-Z_][A-Z0-9_]*$/', $name ) ) {
				$names[] = $name;
			}
		}

		return array_values( array_unique( $names ) );
	}

	private static function safe_slug( mixed $value ): string {
		return substr( preg_replace( '/[^A-Za-z0-9_.:-]/', '', trim( (string) $value ) ) ?? '', 0, 120 );
	}

	private static function safe_key( mixed $value ): string {
		return substr( preg_replace( '/[^A-Za-z0-9_.:-]/', '', trim( (string) $value ) ) ?? '', 0, 120 );
	}

	private static function safe_label( mixed $value ): string {
		return substr( preg_replace( '/[^A-Za-z0-9 ._:@\/-]/', '', trim( (string) $value ) ) ?? '', 0, 160 );
	}

	private static function safe_reason( mixed $value ): string {
		return substr( preg_replace( '/[^A-Za-z0-9 .,:_@\/-]/', '', trim( (string) $value ) ) ?? '', 0, 240 );
	}
}
