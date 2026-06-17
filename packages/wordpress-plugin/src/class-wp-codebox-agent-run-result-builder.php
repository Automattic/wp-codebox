<?php
/**
 * Host-side WP Codebox agent batch and fanout result envelopes.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_Agent_Run_Result_Builder {

	private const SESSION_SCHEMA = WP_Codebox_Agent_Task::SESSION_SCHEMA;

	private WP_Codebox_Run_Plan $run_plan;

	public function __construct( ?WP_Codebox_Run_Plan $run_plan = null ) {
		$this->run_plan = $run_plan ?? new WP_Codebox_Run_Plan();
	}

	/** @param array<string,mixed> $task_input Normalized task input. @param array<string,mixed> $task_result Single task run result. @return array<string,mixed> */
	public function batch_success_run( int $index, array $task_input, array $task_result ): array {
		return array(
			'index'              => $index,
			'task'               => (string) $task_input['goal'],
			'task_input'         => $task_input,
			'success'            => true,
			'status'             => 'completed',
			'exit_code'          => (int) ( $task_result['exit_code'] ?? 0 ),
			'session'            => $task_result['session'] ?? array(),
			'artifact_id'        => (string) ( $task_result['session']['artifacts']['bundle_id'] ?? '' ),
			'preview_url'        => (string) ( $task_result['session']['artifacts']['preview_url'] ?? '' ),
			'artifacts'          => $task_result['session']['artifacts'] ?? array(),
			'agent_result'       => $task_result['agent_result'] ?? array(),
			'agent_task_result'  => $task_result['agent_task_result'] ?? array(),
			'completion_outcome' => $task_result['completion_outcome'] ?? array(),
			'run'                => $task_result['run'] ?? array(),
		);
	}

	/** @param array<string,mixed> $task_input Normalized task input. @return array<string,mixed> */
	public function batch_error_run( int $index, array $task_input, WP_Error $error ): array {
		return array(
			'index'      => $index,
			'task'       => (string) $task_input['goal'],
			'task_input' => $task_input,
			'success'    => false,
			'status'     => 'failed',
			'error'      => $this->error_payload( $error ),
		);
	}

	/** @param array<string,mixed> $session Parent sandbox session. @param array<int,string> $tasks Task labels. @param array<int,array<string,mixed>> $task_inputs Normalized task inputs. @param array<int,array<string,mixed>> $runs Child runs. @param array<int,array<string,mixed>> $paths Component paths. @return array<string,mixed> */
	public function batch_result( string $schema, array $session, array $tasks, array $task_inputs, string $execution, string $wp_version, array $paths, string $artifacts, array $runs ): array {
		$completed = count( array_filter( $runs, static fn( array $run ): bool => true === ( $run['success'] ?? false ) ) );
		$failed    = count( $runs ) - $completed;

		return array(
			'success'     => 0 === $failed,
			'schema'      => $schema,
			'session'     => $session,
			'tasks'       => $tasks,
			'task_inputs' => $task_inputs,
			'execution'   => $execution,
			'total'       => count( $runs ),
			'completed'   => $completed,
			'failed'      => $failed,
			'wp'          => $wp_version,
			'paths'       => $paths,
			'artifacts'   => $artifacts,
			'runs'        => $runs,
		);
	}

	/** @param array<string,mixed> $worker Worker metadata. @param array<string,mixed> $result Worker result. @return array<string,mixed> */
	public function fanout_worker_success_result( array $worker, array $result, float $started_at, float $ended_at ): array {
		$session   = is_array( $result['session'] ?? null ) ? $result['session'] : array();
		$artifacts = is_array( $session['artifacts'] ?? null ) ? $session['artifacts'] : array();

		return array(
			'worker_id'          => (string) $worker['id'],
			'index'              => (int) $worker['index'],
			'success'            => true,
			'status'             => 'completed',
			'agent'              => (string) ( $worker['prepared']['input']['agent'] ?? '' ),
			'exit_code'          => (int) ( $result['exit_code'] ?? 0 ),
			'session'            => $session,
			'artifacts'          => array_merge( $artifacts, array( 'namespace' => (string) $worker['id'], 'result' => 'result.json' ) ),
			'diagnostics'        => is_array( $result['diagnostics'] ?? null ) ? $result['diagnostics'] : array(),
			'evidence_refs'      => is_array( $result['evidence_refs'] ?? null ) ? $result['evidence_refs'] : array(),
			'completion_outcome' => is_array( $result['completion_outcome'] ?? null ) ? $result['completion_outcome'] : array(),
			'timings'            => $this->timings( $started_at, $ended_at ),
		);
	}

	/** @param array<string,mixed> $worker Worker metadata. @return array<string,mixed> */
	public function fanout_worker_error_result( array $worker, WP_Error $error, float $started_at, float $ended_at ): array {
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
			'error'     => $this->error_payload( $error ),
			'timings'   => array_filter(
				array(
					'started_at'  => $started_at > 0 ? gmdate( 'c', (int) $started_at ) : '',
					'ended_at'    => $ended_at > 0 ? gmdate( 'c', (int) $ended_at ) : '',
					'duration_ms' => $started_at > 0 && $ended_at > 0 ? (int) round( ( $ended_at - $started_at ) * 1000 ) : null,
				),
				static fn( mixed $value ): bool => null !== $value && '' !== $value
			),
		);
	}

	/** @param array<string,mixed> $input Ability input. @param array<string,string> $paths Run-plan artifact paths. @param array<int,array<string,mixed>> $runs Child runs. @return array<string,mixed> */
	public function fanout_parent_session( string $session_id, string $status, array $input, array $paths, array $runs ): array {
		$children = array_map(
			static fn( array $run ): array => array_filter(
				array(
					'worker_id'  => (string) ( $run['worker_id'] ?? '' ),
					'session_id' => (string) ( $run['session']['id'] ?? '' ),
					'status'     => (string) ( $run['status'] ?? '' ),
					'artifacts'  => is_array( $run['artifacts'] ?? null ) ? $run['artifacts'] : array(),
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
				'path'      => $paths['root'],
				'plan'      => 'plan.json',
				'events'    => 'events.jsonl',
				'result'    => 'result.json',
				'aggregate' => 'aggregate/result.json',
			)
		);
		$session['children'] = $children;

		return $session;
	}

	/** @param array<string,mixed> $input Ability input. @param array<string,string> $paths Run-plan artifact paths. @param array{total:int,completed:int,failed:int,cancelled:int} $counts Counts. @param array<string,mixed> $plan Plan. @param array<int,array<string,mixed>> $runs Child run results. @return array<string,mixed> */
	public function fanout_result( string $schema, string $artifact_schema, string $execution, string $session_id, string $status, array $input, array $paths, array $counts, float $started_at, float $ended_at, array $plan, array $runs ): array {
		$success = $this->run_plan->succeeded( $counts );

		return array(
			'success'      => $success,
			'schema'       => $schema,
			'execution'    => $execution,
			'session'      => $this->fanout_parent_session( $session_id, $status, $input, $paths, $runs ),
			'concurrency'  => (int) $plan['concurrency'],
			'total'        => $counts['total'],
			'completed'    => $counts['completed'],
			'failed'       => $counts['failed'],
			'cancelled'    => $counts['cancelled'],
			'timings'      => $this->timings( $started_at, $ended_at ),
			'artifacts'    => $this->run_plan->artifacts( $artifact_schema, $paths ),
			'orchestrator' => is_array( $input['orchestrator'] ?? null ) ? $input['orchestrator'] : array(),
			'runs'         => $runs,
			'failures'     => $this->run_plan->failures( $runs ),
		);
	}

	/** @return array{total:int,completed:int,failed:int,cancelled:int} */
	public function status_counts( array $runs ): array {
		return $this->run_plan->result_counts( $runs );
	}

	/** @return array<string,mixed> */
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

	/** @return array{started_at:string,ended_at:string,duration_ms:int} */
	private function timings( float $started_at, float $ended_at ): array {
		return array(
			'started_at'  => gmdate( 'c', (int) $started_at ),
			'ended_at'    => gmdate( 'c', (int) $ended_at ),
			'duration_ms' => (int) round( ( $ended_at - $started_at ) * 1000 ),
		);
	}
}
