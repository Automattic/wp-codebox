<?php
/**
 * WP Codebox abilities.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

require_once __DIR__ . '/trait-wp-codebox-abilities-schemas.php';
require_once __DIR__ . '/trait-wp-codebox-abilities-execution.php';
require_once __DIR__ . '/trait-wp-codebox-abilities-permissions.php';
require_once __DIR__ . '/trait-wp-codebox-abilities-inheritance.php';
require_once __DIR__ . '/trait-wp-codebox-abilities-provider-adapter.php';
require_once __DIR__ . '/trait-wp-codebox-abilities-browser-artifacts.php';
require_once __DIR__ . '/trait-wp-codebox-abilities-browser-runtime.php';
require_once __DIR__ . '/trait-wp-codebox-abilities-browser-blueprint.php';
require_once __DIR__ . '/trait-wp-codebox-abilities-browser-runner.php';
require_once __DIR__ . '/trait-wp-codebox-abilities-browser-connectors.php';
require_once __DIR__ . '/trait-wp-codebox-abilities-agents-api-executors.php';
require_once __DIR__ . '/trait-wp-codebox-abilities-utils.php';

final class WP_Codebox_Abilities {

	private const BROWSER_ARTIFACT_MAX_BYTES = 5242880;
	private const BROWSER_CAPTURE_MAX_BYTES  = 262144;
	private const BROWSER_SESSION_CREATE_SCOPE = 'browser-session:create';
	private const BROWSER_CONNECTOR_REQUEST_SCOPE = 'browser-connector:request';
	private const BROWSER_ARTIFACT_WRITE_SCOPE = 'artifact:write';

	private static bool $registered = false;

	use WP_Codebox_Abilities_Schemas;
	use WP_Codebox_Abilities_Execution;
	use WP_Codebox_Abilities_Permissions;
	use WP_Codebox_Abilities_Inheritance;
	use WP_Codebox_Abilities_Provider_Adapter;
	use WP_Codebox_Abilities_Browser_Artifacts;
	use WP_Codebox_Abilities_Browser_Runtime;
	use WP_Codebox_Abilities_Browser_Blueprint;
	use WP_Codebox_Abilities_Browser_Runner;
	use WP_Codebox_Abilities_Browser_Connectors;
	use WP_Codebox_Abilities_Agents_API_Executors;
	use WP_Codebox_Abilities_Utils;

	public function __construct() {
		if ( ! class_exists( 'WP_Ability' ) ) {
			return;
		}

		if ( self::$registered ) {
			return;
		}

		$this->register_category();
		$this->register_agents_api_executor_adapters();
		$this->register();
		add_action( 'rest_api_init', array( self::class, 'register_rest_routes' ) );
		self::$registered = true;
	}

	public static function register_rest_routes(): void {
		register_rest_route(
			'wp-codebox/v1',
			'/browser-provider-request',
			array(
				'methods'             => 'POST',
				'callback'            => array( self::class, 'rest_browser_provider_request' ),
				'permission_callback' => static fn(): bool => current_user_can( 'manage_options' ),
			)
		);
	}

	/** @param WP_REST_Request $request REST request. @return array<string,mixed>|WP_Error */
	public static function rest_browser_provider_request( WP_REST_Request $request ): array|WP_Error {
		$input = $request->get_json_params();
		if ( ! is_array( $input ) ) {
			return new WP_Error( 'wp_codebox_browser_provider_rest_payload_invalid', 'Browser provider proxy requests must send a JSON object.', array( 'status' => 400 ) );
		}

		return self::execute_browser_provider_request( $input );
	}

	/**
	 * Register the `wp-codebox` ability category.
	 *
	 * As of WordPress 6.9 the Abilities API requires the category to be
	 * registered before any ability that declares it; unregistered categories
	 * cause `wp_register_ability()` to return `null` and silently drop the
	 * ability. Categories must be registered on `wp_abilities_api_categories_init`.
	 */
	private function register_category(): void {
		if ( ! function_exists( 'wp_register_ability_category' ) ) {
			return;
		}

		$register_category = static function (): void {
			wp_register_ability_category(
				'wp-codebox',
				array(
					'label'       => 'WP Codebox',
					'description' => 'Disposable WordPress Playground sandbox runs, artifact capture, and reviewed apply-back.',
				)
			);
		};

		if ( function_exists( 'doing_action' ) && doing_action( 'wp_abilities_api_categories_init' ) ) {
			$register_category();
			return;
		}

		add_action( 'wp_abilities_api_categories_init', $register_category );
	}

	private function register(): void {
		$register_callback = function (): void {
			$task_input_schema  = self::task_input_schema();
			$mount_schema      = self::mount_schema();
			$site_seed_schema  = self::site_seed_schema();
			$inherit_schema    = self::inherit_schema();
			$session_schema    = self::sandbox_session_schema();
			$browser_session_schema = self::browser_playground_session_schema();
			$session_input     = self::sandbox_session_input_schema();
			$preview_schema    = self::preview_input_schema();
			$outcome_schema    = self::remediation_outcome_schema();
			$completion_outcome_schema = self::completion_outcome_schema();
			$artifact_id_schema = array(
				'artifact_id'    => array(
					'type'        => 'string',
					'description' => 'Artifact bundle id from manifest.json.',
				),
				'artifacts_path' => array(
					'type'        => 'string',
					'description' => 'Root directory containing WP Codebox artifact bundles.',
				),
			);

			wp_register_ability(
				'wp-codebox/run-agent-task',
				array(
					'label'               => 'Run Agent Sandbox Task',
					'description'         => 'Run a bounded task inside an isolated WP Codebox WordPress agent sandbox and return artifacts.',
					'category'            => 'wp-codebox',
					'input_schema'        => array(
						'type'       => 'object',
						'anyOf'      => array(
							array( 'type' => 'object', 'required' => array( 'goal' ) ),
							array( 'type' => 'object', 'required' => array( 'task' ) ),
						),
						'properties' => array(
							'goal'                   => $task_input_schema['properties']['goal'],
							'task'                   => array(
								'type'        => 'string',
								'description' => 'Legacy task description. Prefer goal for new product callers.',
							),
							'target'                 => $task_input_schema['properties']['target'],
							'allowed_tools'          => $task_input_schema['properties']['allowed_tools'],
							'sandbox_tool_policy'    => $task_input_schema['properties']['sandbox_tool_policy'],
							'expected_artifacts'     => $task_input_schema['properties']['expected_artifacts'],
							'policy'                 => $task_input_schema['properties']['policy'],
							'context'                => $task_input_schema['properties']['context'],
							'agent'                  => array(
								'type'        => 'string',
								'description' => 'Sandbox agent slug to invoke through agents/chat. Defaults through wp_codebox_default_agent.',
							),
							'mode'                   => array(
								'type'        => 'string',
								'description' => 'Agent execution mode. Defaults to sandbox.',
							),
							'provider'               => array(
								'type'        => 'string',
								'description' => 'AI provider id to seed into the sandbox agent config.',
							),
							'model'                  => array(
								'type'        => 'string',
								'description' => 'AI model id to seed into the sandbox agent config.',
							),
							'provider_plugin_paths'  => array(
								'type'        => 'array',
								'description' => 'AI provider plugin directories to mount and activate inside the sandbox.',
								'items'       => array( 'type' => 'string' ),
							),
							'agent_bundles'          => self::agent_bundle_schema(),
							'runtime_task'           => array(
								'type'        => 'object',
								'description' => 'Generic runtime task request. WP Codebox forwards input to the requested sandbox-local ability after importing agent_bundles.',
							),
							'parent_request'         => array(
								'type'        => 'object',
								'description' => 'External orchestrator task request, such as homeboy/wp-codebox-task-request/v1, normalized into the WP Codebox runner contract.',
							),
							'mounts'                 => $mount_schema,
							'workspaces'             => array(
								'type'        => 'array',
								'description' => 'Recipe workspace entries to seed as policy-checked writable repositories.',
								'items'       => array( 'type' => 'object' ),
							),
							'runtime_stack_mounts'   => array(
								'type'        => 'array',
								'description' => 'Runtime stack mounts to pass through to recipe.runtime.stack.mounts.',
								'items'       => array( 'type' => 'object' ),
							),
							'runtime_overlays'       => array(
								'type'        => 'array',
								'description' => 'Runtime overlays to pass through to recipe.runtime.overlays.',
								'items'       => array( 'type' => 'object' ),
							),
							'site_seeds'             => $site_seed_schema,
							'inherit'                => $inherit_schema,
							'sandbox_session_id'     => $session_input['sandbox_session_id'],
							'orchestrator'           => $session_input['orchestrator'],
							'secret_env'             => array(
								'type'        => 'array',
								'description' => 'Explicit parent environment variable names to expose inside the sandbox. Prefer connector-scoped inheritance credentials for product flows. Values are read from the parent process and are not accepted in this payload.',
								'items'       => array( 'type' => 'string' ),
							),
							'session_id'             => array(
								'type'        => 'string',
								'description' => 'Existing sandbox conversation session id.',
							),
							'max_turns'              => array(
								'type'        => 'integer',
								'description' => 'Maximum agent loop turns for this sandbox task.',
							),
							'task_timeout_seconds'   => array(
								'type'        => 'integer',
								'description' => 'Maximum wall-clock seconds for this sandbox task. Zero or omitted disables the host-side timeout.',
							),
							'preview_hold_seconds'   => $preview_schema['preview_hold_seconds'],
							'preview_port'           => $preview_schema['preview_port'],
							'preview_bind'           => $preview_schema['preview_bind'],
							'preview_public_url'     => $preview_schema['preview_public_url'],
							'wp'                     => array(
								'type'        => 'string',
								'description' => 'WordPress version passed to Playground. Defaults to trunk.',
							),
							'artifacts_path'         => array(
								'type'        => 'string',
								'description' => 'Directory where WP Codebox should write artifact bundles.',
							),
							'wp_codebox_bin'    => array(
								'type'        => 'string',
								'description' => 'WP Codebox CLI binary or path. JS dist files are run through node.',
							),
							'agents_api_path'        => array( 'type' => 'string' ),
							'data_machine_path'      => array( 'type' => 'string' ),
							'data_machine_code_path' => array( 'type' => 'string' ),
						),
					),
					'output_schema'       => array(
						'type'       => 'object',
						'properties' => array(
							'success'   => array( 'type' => 'boolean' ),
							'schema'    => array( 'type' => 'string' ),
							'status'    => array( 'type' => 'string' ),
							'session'   => $session_schema,
							'task'      => array( 'type' => 'string' ),
							'task_input' => $task_input_schema,
							'wp'        => array( 'type' => 'string' ),
							'paths'     => array( 'type' => 'object' ),
							'artifacts' => array( 'type' => 'string' ),
							'exit_code' => array( 'type' => 'integer' ),
							'outcome'   => $outcome_schema,
							'diagnostics' => array( 'type' => 'object' ),
							'evidence_refs' => array( 'type' => 'object' ),
							'run_metadata' => array( 'type' => 'object' ),
							'completion_outcome' => $completion_outcome_schema,
							'run'       => array( 'type' => 'object' ),
						),
					),
					'execute_callback'    => array( self::class, 'run_agent_task' ),
					'permission_callback' => array( self::class, 'can_run_agent_task' ),
					'meta'                => array( 'show_in_rest' => true ),
				)
			);

			wp_register_ability(
				'wp-codebox/run-agent-task-batch',
				array(
					'label'               => 'Run Agent Sandbox Task Batch',
					'description'         => 'Run multiple tasks in isolated WP Codebox WordPress agent sandboxes and return artifacts for each run.',
					'category'            => 'wp-codebox',
					'input_schema'        => array(
						'type'       => 'object',
						'required'   => array( 'tasks' ),
						'properties' => array(
							'tasks'                  => array(
								'type'        => 'array',
								'description' => 'Task descriptions or structured task inputs. Each task runs in its own isolated sandbox.',
								'items'       => array(
									'anyOf' => array(
										array( 'type' => 'string' ),
										$task_input_schema,
									),
								),
							),
							'agent'                  => array( 'type' => 'string' ),
							'mode'                   => array( 'type' => 'string' ),
							'provider'               => array( 'type' => 'string' ),
							'model'                  => array( 'type' => 'string' ),
							'provider_plugin_paths'  => array(
								'type'  => 'array',
								'items' => array( 'type' => 'string' ),
							),
							'agent_bundles'          => self::agent_bundle_schema(),
							'runtime_task'           => array( 'type' => 'object' ),
							'parent_request'         => array( 'type' => 'object' ),
							'mounts'                 => $mount_schema,
							'workspaces'             => array(
								'type'  => 'array',
								'items' => array( 'type' => 'object' ),
							),
							'runtime_stack_mounts'   => array(
								'type'  => 'array',
								'items' => array( 'type' => 'object' ),
							),
							'runtime_overlays'       => array(
								'type'  => 'array',
								'items' => array( 'type' => 'object' ),
							),
							'inherit'                => $inherit_schema,
							'sandbox_session_id'     => $session_input['sandbox_session_id'],
							'orchestrator'           => $session_input['orchestrator'],
							'secret_env'             => array(
								'type'  => 'array',
								'items' => array( 'type' => 'string' ),
							),
							'max_turns'              => array( 'type' => 'integer' ),
							'preview_hold_seconds'   => $preview_schema['preview_hold_seconds'],
							'preview_port'           => $preview_schema['preview_port'],
							'preview_bind'           => $preview_schema['preview_bind'],
							'preview_public_url'     => $preview_schema['preview_public_url'],
							'wp'                     => array( 'type' => 'string' ),
							'artifacts_path'         => array( 'type' => 'string' ),
							'wp_codebox_bin'    => array( 'type' => 'string' ),
							'agents_api_path'        => array( 'type' => 'string' ),
							'data_machine_path'      => array( 'type' => 'string' ),
							'data_machine_code_path' => array( 'type' => 'string' ),
						),
					),
					'output_schema'       => array(
						'type'       => 'object',
						'properties' => array(
							'success'     => array( 'type' => 'boolean' ),
							'schema'      => array( 'type' => 'string' ),
							'session'     => $session_schema,
							'tasks'       => array( 'type' => 'array' ),
							'task_inputs' => array(
								'type'  => 'array',
								'items' => $task_input_schema,
							),
							'execution'   => array( 'type' => 'string' ),
							'total'       => array( 'type' => 'integer' ),
							'completed'   => array( 'type' => 'integer' ),
							'failed'      => array( 'type' => 'integer' ),
							'paths'       => array( 'type' => 'object' ),
							'artifacts'   => array( 'type' => 'string' ),
							'runs'        => array(
								'type'  => 'array',
								'items' => array(
									'type'       => 'object',
									'properties' => array(
										'index'       => array( 'type' => 'integer' ),
										'task'        => array( 'type' => 'string' ),
										'task_input'  => $task_input_schema,
										'success'     => array( 'type' => 'boolean' ),
										'status'      => array( 'type' => 'string' ),
										'exit_code'   => array( 'type' => 'integer' ),
										'session'     => $session_schema,
										'artifact_id' => array( 'type' => 'string' ),
										'preview_url' => array( 'type' => 'string' ),
										'artifacts'   => array( 'type' => 'object' ),
										'outcome'     => $outcome_schema,
										'completion_outcome' => $completion_outcome_schema,
										'run'         => array( 'type' => 'object' ),
										'error'       => array( 'type' => 'object' ),
									),
								),
							),
						),
					),
					'execute_callback'    => array( self::class, 'run_agent_task_batch' ),
					'permission_callback' => array( self::class, 'can_run_agent_task' ),
					'meta'                => array( 'show_in_rest' => true ),
				)
			);

			wp_register_ability(
				'wp-codebox/run-agent-task-fanout',
				array(
					'label'               => 'Run Agent Sandbox Task Fanout',
					'description'         => 'Run multiple agent sandbox workers with bounded host-side concurrency and parent/child artifact envelopes.',
					'category'            => 'wp-codebox',
					'input_schema'        => array(
						'type'       => 'object',
						'required'   => array( 'workers' ),
						'properties' => array(
							'schema'                => array( 'type' => 'string', 'const' => 'wp-codebox/agent-fanout-request/v1' ),
							'workers'               => array(
								'type'        => 'array',
								'description' => 'Explicit fanout worker definitions. Each worker runs in its own isolated sandbox and artifact namespace.',
								'items'       => array(
									'type'       => 'object',
									'required'   => array( 'id', 'goal' ),
									'properties' => array(
										'schema'             => array( 'type' => 'string', 'const' => 'wp-codebox/agent-fanout-worker/v1' ),
										'id'                 => array( 'type' => 'string' ),
										'goal'               => $task_input_schema['properties']['goal'],
										'task'               => array( 'type' => 'string' ),
										'agent'              => array( 'type' => 'string' ),
										'context'            => $task_input_schema['properties']['context'],
										'expected_artifacts' => $task_input_schema['properties']['expected_artifacts'],
										'allowed_tools'      => $task_input_schema['properties']['allowed_tools'],
										'sandbox_tool_policy' => $task_input_schema['properties']['sandbox_tool_policy'],
										'policy'             => $task_input_schema['properties']['policy'],
										'timeout_seconds'    => array( 'type' => 'integer' ),
									),
								),
							),
							'concurrency'           => array(
								'type'        => 'integer',
								'description' => 'Maximum number of workers to run at once. Defaults to 1 and is capped by the host runtime.',
							),
							'agent'                 => array( 'type' => 'string' ),
							'mode'                  => array( 'type' => 'string' ),
							'provider'              => array( 'type' => 'string' ),
							'model'                 => array( 'type' => 'string' ),
							'provider_plugin_paths' => array( 'type' => 'array', 'items' => array( 'type' => 'string' ) ),
							'agent_bundles'         => self::agent_bundle_schema(),
							'runtime_task'          => array( 'type' => 'object' ),
							'parent_request'        => array( 'type' => 'object' ),
							'mounts'                => $mount_schema,
							'workspaces'            => array( 'type' => 'array', 'items' => array( 'type' => 'object' ) ),
							'runtime_stack_mounts'  => array( 'type' => 'array', 'items' => array( 'type' => 'object' ) ),
							'runtime_overlays'      => array( 'type' => 'array', 'items' => array( 'type' => 'object' ) ),
							'inherit'               => $inherit_schema,
							'sandbox_session_id'    => $session_input['sandbox_session_id'],
							'orchestrator'          => $session_input['orchestrator'],
							'secret_env'            => array( 'type' => 'array', 'items' => array( 'type' => 'string' ) ),
							'max_turns'             => array( 'type' => 'integer' ),
							'task_timeout_seconds'  => array( 'type' => 'integer' ),
							'preview_hold_seconds'  => $preview_schema['preview_hold_seconds'],
							'preview_port'          => $preview_schema['preview_port'],
							'preview_bind'          => $preview_schema['preview_bind'],
							'preview_public_url'    => $preview_schema['preview_public_url'],
							'wp'                    => array( 'type' => 'string' ),
							'artifacts_path'        => array( 'type' => 'string' ),
							'wp_codebox_bin'        => array( 'type' => 'string' ),
							'agents_api_path'       => array( 'type' => 'string' ),
							'data_machine_path'     => array( 'type' => 'string' ),
							'data_machine_code_path' => array( 'type' => 'string' ),
						),
					),
					'output_schema'       => array(
						'type'       => 'object',
						'properties' => array(
							'success'     => array( 'type' => 'boolean' ),
							'schema'      => array( 'type' => 'string', 'const' => 'wp-codebox/agent-fanout-result/v1' ),
							'execution'   => array( 'type' => 'string' ),
							'session'     => array( 'type' => 'object' ),
							'concurrency' => array( 'type' => 'integer' ),
							'total'       => array( 'type' => 'integer' ),
							'completed'   => array( 'type' => 'integer' ),
							'failed'      => array( 'type' => 'integer' ),
							'cancelled'   => array( 'type' => 'integer' ),
							'timings'     => array( 'type' => 'object' ),
							'artifacts'   => array(
								'type'       => 'object',
								'properties' => array(
									'schema' => array( 'type' => 'string', 'const' => 'wp-codebox/agent-fanout-artifacts/v1' ),
									'plan'   => array( 'type' => 'string' ),
									'events' => array( 'type' => 'string' ),
								),
							),
							'orchestrator' => array( 'type' => 'object' ),
							'runs'        => array( 'type' => 'array', 'items' => array( 'type' => 'object' ) ),
							'failures'    => array( 'type' => 'array', 'items' => array( 'type' => 'object' ) ),
						),
					),
					'execute_callback'    => array( self::class, 'run_agent_task_fanout' ),
					'permission_callback' => array( self::class, 'can_run_agent_task' ),
					'meta'                => array( 'show_in_rest' => true ),
				)
			);

			wp_register_ability(
				'wp-codebox/request-host-delegation',
				array(
					'label'               => 'Request Host Delegation',
					'description'         => 'Request an explicit product-neutral host-side delegation. Product hosts may satisfy the request through the wp_codebox_host_delegation_request filter; WP Codebox returns structured unavailable evidence when no provider handles it.',
					'category'            => 'wp-codebox',
					'input_schema'        => array(
						'type'       => 'object',
						'properties' => array(
							'schema'             => array( 'type' => 'string', 'const' => 'wp-codebox/host-delegation-request/v1' ),
							'request_id'         => array( 'type' => 'string' ),
							'goal'               => $task_input_schema['properties']['goal'],
							'task'               => array( 'type' => 'string' ),
							'target'             => $task_input_schema['properties']['target'],
							'context'            => $task_input_schema['properties']['context'],
							'expected_artifacts' => $task_input_schema['properties']['expected_artifacts'],
							'execution'          => array(
								'type'        => 'object',
								'description' => 'Product-neutral host execution preferences or requirements. WP Codebox preserves this for the host provider without interpreting product policy.',
							),
							'orchestrator'       => $session_input['orchestrator'],
							'sandbox_session_id' => $session_input['sandbox_session_id'],
							'metadata'           => array( 'type' => 'object' ),
						),
					),
					'output_schema'       => array(
						'type'       => 'object',
						'properties' => array(
							'success'    => array( 'type' => 'boolean' ),
							'schema'     => array( 'type' => 'string', 'const' => 'wp-codebox/host-delegation-result/v1' ),
							'execution'  => array( 'type' => 'string', 'const' => 'host-delegation' ),
							'status'     => array( 'type' => 'string', 'enum' => array( 'unavailable', 'accepted', 'completed', 'failed' ) ),
							'request_id' => array( 'type' => 'string' ),
							'session_id' => array( 'type' => 'string' ),
							'request'    => array( 'type' => 'object' ),
							'provider'   => array( 'type' => 'string' ),
							'result'     => array( 'type' => 'object' ),
							'error'      => array( 'type' => 'object' ),
							'events'     => array( 'type' => 'array', 'items' => array( 'type' => 'object' ) ),
							'artifacts'  => array( 'type' => 'object' ),
							'timings'    => array( 'type' => 'object' ),
						),
					),
					'execute_callback'    => array( self::class, 'request_host_delegation' ),
					'permission_callback' => array( self::class, 'can_run_agent_task' ),
					'meta'                => array( 'show_in_rest' => true ),
				)
			);

			wp_register_ability(
				'wp-codebox/create-browser-playground-session',
				array(
					'label'               => 'Create Browser Playground Session',
					'description'         => 'Prepare a WP Codebox browser-executed WordPress Playground session without requiring the host to run the WP Codebox CLI or Node.',
					'category'            => 'wp-codebox',
					'input_schema'        => array(
						'type'       => 'object',
						'anyOf'      => array(
							array( 'type' => 'object', 'required' => array( 'goal' ) ),
							array( 'type' => 'object', 'required' => array( 'task' ) ),
						),
						'properties' => array(
							'goal'               => $task_input_schema['properties']['goal'],
							'task'               => array(
								'type'        => 'string',
								'description' => 'Legacy task description. Prefer goal for new product callers.',
							),
							'target'             => $task_input_schema['properties']['target'],
							'allowed_tools'      => $task_input_schema['properties']['allowed_tools'],
							'sandbox_tool_policy' => $task_input_schema['properties']['sandbox_tool_policy'],
							'expected_artifacts' => $task_input_schema['properties']['expected_artifacts'],
							'policy'             => $task_input_schema['properties']['policy'],
							'context'            => $task_input_schema['properties']['context'],
							'agent'              => array(
								'type'        => 'string',
								'description' => 'Sandbox agent slug to invoke through agents/chat inside the browser Playground.',
							),
							'provider'           => array(
								'type'        => 'string',
								'description' => 'AI provider id to seed into the browser Playground agent invocation.',
							),
							'model'              => array(
								'type'        => 'string',
								'description' => 'AI model id to seed into the browser Playground agent invocation.',
							),
							'mode'               => array(
								'type'        => 'string',
								'description' => 'Agent execution mode. Defaults to sandbox.',
							),
							'provider_plugin_paths' => array(
								'type'        => 'array',
								'description' => 'AI provider plugin directories the browser sandbox should have available before code execution.',
								'items'       => array( 'type' => 'string' ),
							),
							'agent_bundles'      => self::agent_bundle_schema(),
							'inherit'            => $inherit_schema,
							'secret_env'         => array(
								'type'        => 'array',
								'description' => 'Parent environment variable names expected to be available to the browser sandbox. Values are never accepted in this payload.',
								'items'       => array( 'type' => 'string' ),
							),
							'sandbox_session_id' => $session_input['sandbox_session_id'],
							'orchestrator'       => $session_input['orchestrator'],
							'authorization'      => self::browser_session_authorization_schema(),
							'playground'         => array(
								'type'        => 'object',
								'description' => 'Optional browser Playground client and artifact preview configuration overrides.',
								'properties'  => array(
									'client_module_url' => array( 'type' => 'string' ),
									'remote_url'        => array( 'type' => 'string' ),
									'cors_proxy_url'    => array( 'type' => 'string' ),
								),
							),
							'browser_runner'     => array(
								'type'        => 'object',
								'description' => 'Optional PHP-WASM runner paths and generic sandbox-local invocation settings for executing the task inside the browser Playground site.',
								'properties'  => array(
									'task_path'   => array( 'type' => 'string' ),
									'result_path' => array( 'type' => 'string' ),
									'capture_paths' => array(
										'type'        => 'array',
										'description' => 'Sandbox-local files or reports the generated browser runner should include in its normalized result after invocation.',
										'items'       => array(
											'type'       => 'object',
											'required'   => array( 'path' ),
											'properties' => array(
												'path'       => array( 'type' => 'string' ),
												'name'       => array( 'type' => 'string' ),
												'kind'       => array( 'type' => 'string' ),
												'mime_type'  => array( 'type' => 'string' ),
												'max_bytes'  => array( 'type' => 'integer' ),
											),
										),
									),
									'invocation'  => array(
										'type'        => 'object',
										'description' => 'Generic sandbox-local invocation. Callers can inject MU plugins that register the named ability or hook task; WP Codebox only invokes it and captures normal artifacts.',
										'properties'  => array(
											'type'              => array( 'type' => 'string', 'enum' => array( 'ability', 'task' ) ),
											'name'              => array( 'type' => 'string' ),
											'hook'              => array( 'type' => 'string' ),
											'input'             => array( 'type' => 'object' ),
										),
									),
								),
							),
							'browser_plugins'    => array(
								'type'        => 'array',
								'description' => 'Optional plugin zip URLs the browser Playground should install and activate before running the recipe.',
								'items'       => array(
									'type'       => 'object',
									'properties' => array(
										'slug'     => array( 'type' => 'string' ),
										'url'      => array( 'type' => 'string' ),
										'activate' => array( 'type' => 'boolean' ),
										'sha256'   => array( 'type' => 'string' ),
									),
								),
							),
							'runtime'            => array(
								'type'        => 'object',
								'description' => 'Structured browser Playground runtime dependencies compiled by WP Codebox into the session blueprint.',
								'properties'  => array(
									'components' => array( 'type' => 'array' ),
									'plugins'    => array( 'type' => 'array' ),
									'mu_plugins' => array( 'type' => 'array' ),
									'themes'     => array( 'type' => 'array' ),
									'bootstrap'  => array( 'type' => 'array' ),
								),
							),
							'blueprint'          => array(
								'type'        => 'object',
								'description' => 'Optional WordPress Playground blueprint for the browser to compile and run.',
							),
							'site_blueprint_artifact' => array(
								'type'        => 'object',
								'description' => 'Caller-owned pulled-site Playground blueprint artifact to compile into the browser sandbox before Codebox runs.',
								'properties'  => array(
									'schema'     => array( 'type' => 'string' ),
									'id'         => array( 'type' => 'string' ),
									'blueprint'  => array( 'type' => 'object' ),
									'provenance' => array( 'type' => 'object' ),
								),
							),
							'artifact_files'     => array(
								'type'        => 'array',
								'description' => 'Optional text or base64 artifact files the browser should write into Playground.',
								'items'       => array(
									'type'       => 'object',
									'required'   => array( 'path' ),
									'properties' => array(
										'path'        => array( 'type' => 'string' ),
										'content'     => array( 'type' => 'string' ),
										'content_base64' => array( 'type' => 'string' ),
										'encoding'    => array( 'type' => 'string' ),
										'mime_type'   => array( 'type' => 'string' ),
										'kind'        => array( 'type' => 'string' ),
										'description' => array( 'type' => 'string' ),
									),
								),
							),
						),
					),
					'output_schema'       => $browser_session_schema,
					'execute_callback'    => array( self::class, 'create_browser_playground_session' ),
					'permission_callback' => array( self::class, 'can_create_browser_playground_session' ),
					'meta'                => array( 'show_in_rest' => true ),
				)
			);

			wp_register_ability(
				'wp-codebox/create-browser-materializer-contract',
				array(
					'label'               => 'Create Browser Materializer Contract',
					'description'         => 'Prepare the browser-executed Playground recipe and materialization contract for an already-created parent browser session.',
					'category'            => 'wp-codebox',
					'input_schema'        => array(
						'type'       => 'object',
						'anyOf'      => array(
							array( 'type' => 'object', 'required' => array( 'goal' ) ),
							array( 'type' => 'object', 'required' => array( 'task' ) ),
						),
						'properties' => array(
							'goal'               => $task_input_schema['properties']['goal'],
							'task'               => array(
								'type'        => 'string',
								'description' => 'Legacy task description. Prefer goal for new product callers.',
							),
							'target'             => $task_input_schema['properties']['target'],
							'allowed_tools'      => $task_input_schema['properties']['allowed_tools'],
							'sandbox_tool_policy' => $task_input_schema['properties']['sandbox_tool_policy'],
							'expected_artifacts' => $task_input_schema['properties']['expected_artifacts'],
							'policy'             => $task_input_schema['properties']['policy'],
							'context'            => $task_input_schema['properties']['context'],
							'agent'              => array( 'type' => 'string' ),
							'provider'           => array( 'type' => 'string' ),
							'model'              => array( 'type' => 'string' ),
							'mode'               => array( 'type' => 'string' ),
							'provider_plugin_paths' => array( 'type' => 'array', 'items' => array( 'type' => 'string' ) ),
							'agent_bundles'      => self::agent_bundle_schema(),
							'inherit'            => $inherit_schema,
							'secret_env'         => array( 'type' => 'array', 'items' => array( 'type' => 'string' ) ),
							'sandbox_session_id' => $session_input['sandbox_session_id'],
							'orchestrator'       => $session_input['orchestrator'],
							'authorization'      => self::browser_session_authorization_schema(),
							'playground'         => array( 'type' => 'object' ),
							'browser_runner'     => array( 'type' => 'object' ),
							'browser_plugins'    => array( 'type' => 'array' ),
							'runtime'            => array( 'type' => 'object' ),
							'blueprint'          => array( 'type' => 'object' ),
							'site_blueprint_artifact' => array( 'type' => 'object' ),
							'artifact_files'     => array( 'type' => 'array' ),
						),
					),
					'output_schema'       => self::browser_materializer_contract_schema(),
					'execute_callback'    => array( self::class, 'create_browser_materializer_contract' ),
					'permission_callback' => array( self::class, 'can_create_browser_playground_session' ),
					'meta'                => array( 'show_in_rest' => true ),
				)
			);

			wp_register_ability(
				'wp-codebox/create-browser-task-contract',
				array(
					'label'               => 'Create Browser Task Contract',
					'description'         => 'Prepare a product-facing multi-phase browser Playground task contract with a primary session and optional materializer phases.',
					'category'            => 'wp-codebox',
					'input_schema'        => array(
						'type'       => 'object',
						'anyOf'      => array(
							array( 'type' => 'object', 'required' => array( 'goal' ) ),
							array( 'type' => 'object', 'required' => array( 'task' ) ),
						),
						'properties' => array(
							'goal'               => $task_input_schema['properties']['goal'],
							'task'               => array(
								'type'        => 'string',
								'description' => 'Legacy task description. Prefer goal for new product callers.',
							),
							'target'             => $task_input_schema['properties']['target'],
							'allowed_tools'      => $task_input_schema['properties']['allowed_tools'],
							'sandbox_tool_policy' => $task_input_schema['properties']['sandbox_tool_policy'],
							'expected_artifacts' => $task_input_schema['properties']['expected_artifacts'],
							'policy'             => $task_input_schema['properties']['policy'],
							'context'            => $task_input_schema['properties']['context'],
							'agent'              => array( 'type' => 'string' ),
							'provider'           => array( 'type' => 'string' ),
							'model'              => array( 'type' => 'string' ),
							'mode'               => array( 'type' => 'string' ),
							'provider_plugin_paths' => array( 'type' => 'array', 'items' => array( 'type' => 'string' ) ),
							'agent_bundles'      => self::agent_bundle_schema(),
							'inherit'            => $inherit_schema,
							'secret_env'         => array( 'type' => 'array', 'items' => array( 'type' => 'string' ) ),
							'sandbox_session_id' => $session_input['sandbox_session_id'],
							'orchestrator'       => $session_input['orchestrator'],
							'authorization'      => self::browser_session_authorization_schema(),
							'playground'         => array( 'type' => 'object' ),
							'browser_runner'     => array( 'type' => 'object' ),
							'browser_plugins'    => array( 'type' => 'array' ),
							'runtime'            => array( 'type' => 'object' ),
							'blueprint'          => array( 'type' => 'object' ),
							'site_blueprint_artifact' => array( 'type' => 'object' ),
							'artifact_files'     => array( 'type' => 'array' ),
							'phases'             => array(
								'type'        => 'array',
								'description' => 'Optional named browser task phases. Generic phases may carry wp-codebox/agent-fanout-request/v1 or wp-codebox/host-delegation-request/v1 in request/input for WP Codebox execution; materializer phases may override any primary session input through input.',
								'items'       => array(
									'type'       => 'object',
									'properties' => array(
										'name'     => array( 'type' => 'string' ),
										'kind'     => array( 'type' => 'string', 'enum' => self::browser_task_phase_kinds() ),
										'label'    => array( 'type' => 'string' ),
										'status'   => array( 'type' => 'string' ),
										'metadata' => array( 'type' => 'object' ),
										'request'  => array( 'type' => 'object' ),
										'input'    => array( 'type' => 'object' ),
									),
								),
							),
							'materializers'      => array(
								'type'        => 'array',
								'description' => 'Convenience list of materializer input overrides. Prefer phases for named multi-phase contracts.',
								'items'       => array( 'type' => 'object' ),
							),
						),
					),
					'output_schema'       => self::browser_task_contract_schema(),
					'execute_callback'    => array( self::class, 'create_browser_task_contract' ),
					'permission_callback' => array( self::class, 'can_create_browser_playground_session' ),
					'meta'                => array( 'show_in_rest' => true ),
				)
			);

			wp_register_ability(
				'wp-codebox/browser-connector-request',
				array(
					'label'               => 'Run Browser Connector Request',
					'description'         => 'Resolve connector credentials server-side and dispatch a generic browser connector request without exposing raw secrets to the browser sandbox.',
					'category'            => 'wp-codebox',
					'input_schema'        => self::browser_connector_request_schema(),
					'output_schema'       => self::browser_connector_response_schema(),
					'execute_callback'    => array( self::class, 'browser_connector_request' ),
					'permission_callback' => array( self::class, 'can_request_browser_connector' ),
					'meta'                => array( 'show_in_rest' => true ),
				)
			);

			wp_register_ability(
				'wp-codebox/execute-browser-provider-request',
				array(
					'label'               => 'Execute Browser Provider Request',
					'description'         => 'Dispatch a connector-scoped browser provider request through the generic parent-side provider adapter hook without exposing raw provider credentials to the browser Playground.',
					'category'            => 'wp-codebox',
					'input_schema'        => array(
						'type'       => 'object',
						'required'   => array( 'operation', 'request', 'inherit' ),
						'properties' => array(
							'operation' => array(
								'type'        => 'string',
								'description' => 'Generic provider operation id, for example chat.completions. WP Codebox treats this as opaque adapter input.',
							),
							'provider'  => array( 'type' => 'string' ),
							'model'     => array( 'type' => 'string' ),
							'connector' => array(
								'type'        => 'string',
								'description' => 'Optional connector name to select from the resolved inheritance connector set. Defaults to the first resolved connector.',
							),
							'inherit'   => $inherit_schema,
							'request'   => array(
								'type'        => 'object',
								'description' => 'Generic provider request payload. Secret-like fields are redacted before adapter/audit envelopes are returned.',
							),
							'sandbox_session_id' => $session_input['sandbox_session_id'],
							'session_id'         => array( 'type' => 'string' ),
							'caller_session_id'  => array( 'type' => 'string' ),
							'job_id'             => array( 'type' => 'string' ),
							'orchestrator'       => $session_input['orchestrator'],
							'authorization'      => self::browser_session_authorization_schema(),
						),
					),
					'output_schema'       => array(
						'type'       => 'object',
						'properties' => array(
							'success'   => array( 'type' => 'boolean' ),
							'schema'    => array( 'type' => 'string', 'const' => 'wp-codebox/browser-provider-adapter-response/v1' ),
							'operation' => array( 'type' => 'string' ),
							'provider'  => array( 'type' => 'string' ),
							'model'     => array( 'type' => 'string' ),
							'connector' => array( 'type' => 'object' ),
							'response'  => array( 'type' => 'object' ),
							'audit'     => array( 'type' => 'object' ),
						),
					),
					'execute_callback'    => array( self::class, 'execute_browser_provider_request' ),
					'permission_callback' => array( self::class, 'can_create_browser_playground_session' ),
					'meta'                => array( 'show_in_rest' => true ),
				)
			);

			wp_register_ability(
				'wp-codebox/list-artifacts',
				array(
					'label'               => 'List WP Codebox Artifacts',
					'description'         => 'List artifact bundles under the configured WP Codebox artifact root.',
					'category'            => 'wp-codebox',
					'input_schema'        => array(
						'type'       => 'object',
						'properties' => array(
							'artifacts_path' => $artifact_id_schema['artifacts_path'],
						),
					),
					'output_schema'       => array( 'type' => 'object' ),
					'execute_callback'    => array( self::class, 'list_artifacts' ),
					'permission_callback' => array( self::class, 'can_run_agent_task' ),
					'meta'                => array( 'show_in_rest' => true ),
				)
			);

			wp_register_ability(
				'wp-codebox/get-artifact',
				array(
					'label'               => 'Get WP Codebox Artifact',
					'description'         => 'Read one WP Codebox artifact bundle by id.',
					'category'            => 'wp-codebox',
					'input_schema'        => array(
						'type'       => 'object',
						'required'   => array( 'artifact_id' ),
						'properties' => $artifact_id_schema,
					),
					'output_schema'       => array( 'type' => 'object' ),
					'execute_callback'    => array( self::class, 'get_artifact' ),
					'permission_callback' => array( self::class, 'can_run_agent_task' ),
					'meta'                => array( 'show_in_rest' => true ),
				)
			);

			wp_register_ability(
				'wp-codebox/discard-artifact',
				array(
					'label'               => 'Discard WP Codebox Artifact',
					'description'         => 'Delete one WP Codebox artifact bundle from the configured artifact root.',
					'category'            => 'wp-codebox',
					'input_schema'        => array(
						'type'       => 'object',
						'required'   => array( 'artifact_id' ),
						'properties' => $artifact_id_schema,
					),
					'output_schema'       => array( 'type' => 'object' ),
					'execute_callback'    => array( self::class, 'discard_artifact' ),
					'permission_callback' => array( self::class, 'can_run_agent_task' ),
					'meta'                => array( 'show_in_rest' => true ),
				)
			);

			wp_register_ability(
				'wp-codebox/normalize-browser-artifact-bundle',
				array(
					'label'               => 'Normalize Browser Artifact Bundle',
					'description'         => 'Normalize and verify a caller-owned browser artifact bundle without interpreting product-specific roles or metadata.',
					'category'            => 'wp-codebox',
					'input_schema'        => array(
						'type'       => 'object',
						'required'   => array( 'schema_id', 'entrypoint', 'files' ),
						'properties' => array(
							'schema_id'  => array(
								'type'        => 'string',
								'description' => 'Caller-owned schema id for the product artifact contract being normalized.',
							),
							'root'       => array(
								'type'        => 'string',
								'description' => 'Optional safe relative artifact root applied to entrypoint and file paths.',
							),
							'entrypoint' => array(
								'type'        => 'string',
								'description' => 'Safe relative entrypoint path that must exist in the normalized files.',
							),
							'roles'      => array(
								'type'        => 'object',
								'description' => 'Opaque caller role metadata preserved without product-specific interpretation.',
							),
							'provenance' => array(
								'type'        => 'object',
								'description' => 'Opaque caller provenance preserved on the normalized bundle.',
							),
							'metadata'   => array(
								'type'        => 'object',
								'description' => 'Opaque caller metadata preserved on the normalized bundle.',
							),
							'files'      => array(
								'type'        => 'array',
								'description' => 'Browser-produced artifact files to normalize.',
								'items'       => array(
									'type'       => 'object',
									'required'   => array( 'path' ),
									'properties' => array(
										'path'           => array( 'type' => 'string' ),
										'content'        => array( 'type' => 'string' ),
										'content_base64' => array( 'type' => 'string' ),
										'encoding'       => array( 'type' => 'string', 'enum' => array( 'utf-8', 'base64' ) ),
										'mime_type'      => array( 'type' => 'string' ),
										'kind'           => array( 'type' => 'string' ),
										'roles'          => array( 'type' => 'array', 'items' => array( 'type' => 'string' ) ),
									),
								),
							),
						),
					),
					'output_schema'       => array( 'type' => 'object' ),
					'execute_callback'    => array( self::class, 'normalize_browser_artifact_bundle' ),
					'permission_callback' => array( self::class, 'can_run_agent_task' ),
					'meta'                => array( 'show_in_rest' => true ),
				)
			);

			wp_register_ability(
				'wp-codebox/persist-browser-artifact',
				array(
					'label'               => 'Persist Browser Artifact',
					'description'         => 'Persist browser-produced files from a disposable Playground session as a canonical WP Codebox artifact bundle.',
					'category'            => 'wp-codebox',
					'input_schema'        => array(
						'type'       => 'object',
						'required'   => array( 'files' ),
						'properties' => array(
							'artifacts_path' => $artifact_id_schema['artifacts_path'],
							'authorization'  => self::trusted_orchestrator_authorization_schema( self::BROWSER_ARTIFACT_WRITE_SCOPE, 'Explicit trusted orchestrator authorization for browser artifact persistence. Callers must provide a caller id and the artifact:write scope; sites grant trust through wp_codebox_trusted_browser_session_callers.' ),
							'session_id'     => array(
								'type'        => 'string',
								'description' => 'Optional browser Playground session id that produced the artifact files.',
							),
							'session'        => array(
								'type'        => 'object',
								'description' => 'Optional browser session metadata to preserve in artifact runtime provenance.',
							),
							'provenance'     => array(
								'type'        => 'object',
								'description' => 'Opaque caller provenance describing who requested the browser run and what produced these files.',
							),
							'caller'         => array(
								'type'        => 'object',
								'description' => 'Opaque caller-owned schema and metadata to preserve in the canonical artifact bundle.',
							),
							'caller_schema'  => array(
								'type'        => 'string',
								'description' => 'Optional caller schema URI or id preserved under metadata.caller.schema.',
							),
							'caller_schema_id' => array(
								'type'        => 'string',
								'description' => 'Optional caller schema id preserved under metadata.caller.schemaId.',
							),
							'caller_kind'    => array(
								'type'        => 'string',
								'description' => 'Optional caller artifact kind preserved under metadata.caller.kind.',
							),
							'caller_metadata' => array(
								'type'        => 'object',
								'description' => 'Opaque caller-owned artifact bundle metadata preserved under metadata.caller.metadata.',
							),
							'materialization' => array(
								'type'        => 'object',
								'description' => 'Opaque caller materialization metadata preserved under metadata.caller.materialization.',
							),
							'review_hints'   => array(
								'type'        => 'object',
								'description' => 'Optional caller review hints preserved in bundle metadata and review metadata.',
							),
							'apply_target'   => array(
								'type'        => 'object',
								'description' => 'Opaque caller apply target metadata preserved under metadata.caller.applyTarget.',
							),
							'files'          => array(
								'type'        => 'array',
								'description' => 'Browser-produced artifact files to store under files/browser/ in a canonical WP Codebox artifact bundle.',
								'items'       => array(
									'type'       => 'object',
									'required'   => array( 'path' ),
									'properties' => array(
										'path'           => array( 'type' => 'string' ),
										'content'        => array( 'type' => 'string' ),
										'content_base64' => array( 'type' => 'string' ),
										'encoding'       => array( 'type' => 'string', 'enum' => array( 'utf-8', 'base64' ) ),
										'mime_type'      => array( 'type' => 'string' ),
										'kind'           => array( 'type' => 'string' ),
									),
								),
							),
						),
					),
					'output_schema'       => array( 'type' => 'object' ),
					'execute_callback'    => array( self::class, 'persist_browser_artifact' ),
					'permission_callback' => array( self::class, 'can_persist_browser_artifact' ),
					'meta'                => array( 'show_in_rest' => true ),
				)
			);

			wp_register_ability(
				'wp-codebox/review-artifact',
				array(
					'label'               => 'Review WP Codebox Artifact',
					'description'         => 'Normalize an artifact review decision from a browser or parent product, then delegate only approval consequences through product-owned adapters.',
					'category'            => 'wp-codebox',
					'input_schema'        => array(
						'type'       => 'object',
						'required'   => array( 'artifact_id', 'action' ),
						'properties' => array_merge(
							$artifact_id_schema,
							array(
								'action'         => array(
									'type'        => 'string',
									'description' => 'Review decision action.',
									'enum'        => array( 'approve', 'reject', 'request-changes' ),
								),
								'approved_files' => array(
									'type'        => 'array',
									'description' => 'Explicit sandbox file paths approved by the reviewer. Required for approve decisions.',
									'items'       => array( 'type' => 'string' ),
								),
								'approver'       => array(
									'type'        => 'string',
									'description' => 'Parent-site reviewer principal for decision and audit records.',
								),
								'reason'         => array(
									'type'        => 'string',
									'description' => 'Optional reviewer note for reject or request-changes decisions.',
								),
								'decided_at'     => array( 'type' => 'string' ),
								'apply_target'   => array(
									'type'        => 'object',
									'description' => 'Optional parent-control-plane target metadata passed through to approval adapters.',
								),
								'context'        => array(
									'type'        => 'object',
									'description' => 'Opaque caller-owned context preserved on the normalized decision.',
								),
							)
						),
					),
					'output_schema'       => array( 'type' => 'object' ),
					'execute_callback'    => array( self::class, 'review_artifact' ),
					'permission_callback' => array( self::class, 'can_run_agent_task' ),
					'meta'                => array( 'show_in_rest' => true ),
				)
			);

			wp_register_ability(
				'wp-codebox/apply-artifact-preflight',
				array(
					'label'               => 'Preflight WP Codebox Artifact Apply',
					'description'         => 'Validate a canonical artifact bundle and return the apply adapter payload without mutating parent-side git, pull requests, or deployments.',
					'category'            => 'wp-codebox',
					'input_schema'        => array(
						'type'       => 'object',
						'required'   => array( 'artifact_id', 'approved_files' ),
						'properties' => array_merge(
							$artifact_id_schema,
							array(
								'approved_files' => array(
									'type'        => 'array',
									'description' => 'Explicit sandbox file paths approved by the parent-site reviewer. Preflight requires every changed file to be approved.',
									'items'       => array( 'type' => 'string' ),
								),
								'approver'       => array(
									'type'        => 'string',
									'description' => 'Parent-site approver principal preserved in the returned payload.',
								),
								'apply_target'   => array(
									'type'        => 'object',
									'description' => 'Optional parent-control-plane target metadata preserved in the returned payload.',
								),
							)
						),
					),
					'output_schema'       => array( 'type' => 'object' ),
					'execute_callback'    => array( self::class, 'apply_artifact_preflight' ),
					'permission_callback' => array( self::class, 'can_run_agent_task' ),
					'meta'                => array( 'show_in_rest' => true ),
				)
			);

			wp_register_ability(
				'wp-codebox/apply-approved-artifact',
				array(
					'label'               => 'Apply Approved WP Codebox Artifact',
					'description'         => 'Low-level adapter/test hook that validates an approved canonical artifact patch, delegates to the configured apply-back adapter, and returns wp-codebox/apply-result/v1.',
					'category'            => 'wp-codebox',
					'input_schema'        => array(
						'type'       => 'object',
						'required'   => array( 'artifact_id', 'approved_files' ),
						'properties' => array_merge(
							$artifact_id_schema,
							array(
								'approved_files' => array(
									'type'        => 'array',
									'description' => 'Explicit sandbox file paths approved by the parent-site reviewer.',
									'items'       => array( 'type' => 'string' ),
								),
								'approver'       => array(
									'type'        => 'string',
									'description' => 'Parent-site approver principal for audit records.',
								),
								'apply_target'   => array(
									'type'        => 'object',
									'description' => 'Optional parent-control-plane target metadata consumed by the apply adapter.',
								),
							)
						),
					),
					'output_schema'       => array( 'type' => 'object' ),
					'execute_callback'    => array( self::class, 'apply_approved_artifact' ),
					'permission_callback' => array( self::class, 'can_run_agent_task' ),
					'meta'                => array( 'show_in_rest' => true ),
				)
			);

			wp_register_ability(
				'wp-codebox/stage-artifact-apply',
				array(
					'label'               => 'Stage WP Codebox Artifact Apply',
					'description'         => 'Preferred user-facing API: stage a reviewed WP Codebox artifact apply-back request through Data Machine pending actions before resolving via apply-approved-artifact.',
					'category'            => 'wp-codebox',
					'input_schema'        => array(
						'type'       => 'object',
						'required'   => array( 'artifact_id', 'approved_files' ),
						'properties' => array_merge(
							$artifact_id_schema,
							array(
								'approved_files' => array(
									'type'        => 'array',
									'description' => 'Explicit sandbox file paths approved by the parent-site reviewer.',
									'items'       => array( 'type' => 'string' ),
								),
								'approver'       => array(
									'type'        => 'string',
									'description' => 'Parent-site approver principal for audit records.',
								),
								'apply_target'   => array(
									'type'        => 'object',
									'description' => 'Optional parent-control-plane target metadata consumed by the apply adapter.',
								),
								'summary'        => array(
									'type'        => 'string',
									'description' => 'Optional human-readable pending-action summary.',
								),
								'agent_id'       => array( 'type' => 'integer' ),
								'user_id'        => array( 'type' => 'integer' ),
								'context'        => array( 'type' => 'object' ),
							)
						),
					),
					'output_schema'       => array( 'type' => 'object' ),
					'execute_callback'    => array( self::class, 'stage_artifact_apply' ),
					'permission_callback' => array( self::class, 'can_run_agent_task' ),
					'meta'                => array( 'show_in_rest' => true ),
				)
			);
		};

		if ( function_exists( 'doing_action' ) && doing_action( 'wp_abilities_api_init' ) ) {
			$register_callback();
			return;
		}

		add_action( 'wp_abilities_api_init', $register_callback );
	}
}
