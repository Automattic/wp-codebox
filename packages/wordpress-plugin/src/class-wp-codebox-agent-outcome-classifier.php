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
	public function remediation_outcome( array $run, int $exit_code, string $output ): array {
		$run_outcome          = $this->agents_api_run_outcome( $run );
		$has_run_outcome      = ! empty( $run_outcome );
		$run_status           = (string) ( $run_outcome['status'] ?? '' );
		$stop_reason          = (string) ( $run_outcome['stop_reason'] ?? '' );
		$max_turns_reached    = $has_run_outcome ? 'max_turns' === $stop_reason : $this->recursive_truthy_key( $run, 'max_turns_reached' );
		$pending_runtime_tool = $has_run_outcome && ( 'runtime_tool_pending' === $run_status || 'runtime_tool_pending' === $stop_reason );
		$provider_error       = $has_run_outcome ? $this->agents_api_provider_error_details( $run_outcome ) : $this->provider_error_details( $run, $output );
		$pr_url                = $this->first_url_for_keys( $run, array( 'pr_url', 'pull_request_url', 'pullRequestUrl' ) );
		$false_positive_pr_url = $this->first_url_for_keys( $run, array( 'false_positive_pr_url', 'falsePositivePrUrl' ) );
		$artifact             = $this->remediation_artifact_details( $run );
		$has_artifact_changes = ! empty( $artifact['changed_files'] );
		$false_positive       = $this->remediation_false_positive( $run );

		$outcome = array(
			'schema'      => self::REMEDIATION_OUTCOME_SCHEMA,
			'success'     => true,
			'kind'        => 'unable_to_remediate',
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

		if ( $has_artifact_changes && $false_positive ) {
			$outcome['success']        = true;
			$outcome['kind']           = 'false_positive_artifact';
			$outcome['artifact']       = $artifact;
			$outcome['false_positive'] = true;
			unset( $outcome['failure'] );
			return $outcome;
		}

		if ( $has_artifact_changes ) {
			$outcome['success']  = true;
			$outcome['kind']     = 'fix_artifact';
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
			$outcome['success']               = true;
			$outcome['kind']                  = 'false_positive_pr';
			$outcome['false_positive_pr_url'] = $false_positive_pr_url;
			unset( $outcome['failure'] );
			return $outcome;
		}

		if ( '' !== $pr_url ) {
			$outcome['success'] = true;
			$outcome['kind']    = 'fix_pr';
			$outcome['pr_url']  = $pr_url;
			unset( $outcome['failure'] );
			return $outcome;
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

		if ( ( $has_run_outcome && 'failed' === $run_status ) || 0 !== $exit_code || ! empty( $provider_error ) ) {
			$outcome['success']        = false;
			$outcome['kind']           = 'provider_error';
			$outcome['failure']        = 'provider_error';
			$outcome['provider_error'] = $provider_error;
			$outcome['retryable']      = $has_run_outcome ? (bool) ( $run_outcome['retryable'] ?? true ) : (bool) ( $provider_error['retryable'] ?? true );
			return $outcome;
		}

		if ( $false_positive ) {
			$outcome['kind']           = 'noop_artifact';
			$outcome['false_positive'] = true;
		}

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

	private function bound_output( string $output ): string {
		if ( strlen( $output ) <= 4000 ) {
			return $output;
		}

		return substr( $output, 0, 4000 );
	}
}
