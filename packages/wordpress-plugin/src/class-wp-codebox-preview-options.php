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
	public const HOLD_MAX_SECONDS = 3600;
	public const PORT_MIN         = 1;
	public const PORT_MAX         = 65535;

	/** @return array<string,array<string,mixed>> */
	public static function input_schema(): array {
		return array(
			'preview_hold_seconds' => array(
				'type'        => 'integer',
				'minimum'     => 0,
				'maximum'     => self::HOLD_MAX_SECONDS,
				'description' => 'Seconds to keep the live Playground preview URL available after capture. Max 3600.',
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
		);
	}

	/** @param array<string,mixed> $input Preview option input. @return array{preview_hold_seconds:int,preview_port:?int,preview_bind:?string,preview_public_url:?string}|WP_Error */
	public static function normalize( array $input ): array|WP_Error {
		$port   = self::preview_port( $input );
		$bind   = self::preview_bind( $input );
		$public = self::preview_public_url( $input );

		foreach ( array( $port, $bind, $public ) as $value ) {
			if ( is_wp_error( $value ) ) {
				return $value;
			}
		}

		if ( null !== $bind && null === $port ) {
			return new WP_Error( 'wp_codebox_preview_bind_requires_port', 'preview_bind requires preview_port.', array( 'status' => 400 ) );
		}

		return array(
			'preview_hold_seconds' => self::preview_hold_seconds( $input ),
			'preview_port'         => $port,
			'preview_bind'         => $bind,
			'preview_public_url'   => $public,
		);
	}

	/** @param array<string,mixed> $input Preview option input. */
	public static function preview_hold_seconds( array $input ): int {
		$raw = trim( (string) ( $input['preview_hold_seconds'] ?? $input['preview_hold'] ?? 0 ) );
		if ( preg_match( '/^(\d+)(s|m)?$/', $raw, $matches ) ) {
			$seconds = (int) $matches[1];
			if ( 'm' === ( $matches[2] ?? '' ) ) {
				$seconds *= 60;
			}
		} else {
			$seconds = (int) $raw;
		}

		return max( 0, min( self::HOLD_MAX_SECONDS, $seconds ) );
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

	/** @param array<string,mixed> $input Preview option input. */
	private static function preview_public_url( array $input ): string|WP_Error|null {
		if ( ! array_key_exists( 'preview_public_url', $input ) || '' === trim( (string) $input['preview_public_url'] ) ) {
			return null;
		}

		$url   = trim( (string) $input['preview_public_url'] );
		$parts = function_exists( 'wp_parse_url' ) ? wp_parse_url( $url ) : parse_url( $url );
		if ( ! is_array( $parts ) || empty( $parts['host'] ) || empty( $parts['scheme'] ) || ! in_array( strtolower( (string) $parts['scheme'] ), array( 'http', 'https' ), true ) ) {
			return new WP_Error( 'wp_codebox_preview_public_url_invalid', 'preview_public_url must be an http or https URL with a hostname.', array( 'status' => 400 ) );
		}

		return $url;
	}
}
