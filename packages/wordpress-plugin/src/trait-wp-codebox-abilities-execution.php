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
	return WP_Codebox_Runtime_Provider_Registry::invoke( $input );
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
		'metadata'     => array( 'canonical_ability' => 'wp-codebox/run-fuzz-suite', 'runner' => 'wp-codebox/fuzz-suite-runner/v1' ),
	);
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

		$step_result = self::execute_fuzz_suite_step( $step, $case, $suite, $case_id );
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
private static function execute_fuzz_suite_step( array $step, array $case, array $suite, string $case_id ): array {
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

	try {
		return match ( $command ) {
			'wordpress.ensure-plugin-active' => self::execute_fuzz_suite_plugin_activation( $args, $observation, $case_id ),
			'wordpress.rest-request' => self::execute_fuzz_suite_rest_request( $args, $observation, $case_id ),
			'wordpress.http-request' => self::execute_fuzz_suite_http_request( $args, $observation, $case_id ),
			'wordpress.ability' => self::execute_fuzz_suite_ability( $args, $observation, $case_id ),
			'wordpress.collect-workload-result' => self::execute_fuzz_suite_collect_artifact( $args, $case, $observation ),
			'wordpress.run-workload', 'wordpress.run-declarative-fuzz' => self::execute_fuzz_suite_workload_step( $args, $command, $observation, $case_id ),
			default => self::fuzz_suite_step_unsupported( $command, $observation, $case_id ),
		};
	} catch ( Throwable $throwable ) {
		return array( 'status' => 'error', 'observation' => $observation, 'diagnostic' => self::fuzz_suite_diagnostic( 'error', 'wp_codebox_fuzz_step_exception', $throwable->getMessage(), array( 'case_id' => $case_id, 'command' => $command ) ) );
	}
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

/** @param array<string,string> $args Args. @param array<string,mixed> $observation Observation. @return array<string,mixed> */
private static function execute_fuzz_suite_workload_step( array $args, string $command, array $observation, string $case_id ): array {
	$path = (string) ( $args['path'] ?? $args['manifest'] ?? '' );
	$resolved = self::resolve_fuzz_suite_file_path( $path );
	if ( '' === $resolved ) {
		return array( 'status' => 'skipped', 'observation' => $observation, 'diagnostic' => self::fuzz_suite_diagnostic( 'warning', 'wp_codebox_fuzz_workload_unavailable', 'Workload file is not available inside this runtime.', array( 'case_id' => $case_id, 'command' => $command, 'path' => $path ) ) );
	}
	$observation['path'] = $resolved;
	if ( 'wordpress.run-declarative-fuzz' === $command ) {
		return array( 'status' => 'passed', 'observation' => $observation );
	}
	ob_start();
	$result = include $resolved;
	$output = ob_get_clean();
	$observation['output_bytes'] = strlen( (string) $output );
	$observation['return_type'] = gettype( $result );
	return array( 'status' => false === $result ? 'failed' : 'passed', 'observation' => $observation );
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
			continue;
		}
		$seen[ $key ] = true;
		$output[] = $ref;
	}
	return $output;
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
	$blueprint       = self::browser_selected_prepared_runtime_blueprint( $prepared_runtime, $blueprint );
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
	$decision = self::preview_reuse_decision( $input );
	if ( is_wp_error( $decision ) ) {
		return $decision;
	}

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

	if ( empty( $input['fallback_create'] ) ) {
		return array_filter(
			array(
				'success'         => false,
				'schema'          => 'wp-codebox/browser-contained-site-open-or-create/v1',
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

	$created = self::create_browser_playground_session( $input );
	if ( is_wp_error( $created ) ) {
		return $created;
	}

	return array_filter(
		array(
			'success'         => true === ( $created['success'] ?? false ),
			'schema'          => 'wp-codebox/browser-contained-site-open-or-create/v1',
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

/** @param array<string,mixed> $input Blueprint ref input. @return array<string,mixed>|WP_Error */
public static function hydrate_browser_blueprint_ref( array $input ): array|WP_Error {
	return WP_Codebox_Browser_Task_Builder::hydrate_browser_blueprint_ref( $input );
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function create_browser_materializer_contract( array $input ): array|WP_Error {
	$return_raw = self::include_raw_browser_contract( $input, 'materializer' );
	$input['include_raw_browser_session'] = true;
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
	if ( true === ( $input['include_internal_browser_contract'] ?? false ) || true === ( $input['include_raw_browser_contract'] ?? false ) ) {
		return true;
	}

	if ( 'materializer' === $contract && true === ( $input['include_raw_browser_materializer_contract'] ?? false ) ) {
		return true;
	}

	if ( 'task' === $contract && true === ( $input['include_raw_browser_task_contract'] ?? false ) ) {
		return true;
	}

	$debug = is_array( $input['debug'] ?? null ) ? $input['debug'] : array();
	return true === ( $debug['include_internal_browser_contract'] ?? false )
		|| true === ( $debug['include_raw_browser_contract'] ?? false )
		|| ( 'materializer' === $contract && true === ( $debug['include_raw_browser_materializer_contract'] ?? false ) )
		|| ( 'task' === $contract && true === ( $debug['include_raw_browser_task_contract'] ?? false ) );
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
private static function prepare_browser_task_contract( array $input ): array|WP_Error {
	$input['include_raw_browser_session'] = true;
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

	$has_success = array_key_exists( 'success', $provider_result );
	$has_status  = array_key_exists( 'status', $provider_result );
	$status      = self::safe_key( (string) ( $provider_result['status'] ?? ( $has_success && false === $provider_result['success'] ? 'failed' : 'completed' ) ) );
	$success     = $has_success ? true === $provider_result['success'] : in_array( $status, array( 'accepted', 'completed' ), true );
	if ( ! $has_status && ! $has_success && isset( $provider_result['error'] ) ) {
		$status  = 'failed';
		$success = false;
	}
	if ( ! in_array( $status, array( 'accepted', 'completed', 'failed', 'unavailable' ), true ) ) {
		$status = $success ? 'completed' : 'failed';
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

/** @param array<string,mixed> $session Browser session contract. @param array<string,mixed> $input Ability input. @return array<string,mixed> */
private static function browser_session_response_for_input( array $session, array $input ): array {
	$product_dto = WP_Codebox_Browser_Task_Builder::product_browser_session_dto( $session );
	if ( self::include_raw_browser_session_contract( $input ) ) {
		$session['product'] = $product_dto;
		return $session;
	}

	return $product_dto;
}

/** @param array<string,mixed> $input Ability input. */
private static function include_raw_browser_session_contract( array $input ): bool {
	if ( true === ( $input['include_raw_browser_session'] ?? false ) || true === ( $input['include_internal_browser_session'] ?? false ) ) {
		return true;
	}

	$debug = is_array( $input['debug'] ?? null ) ? $input['debug'] : array();
	return true === ( $debug['include_raw_browser_session'] ?? false );
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
