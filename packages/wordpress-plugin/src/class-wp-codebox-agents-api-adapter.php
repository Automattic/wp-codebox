<?php
/**
 * WP Codebox facade for the Agents API ability boundary.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

/**
 * Advanced internal adapter around the upstream Agents API abilities.
 *
 * Consumers should depend on this class instead of importing Agents API constants,
 * handler names, or execution principal internals.
 *
 * @internal Adapter boundary for WP Codebox runtime integration.
 */
final class WP_Codebox_Agents_API_Adapter {

	public const CHAT                 = 'agents/chat';
	public const RUN_TASK             = 'agents/run-task';
	public const RUN_RUNTIME_PACKAGE  = 'agents/run-runtime-package';
	public const GET_TASK_RUN         = 'agents/get-task-run';
	public const CANCEL_TASK_RUN      = 'agents/cancel-task-run';
	public const GET_CHAT_RUN         = 'agents/get-chat-run';
	public const CANCEL_CHAT_RUN      = 'agents/cancel-chat-run';
	public const QUEUE_CHAT_MESSAGE   = 'agents/queue-chat-message';
	public const LIST_CHAT_RUN_EVENTS = 'agents/list-chat-run-events';

	public const TASK_INPUT_SCHEMA      = 'agents-api/task-input/v1';
	public const EXECUTOR_TARGET_SCHEMA = 'agents-api/executor-target/v1';
	public const BROWSER_TARGET         = 'wp-codebox/browser-playground';
	public const HOST_TARGET            = 'wp-codebox/host-playground';
	public const IMPORT_RUNTIME_BUNDLES_FUNCTION = 'wp_agent_import_runtime_bundles';
	public const RUNTIME_BUNDLE_IMPORT_FILTER = 'wp_agent_runtime_import_bundle';
	public const LEGACY_RESOLVED_TOOLS_FILTER = 'agents_api_resolved_tools';
	public const RUNTIME_RESOLVED_TOOLS_FILTER = 'wp_agent_runtime_resolved_tools';
	public const CHAT_RUNTIME_PRINCIPAL_PERMISSION_FILTER = 'agents_chat_runtime_principal_permission';

	private const EXECUTOR_TARGET_FILTERS = array(
		'agents_api_executor_targets',
		'wp_agent_execution_targets',
		'wp_agent_executor_targets',
	);

	private const EXECUTE_TASK_FILTERS = array(
		'agents_api_execute_task' => 3,
		'wp_agent_task_handler'   => 2,
	);

	/** @return array<string,string> */
	public static function ability_names(): array {
		return array(
			'chat'                 => self::CHAT,
			'run_task'             => self::RUN_TASK,
			'run_runtime_package'  => self::RUN_RUNTIME_PACKAGE,
			'get_task_run'         => self::GET_TASK_RUN,
			'cancel_task_run'      => self::CANCEL_TASK_RUN,
			'get_chat_run'         => self::GET_CHAT_RUN,
			'cancel_chat_run'      => self::CANCEL_CHAT_RUN,
			'queue_chat_message'   => self::QUEUE_CHAT_MESSAGE,
			'list_chat_run_events' => self::LIST_CHAT_RUN_EVENTS,
		);
	}

	public static function default_chat_ability(): string {
		return self::CHAT;
	}

	public static function import_runtime_bundles_function(): string {
		return self::IMPORT_RUNTIME_BUNDLES_FUNCTION;
	}

	public static function runtime_bundle_import_filter(): string {
		return self::RUNTIME_BUNDLE_IMPORT_FILTER;
	}

	public static function runtime_resolved_tools_filter(): string {
		return self::RUNTIME_RESOLVED_TOOLS_FILTER;
	}

	public static function legacy_resolved_tools_filter(): string {
		return self::LEGACY_RESOLVED_TOOLS_FILTER;
	}

	public static function chat_runtime_principal_permission_filter(): string {
		return self::CHAT_RUNTIME_PRINCIPAL_PERMISSION_FILTER;
	}

	/** @return array<int,string> */
	public static function runtime_bundle_importer_paths(): array {
		$paths = array();
		if ( defined( 'AGENTS_API_PATH' ) ) {
			$paths[] = trailingslashit( AGENTS_API_PATH ) . 'src/Registry/register-agent-runtime-bundle-importer.php';
		}
		if ( defined( 'WP_PLUGIN_DIR' ) ) {
			$paths[] = trailingslashit( WP_PLUGIN_DIR ) . 'agents-api/src/Registry/register-agent-runtime-bundle-importer.php';
		}

		return $paths;
	}

	public static function register_executor_adapters( callable $target_callback, callable $execute_callback ): void {
		if ( ! function_exists( 'add_filter' ) ) {
			return;
		}

		foreach ( self::EXECUTOR_TARGET_FILTERS as $hook ) {
			add_filter( $hook, $target_callback );
		}
		foreach ( self::EXECUTE_TASK_FILTERS as $hook => $accepted_args ) {
			add_filter( $hook, $execute_callback, 10, $accepted_args );
		}
	}

	/** @param array<string,mixed> $task_input_schema Codebox task input schema. @return array<string,mixed> */
	public static function task_input_schema( array $task_input_schema ): array {
		$task_input_schema['$id'] = self::TASK_INPUT_SCHEMA;
		$task_input_schema['properties']['schema']['const'] = self::TASK_INPUT_SCHEMA;
		$task_input_schema['properties']['schema']['description'] = 'Generic Agents API task input schema id.';

		return $task_input_schema;
	}

	/** @param array<string,mixed> $task_input_schema Agents API task input schema. @param array<string,mixed> $browser_output_schema Browser task output schema. @return array<int,array<string,mixed>> */
	public static function executor_target_declarations( array $task_input_schema, array $browser_output_schema ): array {
		$browser_output_schema['properties']['schema']['const'] = 'wp-codebox/browser-task-contract/v1';

		return array(
			array(
				'schema'        => self::EXECUTOR_TARGET_SCHEMA,
				'id'            => self::BROWSER_TARGET,
				'label'         => 'WP Codebox Browser Playground',
				'description'   => 'Prepare the existing WP Codebox browser task contract for execution inside a browser-owned WordPress Playground.',
				'provider'      => 'wp-codebox',
				'kind'          => 'browser-playground',
				'capabilities'  => array( 'wordpress-playground', 'browser-runtime', 'browser-task-contract' ),
				'input_schema'  => $task_input_schema,
				'output_schema' => $browser_output_schema,
			),
			array(
				'schema'        => self::EXECUTOR_TARGET_SCHEMA,
				'id'            => self::HOST_TARGET,
				'label'         => 'WP Codebox Host Playground',
				'description'   => 'Run the existing WP Codebox host sandbox runner and return the wp-codebox/run-agent-task result shape.',
				'provider'      => 'wp-codebox',
				'kind'          => 'host-playground',
				'capabilities'  => array( 'wordpress-playground', 'host-sandbox-runner', 'artifact-capture' ),
				'input_schema'  => $task_input_schema,
				'output_schema' => array( 'type' => 'object' ),
			),
		);
	}

	public static function executor_target_id( mixed $target, mixed $request ): string {
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
	public static function task_request_input( array $request ): array {
		foreach ( array( 'input', 'task_input' ) as $field ) {
			if ( is_array( $request[ $field ] ?? null ) ) {
				return self::task_input( $request[ $field ], $request );
			}
		}

		return self::task_input( $request, $request );
	}

	/** @param array<string,mixed> $input Task input. @param array<string,mixed> $request Full request. @return array<string,mixed> */
	private static function task_input( array $input, array $request ): array {
		$normalized_workload = WP_Codebox_Agent_Workload::normalize_ability_input( $input );
		if ( ! is_wp_error( $normalized_workload ) ) {
			$input = $normalized_workload;
		}

		if ( self::TASK_INPUT_SCHEMA === (string) ( $input['schema'] ?? '' ) ) {
			$input['schema'] = WP_Codebox_Task_Input_Contract::SCHEMA;
		}

		foreach ( self::task_passthrough_fields() as $field ) {
			if ( ! array_key_exists( $field, $input ) && array_key_exists( $field, $request ) ) {
				$input[ $field ] = $request[ $field ];
			}
		}

		return $input;
	}

	/** @return array<int,string> */
	private static function task_passthrough_fields(): array {
		return array(
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
	}

	public function is_available( string $ability_name ): bool {
		return '' !== $ability_name && function_exists( 'wp_get_ability' ) && (bool) wp_get_ability( $ability_name );
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public function chat( array $input ): array|WP_Error {
		return $this->execute( self::CHAT, $input );
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public function run_task( array $input ): array|WP_Error {
		return $this->execute( self::RUN_TASK, $input );
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public function run_runtime_package( array $input ): array|WP_Error {
		return $this->execute( self::RUN_RUNTIME_PACKAGE, $input );
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public function get_task_run( array $input ): array|WP_Error {
		return $this->execute( self::GET_TASK_RUN, $input );
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public function cancel_task_run( array $input ): array|WP_Error {
		return $this->execute( self::CANCEL_TASK_RUN, $input );
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public function get_chat_run( array $input ): array|WP_Error {
		return $this->execute( self::GET_CHAT_RUN, $input );
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public function cancel_chat_run( array $input ): array|WP_Error {
		return $this->execute( self::CANCEL_CHAT_RUN, $input );
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public function queue_chat_message( array $input ): array|WP_Error {
		return $this->execute( self::QUEUE_CHAT_MESSAGE, $input );
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public function list_chat_run_events( array $input ): array|WP_Error {
		return $this->execute( self::LIST_CHAT_RUN_EVENTS, $input );
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public function execute( string $ability_name, array $input ): array|WP_Error {
		if ( '' === $ability_name || ! function_exists( 'wp_get_ability' ) ) {
			return new WP_Error( 'wp_codebox_agents_api_unavailable', 'The Agents API ability registry is unavailable.', array( 'status' => 500, 'ability' => $ability_name ) );
		}

		$ability = wp_get_ability( $ability_name );
		if ( ! $ability || ! method_exists( $ability, 'execute' ) ) {
			return new WP_Error( 'wp_codebox_agents_api_ability_unavailable', 'The requested Agents API ability is unavailable.', array( 'status' => 500, 'ability' => $ability_name ) );
		}

		$result = $ability->execute( $input );
		if ( is_wp_error( $result ) ) {
			return $result;
		}

		if ( ! is_array( $result ) ) {
			return new WP_Error( 'wp_codebox_agents_api_invalid_result', 'The requested Agents API ability returned an invalid result.', array( 'status' => 500, 'ability' => $ability_name ) );
		}

		return $result;
	}
}
