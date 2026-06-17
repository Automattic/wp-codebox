<?php
/**
 * Shared PHP mirror of runtime-core path policy primitives.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_Path_Policy {

	public static function clean_host_path( string $path ): string {
		return rtrim( trim( $path ), DIRECTORY_SEPARATOR );
	}

	public static function clean_browser_runtime_source_path( string $path ): string {
		$path = trim( $path );
		if ( '' === $path ) {
			return '';
		}

		$real = realpath( $path );
		return false !== $real ? $real : rtrim( $path, '/\\' );
	}

	public static function normalize_absolute_browser_path( string $path ): string {
		$path = '/' . ltrim( trim( $path ), '/' );
		$path = rtrim( $path, '/' );
		return '' === $path ? '/' : $path;
	}

	/** @param array<string,mixed> $data Additional error data. */
	public static function normalize_sandbox_mount_target( string $target, string $label = 'Sandbox mount', string $error_code = 'wp_codebox_mount_target_invalid', array $data = array() ): string|WP_Error {
		$normalized = preg_replace( '#/+#', '/', trim( str_replace( '\\', '/', $target ) ) );
		$normalized = is_string( $normalized ) ? $normalized : '';
		if ( '' === $normalized ) {
			return self::error( $error_code, $label . ' requires target.', $data + array( 'target' => $target ) );
		}

		if ( ! str_starts_with( $normalized, '/' ) ) {
			return self::error( $error_code, $label . ' requires an absolute target.', $data + array( 'target' => $target ) );
		}

		$segments = array_values( array_filter( explode( '/', $normalized ), static fn( string $segment ): bool => '' !== $segment ) );
		foreach ( $segments as $segment ) {
			if ( '.' === $segment || '..' === $segment ) {
				return self::error( $error_code, $label . ' target must not contain current-directory or parent-directory segments.', $data + array( 'target' => $target, 'segment' => $segment ) );
			}
		}

		return empty( $segments ) ? '/' : '/' . implode( '/', $segments );
	}

	/** @param array<string,mixed> $data Additional error data. */
	public static function normalize_artifact_relative_path( string $path, string $label = 'Artifact path', string $error_code = 'wp_codebox_artifact_path_invalid', array $data = array() ): string|WP_Error {
		$normalized = trim( str_replace( '\\', '/', $path ) );
		if ( '' === $normalized || 1 === preg_match( '/^[A-Za-z]:(?:$|\/)/', $normalized ) ) {
			return self::error( $error_code, $label . ' must be a relative path inside the artifact root.', $data + array( 'path' => $path ) );
		}

		$segments = array_values( array_filter( explode( '/', $normalized ), static fn( string $segment ): bool => '' !== $segment ) );
		if ( empty( $segments ) ) {
			return self::error( $error_code, $label . ' must be a relative path inside the artifact root.', $data + array( 'path' => $path ) );
		}

		foreach ( $segments as $segment ) {
			if ( '.' === $segment || '..' === $segment ) {
				return self::error( $error_code, $label . ' must be a relative path without current-directory or parent-directory segments.', $data + array( 'path' => $path, 'segment' => $segment ) );
			}
		}

		return implode( '/', $segments );
	}

	/** @param array<string,mixed> $data Error data. */
	private static function error( string $code, string $message, array $data ): WP_Error {
		return new WP_Error( $code, $message, array_merge( array( 'status' => 400 ), $data ) );
	}
}
