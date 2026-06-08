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
	private const DEFAULT_WORDPRESS_VERSION = 'latest';
	private const FANOUT_MAX_CONCURRENCY = 8;
	private const SESSION_SCHEMA = WP_Codebox_Agent_Task::SESSION_SCHEMA;
	private const TASK_INPUT_SCHEMA = WP_Codebox_Agent_Task::INPUT_SCHEMA;
	private const TOOL_DENIAL_SCHEMA = 'wp-codebox/tool-allowlist-denial/v1';
	private const REMEDIATION_OUTCOME_SCHEMA = 'wp-codebox/agent-sandbox-remediation-outcome/v1';
	private const COMPLETION_OUTCOME_SCHEMA = 'wp-codebox/sandbox-completion-outcome/v1';
	private const AGENTS_API_RUN_OUTCOME_SCHEMA = 'agents-api.run-outcome';
	private const SANDBOX_TOOL_POLICY_SCHEMA = 'wp-codebox/sandbox-tool-policy/v1';
	private const AGENTS_API_RUNTIME_ENVIRONMENT = 'environment';
	private const AGENTS_API_RUNTIME_CAPABILITY_SCOPE = 'capability_scope';
	private const AGENTS_API_RUNTIME_LOCAL = 'runtime_local';
	private const AGENTS_API_CONTROL_PLANE = 'control_plane';

	/** @var array<string, callable> */
	private array $callbacks;
	private WP_Codebox_Host_Request_Normalizer $request_normalizer;
	private WP_Codebox_Host_Tool_Policy_Validator $tool_policy_validator;
	private WP_Codebox_Host_Recipe_Builder $recipe_builder;
	private WP_Codebox_Host_Run_Result_Normalizer $run_result_normalizer;
	private WP_Codebox_Parent_Site_Seed_Exporter $site_seed_exporter;

	/**
	 * @param array<string, callable> $callbacks Test seams for pure-PHP smoke coverage.
	 */
	public function __construct( array $callbacks = array() ) {
		$this->callbacks             = $callbacks;
		$this->request_normalizer    = new WP_Codebox_Host_Request_Normalizer();
		$this->tool_policy_validator = new WP_Codebox_Host_Tool_Policy_Validator();
		$this->recipe_builder        = new WP_Codebox_Host_Recipe_Builder();
		$this->run_result_normalizer = new WP_Codebox_Host_Run_Result_Normalizer();
		$this->site_seed_exporter    = new WP_Codebox_Parent_Site_Seed_Exporter();
	}

	/**
	 * Run a task inside an isolated WP Codebox agent sandbox.
	 *
	 * @param array<string,mixed> $input Ability input.
	 * @return array<string,mixed>|WP_Error
	 */
	public function run( array $input ): array|WP_Error {
		if ( ! $this->shell_available() ) {
			return new WP_Error( 'wp_codebox_shell_unavailable', 'Shell execution is not available for WP Codebox.', array( 'status' => 500 ) );
		}

		$prepared = $this->prepare_agent_task_run( $input );
		if ( is_wp_error( $prepared ) ) {
			return $prepared;
		}

		$result = $this->run_command( (string) $prepared['command'], $prepared['process_secret_env'], (int) $prepared['timeout_seconds'] );

		return $this->complete_agent_task_run( $prepared, $result );
	}

	/**
	 * Run multiple workers with bounded host-side concurrency.
	 *
	 * @param array<string,mixed> $input Ability input.
	 * @return array<string,mixed>|WP_Error
	 */
	public function run_fanout( array $input ): array|WP_Error {
		if ( ! $this->shell_available() ) {
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
		$base_artifacts    = $this->clean_path( (string) ( $input['artifacts_path'] ?? $this->default_artifacts_path() ) );
		$fanout_path       = $base_artifacts . DIRECTORY_SEPARATOR . 'fanout';
		$workers_path      = $fanout_path . DIRECTORY_SEPARATOR . 'workers';
		$aggregate_path    = $fanout_path . DIRECTORY_SEPARATOR . 'aggregate';
		foreach ( array( $workers_path, $aggregate_path . DIRECTORY_SEPARATOR . 'artifacts' ) as $path ) {
			if ( ! $this->ensure_directory( $path ) ) {
				return new WP_Error( 'wp_codebox_fanout_artifacts_unwritable', 'Could not create fanout artifact directories.', array( 'status' => 500, 'path' => $path ) );
			}
		}

		$plan = array(
			'schema'      => self::FANOUT_PLAN_SCHEMA,
			'session_id'  => $parent_session_id,
			'concurrency' => $concurrency,
			'orchestrator' => is_array( $input['orchestrator'] ?? null ) ? $input['orchestrator'] : array(),
			'workers'     => array_map(
				static fn( array $worker ): array => array(
					'id'                 => (string) $worker['id'],
					'agent'              => (string) ( $worker['agent'] ?? $input['agent'] ?? '' ),
					'goal'               => (string) ( $worker['goal'] ?? '' ),
					'artifact_namespace' => (string) $worker['id'],
				),
				$workers
			),
		);
		$this->write_json_file( $fanout_path . DIRECTORY_SEPARATOR . 'plan.json', $plan );
		$this->append_fanout_event( $fanout_path, array( 'event' => 'fanout.started', 'total' => count( $workers ), 'concurrency' => $concurrency ) );

		$prepared_workers = array();
		foreach ( $workers as $index => $worker ) {
			$worker_id      = (string) $worker['id'];
			$worker_path    = $workers_path . DIRECTORY_SEPARATOR . $worker_id;
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
		$runs       = $this->execute_prepared_fanout_workers( $prepared_workers, $concurrency, $fanout_path );
		$ended_at   = microtime( true );
		ksort( $runs );
		$runs = array_values( $runs );

		$completed = count( array_filter( $runs, static fn( array $run ): bool => true === ( $run['success'] ?? false ) ) );
		$cancelled = count( array_filter( $runs, static fn( array $run ): bool => 'cancelled' === ( $run['status'] ?? '' ) ) );
		$failed    = count( $runs ) - $completed - $cancelled;
		$success   = 0 === $failed && 0 === $cancelled;
		$this->append_fanout_event( $fanout_path, array( 'event' => 'aggregation.started', 'completed' => $completed, 'failed' => $failed, 'cancelled' => $cancelled ) );

		$result = array(
			'success'     => $success,
			'schema'      => self::FANOUT_SCHEMA,
			'execution'   => 'bounded-concurrent-isolated-sandboxes',
			'session'     => $this->fanout_parent_session( $parent_session_id, $success ? 'completed' : 'failed', $input, $fanout_path, $runs ),
			'concurrency' => $concurrency,
			'total'       => count( $runs ),
			'completed'   => $completed,
			'failed'      => $failed,
			'cancelled'   => $cancelled,
			'timings'     => array(
				'started_at'   => gmdate( 'c', (int) $started_at ),
				'ended_at'     => gmdate( 'c', (int) $ended_at ),
				'duration_ms'  => (int) round( ( $ended_at - $started_at ) * 1000 ),
			),
			'artifacts'   => array(
				'schema'          => 'wp-codebox/agent-fanout-artifacts/v1',
				'path'            => $fanout_path,
				'plan'            => 'plan.json',
				'events'          => 'events.jsonl',
				'workers_path'    => 'workers',
				'aggregate_path'  => 'aggregate',
				'result'          => 'result.json',
			),
			'orchestrator' => is_array( $input['orchestrator'] ?? null ) ? $input['orchestrator'] : array(),
			'runs'        => $runs,
			'failures'    => array_values( array_filter( $runs, static fn( array $run ): bool => true !== ( $run['success'] ?? false ) ) ),
		);

		$this->write_json_file( $aggregate_path . DIRECTORY_SEPARATOR . 'result.json', array( 'schema' => 'wp-codebox/agent-fanout-aggregate/v1', 'status' => $success ? 'completed' : 'failed', 'completed' => $completed, 'failed' => $failed, 'cancelled' => $cancelled ) );
		$this->append_fanout_event( $fanout_path, array( 'event' => 'aggregation.completed', 'status' => $success ? 'completed' : 'failed' ) );
		$this->write_json_file( $fanout_path . DIRECTORY_SEPARATOR . 'result.json', $result );
		$this->append_fanout_event( $fanout_path, array( 'event' => $success ? 'fanout.completed' : 'fanout.failed', 'status' => $success ? 'completed' : 'failed', 'completed' => $completed, 'failed' => $failed, 'cancelled' => $cancelled ) );

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

		$inheritance_payload = $this->inheritance_resolution_payload( $input );
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
				'strict_remediation_outcome' => fn( array $task_input ): bool => $this->strict_remediation_outcome( $task_input ),
				'remediation_outcome'        => fn( array $run, int $exit_code, string $output ): array => $this->remediation_outcome( $run, $exit_code, $output ),
				'sandbox_session'            => fn( string $session_id, string $status, array $input, array $run, string $artifacts ): array => $this->sandbox_session( $session_id, $status, $input, $run, $artifacts ),
				'completion_outcome'         => fn( array $run ): array => $this->completion_outcome( $run ),
				'run_diagnostics'            => fn( array $run, int $exit_code, ?array $outcome ): array => $this->run_diagnostics( $run, $exit_code, $outcome ),
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
		if ( ! $this->shell_available() ) {
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
				$runs[] = array(
					'index'      => $index,
					'task'       => (string) $task_input['goal'],
					'task_input' => $task_input,
					'success'    => false,
					'status'     => 'failed',
					'error'      => $this->error_payload( $task_result ),
				);
				continue;
			}

			$runs[] = array(
				'index'       => $index,
				'task'        => (string) $task_input['goal'],
				'task_input'  => $task_input,
				'success'     => true,
				'status'      => 'completed',
				'exit_code'   => (int) ( $task_result['exit_code'] ?? 0 ),
				'session'     => $task_result['session'] ?? array(),
				'artifact_id' => (string) ( $task_result['session']['artifacts']['bundle_id'] ?? '' ),
				'preview_url' => (string) ( $task_result['session']['artifacts']['preview_url'] ?? '' ),
				'artifacts'    => $task_result['session']['artifacts'] ?? array(),
				'agent_result' => $task_result['agent_result'] ?? array(),
				'agent_task_result' => $task_result['agent_task_result'] ?? array(),
				'completion_outcome' => $task_result['completion_outcome'] ?? array(),
				'run'          => $task_result['run'] ?? array(),
			);
		}

		$completed = count( array_filter( $runs, static fn( array $run ): bool => true === ( $run['success'] ?? false ) ) );
		$failed    = count( $runs ) - $completed;

		return array(
			'success'     => 0 === $failed,
			'schema'      => self::BATCH_SCHEMA,
			'session'     => $this->sandbox_session( $session_id, 'completed', $input, array(), $artifacts ),
			'tasks'       => $tasks,
			'task_inputs' => $task_inputs,
			'execution'   => 'sequential-isolated-sandboxes',
			'total'       => count( $runs ),
			'completed'   => $completed,
			'failed'      => $failed,
			'wp'          => $wp_version,
			'paths'       => $paths,
			'artifacts'   => $artifacts,
			'runs'        => $runs,
		);
	}

	/** @param array<string,mixed> $input Ability input. @return array<int,array<string,mixed>>|WP_Error */
	private function fanout_workers( array $input ): array|WP_Error {
		$workers = is_array( $input['workers'] ?? null ) ? $input['workers'] : array();
		if ( empty( $workers ) ) {
			return new WP_Error( 'wp_codebox_fanout_workers_missing', 'workers must include at least one worker.', array( 'status' => 400 ) );
		}

		$normalized = array();
		$seen       = array();
		foreach ( $workers as $index => $worker ) {
			if ( ! is_array( $worker ) ) {
				return new WP_Error( 'wp_codebox_fanout_worker_invalid', 'Each fanout worker must be an object.', array( 'status' => 400, 'index' => $index ) );
			}

			$id = trim( (string) ( $worker['id'] ?? '' ) );
			if ( '' === $id || ! preg_match( '/^[A-Za-z0-9][A-Za-z0-9_.-]*$/', $id ) ) {
				return new WP_Error( 'wp_codebox_fanout_worker_id_invalid', 'Each fanout worker requires a stable alphanumeric id.', array( 'status' => 400, 'index' => $index ) );
			}
			if ( isset( $seen[ $id ] ) ) {
				return new WP_Error( 'wp_codebox_fanout_worker_id_duplicate', 'Fanout worker ids must be unique.', array( 'status' => 400, 'worker_id' => $id ) );
			}

			$goal = trim( (string) ( $worker['goal'] ?? '' ) );
			if ( '' === $goal ) {
				return new WP_Error( 'wp_codebox_fanout_worker_goal_missing', 'Each fanout worker requires goal.', array( 'status' => 400, 'worker_id' => $id ) );
			}

			$seen[ $id ] = true;
			$worker['id'] = $id;
			$worker['goal'] = $goal;
			$normalized[] = $worker;
		}

		return $normalized;
	}

	private function fanout_concurrency( array $input ): int|WP_Error {
		$concurrency = isset( $input['concurrency'] ) ? (int) $input['concurrency'] : 1;
		$max         = self::FANOUT_MAX_CONCURRENCY;
		if ( function_exists( 'apply_filters' ) ) {
			$max = max( 1, (int) apply_filters( 'wp_codebox_agent_fanout_max_concurrency', $max ) );
		}

		if ( $concurrency < 1 || $concurrency > $max ) {
			return new WP_Error( 'wp_codebox_fanout_concurrency_invalid', 'Fanout concurrency must be between 1 and ' . $max . '.', array( 'status' => 400, 'max' => $max ) );
		}

		return $concurrency;
	}

	/** @param array<string,mixed> $parent Parent input. @param array<string,mixed> $worker Worker input. @return array<string,mixed> */
	private function fanout_worker_input( array $parent, array $worker, string $parent_session_id, string $worker_path ): array {
		$worker_artifacts_path = $worker_path . DIRECTORY_SEPARATOR . 'artifacts';
		$this->ensure_directory( $worker_artifacts_path );

		$input = array_merge( $parent, $worker );
		unset( $input['workers'], $input['dependencies'], $input['aggregation'], $input['concurrency'] );

		$input['goal']               = (string) $worker['goal'];
		$input['sandbox_session_id'] = $parent_session_id . ':' . (string) $worker['id'];
		$input['artifacts_path']     = $worker_artifacts_path;
		$input['context']            = is_array( $input['context'] ?? null ) ? $input['context'] : array();
		$input['context']['fanout']  = array(
			'parent_session_id'  => $parent_session_id,
			'worker_id'          => (string) $worker['id'],
			'artifact_namespace' => (string) $worker['id'],
		);

		if ( isset( $worker['timeout_seconds'] ) && ! isset( $worker['task_timeout_seconds'] ) ) {
			$input['task_timeout_seconds'] = (int) $worker['timeout_seconds'];
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
					$runs[ (int) $item['index'] ] = $this->fanout_worker_error_result( $item, $item['error'], 0, 0 );
					$this->write_json_file( (string) $item['path'] . DIRECTORY_SEPARATOR . 'result.json', $runs[ (int) $item['index'] ] );
					continue;
				}

				$started = $this->start_prepared_fanout_worker( $item );
				if ( is_wp_error( $started ) ) {
					$runs[ (int) $item['index'] ] = $this->fanout_worker_error_result( $item, $started, 0, 0 );
					$this->write_json_file( (string) $item['path'] . DIRECTORY_SEPARATOR . 'result.json', $runs[ (int) $item['index'] ] );
					continue;
				}

				$active[] = $started;
				$this->append_fanout_event( $fanout_path, array( 'event' => 'worker.started', 'worker_id' => (string) $item['id'], 'active' => count( $active ) ) );
			}

			foreach ( $active as $active_index => &$worker ) {
				$worker['output'] .= (string) stream_get_contents( $worker['pipes'][1] );
				$worker['error_output'] .= (string) stream_get_contents( $worker['pipes'][2] );
				$status  = proc_get_status( $worker['process'] );
				$running = (bool) ( $status['running'] ?? false );
				$elapsed = microtime( true ) - (float) $worker['started_at'];
				$timeout = (int) ( $worker['prepared']['timeout_seconds'] ?? 0 );

				if ( $running && $timeout > 0 && $elapsed >= $timeout ) {
					proc_terminate( $worker['process'] );
					$worker['timed_out'] = true;
					$running = false;
				}

				if ( $running ) {
					continue;
				}

				$worker['output'] .= (string) stream_get_contents( $worker['pipes'][1] );
				$worker['error_output'] .= (string) stream_get_contents( $worker['pipes'][2] );
				fclose( $worker['pipes'][1] );
				fclose( $worker['pipes'][2] );
				$exit_code = proc_close( $worker['process'] );
				if ( true === ( $worker['timed_out'] ?? false ) ) {
					$exit_code = 124;
				}

				$result = array(
					'exit_code' => $exit_code,
					'output'    => trim( (string) $worker['output'] . "\n" . (string) $worker['error_output'] ),
				);
				if ( true === ( $worker['timed_out'] ?? false ) ) {
					$result['timed_out'] = true;
					$result['timeout_seconds'] = $timeout;
				}

				$completed = $this->complete_agent_task_run( $worker['prepared'], $result );
				$runs[ (int) $worker['index'] ] = is_wp_error( $completed ) ? $this->fanout_worker_error_result( $worker, $completed, (float) $worker['started_at'], microtime( true ) ) : $this->fanout_worker_success_result( $worker, $completed, (float) $worker['started_at'], microtime( true ) );
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

	/** @param array<string,mixed> $item Prepared worker item. @return array<string,mixed>|WP_Error */
	private function start_prepared_fanout_worker( array $item ): array|WP_Error {
		if ( ! function_exists( 'proc_open' ) ) {
			return new WP_Error( 'wp_codebox_proc_open_unavailable', 'Fanout execution requires proc_open support.', array( 'status' => 500 ) );
		}

		$prepared       = is_array( $item['prepared'] ?? null ) ? $item['prepared'] : array();
		$descriptor_spec = array(
			1 => array( 'pipe', 'w' ),
			2 => array( 'pipe', 'w' ),
		);
		$current_env = getenv();
		$secret_env  = is_array( $prepared['process_secret_env'] ?? null ) ? $prepared['process_secret_env'] : array();
		$process     = proc_open( (string) $prepared['command'], $descriptor_spec, $pipes, null, array_merge( is_array( $current_env ) ? $current_env : array(), $_ENV, $secret_env ) );
		if ( ! is_resource( $process ) ) {
			return new WP_Error( 'wp_codebox_fanout_worker_start_failed', 'Could not start fanout worker process.', array( 'status' => 500, 'worker_id' => (string) $item['id'] ) );
		}

		stream_set_blocking( $pipes[1], false );
		stream_set_blocking( $pipes[2], false );

		return array_merge(
			$item,
			array(
				'process'      => $process,
				'pipes'        => $pipes,
				'started_at'   => microtime( true ),
				'output'       => '',
				'error_output' => '',
			)
		);
	}

	/** @param array<string,mixed> $worker Worker metadata. @param array<string,mixed> $result Worker result. @return array<string,mixed> */
	private function fanout_worker_success_result( array $worker, array $result, float $started_at, float $ended_at ): array {
		$session   = is_array( $result['session'] ?? null ) ? $result['session'] : array();
		$artifacts = is_array( $session['artifacts'] ?? null ) ? $session['artifacts'] : array();

		return array(
			'worker_id'   => (string) $worker['id'],
			'index'       => (int) $worker['index'],
			'success'     => true,
			'status'      => 'completed',
			'agent'       => (string) ( $worker['prepared']['input']['agent'] ?? '' ),
			'exit_code'   => (int) ( $result['exit_code'] ?? 0 ),
			'session'     => $session,
			'artifacts'   => array_merge( $artifacts, array( 'namespace' => (string) $worker['id'], 'result' => 'result.json' ) ),
			'diagnostics' => is_array( $result['diagnostics'] ?? null ) ? $result['diagnostics'] : array(),
			'evidence_refs' => is_array( $result['evidence_refs'] ?? null ) ? $result['evidence_refs'] : array(),
			'completion_outcome' => is_array( $result['completion_outcome'] ?? null ) ? $result['completion_outcome'] : array(),
			'timings'     => array(
				'started_at'  => gmdate( 'c', (int) $started_at ),
				'ended_at'    => gmdate( 'c', (int) $ended_at ),
				'duration_ms' => (int) round( ( $ended_at - $started_at ) * 1000 ),
			),
		);
	}

	/** @param array<string,mixed> $worker Worker metadata. */
	private function fanout_worker_error_result( array $worker, WP_Error $error, float $started_at, float $ended_at ): array {
		$prepared  = is_array( $worker['prepared'] ?? null ) ? $worker['prepared'] : array();
		$input     = is_array( $prepared['input'] ?? null ) ? $prepared['input'] : array();
		$artifacts = (string) ( $prepared['artifacts'] ?? ( (string) $worker['path'] . DIRECTORY_SEPARATOR . 'artifacts' ) );

		return array(
			'worker_id' => (string) $worker['id'],
			'index'     => (int) $worker['index'],
			'success'   => false,
			'status'    => 'failed',
			'agent'     => (string) ( $input['agent'] ?? '' ),
			'session'   => array_filter(
				array(
					'schema' => self::SESSION_SCHEMA,
					'id'     => (string) ( $prepared['session_id'] ?? '' ),
					'status' => 'failed',
				),
				static fn( mixed $value ): bool => '' !== $value
			),
			'artifacts' => array(
				'path'      => $artifacts,
				'namespace' => (string) $worker['id'],
				'result'    => 'result.json',
			),
			'error'    => $this->error_payload( $error ),
			'timings'  => array_filter(
				array(
					'started_at'  => $started_at > 0 ? gmdate( 'c', (int) $started_at ) : '',
					'ended_at'    => $ended_at > 0 ? gmdate( 'c', (int) $ended_at ) : '',
					'duration_ms' => $started_at > 0 && $ended_at > 0 ? (int) round( ( $ended_at - $started_at ) * 1000 ) : null,
				),
				static fn( mixed $value ): bool => null !== $value && '' !== $value
			),
		);
	}

	/** @param array<string,mixed> $input Ability input. @param array<int,array<string,mixed>> $runs Worker runs. */
	private function fanout_parent_session( string $session_id, string $status, array $input, string $fanout_path, array $runs ): array {
		$children = array_map(
			static fn( array $run ): array => array_filter(
				array(
					'worker_id' => (string) ( $run['worker_id'] ?? '' ),
					'session_id' => (string) ( $run['session']['id'] ?? '' ),
					'status'    => (string) ( $run['status'] ?? '' ),
					'artifacts' => is_array( $run['artifacts'] ?? null ) ? $run['artifacts'] : array(),
				),
				static fn( mixed $value ): bool => '' !== $value && array() !== $value
			),
			$runs
		);

		$session = WP_Codebox_Agent_Task::session(
			$session_id,
			$status,
			$input,
			array(
				'path'      => $fanout_path,
				'plan'      => 'plan.json',
				'events'    => 'events.jsonl',
				'result'    => 'result.json',
				'aggregate' => 'aggregate/result.json',
			)
		);
		$session['children'] = $children;

		return $session;
	}

	private function ensure_directory( string $path ): bool {
		return is_dir( $path ) || mkdir( $path, 0777, true );
	}

	/** @param array<string,mixed> $data Data to write. */
	private function write_json_file( string $path, array $data ): void {
		$this->ensure_directory( dirname( $path ) );
		$encoded = function_exists( 'wp_json_encode' ) ? wp_json_encode( $data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES ) : json_encode( $data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES );
		if ( is_string( $encoded ) ) {
			file_put_contents( $path, $encoded . "\n" );
		}
	}

	/** @param array<string,mixed> $event Event data. */
	private function append_fanout_event( string $fanout_path, array $event ): void {
		$event = array_merge( array( 'schema' => self::FANOUT_EVENT_SCHEMA, 'time' => gmdate( 'c' ) ), $event );
		$encoded = function_exists( 'wp_json_encode' ) ? wp_json_encode( $event, JSON_UNESCAPED_SLASHES ) : json_encode( $event, JSON_UNESCAPED_SLASHES );
		if ( is_string( $encoded ) ) {
			file_put_contents( $fanout_path . DIRECTORY_SEPARATOR . 'events.jsonl', $encoded . "\n", FILE_APPEND );
		}
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

	private function shell_available(): bool {
		if ( isset( $this->callbacks['shell_available'] ) ) {
			return (bool) ( $this->callbacks['shell_available'] )();
		}

		return function_exists( 'exec' ) && function_exists( 'shell_exec' );
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
		return $this->request_normalizer->normalize( $input );
	}

	private function agent_slug( array $input ): string {
		$agent = trim( (string) ( $input['agent'] ?? '' ) );
		if ( '' !== $agent ) {
			return $agent;
		}

		if ( function_exists( 'apply_filters' ) ) {
			$agent = (string) apply_filters( 'wp_codebox_default_agent', '' );
		}

		return '' !== trim( $agent ) ? trim( $agent ) : 'sandbox-agent';
	}

	private function mode( array $input ): string {
		$mode = trim( (string) ( $input['mode'] ?? '' ) );

		return '' !== $mode ? $mode : 'sandbox';
	}

	private function provider( array $input, ?array $inheritance = null ): string {
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

	private function model( array $input, ?array $inheritance = null ): string {
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
	private function provider_plugin_paths( array $input, ?array $inheritance = null ): array {
		$paths      = is_array( $input['provider_plugin_paths'] ?? null ) ? $input['provider_plugin_paths'] : array();
		$paths      = array_merge( is_array( $paths ) ? $paths : array(), $this->inheritance_provider_plugin_paths( $input, $inheritance ) );

		if ( ! is_array( $paths ) ) {
			return array();
		}

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

	/** @param array<string,mixed> $input Ability input. @return string[] */
	private function secret_env_names( array $input, ?array $inheritance = null ): array {
		$names = is_array( $input['secret_env'] ?? null ) ? $input['secret_env'] : array();
		$names = array_merge( $names, $this->inheritance_secret_env_names( $input, $inheritance ) );
		if ( empty( $names ) && function_exists( 'apply_filters' ) ) {
			$names = apply_filters( 'wp_codebox_default_secret_env', array() );
		}

		if ( ! is_array( $names ) ) {
			return array();
		}

		return array_values(
			array_unique(
				array_filter(
					array_map(
						static fn( $name ): string => trim( (string) $name ),
						$names
					),
					static fn( string $name ): bool => 1 === preg_match( '/^[A-Z_][A-Z0-9_]*$/', $name )
				)
			)
		);
	}

	/** @param array<string,mixed> $input Ability input. @return array{connectors:string[],settings:string[]} */
	private function inheritance_request( array $input ): array {
		return WP_Codebox_Inheritance::request( $input );
	}

	/** @param array<string,mixed> $input Ability input. @return array{connectors:array<int,array<string,mixed>>,settings:array<int,array<string,mixed>>} */
	private function inheritance_resolution( array $input ): array {
		return $this->inheritance_resolution_payload( $input )['inheritance_audit'];
	}

	/** @param array<string,mixed> $input Ability input. @return array{inheritance_audit:array{connectors:array<int,array<string,mixed>>,settings:array<int,array<string,mixed>>},process_secret_env:array<string,string>} */
	private function inheritance_resolution_payload( array $input ): array {
		$payload = WP_Codebox_Inheritance::resolution_payload( $input, fn( string $path ): string => $this->clean_path( $path ) );

		return array(
			'inheritance_audit'  => $payload['inheritance'],
			'process_secret_env' => $this->inheritance_process_secret_env_values( $payload['resolution']['connectors'] ?? array() ),
		);
	}

	/** @param array<int,mixed> $connectors Raw inheritance connector rows. @return array<string,string> */
	private function inheritance_process_secret_env_values( array $connectors ): array {
		$values = array();
		foreach ( $connectors as $connector ) {
			if ( ! is_array( $connector ) ) {
				continue;
			}

			$values = array_merge( $values, $this->process_secret_env_values_from_connector( $connector ) );
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

	/** @param array{connectors:array<int,array<string,mixed>>,settings:array<int,array<string,mixed>>} $inheritance */
	private function connector_credentials_error( array $inheritance ): WP_Error|null {
		return WP_Codebox_Inheritance::connector_credentials_error( $inheritance, 'Requested connector credentials are missing or denied for this sandbox scope.' );
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

	/** @return string[] */
	private function string_list( mixed $values ): array {
		if ( ! is_array( $values ) ) {
			return array();
		}

		return array_values(
			array_unique(
				array_filter(
					array_map(
						static fn( $value ): string => trim( (string) $value ),
						$values
					),
					static fn( string $value ): bool => '' !== $value
				)
			)
		);
	}

	/** @return string[] */
	private function merge_string_lists( mixed ...$lists ): array {
		$merged = array();
		foreach ( $lists as $list ) {
			$merged = array_merge( $merged, $this->string_list( $list ) );
		}

		return array_values( array_unique( $merged ) );
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
	private function agent_bundles( array $input, array $request = array() ): array {
		$bundles = $this->merge_array_lists( $input['agent_bundles'] ?? array(), $request['agent_bundles'] ?? array() );
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
			$on_conflict = (string) ( $bundle['on_conflict'] ?? 'upgrade' );
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

	/**
	 * @param array<string,mixed> $input Ability input.
	 * @param array<string,mixed> $request Parent request input.
	 * @return array<string,mixed>
	 */
	private function runtime_task( array $input, array $request = array() ): array {
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

	private function json_encode( mixed $value ): string {
		$encoded = function_exists( 'wp_json_encode' ) ? wp_json_encode( $value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE ) : json_encode( $value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE );
		return is_string( $encoded ) ? $encoded : '[]';
	}

	/** @param string[] $tools @param array<string,mixed>|null $task_input Normalized task input. */
	public function validate_allowed_tools( array $tools, ?array $task_input = null ): WP_Error|null {
		return $this->tool_policy_validator->validate_allowed_tools( $tools, $task_input );
	}

	/** @param array<string,mixed> $task_input Normalized task input. */
	private function validate_task_tools( array $task_input ): WP_Error|null {
		return $this->tool_policy_validator->validate_task_tools( $task_input );
	}

	/** @param array<string,mixed> $task_input Normalized task input. */
	private function strict_remediation_outcome( array $task_input ): bool {
		$target = is_array( $task_input['target'] ?? null ) ? $task_input['target'] : array();
		$policy = is_array( $task_input['policy'] ?? null ) ? $task_input['policy'] : array();
		$expected_artifacts = is_array( $task_input['expected_artifacts'] ?? null ) ? $task_input['expected_artifacts'] : array();

		foreach ( array( $target['kind'] ?? '', $policy['kind'] ?? '', $policy['outcome_contract'] ?? '', $policy['outcomeContract'] ?? '' ) as $value ) {
			$value = strtolower( str_replace( '_', '-', trim( (string) $value ) ) );
			if ( in_array( $value, array( 'audit-remediation', 'agent-sandbox-remediation', 'remediation-outcome' ), true ) ) {
				return true;
			}
		}

		foreach ( $expected_artifacts as $artifact ) {
			$artifact = strtolower( str_replace( '_', '-', trim( (string) $artifact ) ) );
			if ( in_array( $artifact, array( 'fix-artifact', 'false-positive-artifact', 'remediation-artifact', 'fix-pr', 'false-positive-pr', 'remediation-pr' ), true ) ) {
				return true;
			}
		}

		return false;
	}

	/** @param array<string,mixed> $run Decoded CLI run output. @return array<string,mixed> */
	private function remediation_outcome( array $run, int $exit_code, string $output ): array {
		$run_outcome = $this->agents_api_run_outcome( $run );
		$has_run_outcome = ! empty( $run_outcome );
		$datamachine = $has_run_outcome ? array() : $this->first_datamachine_metadata( $run );
		$run_status = (string) ( $run_outcome['status'] ?? '' );
		$stop_reason = (string) ( $run_outcome['stop_reason'] ?? '' );
		$max_turns_reached = $has_run_outcome ? 'max_turns' === $stop_reason : ( $this->recursive_truthy_key( $run, 'max_turns_reached' ) || true === ( $datamachine['max_turns_reached'] ?? false ) );
		$pending_runtime_tool = $has_run_outcome && ( 'runtime_tool_pending' === $run_status || 'runtime_tool_pending' === $stop_reason );
		$provider_error = $has_run_outcome ? $this->agents_api_provider_error_details( $run_outcome ) : $this->provider_error_details( $run, $output );
		$pr_url = $this->first_url_for_keys( $run, array( 'pr_url', 'pull_request_url', 'pullRequestUrl' ) );
		$false_positive_pr_url = $this->first_url_for_keys( $run, array( 'false_positive_pr_url', 'falsePositivePrUrl' ) );
		$artifact = $this->remediation_artifact_details( $run );
		$has_artifact_changes = ! empty( $artifact['changed_files'] );
		$false_positive = $this->remediation_false_positive( $run );

		$outcome = array(
			'schema'      => self::REMEDIATION_OUTCOME_SCHEMA,
			'success'     => true,
			'kind'        => 'unable_to_remediate',
			'failure'     => '',
			'exit_code'   => $exit_code,
			'retryable'   => false,
			'diagnostics' => array_filter(
				array(
					'agents_api_status'      => $has_run_outcome ? $run_status : null,
					'agents_api_stop_reason' => $has_run_outcome ? $stop_reason : null,
					'agents_api_completed'   => $has_run_outcome && array_key_exists( 'completed', $run_outcome ) ? (bool) $run_outcome['completed'] : null,
					'pending_runtime_tool'   => $has_run_outcome ? $pending_runtime_tool : null,
					'datamachine_completed' => array_key_exists( 'completed', $datamachine ) ? (bool) $datamachine['completed'] : null,
					'max_turns_reached'     => $max_turns_reached,
				),
				static fn( mixed $value ): bool => null !== $value
			),
		);

		if ( $has_run_outcome ) {
			$outcome['metadata'] = array( 'agents_api' => array( 'run_outcome' => $run_outcome ) );
		} elseif ( ! empty( $datamachine ) ) {
			$outcome['metadata'] = array( 'datamachine' => $datamachine );
		}

		if ( $has_artifact_changes && $false_positive ) {
			$outcome['success'] = true;
			$outcome['kind'] = 'false_positive_artifact';
			$outcome['artifact'] = $artifact;
			$outcome['false_positive'] = true;
			unset( $outcome['failure'] );
			return $outcome;
		}

		if ( $has_artifact_changes ) {
			$outcome['success'] = true;
			$outcome['kind'] = 'fix_artifact';
			$outcome['artifact'] = $artifact;
			unset( $outcome['failure'] );
			if ( '' !== $pr_url ) {
				$outcome['pr_url'] = $pr_url;
			}
			if ( '' !== $false_positive_pr_url ) {
				$outcome['false_positive_pr_url'] = $false_positive_pr_url;
			}
			return $outcome;
		}

		if ( '' !== $false_positive_pr_url ) {
			$outcome['success'] = true;
			$outcome['kind'] = 'false_positive_pr';
			$outcome['false_positive_pr_url'] = $false_positive_pr_url;
			unset( $outcome['failure'] );
			return $outcome;
		}

		if ( '' !== $pr_url ) {
			$outcome['success'] = true;
			$outcome['kind'] = 'fix_pr';
			$outcome['pr_url'] = $pr_url;
			unset( $outcome['failure'] );
			return $outcome;
		}

		if ( $pending_runtime_tool ) {
			$outcome['success'] = false;
			$outcome['kind'] = 'runtime_tool_pending';
			$outcome['failure'] = 'runtime_tool_pending';
			$outcome['retryable'] = (bool) ( $run_outcome['retryable'] ?? false );
			return $outcome;
		}

		if ( $max_turns_reached ) {
			$outcome['success'] = false;
			$outcome['kind'] = 'max_turns_exceeded';
			$outcome['failure'] = 'max_turns_exceeded';
			$outcome['retryable'] = $has_run_outcome ? (bool) ( $run_outcome['retryable'] ?? true ) : true;
			return $outcome;
		}

		if ( ( $has_run_outcome && 'failed' === $run_status ) || 0 !== $exit_code || ! empty( $provider_error ) ) {
			$outcome['success'] = false;
			$outcome['kind'] = 'provider_error';
			$outcome['failure'] = 'provider_error';
			$outcome['provider_error'] = $provider_error;
			$outcome['retryable'] = $has_run_outcome ? (bool) ( $run_outcome['retryable'] ?? true ) : (bool) ( $provider_error['retryable'] ?? true );
			return $outcome;
		}

		if ( $false_positive ) {
			$outcome['kind'] = 'noop_artifact';
			$outcome['false_positive'] = true;
		}

		return $outcome;
	}

	/** @param array<string,mixed> $run Decoded CLI run output. @return array<string,mixed> */
	private function agents_api_run_outcome( array $run ): array {
		foreach ( array_merge( array( $run ), $this->agent_payloads( $run ) ) as $payload ) {
			$outcome = is_array( $payload['run_outcome'] ?? null ) ? $payload['run_outcome'] : array();
			if ( self::AGENTS_API_RUN_OUTCOME_SCHEMA === ( $outcome['schema'] ?? '' ) ) {
				return $outcome;
			}
		}

		return array();
	}

	/** @param array<string,mixed> $run_outcome Stable Agents API run outcome. @return array<string,mixed> */
	private function agents_api_provider_error_details( array $run_outcome ): array {
		$provider_error = is_array( $run_outcome['provider_error'] ?? null ) ? $run_outcome['provider_error'] : array();
		if ( empty( $provider_error ) && is_array( $run_outcome['failure'] ?? null ) ) {
			$provider_error = $run_outcome['failure'];
		}

		if ( empty( $provider_error ) ) {
			return array();
		}

		$provider_error['retryable'] = (bool) ( $run_outcome['retryable'] ?? ( $provider_error['retryable'] ?? true ) );
		return $provider_error;
	}

	/** @param array<string,mixed> $run Decoded CLI run output. @return array<string,mixed> */
	private function completion_outcome( array $run ): array {
		$outcome = is_array( $run['completionOutcome'] ?? null ) ? $run['completionOutcome'] : array();
		if ( self::COMPLETION_OUTCOME_SCHEMA !== ( $outcome['schema'] ?? '' ) ) {
			return array();
		}

		return $outcome;
	}

	/** @param array<string,mixed> $run Decoded CLI run output. */
	private function remediation_false_positive( array $run ): bool {
		foreach ( array_merge( array( $run ), $this->agent_payloads( $run ) ) as $payload ) {
			if ( $this->recursive_truthy_key( $payload, 'false_positive' ) || $this->recursive_truthy_key( $payload, 'falsePositive' ) ) {
				return true;
			}

			$encoded = function_exists( 'wp_json_encode' ) ? wp_json_encode( $payload, JSON_UNESCAPED_SLASHES ) : json_encode( $payload, JSON_UNESCAPED_SLASHES );
			$text    = strtolower( is_string( $encoded ) ? $encoded : '' );
			if ( str_contains( $text, 'false positive' ) || str_contains( $text, 'false_positive' ) ) {
				return true;
			}
		}

		return false;
	}

	/** @param array<string,mixed> $run Decoded CLI run output. @return array<string,mixed> */
	private function remediation_artifact_details( array $run ): array {
		$artifacts = is_array( $run['artifacts'] ?? null ) ? $run['artifacts'] : array();
		$directory = $this->clean_path( (string) ( $artifacts['directory'] ?? $artifacts['path'] ?? '' ) );
		$changed_files = array();

		if ( '' !== $directory ) {
			$changed_files_path = $directory . DIRECTORY_SEPARATOR . 'files' . DIRECTORY_SEPARATOR . 'changed-files.json';
			if ( is_readable( $changed_files_path ) ) {
				$decoded = json_decode( (string) file_get_contents( $changed_files_path ), true );
				foreach ( is_array( $decoded['files'] ?? null ) ? $decoded['files'] : array() as $file ) {
					if ( is_array( $file ) ) {
						$changed_files[] = array_filter(
							array(
								'path'          => (string) ( $file['path'] ?? '' ),
								'relative_path' => (string) ( $file['relativePath'] ?? $file['relative_path'] ?? '' ),
								'status'        => (string) ( $file['status'] ?? '' ),
							),
							static fn( mixed $value ): bool => '' !== $value
						);
					}
				}
			}
		}

		return array_filter(
			array(
				'id'            => (string) ( $artifacts['id'] ?? '' ),
				'directory'     => $directory,
				'changed_files' => $changed_files,
			),
			static fn( mixed $value ): bool => '' !== $value && array() !== $value
		);
	}

	/** @param array<string,mixed> $run Decoded CLI run output. @return array<string,mixed> */
	private function first_datamachine_metadata( array $run ): array {
		$payloads = array_merge( array( $run ), $this->agent_payloads( $run ) );
		foreach ( $payloads as $payload ) {
			$metadata = is_array( $payload['metadata'] ?? null ) ? $payload['metadata'] : array();
			$datamachine = is_array( $metadata['datamachine'] ?? null ) ? $metadata['datamachine'] : array();
			if ( ! empty( $datamachine ) ) {
				return $datamachine;
			}
		}

		return array();
	}

	/** @param array<string,mixed> $run Decoded CLI run output. @return array<int,array<string,mixed>> */
	private function agent_payloads( array $run ): array {
		$payloads = array();
		foreach ( is_array( $run['executions'] ?? null ) ? $run['executions'] : array() as $execution ) {
			if ( ! is_array( $execution ) ) {
				continue;
			}

			foreach ( array( 'stdout', 'stderr' ) as $stream ) {
				$decoded = $this->decode_json_fragment( (string) ( $execution[ $stream ] ?? '' ) );
				if ( is_array( $decoded ) ) {
					$payloads[] = is_array( $decoded['result'] ?? null ) ? $decoded['result'] : $decoded;
				}
			}
		}

		return $payloads;
	}

	/** @return array<string,mixed>|null */
	private function decode_json_fragment( string $text ): ?array {
		$text = trim( $text );
		if ( '' === $text ) {
			return null;
		}

		$decoded = json_decode( $text, true );
		if ( is_array( $decoded ) ) {
			return $decoded;
		}

		$start = strpos( $text, '{' );
		$end   = strrpos( $text, '}' );
		if ( false === $start || false === $end || $end <= $start ) {
			return null;
		}

		$decoded = json_decode( substr( $text, $start, $end - $start + 1 ), true );

		return is_array( $decoded ) ? $decoded : null;
	}

	/** @param array<string,mixed> $run Decoded CLI run output. @param string[] $keys */
	private function first_url_for_keys( array $run, array $keys ): string {
		foreach ( array_merge( array( $run ), $this->agent_payloads( $run ) ) as $payload ) {
			$url = $this->recursive_first_string_key( $payload, $keys );
			if ( '' !== $url && preg_match( '#^https://github\.com/[^/\s]+/[^/\s]+/pull/\d+#', $url ) ) {
				return $url;
			}
		}

		return '';
	}

	/** @param array<string,mixed> $payload @param string[] $keys */
	private function recursive_first_string_key( array $payload, array $keys ): string {
		foreach ( $payload as $key => $value ) {
			if ( in_array( (string) $key, $keys, true ) && ! is_array( $value ) && '' !== trim( (string) $value ) ) {
				return trim( (string) $value );
			}

			if ( is_array( $value ) ) {
				$nested = $this->recursive_first_string_key( $value, $keys );
				if ( '' !== $nested ) {
					return $nested;
				}
			}
		}

		return '';
	}

	/** @param array<string,mixed> $payload */
	private function recursive_truthy_key( array $payload, string $needle ): bool {
		foreach ( $payload as $key => $value ) {
			if ( $needle === (string) $key && true === (bool) $value ) {
				return true;
			}

			if ( is_array( $value ) && $this->recursive_truthy_key( $value, $needle ) ) {
				return true;
			}
		}

		return false;
	}

	/** @param array<string,mixed> $run Decoded CLI run output. @return array<string,mixed> */
	private function provider_error_details( array $run, string $output ): array {
		$payloads = array_merge( array( $run ), $this->agent_payloads( $run ) );
		$json     = function_exists( 'wp_json_encode' ) ? wp_json_encode( $payloads, JSON_UNESCAPED_SLASHES ) : json_encode( $payloads, JSON_UNESCAPED_SLASHES );
		$encoded  = strtolower( is_string( $json ) ? $json : '' );
		$output_l = strtolower( $output );
		$haystack = $encoded . "\n" . $output_l;

		if ( ! preg_match( '/provider|timeout|timed out|429|rate limit|too many requests|openai|anthropic/', $haystack ) ) {
			return array();
		}

		$message = $this->recursive_first_string_key( $run, array( 'message', 'error', 'error_message', 'errorMessage', 'details' ) );
		if ( '' === $message ) {
			$message = $this->bound_output( $output );
		}

		return array_filter(
			array(
				'message'   => $this->bound_output( $message ),
				'retryable' => (bool) preg_match( '/timeout|timed out|429|rate limit|too many requests/', $haystack ),
			),
			static fn( mixed $value ): bool => null !== $value && '' !== $value
		);
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	private function resolved_sandbox_tool_policy( array $input ): array|WP_Error {
		$policy = is_array( $input['sandbox_tool_policy'] ?? null ) ? $input['sandbox_tool_policy'] : array();
		if ( empty( $policy ) && function_exists( 'apply_filters' ) ) {
			$policy = apply_filters( 'wp_codebox_resolved_sandbox_tool_policy', $policy, $input );
		}

		$issues = $this->sandbox_tool_policy_issues( is_array( $policy ) ? $policy : array() );
		if ( ! empty( $issues ) ) {
			return new WP_Error(
				'wp_codebox_sandbox_tool_policy_invalid',
				'Allowed tools require a valid resolved sandbox_tool_policy snapshot.',
				array(
					'status' => 400,
					'schema' => 'wp-codebox/sandbox-tool-policy-validation/v1',
					'issues' => $issues,
				)
			);
		}

		return $policy;
	}

	/** @param array<string,mixed> $policy @return array<int,array<string,string>> */
	private function sandbox_tool_policy_issues( array $policy ): array {
		$issues = array();
		if ( self::SANDBOX_TOOL_POLICY_SCHEMA !== ( $policy['schema'] ?? '' ) ) {
			$issues[] = array( 'field' => 'schema', 'message' => 'sandbox_tool_policy.schema must be ' . self::SANDBOX_TOOL_POLICY_SCHEMA . '.' );
		}
		if ( 1 !== (int) ( $policy['version'] ?? 0 ) ) {
			$issues[] = array( 'field' => 'version', 'message' => 'sandbox_tool_policy.version must be 1.' );
		}
		if ( empty( $policy['tools'] ) || ! is_array( $policy['tools'] ) ) {
			$issues[] = array( 'field' => 'tools', 'message' => 'sandbox_tool_policy.tools must be a non-empty array.' );
			return $issues;
		}

		$seen = array();
		foreach ( $policy['tools'] as $index => $tool ) {
			if ( ! is_array( $tool ) ) {
				$issues[] = array( 'field' => 'tools[' . $index . ']', 'message' => 'Each sandbox tool policy tool must be an object.' );
				continue;
			}
			$id = trim( (string) ( $tool['id'] ?? '' ) );
			if ( '' === $id ) {
				$issues[] = array( 'field' => 'tools[' . $index . '].id', 'message' => 'Tool id must be a non-empty string.' );
			} elseif ( isset( $seen[ $id ] ) ) {
				$issues[] = array( 'field' => 'tools[' . $index . '].id', 'message' => 'Duplicate tool id: ' . $id . '.' );
			}
			$seen[ $id ] = true;
			foreach ( array( 'runtime_tool_id' ) as $field ) {
				if ( '' === trim( (string) ( $tool[ $field ] ?? '' ) ) ) {
					$issues[] = array( 'field' => 'tools[' . $index . '].' . $field, 'message' => 'Tool ' . $field . ' must be a non-empty string.' );
				}
			}
			$runtime = is_array( $tool['runtime'] ?? null ) ? $tool['runtime'] : array();
			foreach ( array( self::AGENTS_API_RUNTIME_ENVIRONMENT, self::AGENTS_API_RUNTIME_CAPABILITY_SCOPE ) as $field ) {
				if ( '' === trim( (string) ( $runtime[ $field ] ?? '' ) ) ) {
					$issues[] = array( 'field' => 'tools[' . $index . '].runtime.' . $field, 'message' => 'Tool runtime.' . $field . ' must be a non-empty string.' );
				}
			}
			if ( ! is_bool( $tool['allowed'] ?? null ) ) {
				$issues[] = array( 'field' => 'tools[' . $index . '].allowed', 'message' => 'Tool allowed must be boolean.' );
			}
		}

		return $issues;
	}

	/** @param array<string,mixed> $policy @return string[] */
	private function allowed_sandbox_tools( array $policy ): array {
		$allowed = array();
		foreach ( is_array( $policy['tools'] ?? null ) ? $policy['tools'] : array() as $tool ) {
			if ( is_array( $tool ) && null === $this->sandbox_policy_denial_reason( $tool ) ) {
				$allowed[] = (string) $tool['id'];
			}
		}

		return array_values( array_unique( $allowed ) );
	}

	/** @param array<string,mixed> $policy @return array<string,mixed>|null */
	private function sandbox_policy_tool( array $policy, string $tool_id ): array|null {
		foreach ( is_array( $policy['tools'] ?? null ) ? $policy['tools'] : array() as $tool ) {
			if ( is_array( $tool ) && $tool_id === (string) ( $tool['id'] ?? '' ) ) {
				return $tool;
			}
		}

		return null;
	}

	/** @param array<string,mixed> $tool */
	private function sandbox_policy_denial_reason( array $tool ): string|null {
		$runtime = $this->sandbox_tool_runtime_metadata( $tool );

		if ( self::AGENTS_API_RUNTIME_LOCAL !== $runtime[ self::AGENTS_API_RUNTIME_ENVIRONMENT ] ) {
			return 'parent-only';
		}
		if ( self::AGENTS_API_RUNTIME_LOCAL !== $runtime[ self::AGENTS_API_RUNTIME_CAPABILITY_SCOPE ] ) {
			return 'not-visible-in-sandbox';
		}
		if ( true !== ( $tool['allowed'] ?? false ) ) {
			return 'not-allowed';
		}

		return null;
	}

	/** @param array<string,mixed> $tool @return array{environment:string,capability_scope:string} */
	private function sandbox_tool_runtime_metadata( array $tool ): array {
		$runtime = is_array( $tool['runtime'] ?? null ) ? $tool['runtime'] : array();

		return array(
			self::AGENTS_API_RUNTIME_ENVIRONMENT => isset( $runtime[ self::AGENTS_API_RUNTIME_ENVIRONMENT ] ) && '' !== trim( (string) $runtime[ self::AGENTS_API_RUNTIME_ENVIRONMENT ] )
				? trim( (string) $runtime[ self::AGENTS_API_RUNTIME_ENVIRONMENT ] )
				: '',
			self::AGENTS_API_RUNTIME_CAPABILITY_SCOPE => isset( $runtime[ self::AGENTS_API_RUNTIME_CAPABILITY_SCOPE ] ) && '' !== trim( (string) $runtime[ self::AGENTS_API_RUNTIME_CAPABILITY_SCOPE ] )
				? trim( (string) $runtime[ self::AGENTS_API_RUNTIME_CAPABILITY_SCOPE ] )
				: '',
		);
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
		return rtrim( trim( $path ), DIRECTORY_SEPARATOR );
	}

	private function preview_hold_seconds( array $input ): int {
		return WP_Codebox_Preview_Options::preview_hold_seconds( $input );
	}

	private function preview_args( array $input ): string|WP_Error {
		$options = WP_Codebox_Preview_Options::normalize( $input );
		if ( is_wp_error( $options ) ) {
			return $options;
		}

		$args = $options['preview_hold_seconds'] > 0 ? ' --preview-hold ' . escapeshellarg( (string) $options['preview_hold_seconds'] ) : '';
		$port = $options['preview_port'];
		$bind = $options['preview_bind'];
		$public = $options['preview_public_url'];

		if ( null !== $port ) {
			$args .= ' --preview-port ' . escapeshellarg( (string) $port );
		}
		if ( null !== $bind ) {
			$args .= ' --preview-bind ' . escapeshellarg( $bind );
		}
		if ( null !== $public ) {
			$args .= ' --preview-public-url ' . escapeshellarg( $public );
		}

		return $args;
	}

	private function preview_hold_arg( array $input ): string {
		$seconds = $this->preview_hold_seconds( $input );

		return $seconds > 0 ? ' --preview-hold ' . escapeshellarg( (string) $seconds ) : '';
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

	/** @param array<string,mixed> $input Ability input. @return array<int,array<string,mixed>>|WP_Error */
	private function recipe_mounts( array $input ): array|WP_Error {
		$mounts = is_array( $input['mounts'] ?? null ) ? $input['mounts'] : array();
		$normalized = array();

		foreach ( $mounts as $index => $mount ) {
			if ( ! is_array( $mount ) ) {
				return new WP_Error( 'wp_codebox_mount_invalid', 'Each WP Codebox mount must be an object.', array( 'status' => 400, 'index' => $index ) );
			}

			$source = $this->clean_path( (string) ( $mount['source'] ?? '' ) );
			$target = trim( (string) ( $mount['target'] ?? '' ) );
			if ( '' === $source || ! is_dir( $source ) ) {
				return new WP_Error( 'wp_codebox_mount_source_invalid', 'WP Codebox mount source must be an existing directory.', array( 'status' => 400, 'index' => $index ) );
			}

			if ( '' === $target || ! str_starts_with( $target, '/' ) ) {
				return new WP_Error( 'wp_codebox_mount_target_invalid', 'WP Codebox mount target must be an absolute sandbox path.', array( 'status' => 400, 'index' => $index ) );
			}

			$mode = (string) ( $mount['mode'] ?? 'readwrite' );
			if ( 'readonly' !== $mode && 'readwrite' !== $mode ) {
				return new WP_Error( 'wp_codebox_mount_mode_invalid', 'WP Codebox mount mode must be readonly or readwrite.', array( 'status' => 400, 'index' => $index ) );
			}

			$entry = array(
				'source' => $source,
				'target' => $target,
				'mode'   => $mode,
			);

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
	private function recipe_workspaces( array $input ): array|WP_Error {
		$workspaces = is_array( $input['workspaces'] ?? null ) ? $input['workspaces'] : array();
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
	private function recipe_runtime( array $input, string $wp_version ): array|WP_Error {
		$runtime = array(
			'wp'        => $wp_version,
			'blueprint' => array( 'steps' => array() ),
		);

		$stack_mounts = $this->merge_array_lists( $input['runtime_stack_mounts'] ?? array() );
		if ( ! empty( $stack_mounts ) ) {
			$runtime['stack'] = array( 'mounts' => $stack_mounts );
		}

		$overlays = $this->merge_array_lists( $input['runtime_overlays'] ?? array() );
		if ( ! empty( $overlays ) ) {
			$runtime['overlays'] = $overlays;
		}

		return $runtime;
	}

	private function command_prefix( string $bin ): string|WP_Error {
		if ( str_ends_with( $bin, '.js' ) && is_file( $bin ) ) {
			$node = $this->node_binary();
			if ( is_wp_error( $node ) ) {
				return $node;
			}

			return escapeshellarg( $node ) . ' ' . escapeshellarg( $bin );
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

		if ( ! function_exists( 'exec' ) ) {
			return '';
		}

		$output = array();
		$exit   = 1;
		// phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.system_calls_exec -- Used for executable preflight only.
		exec( 'command -v ' . escapeshellarg( $command ) . ' 2>/dev/null', $output, $exit );
		$resolved = 0 === $exit && ! empty( $output[0] ) ? (string) $output[0] : '';

		return '' !== $resolved && is_executable( $resolved ) ? $resolved : '';
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
			array(
				'inheritance_resolution'     => fn( array $input ): array => $this->inheritance_resolution( $input ),
				'connector_credentials_error' => fn( array $inheritance ): WP_Error|null => $this->connector_credentials_error( $inheritance ),
				'provider_plugin_paths'       => fn( array $input, array $inheritance ): array => $this->provider_plugin_paths( $input, $inheritance ),
				'agent_bundles'               => fn( array $input ): array => $this->agent_bundles( $input ),
				'runtime_task'                => fn( array $input ): array => $this->runtime_task( $input ),
				'task_input'                  => fn( array $input ): array|WP_Error => $this->task_input( $input ),
				'agent_slug'                  => fn( array $input ): string => $this->agent_slug( $input ),
				'mode'                        => fn( array $input ): string => $this->mode( $input ),
				'provider'                    => fn( array $input, array $inheritance ): string => $this->provider( $input, $inheritance ),
				'model'                       => fn( array $input, array $inheritance ): string => $this->model( $input, $inheritance ),
				'json_encode'                 => fn( mixed $value ): string => $this->json_encode( $value ),
				'task_timeout_seconds'        => fn( array $input ): int => $this->task_timeout_seconds( $input ),
				'recipe_mounts'               => fn( array $input ): array|WP_Error => $this->recipe_mounts( $input ),
				'recipe_workspaces'           => fn( array $input ): array|WP_Error => $this->recipe_workspaces( $input ),
				'recipe_runtime'              => fn( array $input, string $wp_version ): array|WP_Error => $this->recipe_runtime( $input, $wp_version ),
				'site_seed_recipe_entries'    => fn( array $input ): array|WP_Error => $this->parent_site_seed_recipe_entries( $input ),
				'inheritance_request'         => fn( array $input ): array => $this->inheritance_request( $input ),
				'component_plugins'           => fn( array $paths ): array => $this->component_plugins( $paths ),
				'secret_env_names'            => fn( array $input, array $inheritance ): array => $this->secret_env_names( $input, $inheritance ),
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

	/** @param array<string,mixed> $scopes Parent-site seed scopes. */
	private function validate_parent_site_seed_scopes( array $scopes ): true|WP_Error {
		if ( empty( $scopes ) ) {
			return new WP_Error( 'wp_codebox_site_seed_scopes_missing', 'parent_site site_seeds require explicit scopes.', array( 'status' => 400 ) );
		}

		foreach ( array( 'posts', 'terms', 'options', 'users', 'media' ) as $scope_name ) {
			$scope = $scopes[ $scope_name ] ?? null;
			if ( null === $scope ) {
				continue;
			}
			if ( ! is_array( $scope ) ) {
				return new WP_Error( 'wp_codebox_site_seed_scope_invalid', 'Record site seed scopes must be objects.', array( 'status' => 400, 'scope' => $scope_name ) );
			}
			$max = isset( $scope['maxRecords'] ) ? (int) $scope['maxRecords'] : 0;
			if ( $max < 1 || $max > 100 ) {
				return new WP_Error( 'wp_codebox_site_seed_scope_unbounded', 'Parent-site record scopes require maxRecords between 1 and 100.', array( 'status' => 400, 'scope' => $scope_name ) );
			}
		}

		if ( isset( $scopes['options'] ) && empty( $scopes['options']['names'] ) ) {
			return new WP_Error( 'wp_codebox_site_seed_options_unbounded', 'Parent-site option seeds require an explicit names allow-list.', array( 'status' => 400 ) );
		}
		if ( isset( $scopes['users'] ) && false === ( $scopes['users']['anonymize'] ?? true ) ) {
			return new WP_Error( 'wp_codebox_site_seed_users_unsafe', 'Parent-site user seeds must be anonymized.', array( 'status' => 400 ) );
		}
		if ( isset( $scopes['media'] ) && true === ( $scopes['media']['includeFiles'] ?? false ) ) {
			return new WP_Error( 'wp_codebox_site_seed_media_files_unsupported', 'Parent-site media seed export includes metadata only; file export is not supported.', array( 'status' => 400 ) );
		}

		return true;
	}

	/** @param array<string,mixed> $scopes Parent-site seed scopes. @return array<string,mixed>|WP_Error */
	private function export_parent_site_seed( string $name, array $scopes ): array|WP_Error {
		$seed = array(
			'schema'     => 'wp-codebox/site-seed-fixture/v1',
			'name'       => $name,
			'provenance' => array(
				'source'      => 'parent_site',
				'source_url'  => function_exists( 'home_url' ) ? home_url( '/' ) : '',
				'exported_at' => gmdate( 'c' ),
				'limitations' => array(
					'media file bytes are not exported',
					'user credentials and raw user emails are not exported',
					'full database state, revisions, comments, post meta, term meta, and arbitrary options are not replayed',
				),
			),
		);

		if ( isset( $scopes['posts'] ) ) {
			$seed['posts'] = $this->export_parent_site_posts( $scopes['posts'] );
		}
		if ( isset( $scopes['terms'] ) ) {
			$seed['terms'] = $this->export_parent_site_terms( $scopes['terms'] );
		}
		if ( isset( $scopes['options'] ) ) {
			$seed['options'] = $this->export_parent_site_options( $scopes['options'] );
		}
		if ( isset( $scopes['users'] ) ) {
			$seed['users'] = $this->export_parent_site_users( $scopes['users'] );
		}
		if ( isset( $scopes['media'] ) ) {
			$seed['media'] = $this->export_parent_site_media( $scopes['media'] );
		}
		if ( true === ( $scopes['activePlugins'] ?? false ) ) {
			$seed['activePlugins'] = array_slice( array_values( (array) get_option( 'active_plugins', array() ) ), 0, 100 );
		}
		if ( true === ( $scopes['activeTheme'] ?? false ) && function_exists( 'get_stylesheet' ) ) {
			$seed['activeTheme'] = get_stylesheet();
		}

		return $seed;
	}

	/** @param array<string,mixed> $scope Parent-site posts scope. @return array<int,array<string,mixed>> */
	private function export_parent_site_posts( array $scope ): array {
		$query = array(
			'post_type'      => ! empty( $scope['postTypes'] ) && is_array( $scope['postTypes'] ) ? array_map( 'sanitize_key', $scope['postTypes'] ) : array( 'post', 'page' ),
			'post_status'    => ! empty( $scope['statuses'] ) && is_array( $scope['statuses'] ) ? array_map( 'sanitize_key', $scope['statuses'] ) : array( 'publish' ),
			'posts_per_page' => min( 100, max( 1, (int) $scope['maxRecords'] ) ),
			'orderby'        => 'ID',
			'order'          => 'ASC',
			'no_found_rows'  => true,
		);
		if ( ! empty( $scope['ids'] ) && is_array( $scope['ids'] ) ) {
			$query['post__in'] = array_map( 'absint', $scope['ids'] );
			$query['orderby']  = 'post__in';
		}
		if ( ! empty( $scope['slugs'] ) && is_array( $scope['slugs'] ) ) {
			$query['post_name__in'] = array_map( 'sanitize_title', $scope['slugs'] );
		}

		$posts = function_exists( 'get_posts' ) ? get_posts( $query ) : array();
		return array_map(
			static fn( WP_Post $post ): array => array(
				'id'           => (int) $post->ID,
				'post_type'    => $post->post_type,
				'post_status'  => $post->post_status,
				'post_name'    => $post->post_name,
				'post_title'   => $post->post_title,
				'post_content' => $post->post_content,
				'post_excerpt' => $post->post_excerpt,
			),
			$posts
		);
	}

	/** @param array<string,mixed> $scope Parent-site terms scope. @return array<int,array<string,mixed>> */
	private function export_parent_site_terms( array $scope ): array {
		$args = array(
			'taxonomy'   => ! empty( $scope['taxonomies'] ) && is_array( $scope['taxonomies'] ) ? array_map( 'sanitize_key', $scope['taxonomies'] ) : array( 'category', 'post_tag' ),
			'number'     => min( 100, max( 1, (int) $scope['maxRecords'] ) ),
			'hide_empty' => false,
			'orderby'    => 'term_id',
			'order'      => 'ASC',
		);
		if ( ! empty( $scope['ids'] ) && is_array( $scope['ids'] ) ) {
			$args['include'] = array_map( 'absint', $scope['ids'] );
		}
		if ( ! empty( $scope['slugs'] ) && is_array( $scope['slugs'] ) ) {
			$args['slug'] = array_map( 'sanitize_title', $scope['slugs'] );
		}
		if ( ! empty( $scope['names'] ) && is_array( $scope['names'] ) ) {
			$args['name'] = array_values( array_map( 'sanitize_text_field', $scope['names'] ) );
		}

		$terms = function_exists( 'get_terms' ) ? get_terms( $args ) : array();
		if ( is_wp_error( $terms ) || ! is_array( $terms ) ) {
			return array();
		}

		return array_map(
			static fn( WP_Term $term ): array => array(
				'id'          => (int) $term->term_id,
				'taxonomy'    => $term->taxonomy,
				'slug'        => $term->slug,
				'name'        => $term->name,
				'description' => $term->description,
			),
			array_slice( $terms, 0, min( 100, max( 1, (int) $scope['maxRecords'] ) ) )
		);
	}

	/** @param array<string,mixed> $scope Parent-site options scope. @return array<string,mixed> */
	private function export_parent_site_options( array $scope ): array {
		$options = array();
		$names   = ! empty( $scope['names'] ) && is_array( $scope['names'] ) ? array_slice( $scope['names'], 0, min( 100, max( 1, (int) $scope['maxRecords'] ) ) ) : array();
		foreach ( $names as $name ) {
			$name = sanitize_key( (string) $name );
			if ( '' === $name ) {
				continue;
			}
			$options[ $name ] = get_option( $name );
		}

		return $options;
	}

	/** @param array<string,mixed> $scope Parent-site users scope. @return array<int,array<string,mixed>> */
	private function export_parent_site_users( array $scope ): array {
		$args = array(
			'number'  => min( 100, max( 1, (int) $scope['maxRecords'] ) ),
			'orderby' => 'ID',
			'order'   => 'ASC',
			'fields'  => array( 'ID', 'display_name', 'roles' ),
		);
		if ( ! empty( $scope['ids'] ) && is_array( $scope['ids'] ) ) {
			$args['include'] = array_map( 'absint', $scope['ids'] );
		}
		if ( ! empty( $scope['roles'] ) && is_array( $scope['roles'] ) ) {
			$args['role__in'] = array_map( 'sanitize_key', $scope['roles'] );
		}

		$users = function_exists( 'get_users' ) ? get_users( $args ) : array();
		return array_map(
			static fn( WP_User $user ): array => array(
				'id'           => (int) $user->ID,
				'user_login'   => 'seed-user-' . (int) $user->ID,
				'user_email'   => 'seed-user-' . (int) $user->ID . '@example.invalid',
				'display_name' => 'Seed user ' . (int) $user->ID,
				'roles'        => array_values( array_map( 'sanitize_key', (array) $user->roles ) ),
			),
			$users
		);
	}

	/** @param array<string,mixed> $scope Parent-site media scope. @return array<int,array<string,mixed>> */
	private function export_parent_site_media( array $scope ): array {
		$query = array(
			'post_type'      => 'attachment',
			'post_status'    => ! empty( $scope['statuses'] ) && is_array( $scope['statuses'] ) ? array_map( 'sanitize_key', $scope['statuses'] ) : array( 'inherit' ),
			'posts_per_page' => min( 100, max( 1, (int) $scope['maxRecords'] ) ),
			'orderby'        => 'ID',
			'order'          => 'ASC',
			'no_found_rows'  => true,
		);
		if ( ! empty( $scope['ids'] ) && is_array( $scope['ids'] ) ) {
			$query['post__in'] = array_map( 'absint', $scope['ids'] );
			$query['orderby']  = 'post__in';
		}
		if ( ! empty( $scope['slugs'] ) && is_array( $scope['slugs'] ) ) {
			$query['post_name__in'] = array_map( 'sanitize_title', $scope['slugs'] );
		}

		$attachments = function_exists( 'get_posts' ) ? get_posts( $query ) : array();
		return array_map(
			static fn( WP_Post $post ): array => array(
				'id'             => (int) $post->ID,
				'post_name'      => $post->post_name,
				'post_title'     => $post->post_title,
				'post_excerpt'   => $post->post_excerpt,
				'post_mime_type' => $post->post_mime_type,
				'post_status'    => $post->post_status,
			),
			$attachments
		);
	}

	/**
	 * @param array<int,array<string,mixed>> $paths Component contracts.
	 * @return array<int,array{source:string,slug:string,activate:bool}>
	 */
	private function component_plugins( array $paths ): array {
		$plugins = array();
		foreach ( $paths as $contract ) {
			$path = (string) ( $contract['path'] ?? '' );
			if ( '' === $path ) {
				continue;
			}

			$plugins[] = array(
				'source'   => $path,
				'slug'     => (string) ( $contract['slug'] ?? basename( $path ) ),
				'activate' => (bool) ( $contract['activate'] ?? false ),
				'loadAs'   => (string) ( $contract['loadAs'] ?? 'mu-plugin' ),
			);
		}

		return $plugins;
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

	/** @param array<string,mixed> $run Decoded CLI run output. @param array<string,mixed>|null $outcome Strict remediation outcome when requested. @return array<string,mixed> */
	private function run_diagnostics( array $run, int $exit_code, ?array $outcome ): array {
		$agent_result = is_array( $run['agentResult'] ?? null ) ? $run['agentResult'] : array();
		$agent_task_result = is_array( $run['agentTaskResult'] ?? null ) ? $run['agentTaskResult'] : array();

		return array_filter(
			array(
				'schema'                    => 'wp-codebox/agent-task-diagnostics/v1',
				'exit_code'                 => $exit_code,
				'recipe_run_schema'         => (string) ( $run['schema'] ?? '' ),
				'agent_result_schema'       => (string) ( $agent_result['schema'] ?? '' ),
				'agent_task_result_schema'  => (string) ( $agent_task_result['schema'] ?? '' ),
				'agent_task_result_status'  => (string) ( $agent_task_result['status'] ?? '' ),
				'agent_actionable'          => array_key_exists( 'actionable', $agent_result ) ? (bool) $agent_result['actionable'] : null,
				'agent_no_op_reason'        => (string) ( $agent_result['noOpReason'] ?? '' ),
				'completion_outcome_status' => is_array( $run['completionOutcome'] ?? null ) ? (string) ( $run['completionOutcome']['status'] ?? '' ) : '',
				'outcome_kind'              => is_array( $outcome ) ? (string) ( $outcome['kind'] ?? '' ) : '',
				'outcome_retryable'         => is_array( $outcome ) && array_key_exists( 'retryable', $outcome ) ? (bool) $outcome['retryable'] : null,
			),
			static fn( mixed $value ): bool => null !== $value && '' !== $value
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
				'orchestrator'       => is_array( $input['orchestrator'] ?? null ) ? $input['orchestrator'] : array(),
				'wp'                 => $wp_version,
				'recipe_run_schema'  => (string) ( $run['schema'] ?? '' ),
			),
			static fn( mixed $value ): bool => '' !== $value && array() !== $value
		);
	}

	private function error_payload( WP_Error $error ): array {
		return array_filter(
			array(
				'code'    => $error->get_error_code(),
				'message' => $error->get_error_message(),
				'data'    => $error->get_error_data(),
			),
			static fn( mixed $value ): bool => null !== $value && array() !== $value && '' !== $value
		);
	}

	/** @return array<string,mixed>|WP_Error */
	private function decode_json_output( string $output ): array|WP_Error {
		$trimmed = trim( $output );
		if ( '' === $trimmed ) {
			return new WP_Error( 'empty_output', 'Empty output.' );
		}

		$decoded = json_decode( $trimmed, true );
		if ( is_array( $decoded ) ) {
			return $decoded;
		}

		$offset = strrpos( $trimmed, "\n{" );
		if ( false !== $offset ) {
			$decoded = json_decode( substr( $trimmed, $offset + 1 ), true );
			if ( is_array( $decoded ) ) {
				return $decoded;
			}
		}

		return new WP_Error( 'json_decode_failed', json_last_error_msg() );
	}

	/** @param array<string,mixed> $input Ability input. */
	private function task_timeout_seconds( array $input ): int {
		$timeout = (int) ( $input['task_timeout_seconds'] ?? 0 );
		return max( 0, $timeout );
	}

	/** @param array<string,string> $secret_env Secret env values for the child process. @return array{exit_code:int,output:string,timed_out?:bool,timeout_seconds?:int} */
	private function run_command( string $command, array $secret_env = array(), int $timeout_seconds = 0 ): array {
		if ( isset( $this->callbacks['command_runner'] ) ) {
			return ( $this->callbacks['command_runner'] )( $command, $secret_env, $timeout_seconds );
		}

		if ( ( ! empty( $secret_env ) || $timeout_seconds > 0 ) && ! function_exists( 'proc_open' ) ) {
			return array(
				'exit_code' => 1,
				'output'    => 'WP Codebox inherited secret environment or timeout requires proc_open support.',
			);
		}

		if ( ! empty( $secret_env ) || $timeout_seconds > 0 ) {
			$descriptor_spec = array(
				1 => array( 'pipe', 'w' ),
				2 => array( 'pipe', 'w' ),
			);
			$current_env = getenv();
			$process     = proc_open( $command, $descriptor_spec, $pipes, null, array_merge( is_array( $current_env ) ? $current_env : array(), $_ENV, $secret_env ) );
			if ( is_resource( $process ) ) {
				stream_set_blocking( $pipes[1], false );
				stream_set_blocking( $pipes[2], false );
				$output    = '';
				$error     = '';
				$started   = time();
				$timed_out = false;

				while ( true ) {
					$output .= (string) stream_get_contents( $pipes[1] );
					$error  .= (string) stream_get_contents( $pipes[2] );
					$status = proc_get_status( $process );
					if ( ! (bool) ( $status['running'] ?? false ) ) {
						break;
					}
					if ( $timeout_seconds > 0 && time() - $started >= $timeout_seconds ) {
						$timed_out = true;
						proc_terminate( $process );
						break;
					}
					usleep( 100000 );
				}

				$output .= (string) stream_get_contents( $pipes[1] );
				$error  .= (string) stream_get_contents( $pipes[2] );
				fclose( $pipes[1] );
				fclose( $pipes[2] );
				$exit_code = proc_close( $process );

				if ( $timed_out ) {
					return array(
						'exit_code'       => 124,
						'output'          => trim( (string) $output . "\n" . (string) $error . "\nWP Codebox task timed out after {$timeout_seconds} seconds." ),
						'timed_out'       => true,
						'timeout_seconds' => $timeout_seconds,
					);
				}

				return array(
					'exit_code' => $exit_code,
					'output'    => trim( (string) $output . "\n" . (string) $error ),
				);
			}
		}

		$output = array();
		$exit   = 0;
		// phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.system_calls_exec -- Required host-side WP Codebox execution primitive.
		exec( $command . ' 2>&1', $output, $exit );

		return array(
			'exit_code' => $exit,
			'output'    => implode( "\n", $output ),
		);
	}

	private function bound_output( string $output ): string {
		if ( strlen( $output ) <= 4000 ) {
			return $output;
		}

		return substr( $output, 0, 4000 );
	}
}
