<?php
/**
 * Portable WP Codebox agent runtime invocation boundary.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_Agent_Runtime_Invoker {

	/** @param array<string,mixed> $input Runtime task input. @return array<string,mixed>|WP_Error */
	public function invoke_host_task( array $input ): array|WP_Error {
		return ( new WP_Codebox_Agent_Sandbox_Runner() )->run( $input );
	}

	/** @param array<string,mixed> $input Runtime task input. @return array<string,mixed>|WP_Error */
	public function invoke_host_batch( array $input ): array|WP_Error {
		return ( new WP_Codebox_Agent_Sandbox_Runner() )->run_batch( $input );
	}

	/** @param array<string,mixed> $input Runtime task input. @return array<string,mixed>|WP_Error */
	public function invoke_host_fanout( array $input ): array|WP_Error {
		return ( new WP_Codebox_Agent_Sandbox_Runner() )->run_fanout( $input );
	}

	/** @return string Browser-runtime PHP fragment defining the portable invoker functions. */
	public static function browser_runtime_php(): string {
		return <<<'PHP'
function wp_codebox_browser_runtime_user_id( array $payload ): int {
$user_id = (int) ( $payload['user_id'] ?? ( function_exists( 'get_current_user_id' ) ? get_current_user_id() : 0 ) );
return $user_id > 0 ? $user_id : 1;
}

function wp_codebox_browser_runtime_agent_principal( string $agent, string $session_id ): array {
return array(
	'acting_user_id' => 0,
	'effective_agent_id' => $agent,
	'auth_source' => 'runtime',
	'request_context' => 'runtime',
	'token_id' => null,
	'request_metadata' => array(
		'source' => 'wp-codebox',
		'mode' => 'browser-playground',
		'codebox_session_id' => $session_id,
	),
	'workspace_id' => 'wp-codebox',
	'client_id' => 'wp-codebox-browser-runner',
	'audience_id' => $session_id,
	'audience_claims' => array(
		'runtime_type' => 'wordpress-playground',
	),
	'owner_type' => 'runtime',
	'owner_key' => $session_id,
);
}

function wp_codebox_browser_runtime_prepare_input( array $payload, array $invocation, string $session_id, array $runtime_tool_declarations, array $ability_tools, array $allowed_tool_ids, array $sandbox_tool_ids ): array {
$agent = sanitize_key( (string) ( $payload['agent'] ?? 'wp-codebox-sandbox' ) );
$runtime_user_id = wp_codebox_browser_runtime_user_id( $payload );
if ( function_exists( 'wp_set_current_user' ) ) {
	wp_set_current_user( $runtime_user_id );
}

$base_input = array(
	'agent' => $agent,
	'message' => (string) ( $payload['message'] ?? ( $payload['task_input']['goal'] ?? '' ) ),
	'user_id' => $runtime_user_id,
	'provider' => (string) ( $payload['provider'] ?? ( is_array( $payload['task_input'] ?? null ) ? ( $payload['task_input']['provider'] ?? '' ) : '' ) ),
	'model' => (string) ( $payload['model'] ?? ( is_array( $payload['task_input'] ?? null ) ? ( $payload['task_input']['model'] ?? '' ) : '' ) ),
	'session_owner' => array(
		'type' => 'browser-playground',
		'key' => $session_id,
		'label' => 'WP Codebox Browser Playground',
	),
	'principal' => wp_codebox_browser_runtime_agent_principal( $agent, $session_id ),
	'client_context' => array(
		'source' => 'peer-agent',
		'client_name' => 'wp-codebox-browser-runner',
		'peer_agent_call' => true,
		'caller_session_id' => $session_id,
		'task_input' => $payload['task_input'] ?? array(),
		'runtime_tools' => $runtime_tool_declarations,
		'runtime_tool_callback' => 'wp_codebox_browser_runtime_tool_callback',
		'ability_tools' => $ability_tools,
	),
);
if ( ! empty( $allowed_tool_ids ) ) {
	$base_input['tool_policy'] = array(
		'mode' => 'allow',
		'tools' => $allowed_tool_ids,
	);
	$base_input['allow_only'] = $allowed_tool_ids;
	if ( ! empty( $sandbox_tool_ids ) ) {
		$base_input['completion_assertions'] = array(
			'required_tool_names' => $sandbox_tool_ids,
		);
	}
}

return array_replace_recursive( $base_input, is_array( $invocation['input'] ?? null ) ? $invocation['input'] : array() );
}

function wp_codebox_browser_runtime_import_agent_bundles( array $bundle_specs ): array {
if ( empty( $bundle_specs ) ) {
	return array();
}

if ( function_exists( 'wp_agent_import_runtime_bundles' ) ) {
	return wp_agent_import_runtime_bundles( $bundle_specs, array( 'owner_id' => get_current_user_id() ?: 1 ) );
}

$imports = array();
foreach ( $bundle_specs as $index => $spec ) {
	if ( ! is_array( $spec ) ) {
		$imports[] = array( 'success' => false, 'index' => $index, 'error' => array( 'code' => 'agent_bundle_spec_invalid', 'message' => 'Agent bundle spec must be an object.' ) );
		continue;
	}
	if ( ! isset( $spec['source'] ) && ! isset( $spec['bundle'] ) ) {
		$imports[] = array( 'success' => false, 'index' => $index, 'error' => array( 'code' => 'agent_bundle_source_missing', 'message' => 'Agent bundle spec requires source or bundle.' ) );
		continue;
	}

	$input = array( 'on_conflict' => (string) ( $spec['on_conflict'] ?? 'upgrade' ) );
	if ( isset( $spec['source'] ) && '' !== trim( (string) $spec['source'] ) ) {
		$input['source'] = trim( (string) $spec['source'] );
	}
	foreach ( array( 'slug', 'token_env' ) as $field ) {
		if ( isset( $spec[ $field ] ) && '' !== trim( (string) $spec[ $field ] ) ) {
			$input[ $field ] = trim( (string) $spec[ $field ] );
		}
	}
	if ( isset( $spec['bundle'] ) && is_array( $spec['bundle'] ) ) {
		$input['bundle'] = $spec['bundle'];
	}
	$input['owner_id'] = isset( $spec['owner_id'] ) && (int) $spec['owner_id'] > 0 ? (int) $spec['owner_id'] : ( get_current_user_id() ?: 1 );
	if ( isset( $spec['import_principal'] ) && is_array( $spec['import_principal'] ) ) {
		$input['import_principal'] = $spec['import_principal'];
	}
	$result = apply_filters( 'wp_agent_runtime_import_bundle', null, $spec, $input, $index );
	if ( null === $result ) {
		$result = new WP_Error( 'wp_codebox_agent_bundle_importer_unavailable', 'No browser runtime agent bundle importer handled this bundle spec.', array( 'index' => $index ) );
	}
	$imports[] = is_wp_error( $result )
		? array( 'success' => false, 'index' => $index, 'source' => isset( $input['source'] ) ? $input['source'] : 'inline', 'error' => array( 'code' => $result->get_error_code(), 'message' => $result->get_error_message(), 'data' => $result->get_error_data() ) )
		: array_merge( array( 'index' => $index, 'source' => isset( $input['source'] ) ? $input['source'] : 'inline' ), is_array( $result ) ? $result : array( 'result' => $result ) );
}

return $imports;
}

function wp_codebox_browser_runtime_preflight( array $payload, array $invocation, array $input, array $agent_bundle_imports, bool $is_playground, string $playground_root ): array {
$invocation_type = (string) ( $invocation['type'] ?? 'ability' );
$provider_ready = apply_filters( 'wp_codebox_browser_runtime_provider_ready', true, $payload, $input, $invocation );
$preflight = array(
	'schema' => 'wp-codebox/agent-runtime-preflight/v1',
	'runtime' => 'browser-playground',
	'playground' => $is_playground,
	'provider_ready' => (bool) $provider_ready,
	'has_ai_client' => class_exists( '\\WordPress\\AiClient\\AiClient' ),
	'invocation_type' => $invocation_type,
);
if ( ! $is_playground ) {
	$preflight['error'] = new WP_Error(
		'wp_codebox_browser_runner_not_playground',
		'The browser agent runner runtime-principal authorization is only allowed inside the disposable WordPress Playground sandbox.',
		array(
			'execution_scope' => 'disposable-playground',
			'permission_model' => 'runtime-principal',
			'detected_root' => $playground_root,
			'detected_php_os_family' => PHP_OS_FAMILY,
		)
	);
}
$failed_imports = array_filter( $agent_bundle_imports, static fn( $import ) => is_array( $import ) && empty( $import['success'] ) );
if ( empty( $preflight['error'] ) && ! empty( $failed_imports ) ) {
	$preflight['error'] = new WP_Error( 'wp_codebox_agent_bundle_import_failed', 'One or more runtime agent bundles failed to import before sandbox invocation.', array( 'agent_bundle_imports' => array_values( $failed_imports ) ) );
}
if ( empty( $preflight['error'] ) && ! $provider_ready ) {
	$preflight['error'] = new WP_Error( 'wp_codebox_browser_provider_unavailable', 'The browser runtime provider is not ready for sandbox invocation.', array( 'provider' => (string) ( $input['provider'] ?? '' ), 'model' => (string) ( $input['model'] ?? '' ) ) );
}
if ( empty( $preflight['error'] ) && 'task' === $invocation_type ) {
	$hook = (string) ( $invocation['hook'] ?? $invocation['name'] ?? '' );
	$preflight['hook'] = $hook;
	if ( '' === $hook || ! has_filter( $hook ) ) {
		$preflight['error'] = new WP_Error( 'wp_codebox_browser_task_unavailable', 'The requested sandbox task hook is not registered inside the Playground site.', array( 'hook' => $hook ) );
	}
}
if ( empty( $preflight['error'] ) && 'task' !== $invocation_type ) {
	$ability_name = (string) ( $invocation['name'] ?? 'agents/chat' );
	$preflight['ability'] = $ability_name;
	$ability = function_exists( 'wp_get_ability' ) ? wp_get_ability( $ability_name ) : null;
	if ( ! $ability instanceof WP_Ability ) {
		$preflight['error'] = new WP_Error( 'wp_codebox_browser_ability_unavailable', 'The requested ability is not available inside the Playground site.', array( 'ability' => $ability_name ) );
	}
}

return $preflight;
}

function wp_codebox_browser_runtime_principal_permission( bool $allowed, $principal, array $permission_input, string $session_id ): bool {
if ( ! $principal instanceof AgentsAPI\AI\WP_Agent_Execution_Principal ) {
	return $allowed;
}
if ( 'runtime' !== $principal->auth_source || 'runtime' !== $principal->request_context ) {
	return $allowed;
}
if ( 'wp-codebox-browser-runner' !== $principal->client_id || 'wp-codebox' !== $principal->workspace_id || 'runtime' !== $principal->owner_type ) {
	return $allowed;
}
if ( $session_id !== $principal->audience_id || $session_id !== $principal->owner_key ) {
	return $allowed;
}
if ( 'wordpress-playground' !== (string) ( $principal->audience_claims['runtime_type'] ?? '' ) ) {
	return $allowed;
}
return 'wp-codebox' === (string) ( $permission_input['principal']['workspace_id'] ?? '' ) && 'wp-codebox-browser-runner' === (string) ( $permission_input['principal']['client_id'] ?? '' );
}

function wp_codebox_browser_runtime_invoke_agent_task( array $payload, array $invocation, array $input, string $session_id, bool $is_playground, string $playground_root ): array {
$agent_bundle_imports = wp_codebox_browser_runtime_import_agent_bundles( is_array( $payload['agent_bundles'] ?? null ) ? $payload['agent_bundles'] : array() );
$preflight = wp_codebox_browser_runtime_preflight( $payload, $invocation, $input, $agent_bundle_imports, $is_playground, $playground_root );
$response = $preflight['error'] ?? null;
$permission_filter = static function ( bool $allowed, $principal, array $permission_input ) use ( $session_id ): bool {
	return wp_codebox_browser_runtime_principal_permission( $allowed, $principal, $permission_input, $session_id );
};
if ( null === $response ) {
	add_filter( 'agents_chat_runtime_principal_permission', $permission_filter, 999, 3 );
	try {
		if ( 'task' === (string) ( $invocation['type'] ?? 'ability' ) ) {
			$response = apply_filters( (string) ( $invocation['hook'] ?? $invocation['name'] ?? '' ), null, $input, $payload );
		} else {
			$ability = wp_get_ability( (string) ( $invocation['name'] ?? 'agents/chat' ) );
			$response = $ability->execute( $input );
		}
	} catch ( Throwable $exception ) {
		$response = $exception;
	} finally {
		if ( function_exists( 'remove_filter' ) ) {
			remove_filter( 'agents_chat_runtime_principal_permission', $permission_filter, 999 );
		}
	}
}

unset( $preflight['error'] );
return array(
	'response' => $response,
	'agent_bundle_imports' => $agent_bundle_imports,
	'preflight' => $preflight,
);
}

PHP;
	}
}
