<?php
/**
 * Host-side sandbox recipe construction for agent task runs.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_Host_Recipe_Builder {

	private const AGENT_RUNTIME_ENV = array( 'WP_AGENT_RUNTIME' => '1' );

	/**
	 * @param array<int,array<string,mixed>> $paths Component contracts.
	 * @param array<string,mixed> $input Ability input.
	 * @param string[] $task_prompts Encoded task prompts.
	 * @param array<string,callable> $adapters Runner adapters for host-specific policy and filesystem concerns.
	 * @return array{path:string,cleanup_paths:array<int,string>}|WP_Error
	 */
	public function build( array $paths, array $input, array $task_prompts, string $wp_version, ?array $inheritance, array $adapters ): array|WP_Error {
		$inheritance      = $inheritance ?? $adapters['inheritance_resolution']( $input );
		$credential_error = $adapters['connector_credentials_error']( $inheritance );
		if ( null !== $credential_error ) {
			return $credential_error;
		}

		$component_plugins = $adapters['component_plugins']( $paths );
		$dependency_plan   = isset( $adapters['runtime_dependency_plan'] ) && is_callable( $adapters['runtime_dependency_plan'] )
			? $adapters['runtime_dependency_plan']( $input, $inheritance, $component_plugins )
			: self::runtime_dependency_plan_from_adapters( $input, $inheritance, $component_plugins, $adapters );
		if ( ! $dependency_plan instanceof WP_Codebox_Runtime_Dependency_Plan ) {
			return new WP_Error( 'wp_codebox_runtime_dependency_plan_invalid', 'Runtime dependency plan resolver must return a WP_Codebox_Runtime_Dependency_Plan.', array( 'status' => 500 ) );
		}
		$runtime_task          = $adapters['runtime_task']( $input );
		$steps          = array();
		foreach ( $task_prompts as $task_prompt ) {
			$task_input = $adapters['task_input']( array_merge( $input, array( 'goal' => $task_prompt ) ) );
			if ( is_wp_error( $task_input ) ) {
				return $task_input;
			}

			$args = array(
				'task=' . $task_prompt,
				'agent=' . (string) ( $dependency_plan->selection()['agent'] ?? '' ),
				'mode=' . (string) ( $dependency_plan->selection()['mode'] ?? '' ),
				'provider=' . $dependency_plan->provider(),
				'model=' . $dependency_plan->model(),
				'provider-plugin-slugs=' . implode( ',', $dependency_plan->provider_plugin_slugs() ),
				'sandbox-tool-policy-json=' . $adapters['json_encode']( $task_input['sandbox_tool_policy'] ),
			);
			if ( ! empty( $dependency_plan->agent_bundles() ) ) {
				$args[] = 'agent-bundles-json=' . $adapters['json_encode']( $dependency_plan->agent_bundles() );
			}
			if ( ! empty( $runtime_task ) ) {
				$args[] = 'runtime-task-json=' . $adapters['json_encode']( $runtime_task );
			}
			if ( ! empty( $input['session_id'] ) ) {
				$args[] = 'session-id=' . (string) $input['session_id'];
			}
			if ( ! empty( $input['max_turns'] ) ) {
				$args[] = 'max-turns=' . (string) max( 1, (int) $input['max_turns'] );
			}
			if ( ! empty( $input['task_timeout_seconds'] ) ) {
				$args[] = 'timeout-seconds=' . (string) $adapters['task_timeout_seconds']( $input );
			}

			$steps[] = array(
				'command' => 'wp-codebox.agent-sandbox-run',
				'args'    => $args,
			);
		}

		$mounts = $adapters['recipe_mounts']( $input );
		if ( is_wp_error( $mounts ) ) {
			return $mounts;
		}
		$workspaces = $adapters['recipe_workspaces']( $input );
		if ( is_wp_error( $workspaces ) ) {
			return $workspaces;
		}
		$runtime = $adapters['recipe_runtime']( $input, $wp_version, $dependency_plan );
		if ( is_wp_error( $runtime ) ) {
			return $runtime;
		}

		$site_seed_payload = $adapters['site_seed_recipe_entries']( $input );
		if ( is_wp_error( $site_seed_payload ) ) {
			return $site_seed_payload;
		}

		$component_manifest = self::component_manifest( $dependency_plan->component_plugins(), $dependency_plan->provider_plugins() );

		$recipe_inputs = array(
			'mounts'             => $mounts,
			'workspaces'         => $workspaces,
			'inherit'            => $dependency_plan->inheritance_request(),
			'inheritance'        => $dependency_plan->inheritance(),
			'extra_plugins'      => array_merge( $dependency_plan->component_plugins(), $dependency_plan->provider_plugins() ),
			'component_manifest' => $component_manifest,
			'runtimeEnv'         => array_merge( $adapters['runtime_env']( $input ), self::AGENT_RUNTIME_ENV ),
			'secretEnv'          => $dependency_plan->secret_env_names(),
		);
		if ( ! empty( $dependency_plan->agent_bundles() ) ) {
			$recipe_inputs['agent_bundles'] = $dependency_plan->agent_bundles();
		}
		if ( ! empty( $site_seed_payload['siteSeeds'] ) ) {
			$recipe_inputs['siteSeeds'] = $site_seed_payload['siteSeeds'];
		}

		$recipe = array(
			'schema'   => 'wp-codebox/workspace-recipe/v1',
			'runtime'  => $runtime,
			'inputs'   => $recipe_inputs,
			'workflow' => array( 'steps' => $steps ),
		);

		$file = tempnam( sys_get_temp_dir(), 'wp-codebox-recipe-' );
		if ( false === $file ) {
			return new WP_Error( 'wp_codebox_recipe_temp_failed', 'Could not create a temporary WP Codebox recipe.', array( 'status' => 500 ) );
		}

		$encoded = function_exists( 'wp_json_encode' ) ? wp_json_encode( $recipe, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE ) : json_encode( $recipe, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE );
		if ( ! is_string( $encoded ) || false === file_put_contents( $file, $encoded ) ) {
			@unlink( $file );
			foreach ( $site_seed_payload['cleanup_paths'] as $cleanup_path ) {
				@unlink( (string) $cleanup_path );
			}
			return new WP_Error( 'wp_codebox_recipe_write_failed', 'Could not write the temporary WP Codebox recipe.', array( 'status' => 500 ) );
		}

		return array(
			'path'          => $file,
			'cleanup_paths' => $site_seed_payload['cleanup_paths'],
		);
	}

	/**
	 * @param array<string,mixed> $input Ability input.
	 * @param array{connectors:array<int,array<string,mixed>>,settings:array<int,array<string,mixed>>} $inheritance Resolved inheritance metadata.
	 * @param array<int,array<string,mixed>> $component_plugins Prepared component plugin entries.
	 * @param array<string,callable> $adapters Runner adapters for host-specific policy and filesystem concerns.
	 */
	private static function runtime_dependency_plan_from_adapters( array $input, array $inheritance, array $component_plugins, array $adapters ): WP_Codebox_Runtime_Dependency_Plan {
		$provider_plugin_paths = $adapters['provider_plugin_paths']( $input, $inheritance );
		$provider_plugins      = array_map(
			static fn( string $path ): array => array(
				'source'   => $path,
				'slug'     => basename( $path ),
				'activate' => false,
			),
			$provider_plugin_paths
		);

		return new WP_Codebox_Runtime_Dependency_Plan(
			array(
				'agent'    => $adapters['agent_slug']( $input ),
				'mode'     => $adapters['mode']( $input ),
				'provider' => $adapters['provider']( $input, $inheritance ),
				'model'    => $adapters['model']( $input, $inheritance ),
			),
			$provider_plugin_paths,
			$provider_plugins,
			$component_plugins,
			is_array( $input['runtime_overlays'] ?? null ) ? $input['runtime_overlays'] : array(),
			$inheritance,
			$adapters['inheritance_request']( $input ),
			$adapters['agent_bundles']( $input ),
			$adapters['secret_env_names']( $input, $inheritance )
		);
	}

	/**
	 * @param array<int,array<string,mixed>> $component_plugins Prepared runtime component plugin entries.
	 * @param array<int,array<string,mixed>> $provider_plugins Provider plugin entries.
	 * @return array<string,mixed>
	 */
	private static function component_manifest( array $component_plugins, array $provider_plugins ): array {
		return array(
			'schema'     => 'wp-codebox/component-manifest/v1',
			'components' => array_values( array_map( array( self::class, 'component_manifest_plugin_entry' ), $component_plugins ) ),
			'providers'  => array_values( array_map( array( self::class, 'component_manifest_plugin_entry' ), $provider_plugins ) ),
		);
	}

	/** @param array<string,mixed> $plugin Prepared plugin entry. @return array<string,mixed> */
	private static function component_manifest_plugin_entry( array $plugin ): array {
		$metadata = is_array( $plugin['metadata'] ?? null ) ? $plugin['metadata'] : array();
		$contract = is_array( $metadata['componentContract'] ?? null ) ? $metadata['componentContract'] : array();

		return array_filter(
			array(
				'slug'          => (string) ( $plugin['slug'] ?? '' ),
				'source'        => (string) ( $plugin['source'] ?? '' ),
				'mountedPath'   => self::component_manifest_mounted_path( $plugin ),
				'entrypoint'    => (string) ( $plugin['pluginFile'] ?? '' ),
				'pluginFile'    => (string) ( $plugin['pluginFile'] ?? '' ),
				'loadAs'        => (string) ( $plugin['loadAs'] ?? '' ),
				'activate'      => isset( $plugin['activate'] ) ? (bool) $plugin['activate'] : null,
				'contractIndex' => isset( $contract['index'] ) ? (int) $contract['index'] : null,
				'requestedPath' => (string) ( $contract['requestedPath'] ?? '' ),
				'provenance'    => ! empty( $metadata ) ? $metadata : null,
			),
			static fn( mixed $value ): bool => null !== $value && '' !== $value
		);
	}

	/** @param array<string,mixed> $plugin Prepared plugin entry. */
	private static function component_manifest_mounted_path( array $plugin ): string {
		$slug = (string) ( $plugin['slug'] ?? '' );
		if ( '' === $slug ) {
			return '';
		}

		return 'mu-plugin' === (string) ( $plugin['loadAs'] ?? '' )
			? '/wordpress/wp-content/mu-plugins/wp-codebox-runtime/' . $slug
			: '/wordpress/wp-content/plugins/' . $slug;
	}
}
