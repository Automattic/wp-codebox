<?php
/**
 * Agent task ability descriptors.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

/**
 * Provides agent task ability descriptors.
 */
final class WP_Codebox_Agent_Task_Ability_Descriptors {

	/**
	 * @param array<string,mixed> $context Shared schemas assembled by WP_Codebox_Abilities.
	 * @return array<string,mixed> Ability descriptor.
	 */
	public static function run_agent_task( array $context ): array {
		$task_input_schema                 = $context['task_input_schema'];
		$session_schema                    = $context['session_schema'];
		$outcome_schema                    = $context['outcome_schema'];
		$completion_outcome_schema         = $context['completion_outcome_schema'];
		$agent_task_run_result_schema      = self::agent_task_run_result_schema();
		$headless_agent_task_result_schema = self::headless_agent_task_result_schema( $agent_task_run_result_schema );

		return array(
			'label'               => 'Run Agent Sandbox Task',
			'description'         => 'Run a bounded headless agent task inside an isolated WP Codebox WordPress sandbox. Public callers provide goal/task input, runtime profile, and workspace artifact policy; WP Codebox returns preview, evidence, and artifact refs.',
			'category'            => 'wp-codebox',
			'input_schema'        => array(
				'type'       => 'object',
				'required'   => array( 'goal' ),
				'properties' => $context['host_agent_task_properties'],
			),
			'output_schema'       => array(
				'type'       => 'object',
				'properties' => array(
					'success'                    => array( 'type' => 'boolean' ),
					'schema'                     => array( 'type' => 'string' ),
					'status'                     => array( 'type' => 'string' ),
					'session'                    => $session_schema,
					'task'                       => array( 'type' => 'string' ),
					'task_input'                 => $task_input_schema,
					'wp'                         => array( 'type' => 'string' ),
					'paths'                      => array( 'type' => 'object' ),
					'artifacts'                  => array( 'type' => 'string' ),
					'artifact_result'            => array( 'type' => 'object' ),
					'outputs'                    => array( 'type' => 'object' ),
					'agent_task_run_result'      => $agent_task_run_result_schema,
					'headless_agent_task_result' => $headless_agent_task_result_schema,
					'exit_code'                  => array( 'type' => 'integer' ),
					'outcome'                    => $outcome_schema,
					'diagnostics'                => array( 'type' => 'object' ),
					'evidence_refs'              => array( 'type' => 'object' ),
					'run_metadata'               => array( 'type' => 'object' ),
					'completion_outcome'         => $completion_outcome_schema,
					'run'                        => array( 'type' => 'object' ),
				),
			),
			'execute_callback'    => array( WP_Codebox_Abilities::class, 'run_agent_task' ),
			'permission_callback' => array( WP_Codebox_Abilities::class, 'can_run_agent_task' ),
			'meta'                => array( 'show_in_rest' => true ),
		);
	}

	/**
	 * @param array<string,mixed> $context Shared schemas assembled by WP_Codebox_Abilities.
	 * @return array<string,mixed> Ability descriptor.
	 */
	public static function run_agent_task_batch( array $context ): array {
		$task_input_schema         = $context['task_input_schema'];
		$session_schema            = $context['session_schema'];
		$outcome_schema            = $context['outcome_schema'];
		$completion_outcome_schema = $context['completion_outcome_schema'];

		return array(
			'label'               => 'Run Agent Sandbox Task Batch',
			'description'         => 'Run multiple tasks in isolated WP Codebox WordPress agent sandboxes and return artifacts for each run.',
			'category'            => 'wp-codebox',
			'input_schema'        => array(
				'type'       => 'object',
				'required'   => array( 'tasks' ),
				'properties' => array(
					'tasks' => array(
						'type'        => 'array',
						'description' => 'Task descriptions or structured task inputs. Each task runs in its own isolated sandbox.',
						'items'       => $task_input_schema,
					),
				) + $context['host_agent_batch_properties'],
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
								'index'              => array( 'type' => 'integer' ),
								'task'               => array( 'type' => 'string' ),
								'task_input'         => $task_input_schema,
								'success'            => array( 'type' => 'boolean' ),
								'status'             => array( 'type' => 'string' ),
								'exit_code'          => array( 'type' => 'integer' ),
								'session'            => $session_schema,
								'artifact_id'        => array( 'type' => 'string' ),
								'preview_url'        => array( 'type' => 'string' ),
								'artifacts'          => array( 'type' => 'object' ),
								'outcome'            => $outcome_schema,
								'completion_outcome' => $completion_outcome_schema,
								'run'                => array( 'type' => 'object' ),
								'error'              => array( 'type' => 'object' ),
							),
						),
					),
				),
			),
			'execute_callback'    => array( WP_Codebox_Abilities::class, 'run_agent_task_batch' ),
			'permission_callback' => array( WP_Codebox_Abilities::class, 'can_run_agent_task' ),
			'meta'                => array( 'show_in_rest' => true ),
		);
	}

	/**
	 * @param array<string,mixed> $context Shared schemas assembled by WP_Codebox_Abilities.
	 * @return array<string,mixed> Ability descriptor.
	 */
	public static function run_agent_task_fanout( array $context ): array {
		$task_input_schema = $context['task_input_schema'];

		return array(
			'label'               => 'Run Agent Sandbox Task Fanout',
			'description'         => 'Run multiple agent sandbox workers with bounded host-side concurrency and parent/child artifact envelopes.',
			'category'            => 'wp-codebox',
			'input_schema'        => array(
				'type'       => 'object',
				'required'   => array( 'workers' ),
				'properties' => array(
					'schema'      => array( 'type' => 'string', 'const' => 'wp-codebox/agent-fanout-request/v1' ),
					'workers'     => array(
						'type'        => 'array',
						'description' => 'Explicit fanout worker definitions. Each worker runs in its own isolated sandbox and artifact namespace.',
						'items'       => array(
							'type'       => 'object',
							'required'   => array( 'id', 'goal' ),
							'properties' => array(
								'schema'          => array( 'type' => 'string', 'const' => 'wp-codebox/agent-fanout-worker/v1' ),
								'id'              => array( 'type' => 'string' ),
								'task'            => array( 'type' => 'string' ),
								'agent'           => array( 'type' => 'string' ),
								'dependsOn'       => array( 'type' => 'array', 'items' => array( 'type' => 'string' ) ),
								'timeout_seconds' => array( 'type' => 'integer' ),
							) + $context['task_input_alias_properties'],
						),
					),
					'concurrency' => array(
						'type'        => 'integer',
						'description' => 'Maximum number of workers to run at once. Defaults to 1 and is capped by the host runtime.',
					),
				) + $context['host_agent_fanout_properties'],
			),
			'output_schema'       => array(
				'type'       => 'object',
				'properties' => array(
					'success'      => array( 'type' => 'boolean' ),
					'schema'       => array( 'type' => 'string', 'const' => 'wp-codebox/agent-fanout-result/v1' ),
					'execution'    => array( 'type' => 'string' ),
					'session'      => array( 'type' => 'object' ),
					'concurrency'  => array( 'type' => 'integer' ),
					'total'        => array( 'type' => 'integer' ),
					'completed'    => array( 'type' => 'integer' ),
					'failed'       => array( 'type' => 'integer' ),
					'skipped'      => array( 'type' => 'integer' ),
					'cancelled'    => array( 'type' => 'integer' ),
					'timed_out'    => array( 'type' => 'integer' ),
					'timings'      => array( 'type' => 'object' ),
					'artifacts'    => array(
						'type'       => 'object',
						'properties' => array(
							'schema' => array( 'type' => 'string', 'const' => 'wp-codebox/agent-fanout-artifacts/v1' ),
							'plan'   => array( 'type' => 'string' ),
							'events' => array( 'type' => 'string' ),
						),
					),
					'aggregate'    => array( 'type' => 'object' ),
					'orchestrator' => array( 'type' => 'object' ),
					'runs'         => array( 'type' => 'array', 'items' => array( 'type' => 'object' ) ),
					'failures'     => array( 'type' => 'array', 'items' => array( 'type' => 'object' ) ),
				),
			),
			'execute_callback'    => array( WP_Codebox_Abilities::class, 'run_agent_task_fanout' ),
			'permission_callback' => array( WP_Codebox_Abilities::class, 'can_run_agent_task' ),
			'meta'                => array( 'show_in_rest' => true ),
		);
	}

	/** @return array<string,mixed> */
	private static function agent_task_run_result_schema(): array {
		return array(
			'type'        => 'object',
			'description' => 'Stable wp-codebox/agent-task-run-result/v1 envelope for consumers, including status, refs, metadata, and terminal result details.',
			'properties'  => array(
				'schema'                 => array( 'type' => 'string', 'const' => 'wp-codebox/agent-task-run-result/v1' ),
				'status'                 => array( 'type' => 'string' ),
				'success'                => array( 'type' => 'boolean' ),
				'summary'                => array( 'type' => 'string' ),
				'artifacts'              => array( 'type' => 'array', 'items' => array( 'type' => 'object' ) ),
				'refs'                   => array( 'type' => 'object' ),
				'diagnostics'            => array( 'type' => 'array', 'items' => array( 'type' => 'object' ) ),
				'metadata'               => array( 'type' => 'object' ),
				'terminal_result'        => array( 'type' => 'object' ),
				'no_op'                  => array( 'type' => 'object' ),
				'failure_classification' => array( 'type' => 'string' ),
			),
		);
	}

	/**
	 * @param array<string,mixed> $agent_task_run_result_schema Nested agent task run result schema.
	 * @return array<string,mixed>
	 */
	private static function headless_agent_task_result_schema( array $agent_task_run_result_schema ): array {
		return array(
			'type'        => 'object',
			'description' => 'Stable wp-codebox/headless-agent-task-result/v1 public envelope for callers that submit wp-codebox/headless-agent-task-request/v1 inputs.',
			'properties'  => array(
				'schema'                => array( 'type' => 'string', 'const' => 'wp-codebox/headless-agent-task-result/v1' ),
				'success'               => array( 'type' => 'boolean' ),
				'status'                => array( 'type' => 'string' ),
				'summary'               => array( 'type' => 'string' ),
				'preview'               => array( 'type' => 'object' ),
				'refs'                  => array( 'type' => 'object' ),
				'artifacts'             => array( 'type' => 'array', 'items' => array( 'type' => 'object' ) ),
				'evidence_refs'         => array( 'type' => 'array', 'items' => array( 'type' => 'object' ) ),
				'diagnostics'           => array( 'type' => 'array', 'items' => array( 'type' => 'object' ) ),
				'metadata'              => array( 'type' => 'object' ),
				'agent_task_run_result' => $agent_task_run_result_schema,
			),
		);
	}
}
