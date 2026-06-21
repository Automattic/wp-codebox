<?php
/**
 * Host-side normalization for sandbox recipe-run command results.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_Host_Run_Result_Normalizer {

	private const SCHEMA = 'wp-codebox/agent-task-run/v1';
	private const RUN_RESULT_SCHEMA = 'wp-codebox/agent-task-run-result/v1';

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
		$response['agent_task_run_result'] = $this->agent_task_run_result( $response, $exit_code );

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
			'agent_task_result'   => is_array( $run['agentTaskResult'] ?? null ) ? $run['agentTaskResult'] : array(),
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
		$response['agent_task_run_result'] = $this->agent_task_run_result( $response, $exit_code, $message, $failure_classification );

		return $response;
	}

	/**
	 * @param array<string,mixed> $response Agent task run response.
	 * @return array<string,mixed>
	 */
	private function agent_task_run_result( array $response, int $exit_code, string $summary = '', string $failure_classification = '' ): array {
		$agent_result      = is_array( $response['agent_result'] ?? null ) ? $response['agent_result'] : array();
		$agent_task_result = is_array( $response['agent_task_result'] ?? null ) ? $response['agent_task_result'] : array();
		$run               = is_array( $response['run'] ?? null ) ? $response['run'] : array();
		$run_metadata      = is_array( $response['run_metadata'] ?? null ) ? $response['run_metadata'] : array();
		$diagnostics       = is_array( $response['diagnostics'] ?? null ) ? $response['diagnostics'] : array();
		$status            = (string) ( $response['agent_task_status'] ?? '' );
		if ( '' === $status ) {
			$status = WP_Codebox_Status_Taxonomy::agent_task_status(
				array(
					'status'      => $response['status'] ?? '',
					'success'     => $response['success'] ?? false,
					'exit_status' => $exit_code,
				)
			);
		}

		$changed_files = is_array( $agent_result['changedFiles'] ?? null ) ? $agent_result['changedFiles'] : array();
		$patch         = is_array( $agent_result['patch'] ?? null ) ? $agent_result['patch'] : array();
		$no_op_reason  = (string) ( $agent_result['noOpReason'] ?? ( $response['no_op_reason'] ?? '' ) );
		$changed_count = isset( $changed_files['count'] ) ? (int) $changed_files['count'] : null;
		$patch_bytes   = isset( $patch['bytes'] ) ? (int) $patch['bytes'] : null;
		$no_op         = array(
			'detected' => 'no_op' === $status || ( true === ( $response['success'] ?? false ) && '' !== $no_op_reason && 0 === $changed_count && 0 === $patch_bytes ),
		);
		if ( '' !== $no_op_reason ) {
			$no_op['reason'] = $no_op_reason;
		}
		if ( null !== $changed_count ) {
			$no_op['changed_files_count'] = $changed_count;
		}
		if ( null !== $patch_bytes ) {
			$no_op['patch_bytes'] = $patch_bytes;
		}

		$artifacts = $this->agent_task_run_artifacts( $response, $agent_result, $run );
		$result    = array(
			'schema'      => self::RUN_RESULT_SCHEMA,
			'status'      => $status,
			'success'     => in_array( $status, array( 'succeeded', 'no_op' ), true ),
			'summary'     => '' !== $summary ? $summary : (string) ( $response['summary'] ?? $agent_result['summary'] ?? ( in_array( $status, array( 'succeeded', 'no_op' ), true ) ? 'WP Codebox agent task succeeded.' : 'WP Codebox agent task failed.' ) ),
			'artifacts'   => $artifacts,
			'refs'        => array(
				'artifact_bundles' => $this->artifact_refs_by_kind( $artifacts, array( 'artifact-bundle', 'codebox-artifact-bundle' ) ),
				'changed_files'    => $this->artifact_refs_by_kind( $artifacts, array( 'codebox-changed-files' ) ),
				'patches'          => $this->artifact_refs_by_kind( $artifacts, array( 'codebox-patch' ) ),
				'transcripts'      => $this->artifact_refs_by_kind( $artifacts, array( 'codebox-transcript' ) ),
				'logs'             => $this->artifact_refs_by_kind( $artifacts, array( 'codebox-runtime-log', 'codebox-command-log' ) ),
				'runtimes'         => $this->artifact_refs_by_kind( $artifacts, array( 'codebox-runtime' ) ),
			),
			'diagnostics' => array_values( array_filter( $diagnostics, 'is_array' ) ),
			'metadata'    => array_filter(
				array(
					'run_id'              => $run_metadata['run_id'] ?? $run_metadata['session_id'] ?? null,
					'run_status'          => $run_metadata['run_status'] ?? null,
					'runtime_id'          => $run_metadata['runtime_id'] ?? null,
					'runtime_status'      => $run_metadata['runtime_status'] ?? null,
					'changed_files_count' => $changed_count,
					'patch_bytes'         => $patch_bytes,
					'patch_sha256'        => $patch['sha256'] ?? null,
					'no_op_reason'        => '' !== $no_op_reason ? $no_op_reason : null,
				),
				static fn( mixed $value ): bool => null !== $value && '' !== $value
			),
			'no_op'       => $no_op,
		);

		if ( is_array( $response['terminal_result'] ?? null ) ) {
			$result['terminal_result'] = $response['terminal_result'];
		}
		if ( '' !== $failure_classification ) {
			$result['failure_classification'] = $failure_classification;
		} elseif ( ! in_array( $status, array( 'succeeded', 'no_op' ), true ) ) {
			$result['failure_classification'] = 'timeout' === $status ? 'timeout' : 'runtime';
		}
		if ( is_array( $agent_task_result ) && isset( $agent_task_result['schema'] ) ) {
			$result['metadata']['agent_task_result_schema'] = (string) $agent_task_result['schema'];
		}

		return $result;
	}

	/** @param array<int,array<string,mixed>> $artifacts @param string[] $kinds @return array<int,array<string,mixed>> */
	private function artifact_refs_by_kind( array $artifacts, array $kinds ): array {
		return array_values( array_filter( $artifacts, static fn( array $artifact ): bool => in_array( (string) ( $artifact['kind'] ?? '' ), $kinds, true ) ) );
	}

	/** @param array<string,mixed> $response @param array<string,mixed> $agent_result @param array<string,mixed> $run @return array<int,array<string,mixed>> */
	private function agent_task_run_artifacts( array $response, array $agent_result, array $run ): array {
		$artifacts = array();
		$root      = (string) ( $agent_result['artifacts']['directory'] ?? $response['artifacts'] ?? '' );
		$this->append_artifact_ref( $artifacts, array( 'id' => basename( $root ), 'kind' => 'codebox-artifact-bundle', 'path' => $root ) );
		$this->append_agent_artifact_ref( $artifacts, 'codebox-changed-files', $root, is_array( $agent_result['changedFiles'] ?? null ) ? $agent_result['changedFiles'] : array() );
		$this->append_agent_artifact_ref( $artifacts, 'codebox-patch', $root, is_array( $agent_result['patch'] ?? null ) ? $agent_result['patch'] : array() );
		$this->append_agent_artifact_ref( $artifacts, 'codebox-transcript', $root, is_array( $agent_result['transcript'] ?? null ) ? $agent_result['transcript'] : array() );

		if ( is_array( $run['artifacts'] ?? null ) ) {
			$this->append_artifact_ref( $artifacts, array( 'id' => 'codebox-runtime-log', 'kind' => 'codebox-runtime-log', 'path' => (string) ( $run['artifacts']['runtimeLogPath'] ?? '' ) ) );
			$this->append_artifact_ref( $artifacts, array( 'id' => 'codebox-command-log', 'kind' => 'codebox-command-log', 'path' => (string) ( $run['artifacts']['commandsLogPath'] ?? '' ) ) );
		}

		$runtime = is_array( $run['runtime'] ?? null ) ? $run['runtime'] : array();
		$this->append_artifact_ref( $artifacts, array( 'id' => (string) ( $runtime['id'] ?? '' ), 'kind' => 'codebox-runtime', 'metadata' => array( 'status' => (string) ( $runtime['status'] ?? '' ) ) ) );

		return $artifacts;
	}

	/** @param array<int,array<string,mixed>> $artifacts @param array<string,mixed> $metadata */
	private function append_agent_artifact_ref( array &$artifacts, string $kind, string $root, array $metadata ): void {
		$artifact = (string) ( $metadata['artifact'] ?? '' );
		$path     = '' !== $root && '' !== $artifact ? rtrim( $root, '/\\' ) . '/' . ltrim( $artifact, '/\\' ) : '';
		$this->append_artifact_ref(
			$artifacts,
			array(
				'id'         => $kind,
				'kind'       => $kind,
				'path'       => $path,
				'sha256'     => (string) ( $metadata['sha256'] ?? '' ),
				'size_bytes' => isset( $metadata['bytes'] ) ? (int) $metadata['bytes'] : null,
				'metadata'   => $metadata,
			)
		);
	}

	/** @param array<int,array<string,mixed>> $artifacts @param array<string,mixed> $artifact */
	private function append_artifact_ref( array &$artifacts, array $artifact ): void {
		$artifact = array_filter( $artifact, static fn( mixed $value ): bool => null !== $value && '' !== $value && array() !== $value );
		if ( empty( $artifact['kind'] ) ) {
			return;
		}
		$key = (string) ( $artifact['path'] ?? $artifact['url'] ?? $artifact['id'] ?? '' );
		if ( '' === $key ) {
			return;
		}
		foreach ( $artifacts as $existing ) {
			if ( $key === (string) ( $existing['path'] ?? $existing['url'] ?? $existing['id'] ?? '' ) ) {
				return;
			}
		}
		$artifacts[] = $artifact;
	}
}
