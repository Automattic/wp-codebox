<?php
/**
 * WP_Codebox_Abilities_Browser_Artifacts implementation.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

trait WP_Codebox_Abilities_Browser_Artifacts {
/** @param array<string,mixed> $input Ability input. @return array<int,array<string,mixed>>|WP_Error */
private static function browser_artifact_files( array $input ): array|WP_Error {
	$files      = is_array( $input['artifact_files'] ?? null ) ? $input['artifact_files'] : array();
	$playground = is_array( $input['playground'] ?? null ) ? $input['playground'] : array();
	$base_path  = self::browser_artifact_base_path( $playground );
	$base_url   = self::browser_artifact_base_url( $playground );
	$normalized = array();
	foreach ( $files as $index => $file ) {
		if ( ! is_array( $file ) ) {
			return new WP_Error( 'wp_codebox_browser_artifact_file_invalid', 'Each browser artifact file must be an object.', array( 'status' => 400, 'index' => $index ) );
		}

		$path_validation = self::validate_browser_artifact_path( trim( (string) ( $file['path'] ?? '' ) ), (int) $index );
		if ( is_wp_error( $path_validation ) ) {
			return $path_validation;
		}
		$path = $path_validation;

		$encoding = strtolower( trim( (string) ( $file['encoding'] ?? '' ) ) );
		if ( '' === $encoding ) {
			$encoding = array_key_exists( 'content_base64', $file ) ? 'base64' : 'utf-8';
		}

		if ( ! in_array( $encoding, array( 'utf-8', 'base64' ), true ) ) {
			return new WP_Error( 'wp_codebox_browser_artifact_encoding_invalid', 'Browser artifact file encoding must be utf-8 or base64.', array( 'status' => 400, 'index' => $index, 'path' => $path, 'encoding' => $encoding ) );
		}

		if ( 'base64' === $encoding ) {
			$encoded = (string) ( $file['content_base64'] ?? $file['content'] ?? '' );
			$bytes   = base64_decode( $encoded, true );
			if ( false === $bytes ) {
				return new WP_Error( 'wp_codebox_browser_artifact_base64_invalid', 'Browser artifact file content_base64 must be valid base64.', array( 'status' => 400, 'index' => $index, 'path' => $path ) );
			}
		} else {
			$bytes   = (string) ( $file['content'] ?? '' );
			$encoded = '';
		}

		$size = strlen( $bytes );
		if ( $size > self::BROWSER_ARTIFACT_MAX_BYTES ) {
			return new WP_Error( 'wp_codebox_browser_artifact_file_too_large', 'Browser artifact file exceeds the maximum inline size.', array( 'status' => 400, 'index' => $index, 'path' => $path, 'size' => $size, 'max_size' => self::BROWSER_ARTIFACT_MAX_BYTES ) );
		}

		$mime_type = trim( (string) ( $file['mime_type'] ?? '' ) );
		if ( '' === $mime_type ) {
			$mime_type = self::browser_artifact_mime_type( $path );
		}

		$artifact = array(
			'path'            => $path,
			'playground_path' => self::join_browser_path( $base_path, $path ),
			'url_path'        => self::join_browser_path( $base_url, $path ),
			'encoding'        => $encoding,
			'mime_type'       => $mime_type,
			'size'            => $size,
			'sha256'          => hash( 'sha256', $bytes ),
			'kind'            => (string) ( $file['kind'] ?? 'text' ),
			'description'     => (string) ( $file['description'] ?? '' ),
		);

		if ( 'base64' === $encoding ) {
			$artifact['content_base64'] = $encoded;
		} else {
			$artifact['content'] = $bytes;
		}

		$normalized[] = $artifact;
	}

	return $normalized;
}

private static function validate_browser_artifact_path( string $path, int $index ): string|WP_Error {
	if ( '' === $path || str_starts_with( $path, '/' ) || ! preg_match( '#^[A-Za-z0-9_./-]+$#', $path ) ) {
		return new WP_Error( 'wp_codebox_browser_artifact_path_invalid', 'Browser artifact file paths must be safe relative paths.', array( 'status' => 400, 'index' => $index, 'path' => $path ) );
	}

	$segments = explode( '/', $path );
	foreach ( $segments as $segment ) {
		if ( '' === $segment || '.' === $segment || '..' === $segment ) {
			return new WP_Error( 'wp_codebox_browser_artifact_path_invalid', 'Browser artifact file paths must not contain empty, current-directory, or parent-directory segments.', array( 'status' => 400, 'index' => $index, 'path' => $path, 'segment' => $segment ) );
		}
	}

	$extension = strtolower( pathinfo( $path, PATHINFO_EXTENSION ) );
	if ( in_array( $extension, array( 'php', 'phtml', 'phar', 'cgi', 'pl', 'py', 'rb', 'asp', 'aspx', 'jsp' ), true ) ) {
		return new WP_Error( 'wp_codebox_browser_artifact_extension_blocked', 'Browser artifact files must not use executable server-side extensions.', array( 'status' => 400, 'index' => $index, 'path' => $path, 'extension' => $extension ) );
	}

	return $path;
}

private static function browser_artifact_mime_type( string $path ): string {
	return match ( strtolower( pathinfo( $path, PATHINFO_EXTENSION ) ) ) {
		'html', 'htm' => 'text/html',
		'css'        => 'text/css',
		'js', 'mjs'   => 'text/javascript',
		'json'       => 'application/json',
		'svg'        => 'image/svg+xml',
		'jpg', 'jpeg' => 'image/jpeg',
		'png'        => 'image/png',
		'webp'       => 'image/webp',
		'gif'        => 'image/gif',
		'txt'        => 'text/plain',
		default      => 'application/octet-stream',
	};
}
}
