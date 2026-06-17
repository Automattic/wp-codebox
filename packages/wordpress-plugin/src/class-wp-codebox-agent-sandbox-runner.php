<?php
/**
 * Host-side WP Codebox agent sandbox runner.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_Agent_Sandbox_Runner {

	private const SCHEMA = 'wp-codebox/agent-task-run/v1';
	private const BATCH_SCHEMA = 'wp-codebox/agent-task-batch/v1';
	private const FANOUT_PLAN_SCHEMA = 'wp-codebox/agent-fanout-plan/v1';
	private const FANOUT_EVENT_SCHEMA = 'wp-codebox/agent-fanout-event/v1';
	private const FANOUT_SCHEMA = 'wp-codebox/agent-fanout-result/v1';
	private const FANOUT_AGGREGATE_SCHEMA = 'wp-codebox/agent-fanout-aggregate/v1';
	private const FANOUT_ARTIFACTS_SCHEMA = 'wp-codebox/agent-fanout-artifacts/v1';
	private const DEFAULT_WORDPRESS_VERSION = 'latest';
	private const FANOUT_MAX_CONCURRENCY = 8;
	private const TASK_INPUT_SCHEMA = WP_Codebox_Agent_Task::INPUT_SCHEMA;
	private const TOOL_DENIAL_SCHEMA = 'wp-codebox/tool-allowlist-denial/v1';
	private const SANDBOX_TOOL_POLICY_SCHEMA = 'wp-codebox/sandbox-tool-policy/v1';
	private const AGENTS_API_RUNTIME_ENVIRONMENT = 'environment';
	private const AGENTS_API_RUNTIME_CAPABILITY_SCOPE = 'capability_scope';
	private const AGENTS_API_RUNTIME_LOCAL = 'runtime_local';
	private const AGENTS_API_CONTROL_PLANE = 'control_plane';

	/** @var array<string, callable> */
	private array $callbacks;
	private WP_Codebox_Host_Tool_Policy_Validator $tool_policy_validator;
	private WP_Codebox_Host_Preview_Args_Builder $preview_args_builder;
	private WP_Codebox_Agent_Runtime_Config_Resolver $runtime_config_resolver;
	private WP_Codebox_Host_Recipe_Builder $recipe_builder;
	private WP_Codebox_Host_Run_Result_Normalizer $run_result_normalizer;
	private WP_Codebox_Agent_Run_Result_Builder $result_builder;
	private WP_Codebox_Parent_Site_Seed_Exporter $site_seed_exporter;
	private WP_Codebox_Run_Plan $run_plan;
	private WP_Codebox_Agent_Process_Runner $process_runner;
	private WP_Codebox_Agent_Outcome_Classifier $outcome_classifier;

	/**
	 * @param array<string, callable> $callbacks Test seams for pure-PHP smoke coverage.
	 */
	public function __construct( array $callbacks = array() ) {
		$this->callbacks               = $callbacks;
		$this->tool_policy_validator   = new WP_Codebox_Host_Tool_Policy_Validator();
		$this->preview_args_builder    = new WP_Codebox_Host_Preview_Args_Builder();
		$this->runtime_config_resolver = new WP_Codebox_Agent_Runtime_Config_Resolver();
		$this->recipe_builder          = new WP_Codebox_Host_Recipe_Builder();
		$this->run_result_normalizer   = new WP_Codebox_Host_Run_Result_Normalizer();
		$this->site_seed_exporter      = new WP_Codebox_Parent_Site_Seed_Exporter();
		$this->run_plan                = new WP_Codebox_Run_Plan();
		$this->process_runner          = new WP_Codebox_Agent_Process_Runner( $callbacks );
		$this->result_builder          = new WP_Codebox_Agent_Run_Result_Builder( $this->run_plan );
		$this->outcome_classifier      = new WP_Codebox_Agent_Outcome_Classifier();
	}

	/**
	 * Run a task inside an isolated WP Codebox agent sandbox.
	 *
	 * @param array<string,mixed> $input Ability input.
	 * @return array<string,mixed>|WP_Error
	 */
	public function run( array $input ): array|WP_Error {
		if ( ! $this->process_runner->shell_available() ) {
			return new WP_Error( 'wp_codebox_shell_unavailable', 'Shell execution is not available for WP Codebox.', array( 'status' => 500 ) );
		}

		$prepared = $this->prepare_agent_task_run( $input );
		if ( is_wp_error( $prepared ) ) {
			return $prepared;
		}

		$result = $this->process_runner->run_command( (string) $prepared['command'], $prepared['process_secret_env'], (int) $prepared['timeout_seconds'] );

		return $this->complete_agent_task_run( $prepared, $result );
	}

	/**
	 * Run multiple workers with bounded host-side concurrency.
	 *
	 * @param array<string,mixed> $input Ability input.
	 * @return array<string,mixed>|WP_Error
	 */
	public function run_fanout( array $input ): array|WP_Error {
		if ( ! $this->process_runner->shell_available() ) {
			return new WP_Error( 'wp_codebox_shell_unavailable', 'Shell execution is not available for WP Codebox.', array( 'status' => 500 ) );
		}

		$workers = $this->fanout_workers( $input );
		if ( is_wp_error( $workers ) ) {
			return $workers;
		}

		$concurrency = $this->fanout_concurrency( $input );
		if ( is_wp_error( $concurrency ) ) {
			return $concurrency;
		}

		$parent_session_id = $this->sandbox_session_id( $input );
		$paths = $this->run_plan_paths( $this->clean_path( (string) ( $input['artifacts_path'] ?? $this->default_artifacts_path() ) ) );
		foreach ( array( $paths['workers'], $paths['aggregate_artifacts'] ) as $path ) {
			if ( ! $this->ensure_directory( $path ) ) {
				return new WP_Error( 'wp_codebox_fanout_artifacts_unwritable', 'Could not create fanout artifact directories.', array( 'status' => 500, 'path' => $path ) );
			}
		}

		$plan = $this->run_plan_contract( self::FANOUT_PLAN_SCHEMA, $parent_session_id, $concurrency, $input, $workers );
		$this->write_json_file( $paths['plan'], $plan );
		$this->append_fanout_event( $paths['root'], array( 'event' => 'fanout.started', 'total' => count( $workers ), 'concurrency' => $concurrency ) );

		$prepared_workers = array();
		foreach ( $workers as $index => $worker ) {
			$worker_id      = (string) $worker['id'];
			$worker_path    = $paths['workers'] . DIRECTORY_SEPARATOR . $worker_id;
			$worker_input   = $this->fanout_worker_input( $input, $worker, $parent_session_id, $worker_path );
			$worker_prepare = $this->prepare_agent_task_run( $worker_input );
			if ( is_wp_error( $worker_prepare ) ) {
				$prepared_workers[] = array(
					'id'       => $worker_id,
					'index'    => $index,
					'prepared' => null,
					'error'    => $worker_prepare,
					'path'     => $worker_path,
				);
				continue;
			}

			$prepared_workers[] = array(
				'id'       => $worker_id,
				'index'    => $index,
				'prepared' => $worker_prepare,
				'error'    => null,
				'path'     => $worker_path,
			);
		}

		$started_at = microtime( true );
		$runs       = $this->execute_prepared_fanout_workers( $prepared_workers, $concurrency, $paths['root'] );
		$ended_at   = microtime( true );
		ksort( $runs );
		$runs = array_values( $runs );

		$counts = $this->result_builder->status_counts( $runs );
		$success = $this->run_plan->succeeded( $counts );
		$status  = $success ? 'completed' : 'failed';
		$this->append_fanout_event( $paths['root'], array( 'event' => 'aggregation.started', 'completed' => $counts['completed'], 'failed' => $counts['failed'], 'cancelled' => $counts['cancelled'] ) );

		$result = $this->result_builder->fanout_result(
			self::FANOUT_SCHEMA,
			self::FANOUT_ARTIFACTS_SCHEMA,
			'bounded-concurrent-isolated-sandboxes',
			$parent_session_id,
			$status,
			$input,
			$paths,
			$counts,
			$started_at,
			$ended_at,
			$plan,
			$runs
		);

		$this->write_json_file( $paths['aggregate_result'], $this->run_plan->aggregate_result( self::FANOUT_AGGREGATE_SCHEMA, $status, $counts ) );
		$this->append_fanout_event( $paths['root'], array( 'event' => 'aggregation.completed', 'status' => $status ) );
		$this->write_json_file( $paths['result'], $result );
		$this->append_fanout_event( $paths['root'], array( 'event' => $success ? 'fanout.completed' : 'fanout.failed', 'status' => $status, 'completed' => $counts['completed'], 'failed' => $counts['failed'], 'cancelled' => $counts['cancelled'] ) );

		return $result;
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	private function prepare_agent_task_run( array $input ): array|WP_Error {
		$input = $this->normalize_parent_task_request( $input );
		if ( is_wp_error( $input ) ) {
			return $input;
		}

		$task_input = $this->task_input( $input );
		if ( is_wp_error( $task_input ) ) {
			return $task_input;
		}
		$task        = (string) $task_input['goal'];
		$task_prompt = $this->task_input_prompt( $task_input );
		$session_id  = $this->sandbox_session_id( $input );

		$raw_code_input = $this->reject_raw_code_input( $input );
		if ( is_wp_error( $raw_code_input ) ) {
			return $raw_code_input;
		}

		$paths = $this->resolve_component_paths( $input );
		if ( is_wp_error( $paths ) ) {
			return $paths;
		}

		$artifacts = $this->clean_path( (string) ( $input['artifacts_path'] ?? $this->default_artifacts_path() ) );
		$wp_version = trim( (string) ( $input['wp'] ?? self::DEFAULT_WORDPRESS_VERSION ) );
		if ( '' === $wp_version ) {
			$wp_version = self::DEFAULT_WORDPRESS_VERSION;
		}

		$bin = trim( (string) ( $input['wp_codebox_bin'] ?? $this->default_bin() ) );
		if ( '' === $bin || ! preg_match( '#^[A-Za-z0-9_./:@+-]+$#', $bin ) ) {
			return new WP_Error( 'wp_codebox_bin_invalid', 'wp_codebox_bin must be a command name or path without shell metacharacters.', array( 'status' => 400 ) );
		}

		$command_prefix = $this->command_prefix( $bin );
		if ( is_wp_error( $command_prefix ) ) {
			return $command_prefix;
		}

		$preview_args = $this->preview_args( $input );
		if ( is_wp_error( $preview_args ) ) {
			return $preview_args;
		}

		$inheritance_payload = $this->runtime_config_resolver->inheritance_resolution_payload( $input );
		$recipe_payload      = $this->write_agent_recipe( $paths, $input, array( $task_prompt ), $wp_version, $inheritance_payload['inheritance_audit'] );
		if ( is_wp_error( $recipe_payload ) ) {
			return $recipe_payload;
		}
		$recipe_file = (string) $recipe_payload['path'];

		$command = sprintf(
			'%s recipe-run --recipe %s --artifacts %s --json',
			$command_prefix,
			escapeshellarg( $recipe_file ),
			escapeshellarg( $artifacts )
		);
		$command .= $preview_args;

		return array(
			'input'              => $input,
			'task_input'         => $task_input,
			'task'               => $task,
			'session_id'         => $session_id,
			'paths'              => $paths,
			'artifacts'          => $artifacts,
			'wp_version'         => $wp_version,
			'command'            => $command,
			'process_secret_env' => $inheritance_payload['process_secret_env'],
			'timeout_seconds'    => $this->task_timeout_seconds( $input ),
			'recipe_file'        => $recipe_file,
			'cleanup_paths'      => $recipe_payload['cleanup_paths'],
		);
	}

	/** @param array<string,mixed> $prepared Prepared run. @param array<string,mixed> $result Command result. @return array<string,mixed>|WP_Error */
	private function complete_agent_task_run( array $prepared, array $result ): array|WP_Error {
		return $this->run_result_normalizer->normalize(
			$prepared,
			$result,
			array(
				'bound_output'               => fn( string $output ): string => $this->bound_output( $output ),
				'decode_json_output'         => fn( string $output ): array|WP_Error => $this->decode_json_output( $output ),
				'strict_remediation_outcome' => fn( array $task_input ): bool => $this->outcome_classifier->strict_remediation_outcome( $task_input ),
				'remediation_outcome'        => fn( array $run, int $exit_code, string $output ): array => $this->outcome_classifier->remediation_outcome( $run, $exit_code, $output ),
				'sandbox_session'            => fn( string $session_id, string $status, array $input, array $run, string $artifacts ): array => $this->sandbox_session( $session_id, $status, $input, $run, $artifacts ),
				'completion_outcome'         => fn( array $run ): array => $this->outcome_classifier->completion_outcome( $run ),
				'run_diagnostics'            => fn( array $run, int $exit_code, ?array $outcome ): array => $this->outcome_classifier->run_diagnostics( $run, $exit_code, $outcome ),
				'evidence_refs'              => fn( array $session, array $run ): array => $this->evidence_refs( $session, $run ),
				'run_metadata'               => fn( string $session_id, array $input, string $wp_version, array $run ): array => $this->run_metadata( $session_id, $input, $wp_version, $run ),
			)
		);
	}

	/**
	 * Run multiple tasks, each in its own isolated WP Codebox agent sandbox.
	 *
	 * @param array<string,mixed> $input Ability input.
	 * @return array<string,mixed>|WP_Error
	 */
	public function run_batch( array $input ): array|WP_Error {
		if ( ! $this->process_runner->shell_available() ) {
			return new WP_Error( 'wp_codebox_shell_unavailable', 'Shell execution is not available for WP Codebox.', array( 'status' => 500 ) );
		}

		$input = $this->normalize_parent_task_request( $input );
		if ( is_wp_error( $input ) ) {
			return $input;
		}

		$task_inputs = $this->task_inputs( $input );
		if ( is_wp_error( $task_inputs ) ) {
			return $task_inputs;
		}

		if ( empty( $task_inputs ) ) {
			return new WP_Error( 'wp_codebox_tasks_missing', 'tasks must include at least one task.', array( 'status' => 400 ) );
		}
		$tasks      = array_map( static fn( array $task_input ): string => (string) $task_input['goal'], $task_inputs );
		$session_id = $this->sandbox_session_id( $input );

		$paths = $this->resolve_component_paths( $input );
		if ( is_wp_error( $paths ) ) {
			return $paths;
		}

		$artifacts  = $this->clean_path( (string) ( $input['artifacts_path'] ?? $this->default_artifacts_path() ) );
		$wp_version = trim( (string) ( $input['wp'] ?? self::DEFAULT_WORDPRESS_VERSION ) );
		if ( '' === $wp_version ) {
			$wp_version = self::DEFAULT_WORDPRESS_VERSION;
		}

		$bin = trim( (string) ( $input['wp_codebox_bin'] ?? $this->default_bin() ) );
		if ( '' === $bin || ! preg_match( '#^[A-Za-z0-9_./:@+-]+$#', $bin ) ) {
			return new WP_Error( 'wp_codebox_bin_invalid', 'wp_codebox_bin must be a command name or path without shell metacharacters.', array( 'status' => 400 ) );
		}

		$runs = array();
		foreach ( $task_inputs as $index => $task_input ) {
			$task_input_request = array_merge( $input, $task_input );
			unset( $task_input_request['tasks'], $task_input_request['task'], $task_input_request['concurrency'], $task_input_request['session_id'] );

			if ( ! empty( $input['sandbox_session_id'] ) ) {
				$task_input_request['sandbox_session_id'] = $session_id . ':' . ( $index + 1 );
			}

			$task_result = $this->run( $task_input_request );
			if ( is_wp_error( $task_result ) ) {
				$runs[] = $this->result_builder->batch_error_run( $index, $task_input, $task_result );
				continue;
			}

			$runs[] = $this->result_builder->batch_success_run( $index, $task_input, $task_result );
		}

		return $this->result_builder->batch_result(
			self::BATCH_SCHEMA,
			$this->sandbox_session( $session_id, 'completed', $input, array(), $artifacts ),
			$tasks,
			$task_inputs,
			'sequential-isolated-sandboxes',
			$wp_version,
			$paths,
			$artifacts,
			$runs
		);
	}

	/** @return array<string,string> */
	private function run_plan_paths( string $base_artifacts ): array {
		return $this->run_plan->paths( $base_artifacts, 'fanout' );
	}

	/** @param array<string,mixed> $input Ability input. @param array<int,array<string,mixed>> $workers Workers. @return array<string,mixed> */
	private function run_plan_contract( string $schema, string $session_id, int $concurrency, array $input, array $workers ): array {
		$descriptors = array_map( static fn( array $worker ): array => $worker['_run_plan_descriptor'], $workers );

		return $this->run_plan->plan( $schema, $session_id, $concurrency, is_array( $input['orchestrator'] ?? null ) ? $input['orchestrator'] : array(), $descriptors );
	}

	/** @param array<string,mixed> $input Ability input. @return array<int,array<string,mixed>>|WP_Error */
	private function fanout_workers( array $input ): array|WP_Error {
		$workers = is_array( $input['workers'] ?? null ) ? $input['workers'] : array();
		$descriptors = $this->run_plan->normalize_worker_descriptors( $workers, array( 'default_agent' => (string) ( $input['agent'] ?? '' ), 'require_goal' => true ) );
		if ( is_wp_error( $descriptors ) ) {
			return $this->fanout_worker_descriptor_error( $descriptors );
		}

		return array_map(
			static function ( array $descriptor ): array {
				$worker = $descriptor['worker'];
				$worker['_run_plan_descriptor'] = $descriptor;
				return $worker;
			},
			$descriptors
		);
	}

	private function fanout_concurrency( array $input ): int|WP_Error {
		$max         = self::FANOUT_MAX_CONCURRENCY;
		if ( function_exists( 'apply_filters' ) ) {
			$max = max( 1, (int) apply_filters( 'wp_codebox_agent_fanout_max_concurrency', $max ) );
		}

		$concurrency = $this->run_plan->normalize_concurrency( $input['concurrency'] ?? null, array( 'max_concurrency' => $max, 'concurrency_mode' => 'validate' ) );
		if ( is_wp_error( $concurrency ) ) {
			return new WP_Error( 'wp_codebox_fanout_concurrency_invalid', 'Fanout concurrency must be between 1 and ' . $max . '.', array( 'status' => 400, 'max' => $max ) );
		}

		return $concurrency;
	}

	/** @param array<string,mixed> $parent Parent input. @param array<string,mixed> $worker Worker input. @return array<string,mixed> */
	private function fanout_worker_input( array $parent, array $worker, string $parent_session_id, string $worker_path ): array {
		$descriptor            = is_array( $worker['_run_plan_descriptor'] ?? null ) ? $worker['_run_plan_descriptor'] : array();
		$artifact_namespace    = (string) ( $descriptor['artifact_namespace'] ?? $worker['id'] );
		$worker_artifacts_path = $worker_path . DIRECTORY_SEPARATOR . 'artifacts';
		$this->ensure_directory( $worker_artifacts_path );

		$input = array_merge( $parent, $worker );
		unset( $input['workers'], $input['dependencies'], $input['aggregation'], $input['concurrency'], $input['_run_plan_descriptor'] );

		$input['goal']               = (string) $worker['goal'];
		$input['sandbox_session_id'] = $parent_session_id . ':' . (string) $worker['id'];
		$input['artifacts_path']     = $worker_artifacts_path;
		$input['context']            = is_array( $input['context'] ?? null ) ? $input['context'] : array();
		$input['context']['fanout']  = array(
			'parent_session_id'  => $parent_session_id,
			'worker_id'          => (string) $worker['id'],
			'artifact_namespace' => $artifact_namespace,
		);

		if ( isset( $descriptor['timeout_seconds'] ) && ! isset( $worker['task_timeout_seconds'] ) ) {
			$input['task_timeout_seconds'] = (int) $descriptor['timeout_seconds'];
		}

		return $input;
	}

	/** @param array<int,array<string,mixed>> $prepared_workers Prepared workers. @return array<int,array<string,mixed>> */
	private function execute_prepared_fanout_workers( array $prepared_workers, int $concurrency, string $fanout_path ): array {
		$runs   = array();
		$active = array();
		$next   = 0;
		$total  = count( $prepared_workers );

		while ( $next < $total || ! empty( $active ) ) {
			while ( count( $active ) < $concurrency && $next < $total ) {
				$item = $prepared_workers[ $next ];
				++$next;

				if ( is_wp_error( $item['error'] ?? null ) ) {
					$runs[ (int) $item['index'] ] = $this->result_builder->fanout_worker_error_result( $item, $item['error'], 0, 0 );
					$this->write_json_file( (string) $item['path'] . DIRECTORY_SEPARATOR . 'result.json', $runs[ (int) $item['index'] ] );
					continue;
				}

				$started = $this->process_runner->start_fanout_worker_process( $item );
				if ( is_wp_error( $started ) ) {
					$runs[ (int) $item['index'] ] = $this->result_builder->fanout_worker_error_result( $item, $started, 0, 0 );
					$this->write_json_file( (string) $item['path'] . DIRECTORY_SEPARATOR . 'result.json', $runs[ (int) $item['index'] ] );
					continue;
				}

				$active[] = $started;
				$this->append_fanout_event( $fanout_path, array( 'event' => 'worker.started', 'worker_id' => (string) $item['id'], 'active' => count( $active ) ) );
			}

			foreach ( $active as $active_index => &$worker ) {
				$captured = $this->process_runner->capture_fanout_worker_process_result( $worker );
				$worker   = $captured['worker'];

				if ( null === $captured['result'] ) {
					continue;
				}

				$result = $captured['result'];

				$completed = $this->complete_agent_task_run( $worker['prepared'], $result );
				$runs[ (int) $worker['index'] ] = is_wp_error( $completed ) ? $this->result_builder->fanout_worker_error_result( $worker, $completed, (float) $worker['started_at'], microtime( true ) ) : $this->result_builder->fanout_worker_success_result( $worker, $completed, (float) $worker['started_at'], microtime( true ) );
				$this->write_json_file( (string) $worker['path'] . DIRECTORY_SEPARATOR . 'result.json', $runs[ (int) $worker['index'] ] );
				$this->append_fanout_event( $fanout_path, array( 'event' => true === ( $runs[ (int) $worker['index'] ]['success'] ?? false ) ? 'worker.completed' : 'worker.failed', 'worker_id' => (string) $worker['id'], 'status' => (string) $runs[ (int) $worker['index'] ]['status'] ) );
				unset( $active[ $active_index ] );
			}
			unset( $worker );

			$active = array_values( $active );
			if ( ! empty( $active ) ) {
				usleep( 50000 );
			}
		}

		return $runs;
	}

	private function ensure_directory( string $path ): bool {
		return is_dir( $path ) || mkdir( $path, 0777, true );
	}

	/** @param array<string,mixed> $data Data to write. */
	private function write_json_file( string $path, array $data ): void {
		WP_Codebox_Json::write_file( $path, $data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES );
	}

	/** @param array<string,mixed> $event Event data. */
	private function append_fanout_event( string $fanout_path, array $event ): void {
		$this->append_run_plan_event( $fanout_path . DIRECTORY_SEPARATOR . 'events.jsonl', self::FANOUT_EVENT_SCHEMA, $event );
	}

	/** @param array<string,mixed> $event Event data. */
	private function append_run_plan_event( string $events_path, string $schema, array $event ): void {
		WP_Codebox_Json::append_jsonl( $events_path, $this->run_plan->event( $schema, $event ), JSON_UNESCAPED_SLASHES );
	}

	private function fanout_worker_descriptor_error( WP_Error $error ): WP_Error {
		$data = is_array( $error->get_error_data() ) ? $error->get_error_data() : array();
		return match ( $error->get_error_code() ) {
			'wp_codebox_run_plan_workers_missing' => new WP_Error( 'wp_codebox_fanout_workers_missing', 'workers must include at least one worker.', $data ),
			'wp_codebox_run_plan_worker_invalid' => new WP_Error( 'wp_codebox_fanout_worker_invalid', 'Each fanout worker must be an object.', $data ),
			'wp_codebox_run_plan_path_segment_invalid' => new WP_Error( 'wp_codebox_fanout_worker_id_invalid', 'Each fanout worker requires a stable alphanumeric id.', $data ),
			'wp_codebox_run_plan_worker_id_duplicate' => new WP_Error( 'wp_codebox_fanout_worker_id_duplicate', 'Fanout worker ids must be unique.', $data ),
			'wp_codebox_run_plan_worker_goal_missing' => new WP_Error( 'wp_codebox_fanout_worker_goal_missing', 'Each fanout worker requires goal.', $data ),
			default => $error,
		};
	}

	/**
	 * @param array<string,mixed> $input Ability input.
	 * @return array<int,array<string,mixed>>|WP_Error
	 */
	private function resolve_component_paths( array $input ): array|WP_Error {
		$contracts = $this->component_contracts( $input );
		foreach ( $contracts as $contract ) {
			$path = (string) ( $contract['path'] ?? '' );
			if ( '' === $path ) {
				if ( ! empty( $contract['required'] ) ) {
					return new WP_Error( 'wp_codebox_component_path_missing', sprintf( 'WP Codebox component path %s is missing or not a directory.', (string) ( $contract['slug'] ?? 'unknown' ) ), array( 'status' => 400 ) );
				}

				continue;
			}

			if ( ! is_dir( $path ) ) {
				return new WP_Error( 'wp_codebox_component_path_missing', sprintf( 'WP Codebox component path %s is missing or not a directory.', (string) ( $contract['slug'] ?? 'unknown' ) ), array( 'status' => 400, 'slug' => (string) ( $contract['slug'] ?? '' ), 'path' => $path ) );
			}
		}

		return $contracts;
	}

	/** @param array<string,mixed> $input Ability input. @return array<int,array<string,mixed>> */
	private function component_contracts( array $input ): array {
		$contracts = array();
		foreach ( $this->configured_component_contracts() as $contract ) {
			if ( is_array( $contract ) ) {
				$contracts[] = $contract;
			}
		}
		foreach ( is_array( $input['component_contracts'] ?? null ) ? $input['component_contracts'] : array() as $contract ) {
			if ( is_array( $contract ) ) {
				$contracts[] = $contract;
			}
		}
		$normalized = array();
		foreach ( $contracts as $contract ) {
			$slug = $this->component_slug( (string) ( $contract['slug'] ?? $contract['component'] ?? $contract['name'] ?? '' ) );
			if ( '' === $slug ) {
				continue;
			}

			$path = $this->clean_path( (string) ( $contract['path'] ?? $contract['source'] ?? '' ) );
			$normalized[ $slug ] = array_filter(
				array_merge(
					$contract,
					array(
						'slug'     => $slug,
						'path'     => $path,
						'activate' => (bool) ( $contract['activate'] ?? false ),
						'loadAs'   => (string) ( $contract['loadAs'] ?? 'mu-plugin' ),
					)
				),
				static fn( mixed $value ): bool => null !== $value && '' !== $value
			);
		}

		return array_values( $normalized );
	}

	/** @return array<int,array<string,mixed>> */
	private function configured_component_contracts(): array {
		$contracts = array();
		$option    = $this->config_option( 'wp_codebox_component_contracts', array() );
		if ( is_array( $option ) ) {
			$contracts = $option;
		}

		if ( function_exists( 'apply_filters' ) ) {
			$contracts = apply_filters( 'wp_codebox_component_contracts', $contracts );
		}

		return is_array( $contracts ) ? $contracts : array();
	}

	private function component_slug( string $slug ): string {
		$slug = strtolower( trim( $slug ) );
		$slug = str_replace( '_', '-', $slug );
		return preg_replace( '/[^a-z0-9-]+/', '', $slug ) ?? '';
	}

	/** @param array<string,mixed> $input Ability input. @return true|WP_Error */
	private function reject_raw_code_input( array $input ): true|WP_Error {
		foreach ( array( 'code', 'code_file' ) as $field ) {
			if ( ! array_key_exists( $field, $input ) ) {
				continue;
			}

			$value = $input[ $field ];
			if ( null === $value || '' === trim( (string) $value ) ) {
				continue;
			}

			return new WP_Error(
				'wp_codebox_raw_code_forbidden',
				'Raw PHP code inputs are not accepted by wp-codebox/run-agent-task. Use the operator CLI debug path for raw PHP execution.',
				array(
					'status' => 400,
					'field'  => $field,
				)
			);
		}

		return true;
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	private function normalize_parent_task_request( array $input ): array|WP_Error {
		return $this->runtime_config_resolver->normalize_parent_task_request( $input );
	}


	/** @param array<string,mixed> $input Ability input. @return string[] */
	private function tasks( array $input ): array {
		$task_inputs = $this->task_inputs( $input );
		if ( is_wp_error( $task_inputs ) ) {
			return array();
		}

		return array_map( static fn( array $task_input ): string => (string) $task_input['goal'], $task_inputs );
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	private function task_input( array $input ): array|WP_Error {
		$task_input = WP_Codebox_Agent_Task::normalize_input( $input );
		if ( is_wp_error( $task_input ) ) {
			return $task_input;
		}

		if ( ! empty( $task_input['allowed_tools'] ) ) {
			$error = $this->validate_task_tools( $task_input );
			if ( is_wp_error( $error ) ) {
				return $error;
			}
		}

		return $task_input;
	}

	/** @param array<string,mixed> $input Ability input. @return array<int,array<string,mixed>>|WP_Error */
	private function task_inputs( array $input ): array|WP_Error {
		$tasks = is_array( $input['tasks'] ?? null ) ? $input['tasks'] : array();

		$task_inputs = array();
		foreach ( $tasks as $task ) {
			if ( ! is_array( $task ) ) {
				continue;
			}

			$normalized = $this->task_input( $task );
			if ( is_wp_error( $normalized ) ) {
				continue;
			}

			$task_inputs[] = $normalized;
		}

		return $task_inputs;
	}

	/** @param array<string,mixed> $task_input Normalized task input. */
	private function task_input_prompt( array $task_input ): string {
		return WP_Codebox_Agent_Task::prompt( $task_input );
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

	private function json_encode( mixed $value ): string {
		return WP_Codebox_Json::encode( $value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE, '[]' );
	}

	/** @param string[] $tools @param array<string,mixed>|null $task_input Normalized task input. */
	public function validate_allowed_tools( array $tools, ?array $task_input = null ): WP_Error|null {
		return $this->tool_policy_validator->validate_allowed_tools( $tools, $task_input );
	}

	/** @param array<string,mixed> $task_input Normalized task input. */
	private function validate_task_tools( array $task_input ): WP_Error|null {
		return $this->tool_policy_validator->validate_task_tools( $task_input );
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	private function resolved_sandbox_tool_policy( array $input ): array|WP_Error {
		return $this->tool_policy_validator->resolved_policy( $input );
	}

	/** @param array<string,mixed> $policy @return array<int,array<string,string>> */
	private function sandbox_tool_policy_issues( array $policy ): array {
		return $this->tool_policy_validator->policy_issues( $policy );
	}

	/** @param array<string,mixed> $policy @return string[] */
	private function allowed_sandbox_tools( array $policy ): array {
		return $this->tool_policy_validator->allowed_tools( $policy );
	}

	/** @param array<string,mixed> $policy @return array<string,mixed>|null */
	private function sandbox_policy_tool( array $policy, string $tool_id ): array|null {
		return $this->tool_policy_validator->policy_tool( $policy, $tool_id );
	}

	/** @param array<string,mixed> $tool */
	private function sandbox_policy_denial_reason( array $tool ): string|null {
		return $this->tool_policy_validator->denial_reason( $tool );
	}

	/** @param array<string,mixed> $tool @return array{environment:string,capability_scope:string} */
	private function sandbox_tool_runtime_metadata( array $tool ): array {
		return $this->tool_policy_validator->runtime_metadata( $tool );
	}

	private function default_artifacts_path(): string {
		$configured = $this->clean_path( (string) $this->config_option( 'wp_codebox_artifacts_root', '' ) );
		if ( '' !== $configured ) {
			return $configured . DIRECTORY_SEPARATOR . $this->generate_run_id();
		}

		$base = function_exists( 'wp_upload_dir' ) ? wp_upload_dir() : array( 'basedir' => sys_get_temp_dir() );
		$root = is_array( $base ) && ! empty( $base['basedir'] ) ? (string) $base['basedir'] : sys_get_temp_dir();

		return rtrim( $root, DIRECTORY_SEPARATOR ) . DIRECTORY_SEPARATOR . 'wp-codebox' . DIRECTORY_SEPARATOR . $this->generate_run_id();
	}

	private function default_bin(): string {
		$bundled = defined( 'WP_CODEBOX_PLUGIN_PATH' ) ? WP_CODEBOX_PLUGIN_PATH . 'vendor/wp-codebox-cli/bin/wp-codebox' : '';
		$default = is_string( $bundled ) && is_file( $bundled ) ? $bundled : 'wp-codebox';
		$bin     = (string) $this->config_option( 'wp_codebox_bin', $default );

		if ( function_exists( 'apply_filters' ) ) {
			$bin = (string) apply_filters( 'wp_codebox_bin', $bin );
		}

		return $bin;
	}

	private function clean_path( string $path ): string {
		return WP_Codebox_Path_Policy::clean_host_path( $path );
	}

	private function preview_hold_seconds( array $input ): int {
		return WP_Codebox_Preview_Options::preview_hold_seconds( $input );
	}

	private function preview_args( array $input ): string|WP_Error {
		return $this->preview_args_builder->build( $input );
	}

	private function preview_hold_arg( array $input ): string {
		$seconds = $this->preview_hold_seconds( $input );

		return $seconds > 0 ? ' --preview-hold-seconds ' . escapeshellarg( (string) $seconds ) : '';
	}

	private function config_option( string $name, mixed $default ): mixed {
		if ( function_exists( 'is_multisite' ) && is_multisite() && function_exists( 'get_site_option' ) ) {
			return get_site_option( $name, $default );
		}

		if ( function_exists( 'get_option' ) ) {
			return get_option( $name, $default );
		}

		return $default;
	}

	private function command_prefix( string $bin ): string|WP_Error {
		$is_node_script = 1 === preg_match( '/\.m?js$/', $bin );
		$is_path_like   = str_contains( $bin, '/' ) || str_contains( $bin, '\\' ) || str_starts_with( $bin, '.' );

		if ( $is_node_script && is_file( $bin ) ) {
			$node = $this->node_binary();
			if ( is_wp_error( $node ) ) {
				return $node;
			}

			return escapeshellarg( $node ) . ' ' . escapeshellarg( $bin );
		}

		if ( $is_node_script && $is_path_like ) {
			return new WP_Error(
				'wp_codebox_bin_missing',
				'Configured wp_codebox_bin points at a missing JavaScript file. Build WP Codebox first, point wp_codebox_bin at bin/wp-codebox-source.mjs for source checkouts, or use an installed wp-codebox binary.',
				array(
					'status'          => 500,
					'path'            => $bin,
					'source_command'  => 'node bin/wp-codebox-source.mjs',
					'build_command'   => 'npm ci && npm run build',
				)
			);
		}

		if ( $this->is_bundled_cli_wrapper( $bin ) ) {
			$node = $this->node_binary();
			if ( is_wp_error( $node ) ) {
				return $node;
			}
		}

		return escapeshellarg( $bin );
	}

	private function node_binary(): string|WP_Error {
		$configured = trim( (string) ( getenv( 'WP_CODEBOX_NODE_BIN' ) ?: '' ) );
		if ( '' !== $configured ) {
			if ( is_file( $configured ) && is_executable( $configured ) ) {
				return $configured;
			}

			return new WP_Error( 'wp_codebox_node_runtime_unavailable', 'WP_CODEBOX_NODE_BIN is configured but is not an executable file.', array( 'status' => 500, 'path' => $configured ) );
		}

		$bundled = $this->bundled_node_binary();
		if ( '' !== $bundled ) {
			return $bundled;
		}

		foreach ( array( 'node', 'nodejs' ) as $command ) {
			$resolved = $this->resolve_command( $command );
			if ( '' !== $resolved ) {
				return $resolved;
			}
		}

		return new WP_Error(
			'wp_codebox_node_runtime_unavailable',
			'WP Codebox could not find an executable Node.js runtime. Use the packaged plugin with vendor/wp-codebox-cli/vendor/node/bin/node, set WP_CODEBOX_NODE_BIN, or install node on PATH.',
			array( 'status' => 500 )
		);
	}

	private function bundled_node_binary(): string {
		if ( ! defined( 'WP_CODEBOX_PLUGIN_PATH' ) ) {
			return '';
		}

		$path = WP_CODEBOX_PLUGIN_PATH . 'vendor/wp-codebox-cli/vendor/node/bin/node';
		return is_file( $path ) && is_executable( $path ) ? $path : '';
	}

	private function is_bundled_cli_wrapper( string $bin ): bool {
		if ( ! defined( 'WP_CODEBOX_PLUGIN_PATH' ) ) {
			return false;
		}

		return $bin === WP_CODEBOX_PLUGIN_PATH . 'vendor/wp-codebox-cli/bin/wp-codebox';
	}

	private function resolve_command( string $command ): string {
		if ( isset( $this->callbacks['command_resolver'] ) ) {
			$resolved = ( $this->callbacks['command_resolver'] )( $command );
			return is_string( $resolved ) ? $resolved : '';
		}

		$paths = explode( PATH_SEPARATOR, (string) getenv( 'PATH' ) );
		foreach ( $paths as $path ) {
			$candidate = rtrim( $path, DIRECTORY_SEPARATOR ) . DIRECTORY_SEPARATOR . $command;
			if ( is_file( $candidate ) && is_executable( $candidate ) ) {
				return $candidate;
			}
		}

		return '';
	}

	/**
	 * @param array<int,array<string,mixed>> $paths Component contracts.
	 * @param array<string,mixed> $input Ability input.
	 * @param string[] $task_prompts Encoded task prompts.
	 */
	private function write_agent_recipe( array $paths, array $input, array $task_prompts, string $wp_version, ?array $inheritance = null ): array|WP_Error {
		return $this->recipe_builder->build(
			$paths,
			$input,
			$task_prompts,
			$wp_version,
			$inheritance,
			$this->runtime_config_resolver->recipe_adapters(
				fn( array $input ): array|WP_Error => $this->task_input( $input ),
				fn( mixed $value ): string => $this->json_encode( $value ),
				fn( array $input ): int => $this->task_timeout_seconds( $input ),
				fn( array $input ): array|WP_Error => $this->parent_site_seed_recipe_entries( $input )
			)
		);
	}

	/**
	 * @param array<string,mixed> $input Ability input.
	 * @return array{siteSeeds:array<int,array<string,mixed>>,cleanup_paths:array<int,string>}|WP_Error
	 */
	private function parent_site_seed_recipe_entries( array $input ): array|WP_Error {
		return $this->site_seed_exporter->recipe_entries( $input );
	}

	private function generate_run_id(): string {
		if ( function_exists( 'wp_generate_uuid4' ) ) {
			return wp_generate_uuid4();
		}

		return bin2hex( random_bytes( 16 ) );
	}

	private function sandbox_session_id( array $input ): string {
		$id = trim( (string) ( $input['sandbox_session_id'] ?? '' ) );
		if ( '' !== $id ) {
			return $id;
		}

		$id = trim( (string) ( $input['session_id'] ?? '' ) );
		return '' !== $id ? $id : $this->generate_run_id();
	}

	/** @param array<string,mixed> $input Ability input. @param array<string,mixed> $run Decoded CLI run output. */
	private function sandbox_session( string $session_id, string $status, array $input, array $run, string $artifacts ): array {
		return WP_Codebox_Agent_Task::session(
			$session_id,
			$status,
			$input,
			array_filter(
				array(
					'path'        => $artifacts,
					'bundle_id'   => is_array( $run['artifacts'] ?? null ) ? (string) ( $run['artifacts']['id'] ?? '' ) : '',
					'preview_url' => is_array( $run['artifacts']['preview'] ?? null ) ? (string) ( $run['artifacts']['preview']['url'] ?? '' ) : '',
					'agent_task_result' => is_array( $run['agentTaskResult'] ?? null ) ? 'files/agent-task-result.json' : '',
					'completion_outcome' => is_array( $run['completionOutcome'] ?? null ) ? 'files/completion-outcome.json' : '',
				),
				static fn( mixed $value ): bool => '' !== $value
			)
		);
	}

	/** @param array<string,mixed> $session Sandbox session envelope. @param array<string,mixed> $run Decoded CLI run output. @return array<string,mixed> */
	private function evidence_refs( array $session, array $run ): array {
		$session_artifacts = is_array( $session['artifacts'] ?? null ) ? $session['artifacts'] : array();
		$run_artifacts     = is_array( $run['artifacts'] ?? null ) ? $run['artifacts'] : array();
		$agent_result      = is_array( $run['agentResult'] ?? null ) ? $run['agentResult'] : array();
		$transcript        = is_array( $agent_result['transcript'] ?? null ) ? $agent_result['transcript'] : array();

		return array_filter(
			array(
				'schema'             => 'wp-codebox/agent-task-evidence-refs/v1',
				'artifacts_path'     => (string) ( $session_artifacts['path'] ?? '' ),
				'artifact_bundle_id' => (string) ( $session_artifacts['bundle_id'] ?? $run_artifacts['id'] ?? '' ),
				'preview_url'        => (string) ( $session_artifacts['preview_url'] ?? '' ),
				'agent_task_result'  => (string) ( $session_artifacts['agent_task_result'] ?? '' ),
				'completion_outcome' => (string) ( $session_artifacts['completion_outcome'] ?? '' ),
				'transcript'         => (string) ( $transcript['artifact'] ?? '' ),
			),
			static fn( mixed $value ): bool => '' !== $value
		);
	}

	/** @param array<string,mixed> $input Ability input. @param array<string,mixed> $run Decoded CLI run output. @return array<string,mixed> */
	private function run_metadata( string $session_id, array $input, string $wp_version, array $run ): array {
		return array_filter(
			array(
				'schema'             => 'wp-codebox/agent-task-run-metadata/v1',
				'sandbox_session_id' => $session_id,
				'agent_session_id'   => (string) ( $input['session_id'] ?? '' ),
				'provider'           => $this->runtime_config_resolver->provider( $input ),
				'model'              => $this->runtime_config_resolver->model( $input ),
				'orchestrator'       => is_array( $input['orchestrator'] ?? null ) ? $input['orchestrator'] : array(),
				'wp'                 => $wp_version,
				'recipe_run_schema'  => (string) ( $run['schema'] ?? '' ),
			),
			static fn( mixed $value ): bool => '' !== $value && array() !== $value
		);
	}

	/** @return array<string,mixed>|WP_Error */
	private function decode_json_output( string $output ): array|WP_Error {
		$trimmed = trim( $output );
		if ( '' === $trimmed ) {
			return new WP_Error( 'empty_output', 'Empty output.' );
		}

		$decoded = WP_Codebox_Json::decode_trailing_array( $trimmed );
		if ( null !== $decoded ) {
			return $decoded;
		}

		return new WP_Error( 'json_decode_failed', json_last_error_msg() );
	}

	/** @param array<string,mixed> $input Ability input. */
	private function task_timeout_seconds( array $input ): int {
		$timeout = (int) ( $input['task_timeout_seconds'] ?? 0 );
		return max( 0, $timeout );
	}

	private function bound_output( string $output ): string {
		if ( strlen( $output ) <= 4000 ) {
			return $output;
		}

		return substr( $output, 0, 4000 );
	}
}
