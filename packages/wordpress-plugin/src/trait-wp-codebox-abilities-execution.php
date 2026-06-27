<?php
/**
 * WP_Codebox_Abilities_Execution implementation.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

trait WP_Codebox_Abilities_Execution {
/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function run_agent_task( array $input ): array|WP_Error {
	return ( new WP_Codebox_Agent_Runtime_Invoker() )->invoke_host_task( $input );
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function run_agent_task_batch( array $input ): array|WP_Error {
	return ( new WP_Codebox_Agent_Runtime_Invoker() )->invoke_host_batch( $input );
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function run_agent_task_fanout( array $input ): array|WP_Error {
	return ( new WP_Codebox_Agent_Runtime_Invoker() )->invoke_host_fanout( $input );
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function run_runtime_package( array $input ): array|WP_Error {
	$task = self::normalize_runtime_package_task_input( $input );
	if ( is_wp_error( $task ) ) {
		return $task;
	}

	$result = WP_Codebox_Runtime_Provider_Registry::invoke( $task );
	if ( is_wp_error( $result ) ) {
		return $result;
	}

	return self::normalize_runtime_package_result( $result, $task );
}

/** @param array<string,mixed> $input Runtime package input. @return array<string,mixed>|WP_Error */
private static function normalize_runtime_package_task_input( array $input ): array|WP_Error {
	if ( 'wp-codebox/runtime-package-task/v1' === (string) ( $input['schema'] ?? '' ) ) {
		$invalid = self::runtime_package_task_validation_errors( $input );
		if ( ! empty( $invalid ) ) {
			return new WP_Error( 'wp_codebox_runtime_package_task_invalid', 'Runtime package task does not match wp-codebox/runtime-package-task/v1.', array( 'status' => 400, 'diagnostics' => $invalid ) );
		}

		return $input;
	}

	return self::legacy_runtime_package_task_input( $input );
}

/** @param array<string,mixed> $input Legacy runtime package input. @return array<string,mixed>|WP_Error */
private static function legacy_runtime_package_task_input( array $input ): array|WP_Error {
	$metadata   = is_array( $input['metadata'] ?? null ) ? $input['metadata'] : array();
	$descriptor = is_array( $input['package'] ?? null ) ? $input['package'] : ( is_array( $metadata['runtime_package_descriptor'] ?? null ) ? $metadata['runtime_package_descriptor'] : array() );
	if ( empty( $descriptor ) && isset( $input['runtime_package'] ) ) {
		$descriptor = self::runtime_package_descriptor_from_legacy_string( (string) $input['runtime_package'] );
	}

	$package = self::runtime_package_descriptor_for_task( $descriptor, $input );
	if ( '' === (string) ( $package['slug'] ?? '' ) || '' === (string) ( $package['source'] ?? '' ) ) {
		return new WP_Error( 'wp_codebox_runtime_package_task_invalid', 'Runtime package task requires package.slug and package.source.', array( 'status' => 400 ) );
	}

	$workflow_id = self::runtime_package_string_value( $input['workflow_id'] ?? $input['workflowId'] ?? ( is_array( $input['workflow'] ?? null ) ? ( $input['workflow']['id'] ?? '' ) : '' ) );
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
		'required_artifacts'    => self::runtime_package_required_artifacts( $input ),
		'metadata'              => $metadata,
	) + array_intersect_key( $input, array_flip( array( 'runtime_provider', 'runtime_provider_id', 'provider', 'model', 'options', 'task_input' ) ) );
}

/** @param array<string,mixed> $task Runtime package task. @return array<int,array<string,mixed>> */
private static function runtime_package_task_validation_errors( array $task ): array {
	$errors = array();
	foreach ( array( 'schema', 'package', 'workflow', 'input', 'artifact_declarations', 'required_artifacts' ) as $field ) {
		if ( ! array_key_exists( $field, $task ) ) {
			$errors[] = self::runtime_package_diagnostic( 'runtime_package_task_missing_field', 'Runtime package task is missing required field: ' . $field . '.', $field );
		}
	}
	if ( ! is_array( $task['package'] ?? null ) || '' === self::runtime_package_string_value( $task['package']['slug'] ?? '' ) || '' === self::runtime_package_string_value( $task['package']['source'] ?? '' ) ) {
		$errors[] = self::runtime_package_diagnostic( 'runtime_package_task_invalid_package', 'Runtime package task requires package.slug and package.source.', 'package' );
	}
	if ( is_array( $task['package'] ?? null ) && self::runtime_package_is_workspace_relative_source( (string) ( $task['package']['source'] ?? '' ) ) ) {
		$errors[] = self::runtime_package_diagnostic( 'runtime_package_workspace_root_required', 'Workspace-relative package.source requires explicit workspace root normalization before execution.', 'package.source' );
	}
	if ( ! is_array( $task['workflow'] ?? null ) || '' === self::runtime_package_string_value( $task['workflow']['id'] ?? '' ) ) {
		$errors[] = self::runtime_package_diagnostic( 'runtime_package_task_invalid_workflow', 'Runtime package task requires workflow.id.', 'workflow.id' );
	}
	if ( ! is_array( $task['input'] ?? null ) ) {
		$errors[] = self::runtime_package_diagnostic( 'runtime_package_task_invalid_input', 'Runtime package task requires input object.', 'input' );
	}
	if ( ! is_array( $task['artifact_declarations'] ?? null ) ) {
		$errors[] = self::runtime_package_diagnostic( 'runtime_package_task_invalid_artifact_declarations', 'Runtime package task requires artifact_declarations array.', 'artifact_declarations' );
	}
	if ( ! is_array( $task['required_artifacts'] ?? null ) ) {
		$errors[] = self::runtime_package_diagnostic( 'runtime_package_task_invalid_required_artifacts', 'Runtime package task requires required_artifacts array.', 'required_artifacts' );
	}

	return $errors;
}

/** @param array<string,mixed> $input Runtime package input. @return string[] */
private static function runtime_package_required_artifacts( array $input ): array {
	if ( is_array( $input['required_artifacts'] ?? null ) ) {
		return array_values( array_unique( array_filter( array_map( 'strval', $input['required_artifacts'] ) ) ) );
	}

	$required = array();
	foreach ( is_array( $input['artifact_declarations'] ?? null ) ? $input['artifact_declarations'] : array() as $artifact ) {
		if ( is_array( $artifact ) && true === ( $artifact['required'] ?? false ) && 'input' !== (string) ( $artifact['direction'] ?? 'output' ) ) {
			$name = self::runtime_package_string_value( $artifact['name'] ?? '' );
			if ( '' !== $name ) {
				$required[] = $name;
			}
		}
	}

	return array_values( array_unique( $required ) );
}

/** @param array<string,mixed> $result Provider result. @param array<string,mixed> $task Runtime package task. @return array<string,mixed> */
private static function normalize_runtime_package_result( array $result, array $task ): array {
	$diagnostics = self::runtime_package_diagnostics( $result['diagnostics'] ?? array() );
	$failed      = false === ( $result['success'] ?? true ) || 'failed' === (string) ( $result['status'] ?? '' ) || self::runtime_package_has_error_diagnostic( $diagnostics );
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
		'package'     => is_array( $result['package'] ?? null ) ? self::runtime_package_descriptor_for_task( $result['package'], $task ) : $task['package'],
		'outputs'     => is_array( $result['outputs'] ?? null ) ? $result['outputs'] : self::runtime_package_semantic_outputs( $result ),
		'artifacts'   => self::runtime_package_artifacts( $result['artifacts'] ?? array() ),
		'diagnostics' => $diagnostics,
		'metadata'    => $metadata,
	);
}

/** @param array<string,mixed> $descriptor Package descriptor. @param array<string,mixed> $input Runtime package input. @return array<string,string> */
private static function runtime_package_descriptor_for_task( array $descriptor, array $input ): array {
	$slug   = self::runtime_package_string_value( $descriptor['slug'] ?? $descriptor['id'] ?? '' );
	$source = self::runtime_package_string_value( $descriptor['source'] ?? '' );
	if ( '' !== $source && self::runtime_package_is_workspace_relative_source( $source ) ) {
		foreach ( self::runtime_package_workspace_roots( $input ) as $root ) {
			$candidate = rtrim( $root, '/\\' ) . '/' . ltrim( $source, '/\\' );
			if ( file_exists( $candidate ) ) {
				$source = $candidate;
				break;
			}
		}
	}
	if ( '' === $slug && '' !== $source ) {
		$slug = self::runtime_package_slug_from_source( $source );
	}

	return array( 'slug' => $slug, 'source' => $source );
}

/** @return array<string,string> */
private static function runtime_package_descriptor_from_legacy_string( string $runtime_package ): array {
	$runtime_package = trim( $runtime_package );
	if ( '' === $runtime_package ) {
		return array( 'slug' => '', 'source' => '' );
	}

	return array( 'slug' => self::runtime_package_slug_from_source( $runtime_package ), 'source' => $runtime_package );
}

/** @param mixed $value Diagnostics value. @return array<int,array<string,mixed>> */
private static function runtime_package_diagnostics( mixed $value ): array {
	if ( ! is_array( $value ) ) {
		return array();
	}

	$diagnostics = array();
	foreach ( $value as $diagnostic ) {
		if ( ! is_array( $diagnostic ) ) {
			continue;
		}
		$diagnostics[] = self::runtime_package_diagnostic(
			self::runtime_package_string_value( $diagnostic['code'] ?? 'runtime_package_diagnostic' ),
			self::runtime_package_string_value( $diagnostic['message'] ?? 'Runtime package diagnostic.' ),
			self::runtime_package_string_value( $diagnostic['path'] ?? '' ),
			in_array( (string) ( $diagnostic['severity'] ?? '' ), array( 'info', 'warning', 'error' ), true ) ? (string) $diagnostic['severity'] : 'error',
			is_array( $diagnostic['details'] ?? null ) ? $diagnostic['details'] : array()
		);
	}

	return $diagnostics;
}

/** @param array<int,mixed> $value Artifact value. @return array<int,array<string,mixed>> */
private static function runtime_package_artifacts( mixed $value ): array {
	if ( ! is_array( $value ) ) {
		return array();
	}

	$artifacts = array();
	foreach ( $value as $artifact ) {
		if ( is_array( $artifact ) && '' !== self::runtime_package_string_value( $artifact['name'] ?? '' ) ) {
			$artifacts[] = $artifact;
		}
	}

	return $artifacts;
}

/** @param array<string,mixed> $result Provider result. @return array<string,mixed> */
private static function runtime_package_semantic_outputs( array $result ): array {
	$outputs = array();
	foreach ( array( 'result', 'summary', 'data', 'semantic_outputs', 'structured_outputs' ) as $field ) {
		if ( array_key_exists( $field, $result ) ) {
			$outputs[ $field ] = $result[ $field ];
		}
	}

	return $outputs;
}

/** @param array<int,array<string,mixed>> $diagnostics Diagnostics. */
private static function runtime_package_has_error_diagnostic( array $diagnostics ): bool {
	foreach ( $diagnostics as $diagnostic ) {
		if ( 'error' === (string) ( $diagnostic['severity'] ?? '' ) ) {
			return true;
		}
	}

	return false;
}

/** @param array<string,mixed> $details Diagnostic details. @return array<string,mixed> */
private static function runtime_package_diagnostic( string $code, string $message, string $path = '', string $severity = 'error', array $details = array() ): array {
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
private static function runtime_package_workspace_roots( array $input ): array {
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

private static function runtime_package_is_workspace_relative_source( string $source ): bool {
	return '' !== $source && ( str_contains( $source, '/' ) || str_contains( $source, '\\' ) ) && ! str_starts_with( $source, '/' ) && 1 !== preg_match( '#^[a-z][a-z0-9+.-]*://#i', $source ) && 1 !== preg_match( '#^[A-Za-z]:[\\/]#', $source );
}

private static function runtime_package_slug_from_source( string $source ): string {
	$source = str_replace( '\\', '/', rtrim( trim( $source ), '/\\' ) );
	$slug   = basename( $source );

	return '' !== $slug ? $slug : $source;
}

private static function runtime_package_string_value( mixed $value ): string {
	return is_scalar( $value ) ? trim( (string) $value ) : '';
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed> */
public static function resolve_runtime_requirements( array $input ): array {
	return WP_Codebox_Runtime_Provider_Registry::resolve_runtime_requirements( $input );
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function run_runtime_task( array $input ): array|WP_Error {
	return ( new WP_Codebox_Runtime_Task_Runner() )->run( $input );
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function run_wordpress_workload( array $input ): array|WP_Error {
	$unsafe = self::unsafe_execution_fields( $input );
	if ( ! empty( $unsafe ) ) {
		return new WP_Error( 'wp_codebox_wordpress_workload_unsafe_input', 'wp-codebox/run-wordpress-workload does not accept raw code execution fields.', array( 'status' => 400, 'unsafe_fields' => $unsafe ) );
	}

	return ( new WP_Codebox_WordPress_Workload_Runner() )->run( $input );
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function run_fuzz_suite( array $input ): array|WP_Error {
	$unsafe = self::unsafe_execution_fields( $input );
	if ( ! empty( $unsafe ) ) {
		return new WP_Error( 'wp_codebox_fuzz_suite_unsafe_input', 'wp-codebox/run-fuzz-suite does not accept raw code execution fields.', array( 'status' => 400, 'unsafe_fields' => $unsafe ) );
	}

	$cases = is_array( $input['cases'] ?? null ) ? $input['cases'] : array();
	$runner_capabilities = self::fuzz_suite_php_runner_capabilities( $input );
	$missing_capabilities = self::fuzz_suite_missing_required_capabilities( $input, $runner_capabilities );
	$requested_runner_mode = self::fuzz_suite_requested_runner_mode( $input );
	if ( 'php-in-process' !== $requested_runner_mode ) {
		return self::fuzz_suite_runner_capability_error_result(
			$input,
			$cases,
			$runner_capabilities,
			self::fuzz_suite_diagnostic(
				'error',
				'wp_codebox_fuzz_suite_runner_mode_unavailable',
				'wp-codebox/run-fuzz-suite is an in-process WordPress ability only; use wp-codebox run-fuzz-suite --runner-mode=runtime-backed or @automattic/wp-codebox-playground/public executeWordPressFuzzSuite for browser, editor, page, CRUD, runtime, or runtime-action coverage.',
				array( 'requested_runner_mode' => $requested_runner_mode, 'available_runner_mode' => $runner_capabilities['mode'], 'missing_capabilities' => $missing_capabilities, 'runtime_backed_execution' => self::fuzz_suite_runtime_backed_execution_contract(), 'required_support' => array( 'cli' => 'wp-codebox run-fuzz-suite --runner-mode=runtime-backed', 'typescript_public_facade' => '@automattic/wp-codebox-playground/public executeWordPressFuzzSuite', 'episode_methods' => array( 'step', 'reset' ) ) )
			)
		);
	}
	if ( self::fuzz_suite_require_coverage( $input ) && ! empty( $missing_capabilities ) ) {
		return self::fuzz_suite_runner_capability_error_result(
			$input,
			$cases,
			$runner_capabilities,
			self::fuzz_suite_diagnostic( 'error', 'wp_codebox_fuzz_suite_required_runner_capabilities_unsupported', 'Fuzz suite requires runner capabilities that are not available in PHP in-process mode.', array( 'missing_capabilities' => $missing_capabilities, 'runner_mode' => $runner_capabilities['mode'] ) )
		);
	}
	$results = array();
	$diagnostics = array();
	$artifact_refs = array();

	foreach ( $cases as $index => $case ) {
		if ( ! is_array( $case ) ) {
			$diagnostic = self::fuzz_suite_diagnostic( 'error', 'wp_codebox_fuzz_case_invalid', 'Fuzz suite case must be an object.', array( 'case_index' => $index ) );
			$diagnostics[] = $diagnostic;
			$results[] = self::fuzz_suite_case_result( 'case-' . (string) $index, 'error', array( $diagnostic ) );
			continue;
		}

		$result = self::execute_fuzz_suite_case( $case, $input, $index );
		$results[] = $result;
		foreach ( $result['diagnostics'] ?? array() as $diagnostic ) {
			$diagnostics[] = $diagnostic;
		}
		foreach ( $result['artifactRefs'] ?? array() as $artifact_ref ) {
			$artifact_refs[] = $artifact_ref;
		}
	}

	$summary = self::fuzz_suite_summary( $results );
	$status = self::fuzz_suite_status( $summary );

	return array(
		'success'      => 'passed' === $status,
		'schema'       => 'wp-codebox/fuzz-suite-result/v1',
		'status'       => $status,
		'suite'        => array_filter(
			array(
				'id'      => (string) ( $input['id'] ?? '' ),
				'version' => (string) ( $input['version'] ?? '' ),
			),
			static fn( mixed $value ): bool => '' !== $value
		),
		'summary'      => $summary,
		'cases'        => $results,
		'diagnostics'  => $diagnostics,
		'artifactRefs' => self::dedupe_fuzz_suite_artifact_refs( $artifact_refs ),
		'metadata'     => array( 'canonical_ability' => 'wp-codebox/run-fuzz-suite', 'runner' => 'wp-codebox/fuzz-suite-runner/v1', 'runnerCapabilities' => $runner_capabilities ),
	);
}

/** @param array<string,mixed> $suite Suite input. @param array<int,mixed> $cases Suite cases. @param array<string,mixed> $runner_capabilities Runner capabilities. @param array<string,mixed> $diagnostic Diagnostic. @return array<string,mixed> */
private static function fuzz_suite_runner_capability_error_result( array $suite, array $cases, array $runner_capabilities, array $diagnostic ): array {
	$results = array();
	foreach ( $cases as $index => $case ) {
		$case_id = is_array( $case ) ? (string) ( $case['id'] ?? $case['case_id'] ?? ( 'case-' . (string) $index ) ) : ( 'case-' . (string) $index );
		$results[] = self::fuzz_suite_case_result( $case_id, 'skipped', array( $diagnostic ) );
	}

	return array(
		'success'      => false,
		'schema'       => 'wp-codebox/fuzz-suite-result/v1',
		'status'       => 'error',
		'suite'        => array_filter( array( 'id' => (string) ( $suite['id'] ?? '' ), 'version' => (string) ( $suite['version'] ?? '' ) ), static fn( mixed $value ): bool => '' !== $value ),
		'summary'      => self::fuzz_suite_summary( $results ),
		'cases'        => $results,
		'diagnostics'  => array( $diagnostic ),
		'artifactRefs' => array(),
		'metadata'     => array( 'canonical_ability' => 'wp-codebox/run-fuzz-suite', 'runner' => 'wp-codebox/fuzz-suite-runner/v1', 'runnerCapabilities' => $runner_capabilities ),
	);
}

/** @param array<string,mixed> $suite Optional suite input. @return array<string,mixed> */
private static function fuzz_suite_php_runner_capabilities( array $suite = array() ): array {
	return self::fuzz_suite_runner_capabilities_contract( $suite );
}

/** @return array<string,array<string,mixed>> */
private static function fuzz_suite_supported_runner_capabilities(): array {
	return array(
		'php-in-process' => self::fuzz_suite_runner_capabilities_contract(),
		'runtime-backed' => self::fuzz_suite_runtime_backed_runner_capabilities_contract(),
	);
}

/** @return array<string,mixed> */
private static function fuzz_suite_runtime_backed_execution_contract(): array {
	return array(
		'supported_by_this_ability' => false,
		'ability_execution_mode'    => 'php-in-process-only',
		'public_runtime_backed_path' => 'wp-codebox run-fuzz-suite --runner-mode=runtime-backed',
		'supported_public_facade'   => '@automattic/wp-codebox-playground/public executeWordPressFuzzSuite',
		'required_episode_methods'  => array( 'step', 'reset' ),
		'failure_code'              => 'wp_codebox_fuzz_suite_runner_mode_unavailable',
	);
}

/** @param array<string,mixed> $suite Optional suite input. @return array<string,mixed> */
private static function fuzz_suite_runner_capabilities_contract( array $suite = array() ): array {
	$capabilities = array(
		'schema'                          => 'wp-codebox/fuzz-runner-capabilities/v1',
		'mode'                            => 'php-in-process',
		'capabilities'                    => array( 'target:ability', 'target:http', 'target:rest' ),
		'targetKinds'                     => array( 'ability', 'http', 'rest' ),
		'unsupportedRequiredCapabilities' => array(),
	);
	if ( ! empty( $suite ) ) {
		$capabilities['unsupportedRequiredCapabilities'] = self::fuzz_suite_missing_required_capabilities( $suite, $capabilities );
	}
	return array(
		'schema'                          => $capabilities['schema'],
		'mode'                            => $capabilities['mode'],
		'capabilities'                    => $capabilities['capabilities'],
		'targetKinds'                     => $capabilities['targetKinds'],
		'unsupportedRequiredCapabilities' => $capabilities['unsupportedRequiredCapabilities'],
	);
}

/** @param array<string,mixed> $suite Optional suite input. @return array<string,mixed> */
private static function fuzz_suite_runtime_backed_runner_capabilities_contract( array $suite = array() ): array {
	$capabilities = array(
		'schema'                          => 'wp-codebox/fuzz-runner-capabilities/v1',
		'mode'                            => 'runtime-backed',
		'capabilities'                    => array( 'target:ability', 'target:command', 'target:http', 'target:rest', 'target:runtime', 'target:runtime-action', 'runtime', 'runtime-action:admin_page', 'runtime-action:browser', 'runtime-action:browser_probe', 'runtime-action:crud_operation', 'runtime-action:db_operation', 'runtime-action:editor_open', 'runtime-action:page', 'runtime-action:php', 'runtime-action:rest_request', 'runtime-action:wp_cli', 'db_operation' ),
		'targetKinds'                     => array( 'ability', 'command', 'http', 'rest', 'runtime', 'runtime-action' ),
		'runtimeActionTypes'              => array( 'admin_page', 'browser', 'browser_probe', 'crud_operation', 'db_operation', 'editor_open', 'page', 'php', 'rest_request', 'wp_cli' ),
		'commands'                        => array( 'wp-codebox.checkpoint-create', 'wp-codebox.checkpoint-list', 'wp-codebox.checkpoint-restore', 'wordpress.ability', 'wordpress.admin-page-load', 'wordpress.browser-actions', 'wordpress.browser-page-load', 'wordpress.browser-probe', 'wordpress.crud-operation', 'wordpress.db-operation', 'wordpress.editor-open', 'wordpress.ensure-plugin-active', 'wordpress.frontend-page-load', 'wordpress.http-request', 'wordpress.plugin-state', 'wordpress.rest-performance-observation', 'wordpress.rest-request', 'wordpress.run-php', 'wordpress.run-workload', 'wordpress.server-page-load', 'wordpress.simulated-admin-page-load', 'wordpress.simulated-frontend-page-load', 'wordpress.wp-cli' ),
		'unsupportedRequiredCapabilities' => array(),
	);
	if ( ! empty( $suite ) ) {
		$capabilities['unsupportedRequiredCapabilities'] = self::fuzz_suite_missing_required_capabilities( $suite, $capabilities );
	}
	return $capabilities;
}

/** @param array<string,mixed> $suite Suite input. */
private static function fuzz_suite_require_coverage( array $suite ): bool {
	return true === ( $suite['requireCoverage'] ?? $suite['require_coverage'] ?? false );
}

/** @param array<string,mixed> $suite Suite input. */
private static function fuzz_suite_requested_runner_mode( array $suite ): string {
	$metadata = is_array( $suite['metadata'] ?? null ) ? $suite['metadata'] : array();
	$mode = (string) ( $suite['runnerMode'] ?? $suite['runner_mode'] ?? $metadata['runnerMode'] ?? $metadata['runner_mode'] ?? 'php-in-process' );
	return '' === $mode || 'auto' === $mode ? 'php-in-process' : $mode;
}

/** @param array<string,mixed> $suite Suite input. @param array<string,mixed> $runner_capabilities Runner capabilities. @return string[] */
private static function fuzz_suite_missing_required_capabilities( array $suite, array $runner_capabilities ): array {
	$required = self::fuzz_suite_required_capabilities( $suite );
	$available = array_fill_keys( array_map( 'strval', $runner_capabilities['capabilities'] ?? array() ), true );
	foreach ( (array) ( $runner_capabilities['targetKinds'] ?? array() ) as $kind ) {
		$available[ 'target:' . (string) $kind ] = true;
	}
	foreach ( (array) ( $runner_capabilities['runtimeActionTypes'] ?? array() ) as $type ) {
		$available[ 'runtime-action:' . (string) $type ] = true;
	}
	foreach ( (array) ( $runner_capabilities['commands'] ?? array() ) as $command ) {
		$available[ 'command:' . (string) $command ] = true;
	}
	return array_values( array_filter( $required, static fn( string $capability ): bool => ! isset( $available[ $capability ] ) ) );
}

/** @param array<string,mixed> $suite Suite input. @return string[] */
private static function fuzz_suite_required_capabilities( array $suite ): array {
	$metadata = is_array( $suite['metadata'] ?? null ) ? $suite['metadata'] : array();
	$required = is_array( $metadata['requiredRunnerCapabilities'] ?? null ) ? $metadata['requiredRunnerCapabilities'] : ( is_array( $metadata['required_runner_capabilities'] ?? null ) ? $metadata['required_runner_capabilities'] : array() );
	$capabilities = array_map( 'strval', is_array( $required['capabilities'] ?? null ) ? $required['capabilities'] : array() );
	$capabilities = array_merge( $capabilities, self::fuzz_suite_declared_target_capabilities( $suite ) );
	foreach ( is_array( $required['targetKinds'] ?? null ) ? $required['targetKinds'] : ( is_array( $required['target_kinds'] ?? null ) ? $required['target_kinds'] : array() ) as $kind ) {
		$capabilities[] = 'target:' . (string) $kind;
	}
	foreach ( is_array( $required['runtimeActionTypes'] ?? null ) ? $required['runtimeActionTypes'] : ( is_array( $required['runtime_action_types'] ?? null ) ? $required['runtime_action_types'] : array() ) as $type ) {
		$capabilities[] = 'runtime-action:' . (string) $type;
	}
	foreach ( ( is_array( $required['commands'] ?? null ) ? $required['commands'] : array() ) as $command ) {
		$capabilities[] = 'command:' . (string) $command;
	}
	return array_values( array_unique( array_filter( $capabilities, static fn( string $capability ): bool => '' !== $capability ) ) );
}

/** @param array<string,mixed> $suite Suite input. @return string[] */
private static function fuzz_suite_declared_target_capabilities( array $suite ): array {
	$capabilities = array();
	$targets = array();
	if ( is_array( $suite['target'] ?? null ) ) {
		$targets[] = $suite['target'];
	}
	foreach ( is_array( $suite['cases'] ?? null ) ? $suite['cases'] : array() as $case ) {
		if ( is_array( $case ) && is_array( $case['target'] ?? null ) ) {
			$targets[] = $case['target'];
		}
	}

	foreach ( $targets as $target ) {
		$kind = (string) ( $target['kind'] ?? '' );
		if ( '' !== $kind ) {
			$capabilities[] = 'target:' . $kind;
		}
	}

	foreach ( is_array( $suite['cases'] ?? null ) ? $suite['cases'] : array() as $case ) {
		if ( ! is_array( $case ) ) {
			continue;
		}
		$target = is_array( $case['target'] ?? null ) ? $case['target'] : ( is_array( $suite['target'] ?? null ) ? $suite['target'] : array() );
		if ( 'runtime-action' !== (string) ( $target['kind'] ?? '' ) ) {
			continue;
		}
		$input = is_array( $case['input'] ?? null ) ? $case['input'] : array();
		$type = (string) ( $input['type'] ?? '' );
		if ( '' !== $type ) {
			$capabilities[] = 'runtime-action:' . $type;
		}
	}

	return array_values( array_unique( array_filter( $capabilities, static fn( string $capability ): bool => '' !== $capability ) ) );
}

/** @param array<string,mixed> $case Fuzz case. @param array<string,mixed> $suite Suite input. @return array<string,mixed> */
private static function execute_fuzz_suite_case( array $case, array $suite, int $index ): array {
	$case_id = (string) ( $case['id'] ?? $case['case_id'] ?? ( 'case-' . (string) $index ) );
	$diagnostics = array();
	$artifacts = self::fuzz_suite_declared_artifact_refs( $case );
	$steps = self::fuzz_suite_case_steps( $case );

	if ( empty( $steps ) ) {
		$target = is_array( $case['target'] ?? null ) ? $case['target'] : ( is_array( $suite['target'] ?? null ) ? $suite['target'] : array() );
		$steps = array( self::fuzz_suite_target_step( $case, $target ) );
	}

	$status = 'passed';
	$observations = array();
	foreach ( $steps as $step_index => $step ) {
		if ( ! is_array( $step ) ) {
			$diagnostic = self::fuzz_suite_diagnostic( 'error', 'wp_codebox_fuzz_step_invalid', 'Fuzz suite step must be an object.', array( 'case_id' => $case_id, 'step_index' => $step_index ) );
			$diagnostics[] = $diagnostic;
			$status = 'error';
			break;
		}

		$step_result = self::execute_fuzz_suite_step( $step, $case, $suite, $case_id, $observations );
		$observations[] = $step_result['observation'];
		foreach ( $step_result['artifactRefs'] ?? array() as $artifact_ref ) {
			$artifacts[] = $artifact_ref;
		}
		if ( ! empty( $step_result['diagnostic'] ) ) {
			$diagnostics[] = $step_result['diagnostic'];
		}
		if ( 'passed' !== $step_result['status'] ) {
			$status = $step_result['status'];
			if ( 'skipped' !== $status ) {
				break;
			}
		}
	}

	return self::fuzz_suite_case_result( $case_id, $status, $diagnostics, $artifacts, array( 'observations' => $observations ) );
}

/** @param array<string,mixed> $case Fuzz case. @return array<int,array<string,mixed>> */
private static function fuzz_suite_case_steps( array $case ): array {
	$steps = array();
	$phases = is_array( $case['phases'] ?? null ) ? $case['phases'] : array();
	foreach ( array( 'setup', 'action', 'assert' ) as $phase ) {
		foreach ( is_array( $phases[ $phase ] ?? null ) ? $phases[ $phase ] : array() as $step ) {
			if ( is_array( $step ) ) {
				$step['phase'] = $phase;
			}
			$steps[] = $step;
		}
	}
	return $steps;
}

/** @param array<string,mixed> $case Fuzz case. @param array<string,mixed> $target Target. @return array<string,mixed> */
private static function fuzz_suite_target_step( array $case, array $target ): array {
	$kind = (string) ( $target['kind'] ?? '' );
	$entrypoint = (string) ( $target['entrypoint'] ?? $target['id'] ?? '' );
	$input = $case['input'] ?? array();
	$args = is_array( $input['args'] ?? null ) ? $input['args'] : array();
	if ( empty( $args ) && is_array( $input ) ) {
		if ( 'rest' === $kind ) {
			$args = self::fuzz_suite_args_from_map( array( 'path' => $input['path'] ?? $input['route'] ?? $entrypoint, 'method' => $input['method'] ?? 'GET', 'params-json' => $input['params'] ?? null, 'headers-json' => $input['headers'] ?? null, 'body-json' => $input['bodyJson'] ?? $input['body_json'] ?? null ) );
		} elseif ( 'http' === $kind ) {
			$args = self::fuzz_suite_args_from_map( array( 'url' => $input['url'] ?? $input['path'] ?? $entrypoint, 'method' => $input['method'] ?? 'GET', 'headers-json' => $input['headers'] ?? null, 'body' => $input['body'] ?? null ) );
		} elseif ( 'ability' === $kind ) {
			$args = self::fuzz_suite_args_from_map( array( 'name' => $entrypoint, 'input' => $input['input'] ?? $input['payload'] ?? null ) );
		} elseif ( 'runtime-action' === $kind ) {
			return self::fuzz_suite_runtime_action_step( $input );
		}
	}
	$command = match ( $kind ) {
		'rest' => 'wordpress.rest-request',
		'http' => 'wordpress.http-request',
		'ability' => 'wordpress.ability',
		default => $entrypoint,
	};
	return array_filter( array( 'command' => $command, 'args' => $args, 'targetKind' => $kind, 'targetId' => $entrypoint ), static fn( mixed $value ): bool => '' !== $value && ! ( is_array( $value ) && empty( $value ) ) );
}

/** @param array<string,mixed> $input Runtime action input. @return array<string,mixed> */
private static function fuzz_suite_runtime_action_step( array $input ): array {
	$type = (string) ( $input['type'] ?? '' );
	if ( 'rest_request' === $type ) {
		return array(
			'command' => 'wordpress.rest-request',
			'args'    => self::fuzz_suite_args_from_map( array( 'path' => $input['path'] ?? $input['route'] ?? null, 'method' => $input['method'] ?? 'GET', 'params-json' => $input['params'] ?? null, 'headers-json' => $input['headers'] ?? null, 'body-json' => $input['bodyJson'] ?? $input['body_json'] ?? null ) ),
		);
	}
	if ( 'wp_cli' === $type ) {
		return array(
			'command' => 'wordpress.wp-cli',
			'args'    => self::fuzz_suite_args_from_map( array( 'command' => $input['command'] ?? null ) ),
			'action'  => $type,
		);
	}
	if ( 'php' === $type ) {
		return array(
			'command' => 'wordpress.run-php',
			'action'  => $type,
		);
	}
	if ( 'browser' === $type ) {
		return array(
			'command' => 'wordpress.browser-actions',
			'args'    => self::fuzz_suite_browser_action_args( $input ),
			'action'  => $type,
		);
	}
	if ( 'browser_probe' === $type ) {
		return array(
			'command' => 'wordpress.browser-probe',
			'args'    => self::fuzz_suite_args_from_map( array( 'url' => $input['url'] ?? null, 'wait-for' => $input['wait_for'] ?? $input['waitFor'] ?? null, 'duration' => $input['duration'] ?? null, 'capture' => self::fuzz_suite_csv_arg( $input['capture'] ?? null ), 'viewport' => $input['viewport'] ?? null ) ),
			'action'  => $type,
		);
	}
	if ( 'editor_open' === $type ) {
		return array(
			'command' => 'wordpress.editor-open',
			'args'    => self::fuzz_suite_args_from_map( array( 'target' => $input['target'] ?? null, 'post-id' => $input['post_id'] ?? $input['postId'] ?? null, 'post-type' => $input['post_type'] ?? $input['postType'] ?? null, 'url' => $input['url'] ?? null, 'wait-selector' => $input['wait_selector'] ?? $input['waitSelector'] ?? null, 'wait-timeout' => isset( $input['timeout_ms'] ) ? ( (string) $input['timeout_ms'] . 'ms' ) : ( isset( $input['timeoutMs'] ) ? ( (string) $input['timeoutMs'] . 'ms' ) : null ), 'capture' => self::fuzz_suite_csv_arg( $input['capture'] ?? null ) ) ),
			'action'  => $type,
		);
	}
	if ( 'admin_page' === $type || 'page' === $type ) {
		return array(
			'command' => 'admin_page' === $type ? 'wordpress.admin-page-load' : 'wordpress.frontend-page-load',
			'args'    => self::fuzz_suite_args_from_map( array( 'path' => $input['path'] ?? null, 'url' => $input['url'] ?? null, 'method' => $input['method'] ?? null, 'query-json' => $input['query'] ?? null, 'body-json' => $input['body'] ?? null, 'user' => $input['user'] ?? null, 'session' => $input['session'] ?? null, 'capture-diagnostics' => self::fuzz_suite_csv_arg( $input['capture_diagnostics'] ?? $input['captureDiagnostics'] ?? null ) ) ),
			'action'  => $type,
		);
	}
	return array( 'command' => 'wordpress.runtime-action', 'args' => self::fuzz_suite_args_from_map( array( 'type' => $type ) ), 'action' => $type );
}

/** @param array<string,mixed> $input Runtime browser action input. @return string[] */
private static function fuzz_suite_browser_action_args( array $input ): array {
	$operation = (string) ( $input['operation'] ?? '' );
	$step = array_filter(
		array(
			'kind'     => 'wait' === $operation ? 'waitFor' : $operation,
			'url'      => $input['url'] ?? null,
			'selector' => $input['selector'] ?? null,
			'text'     => $input['text'] ?? null,
			'value'    => $input['value'] ?? null,
			'key'      => $input['key'] ?? null,
			'duration' => $input['duration'] ?? null,
			'waitFor'  => $input['wait_for'] ?? $input['waitFor'] ?? null,
			'capture'  => 'capture' === $operation && is_array( $input['capture'] ?? null ) ? $input['capture'] : null,
		),
		static fn( mixed $value ): bool => null !== $value && '' !== $value
	);

	return self::fuzz_suite_args_from_map( array( 'url' => ( isset( $input['url'] ) && 'navigate' !== $operation ) ? $input['url'] : null, 'steps-json' => array( $step ), 'capture' => self::fuzz_suite_csv_arg( $input['capture'] ?? null ) ) );
}

private static function fuzz_suite_csv_arg( mixed $value ): ?string {
	return is_array( $value ) && ! empty( $value ) ? implode( ',', array_map( 'strval', $value ) ) : null;
}

/** @param array<string,mixed> $values Values. @return string[] */
private static function fuzz_suite_args_from_map( array $values ): array {
	$args = array();
	foreach ( $values as $key => $value ) {
		if ( null === $value || '' === $value ) {
			continue;
		}
		$args[] = (string) $key . '=' . ( is_array( $value ) || is_object( $value ) ? wp_json_encode( $value ) : (string) $value );
	}
	return $args;
}

/** @param array<string,mixed> $step Step. @param array<string,mixed> $case Case. @param array<string,mixed> $suite Suite. @return array<string,mixed> */
private static function execute_fuzz_suite_step( array $step, array $case, array $suite, string $case_id, array $prior_observations = array() ): array {
	$command = (string) ( $step['command'] ?? '' );
	$args = self::fuzz_suite_parse_args( is_array( $step['args'] ?? null ) ? $step['args'] : array() );
	$observation = array_filter(
		array(
			'command'    => $command,
			'phase'      => (string) ( $step['phase'] ?? '' ),
			'targetKind' => (string) ( $step['targetKind'] ?? '' ),
			'targetId'   => (string) ( $step['targetId'] ?? '' ),
			'action'     => (string) ( $step['action'] ?? '' ),
		),
		static fn( mixed $value ): bool => '' !== $value
	);
	if ( ! empty( $prior_observations ) ) {
		$observation['prior_observations'] = $prior_observations;
	}

	try {
		return match ( $command ) {
			'wordpress.ensure-plugin-active' => self::execute_fuzz_suite_plugin_activation( $args, $observation, $case_id ),
			'wordpress.ensure-external-http-guardrail' => self::execute_fuzz_suite_external_http_guardrail( $args, $observation ),
			'wordpress.inventory-rest-routes', 'wordpress.rest-route-inventory' => self::execute_fuzz_suite_rest_route_inventory( $args, $observation, $case_id ),
			'wordpress.inventory-database' => self::execute_fuzz_suite_database_inventory( $args, $observation, $case_id ),
			'wordpress.admin-page-inventory' => self::execute_fuzz_suite_admin_page_inventory( $args, $observation ),
			'wordpress.fuzz-admin-pages' => self::execute_fuzz_suite_admin_page_fuzz( $args, $observation ),
			'wordpress.rest-request' => self::execute_fuzz_suite_rest_request( $args, $observation, $case_id ),
			'wordpress.http-request' => self::execute_fuzz_suite_http_request( $args, $observation, $case_id ),
			'wordpress.trace-browser-coverage' => self::execute_fuzz_suite_browser_coverage( $args, $case, $suite, $observation, $case_id ),
			'wordpress.ability' => self::execute_fuzz_suite_ability( $args, $observation, $case_id ),
			'wordpress.summarize-fuzz-artifacts' => self::execute_fuzz_suite_artifact_summary( $args, $case, $suite, $observation, $case_id ),
			'wordpress.collect-workload-result' => self::execute_fuzz_suite_collect_artifact( $args, $case, $observation ),
			'wordpress.run-workload', 'wordpress.run-declarative-fuzz' => self::execute_fuzz_suite_workload_step( $args, $command, $case, $observation, $case_id ),
			default => self::fuzz_suite_step_unsupported( $command, $observation, $case_id ),
		};
	} catch ( Throwable $throwable ) {
		return array( 'status' => 'error', 'observation' => $observation, 'diagnostic' => self::fuzz_suite_diagnostic( 'error', 'wp_codebox_fuzz_step_exception', $throwable->getMessage(), array( 'case_id' => $case_id, 'command' => $command ) ) );
	}
}

/** @param array<string,string> $args Args. @param array<string,mixed> $observation Observation. @return array<string,mixed> */
private static function execute_fuzz_suite_rest_route_inventory( array $args, array $observation, string $case_id ): array {
	if ( ! function_exists( 'rest_get_server' ) ) {
		require_once ABSPATH . WPINC . '/rest-api.php';
	}
	self::refresh_fuzz_suite_rest_server();
	$server = rest_get_server();
	$routes = $server ? $server->get_routes() : array();
	$namespace_filter = array_values( array_filter( array_map( 'trim', explode( ',', (string) ( $args['namespaces'] ?? '' ) ) ) ) );
	$items = array();
	$namespaces = array();
	foreach ( $routes as $route => $handlers ) {
		$namespace = trim( strtok( ltrim( (string) $route, '/' ), '/' ) ?: '' );
		if ( ! empty( $namespace_filter ) && ! self::rest_route_matches_namespace_filter( (string) $route, $namespace_filter ) ) {
			continue;
		}
		$methods = array();
		$arg_names = array();
		$endpoints = array();
		foreach ( is_array( $handlers ) ? $handlers : array() as $handler ) {
			if ( ! is_array( $handler ) ) {
				continue;
			}
			$endpoint_methods = self::rest_route_inventory_methods( $handler['methods'] ?? array() );
			$endpoint_args = array();
			foreach ( (array) ( $handler['args'] ?? array() ) as $arg_name => $arg_schema ) {
				$arg_names[] = (string) $arg_name;
				$endpoint_args[] = self::rest_route_inventory_arg( (string) $arg_name, is_array( $arg_schema ) ? $arg_schema : array() );
			}
			$methods = array_merge( $methods, $endpoint_methods );
			$endpoints[] = array(
				'methods'    => $endpoint_methods,
				'permission' => self::rest_route_inventory_permission( $handler ),
				'args'       => $endpoint_args,
			);
		}
		$item = array(
			'route'     => (string) $route,
			'namespace' => $namespace,
			'methods'   => array_values( array_unique( $methods ) ),
			'argNames'  => array_values( array_unique( $arg_names ) ),
			'endpoints' => $endpoints,
		);
		$route_schema = self::rest_route_inventory_schema( is_array( $handlers ) ? $handlers : array() );
		if ( ! empty( $route_schema ) ) {
			$item['schema'] = $route_schema;
		}
		$items[] = $item;
		if ( '' !== $namespace ) {
			$namespaces[] = $namespace;
		}
	}
	$observation['artifact'] = (string) ( $args['artifact'] ?? 'route_inventory' );
	$observation['route_count'] = count( $items );
	$observation['namespaces'] = array_values( array_unique( $namespaces ) );
	$observation['payload'] = array(
		'schema'     => 'wp-codebox/wordpress-rest-route-inventory/v1',
		'command'    => 'wordpress.inventory-rest-routes',
		'routes'     => $items,
		'namespaces' => $observation['namespaces'],
	);
	return array( 'status' => 'passed', 'observation' => $observation );
}

/** @param array<string,string> $args Args. @param array<string,mixed> $observation Observation. @return array<string,mixed> */
private static function execute_fuzz_suite_admin_page_inventory( array $args, array $observation ): array {
	$inventory = self::fuzz_suite_admin_page_inventory( $args );
	$observation['page_count'] = count( $inventory['pages'] );
	$observation['menu_loaded'] = (bool) $inventory['menuLoaded'];
	$observation['payload'] = $inventory;
	return array( 'status' => 'passed', 'observation' => $observation );
}

/** @param array<string,string> $args Args. @param array<string,mixed> $observation Observation. @return array<string,mixed> */
private static function execute_fuzz_suite_admin_page_fuzz( array $args, array $observation ): array {
	$inventory = self::fuzz_suite_admin_page_inventory( $args );
	$max_pages = max( 1, (int) ( $args['max_pages'] ?? 80 ) );
	$targets = array_slice( $inventory['pages'], 0, $max_pages );
	$visits = array();
	$skipped = array();
	foreach ( $targets as $target ) {
		$url = (string) ( $target['canonicalUrl'] ?? '' );
		$skip_reason = self::fuzz_suite_admin_page_skip_reason( $target, $url );
		if ( null !== $skip_reason ) {
			$skipped[] = array( 'target' => $target, 'reason' => $skip_reason );
			continue;
		}
		$visits[] = array(
			'target' => $target,
			'method' => 'GET',
			'status' => 'planned',
			'reason' => 'public PHP fuzz runner records safe admin coverage without issuing browser requests.',
		);
	}
	$payload = array(
		'schema' => 'wp-codebox/wordpress-admin-page-coverage/v1',
		'contract' => array(
			'safety_class' => 'read_only',
			'command' => 'wordpress.fuzz-admin-pages',
			'admin_inventory_schema' => $inventory['schema'],
		),
		'targets' => $targets,
		'visits' => $visits,
		'skipped' => $skipped,
		'request_logs' => array(),
		'query_attribution' => array(),
		'metrics' => array(
			'target_count' => count( $targets ),
			'visit_count' => count( $visits ),
			'skipped_count' => count( $skipped ),
			'menu_loaded' => (bool) $inventory['menuLoaded'],
		),
		'inventory' => $inventory,
	);
	$observation['artifact'] = (string) ( $args['artifact'] ?? 'admin_page_coverage' );
	$observation['target_count'] = count( $targets );
	$observation['visit_count'] = count( $visits );
	$observation['skipped_count'] = count( $skipped );
	$observation['payload'] = $payload;
	return array( 'status' => 'passed', 'observation' => $observation );
}

/** @param array<string,string> $args Args. @param array<string,mixed> $observation Observation. @return array<string,mixed> */
private static function execute_fuzz_suite_external_http_guardrail( array $args, array $observation ): array {
	if ( function_exists( 'wp_codebox_bench_run_external_http_guardrail_step' ) ) {
		$payload = wp_codebox_bench_run_external_http_guardrail_step(
			array(
				'action'           => 'install',
				'allowlistDomains' => self::csv_fuzz_suite_arg( (string) ( $args['allowlist'] ?? '' ) ),
				'blockNetwork'     => filter_var( $args['block_network'] ?? true, FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE ) ?? true,
			)
		);
		$observation['payload'] = $payload;
	}
	$observation['installed'] = true;
	$observation['allowlist'] = self::csv_fuzz_suite_arg( (string) ( $args['allowlist'] ?? '' ) );
	return array( 'status' => 'passed', 'observation' => $observation );
}

/** @param array<string,string> $args Args. @return array<string,mixed> */
private static function fuzz_suite_admin_page_inventory( array $args ): array {
	$diagnostics = array();
	if ( ( ! isset( $GLOBALS['menu'] ) || ! is_array( $GLOBALS['menu'] ) ) && function_exists( 'is_user_logged_in' ) && is_user_logged_in() ) {
		if ( ! defined( 'WP_ADMIN' ) ) {
			define( 'WP_ADMIN', true );
		}
		global $menu, $submenu;
		if ( ! is_array( $submenu ?? null ) ) {
			$submenu = array();
		}
		if ( defined( 'ABSPATH' ) && file_exists( ABSPATH . 'wp-admin/includes/admin.php' ) ) {
			require_once ABSPATH . 'wp-admin/includes/admin.php';
		}
		if ( defined( 'ABSPATH' ) && file_exists( ABSPATH . 'wp-admin/menu.php' ) ) {
			require_once ABSPATH . 'wp-admin/menu.php';
		}
	}
	$menu_loaded = isset( $GLOBALS['menu'] ) && is_array( $GLOBALS['menu'] );
	if ( ! $menu_loaded ) {
		$diagnostics[] = array( 'surface' => 'admin', 'code' => 'admin-menu-not-loaded', 'message' => 'The admin menu globals are not populated in this request context.' );
	}
	$pages = array();
	foreach ( (array) ( $GLOBALS['menu'] ?? array() ) as $item ) {
		if ( is_array( $item ) ) {
			$pages[] = self::fuzz_suite_admin_page_descriptor( (string) ( $item[2] ?? '' ), (string) ( $item[0] ?? '' ), (string) ( $item[1] ?? '' ) );
		}
	}
	foreach ( (array) ( $GLOBALS['submenu'] ?? array() ) as $parent_slug => $items ) {
		foreach ( (array) $items as $item ) {
			if ( is_array( $item ) ) {
				$pages[] = self::fuzz_suite_admin_page_descriptor( (string) ( $item[2] ?? '' ), (string) ( $item[0] ?? '' ), (string) ( $item[1] ?? '' ), (string) $parent_slug );
			}
		}
	}
	return array(
		'schema' => 'wp-codebox/wordpress-admin-page-inventory/v1',
		'command' => 'wordpress.admin-page-inventory',
		'status' => $menu_loaded ? 'ok' : 'unsupported',
		'adminUrl' => function_exists( 'admin_url' ) ? admin_url() : '',
		'menuLoaded' => $menu_loaded,
		'user' => self::fuzz_suite_admin_user_context(),
		'pages' => array_values( array_filter( $pages, static fn( array $page ): bool => '' !== ( $page['menuSlug'] ?? '' ) ) ),
		'diagnostics' => $diagnostics,
	);
}

private static function fuzz_suite_admin_page_descriptor( string $menu_slug, string $title, string $capability, string $parent_slug = '' ): array {
	$page = array(
		'menuSlug' => $menu_slug,
		'pageTitle' => self::fuzz_suite_strip_tags( $title ),
		'menuTitle' => self::fuzz_suite_strip_tags( $title ),
		'capability' => $capability,
		'canAccess' => '' === $capability || ! function_exists( 'current_user_can' ) ? null : current_user_can( $capability ),
		'canonicalUrl' => self::fuzz_suite_admin_page_url( $menu_slug, $parent_slug ),
	);
	if ( '' !== $parent_slug ) {
		$page['parentSlug'] = $parent_slug;
	}
	return $page;
}

private static function fuzz_suite_admin_page_url( string $menu_slug, string $parent_slug = '' ): string {
	if ( str_ends_with( $menu_slug, '.php' ) ) {
		$path = $menu_slug;
	} elseif ( str_contains( $menu_slug, '.php' ) ) {
		$path = $menu_slug;
	} elseif ( '' !== $parent_slug && str_contains( $parent_slug, '.php' ) ) {
		$path = $parent_slug . '?page=' . rawurlencode( $menu_slug );
	} else {
		$path = 'admin.php?page=' . rawurlencode( $menu_slug );
	}
	return function_exists( 'admin_url' ) ? admin_url( $path ) : $path;
}

/** @param array<string,mixed> $target Target. */
private static function fuzz_suite_admin_page_skip_reason( array $target, string $url ): ?array {
	if ( false === ( $target['canAccess'] ?? null ) ) {
		return array( 'code' => 'capability_denied', 'message' => 'The current runtime user cannot access this admin page.', 'capability' => $target['capability'] ?? '' );
	}
	foreach ( array( 'action=delete', 'action=install', 'action=update', 'action=activate', 'action=deactivate', '_wpnonce=' ) as $pattern ) {
		if ( str_contains( $url, $pattern ) ) {
			return array( 'code' => 'destructive_or_nonce_action', 'message' => 'The admin page URL looks like a mutation or nonce-protected action.', 'pattern' => $pattern );
		}
	}
	return null;
}

/** @return array<string,mixed> */
private static function fuzz_suite_admin_user_context(): array {
	$user = function_exists( 'wp_get_current_user' ) ? wp_get_current_user() : null;
	return array(
		'isLoggedIn' => function_exists( 'is_user_logged_in' ) ? is_user_logged_in() : false,
		'id' => is_object( $user ) && isset( $user->ID ) ? (int) $user->ID : 0,
		'roles' => is_object( $user ) && isset( $user->roles ) ? array_values( array_map( 'strval', (array) $user->roles ) ) : array(),
	);
}

/** @param array<string,string> $args Args. @param array<string,mixed> $observation Observation. @return array<string,mixed> */
private static function execute_fuzz_suite_database_inventory( array $args, array $observation, string $case_id ): array {
	global $wpdb;
	if ( ! is_object( $wpdb ) || ! method_exists( $wpdb, 'get_results' ) ) {
		return array( 'status' => 'skipped', 'observation' => $observation, 'diagnostic' => self::fuzz_suite_diagnostic( 'warning', 'wp_codebox_fuzz_database_unavailable', 'WordPress database connection is not available.', array( 'case_id' => $case_id ) ) );
	}

	$prefix = isset( $wpdb->prefix ) ? (string) $wpdb->prefix : '';
	$tables = self::fuzz_suite_database_tables( $wpdb, $prefix );
	$totals = array(
		'tableCount'  => count( $tables ),
		'rowCount'    => (int) array_sum( array_map( static fn( array $table ): int => (int) ( $table['rowCount'] ?? 0 ), $tables ) ),
		'columnCount' => (int) array_sum( array_map( static fn( array $table ): int => count( (array) ( $table['columns'] ?? array() ) ), $tables ) ),
		'indexCount'  => (int) array_sum( array_map( static fn( array $table ): int => count( (array) ( $table['indexes'] ?? array() ) ), $tables ) ),
		'dataBytes'   => (int) array_sum( array_map( static fn( array $table ): int => (int) ( $table['dataBytes'] ?? 0 ), $tables ) ),
		'indexBytes'  => (int) array_sum( array_map( static fn( array $table ): int => (int) ( $table['indexBytes'] ?? 0 ), $tables ) ),
		'totalBytes'  => (int) array_sum( array_map( static fn( array $table ): int => (int) ( $table['totalBytes'] ?? 0 ), $tables ) ),
	);

	$observation['artifact'] = (string) ( $args['artifact'] ?? 'db_inventory' );
	$observation['table_count'] = $totals['tableCount'];
	$observation['payload'] = array(
		'schema'      => 'wp-codebox/wordpress-db-inventory/v1',
		'command'     => 'wordpress.inventory-database',
		'status'      => 'ok',
		'prefix'      => $prefix,
		'tables'      => $tables,
		'totals'      => $totals,
		'diagnostics' => array(),
	);
	return array( 'status' => 'passed', 'observation' => $observation );
}

/** @return array<int,array<string,mixed>> */
private static function fuzz_suite_database_tables( object $wpdb, string $prefix ): array {
	$tables = array();
	foreach ( self::fuzz_suite_database_query_rows( $wpdb, 'SHOW TABLE STATUS' ) as $status ) {
		$name = (string) ( $status['Name'] ?? '' );
		if ( '' === $name ) {
			continue;
		}
		$data_bytes = (int) ( $status['Data_length'] ?? 0 );
		$index_bytes = (int) ( $status['Index_length'] ?? 0 );
		$tables[] = array(
			'name'           => $name,
			'baseName'       => self::fuzz_suite_database_base_table_name( $name, $prefix ),
			'classification' => self::fuzz_suite_database_table_classification( $name, $prefix ),
			'engine'         => (string) ( $status['Engine'] ?? '' ),
			'rowCount'       => (int) ( $status['Rows'] ?? 0 ),
			'dataBytes'      => $data_bytes,
			'indexBytes'     => $index_bytes,
			'totalBytes'     => $data_bytes + $index_bytes,
			'columns'        => self::fuzz_suite_database_columns( $wpdb, $name ),
			'indexes'        => self::fuzz_suite_database_indexes( $wpdb, $name ),
			'status'         => array(
				'engine'     => (string) ( $status['Engine'] ?? '' ),
				'rows'       => isset( $status['Rows'] ) ? (int) $status['Rows'] : null,
				'collation'  => (string) ( $status['Collation'] ?? '' ),
				'dataBytes'  => $data_bytes,
				'indexBytes' => $index_bytes,
				'totalBytes' => $data_bytes + $index_bytes,
			),
		);
	}
	return $tables;
}

/** @return array<int,array<string,mixed>> */
private static function fuzz_suite_database_columns( object $wpdb, string $table ): array {
	return array_values( array_map( static fn( array $row ): array => array(
		'name'     => (string) ( $row['Field'] ?? '' ),
		'type'     => (string) ( $row['Type'] ?? '' ),
		'nullable' => 'YES' === strtoupper( (string) ( $row['Null'] ?? '' ) ),
		'key'      => (string) ( $row['Key'] ?? '' ),
		'default'  => array_key_exists( 'Default', $row ) && null !== $row['Default'] ? (string) $row['Default'] : null,
		'extra'    => (string) ( $row['Extra'] ?? '' ),
	), self::fuzz_suite_database_query_rows( $wpdb, 'DESCRIBE ' . self::fuzz_suite_database_identifier( $table ) ) ) );
}

/** @return array<int,array<string,mixed>> */
private static function fuzz_suite_database_indexes( object $wpdb, string $table ): array {
	return array_values( array_map( static fn( array $row ): array => array(
		'name'     => (string) ( $row['Key_name'] ?? '' ),
		'column'   => (string) ( $row['Column_name'] ?? '' ),
		'unique'   => '0' === (string) ( $row['Non_unique'] ?? '1' ),
		'sequence' => isset( $row['Seq_in_index'] ) ? (int) $row['Seq_in_index'] : null,
	), self::fuzz_suite_database_query_rows( $wpdb, 'SHOW INDEX FROM ' . self::fuzz_suite_database_identifier( $table ) ) ) );
}

/** @return array<int,array<string,mixed>> */
private static function fuzz_suite_database_query_rows( object $wpdb, string $query ): array {
	$rows = $wpdb->get_results( $query, defined( 'ARRAY_A' ) ? ARRAY_A : 'ARRAY_A' );
	return is_array( $rows ) ? array_values( array_filter( $rows, 'is_array' ) ) : array();
}

private static function fuzz_suite_database_identifier( string $name ): string {
	return '`' . str_replace( '`', '``', $name ) . '`';
}

private static function fuzz_suite_database_base_table_name( string $name, string $prefix ): string {
	return '' !== $prefix && str_starts_with( $name, $prefix ) ? substr( $name, strlen( $prefix ) ) : $name;
}

private static function fuzz_suite_database_table_classification( string $name, string $prefix ): string {
	if ( '' !== $prefix && str_starts_with( $name, $prefix ) ) {
		return in_array( self::fuzz_suite_database_base_table_name( $name, $prefix ), array( 'commentmeta', 'comments', 'links', 'options', 'postmeta', 'posts', 'term_relationships', 'term_taxonomy', 'termmeta', 'terms', 'usermeta', 'users' ), true ) ? 'core' : 'prefixed';
	}
	return 'external';
}

private static function fuzz_suite_strip_tags( string $value ): string {
	return function_exists( 'wp_strip_all_tags' ) ? wp_strip_all_tags( $value ) : strip_tags( $value );
}

/** @param string[] $namespace_filter Namespace filters. */
private static function rest_route_matches_namespace_filter( string $route, array $namespace_filter ): bool {
	$route = '/' . ltrim( $route, '/' );
	foreach ( $namespace_filter as $namespace ) {
		$namespace = trim( (string) $namespace, '/' );
		if ( '' !== $namespace && str_starts_with( $route, '/' . $namespace ) ) {
			return true;
		}
	}
	return false;
}

private static function rest_route_inventory_methods( mixed $methods ): array {
	if ( is_string( $methods ) ) {
		return array_values( array_filter( array_map( 'trim', explode( ',', strtoupper( $methods ) ) ) ) );
	}
	$raw = array_merge( array_keys( (array) $methods ), array_values( (array) $methods ) );
	$normalized = array();
	foreach ( $raw as $method ) {
		if ( is_string( $method ) && '' !== $method && strtoupper( $method ) === $method ) {
			$normalized[] = $method;
		}
	}
	return array_values( array_unique( $normalized ) );
}

private static function rest_route_inventory_permission( array $handler ): array {
	if ( ! array_key_exists( 'permission_callback', $handler ) ) {
		return array( 'mode' => 'none' );
	}
	$callback = $handler['permission_callback'];
	if ( '__return_true' === $callback ) {
		return array( 'mode' => 'public', 'callbackType' => 'function' );
	}
	return array( 'mode' => 'callback', 'callbackType' => self::rest_route_inventory_callback_type( $callback ) );
}

private static function rest_route_inventory_callback_type( mixed $callback ): string {
	if ( is_string( $callback ) ) {
		return 'function';
	}
	if ( is_array( $callback ) ) {
		return 'method';
	}
	if ( $callback instanceof Closure ) {
		return 'closure';
	}
	if ( is_object( $callback ) && is_callable( $callback ) ) {
		return 'invokable';
	}
	return is_callable( $callback ) ? 'callable' : 'unknown';
}

private static function rest_route_inventory_arg( string $name, array $schema ): array {
	$arg = array( 'name' => $name, 'required' => ! empty( $schema['required'] ) );
	foreach ( array( 'type', 'format' ) as $key ) {
		if ( isset( $schema[ $key ] ) && ( is_string( $schema[ $key ] ) || is_array( $schema[ $key ] ) ) ) {
			$arg[ $key ] = $schema[ $key ];
		}
	}
	if ( isset( $schema['enum'] ) && is_array( $schema['enum'] ) ) {
		$arg['enum'] = array_slice( array_values( $schema['enum'] ), 0, 25 );
	}
	if ( isset( $schema['description'] ) && is_string( $schema['description'] ) ) {
		$description = function_exists( 'wp_strip_all_tags' ) ? wp_strip_all_tags( $schema['description'] ) : strip_tags( $schema['description'] );
		$arg['description'] = substr( $description, 0, 240 );
	}
	$arg['defaultPresent'] = array_key_exists( 'default', $schema );
	$arg['validateCallback'] = array_key_exists( 'validate_callback', $schema );
	$arg['sanitizeCallback'] = array_key_exists( 'sanitize_callback', $schema );
	return $arg;
}

private static function rest_route_inventory_schema( array $handlers ): array {
	foreach ( $handlers as $handler ) {
		if ( ! is_array( $handler ) || ! isset( $handler['schema'] ) || ! is_array( $handler['schema'] ) ) {
			continue;
		}
		$schema = $handler['schema'];
		$descriptor = array();
		foreach ( array( 'title', 'type' ) as $key ) {
			if ( isset( $schema[ $key ] ) && ( is_string( $schema[ $key ] ) || is_array( $schema[ $key ] ) ) ) {
				$descriptor[ $key ] = $schema[ $key ];
			}
		}
		if ( isset( $schema['properties'] ) && is_array( $schema['properties'] ) ) {
			$descriptor['properties'] = array_slice( array_values( array_map( 'strval', array_keys( $schema['properties'] ) ) ), 0, 100 );
		}
		return $descriptor;
	}
	return array();
}

/** @param string[] $args Args. @return array<string,string> */
private static function fuzz_suite_parse_args( array $args ): array {
	$parsed = array();
	foreach ( $args as $arg ) {
		$parts = explode( '=', (string) $arg, 2 );
		$parsed[ $parts[0] ] = $parts[1] ?? '';
	}
	return $parsed;
}

/** @param array<string,string> $args Args. @param array<string,mixed> $observation Observation. @return array<string,mixed> */
private static function execute_fuzz_suite_plugin_activation( array $args, array $observation, string $case_id ): array {
	$plugin = trim( (string) ( $args['plugin'] ?? '' ) );
	if ( '' === $plugin ) {
		return array( 'status' => 'error', 'observation' => $observation, 'diagnostic' => self::fuzz_suite_diagnostic( 'error', 'wp_codebox_fuzz_plugin_missing', 'Plugin activation step requires plugin=<plugin-file>.', array( 'case_id' => $case_id ) ) );
	}
	if ( ! function_exists( 'is_plugin_active' ) ) {
		require_once ABSPATH . 'wp-admin/includes/plugin.php';
	}
	if ( ! is_plugin_active( $plugin ) ) {
		$result = activate_plugin( $plugin );
		if ( is_wp_error( $result ) ) {
			return array( 'status' => 'failed', 'observation' => $observation, 'diagnostic' => self::fuzz_suite_diagnostic( 'error', 'wp_codebox_fuzz_plugin_activation_failed', $result->get_error_message(), array( 'case_id' => $case_id, 'plugin' => $plugin ) ) );
		}
	}
	self::refresh_fuzz_suite_rest_server();
	$observation['plugin'] = $plugin;
	return array( 'status' => 'passed', 'observation' => $observation );
}

/** @param array<string,string> $args Args. @param array<string,mixed> $observation Observation. @return array<string,mixed> */
private static function execute_fuzz_suite_rest_request( array $args, array $observation, string $case_id ): array {
	$path = (string) ( $args['path'] ?? $args['route'] ?? '' );
	if ( '' === $path || ! str_starts_with( $path, '/' ) ) {
		return array( 'status' => 'error', 'observation' => $observation, 'diagnostic' => self::fuzz_suite_diagnostic( 'error', 'wp_codebox_fuzz_rest_path_invalid', 'REST fuzz step requires an absolute path.', array( 'case_id' => $case_id, 'path' => $path ) ) );
	}
	$request = new WP_REST_Request( strtoupper( (string) ( $args['method'] ?? 'GET' ) ), $path );
	foreach ( self::json_arg( $args['params-json'] ?? '' ) as $key => $value ) {
		$request->set_param( (string) $key, $value );
	}
	foreach ( self::json_arg( $args['headers-json'] ?? '' ) as $key => $value ) {
		$request->set_header( (string) $key, (string) $value );
	}
	if ( isset( $args['body-json'] ) && '' !== $args['body-json'] ) {
		$request->set_body_params( self::json_arg( $args['body-json'] ) );
	} elseif ( isset( $args['body'] ) ) {
		$request->set_body( $args['body'] );
	}
	$response = rest_do_request( $request );
	$status = (int) $response->get_status();
	$observation['status'] = $status;
	$observation['path'] = $path;
	return array( 'status' => $status >= 500 ? 'failed' : 'passed', 'observation' => $observation, 'diagnostic' => $status >= 500 ? self::fuzz_suite_diagnostic( 'error', 'wp_codebox_fuzz_rest_request_failed', 'REST request returned a server error.', array( 'case_id' => $case_id, 'status' => $status, 'path' => $path ) ) : null );
}

/** @param array<string,string> $args Args. @param array<string,mixed> $observation Observation. @return array<string,mixed> */
private static function execute_fuzz_suite_http_request( array $args, array $observation, string $case_id ): array {
	$url = (string) ( $args['url'] ?? $args['path'] ?? '' );
	if ( '' === $url || preg_match( '#^https?://#i', $url ) ) {
		return array( 'status' => 'error', 'observation' => $observation, 'diagnostic' => self::fuzz_suite_diagnostic( 'error', 'wp_codebox_fuzz_http_url_invalid', 'HTTP fuzz step only accepts same-site relative URLs.', array( 'case_id' => $case_id, 'url' => $url ) ) );
	}
	$response = wp_remote_request( home_url( '/' . ltrim( $url, '/' ) ), array( 'method' => strtoupper( (string) ( $args['method'] ?? 'GET' ) ), 'timeout' => 15 ) );
	if ( is_wp_error( $response ) ) {
		return array( 'status' => 'failed', 'observation' => $observation, 'diagnostic' => self::fuzz_suite_diagnostic( 'error', 'wp_codebox_fuzz_http_request_failed', $response->get_error_message(), array( 'case_id' => $case_id, 'url' => $url ) ) );
	}
	$code = (int) wp_remote_retrieve_response_code( $response );
	$observation['status'] = $code;
	$observation['url'] = $url;
	return array( 'status' => $code >= 500 ? 'failed' : 'passed', 'observation' => $observation );
}

/** @param array<string,string> $args Args. @param array<string,mixed> $case Case. @param array<string,mixed> $suite Suite. @param array<string,mixed> $observation Observation. @return array<string,mixed> */
private static function execute_fuzz_suite_browser_coverage( array $args, array $case, array $suite, array $observation, string $case_id ): array {
	$targets = self::fuzz_suite_browser_coverage_targets( $args );
	if ( empty( $targets ) ) {
		return array( 'status' => 'error', 'observation' => $observation, 'diagnostic' => self::fuzz_suite_diagnostic( 'error', 'wp_codebox_fuzz_browser_coverage_target_missing', 'Browser coverage requires at least one safe same-site path or URL.', array( 'case_id' => $case_id ) ) );
	}

	$started_at = gmdate( 'Y-m-d\TH:i:s\Z' );
	$requests = array();
	$failed = 0;
	foreach ( $targets as $target ) {
		$url = self::fuzz_suite_browser_coverage_url( (string) $target['path'] );
		if ( '' === $url ) {
			$requests[] = array( 'surface' => $target['surface'], 'path' => $target['path'], 'status' => 'skipped', 'diagnostics' => array( self::fuzz_suite_diagnostic( 'warning', 'wp_codebox_fuzz_browser_coverage_unsafe_url', 'Browser coverage target is not a safe same-site URL.', array( 'case_id' => $case_id, 'path' => $target['path'] ) ) ) );
			continue;
		}

		$response = wp_remote_request( $url, array( 'method' => 'GET', 'timeout' => 15, 'redirection' => 0 ) );
		if ( is_wp_error( $response ) ) {
			$failed++;
			$requests[] = array( 'surface' => $target['surface'], 'path' => $target['path'], 'url' => $url, 'status' => 'failed', 'diagnostics' => array( self::fuzz_suite_diagnostic( 'error', 'wp_codebox_fuzz_browser_coverage_request_failed', $response->get_error_message(), array( 'case_id' => $case_id, 'path' => $target['path'] ) ) ) );
			continue;
		}

		$status_code = (int) wp_remote_retrieve_response_code( $response );
		if ( $status_code >= 500 ) {
			$failed++;
		}
		$requests[] = array_filter(
			array(
				'surface'      => $target['surface'],
				'path'         => $target['path'],
				'url'          => $url,
				'status'       => $status_code >= 500 ? 'failed' : 'covered',
				'http'         => array(
					'status'      => $status_code,
					'contentType' => (string) wp_remote_retrieve_header( $response, 'content-type' ),
					'location'    => (string) wp_remote_retrieve_header( $response, 'location' ),
				),
				'bodyBytes'    => strlen( (string) wp_remote_retrieve_body( $response ) ),
				'diagnostics'  => $status_code >= 500 ? array( self::fuzz_suite_diagnostic( 'error', 'wp_codebox_fuzz_browser_coverage_server_error', 'Browser coverage target returned a server error.', array( 'case_id' => $case_id, 'path' => $target['path'], 'status' => $status_code ) ) ) : array(),
			),
			static fn( mixed $value ): bool => ! ( '' === $value || ( is_array( $value ) && empty( $value ) ) )
		);
	}

	$report = array(
		'schema'      => 'wp-codebox/browser-request-coverage/v1',
		'command'     => 'wordpress.trace-browser-coverage',
		'caseId'      => $case_id,
		'status'      => $failed > 0 ? 'failed' : 'passed',
		'generatedAt' => gmdate( 'Y-m-d\TH:i:s\Z' ),
		'timing'      => array( 'startedAt' => $started_at ),
		'summary'     => array( 'total' => count( $requests ), 'covered' => count( array_filter( $requests, static fn( array $request ): bool => 'covered' === ( $request['status'] ?? '' ) ) ), 'failed' => $failed, 'skipped' => count( array_filter( $requests, static fn( array $request ): bool => 'skipped' === ( $request['status'] ?? '' ) ) ) ),
		'coverage'    => array( 'surfaces' => array_values( array_unique( array_map( static fn( array $request ): string => (string) ( $request['surface'] ?? 'frontend' ), $requests ) ) ), 'operations' => array( 'frontend-page-render', 'asset-request-capture', 'xhr-fetch-capture', 'skipped-destructive-action-classification' ), 'requests' => count( $requests ), 'responses' => count( array_filter( $requests, static fn( array $request ): bool => isset( $request['http'] ) ) ), 'failures' => $failed ),
		'requests'    => $requests,
		'metadata'    => array( 'suiteId' => (string) ( $suite['id'] ?? '' ), 'runner' => 'wp-codebox/fuzz-suite-runner/v1' ),
	);

	$artifact_result = self::write_fuzz_suite_browser_coverage_artifact( $report, $case, (string) ( $args['artifact'] ?? '' ) );
	if ( is_wp_error( $artifact_result ) ) {
		return array( 'status' => 'error', 'observation' => $observation, 'diagnostic' => self::fuzz_suite_diagnostic( 'error', $artifact_result->code, $artifact_result->get_error_message(), array( 'case_id' => $case_id ) ) );
	}

	$observation['targets'] = count( $targets );
	$observation['artifact'] = $artifact_result['path'];
	$observation['status'] = $report['status'];
	$observation['payload'] = $report;
	return array( 'status' => $failed > 0 ? 'failed' : 'passed', 'observation' => $observation, 'artifactRefs' => self::fuzz_suite_declared_artifact_refs( $case ) );
}

/** @param array<string,string> $args Args. @param array<string,mixed> $observation Observation. @return array<string,mixed> */
private static function execute_fuzz_suite_ability( array $args, array $observation, string $case_id ): array {
	$name = (string) ( $args['name'] ?? '' );
	if ( '' === $name || ! function_exists( 'wp_has_ability' ) || ! function_exists( 'wp_call_ability' ) ) {
		return self::fuzz_suite_step_unsupported( 'wordpress.ability', $observation, $case_id );
	}
	$input = self::json_arg( $args['input'] ?? '{}' );
	$result = wp_call_ability( $name, $input );
	if ( is_wp_error( $result ) ) {
		return array( 'status' => 'failed', 'observation' => $observation, 'diagnostic' => self::fuzz_suite_diagnostic( 'error', 'wp_codebox_fuzz_ability_failed', $result->get_error_message(), array( 'case_id' => $case_id, 'ability' => $name ) ) );
	}
	$observation['ability'] = $name;
	return array( 'status' => 'passed', 'observation' => $observation );
}

/** @param array<string,string> $args Args. @param array<string,mixed> $case Case. @param array<string,mixed> $observation Observation. @return array<string,mixed> */
private static function execute_fuzz_suite_collect_artifact( array $args, array $case, array $observation ): array {
	$name = (string) ( $args['artifact'] ?? '' );
	$refs = array_values( array_filter( self::fuzz_suite_declared_artifact_refs( $case ), static fn( array $artifact ): bool => '' === $name || ( $artifact['name'] ?? '' ) === $name ) );
	$observation['artifact'] = $name;
	return array( 'status' => 'passed', 'observation' => $observation, 'artifactRefs' => $refs );
}

/** @param array<string,string> $args Args. @param array<string,mixed> $case Case. @param array<string,mixed> $suite Suite. @param array<string,mixed> $observation Observation. @return array<string,mixed> */
private static function execute_fuzz_suite_artifact_summary( array $args, array $case, array $suite, array $observation, string $case_id ): array {
	$refs = self::fuzz_suite_filter_artifact_refs( self::fuzz_suite_declared_artifact_refs( $case ), self::csv_fuzz_suite_arg( (string) ( $args['artifact'] ?? $args['artifacts'] ?? '' ) ) );
	if ( empty( $refs ) ) {
		return array( 'status' => 'skipped', 'observation' => $observation, 'diagnostic' => self::fuzz_suite_diagnostic( 'warning', 'wp_codebox_fuzz_summary_artifacts_missing', 'Fuzz artifact summary requires declared artifact paths.', array( 'case_id' => $case_id ) ) );
	}

	$inputs = is_array( $case['inputs'] ?? null ) ? $case['inputs'] : array();
	$surfaces = array_values( array_map( 'strval', is_array( $inputs['observation_surfaces'] ?? null ) ? $inputs['observation_surfaces'] : array() ) );
	$budget_keys = array_values( array_map( 'strval', is_array( $inputs['budget_keys'] ?? null ) ? $inputs['budget_keys'] : array() ) );
	$product_budgets = is_array( $inputs['product_budgets'] ?? null ) ? $inputs['product_budgets'] : array();
	$hotspot_classes = array_values( array_map( 'strval', is_array( $inputs['hotspot_classes'] ?? null ) ? $inputs['hotspot_classes'] : array() ) );
	$skip_reason_codes = array_values( array_map( 'strval', is_array( $inputs['skip_reason_codes'] ?? null ) ? $inputs['skip_reason_codes'] : array() ) );
	$summary = array(
		'schema'                    => 'wp-codebox/fuzz-artifact-summary/v1',
		'command'                   => 'wordpress.summarize-fuzz-artifacts',
		'caseId'                    => $case_id,
		'suiteId'                   => (string) ( $suite['id'] ?? '' ),
		'surface'                   => (string) ( $args['surface'] ?? '' ),
		'include'                   => self::csv_fuzz_suite_arg( (string) ( $args['include'] ?? '' ) ),
		'generatedAt'               => gmdate( 'Y-m-d\TH:i:s\Z' ),
		'product_budget_comparison' => array_fill_keys( $budget_keys, array( 'status' => 'not_measured', 'observed' => null, 'budget' => null ) ),
		'hotspot_classification'    => array_fill_keys( $hotspot_classes, 0 ),
		'query_attribution_summary' => array( 'source' => (string) ( $inputs['query_attribution_source'] ?? '' ), 'observed' => false ),
		'connected_state_caveats'   => array_values( array_map( 'strval', is_array( $inputs['states'] ?? null ) ? $inputs['states'] : array() ) ),
		'surface_rollups'           => array_fill_keys( $surfaces, array( 'status' => 'declared', 'artifact_inputs' => 0 ) ),
		'budget_status'             => empty( $budget_keys ) ? 'not_declared' : 'not_measured',
		'artifact_inputs'           => $surfaces,
		'skip_reason_rollups'       => array_fill_keys( $skip_reason_codes, 0 ),
		'metadata'                  => array( 'runner' => 'wp-codebox/fuzz-suite-runner/v1' ),
	);
	$summary = self::summarize_fuzz_suite_observations( $summary, is_array( $observation['prior_observations'] ?? null ) ? $observation['prior_observations'] : array(), $product_budgets );

	$written = array();
	$refs_with_payload = array();
	foreach ( $refs as $ref ) {
		$result = self::write_fuzz_suite_declared_artifact( $summary, (string) ( $ref['path'] ?? '' ), 'summary' );
		if ( is_wp_error( $result ) ) {
			return array( 'status' => 'error', 'observation' => $observation, 'diagnostic' => self::fuzz_suite_diagnostic( 'error', $result->code, $result->get_error_message(), array( 'case_id' => $case_id ) ) );
		}
		$written[] = $result;
		$refs_with_payload[] = array_merge( $ref, array( 'payload' => $summary ) );
	}

	$observation['artifact_count'] = count( $written );
	return array( 'status' => 'passed', 'observation' => $observation, 'artifactRefs' => $refs_with_payload );
}

/** @param array<string,mixed> $summary Summary. @param array<int,array<string,mixed>> $observations Observations. @return array<string,mixed> */
private static function summarize_fuzz_suite_observations( array $summary, array $observations, array $product_budgets = array() ): array {
	$metrics = array(
		'request_count' => 0,
		'query_count' => 0,
		'browser_request_count' => 0,
		'admin_target_count' => 0,
		'external_http_attempt_count' => 0,
	);
	foreach ( $observations as $observation ) {
		if ( ! is_array( $observation ) ) {
			continue;
		}
		$payload = is_array( $observation['payload'] ?? null ) ? $observation['payload'] : array();
		foreach ( is_array( $payload['steps'] ?? null ) ? $payload['steps'] : array() as $step ) {
			if ( ! is_array( $step ) ) {
				continue;
			}
			$metrics['request_count'] += (int) ( $step['observation']['requestCount'] ?? 0 );
			$metrics['query_count'] += (int) ( $step['observation']['queryCount'] ?? 0 );
		}
		if ( 'wp-codebox/browser-request-coverage/v1' === ( $payload['schema'] ?? '' ) ) {
			$metrics['browser_request_count'] += (int) ( $payload['summary']['total'] ?? 0 );
		}
		$metrics['admin_target_count'] += (int) ( $payload['metrics']['target_count'] ?? 0 );
		if ( 'wp-codebox/external-http-guardrail/v1' === ( $payload['schema'] ?? '' ) ) {
			$metrics['external_http_attempt_count'] += (int) ( $payload['summary']['total'] ?? 0 );
		}
	}

	$summary['observed_metrics'] = $metrics;
	if ( array_sum( $metrics ) > 0 ) {
		$summary['budget_status'] = 'measured';
		if ( isset( $summary['hotspot_classification']['external-http-attempt'] ) ) {
			$summary['hotspot_classification']['external-http-attempt'] = $metrics['external_http_attempt_count'];
		}
		if ( isset( $summary['hotspot_classification']['asset-bloat'] ) ) {
			$summary['hotspot_classification']['asset-bloat'] = $metrics['browser_request_count'];
		}
		foreach ( $summary['product_budget_comparison'] as $budget_key => $budget ) {
			$observed = self::fuzz_suite_observed_value_for_budget( (string) $budget_key, $metrics );
			$budget_value = is_numeric( $product_budgets[ $budget_key ] ?? null ) ? (int) $product_budgets[ $budget_key ] : null;
			$status = null === $observed ? 'not_measured' : 'measured';
			if ( null !== $observed && null !== $budget_value ) {
				$status = $observed > $budget_value ? 'exceeded' : 'passed';
			}
			$summary['product_budget_comparison'][ $budget_key ] = array( 'status' => $status, 'observed' => $observed, 'budget' => $budget_value );
		}
		$summary['budget_status'] = count( array_filter( $summary['product_budget_comparison'], static fn( array $entry ): bool => 'exceeded' === ( $entry['status'] ?? '' ) ) ) > 0 ? 'exceeded' : 'measured';
		foreach ( $summary['surface_rollups'] as $surface => $rollup ) {
			$summary['surface_rollups'][ $surface ] = array_merge( is_array( $rollup ) ? $rollup : array(), array( 'status' => 'observed', 'artifact_inputs' => count( $observations ) ) );
		}
	}
	return $summary;
}

/** @param array<string,int> $metrics Metrics. */
private static function fuzz_suite_observed_value_for_budget( string $budget_key, array $metrics ): int|null {
	return match ( $budget_key ) {
		'max_queries_per_rest_case' => $metrics['query_count'],
		'max_assets_per_public_request' => $metrics['browser_request_count'],
		'max_external_http_attempts' => $metrics['external_http_attempt_count'],
		default => null,
	};
}

/** @param array<string,string> $args Args. @param array<string,mixed> $case Case. @param array<string,mixed> $observation Observation. @return array<string,mixed> */
private static function execute_fuzz_suite_workload_step( array $args, string $command, array $case, array $observation, string $case_id ): array {
	$path = (string) ( $args['path'] ?? $args['manifest'] ?? '' );
	$resolved = self::resolve_fuzz_suite_file_path( $path );
	if ( '' === $resolved ) {
		return array( 'status' => 'skipped', 'observation' => $observation, 'diagnostic' => self::fuzz_suite_diagnostic( 'warning', 'wp_codebox_fuzz_workload_unavailable', 'Workload file is not available inside this runtime.', array( 'case_id' => $case_id, 'command' => $command, 'path' => $path ) ) );
	}
	$observation['path'] = $resolved;
	if ( 'json' === strtolower( pathinfo( $resolved, PATHINFO_EXTENSION ) ) ) {
		return self::execute_fuzz_suite_json_workload( $resolved, $case, $observation, $case_id, (string) ( $args['artifact'] ?? '' ) );
	}
	if ( 'wordpress.run-declarative-fuzz' === $command ) {
		return array( 'status' => 'passed', 'observation' => $observation );
	}
	ob_start();
	$result = include $resolved;
	if ( $result instanceof Closure ) {
		$result = $result();
	}
	$output = ob_get_clean();
	$observation['output_bytes'] = strlen( (string) $output );
	$observation['return_type'] = gettype( $result );
	if ( is_array( $result ) ) {
		$observation['payload'] = $result;
	}
	return array( 'status' => false === $result ? 'failed' : 'passed', 'observation' => $observation );
}

/** @param array<string,mixed> $case Case. @param array<string,mixed> $observation Observation. @return array<string,mixed> */
private static function execute_fuzz_suite_json_workload( string $resolved, array $case, array $observation, string $case_id, string $artifact_name = '' ): array {
	$decoded = json_decode( (string) file_get_contents( $resolved ), true );
	if ( ! is_array( $decoded ) ) {
		return array( 'status' => 'error', 'observation' => $observation, 'diagnostic' => self::fuzz_suite_diagnostic( 'error', 'wp_codebox_fuzz_workload_json_invalid', 'JSON workload file could not be decoded.', array( 'case_id' => $case_id, 'path' => $resolved ) ) );
	}

	$steps = is_array( $decoded['run'] ?? null ) ? $decoded['run'] : array();
	if ( empty( $steps ) ) {
		return array( 'status' => 'error', 'observation' => $observation, 'diagnostic' => self::fuzz_suite_diagnostic( 'error', 'wp_codebox_fuzz_workload_run_missing', 'JSON workload requires at least one run step.', array( 'case_id' => $case_id, 'path' => $resolved ) ) );
	}

	$step_results = array();
	$diagnostics = array();
	$status = 'passed';
	foreach ( $steps as $index => $step ) {
		if ( ! is_array( $step ) ) {
			$diagnostics[] = self::fuzz_suite_diagnostic( 'error', 'wp_codebox_fuzz_workload_step_invalid', 'JSON workload run steps must be objects.', array( 'case_id' => $case_id, 'step_index' => $index ) );
			$status = 'error';
			break;
		}

		$result = self::execute_fuzz_suite_json_workload_run_step( $step, $index );
		$step_results[] = $result;
		foreach ( is_array( $result['diagnostics'] ?? null ) ? $result['diagnostics'] : array() as $diagnostic ) {
			$diagnostics[] = $diagnostic;
		}
		if ( 'passed' !== ( $result['status'] ?? 'error' ) ) {
			$status = (string) ( $result['status'] ?? 'error' );
			break;
		}
	}

	$report = array(
		'schema'      => 'wp-codebox/json-workload-result/v1',
		'caseId'      => $case_id,
		'workload'    => array_filter( array( 'id' => (string) ( $decoded['id'] ?? '' ), 'source' => (string) ( $decoded['source'] ?? '' ) ), static fn( mixed $value ): bool => '' !== $value ),
		'status'      => $status,
		'generatedAt' => gmdate( 'Y-m-d\TH:i:s\Z' ),
		'steps'       => $step_results,
		'diagnostics' => $diagnostics,
		'metadata'    => is_array( $decoded['metadata'] ?? null ) ? $decoded['metadata'] : array(),
	);

	$artifact_result = self::write_fuzz_suite_workload_artifact( $report, $case, (string) ( $decoded['id'] ?? $case_id ), $artifact_name );
	if ( is_wp_error( $artifact_result ) ) {
		return array( 'status' => 'error', 'observation' => $observation, 'diagnostic' => self::fuzz_suite_diagnostic( 'error', $artifact_result->code, $artifact_result->get_error_message(), array( 'case_id' => $case_id ) ) );
	}

	$observation['workload_id'] = (string) ( $decoded['id'] ?? '' );
	$observation['step_count'] = count( $step_results );
	$observation['artifact'] = $artifact_result['path'];
	$observation['payload'] = $report;
	return array( 'status' => $status, 'observation' => $observation, 'artifactRefs' => array( self::fuzz_suite_workload_artifact_ref( $artifact_result['path'] ) ), 'diagnostic' => $diagnostics[0] ?? null );
}

/** @param array<string,mixed> $step Step. @return array<string,mixed> */
private static function execute_fuzz_suite_json_workload_run_step( array $step, int $index ): array {
	$type = (string) ( $step['type'] ?? '' );
	return match ( $type ) {
		'php'                    => self::execute_fuzz_suite_json_php_step( $step, $index ),
		'hook-hotspot-sampler'   => self::execute_fuzz_suite_json_hook_hotspot_sampler_step( $step, $index ),
		'rest-db-query-profiler' => self::execute_fuzz_suite_json_rest_db_query_profiler_step( $step, $index ),
		default                  => array( 'type' => $type, 'index' => $index, 'status' => 'skipped', 'diagnostics' => array( self::fuzz_suite_diagnostic( 'warning', 'wp_codebox_fuzz_workload_step_unsupported', 'JSON workload run step type is not supported by this runner.', array( 'step_index' => $index, 'type' => $type ) ) ) ),
	};
}

/** @param array<string,mixed> $step Step. @return array<string,mixed> */
private static function execute_fuzz_suite_json_php_step( array $step, int $index ): array {
	$code = (string) ( $step['code'] ?? '' );
	ob_start();
	try {
		$result = eval( $code );
	} finally {
		$output = ob_get_clean();
	}
	return array_filter(
		array(
			'type'        => 'php',
			'index'       => $index,
			'success'     => true,
			'status'      => 'passed',
			'observation' => array_filter( array( 'outputBytes' => strlen( (string) $output ), 'returnType' => gettype( $result ), 'result' => is_array( $result ) ? $result : null ), static fn( mixed $value ): bool => null !== $value ),
		),
		static fn( mixed $value ): bool => ! ( is_array( $value ) && empty( $value ) )
	);
}

/** @param array<string,mixed> $step Step. @return array<string,mixed> */
private static function execute_fuzz_suite_json_rest_db_query_profiler_step( array $step, int $index ): array {
	$cases = is_array( $step['rest_request_cases'] ?? null ) ? $step['rest_request_cases'] : array();
	$requests = array();
	$failed = 0;
	foreach ( $cases as $case ) {
		if ( ! is_array( $case ) ) {
			continue;
		}
		$request_result = self::profile_fuzz_suite_rest_request_queries( $case, (int) ( $step['sampleLimit'] ?? 50 ), (int) ( $step['queryLengthLimit'] ?? 500 ), (int) ( $step['fingerprintLimit'] ?? 50 ) );
		if ( (int) ( $request_result['status'] ?? 0 ) >= 500 ) {
			++$failed;
		}
		$requests[] = $request_result;
	}

	$total_queries        = array_sum( array_map( static fn( array $request ): int => (int) ( $request['queryCount'] ?? 0 ), $requests ) );
	$query_fingerprints  = self::merge_fuzz_suite_query_fingerprints( $requests, (int) ( $step['fingerprintLimit'] ?? 50 ) );
	$fingerprint_count   = count( $query_fingerprints );
	return array(
		'type'        => 'rest-db-query-profiler',
		'index'       => $index,
		'success'     => 0 === $failed,
		'status'      => 0 === $failed ? 'passed' : 'failed',
		'observation' => array( 'metricPrefix' => (string) ( $step['metric-prefix'] ?? 'rest_db_query_profile' ), 'requestCount' => count( $requests ), 'queryCount' => $total_queries, 'fingerprintCount' => $fingerprint_count ),
		'metrics'     => array( (string) ( $step['metric-prefix'] ?? 'rest_db_query_profile' ) . '.query_count' => $total_queries, (string) ( $step['metric-prefix'] ?? 'rest_db_query_profile' ) . '.request_count' => count( $requests ), (string) ( $step['metric-prefix'] ?? 'rest_db_query_profile' ) . '.fingerprint_count' => $fingerprint_count ),
		'requests'    => $requests,
		'queryFingerprints' => $query_fingerprints,
	);
}

/** @param array<string,mixed> $step Step. @return array<string,mixed> */
private static function execute_fuzz_suite_json_hook_hotspot_sampler_step( array $step, int $index ): array {
	$cases = is_array( $step['rest_request_cases'] ?? null ) ? $step['rest_request_cases'] : array();
	$requests = array();
	$failed = 0;
	foreach ( $cases as $case ) {
		if ( ! is_array( $case ) ) {
			continue;
		}
		$request_result = self::sample_fuzz_suite_rest_request_hooks( $case, (int) ( $step['sampleLimit'] ?? 50 ), (int) ( $step['hookLimit'] ?? 500 ) );
		if ( (int) ( $request_result['status'] ?? 0 ) >= 500 ) {
			++$failed;
		}
		$requests[] = $request_result;
	}

	$total_hooks = array_sum( array_map( static fn( array $request ): int => (int) ( $request['hookCount'] ?? 0 ), $requests ) );
	return array(
		'type'        => 'hook-hotspot-sampler',
		'index'       => $index,
		'success'     => 0 === $failed,
		'status'      => 0 === $failed ? 'passed' : 'failed',
		'observation' => array( 'metricPrefix' => (string) ( $step['metric-prefix'] ?? 'wp_hook_hotspot' ), 'requestCount' => count( $requests ), 'hookCount' => $total_hooks ),
		'metrics'     => array( (string) ( $step['metric-prefix'] ?? 'wp_hook_hotspot' ) . '.hook_count' => $total_hooks, (string) ( $step['metric-prefix'] ?? 'wp_hook_hotspot' ) . '.request_count' => count( $requests ) ),
		'requests'    => $requests,
	);
}

/** @param array<string,mixed> $case Case. @return array<string,mixed> */
private static function profile_fuzz_suite_rest_request_queries( array $case, int $sample_limit, int $query_length_limit, int $fingerprint_limit ): array {
	global $wpdb;
	self::ensure_fuzz_suite_rest_routes_registered();
	$path = (string) ( $case['path'] ?? '' );
	$request = new WP_REST_Request( strtoupper( (string) ( $case['method'] ?? 'GET' ) ), $path );
	foreach ( is_array( $case['params'] ?? null ) ? $case['params'] : array() as $key => $value ) {
		$request->set_param( (string) $key, $value );
	}
	$captured_queries = array();
	$query_filter     = static function ( $query ) use ( &$captured_queries ) {
		$captured_queries[] = array( (string) $query, 0.0, 'query filter' );
		return $query;
	};
	$before = is_object( $wpdb ) && is_array( $wpdb->queries ?? null ) ? count( $wpdb->queries ) : 0;
	if ( function_exists( 'add_filter' ) ) {
		add_filter( 'query', $query_filter, PHP_INT_MAX, 1 );
	}
	try {
		$response = rest_do_request( $request );
	} finally {
		if ( function_exists( 'remove_filter' ) ) {
			remove_filter( 'query', $query_filter, PHP_INT_MAX );
		}
	}
	$after_queries = is_object( $wpdb ) && is_array( $wpdb->queries ?? null ) ? array_slice( $wpdb->queries, $before ) : array();
	if ( empty( $after_queries ) && ! empty( $captured_queries ) ) {
		$after_queries = $captured_queries;
	}
	$queries      = array_slice( array_map( static fn( mixed $query ): array => self::normalize_fuzz_suite_query_sample( $query, $query_length_limit ), $after_queries ), 0, max( 0, $sample_limit ) );
	$fingerprints = self::build_fuzz_suite_query_fingerprints( $after_queries, $query_length_limit, $fingerprint_limit );
	return array( 'id' => (string) ( $case['id'] ?? $path ), 'method' => strtoupper( (string) ( $case['method'] ?? 'GET' ) ), 'path' => $path, 'status' => (int) $response->get_status(), 'queryCount' => count( $after_queries ), 'sampledQueries' => $queries, 'queryFingerprints' => $fingerprints );
}

/** @param array<string,mixed> $case Case. @return array<string,mixed> */
private static function sample_fuzz_suite_rest_request_hooks( array $case, int $sample_limit, int $hook_limit ): array {
	self::ensure_fuzz_suite_rest_routes_registered();
	$path = (string) ( $case['path'] ?? '' );
	$request = new WP_REST_Request( strtoupper( (string) ( $case['method'] ?? 'GET' ) ), $path );
	foreach ( is_array( $case['params'] ?? null ) ? $case['params'] : array() as $key => $value ) {
		$request->set_param( (string) $key, $value );
	}

	$started = microtime( true );
	$samples = array();
	$hook_count = 0;
	$truncated = false;
	$sampler = static function () use ( &$samples, &$hook_count, &$truncated, $hook_limit ): void {
		if ( ! function_exists( 'current_filter' ) ) {
			return;
		}
		$hook = self::normalize_fuzz_suite_hook_name( (string) current_filter() );
		if ( '' === $hook ) {
			return;
		}
		++$hook_count;
		if ( ! isset( $samples[ $hook ] ) && count( $samples ) >= max( 1, $hook_limit ) ) {
			$truncated = true;
			return;
		}
		$now = microtime( true );
		if ( ! isset( $samples[ $hook ] ) ) {
			$samples[ $hook ] = array( 'hook' => $hook, 'count' => 0, 'first' => $now, 'last' => $now, 'callbackCount' => self::fuzz_suite_registered_callback_count( $hook ) );
		}
		++$samples[ $hook ]['count'];
		$samples[ $hook ]['last'] = $now;
	};

	if ( function_exists( 'add_filter' ) ) {
		add_filter( 'all', $sampler, PHP_INT_MIN, 0 );
	}
	try {
		$response = rest_do_request( $request );
	} finally {
		if ( function_exists( 'remove_filter' ) ) {
			remove_filter( 'all', $sampler, PHP_INT_MIN );
		}
	}

	$hotspots = array_values( array_map( static fn( array $sample ): array => array_filter( array( 'hook' => $sample['hook'], 'count' => (int) $sample['count'], 'elapsedMs' => (int) round( max( 0, ( (float) $sample['last'] - (float) $sample['first'] ) * 1000 ) ), 'callbackCount' => (int) $sample['callbackCount'] ), static fn( mixed $value ): bool => 0 !== $value && '' !== $value ), $samples ) );
	usort( $hotspots, static fn( array $a, array $b ): int => ( (int) ( $b['count'] ?? 0 ) <=> (int) ( $a['count'] ?? 0 ) ) ?: strcmp( (string) ( $a['hook'] ?? '' ), (string) ( $b['hook'] ?? '' ) ) );
	$limit = max( 0, $sample_limit );
	return array( 'id' => (string) ( $case['id'] ?? $path ), 'method' => strtoupper( (string) ( $case['method'] ?? 'GET' ) ), 'path' => $path, 'status' => (int) $response->get_status(), 'hookCount' => $hook_count, 'sampledHookCount' => count( $hotspots ), 'totalElapsedMs' => (int) round( max( 0, ( microtime( true ) - $started ) * 1000 ) ), 'truncated' => $truncated || count( $hotspots ) > $limit, 'hookHotspots' => array_slice( $hotspots, 0, $limit ) );
}

private static function normalize_fuzz_suite_hook_name( string $hook ): string {
	$hook = preg_replace( '/[^A-Za-z0-9_\.\-\/]/', '', $hook );
	return substr( (string) $hook, 0, 120 );
}

private static function fuzz_suite_registered_callback_count( string $hook ): int {
	global $wp_filter;
	$wp_hook = is_array( $wp_filter ?? null ) ? ( $wp_filter[ $hook ] ?? null ) : null;
	$callbacks = is_object( $wp_hook ) && isset( $wp_hook->callbacks ) && is_array( $wp_hook->callbacks ) ? $wp_hook->callbacks : ( is_array( $wp_hook ) ? $wp_hook : array() );
	$count = 0;
	foreach ( $callbacks as $priority_callbacks ) {
		$count += is_array( $priority_callbacks ) ? count( $priority_callbacks ) : 0;
	}
	return $count;
}

private static function ensure_fuzz_suite_rest_routes_registered(): void {
	static $registered = false;
	if ( $registered ) {
		return;
	}
	$registered = true;
	self::refresh_fuzz_suite_rest_server();
}

private static function refresh_fuzz_suite_rest_server(): void {
	if ( function_exists( 'rest_get_server' ) ) {
		global $wp_rest_server;
		$wp_rest_route_was_set  = isset( $GLOBALS['wp'] )
			&& is_object( $GLOBALS['wp'] )
			&& isset( $GLOBALS['wp']->query_vars )
			&& is_array( $GLOBALS['wp']->query_vars )
			&& array_key_exists( 'rest_route', $GLOBALS['wp']->query_vars );
		$wp_rest_route          = $wp_rest_route_was_set ? $GLOBALS['wp']->query_vars['rest_route'] : null;
		$get_rest_route_was_set = array_key_exists( 'rest_route', $_GET );
		$get_rest_route         = $get_rest_route_was_set ? $_GET['rest_route'] : null;
		if ( $wp_rest_route_was_set ) {
			unset( $GLOBALS['wp']->query_vars['rest_route'] );
		}
		unset( $_GET['rest_route'] );
		$wp_rest_server = null;
		try {
			rest_get_server();
		} finally {
			if ( $wp_rest_route_was_set ) {
				$GLOBALS['wp']->query_vars['rest_route'] = $wp_rest_route;
			}
			if ( $get_rest_route_was_set ) {
				$_GET['rest_route'] = $get_rest_route;
			}
		}
	}
}

/** @return array<string,mixed> */
private static function normalize_fuzz_suite_query_sample( mixed $query, int $query_length_limit ): array {
	$sql = is_array( $query ) ? (string) ( $query[0] ?? '' ) : (string) $query;
	$time = is_array( $query ) ? (float) ( $query[1] ?? 0 ) : 0.0;
	$redacted = self::normalize_fuzz_suite_query_sql( $sql );
	return array_filter( array( 'sql' => substr( $redacted, 0, max( 0, $query_length_limit ) ), 'time' => $time ), static fn( mixed $value ): bool => '' !== $value && 0.0 !== $value );
}

private static function normalize_fuzz_suite_query_sql( string $sql ): string {
	$redacted = preg_replace( '/\/\*.*?\*\//s', '/* ? */', $sql );
	$redacted = preg_replace( "/\\b(?:x|b)'(?:''|[^'])*'/i", "'?'", is_string( $redacted ) ? $redacted : $sql );
	$redacted = preg_replace( "/'(?:''|[^'])*'/", "'?'", is_string( $redacted ) ? $redacted : $sql );
	$redacted = preg_replace( '/"(?:""|[^"])*"/', '"?"', is_string( $redacted ) ? $redacted : $sql );
	$redacted = preg_replace( '/--[^\r\n]*/', '-- ?', is_string( $redacted ) ? $redacted : $sql );
	$redacted = preg_replace( '/#[^\r\n]*/', '# ?', is_string( $redacted ) ? $redacted : $sql );
	$redacted = preg_replace( '/\b0x[0-9a-f]+\b/i', '?', is_string( $redacted ) ? $redacted : $sql );
	$redacted = preg_replace( '/\b[-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?\b/i', '?', is_string( $redacted ) ? $redacted : $sql );
	$redacted = preg_replace( '/\s+/', ' ', is_string( $redacted ) ? $redacted : $sql );
	$redacted = trim( (string) $redacted );
	do {
		$previous = $redacted;
		$redacted = (string) preg_replace( '/\bIN\s*\(\s*\?(?:\s*,\s*\?)+\s*\)/i', 'IN (?)', $redacted );
	} while ( $previous !== $redacted );
	return $redacted;
}

/** @param array<int,mixed> $queries Queries. @return array<int,array<string,mixed>> */
private static function build_fuzz_suite_query_fingerprints( array $queries, int $query_length_limit, int $fingerprint_limit ): array {
	$groups = array();
	foreach ( $queries as $query ) {
		$sql         = is_array( $query ) ? (string) ( $query[0] ?? '' ) : (string) $query;
		$normalized  = self::normalize_fuzz_suite_query_sql( $sql );
		$fingerprint = strtolower( $normalized );
		if ( '' === $fingerprint ) {
			continue;
		}
		if ( ! isset( $groups[ $fingerprint ] ) ) {
			$groups[ $fingerprint ] = array( 'fingerprint' => substr( $fingerprint, 0, max( 0, $query_length_limit ) ), 'count' => 0, 'examples' => array() );
		}
		++$groups[ $fingerprint ]['count'];
		$example = substr( $normalized, 0, max( 0, $query_length_limit ) );
		if ( count( $groups[ $fingerprint ]['examples'] ) < 3 && ! in_array( $example, $groups[ $fingerprint ]['examples'], true ) ) {
			$groups[ $fingerprint ]['examples'][] = $example;
		}
	}
	$fingerprints = array_values( $groups );
	usort( $fingerprints, static fn( array $a, array $b ): int => ( (int) $b['count'] <=> (int) $a['count'] ) ?: strcmp( (string) $a['fingerprint'], (string) $b['fingerprint'] ) );
	return array_slice( $fingerprints, 0, max( 0, $fingerprint_limit ) );
}

/** @param array<int,array<string,mixed>> $requests Requests. @return array<int,array<string,mixed>> */
private static function merge_fuzz_suite_query_fingerprints( array $requests, int $fingerprint_limit ): array {
	$groups = array();
	foreach ( $requests as $request ) {
		foreach ( is_array( $request['queryFingerprints'] ?? null ) ? $request['queryFingerprints'] : array() as $group ) {
			if ( ! is_array( $group ) ) {
				continue;
			}
			$fingerprint = (string) ( $group['fingerprint'] ?? '' );
			if ( '' === $fingerprint ) {
				continue;
			}
			if ( ! isset( $groups[ $fingerprint ] ) ) {
				$groups[ $fingerprint ] = array( 'fingerprint' => $fingerprint, 'count' => 0, 'examples' => array() );
			}
			$groups[ $fingerprint ]['count'] += (int) ( $group['count'] ?? 0 );
			foreach ( is_array( $group['examples'] ?? null ) ? $group['examples'] : array() as $example ) {
				$example = (string) $example;
				if ( count( $groups[ $fingerprint ]['examples'] ) < 3 && '' !== $example && ! in_array( $example, $groups[ $fingerprint ]['examples'], true ) ) {
					$groups[ $fingerprint ]['examples'][] = $example;
				}
			}
		}
	}
	$fingerprints = array_values( $groups );
	usort( $fingerprints, static fn( array $a, array $b ): int => ( (int) $b['count'] <=> (int) $a['count'] ) ?: strcmp( (string) $a['fingerprint'], (string) $b['fingerprint'] ) );
	return array_slice( $fingerprints, 0, max( 0, $fingerprint_limit ) );
}

/** @param array<string,mixed> $observation Observation. @return array<string,mixed> */
private static function fuzz_suite_step_unsupported( string $command, array $observation, string $case_id ): array {
	$reason = self::fuzz_suite_unsupported_step_reason( $command, $observation );
	return array( 'status' => 'skipped', 'observation' => $observation, 'diagnostic' => self::fuzz_suite_diagnostic( 'warning', $reason['code'], $reason['message'], array_filter( array( 'case_id' => $case_id, 'command' => $command, 'target_kind' => $observation['targetKind'] ?? null, 'target_id' => $observation['targetId'] ?? null, 'action' => $observation['action'] ?? null, 'reason' => $reason['reason'] ) ) ) );
}

/** @param array<string,mixed> $observation Observation. @return array{code:string,message:string,reason:string} */
private static function fuzz_suite_unsupported_step_reason( string $command, array $observation ): array {
	if ( in_array( $observation['targetKind'] ?? '', array( 'command', 'runtime' ), true ) ) {
		return array( 'code' => 'wp_codebox_fuzz_target_command_unsupported', 'reason' => 'target_command_unsupported', 'message' => 'Command and runtime fuzz-suite targets require the runtime command executor; the public PHP fuzz-suite ability records a structured skip.' );
	}

	$runtime_commands = array(
		'wordpress.wp-cli'             => array( 'wp_codebox_fuzz_runtime_action_wp_cli_unsupported', 'runtime_action_wp_cli_unsupported', 'Runtime-action type wp_cli requires the runtime command executor; the public PHP fuzz-suite ability records a structured skip.' ),
		'wordpress.run-php'            => array( 'wp_codebox_fuzz_runtime_action_php_unsupported', 'runtime_action_php_unsupported', 'Runtime-action type php requires raw PHP execution and is not accepted by the public PHP fuzz-suite ability.' ),
		'wordpress.browser-actions'    => array( 'wp_codebox_fuzz_runtime_action_browser_unsupported', 'runtime_action_browser_unsupported', 'Runtime-action type browser requires the browser runtime executor; the public PHP fuzz-suite ability records a structured skip.' ),
		'wordpress.browser-probe'      => array( 'wp_codebox_fuzz_runtime_action_browser_probe_unsupported', 'runtime_action_browser_probe_unsupported', 'Runtime-action type browser_probe requires the browser runtime executor; the public PHP fuzz-suite ability records a structured skip.' ),
		'wordpress.editor-open'        => array( 'wp_codebox_fuzz_runtime_action_editor_open_unsupported', 'runtime_action_editor_open_unsupported', 'Runtime-action type editor_open requires the browser/editor runtime executor; the public PHP fuzz-suite ability records a structured skip.' ),
		'wordpress.admin-page-load'    => array( 'wp_codebox_fuzz_runtime_action_admin_page_unsupported', 'runtime_action_admin_page_unsupported', 'Runtime-action type admin_page requires the page-load runtime executor; the public PHP fuzz-suite ability records a structured skip.' ),
		'wordpress.frontend-page-load' => array( 'wp_codebox_fuzz_runtime_action_page_unsupported', 'runtime_action_page_unsupported', 'Runtime-action type page requires the page-load runtime executor; the public PHP fuzz-suite ability records a structured skip.' ),
		'wordpress.runtime-action'     => array( 'wp_codebox_fuzz_runtime_action_unsupported', 'runtime_action_unsupported', 'Runtime-action type is not supported by the public PHP fuzz-suite ability.' ),
	);

	if ( isset( $runtime_commands[ $command ] ) ) {
		return array( 'code' => $runtime_commands[ $command ][0], 'reason' => $runtime_commands[ $command ][1], 'message' => $runtime_commands[ $command ][2] );
	}

	return array( 'code' => 'wp_codebox_fuzz_step_unsupported', 'reason' => 'step_unsupported', 'message' => 'Fuzz suite step is not supported by this runner.' );
}

/** @return array<string,mixed> */
private static function fuzz_suite_case_result( string $id, string $status, array $diagnostics, array $artifact_refs = array(), array $metadata = array() ): array {
	$result = array(
			'id'           => $id,
			'status'       => $status,
			'success'      => 'passed' === $status,
			'skipReason'   => 'skipped' === $status ? (string) ( $diagnostics[0]['code'] ?? '' ) : null,
			'diagnostics'  => $diagnostics,
			'artifactRefs' => self::dedupe_fuzz_suite_artifact_refs( $artifact_refs ),
			'metadata'     => $metadata,
		);
	return array_filter(
		$result,
		static fn( mixed $value ): bool => null !== $value && ! ( is_array( $value ) && empty( $value ) )
	);
}

/** @return array<string,mixed> */
private static function fuzz_suite_diagnostic( string $severity, string $code, string $message, array $metadata = array() ): array {
	return array_filter( array( 'severity' => $severity, 'code' => $code, 'message' => $message, 'metadata' => $metadata ), static fn( mixed $value ): bool => ! ( is_array( $value ) && empty( $value ) ) );
}

/** @param array<int,array<string,mixed>> $results Results. @return array<string,int> */
private static function fuzz_suite_summary( array $results ): array {
	$summary = array( 'total' => count( $results ), 'passed' => 0, 'failed' => 0, 'error' => 0, 'skipped' => 0 );
	foreach ( $results as $result ) {
		$status = (string) ( $result['status'] ?? 'error' );
		if ( isset( $summary[ $status ] ) ) {
			$summary[ $status ]++;
		}
	}
	return $summary;
}

/** @param array<string,int> $summary Summary. */
private static function fuzz_suite_status( array $summary ): string {
	if ( $summary['error'] > 0 ) {
		return 'error';
	}
	if ( $summary['failed'] > 0 ) {
		return 'failed';
	}
	if ( $summary['skipped'] === $summary['total'] && $summary['total'] > 0 ) {
		return 'skipped';
	}
	return 'passed';
}

/** @param array<string,mixed> $case Case. @return array<int,array<string,mixed>> */
private static function fuzz_suite_declared_artifact_refs( array $case ): array {
	$refs = array();
	foreach ( is_array( $case['artifacts'] ?? null ) ? $case['artifacts'] : array() as $artifact ) {
		if ( ! is_array( $artifact ) || empty( $artifact['path'] ) ) {
			continue;
		}
		$refs[] = array_filter( array( 'name' => (string) ( $artifact['name'] ?? '' ), 'path' => (string) $artifact['path'], 'kind' => (string) ( $artifact['role'] ?? 'fuzz_report' ), 'contentType' => 'application/json', 'metadata' => is_array( $artifact['metadata'] ?? null ) ? $artifact['metadata'] : array() ), static fn( mixed $value ): bool => ! ( '' === $value || ( is_array( $value ) && empty( $value ) ) ) );
	}
	return $refs;
}

/** @param array<int,array<string,mixed>> $refs Refs. @return array<int,array<string,mixed>> */
private static function dedupe_fuzz_suite_artifact_refs( array $refs ): array {
	$seen = array();
	$output = array();
	foreach ( $refs as $ref ) {
		$key = (string) ( $ref['kind'] ?? '' ) . ':' . (string) ( $ref['path'] ?? '' );
		if ( isset( $seen[ $key ] ) ) {
			$output[ $seen[ $key ] ] = array_merge( $output[ $seen[ $key ] ], $ref );
			continue;
		}
		$seen[ $key ] = count( $output );
		$output[] = $ref;
	}
	return $output;
}

/** @param array<int,array<string,mixed>> $refs Refs. @param string[] $names Names. @return array<int,array<string,mixed>> */
private static function fuzz_suite_filter_artifact_refs( array $refs, array $names ): array {
	$names = array_values( array_filter( array_map( 'strval', $names ), static fn( string $name ): bool => '' !== $name ) );
	if ( empty( $names ) ) {
		return $refs;
	}
	$allowed = array_fill_keys( $names, true );
	return array_values( array_filter( $refs, static fn( array $ref ): bool => isset( $allowed[ (string) ( $ref['name'] ?? '' ) ] ) ) );
}

/** @param array<string,string> $args Args. @return array<int,array{surface:string,path:string}> */
private static function fuzz_suite_browser_coverage_targets( array $args ): array {
	$surface = self::normalize_fuzz_suite_browser_coverage_surface( (string) ( $args['surface'] ?? 'frontend' ) );
	$paths = self::csv_fuzz_suite_arg( (string) ( $args['paths'] ?? $args['path'] ?? $args['urls'] ?? $args['url'] ?? '' ) );
	if ( empty( $paths ) ) {
		$paths = 'admin' === $surface ? array( '/wp-admin/index.php' ) : array( '/', '/shop/', '/product/', '/cart/', '/checkout/' );
	}

	$targets = array();
	foreach ( $paths as $path ) {
		$target_surface = str_starts_with( $path, '/wp-admin/' ) ? 'admin' : $surface;
		$targets[] = array( 'surface' => $target_surface, 'path' => $path );
	}
	return $targets;
}

private static function normalize_fuzz_suite_browser_coverage_surface( string $surface ): string {
	$surface = strtolower( trim( $surface ) );
	return in_array( $surface, array( 'admin', 'admin_pages', 'wp-admin' ), true ) ? 'admin' : 'frontend';
}

/** @return string[] */
private static function csv_fuzz_suite_arg( string $value ): array {
	return array_values( array_filter( array_map( 'trim', explode( ',', $value ) ), static fn( string $entry ): bool => '' !== $entry ) );
}

private static function fuzz_suite_browser_coverage_url( string $path ): string {
	if ( str_contains( $path, "\0" ) ) {
		return '';
	}
	$home = home_url( '/' );
	if ( preg_match( '#^https?://#i', $path ) ) {
		$path_host = wp_parse_url( $path, PHP_URL_HOST );
		$home_host = wp_parse_url( $home, PHP_URL_HOST );
		return $path_host && $home_host && strtolower( (string) $path_host ) === strtolower( (string) $home_host ) ? $path : '';
	}
	if ( ! str_starts_with( $path, '/' ) || str_contains( $path, '..' ) ) {
		return '';
	}
	return home_url( $path );
}

/** @param array<string,mixed> $report Report. @param array<string,mixed> $case Case. @return array{path:string,bytes:int}|WP_Error */
private static function write_fuzz_suite_browser_coverage_artifact( array $report, array $case, string $artifact_name = '' ): array|WP_Error {
	$refs = self::fuzz_suite_filter_artifact_refs( self::fuzz_suite_declared_artifact_refs( $case ), array( $artifact_name ) );
	$ref = $refs[0] ?? null;
	$relative_path = is_array( $ref ) ? (string) ( $ref['path'] ?? '' ) : '';
	if ( '' === $relative_path || str_starts_with( $relative_path, '/' ) || str_contains( $relative_path, '..' ) || str_contains( $relative_path, "\0" ) ) {
		return new WP_Error( 'wp_codebox_fuzz_browser_coverage_artifact_path_invalid', 'Browser coverage requires a safe relative declared artifact path.' );
	}

	$upload_dir = function_exists( 'wp_upload_dir' ) ? wp_upload_dir( null, false ) : array();
	$base_dir = is_array( $upload_dir ) && ! empty( $upload_dir['basedir'] ) ? (string) $upload_dir['basedir'] : rtrim( WP_CONTENT_DIR, DIRECTORY_SEPARATOR ) . DIRECTORY_SEPARATOR . 'uploads';
	$absolute = rtrim( $base_dir, DIRECTORY_SEPARATOR ) . DIRECTORY_SEPARATOR . str_replace( '/', DIRECTORY_SEPARATOR, $relative_path );
	$directory = dirname( $absolute );
	if ( ! self::ensure_fuzz_suite_directory( $directory ) ) {
		return new WP_Error( 'wp_codebox_fuzz_browser_coverage_artifact_directory_failed', 'Browser coverage could not create the artifact directory.' );
	}

	$encoded = wp_json_encode( $report, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES );
	if ( ! is_string( $encoded ) || false === file_put_contents( $absolute, $encoded . "\n" ) ) {
		return new WP_Error( 'wp_codebox_fuzz_browser_coverage_artifact_write_failed', 'Browser coverage could not write the artifact JSON file.' );
	}
	return array( 'path' => $relative_path, 'bytes' => strlen( $encoded ) + 1 );
}

/** @param array<string,mixed> $report Report. @param array<string,mixed> $case Case. @return array{path:string,bytes:int}|WP_Error */
private static function write_fuzz_suite_workload_artifact( array $report, array $case, string $workload_id, string $artifact_name = '' ): array|WP_Error {
	$refs = self::fuzz_suite_filter_artifact_refs( self::fuzz_suite_declared_artifact_refs( $case ), array( $artifact_name ) );
	$ref = $refs[0] ?? null;
	$relative_path = is_array( $ref ) ? (string) ( $ref['path'] ?? '' ) : '';
	if ( '' === $relative_path ) {
		$safe_id = preg_replace( '/[^A-Za-z0-9_.-]+/', '-', '' === $workload_id ? 'workload' : $workload_id );
		$relative_path = 'workloads/' . trim( (string) $safe_id, '-.' ) . '.json';
	}
	if ( '' === $relative_path || str_starts_with( $relative_path, '/' ) || str_contains( $relative_path, '..' ) || str_contains( $relative_path, "\0" ) ) {
		return new WP_Error( 'wp_codebox_fuzz_workload_artifact_path_invalid', 'JSON workload requires a safe relative artifact path.' );
	}

	$upload_dir = function_exists( 'wp_upload_dir' ) ? wp_upload_dir( null, false ) : array();
	$base_dir = is_array( $upload_dir ) && ! empty( $upload_dir['basedir'] ) ? (string) $upload_dir['basedir'] : rtrim( WP_CONTENT_DIR, DIRECTORY_SEPARATOR ) . DIRECTORY_SEPARATOR . 'uploads';
	$absolute = rtrim( $base_dir, DIRECTORY_SEPARATOR ) . DIRECTORY_SEPARATOR . str_replace( '/', DIRECTORY_SEPARATOR, $relative_path );
	$directory = dirname( $absolute );
	if ( ! self::ensure_fuzz_suite_directory( $directory ) ) {
		return new WP_Error( 'wp_codebox_fuzz_workload_artifact_directory_failed', 'JSON workload could not create the artifact directory.' );
	}

	$encoded = wp_json_encode( $report, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES );
	if ( ! is_string( $encoded ) || false === file_put_contents( $absolute, $encoded . "\n" ) ) {
		return new WP_Error( 'wp_codebox_fuzz_workload_artifact_write_failed', 'JSON workload could not write the artifact JSON file.' );
	}
	return array( 'path' => $relative_path, 'bytes' => strlen( $encoded ) + 1 );
}

/** @param array<string,mixed> $report Report. @return array{path:string,bytes:int}|WP_Error */
private static function write_fuzz_suite_declared_artifact( array $report, string $relative_path, string $label ): array|WP_Error {
	if ( '' === $relative_path || str_starts_with( $relative_path, '/' ) || str_contains( $relative_path, '..' ) || str_contains( $relative_path, "\0" ) ) {
		return new WP_Error( 'wp_codebox_fuzz_' . $label . '_artifact_path_invalid', 'Fuzz artifact summary requires safe relative declared artifact paths.' );
	}

	$upload_dir = function_exists( 'wp_upload_dir' ) ? wp_upload_dir( null, false ) : array();
	$base_dir = is_array( $upload_dir ) && ! empty( $upload_dir['basedir'] ) ? (string) $upload_dir['basedir'] : rtrim( WP_CONTENT_DIR, DIRECTORY_SEPARATOR ) . DIRECTORY_SEPARATOR . 'uploads';
	$absolute = rtrim( $base_dir, DIRECTORY_SEPARATOR ) . DIRECTORY_SEPARATOR . str_replace( '/', DIRECTORY_SEPARATOR, $relative_path );
	$directory = dirname( $absolute );
	if ( ! self::ensure_fuzz_suite_directory( $directory ) ) {
		return new WP_Error( 'wp_codebox_fuzz_' . $label . '_artifact_directory_failed', 'Fuzz artifact summary could not create the artifact directory.' );
	}

	$encoded = wp_json_encode( $report, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES );
	if ( ! is_string( $encoded ) || false === file_put_contents( $absolute, $encoded . "\n" ) ) {
		return new WP_Error( 'wp_codebox_fuzz_' . $label . '_artifact_write_failed', 'Fuzz artifact summary could not write the artifact JSON file.' );
	}
	return array( 'path' => $relative_path, 'bytes' => strlen( $encoded ) + 1 );
}

/** @return array<string,mixed> */
private static function fuzz_suite_workload_artifact_ref( string $path ): array {
	return array( 'name' => 'workload_result', 'path' => $path, 'kind' => 'fuzz_report', 'contentType' => 'application/json', 'metadata' => array( 'semantic_key' => 'fuzz.report' ) );
}

private static function ensure_fuzz_suite_directory( string $directory ): bool {
	if ( is_dir( $directory ) ) {
		return true;
	}
	if ( function_exists( 'wp_mkdir_p' ) ) {
		return (bool) wp_mkdir_p( $directory );
	}
	return mkdir( $directory, 0777, true );
}

/** @return array<string,mixed> */
private static function json_arg( string $value ): array {
	if ( '' === $value ) {
		return array();
	}
	$decoded = json_decode( $value, true );
	return is_array( $decoded ) ? $decoded : array();
}

private static function resolve_fuzz_suite_file_path( string $path ): string {
	if ( '' === $path || str_contains( $path, '${' ) || str_contains( $path, "\0" ) ) {
		return '';
	}
	$real = realpath( $path );
	if ( false === $real || ! is_readable( $real ) ) {
		return '';
	}
	$allowed = array_filter( array( realpath( ABSPATH ), realpath( WP_CONTENT_DIR ), realpath( get_temp_dir() ), realpath( (string) getenv( 'WP_CODEBOX_FUZZ_WORKLOAD_ROOT' ) ) ) );
	foreach ( $allowed as $root ) {
		if ( str_starts_with( $real, rtrim( (string) $root, DIRECTORY_SEPARATOR ) . DIRECTORY_SEPARATOR ) || $real === $root ) {
			return $real;
		}
	}
	return '';
}

/** @return array<string,mixed> */
private static function unsupported_public_runtime_envelope( string $schema, string $status, string $code, string $message, array $extra ): array {
	return array_merge(
		array(
			'success'     => false,
			'schema'      => $schema,
			'status'      => $status,
			'diagnostics' => array(
				array(
					'code'     => $code,
					'severity' => 'error',
					'message'  => $message,
				),
			),
		),
		$extra
	);
}

/** @param array<string,mixed> $input Ability input. @return string[] */
private static function unsafe_execution_fields( array $input ): array {
	$unsafe = array();
	foreach ( array( 'command' ) as $field ) {
		if ( array_key_exists( $field, $input ) ) {
			$unsafe[] = $field;
		}
	}
	self::collect_unsafe_execution_fields( $input, '', $unsafe );

	return array_values( array_unique( $unsafe ) );
}

/** @param mixed $value Input value. @param string $path Current input path. @param string[] $unsafe Unsafe path accumulator. */
private static function collect_unsafe_execution_fields( mixed $value, string $path, array &$unsafe ): void {
	if ( ! is_array( $value ) ) {
		return;
	}

	foreach ( $value as $key => $entry ) {
		$field = is_string( $key ) ? $key : (string) $key;
		$next_path = '' === $path ? $field : $path . '.' . $field;
		if ( 'metadata' === $field ) {
			continue;
		}
		if ( in_array( $field, array( 'code', 'php', 'php_code', 'raw_code', 'eval', 'shell' ), true ) ) {
			$unsafe[] = $next_path;
			continue;
		}

		self::collect_unsafe_execution_fields( $entry, $next_path, $unsafe );
	}
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function request_host_delegation( array $input ): array|WP_Error {
	return self::execute_host_delegation_request( $input );
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function create_browser_playground_session( array $input ): array|WP_Error {
	$input      = WP_Codebox_Browser_Task_Builder::local_browser_task_input( $input );
	$task_input = self::normalize_task_input( $input );
	if ( is_wp_error( $task_input ) ) {
		return $task_input;
	}

	$session_id = trim( (string) ( $input['sandbox_session_id'] ?? $input['session_id'] ?? '' ) );
	if ( '' === $session_id ) {
		$session_id = self::generate_id();
	}

	$playground = self::browser_playground( $input );
	if ( is_wp_error( $playground ) ) {
		return $playground;
	}

	$inheritance_payload = self::browser_inheritance_resolution_payload( $input );
	if ( is_wp_error( $inheritance_payload ) ) {
		return $inheritance_payload;
	}
	$input           = self::browser_input_with_inheritance( $input, $inheritance_payload['inheritance'] );
	if ( is_wp_error( $input ) ) {
		return $input;
	}
	$dependency_plan = self::browser_runtime_dependency_plan( $input, $inheritance_payload['inheritance'] );
	$browser_runner  = is_array( $input['browser_runner'] ?? null ) ? $input['browser_runner'] : array();
	$browser_plugins = self::browser_plugins( $input );
	if ( is_wp_error( $browser_plugins ) ) {
		return $browser_plugins;
	}
	$runtime = self::browser_runtime_dependencies( $input, $browser_plugins, $dependency_plan );
	if ( is_wp_error( $runtime ) ) {
		return $runtime;
	}
	$browser_plugins = $runtime['plugins'];

	$site_blueprint_artifact = self::browser_site_blueprint_artifact( $input );
	if ( is_wp_error( $site_blueprint_artifact ) ) {
		return $site_blueprint_artifact;
	}

	$base_blueprint = self::browser_blueprint_with_site_artifact( is_array( $input['blueprint'] ?? null ) ? $input['blueprint'] : array(), $site_blueprint_artifact );
	$blueprint      = self::browser_blueprint_with_runtime( $base_blueprint, $runtime, $playground );
	$prepared_runtime = self::browser_prepared_runtime_with_blueprints( is_array( $runtime['prepared_runtime'] ?? null ) ? $runtime['prepared_runtime'] : array(), $blueprint, $playground );
	$runtime['prepared_runtime'] = $prepared_runtime;
	$contained_site  = self::browser_contained_site_envelope( $input, $session_id, $playground, $runtime, $prepared_runtime, 'ready' );
	$artifacts       = self::browser_artifact_files( $input );
	if ( is_wp_error( $artifacts ) ) {
		return $artifacts;
	}
	$ready_to_code = self::browser_ready_to_code_signal( $input, $runtime );
	if ( false === ( $ready_to_code['emitted'] ?? false ) ) {
		$blocked_session = self::blocked_browser_playground_session( $session_id, $input, $task_input, $ready_to_code, $browser_plugins, $runtime, $artifacts, $playground, $blueprint, $site_blueprint_artifact );
		return self::browser_session_response_for_input( $blocked_session, $input );
	}

	$task_payload = self::browser_task_payload( $input, $task_input, $session_id, $artifacts, $inheritance_payload['inheritance'], $dependency_plan );
	$recipe = self::browser_agent_recipe( $task_input, $session_id, $browser_runner, $blueprint, $playground, $task_payload );
	if ( is_wp_error( $recipe ) ) {
		return $recipe;
	}
	$recipe_blueprint = is_array( $recipe['runtime']['blueprint'] ?? null ) ? $recipe['runtime']['blueprint'] : $blueprint;
	if ( is_array( $runtime['prepared_runtime'] ?? null ) ) {
		self::browser_prepared_runtime_cache_store( $runtime['prepared_runtime'], $recipe_blueprint );
	}
	$blueprint = $recipe_blueprint;
	$materialization = self::browser_materialization_contract( $recipe );

	$session = array(
		'success'          => true,
		'schema'           => 'wp-codebox/browser-playground-session/v1',
		'execution'        => 'browser-playground',
		'execution_scope'  => 'disposable-playground',
		'permission_model' => 'runtime-principal',
		'session'          => self::browser_session_envelope( $session_id, 'ready', $input ),
		'task'             => (string) $task_input['goal'],
		'task_input' => $task_input,
		'task_payload' => $task_payload,
		'agent'      => (string) ( $input['agent'] ?? 'wp-codebox-sandbox' ),
		'provider'   => self::browser_provider( $input, $inheritance_payload['inheritance'] ),
		'model'      => self::browser_model( $input, $inheritance_payload['inheritance'] ),
		'inheritance' => $inheritance_payload['inheritance'],
		'plugins'    => $browser_plugins,
		'runtime'    => $runtime,
		'contained_site' => $contained_site,
		'site_blueprint_artifact' => $site_blueprint_artifact,
		'materialization' => $materialization,
		'runtime_capabilities' => array_values(
			array_unique(
				array_filter(
					array_merge(
						array_map( 'strval', is_array( $input['runtime_capabilities'] ?? null ) ? $input['runtime_capabilities'] : array() ),
						array_map( 'strval', is_array( $input['runtime']['capabilities'] ?? null ) ? $input['runtime']['capabilities'] : array() ),
						array_map( 'strval', is_array( $runtime['capabilities'] ?? null ) ? $runtime['capabilities'] : array() )
					)
				)
			)
		),
		'playground' => array(
			'client_module_url'  => $playground['client_module_url'],
			'remote_url'         => $playground['remote_url'],
			'cors_proxy_url'     => $playground['cors_proxy_url'],
			'scope'              => (string) ( $playground['scope'] ?? $session_id ),
			'artifact_base_path' => self::browser_artifact_base_path( $playground ),
			'artifact_base_url'  => self::browser_artifact_base_url( $playground ),
			'preview_url'        => self::browser_preview_url( $artifacts, $playground ),
			'blueprint'          => self::browser_playground_blueprint( $blueprint, $playground ),
			'prepared_runtime'   => $prepared_runtime,
			'contained_site'     => $contained_site,
			'capabilities'       => array(
				'compile_blueprint' => true,
				'run_blueprint'     => true,
				'write_file'        => true,
				'run_php'           => true,
			),
			'provenance'         => $playground['provenance'],
		),
		'recipe'     => $recipe,
		'signals'    => array(
			'ready_to_code' => $ready_to_code,
		),
		'artifacts'  => array(
			'schema'             => 'wp-codebox/browser-artifacts/v1',
			'files'              => $artifacts,
			'preview_url'        => self::browser_preview_url( $artifacts, $playground ),
			'expected_artifacts' => $task_input['expected_artifacts'],
		),
	);

	return self::browser_session_response_for_input( $session, $input );
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function get_browser_contained_site_status( array $input ): array|WP_Error {
	$contained_site = is_array( $input['contained_site'] ?? null ) ? $input['contained_site'] : array();
	$recovery       = is_array( $contained_site['recovery']['input'] ?? null ) ? $contained_site['recovery']['input'] : array();
	$prepared       = is_array( $contained_site['prepared_runtime'] ?? null ) ? $contained_site['prepared_runtime'] : array();
	$source_digest  = is_array( $input['source_digest'] ?? null ) ? (string) ( $input['source_digest']['value'] ?? '' ) : (string) ( $input['source_digest'] ?? '' );
	if ( '' === $source_digest && is_array( $contained_site['source_digest'] ?? null ) ) {
		$source_digest = (string) ( $contained_site['source_digest']['value'] ?? '' );
	}

	$cache_key  = self::safe_key( (string) ( $input['cache_key'] ?? $recovery['cache_key'] ?? $prepared['cache_key'] ?? $input['site_id'] ?? $contained_site['site_id'] ?? '' ) );
	$input_hash = strtolower( trim( (string) ( $input['input_hash'] ?? $recovery['input_hash'] ?? $prepared['input_hash'] ?? $source_digest ) ) );
	if ( '' === $cache_key || ! preg_match( '/^[a-f0-9]{64}$/', $input_hash ) ) {
		return new WP_Error( 'wp_codebox_browser_contained_site_ref_invalid', 'Browser contained site status requires cache_key/site_id and a 64-character source digest.', array( 'status' => 400 ) );
	}

	$prepared_ref = array(
		'cache_key'  => $cache_key,
		'input_hash' => $input_hash,
	);
	$lookup = self::browser_prepared_runtime_cache_lookup( $prepared_ref );
	return self::browser_contained_site_status_envelope( $cache_key, $input_hash, $lookup );
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function preview_reuse_decision( array $input ): array|WP_Error {
	$status = self::get_browser_contained_site_status( $input );
	if ( is_wp_error( $status ) ) {
		return $status;
	}

	$open_mode = (string) ( $status['open_mode'] ?? 'materialize' );
	$action    = match ( $open_mode ) {
		'reuse_current' => 'reuse-current',
		'reuse_live', 'reuse_materialized', 'reuse_prepared_runtime' => 'hydrate-ref',
		'unavailable' => 'reload-required',
		default => 'create-new',
	};
	$reload_required = in_array( $action, array( 'create-new', 'reload-required' ), true );
	$identity_key    = hash( 'sha256', implode( ':', array( (string) ( $status['site_id'] ?? '' ), (string) ( $status['source_digest']['value'] ?? '' ), $open_mode ) ) );

	return array_filter(
		array(
			'success'         => true,
			'schema'          => 'wp-codebox/preview-reuse-decision/v1',
			'action'          => $action,
			'decision'        => $action,
			'identity_key'    => $identity_key,
			'reload_required' => $reload_required,
			'site_id'         => (string) ( $status['site_id'] ?? '' ),
			'open_mode'       => $open_mode,
			'reuse_level'     => (string) ( $status['reuse_level'] ?? 'none' ),
			'requires_materialization' => true === ( $status['requires_materialization'] ?? false ),
			'prepared_runtime_recoverable' => true === ( $status['prepared_runtime_recoverable'] ?? false ),
			'live'            => true === ( $status['live'] ?? false ),
			'current'         => true === ( $status['current'] ?? false ),
			'materialized'    => true === ( $status['materialized'] ?? false ),
			'status'          => (string) ( $status['status'] ?? '' ),
			'reason'          => (string) ( $status['resolution']['reason'] ?? '' ),
			'resolution'      => is_array( $status['resolution'] ?? null ) ? $status['resolution'] : array(),
			'status_result'   => $status,
			'recovery'        => is_array( $status['recovery'] ?? null ) ? $status['recovery'] : array(),
			'recovery_handle' => (string) ( $status['recovery_handle'] ?? '' ),
		),
		static fn( mixed $value ): bool => array() !== $value && '' !== $value
	);
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function open_browser_contained_site( array $input ): array|WP_Error {
	$status = self::get_browser_contained_site_status( $input );
	if ( is_wp_error( $status ) ) {
		return $status;
	}

	$contained_site = self::browser_contained_site_public_input( is_array( $input['contained_site'] ?? null ) ? $input['contained_site'] : array() );
	$session        = self::browser_contained_site_open_session( $input, $contained_site, $status );
	$preview_boot   = WP_Codebox_Browser_Task_Builder::preview_boot_config( $session );
	$preview_lease  = WP_Codebox_Browser_Task_Builder::preview_lease( $session );
	$blueprint_ref  = is_array( $status['blueprint_ref'] ?? null ) ? $status['blueprint_ref'] : array();
	$boot_contract  = true === ( $status['success'] ?? false ) ? WP_Codebox_Browser_Task_Builder::validate_browser_preview_boot_contract( $preview_boot, $blueprint_ref ) : array( 'valid' => false, 'reason' => '' );
	$site_id        = (string) ( $status['site_id'] ?? $contained_site['site_id'] ?? $input['site_id'] ?? '' );
	$session_id     = (string) ( $session['session']['id'] ?? '' );
	$preview_id     = (string) ( $contained_site['preview_id'] ?? $input['preview_id'] ?? '' );
	$scope          = (string) ( $preview_boot['scope'] ?? $contained_site['preview']['scope'] ?? '' );
	$resolution     = is_array( $status['resolution'] ?? null ) ? $status['resolution'] : array();
	$open_status    = (string) ( $status['status'] ?? 'miss' );
	$open_success   = true === ( $status['success'] ?? false );
	$lifecycle      = self::browser_contained_site_lifecycle( $open_status, $resolution );
	if ( $open_success && true !== ( $boot_contract['valid'] ?? false ) ) {
		$open_success = false;
		$open_status  = 'unusable';
		$resolution   = self::browser_contained_site_resolution( $open_status, array( 'invalidation' => array( 'reason' => (string) ( $boot_contract['reason'] ?? 'preview-boot-contract-unusable' ) ) ) );
		$lifecycle    = self::browser_contained_site_lifecycle( $open_status, $resolution );
	}
	$recovery        = self::browser_contained_site_open_recovery( $site_id, (string) ( $status['source_digest']['value'] ?? '' ) );
	$recovery_handle = self::browser_contained_site_recovery_handle( $site_id, (string) ( $status['source_digest']['value'] ?? '' ) );
	$digest_refs     = self::browser_contained_site_digest_refs( $status );

	$opened_site = array_filter(
		array_merge(
			$contained_site,
			$lifecycle,
			$digest_refs,
			array(
				'schema'           => 'wp-codebox/browser-contained-site/v1',
				'site_id'          => $site_id,
				'preview_id'       => $preview_id,
				'session_id'       => $session_id,
				'status'           => $open_status,
				'resolution'       => $resolution,
				'persistence'      => 'browser-contained',
				'source_digest'    => is_array( $status['source_digest'] ?? null ) ? $status['source_digest'] : array(),
				'prepared_runtime' => is_array( $status['prepared_runtime'] ?? null ) ? $status['prepared_runtime'] : array(),
				'blueprint_ref'    => $blueprint_ref,
				'preview_boot'     => $preview_boot,
				'preview_lease'    => $preview_lease,
				'session'          => self::browser_contained_site_session_identity( $session_id, $preview_id, $scope ),
				'recovery'         => $recovery,
				'recovery_handle'  => $recovery_handle,
			)
		),
		static fn( mixed $value ): bool => array() !== $value && '' !== $value
	);
	$session['contained_site'] = $opened_site;
	$preview_session          = WP_Codebox_Browser_Task_Builder::product_browser_session_dto( $session );

	return array_filter(
		array_merge(
			$lifecycle,
			$digest_refs,
			array(
				'success'       => $open_success,
				'schema'        => 'wp-codebox/browser-contained-site-open/v1',
				'site_id'       => $site_id,
				'status'        => $open_status,
				'resolution'    => $resolution,
				'contained_site' => $opened_site,
				'source_digest' => is_array( $status['source_digest'] ?? null ) ? $status['source_digest'] : array(),
				'prepared_runtime' => is_array( $status['prepared_runtime'] ?? null ) ? $status['prepared_runtime'] : array(),
				'blueprint_ref' => $blueprint_ref,
				'preview_boot'  => $preview_boot,
				'preview_lease' => $preview_lease,
				'preview_session' => $preview_session,
				'session'       => self::browser_contained_site_session_identity( $session_id, $preview_id, $scope ),
				'recovery'      => $recovery,
				'recovery_handle' => $recovery_handle,
			)
		),
		static fn( mixed $value ): bool => array() !== $value && '' !== $value
	);
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function open_or_create_browser_contained_site( array $input ): array|WP_Error {
	$mode = self::browser_contained_site_start_mode( $input );
	if ( is_wp_error( $mode ) ) {
		return $mode;
	}

	if ( 'prepare-new' === $mode ) {
		return self::create_browser_contained_site_start_result( $input, array(), $mode );
	}

	$decision = self::preview_reuse_decision( $input );
	if ( is_wp_error( $decision ) ) {
		return $decision;
	}
	$decision['mode'] = $mode;

	$action = (string) ( $decision['action'] ?? 'create-new' );
	if ( in_array( $action, array( 'reuse-current', 'hydrate-ref' ), true ) ) {
		$open = self::open_browser_contained_site( $input );
		if ( is_wp_error( $open ) ) {
			return $open;
		}

		if ( true === ( $open['success'] ?? false ) ) {
			return array_filter(
				array(
					'success'         => true,
					'schema'          => 'wp-codebox/browser-contained-site-open-or-create/v1',
					'mode'            => $mode,
					'action'          => 'opened',
					'decision'        => $decision,
					'identity_key'    => (string) ( $decision['identity_key'] ?? '' ),
					'reload_required' => false,
					'open'            => $open,
					'contained_site'  => is_array( $open['contained_site'] ?? null ) ? $open['contained_site'] : array(),
					'preview_boot'    => is_array( $open['preview_boot'] ?? null ) ? $open['preview_boot'] : array(),
					'preview_lease'   => is_array( $open['preview_lease'] ?? null ) ? $open['preview_lease'] : array(),
					'preview_session' => is_array( $open['preview_session'] ?? null ) ? $open['preview_session'] : array(),
					'session'         => is_array( $open['session'] ?? null ) ? $open['session'] : array(),
				),
				static fn( mixed $value ): bool => array() !== $value && '' !== $value
			);
		}
	}

	if ( 'open-only' === $mode ) {
		return array_filter(
			array(
				'success'         => false,
				'schema'          => 'wp-codebox/browser-contained-site-open-or-create/v1',
				'mode'            => $mode,
				'action'          => 'unavailable',
				'decision'        => $decision,
				'identity_key'    => (string) ( $decision['identity_key'] ?? '' ),
				'reload_required' => true,
				'error'           => array(
					'code'    => 'wp_codebox_browser_contained_site_unavailable',
					'message' => 'Browser contained site cannot be reused or recovered.',
				),
			),
			static fn( mixed $value ): bool => array() !== $value && '' !== $value
		);
	}

	return self::create_browser_contained_site_start_result( $input, $decision, $mode );
}

/** @param array<string,mixed> $input Ability input. @return string|WP_Error */
private static function browser_contained_site_start_mode( array $input ): string|WP_Error {
	$mode = trim( (string) ( $input['mode'] ?? '' ) );
	if ( '' === $mode ) {
		return new WP_Error( 'wp_codebox_browser_contained_site_mode_required', 'mode is required and must be one of open-only, open-or-create, or prepare-new.', array( 'status' => 400 ) );
	}

	if ( ! in_array( $mode, array( 'open-only', 'open-or-create', 'prepare-new' ), true ) ) {
		return new WP_Error( 'wp_codebox_browser_contained_site_mode_invalid', 'mode must be one of open-only, open-or-create, or prepare-new.', array( 'status' => 400, 'mode' => $mode ) );
	}

	return $mode;
}

/** @param array<string,mixed> $input Ability input. @param array<string,mixed> $decision Reuse decision. @return array<string,mixed>|WP_Error */
private static function create_browser_contained_site_start_result( array $input, array $decision, string $mode ): array|WP_Error {
	$created = self::create_browser_playground_session( $input );
	if ( is_wp_error( $created ) ) {
		return $created;
	}

	return array_filter(
		array(
			'success'         => true === ( $created['success'] ?? false ),
			'schema'          => 'wp-codebox/browser-contained-site-open-or-create/v1',
			'mode'            => $mode,
			'action'          => true === ( $created['success'] ?? false ) ? 'created' : 'blocked',
			'decision'        => $decision,
			'identity_key'    => (string) ( $decision['identity_key'] ?? '' ),
			'reload_required' => true,
			'created'         => $created,
			'contained_site'  => is_array( $created['contained_site'] ?? null ) ? $created['contained_site'] : array(),
			'preview_boot'    => is_array( $created['preview_boot'] ?? null ) ? $created['preview_boot'] : array(),
			'preview_session' => is_array( $created['preview_session'] ?? null ) ? $created['preview_session'] : array(),
			'session'         => is_array( $created['session'] ?? null ) ? $created['session'] : array(),
		),
		static fn( mixed $value ): bool => array() !== $value && '' !== $value
	);
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function create_browser_contained_site_session( array $input ): array|WP_Error {
	$created = self::create_browser_playground_session( $input );
	if ( is_wp_error( $created ) ) {
		return $created;
	}

	return self::browser_contained_site_facade_session( $created, 'created' );
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function boot_browser_contained_site_session( array $input ): array|WP_Error {
	$open = self::open_browser_contained_site( $input );
	if ( is_wp_error( $open ) ) {
		return $open;
	}

	$session = self::browser_contained_site_facade_session( $open, true === ( $open['success'] ?? false ) ? 'opened' : 'unavailable' );
	return array_filter(
		array(
			'success'             => true === ( $session['success'] ?? false ),
			'schema'              => 'wp-codebox/browser-contained-site-boot-result/v1',
			'action'              => (string) ( $session['action'] ?? '' ),
			'boot'                => is_array( $session['boot'] ?? null ) ? $session['boot'] : array(),
			'preview_lease'       => is_array( $session['preview_lease'] ?? null ) ? $session['preview_lease'] : array(),
			'contained_site'      => is_array( $session['contained_site'] ?? null ) ? $session['contained_site'] : array(),
			'startup_diagnostics' => is_array( $session['startup_diagnostics'] ?? null ) ? $session['startup_diagnostics'] : array(),
		),
		static fn( mixed $value ): bool => array() !== $value && '' !== $value
	);
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function preview_boot_ref( array $input ): array|WP_Error {
	$boot_result = self::boot_browser_contained_site_session( $input );
	if ( is_wp_error( $boot_result ) ) {
		return $boot_result;
	}

	$boot           = is_array( $boot_result['boot'] ?? null ) ? $boot_result['boot'] : array();
	$contained_site = is_array( $boot_result['contained_site'] ?? null ) ? $boot_result['contained_site'] : array();
	$preview_lease  = is_array( $boot_result['preview_lease'] ?? null ) ? $boot_result['preview_lease'] : array();
	$diagnostics    = is_array( $boot_result['startup_diagnostics'] ?? null ) ? $boot_result['startup_diagnostics'] : array();
	$blueprint_ref  = is_array( $boot['blueprint_ref'] ?? null ) ? $boot['blueprint_ref'] : array();
	$preview        = is_array( $boot['preview'] ?? null ) ? $boot['preview'] : $preview_lease;

	$stable_boot = array_filter(
		array(
			'schema'        => 'wp-codebox/browser-contained-site-boot/v1',
			'session_id'    => (string) ( $boot['session_id'] ?? '' ),
			'site_id'       => (string) ( $boot['site_id'] ?? '' ),
			'status'        => (string) ( $boot['status'] ?? '' ),
			'preview'       => $preview,
			'blueprint_ref' => $blueprint_ref,
		),
		static fn( mixed $value ): bool => array() !== $value && '' !== $value
	);

	return array_filter(
		array(
			'success'             => true === ( $boot_result['success'] ?? false ),
			'schema'              => 'wp-codebox/preview-boot-ref/v1',
			'boot'                => $stable_boot,
			'blueprint_ref'       => $blueprint_ref,
			'preview_lease'       => $preview_lease,
			'startup_diagnostics' => $diagnostics,
			'compatibility'       => array_filter(
				array(
					'contained_site_schema' => (string) ( $contained_site['schema'] ?? '' ),
					'session_result_schema' => (string) ( $boot_result['schema'] ?? '' ),
					'legacy_contained_site' => $contained_site,
					'legacy_session_result' => $boot_result,
				),
				static fn( mixed $value ): bool => array() !== $value && '' !== $value
			),
		),
		static fn( mixed $value ): bool => array() !== $value && '' !== $value
	);
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function destroy_browser_contained_site_session( array $input ): array|WP_Error {
	$contained_site = self::browser_contained_site_public_input( is_array( $input['contained_site'] ?? null ) ? $input['contained_site'] : array() );
	$site_id        = (string) ( $input['site_id'] ?? $contained_site['site_id'] ?? '' );
	$source_digest  = is_array( $input['source_digest'] ?? null ) ? (string) ( $input['source_digest']['value'] ?? '' ) : (string) ( $input['source_digest'] ?? $contained_site['source_digest']['value'] ?? '' );
	$preview_lease  = WP_Codebox_Browser_Task_Builder::preview_lease( array( 'preview_lease' => array_merge( is_array( $input['preview_lease'] ?? null ) ? $input['preview_lease'] : array(), array( 'status' => 'released' ) ) ) );
	if ( ! empty( $contained_site ) ) {
		$contained_site['status'] = 'destroyed';
	}

	$diagnostics = self::browser_contained_site_startup_diagnostics(
		array_merge( $contained_site, array( 'status' => 'destroyed', 'recovery_handle' => self::browser_contained_site_recovery_handle( $site_id, strtolower( trim( $source_digest ) ) ) ) ),
		array(),
		$preview_lease,
		array( 'valid' => false, 'reason' => 'contained-site-session-released' )
	);

	return array_filter(
		array(
			'success'             => true,
			'schema'              => 'wp-codebox/browser-contained-site-destroy/v1',
			'action'              => '' !== $site_id ? 'released' : 'noop',
			'contained_site'      => $contained_site,
			'preview_lease'       => $preview_lease,
			'startup_diagnostics' => $diagnostics,
		),
		static fn( mixed $value ): bool => array() !== $value && '' !== $value
	);
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function snapshot_browser_contained_site( array $input ): array|WP_Error {
	$validation = self::validate_browser_contained_site_source( $input, 'wp-codebox/browser-contained-site-snapshot/v1' );
	if ( false === ( $validation['success'] ?? false ) ) {
		return $validation;
	}

	$contained_site = is_array( $validation['contained_site'] ?? null ) ? $validation['contained_site'] : array();
	$source_digest  = is_array( $validation['source_digest'] ?? null ) ? $validation['source_digest'] : array();
	$status         = is_array( $validation['status'] ?? null ) ? $validation['status'] : array();

	return array_filter(
		array(
			'success'        => true,
			'schema'         => 'wp-codebox/browser-contained-site-snapshot/v1',
			'contained_site' => $contained_site,
			'source_digest'  => $source_digest,
			'session'        => is_array( $validation['session'] ?? null ) ? $validation['session'] : array(),
			'status'         => $status,
			'snapshot'       => array(
				'schema'        => 'wp-codebox/wordpress-runtime-snapshot/v1',
				'status'        => 'preview-contract',
				'capture'       => 'browser-contained-site',
				'site_id'       => (string) ( $contained_site['site_id'] ?? '' ),
				'source_digest' => $source_digest,
				'capabilities'  => array( 'runtime-snapshot-export', 'replay-export-package' ),
			),
		),
		static fn( mixed $value ): bool => array() !== $value && '' !== $value
	);
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function export_browser_contained_site( array $input ): array|WP_Error {
	$snapshot = self::snapshot_browser_contained_site( $input );
	if ( is_wp_error( $snapshot ) ) {
		return $snapshot;
	}
	if ( false === ( $snapshot['success'] ?? false ) ) {
		return array_merge( $snapshot, array( 'schema' => 'wp-codebox/browser-contained-site-export/v1' ) );
	}

	return array_filter(
		array(
			'success'        => true,
			'schema'         => 'wp-codebox/browser-contained-site-export/v1',
			'contained_site' => is_array( $snapshot['contained_site'] ?? null ) ? $snapshot['contained_site'] : array(),
			'source_digest'  => is_array( $snapshot['source_digest'] ?? null ) ? $snapshot['source_digest'] : array(),
			'snapshot'       => $snapshot,
			'export'         => array(
				'schema'        => 'wp-codebox/replayable-wordpress-site/v1',
				'status'        => 'preview-contract',
				'package_kind'  => 'replay-export-package',
				'snapshot_path' => 'files/runtime-snapshot.json',
				'blueprint'     => array( 'schema' => 'wp-codebox/replay-export-blueprint/v1' ),
			),
		),
		static fn( mixed $value ): bool => array() !== $value && '' !== $value
	);
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function plan_browser_contained_site_apply( array $input ): array|WP_Error {
	$validation = self::validate_browser_contained_site_source( $input, 'wp-codebox/browser-contained-site-apply-plan/v1' );
	if ( false === ( $validation['success'] ?? false ) ) {
		return $validation;
	}

	$mode          = true === ( $input['apply'] ?? false ) ? 'apply' : 'preview';
	$host_mutation = 'apply' === $mode && true === ( $input['allow_host_mutation'] ?? false );
	$changes       = array_values( is_array( $input['changes'] ?? null ) ? $input['changes'] : array() );

	return array_filter(
		array(
			'success'        => true,
			'schema'         => 'wp-codebox/browser-contained-site-apply-plan/v1',
			'mode'           => $mode,
			'host_mutation'  => $host_mutation,
			'contained_site' => is_array( $validation['contained_site'] ?? null ) ? $validation['contained_site'] : array(),
			'source_digest'  => is_array( $validation['source_digest'] ?? null ) ? $validation['source_digest'] : array(),
			'plan'           => array(
				'schema'            => 'wp-codebox/browser-contained-site-apply-plan/v1',
				'status'            => $host_mutation ? 'ready-for-host-apply' : 'preview-only',
				'preview_only'      => ! $host_mutation,
				'host_mutation'     => $host_mutation,
				'operation_count'   => count( $changes ),
				'operations'        => $changes,
				'requires_approval' => true,
			),
		),
		static fn( mixed $value ): bool => array() !== $value && '' !== $value
	);
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function apply_browser_contained_site_plan( array $input ): array|WP_Error {
	$plan = is_array( $input['plan'] ?? null ) ? $input['plan'] : self::plan_browser_contained_site_apply( $input );
	if ( is_wp_error( $plan ) ) {
		return $plan;
	}
	if ( false === ( $plan['success'] ?? false ) ) {
		return array_merge( $plan, array( 'schema' => 'wp-codebox/browser-contained-site-apply-result/v1' ) );
	}

	$host_mutation = true === ( $plan['host_mutation'] ?? false ) && true === ( $input['allow_host_mutation'] ?? false );
	return array_filter(
		array(
			'success'        => true,
			'schema'         => 'wp-codebox/browser-contained-site-apply-result/v1',
			'mode'           => $host_mutation ? 'apply' : 'preview',
			'host_mutation'  => $host_mutation,
			'contained_site' => is_array( $plan['contained_site'] ?? null ) ? $plan['contained_site'] : array(),
			'source_digest'  => is_array( $plan['source_digest'] ?? null ) ? $plan['source_digest'] : array(),
			'result'         => array(
				'schema'        => 'wp-codebox/browser-contained-site-apply-result/v1',
				'status'        => $host_mutation ? 'not-applied' : 'previewed',
				'preview_only'  => ! $host_mutation,
				'host_mutation' => $host_mutation,
				'message'       => $host_mutation ? 'Host apply requires an approved apply adapter.' : 'Preview apply result produced without host mutation.',
			),
		),
		static fn( mixed $value ): bool => array() !== $value && '' !== $value
	);
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function browser_contained_site_sync_delegation( array $input ): array|WP_Error {
	$base = '/wp-codebox/v1/browser-contained-site-sync';
	$delegation = array_filter(
		array(
			'success'        => true,
			'schema'         => 'wp-codebox/browser-contained-site-sync-delegation/v1',
			'status'         => self::browser_contained_site_sync_backend_available() ? 'available' : 'unavailable',
			'backend'        => array(
				'status' => self::browser_contained_site_sync_backend_available() ? 'available' : 'unavailable',
			),
			'contained_site' => is_array( $input['contained_site'] ?? null ) ? self::browser_contained_site_public_input( $input['contained_site'] ) : array(),
			'source_digest'  => self::browser_contained_site_digest_ref( $input['source_digest'] ?? $input['input_hash'] ?? '' ),
			'routes'         => array(
				'source_connect'      => $base . '/source-connect',
				'manifest'            => $base . '/manifest',
				'export'              => $base . '/export',
				'apply_plan_generate' => $base . '/apply-plan/generate',
				'apply_plan_validate' => $base . '/apply-plan/validate',
				'apply'               => $base . '/apply',
			),
			'abilities'      => array(
				'source_connect'      => 'wp-codebox/browser-contained-site-sync-source-connect',
				'manifest'            => 'wp-codebox/browser-contained-site-sync-manifest',
				'export'              => 'wp-codebox/browser-contained-site-sync-export',
				'apply_plan_generate' => 'wp-codebox/browser-contained-site-sync-apply-plan-generate',
				'apply_plan_validate' => 'wp-codebox/browser-contained-site-sync-apply-plan-validate',
				'apply'               => 'wp-codebox/browser-contained-site-sync-apply',
			),
		),
		static fn( mixed $value ): bool => array() !== $value && '' !== $value
	);

	$backend = self::browser_contained_site_sync_backend_response( 'delegation', $input, $delegation );
	return is_array( $backend ) ? array_merge( $delegation, $backend, array( 'schema' => 'wp-codebox/browser-contained-site-sync-delegation/v1' ) ) : $delegation;
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function browser_contained_site_sync_source_connect( array $input ): array|WP_Error {
	return self::browser_contained_site_sync_envelope( 'source_connect', 'wp-codebox/browser-contained-site-sync-source/v1', $input, array( 'source' => null ) );
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function browser_contained_site_sync_manifest( array $input ): array|WP_Error {
	return self::browser_contained_site_sync_envelope( 'manifest', 'wp-codebox/browser-contained-site-sync-manifest/v1', $input, array( 'manifest' => null ) );
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function browser_contained_site_sync_export( array $input ): array|WP_Error {
	return self::browser_contained_site_sync_envelope( 'export', 'wp-codebox/browser-contained-site-sync-export/v1', $input, array( 'package' => null ) );
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function browser_contained_site_sync_apply_plan_generate( array $input ): array|WP_Error {
	$plan = self::plan_browser_contained_site_apply( $input );
	if ( is_wp_error( $plan ) ) {
		return $plan;
	}

	return self::browser_contained_site_sync_envelope( 'apply_plan_generate', 'wp-codebox/browser-contained-site-sync-apply-plan/v1', $input, array( 'apply_plan' => $plan ) );
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function browser_contained_site_sync_apply_plan_validate( array $input ): array|WP_Error {
	$plan = is_array( $input['apply_plan'] ?? null ) ? $input['apply_plan'] : array();
	$fallback = array(
		'validation'      => array(
			'schema'          => 'wp-codebox/browser-contained-site-sync-validation/v1',
			'status'          => 'preview-only',
			'host_mutation'   => false,
			'validation_hash' => hash( 'sha256', 'wp-codebox/browser-contained-site-sync-validation/v1' . "\n" . self::stable_json( $plan ) ),
		),
		'validation_hash' => hash( 'sha256', 'wp-codebox/browser-contained-site-sync-validation/v1' . "\n" . self::stable_json( $plan ) ),
	);

	return self::browser_contained_site_sync_envelope( 'apply_plan_validate', 'wp-codebox/browser-contained-site-sync-validation/v1', $input, $fallback );
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function browser_contained_site_sync_apply( array $input ): array|WP_Error {
	$result = self::apply_browser_contained_site_plan( $input );
	if ( is_wp_error( $result ) ) {
		return $result;
	}

	return self::browser_contained_site_sync_envelope( 'apply', 'wp-codebox/browser-contained-site-sync-apply-result/v1', $input, array( 'result' => $result ) );
}

/** @param array<string,mixed> $input Ability input. @param array<string,mixed> $fallback Fallback payload. @return array<string,mixed>|WP_Error */
private static function browser_contained_site_sync_envelope( string $operation, string $schema, array $input, array $fallback = array() ): array|WP_Error {
	$backend = self::browser_contained_site_sync_backend_response( $operation, $input, null );
	if ( is_wp_error( $backend ) ) {
		return $backend;
	}

	$payload = is_array( $backend ) ? $backend : $fallback;
	return array_merge(
		array(
			'success'   => is_array( $backend ),
			'schema'    => $schema,
			'status'    => is_array( $backend ) ? 'available' : 'unavailable',
			'operation' => $operation,
		),
		$payload,
		array( 'schema' => $schema )
	);
}

/** @param array<string,mixed> $input Ability input. @param array<string,mixed>|null $delegation Delegation DTO. @return array<string,mixed>|WP_Error|null */
private static function browser_contained_site_sync_backend_response( string $operation, array $input, ?array $delegation ): array|WP_Error|null {
	if ( ! function_exists( 'apply_filters' ) ) {
		return null;
	}

	$response = apply_filters( 'wp_codebox_browser_contained_site_sync_request', null, $operation, $input, $delegation );
	return is_array( $response ) || is_wp_error( $response ) ? $response : null;
}

private static function browser_contained_site_sync_backend_available(): bool {
	if ( ! function_exists( 'apply_filters' ) ) {
		return false;
	}

	return (bool) apply_filters( 'wp_codebox_browser_contained_site_sync_backend_available', false );
}

/** @param array<string,mixed> $input Blueprint ref input. @return array<string,mixed>|WP_Error */
public static function hydrate_browser_blueprint_ref( array $input ): array|WP_Error {
	return WP_Codebox_Browser_Task_Builder::hydrate_browser_blueprint_ref( $input );
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function create_browser_materializer_contract( array $input ): array|WP_Error {
	$return_raw = self::include_raw_browser_contract( $input, 'materializer' );
	$input['include_internal_browser_session'] = true;
	$session = self::create_browser_playground_session( $input );
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
				'authorization'    => is_array( $session_envelope['authorization'] ?? null ) ? $session_envelope['authorization'] : self::browser_session_authorization( $input ),
				'signals'          => is_array( $session['signals'] ?? null ) ? $session['signals'] : array(),
			),
			static fn( mixed $value ): bool => array() !== $value && '' !== $value
		);
		$contract['compact'] = self::compact_browser_materializer_contract_dto( $contract );

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
		'authorization'    => is_array( $session_envelope['authorization'] ?? null ) ? $session_envelope['authorization'] : self::browser_session_authorization( $input ),
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
	$contract['compact'] = self::compact_browser_materializer_contract_dto( $contract );

	return $return_raw ? $contract : $contract['compact'];
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function create_browser_task_contract( array $input ): array|WP_Error {
	$return_raw = self::include_raw_browser_contract( $input, 'task' );
	$contract = self::prepare_browser_task_contract( $input );
	if ( is_wp_error( $contract ) ) {
		return $contract;
	}
	if ( true === ( $input['execute_phases'] ?? false ) ) {
		$contract = self::execute_browser_task_phases( $contract );
		if ( is_wp_error( $contract ) ) {
			return $contract;
		}
	}

	return $return_raw ? $contract : ( is_array( $contract['compact'] ?? null ) ? $contract['compact'] : self::compact_browser_task_contract_dto( $contract ) );
}

/** @param array<string,mixed> $input Ability input. */
private static function include_raw_browser_contract( array $input, string $contract ): bool {
	$include = true === ( $input['include_internal_browser_contract'] ?? false );
	if ( function_exists( 'apply_filters' ) ) {
		$include = (bool) apply_filters( 'wp_codebox_include_internal_browser_contract', $include, $input, $contract );
	}

	return $include;
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
private static function prepare_browser_task_contract( array $input ): array|WP_Error {
	$input['include_internal_browser_session'] = true;
	$primary = self::create_browser_playground_session( $input );
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
				'authorization'    => is_array( $session_envelope['authorization'] ?? null ) ? $session_envelope['authorization'] : self::browser_session_authorization( $input ),
				'task_input'       => is_array( $primary['task_input'] ?? null ) ? $primary['task_input'] : array(),
				'contained_site'   => is_array( $primary['contained_site'] ?? null ) ? $primary['contained_site'] : array(),
				'primary'          => $primary,
				'phases'           => array(),
				'execution_metrics' => self::browser_contract_execution_metrics( $primary, array() ),
			),
			static fn( mixed $value ): bool => array() !== $value && '' !== $value
		);
		$contract['compact'] = self::compact_browser_task_contract_dto( $contract );

		return $contract;
	}

	$phases = self::prepare_browser_task_contract_phases( $input, $session_envelope );
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
		'authorization'    => is_array( $session_envelope['authorization'] ?? null ) ? $session_envelope['authorization'] : self::browser_session_authorization( $input ),
		'task_input'       => is_array( $primary['task_input'] ?? null ) ? $primary['task_input'] : array(),
		'contained_site'   => is_array( $primary['contained_site'] ?? null ) ? $primary['contained_site'] : array(),
		'primary'          => $primary,
		'phases'           => $phases,
		'execution_metrics' => self::browser_contract_execution_metrics( $primary, $phases ),
		'provenance'       => array(
			'generated_by' => 'wp-codebox/browser-task-contract',
			'source'       => 'wp-codebox/create-browser-playground-session',
		),
	);
	$contract['compact'] = self::compact_browser_task_contract_dto( $contract );

	return $contract;
}

/** @param array<string,mixed> $contract Browser task contract. @return array<string,mixed>|WP_Error */
private static function execute_browser_task_phases( array $contract ): array|WP_Error {
	$session_envelope = is_array( $contract['session'] ?? null ) ? $contract['session'] : array();
	$phases           = array();

	foreach ( is_array( $contract['phases'] ?? null ) ? $contract['phases'] : array() as $phase ) {
		if ( ! is_array( $phase ) ) {
			continue;
		}

		$executed_phase = self::execute_browser_task_phase( $phase, $session_envelope );
		if ( is_wp_error( $executed_phase ) ) {
			return $executed_phase;
		}

		$phases[] = $executed_phase;
	}

	$contract['phases']            = $phases;
	$contract['execution_metrics'] = self::browser_contract_execution_metrics( is_array( $contract['primary'] ?? null ) ? $contract['primary'] : array(), $phases );
	$contract['compact']           = self::compact_browser_task_contract_dto( $contract );

	return $contract;
}

/** @param array<string,mixed> $phase Browser task phase. @param array<string,mixed> $session_envelope Primary browser session envelope. @return array<string,mixed>|WP_Error */
private static function execute_browser_task_phase( array $phase, array $session_envelope ): array|WP_Error {
	$fanout_request = self::browser_task_phase_fanout_request( $phase );
	if ( is_array( $fanout_request ) ) {
		if ( empty( $fanout_request['sandbox_session_id'] ) && '' !== (string) ( $session_envelope['id'] ?? '' ) ) {
			$fanout_request['sandbox_session_id'] = (string) $session_envelope['id'];
		}

		$result = self::run_agent_task_fanout( $fanout_request );
		if ( is_wp_error( $result ) ) {
			return $result;
		}

		$phase['status'] = true === ( $result['success'] ?? false ) ? 'completed' : 'failed';
		$phase['result'] = $result;

		return array_filter( $phase, static fn( mixed $value ): bool => array() !== $value && '' !== $value );
	}

	$host_delegation_request = self::browser_task_phase_host_delegation_request( $phase );
	if ( is_array( $host_delegation_request ) ) {
		if ( empty( $host_delegation_request['sandbox_session_id'] ) && '' !== (string) ( $session_envelope['id'] ?? '' ) ) {
			$host_delegation_request['sandbox_session_id'] = (string) $session_envelope['id'];
		}

		$result = self::request_host_delegation( $host_delegation_request );
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
private static function compact_browser_task_contract_dto( array $contract ): array {
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
			'metadata' => is_array( $phase['metadata'] ?? null ) ? self::compact_browser_dto_value( $phase['metadata'] ) : array(),
		);
		if ( is_array( $phase['contract'] ?? null ) ) {
			$phase_dto['contract'] = self::compact_browser_materializer_contract_dto( $phase['contract'] );
		}
		if ( is_array( $phase['result'] ?? null ) ) {
			$phase_dto['result'] = self::compact_browser_dto_value( $phase['result'] );
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
			'error'            => is_array( $contract['error'] ?? null ) ? self::compact_browser_dto_value( $contract['error'] ) : array(),
			'session'          => is_array( $contract['session'] ?? null ) ? self::compact_browser_dto_value( $contract['session'] ) : array(),
			'authorization'    => is_array( $contract['authorization'] ?? null ) ? self::compact_browser_dto_value( $contract['authorization'] ) : array(),
			'task_input'       => is_array( $contract['task_input'] ?? null ) ? self::compact_browser_executable_task_input( $contract['task_input'], array() ) : array(),
			'primary'          => is_array( $contract['primary'] ?? null ) ? self::compact_browser_session_dto( $contract['primary'] ) : array(),
			'phases'           => $phases,
			'execution_metrics' => is_array( $contract['execution_metrics'] ?? null ) ? self::compact_browser_dto_value( $contract['execution_metrics'] ) : array(),
			'provenance'       => is_array( $contract['provenance'] ?? null ) ? self::compact_browser_dto_value( $contract['provenance'] ) : array(),
		),
		static fn( mixed $value ): bool => array() !== $value && '' !== $value
	);
}

/** @param array<string,mixed> $primary Primary browser session. @param array<int,array<string,mixed>> $phases Browser phases. @return array<string,mixed> */
private static function browser_contract_execution_metrics( array $primary, array $phases ): array {
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
					'task_payload' => self::browser_metrics_json_bytes( $task_payload ),
					'recipe'       => self::browser_metrics_json_bytes( $recipe ),
					'blueprint'    => self::browser_metrics_json_bytes( $blueprint ),
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
				'class' => self::browser_metrics_failure_class( (string) ( $error['code'] ?? '' ) ),
				'code'  => (string) ( $error['code'] ?? '' ),
			),
		),
		static fn( mixed $value ): bool => array() !== $value && '' !== $value
	);
}

private static function browser_metrics_json_bytes( mixed $value ): int {
	$encoded = wp_json_encode( $value, JSON_UNESCAPED_SLASHES );
	return is_string( $encoded ) ? strlen( $encoded ) : 0;
}

private static function browser_metrics_failure_class( string $code ): string {
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
private static function compact_browser_materializer_contract_dto( array $contract ): array {
	return array_filter(
		array(
			'success'          => (bool) ( $contract['success'] ?? false ),
			'schema'           => 'wp-codebox/browser-materializer-product-dto/v1',
			'source_schema'    => (string) ( $contract['schema'] ?? '' ),
			'execution'        => (string) ( $contract['execution'] ?? '' ),
			'execution_scope'  => (string) ( $contract['execution_scope'] ?? '' ),
			'permission_model' => (string) ( $contract['permission_model'] ?? '' ),
			'status'           => (string) ( $contract['status'] ?? '' ),
			'error'            => is_array( $contract['error'] ?? null ) ? self::compact_browser_dto_value( $contract['error'] ) : array(),
			'session_id'       => (string) ( $contract['session_id'] ?? '' ),
			'authorization'    => is_array( $contract['authorization'] ?? null ) ? self::compact_browser_dto_value( $contract['authorization'] ) : array(),
			'task'             => is_array( $contract['task_input'] ?? null ) ? (string) ( $contract['task_input']['goal'] ?? '' ) : '',
			'preview_boot'     => WP_Codebox_Browser_Task_Builder::browser_preview_boot_config( $contract ),
			'preview_ref'      => WP_Codebox_Browser_Task_Builder::browser_preview_ref( $contract ),
			'artifact_refs'    => WP_Codebox_Browser_Task_Builder::browser_artifact_refs( $contract ),
			'diagnostics'      => self::compact_browser_contract_diagnostics( $contract ),
			'executable'       => self::browser_executable_materializer_contract_dto( $contract ),
			'provenance'       => is_array( $contract['provenance'] ?? null ) ? self::compact_browser_dto_value( $contract['provenance'] ) : array(),
		),
		static fn( mixed $value ): bool => array() !== $value && '' !== $value
	);
}

/** @param array<string,mixed> $contract Browser contract. @return array<string,mixed> */
private static function compact_browser_contract_diagnostics( array $contract ): array {
	$diagnostics = array();
	if ( is_array( $contract['signals'] ?? null ) ) {
		$diagnostics['signals'] = self::compact_browser_dto_value( $contract['signals'] );
	}
	if ( is_array( $contract['execution_metrics'] ?? null ) ) {
		$metrics = self::compact_browser_dto_value( $contract['execution_metrics'] );
		unset( $metrics['payload_bytes'], $metrics['diagnostics_refs'] );
		$diagnostics['execution_metrics'] = $metrics;
	}

	return array_filter( $diagnostics, static fn( mixed $value ): bool => array() !== $value && '' !== $value );
}

/** @param array<string,mixed> $contract Browser materializer contract. @return array<string,mixed> */
private static function browser_executable_materializer_contract_dto( array $contract ): array {
	$task_payload = is_array( $contract['task_payload'] ?? null ) ? $contract['task_payload'] : array();
	$task_input   = is_array( $contract['task_input'] ?? null ) ? $contract['task_input'] : array();
	$payload_bundles = is_array( $task_payload['agent_bundles'] ?? null ) ? self::normalize_agent_bundles( $task_payload['agent_bundles'] ) : array();
	$input_bundles   = is_array( $task_input['agent_bundles'] ?? null ) ? self::normalize_agent_bundles( $task_input['agent_bundles'] ) : array();
	$agent_bundles   = ! empty( $payload_bundles ) ? $payload_bundles : $input_bundles;

	return array_filter(
		array(
			'schema'       => 'wp-codebox/browser-materializer-executable-dto/v1',
			'session_id'   => (string) ( $contract['session_id'] ?? $task_payload['session_id'] ?? '' ),
			'task_payload' => self::compact_browser_executable_task_payload( $task_payload, $agent_bundles ),
			'task_input'   => self::compact_browser_executable_task_input( $task_input, $agent_bundles ),
		),
		static fn( mixed $value ): bool => array() !== $value && '' !== $value
	);
}

/** @param array<string,mixed> $task_payload Browser task payload. @param array<int,array<string,mixed>> $agent_bundles Executable bundle specs. @return array<string,mixed> */
private static function compact_browser_executable_task_payload( array $task_payload, array $agent_bundles ): array {
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
private static function compact_browser_executable_task_input( array $task_input, array $agent_bundles ): array {
	$compact = array();
	foreach ( array( 'schema', 'version', 'goal' ) as $field ) {
		$value = isset( $task_input[ $field ] ) ? (string) $task_input[ $field ] : '';
		if ( '' !== $value ) {
			$compact[ $field ] = $value;
		}
	}
	foreach ( array( 'target', 'allowed_tools', 'expected_artifacts', 'structured_artifacts', 'tool_bridge', 'sandbox_tool_policy', 'policy', 'context' ) as $field ) {
		if ( is_array( $task_input[ $field ] ?? null ) ) {
			$compact[ $field ] = self::compact_browser_dto_value( $task_input[ $field ] );
		}
	}
	if ( ! empty( $agent_bundles ) ) {
		$compact['agent_bundles'] = $agent_bundles;
	}

	return array_filter( $compact, static fn( mixed $value ): bool => array() !== $value && '' !== $value );
}

/** @param array<string,mixed> $session Browser session envelope. @return array<string,mixed> */
private static function compact_browser_session_dto( array $session ): array {
	return WP_Codebox_Browser_Task_Builder::product_browser_session_dto( $session );
}

/** @param array<string,mixed> $playground Playground contract. @return array<string,mixed> */
private static function compact_browser_playground_dto( array $playground ): array {
	return array_filter(
		array(
			'client_module_url'  => (string) ( $playground['client_module_url'] ?? '' ),
			'remote_url'         => (string) ( $playground['remote_url'] ?? '' ),
			'cors_proxy_url'     => (string) ( $playground['cors_proxy_url'] ?? '' ),
			'scope'              => (string) ( $playground['scope'] ?? '' ),
			'artifact_base_path' => (string) ( $playground['artifact_base_path'] ?? '' ),
			'artifact_base_url'  => (string) ( $playground['artifact_base_url'] ?? '' ),
			'preview_url'        => (string) ( $playground['preview_url'] ?? '' ),
			'contained_site'     => is_array( $playground['contained_site'] ?? null ) ? self::compact_browser_dto_value( $playground['contained_site'] ) : array(),
			'capabilities'       => is_array( $playground['capabilities'] ?? null ) ? self::compact_browser_dto_value( $playground['capabilities'] ) : array(),
			'provenance'         => is_array( $playground['provenance'] ?? null ) ? self::compact_browser_dto_value( $playground['provenance'] ) : array(),
		),
		static fn( mixed $value ): bool => array() !== $value && '' !== $value
	);
}

/** @param array<string,mixed> $recipe Browser recipe. @return array<string,mixed> */
private static function compact_browser_recipe_dto( array $recipe ): array {
	return WP_Codebox_Browser_Task_Builder::browser_recipe_dto( $recipe );
}

private static function compact_browser_dto_value( mixed $value, string $key = '' ): mixed {
	$key = (string) $key;
	if ( self::compact_browser_dto_key_should_omit( $key ) ) {
		return null;
	}
	if ( self::compact_browser_dto_key_should_redact( $key ) ) {
		return '[redacted]';
	}
	if ( ! is_array( $value ) ) {
		return $value;
	}

	$compact = array();
	foreach ( $value as $child_key => $child_value ) {
		$child_compact = self::compact_browser_dto_value( $child_value, is_string( $child_key ) ? $child_key : '' );
		if ( null === $child_compact ) {
			continue;
		}

		$compact[ $child_key ] = $child_compact;
	}

	return $compact;
}

private static function compact_browser_dto_key_should_omit( string $key ): bool {
	return in_array( $key, array( 'pluginData', 'source', 'content', 'content_base64', 'bundle', 'plugins', 'runtime', 'artifact_base_path', 'base_path', 'task_path', 'result_path', 'event_stream_path', 'capture_paths', 'materialization_result_path' ), true );
}

private static function compact_browser_dto_key_should_redact( string $key ): bool {
	return WP_Codebox_Redaction_Policy::key_should_redact( 'public_session_dto', $key );
}

/** @param array<string,mixed> $input Ability input. @param array<string,mixed> $session_envelope Primary browser session envelope. @return array<int,array<string,mixed>>|WP_Error */
private static function prepare_browser_task_contract_phases( array $input, array $session_envelope ): array|WP_Error {
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

		$kind = self::safe_key( (string) ( $phase['kind'] ?? 'materializer' ) );
		if ( ! in_array( $kind, self::browser_task_phase_kinds(), true ) ) {
			return new WP_Error( 'wp_codebox_browser_phase_kind_invalid', 'Browser task phases support materializer, agent, validator, repair, aggregator, and host-delegation kinds.', array( 'status' => 400, 'index' => $index, 'kind' => $kind ) );
		}

		$phase_descriptor = array(
			'name'     => self::safe_key( (string) ( $phase['name'] ?? $kind . '-' . ( $index + 1 ) ) ),
			'kind'     => $kind,
			'index'    => $index,
			'label'    => (string) ( $phase['label'] ?? '' ),
			'status'   => (string) ( $phase['status'] ?? 'pending' ),
			'metadata' => is_array( $phase['metadata'] ?? null ) ? self::compact_browser_dto_value( $phase['metadata'] ) : array(),
		);

		$fanout_request = self::browser_task_phase_fanout_request( $phase );
		if ( is_array( $fanout_request ) ) {
			if ( empty( $fanout_request['sandbox_session_id'] ) && '' !== (string) ( $session_envelope['id'] ?? '' ) ) {
				$fanout_request['sandbox_session_id'] = (string) $session_envelope['id'];
			}

			$phase_descriptor['request'] = $fanout_request;
			$phases[] = array_filter( $phase_descriptor, static fn( mixed $value ): bool => array() !== $value && '' !== $value );
			continue;
		}

		$host_delegation_request = self::browser_task_phase_host_delegation_request( $phase );
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

		$contract = self::create_browser_materializer_contract( $phase_input );
		if ( is_wp_error( $contract ) ) {
			return $contract;
		}

		$phase_descriptor['contract'] = $contract;
		$phases[] = array_filter( $phase_descriptor, static fn( mixed $value ): bool => array() !== $value && '' !== $value );
	}

	return $phases;
}

/** @param array<string,mixed> $phase Browser task phase. @return array<string,mixed>|null */
private static function browser_task_phase_fanout_request( array $phase ): ?array {
	$candidates = array( $phase['request'] ?? null, $phase['input'] ?? null );
	foreach ( $candidates as $candidate ) {
		if ( is_array( $candidate ) && 'wp-codebox/agent-fanout-request/v1' === (string) ( $candidate['schema'] ?? '' ) ) {
			return $candidate;
		}
	}

	return null;
}

/** @param array<string,mixed> $phase Browser task phase. @return array<string,mixed>|null */
private static function browser_task_phase_host_delegation_request( array $phase ): ?array {
	$candidates = array( $phase['request'] ?? null, $phase['input'] ?? null );
	foreach ( $candidates as $candidate ) {
		if ( is_array( $candidate ) && 'wp-codebox/host-delegation-request/v1' === (string) ( $candidate['schema'] ?? '' ) ) {
			return $candidate;
		}
	}

	return null;
}

/** @param array<string,mixed> $request Host delegation request. @return array<string,mixed>|WP_Error */
private static function execute_host_delegation_request( array $request ): array|WP_Error {
	if ( isset( $request['schema'] ) && 'wp-codebox/host-delegation-request/v1' !== (string) $request['schema'] ) {
		return new WP_Error( 'wp_codebox_host_delegation_schema_invalid', 'Host delegation requests must use wp-codebox/host-delegation-request/v1.', array( 'status' => 400 ) );
	}

	$request['schema'] = 'wp-codebox/host-delegation-request/v1';
	$request_id        = self::safe_key( (string) ( $request['request_id'] ?? $request['id'] ?? '' ) );
	if ( '' === $request_id ) {
		$request_id = self::generate_id();
	}
	$request['request_id'] = $request_id;
	$started_at            = microtime( true );
	$events                = array( self::host_delegation_event( 'host-delegation.requested', $request_id ) );
	$request_error         = self::host_delegation_request_validation_error( $request );
	if ( null !== $request_error ) {
		$ended_at = microtime( true );
		$events[] = self::host_delegation_event( 'host-delegation.failed', $request_id, 'failed' );
		return self::host_delegation_result( false, 'failed', $request, null, $request_error, $events, $started_at, $ended_at );
	}

	/**
	 * Lets products satisfy an explicit host-delegation request.
	 *
	 * Return an array shaped like wp-codebox/host-delegation-result/v1, a provider
	 * payload to wrap, or null when the host has no delegation provider.
	 *
	 * @param mixed               $result  Provider result. Null means unavailable.
	 * @param array<string,mixed> $request Canonical host delegation request.
	 */
	$provider_result = apply_filters( 'wp_codebox_host_delegation_request', null, $request );
	$ended_at        = microtime( true );

	if ( null === $provider_result ) {
		$events[] = self::host_delegation_event( 'host-delegation.unavailable', $request_id, 'unavailable' );
		return self::host_delegation_result( false, 'unavailable', $request, null, array( 'code' => 'wp_codebox_host_delegation_unavailable', 'message' => 'No host delegation provider handled the request.', 'data' => null ), $events, $started_at, $ended_at );
	}

	if ( is_wp_error( $provider_result ) ) {
		$events[] = self::host_delegation_event( 'host-delegation.failed', $request_id, 'failed' );
		return self::host_delegation_result( false, 'failed', $request, null, array( 'code' => $provider_result->get_error_code(), 'message' => $provider_result->get_error_message(), 'data' => $provider_result->get_error_data() ), $events, $started_at, $ended_at );
	}

	if ( ! is_array( $provider_result ) ) {
		$events[] = self::host_delegation_event( 'host-delegation.failed', $request_id, 'failed' );
		return self::host_delegation_result( false, 'failed', $request, null, array( 'code' => 'wp_codebox_host_delegation_provider_result_invalid', 'message' => 'Host delegation providers must return an array, WP_Error, or null.', 'data' => array( 'type' => get_debug_type( $provider_result ) ) ), $events, $started_at, $ended_at );
	}

	$provider_error = self::host_delegation_provider_result_validation_error( $request, $provider_result );
	if ( null !== $provider_error ) {
		$events[] = self::host_delegation_event( 'host-delegation.failed', $request_id, 'failed', (string) ( $provider_result['provider'] ?? '' ) );
		return self::host_delegation_result( false, 'failed', $request, null, $provider_error, $events, $started_at, $ended_at );
	}

	$has_success = array_key_exists( 'success', $provider_result );
	$has_status  = array_key_exists( 'status', $provider_result );
	$status      = self::safe_key( (string) ( $provider_result['status'] ?? ( $has_success && false === $provider_result['success'] ? 'failed' : 'completed' ) ) );
	$success     = $has_success ? true === $provider_result['success'] : in_array( $status, array( 'accepted', 'completed' ), true );
	if ( ! $has_status && ! $has_success && isset( $provider_result['error'] ) ) {
		$status  = 'failed';
		$success = false;
	}

	$events[] = self::host_delegation_event( $success ? ( 'accepted' === $status ? 'host-delegation.accepted' : 'host-delegation.completed' ) : ( 'unavailable' === $status ? 'host-delegation.unavailable' : 'host-delegation.failed' ), $request_id, $status, (string) ( $provider_result['provider'] ?? '' ) );
	$error    = is_array( $provider_result['error'] ?? null ) ? $provider_result['error'] : null;
	$result   = is_array( $provider_result['result'] ?? null ) ? $provider_result['result'] : $provider_result;

	$envelope = self::host_delegation_result( $success, $status, $request, $result, $success ? null : $error, $events, $started_at, $ended_at );
	foreach ( array( 'provider', 'artifacts', 'orchestrator' ) as $field ) {
		if ( isset( $provider_result[ $field ] ) ) {
			$envelope[ $field ] = $provider_result[ $field ];
		}
	}

	return $envelope;
}

/** @param array<string,mixed> $request Host delegation request. @return array<string,mixed>|null */
private static function host_delegation_request_validation_error( array $request ): ?array {
	if ( '' === trim( (string) ( $request['goal'] ?? $request['task'] ?? '' ) ) ) {
		return array( 'code' => 'wp_codebox_host_delegation_request_invalid', 'message' => 'Host delegation requests require a non-empty goal or task.', 'data' => array( 'field' => 'goal' ) );
	}

	foreach ( array( 'target', 'context', 'execution', 'orchestrator', 'metadata' ) as $field ) {
		if ( isset( $request[ $field ] ) && ! is_array( $request[ $field ] ) ) {
			return array( 'code' => 'wp_codebox_host_delegation_request_invalid', 'message' => 'Host delegation request object fields must be arrays.', 'data' => array( 'field' => $field ) );
		}
	}

	if ( isset( $request['expected_artifacts'] ) && ! is_array( $request['expected_artifacts'] ) ) {
		return array( 'code' => 'wp_codebox_host_delegation_request_invalid', 'message' => 'Host delegation expected_artifacts must be an array.', 'data' => array( 'field' => 'expected_artifacts' ) );
	}

	if ( isset( $request['source_digest'] ) && '' === self::host_delegation_digest_value( $request['source_digest'] ) ) {
		return array( 'code' => 'wp_codebox_host_delegation_source_digest_invalid', 'message' => 'Host delegation source_digest must be a 64-character sha256 digest.', 'data' => array( 'field' => 'source_digest' ) );
	}

	return null;
}

/** @param array<string,mixed> $request Host delegation request. @param array<string,mixed> $provider_result Provider result. @return array<string,mixed>|null */
private static function host_delegation_provider_result_validation_error( array $request, array $provider_result ): ?array {
	if ( isset( $provider_result['schema'] ) && 'wp-codebox/host-delegation-result/v1' !== (string) $provider_result['schema'] ) {
		return array( 'code' => 'wp_codebox_host_delegation_provider_result_schema_invalid', 'message' => 'Host delegation provider results must use wp-codebox/host-delegation-result/v1 when a schema is present.', 'data' => array( 'schema' => (string) $provider_result['schema'] ) );
	}

	$status = self::safe_key( (string) ( $provider_result['status'] ?? ( array_key_exists( 'success', $provider_result ) && false === $provider_result['success'] ? 'failed' : 'completed' ) ) );
	if ( ! in_array( $status, array( 'accepted', 'completed', 'failed', 'unavailable' ), true ) ) {
		return array( 'code' => 'wp_codebox_host_delegation_provider_status_invalid', 'message' => 'Host delegation provider status must be accepted, completed, failed, or unavailable.', 'data' => array( 'status' => $status ) );
	}

	if ( isset( $provider_result['result'] ) && null !== $provider_result['result'] && ! is_array( $provider_result['result'] ) ) {
		return array( 'code' => 'wp_codebox_host_delegation_provider_result_invalid', 'message' => 'Host delegation provider result must be an object when present.', 'data' => array( 'field' => 'result', 'type' => get_debug_type( $provider_result['result'] ) ) );
	}

	$provider_request_id = self::safe_key( (string) ( $provider_result['request_id'] ?? '' ) );
	if ( '' !== $provider_request_id && $provider_request_id !== (string) $request['request_id'] ) {
		return array( 'code' => 'wp_codebox_host_delegation_request_id_mismatch', 'message' => 'Host delegation provider result request_id does not match the request.', 'data' => array( 'expected' => (string) $request['request_id'], 'actual' => $provider_request_id ) );
	}

	$request_session = trim( (string) ( $request['sandbox_session_id'] ?? $request['session_id'] ?? '' ) );
	$result_session  = trim( (string) ( $provider_result['sandbox_session_id'] ?? $provider_result['session_id'] ?? '' ) );
	$result          = is_array( $provider_result['result'] ?? null ) ? $provider_result['result'] : array();
	if ( '' === $result_session ) {
		$result_session = trim( (string) ( $result['sandbox_session_id'] ?? $result['session_id'] ?? '' ) );
	}
	if ( '' !== $request_session && '' !== $result_session && $request_session !== $result_session ) {
		return array( 'code' => 'wp_codebox_host_delegation_scope_mismatch', 'message' => 'Host delegation provider result session scope does not match the request.', 'data' => array( 'expected' => $request_session, 'actual' => $result_session ) );
	}

	$request_digest = self::host_delegation_digest_value( $request['source_digest'] ?? null );
	$result_digest  = self::host_delegation_digest_value( $provider_result['source_digest'] ?? $result['source_digest'] ?? null );
	if ( '' !== $request_digest && '' !== $result_digest && $request_digest !== $result_digest ) {
		return array( 'code' => 'wp_codebox_host_delegation_source_digest_mismatch', 'message' => 'Host delegation provider result source digest does not match the request.', 'data' => array( 'expected' => $request_digest, 'actual' => $result_digest ) );
	}

	return null;
}

private static function host_delegation_digest_value( mixed $value ): string {
	$digest = is_array( $value ) ? (string) ( $value['value'] ?? $value['sha256'] ?? $value['hash'] ?? '' ) : (string) $value;
	$digest = strtolower( trim( $digest ) );
	return preg_match( '/^[a-f0-9]{64}$/', $digest ) ? $digest : '';
}

private static function host_delegation_event( string $event, string $request_id, string $status = '', string $provider = '' ): array {
	return array_filter(
		array(
			'schema'     => 'wp-codebox/host-delegation-event/v1',
			'event'      => $event,
			'time'       => gmdate( 'c' ),
			'request_id' => $request_id,
			'status'     => $status,
			'provider'   => $provider,
		),
		static fn( mixed $value ): bool => '' !== $value
	);
}

/** @param array<string,mixed> $request Host delegation request. @param array<string,mixed>|null $result Provider result. @param array<string,mixed>|null $error Error payload. @param array<int,array<string,mixed>> $events Events. @return array<string,mixed> */
private static function host_delegation_result( bool $success, string $status, array $request, ?array $result, ?array $error, array $events, float $started_at, float $ended_at ): array {
	return array_filter(
		array(
			'success'   => $success,
			'schema'    => 'wp-codebox/host-delegation-result/v1',
			'execution' => 'host-delegation',
			'status'    => $status,
			'request_id' => (string) ( $request['request_id'] ?? '' ),
			'session_id' => (string) ( $request['sandbox_session_id'] ?? $request['session_id'] ?? '' ),
			'request'   => $request,
			'result'    => $result,
			'error'     => $error,
			'events'    => $events,
			'timings'   => array(
				'started_at'  => gmdate( 'c', (int) $started_at ),
				'ended_at'    => gmdate( 'c', (int) $ended_at ),
				'duration_ms' => (int) round( ( $ended_at - $started_at ) * 1000 ),
			),
			'orchestrator' => is_array( $request['orchestrator'] ?? null ) ? $request['orchestrator'] : array(),
		),
		static fn( mixed $value ): bool => array() !== $value && null !== $value && '' !== $value
	);
}

/**
 * @param array<string,mixed> $input Ability input.
 * @param array<string,mixed> $task_input Normalized task input.
 * @param array<string,mixed> $ready_to_code Readiness signal.
 * @param array<int,array<string,string>> $browser_plugins Browser plugin specs.
 * @param array<string,mixed> $runtime Normalized runtime dependency specs.
 * @param array<int,array<string,string>> $artifacts Browser artifact specs.
 * @param array<string,mixed> $playground Playground input.
 * @param array<string,mixed> $blueprint Playground blueprint.
 * @param array<string,mixed> $site_blueprint_artifact Normalized site blueprint artifact.
 * @return array<string,mixed>
 */
private static function blocked_browser_playground_session( string $session_id, array $input, array $task_input, array $ready_to_code, array $browser_plugins, array $runtime, array $artifacts, array $playground, array $blueprint, array $site_blueprint_artifact ): array {
	$prepared_runtime = is_array( $runtime['prepared_runtime'] ?? null ) ? $runtime['prepared_runtime'] : array();
	$contained_site   = self::browser_contained_site_envelope( $input, $session_id, $playground, $runtime, $prepared_runtime, 'blocked' );

	return array(
		'success'          => false,
		'schema'           => 'wp-codebox/browser-playground-session/v1',
		'execution'        => 'browser-playground',
		'execution_scope'  => 'disposable-playground',
		'permission_model' => 'runtime-principal',
		'status'           => 'blocked',
		'error'            => array(
			'code'    => 'wp_codebox_browser_prerequisites_missing',
			'message' => 'Browser Playground sandbox is missing required coding prerequisites.',
			'missing' => $ready_to_code['missing'] ?? array(),
		),
		'session'          => self::browser_session_envelope( $session_id, 'blocked', $input ),
		'task'             => (string) $task_input['goal'],
		'task_input' => $task_input,
		'agent'      => (string) ( $input['agent'] ?? 'wp-codebox-sandbox' ),
		'plugins'    => $browser_plugins,
		'runtime'    => $runtime,
		'contained_site' => $contained_site,
		'site_blueprint_artifact' => $site_blueprint_artifact,
		'materialization' => array(
			'schema' => 'wp-codebox/browser-materialization/v1',
			'status' => 'blocked',
			'captures' => array(),
		),
		'playground' => array(
			'client_module_url'  => $playground['client_module_url'],
			'remote_url'         => $playground['remote_url'],
			'cors_proxy_url'     => $playground['cors_proxy_url'],
			'scope'              => (string) ( $playground['scope'] ?? $session_id ),
			'artifact_base_path' => self::browser_artifact_base_path( $playground ),
			'artifact_base_url'  => self::browser_artifact_base_url( $playground ),
			'preview_url'        => self::browser_preview_url( $artifacts, $playground ),
			'blueprint'          => self::browser_playground_blueprint( $blueprint, $playground ),
			'prepared_runtime'   => $prepared_runtime,
			'contained_site'     => $contained_site,
			'capabilities'       => array(
				'compile_blueprint' => true,
				'run_blueprint'     => true,
				'write_file'        => true,
				'run_php'           => true,
			),
			'provenance'         => $playground['provenance'],
		),
		'signals'    => array(
			'ready_to_code' => $ready_to_code,
		),
		'artifacts'  => array(
			'schema'             => 'wp-codebox/browser-artifacts/v1',
			'files'              => $artifacts,
			'preview_url'        => self::browser_preview_url( $artifacts, $playground ),
			'expected_artifacts' => $task_input['expected_artifacts'],
		),
	);
}

/** @param array<string,mixed> $session Browser session contract. @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
private static function browser_session_response_for_input( array $session, array $input ): array|WP_Error {
	$product_dto = WP_Codebox_Browser_Task_Builder::product_browser_session_dto( $session );
	if ( true === ( $product_dto['success'] ?? false ) && 'ready' === (string) ( $product_dto['status'] ?? '' ) ) {
		$boot_contract = WP_Codebox_Browser_Task_Builder::validate_browser_preview_boot_contract(
			is_array( $product_dto['preview_boot'] ?? null ) ? $product_dto['preview_boot'] : array(),
			is_array( $product_dto['blueprint_ref'] ?? null ) ? $product_dto['blueprint_ref'] : array()
		);
		if ( false === ( $boot_contract['valid'] ?? false ) ) {
			return new WP_Error(
				'wp_codebox_browser_preview_boot_contract_invalid',
				'Browser preview session is missing a hydratable blueprint ref.',
				array(
					'status'        => 500,
					'schema'        => 'wp-codebox/browser-preview-boot-contract-error/v1',
					'reason'        => (string) ( $boot_contract['reason'] ?? 'preview-boot-contract-invalid' ),
					'session_id'    => (string) ( $product_dto['session_id'] ?? '' ),
					'blueprint_ref' => is_array( $product_dto['blueprint_ref'] ?? null ) ? $product_dto['blueprint_ref'] : array(),
				)
			);
		}
	}
	$evidence_ref = self::browser_session_evidence_store( $product_dto, $session );
	if ( ! empty( $evidence_ref ) ) {
		$product_dto['evidence_ref'] = $evidence_ref;
	}
	if ( self::include_raw_browser_session_contract( $input, $session, $product_dto ) ) {
		$session['product'] = $product_dto;
		return $session;
	}

	return $product_dto;
}

/** @param array<string,mixed> $product_dto Product-safe session DTO. @param array<string,mixed> $session Raw browser session contract. @return array<string,mixed> */
private static function browser_session_evidence_store( array $product_dto, array $session ): array {
	if ( ! function_exists( 'set_transient' ) ) {
		return array();
	}

	$session_id  = (string) ( $product_dto['session_id'] ?? '' );
	$evidence_id = 'browser-session-' . substr( hash( 'sha256', $session_id . wp_json_encode( $product_dto ) ), 0, 24 );
	$ttl         = max( 1, (int) apply_filters( 'wp_codebox_browser_session_evidence_ttl', WEEK_IN_SECONDS, $product_dto, $session ) );
	$evidence    = array_filter(
		array(
			'schema'            => 'wp-codebox/browser-session-evidence/v1',
			'id'                => $evidence_id,
			'created_at'        => gmdate( 'c' ),
			'session_id'        => $session_id,
			'preview_ref'       => is_array( $product_dto['preview_ref'] ?? null ) ? $product_dto['preview_ref'] : array(),
			'preview_reference' => is_array( $product_dto['preview_reference'] ?? null ) ? $product_dto['preview_reference'] : array(),
			'preview_lease'     => is_array( $product_dto['preview_lease'] ?? null ) ? $product_dto['preview_lease'] : array(),
			'preview_boot'      => is_array( $product_dto['preview_boot'] ?? null ) ? $product_dto['preview_boot'] : array(),
			'blueprint_ref'     => is_array( $product_dto['blueprint_ref'] ?? null ) ? $product_dto['blueprint_ref'] : array(),
			'contained_site'    => is_array( $product_dto['contained_site'] ?? null ) ? $product_dto['contained_site'] : array(),
			'signals'           => is_array( $product_dto['signals'] ?? null ) ? $product_dto['signals'] : array(),
		),
		static fn( mixed $value ): bool => '' !== $value && array() !== $value
	);

	if ( ! set_transient( 'wp_codebox_browser_session_evidence_' . $evidence_id, $evidence, $ttl ) ) {
		return array();
	}

	return array(
		'schema'  => 'wp-codebox/browser-session-evidence-ref/v1',
		'id'      => $evidence_id,
		'storage' => 'transient',
		'ttl'     => $ttl,
	);
}

/** @param array<string,mixed> $input Ability input. @param array<string,mixed> $session Raw browser session contract. @param array<string,mixed> $product_dto Product DTO. */
private static function include_raw_browser_session_contract( array $input, array $session, array $product_dto ): bool {
	$include = true === ( $input['include_internal_browser_session'] ?? false );
	if ( function_exists( 'apply_filters' ) ) {
		$include = (bool) apply_filters( 'wp_codebox_include_internal_browser_session_contract', $include, $input, $session, $product_dto );
	}

	return $include;
}

/** @return array<string,mixed> */
private static function browser_contained_site_envelope( array $input, string $session_id, array $playground, array $runtime, array $prepared_runtime, string $status ): array {
	$source_digest = self::browser_contained_site_source_digest( $input, $playground, $runtime, $prepared_runtime );
	$caller_id     = self::browser_contained_site_caller_id( $input );
	$artifact_meta = self::browser_contained_site_artifact_meta( $input );
	$cache_key     = self::safe_key( (string) ( $prepared_runtime['cache_key'] ?? '' ) );
	if ( '' === $cache_key ) {
		$cache_key = 'site-' . substr( hash( 'sha256', $caller_id . ':' . $source_digest ), 0, 16 );
	}
	$site_id    = $cache_key;
	$preview_id = 'preview-' . substr( hash( 'sha256', $site_id . ':' . $session_id ), 0, 16 );

	return array_filter(
		array(
			'schema'        => 'wp-codebox/browser-contained-site/v1',
			'site_id'       => $site_id,
			'preview_id'    => $preview_id,
			'session_id'    => $session_id,
			'caller_id'     => $caller_id,
			'status'        => $status,
			'persistence'   => 'browser-contained',
			'artifact_seed' => (string) ( $artifact_meta['seed'] ?? '' ),
			'artifact_revision' => (string) ( $artifact_meta['revision'] ?? '' ),
			'recovery'      => array(
				'ability' => 'wp-codebox/get-browser-contained-site-status',
				'input'   => array(
					'cache_key'     => $cache_key,
					'input_hash'    => $source_digest,
					'source_digest' => $source_digest,
				),
			),
			'source_digest' => array(
				'algorithm' => 'sha256',
				'value'     => $source_digest,
			),
			'preview'       => array_filter(
				array(
					'preview_public_url' => (string) ( $playground['preview_public_url'] ?? '' ),
					'local_url'          => self::browser_preview_url( array(), $playground ),
					'scope'              => (string) ( $playground['scope'] ?? $session_id ),
				),
				static fn( string $value ): bool => '' !== $value
			),
			'prepared_runtime' => array_filter(
				array(
					'cache_key'  => $cache_key,
					'input_hash' => $source_digest,
					'status'     => (string) ( $prepared_runtime['status'] ?? '' ),
					'selected'   => (string) ( $prepared_runtime['selected'] ?? '' ),
				),
				static fn( string $value ): bool => '' !== $value
			),
		),
		static fn( mixed $value ): bool => array() !== $value && '' !== $value
	);
}

/** @return array{seed?:string,revision?:string} */
private static function browser_contained_site_artifact_meta( array $input ): array {
	$artifact = is_array( $input['site_blueprint_artifact'] ?? null ) ? $input['site_blueprint_artifact'] : array();

	return array_filter(
		array(
			'seed'     => (string) ( $input['artifact_seed'] ?? $artifact['seed'] ?? $artifact['id'] ?? $artifact['ref'] ?? '' ),
			'revision' => (string) ( $input['artifact_revision'] ?? $input['revision'] ?? $artifact['revision'] ?? $artifact['version'] ?? '' ),
		),
		static fn( string $value ): bool => '' !== $value
	);
}

/** @return array<string,mixed> */
private static function browser_contained_site_status_envelope( string $cache_key, string $input_hash, array $lookup ): array {
	$artifact = is_array( $lookup['artifact'] ?? null ) ? $lookup['artifact'] : array();
	$status     = self::browser_contained_site_status_from_lookup( $lookup );
	$resolution = self::browser_contained_site_resolution( $status, $lookup );
	$lifecycle  = self::browser_contained_site_lifecycle( $status, $resolution );
	$digest_refs = self::browser_contained_site_digest_refs( array_merge( $lookup, array( 'source_digest' => array( 'algorithm' => 'sha256', 'value' => $input_hash ) ) ) );

	return array_filter(
		array_merge(
			$lifecycle,
			$digest_refs,
			array(
				'success'       => 'recoverable_prepared_runtime' === $status,
				'schema'        => 'wp-codebox/browser-contained-site-status/v1',
				'site_id'       => $cache_key,
				'status'        => $status,
				'resolution'    => $resolution,
				'source_digest' => array(
					'algorithm' => 'sha256',
					'value'     => $input_hash,
				),
				'prepared_runtime' => array_filter(
					array(
						'cache_key'  => $cache_key,
						'input_hash' => $input_hash,
						'status'     => (string) ( $lookup['status'] ?? '' ),
						'reason'     => (string) ( $resolution['reason'] ?? '' ),
						'created_at' => (string) ( $artifact['created_at'] ?? '' ),
					),
					static fn( string $value ): bool => '' !== $value
				),
				'blueprint_ref' => 'recoverable_prepared_runtime' === $status ? WP_Codebox_Browser_Task_Builder::browser_blueprint_ref( array( 'cache_key' => $cache_key, 'input_hash' => $input_hash, 'status' => 'recoverable_prepared_runtime' ) ) : array(),
				'recovery'      => self::browser_contained_site_open_recovery( $cache_key, $input_hash ),
				'recovery_handle' => self::browser_contained_site_recovery_handle( $cache_key, $input_hash ),
			)
		),
		static fn( mixed $value ): bool => array() !== $value && '' !== $value
	);
}

/** @return array<string,mixed> */
private static function browser_contained_site_lifecycle( string $status, array $resolution ): array {
	$prepared_runtime_recoverable = true === ( $resolution['prepared_runtime_recoverable'] ?? false );
	$live                         = true === ( $resolution['live'] ?? false );
	$current                      = true === ( $resolution['current'] ?? false );
	$materialized                 = true === ( $resolution['materialized'] ?? false );
	$open_mode                    = 'materialize';
	$reuse_level                  = 'none';

	if ( $current ) {
		$open_mode   = 'reuse_current';
		$reuse_level = 'current';
	} elseif ( $live ) {
		$open_mode   = 'reuse_live';
		$reuse_level = 'live';
	} elseif ( $prepared_runtime_recoverable ) {
		$open_mode   = 'reuse_prepared_runtime';
		$reuse_level = 'prepared_runtime';
	} elseif ( $materialized ) {
		$open_mode   = 'reuse_materialized';
		$reuse_level = 'materialized';
	} elseif ( in_array( $status, array( 'disabled', 'incompatible', 'unusable' ), true ) ) {
		$open_mode = 'unavailable';
	}

	return array(
		'open_mode'                    => $open_mode,
		'reuse_level'                  => $reuse_level,
		'requires_materialization'     => ! ( $prepared_runtime_recoverable || $live || $current || $materialized ),
		'prepared_runtime_recoverable' => $prepared_runtime_recoverable,
		'live'                         => $live,
		'current'                      => $current,
		'materialized'                 => $materialized,
	);
}

/** @return array<string,mixed> */
private static function browser_contained_site_digest_refs( array $input ): array {
	$artifact = is_array( $input['artifact'] ?? null ) ? $input['artifact'] : array();

	return array_filter(
		array(
			'source_digest'          => self::browser_contained_site_digest_ref( $input['source_digest'] ?? $artifact['source_digest'] ?? $input['input_hash'] ?? '' ),
			'artifact_digest'        => self::browser_contained_site_digest_ref( $artifact['artifact_digest'] ?? $input['artifact_digest'] ?? $artifact['digest'] ?? $artifact['sha256'] ?? '' ),
			'materialization_digest' => self::browser_contained_site_digest_ref( $artifact['materialization_digest'] ?? $input['materialization_digest'] ?? '' ),
		),
		static fn( mixed $value ): bool => array() !== $value
	);
}

/** @return array{algorithm:string,value:string}|array{} */
private static function browser_contained_site_digest_ref( mixed $value ): array {
	if ( is_array( $value ) ) {
		$digest    = strtolower( trim( (string) ( $value['value'] ?? $value['sha256'] ?? $value['hash'] ?? '' ) ) );
		$algorithm = (string) ( $value['algorithm'] ?? 'sha256' );
	} else {
		$digest    = strtolower( trim( (string) $value ) );
		$algorithm = 'sha256';
	}

	if ( ! preg_match( '/^[a-f0-9]{64}$/', $digest ) ) {
		return array();
	}

	return array(
		'algorithm' => $algorithm,
		'value'     => $digest,
	);
}

/** @return string */
private static function browser_contained_site_status_from_lookup( array $lookup ): string {
	$lookup_status = (string) ( $lookup['status'] ?? 'miss' );
	if ( 'hit' === $lookup_status ) {
		return 'recoverable_prepared_runtime';
	}

	if ( ! empty( $lookup['invalidation'] ) ) {
		return 'incompatible';
	}

	return '' !== $lookup_status ? $lookup_status : 'miss';
}

/** @return array<string,mixed> */
private static function browser_contained_site_resolution( string $status, array $lookup ): array {
	$invalidation = is_array( $lookup['invalidation'] ?? null ) ? $lookup['invalidation'] : array();
	$reason       = (string) ( $invalidation['reason'] ?? '' );
	if ( '' === $reason ) {
		$reason = match ( $status ) {
			'recoverable_prepared_runtime' => 'prepared-runtime-cache-hit',
			'incompatible'  => 'prepared-runtime-incompatible',
			'disabled'      => 'prepared-runtime-cache-disabled',
			default         => 'prepared-runtime-not-found-or-expired',
		};
	}

	return array_filter(
		array(
			'schema'       => 'wp-codebox/browser-contained-site-resolution/v1',
			'outcome'      => $status,
			'reason'       => $reason,
			'recoverable'  => 'recoverable_prepared_runtime' === $status,
			'prepared_runtime_recoverable' => 'recoverable_prepared_runtime' === $status,
			'live'         => in_array( $status, array( 'current', 'live' ), true ),
			'current'      => 'current' === $status,
			'materialized' => in_array( $status, array( 'current', 'live', 'materialized' ), true ),
			'reused'       => false,
			'created'      => false,
			'expired'      => 'miss' === $status ? null : false,
			'miss'         => 'miss' === $status,
			'incompatible' => 'incompatible' === $status,
		),
		static fn( mixed $value ): bool => null !== $value && array() !== $value && '' !== $value
	);
}

/** @return array<string,mixed> */
private static function browser_contained_site_open_session( array $input, array $contained_site, array $status ): array {
	$source_digest = (string) ( $status['source_digest']['value'] ?? '' );
	$session_id    = trim( (string) ( $input['session_id'] ?? $input['sandbox_session_id'] ?? $contained_site['session_id'] ?? '' ) );
	$site_id       = (string) ( $status['site_id'] ?? $contained_site['site_id'] ?? $input['site_id'] ?? '' );
	if ( '' === $session_id && '' !== $site_id ) {
		$session_id = 'contained-' . substr( hash( 'sha256', $site_id . ':' . $source_digest ), 0, 16 );
	}

	$preview    = is_array( $contained_site['preview'] ?? null ) ? $contained_site['preview'] : array();
	$playground = is_array( $input['playground'] ?? null ) ? $input['playground'] : array();
	$playground = array_merge(
		array_filter(
			array(
				'scope'              => (string) ( $preview['scope'] ?? $session_id ),
				'preview_public_url' => (string) ( $preview['preview_public_url'] ?? '' ),
				'preview_url'        => (string) ( $preview['local_url'] ?? '' ),
				'local_url'          => (string) ( $preview['local_url'] ?? '' ),
				'site_url'           => (string) ( $preview['site_url'] ?? '' ),
			),
			static fn( string $value ): bool => '' !== $value
		),
		$playground
	);
	$playground['prepared_runtime'] = array_filter(
		array(
			'cache_key'  => $site_id,
			'input_hash' => $source_digest,
			'status'     => (string) ( $status['status'] ?? '' ),
			'created_at' => (string) ( $status['prepared_runtime']['created_at'] ?? '' ),
		),
		static fn( string $value ): bool => '' !== $value
	);

	if ( is_array( $input['preview_lease'] ?? null ) ) {
		$playground['lease'] = $input['preview_lease'];
	}

	return array(
		'success'        => true === ( $status['success'] ?? false ),
		'schema'         => 'wp-codebox/browser-contained-site-open-session/v1',
		'status'         => (string) ( $status['status'] ?? '' ),
		'execution'      => 'browser-contained-site-open',
		'execution_scope' => 'browser-contained-site',
		'session'        => array_filter( array( 'id' => $session_id ), static fn( string $value ): bool => '' !== $value ),
		'session_id'     => $session_id,
		'playground'     => $playground,
		'contained_site' => $contained_site,
	);
}

/** @return array<string,mixed> */
private static function browser_contained_site_public_input( array $contained_site ): array {
	return array_intersect_key(
		$contained_site,
		array(
			'schema'           => true,
			'site_id'          => true,
			'preview_id'       => true,
			'session_id'       => true,
			'caller_id'        => true,
			'status'           => true,
			'persistence'      => true,
			'recovery'         => true,
			'source_digest'    => true,
			'artifact_seed'    => true,
			'artifact_revision' => true,
			'preview'          => true,
			'prepared_runtime' => true,
			'resolution'       => true,
			'blueprint_ref'    => true,
		)
	);
}

/** @return array<string,mixed> */
private static function browser_contained_site_session_identity( string $session_id, string $preview_id, string $scope ): array {
	return array_filter(
		array(
			'schema'     => 'wp-codebox/browser-session-identity/v1',
			'session_id' => $session_id,
			'preview_id' => $preview_id,
			'scope'      => $scope,
		),
		static fn( string $value ): bool => '' !== $value
	);
}

/** @param array<string,mixed> $result Source create/open result. @return array<string,mixed> */
private static function browser_contained_site_facade_session( array $result, string $action ): array {
	$contained_site = is_array( $result['contained_site'] ?? null ) ? $result['contained_site'] : array();
	$preview_boot   = is_array( $result['preview_boot'] ?? null ) ? $result['preview_boot'] : array();
	$preview_lease  = is_array( $result['preview_lease'] ?? null ) ? $result['preview_lease'] : WP_Codebox_Browser_Task_Builder::preview_lease( $result );
	$blueprint_ref  = is_array( $result['blueprint_ref'] ?? null ) ? $result['blueprint_ref'] : ( is_array( $preview_boot['blueprint_ref_dto'] ?? null ) ? $preview_boot['blueprint_ref_dto'] : array() );
	$boot_contract  = WP_Codebox_Browser_Task_Builder::validate_browser_preview_boot_contract( $preview_boot, $blueprint_ref );
	$boot           = self::browser_contained_site_boot_descriptor( $result, $contained_site, $preview_boot, $preview_lease, $blueprint_ref );

	return array_filter(
		array(
			'success'             => true === ( $result['success'] ?? false ),
			'schema'              => 'wp-codebox/browser-contained-site-session/v1',
			'action'              => $action,
			'contained_site'      => $contained_site,
			'boot'                => $boot,
			'preview_lease'       => $preview_lease,
			'startup_diagnostics' => self::browser_contained_site_startup_diagnostics( $result, $contained_site, $preview_lease, $boot_contract ),
			'session'             => is_array( $result['session'] ?? null ) ? $result['session'] : array(),
		),
		static fn( mixed $value ): bool => array() !== $value && '' !== $value
	);
}

/** @return array<string,mixed> */
private static function browser_contained_site_boot_descriptor( array $result, array $contained_site, array $preview_boot, array $preview_lease, array $blueprint_ref ): array {
	return array_filter(
		array(
			'schema'         => 'wp-codebox/browser-contained-site-boot/v1',
			'session_id'     => (string) ( $result['session']['session_id'] ?? $result['session']['id'] ?? $preview_boot['session_id'] ?? '' ),
			'site_id'        => (string) ( $result['site_id'] ?? $contained_site['site_id'] ?? '' ),
			'status'         => (string) ( $result['status'] ?? $contained_site['status'] ?? '' ),
			'preview'        => $preview_lease,
			'contained_site' => $contained_site,
			'blueprint_ref'  => $blueprint_ref,
			'debug'          => array_filter(
				array(
					'preview_boot_schema' => (string) ( $preview_boot['schema'] ?? '' ),
					'preview_boot_ref'    => (string) ( $preview_boot['blueprint_ref'] ?? '' ),
				),
				static fn( string $value ): bool => '' !== $value
			),
		),
		static fn( mixed $value ): bool => array() !== $value && '' !== $value
	);
}

/** @return array<string,mixed> */
private static function browser_contained_site_startup_diagnostics( array $result, array $contained_site, array $preview_lease, array $boot_contract ): array {
	return array_filter(
		array(
			'schema'               => 'wp-codebox/browser-contained-site-startup-diagnostics/v1',
			'status'               => (string) ( $result['status'] ?? $contained_site['status'] ?? 'unknown' ),
			'open_mode'            => (string) ( $result['open_mode'] ?? $contained_site['open_mode'] ?? '' ),
			'reuse_level'          => (string) ( $result['reuse_level'] ?? $contained_site['reuse_level'] ?? '' ),
			'preview_lease_status' => WP_Codebox_Browser_Task_Builder::preview_lease_status( $preview_lease ),
			'boot_contract'        => $boot_contract,
			'recovery_handle'      => (string) ( $result['recovery_handle'] ?? $contained_site['recovery_handle'] ?? '' ),
		),
		static fn( mixed $value ): bool => array() !== $value && '' !== $value
	);
}

/** @return array<string,mixed> */
private static function validate_browser_contained_site_source( array $input, string $schema ): array {
	$contained_site = self::browser_contained_site_public_input( is_array( $input['contained_site'] ?? null ) ? $input['contained_site'] : array() );
	$site_id        = self::safe_key( (string) ( $input['site_id'] ?? $contained_site['site_id'] ?? '' ) );
	$input_digest   = self::browser_contained_site_digest_ref( $input['source_digest'] ?? $input['input_hash'] ?? '' );
	$site_digest    = self::browser_contained_site_digest_ref( $contained_site['source_digest'] ?? '' );
	$source_digest  = ! empty( $input_digest ) ? $input_digest : $site_digest;

	if ( '' === $site_id || empty( $source_digest ) ) {
		return self::browser_contained_site_contract_error( $schema, 'wp_codebox_browser_contained_site_ref_invalid', 'Browser contained site contracts require a contained site handle/site_id and a 64-character source digest.', array( 'site_id' => $site_id ), array( 'source_digest' => $input['source_digest'] ?? $input['input_hash'] ?? $contained_site['source_digest'] ?? null ) );
	}

	if ( ! empty( $site_digest ) && ! empty( $input_digest ) && (string) $site_digest['value'] !== (string) $input_digest['value'] ) {
		return self::browser_contained_site_contract_error( $schema, 'wp_codebox_browser_contained_site_stale_digest', 'Browser contained site source digest does not match the requested source digest.', $site_digest, $input_digest );
	}

	$session_id       = trim( (string) ( $input['session_id'] ?? $input['sandbox_session_id'] ?? '' ) );
	$site_session_id  = trim( (string) ( $contained_site['session_id'] ?? '' ) );
	if ( '' !== $session_id && '' !== $site_session_id && $session_id !== $site_session_id ) {
		return self::browser_contained_site_contract_error( $schema, 'wp_codebox_browser_contained_site_session_mismatch', 'Browser contained site session does not match the requested session.', array( 'session_id' => $site_session_id ), array( 'session_id' => $session_id ) );
	}

	$scope      = trim( (string) ( $input['scope'] ?? '' ) );
	$site_scope = trim( (string) ( $contained_site['preview']['scope'] ?? $contained_site['session']['scope'] ?? '' ) );
	if ( '' !== $scope && '' !== $site_scope && $scope !== $site_scope ) {
		return self::browser_contained_site_contract_error( $schema, 'wp_codebox_browser_contained_site_scope_mismatch', 'Browser contained site scope does not match the requested scope.', array( 'scope' => $site_scope ), array( 'scope' => $scope ) );
	}

	$status = self::get_browser_contained_site_status(
		array(
			'site_id'       => $site_id,
			'source_digest' => $source_digest,
		)
	);
	if ( is_wp_error( $status ) ) {
		return self::browser_contained_site_contract_error( $schema, 'wp_codebox_browser_contained_site_ref_invalid', 'Browser contained site status could not be resolved.', array( 'site_id' => $site_id, 'source_digest' => $source_digest ), array() );
	}
	if ( 'incompatible' === (string) ( $status['status'] ?? '' ) ) {
		return self::browser_contained_site_contract_error( $schema, 'wp_codebox_browser_contained_site_stale_digest', 'Browser contained site source digest is stale for the prepared runtime.', array( 'source_digest' => $source_digest ), array( 'status' => $status ) );
	}

	return array_filter(
		array(
			'success'        => true,
			'schema'         => $schema,
			'contained_site' => array_filter( array_merge( $contained_site, array( 'schema' => 'wp-codebox/browser-contained-site/v1', 'site_id' => $site_id, 'source_digest' => $source_digest ) ), static fn( mixed $value ): bool => array() !== $value && '' !== $value ),
			'source_digest'  => $source_digest,
			'session'        => self::browser_contained_site_session_identity( '' !== $site_session_id ? $site_session_id : $session_id, (string) ( $contained_site['preview_id'] ?? '' ), '' !== $site_scope ? $site_scope : $scope ),
			'status'         => $status,
		),
		static fn( mixed $value ): bool => array() !== $value && '' !== $value
	);
}

/** @return array<string,mixed> */
private static function browser_contained_site_contract_error( string $schema, string $code, string $message, array $expected, array $actual ): array {
	return array_filter(
		array(
			'success' => false,
			'schema'  => $schema,
			'error'   => array_filter(
				array(
					'code'     => $code,
					'message'  => $message,
					'expected' => $expected,
					'actual'   => $actual,
				),
				static fn( mixed $value ): bool => array() !== $value && null !== $value
			),
		),
		static fn( mixed $value ): bool => array() !== $value && '' !== $value
	);
}

/** @return array<string,mixed> */
private static function browser_contained_site_open_recovery( string $site_id, string $source_digest ): array {
	return array_filter(
		array(
			'ability' => 'wp-codebox/open-browser-contained-site',
			'input'   => array_filter(
				array(
					'site_id'       => $site_id,
					'source_digest' => $source_digest,
				),
				static fn( string $value ): bool => '' !== $value
			),
		),
		static fn( mixed $value ): bool => array() !== $value && '' !== $value
	);
}

private static function browser_contained_site_recovery_handle( string $site_id, string $source_digest ): string {
	return '' !== $site_id && preg_match( '/^[a-f0-9]{64}$/', $source_digest ) ? 'browser-contained-site:' . $site_id . ':' . $source_digest : '';
}

private static function browser_contained_site_source_digest( array $input, array $playground, array $runtime, array $prepared_runtime ): string {
	$input_hash = strtolower( trim( (string) ( $prepared_runtime['input_hash'] ?? '' ) ) );
	if ( preg_match( '/^[a-f0-9]{64}$/', $input_hash ) ) {
		return $input_hash;
	}

	$hash_input = array(
		'runtime'    => is_array( $runtime['prepared_runtime'] ?? null ) ? array_diff_key( $runtime, array( 'prepared_runtime' => true ) ) : $runtime,
		'blueprint'  => is_array( $input['blueprint'] ?? null ) ? $input['blueprint'] : array(),
		'site_blueprint_artifact' => is_array( $input['site_blueprint_artifact'] ?? null ) ? $input['site_blueprint_artifact'] : array(),
		'playground' => array(
			'wp'  => (string) ( $playground['wp'] ?? $input['playground']['wp'] ?? 'latest' ),
			'php' => (string) ( $playground['php'] ?? $input['playground']['php'] ?? 'latest' ),
		),
	);

	return hash( 'sha256', 'wp-codebox/browser-contained-site-source/v1' . "\n" . self::stable_json( $hash_input ) );
}

private static function browser_contained_site_caller_id( array $input ): string {
	$authorization = is_array( $input['authorization'] ?? null ) ? $input['authorization'] : array();
	$orchestrator  = is_array( $input['orchestrator'] ?? null ) ? $input['orchestrator'] : array();
	$caller_id     = self::safe_key( (string) ( $authorization['caller'] ?? $orchestrator['id'] ?? $orchestrator['type'] ?? '' ) );

	return '' !== $caller_id ? $caller_id : 'wp-codebox';
}

/** @return array<string,mixed> */
private static function browser_session_envelope( string $session_id, string $status, array $input ): array {
	$session = WP_Codebox_Agent_Task::session( $session_id, $status, $input );
	$session['execution_scope']  = 'disposable-playground';
	$session['permission_model'] = 'runtime-principal';
	$authorization               = self::browser_session_authorization( $input );
	if ( ! empty( $authorization['caller'] ) || ! empty( $authorization['scope'] ) ) {
		$session['authorization'] = $authorization;
	}

	return $session;
}

/** @param array<string,mixed> $input Ability input. @param array<string,mixed> $runtime Normalized runtime dependency specs. @return array<string,mixed> */
private static function browser_ready_to_code_signal( array $input, array $runtime ): array {
	$provider_plugin_paths = array_values(
		array_filter(
			array_map( 'strval', is_array( $input['provider_plugin_paths'] ?? null ) ? $input['provider_plugin_paths'] : array() ),
			static fn( string $path ): bool => '' !== trim( $path )
		)
	);
	$inherit      = is_array( $input['inherit'] ?? null ) ? $input['inherit'] : array();
	$connectors   = array_values( array_filter( array_map( 'strval', is_array( $inherit['connectors'] ?? null ) ? $inherit['connectors'] : array() ) ) );
	$secret_env   = array_values( array_filter( array_map( 'strval', is_array( $input['secret_env'] ?? null ) ? $input['secret_env'] : array() ) ) );
	$runtime_requirements = self::browser_runtime_requirements( $input, array( 'connectors' => array(), 'settings' => array() ) );
	$requires_provider    = (bool) ( $runtime_requirements['requires_provider'] ?? false );
	$requirements = array(
		'provider_plugin'   => ! $requires_provider || empty( $provider_plugin_paths ) || self::all_paths_ready( $provider_plugin_paths ),
		'provider_secret'   => ! $requires_provider || ! empty( $connectors ) || ! empty( $secret_env ),
		'runtime_dependencies' => true,
	);
	foreach ( self::browser_ready_to_code_component_requirements( $input, $runtime ) as $name => $ready ) {
		$requirements[ $name ] = $ready;
	}

	/**
	 * Filters browser sandbox readiness requirements before the signal is emitted.
	 *
	 * @param array<string,bool>  $requirements Named readiness checks.
	 * @param array<string,mixed> $input        Ability input.
	 */
	$requirements = apply_filters( 'wp_codebox_browser_ready_to_code_requirements', $requirements, $input );
	$requirements = is_array( $requirements ) ? array_map( 'boolval', $requirements ) : array();
	$missing      = array_keys( array_filter( $requirements, static fn( bool $ready ): bool => ! $ready ) );
	$emitted      = empty( $missing );

	return array(
		'schema'       => 'wp-codebox/signal/v1',
		'name'         => 'ready_to_code',
		'emitted'      => $emitted,
		'message'      => $emitted ? 'Browser Playground sandbox is ready to code.' : 'Browser Playground sandbox is not ready to code.',
		'requirements' => $requirements,
		'requirement_metadata' => array(
			'runtime_requirements'  => $runtime_requirements,
			'runtime_dependencies' => self::browser_runtime_readiness_metadata( $runtime ),
			'components'           => self::browser_runtime_component_readiness_metadata( $input, $runtime ),
		),
		'missing'      => $missing,
	);
}

/** @param array<string,mixed> $input Ability input. @param array<string,mixed> $runtime Normalized runtime dependencies. @return array<string,bool> */
private static function browser_ready_to_code_component_requirements( array $input, array $runtime ): array {
	$requirements = array();
	$contracts    = self::browser_component_contracts( $input );
	foreach ( self::browser_runtime_component_slugs( is_array( $runtime['components'] ?? null ) ? $runtime['components'] : array(), false ) as $slug ) {
		$contract = is_array( $contracts[ $slug ] ?? null ) ? $contracts[ $slug ] : array();
		$ready    = self::browser_runtime_has_plugin( $runtime, $slug );
		$probe    = is_array( $contract['readiness_probe'] ?? null ) ? $contract['readiness_probe'] : array();
		if ( $ready && ! empty( $probe ) ) {
			$ready = self::browser_component_readiness_probe_ready( $probe );
		}

		$requirements[ 'component:' . $slug ] = $ready;
	}

	return $requirements;
}

/** @param array<string,mixed> $probe Component readiness probe. */
private static function browser_component_readiness_probe_ready( array $probe ): bool {
	$type = (string) ( $probe['type'] ?? '' );
	if ( 'ability' === $type ) {
		$name = (string) ( $probe['name'] ?? '' );
		return ( new WP_Codebox_Agent_Runtime_Invoker() )->is_ability_available( $name );
	}

	if ( 'filter' === $type ) {
		$name = (string) ( $probe['name'] ?? '' );
		return '' !== $name && function_exists( 'apply_filters' ) && (bool) apply_filters( $name, false, $probe );
	}

	return true;
}

/** @param array<string,mixed> $input Ability input. @param array<string,mixed> $runtime Normalized runtime dependencies. @return array<int,array<string,mixed>> */
private static function browser_runtime_component_readiness_metadata( array $input, array $runtime ): array {
	$contracts = self::browser_component_contracts( $input );
	$metadata  = array();
	foreach ( self::browser_runtime_component_slugs( is_array( $runtime['components'] ?? null ) ? $runtime['components'] : array(), false ) as $slug ) {
		$metadata[] = array(
			'slug'       => $slug,
			'installed'  => self::browser_runtime_has_plugin( $runtime, $slug ),
			'probe'      => is_array( $contracts[ $slug ]['readiness_probe'] ?? null ) ? $contracts[ $slug ]['readiness_probe'] : null,
			'readiness'  => self::browser_runtime_has_plugin( $runtime, $slug ) ? 'compiled' : 'missing',
		);
	}

	return $metadata;
}

private static function agents_api_ready(): bool {
	return ( new WP_Codebox_Agent_Runtime_Invoker() )->is_agents_api_ready();
}

/** @param array<int,string> $paths Paths to verify. */
private static function all_paths_ready( array $paths ): bool {
	foreach ( $paths as $path ) {
		if ( ! is_dir( $path ) ) {
			return false;
		}
	}

	return true;
}

/** @param array<string,mixed> $runtime Normalized runtime dependencies. */
private static function browser_runtime_has_plugin( array $runtime, string $slug ): bool {
	foreach ( is_array( $runtime['plugins'] ?? null ) ? $runtime['plugins'] : array() as $plugin ) {
		if ( is_array( $plugin ) && $slug === self::safe_key( (string) ( $plugin['slug'] ?? '' ) ) ) {
			return true;
		}
	}

	return false;
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function list_artifacts( array $input = array() ): array|WP_Error {
	return ( new WP_Codebox_Artifacts() )->list( $input );
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function get_artifact( array $input ): array|WP_Error {
	return ( new WP_Codebox_Artifacts() )->get( $input );
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function inspect_artifact( array $input ): array|WP_Error {
	return ( new WP_Codebox_Artifacts() )->inspect( $input );
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function discard_artifact( array $input ): array|WP_Error {
	return ( new WP_Codebox_Artifacts() )->discard( $input );
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function normalize_browser_artifact_bundle( array $input ): array|WP_Error {
	return ( new WP_Codebox_Artifacts() )->normalize_browser_bundle( $input );
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function persist_browser_artifact( array $input ): array|WP_Error {
	$result = ( new WP_Codebox_Artifacts() )->persist_browser_bundle( $input );
	if ( is_wp_error( $result ) ) {
		return $result;
	}

	$authorization = self::trusted_orchestrator_authorization( $input, self::BROWSER_ARTIFACT_WRITE_SCOPE );
	if ( ! empty( $authorization['caller'] ) || ! empty( $authorization['scope'] ) ) {
		$result['authorization'] = $authorization;
	}

	return $result;
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function import_artifact_bundle( array $input ): array|WP_Error {
	return ( new WP_Codebox_Artifacts() )->import_artifact_bundle( $input );
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function reimport_artifact_bundle( array $input ): array|WP_Error {
	return ( new WP_Codebox_Artifacts() )->reimport_artifact_bundle( $input );
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function review_artifact( array $input ): array|WP_Error {
	return ( new WP_Codebox_Artifacts() )->review_artifact( $input );
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function apply_artifact_preflight( array $input ): array|WP_Error {
	return ( new WP_Codebox_Artifacts() )->apply_preflight( $input );
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function apply_approved_artifact( array $input ): array|WP_Error {
	return ( new WP_Codebox_Artifacts() )->apply_approved( $input );
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function stage_artifact_apply( array $input ): array|WP_Error {
	return WP_Codebox_Pending_Artifact_Apply::stage_apply_artifact( $input );
}
}

if ( ! function_exists( 'wp_codebox_bench_run_external_http_guardrail_step' ) ) {
	/** @param array<string,mixed> $args Args. @return array<string,mixed> */
	function wp_codebox_bench_run_external_http_guardrail_step( array $args ): array {
		$state = is_array( $GLOBALS['wp_codebox_external_http_guardrail_state'] ?? null ) ? $GLOBALS['wp_codebox_external_http_guardrail_state'] : array();
		$action = (string) ( $args['action'] ?? 'collect' );
		if ( 'install' === $action ) {
			$state = array(
				'allowlist' => array_values( array_filter( array_map( 'strval', $args['allowlistDomains'] ?? $args['allowlist'] ?? array() ) ) ),
				'block'     => (bool) ( $args['blockNetwork'] ?? $args['block_network'] ?? true ),
				'requests'  => array(),
			);
			$GLOBALS['wp_codebox_external_http_guardrail_state'] = $state;
			if ( empty( $GLOBALS['wp_codebox_external_http_guardrail_filter_installed'] ) ) {
				add_filter( 'pre_http_request', 'wp_codebox_external_http_guardrail_pre_http_request', 10, 3 );
				$GLOBALS['wp_codebox_external_http_guardrail_filter_installed'] = true;
			}
		}

		$state = is_array( $GLOBALS['wp_codebox_external_http_guardrail_state'] ?? null ) ? $GLOBALS['wp_codebox_external_http_guardrail_state'] : $state;
		$requests = is_array( $state['requests'] ?? null ) ? $state['requests'] : array();
		$blocked = count( array_filter( $requests, static fn( array $request ): bool => 'blocked' === ( $request['classification'] ?? '' ) ) );
		$allowlisted = count( array_filter( $requests, static fn( array $request ): bool => 'allowlisted_boundary_blocked' === ( $request['classification'] ?? '' ) ) );
		return array(
			'schema' => 'wp-codebox/external-http-guardrail/v1',
			'status' => 'passed',
			'summary' => array( 'total' => count( $requests ), 'blocked' => $blocked, 'allowlisted' => $allowlisted ),
			'requests' => $requests,
			'metadata' => array( 'runner' => 'wp-codebox/fuzz-suite-runner/v1', 'allowlist' => array_values( array_map( 'strval', $state['allowlist'] ?? array() ) ) ),
		);
	}
}

if ( ! function_exists( 'wp_codebox_external_http_guardrail_pre_http_request' ) ) {
	/** @param false|array|WP_Error $preempt Preempt. @param array<string,mixed> $parsed_args Parsed args. */
	function wp_codebox_external_http_guardrail_pre_http_request( mixed $preempt, array $parsed_args, string $url ): mixed {
		$state = is_array( $GLOBALS['wp_codebox_external_http_guardrail_state'] ?? null ) ? $GLOBALS['wp_codebox_external_http_guardrail_state'] : array();
		$host = strtolower( (string) wp_parse_url( $url, PHP_URL_HOST ) );
		$allowlist = array_map( 'strtolower', array_map( 'strval', is_array( $state['allowlist'] ?? null ) ? $state['allowlist'] : array() ) );
		$classification = in_array( $host, $allowlist, true ) ? 'allowlisted_boundary_blocked' : 'blocked';
		$state['requests'][] = array(
			'url' => preg_replace( '/([?&](?:token|secret|nonce|_wpnonce|authorization)=)[^&]+/i', '$1[redacted]', $url ),
			'host' => $host,
			'method' => (string) ( $parsed_args['method'] ?? 'GET' ),
			'classification' => $classification,
		);
		$GLOBALS['wp_codebox_external_http_guardrail_state'] = $state;
		if ( ! empty( $state['block'] ) ) {
			return new WP_Error( 'wp_codebox_external_http_guardrail_blocked', 'External HTTP request blocked by WP Codebox fuzz guardrail.', array( 'host' => $host, 'classification' => $classification ) );
		}
		return $preempt;
	}
}
