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
			return new WP_Error(
				'wp_codebox_run_timeout',
				'WP Codebox agent sandbox run timed out.',
				array(
					'status'          => 500,
					'exit_code'       => $exit_code,
					'timeout_seconds' => (int) ( $result['timeout_seconds'] ?? 0 ),
					'output'          => $adapters['bound_output']( $output ),
				)
			);
		}

		$decoded = $adapters['decode_json_output']( $output );
		if ( is_wp_error( $decoded ) ) {
			return new WP_Error(
				'wp_codebox_json_invalid',
				'WP Codebox did not return valid JSON: ' . $decoded->get_error_message(),
				array(
					'status'    => 500,
					'exit_code' => $exit_code,
					'output'    => $adapters['bound_output']( $output ),
				)
			);
		}

		$strict_remediation_outcome = (bool) $adapters['strict_remediation_outcome']( $task_input );
		$outcome                    = $strict_remediation_outcome ? $adapters['remediation_outcome']( $decoded, $exit_code, $output ) : null;

		if ( 0 !== $exit_code && ! $strict_remediation_outcome ) {
			return new WP_Error(
				'wp_codebox_run_failed',
				'WP Codebox agent sandbox run failed.',
				array(
					'status'    => 500,
					'exit_code' => $exit_code,
					'output'    => $adapters['bound_output']( $output ),
					'run'       => $decoded,
				)
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
}
