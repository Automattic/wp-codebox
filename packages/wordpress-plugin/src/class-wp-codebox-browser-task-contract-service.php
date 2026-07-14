<?php
/**
 * Browser task/materializer contract service.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_Browser_Task_Contract_Service {

	/** @var callable(string,array<int,mixed>):mixed */
	private $helper;

	/** @param callable(string,array<int,mixed>):mixed $helper Existing abilities helper bridge. */
	public function __construct( callable $helper ) {
		$this->helper = $helper;
	}

	/** @param array<int,mixed> $args Helper arguments. @return mixed */
	public function __call( string $name, array $args ): mixed {
		return ( $this->helper )( $name, $args );
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public function create_browser_materializer_contract( array $input ): array|WP_Error {
		$return_raw = $this->include_raw_browser_contract( $input, 'materializer' );
		$input['preview_only'] = false;
		$input['include_internal_browser_session'] = true;
		$session = $this->create_browser_playground_session( $input );
		if ( is_wp_error( $session ) ) {
			return $session;
		}

		if ( true !== ( $session['success'] ?? false ) ) {
			$session_envelope = is_array( $session['session'] ?? null ) ? $session['session'] : array();
			$contract         = array_filter(
				array(
					'success'          => false,
					'schema'           => 'wp-codebox/browser-materializer-contract/v1',
					'execution'        => 'browser-playground',
					'execution_scope'  => 'disposable-playground',
					'permission_model' => 'runtime-principal',
					'status'           => (string) ( $session['status'] ?? 'blocked' ),
					'error'            => is_array( $session['error'] ?? null ) ? $session['error'] : array(),
					'session_id'       => (string) ( $session_envelope['id'] ?? '' ),
					'contained_site'   => is_array( $session['contained_site'] ?? null ) ? $session['contained_site'] : array(),
					'authorization'    => is_array( $session_envelope['authorization'] ?? null ) ? $session_envelope['authorization'] : $this->browser_session_authorization( $input ),
					'signals'          => is_array( $session['signals'] ?? null ) ? $session['signals'] : array(),
				),
				static fn( mixed $value ): bool => array() !== $value && '' !== $value
			);
			$contract['compact'] = $this->compact_browser_materializer_contract_dto( $contract );

			return $return_raw ? $contract : $contract['compact'];
		}

		$session_envelope = is_array( $session['session'] ?? null ) ? $session['session'] : array();

		$contract = array(
			'success'          => true,
			'schema'           => 'wp-codebox/browser-materializer-contract/v1',
			'execution'        => 'browser-playground',
			'execution_scope'  => 'disposable-playground',
			'permission_model' => 'runtime-principal',
			'session_id'       => (string) ( $session_envelope['id'] ?? '' ),
			'contained_site'   => is_array( $session['contained_site'] ?? null ) ? $session['contained_site'] : array(),
			'authorization'    => is_array( $session_envelope['authorization'] ?? null ) ? $session_envelope['authorization'] : $this->browser_session_authorization( $input ),
			'task_input'       => is_array( $session['task_input'] ?? null ) ? $session['task_input'] : array(),
			'task_payload'     => is_array( $session['task_payload'] ?? null ) ? $session['task_payload'] : array(),
			'materialization'  => is_array( $session['materialization'] ?? null ) ? $session['materialization'] : array(),
			'recipe'           => is_array( $session['recipe'] ?? null ) ? $session['recipe'] : array(),
			'playground'       => is_array( $session['playground'] ?? null ) ? $session['playground'] : array(),
			'runtime'          => is_array( $session['runtime'] ?? null ) ? $session['runtime'] : array(),
			'artifacts'        => is_array( $session['artifacts'] ?? null ) ? $session['artifacts'] : array(),
			'provenance'       => array(
				'generated_by' => 'wp-codebox/browser-materializer-contract',
				'source'       => 'wp-codebox/create-browser-playground-session',
			),
		);
		$contract['compact'] = $this->compact_browser_materializer_contract_dto( $contract );

		return $return_raw ? $contract : $contract['compact'];
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public function create_browser_task_contract( array $input ): array|WP_Error {
		$return_raw = $this->include_raw_browser_contract( $input, 'task' );
		$contract = $this->prepare_browser_task_contract( $input );
		if ( is_wp_error( $contract ) ) {
			return $contract;
		}
		if ( true === ( $input['execute_phases'] ?? false ) ) {
			$contract = $this->execute_browser_task_phases( $contract );
			if ( is_wp_error( $contract ) ) {
				return $contract;
			}
		}

		return $return_raw ? $contract : ( is_array( $contract['compact'] ?? null ) ? $contract['compact'] : $this->compact_browser_task_contract_dto( $contract ) );
	}

	/** @param array<string,mixed> $input Ability input. */
	private function include_raw_browser_contract( array $input, string $contract ): bool {
		$include = true === ( $input['include_internal_browser_contract'] ?? false );
		if ( function_exists( 'apply_filters' ) ) {
			$include = (bool) apply_filters( 'wp_codebox_include_internal_browser_contract', $include, $input, $contract );
		}

		return $include;
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	private function prepare_browser_task_contract( array $input ): array|WP_Error {
		$input['preview_only'] = false;
		$input['include_internal_browser_session'] = true;
		$primary = $this->create_browser_playground_session( $input );
		if ( is_wp_error( $primary ) ) {
			return $primary;
		}

		$session_envelope = is_array( $primary['session'] ?? null ) ? $primary['session'] : array();
		if ( true !== ( $primary['success'] ?? false ) ) {
			$contract = array_filter(
				array(
					'success'          => false,
					'schema'           => 'wp-codebox/browser-task-contract/v1',
					'execution'        => 'browser-playground',
					'execution_scope'  => 'disposable-playground',
					'permission_model' => 'runtime-principal',
					'status'           => (string) ( $primary['status'] ?? 'blocked' ),
					'error'            => is_array( $primary['error'] ?? null ) ? $primary['error'] : array(),
					'session'          => $session_envelope,
					'authorization'    => is_array( $session_envelope['authorization'] ?? null ) ? $session_envelope['authorization'] : $this->browser_session_authorization( $input ),
					'task_input'       => is_array( $primary['task_input'] ?? null ) ? $primary['task_input'] : array(),
					'contained_site'   => is_array( $primary['contained_site'] ?? null ) ? $primary['contained_site'] : array(),
					'primary'          => $primary,
					'phases'           => array(),
					'execution_metrics' => $this->browser_contract_execution_metrics( $primary, array() ),
				),
				static fn( mixed $value ): bool => array() !== $value && '' !== $value
			);
			$contract['compact'] = $this->compact_browser_task_contract_dto( $contract );

			return $contract;
		}

		$phases = $this->prepare_browser_task_contract_phases( $input, $session_envelope );
		if ( is_wp_error( $phases ) ) {
			return $phases;
		}

		$contract = array(
			'success'          => true,
			'schema'           => 'wp-codebox/browser-task-contract/v1',
			'execution'        => 'browser-playground',
			'execution_scope'  => 'disposable-playground',
			'permission_model' => 'runtime-principal',
			'session'          => $session_envelope,
			'authorization'    => is_array( $session_envelope['authorization'] ?? null ) ? $session_envelope['authorization'] : $this->browser_session_authorization( $input ),
			'task_input'       => is_array( $primary['task_input'] ?? null ) ? $primary['task_input'] : array(),
			'contained_site'   => is_array( $primary['contained_site'] ?? null ) ? $primary['contained_site'] : array(),
			'primary'          => $primary,
			'phases'           => $phases,
			'execution_metrics' => $this->browser_contract_execution_metrics( $primary, $phases ),
			'provenance'       => array(
				'generated_by' => 'wp-codebox/browser-task-contract',
				'source'       => 'wp-codebox/create-browser-playground-session',
			),
		);
		$contract['compact'] = $this->compact_browser_task_contract_dto( $contract );

		return $contract;
	}

	/** @param array<string,mixed> $contract Browser task contract. @return array<string,mixed>|WP_Error */
	private function execute_browser_task_phases( array $contract ): array|WP_Error {
		$session_envelope = is_array( $contract['session'] ?? null ) ? $contract['session'] : array();
		$phases           = array();

		foreach ( is_array( $contract['phases'] ?? null ) ? $contract['phases'] : array() as $phase ) {
			if ( ! is_array( $phase ) ) {
				continue;
			}

			$executed_phase = $this->execute_browser_task_phase( $phase, $session_envelope );
			if ( is_wp_error( $executed_phase ) ) {
				return $executed_phase;
			}

			$phases[] = $executed_phase;
		}

		$contract['phases']            = $phases;
		$contract['execution_metrics'] = $this->browser_contract_execution_metrics( is_array( $contract['primary'] ?? null ) ? $contract['primary'] : array(), $phases );
		$contract['compact']           = $this->compact_browser_task_contract_dto( $contract );

		return $contract;
	}

	/** @param array<string,mixed> $phase Browser task phase. @param array<string,mixed> $session_envelope Primary browser session envelope. @return array<string,mixed>|WP_Error */
	private function execute_browser_task_phase( array $phase, array $session_envelope ): array|WP_Error {
		$fanout_request = $this->browser_task_phase_fanout_request( $phase );
		if ( is_array( $fanout_request ) ) {
			if ( empty( $fanout_request['sandbox_session_id'] ) && '' !== (string) ( $session_envelope['id'] ?? '' ) ) {
				$fanout_request['sandbox_session_id'] = (string) $session_envelope['id'];
			}

			$result = $this->run_agent_task_fanout( $fanout_request );
			if ( is_wp_error( $result ) ) {
				return $result;
			}

			$phase['status'] = true === ( $result['success'] ?? false ) ? 'completed' : 'failed';
			$phase['result'] = $result;

			return array_filter( $phase, static fn( mixed $value ): bool => array() !== $value && '' !== $value );
		}

		$host_delegation_request = $this->browser_task_phase_host_delegation_request( $phase );
		if ( is_array( $host_delegation_request ) ) {
			if ( empty( $host_delegation_request['sandbox_session_id'] ) && '' !== (string) ( $session_envelope['id'] ?? '' ) ) {
				$host_delegation_request['sandbox_session_id'] = (string) $session_envelope['id'];
			}

			$result = $this->request_host_delegation( $host_delegation_request );
			if ( is_wp_error( $result ) ) {
				return $result;
			}

			$phase['status'] = true === ( $result['success'] ?? false ) ? (string) ( $result['status'] ?? 'completed' ) : (string) ( $result['status'] ?? 'failed' );
			$phase['result'] = $result;

			return array_filter( $phase, static fn( mixed $value ): bool => array() !== $value && '' !== $value );
		}

		return array_filter( $phase, static fn( mixed $value ): bool => array() !== $value && '' !== $value );
	}

	/** @param array<string,mixed> $contract Browser task contract. @return array<string,mixed> */
	private function compact_browser_task_contract_dto( array $contract ): array {
		$phases = array();
		foreach ( is_array( $contract['phases'] ?? null ) ? $contract['phases'] : array() as $phase ) {
			if ( ! is_array( $phase ) ) {
				continue;
			}

			$phase_dto = array(
				'name'     => (string) ( $phase['name'] ?? '' ),
				'kind'     => (string) ( $phase['kind'] ?? '' ),
				'index'    => (int) ( $phase['index'] ?? 0 ),
				'label'    => (string) ( $phase['label'] ?? '' ),
				'status'   => (string) ( $phase['status'] ?? '' ),
				'metadata' => is_array( $phase['metadata'] ?? null ) ? $this->compact_browser_dto_value( $phase['metadata'] ) : array(),
			);
			if ( is_array( $phase['contract'] ?? null ) ) {
				$phase_dto['contract'] = $this->compact_browser_materializer_contract_dto( $phase['contract'] );
			}
			if ( is_array( $phase['result'] ?? null ) ) {
				$phase_dto['result'] = $this->compact_browser_dto_value( $phase['result'] );
			}

			$phases[] = array_filter( $phase_dto, static fn( mixed $value ): bool => array() !== $value && '' !== $value );
		}

		return array_filter(
			array(
				'success'          => (bool) ( $contract['success'] ?? false ),
				'schema'           => 'wp-codebox/browser-task-product-dto/v1',
				'source_schema'    => (string) ( $contract['schema'] ?? '' ),
				'execution'        => (string) ( $contract['execution'] ?? '' ),
				'execution_scope'  => (string) ( $contract['execution_scope'] ?? '' ),
				'permission_model' => (string) ( $contract['permission_model'] ?? '' ),
				'status'           => (string) ( $contract['status'] ?? '' ),
				'error'            => is_array( $contract['error'] ?? null ) ? $this->compact_browser_dto_value( $contract['error'] ) : array(),
				'session'          => is_array( $contract['session'] ?? null ) ? $this->compact_browser_dto_value( $contract['session'] ) : array(),
				'authorization'    => is_array( $contract['authorization'] ?? null ) ? $this->compact_browser_dto_value( $contract['authorization'] ) : array(),
				'task_input'       => is_array( $contract['task_input'] ?? null ) ? $this->compact_browser_executable_task_input( $contract['task_input'], array() ) : array(),
				'primary'          => is_array( $contract['primary'] ?? null ) ? $this->compact_browser_session_dto( $contract['primary'] ) : array(),
				'phases'           => $phases,
				'execution_metrics' => is_array( $contract['execution_metrics'] ?? null ) ? $this->compact_browser_dto_value( $contract['execution_metrics'] ) : array(),
				'provenance'       => is_array( $contract['provenance'] ?? null ) ? $this->compact_browser_dto_value( $contract['provenance'] ) : array(),
			),
			static fn( mixed $value ): bool => array() !== $value && '' !== $value
		);
	}

	/** @param array<string,mixed> $primary Primary browser session. @param array<int,array<string,mixed>> $phases Browser phases. @return array<string,mixed> */
	private function browser_contract_execution_metrics( array $primary, array $phases ): array {
		$recipe       = is_array( $primary['recipe'] ?? null ) ? $primary['recipe'] : array();
		$playground   = is_array( $primary['playground'] ?? null ) ? $primary['playground'] : array();
		$blueprint    = is_array( $playground['blueprint'] ?? null ) ? $playground['blueprint'] : array();
		$browser      = is_array( $recipe['browser'] ?? null ) ? $recipe['browser'] : array();
		$captures     = is_array( $browser['captures'] ?? null ) ? $browser['captures'] : array();
		$task_payload = is_array( $primary['task_payload'] ?? null ) ? $primary['task_payload'] : array();
		$artifacts    = is_array( $primary['artifacts'] ?? null ) ? $primary['artifacts'] : array();
		$error        = is_array( $primary['error'] ?? null ) ? $primary['error'] : array();

		return array_filter(
			array(
				'schema'           => 'wp-codebox/execution-metrics/v1',
				'executor'         => function_exists( 'apply_filters' ) ? (string) apply_filters( 'wp_codebox_browser_runtime_executor_target', 'wp-codebox/browser-playground' ) : 'wp-codebox/browser-playground',
				'phase'            => 'contract',
				'status'           => true === ( $primary['success'] ?? false ) ? 'pending' : (string) ( $primary['status'] ?? 'blocked' ),
				'execution'        => 'browser-playground',
				'execution_scope'  => 'disposable-playground',
				'permission_model' => 'runtime-principal',
				'timings_ms'       => array(
					'browser_startup_ms'    => null,
					'playground_startup_ms' => null,
					'blueprint_run_ms'      => null,
					'agent_loop_ms'         => null,
				),
				'payload_bytes'    => array_filter(
					array(
						'task_payload' => $this->browser_metrics_json_bytes( $task_payload ),
						'recipe'       => $this->browser_metrics_json_bytes( $recipe ),
						'blueprint'    => $this->browser_metrics_json_bytes( $blueprint ),
					),
					static fn( int $bytes ): bool => $bytes > 0
				),
				'artifacts'        => array(
					'expected_count'       => is_array( $artifacts['expected_artifacts'] ?? null ) ? count( $artifacts['expected_artifacts'] ) : 0,
					'declared_file_count'  => is_array( $artifacts['files'] ?? null ) ? count( $artifacts['files'] ) : 0,
					'capture_path_count'   => count( $captures ),
					'phase_count'          => count( $phases ),
					'materializer_phases'  => count( array_filter( $phases, static fn( mixed $phase ): bool => is_array( $phase ) && 'materializer' === (string) ( $phase['kind'] ?? '' ) ) ),
				),
				'diagnostics_refs' => array_filter(
					array(
						'materialization_result_path' => (string) ( $browser['result_path'] ?? '' ),
						'event_stream_path'           => '/tmp/wp-codebox-agent-events.jsonl',
						'capture_paths'               => array_values( array_filter( array_map( static fn( mixed $capture ): string => is_array( $capture ) ? (string) ( $capture['path'] ?? '' ) : '', $captures ) ) ),
						'provider_proxy'              => 'browser-result.diagnostics.provider_proxy',
					),
					static fn( mixed $value ): bool => array() !== $value && '' !== $value
				),
				'failure'          => empty( $error ) ? array() : array(
					'class' => $this->browser_metrics_failure_class( (string) ( $error['code'] ?? '' ) ),
					'code'  => (string) ( $error['code'] ?? '' ),
				),
			),
			static fn( mixed $value ): bool => array() !== $value && '' !== $value
		);
	}

	private function browser_metrics_json_bytes( mixed $value ): int {
		$encoded = wp_json_encode( $value, JSON_UNESCAPED_SLASHES );
		return is_string( $encoded ) ? strlen( $encoded ) : 0;
	}

	private function browser_metrics_failure_class( string $code ): string {
		if ( '' === $code ) {
			return '';
		}
		if ( str_contains( $code, 'timeout' ) ) {
			return 'timeout';
		}
		if ( str_contains( $code, 'permission' ) || str_contains( $code, 'authorization' ) || str_contains( $code, 'not_playground' ) ) {
			return 'authorization';
		}
		if ( str_contains( $code, 'unavailable' ) || str_contains( $code, 'missing' ) ) {
			return 'dependency_unavailable';
		}
		if ( str_contains( $code, 'invalid' ) ) {
			return 'invalid_request';
		}

		return 'runtime_error';
	}

	/** @param array<string,mixed> $contract Browser materializer contract. @return array<string,mixed> */
	private function compact_browser_materializer_contract_dto( array $contract ): array {
		return array_filter(
			array(
				'success'          => (bool) ( $contract['success'] ?? false ),
				'schema'           => 'wp-codebox/browser-materializer-product-dto/v1',
				'source_schema'    => (string) ( $contract['schema'] ?? '' ),
				'execution'        => (string) ( $contract['execution'] ?? '' ),
				'execution_scope'  => (string) ( $contract['execution_scope'] ?? '' ),
				'permission_model' => (string) ( $contract['permission_model'] ?? '' ),
				'status'           => (string) ( $contract['status'] ?? '' ),
				'error'            => is_array( $contract['error'] ?? null ) ? $this->compact_browser_dto_value( $contract['error'] ) : array(),
				'session_id'       => (string) ( $contract['session_id'] ?? '' ),
				'authorization'    => is_array( $contract['authorization'] ?? null ) ? $this->compact_browser_dto_value( $contract['authorization'] ) : array(),
				'task'             => is_array( $contract['task_input'] ?? null ) ? (string) ( $contract['task_input']['goal'] ?? '' ) : '',
				'preview_boot'     => WP_Codebox_Browser_Task_Builder::browser_preview_boot_config( $contract ),
				'preview_ref'      => WP_Codebox_Browser_Task_Builder::browser_preview_ref( $contract ),
				'artifact_refs'    => WP_Codebox_Browser_Task_Builder::browser_artifact_refs( $contract ),
				'diagnostics'      => $this->compact_browser_contract_diagnostics( $contract ),
				'executable'       => $this->browser_executable_materializer_contract_dto( $contract ),
				'provenance'       => is_array( $contract['provenance'] ?? null ) ? $this->compact_browser_dto_value( $contract['provenance'] ) : array(),
			),
			static fn( mixed $value ): bool => array() !== $value && '' !== $value
		);
	}

	/** @param array<string,mixed> $contract Browser contract. @return array<string,mixed> */
	private function compact_browser_contract_diagnostics( array $contract ): array {
		$diagnostics = array();
		if ( is_array( $contract['signals'] ?? null ) ) {
			$diagnostics['signals'] = $this->compact_browser_dto_value( $contract['signals'] );
		}
		if ( is_array( $contract['execution_metrics'] ?? null ) ) {
			$metrics = $this->compact_browser_dto_value( $contract['execution_metrics'] );
			unset( $metrics['payload_bytes'], $metrics['diagnostics_refs'] );
			$diagnostics['execution_metrics'] = $metrics;
		}

		return array_filter( $diagnostics, static fn( mixed $value ): bool => array() !== $value && '' !== $value );
	}

	/** @param array<string,mixed> $contract Browser materializer contract. @return array<string,mixed> */
	private function browser_executable_materializer_contract_dto( array $contract ): array {
		$task_payload = is_array( $contract['task_payload'] ?? null ) ? $contract['task_payload'] : array();
		$task_input   = is_array( $contract['task_input'] ?? null ) ? $contract['task_input'] : array();
		$payload_bundles = is_array( $task_payload['agent_bundles'] ?? null ) ? $this->normalize_agent_bundles( $task_payload['agent_bundles'] ) : array();
		$input_bundles   = is_array( $task_input['agent_bundles'] ?? null ) ? $this->normalize_agent_bundles( $task_input['agent_bundles'] ) : array();
		$agent_bundles   = ! empty( $payload_bundles ) ? $payload_bundles : $input_bundles;

		return array_filter(
			array(
				'schema'       => 'wp-codebox/browser-materializer-executable-dto/v1',
				'session_id'   => (string) ( $contract['session_id'] ?? $task_payload['session_id'] ?? '' ),
				'task_payload' => $this->compact_browser_executable_task_payload( $task_payload, $agent_bundles ),
				'task_input'   => $this->compact_browser_executable_task_input( $task_input, $agent_bundles ),
			),
			static fn( mixed $value ): bool => array() !== $value && '' !== $value
		);
	}

	/** @param array<string,mixed> $task_payload Browser task payload. @param array<int,array<string,mixed>> $agent_bundles Executable bundle specs. @return array<string,mixed> */
	private function compact_browser_executable_task_payload( array $task_payload, array $agent_bundles ): array {
		$compact = array();
		foreach ( array( 'schema', 'agent', 'mode', 'provider', 'model', 'message', 'session_id' ) as $field ) {
			$value = isset( $task_payload[ $field ] ) ? (string) $task_payload[ $field ] : '';
			if ( '' !== $value ) {
				$compact[ $field ] = $value;
			}
		}
		if ( ! empty( $agent_bundles ) ) {
			$compact['agent_bundles'] = $agent_bundles;
		}

		return $compact;
	}

	/** @param array<string,mixed> $task_input Browser task input. @param array<int,array<string,mixed>> $agent_bundles Executable bundle specs. @return array<string,mixed> */
	private function compact_browser_executable_task_input( array $task_input, array $agent_bundles ): array {
		$compact = array();
		foreach ( array( 'schema', 'version', 'goal' ) as $field ) {
			$value = isset( $task_input[ $field ] ) ? (string) $task_input[ $field ] : '';
			if ( '' !== $value ) {
				$compact[ $field ] = $value;
			}
		}
		foreach ( array( 'target', 'allowed_tools', 'expected_artifacts', 'structured_artifacts', 'tool_bridge', 'sandbox_tool_policy', 'policy', 'context' ) as $field ) {
			if ( is_array( $task_input[ $field ] ?? null ) ) {
				$compact[ $field ] = $this->compact_browser_dto_value( $task_input[ $field ] );
			}
		}
		if ( ! empty( $agent_bundles ) ) {
			$compact['agent_bundles'] = $agent_bundles;
		}

		return array_filter( $compact, static fn( mixed $value ): bool => array() !== $value && '' !== $value );
	}

	/** @param array<string,mixed> $session Browser session envelope. @return array<string,mixed> */
	private function compact_browser_session_dto( array $session ): array {
		return WP_Codebox_Browser_Task_Builder::product_browser_session_dto( $session );
	}

	/** @param array<string,mixed> $playground Playground contract. @return array<string,mixed> */
	private function compact_browser_playground_dto( array $playground ): array {
		return array_filter(
			array(
				'client_module_url'  => (string) ( $playground['client_module_url'] ?? '' ),
				'remote_url'         => (string) ( $playground['remote_url'] ?? '' ),
				'cors_proxy_url'     => (string) ( $playground['cors_proxy_url'] ?? '' ),
				'scope'              => (string) ( $playground['scope'] ?? '' ),
				'artifact_base_path' => (string) ( $playground['artifact_base_path'] ?? '' ),
				'artifact_base_url'  => (string) ( $playground['artifact_base_url'] ?? '' ),
				'preview_url'        => (string) ( $playground['preview_url'] ?? '' ),
				'contained_site'     => is_array( $playground['contained_site'] ?? null ) ? $this->compact_browser_dto_value( $playground['contained_site'] ) : array(),
				'capabilities'       => is_array( $playground['capabilities'] ?? null ) ? $this->compact_browser_dto_value( $playground['capabilities'] ) : array(),
				'provenance'         => is_array( $playground['provenance'] ?? null ) ? $this->compact_browser_dto_value( $playground['provenance'] ) : array(),
			),
			static fn( mixed $value ): bool => array() !== $value && '' !== $value
		);
	}

	/** @param array<string,mixed> $recipe Browser recipe. @return array<string,mixed> */
	private function compact_browser_recipe_dto( array $recipe ): array {
		return WP_Codebox_Browser_Task_Builder::browser_recipe_dto( $recipe );
	}

	private function compact_browser_dto_value( mixed $value, string $key = '' ): mixed {
		$key = (string) $key;
		if ( $this->compact_browser_dto_key_should_omit( $key ) ) {
			return null;
		}
		if ( $this->compact_browser_dto_key_should_redact( $key ) ) {
			return '[redacted]';
		}
		if ( ! is_array( $value ) ) {
			return $value;
		}

		$compact = array();
		foreach ( $value as $child_key => $child_value ) {
			$child_compact = $this->compact_browser_dto_value( $child_value, is_string( $child_key ) ? $child_key : '' );
			if ( null === $child_compact ) {
				continue;
			}

			$compact[ $child_key ] = $child_compact;
		}

		return $compact;
	}

	private function compact_browser_dto_key_should_omit( string $key ): bool {
		return in_array( $key, array( 'pluginData', 'source', 'content', 'content_base64', 'bundle', 'plugins', 'runtime', 'artifact_base_path', 'base_path', 'task_path', 'result_path', 'event_stream_path', 'capture_paths', 'materialization_result_path' ), true );
	}

	private function compact_browser_dto_key_should_redact( string $key ): bool {
		return WP_Codebox_Redaction_Policy::key_should_redact( 'public_session_dto', $key );
	}

	/** @param array<string,mixed> $input Ability input. @param array<string,mixed> $session_envelope Primary browser session envelope. @return array<int,array<string,mixed>>|WP_Error */
	private function prepare_browser_task_contract_phases( array $input, array $session_envelope ): array|WP_Error {
		$phase_specs = is_array( $input['phases'] ?? null ) ? $input['phases'] : array();
		if ( empty( $phase_specs ) && is_array( $input['materializers'] ?? null ) ) {
			$phase_specs = array_map(
				static fn( mixed $materializer ): array => array(
					'kind'  => 'materializer',
					'input' => is_array( $materializer ) ? $materializer : array(),
				),
				$input['materializers']
			);
		}

		$phases = array();
		foreach ( $phase_specs as $index => $phase ) {
			if ( ! is_array( $phase ) ) {
				return new WP_Error( 'wp_codebox_browser_phase_invalid', 'Each browser task phase must be an object.', array( 'status' => 400, 'index' => $index ) );
			}

			$kind = $this->safe_key( (string) ( $phase['kind'] ?? 'materializer' ) );
			if ( ! in_array( $kind, $this->browser_task_phase_kinds(), true ) ) {
				return new WP_Error( 'wp_codebox_browser_phase_kind_invalid', 'Browser task phases support materializer, agent, validator, repair, aggregator, and host-delegation kinds.', array( 'status' => 400, 'index' => $index, 'kind' => $kind ) );
			}

			$phase_descriptor = array(
				'name'     => $this->safe_key( (string) ( $phase['name'] ?? $kind . '-' . ( $index + 1 ) ) ),
				'kind'     => $kind,
				'index'    => $index,
				'label'    => (string) ( $phase['label'] ?? '' ),
				'status'   => (string) ( $phase['status'] ?? 'pending' ),
				'metadata' => is_array( $phase['metadata'] ?? null ) ? $this->compact_browser_dto_value( $phase['metadata'] ) : array(),
			);

			$fanout_request = $this->browser_task_phase_fanout_request( $phase );
			if ( is_array( $fanout_request ) ) {
				if ( empty( $fanout_request['sandbox_session_id'] ) && '' !== (string) ( $session_envelope['id'] ?? '' ) ) {
					$fanout_request['sandbox_session_id'] = (string) $session_envelope['id'];
				}

				$phase_descriptor['request'] = $fanout_request;
				$phases[] = array_filter( $phase_descriptor, static fn( mixed $value ): bool => array() !== $value && '' !== $value );
				continue;
			}

			$host_delegation_request = $this->browser_task_phase_host_delegation_request( $phase );
			if ( is_array( $host_delegation_request ) ) {
				if ( empty( $host_delegation_request['sandbox_session_id'] ) && '' !== (string) ( $session_envelope['id'] ?? '' ) ) {
					$host_delegation_request['sandbox_session_id'] = (string) $session_envelope['id'];
				}

				$phase_descriptor['request'] = $host_delegation_request;
				$phases[] = array_filter( $phase_descriptor, static fn( mixed $value ): bool => array() !== $value && '' !== $value );
				continue;
			}

			if ( 'materializer' !== $kind ) {
				$phases[] = array_filter( $phase_descriptor, static fn( mixed $value ): bool => array() !== $value && '' !== $value );
				continue;
			}

			$phase_input = is_array( $phase['input'] ?? null ) ? $phase['input'] : array();
			$phase_input = array_replace_recursive( $input, $phase_input );
			unset( $phase_input['phases'], $phase_input['materializers'] );

			if ( empty( $phase_input['sandbox_session_id'] ) && '' !== (string) ( $session_envelope['id'] ?? '' ) ) {
				$phase_input['sandbox_session_id'] = (string) $session_envelope['id'];
			}
			$phase_input['include_internal_browser_contract'] = true;

			$contract = $this->create_browser_materializer_contract( $phase_input );
			if ( is_wp_error( $contract ) ) {
				return $contract;
			}

			$phase_descriptor['contract'] = $contract;
			$phases[] = array_filter( $phase_descriptor, static fn( mixed $value ): bool => array() !== $value && '' !== $value );
		}

		return $phases;
	}

	/** @param array<string,mixed> $phase Browser task phase. @return array<string,mixed>|null */
	private function browser_task_phase_fanout_request( array $phase ): ?array {
		$candidates = array( $phase['request'] ?? null, $phase['input'] ?? null );
		foreach ( $candidates as $candidate ) {
			if ( is_array( $candidate ) && 'wp-codebox/agent-fanout-request/v1' === (string) ( $candidate['schema'] ?? '' ) ) {
				return $candidate;
			}
		}

		return null;
	}

	/** @param array<string,mixed> $phase Browser task phase. @return array<string,mixed>|null */
	private function browser_task_phase_host_delegation_request( array $phase ): ?array {
		$candidates = array( $phase['request'] ?? null, $phase['input'] ?? null );
		foreach ( $candidates as $candidate ) {
			if ( is_array( $candidate ) && 'wp-codebox/host-delegation-request/v1' === (string) ( $candidate['schema'] ?? '' ) ) {
				return $candidate;
			}
		}

		return null;
	}
}
