<?php
/**
 * Browser runner generated PHP templates.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

/** String-only builders for generated browser runner PHP fragments. */
final class WP_Codebox_Browser_Runner_Template {
	/**
	 * Builds the generated PHP bootstrap fragment for the browser runner.
	 *
	 * @param string                  $task_path   Absolute Playground path for the staged task payload.
	 * @param string                  $result_path Absolute Playground path for runner result output.
	 * @param array<string,mixed>     $payload     Default runner payload.
	 * @param array<string,mixed>     $invocation  Normalized runner invocation.
	 * @param array<int,array<string,mixed>> $captures Normalized capture paths.
	 */
	public static function bootstrap_fragment( string $task_path, string $result_path, array $payload, array $invocation, array $captures ): string {
		return '<?php
$_GET[\'rest_route\'] = \'/wp-codebox/browser-runner\';
$task_path = ' . var_export( $task_path, true ) . ';
$result_path = ' . var_export( $result_path, true ) . ';
$event_path = "/tmp/wp-codebox-agent-events.jsonl";
$payload = ' . var_export( $payload, true ) . ';
$invocation = ' . var_export( $invocation, true ) . ';
$capture_paths = ' . var_export( $captures, true ) . ';
$started_at = gmdate( \'c\' );
$started_monotonic = microtime( true );

if ( is_readable( $task_path ) ) {
	$raw_payload = json_decode( (string) file_get_contents( $task_path ), true );
	if ( is_array( $raw_payload ) ) {
		$payload = array_replace_recursive( $payload, $raw_payload );
	}
}

$wp_codebox_component_manifest = is_array( $payload[\'component_manifest\'] ?? null ) ? $payload[\'component_manifest\'] : array();
if ( ! empty( $wp_codebox_component_manifest ) ) {
	$GLOBALS[\'wp_codebox_component_manifest\'] = $wp_codebox_component_manifest;
	if ( ! defined( \'WP_CODEBOX_COMPONENT_MANIFEST_JSON\' ) ) {
		define( \'WP_CODEBOX_COMPONENT_MANIFEST_JSON\', json_encode( $wp_codebox_component_manifest, JSON_UNESCAPED_SLASHES ) );
	}
}

require_once \'/wordpress/wp-load.php\';

if ( function_exists( \'get_current_user_id\' ) && function_exists( \'wp_set_current_user\' ) && get_current_user_id() <= 0 ) {
	wp_set_current_user( 1 );
}
';
	}

	/** Builds the generated PHP runtime event sink fragment. */
	public static function runtime_event_sink_fragment(): string {
		return '
function wp_codebox_browser_event_scalar( $value, string $key = "" ) {
if ( is_bool( $value ) || is_int( $value ) || is_float( $value ) || null === $value ) {
	return $value;
}

$text = is_scalar( $value ) ? (string) $value : "";
if ( wp_codebox_browser_redaction_key_should_redact( "browser_event", $key ) ) {
	return "[redacted]";
}
if ( preg_match( "/content|message|prompt|response|body|data|argument|output|input/i", $key ) ) {
	return array( "type" => "string", "bytes" => strlen( $text ), "sha256" => hash( "sha256", $text ) );
}
if ( strlen( $text ) > 160 ) {
	return array( "type" => "string", "bytes" => strlen( $text ), "sha256" => hash( "sha256", $text ), "preview" => substr( $text, 0, 160 ) );
}

return $text;
}

function wp_codebox_browser_redaction_key_should_redact( string $profile_name, string $key ): bool {
$profiles = array(
	"browser_event" => array(
		"exact_keys" => array( "authorization" ),
		"sensitive_key_tokens" => array( "secret", "token", "password", "credential", "private_key", "api_key", "cookie" ),
	),
);
$profile = $profiles[ $profile_name ] ?? null;
if ( ! is_array( $profile ) ) {
	return false;
}
$normalized_key = strtolower( $key );
if ( in_array( $normalized_key, $profile["exact_keys"], true ) ) {
	return true;
}
foreach ( $profile["sensitive_key_tokens"] as $token ) {
	if ( str_contains( $normalized_key, $token ) ) {
		return true;
	}
}
return false;
}

function wp_codebox_browser_sanitize_event_value( $value, string $key = "" ) {
if ( is_array( $value ) ) {
	$sanitized = array();
	$count = 0;
	foreach ( $value as $item_key => $item ) {
		if ( $count >= 20 ) {
			$sanitized["truncated_items"] = count( $value ) - $count;
			break;
		}
		$sanitized[ is_int( $item_key ) ? $item_key : (string) $item_key ] = wp_codebox_browser_sanitize_event_value( $item, is_int( $item_key ) ? $key : (string) $item_key );
		++$count;
	}
	return $sanitized;
}

return wp_codebox_browser_event_scalar( $value, $key );
}

function wp_codebox_browser_sanitize_event_payload( array $payload ): array {
$preserve_keys = array(
	"turn" => true,
	"turn_index" => true,
	"turn_count" => true,
	"tool_name" => true,
	"tool_call_id" => true,
	"success" => true,
	"finish_reason" => true,
	"budget_exhausted" => true,
	"status" => true,
	"code" => true,
	"error_code" => true,
	"reason" => true,
	"provider" => true,
	"model" => true,
	"duration_ms" => true,
	"elapsed_ms" => true,
	"remaining_budget" => true,
	"budget" => true,
	"max_turns" => true,
	"completed" => true,
	"stopped" => true,
);
$preserve_containers = array( "metadata" => true, "finish" => true, "budget" => true, "usage" => true );
$sanitized = array();
foreach ( $payload as $key => $value ) {
	$key = (string) $key;
	if ( isset( $preserve_keys[ $key ] ) || isset( $preserve_containers[ $key ] ) || str_contains( $key, "status" ) || str_contains( $key, "budget" ) || str_contains( $key, "finish" ) ) {
		$sanitized[ $key ] = wp_codebox_browser_sanitize_event_value( $value, $key );
	}
}
return $sanitized;
}

if ( ! class_exists( "WP_Codebox_Browser_Event_File_Sink" ) ) {
class WP_Codebox_Browser_Event_File_Sink {
	private string $path;

	public function __construct( string $path ) {
		$this->path = $path;
	}

	public function emit( string $event, array $payload = array() ): void {
		$record = array(
			"schema" => "wp-codebox/browser-agent-event/v1",
			"event" => sanitize_key( $event ),
			"payload" => wp_codebox_browser_sanitize_event_payload( $payload ),
			"emitted_at" => gmdate( "c" ),
		);
		$json = wp_json_encode( $record, JSON_UNESCAPED_SLASHES );
		if ( is_string( $json ) ) {
			file_put_contents( $this->path, $json . "\n", FILE_APPEND | LOCK_EX );
		}
	}
}
}

function wp_codebox_browser_runtime_event_sink( string $event_path, array $input, array $payload ) {
$sink = null;
if ( function_exists( "apply_filters" ) ) {
	$sink = apply_filters( "wp_codebox_browser_runtime_event_sink", $sink, $event_path, $input, $payload );
}

return is_object( $sink ) && method_exists( $sink, "emit" ) ? $sink : null;
}
';
	}

	/** Builds the generated PHP capture-file policy fragment. */
	public static function artifact_capture_policy_fragment( int $capture_max_bytes ): string {
		return '
function wp_codebox_browser_capture_file( array $capture ) {
$path = (string) ( $capture[\'path\'] ?? \'\' );
$record = array(
	\'schema\' => \'wp-codebox/browser-capture/v1\',
	\'path\' => $path,
	\'name\' => (string) ( $capture[\'name\'] ?? \'\' ),
	\'kind\' => (string) ( $capture[\'kind\'] ?? \'report\' ),
	\'mime_type\' => (string) ( $capture[\'mime_type\'] ?? \'\' ),
	\'exists\' => is_readable( $path ),
);
if ( ! $record[\'exists\'] ) {
	return $record;
}
$contents = file_get_contents( $path );
if ( ! is_string( $contents ) ) {
	$record[\'error\'] = array( \'code\' => \'wp_codebox_browser_capture_read_failed\', \'message\' => \'Could not read captured browser materialization file.\' );
	return $record;
}
$size = strlen( $contents );
$max_bytes = isset( $capture[\'max_bytes\'] ) ? (int) $capture[\'max_bytes\'] : ' . $capture_max_bytes . ';
$record[\'size\'] = $size;
$record[\'sha256\'] = hash( \'sha256\', $contents );
$record[\'truncated\'] = $size > $max_bytes;
if ( $max_bytes > 0 ) {
	$body = $record[\'truncated\'] ? substr( $contents, 0, $max_bytes ) : $contents;
	$json = json_decode( $body, true );
	if ( JSON_ERROR_NONE === json_last_error() ) {
		$record[\'json\'] = $json;
	} elseif ( preg_match( \'#^[\\x09\\x0A\\x0D\\x20-\\x7E]*$#\', $body ) ) {
		$record[\'content\'] = $body;
	} else {
		$record[\'content_base64\'] = base64_encode( $body );
		$record[\'encoding\'] = \'base64\';
	}
}
return array_filter( $record, static fn( $value ) => array() !== $value && \'\' !== $value );
}
';
	}

	/** Returns the generated PHP result envelope schema. */
	public static function result_envelope_schema(): string {
		return 'wp-codebox/browser-materialization/v1';
	}

	/** Builds the generated PHP provider transport registration fragment. */
	public static function provider_transport_registration_fragment(): string {
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
}
