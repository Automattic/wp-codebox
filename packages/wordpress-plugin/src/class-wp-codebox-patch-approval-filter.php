<?php
/**
 * Filters artifact patches down to approved sandbox files.
 *
 * @package WP_Codebox
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class WP_Codebox_Patch_Approval_Filter {
	/**
	 * @param array<int,mixed> $changed_files Artifact changed file entries.
	 * @param string[]         $approved_files Approved sandbox paths.
	 */
	public function filter_patch_to_approved_files( string $patch, array $changed_files, array $approved_files ): string|WP_Error {
		$approved_lookup             = array_fill_keys( $approved_files, true );
		$approved_patch_path_sets    = array();
		$approved_patch_paths_lookup = array();

		foreach ( $changed_files as $file ) {
			if ( ! is_array( $file ) ) {
				continue;
			}

			$path = trim( (string) ( $file['path'] ?? '' ) );
			if ( '' === $path || ! isset( $approved_lookup[ $path ] ) ) {
				continue;
			}

			foreach ( array( $path, (string) ( $file['relativePath'] ?? '' ) ) as $patch_path ) {
				$normalized = $this->normalize_patch_path( $patch_path );
				if ( '' !== $normalized ) {
					$approved_patch_path_sets[ $path ][ $normalized ] = true;
					$approved_patch_paths_lookup[ $normalized ] = true;
				}
			}
		}

		if ( empty( $approved_patch_paths_lookup ) ) {
			return new WP_Error( 'wp_codebox_approved_patch_paths_missing', 'Approved files could not be mapped to patch paths.', array( 'status' => 400 ) );
		}

		$blocks = $this->split_git_patch_blocks( $patch );
		if ( empty( $blocks ) ) {
			return new WP_Error( 'wp_codebox_patch_unfilterable', 'Artifact patch.diff could not be split into file patches.', array( 'status' => 400 ) );
		}

		$matched_approved_files = array();
		$filtered_blocks        = array();
		foreach ( $blocks as $block ) {
			$block_paths = $this->git_patch_block_paths( $block );
			$matches     = array_intersect_key( $block_paths, $approved_patch_paths_lookup );
			if ( empty( $matches ) ) {
				continue;
			}

			foreach ( $approved_patch_path_sets as $approved_file => $candidate_paths ) {
				if ( ! empty( array_intersect_key( $matches, $candidate_paths ) ) ) {
					$matched_approved_files[ $approved_file ] = true;
				}
			}

			$filtered_blocks[] = $block;
		}

		$missing_files = array_values( array_diff( $approved_files, array_keys( $matched_approved_files ) ) );
		if ( ! empty( $missing_files ) ) {
			return new WP_Error(
				'wp_codebox_approved_patch_missing',
				'Artifact patch.diff does not contain every approved file, so the partial approval cannot be applied safely.',
				array(
					'status' => 400,
					'files'  => $missing_files,
				)
			);
		}

		$filtered_patch = implode( '', $filtered_blocks );
		if ( '' === trim( $filtered_patch ) ) {
			return new WP_Error( 'wp_codebox_approved_patch_empty', 'Approved files produced an empty patch.', array( 'status' => 400 ) );
		}

		return $filtered_patch;
	}

	/** @return string[] */
	private function split_git_patch_blocks( string $patch ): array {
		$lines = preg_split( "/(?<=\n)(?=diff --git )/", $patch );
		if ( false === $lines ) {
			return array();
		}

		return array_values(
			array_filter(
				$lines,
				static fn( string $block ): bool => str_starts_with( $block, 'diff --git ' )
			)
		);
	}

	/** @return array<string,bool> */
	private function git_patch_block_paths( string $block ): array {
		$paths = array();
		if ( preg_match( '/^diff --git\s+a\/(.+?)\s+b\/(.+)$/m', $block, $matches ) ) {
			foreach ( array( $matches[1], $matches[2] ) as $path ) {
				$normalized = $this->normalize_patch_path( $path );
				if ( '' !== $normalized ) {
					$paths[ $normalized ] = true;
				}
			}
		}

		foreach ( array( '---', '+++' ) as $prefix ) {
			if ( preg_match( '/^' . preg_quote( $prefix, '/' ) . '\s+(.+)$/m', $block, $matches ) ) {
				$normalized = $this->normalize_patch_path( $matches[1] );
				if ( '' !== $normalized ) {
					$paths[ $normalized ] = true;
				}
			}
		}

		return $paths;
	}

	private function normalize_patch_path( string $path ): string {
		$path = trim( $path );
		if ( '' === $path || '/dev/null' === $path ) {
			return '';
		}

		$path = preg_replace( '/\s+.*$/', '', $path ) ?? $path;
		$path = str_replace( '\\', '/', $path );
		$path = preg_replace( '#^(?:a|b)/#', '', $path ) ?? $path;
		$path = ltrim( $path, '/' );

		return $path;
	}
}
