<?php
/**
 * Shared preview option contract and validation helpers.
 *
 * @package WPCodebox
 */

declare( strict_types=1 );

if ( ! defined( 'ABSPATH' ) ) {
	die;
}

final class WP_Codebox_Preview_Options {
	public const HOLD_DEFAULT_MAX_SECONDS = 3600;
	public const HOLD_MAX_SECONDS         = self::HOLD_DEFAULT_MAX_SECONDS;
	public const HOLD_HARD_MAX_SECONDS    = 24 * 60 * 60;
	public const HOLD_MAX_SECONDS_ENV     = 'WP_CODEBOX_PREVIEW_HOLD_MAX_SECONDS';
	public const PORT_MIN                 = 1;
	public const PORT_MAX                 = 65535;

	/** @return array<string,array<string,mixed>> */
	public static function input_schema(): array {
		$hold_max = self::preview_hold_max_seconds();
		if ( is_wp_error( $hold_max ) ) {
			$hold_max = self::HOLD_DEFAULT_MAX_SECONDS;
		}

		return array(
			'preview_hold_seconds' => array(
				'type'        => 'integer',
				'minimum'     => 0,
				'maximum'     => $hold_max,
				'description' => 'Seconds to keep the live Playground preview URL available after capture. Max 3600 by default; operators may raise the cap with WP_CODEBOX_PREVIEW_HOLD_MAX_SECONDS.',
			),
			'preview_port'         => array(
				'type'        => 'integer',
				'minimum'     => self::PORT_MIN,
				'maximum'     => self::PORT_MAX,
				'description' => 'Optional fixed local WP Codebox preview proxy port. Omit to keep the default loopback-only random-port behavior.',
			),
			'preview_bind'         => array(
				'type'        => 'string',
				'description' => 'Optional fixed-port preview proxy bind host or IP. Requires preview_port. Defaults to 127.0.0.1 when omitted.',
			),
			'preview_public_url'   => array(
				'type'        => 'string',
				'format'      => 'uri',
				'description' => 'Optional public http/https URL reported in preview metadata and passed to the sandbox for site URL alignment.',
			),
			'preview_lease'        => array(
				'type'        => 'object',
				'description' => 'Optional wp-codebox/preview-lease/v1 envelope for external tunnel/public URL handoff metadata. WP Codebox reports it but does not create the tunnel.',
			),
		);
	}

	/** @param array<string,mixed> $input Preview option input. @return array{preview_hold_seconds:int,preview_port:?int,preview_bind:?string,preview_public_url:?string,preview_lease:?array<string,mixed>}|WP_Error */
	public static function normalize( array $input ): array|WP_Error {
		$hold   = self::preview_hold_seconds( $input );
		$port   = self::preview_port( $input );
		$bind   = self::preview_bind( $input );
		$lease  = self::preview_lease( $input );
		$public = self::preview_public_url( $input, is_array( $lease ) ? $lease : null );

		foreach ( array( $hold, $port, $bind, $public, $lease ) as $value ) {
			if ( is_wp_error( $value ) ) {
				return $value;
			}
		}

		if ( null !== $bind && null === $port ) {
			return new WP_Error( 'wp_codebox_preview_bind_requires_port', 'preview_bind requires preview_port.', array( 'status' => 400 ) );
		}

		return array(
			'preview_hold_seconds' => $hold,
			'preview_port'         => $port,
			'preview_bind'         => $bind,
			'preview_public_url'   => $public,
			'preview_lease'        => $lease,
		);
	}

	/** @param array<string,mixed> $input Preview option input. @return int|WP_Error */
	public static function preview_hold_seconds( array $input ): int|WP_Error {
		$max = self::preview_hold_max_seconds();
		if ( is_wp_error( $max ) ) {
			return $max;
		}

		$raw = trim( (string) ( $input['preview_hold_seconds'] ?? 0 ) );
		if ( preg_match( '/^(\d+)(s|m|h)?$/', $raw, $matches ) ) {
			$seconds = (int) $matches[1];
			if ( 'h' === ( $matches[2] ?? '' ) ) {
				$seconds *= 3600;
			} elseif ( 'm' === ( $matches[2] ?? '' ) ) {
				$seconds *= 60;
			}
		} else {
			$seconds = (int) $raw;
		}

		return max( 0, min( $max, $seconds ) );
	}

	private static function preview_hold_max_seconds(): int|WP_Error {
		$value = getenv( self::HOLD_MAX_SECONDS_ENV );
		if ( false === $value || '' === trim( (string) $value ) ) {
			return self::HOLD_DEFAULT_MAX_SECONDS;
		}

		$raw = trim( (string) $value );
		if ( ! preg_match( '/^(\d+)(s|m|h)?$/', $raw, $matches ) ) {
			return new WP_Error( 'wp_codebox_preview_hold_max_invalid', self::HOLD_MAX_SECONDS_ENV . ' must be a duration such as 3600, 60m, or 4h.', array( 'status' => 400 ) );
		}

		$seconds = (int) $matches[1];
		if ( 'h' === ( $matches[2] ?? '' ) ) {
			$seconds *= 3600;
		} elseif ( 'm' === ( $matches[2] ?? '' ) ) {
			$seconds *= 60;
		}

		if ( $seconds < self::HOLD_DEFAULT_MAX_SECONDS || $seconds > self::HOLD_HARD_MAX_SECONDS ) {
			return new WP_Error( 'wp_codebox_preview_hold_max_invalid', self::HOLD_MAX_SECONDS_ENV . ' must be between ' . self::HOLD_DEFAULT_MAX_SECONDS . ' and ' . self::HOLD_HARD_MAX_SECONDS . ' seconds.', array( 'status' => 400 ) );
		}

		return $seconds;
	}

	/** @param array<string,mixed> $input Preview option input. */
	private static function preview_port( array $input ): int|WP_Error|null {
		if ( ! array_key_exists( 'preview_port', $input ) || '' === trim( (string) $input['preview_port'] ) ) {
			return null;
		}

		$raw = trim( (string) $input['preview_port'] );
		if ( ! preg_match( '/^\d+$/', $raw ) ) {
			return new WP_Error( 'wp_codebox_preview_port_invalid', 'preview_port must be an integer between 1 and 65535.', array( 'status' => 400 ) );
		}

		$port = (int) $raw;
		if ( $port < self::PORT_MIN || $port > self::PORT_MAX ) {
			return new WP_Error( 'wp_codebox_preview_port_invalid', 'preview_port must be an integer between 1 and 65535.', array( 'status' => 400 ) );
		}

		return $port;
	}

	/** @param array<string,mixed> $input Preview option input. */
	private static function preview_bind( array $input ): string|WP_Error|null {
		if ( ! array_key_exists( 'preview_bind', $input ) || '' === trim( (string) $input['preview_bind'] ) ) {
			return null;
		}

		$bind = trim( (string) $input['preview_bind'] );
		if ( str_contains( $bind, '/' ) || str_contains( $bind, '\\' ) || preg_match( '/\s/', $bind ) ) {
			return new WP_Error( 'wp_codebox_preview_bind_invalid', 'preview_bind must be a hostname or IP address, not a URL.', array( 'status' => 400 ) );
		}

		return $bind;
	}

	/**
	 * @param array<string,mixed>      $input Preview option input.
	 * @param array<string,mixed>|null $lease Preview lease input.
	 */
	private static function preview_public_url( array $input, ?array $lease = null ): string|WP_Error|null {
		if ( ! array_key_exists( 'preview_public_url', $input ) || '' === trim( (string) $input['preview_public_url'] ) ) {
			$lease_public = is_array( $lease ) ? ( $lease['public_url'] ?? $lease['preview_public_url'] ?? null ) : null;
			return is_string( $lease_public ) ? $lease_public : null;
		}

		$url   = trim( (string) $input['preview_public_url'] );
		$parts = function_exists( 'wp_parse_url' ) ? wp_parse_url( $url ) : parse_url( $url );
		if ( ! is_array( $parts ) || empty( $parts['host'] ) || empty( $parts['scheme'] ) || ! in_array( strtolower( (string) $parts['scheme'] ), array( 'http', 'https' ), true ) ) {
			return new WP_Error( 'wp_codebox_preview_public_url_invalid', 'preview_public_url must be an http or https URL with a hostname.', array( 'status' => 400 ) );
		}

		return $url;
	}

	/** @param array<string,mixed> $input Preview option input. @return array<string,mixed>|WP_Error|null */
	private static function preview_lease( array $input ): array|WP_Error|null {
		if ( ! array_key_exists( 'preview_lease', $input ) || null === $input['preview_lease'] || '' === $input['preview_lease'] ) {
			return null;
		}

		$lease = $input['preview_lease'];
		if ( is_string( $lease ) ) {
			$decoded = json_decode( $lease, true );
			if ( ! is_array( $decoded ) ) {
				return new WP_Error( 'wp_codebox_preview_lease_invalid', 'preview_lease must be a JSON object using wp-codebox/preview-lease/v1.', array( 'status' => 400 ) );
			}
			$lease = $decoded;
		}

		if ( ! is_array( $lease ) || ( $lease['schema'] ?? null ) !== 'wp-codebox/preview-lease/v1' ) {
			return new WP_Error( 'wp_codebox_preview_lease_invalid', 'preview_lease must use schema wp-codebox/preview-lease/v1.', array( 'status' => 400 ) );
		}

		$public = $lease['public_url'] ?? $lease['preview_public_url'] ?? null;
		if ( null !== $public ) {
			$input['preview_public_url'] = $public;
			$valid_public = self::preview_public_url( $input );
			if ( is_wp_error( $valid_public ) ) {
				return $valid_public;
			}
			$lease['public_url']         = $valid_public;
			$lease['preview_public_url'] = $valid_public;
		}
		if ( ! array_key_exists( 'evidence_refs', $lease ) ) {
			$lease['evidence_refs'] = array();
		}

		return $lease;
	}
}
