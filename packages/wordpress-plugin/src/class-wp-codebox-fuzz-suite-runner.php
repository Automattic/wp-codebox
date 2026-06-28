<?php
/**
 * PHP in-process fuzz suite runner.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

class WP_Codebox_Fuzz_Suite_Runner {
/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public function run( array $input ): array|WP_Error {
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
public static function fuzz_suite_supported_runner_capabilities(): array {
	return array(
		'php-in-process' => self::fuzz_suite_runner_capabilities_contract(),
		'runtime-backed' => self::fuzz_suite_runtime_backed_runner_capabilities_contract(),
	);
}

/** @return array<string,mixed> */
public static function fuzz_suite_runtime_backed_execution_contract(): array {
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
public static function fuzz_suite_runner_capabilities_contract( array $suite = array() ): array {
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
public static function fuzz_suite_runtime_backed_runner_capabilities_contract( array $suite = array() ): array {
	$capabilities = array(
		'schema'                          => 'wp-codebox/fuzz-runner-capabilities/v1',
		'mode'                            => 'runtime-backed',
		'capabilities'                    => array( 'target:ability', 'target:command', 'target:http', 'target:rest', 'target:runtime', 'target:runtime-action', 'runtime', 'runtime-action:admin_page', 'runtime-action:browser', 'runtime-action:browser_probe', 'runtime-action:crud_operation', 'runtime-action:db_operation', 'runtime-action:editor_open', 'runtime-action:page', 'runtime-action:php', 'runtime-action:rest_request', 'runtime-action:wp_cli', 'db_operation', 'rest-mutation:fixture-opt-in', 'mutation-isolation-artifact', 'delete-boundary-artifact' ),
		'targetKinds'                     => array( 'ability', 'command', 'http', 'rest', 'runtime', 'runtime-action' ),
		'operationKinds'                  => array( 'read', 'crud', 'mutation-isolation', 'delete-boundary' ),
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

		$step_result = self::execute_fuzz_suite_step( $step, $case, $suite, $case_id, $observations, $artifacts );
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
private static function execute_fuzz_suite_step( array $step, array $case, array $suite, string $case_id, array $prior_observations = array(), array $prior_artifacts = array() ): array {
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
			'wordpress.collect-workload-result' => self::execute_fuzz_suite_collect_artifact( $args, $case, $observation, $prior_artifacts ),
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
		$payload = WP_Codebox_WordPress_Runtime_Primitives::external_http_guardrail(
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
private static function execute_fuzz_suite_collect_artifact( array $args, array $case, array $observation, array $prior_artifacts = array() ): array {
	$name = (string) ( $args['artifact'] ?? $args['name'] ?? '' );
	$prior_steps = array_map(
		static fn( array $prior ): array => array_filter( array( 'command' => (string) ( $prior['command'] ?? '' ), 'status' => (string) ( $prior['status'] ?? 'passed' ), 'observation' => $prior ), static fn( mixed $value ): bool => '' !== $value ),
		array_values( array_filter( is_array( $observation['prior_observations'] ?? null ) ? $observation['prior_observations'] : array(), 'is_array' ) )
	);
	$collection = WP_Codebox_WordPress_Runtime_Primitives::collect_workload_result( $args, $prior_steps, array_merge( self::fuzz_suite_declared_artifact_refs( $case ), $prior_artifacts ) );
	$observation['artifact'] = $name;
	$observation['payload'] = $collection['payload'];
	return array( 'status' => 'passed', 'observation' => $observation, 'artifactRefs' => $collection['artifactRefs'] );
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

}
