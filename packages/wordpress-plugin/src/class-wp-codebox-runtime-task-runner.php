<?php
/**
 * WP Codebox runtime task runner.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

/**
 * Codebox-owned facade for runtime task execution.
 */
final class WP_Codebox_Runtime_Task_Runner {

	/** @param array<string,mixed> $input Runtime task request. @return array<string,mixed>|WP_Error */
	public function run( array $input ): array|WP_Error {
		if ( ! is_array( $input['task'] ?? null ) && '' === trim( (string) ( $input['task'] ?? '' ) ) ) {
			return $this->public_error( 'wp_codebox_runtime_task_request_invalid', 'Runtime task requests require a task.', 400 );
		}

		$target_id = $this->target_id( $input );
		if ( '' === $target_id ) {
			return $this->public_error( 'wp_codebox_runtime_task_target_required', 'Runtime task requests require an explicit target_id.', 400, array( 'reason' => 'target_id_required' ) );
		}

		foreach ( $this->runtime_task_providers( $input ) as $provider ) {
			if ( ! $this->provider_matches( $provider, $input ) ) {
				continue;
			}

			$result = $this->execute_provider( $provider, $input );
			if ( is_wp_error( $result ) ) {
				return $this->public_error_from_private_error( $result );
			}

			return $this->result_envelope( $input, $result, $this->provider_id( $provider ) );
		}

		return $this->public_error( 'wp_codebox_runtime_task_unsupported_target', 'Runtime task target is not supported.', 422, array( 'reason' => 'unsupported-target', 'target_id' => $target_id ) );
	}

	/** @param array<string,mixed> $input Runtime task request. @return array<string,mixed>|WP_Error */
	private function execute_codebox_runtime_task( array $input ): array|WP_Error {
		$target_id  = $this->target_id( $input );
		$task_input = $this->task_input( $input );

		if ( 'wp-codebox/browser-playground' === $target_id ) {
			return WP_Codebox_Abilities::create_browser_task_contract( $task_input );
		}

		return WP_Codebox_Abilities::run_agent_task( $task_input );
	}

	/** @param array<string,mixed> $input Runtime task request. @return array<int,array<string,mixed>> */
	private function runtime_task_providers( array $input ): array {
		$providers = array(
			array(
				'id'         => 'wp-codebox-runtime',
				'target_ids' => array( 'wp-codebox/host-playground', 'wp-codebox/browser-playground' ),
				'callback'   => fn( array $request ): array|WP_Error => $this->execute_codebox_runtime_task( $request ),
			),
		);

		if ( function_exists( 'apply_filters' ) ) {
			$providers = apply_filters( 'wp_codebox_runtime_task_providers', $providers, $input );
		}

		if ( ! is_array( $providers ) ) {
			return array();
		}

		return array_values( array_filter( $providers, 'is_array' ) );
	}

	/** @param array<string,mixed> $provider Runtime task provider. @param array<string,mixed> $input Runtime task request. */
	private function provider_matches( array $provider, array $input ): bool {
		$matches = $provider['matches'] ?? null;
		if ( is_callable( $matches ) ) {
			return true === $matches( $input );
		}

		$target_ids = $provider['target_ids'] ?? array();
		if ( is_array( $target_ids ) && ! empty( $target_ids ) ) {
			return in_array( $this->target_id( $input ), array_values( array_filter( $target_ids, 'is_string' ) ), true );
		}

		return true;
	}

	/** @param array<string,mixed> $provider Runtime task provider. @param array<string,mixed> $input Runtime task request. @return array<string,mixed>|WP_Error */
	private function execute_provider( array $provider, array $input ): array|WP_Error {
		$callback = $provider['callback'] ?? null;
		if ( ! is_callable( $callback ) ) {
			return new WP_Error( 'wp_codebox_runtime_task_provider_invalid', 'Runtime task provider is invalid.', array( 'status' => 500 ) );
		}

		$result = $callback( $input, $provider );
		if ( is_wp_error( $result ) ) {
			return $result;
		}

		if ( ! is_array( $result ) ) {
			return new WP_Error( 'wp_codebox_runtime_task_provider_invalid_result', 'Runtime task provider returned an invalid result.', array( 'status' => 502 ) );
		}

		return $result;
	}

	/** @param array<string,mixed> $provider Runtime task provider. */
	private function provider_id( array $provider ): string {
		$id = trim( (string) ( $provider['id'] ?? '' ) );

		return '' === $id ? 'runtime-task-provider' : $id;
	}

	/** @param array<string,mixed> $input Runtime task request. @return array<string,mixed> */
	private function task_input( array $input ): array {
		$task_input = is_array( $input['input'] ?? null ) ? $input['input'] : ( is_array( $input['task_input'] ?? null ) ? $input['task_input'] : $input );
		if ( is_string( $input['task'] ?? null ) && ! isset( $task_input['goal'] ) ) {
			$task_input['goal'] = $input['task'];
		}

		foreach ( array( 'agent', 'mode', 'provider', 'model', 'sandbox_session_id', 'orchestrator' ) as $field ) {
			if ( ! array_key_exists( $field, $task_input ) && array_key_exists( $field, $input ) ) {
				$task_input[ $field ] = $input[ $field ];
			}
		}

		return $task_input;
	}

	/** @param array<string,mixed> $input Runtime task request. */
	private function target_id( array $input ): string {
		$value = $input['target_id'] ?? null;
		if ( is_string( $value ) && '' !== trim( $value ) ) {
			return trim( $value );
		}

		return '';
	}

	/** @param array<string,mixed> $input Runtime task request. @param array<string,mixed> $result Runtime result. @return array<string,mixed> */
	private function result_envelope( array $input, array $result, string $execution ): array {
		$success = true === ( $result['success'] ?? true ) && ! in_array( (string) ( $result['status'] ?? '' ), array( 'failed', 'error' ), true );
		$public  = is_array( $result['public'] ?? null ) ? $result['public'] : $result;

		return array_filter(
			array(
				'success'       => $success,
				'schema'        => 'wp-codebox/runtime-task-result/v1',
				'status'        => (string) ( $result['status'] ?? ( $success ? 'completed' : 'failed' ) ),
				'execution'     => $execution,
				'task'          => $input['task'] ?? null,
				'result'        => $public,
				'events'        => is_array( $public['events'] ?? null ) ? $public['events'] : array(),
				'artifacts'     => $public['artifacts'] ?? null,
				'run'           => is_array( $public['run'] ?? null ) ? $public['run'] : array(),
				'metadata'      => is_array( $input['metadata'] ?? null ) ? $input['metadata'] : array(),
				'upstream_refs' => $this->upstream_refs( $public ),
			),
			static fn( mixed $value ): bool => null !== $value && '' !== $value && array() !== $value
		);
	}

	/** @param array<string,mixed> $result Runtime result. @return array<string,mixed> */
	private function upstream_refs( array $result ): array {
		$refs = array();
		foreach ( array( 'run_id', 'task_id', 'session_id' ) as $field ) {
			if ( is_scalar( $result[ $field ] ?? null ) && '' !== (string) $result[ $field ] ) {
				$refs[ $field ] = (string) $result[ $field ];
			}
		}

		return $refs;
	}

	/** @return WP_Error */
	private function public_error( string $code, string $message, int $status, array $extra = array() ): WP_Error {
		return new WP_Error(
			$code,
			$message,
			array_filter(
				array_merge(
					$extra,
					array(
						'status' => $status,
						'schema' => 'wp-codebox/runtime-task-error/v1',
					)
				),
				static fn( mixed $value ): bool => null !== $value && '' !== $value
			)
		);
	}

	private function public_error_from_private_error( WP_Error $error ): WP_Error {
		$data   = $error->get_error_data();
		$public = is_array( $data ) && is_array( $data['public'] ?? null ) ? $data['public'] : array();

		return $this->public_error(
			(string) ( $public['code'] ?? 'wp_codebox_runtime_task_failed' ),
			(string) ( $public['message'] ?? 'Runtime task execution failed.' ),
			(int) ( $public['status'] ?? $this->error_status( $error, 500 ) )
		);
	}

	private function error_status( WP_Error $error, int $default ): int {
		$data = $error->get_error_data();
		if ( is_array( $data ) && isset( $data['status'] ) ) {
			return (int) $data['status'];
		}

		return $default;
	}

}
