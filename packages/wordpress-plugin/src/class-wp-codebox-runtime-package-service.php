<?php
/**
 * Runtime package task/result normalization service.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_Runtime_Package_Service {

	/** @param array<string,mixed> $input Runtime package input. @return array<string,mixed>|WP_Error */
	public function run( array $input ): array|WP_Error {
		$task = $this->normalize_task_input( $input );
		if ( is_wp_error( $task ) ) {
			return $task;
		}

		$result = WP_Codebox_Runtime_Provider_Registry::invoke( $task );
		if ( is_wp_error( $result ) ) {
			return $result;
		}

		return $this->normalize_result( $result, $task );
	}

	/** @param array<string,mixed> $input Runtime package input. @return array<string,mixed>|WP_Error */
	private function normalize_task_input( array $input ): array|WP_Error {
		if ( 'wp-codebox/runtime-package-task/v1' === (string) ( $input['schema'] ?? '' ) ) {
			$invalid = $this->task_validation_errors( $input );
			if ( ! empty( $invalid ) ) {
				return new WP_Error( 'wp_codebox_runtime_package_task_invalid', 'Runtime package task does not match wp-codebox/runtime-package-task/v1.', array( 'status' => 400, 'diagnostics' => $invalid ) );
			}

			return $input;
		}

		return $this->legacy_task_input( $input );
	}

	/** @param array<string,mixed> $input Legacy runtime package input. @return array<string,mixed>|WP_Error */
	private function legacy_task_input( array $input ): array|WP_Error {
		$metadata   = is_array( $input['metadata'] ?? null ) ? $input['metadata'] : array();
		$descriptor = is_array( $input['package'] ?? null ) ? $input['package'] : ( is_array( $metadata['runtime_package_descriptor'] ?? null ) ? $metadata['runtime_package_descriptor'] : array() );
		if ( empty( $descriptor ) && isset( $input['runtime_package'] ) ) {
			$descriptor = $this->descriptor_from_legacy_string( (string) $input['runtime_package'] );
		}

		$package = $this->descriptor_for_task( $descriptor, $input );
		if ( '' === (string) ( $package['slug'] ?? '' ) || '' === (string) ( $package['source'] ?? '' ) ) {
			return new WP_Error( 'wp_codebox_runtime_package_task_invalid', 'Runtime package task requires package.slug and package.source.', array( 'status' => 400 ) );
		}

		$workflow_id = $this->string_value( $input['workflow_id'] ?? $input['workflowId'] ?? ( is_array( $input['workflow'] ?? null ) ? ( $input['workflow']['id'] ?? '' ) : '' ) );
		if ( '' === $workflow_id ) {
			$workflow_id = (string) $package['slug'];
		}

		return array(
			'schema'                => 'wp-codebox/runtime-package-task/v1',
			'package'               => $package,
			'workflow'              => array( 'id' => $workflow_id ),
			'input'                 => is_array( $input['input'] ?? null ) ? $input['input'] : array(),
			'artifact_declarations' => is_array( $input['artifact_declarations'] ?? null ) ? $input['artifact_declarations'] : array(),
			'output_projections'    => is_array( $input['output_projections'] ?? null ) ? $input['output_projections'] : array(),
			'required_artifacts'    => $this->required_artifacts( $input ),
			'metadata'              => $metadata,
		) + array_intersect_key( $input, array_flip( array( 'runtime_provider', 'runtime_provider_id', 'provider', 'model', 'options', 'task_input' ) ) );
	}

	/** @param array<string,mixed> $task Runtime package task. @return array<int,array<string,mixed>> */
	private function task_validation_errors( array $task ): array {
		$errors = array();
		foreach ( array( 'schema', 'package', 'workflow', 'input', 'artifact_declarations', 'required_artifacts' ) as $field ) {
			if ( ! array_key_exists( $field, $task ) ) {
				$errors[] = $this->diagnostic( 'runtime_package_task_missing_field', 'Runtime package task is missing required field: ' . $field . '.', $field );
			}
		}
		if ( ! is_array( $task['package'] ?? null ) || '' === $this->string_value( $task['package']['slug'] ?? '' ) || '' === $this->string_value( $task['package']['source'] ?? '' ) ) {
			$errors[] = $this->diagnostic( 'runtime_package_task_invalid_package', 'Runtime package task requires package.slug and package.source.', 'package' );
		}
		if ( is_array( $task['package'] ?? null ) && $this->is_workspace_relative_source( (string) ( $task['package']['source'] ?? '' ) ) ) {
			$errors[] = $this->diagnostic( 'runtime_package_workspace_root_required', 'Workspace-relative package.source requires explicit workspace root normalization before execution.', 'package.source' );
		}
		if ( ! is_array( $task['workflow'] ?? null ) || '' === $this->string_value( $task['workflow']['id'] ?? '' ) ) {
			$errors[] = $this->diagnostic( 'runtime_package_task_invalid_workflow', 'Runtime package task requires workflow.id.', 'workflow.id' );
		}
		if ( ! is_array( $task['input'] ?? null ) ) {
			$errors[] = $this->diagnostic( 'runtime_package_task_invalid_input', 'Runtime package task requires input object.', 'input' );
		}
		if ( ! is_array( $task['artifact_declarations'] ?? null ) ) {
			$errors[] = $this->diagnostic( 'runtime_package_task_invalid_artifact_declarations', 'Runtime package task requires artifact_declarations array.', 'artifact_declarations' );
		}
		if ( ! is_array( $task['required_artifacts'] ?? null ) ) {
			$errors[] = $this->diagnostic( 'runtime_package_task_invalid_required_artifacts', 'Runtime package task requires required_artifacts array.', 'required_artifacts' );
		}

		return $errors;
	}

	/** @param array<string,mixed> $input Runtime package input. @return string[] */
	private function required_artifacts( array $input ): array {
		if ( is_array( $input['required_artifacts'] ?? null ) ) {
			return array_values( array_unique( array_filter( array_map( 'strval', $input['required_artifacts'] ) ) ) );
		}

		$required = array();
		foreach ( is_array( $input['artifact_declarations'] ?? null ) ? $input['artifact_declarations'] : array() as $artifact ) {
			if ( is_array( $artifact ) && true === ( $artifact['required'] ?? false ) && 'input' !== (string) ( $artifact['direction'] ?? 'output' ) ) {
				$name = $this->string_value( $artifact['name'] ?? '' );
				if ( '' !== $name ) {
					$required[] = $name;
				}
			}
		}

		return array_values( array_unique( $required ) );
	}

	/** @param array<string,mixed> $result Provider result. @param array<string,mixed> $task Runtime package task. @return array<string,mixed> */
	private function normalize_result( array $result, array $task ): array {
		$diagnostics = $this->diagnostics( $result['diagnostics'] ?? array() );
		$failed      = false === ( $result['success'] ?? true ) || 'failed' === (string) ( $result['status'] ?? '' ) || $this->has_error_diagnostic( $diagnostics );
		$metadata    = is_array( $result['metadata'] ?? null ) ? $result['metadata'] : array();
		foreach ( array( 'runtime_provider', 'projections', 'received' ) as $field ) {
			if ( array_key_exists( $field, $result ) && ! array_key_exists( $field, $metadata ) ) {
				$metadata[ $field ] = $result[ $field ];
			}
		}

		return array(
			'schema'      => 'wp-codebox/runtime-package-result/v1',
			'status'      => $failed ? 'failed' : 'success',
			'success'     => ! $failed,
			'package'     => is_array( $result['package'] ?? null ) ? $this->descriptor_for_task( $result['package'], $task ) : $task['package'],
			'outputs'     => is_array( $result['outputs'] ?? null ) ? $result['outputs'] : $this->semantic_outputs( $result ),
			'artifacts'   => $this->artifacts( $result['artifacts'] ?? array() ),
			'diagnostics' => $diagnostics,
			'metadata'    => $metadata,
		);
	}

	/** @param array<string,mixed> $descriptor Package descriptor. @param array<string,mixed> $input Runtime package input. @return array<string,string> */
	private function descriptor_for_task( array $descriptor, array $input ): array {
		$slug   = $this->string_value( $descriptor['slug'] ?? $descriptor['id'] ?? '' );
		$source = $this->string_value( $descriptor['source'] ?? '' );
		if ( '' !== $source && $this->is_workspace_relative_source( $source ) ) {
			foreach ( $this->workspace_roots( $input ) as $root ) {
				$candidate = rtrim( $root, '/\\' ) . '/' . ltrim( $source, '/\\' );
				if ( file_exists( $candidate ) ) {
					$source = $candidate;
					break;
				}
			}
		}
		if ( '' === $slug && '' !== $source ) {
			$slug = $this->slug_from_source( $source );
		}

		return array( 'slug' => $slug, 'source' => $source );
	}

	/** @return array<string,string> */
	private function descriptor_from_legacy_string( string $runtime_package ): array {
		$runtime_package = trim( $runtime_package );
		if ( '' === $runtime_package ) {
			return array( 'slug' => '', 'source' => '' );
		}

		return array( 'slug' => $this->slug_from_source( $runtime_package ), 'source' => $runtime_package );
	}

	/** @param mixed $value Diagnostics value. @return array<int,array<string,mixed>> */
	private function diagnostics( mixed $value ): array {
		if ( ! is_array( $value ) ) {
			return array();
		}

		$diagnostics = array();
		foreach ( $value as $diagnostic ) {
			if ( ! is_array( $diagnostic ) ) {
				continue;
			}
			$diagnostics[] = $this->diagnostic(
				$this->string_value( $diagnostic['code'] ?? 'runtime_package_diagnostic' ),
				$this->string_value( $diagnostic['message'] ?? 'Runtime package diagnostic.' ),
				$this->string_value( $diagnostic['path'] ?? '' ),
				in_array( (string) ( $diagnostic['severity'] ?? '' ), array( 'info', 'warning', 'error' ), true ) ? (string) $diagnostic['severity'] : 'error',
				is_array( $diagnostic['details'] ?? null ) ? $diagnostic['details'] : array()
			);
		}

		return $diagnostics;
	}

	/** @param array<int,mixed> $value Artifact value. @return array<int,array<string,mixed>> */
	private function artifacts( mixed $value ): array {
		if ( ! is_array( $value ) ) {
			return array();
		}

		$artifacts = array();
		foreach ( $value as $artifact ) {
			if ( is_array( $artifact ) && '' !== $this->string_value( $artifact['name'] ?? '' ) ) {
				$artifacts[] = $artifact;
			}
		}

		return $artifacts;
	}

	/** @param array<string,mixed> $result Provider result. @return array<string,mixed> */
	private function semantic_outputs( array $result ): array {
		$outputs = array();
		foreach ( array( 'result', 'summary', 'data', 'semantic_outputs', 'structured_outputs' ) as $field ) {
			if ( array_key_exists( $field, $result ) ) {
				$outputs[ $field ] = $result[ $field ];
			}
		}

		return $outputs;
	}

	/** @param array<int,array<string,mixed>> $diagnostics Diagnostics. */
	private function has_error_diagnostic( array $diagnostics ): bool {
		foreach ( $diagnostics as $diagnostic ) {
			if ( 'error' === (string) ( $diagnostic['severity'] ?? '' ) ) {
				return true;
			}
		}

		return false;
	}

	/** @param array<string,mixed> $details Diagnostic details. @return array<string,mixed> */
	private function diagnostic( string $code, string $message, string $path = '', string $severity = 'error', array $details = array() ): array {
		$diagnostic = array(
			'schema'   => 'wp-codebox/runtime-package-diagnostic/v1',
			'code'     => $code,
			'message'  => $message,
			'severity' => $severity,
		);
		if ( '' !== $path ) {
			$diagnostic['path'] = $path;
		}
		if ( ! empty( $details ) ) {
			$diagnostic['details'] = $details;
		}

		return $diagnostic;
	}

	/** @param array<string,mixed> $input Runtime package input. @return string[] */
	private function workspace_roots( array $input ): array {
		$contexts = array();
		foreach ( array( $input, $input['input'] ?? null, $input['task_input'] ?? null ) as $value ) {
			if ( is_array( $value ) && is_array( $value['client_context'] ?? null ) ) {
				$contexts[] = $value['client_context'];
			}
		}

		$roots = array();
		foreach ( $contexts as $context ) {
			if ( isset( $context['default_workspace']['target'] ) && is_string( $context['default_workspace']['target'] ) ) {
				$roots[] = $context['default_workspace']['target'];
			}
		}

		return array_values( array_unique( array_filter( $roots, static fn( string $root ): bool => '' !== trim( $root ) ) ) );
	}

	private function is_workspace_relative_source( string $source ): bool {
		return '' !== $source && ( str_contains( $source, '/' ) || str_contains( $source, '\\' ) ) && ! str_starts_with( $source, '/' ) && 1 !== preg_match( '#^[a-z][a-z0-9+.-]*://#i', $source ) && 1 !== preg_match( '#^[A-Za-z]:[\\/]#', $source );
	}

	private function slug_from_source( string $source ): string {
		$source = str_replace( '\\', '/', rtrim( trim( $source ), '/\\' ) );
		$slug   = basename( $source );

		return '' !== $slug ? $slug : $source;
	}

	private function string_value( mixed $value ): string {
		return is_scalar( $value ) ? trim( (string) $value ) : '';
	}
}
