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
 * Internal runtime code uses this adapter instead of importing Agents API
 * constants, handler names, or execution principal internals. Consumers should
 * call WP_Codebox_API or wp-codebox/* abilities.
 *
 * @internal Adapter boundary for WP Codebox runtime integration.
 */
final class WP_Codebox_Agents_API_Adapter {

	private const CHAT                 = 'agents/chat';
	private const RUN_TASK             = 'agents/run-task';
	private const RUN_RUNTIME_PACKAGE  = 'wp-codebox/run-runtime-package';
	private const GET_TASK_RUN         = 'agents/get-task-run';
	private const CANCEL_TASK_RUN      = 'agents/cancel-task-run';
	private const GET_CHAT_RUN         = 'agents/get-chat-run';
	private const CANCEL_CHAT_RUN      = 'agents/cancel-chat-run';
	private const QUEUE_CHAT_MESSAGE   = 'agents/queue-chat-message';
	private const LIST_CHAT_RUN_EVENTS = 'agents/list-chat-run-events';

	private const EXECUTOR_TARGET_SCHEMA = 'wp-codebox/executor-target/v1';
	private const RUNTIME_PACKAGE_TASK_SCHEMA = 'wp-codebox/runtime-package-task/v1';
	private const BROWSER_TARGET         = 'wp-codebox/browser-playground';
	private const HOST_TARGET            = 'wp-codebox/host-playground';
	private const IMPORT_RUNTIME_BUNDLES_FUNCTION = 'wp_agent_import_runtime_bundles';
	private const RUNTIME_BUNDLE_IMPORT_FILTER = 'wp_agent_runtime_import_bundle';
	private const RUNTIME_RESOLVED_TOOLS_FILTER = 'wp_agent_runtime_resolved_tools';
	private const CHAT_RUNTIME_PRINCIPAL_PERMISSION_FILTER = 'agents_chat_runtime_principal_permission';
	private const SANDBOX_AGENT = 'wp-codebox-sandbox';

	private const RESPONSE_SCHEMAS = array(
		self::CHAT                 => 'wp-codebox/agent-chat-result/v1',
		self::RUN_TASK             => 'wp-codebox/agent-task-result/v1',
		self::RUN_RUNTIME_PACKAGE  => 'wp-codebox/runtime-package-result/v1',
		self::GET_TASK_RUN         => 'wp-codebox/agent-task-run/v1',
		self::CANCEL_TASK_RUN      => 'wp-codebox/agent-task-cancel-result/v1',
		self::GET_CHAT_RUN         => 'wp-codebox/agent-chat-run/v1',
		self::CANCEL_CHAT_RUN      => 'wp-codebox/agent-chat-cancel-result/v1',
		self::QUEUE_CHAT_MESSAGE   => 'wp-codebox/agent-chat-message-result/v1',
		self::LIST_CHAT_RUN_EVENTS => 'wp-codebox/agent-chat-run-events/v1',
	);

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

	public static function browser_executor_target_id(): string {
		return self::BROWSER_TARGET;
	}

	public static function host_executor_target_id(): string {
		return self::HOST_TARGET;
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

	public static function register_runtime_profiles(): void {
		if ( ! function_exists( 'add_filter' ) ) {
			return;
		}

		add_filter( 'wp_codebox_runtime_profile_registry', array( self::class, 'runtime_profile_registry' ) );
		add_filter( 'wp_codebox_browser_runtime_required_components', array( self::class, 'browser_runtime_required_components' ) );
		add_filter( 'wp_codebox_browser_runtime_default_invocation', array( self::class, 'browser_runtime_default_invocation' ) );
		add_filter( 'wp_codebox_browser_runtime_default_ability', array( self::class, 'default_chat_ability' ) );
		add_filter( 'wp_codebox_browser_runtime_ability_names', array( self::class, 'ability_names' ) );
		add_filter( 'wp_codebox_browser_runtime_bundle_import_function', array( self::class, 'import_runtime_bundles_function' ) );
		add_filter( 'wp_codebox_browser_runtime_bundle_import_filter', array( self::class, 'runtime_bundle_import_filter' ) );
		add_filter( 'wp_codebox_browser_runtime_bundle_importer_paths', array( self::class, 'runtime_bundle_importer_paths' ) );
		add_filter( 'wp_codebox_browser_runtime_principal_permission_filter', array( self::class, 'chat_runtime_principal_permission_filter' ) );
		add_filter( 'wp_codebox_browser_runtime_invocation_input', array( self::class, 'browser_runtime_invocation_input' ), 10, 4 );
		add_filter( 'wp_codebox_browser_runtime_principal_permission', array( self::class, 'browser_runtime_principal_permission' ), 10, 4 );
		add_filter( 'wp_codebox_browser_runtime_executor_target', array( self::class, 'browser_executor_target_id' ) );
		add_filter( 'wp_codebox_browser_runtime_resolved_tools_filter', array( self::class, 'runtime_resolved_tools_filter' ) );
	}

	public static function register_runtime_provider(): void {
		if ( ! class_exists( 'WP_Codebox_Runtime_Provider_Registry' ) ) {
			return;
		}

		WP_Codebox_Runtime_Provider_Registry::register(
			'agents-api-adapter',
			array( new self(), 'run_runtime_package' ),
			array(
				'label'        => 'Agents API runtime adapter',
				'kind'         => 'ability-adapter',
				'public_id'    => 'codebox-agent-runtime',
				'public_label' => 'Codebox agent runtime',
				'public_kind'  => 'runtime-profile',
				'capabilities' => array( 'codebox.runtime-package' ),
				'default'      => false,
			)
		);
	}

	public static function register_sandbox_agent(): void {
		if ( ! function_exists( 'wp_register_agent' ) ) {
			return;
		}
		if ( function_exists( 'wp_has_agent' ) && wp_has_agent( self::SANDBOX_AGENT ) ) {
			return;
		}

		wp_register_agent(
			self::SANDBOX_AGENT,
			array(
				'label'       => 'WP Codebox Sandbox',
				'description' => 'Default runtime agent for executing WP Codebox tasks inside disposable sandbox environments.',
				'meta'        => array(
					'source_plugin'  => 'wp-codebox',
					'source_type'    => 'plugin-default',
					'source_package' => 'wp-codebox',
				),
			)
		);
	}

	public static function register_if_available(): void {
		self::register_runtime_profiles();
		self::register_runtime_provider();
	}

	private static function should_register_adapter(): bool {
		if ( ( new self() )->is_available( self::RUN_RUNTIME_PACKAGE ) ) {
			return true;
		}

		$configured_default = class_exists( 'WP_Codebox_Runtime_Provider_Registry' ) ? WP_Codebox_Runtime_Provider_Registry::default_provider() : '';
		if ( in_array( $configured_default, array( 'agents-api-adapter', 'agents-api', 'agents-runtime', 'wordpress-agents-api-runtime' ), true ) ) {
			return true;
		}

		return function_exists( 'apply_filters' ) && (bool) apply_filters( 'wp_codebox_agents_api_adapter_enabled', false );
	}

	/** @param array<string,mixed> $input Runtime input. @param array<string,mixed> $defaults Caller defaults. @return array<string,string> */
	public static function browser_runtime_default_invocation( array $input = array(), array $defaults = array() ): array {
		if ( ! empty( self::runtime_task_from_browser_input( $input, $defaults ) ) ) {
			return array(
				'type' => 'ability',
				'name' => self::RUN_RUNTIME_PACKAGE,
			);
		}

		return array(
			'type' => 'ability',
			'name' => self::default_chat_ability(),
		);
	}

	/** @param array<string,mixed> $input Runtime input. @param array<string,mixed> $payload Browser payload. @param array<string,mixed> $invocation Runtime invocation. @return array<string,mixed> */
	public static function browser_runtime_invocation_input( array $input, array $payload, array $invocation, string $session_id ): array {
		if ( 'ability' !== (string) ( $invocation['type'] ?? 'ability' ) ) {
			return $input;
		}

		$ability_name = (string) ( $invocation['name'] ?? '' );
		if ( '' === $ability_name || ! in_array( $ability_name, self::ability_names(), true ) ) {
			return $input;
		}
		if ( self::RUN_RUNTIME_PACKAGE === $ability_name ) {
			$runtime_task_input = self::runtime_package_input_from_runtime_task( self::runtime_task_from_browser_payload( $payload ) );
			if ( ! empty( $runtime_task_input ) ) {
				$input = array_replace_recursive( $input, $runtime_task_input );
			}
		}

		$agent = sanitize_key( (string) ( $payload['agent'] ?? $input['agent'] ?? '' ) );
		if ( '' === $agent ) {
			$agent = self::SANDBOX_AGENT;
		}
		$input['agent'] = $agent;
		$input['principal'] = array(
			'acting_user_id'     => 0,
			'effective_agent_id' => $agent,
			'auth_source'        => 'runtime',
			'request_context'    => 'runtime',
			'token_id'           => null,
			'request_metadata'   => array(
				'source'             => 'wp-codebox',
				'mode'               => 'browser-playground',
				'codebox_session_id' => $session_id,
			),
			'workspace_id'       => 'wp-codebox',
			'client_id'          => 'wp-codebox-browser-runner',
			'audience_id'        => $session_id,
			'audience_claims'    => array(
				'runtime_type' => 'wordpress-playground',
			),
			'owner_type'         => 'runtime',
			'owner_key'          => $session_id,
		);

		$input['client_context']['source'] = 'peer-agent';
		$input['client_context']['peer_agent_call'] = true;

		return $input;
	}

	/** @param array<string,mixed> $input Runtime input. @param array<string,mixed> $defaults Caller defaults. @return array<string,mixed> */
	private static function runtime_task_from_browser_input( array $input, array $defaults = array() ): array {
		foreach ( array( $input, $defaults ) as $candidate ) {
			$runtime_task = self::runtime_task_from_candidate( $candidate );
			if ( ! empty( $runtime_task ) ) {
				return $runtime_task;
			}
		}

		return array();
	}

	/** @param array<string,mixed> $payload Browser runtime payload. @return array<string,mixed> */
	private static function runtime_task_from_browser_payload( array $payload ): array {
		$task_input = is_array( $payload['task_input'] ?? null ) ? $payload['task_input'] : array();

		return self::runtime_task_from_candidate( $task_input );
	}

	/** @param array<string,mixed> $candidate Runtime input candidate. @return array<string,mixed> */
	private static function runtime_task_from_candidate( array $candidate ): array {
		if ( is_array( $candidate['runtime_task'] ?? null ) ) {
			return $candidate['runtime_task'];
		}
		if ( is_array( $candidate['runtimeTask'] ?? null ) ) {
			return $candidate['runtimeTask'];
		}

		$agent_runtime = $candidate['agent_runtime'] ?? $candidate['agentRuntime'] ?? null;
		if ( is_array( $agent_runtime ) ) {
			if ( is_array( $agent_runtime['runtime_task'] ?? null ) ) {
				return $agent_runtime['runtime_task'];
			}
			if ( is_array( $agent_runtime['runtimeTask'] ?? null ) ) {
				return $agent_runtime['runtimeTask'];
			}
		}

		return array();
	}

	/** @param array<string,mixed> $runtime_task Runtime task descriptor. @return array<string,mixed> */
	private static function runtime_package_input_from_runtime_task( array $runtime_task ): array {
		if ( is_array( $runtime_task['input'] ?? null ) && self::RUN_RUNTIME_PACKAGE === (string) ( $runtime_task['ability'] ?? '' ) ) {
			return $runtime_task['input'];
		}
		if ( is_array( $runtime_task['input'] ?? null ) && 'bundle' === (string) ( $runtime_task['kind'] ?? '' ) ) {
			return $runtime_task['input'];
		}

		return $runtime_task;
	}

	/** @param array<string,mixed> $permission_input Permission input. */
	public static function browser_runtime_principal_permission( bool $allowed, mixed $principal, array $permission_input, string $session_id ): bool {
		if ( ! class_exists( 'AgentsAPI\\AI\\WP_Agent_Execution_Principal' ) || ! $principal instanceof AgentsAPI\AI\WP_Agent_Execution_Principal ) {
			return $allowed;
		}
		if ( 'runtime' !== $principal->auth_source || 'runtime' !== $principal->request_context ) {
			return $allowed;
		}
		if ( 'wp-codebox-browser-runner' !== $principal->client_id || 'wp-codebox' !== $principal->workspace_id || 'runtime' !== $principal->owner_type ) {
			return $allowed;
		}
		if ( $session_id !== $principal->audience_id || $session_id !== $principal->owner_key ) {
			return $allowed;
		}
		if ( 'wordpress-playground' !== (string) ( $principal->audience_claims['runtime_type'] ?? '' ) ) {
			return $allowed;
		}

		return 'wp-codebox' === (string) ( $permission_input['principal']['workspace_id'] ?? '' ) && 'wp-codebox-browser-runner' === (string) ( $permission_input['principal']['client_id'] ?? '' );
	}

	/** @param array<string,array<string,mixed>> $registry Runtime profile registry. @return array<string,array<string,mixed>> */
	public static function runtime_profile_registry( array $registry ): array {
		$registry['agents-api-adapter'] = array(
			'id'                     => 'agents-api-adapter',
			'label'                  => 'Agents API runtime adapter',
			'aliases'                => array( 'agents-api', 'agents-runtime', 'wordpress-agents-api-runtime' ),
			'capabilities'           => array( 'agents.runtime' ),
			'public_capabilities'    => array( 'codebox.agent-runtime' ),
			'requires'                => array( 'codebox-agent-runtime' ),
			'components'              => array( array( 'slug' => 'agents-api' ) ),
			'placement_capabilities' => array( 'agents.runtime' ),
			'provenance'             => array( 'adapter' => self::class ),
		);

		// WP Codebox is the agentic runtime: selecting codebox-agent-runtime must
		// provision the runtime substrate (agents-api) by default, so consumers
		// supply domain inputs (bundle, goal, provider selection) only and never
		// hand-inject the runtime plugins themselves.
		$registry['codebox-agent-runtime'] = self::merge_default_components(
			is_array( $registry['codebox-agent-runtime'] ?? null ) ? $registry['codebox-agent-runtime'] : array(),
			self::default_runtime_component_slugs()
		);

		return $registry;
	}

	/**
	 * Default runtime substrate component slugs provisioned for the agent runtime.
	 *
	 * Minimal set proven from code: agents-api ships its own conversation loop,
	 * workflow runner, and bundle importer, so it runs worker bundles + the agent
	 * loop without Data Machine. The selected AI provider plugin is provisioned
	 * separately via the provider profile. Both resolve from the host's installed
	 * copies. A host/deploy that needs additional substrate (e.g. data-machine /
	 * data-machine-code for bundles that use those abilities) adds slugs through
	 * this filter and supplies a source via the component registry/contract or
	 * host plugin roots filter.
	 *
	 * @return array<int,string>
	 */
	private static function default_runtime_component_slugs(): array {
		$slugs = array( 'agents-api' );
		if ( function_exists( 'apply_filters' ) ) {
			$filtered = apply_filters( 'wp_codebox_agent_runtime_default_components', $slugs );
			if ( is_array( $filtered ) ) {
				$slugs = $filtered;
			}
		}

		$normalized = array();
		foreach ( $slugs as $slug ) {
			$slug = function_exists( 'sanitize_key' ) ? sanitize_key( (string) $slug ) : strtolower( trim( (string) $slug ) );
			if ( '' !== $slug && ! in_array( $slug, $normalized, true ) ) {
				$normalized[] = $slug;
			}
		}

		return $normalized;
	}

	/**
	 * Required browser runtime component slugs.
	 *
	 * Ensures the runtime substrate installs even on the required-only browser
	 * path (when provider plugin paths, connectors, or secret env are present)
	 * in addition to when the codebox-agent-runtime profile declares it.
	 *
	 * @param array<int,string> $slugs Required component slugs.
	 * @return array<int,string>
	 */
	public static function browser_runtime_required_components( array $slugs = array() ): array {
		foreach ( self::default_runtime_component_slugs() as $slug ) {
			if ( ! in_array( $slug, $slugs, true ) ) {
				$slugs[] = $slug;
			}
		}

		return $slugs;
	}

	/**
	 * Merges default component slugs into a runtime profile registry entry.
	 *
	 * @param array<string,mixed> $profile Profile registry entry.
	 * @param array<int,string>   $slugs   Default component slugs.
	 * @return array<string,mixed>
	 */
	private static function merge_default_components( array $profile, array $slugs ): array {
		$components = is_array( $profile['components'] ?? null ) ? $profile['components'] : array();
		$existing   = array();
		foreach ( $components as $component ) {
			$existing[] = is_array( $component ) ? (string) ( $component['slug'] ?? '' ) : (string) $component;
		}

		foreach ( $slugs as $slug ) {
			if ( ! in_array( $slug, $existing, true ) ) {
				$components[] = array( 'slug' => $slug );
			}
		}

		$profile['components'] = $components;

		return $profile;
	}

	/** @param array<string,mixed> $task_input_schema Codebox task input schema. @return array<string,mixed> */
	public static function task_input_schema( array $task_input_schema ): array {
		$task_input_schema['$id'] = WP_Codebox_Task_Input_Contract::SCHEMA;
		$task_input_schema['properties']['schema']['const'] = WP_Codebox_Task_Input_Contract::SCHEMA;
		$task_input_schema['properties']['schema']['description'] = 'WP Codebox task input schema id.';

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

		if ( str_starts_with( (string) ( $input['schema'] ?? '' ), 'agents-api/' ) ) {
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
			'staged_files',
			'stagedFiles',
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
		$input = self::normalize_runtime_package_task_for_agents_api( $input );
		$input = self::stage_runtime_package_wordpress_workload_files( $input );
		$input = self::runtime_package_options_for_agents_api( $input );

		return $this->execute( self::RUN_RUNTIME_PACKAGE, $input );
	}

	/** @param array<string,mixed> $input Runtime input. @return array<string,mixed> */
	private static function normalize_runtime_package_task_for_agents_api( array $input ): array {
		$metadata = is_array( $input['metadata'] ?? null ) ? $input['metadata'] : array();
		if ( ! is_array( $input['package'] ?? null ) ) {
			$descriptor = is_array( $metadata['runtime_package_descriptor'] ?? null ) ? $metadata['runtime_package_descriptor'] : array();
			if ( ! empty( $descriptor ) ) {
				$input['package'] = $descriptor;
			} elseif ( isset( $input['runtime_package'] ) ) {
				$input['package'] = self::package_descriptor_from_runtime_package( (string) $input['runtime_package'] );
			}
		}

		if ( is_array( $input['package'] ?? null ) ) {
			$input['package'] = self::package_descriptor_for_runtime( $input['package'], $input );
		}
		$input = self::runtime_package_workflow_for_agents_api( $input );
		$input = self::runtime_package_required_artifacts_for_agents_api( $input );
		if ( self::RUNTIME_PACKAGE_TASK_SCHEMA === (string) ( $input['schema'] ?? '' ) ) {
			unset( $input['schema'] );
		}

		return $input;
	}

	/** @param array<string,mixed> $input Runtime input. @return array<string,mixed> */
	private static function runtime_package_workflow_for_agents_api( array $input ): array {
		if ( is_array( $input['workflow'] ?? null ) && ( isset( $input['workflow']['id'] ) || isset( $input['workflow']['spec'] ) ) ) {
			return $input;
		}

		$package = is_array( $input['package'] ?? null ) ? $input['package'] : array();
		$id      = self::string_value( $input['workflow_id'] ?? $input['workflowId'] ?? $package['workflow'] ?? $package['slug'] ?? $package['id'] ?? self::runtime_package_id( (string) ( $input['runtime_package'] ?? '' ) ) );
		if ( '' !== $id ) {
			$input['workflow'] = array( 'id' => $id );
		}

		return $input;
	}

	/** @param array<string,mixed> $input Runtime input. @return array<string,mixed> */
	private static function runtime_package_required_artifacts_for_agents_api( array $input ): array {
		$required = array();
		foreach ( is_array( $input['artifact_declarations'] ?? null ) ? $input['artifact_declarations'] : array() as $artifact ) {
			if ( is_array( $artifact ) && true === ( $artifact['required'] ?? false ) && 'input' !== (string) ( $artifact['direction'] ?? 'output' ) ) {
				$name = self::string_value( $artifact['name'] ?? '' );
				if ( '' !== $name ) {
					$required[] = $name;
				}
			}
		}
		$input['required_artifacts'] = array_values( array_unique( $required ) );

		return $input;
	}

	/** @param array<string,mixed> $input Runtime input. @return array<string,mixed> */
	private static function stage_runtime_package_wordpress_workload_files( array $input ): array {
		$workflow_input = is_array( $input['input'] ?? null ) ? $input['input'] : array();
		if ( 'wp-codebox/wordpress-workload-run/v1' !== (string) ( $workflow_input['schema'] ?? '' ) ) {
			return $input;
		}

		$package_root = self::runtime_package_root( is_array( $input['package'] ?? null ) ? $input['package'] : array() );
		$staged_files = is_array( $workflow_input['staged_files'] ?? null ) ? $workflow_input['staged_files'] : ( is_array( $workflow_input['stagedFiles'] ?? null ) ? $workflow_input['stagedFiles'] : array() );
		foreach ( array( 'before', 'steps', 'after' ) as $phase ) {
			$steps = is_array( $workflow_input[ $phase ] ?? null ) ? $workflow_input[ $phase ] : array();
			foreach ( $steps as $index => $step ) {
				if ( ! is_array( $step ) || 'wordpress.run-workload' !== (string) ( $step['command'] ?? '' ) ) {
					continue;
				}
				$args = self::parse_step_args( is_array( $step['args'] ?? null ) ? $step['args'] : array() );
				if ( 'php' !== strtolower( (string) ( $args['type'] ?? '' ) ) ) {
					continue;
				}
				$source = self::resolve_runtime_package_file_path( (string) ( $args['path'] ?? $args['file'] ?? '' ), $package_root );
				if ( '' === $source ) {
					continue;
				}

				$target = '/tmp/wp-codebox-workloads/' . substr( hash( 'sha256', $source ), 0, 16 ) . '-' . basename( $source );
				$staged_files[] = array(
					'source'   => $source,
					'target'   => $target,
					'metadata' => array( 'kind' => 'wordpress-php-workload' ),
				);
				$args['path'] = $target;
				unset( $args['file'] );
				$step['args'] = self::step_args_from_map( $args );
				$steps[ $index ] = $step;
			}
			$workflow_input[ $phase ] = $steps;
		}

		if ( ! empty( $staged_files ) ) {
			$workflow_input['staged_files'] = array_values( $staged_files );
		}
		$input['input'] = $workflow_input;

		return $input;
	}

	/** @param array<string,mixed> $package Package descriptor. */
	private static function runtime_package_root( array $package ): string {
		$source = isset( $package['source'] ) ? (string) $package['source'] : '';
		if ( '' === $source ) {
			return '';
		}
		if ( is_file( $source ) ) {
			return dirname( $source );
		}

		return is_dir( $source ) ? rtrim( $source, '/\\' ) : '';
	}

	private static function resolve_runtime_package_file_path( string $path, string $package_root ): string {
		$path = trim( $path );
		if ( '' === $path ) {
			return '';
		}
		if ( '' !== $package_root ) {
			$path = str_replace( array( '${package.root}', '{{package.root}}' ), $package_root, $path );
		}
		$candidates = array( $path );
		if ( '' !== $package_root && ! self::is_absolute_package_source( $path ) ) {
			$candidates[] = rtrim( $package_root, '/\\' ) . '/' . ltrim( $path, '/\\' );
		}
		foreach ( $candidates as $candidate ) {
			if ( is_file( $candidate ) && is_readable( $candidate ) ) {
				$real = realpath( $candidate );
				return false !== $real ? $real : $candidate;
			}
		}

		return '';
	}

	/** @param array<int,mixed> $args @return array<string,string> */
	private static function parse_step_args( array $args ): array {
		$parsed = array();
		foreach ( $args as $arg ) {
			$parts = explode( '=', (string) $arg, 2 );
			$parsed[ $parts[0] ] = $parts[1] ?? '';
		}

		return $parsed;
	}

	/** @param array<string,string> $args @return array<int,string> */
	private static function step_args_from_map( array $args ): array {
		$out = array();
		foreach ( $args as $key => $value ) {
			$out[] = (string) $key . '=' . (string) $value;
		}

		return $out;
	}

	/** @param array<string,mixed> $input Runtime input. @return array<string,mixed> */
	private static function runtime_package_options_for_agents_api( array $input ): array {
		$options        = is_array( $input['options'] ?? null ) ? $input['options'] : array();
		$workflow_input = is_array( $input['input'] ?? null ) ? $input['input'] : array();

		foreach ( self::runtime_package_option_fields() as $field ) {
			if ( array_key_exists( $field, $input ) && ! array_key_exists( $field, $options ) ) {
				$options[ $field ] = $input[ $field ];
			}
			if ( array_key_exists( $field, $options ) && ! array_key_exists( $field, $workflow_input ) ) {
				$workflow_input[ $field ] = $options[ $field ];
			}
			if ( array_key_exists( $field, $workflow_input ) && ! array_key_exists( $field, $options ) ) {
				$options[ $field ] = $workflow_input[ $field ];
			}
		}

		if ( ! empty( $options ) ) {
			$input['options'] = $options;
		}
		if ( isset( $input['input'] ) ) {
			$input['input'] = $workflow_input;
		}

		return $input;
	}

	/** @return array<int,string> */
	private static function runtime_package_option_fields(): array {
		return array(
			'provider',
			'model',
			'wait_for_completion',
			'wait',
			'step_budget',
			'time_budget_ms',
			'required_outputs',
			'required_artifacts',
			'engine_data_outputs',
			'runtime_tools',
			'ability_tools',
			'tools',
			'disable_directives',
		);
	}

	/** @param array<string,mixed> $package Package descriptor. @param array<string,mixed> $input Runtime input. @return array<string,mixed> */
	private static function package_descriptor_for_runtime( array $package, array $input ): array {
		$source = isset( $package['source'] ) && is_string( $package['source'] ) ? trim( $package['source'] ) : '';
		if ( '' === $source || self::is_absolute_package_source( $source ) || file_exists( $source ) ) {
			return $package;
		}

		foreach ( self::runtime_workspace_roots( $input ) as $root ) {
			$candidate = rtrim( $root, '/' ) . '/' . ltrim( $source, '/' );
			if ( file_exists( $candidate ) ) {
				$package['source'] = $candidate;
				return $package;
			}
		}

		return $package;
	}

	/** @return array<string,string> */
	private static function package_descriptor_from_runtime_package( string $runtime_package ): array {
		$runtime_package = trim( $runtime_package );
		if ( '' === $runtime_package ) {
			return array( 'slug' => '' );
		}

		if ( self::is_path_like_runtime_package( $runtime_package ) ) {
			return array(
				'slug'   => self::runtime_package_id( $runtime_package ),
				'source' => $runtime_package,
			);
		}

		return array( 'slug' => $runtime_package );
	}

	private static function runtime_package_id( string $runtime_package ): string {
		$runtime_package = trim( $runtime_package );
		if ( '' === $runtime_package ) {
			return '';
		}

		$normalized = str_replace( '\\', '/', rtrim( $runtime_package, '/\\' ) );
		$basename   = basename( $normalized );
		return '' !== $basename ? $basename : $runtime_package;
	}

	private static function is_path_like_runtime_package( string $runtime_package ): bool {
		return self::is_absolute_package_source( $runtime_package ) || str_contains( $runtime_package, '/' ) || str_contains( $runtime_package, '\\' );
	}

	/** @param array<string,mixed> $input Runtime input. @return array<int,string> */
	private static function runtime_workspace_roots( array $input ): array {
		$contexts = array();
		foreach ( array( $input, $input['input'] ?? null, $input['task_input'] ?? null ) as $value ) {
			if ( is_array( $value ) && is_array( $value['client_context'] ?? null ) ) {
				$contexts[] = $value['client_context'];
			}
		}

		$roots = array();
		foreach ( $contexts as $context ) {
			if ( isset( $context['default_workspace']['target'] ) && is_string( $context['default_workspace']['target'] ) ) {
				$roots[] = $context['default_workspace']['target'];
			}

			foreach ( is_array( $context['sandbox_workspace']['mounts'] ?? null ) ? $context['sandbox_workspace']['mounts'] : array() as $mount ) {
				if ( is_array( $mount ) && isset( $mount['target'] ) && is_string( $mount['target'] ) ) {
					$roots[] = $mount['target'];
				}
			}
		}

		return array_values( array_unique( array_filter( $roots, static fn( string $root ): bool => '' !== trim( $root ) ) ) );
	}

	private static function is_absolute_package_source( string $source ): bool {
		return str_starts_with( $source, '/' ) || 1 === preg_match( '#^[a-z][a-z0-9+.-]*://#i', $source ) || 1 === preg_match( '#^[A-Za-z]:[\\/]#', $source );
	}

	private static function string_value( mixed $value ): string {
		return is_scalar( $value ) ? trim( (string) $value ) : '';
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

		return self::public_response( $ability_name, $result );
	}

	/** @param array<string,mixed> $result Upstream result. @return array<string,mixed> */
	private static function public_response( string $ability_name, array $result ): array {
		if ( self::RUN_RUNTIME_PACKAGE === $ability_name ) {
			return self::runtime_package_result_for_public( $result );
		}

		if ( isset( self::RESPONSE_SCHEMAS[ $ability_name ] ) ) {
			$result['schema'] = self::RESPONSE_SCHEMAS[ $ability_name ];
		}

		return self::sanitize_public_value( $result );
	}

	/** @param array<string,mixed> $result Upstream runtime package result. @return array<string,mixed> */
	private static function runtime_package_result_for_public( array $result ): array {
		$diagnostics = array();
		foreach ( is_array( $result['diagnostics'] ?? null ) ? $result['diagnostics'] : array() as $diagnostic ) {
			if ( ! is_array( $diagnostic ) ) {
				continue;
			}
			$diagnostics[] = self::runtime_package_diagnostic_for_public(
				self::string_value( $diagnostic['code'] ?? 'runtime_package_diagnostic' ),
				self::string_value( $diagnostic['message'] ?? 'Runtime package diagnostic.' ),
				self::string_value( $diagnostic['path'] ?? '' ),
				in_array( (string) ( $diagnostic['severity'] ?? '' ), array( 'info', 'warning', 'error' ), true ) ? (string) $diagnostic['severity'] : 'error',
				is_array( $diagnostic['details'] ?? null ) ? $diagnostic['details'] : array()
			);
		}

		$failed   = false === ( $result['success'] ?? true ) || 'failed' === (string) ( $result['status'] ?? '' ) || self::runtime_package_has_error_diagnostic_for_public( $diagnostics );
		$metadata = is_array( $result['metadata'] ?? null ) ? $result['metadata'] : array();
		foreach ( array( 'received', 'projections' ) as $field ) {
			if ( array_key_exists( $field, $result ) && ! array_key_exists( $field, $metadata ) ) {
				$metadata[ $field ] = $result[ $field ];
			}
		}

		$received = is_array( $result['received'] ?? null ) ? $result['received'] : array();
		$package  = is_array( $result['package'] ?? null ) ? $result['package'] : ( is_array( $received['package'] ?? null ) ? $received['package'] : array() );

		return self::sanitize_public_value(
			array(
				'schema'      => self::RESPONSE_SCHEMAS[ self::RUN_RUNTIME_PACKAGE ],
				'status'      => $failed ? 'failed' : 'success',
				'success'     => ! $failed,
				'package'     => ! empty( $package ) ? self::package_descriptor_for_runtime( $package, $result ) : null,
				'outputs'     => is_array( $result['outputs'] ?? null ) ? $result['outputs'] : self::runtime_package_semantic_outputs_for_public( $result ),
				'artifacts'   => self::runtime_package_artifacts_for_public( $result['artifacts'] ?? array() ),
				'diagnostics' => $diagnostics,
				'metadata'    => $metadata,
			)
		);
	}

	/** @param mixed $artifacts Artifacts. @return array<int,array<string,mixed>> */
	private static function runtime_package_artifacts_for_public( mixed $artifacts ): array {
		if ( ! is_array( $artifacts ) ) {
			return array();
		}

		$out = array();
		foreach ( $artifacts as $artifact ) {
			if ( is_array( $artifact ) && '' !== self::string_value( $artifact['name'] ?? '' ) ) {
				$out[] = $artifact;
			}
		}

		return $out;
	}

	/** @param array<string,mixed> $result Upstream result. @return array<string,mixed> */
	private static function runtime_package_semantic_outputs_for_public( array $result ): array {
		$outputs = array();
		foreach ( array( 'result', 'summary', 'data', 'semantic_outputs', 'structured_outputs' ) as $field ) {
			if ( array_key_exists( $field, $result ) ) {
				$outputs[ $field ] = $result[ $field ];
			}
		}

		return $outputs;
	}

	/** @param array<int,array<string,mixed>> $diagnostics Diagnostics. */
	private static function runtime_package_has_error_diagnostic_for_public( array $diagnostics ): bool {
		foreach ( $diagnostics as $diagnostic ) {
			if ( 'error' === (string) ( $diagnostic['severity'] ?? '' ) ) {
				return true;
			}
		}

		return false;
	}

	/** @param array<string,mixed> $details Diagnostic details. @return array<string,mixed> */
	private static function runtime_package_diagnostic_for_public( string $code, string $message, string $path = '', string $severity = 'error', array $details = array() ): array {
		$diagnostic = array(
			'schema'   => 'wp-codebox/runtime-package-diagnostic/v1',
			'code'     => $code,
			'message'  => $message,
			'severity' => $severity,
		);
		if ( '' !== $path ) {
			$diagnostic['path'] = $path;
		}
		if ( ! empty( $details ) ) {
			$diagnostic['details'] = $details;
		}

		return $diagnostic;
	}

	/** @param array<string,mixed> $value Public response value. @return array<string,mixed> */
	private static function sanitize_public_value( array $value ): array {
		foreach ( $value as $key => $item ) {
			if ( is_string( $item ) && self::is_upstream_schema_name( $item ) ) {
				$value[ $key ] = 'wp-codebox/upstream-adapter-value/v1';
				continue;
			}
			if ( is_array( $item ) ) {
				$value[ $key ] = self::sanitize_public_value( $item );
			}
		}

		return $value;
	}

	private static function is_upstream_schema_name( string $value ): bool {
		return 1 === preg_match( '#^agents-api(?:[./][A-Za-z0-9_-]+)*/v[0-9]+$#', $value )
			|| 1 === preg_match( '#^agents-api\.[A-Za-z0-9_.-]+$#', $value );
	}
}
