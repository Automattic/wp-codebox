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
	private const ARTIFACT_RESULT_SCHEMA = 'wp-codebox/artifact-result-envelope/v1';

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
		$response['artifact_result'] = $this->artifact_result_envelope( $response );
		$response['outputs'] = array( 'artifact_result' => $response['artifact_result'] );

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
		$response['artifact_result'] = $this->artifact_result_envelope( $response );
		$response['outputs'] = array( 'artifact_result' => $response['artifact_result'] );

		return $response;
	}

	/** @param array<string,mixed> $response Agent task run response. @return array<string,mixed> */
	private function artifact_result_envelope( array $response ): array {
		$run_result        = is_array( $response['agent_task_run_result'] ?? null ) ? $response['agent_task_run_result'] : array();
		$refs              = is_array( $run_result['refs'] ?? null ) ? $run_result['refs'] : array();
		$artifact_bundles  = is_array( $refs['artifact_bundles'] ?? null ) ? array_values( array_filter( $refs['artifact_bundles'], 'is_array' ) ) : array();
		$artifacts         = is_array( $run_result['artifacts'] ?? null ) ? array_values( array_filter( $run_result['artifacts'], 'is_array' ) ) : array();
		$evidence_refs     = is_array( $response['evidence_refs'] ?? null ) ? array_values( array_filter( $response['evidence_refs'], 'is_array' ) ) : array();
		$diagnostics       = is_array( $response['diagnostics'] ?? null ) ? array_values( array_filter( $response['diagnostics'], 'is_array' ) ) : array();
		$agent_result      = is_array( $response['agent_result'] ?? null ) ? $response['agent_result'] : array();
		$agent_task_result = is_array( $response['agent_task_result'] ?? null ) ? $response['agent_task_result'] : array();
		$success           = true === ( $run_result['success'] ?? false );

		$envelope = array(
			'schema'       => self::ARTIFACT_RESULT_SCHEMA,
			'operation'    => 'agent-task-run',
			'status'       => $success ? 'created' : 'failed',
			'success'      => $success,
			'artifactRefs' => $this->dedupe_records( array_merge( $artifact_bundles, $artifacts ) ),
			'evidenceRefs' => $evidence_refs,
			'result'       => array_filter(
				array(
					'structured_artifacts' => $this->structured_artifacts( $agent_task_result ),
					'typed_artifacts'      => $this->typed_artifacts( $agent_task_result, is_array( $response['task_input'] ?? null ) ? $response['task_input'] : array() ),
					'agent_reply'          => $this->agent_reply( $agent_result, $run_result ),
					'transcript_refs'      => is_array( $refs['transcripts'] ?? null ) ? $refs['transcripts'] : array(),
					'evidence_refs'        => $evidence_refs,
					'session'              => is_array( $response['session'] ?? null ) ? $response['session'] : array(),
				),
				static fn( mixed $value ): bool => array() !== $value && null !== $value
			),
			'diagnostics' => array_map( array( $this, 'artifact_result_diagnostic' ), $diagnostics ),
			'metadata'    => $this->artifact_result_metadata( $response, $run_result ),
		);

		if ( isset( $artifact_bundles[0] ) ) {
			$envelope['artifactBundle'] = $artifact_bundles[0];
		}
		if ( ! $success ) {
			$error = is_array( $response['error'] ?? null ) ? $response['error'] : array();
			$envelope['error'] = array_filter(
				array(
					'name'    => 'WP_Codebox_Agent_Task_Run_Error',
					'message' => (string) ( $error['message'] ?? $run_result['summary'] ?? 'WP Codebox agent task failed.' ),
					'code'    => (string) ( $error['code'] ?? '' ),
				),
				static fn( mixed $value ): bool => '' !== $value
			);
		}

		return $envelope;
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
				'evidence_bundles' => $this->artifact_refs_by_kind( $artifacts, array( 'evidence-bundle', 'codebox-evidence-bundle' ) ),
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
		foreach ( is_array( $response['artifacts'] ?? null ) ? $response['artifacts'] : array() as $artifact ) {
			if ( is_array( $artifact ) ) {
				$this->append_artifact_ref( $artifacts, $artifact );
			}
		}
		foreach ( is_array( $response['evidence_refs'] ?? null ) ? $response['evidence_refs'] : array() as $evidence_ref ) {
			if ( is_array( $evidence_ref ) ) {
				$this->append_artifact_ref( $artifacts, array_merge( array( 'kind' => 'codebox-evidence-bundle' ), $evidence_ref ) );
			}
		}
		foreach ( is_array( $run['evidence_refs'] ?? null ) ? $run['evidence_refs'] : array() as $evidence_ref ) {
			if ( is_array( $evidence_ref ) ) {
				$this->append_artifact_ref( $artifacts, array_merge( array( 'kind' => 'codebox-evidence-bundle' ), $evidence_ref ) );
			}
		}
		$root      = (string) ( $agent_result['artifacts']['directory'] ?? ( is_string( $response['artifacts'] ?? null ) ? $response['artifacts'] : '' ) );
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

	/** @param array<string,mixed> $agent_task_result @return array<int,array<string,mixed>> */
	private function structured_artifacts( array $agent_task_result ): array {
		$direct  = is_array( $agent_task_result['structured_artifacts'] ?? null ) ? $agent_task_result['structured_artifacts'] : array();
		$outputs = is_array( $agent_task_result['outputs'] ?? null ) ? $agent_task_result['outputs'] : array();
		$nested  = is_array( $outputs['structured_artifacts'] ?? null ) ? $outputs['structured_artifacts'] : array();

		return $this->dedupe_records( array_values( array_filter( array_merge( $direct, $nested ), 'is_array' ) ) );
	}

	/** @param array<string,mixed> $agent_task_result @param array<string,mixed> $task_input @return array<int,array<string,mixed>> */
	private function typed_artifacts( array $agent_task_result, array $task_input ): array {
		$outputs        = is_array( $agent_task_result['outputs'] ?? null ) ? $agent_task_result['outputs'] : array();
		$direct         = is_array( $agent_task_result['typed_artifacts'] ?? null ) ? $agent_task_result['typed_artifacts'] : array();
		$from_outputs   = is_array( $outputs['typed_artifacts'] ?? null ) ? $outputs['typed_artifacts'] : array();
		$runtime_outputs = $this->runtime_outputs( $agent_task_result );
		$engine_outputs = is_array( $task_input['agent_bundle']['engine_data_outputs'] ?? null ) ? $task_input['agent_bundle']['engine_data_outputs'] : array();
		$typed          = array_values( array_filter( array_merge( $direct, $from_outputs ), 'is_array' ) );

		foreach ( $runtime_outputs as $name => $payload ) {
			if ( 'typed_artifacts' === $name || 'structured_artifacts' === $name ) {
				continue;
			}
			if ( ! is_array( $payload ) ) {
				continue;
			}
			$typed[] = array_filter(
				array(
					'name'            => (string) $name,
					'artifact_schema' => is_string( $engine_outputs[ $name ] ?? null ) ? (string) $engine_outputs[ $name ] : '',
					'payload'         => $payload,
				),
				static fn( mixed $value ): bool => '' !== $value
			);
		}

		return $this->dedupe_records( $typed );
	}

	/** @param array<string,mixed> $agent_task_result @return array<string,mixed> */
	private function runtime_outputs( array $agent_task_result ): array {
		$raw           = is_array( $agent_task_result['raw'] ?? null ) ? $agent_task_result['raw'] : array();
		$agent_runtime = is_array( $raw['agent_runtime'] ?? null ) ? $raw['agent_runtime'] : array();
		$result        = is_array( $agent_runtime['result'] ?? null ) ? $agent_runtime['result'] : array();
		$outputs       = is_array( $result['outputs'] ?? null ) ? $result['outputs'] : ( is_array( $result['output'] ?? null ) ? $result['output'] : array() );

		return $outputs;
	}

	/** @param array<string,mixed> $agent_result @param array<string,mixed> $run_result @return array<string,mixed> */
	private function agent_reply( array $agent_result, array $run_result ): array {
		return array_filter(
			array(
				'text'    => (string) ( $agent_result['reply'] ?? $agent_result['message'] ?? $agent_result['response'] ?? '' ),
				'summary' => (string) ( $agent_result['summary'] ?? $run_result['summary'] ?? '' ),
				'status'  => (string) ( $run_result['status'] ?? '' ),
			),
			static fn( mixed $value ): bool => '' !== $value
		);
	}

	/** @param array<string,mixed> $diagnostic @return array<string,mixed> */
	private function artifact_result_diagnostic( array $diagnostic ): array {
		return array_filter(
			array(
				'code'     => (string) ( $diagnostic['code'] ?? $diagnostic['class'] ?? $diagnostic['kind'] ?? 'wp-codebox.agent_task_diagnostic' ),
				'message'  => (string) ( $diagnostic['message'] ?? 'WP Codebox agent task diagnostic.' ),
				'severity' => in_array( $diagnostic['severity'] ?? '', array( 'info', 'warning', 'error' ), true ) ? (string) $diagnostic['severity'] : '',
				'phase'    => (string) ( $diagnostic['phase'] ?? '' ),
				'metadata' => is_array( $diagnostic['data'] ?? null ) ? $diagnostic['data'] : ( is_array( $diagnostic['metadata'] ?? null ) ? $diagnostic['metadata'] : array() ),
			),
			static fn( mixed $value ): bool => '' !== $value && array() !== $value
		);
	}

	/** @param array<string,mixed> $response @param array<string,mixed> $run_result @return array<string,mixed> */
	private function artifact_result_metadata( array $response, array $run_result ): array {
		$metadata = is_array( $run_result['metadata'] ?? null ) ? $run_result['metadata'] : array();

		return array_filter(
			array(
				'status'       => (string) ( $run_result['status'] ?? '' ),
				'success'      => true === ( $run_result['success'] ?? false ),
				'run_id'       => (string) ( $metadata['run_id'] ?? '' ),
				'run_status'   => (string) ( $metadata['run_status'] ?? '' ),
				'runtime_id'   => (string) ( $metadata['runtime_id'] ?? '' ),
				'runtime_status' => (string) ( $metadata['runtime_status'] ?? '' ),
				'parent_request_schema' => (string) ( $response['run_metadata']['parent_request_schema'] ?? '' ),
			),
			static fn( mixed $value ): bool => '' !== $value && null !== $value
		);
	}

	/** @param array<int,array<string,mixed>> $records @return array<int,array<string,mixed>> */
	private function dedupe_records( array $records ): array {
		$seen = array();
		$out  = array();
		foreach ( $records as $record ) {
			if ( ! is_array( $record ) || empty( $record ) ) {
				continue;
			}
			$key = function_exists( 'wp_json_encode' ) ? wp_json_encode( $record ) : json_encode( $record );
			if ( isset( $seen[ (string) $key ] ) ) {
				continue;
			}
			$seen[ (string) $key ] = true;
			$out[] = $record;
		}

		return $out;
	}
}
