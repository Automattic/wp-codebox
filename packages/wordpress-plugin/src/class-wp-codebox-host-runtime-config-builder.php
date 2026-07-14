<?php
/**
 * Host-side runtime config and mount assembly.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_Host_Runtime_Config_Builder {

	/** @param array<string,mixed> $input Ability input. @return array<int,array<string,mixed>>|WP_Error */
	public function recipe_mounts( array $input ): array|WP_Error {
		$mounts     = is_array( $input['mounts'] ?? null ) ? $input['mounts'] : array();
		$normalized = array();

		foreach ( $mounts as $index => $mount ) {
			if ( ! is_array( $mount ) ) {
				return new WP_Error( 'wp_codebox_mount_invalid', 'Each WP Codebox mount must be an object.', array( 'status' => 400, 'index' => $index ) );
			}

			$source = WP_Codebox_Path_Policy::clean_host_path( (string) ( $mount['source'] ?? '' ) );
			$target = WP_Codebox_Path_Policy::normalize_sandbox_mount_target( (string) ( $mount['target'] ?? '' ), 'WP Codebox mount ' . $index, 'wp_codebox_mount_target_invalid', array( 'index' => $index ) );
			if ( '' === $source || ( ! is_dir( $source ) && ! is_file( $source ) ) ) {
				return new WP_Error( 'wp_codebox_mount_source_invalid', 'WP Codebox mount source must be an existing file or directory.', array( 'status' => 400, 'index' => $index ) );
			}

			if ( is_wp_error( $target ) ) {
				return $target;
			}

			$mode = (string) ( $mount['mode'] ?? 'readwrite' );
			if ( 'readonly' !== $mode && 'readwrite' !== $mode ) {
				return new WP_Error( 'wp_codebox_mount_mode_invalid', 'WP Codebox mount mode must be readonly or readwrite.', array( 'status' => 400, 'index' => $index ) );
			}

			$entry = array(
				'type'   => is_file( $source ) ? 'file' : 'directory',
				'source' => $source,
				'target' => $target,
				'mode'   => $mode,
			);
			if ( isset( $mount['type'] ) && in_array( (string) $mount['type'], array( 'file', 'directory' ), true ) ) {
				$entry['type'] = (string) $mount['type'];
			}

			if ( isset( $mount['metadata'] ) && ! is_array( $mount['metadata'] ) ) {
				return new WP_Error( 'wp_codebox_mount_metadata_invalid', 'WP Codebox mount metadata must be an object.', array( 'status' => 400, 'index' => $index ) );
			}

			if ( isset( $mount['metadata'] ) ) {
				$entry['metadata'] = $mount['metadata'];
			}

			$normalized[] = $entry;
		}

		return $normalized;
	}

	/** @param array<string,mixed> $input Ability input. @return array<int,array<string,mixed>>|WP_Error */
	public function recipe_workspaces( array $input ): array|WP_Error {
		$workspaces = is_array( $input['workspaces'] ?? null ) ? $input['workspaces'] : array();
		$runner_workspace = is_array( $input['runner_workspace'] ?? null ) ? $input['runner_workspace'] : array();
		if ( ! empty( $runner_workspace['enabled'] ) ) {
			$checkout = WP_Codebox_Path_Policy::clean_host_path( (string) ( $runner_workspace['checkout_path'] ?? $runner_workspace['workspace_path'] ?? $runner_workspace['path'] ?? '' ) );
			if ( '' === $checkout || ! is_dir( $checkout ) ) {
				return new WP_Error( 'wp_codebox_runner_workspace_checkout_missing', 'Enabled runner_workspace requires an existing checked-out host workspace path.', array( 'status' => 400 ) );
			}
			foreach ( $workspaces as $workspace ) {
				if ( is_array( $workspace ) && '/workspace' === (string) ( $workspace['target'] ?? '' ) ) {
					return new WP_Error( 'wp_codebox_runner_workspace_target_conflict', 'runner_workspace reserves the sandbox target /workspace.', array( 'status' => 400 ) );
				}
			}
			// Recipe preparation copies this directory to an ephemeral source and a
			// separate baseline. It is deliberately not represented as a mount.
			$workspaces[] = array(
				'target'     => '/workspace',
				'mode'       => 'readwrite',
				'sourceMode' => 'repo-backed',
				'seed'       => array(
					'type'         => 'directory',
					'source'       => $checkout,
					'excludePaths' => array( '.git/**', '.codebox/**', 'node_modules/**', 'vendor/**', 'dist/**', 'build/**', 'coverage/**', '.cache/**' ),
				),
			);
		}
		foreach ( $workspaces as $index => $workspace ) {
			if ( ! is_array( $workspace ) || ! is_array( $workspace['seed'] ?? null ) ) {
				return new WP_Error( 'wp_codebox_workspace_invalid', 'Each WP Codebox workspace must include a seed object.', array( 'status' => 400, 'index' => $index ) );
			}
			if ( 'directory' === (string) ( $workspace['seed']['type'] ?? '' ) && empty( $workspace['seed']['source'] ) ) {
				return new WP_Error( 'wp_codebox_workspace_source_missing', 'Directory workspaces require seed.source.', array( 'status' => 400, 'index' => $index ) );
			}
		}

		return $workspaces;
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public function recipe_runtime( array $input, string $wp_version, ?WP_Codebox_Runtime_Dependency_Plan $dependency_plan = null ): array|WP_Error {
		$runtime = array(
			'wp'        => $wp_version,
			'blueprint' => array( 'steps' => array() ),
		);

		$stack_mounts = $this->runtime_stack_mounts( $input );
		if ( is_wp_error( $stack_mounts ) ) {
			return $stack_mounts;
		}
		if ( ! empty( $stack_mounts ) ) {
			$runtime['stack'] = array( 'mounts' => $stack_mounts );
		}

		$overlays = $dependency_plan instanceof WP_Codebox_Runtime_Dependency_Plan ? $dependency_plan->runtime_overlays() : $this->merge_array_lists( $input['runtime_overlays'] ?? array() );
		if ( ! empty( $overlays ) ) {
			$runtime['overlays'] = $overlays;
		}

		return $runtime;
	}

	/** @param array<string,mixed> $input Ability input. @return array<int,array<string,mixed>>|WP_Error */
	public function runtime_stack_mounts( array $input ): array|WP_Error {
		$mounts = $this->merge_array_lists(
			$input['runtime_stack_mounts'] ?? array(),
			$input['runtime_config_mounts'] ?? array(),
			$input['runtimeConfigMounts'] ?? array(),
			$input['runtime_state_mounts'] ?? array(),
			$input['runtimeStateMounts'] ?? array()
		);

		$normalized = array();
		foreach ( $mounts as $index => $mount ) {
			$target = WP_Codebox_Path_Policy::normalize_sandbox_mount_target( (string) ( $mount['target'] ?? '' ), 'Runtime stack mount ' . $index, 'wp_codebox_runtime_mount_target_invalid', array( 'index' => $index ) );
			if ( is_wp_error( $target ) ) {
				return $target;
			}

			$mount['target'] = $target;
			if ( ! isset( $mount['metadata'] ) || ! is_array( $mount['metadata'] ) ) {
				$mount['metadata'] = array();
			}
			$mount['metadata'] = array_merge( array( 'kind' => 'runtime-state-mount' ), $mount['metadata'] );
			$normalized[]      = $mount;
		}

		return $normalized;
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,string> */
	public function runtime_env( array $input ): array {
		$raw = is_array( $input['runtime_env'] ?? null ) ? $input['runtime_env'] : ( is_array( $input['runtimeEnv'] ?? null ) ? $input['runtimeEnv'] : array() );
		$env = array();
		foreach ( $raw as $name => $value ) {
			$name = trim( (string) $name );
			if ( 1 === preg_match( '/^[A-Z_][A-Z0-9_]*$/', $name ) && is_scalar( $value ) ) {
				$env[ $name ] = (string) $value;
			}
		}

		return $env;
	}

	/** @param string[] $paths @return string[] */
	public function existing_host_directories( array $paths ): array {
		return array_values(
			array_unique(
				array_filter(
					array_map(
						static fn( $path ): string => WP_Codebox_Path_Policy::clean_host_path( (string) $path ),
						$paths
					),
					static fn( string $path ): bool => '' !== $path && is_dir( $path )
				)
			)
		);
	}

	/**
	 * @param array<int,array<string,mixed>> $paths Component contracts.
	 * @return array<int,array<string,mixed>>
	 */
	public function component_plugins( array $paths ): array {
		$plugins = array();
		foreach ( $paths as $index => $contract ) {
			$path = trim( (string) ( $contract['path'] ?? $contract['source'] ?? '' ) );
			$source_path = trim( (string) ( $contract['sourcePath'] ?? $contract['source_path'] ?? '' ) );
			if ( '' === $path ) {
				$path = $source_path;
			}
			if ( '' === $path ) {
				continue;
			}

			$slug     = (string) ( $contract['slug'] ?? basename( $path ) );
			$load_as  = (string) ( $contract['loadAs'] ?? 'mu-plugin' );
			$activate = (bool) ( $contract['activate'] ?? false );

			$plugin = array_filter(
				array(
					'source'        => '' === $source_path ? $path : '',
					'sourcePath'    => $source_path,
					'sourceRoot'    => trim( (string) ( $contract['sourceRoot'] ?? $contract['source_root'] ?? '' ) ),
					'sourceSubdir'  => trim( (string) ( $contract['sourceSubdir'] ?? $contract['source_subdir'] ?? '' ) ),
					'sourceSubpath' => trim( (string) ( $contract['sourceSubpath'] ?? $contract['source_subpath'] ?? '' ) ),
					'slug'          => $slug,
					'mountSlug'     => trim( (string) ( $contract['mountSlug'] ?? $contract['mount_slug'] ?? '' ) ),
					'pluginFile'    => trim( (string) ( $contract['pluginFile'] ?? $contract['plugin_file'] ?? '' ) ),
					'activate'      => $activate,
					'loadAs'        => $load_as,
				),
				static fn( mixed $value ): bool => '' !== $value
			);

			$plugin['metadata'] = array(
				'componentContract' => array_filter(
					array(
						'index'         => $index,
						'slug'          => $slug,
						'requestedPath' => $path,
						'originalPath'  => isset( $contract['original_path'] ) ? (string) $contract['original_path'] : ( isset( $contract['originalPath'] ) ? (string) $contract['originalPath'] : '' ),
						'preparedPath'  => $path,
						'loadAs'        => $load_as,
						'activate'      => $activate,
					),
					static fn( mixed $value ): bool => '' !== $value
				),
			);
			$plugins[] = $plugin;
		}

		return $plugins;
	}

	/** @return array<int,array<string,mixed>> */
	private function merge_array_lists( mixed ...$lists ): array {
		$merged = array();
		foreach ( $lists as $list ) {
			foreach ( is_array( $list ) ? $list : array() as $entry ) {
				if ( is_array( $entry ) ) {
					$merged[] = $entry;
				}
			}
		}

		return $merged;
	}
}
