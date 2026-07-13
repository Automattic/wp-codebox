<?php
/**
 * Standalone WP Codebox runtime package executor.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

/**
 * Executes runtime packages through the local WordPress ability surface.
 */
final class WP_Codebox_Runtime_Package_Executor {

	private const PROVIDER_ID = 'codebox-runtime-package';

	public static function register_runtime_provider(): void {
		if ( ! class_exists( 'WP_Codebox_Runtime_Provider_Registry' ) ) {
			return;
		}

		WP_Codebox_Runtime_Provider_Registry::register(
			self::PROVIDER_ID,
			array( new self(), 'run' ),
			array(
				'label'        => 'WP Codebox runtime package executor',
				'kind'         => 'ability-executor',
				'public_id'    => 'codebox-runtime-package',
				'public_label' => 'WP Codebox runtime package executor',
				'public_kind'  => 'runtime-profile',
				'capabilities' => array( 'codebox.runtime-package' ),
				'default'      => true,
			)
		);
	}

	/** @param array<string,mixed> $task Runtime package task. @return array<string,mixed>|WP_Error */
	public function run( array $task ): array|WP_Error {
		$imports = $this->import_package_bundle( $task );
		if ( is_wp_error( $imports ) ) {
			return $imports;
		}

		$agent_slug = $this->imported_agent_slug( $task );
		if ( is_wp_error( $agent_slug ) ) {
			return $agent_slug;
		}
		if ( '' !== $agent_slug ) {
			$input           = is_array( $task['input'] ?? null ) ? $task['input'] : array();
			$input['agent']  = $agent_slug;
			$task['input']   = $input;
		}

		$result = $this->execute_workflow( $task );
		if ( is_wp_error( $result ) ) {
			return $result;
		}

		return $this->result_with_artifact_validation( $result, $task, $imports );
	}

	/** @param array<string,mixed> $task Runtime package task. @return array<int,array<string,mixed>>|WP_Error */
	private function import_package_bundle( array $task ): array|WP_Error {
		$package = is_array( $task['package'] ?? null ) ? $task['package'] : array();
		$source  = $this->string_value( $package['source'] ?? '' );
		$slug    = $this->string_value( $package['slug'] ?? '' );
		$external_source = is_array( $package['external_source'] ?? null ) ? $package['external_source'] : array();
		$expected_digest = $this->string_value( $external_source['digest'] ?? '' );
		if ( ! empty( $package['bootstrap_imported'] ) ) {
			$bootstrap = is_array( $GLOBALS['wp_codebox_private_runtime_package_import'] ?? null ) ? $GLOBALS['wp_codebox_private_runtime_package_import'] : array();
			if ( ! hash_equals( $expected_digest, $this->string_value( $bootstrap['digest'] ?? '' ) ) || ! is_array( $bootstrap['imports'] ?? null ) || '' === $this->string_value( $bootstrap['identity']['slug'] ?? '' ) ) {
				return new WP_Error( 'wp_codebox_runtime_package_bootstrap_missing', 'Private runtime package import did not complete before agent availability.', array( 'status' => 400 ) );
			}
			return $bootstrap['imports'];
		}
		if ( '' === $source ) {
			return new WP_Error( 'wp_codebox_runtime_package_source_missing', 'Runtime package execution requires package.source.', array( 'status' => 400 ) );
		}
		if ( ! is_readable( $source ) || ! str_ends_with( $source, '.agent.json' ) ) {
			return new WP_Error( 'wp_codebox_runtime_package_native_agent_missing', 'Runtime package source must identify one standalone .agent.json file.', array( 'status' => 400 ) );
		}
		if ( '' !== $expected_digest && ! hash_equals( $expected_digest, 'sha256-bytes-v1:' . hash_file( 'sha256', $source ) ) ) {
			return new WP_Error( 'wp_codebox_runtime_package_digest_mismatch', 'Runtime package content changed after staging and before import.', array( 'status' => 400 ) );
		}

		$bundle_spec = array_filter(
			array(
				'source'      => $source,
				'slug'        => $slug,
				'on_conflict' => 'upgrade',
			),
			static fn( mixed $value ): bool => '' !== $value
		);

		$imports = $this->import_runtime_bundles( array( $bundle_spec ) );
		if ( is_wp_error( $imports ) ) {
			return $imports;
		}
		$failed  = array_values( array_filter( $imports, static fn( mixed $import ): bool => is_array( $import ) && empty( $import['success'] ) ) );
		if ( ! empty( $failed ) ) {
			return new WP_Error( 'wp_codebox_runtime_package_import_failed', 'Runtime package bundle import failed.', array( 'status' => 500, 'agent_bundle_imports' => $failed ) );
		}

		return $imports;
	}

	/** @param array<int,array<string,mixed>> $bundle_specs Runtime bundle specs. @return array<int,array<string,mixed>>|WP_Error */
	private function import_runtime_bundles( array $bundle_specs ): array|WP_Error {
		if ( ! function_exists( 'wp_agent_import_runtime_bundles' ) ) {
			return new WP_Error( 'wp_codebox_runtime_package_importer_unavailable', 'Canonical wp_agent_import_runtime_bundles() is unavailable.', array( 'status' => 500 ) );
		}
		$result = wp_agent_import_runtime_bundles( $bundle_specs, array( 'owner_id' => $this->owner_id() ) );
		return is_array( $result ) ? $result : new WP_Error( 'wp_codebox_runtime_package_importer_invalid_result', 'Canonical wp_agent_import_runtime_bundles() returned an invalid result.', array( 'status' => 500 ) );
	}

	/** @param array<string,mixed> $task Runtime package task. @return array<string,mixed>|WP_Error */
	private function execute_workflow( array $task ): array|WP_Error {
		$ability = 'agents/chat';
		$input   = is_array( $task['input'] ?? null ) ? $task['input'] : array();
		$package = is_array( $task['package'] ?? null ) ? $task['package'] : array();
		if ( ! isset( $input['agent'] ) && '' !== $this->string_value( $package['slug'] ?? '' ) ) {
			$input['agent'] = $this->string_value( $package['slug'] );
		}
		if ( ! isset( $input['message'] ) ) {
			$input['message'] = $this->string_value( $input['prompt'] ?? '' );
		}
		$input['runtime_package_task'] = $task;
		$ability_object = function_exists( 'wp_get_ability' ) ? wp_get_ability( $ability ) : null;
		if ( ! is_object( $ability_object ) || ! method_exists( $ability_object, 'execute' ) ) {
			return new WP_Error( 'wp_codebox_runtime_package_workflow_unavailable', 'Runtime package workflow ability is unavailable.', array( 'status' => 500, 'ability' => $ability ) );
		}

		$result = $ability_object->execute( $input );
		if ( is_wp_error( $result ) ) {
			return $result;
		}
		if ( ! is_array( $result ) ) {
			return new WP_Error( 'wp_codebox_runtime_package_workflow_invalid_result', 'Runtime package workflow returned an invalid result.', array( 'status' => 500, 'ability' => $ability ) );
		}

		$result['metadata'] = array_merge(
			is_array( $result['metadata'] ?? null ) ? $result['metadata'] : array(),
			array(
				'workflow_ability' => $ability,
				'workflow_id'      => $ability,
			)
		);

		return $result;
	}

	/** @param array<string,mixed> $task Runtime package task. @return string|WP_Error */
	private function imported_agent_slug( array $task ): string|WP_Error {
		$package = is_array( $task['package'] ?? null ) ? $task['package'] : array();
		if ( empty( $package['bootstrap_imported'] ) ) {
			return '';
		}
		$metadata = is_array( $task['metadata'] ?? null ) ? $task['metadata'] : array();
		$slug     = $this->string_value( $metadata['imported_agent']['slug'] ?? '' );
		$bootstrap = is_array( $GLOBALS['wp_codebox_private_runtime_package_import'] ?? null ) ? $GLOBALS['wp_codebox_private_runtime_package_import'] : array();
		if ( '' === $slug || ! hash_equals( $slug, $this->string_value( $bootstrap['identity']['slug'] ?? '' ) ) || ! function_exists( 'wp_get_agent' ) || ! wp_get_agent( $slug ) ) {
			return new WP_Error( 'wp_codebox_runtime_package_imported_agent_unresolved', 'The imported runtime package agent identity did not resolve exactly.', array( 'status' => 400 ) );
		}

		return $slug;
	}


	/** @param array<string,mixed> $result Workflow result. @param array<string,mixed> $task Runtime package task. @param array<int,array<string,mixed>> $imports Import results. @return array<string,mixed> */
	private function result_with_artifact_validation( array $result, array $task, array $imports ): array {
		$artifacts   = $this->result_artifacts( $result );
		$diagnostics = is_array( $result['diagnostics'] ?? null ) ? $result['diagnostics'] : array();
		$names       = array_values( array_filter( array_map( static fn( mixed $artifact ): string => is_array( $artifact ) ? (string) ( $artifact['name'] ?? '' ) : '', $artifacts ) ) );

		foreach ( is_array( $task['required_artifacts'] ?? null ) ? $task['required_artifacts'] : array() as $required ) {
			$required = (string) $required;
			if ( '' !== $required && ! in_array( $required, $names, true ) ) {
				$diagnostics[] = array(
					'schema'   => 'wp-codebox/runtime-package-diagnostic/v1',
					'code'     => 'runtime_package_required_artifact_missing',
					'message'  => 'Runtime package result is missing required artifact: ' . $required . '.',
					'severity' => 'error',
					'path'     => 'artifacts',
				);
			}
		}

		$result['diagnostics'] = $diagnostics;
		$result['artifacts']   = $artifacts;
		$result['success']     = false === ( $result['success'] ?? true ) ? false : empty( array_filter( $diagnostics, static fn( mixed $diagnostic ): bool => is_array( $diagnostic ) && 'error' === (string) ( $diagnostic['severity'] ?? '' ) ) );
		$result['metadata']    = array_merge( is_array( $result['metadata'] ?? null ) ? $result['metadata'] : array(), array( 'agent_bundle_imports' => $imports ) );

		return $result;
	}

	/** @param array<string,mixed> $result Workflow result. @return array<int,array<string,mixed>> */
	private function result_artifacts( array $result ): array {
		$artifacts = is_array( $result['artifacts'] ?? null ) ? $result['artifacts'] : array();
		foreach ( is_array( $result['typed_artifacts'] ?? null ) ? $result['typed_artifacts'] : array() as $typed_artifact ) {
			if ( ! is_array( $typed_artifact ) ) {
				continue;
			}
			$artifacts[] = array_filter(
				array(
					'name'          => $this->string_value( $typed_artifact['output_key'] ?? $typed_artifact['name'] ?? '' ),
					'type'          => 'typed_artifact',
					'payloadSchema' => $typed_artifact['schema'] ?? null,
					'payload'       => $typed_artifact['payload'] ?? null,
				),
				static fn( mixed $value ): bool => null !== $value && '' !== $value
			);
		}

		return array_values( array_filter( $artifacts, 'is_array' ) );
	}

	private function owner_id(): int {
		return function_exists( 'get_current_user_id' ) ? max( 1, (int) get_current_user_id() ) : 1;
	}

	private function string_value( mixed $value ): string {
		return is_scalar( $value ) ? trim( (string) $value ) : '';
	}
}
