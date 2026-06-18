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
require_once __DIR__ . '/trait-wp-codebox-abilities-runner-publication.php';
require_once __DIR__ . '/trait-wp-codebox-abilities-browser-artifacts.php';
require_once __DIR__ . '/trait-wp-codebox-abilities-browser-callbacks.php';
require_once __DIR__ . '/trait-wp-codebox-abilities-browser-runtime.php';
require_once __DIR__ . '/trait-wp-codebox-abilities-browser-blueprint.php';
require_once __DIR__ . '/trait-wp-codebox-abilities-browser-runner.php';
require_once __DIR__ . '/trait-wp-codebox-abilities-browser-connectors.php';
require_once __DIR__ . '/trait-wp-codebox-abilities-agents-api-executors.php';
require_once __DIR__ . '/trait-wp-codebox-abilities-utils.php';
require_once __DIR__ . '/class-wp-codebox-browser-ability-descriptors.php';

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
	use WP_Codebox_Abilities_Runner_Publication;
	use WP_Codebox_Abilities_Browser_Artifacts;
	use WP_Codebox_Abilities_Browser_Callbacks;
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
		add_filter( 'rest_pre_dispatch', array( self::class, 'rest_handle_browser_callback_cors_preflight' ), 10, 3 );
		add_filter( 'rest_pre_serve_request', array( self::class, 'rest_send_browser_callback_cors_headers' ), 10, 4 );
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
		register_rest_route(
			'wp-codebox/v1',
			'/browser-callback/(?P<capability>[A-Za-z0-9][A-Za-z0-9_-]*)',
			array(
				'methods'             => 'POST',
				'callback'            => array( self::class, 'rest_browser_callback' ),
				'permission_callback' => '__return_true',
				'args'                => array(
					'capability' => array(
						'type'              => 'string',
						'required'          => true,
						'sanitize_callback' => 'sanitize_key',
					),
				),
			)
		);
		register_rest_route(
			'wp-codebox/v1',
			'/browser-blueprint-ref',
			array(
				'methods'             => 'GET',
				'callback'            => array( self::class, 'rest_browser_blueprint_ref' ),
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

	/** @param WP_REST_Request $request REST request. @return array<string,mixed>|WP_Error */
	public static function rest_browser_blueprint_ref( WP_REST_Request $request ): array|WP_Error {
		return self::hydrate_browser_blueprint_ref(
			array(
				'ref'        => (string) $request->get_param( 'ref' ),
				'cache_key'  => (string) $request->get_param( 'cache_key' ),
				'input_hash' => (string) $request->get_param( 'input_hash' ),
			)
		);
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
			// Core's `wp_abilities_api_categories_init` action can fire more than
			// once per request (e.g. on multisite), so guard against re-registering
			// an already-registered category to avoid a `_doing_it_wrong` notice.
			if ( function_exists( 'wp_has_ability_category' ) && wp_has_ability_category( 'wp-codebox' ) ) {
				return;
			}

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
			$host_agent_task_properties = self::host_agent_task_input_properties(
				$task_input_schema,
				$mount_schema,
				$site_seed_schema,
				$inherit_schema,
				$session_input,
				$preview_schema,
				array(
					'detailed'             => true,
					'task_fields'          => true,
					'site_seeds'           => true,
					'session_id'           => true,
					'task_timeout_seconds' => true,
				)
			);
			$host_agent_batch_properties = self::host_agent_task_input_properties(
				$task_input_schema,
				$mount_schema,
				$site_seed_schema,
				$inherit_schema,
				$session_input,
				$preview_schema
			);
			$host_agent_fanout_properties = self::host_agent_task_input_properties(
				$task_input_schema,
				$mount_schema,
				$site_seed_schema,
				$inherit_schema,
				$session_input,
				$preview_schema,
				array( 'task_timeout_seconds' => true )
			);
			$browser_session_properties = self::browser_task_input_properties( $task_input_schema, $inherit_schema, $session_input, true );
			$browser_contract_properties = self::browser_task_input_properties( $task_input_schema, $inherit_schema, $session_input );
			$artifact_apply_properties = self::artifact_apply_input_properties(
				'Explicit sandbox file paths approved by the parent-site reviewer.',
				'Parent-site approver principal for audit records.',
				'Optional parent-control-plane target metadata consumed by the apply adapter.'
			);
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
						'required'   => array( 'goal' ),
						'properties' => $host_agent_task_properties,
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
								'items'       => $task_input_schema,
							),
						) + $host_agent_batch_properties,
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
										'task'               => array( 'type' => 'string' ),
										'agent'              => array( 'type' => 'string' ),
										'timeout_seconds'    => array( 'type' => 'integer' ),
									) + self::task_input_alias_properties( $task_input_schema ),
								),
							),
							'concurrency'           => array(
								'type'        => 'integer',
								'description' => 'Maximum number of workers to run at once. Defaults to 1 and is capped by the host runtime.',
							),
						) + $host_agent_fanout_properties,
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
							'task'               => array( 'type' => 'string' ),
							'execution'          => array(
								'type'        => 'object',
								'description' => 'Product-neutral host execution preferences or requirements. WP Codebox preserves this for the host provider without interpreting product policy.',
							),
							'orchestrator'       => $session_input['orchestrator'],
							'sandbox_session_id' => $session_input['sandbox_session_id'],
							'metadata'           => array( 'type' => 'object' ),
						) + self::task_input_alias_properties( $task_input_schema ),
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
				'wp-codebox/prepare-runner-workspace',
				array(
					'label'               => 'Prepare Runner Workspace',
					'description'         => 'Prepare a runner-owned workspace through the WP Codebox runner boundary without exposing backend workspace internals to callers.',
					'category'            => 'wp-codebox',
					'input_schema'        => self::runner_workspace_prepare_input_schema(),
					'output_schema'       => self::runner_workspace_prepare_output_schema(),
					'execute_callback'    => array( self::class, 'prepare_runner_workspace' ),
					'permission_callback' => array( self::class, 'can_run_agent_task' ),
					'meta'                => array( 'show_in_rest' => true ),
				)
			);

			wp_register_ability(
				'wp-codebox/publish-runner-workspace',
				array(
					'label'               => 'Publish Runner Workspace',
					'description'         => 'Publish runner-owned workspace changes through the WP Codebox runner boundary without exposing backend publication internals to callers.',
					'category'            => 'wp-codebox',
					'input_schema'        => self::runner_workspace_publication_input_schema(),
					'output_schema'       => self::runner_workspace_publication_output_schema(),
					'execute_callback'    => array( self::class, 'publish_runner_workspace' ),
					'permission_callback' => array( self::class, 'can_run_agent_task' ),
					'meta'                => array( 'show_in_rest' => true ),
				)
			);

			wp_register_ability(
				'wp-codebox/runner-workspace-publish',
				array(
					'label'               => 'Publish Runner Workspace',
					'description'         => 'Publish runner-owned workspace changes through the WP Codebox runner boundary without exposing backend publication internals to callers.',
					'category'            => 'wp-codebox',
					'input_schema'        => self::runner_workspace_publication_input_schema(),
					'output_schema'       => self::runner_workspace_publication_output_schema(),
					'execute_callback'    => array( self::class, 'publish_runner_workspace' ),
					'permission_callback' => array( self::class, 'can_run_agent_task' ),
					'meta'                => array( 'show_in_rest' => true ),
				)
			);

			wp_register_ability(
				'wp-codebox/capture-runner-workspace',
				array(
					'label'               => 'Capture Runner Workspace',
					'description'         => 'Capture runner-owned workspace status and diff metadata through the WP Codebox runner boundary without exposing backend workspace internals to callers.',
					'category'            => 'wp-codebox',
					'input_schema'        => self::runner_workspace_capture_input_schema(),
					'output_schema'       => self::runner_workspace_capture_output_schema(),
					'execute_callback'    => array( self::class, 'capture_runner_workspace' ),
					'permission_callback' => array( self::class, 'can_run_agent_task' ),
					'meta'                => array( 'show_in_rest' => true ),
				)
			);

			wp_register_ability(
				'wp-codebox/run-runner-workspace-command',
				array(
					'label'               => 'Run Runner Workspace Command',
					'description'         => 'Run a bounded verification or drift-check command against a runner-owned workspace through the WP Codebox runner boundary.',
					'category'            => 'wp-codebox',
					'input_schema'        => self::runner_workspace_command_input_schema(),
					'output_schema'       => self::runner_workspace_command_output_schema(),
					'execute_callback'    => array( self::class, 'run_runner_workspace_command' ),
					'permission_callback' => array( self::class, 'can_run_agent_task' ),
					'meta'                => array( 'show_in_rest' => true ),
				)
			);

			wp_register_ability(
				'wp-codebox/runner-workspace-command',
				array(
					'label'               => 'Run Runner Workspace Command',
					'description'         => 'Run a bounded verification or drift-check command against a runner-owned workspace through the WP Codebox runner boundary.',
					'category'            => 'wp-codebox',
					'input_schema'        => self::runner_workspace_command_input_schema(),
					'output_schema'       => self::runner_workspace_command_output_schema(),
					'execute_callback'    => array( self::class, 'run_runner_workspace_command' ),
					'permission_callback' => array( self::class, 'can_run_agent_task' ),
					'meta'                => array( 'show_in_rest' => true ),
				)
			);

			foreach ( WP_Codebox_Browser_Ability_Descriptors::descriptors(
				array(
					'artifact_id_schema'          => $artifact_id_schema,
					'browser_contract_properties' => $browser_contract_properties,
					'browser_session_properties'  => $browser_session_properties,
					'browser_session_schema'      => $browser_session_schema,
					'inherit_schema'              => $inherit_schema,
					'session_input'               => $session_input,
					'browser_connector_authorization_schema' => self::browser_connector_authorization_schema(),
					'browser_connector_request_schema' => self::browser_connector_request_schema(),
					'browser_connector_response_schema' => self::browser_connector_response_schema(),
					'browser_materializer_contract_schema' => self::browser_materializer_contract_schema(),
					'browser_task_contract_schema' => self::browser_task_contract_schema(),
					'browser_task_phase_kinds'    => self::browser_task_phase_kinds(),
					'trusted_artifact_authorization_schema' => self::trusted_orchestrator_authorization_schema( self::BROWSER_ARTIFACT_WRITE_SCOPE, 'Explicit trusted orchestrator authorization for browser artifact persistence. Callers must provide a caller id and the artifact:write scope; sites grant trust through wp_codebox_trusted_browser_session_callers.' ),
				)
			) as $ability_id => $ability_definition ) {
				wp_register_ability( $ability_id, $ability_definition );
			}

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
							self::artifact_apply_input_properties(
								'Explicit sandbox file paths approved by the reviewer. Required for approve decisions.',
								'Parent-site reviewer principal for decision and audit records.',
								'Optional parent-control-plane target metadata passed through to approval adapters.'
							),
							array(
								'action'         => array(
									'type'        => 'string',
									'description' => 'Review decision action.',
									'enum'        => array( 'approve', 'reject', 'request-changes' ),
								),
								'reason'         => array(
									'type'        => 'string',
									'description' => 'Optional reviewer note for reject or request-changes decisions.',
								),
								'decided_at'     => array( 'type' => 'string' ),
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
							self::artifact_apply_input_properties(
								'Explicit sandbox file paths approved by the parent-site reviewer. Preflight requires every changed file to be approved.',
								'Parent-site approver principal preserved in the returned payload.',
								'Optional parent-control-plane target metadata preserved in the returned payload.'
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
							$artifact_apply_properties
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
					'description'         => 'Preferred user-facing API: stage a reviewed WP Codebox artifact apply-back request through the host approval adapter before resolving via apply-approved-artifact.',
					'category'            => 'wp-codebox',
					'input_schema'        => array(
						'type'       => 'object',
						'required'   => array( 'artifact_id', 'approved_files' ),
						'properties' => array_merge(
							$artifact_id_schema,
							$artifact_apply_properties,
							array(
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
