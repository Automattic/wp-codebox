<?php
/**
 * Host-side normalization for sandbox recipe-run command results.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_Host_Run_Result_Normalizer {

	private const SCHEMA = 'wp-codebox/agent-task-run/v1';

	/**
	 * @param array<string,mixed> $prepared Prepared run.
	 * @param array<string,mixed> $result Command result.
	 * @param array<string,callable> $adapters Focused runner adapters for existing host contracts.
	 * @return array<string,mixed>|WP_Error
	 */
	public function normalize( array $prepared, array $result, array $adapters ): array|WP_Error {
		$input      = is_array( $prepared['input'] ?? null ) ? $prepared['input'] : array();
		$task_input = is_array( $prepared['task_input'] ?? null ) ? $prepared['task_input'] : array();
		$task       = (string) ( $prepared['task'] ?? '' );
		$session_id = (string) ( $prepared['session_id'] ?? '' );
		$paths      = is_array( $prepared['paths'] ?? null ) ? $prepared['paths'] : array();
		$artifacts  = (string) ( $prepared['artifacts'] ?? '' );
		$wp_version = (string) ( $prepared['wp_version'] ?? '' );

		@unlink( (string) ( $prepared['recipe_file'] ?? '' ) );
		foreach ( is_array( $prepared['cleanup_paths'] ?? null ) ? $prepared['cleanup_paths'] : array() as $cleanup_path ) {
			@unlink( (string) $cleanup_path );
		}

		$exit_code = (int) ( $result['exit_code'] ?? 1 );
		$output    = (string) ( $result['output'] ?? '' );
		if ( true === ( $result['timed_out'] ?? false ) ) {
			return $this->failed_run_envelope(
				$prepared,
				$result,
				$adapters,
				'wp_codebox_run_timeout',
				'WP Codebox agent sandbox run timed out.',
				'timeout'
			);
		}

		$decoded = $adapters['decode_json_output']( $output );
		if ( is_wp_error( $decoded ) ) {
			return $this->failed_run_envelope(
				$prepared,
				$result,
				$adapters,
				'wp_codebox_json_invalid',
				'WP Codebox did not return valid JSON: ' . $decoded->get_error_message(),
				'invalid_json'
			);
		}

		$strict_remediation_outcome = (bool) $adapters['strict_remediation_outcome']( $task_input );
		$outcome                    = $strict_remediation_outcome ? $adapters['remediation_outcome']( $decoded, $exit_code, $output ) : null;

		if ( 0 !== $exit_code && ! $strict_remediation_outcome ) {
			return $this->failed_run_envelope(
				$prepared,
				$result,
				$adapters,
				'wp_codebox_run_failed',
				'WP Codebox agent sandbox run failed.',
				'non_zero_exit',
				$decoded
			);
		}

		$success           = $strict_remediation_outcome ? (bool) ( $outcome['success'] ?? false ) : true;
		$legacy_status     = $success ? 'completed' : 'failed';
		$agent_task_result = is_array( $decoded['agentTaskResult'] ?? null ) ? $decoded['agentTaskResult'] : array();
		$agent_task_status = WP_Codebox_Status_Taxonomy::agent_task_status(
			array(
				'status'      => $agent_task_result['status'] ?? $legacy_status,
				'success'     => $success,
				'exit_status' => $exit_code,
			)
		);

		$response = array(
			'success'             => $success,
			'schema'              => self::SCHEMA,
			'session'             => $adapters['sandbox_session']( $session_id, 'completed', $input, $decoded, $artifacts ),
			'task'                => $task,
			'task_input'          => $task_input,
			'wp'                  => $wp_version,
			'paths'               => $paths,
			'artifacts'           => $artifacts,
			'exit_code'           => $exit_code,
			'agent_result'        => is_array( $decoded['agentResult'] ?? null ) ? $decoded['agentResult'] : array(),
			'agent_task_result'   => $agent_task_result,
			'completion_outcome'  => $adapters['completion_outcome']( $decoded ),
			'run'                 => $decoded,
		);

		if ( null !== $outcome ) {
			$response['outcome'] = $outcome;
		}

		$response['status']        = $legacy_status;
		$response['statuses']      = array(
			'command'    => WP_Codebox_Status_Taxonomy::command_envelope_status( array( 'status' => $legacy_status, 'success' => $success, 'exit_status' => $exit_code ) ),
			'phase'      => WP_Codebox_Status_Taxonomy::phase_recipe_status( array( 'status' => $legacy_status, 'success' => $success, 'exit_status' => $exit_code ) ),
			'agent_task' => $agent_task_status,
		);
		$response['agent_task_status'] = $agent_task_status;
		$response['diagnostics']   = $adapters['run_diagnostics']( $decoded, $exit_code, $outcome );
		$response['evidence_refs'] = $adapters['evidence_refs']( $response['session'], $decoded );
		$response['run_metadata']  = $adapters['run_metadata']( $session_id, $input, $wp_version, $decoded );

		return $response;
	}

	/**
	 * @param array<string,mixed> $prepared Prepared run.
	 * @param array<string,mixed> $result Command result.
	 * @param array<string,callable> $adapters Focused runner adapters for existing host contracts.
	 * @param array<string,mixed>|null $run Decoded run payload when available.
	 * @return array<string,mixed>
	 */
	private function failed_run_envelope( array $prepared, array $result, array $adapters, string $code, string $message, string $failure_classification, ?array $run = null ): array {
		$input      = is_array( $prepared['input'] ?? null ) ? $prepared['input'] : array();
		$task_input = is_array( $prepared['task_input'] ?? null ) ? $prepared['task_input'] : array();
		$task       = (string) ( $prepared['task'] ?? '' );
		$session_id = (string) ( $prepared['session_id'] ?? '' );
		$paths      = is_array( $prepared['paths'] ?? null ) ? $prepared['paths'] : array();
		$artifacts  = (string) ( $prepared['artifacts'] ?? '' );
		$wp_version = (string) ( $prepared['wp_version'] ?? '' );
		$exit_code  = (int) ( $result['exit_code'] ?? 1 );
		$output     = (string) ( $result['output'] ?? '' );
		$run        = is_array( $run ) ? $run : array();
		$error      = array(
			'code'                   => $code,
			'message'                => $message,
			'failure_classification' => $failure_classification,
			'exit_code'              => $exit_code,
			'output'                 => $adapters['bound_output']( $output ),
		);

		if ( true === ( $result['timed_out'] ?? false ) ) {
			$error['timeout_seconds'] = (int) ( $result['timeout_seconds'] ?? 0 );
		}

		$response = array(
			'success'             => false,
			'schema'              => self::SCHEMA,
			'session'             => $adapters['sandbox_session']( $session_id, 'failed', $input, $run, $artifacts ),
			'task'                => $task,
			'task_input'          => $task_input,
			'wp'                  => $wp_version,
			'paths'               => $paths,
			'artifacts'           => $artifacts,
			'exit_code'           => $exit_code,
			'agent_result'        => is_array( $run['agentResult'] ?? null ) ? $run['agentResult'] : array(),
			'agent_task_result'   => array(
				'schema'                 => 'wp-codebox/agent-task-run-result/v1',
				'success'                => false,
				'status'                 => 'timeout' === $failure_classification ? 'timeout' : 'failed',
				'summary'                => $message,
				'failure_classification' => $failure_classification,
			),
			'completion_outcome'  => $adapters['completion_outcome']( $run ),
			'run'                 => $run,
			'error'               => $error,
			'status'              => 'failed',
			'statuses'            => array(
				'command'    => WP_Codebox_Status_Taxonomy::command_envelope_status( array( 'status' => 'failed', 'success' => false, 'exit_status' => $exit_code, 'timeout' => true === ( $result['timed_out'] ?? false ) ) ),
				'phase'      => WP_Codebox_Status_Taxonomy::phase_recipe_status( array( 'status' => 'failed', 'success' => false, 'exit_status' => $exit_code ) ),
				'agent_task' => 'timeout' === $failure_classification ? 'timeout' : 'failed',
			),
			'agent_task_status'   => 'timeout' === $failure_classification ? 'timeout' : 'failed',
			'diagnostics'         => $adapters['run_diagnostics']( $run, $exit_code, null ),
			'run_metadata'        => $adapters['run_metadata']( $session_id, $input, $wp_version, $run ),
		);
		$response['evidence_refs'] = $adapters['evidence_refs']( $response['session'], $run );

		return $response;
	}
}
