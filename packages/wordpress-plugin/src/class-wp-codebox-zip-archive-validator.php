<?php
/**
 * Bounded ZIP admission policy for host-side archive consumers.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_Zip_Archive_Validator {

	private const MAX_ENTRIES = 2048;
	private const MAX_UNCOMPRESSED_BYTES = 209715200;
	private const MAX_ENTRY_UNCOMPRESSED_BYTES = 52428800;
	private const MAX_COMPRESSION_RATIO = 100;

	/** @return true|WP_Error */
	public static function validate( string $archive ): true|WP_Error {
		if ( ! class_exists( 'ZipArchive' ) ) {
			return self::error( 'zip_support_unavailable' );
		}
		if ( strlen( $archive ) < 22 || self::has_zip64_records( $archive ) ) {
			return self::error( 'zip64_or_truncated' );
		}

		$path = tempnam( sys_get_temp_dir(), 'wp-codebox-zip-' );
		if ( false === $path || false === file_put_contents( $path, $archive ) ) {
			return self::error( 'staging_failed', 500 );
		}

		$zip = new ZipArchive();
		try {
			if ( true !== $zip->open( $path, ZipArchive::CHECKCONS ) ) {
				return self::error( 'invalid_archive' );
			}
			if ( $zip->numFiles < 1 || $zip->numFiles > self::MAX_ENTRIES ) {
				return self::error( 'entry_count' );
			}

			$total = 0;
			$names = array();
			for ( $index = 0; $index < $zip->numFiles; $index++ ) {
				$stat = $zip->statIndex( $index, ZipArchive::FL_UNCHANGED );
				if ( ! is_array( $stat ) || ! self::entry_is_safe( $zip, $index, $stat, $names ) ) {
					return self::error( 'unsafe_entry' );
				}
				$size      = (int) ( $stat['size'] ?? -1 );
				$compressed = (int) ( $stat['comp_size'] ?? -1 );
				if ( $size < 0 || $compressed < 0 || $size > self::MAX_ENTRY_UNCOMPRESSED_BYTES || $total > self::MAX_UNCOMPRESSED_BYTES - $size ) {
					return self::error( 'uncompressed_size' );
				}
				if ( ( $size > 0 && 0 === $compressed ) || ( $compressed > 0 && $size > $compressed * self::MAX_COMPRESSION_RATIO ) ) {
					return self::error( 'compression_ratio' );
				}
				$total += $size;
			}
			return true;
		} finally {
			if ( $zip->status === ZipArchive::ER_OK ) {
				$zip->close();
			}
			@unlink( $path );
		}
	}

	/** @param array<string,mixed> $stat @param array<string,bool> $names */
	private static function entry_is_safe( ZipArchive $zip, int $index, array $stat, array &$names ): bool {
		$name = (string) ( $stat['name'] ?? '' );
		if ( '' === $name || isset( $names[ $name ] ) || str_contains( $name, "\0" ) || str_contains( $name, '\\' ) || str_starts_with( $name, '/' ) || preg_match( '#(?:^|/)\.\.?(/|$)#', $name ) ) {
			return false;
		}
		$names[ $name ] = true;
		if ( isset( $stat['encryption_method'] ) && ZipArchive::EM_NONE !== (int) $stat['encryption_method'] ) {
			return false;
		}
		$operations = 0;
		$attributes = 0;
		if ( ! $zip->getExternalAttributesIndex( $index, $operations, $attributes, ZipArchive::FL_UNCHANGED ) ) {
			return false;
		}
		// Unix archives encode the file kind in the upper mode bits. Only regular
		// files and directories can be imported; links and device nodes are rejected.
		if ( ZipArchive::OPSYS_UNIX === $operations ) {
			$kind = ( $attributes >> 16 ) & 0170000;
			if ( 0 !== $kind && 0100000 !== $kind && 0040000 !== $kind ) {
				return false;
			}
		}
		return true;
	}

	private static function has_zip64_records( string $archive ): bool {
		// ZIP64 needs 64-bit central-directory accounting. This bounded importer
		// deliberately rejects it instead of accepting a format it cannot cap.
		return false !== strpos( $archive, "PK\x06\x06" ) || false !== strpos( $archive, "PK\x06\x07" );
	}

	private static function error( string $reason, int $status = 400 ): WP_Error {
		return new WP_Error( 'wp_codebox_zip_archive_invalid', 'ZIP archive failed the host import safety policy.', array( 'status' => $status, 'reason' => $reason ) );
	}
}
