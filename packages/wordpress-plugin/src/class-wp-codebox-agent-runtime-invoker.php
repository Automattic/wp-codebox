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

	public function is_agents_api_ready(): bool {
		return class_exists( 'WP_Codebox_Agents_API_Adapter' ) && $this->is_ability_available( WP_Codebox_Agents_API_Adapter::default_chat_ability() );
	}

	public function is_ability_available( string $name ): bool {
		return class_exists( 'WP_Codebox_Agents_API_Adapter' ) && ( new WP_Codebox_Agents_API_Adapter() )->is_available( $name );
	}

	/** @param array{url:string,method:string,headers:array<string,string>,body:string} $prepared Prepared request. @return array{url:string,method:string,headers:array<string,string>,body:string}|WP_Error */
	public function authenticate_provider_request( string $provider, array $prepared ): array|WP_Error {
		if ( ! class_exists( '\WordPress\AiClient\AiClient' ) || ! class_exists( '\WordPress\AiClient\Providers\Http\DTO\Request' ) || ! class_exists( '\WordPress\AiClient\Providers\Http\Enums\HttpMethodEnum' ) ) {
			return new WP_Error( 'wp_codebox_browser_provider_bridge_php_ai_client_unavailable', 'PHP AI Client request authentication is unavailable.', array( 'status' => 500, 'provider' => $provider ) );
		}

		try {
			$registry       = \WordPress\AiClient\AiClient::defaultRegistry();
			$authentication = method_exists( $registry, 'getProviderRequestAuthentication' ) ? $registry->getProviderRequestAuthentication( $provider ) : null;
			$method_enum    = \WordPress\AiClient\Providers\Http\Enums\HttpMethodEnum::tryFrom( $prepared['method'] );
			if ( null === $authentication || null === $method_enum ) {
				return new WP_Error( 'wp_codebox_browser_provider_bridge_php_ai_client_authentication_missing', 'PHP AI Client request authentication is not registered for this provider.', array( 'status' => 403, 'provider' => $provider ) );
			}

			$auth_request = new \WordPress\AiClient\Providers\Http\DTO\Request( $method_enum, $prepared['url'], $prepared['headers'], $prepared['body'] );
			$auth_request = $authentication->authenticateRequest( $auth_request );

			return array(
				'url'     => $auth_request->getUri(),
				'method'  => $auth_request->getMethod()->value,
				'headers' => self::flat_headers( $auth_request->getHeaders() ),
				'body'    => (string) $auth_request->getBody(),
			);
		} catch ( Throwable $throwable ) {
			return new WP_Error( 'wp_codebox_browser_provider_bridge_authentication_failed', $throwable->getMessage(), array( 'status' => 500, 'provider' => $provider, 'type' => get_class( $throwable ) ) );
		}
	}

	/** @param array<string,array<int,string>|string> $headers Header lists. @return array<string,string> */
	private static function flat_headers( array $headers ): array {
		$flat = array();
		foreach ( $headers as $name => $values ) {
			$flat[ (string) $name ] = is_array( $values ) ? implode( ', ', array_map( 'strval', $values ) ) : (string) $values;
		}

		return $flat;
	}

	/** Builds the generated PHP provider transport registration fragment. */
	public static function browser_provider_proxy_php(): string {
		return '
function wp_codebox_browser_install_provider_proxy( array $payload ): array {
$diagnostics = array( \'schema\' => \'wp-codebox/browser-provider-proxy-diagnostics/v1\', \'installed\' => false );
if ( ! function_exists( \'post_message_to_js\' ) || ! class_exists( \'\\WordPress\\AiClient\\AiClient\' ) || ! interface_exists( \'\\WordPress\\AiClient\\Providers\\Http\\Contracts\\HttpTransporterInterface\' ) || ! interface_exists( \'\\WordPress\\AiClient\\Providers\\Http\\Contracts\\RequestAuthenticationInterface\' ) ) {
	$diagnostics[\'early_return\'] = \'missing_browser_proxy_dependencies\';
	$diagnostics[\'has_post_message_to_js\'] = function_exists( \'post_message_to_js\' );
	$diagnostics[\'has_ai_client\'] = class_exists( \'\\WordPress\\AiClient\\AiClient\' );
	$diagnostics[\'has_http_transporter_interface\'] = interface_exists( \'\\WordPress\\AiClient\\Providers\\Http\\Contracts\\HttpTransporterInterface\' );
	$diagnostics[\'has_request_authentication_interface\'] = interface_exists( \'\\WordPress\\AiClient\\Providers\\Http\\Contracts\\RequestAuthenticationInterface\' );
	return $diagnostics;
}

$task_input = is_array( $payload[\'task_input\'] ?? null ) ? $payload[\'task_input\'] : array();
$provider = trim( (string) ( $payload[\'provider\'] ?? $task_input[\'provider\'] ?? \'\' ) );
$diagnostics[\'provider\'] = $provider;
if ( \'\' === $provider ) {
	$diagnostics[\'early_return\'] = \'provider_missing\';
	return $diagnostics;
}

$registry = \\WordPress\\AiClient\\AiClient::defaultRegistry();
if ( ! method_exists( $registry, \'setHttpTransporter\' ) || ! method_exists( $registry, \'setProviderRequestAuthentication\' ) ) {
	$diagnostics[\'early_return\'] = \'registry_methods_missing\';
	$diagnostics[\'has_set_http_transporter\'] = method_exists( $registry, \'setHttpTransporter\' );
	$diagnostics[\'has_set_provider_request_authentication\'] = method_exists( $registry, \'setProviderRequestAuthentication\' );
	return $diagnostics;
}

$provider_id = $provider;
if ( method_exists( $registry, \'getProviderId\' ) ) {
	try {
		$provider_id = (string) $registry->getProviderId( $provider );
	} catch ( Throwable $exception ) {
		$provider_id = $provider;
	}
}
$diagnostics[\'provider_id\'] = $provider_id;

$inherit = is_array( $payload[\'inherit\'] ?? null ) ? $payload[\'inherit\'] : ( is_array( $task_input[\'inherit\'] ?? null ) ? $task_input[\'inherit\'] : array() );
if ( empty( $inherit[\'connectors\'] ) && is_array( $payload[\'inheritance\'][\'connectors\'] ?? null ) ) {
	$inherit[\'connectors\'] = array_values( array_filter( array_map( static function ( $connector ): string {
		return is_array( $connector ) ? trim( (string) ( $connector[\'name\'] ?? \'\' ) ) : trim( (string) $connector );
	}, $payload[\'inheritance\'][\'connectors\'] ) ) );
}
if ( empty( $inherit[\'connectors\'] ) && is_array( $task_input[\'inheritance\'][\'connectors\'] ?? null ) ) {
	$inherit[\'connectors\'] = array_values( array_filter( array_map( static function ( $connector ): string {
		return is_array( $connector ) ? trim( (string) ( $connector[\'name\'] ?? \'\' ) ) : trim( (string) $connector );
	}, $task_input[\'inheritance\'][\'connectors\'] ) ) );
}
if ( empty( $inherit[\'connectors\'] ) ) {
	$inherit[\'connectors\'] = array( $provider );
}
$diagnostics[\'connector_count\'] = count( is_array( $inherit[\'connectors\'] ?? null ) ? $inherit[\'connectors\'] : array() );
$diagnostics[\'connector\'] = (string) ( $inherit[\'connectors\'][0] ?? \'\' );

$request_authentication = class_exists( \'\\WordPress\\AiClient\\Providers\\Http\\DTO\\ApiKeyRequestAuthentication\' )
	? new \\WordPress\\AiClient\\Providers\\Http\\DTO\\ApiKeyRequestAuthentication( \'wp-codebox-browser-provider-proxy\' )
	: new class implements \\WordPress\\AiClient\\Providers\\Http\\Contracts\\RequestAuthenticationInterface {
		public static function getJsonSchema(): array {
			return array( \'type\' => \'object\' );
		}

		public function authenticateRequest( \\WordPress\\AiClient\\Providers\\Http\\DTO\\Request $request ): \\WordPress\\AiClient\\Providers\\Http\\DTO\\Request {
			return $request;
		}
	};
$registry->setProviderRequestAuthentication( $provider_id, $request_authentication );
$diagnostics[\'request_authentication_class\'] = get_class( $request_authentication );
$diagnostics[\'request_authentication_bound\'] = true;

$registry->setHttpTransporter(
	new class( $payload, $inherit ) implements \\WordPress\\AiClient\\Providers\\Http\\Contracts\\HttpTransporterInterface {
		private array $payload;
		private array $inherit;

		public function __construct( array $payload, array $inherit ) {
			$this->payload = $payload;
			$this->inherit = $inherit;
		}

		public function send( \\WordPress\\AiClient\\Providers\\Http\\DTO\\Request $request, ?\\WordPress\\AiClient\\Providers\\Http\\DTO\\RequestOptions $options = null ): \\WordPress\\AiClient\\Providers\\Http\\DTO\\Response {
			unset( $options );
			$connector = trim( (string) ( $this->payload[\'connector\'] ?? $this->inherit[\'connectors\'][0] ?? \'\' ) );
			$message   = array(
				\'schema\'             => \'wp-codebox/browser-provider-proxy-request/v1\',
				\'id\'                 => \'provider-\' . bin2hex( random_bytes( 8 ) ),
				\'operation\'          => \'http.request\',
				\'provider\'           => (string) ( $this->payload[\'provider\'] ?? ( is_array( $this->payload[\'task_input\'] ?? null ) ? ( $this->payload[\'task_input\'][\'provider\'] ?? \'\' ) : \'\' ) ),
				\'model\'              => (string) ( $this->payload[\'model\'] ?? ( is_array( $this->payload[\'task_input\'] ?? null ) ? ( $this->payload[\'task_input\'][\'model\'] ?? \'\' ) : \'\' ) ),
				\'connector\'          => $connector,
				\'inherit\'            => $this->inherit,
				\'sandbox_session_id\' => (string) ( $this->payload[\'sandbox_session_id\'] ?? $this->payload[\'session_id\'] ?? \'\' ),
				\'caller_session_id\'  => (string) ( $this->payload[\'caller_session_id\'] ?? $this->payload[\'session_id\'] ?? \'\' ),
				\'job_id\'             => (string) ( $this->payload[\'job_id\'] ?? \'\' ),
				\'orchestrator\'       => is_array( $this->payload[\'orchestrator\'] ?? null ) ? $this->payload[\'orchestrator\'] : array(),
				\'authorization\'      => is_array( $this->payload[\'authorization\'] ?? null ) ? $this->payload[\'authorization\'] : array(),
				\'request\'            => array(
					\'method\'  => method_exists( $request->getMethod(), \'value\' ) ? $request->getMethod()->value : (string) $request->getMethod(),
					\'uri\'     => $request->getUri(),
					\'headers\' => $request->getHeaders(),
					\'body\'    => $request->getBody(),
					\'data\'    => $request->getData(),
				),
			);

			$response_json = post_message_to_js( wp_json_encode( $message, JSON_UNESCAPED_SLASHES ) );
			$response      = json_decode( is_string( $response_json ) ? $response_json : \'\', true );
			if ( ! is_array( $response ) || empty( $response[\'success\'] ) ) {
				$error = is_array( $response[\'error\'] ?? null ) ? $response[\'error\'] : array();
				throw new RuntimeException( (string) ( $error[\'message\'] ?? \'Browser provider proxy request failed.\' ) );
			}

			$response_payload = is_array( $response[\'response\'] ?? null ) ? $response[\'response\'] : array();
			$http = is_array( $response_payload[\'http\'] ?? null ) ? $response_payload[\'http\'] : ( is_array( $response[\'http\'] ?? null ) ? $response[\'http\'] : array() );
			$status = (int) ( $http[\'status\'] ?? 0 );
			if ( $status < 100 || $status > 599 ) {
				throw new RuntimeException( \'Browser provider proxy returned a malformed HTTP response.\' );
			}

			return new \\WordPress\\AiClient\\Providers\\Http\\DTO\\Response(
				$status,
				is_array( $http[\'headers\'] ?? null ) ? $http[\'headers\'] : array( \'Content-Type\' => \'application/json\' ),
				isset( $http[\'body\'] ) ? (string) $http[\'body\'] : \'\'
			);
		}
	}
);
$diagnostics[\'http_transporter_bound\'] = true;
$diagnostics[\'installed\'] = true;
return $diagnostics;
}
';
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

function wp_codebox_browser_runtime_agents_ability_names(): array {
$names = function_exists( 'apply_filters' ) ? apply_filters( 'wp_codebox_browser_runtime_ability_names', array() ) : array();
return is_array( $names ) ? $names : array();
}

function wp_codebox_browser_runtime_agents_ability_exists( string $ability_name ): bool {
return '' !== $ability_name && function_exists( 'wp_get_ability' ) && wp_get_ability( $ability_name ) instanceof WP_Ability;
}

function wp_codebox_browser_runtime_execute_agents_ability( string $ability_name, array $input ) {
if ( ! wp_codebox_browser_runtime_agents_ability_exists( $ability_name ) ) {
	return new WP_Error( 'wp_codebox_browser_ability_unavailable', 'The requested ability is not available inside the Playground site.', array( 'ability' => $ability_name ) );
}

$ability = wp_get_ability( $ability_name );
return $ability->execute( $input );
}

function wp_codebox_browser_runtime_prepare_input( array $payload, array $invocation, string $session_id, array $runtime_tool_declarations, array $ability_tools, array $allowed_tool_ids, array $sandbox_tool_ids ): array {
$agent = sanitize_key( (string) ( $payload['agent'] ?? 'wp-codebox-sandbox' ) );
$message = (string) ( $payload['message'] ?? ( $payload['task_input']['goal'] ?? '' ) );
$artifact_environment = function_exists( 'wp_codebox_browser_artifact_environment' ) ? wp_codebox_browser_artifact_environment( $payload ) : array();
$artifact_contract_schema = (string) ( $artifact_environment['contract']['schema'] ?? '' );
if ( '' !== $artifact_contract_schema && '' !== (string) ( $artifact_environment['entrypoint'] ?? '' ) ) {
	$artifact_entrypoint_path = rtrim( (string) ( $artifact_environment['base_path'] ?? '/wordpress/wp-content/uploads/wp-codebox/artifacts' ), '/' ) . '/' . ltrim( (string) $artifact_environment['entrypoint'], '/' );
	$message .= "\n\nRequired artifact output:\n";
	$message .= "- Write the final browser-runnable artifact entrypoint to {$artifact_entrypoint_path}.\n";
	$message .= "- Use the filesystem_write tool for this file before finishing.\n";
	$message .= "- The captured artifact schema is {$artifact_contract_schema}.";
}
$runtime_user_id = wp_codebox_browser_runtime_user_id( $payload );
if ( function_exists( 'wp_set_current_user' ) ) {
	wp_set_current_user( $runtime_user_id );
}

$base_input = array(
	'agent' => $agent,
	'message' => $message,
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

$import_runtime_bundles = (string) ( function_exists( 'apply_filters' ) ? apply_filters( 'wp_codebox_browser_runtime_bundle_import_function', '' ) : '' );
if ( '' !== $import_runtime_bundles && ! function_exists( $import_runtime_bundles ) ) {
	$importer_paths = function_exists( 'apply_filters' ) ? apply_filters( 'wp_codebox_browser_runtime_bundle_importer_paths', array() ) : array();
	foreach ( is_array( $importer_paths ) ? $importer_paths : array() as $agents_api_importer ) {
		if ( is_readable( $agents_api_importer ) ) {
			require_once $agents_api_importer;
			break;
		}
	}
}

if ( '' !== $import_runtime_bundles && function_exists( $import_runtime_bundles ) ) {
	return $import_runtime_bundles( $bundle_specs, array( 'owner_id' => get_current_user_id() ?: 1 ) );
}

$imports = array();
foreach ( $bundle_specs as $index => $spec ) {
	if ( ! is_array( $spec ) ) {
		$imports[] = array( 'success' => false, 'index' => $index, 'error' => array( 'code' => 'agent_bundle_spec_invalid', 'message' => 'Agent bundle spec must be an object.' ) );
		continue;
	}
	if ( ! isset( $spec['source'] ) && ! isset( $spec['bundle'] ) ) {
		$imports[] = array( 'success' => false, 'index' => $index, 'error' => array( 'code' => 'agent_bundle_source_missing', 'message' => 'Agent bundle spec requires source or bundle.', 'data' => array( 'spec_keys' => array_values( array_slice( array_map( 'strval', array_keys( $spec ) ), 0, 12 ) ), 'has_source' => isset( $spec['source'] ), 'has_bundle' => isset( $spec['bundle'] ), 'slug' => is_scalar( $spec['slug'] ?? null ) ? (string) $spec['slug'] : '' ) ) );
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
	$runtime_bundle_import_filter = (string) ( function_exists( 'apply_filters' ) ? apply_filters( 'wp_codebox_browser_runtime_bundle_import_filter', '' ) : '' );
	$result = '' !== $runtime_bundle_import_filter ? apply_filters( $runtime_bundle_import_filter, null, $spec, $input, $index ) : null;
	if ( null === $result ) {
		$result = new WP_Error( 'wp_codebox_agent_bundle_importer_unavailable', 'No browser runtime agent bundle importer handled this bundle spec.', array( 'index' => $index, 'diagnostics' => wp_codebox_browser_runtime_agent_bundle_importer_diagnostics() ) );
	}
	$imports[] = is_wp_error( $result )
		? array( 'success' => false, 'index' => $index, 'source' => isset( $input['source'] ) ? $input['source'] : 'inline', 'error' => array( 'code' => $result->get_error_code(), 'message' => $result->get_error_message(), 'data' => $result->get_error_data() ) )
		: array_merge( array( 'index' => $index, 'source' => isset( $input['source'] ) ? $input['source'] : 'inline' ), is_array( $result ) ? $result : array( 'result' => $result ) );
}

function wp_codebox_browser_runtime_agent_bundle_importer_diagnostics(): array {
global $wp_filter;
$callback_count = 0;
$runtime_bundle_import_filter = (string) ( function_exists( 'apply_filters' ) ? apply_filters( 'wp_codebox_browser_runtime_bundle_import_filter', '' ) : '' );
if ( isset( $wp_filter[ $runtime_bundle_import_filter ] ) && is_object( $wp_filter[ $runtime_bundle_import_filter ] ) && isset( $wp_filter[ $runtime_bundle_import_filter ]->callbacks ) && is_array( $wp_filter[ $runtime_bundle_import_filter ]->callbacks ) ) {
	foreach ( $wp_filter[ $runtime_bundle_import_filter ]->callbacks as $callbacks ) {
		$callback_count += is_array( $callbacks ) ? count( $callbacks ) : 0;
	}
}

$candidates = function_exists( 'apply_filters' ) ? apply_filters( 'wp_codebox_browser_runtime_bundle_importer_paths', array() ) : array();
$import_runtime_bundles = (string) ( function_exists( 'apply_filters' ) ? apply_filters( 'wp_codebox_browser_runtime_bundle_import_function', '' ) : '' );

return array(
	'wp_plugin_dir' => defined( 'WP_PLUGIN_DIR' ) ? (string) WP_PLUGIN_DIR : '',
	'browser_runtime_bundle_import_function' => $import_runtime_bundles,
	'browser_runtime_bundle_import_function_exists' => '' !== $import_runtime_bundles && function_exists( $import_runtime_bundles ),
	'wp_agent_runtime_import_bundle_callback_count' => $callback_count,
	'candidate_importers' => array_values( array_map( static fn( $path ) => array(
		'path' => (string) $path,
		'readable' => is_readable( $path ),
	), $candidates ) ),
);
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
	$ability_names = wp_codebox_browser_runtime_agents_ability_names();
	$ability_name = (string) ( $invocation['name'] ?? $ability_names['chat'] ?? '' );
	$preflight['ability'] = $ability_name;
	if ( ! wp_codebox_browser_runtime_agents_ability_exists( $ability_name ) ) {
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
	$permission_filter_hook = (string) ( function_exists( 'apply_filters' ) ? apply_filters( 'wp_codebox_browser_runtime_principal_permission_filter', '' ) : '' );
	if ( '' !== $permission_filter_hook ) {
		add_filter( $permission_filter_hook, $permission_filter, 999, 3 );
	}
	try {
		if ( 'task' === (string) ( $invocation['type'] ?? 'ability' ) ) {
			$response = apply_filters( (string) ( $invocation['hook'] ?? $invocation['name'] ?? '' ), null, $input, $payload );
		} else {
			$ability_names = wp_codebox_browser_runtime_agents_ability_names();
			$response = wp_codebox_browser_runtime_execute_agents_ability( (string) ( $invocation['name'] ?? $ability_names['chat'] ?? '' ), $input );
		}
	} catch ( Throwable $exception ) {
		$response = $exception;
	} finally {
		if ( function_exists( 'remove_filter' ) && '' !== $permission_filter_hook ) {
			remove_filter( $permission_filter_hook, $permission_filter, 999 );
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
