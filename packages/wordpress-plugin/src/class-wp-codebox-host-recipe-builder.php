<?php
/**
 * Host-side sandbox recipe construction for agent task runs.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_Host_Recipe_Builder {

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

		$provider_plugins = array_map(
			static fn( string $path ): array => array(
				'source'   => $path,
				'slug'     => basename( $path ),
				'activate' => false,
			),
			$adapters['provider_plugin_paths']( $input, $inheritance )
		);

		$provider_slugs = array_map( static fn( array $plugin ): string => (string) $plugin['slug'], $provider_plugins );
		$agent_bundles  = $adapters['agent_bundles']( $input );
		$runtime_task   = $adapters['runtime_task']( $input );
		$steps          = array();
		foreach ( $task_prompts as $task_prompt ) {
			$task_input = $adapters['task_input']( array_merge( $input, array( 'goal' => $task_prompt ) ) );
			if ( is_wp_error( $task_input ) ) {
				return $task_input;
			}

			$args = array(
				'task=' . $task_prompt,
				'agent=' . $adapters['agent_slug']( $input ),
				'mode=' . $adapters['mode']( $input ),
				'provider=' . $adapters['provider']( $input, $inheritance ),
				'model=' . $adapters['model']( $input, $inheritance ),
				'provider-plugin-slugs=' . implode( ',', $provider_slugs ),
				'sandbox-tool-policy-json=' . $adapters['json_encode']( $task_input['sandbox_tool_policy'] ),
			);
			if ( ! empty( $agent_bundles ) ) {
				$args[] = 'agent-bundles-json=' . $adapters['json_encode']( $agent_bundles );
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
		$runtime = $adapters['recipe_runtime']( $input, $wp_version );
		if ( is_wp_error( $runtime ) ) {
			return $runtime;
		}

		$site_seed_payload = $adapters['site_seed_recipe_entries']( $input );
		if ( is_wp_error( $site_seed_payload ) ) {
			return $site_seed_payload;
		}

		$recipe_inputs = array(
			'mounts'        => $mounts,
			'workspaces'    => $workspaces,
			'inherit'       => $adapters['inheritance_request']( $input ),
			'inheritance'   => $inheritance,
			'extra_plugins' => array_merge( $adapters['component_plugins']( $paths ), $provider_plugins ),
			'runtimeEnv'    => $adapters['runtime_env']( $input ),
			'secretEnv'     => $adapters['secret_env_names']( $input, $inheritance ),
		);
		if ( ! empty( $agent_bundles ) ) {
			$recipe_inputs['agent_bundles'] = $agent_bundles;
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
}
