<?php
/**
 * Host-side parent task request normalization for sandbox runner inputs.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_Host_Request_Normalizer {

	private const TASK_INPUT_SCHEMA = WP_Codebox_Agent_Task::INPUT_SCHEMA;
	private const DEFAULT_AGENT = 'sandbox-agent';
	private const DEFAULT_MODE = 'sandbox';

	/** @var callable */
	private $clean_path;

	/** @var callable */
	private $existing_host_directories;

	/** @var callable */
	private $runtime_env;

	/** @param callable|null $clean_path Host path cleaner. @param callable|null $existing_host_directories Existing host directory resolver. @param callable|null $runtime_env Runtime env normalizer. */
	public function __construct( ?callable $clean_path = null, ?callable $existing_host_directories = null, ?callable $runtime_env = null ) {
		$this->clean_path                = $clean_path ?? static fn( string $path ): string => WP_Codebox_Path_Policy::clean_host_path( $path );
		$this->existing_host_directories = $existing_host_directories ?? fn( array $paths ): array => $this->default_existing_host_directories( $paths );
		$this->runtime_env               = $runtime_env ?? fn( array $input ): array => $this->default_runtime_env( $input );
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public function normalize( array $input ): array|WP_Error {
		$request = is_array( $input['parent_request'] ?? null ) ? $input['parent_request'] : $input;
		$schema  = (string) ( $request['schema'] ?? '' );
		if ( self::TASK_INPUT_SCHEMA !== $schema ) {
			return $input;
		}

		$goal = trim( (string) ( $request['goal'] ?? '' ) );
		if ( '' === $goal ) {
			return new WP_Error( 'wp_codebox_parent_task_missing', 'parent_request.goal is required.', array( 'status' => 400 ) );
		}

		$context = is_array( $request['context'] ?? null ) ? $request['context'] : array();
		foreach ( array( 'sandbox_session_id', 'group_key', 'audit_findings', 'orchestrator' ) as $context_key ) {
			if ( array_key_exists( $context_key, $request ) ) {
				$context[ $context_key ] = $request[ $context_key ];
			}
		}

		$normalized = array_merge(
			$input,
			array_filter(
				array(
					'goal'                   => $goal,
					'target'                 => is_array( $request['target'] ?? null ) ? $request['target'] : array(),
					'allowed_tools'          => is_array( $request['allowed_tools'] ?? null ) ? $request['allowed_tools'] : array(),
					'parent_tool_bridge'     => is_array( $request['parent_tool_bridge'] ?? null ) ? $request['parent_tool_bridge'] : array(),
					'sandbox_tool_policy'    => is_array( $request['sandbox_tool_policy'] ?? null ) ? $request['sandbox_tool_policy'] : array(),
					'expected_artifacts'     => is_array( $request['expected_artifacts'] ?? null ) ? $request['expected_artifacts'] : array(),
					'policy'                 => is_array( $request['policy'] ?? null ) ? $request['policy'] : array(),
					'context'                => $context,
					'provider'               => (string) ( $input['provider'] ?? $request['provider'] ?? '' ),
					'model'                  => (string) ( $input['model'] ?? $request['model'] ?? '' ),
					'provider_plugin_paths'  => $this->merge_string_lists( $input['provider_plugin_paths'] ?? array(), $request['provider_plugin_paths'] ?? array() ),
					'agent_bundles'          => $this->agent_bundles( $input, $request ),
					'runtime_task'           => $this->runtime_task( $input, $request ),
					'component_contracts'    => $this->merge_array_lists( $input['component_contracts'] ?? array(), $request['component_contracts'] ?? array() ),
					'secret_env'             => $this->merge_string_lists( $input['secret_env'] ?? array(), $request['secret_env'] ?? array() ),
					'mounts'                 => $this->merge_array_lists( $input['mounts'] ?? array(), $request['mounts'] ?? array() ),
					'workspaces'             => $this->merge_array_lists( $input['workspaces'] ?? array(), $request['workspaces'] ?? array() ),
					'runtime_stack_mounts'   => $this->merge_array_lists( $input['runtime_stack_mounts'] ?? array(), $request['runtime_stack_mounts'] ?? array() ),
					'runtime_state_mounts'   => $this->merge_array_lists( $input['runtime_state_mounts'] ?? array(), $request['runtime_state_mounts'] ?? array() ),
					'runtime_config_mounts'  => $this->merge_array_lists( $input['runtime_config_mounts'] ?? array(), $request['runtime_config_mounts'] ?? array() ),
					'runtime_env'            => $this->merge_string_maps( $input['runtime_env'] ?? array(), $request['runtime_env'] ?? array() ),
					'runtime_overlays'       => $this->merge_array_lists( $input['runtime_overlays'] ?? array(), $request['runtime_overlays'] ?? array() ),
					'task_timeout_seconds'   => (int) ( $input['task_timeout_seconds'] ?? $request['task_timeout_seconds'] ?? 0 ),
					'max_turns'              => (int) ( $input['max_turns'] ?? $request['max_turns'] ?? 0 ),
					'sandbox_session_id'     => (string) ( $input['sandbox_session_id'] ?? $request['sandbox_session_id'] ?? '' ),
					'orchestrator'           => is_array( $input['orchestrator'] ?? null ) ? $input['orchestrator'] : ( is_array( $request['orchestrator'] ?? null ) ? $request['orchestrator'] : array() ),
					'artifacts_path'         => (string) ( $input['artifacts_path'] ?? $request['artifacts'] ?? '' ),
					'wp_codebox_bin'         => (string) ( $input['wp_codebox_bin'] ?? $request['wp_codebox_bin'] ?? '' ),
				),
				static fn( mixed $value ): bool => '' !== $value && array() !== $value && 0 !== $value
			)
		);

		unset( $normalized['parent_request'] );

		return $normalized;
	}

	/** @param array<string,mixed> $input Ability input. */
	public function agent_slug( array $input ): string {
		$agent = trim( (string) ( $input['agent'] ?? '' ) );
		if ( '' !== $agent ) {
			return $agent;
		}

		if ( function_exists( 'apply_filters' ) ) {
			$agent = (string) apply_filters( 'wp_codebox_default_agent', '' );
		}

		return '' !== trim( $agent ) ? trim( $agent ) : self::DEFAULT_AGENT;
	}

	/** @param array<string,mixed> $input Ability input. */
	public function mode( array $input ): string {
		$mode = trim( (string) ( $input['mode'] ?? '' ) );

		return '' !== $mode ? $mode : self::DEFAULT_MODE;
	}

	/** @param array<string,mixed> $input Ability input. */
	public function provider( array $input, ?array $inheritance = null ): string {
		$provider = trim( (string) ( $input['provider'] ?? '' ) );
		if ( '' !== $provider ) {
			return $provider;
		}

		$inheritance_provider = $this->inheritance_provider( $input, $inheritance );
		if ( '' !== $inheritance_provider ) {
			return $inheritance_provider;
		}

		if ( function_exists( 'apply_filters' ) ) {
			$provider = (string) apply_filters( 'wp_codebox_default_provider', '' );
		}

		return trim( $provider );
	}

	/** @param array<string,mixed> $input Ability input. */
	public function model( array $input, ?array $inheritance = null ): string {
		$model = trim( (string) ( $input['model'] ?? '' ) );
		if ( '' !== $model ) {
			return $model;
		}

		$inheritance_model = $this->inheritance_model( $input, $inheritance );
		if ( '' !== $inheritance_model ) {
			return $inheritance_model;
		}

		if ( function_exists( 'apply_filters' ) ) {
			$model = (string) apply_filters( 'wp_codebox_default_model', '' );
		}

		return trim( $model );
	}

	/** @param array<string,mixed> $input Ability input. @return string[] */
	public function provider_plugin_paths( array $input, ?array $inheritance = null ): array {
		$paths = is_array( $input['provider_plugin_paths'] ?? null ) ? $input['provider_plugin_paths'] : array();
		$paths = array_merge( $paths, $this->inheritance_provider_plugin_paths( $input, $inheritance ) );

		return call_user_func( $this->existing_host_directories, is_array( $paths ) ? $paths : array() );
	}

	/** @param array<string,mixed> $input Ability input. @return string[] */
	public function secret_env_names( array $input, ?array $inheritance = null ): array {
		$names = is_array( $input['secret_env'] ?? null ) ? $input['secret_env'] : array();
		$names = array_merge( $names, $this->inheritance_secret_env_names( $input, $inheritance ) );
		if ( empty( $names ) && function_exists( 'apply_filters' ) ) {
			$names = apply_filters( 'wp_codebox_default_secret_env', array() );
		}

		return array_values(
			array_unique(
				array_filter(
					array_map(
						static fn( $name ): string => trim( (string) $name ),
						is_array( $names ) ? $names : array()
					),
					static fn( string $name ): bool => 1 === preg_match( '/^[A-Z_][A-Z0-9_]*$/', $name )
				)
			)
		);
	}

	/** @param array<string,mixed> $input Ability input. @return array{connectors:string[],settings:string[]} */
	public function inheritance_request( array $input ): array {
		return WP_Codebox_Inheritance::request( $input );
	}

	/** @param array<string,mixed> $input Ability input. @return array{connectors:array<int,array<string,mixed>>,settings:array<int,array<string,mixed>>} */
	public function inheritance_resolution( array $input ): array {
		return $this->inheritance_resolution_payload( $input )['inheritance_audit'];
	}

	/** @param array<string,mixed> $input Ability input. @return array{inheritance_audit:array{connectors:array<int,array<string,mixed>>,settings:array<int,array<string,mixed>>},process_secret_env:array<string,string>} */
	public function inheritance_resolution_payload( array $input ): array {
		$payload = WP_Codebox_Inheritance::resolution_payload( $input, fn( string $path ): string => $this->clean_path( $path ) );
		$secret_env_names = $this->secret_env_names( $input, $payload['inheritance'] );

		return array(
			'inheritance_audit'  => $payload['inheritance'],
			'process_secret_env' => array_merge(
				$this->parent_process_secret_env_values( $secret_env_names ),
				$this->inheritance_process_secret_env_values( $payload['resolution']['connectors'] ?? array() )
			),
		);
	}

	/**
	 * @param array<string,mixed> $input Ability input.
	 * @param array{connectors:array<int,array<string,mixed>>,settings:array<int,array<string,mixed>>} $inheritance Resolved inheritance metadata.
	 * @param array<int,array<string,mixed>> $component_plugins Prepared component plugin entries.
	 */
	public function runtime_dependency_plan( array $input, array $inheritance, array $component_plugins ): WP_Codebox_Runtime_Dependency_Plan {
		$provider_plugin_paths = $this->provider_plugin_paths( $input, $inheritance );
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
				'agent'    => $this->agent_slug( $input ),
				'mode'     => $this->mode( $input ),
				'provider' => $this->provider( $input, $inheritance ),
				'model'    => $this->model( $input, $inheritance ),
			),
			$provider_plugin_paths,
			$provider_plugins,
			$component_plugins,
			is_array( $input['runtime_overlays'] ?? null ) ? $input['runtime_overlays'] : array(),
			$inheritance,
			$this->inheritance_request( $input ),
			$this->agent_bundles( $input ),
			$this->secret_env_names( $input, $inheritance ),
			$this->runtime_env( $input )
		);
	}

	/** @param array{connectors:array<int,array<string,mixed>>,settings:array<int,array<string,mixed>>} $inheritance */
	public function connector_credentials_error( array $inheritance ): WP_Error|null {
		return WP_Codebox_Inheritance::connector_credentials_error( $inheritance, 'Requested connector credentials are missing or denied for this sandbox scope.' );
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,string> */
	public function runtime_env( array $input ): array {
		return call_user_func( $this->runtime_env, $input );
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,string> */
	private function default_runtime_env( array $input ): array {
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
	private function default_existing_host_directories( array $paths ): array {
		return array_values(
			array_unique(
				array_filter(
					array_map(
						fn( $path ): string => $this->clean_path( (string) $path ),
						$paths
					),
					static fn( string $path ): bool => '' !== $path && is_dir( $path )
				)
			)
		);
	}

	/** @return string[] */
	private function string_list( mixed $values ): array {
		return WP_Codebox_Agent_Task::string_list( $values );
	}

	/** @return string[] */
	private function merge_string_lists( mixed ...$lists ): array {
		$merged = array();
		foreach ( $lists as $list ) {
			$merged = array_merge( $merged, $this->string_list( $list ) );
		}

		return array_values( array_unique( $merged ) );
	}

	/** @return array<string,string> */
	private function string_map( mixed $values ): array {
		if ( ! is_array( $values ) ) {
			return array();
		}

		$mapped = array();
		foreach ( $values as $name => $value ) {
			$name = trim( (string) $name );
			if ( '' !== $name && is_scalar( $value ) ) {
				$mapped[ $name ] = (string) $value;
			}
		}

		return $mapped;
	}

	/** @return array<string,string> */
	private function merge_string_maps( mixed ...$maps ): array {
		$merged = array();
		foreach ( $maps as $map ) {
			$merged = array_merge( $merged, $this->string_map( $map ) );
		}

		return $merged;
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

	/** @param array<string,mixed> $input Direct ability input. @param array<string,mixed> $request Parent request input. @return array<int,array<string,mixed>> */
	public function agent_bundles( array $input, array $request = array() ): array {
		$bundles    = $this->merge_array_lists( $input['agent_bundles'] ?? array(), $request['agent_bundles'] ?? array() );
		$normalized = array();
		foreach ( $bundles as $bundle ) {
			$source = isset( $bundle['source'] ) ? trim( (string) $bundle['source'] ) : '';
			$inline = is_array( $bundle['bundle'] ?? null ) ? $bundle['bundle'] : null;
			if ( '' === $source && null === $inline ) {
				continue;
			}

			$entry = array();
			if ( '' !== $source ) {
				$entry['source'] = $source;
			}
			if ( null !== $inline ) {
				$entry['bundle'] = $inline;
			}
			foreach ( array( 'slug', 'token_env' ) as $field ) {
				$value = isset( $bundle[ $field ] ) ? trim( (string) $bundle[ $field ] ) : '';
				if ( '' !== $value ) {
					$entry[ $field ] = $value;
				}
			}
			$on_conflict          = (string) ( $bundle['on_conflict'] ?? 'upgrade' );
			$entry['on_conflict'] = in_array( $on_conflict, array( 'error', 'skip', 'upgrade' ), true ) ? $on_conflict : 'upgrade';
			if ( isset( $bundle['owner_id'] ) && (int) $bundle['owner_id'] > 0 ) {
				$entry['owner_id'] = (int) $bundle['owner_id'];
			}
			if ( is_array( $bundle['import_principal'] ?? null ) ) {
				$entry['import_principal'] = $this->agent_bundle_import_principal( $bundle['import_principal'] );
			}

			$normalized[] = $entry;
		}

		return $normalized;
	}

	/** @param array<string,mixed> $input Ability input. @param array<string,mixed> $request Parent request input. @return array<string,mixed> */
	public function runtime_task( array $input, array $request = array() ): array {
		$candidates = array(
			$input['runtime_task'] ?? $input['runtimeTask'] ?? null,
			$request['runtime_task'] ?? $request['runtimeTask'] ?? null,
		);

		foreach ( $candidates as $bundle ) {
			if ( is_array( $bundle ) ) {
				return $bundle;
			}
		}

		return array();
	}

	/** @param array<string,mixed> $principal Raw import principal. @return array<string,mixed> */
	private function agent_bundle_import_principal( array $principal ): array {
		$normalized = array();
		foreach ( array( 'agent_id', 'owner_id', 'token_id' ) as $field ) {
			if ( isset( $principal[ $field ] ) && (int) $principal[ $field ] > 0 ) {
				$normalized[ $field ] = (int) $principal[ $field ];
			}
		}

		$capabilities = $this->string_list( $principal['capabilities'] ?? array() );
		if ( ! empty( $capabilities ) ) {
			$normalized['capabilities'] = $capabilities;
		}
		if ( is_array( $principal['scope'] ?? null ) ) {
			$normalized['scope'] = $principal['scope'];
		}

		return $normalized;
	}

	/** @param array<string,mixed> $input Ability input. */
	private function inheritance_provider( array $input, ?array $inheritance = null ): string {
		foreach ( ( $inheritance ?? $this->inheritance_resolution( $input ) )['connectors'] as $connector ) {
			$provider = trim( (string) ( $connector['provider'] ?? '' ) );
			if ( '' !== $provider ) {
				return $provider;
			}
		}

		return '';
	}

	/** @param array<string,mixed> $input Ability input. */
	private function inheritance_model( array $input, ?array $inheritance = null ): string {
		foreach ( ( $inheritance ?? $this->inheritance_resolution( $input ) )['connectors'] as $connector ) {
			$model = trim( (string) ( $connector['model'] ?? '' ) );
			if ( '' !== $model ) {
				return $model;
			}
		}

		return '';
	}

	/** @param array<string,mixed> $input Ability input. @return string[] */
	private function inheritance_provider_plugin_paths( array $input, ?array $inheritance = null ): array {
		$paths = array();
		foreach ( ( $inheritance ?? $this->inheritance_resolution( $input ) )['connectors'] as $connector ) {
			$paths = array_merge( $paths, $this->string_list( $connector['providerPluginPaths'] ?? array() ) );
		}

		return $paths;
	}

	/** @param array<string,mixed> $input Ability input. @return string[] */
	private function inheritance_secret_env_names( array $input, ?array $inheritance = null ): array {
		return WP_Codebox_Inheritance::secret_env_names( $inheritance ?? $this->inheritance_resolution( $input ) );
	}

	/** @param string[] $names Secret env names declared by the caller. @return array<string,string> */
	private function parent_process_secret_env_values( array $names ): array {
		$values = array();
		foreach ( $names as $name ) {
			$name = trim( (string) $name );
			if ( 1 !== preg_match( '/^[A-Z_][A-Z0-9_]*$/', $name ) ) {
				continue;
			}

			$value = getenv( $name );
			if ( false === $value && isset( $_ENV[ $name ] ) ) {
				$value = $_ENV[ $name ];
			}
			if ( false === $value && isset( $_SERVER[ $name ] ) ) {
				$value = $_SERVER[ $name ];
			}

			$value = false === $value ? '' : (string) $value;
			if ( '' !== $value ) {
				$values[ $name ] = $value;
			}
		}

		return $values;
	}

	/** @param array<int,mixed> $connectors Raw inheritance connector rows. @return array<string,string> */
	private function inheritance_process_secret_env_values( array $connectors ): array {
		$values = array();
		foreach ( $connectors as $connector ) {
			if ( is_array( $connector ) ) {
				$values = array_merge( $values, $this->process_secret_env_values_from_connector( $connector ) );
			}
		}

		return $values;
	}

	/** @param array<string,mixed> $connector Raw inheritance connector row. @return array<string,string> */
	private function process_secret_env_values_from_connector( array $connector ): array {
		$values = array();
		foreach ( array( 'secret_env_values', 'secretEnvValues' ) as $field ) {
			if ( is_array( $connector[ $field ] ?? null ) ) {
				$values = array_merge( $values, $this->sanitize_process_secret_env_values( $connector[ $field ] ) );
			}
		}

		$credentials = is_array( $connector['credentials'] ?? null ) ? $connector['credentials'] : array();
		foreach ( is_array( $credentials['secrets'] ?? null ) ? $credentials['secrets'] : array() as $secret ) {
			if ( ! is_array( $secret ) || ! isset( $secret['value'] ) ) {
				continue;
			}

			$name = trim( (string) ( $secret['name'] ?? '' ) );
			if ( 1 === preg_match( '/^[A-Z_][A-Z0-9_]*$/', $name ) ) {
				$value = (string) $secret['value'];
				if ( '' !== $value ) {
					$values[ $name ] = $value;
				}
			}
		}

		return $values;
	}

	/** @param array<mixed> $raw_values Raw secret env map. @return array<string,string> */
	private function sanitize_process_secret_env_values( array $raw_values ): array {
		$values = array();
		foreach ( $raw_values as $name => $value ) {
			$name = trim( (string) $name );
			if ( 1 !== preg_match( '/^[A-Z_][A-Z0-9_]*$/', $name ) ) {
				continue;
			}

			$value = (string) $value;
			if ( '' !== $value ) {
				$values[ $name ] = $value;
			}
		}

		return $values;
	}

	private function clean_path( string $path ): string {
		return (string) call_user_func( $this->clean_path, $path );
	}
}
