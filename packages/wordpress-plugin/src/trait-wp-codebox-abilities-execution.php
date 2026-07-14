<?php
/**
 * WP_Codebox_Abilities_Execution implementation.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

if ( ! class_exists( 'WP_Codebox_Browser_Contained_Site_Service' ) ) {
	require_once __DIR__ . '/class-wp-codebox-browser-contained-site-service.php';
}
if ( ! class_exists( 'WP_Codebox_Browser_Task_Contract_Service' ) ) {
	require_once __DIR__ . '/class-wp-codebox-browser-task-contract-service.php';
}

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
	return ( new WP_Codebox_Runtime_Package_Service() )->run( $input );
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

	return ( new WP_Codebox_Fuzz_Suite_Runner() )->run( $input );
}

/** @param array<string,mixed> $suite Optional suite input. @return array<string,mixed> */
private static function fuzz_suite_runner_capabilities_contract( array $suite = array() ): array {
	return WP_Codebox_Fuzz_Suite_Runner::fuzz_suite_runner_capabilities_contract( $suite );
}

/** @param array<string,mixed> $suite Optional suite input. @return array<string,mixed> */
private static function fuzz_suite_runtime_backed_runner_capabilities_contract( array $suite = array() ): array {
	return WP_Codebox_Fuzz_Suite_Runner::fuzz_suite_runtime_backed_runner_capabilities_contract( $suite );
}

/** @return array<string,array<string,mixed>> */
private static function fuzz_suite_supported_runner_capabilities(): array {
	return WP_Codebox_Fuzz_Suite_Runner::fuzz_suite_supported_runner_capabilities();
}

/** @return array<string,mixed> */
private static function fuzz_suite_runtime_backed_execution_contract(): array {
	return WP_Codebox_Fuzz_Suite_Runner::fuzz_suite_runtime_backed_execution_contract();
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
	$preview_only = true === ( $input['preview_only'] ?? false );
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

	$inheritance_payload = array( 'inheritance' => array( 'connectors' => array(), 'settings' => array() ) );
	$dependency_plan     = null;
	if ( ! $preview_only ) {
		$inheritance_payload = self::browser_inheritance_resolution_payload( $input );
		if ( is_wp_error( $inheritance_payload ) ) {
			return $inheritance_payload;
		}
		$input = self::browser_input_with_inheritance( $input, $inheritance_payload['inheritance'] );
		if ( is_wp_error( $input ) ) {
			return $input;
		}
		$dependency_plan = self::browser_runtime_dependency_plan( $input, $inheritance_payload['inheritance'] );
	}
	$browser_runner  = is_array( $input['browser_runner'] ?? null ) ? $input['browser_runner'] : array();
	$browser_plugins = self::browser_plugins( $input );
	if ( is_wp_error( $browser_plugins ) ) {
		return $browser_plugins;
	}
	$runtime_input = $input;
	if ( $preview_only ) {
		unset( $runtime_input['browser_runner'], $runtime_input['provider_plugin_paths'], $runtime_input['inherit'], $runtime_input['secret_env'], $runtime_input['runtime_requirements'] );
	}
	$runtime = self::browser_runtime_dependencies( $runtime_input, $browser_plugins, $dependency_plan );
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
	$blueprint      = self::browser_blueprint_with_post_runtime( $blueprint, is_array( $input['post_runtime_blueprint'] ?? null ) ? $input['post_runtime_blueprint'] : array() );
	$prepared_runtime = self::browser_prepared_runtime_with_blueprints( is_array( $runtime['prepared_runtime'] ?? null ) ? $runtime['prepared_runtime'] : array(), $blueprint, $playground );
	$runtime['prepared_runtime'] = $prepared_runtime;
	$contained_site  = self::browser_contained_site_envelope( $input, $session_id, $playground, $runtime, $prepared_runtime, 'ready' );
	$artifacts       = self::browser_artifact_files( $input );
	if ( is_wp_error( $artifacts ) ) {
		return $artifacts;
	}
	$ready_to_code = self::browser_ready_to_code_signal( $runtime_input, $runtime );
	if ( false === ( $ready_to_code['emitted'] ?? false ) ) {
		$blocked_session = self::blocked_browser_playground_session( $session_id, $input, $task_input, $ready_to_code, $browser_plugins, $runtime, $artifacts, $playground, $blueprint, $site_blueprint_artifact );
		return self::browser_session_response_for_input( $blocked_session, $input );
	}

	$task_payload = array();
	$recipe       = array();
	$materialization = array();
	$recipe_blueprint = self::browser_playground_blueprint( self::browser_selected_prepared_runtime_blueprint( $prepared_runtime, $blueprint ), $playground );
	if ( ! $preview_only ) {
		$task_payload = self::browser_task_payload( $input, $task_input, $session_id, $artifacts, $inheritance_payload['inheritance'], $dependency_plan );
		$recipe = self::browser_agent_recipe( $task_input, $session_id, $browser_runner, $blueprint, $playground, $task_payload );
		if ( is_wp_error( $recipe ) ) {
			return $recipe;
		}
		$recipe_blueprint = is_array( $recipe['runtime']['blueprint'] ?? null ) ? $recipe['runtime']['blueprint'] : $blueprint;
		$materialization = self::browser_materialization_contract( $recipe );
	}
	if ( is_array( $runtime['prepared_runtime'] ?? null ) ) {
		self::browser_prepared_runtime_cache_store( $runtime['prepared_runtime'], $recipe_blueprint );
	}
	$blueprint = $recipe_blueprint;

	$session = array(
		'success'          => true,
		'schema'           => 'wp-codebox/browser-playground-session/v1',
		'preview_only'     => $preview_only,
		'execution'        => 'browser-playground',
		'execution_scope'  => 'disposable-playground',
		'permission_model' => 'runtime-principal',
		'session'          => self::browser_session_envelope( $session_id, 'ready', $input ),
		'task'             => (string) $task_input['goal'],
		'task_input' => $task_input,
		'task_payload' => $preview_only ? array() : $task_payload,
		'agent'      => $preview_only ? '' : (string) ( $input['agent'] ?? 'wp-codebox-sandbox' ),
		'provider'   => $preview_only ? '' : self::browser_provider( $input, $inheritance_payload['inheritance'] ),
		'model'      => $preview_only ? '' : self::browser_model( $input, $inheritance_payload['inheritance'] ),
		'inheritance' => $preview_only ? array() : $inheritance_payload['inheritance'],
		'plugins'    => $browser_plugins,
		'runtime'    => $runtime,
		'contained_site' => $contained_site,
		'site_blueprint_artifact' => $site_blueprint_artifact,
		'materialization' => $preview_only ? array() : $materialization,
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
		'recipe'     => $preview_only ? array() : $recipe,
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
	if ( $preview_only ) {
		unset( $session['task_payload'], $session['agent'], $session['provider'], $session['model'], $session['inheritance'], $session['materialization'], $session['recipe'] );
	}

	return self::browser_session_response_for_input( $session, $input );
}

/** @return WP_Codebox_Browser_Contained_Site_Service */
private static function browser_contained_site_service(): WP_Codebox_Browser_Contained_Site_Service {
	return new WP_Codebox_Browser_Contained_Site_Service(
		static function ( string $name, array $args ): mixed {
			return self::{$name}( ...$args );
		}
	);
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function get_browser_contained_site_status( array $input ): array|WP_Error {
	return self::browser_contained_site_service()->get_browser_contained_site_status($input);
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function preview_reuse_decision( array $input ): array|WP_Error {
	return self::browser_contained_site_service()->preview_reuse_decision($input);
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function open_browser_contained_site( array $input ): array|WP_Error {
	return self::browser_contained_site_service()->open_browser_contained_site($input);
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function open_or_create_browser_contained_site( array $input ): array|WP_Error {
	return self::browser_contained_site_service()->open_or_create_browser_contained_site($input);
}

/** @param array<string,mixed> $input Ability input. @return string|WP_Error */
private static function browser_contained_site_start_mode( array $input ): string|WP_Error {
	return self::browser_contained_site_service()->browser_contained_site_start_mode($input);
}

/** @param array<string,mixed> $input Ability input. @param array<string,mixed> $decision Reuse decision. @return array<string,mixed>|WP_Error */
private static function create_browser_contained_site_start_result( array $input, array $decision, string $mode ): array|WP_Error {
	return self::browser_contained_site_service()->create_browser_contained_site_start_result($input, $decision, $mode);
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function create_browser_contained_site_session( array $input ): array|WP_Error {
	return self::browser_contained_site_service()->create_browser_contained_site_session($input);
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function boot_browser_contained_site_session( array $input ): array|WP_Error {
	return self::browser_contained_site_service()->boot_browser_contained_site_session($input);
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function preview_boot_ref( array $input ): array|WP_Error {
	return self::browser_contained_site_service()->preview_boot_ref($input);
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function destroy_browser_contained_site_session( array $input ): array|WP_Error {
	return self::browser_contained_site_service()->destroy_browser_contained_site_session($input);
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

/** @return WP_Codebox_Browser_Task_Contract_Service */
private static function browser_task_contract_service(): WP_Codebox_Browser_Task_Contract_Service {
	return new WP_Codebox_Browser_Task_Contract_Service(
		static function ( string $name, array $args ): mixed {
			return self::{$name}( ...$args );
		}
	);
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function create_browser_materializer_contract( array $input ): array|WP_Error {
	return self::browser_task_contract_service()->create_browser_materializer_contract( $input );
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function create_browser_task_contract( array $input ): array|WP_Error {
	return self::browser_task_contract_service()->create_browser_task_contract( $input );
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
	return self::browser_contained_site_service()->blocked_browser_playground_session($session_id, $input, $task_input, $ready_to_code, $browser_plugins, $runtime, $artifacts, $playground, $blueprint, $site_blueprint_artifact);
}

/** @param array<string,mixed> $session Browser session contract. @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
private static function browser_session_response_for_input( array $session, array $input ): array|WP_Error {
	return self::browser_contained_site_service()->browser_session_response_for_input($session, $input);
}

/** @param array<string,mixed> $product_dto Product-safe session DTO. @param array<string,mixed> $session Raw browser session contract. @return array<string,mixed> */
private static function browser_session_evidence_store( array $product_dto, array $session ): array {
	return self::browser_contained_site_service()->browser_session_evidence_store($product_dto, $session);
}

/** @param array<string,mixed> $input Ability input. @param array<string,mixed> $session Raw browser session contract. @param array<string,mixed> $product_dto Product DTO. */
private static function include_raw_browser_session_contract( array $input, array $session, array $product_dto ): bool {
	return self::browser_contained_site_service()->include_raw_browser_session_contract($input, $session, $product_dto);
}

/** @return array<string,mixed> */
private static function browser_contained_site_envelope( array $input, string $session_id, array $playground, array $runtime, array $prepared_runtime, string $status ): array {
	return self::browser_contained_site_service()->browser_contained_site_envelope($input, $session_id, $playground, $runtime, $prepared_runtime, $status);
}

/** @return array{seed?:string,revision?:string} */
private static function browser_contained_site_artifact_meta( array $input ): array {
	return self::browser_contained_site_service()->browser_contained_site_artifact_meta($input);
}

/** @return array<string,mixed> */
private static function browser_contained_site_status_envelope( string $cache_key, string $input_hash, array $lookup ): array {
	return self::browser_contained_site_service()->browser_contained_site_status_envelope($cache_key, $input_hash, $lookup);
}

/** @return array<string,mixed> */
private static function browser_contained_site_lifecycle( string $status, array $resolution ): array {
	return self::browser_contained_site_service()->browser_contained_site_lifecycle($status, $resolution);
}

/** @return array<string,mixed> */
private static function browser_contained_site_digest_refs( array $input ): array {
	return self::browser_contained_site_service()->browser_contained_site_digest_refs($input);
}

/** @return array{algorithm:string,value:string}|array{} */
private static function browser_contained_site_digest_ref( mixed $value ): array {
	return self::browser_contained_site_service()->browser_contained_site_digest_ref($value);
}

/** @return string */
private static function browser_contained_site_status_from_lookup( array $lookup ): string {
	return self::browser_contained_site_service()->browser_contained_site_status_from_lookup($lookup);
}

/** @return array<string,mixed> */
private static function browser_contained_site_resolution( string $status, array $lookup ): array {
	return self::browser_contained_site_service()->browser_contained_site_resolution($status, $lookup);
}

/** @return array<string,mixed> */
private static function browser_contained_site_open_session( array $input, array $contained_site, array $status ): array {
	return self::browser_contained_site_service()->browser_contained_site_open_session($input, $contained_site, $status);
}

/** @return array<string,mixed> */
private static function browser_contained_site_public_input( array $contained_site ): array {
	return self::browser_contained_site_service()->browser_contained_site_public_input($contained_site);
}

/** @return array<string,mixed> */
private static function browser_contained_site_session_identity( string $session_id, string $preview_id, string $scope ): array {
	return self::browser_contained_site_service()->browser_contained_site_session_identity($session_id, $preview_id, $scope);
}

/** @param array<string,mixed> $result Source create/open result. @return array<string,mixed> */
private static function browser_contained_site_facade_session( array $result, string $action ): array {
	return self::browser_contained_site_service()->browser_contained_site_facade_session($result, $action);
}

/** @return array<string,mixed> */
private static function browser_contained_site_boot_descriptor( array $result, array $contained_site, array $preview_boot, array $preview_lease, array $blueprint_ref ): array {
	return self::browser_contained_site_service()->browser_contained_site_boot_descriptor($result, $contained_site, $preview_boot, $preview_lease, $blueprint_ref);
}

/** @return array<string,mixed> */
private static function browser_contained_site_startup_diagnostics( array $result, array $contained_site, array $preview_lease, array $boot_contract ): array {
	return self::browser_contained_site_service()->browser_contained_site_startup_diagnostics($result, $contained_site, $preview_lease, $boot_contract);
}

/** @return array<string,mixed> */
private static function validate_browser_contained_site_source( array $input, string $schema ): array {
	return self::browser_contained_site_service()->validate_browser_contained_site_source($input, $schema);
}

/** @return array<string,mixed> */
private static function browser_contained_site_contract_error( string $schema, string $code, string $message, array $expected, array $actual ): array {
	return self::browser_contained_site_service()->browser_contained_site_contract_error($schema, $code, $message, $expected, $actual);
}

/** @return array<string,mixed> */
private static function browser_contained_site_open_recovery( string $site_id, string $source_digest ): array {
	return self::browser_contained_site_service()->browser_contained_site_open_recovery($site_id, $source_digest);
}

private static function browser_contained_site_recovery_handle( string $site_id, string $source_digest ): string {
	return self::browser_contained_site_service()->browser_contained_site_recovery_handle($site_id, $source_digest);
}

private static function browser_contained_site_source_digest( array $input, array $playground, array $runtime, array $prepared_runtime ): string {
	return self::browser_contained_site_service()->browser_contained_site_source_digest($input, $playground, $runtime, $prepared_runtime);
}

private static function browser_contained_site_caller_id( array $input ): string {
	return self::browser_contained_site_service()->browser_contained_site_caller_id($input);
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
	return self::artifact_ability_service()->list_artifacts( $input );
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function get_artifact( array $input ): array|WP_Error {
	return self::artifact_ability_service()->get_artifact( $input );
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function inspect_artifact( array $input ): array|WP_Error {
	return self::artifact_ability_service()->inspect_artifact( $input );
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function discard_artifact( array $input ): array|WP_Error {
	return self::artifact_ability_service()->discard_artifact( $input );
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function normalize_browser_artifact_bundle( array $input ): array|WP_Error {
	return self::artifact_ability_service()->normalize_browser_artifact_bundle( $input );
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function persist_browser_artifact( array $input ): array|WP_Error {
	return self::artifact_ability_service()->persist_browser_artifact( $input );
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function import_artifact_bundle( array $input ): array|WP_Error {
	return self::artifact_ability_service()->import_artifact_bundle( $input );
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function reimport_artifact_bundle( array $input ): array|WP_Error {
	return self::artifact_ability_service()->reimport_artifact_bundle( $input );
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function review_artifact( array $input ): array|WP_Error {
	return self::artifact_ability_service()->review_artifact( $input );
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function apply_artifact_preflight( array $input ): array|WP_Error {
	return self::artifact_ability_service()->apply_artifact_preflight( $input );
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function apply_approved_artifact( array $input ): array|WP_Error {
	return self::artifact_ability_service()->apply_approved_artifact( $input );
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function stage_artifact_apply( array $input ): array|WP_Error {
	return self::artifact_ability_service()->stage_artifact_apply( $input );
}

private static function artifact_ability_service(): WP_Codebox_Artifact_Ability_Service {
	return new WP_Codebox_Artifact_Ability_Service();
}
}
