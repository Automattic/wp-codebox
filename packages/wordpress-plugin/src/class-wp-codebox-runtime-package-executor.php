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
		if ( '' === $source ) {
			return new WP_Error( 'wp_codebox_runtime_package_source_missing', 'Runtime package execution requires package.source.', array( 'status' => 400 ) );
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
		$failed  = array_values( array_filter( $imports, static fn( mixed $import ): bool => is_array( $import ) && empty( $import['success'] ) ) );
		if ( ! empty( $failed ) ) {
			return new WP_Error( 'wp_codebox_runtime_package_import_failed', 'Runtime package bundle import failed.', array( 'status' => 500, 'agent_bundle_imports' => $failed ) );
		}

		return $imports;
	}

	/** @param array<int,array<string,mixed>> $bundle_specs Runtime bundle specs. @return array<int,array<string,mixed>> */
	private function import_runtime_bundles( array $bundle_specs ): array {
		$function = function_exists( 'apply_filters' ) ? (string) apply_filters( 'wp_codebox_browser_runtime_bundle_import_function', 'wp_agent_import_runtime_bundles' ) : 'wp_agent_import_runtime_bundles';
		if ( '' !== $function && ! function_exists( $function ) && class_exists( 'WP_Codebox_Agents_API_Adapter' ) ) {
			foreach ( WP_Codebox_Agents_API_Adapter::runtime_bundle_importer_paths() as $path ) {
				if ( is_readable( $path ) ) {
					require_once $path;
					break;
				}
			}
		}
		if ( '' !== $function && function_exists( $function ) ) {
			$result = $function( $bundle_specs, array( 'owner_id' => $this->owner_id() ) );
			return is_array( $result ) ? $result : array();
		}

		$imports = array();
		foreach ( $bundle_specs as $index => $spec ) {
			$input = array(
				'source'      => (string) ( $spec['source'] ?? '' ),
				'slug'        => (string) ( $spec['slug'] ?? '' ),
				'on_conflict' => (string) ( $spec['on_conflict'] ?? 'upgrade' ),
				'owner_id'    => $this->owner_id(),
			);
			$result = function_exists( 'apply_filters' ) ? apply_filters( 'wp_agent_runtime_import_bundle', null, $spec, array_filter( $input, static fn( mixed $value ): bool => '' !== $value ), $index ) : null;
			$imports[] = is_wp_error( $result )
				? array( 'success' => false, 'index' => $index, 'source' => (string) ( $spec['source'] ?? '' ), 'error' => array( 'code' => $result->get_error_code(), 'message' => $result->get_error_message(), 'data' => $result->get_error_data() ) )
				: array_merge( array( 'success' => null !== $result, 'index' => $index, 'source' => (string) ( $spec['source'] ?? '' ) ), is_array( $result ) ? $result : array() );
		}

		return $imports;
	}

	/** @param array<string,mixed> $task Runtime package task. @return array<string,mixed>|WP_Error */
	private function execute_workflow( array $task ): array|WP_Error {
		$workflow         = is_array( $task['workflow'] ?? null ) ? $task['workflow'] : array();
		$package_workflow = $this->load_package_workflow( $task, $workflow );
		if ( is_wp_error( $package_workflow ) ) {
			return $package_workflow;
		}

		$ability = $this->workflow_ability_name( $workflow );
		$input   = $this->workflow_input( $task, $package_workflow );

		if ( '' === $ability ) {
			return new WP_Error( 'wp_codebox_runtime_package_workflow_missing', 'Runtime package workflow must resolve to a local ability.', array( 'status' => 400, 'workflow' => $workflow ) );
		}
		if ( 'wp-codebox/run-runtime-package' === $ability ) {
			return new WP_Error( 'wp_codebox_runtime_package_recursive_workflow', 'Runtime package workflows cannot invoke wp-codebox/run-runtime-package recursively.', array( 'status' => 400, 'workflow' => $workflow ) );
		}

		$ability_object = function_exists( 'wp_get_ability' ) ? wp_get_ability( $ability ) : null;
		if ( ! is_object( $ability_object ) || ! method_exists( $ability_object, 'execute' ) ) {
			return new WP_Error( 'wp_codebox_runtime_package_workflow_unavailable', 'Runtime package workflow ability is unavailable.', array( 'status' => 500, 'ability' => $ability, 'workflow' => $workflow ) );
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
				'workflow_id'      => (string) ( $package_workflow['flow']['slug'] ?? $workflow['id'] ?? '' ),
				'pipeline_id'      => (string) ( $package_workflow['pipeline']['slug'] ?? $package_workflow['flow']['pipeline_slug'] ?? '' ),
			)
		);

		return $result;
	}

	/** @param array<string,mixed> $task Runtime package task. @param array<string,mixed> $workflow Runtime workflow. @return array{manifest:array<string,mixed>,flow:array<string,mixed>,pipeline:array<string,mixed>}|WP_Error */
	private function load_package_workflow( array $task, array $workflow ): array|WP_Error {
		$package = is_array( $task['package'] ?? null ) ? $task['package'] : array();
		$root    = $this->package_root( $package );
		if ( '' === $root ) {
			return new WP_Error( 'wp_codebox_runtime_package_root_missing', 'Runtime package source must be a readable directory or file.', array( 'status' => 400, 'package' => $package ) );
		}

		$manifest = $this->read_json_file( $root . '/manifest.json' );
		if ( is_wp_error( $manifest ) ) {
			return $manifest;
		}

		$workflow_id = $this->string_value( $workflow['id'] ?? $workflow['slug'] ?? $manifest['bundle_slug'] ?? $package['slug'] ?? '' );
		if ( '' === $workflow_id ) {
			return new WP_Error( 'wp_codebox_runtime_package_workflow_id_missing', 'Runtime package workflow.id is required.', array( 'status' => 400 ) );
		}

		$flow = $this->read_json_file( $root . '/flows/' . $this->safe_slug( $workflow_id ) . '.json' );
		if ( is_wp_error( $flow ) ) {
			return $flow;
		}

		$pipeline_slug = $this->string_value( $flow['pipeline_slug'] ?? $flow['pipeline'] ?? '' );
		$pipeline      = array();
		if ( '' !== $pipeline_slug ) {
			$pipeline = $this->read_json_file( $root . '/pipelines/' . $this->safe_slug( $pipeline_slug ) . '.json' );
			if ( is_wp_error( $pipeline ) ) {
				return $pipeline;
			}
		}

		return array(
			'manifest' => $manifest,
			'flow'     => $flow,
			'pipeline' => $pipeline,
		);
	}

	/** @param array<string,mixed> $workflow Runtime package workflow. */
	private function workflow_ability_name( array $workflow ): string {
		foreach ( array( 'ability', 'ability_name', 'name', 'id' ) as $field ) {
			$value = $this->string_value( $workflow[ $field ] ?? '' );
			if ( str_contains( $value, '/' ) ) {
				return $value;
			}
		}

		return function_exists( 'apply_filters' ) ? (string) apply_filters( 'wp_codebox_runtime_package_default_workflow_ability', 'agents/chat', $workflow ) : 'agents/chat';
	}

	/** @param array<string,mixed> $task Runtime package task. @param array{manifest:array<string,mixed>,flow:array<string,mixed>,pipeline:array<string,mixed>} $package_workflow Package workflow. @return array<string,mixed> */
	private function workflow_input( array $task, array $package_workflow ): array {
		$workflow       = is_array( $task['workflow'] ?? null ) ? $task['workflow'] : array();
		$input          = is_array( $task['input'] ?? null ) ? $task['input'] : array();
		$manifest       = $package_workflow['manifest'];
		$agent_manifest = is_array( $manifest['agent'] ?? null ) ? $manifest['agent'] : array();
		$agent          = $this->string_value( $workflow['agent'] ?? $agent_manifest['slug'] ?? ( is_array( $task['package'] ?? null ) ? ( $task['package']['slug'] ?? '' ) : '' ) );
		if ( '' !== $agent && ! isset( $input['agent'] ) ) {
			$input['agent'] = $agent;
		}
		if ( ! isset( $input['message'] ) ) {
			$input['message'] = $this->runtime_flow_message( $input, $task, $package_workflow );
		}
		$input['runtime_package_flow']     = $package_workflow['flow'];
		$input['runtime_package_pipeline'] = $package_workflow['pipeline'];
		$input['runtime_package_manifest'] = $manifest;
		$input['runtime_package_task']     = $task;
		$assertions                        = $this->completion_assertions( $package_workflow['flow'], $package_workflow['pipeline'] );
		if ( ! empty( $assertions ) && ! isset( $input['completion_assertions'] ) ) {
			$input['completion_assertions'] = $assertions;
		}

		return $input;
	}

	/** @param array<string,mixed> $input Caller input. @param array<string,mixed> $task Runtime task. @param array{manifest:array<string,mixed>,flow:array<string,mixed>,pipeline:array<string,mixed>} $package_workflow Package workflow. */
	private function runtime_flow_message( array $input, array $task, array $package_workflow ): string {
		$parts = array_filter( array( $this->string_value( $input['prompt'] ?? $task['metadata']['prompt'] ?? '' ) ) );
		foreach ( is_array( $package_workflow['flow']['steps'] ?? null ) ? $package_workflow['flow']['steps'] : array() as $step ) {
			if ( ! is_array( $step ) ) {
				continue;
			}
			foreach ( is_array( $step['prompt_queue'] ?? null ) ? $step['prompt_queue'] : array() as $prompt ) {
				$text = is_array( $prompt ) ? $this->string_value( $prompt['prompt'] ?? '' ) : $this->string_value( $prompt );
				if ( '' !== $text ) {
					$parts[] = $text;
				}
			}
		}
		foreach ( is_array( $package_workflow['pipeline']['steps'] ?? null ) ? $package_workflow['pipeline']['steps'] : array() as $step ) {
			$config        = is_array( $step ) && is_array( $step['step_config'] ?? null ) ? $step['step_config'] : array();
			$system_prompt = $this->string_value( $config['system_prompt'] ?? '' );
			if ( '' !== $system_prompt ) {
				$parts[] = $system_prompt;
			}
		}

		return implode( "\n\n", array_values( array_unique( $parts ) ) );
	}

	/** @param array<string,mixed> $flow Flow config. @param array<string,mixed> $pipeline Pipeline config. @return array<string,mixed> */
	private function completion_assertions( array $flow, array $pipeline ): array {
		$required = array();
		foreach ( is_array( $pipeline['steps'] ?? null ) ? $pipeline['steps'] : array() as $step ) {
			$config     = is_array( $step ) && is_array( $step['step_config'] ?? null ) ? $step['step_config'] : array();
			$assertions = is_array( $config['completion_assertions'] ?? null ) ? $config['completion_assertions'] : array();
			foreach ( is_array( $assertions['required_artifact_outputs'] ?? null ) ? $assertions['required_artifact_outputs'] : array() as $artifact ) {
				if ( is_array( $artifact ) ) {
					$required[] = $artifact;
				}
			}
		}
		foreach ( is_array( $flow['steps'] ?? null ) ? $flow['steps'] : array() as $step ) {
			$configs        = is_array( $step ) && is_array( $step['handler_configs'] ?? null ) ? $step['handler_configs'] : array();
			$typed_artifact = is_array( $configs['typed_artifact'] ?? null ) ? $configs['typed_artifact'] : array();
			if ( ! empty( $typed_artifact ) ) {
				$required[] = $typed_artifact;
			}
		}

		return empty( $required ) ? array() : array( 'required_artifact_outputs' => array_values( $required ) );
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

	/** @param array<string,mixed> $package Package descriptor. */
	private function package_root( array $package ): string {
		$source = $this->string_value( $package['source'] ?? '' );
		if ( '' === $source || ! file_exists( $source ) ) {
			return '';
		}
		$root = is_file( $source ) ? dirname( $source ) : $source;
		$real = realpath( $root );

		return false !== $real ? $real : rtrim( $root, '/\\' );
	}

	/** @return array<string,mixed>|WP_Error */
	private function read_json_file( string $path ): array|WP_Error {
		if ( ! is_readable( $path ) ) {
			return new WP_Error( 'wp_codebox_runtime_package_file_missing', 'Runtime package file is missing or unreadable.', array( 'status' => 400, 'path' => $path ) );
		}
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents -- Runtime package files are local sandbox inputs.
		$json = file_get_contents( $path );
		$data = false !== $json ? json_decode( $json, true ) : null;
		if ( ! is_array( $data ) ) {
			return new WP_Error( 'wp_codebox_runtime_package_file_invalid', 'Runtime package file must contain a JSON object.', array( 'status' => 400, 'path' => $path ) );
		}

		return $data;
	}

	private function safe_slug( string $slug ): string {
		$slug = basename( str_replace( '\\', '/', trim( $slug ) ) );
		return preg_replace( '/[^A-Za-z0-9_.-]+/', '-', $slug ) ?? '';
	}

	private function owner_id(): int {
		return function_exists( 'get_current_user_id' ) ? max( 1, (int) get_current_user_id() ) : 1;
	}

	private function string_value( mixed $value ): string {
		return is_scalar( $value ) ? trim( (string) $value ) : '';
	}
}
