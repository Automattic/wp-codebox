<?php
/**
 * Shared JSON helpers for WP Codebox PHP code.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_Json {

	public static function encode( mixed $value, int $flags = 0, string $fallback = '{}' ): string {
		$encoded = self::try_encode( $value, $flags );

		return false === $encoded ? $fallback : $encoded;
	}

	/** @return string|false */
	public static function try_encode( mixed $value, int $flags = 0 ): string|false {
		if ( function_exists( 'wp_json_encode' ) ) {
			return wp_json_encode( $value, $flags );
		}

		return json_encode( $value, $flags );
	}

	public static function decode( string $json ): mixed {
		return json_decode( $json, true );
	}

	/** @return array<mixed>|null */
	public static function decode_array( string $json ): ?array {
		$decoded = self::decode( $json );

		return is_array( $decoded ) ? $decoded : null;
	}

	/** @return array<string,mixed>|null */
	public static function decode_object( string $json ): ?array {
		$decoded = self::decode_array( $json );

		return null !== $decoded && ! array_is_list( $decoded ) ? $decoded : null;
	}

	/** @return array<int,mixed>|null */
	public static function decode_list( string $json ): ?array {
		$decoded = self::decode_array( $json );

		return null !== $decoded && array_is_list( $decoded ) ? $decoded : null;
	}

	/** @return array<mixed>|null */
	public static function decode_trailing_array( string $output ): ?array {
		$trimmed = trim( $output );
		if ( '' === $trimmed ) {
			return null;
		}

		$decoded = self::decode_array( $trimmed );
		if ( null !== $decoded ) {
			return $decoded;
		}

		$offset = strrpos( $trimmed, "\n{" );
		if ( false === $offset ) {
			return null;
		}

		return self::decode_array( substr( $trimmed, $offset + 1 ) );
	}

	/** @return array<mixed>|null */
	public static function decode_fragment_array( string $text ): ?array {
		$trimmed = trim( $text );
		if ( '' === $trimmed ) {
			return null;
		}

		$decoded = self::decode_array( $trimmed );
		if ( null !== $decoded ) {
			return $decoded;
		}

		$start = strpos( $trimmed, '{' );
		$end   = strrpos( $trimmed, '}' );
		if ( false === $start || false === $end || $end <= $start ) {
			return null;
		}

		return self::decode_array( substr( $trimmed, $start, $end - $start + 1 ) );
	}

	/** @return array<mixed>|null */
	public static function read_array_file( string $path ): ?array {
		$contents = is_file( $path ) ? file_get_contents( $path ) : false;
		if ( false === $contents ) {
			return null;
		}

		return self::decode_array( (string) $contents );
	}

	public static function write_file( string $path, mixed $value, int $flags = 0, bool $append_newline = true ): bool {
		$directory = dirname( $path );
		if ( ! self::ensure_directory( $directory ) ) {
			return false;
		}

		$encoded = self::try_encode( $value, $flags );
		if ( false === $encoded ) {
			return false;
		}

		return false !== file_put_contents( $path, $encoded . ( $append_newline ? "\n" : '' ) );
	}

	public static function append_jsonl( string $path, mixed $record, int $flags = 0, int $file_flags = FILE_APPEND ): bool {
		$directory = dirname( $path );
		if ( ! self::ensure_directory( $directory ) ) {
			return false;
		}

		$encoded = self::try_encode( $record, $flags );
		if ( false === $encoded ) {
			return false;
		}

		return false !== file_put_contents( $path, $encoded . "\n", $file_flags );
	}

	private static function ensure_directory( string $path ): bool {
		if ( '' === $path || '.' === $path || is_dir( $path ) ) {
			return true;
		}

		if ( function_exists( 'wp_mkdir_p' ) ) {
			return (bool) wp_mkdir_p( $path );
		}

		return mkdir( $path, 0777, true );
	}
}
