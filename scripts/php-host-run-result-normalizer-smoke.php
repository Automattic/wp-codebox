<?php

declare(strict_types=1);

define( 'ABSPATH', __DIR__ );

require_once dirname( __DIR__ ) . '/packages/wordpress-plugin/src/class-wp-codebox-status-taxonomy.php';
require_once dirname( __DIR__ ) . '/packages/wordpress-plugin/src/class-wp-codebox-host-run-result-normalizer.php';

final class WP_Error {
	private string $code;
	private string $message;
	private mixed $data;

	public function __construct( string $code, string $message, mixed $data = null ) {
		$this->code    = $code;
		$this->message = $message;
		$this->data    = $data;
	}

	public function get_error_code(): string {
		return $this->code;
	}

	public function get_error_message(): string {
		return $this->message;
	}

	public function get_error_data(): mixed {
		return $this->data;
	}
}

function is_wp_error( mixed $value ): bool {
	return $value instanceof WP_Error;
}

function smoke_assert( bool $condition, string $message ): void {
	if ( ! $condition ) {
		fwrite( STDERR, $message . PHP_EOL );
		exit( 1 );
	}
}

function smoke_has_artifact_kind( array $artifacts, string $kind ): bool {
	foreach ( $artifacts as $artifact ) {
		if ( is_array( $artifact ) && $kind === (string) ( $artifact['kind'] ?? '' ) ) {
			return true;
		}
	}

	return false;
}

$normalizer = new WP_Codebox_Host_Run_Result_Normalizer();
$prepared   = array(
	'input'       => array( 'goal' => 'Test task' ),
	'task_input'  => array(
		'goal'         => 'Test task',
		'agent_bundle' => array(
			'engine_data_outputs' => array(
				'concept_packet' => 'ssi/concept-packet/v1',
			),
		),
	),
	'task'        => 'Test task',
	'session_id'  => 'session-1',
	'paths'       => array(),
	'artifacts'   => '/tmp/wp-codebox-artifacts',
	'wp_version'  => 'latest',
	'recipe_file' => '',
);
$adapters   = array(
	'bound_output'               => static fn( string $output ): string => $output,
	'decode_json_output'         => static fn( string $output ): array|WP_Error => json_decode( $output, true ) ?: new WP_Error( 'json_invalid', 'Invalid JSON' ),
	'strict_remediation_outcome' => static fn( array $task_input ): bool => false,
	'remediation_outcome'        => static fn( array $run, int $exit_code, string $output ): array => array( 'success' => 0 === $exit_code ),
	'sandbox_session'            => static fn( string $session_id, string $status, array $input, array $run, string $artifacts ): array => array( 'id' => $session_id, 'status' => $status, 'artifacts' => $artifacts ),
	'completion_outcome'         => static fn( array $run ): array => array(),
	'run_diagnostics'            => static fn( array $run, int $exit_code, ?array $outcome ): array => array(),
	'evidence_refs'              => static fn( array $session, array $run ): array => array(),
	'run_metadata'               => static fn( string $session_id, array $input, string $wp_version, array $run ): array => array( 'session_id' => $session_id, 'wp' => $wp_version ),
);

$timeout = $normalizer->normalize( $prepared, array( 'exit_code' => 124, 'output' => '', 'timed_out' => true, 'timeout_seconds' => 1 ), $adapters );
smoke_assert( is_array( $timeout ) && ! is_wp_error( $timeout ), 'timeout returns result envelope' );
smoke_assert( false === $timeout['success'], 'timeout envelope is unsuccessful' );
smoke_assert( 'timeout' === $timeout['agent_task_status'], 'timeout maps to agent task timeout' );
smoke_assert( 'wp-codebox/agent-task-run-result/v1' === $timeout['agent_task_run_result']['schema'], 'timeout includes canonical agent task run result schema' );
smoke_assert( 'wp-codebox/artifact-result-envelope/v1' === $timeout['artifact_result']['schema'], 'timeout includes public artifact result envelope' );
smoke_assert( 'failed' === $timeout['artifact_result']['status'], 'timeout artifact result is failed' );
smoke_assert( false === $timeout['agent_task_run_result']['success'], 'timeout canonical result is unsuccessful' );
smoke_assert( 'timeout' === $timeout['agent_task_run_result']['status'], 'timeout canonical result status is timeout' );
smoke_assert( 'wp_codebox_run_timeout' === $timeout['error']['code'], 'timeout error code is preserved' );

$prepared_without_artifacts = array_merge( $prepared, array( 'artifacts' => '' ) );
$invalid_json = $normalizer->normalize( $prepared_without_artifacts, array( 'exit_code' => 0, 'output' => 'not-json' ), $adapters );
smoke_assert( is_array( $invalid_json ) && ! is_wp_error( $invalid_json ), 'invalid JSON returns result envelope' );
smoke_assert( 'wp_codebox_json_invalid' === $invalid_json['error']['code'], 'invalid JSON error code is preserved' );
smoke_assert( 'invalid_json' === $invalid_json['error']['failure_classification'], 'invalid JSON classification is preserved' );
smoke_assert( 'wp-codebox/agent-task-run-result/v1' === $invalid_json['agent_task_run_result']['schema'], 'invalid JSON includes canonical result schema' );
smoke_assert( 'wp-codebox/artifact-result-envelope/v1' === $invalid_json['outputs']['artifact_result']['schema'], 'invalid JSON exposes public artifact result through outputs' );
smoke_assert( array() === $invalid_json['agent_task_run_result']['refs']['artifact_bundles'], 'failure before artifacts has no artifact bundle refs' );

$non_zero = $normalizer->normalize( $prepared, array( 'exit_code' => 2, 'output' => '{"agentResult":{}}' ), $adapters );
smoke_assert( is_array( $non_zero ) && ! is_wp_error( $non_zero ), 'non-zero exit returns result envelope' );
smoke_assert( 'wp_codebox_run_failed' === $non_zero['error']['code'], 'non-zero error code is preserved' );
smoke_assert( 'non_zero_exit' === $non_zero['error']['failure_classification'], 'non-zero classification is preserved' );

$success = $normalizer->normalize(
	$prepared,
	array(
		'exit_code' => 0,
		'output'    => '{"agentResult":{"artifacts":{"directory":"/tmp/wp-codebox-artifacts"},"summary":"Changed one file","changedFiles":{"artifact":"files/changed-files.json","count":1},"patch":{"artifact":"files/patch.diff","bytes":10},"transcript":{"artifact":"files/transcript.json"}},"agentTaskResult":{"raw":{"agent_runtime":{"success":true,"result":{"output":{"concept_packet":{"title":"Stabilized public envelope"}}}}}},"evidence_refs":[{"id":"evidence-1","path":"/tmp/wp-codebox-artifacts/evidence.json"}],"runtime":{"id":"runtime-1","status":"destroyed"}}',
	),
	$adapters
);
smoke_assert( is_array( $success ) && ! is_wp_error( $success ), 'success returns result envelope' );
smoke_assert( 'wp-codebox/agent-task-run-result/v1' === $success['agent_task_run_result']['schema'], 'success includes canonical agent task run result schema' );
smoke_assert( 'succeeded' === $success['agent_task_run_result']['status'], 'success canonical result status is succeeded' );
smoke_assert( true === $success['agent_task_run_result']['success'], 'success canonical result is successful' );
smoke_assert( 1 === $success['agent_task_run_result']['metadata']['changed_files_count'], 'success canonical result includes changed file count' );
smoke_assert( 'codebox-patch' === $success['agent_task_run_result']['refs']['patches'][0]['kind'], 'success canonical result includes patch ref' );
smoke_assert( 'codebox-evidence-bundle' === $success['agent_task_run_result']['refs']['evidence_bundles'][0]['kind'], 'success canonical result includes evidence bundle ref' );
smoke_assert( 'wp-codebox/artifact-result-envelope/v1' === $success['artifact_result']['schema'], 'success includes public artifact result envelope' );
smoke_assert( 'created' === $success['artifact_result']['status'], 'success artifact result status is created' );
smoke_assert( $success['artifact_result'] === $success['outputs']['artifact_result'], 'public artifact result is exposed as the primary output envelope' );
smoke_assert( smoke_has_artifact_kind( $success['artifact_result']['artifactRefs'], 'codebox-patch' ), 'artifact result includes patch artifact refs' );
smoke_assert( 'concept_packet' === $success['artifact_result']['result']['typed_artifacts'][0]['name'], 'artifact result includes concept packet typed artifact' );
smoke_assert( 'ssi/concept-packet/v1' === $success['artifact_result']['result']['typed_artifacts'][0]['artifact_schema'], 'typed artifact preserves declared concept packet schema' );
smoke_assert( 'Stabilized public envelope' === $success['artifact_result']['result']['typed_artifacts'][0]['payload']['title'], 'typed artifact preserves runtime output payload' );
smoke_assert( ! isset( $success['artifact_result']['metadata']['agent_runtime'] ), 'artifact result metadata does not expose private agent runtime internals' );

$datamachine_success = $normalizer->normalize(
	$prepared,
	array(
		'exit_code' => 0,
		'output'    => json_encode(
			array(
				'agentResult'     => array(
					'artifacts' => array( 'directory' => '/tmp/wp-codebox-artifacts' ),
					'summary'   => 'Runtime package completed',
				),
				'agentTaskResult' => array(
					'status'  => 'completed',
					'outputs' => array(
						'result' => array(
							'engine_data' => array(
								'outputs' => array(
									'typed_artifacts' => array(
										'concept_packet' => array(
											'output_key' => 'concept_packet',
											'schema'     => 'wp-site-generator/ConceptPacket/v1',
											'artifact'   => 'ConceptPacket',
											'payload'    => array( 'title' => 'Kiln Shelf Supply' ),
										),
									),
								),
							),
						),
					),
				),
			)
		),
	),
	$adapters
);
smoke_assert( is_array( $datamachine_success ) && ! is_wp_error( $datamachine_success ), 'Data Machine runtime package success returns result envelope' );
smoke_assert( 'concept_packet' === $datamachine_success['artifact_result']['result']['typed_artifacts'][0]['name'], 'Data Machine engine typed artifact is exposed by name' );
smoke_assert( 'wp-site-generator/ConceptPacket/v1' === $datamachine_success['artifact_result']['result']['typed_artifacts'][0]['artifact_schema'], 'Data Machine engine typed artifact schema is exposed' );
smoke_assert( 'Kiln Shelf Supply' === $datamachine_success['artifact_result']['result']['typed_artifacts'][0]['payload']['title'], 'Data Machine engine typed artifact payload is exposed' );

echo "host run result normalizer smoke passed\n";
