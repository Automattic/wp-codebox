<?php
/**
 * Internal Agents API task executor adapters for WP Codebox.
 *
 * These adapters let the upstream task runtime call Codebox-owned execution
 * targets. Consumer-facing integrations should use the wp-codebox/* abilities
 * and schemas registered by WP_Codebox_Abilities instead of upstream names.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

trait WP_Codebox_Abilities_Agents_API_Executors {

	private const AGENTS_API_TASK_INPUT_SCHEMA = 'agents-api/task-input/v1';

	private function register_agents_api_executor_adapters(): void {
		if ( ! function_exists( 'add_filter' ) ) {
			return;
		}

		add_filter( 'agents_api_executor_targets', array( self::class, 'register_agents_api_executor_targets' ) );
		add_filter( 'wp_agent_execution_targets', array( self::class, 'register_agents_api_executor_targets' ) );
		add_filter( 'wp_agent_executor_targets', array( self::class, 'register_agents_api_executor_targets' ) );
		add_filter( 'agents_api_execute_task', array( self::class, 'execute_agents_api_task' ), 10, 3 );
		add_filter( 'wp_agent_task_handler', array( self::class, 'execute_agents_api_task' ), 10, 2 );
	}

	/** @param mixed $targets Existing executor targets. @return array<int|string,mixed> */
	public static function register_agents_api_executor_targets( mixed $targets ): array {
		$targets = is_array( $targets ) ? $targets : array();
		foreach ( self::agents_api_executor_target_declarations() as $target ) {
			$targets[ (string) $target['id'] ] = $target;
		}

		return $targets;
	}

	/** @param mixed $pre Existing dispatch result. @param mixed $request Generic task request. @param mixed $target Target id or declaration. @return mixed */
	public static function execute_agents_api_task( mixed $pre, mixed $request, mixed $target = null ): mixed {
		if ( null !== $pre ) {
			return $pre;
		}

		$target_id = self::agents_api_executor_target_id( $target, $request );
		if ( ! in_array( $target_id, array( 'wp-codebox/browser-playground', 'wp-codebox/host-playground' ), true ) ) {
			return $pre;
		}

		if ( ! is_array( $request ) ) {
			return new WP_Error( 'wp_codebox_agents_api_task_request_invalid', 'Agents API task requests must be objects.', array( 'status' => 400 ) );
		}

		$input = self::agents_api_task_request_input( $request );
		return 'wp-codebox/browser-playground' === $target_id
			? self::create_browser_task_contract( $input )
			: self::run_agent_task( $input );
	}

	/** @return array<int,array<string,mixed>> */
	private static function agents_api_executor_target_declarations(): array {
		$task_input_schema          = self::agents_api_task_input_schema();
		$browser_task_output_schema = self::browser_task_contract_schema();
		$browser_task_output_schema['properties']['schema']['const'] = 'wp-codebox/browser-task-contract/v1';

		return array(
			array(
				'schema'       => 'agents-api/executor-target/v1',
				'id'           => 'wp-codebox/browser-playground',
				'label'        => 'WP Codebox Browser Playground',
				'description'  => 'Prepare the existing WP Codebox browser task contract for execution inside a browser-owned WordPress Playground.',
				'provider'     => 'wp-codebox',
				'kind'         => 'browser-playground',
				'capabilities' => array( 'wordpress-playground', 'browser-runtime', 'browser-task-contract' ),
				'input_schema'      => $task_input_schema,
				'output_schema'     => $browser_task_output_schema,
			),
			array(
				'schema'       => 'agents-api/executor-target/v1',
				'id'           => 'wp-codebox/host-playground',
				'label'        => 'WP Codebox Host Playground',
				'description'  => 'Run the existing WP Codebox host sandbox runner and return the wp-codebox/run-agent-task result shape.',
				'provider'     => 'wp-codebox',
				'kind'         => 'host-playground',
				'capabilities' => array( 'wordpress-playground', 'host-sandbox-runner', 'artifact-capture' ),
				'input_schema'      => $task_input_schema,
				'output_schema'     => array( 'type' => 'object' ),
			),
		);
	}

	/** @return array<string,mixed> */
	private static function agents_api_task_input_schema(): array {
		$schema = self::task_input_schema();
		$schema['$id'] = self::AGENTS_API_TASK_INPUT_SCHEMA;
		$schema['properties']['schema']['const'] = self::AGENTS_API_TASK_INPUT_SCHEMA;
		$schema['properties']['schema']['description'] = 'Generic Agents API task input schema id.';

		return $schema;
	}

	private static function agents_api_executor_target_id( mixed $target, mixed $request ): string {
		if ( is_string( $target ) ) {
			return $target;
		}
		if ( is_array( $target ) ) {
			return trim( (string) ( $target['id'] ?? $target['target'] ?? '' ) );
		}
		if ( is_array( $request ) ) {
			foreach ( array( 'executor_id', 'executor', 'target_id', 'target' ) as $field ) {
				if ( is_string( $request[ $field ] ?? null ) ) {
					return trim( (string) $request[ $field ] );
				}
				if ( is_array( $request[ $field ] ?? null ) ) {
					$nested = $request[ $field ];
					return trim( (string) ( $nested['id'] ?? $nested['target'] ?? '' ) );
				}
			}
		}

		return '';
	}

	/** @param array<string,mixed> $request Generic task request. @return array<string,mixed> */
	private static function agents_api_task_request_input( array $request ): array {
		foreach ( array( 'input', 'task_input' ) as $field ) {
			if ( is_array( $request[ $field ] ?? null ) ) {
				return self::agents_api_task_input( $request[ $field ], $request );
			}
		}

		return self::agents_api_task_input( $request, $request );
	}

	/** @param array<string,mixed> $input Task input. @param array<string,mixed> $request Full request. @return array<string,mixed> */
	private static function agents_api_task_input( array $input, array $request ): array {
		$normalized_workload = WP_Codebox_Agent_Workload::normalize_ability_input( $input );
		if ( ! is_wp_error( $normalized_workload ) ) {
			$input = $normalized_workload;
		}

		if ( self::AGENTS_API_TASK_INPUT_SCHEMA === (string) ( $input['schema'] ?? '' ) ) {
			$input['schema'] = WP_Codebox_Task_Input_Contract::SCHEMA;
		}

		$passthrough_fields = array(
			'agent',
			'mode',
			'provider',
			'model',
			'provider_plugin_paths',
			'agent_bundles',
			'runtime_task',
			'parent_request',
			'component_contracts',
			'mounts',
			'workspaces',
			'runtime_stack_mounts',
			'runtime_overlays',
			'inherit',
			'secret_env',
			'sandbox_session_id',
			'orchestrator',
			'session_id',
			'max_turns',
			'task_timeout_seconds',
			'preview_hold_seconds',
			'preview_port',
			'preview_bind',
			'preview_public_url',
			'wp',
			'artifacts_path',
			'wp_codebox_bin',
			'authorization',
			'playground',
			'browser_runner',
			'browser_plugins',
			'runtime',
			'blueprint',
			'site_blueprint_artifact',
			'artifact_files',
			'phases',
			'materializers',
		);

		foreach ( $passthrough_fields as $field ) {
			if ( ! array_key_exists( $field, $input ) && array_key_exists( $field, $request ) ) {
				$input[ $field ] = $request[ $field ];
			}
		}

		return $input;
	}
}
