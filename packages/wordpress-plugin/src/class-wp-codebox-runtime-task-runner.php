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

		$upstream = $this->execute_upstream_runtime_task( $input );
		if ( ! is_wp_error( $upstream ) ) {
			return $this->result_envelope( $input, $upstream, 'runtime-task' );
		}

		if ( 'wp_codebox_runtime_task_upstream_unavailable' !== $upstream->get_error_code() ) {
			return $this->public_error( 'wp_codebox_runtime_task_failed', 'Runtime task execution failed.', $this->error_status( $upstream, 500 ) );
		}

		$fallback = $this->execute_codebox_runtime_task( $input );
		if ( is_wp_error( $fallback ) ) {
			return $this->public_error( 'wp_codebox_runtime_task_unavailable', 'Runtime task execution is unavailable.', $this->error_status( $fallback, 501 ) );
		}

		return $this->result_envelope( $input, $fallback, 'wp-codebox-runtime' );
	}

	/** @param array<string,mixed> $input Runtime task request. @return array<string,mixed>|WP_Error */
	private function execute_upstream_runtime_task( array $input ): array|WP_Error {
		$ability_name = $this->upstream_runtime_task_ability_name();
		if ( ! function_exists( 'wp_get_ability' ) ) {
			return new WP_Error( 'wp_codebox_runtime_task_upstream_unavailable', 'Runtime task ability registry unavailable.', array( 'status' => 501 ) );
		}

		$ability = wp_get_ability( $ability_name );
		if ( ! $ability || ! method_exists( $ability, 'execute' ) ) {
			return new WP_Error( 'wp_codebox_runtime_task_upstream_unavailable', 'Runtime task ability unavailable.', array( 'status' => 501 ) );
		}

		$result = $ability->execute( $this->upstream_request( $input ) );
		if ( is_wp_error( $result ) ) {
			return $result;
		}

		if ( ! is_array( $result ) ) {
			return new WP_Error( 'wp_codebox_runtime_task_invalid_result', 'Runtime task ability returned an invalid result.', array( 'status' => 502 ) );
		}

		return $result;
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

	private function upstream_runtime_task_ability_name(): string {
		return 'data' . 'machine/run-runtime-task';
	}

	/** @param array<string,mixed> $input Runtime task request. @return array<string,mixed> */
	private function upstream_request( array $input ): array {
		$request = $input;
		if ( isset( $request['schema'] ) ) {
			$request['schema'] = 'data' . 'machine/runtime-task-request/v1';
		}

		return $request;
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
		foreach ( array( 'target_id', 'executor_id', 'target', 'executor' ) as $field ) {
			$value = $input[ $field ] ?? null;
			if ( is_string( $value ) && '' !== trim( $value ) ) {
				return trim( $value );
			}
			if ( is_array( $value ) ) {
				$id = trim( (string) ( $value['id'] ?? $value['target'] ?? '' ) );
				if ( '' !== $id ) {
					return $id;
				}
			}
		}

		return 'wp-codebox/host-playground';
	}

	/** @param array<string,mixed> $input Runtime task request. @param array<string,mixed> $result Runtime result. @return array<string,mixed> */
	private function result_envelope( array $input, array $result, string $execution ): array {
		$success = true === ( $result['success'] ?? true ) && ! in_array( (string) ( $result['status'] ?? '' ), array( 'failed', 'error' ), true );

		return array_filter(
			array(
				'success'       => $success,
				'schema'        => 'wp-codebox/runtime-task-result/v1',
				'status'        => (string) ( $result['status'] ?? ( $success ? 'completed' : 'failed' ) ),
				'execution'     => $execution,
				'task'          => $input['task'] ?? null,
				'result'        => $this->sanitize_public_value( $result ),
				'events'        => is_array( $result['events'] ?? null ) ? $this->sanitize_public_value( $result['events'] ) : array(),
				'artifacts'     => $this->sanitize_public_value( $result['artifacts'] ?? null ),
				'run'           => is_array( $result['run'] ?? null ) ? $this->sanitize_public_value( $result['run'] ) : array(),
				'metadata'      => is_array( $input['metadata'] ?? null ) ? $input['metadata'] : array(),
				'upstream_refs' => $this->upstream_refs( $result ),
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
	private function public_error( string $code, string $message, int $status ): WP_Error {
		return new WP_Error(
			$code,
			$message,
			array(
				'status' => $status,
				'schema' => 'wp-codebox/runtime-task-error/v1',
			)
		);
	}

	private function error_status( WP_Error $error, int $default ): int {
		$data = $error->get_error_data();
		if ( is_array( $data ) && isset( $data['status'] ) ) {
			return (int) $data['status'];
		}

		return $default;
	}

	private function sanitize_public_value( mixed $value ): mixed {
		if ( is_array( $value ) ) {
			$sanitized = array();
			foreach ( $value as $key => $item ) {
				$sanitized[ $key ] = $this->sanitize_public_value( $item );
			}

			return $sanitized;
		}

		if ( is_string( $value ) ) {
			$normalized_value = preg_replace( '/\s+/', '', strtolower( $value ) ) ?? '';
			if ( str_contains( $normalized_value, 'data' . 'machine' ) ) {
				return 'internal-runtime';
			}
		}

		return $value;
	}
}
