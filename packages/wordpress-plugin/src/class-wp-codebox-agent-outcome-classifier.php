<?php
/**
 * Agent sandbox outcome classification and response shaping.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_Agent_Outcome_Classifier {

	private const REMEDIATION_OUTCOME_SCHEMA = 'wp-codebox/agent-sandbox-remediation-outcome/v1';
	private const COMPLETION_OUTCOME_SCHEMA = 'wp-codebox/sandbox-completion-outcome/v1';
	private const AGENTS_API_RUN_OUTCOME_SCHEMA = 'agents-api.run-outcome';

	/** @param array<string,mixed> $task_input Normalized task input. */
	public function strict_remediation_outcome( array $task_input ): bool {
		$target             = is_array( $task_input['target'] ?? null ) ? $task_input['target'] : array();
		$policy             = is_array( $task_input['policy'] ?? null ) ? $task_input['policy'] : array();

		foreach ( array( $target['kind'] ?? '', $policy['kind'] ?? '', $policy['outcome_contract'] ?? '', $policy['outcomeContract'] ?? '' ) as $value ) {
			$value = strtolower( str_replace( '_', '-', trim( (string) $value ) ) );
			if ( in_array( $value, array( 'audit-remediation', 'agent-sandbox-remediation', 'remediation-outcome' ), true ) ) {
				return true;
			}
		}

		return false;
	}

	/** @param array<string,mixed> $run Decoded CLI run output. @return array<string,mixed> */
	public function remediation_outcome( array $run, int $exit_code, string $output ): array {
		$run_outcome          = $this->agents_api_run_outcome( $run );
		$has_run_outcome      = ! empty( $run_outcome );
		$run_status           = (string) ( $run_outcome['status'] ?? '' );
		$stop_reason          = (string) ( $run_outcome['stop_reason'] ?? '' );
		$max_turns_reached    = $has_run_outcome ? 'max_turns' === $stop_reason : $this->recursive_truthy_key( $run, 'max_turns_reached' );
		$pending_runtime_tool = $has_run_outcome && ( 'runtime_tool_pending' === $run_status || 'runtime_tool_pending' === $stop_reason );
		$provider_error       = $has_run_outcome ? $this->agents_api_provider_error_details( $run_outcome ) : array();
		$artifact             = $this->remediation_artifact_details( $run );
		$has_artifact_changes = ! empty( $artifact['changed_files'] );
		$failed               = ( $has_run_outcome && 'failed' === $run_status ) || 0 !== $exit_code;

		$outcome = array(
			'schema'      => self::REMEDIATION_OUTCOME_SCHEMA,
			'success'     => ! $failed,
			'kind'        => $failed ? 'failed' : 'completed',
			'failure'     => '',
			'exit_code'   => $exit_code,
			'retryable'   => false,
			'diagnostics' => array_filter(
				array(
					'upstream_run_status'      => $has_run_outcome ? $run_status : null,
					'upstream_run_stop_reason' => $has_run_outcome ? $stop_reason : null,
					'upstream_run_completed'   => $has_run_outcome && array_key_exists( 'completed', $run_outcome ) ? (bool) $run_outcome['completed'] : null,
					'pending_runtime_tool'   => $has_run_outcome ? $pending_runtime_tool : null,
					'max_turns_reached'     => $max_turns_reached,
				),
				static fn( mixed $value ): bool => null !== $value
			),
		);

		if ( $has_run_outcome ) {
			$outcome['metadata'] = array( 'upstream_run' => $this->codebox_run_outcome_dto( $run_outcome ) );
		}

		if ( $has_artifact_changes ) {
			$outcome['artifact'] = $artifact;
		}

		if ( $pending_runtime_tool ) {
			$outcome['success']   = false;
			$outcome['kind']      = 'runtime_tool_pending';
			$outcome['failure']   = 'runtime_tool_pending';
			$outcome['retryable'] = (bool) ( $run_outcome['retryable'] ?? false );
			return $outcome;
		}

		if ( $max_turns_reached ) {
			$outcome['success']   = false;
			$outcome['kind']      = 'max_turns_exceeded';
			$outcome['failure']   = 'max_turns_exceeded';
			$outcome['retryable'] = $has_run_outcome ? (bool) ( $run_outcome['retryable'] ?? true ) : true;
			return $outcome;
		}

		if ( ! empty( $provider_error ) ) {
			$outcome['success']        = false;
			$outcome['kind']           = 'provider_error';
			$outcome['failure']        = 'provider_error';
			$outcome['provider_error'] = $provider_error;
			$outcome['retryable']      = (bool) ( $run_outcome['retryable'] ?? true );
			return $outcome;
		}

		if ( $failed ) {
			$outcome['failure']   = 'failed';
			$outcome['retryable'] = $has_run_outcome ? (bool) ( $run_outcome['retryable'] ?? true ) : true;
			return $outcome;
		}

		unset( $outcome['failure'] );
		return $outcome;
	}

	/** @param array<string,mixed> $run Decoded CLI run output. @return array<string,mixed> */
	public function completion_outcome( array $run ): array {
		$outcome = is_array( $run['completionOutcome'] ?? null ) ? $run['completionOutcome'] : array();
		if ( self::COMPLETION_OUTCOME_SCHEMA !== ( $outcome['schema'] ?? '' ) ) {
			return array();
		}

		return $outcome;
	}

	/** @param array<string,mixed> $run Decoded CLI run output. @param array<string,mixed>|null $outcome Strict remediation outcome when requested. @return array<string,mixed> */
	public function run_diagnostics( array $run, int $exit_code, ?array $outcome ): array {
		$agent_result      = is_array( $run['agentResult'] ?? null ) ? $run['agentResult'] : array();
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

	/** @param array<string,mixed> $run_outcome Stable upstream run outcome. @return array<string,mixed> */
	private function codebox_run_outcome_dto( array $run_outcome ): array {
		$dto = $run_outcome;
		if ( isset( $dto['schema'] ) ) {
			$dto['schema'] = 'wp-codebox/upstream-run-outcome/v1';
		}

		return $dto;
	}

	/** @param array<string,mixed> $run_outcome Stable upstream run outcome. @return array<string,mixed> */
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
	private function remediation_artifact_details( array $run ): array {
		$artifacts     = is_array( $run['artifacts'] ?? null ) ? $run['artifacts'] : array();
		$directory     = WP_Codebox_Path_Policy::clean_host_path( (string) ( $artifacts['directory'] ?? $artifacts['path'] ?? '' ) );
		$changed_files = array();

		if ( '' !== $directory ) {
			$changed_files_path = $directory . DIRECTORY_SEPARATOR . 'files' . DIRECTORY_SEPARATOR . 'changed-files.json';
			if ( is_readable( $changed_files_path ) ) {
				$decoded = WP_Codebox_Json::read_array_file( $changed_files_path ) ?? array();
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
		return WP_Codebox_Json::decode_fragment_array( $text );
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
}
