<?php
/**
 * WP_Codebox_Abilities_Browser_Runner implementation.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

trait WP_Codebox_Abilities_Browser_Runner {
/** @param array<string,mixed> $task_input Normalized task input. @param array<string,mixed> $runner Runner overrides. @param array<string,mixed> $task_payload Browser task payload. @return array<string,mixed>|WP_Error */
	private static function browser_agent_recipe( array $task_input, string $session_id, array $runner, array $blueprint, array $playground, array $task_payload ): array|WP_Error {
		$task_path   = (string) ( $runner['task_path'] ?? '/tmp/wp-codebox-agent-task.json' );
		$result_path = (string) ( $runner['result_path'] ?? '/tmp/wp-codebox-agent-result.json' );
		$event_path  = '/tmp/wp-codebox-agent-events.jsonl';
		$invocation  = self::browser_runner_invocation( $runner );
		if ( is_wp_error( $invocation ) ) {
			return $invocation;
		}
	$captures = self::browser_runner_capture_paths( $runner );
		if ( is_wp_error( $captures ) ) {
			return $captures;
		}
		$captured_paths = array_map( static fn( array $capture ): string => (string) ( $capture['path'] ?? '' ), $captures );
		if ( ! in_array( $event_path, $captured_paths, true ) ) {
			$captures[] = array(
				'path'      => $event_path,
				'name'      => 'agent-events',
				'kind'      => 'events',
				'mime_type' => 'application/x-ndjson',
				'max_bytes' => self::BROWSER_CAPTURE_MAX_BYTES,
			);
		}

		foreach ( array( 'task_path' => $task_path, 'result_path' => $result_path ) as $field => $path ) {
			if ( '' === $path || str_contains( $path, '..' ) || ! str_starts_with( $path, '/' ) || ! preg_match( '#^[A-Za-z0-9_./-]+$#', $path ) ) {
			return new WP_Error( 'wp_codebox_browser_runner_path_invalid', $field . ' must be a safe absolute Playground path.', array( 'status' => 400 ) );
		}
	}

	return array(
		'schema'   => 'wp-codebox/workspace-recipe/v1',
		'runtime'  => array(
			'backend'   => 'wordpress-playground',
			'name'      => 'browser-playground',
			'wp'        => (string) ( $playground['wp'] ?? 'latest' ),
			'blueprint' => self::browser_playground_blueprint( $blueprint, $playground ),
		),
		'inputs'   => array(
			'stagedFiles' => array(
				array(
					'source' => 'task-payload',
					'target' => $task_path,
				),
			),
			'agent_bundles' => is_array( $task_payload['agent_bundles'] ?? null ) ? $task_payload['agent_bundles'] : array(),
		),
		'workflow' => array(
			'steps' => array(
				array(
					'command' => 'wordpress.run-php',
					'args'    => array(
						'code=' . self::browser_agent_runner_php( $task_input, $session_id, $task_path, $result_path, $invocation, $captures ),
					),
				),
			),
		),
		'artifacts' => array(
			'directory' => self::browser_artifact_base_path( $playground ),
		),
		'browser'  => array(
			'execution'  => 'php-wasm',
			'task_path'  => $task_path,
			'result_path' => $result_path,
			'task_payload' => $task_payload,
			'invocation' => self::browser_runner_invocation_metadata( $invocation ),
			'captures'   => $captures,
		),
	);
}

/** @param array<string,mixed> $recipe Browser recipe. @return array<string,mixed> */
private static function browser_materialization_contract( array $recipe ): array {
	$browser = is_array( $recipe['browser'] ?? null ) ? $recipe['browser'] : array();
	return array(
		'schema'        => 'wp-codebox/browser-materialization/v1',
		'status'        => 'pending',
		'execution'     => (string) ( $browser['execution'] ?? 'php-wasm' ),
		'result_path'   => (string) ( $browser['result_path'] ?? '' ),
		'invocation'    => is_array( $browser['invocation'] ?? null ) ? $browser['invocation'] : array(),
		'captures'      => is_array( $browser['captures'] ?? null ) ? $browser['captures'] : array(),
		'diagnostics'   => array(
			'capture_count' => count( is_array( $browser['captures'] ?? null ) ? $browser['captures'] : array() ),
		),
		'errors'        => array(),
		'provenance'    => array(
			'generated_by' => 'wp-codebox/browser-runner',
			'task_path'    => (string) ( $browser['task_path'] ?? '' ),
			'result_path'  => (string) ( $browser['result_path'] ?? '' ),
		),
		'error_schema'  => 'wp-codebox/browser-materialization-error/v1',
	);
}

/** @param array<string,mixed> $runner Runner overrides. @return array<string,mixed>|WP_Error */
private static function browser_runner_invocation( array $runner ): array|WP_Error {
	$invocation = is_array( $runner['invocation'] ?? null ) ? $runner['invocation'] : array();
	$type       = self::safe_key( (string) ( $invocation['type'] ?? 'ability' ) );
	if ( ! in_array( $type, array( 'ability', 'task' ), true ) ) {
		return new WP_Error( 'wp_codebox_browser_invocation_type_invalid', 'Browser runner invocation type must be ability or task.', array( 'status' => 400 ) );
	}

	$name = trim( (string) ( $invocation['name'] ?? '' ) );
	$hook = trim( (string) ( $invocation['hook'] ?? $name ) );
	if ( 'ability' === $type ) {
		$name = '' !== $name ? $name : 'agents/chat';
		if ( ! preg_match( '#^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$#', $name ) ) {
			return new WP_Error( 'wp_codebox_browser_invocation_name_invalid', 'Browser runner ability names must use namespace/name form.', array( 'status' => 400 ) );
		}
	} elseif ( '' === $hook || ! preg_match( '#^[A-Za-z0-9_.:-]+$#', $hook ) ) {
		return new WP_Error( 'wp_codebox_browser_invocation_hook_invalid', 'Browser runner task hooks must be safe WordPress hook names.', array( 'status' => 400 ) );
	}

	return array(
		'type'  => $type,
		'name'  => $name,
		'hook'  => $hook,
		'input' => is_array( $invocation['input'] ?? null ) ? $invocation['input'] : array(),
	);
}

/** @param array<string,mixed> $runner Runner overrides. @return array<int,array<string,mixed>>|WP_Error */
private static function browser_runner_capture_paths( array $runner ): array|WP_Error {
	$captures = is_array( $runner['capture_paths'] ?? null ) ? $runner['capture_paths'] : array();
	$normalized = array();
	foreach ( $captures as $index => $capture ) {
		if ( ! is_array( $capture ) ) {
			return new WP_Error( 'wp_codebox_browser_capture_invalid', 'Each browser runner capture path must be an object.', array( 'status' => 400, 'index' => $index ) );
		}
		$path = (string) ( $capture['path'] ?? '' );
		if ( '' === $path || str_contains( $path, '..' ) || ! str_starts_with( $path, '/' ) || ! preg_match( '#^[A-Za-z0-9_./-]+$#', $path ) ) {
			return new WP_Error( 'wp_codebox_browser_capture_path_invalid', 'Browser runner capture paths must be safe absolute Playground paths.', array( 'status' => 400, 'index' => $index ) );
		}
		$max_bytes = (int) ( $capture['max_bytes'] ?? self::BROWSER_CAPTURE_MAX_BYTES );
		if ( $max_bytes < 0 || $max_bytes > self::BROWSER_ARTIFACT_MAX_BYTES ) {
			return new WP_Error( 'wp_codebox_browser_capture_max_bytes_invalid', 'Browser runner capture max_bytes must be between 0 and the browser artifact byte limit.', array( 'status' => 400, 'index' => $index ) );
		}

		$normalized[] = array_filter(
			array(
				'path'      => $path,
				'name'      => sanitize_key( (string) ( $capture['name'] ?? '' ) ),
				'kind'      => sanitize_key( (string) ( $capture['kind'] ?? 'report' ) ),
				'mime_type' => sanitize_text_field( (string) ( $capture['mime_type'] ?? '' ) ),
				'max_bytes' => $max_bytes,
			),
			static fn( mixed $value ): bool => '' !== $value
		);
	}

	return $normalized;
}

/** @param array<string,mixed> $invocation Normalized invocation. @return array<string,string> */
private static function browser_runner_invocation_metadata( array $invocation ): array {
	return array_filter(
		array(
			'type' => (string) $invocation['type'],
			'name' => (string) $invocation['name'],
			'hook' => (string) $invocation['hook'],
		),
		static fn( string $value ): bool => '' !== $value
	);
}

private static function browser_agent_runner_php( array $task_input, string $session_id, string $task_path, string $result_path, array $invocation, array $captures ): string {
	$default_payload = array(
		'agent'      => 'wp-codebox-sandbox',
		'message'    => (string) $task_input['goal'],
		'session_id' => $session_id,
		'task_input' => $task_input,
		'artifacts'  => array(),
	);
	$default_invocation = $invocation;
	$default_captures   = $captures;

	return '<?php
$_GET[\'rest_route\'] = \'/wp-codebox/browser-runner\';
require_once \'/wordpress/wp-load.php\';

if ( function_exists( \'get_current_user_id\' ) && function_exists( \'wp_set_current_user\' ) && get_current_user_id() <= 0 ) {
	wp_set_current_user( 1 );
}

$task_path = ' . var_export( $task_path, true ) . ';
$result_path = ' . var_export( $result_path, true ) . ';
$event_path = "/tmp/wp-codebox-agent-events.jsonl";
$payload = ' . var_export( $default_payload, true ) . ';
$invocation = ' . var_export( $default_invocation, true ) . ';
$capture_paths = ' . var_export( $default_captures, true ) . ';
$started_at = gmdate( \'c\' );

function wp_codebox_browser_normalize_error( $error ) {
if ( is_wp_error( $error ) ) {
	return array(
		\'schema\' => \'wp-codebox/browser-materialization-error/v1\',
		\'code\' => $error->get_error_code(),
		\'message\' => $error->get_error_message(),
		\'data\' => $error->get_error_data(),
	);
}

return array(
	\'schema\' => \'wp-codebox/browser-materialization-error/v1\',
	\'code\' => \'wp_codebox_browser_runner_exception\',
	\'message\' => $error instanceof Throwable ? $error->getMessage() : (string) $error,
);
}

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
$max_bytes = isset( $capture[\'max_bytes\'] ) ? (int) $capture[\'max_bytes\'] : ' . self::BROWSER_CAPTURE_MAX_BYTES . ';
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
return array_filter( $record, static fn( $value ) => \'\' !== $value );
}

function wp_codebox_browser_event_scalar( $value, string $key = "" ) {
if ( is_bool( $value ) || is_int( $value ) || is_float( $value ) || null === $value ) {
	return $value;
}

$text = is_scalar( $value ) ? (string) $value : "";
if ( preg_match( "/authorization|secret|token|password|credential|private_key|api_key|cookie/i", $key ) ) {
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

if ( interface_exists( "\\DataMachine\\Engine\\AI\\LoopEventSinkInterface" ) && ! class_exists( "WP_Codebox_Browser_Event_File_Sink" ) ) {
class WP_Codebox_Browser_Event_File_Sink implements \\DataMachine\\Engine\\AI\\LoopEventSinkInterface {
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

function wp_codebox_browser_safe_artifact_path( $path, $root ) {
$path = str_replace( chr( 92 ), "/", (string) $path );
$path = ltrim( preg_replace( "#/+#", "/", $path ), "/" );
$root = str_replace( chr( 92 ), "/", (string) $root );
$root = rtrim( ltrim( preg_replace( "#/+#", "/", $root ), "/" ), "/" ) . "/";
$parts = array_filter( explode( "/", $path ), static fn( $part ) => \'\' !== $part );
if ( empty( $parts ) || in_array( \'..\', $parts, true ) || in_array( \'.\', $parts, true ) ) {
	return \'\';
}
$normalized = implode( "/", $parts );
return str_starts_with( $normalized, $root ) ? $normalized : \'\';
}

function wp_codebox_browser_safe_playground_read_path( $path ) {
$path = str_replace( chr( 92 ), "/", (string) $path );
$root = defined( \'ABSPATH\' ) ? wp_normalize_path( ABSPATH ) : \'/wordpress/\';
$root = rtrim( str_replace( chr( 92 ), "/", $root ), "/" ) . "/";
if ( \'\' === $path || str_contains( $path, \'..\' ) || ! str_starts_with( $path, $root ) || ! is_readable( $path ) ) {
	return \'\';
}

return $path;
}

function wp_codebox_browser_artifact_contract( array $payload ) {
$candidates = array(
	$payload[\'task_input\'][\'context\'][\'output\'][\'artifact_bundle\'] ?? null,
	$payload[\'task_input\'][\'context\'][\'artifact_contract\'] ?? null,
	$payload[\'artifacts\'] ?? null,
);
foreach ( $candidates as $candidate ) {
	if ( is_array( $candidate ) && \'\' !== trim( (string) ( $candidate[\'schema\'] ?? \'\' ) ) ) {
		return $candidate;
	}
}
return array();
}

function wp_codebox_browser_normalize_artifact_root( $root ): string {
$root = rtrim( ltrim( str_replace( chr( 92 ), "/", (string) $root ), "/" ), "/" );
if ( \'\' === $root || str_contains( $root, \'..\' ) ) {
	return \'\';
}

return $root . \'/\';
}

function wp_codebox_browser_artifact_root( array $contract ): string {
$root = wp_codebox_browser_normalize_artifact_root( $contract[\'root\'] ?? \'\' );
return \'\' !== $root ? $root : \'wp-codebox-output/\';
}

function wp_codebox_browser_artifact_base_path( array $payload, array $contract, string $root ): string {
$candidates = array(
	$contract[\'artifact_base_path\'] ?? null,
	$contract[\'base_path\'] ?? null,
	$payload[\'task_input\'][\'context\'][\'output\'][\'artifact_base_path\'] ?? null,
	$payload[\'task_input\'][\'context\'][\'output\'][\'base_path\'] ?? null,
	$payload[\'playground\'][\'artifact_base_path\'] ?? null,
);
$bundle_root = (string) ( $payload[\'task_input\'][\'context\'][\'output\'][\'bundle_root\'] ?? \'\' );
if ( \'\' !== $bundle_root ) {
	$candidates[] = preg_replace( \'#/?\' . preg_quote( rtrim( $root, \'/\' ), \'#\' ) . \'/?$#\', \'\', $bundle_root );
}

foreach ( $candidates as $candidate ) {
	$base = rtrim( str_replace( chr( 92 ), \'/\', (string) $candidate ), \'/\' );
	if ( \'\' !== $base && str_starts_with( $base, \'/\' ) && ! str_contains( $base, \'..\' ) && preg_match( \'#^[A-Za-z0-9_./-]+$#\', $base ) ) {
		return $base;
	}
}

return \'/wordpress/wp-content/uploads/wp-codebox/artifacts\';
}

function wp_codebox_browser_artifact_base_url( array $payload, array $contract ): string {
$candidates = array(
	$contract[\'artifact_base_url\'] ?? null,
	$contract[\'base_url\'] ?? null,
	$payload[\'task_input\'][\'context\'][\'output\'][\'artifact_base_url\'] ?? null,
	$payload[\'task_input\'][\'context\'][\'output\'][\'base_url\'] ?? null,
	$payload[\'playground\'][\'artifact_base_url\'] ?? null,
);
foreach ( $candidates as $candidate ) {
	$base = rtrim( str_replace( chr( 92 ), \'/\', (string) $candidate ), \'/\' );
	if ( \'\' !== $base && str_starts_with( $base, \'/\' ) && ! str_contains( $base, \'..\' ) ) {
		return $base;
	}
}

return \'/wp-content/uploads/wp-codebox/artifacts\';
}

function wp_codebox_browser_artifact_environment( array $payload ): array {
$contract = wp_codebox_browser_artifact_contract( $payload );
$root = wp_codebox_browser_artifact_root( $contract );
$base_path = wp_codebox_browser_artifact_base_path( $payload, $contract, $root );
$base_url = wp_codebox_browser_artifact_base_url( $payload, $contract );
$entrypoint = wp_codebox_browser_safe_artifact_path( (string) ( $contract[\'entrypoint\'] ?? $root . \'index.html\' ), $root );

return array(
	\'contract\' => $contract,
	\'root\' => $root,
	\'base_path\' => $base_path,
	\'base_url\' => $base_url,
	\'entrypoint\' => $entrypoint,
);
}

function wp_codebox_browser_discover_artifact_files( array $contract, string $root, string $base_path, string $base_url ): array {
$base = rtrim( $base_path, \'/\' ) . \'/\' . $root;
if ( ! is_dir( $base ) ) {
	return array();
}

$files = array();
$iterator = new RecursiveIteratorIterator( new RecursiveDirectoryIterator( $base, FilesystemIterator::SKIP_DOTS ) );
foreach ( $iterator as $file ) {
	if ( ! $file instanceof SplFileInfo || ! $file->isFile() ) {
		continue;
	}
	$absolute = $file->getPathname();
	$relative = $root . ltrim( str_replace( chr( 92 ), \'/\', substr( $absolute, strlen( $base ) ) ), \'/\' );
	$files[] = array(
		\'path\'            => $relative,
		\'playground_path\' => $absolute,
		\'url_path\'        => rtrim( $base_url, \'/\' ) . \'/\' . $relative,
	);
}

return $files;
}

function wp_codebox_browser_capture_artifact_bundle( array $payload ) {
$environment = wp_codebox_browser_artifact_environment( $payload );
$contract = $environment[\'contract\'];
$schema = trim( (string) ( $contract[\'schema\'] ?? \'\' ) );
if ( \'\' === $schema ) {
	return array();
}

$root = $environment[\'root\'];
$entrypoint = $environment[\'entrypoint\'];
if ( \'\' === $entrypoint ) {
	return array();
}
$contract_files = is_array( $contract[\'files\'] ?? null ) ? $contract[\'files\'] : array();
if ( empty( $contract_files ) ) {
	$contract_files = wp_codebox_browser_discover_artifact_files( $contract, $root, $environment[\'base_path\'], $environment[\'base_url\'] );
}

$files = array();
foreach ( $contract_files as $file ) {
	if ( ! is_array( $file ) ) {
		continue;
	}
	$path = wp_codebox_browser_safe_artifact_path( $file[\'path\'] ?? \'\', $root );
	$playground_path = wp_codebox_browser_safe_playground_read_path( $file[\'playground_path\'] ?? \'\' );
	if ( \'\' === $path || \'\' === $playground_path ) {
		continue;
	}
	$contents = file_get_contents( $playground_path );
	if ( ! is_string( $contents ) ) {
		continue;
	}
	$is_text = 1 === preg_match( \'#^[\\x09\\x0A\\x0D\\x20-\\x7E]*$#\', $contents );
	$record = array_diff_key( $file, array( \'playground_path\' => true, \'content\' => true, \'content_base64\' => true, \'encoding\' => true, \'sha256\' => true ) );
	$record[\'path\'] = $path;
	$record[\'kind\'] = (string) ( $file[\'kind\'] ?? \'\' );
	$record[\'mime_type\'] = (string) ( $file[\'mime_type\'] ?? \'\' );
	$record[\'url_path\'] = (string) ( $file[\'url_path\'] ?? \'\' );
	$record[\'sha256\'] = hash( \'sha256\', $contents );
	if ( $is_text ) {
		$record[\'content\'] = $contents;
		$record[\'encoding\'] = \'utf-8\';
	} else {
		$record[\'content_base64\'] = base64_encode( $contents );
		$record[\'encoding\'] = \'base64\';
	}
	$files[] = array_filter( $record, static fn( $value ) => \'\' !== $value );
}

$entrypoint_captured = in_array( $entrypoint, array_column( $files, \'path\' ), true );
if ( empty( $files ) || ! $entrypoint_captured ) {
	return array();
}

return array_merge(
	array_diff_key( $contract, array( \'files\' => true ) ),
	array(
		\'schema\' => $schema,
		\'root\' => $root,
		\'entrypoint\' => $entrypoint,
		\'files\' => $files,
	)
);
}

function wp_codebox_browser_artifact_capture_diagnostics( array $payload, array $artifact_bundle ) {
$environment = wp_codebox_browser_artifact_environment( $payload );
$contract = $environment[\'contract\'];
$root = $environment[\'root\'];
$base = rtrim( $environment[\'base_path\'], \'/\' ) . \'/\' . $root;
$entrypoint = $environment[\'entrypoint\'];
$contract_files = is_array( $contract[\'files\'] ?? null ) ? $contract[\'files\'] : array();

return array_filter( array(
	\'contract_schema\' => (string) ( $contract[\'schema\'] ?? \'\' ),
	\'root\' => $root,
	\'base_path\' => $environment[\'base_path\'],
	\'base_exists\' => is_dir( $base ),
	\'entrypoint\' => $entrypoint,
	\'entrypoint_exists\' => \'\' !== $entrypoint && is_readable( rtrim( $environment[\'base_path\'], \'/\' ) . \'/\' . $entrypoint ),
	\'contract_file_count\' => count( $contract_files ),
	\'captured_file_count\' => is_array( $artifact_bundle[\'files\'] ?? null ) ? count( $artifact_bundle[\'files\'] ) : 0,
	\'captured\' => ! empty( $artifact_bundle ),
) );
}

function wp_codebox_browser_response_diagnostics( $response ) {
if ( ! is_array( $response ) ) {
	return array( \'type\' => is_object( $response ) ? get_class( $response ) : gettype( $response ) );
}

$metadata = is_array( $response[\'metadata\'] ?? null ) ? $response[\'metadata\'] : array();
$tool_names = array();
foreach ( is_array( $response[\'tool_calls\'] ?? null ) ? $response[\'tool_calls\'] : array() as $tool_call ) {
	if ( is_array( $tool_call ) && is_scalar( $tool_call[\'name\'] ?? null ) ) {
		$tool_names[] = (string) $tool_call[\'name\'];
	}
}
$last_tool_names = array();
foreach ( is_array( $response[\'last_tool_calls\'] ?? null ) ? $response[\'last_tool_calls\'] : array() as $tool_call ) {
	if ( is_array( $tool_call ) && is_scalar( $tool_call[\'name\'] ?? null ) ) {
		$last_tool_names[] = (string) $tool_call[\'name\'];
	}
}
$tool_result_names = array();
foreach ( is_array( $response[\'tool_execution_results\'] ?? null ) ? $response[\'tool_execution_results\'] : array() as $tool_result ) {
	if ( is_array( $tool_result ) && is_scalar( $tool_result[\'tool_name\'] ?? null ) ) {
		$tool_result_names[] = (string) $tool_result[\'tool_name\'];
	}
}

return array_filter( array(
	\'keys\' => array_slice( array_keys( $response ), 0, 20 ),
	\'turn_count\' => isset( $response[\'turn_count\'] ) && is_scalar( $response[\'turn_count\'] ) ? (int) $response[\'turn_count\'] : null,
	\'tool_call_count\' => is_array( $response[\'tool_calls\'] ?? null ) ? count( $response[\'tool_calls\'] ) : null,
	\'last_tool_call_count\' => is_array( $response[\'last_tool_calls\'] ?? null ) ? count( $response[\'last_tool_calls\'] ) : null,
	\'tool_execution_result_count\' => is_array( $response[\'tool_execution_results\'] ?? null ) ? count( $response[\'tool_execution_results\'] ) : null,
	\'tool_names\' => array_values( array_unique( $tool_names ) ),
	\'last_tool_names\' => array_values( array_unique( $last_tool_names ) ),
	\'tool_execution_result_names\' => array_values( array_unique( $tool_result_names ) ),
	\'completion_assertions_required\' => is_array( $metadata[\'completion_assertions_required\'] ?? null ) ? $metadata[\'completion_assertions_required\'] : null,
	\'completion_assertions_missing\' => is_array( $metadata[\'completion_assertions_missing\'] ?? null ) ? $metadata[\'completion_assertions_missing\'] : null,
	\'completion_assertions_satisfied\' => is_array( $metadata[\'completion_assertions_satisfied\'] ?? null ) ? $metadata[\'completion_assertions_satisfied\'] : null,
	\'completion_assertions_complete\' => isset( $metadata[\'completion_assertions_complete\'] ) ? (bool) $metadata[\'completion_assertions_complete\'] : null,
	\'text_bytes\' => isset( $response[\'response\'] ) && is_string( $response[\'response\'] ) ? strlen( $response[\'response\'] ) : null,
	\'status\' => is_scalar( $response[\'status\'] ?? null ) ? (string) $response[\'status\'] : null,
) );
}

function wp_codebox_browser_input_control_diagnostics( array $input ): array {
return array_filter( array(
	\'has_tool_policy\' => is_array( $input[\'tool_policy\'] ?? null ),
	\'tool_policy_mode\' => is_scalar( $input[\'tool_policy\'][\'mode\'] ?? null ) ? (string) $input[\'tool_policy\'][\'mode\'] : null,
	\'tool_policy_tools\' => is_array( $input[\'tool_policy\'][\'tools\'] ?? null ) ? array_values( array_map( \'strval\', $input[\'tool_policy\'][\'tools\'] ) ) : null,
	\'allow_only\' => is_array( $input[\'allow_only\'] ?? null ) ? array_values( array_map( \'strval\', $input[\'allow_only\'] ) ) : null,
	\'completion_required_tool_names\' => is_array( $input[\'completion_assertions\'][\'required_tool_names\'] ?? null ) ? array_values( array_map( \'strval\', $input[\'completion_assertions\'][\'required_tool_names\'] ) ) : null,
) );
}

function wp_codebox_browser_import_agent_bundles( array $bundle_specs ): array {
if ( empty( $bundle_specs ) ) {
	return array();
}

if ( function_exists( \'wp_agent_import_runtime_bundles\' ) ) {
	return wp_agent_import_runtime_bundles( $bundle_specs, array( \'owner_id\' => get_current_user_id() ?: 1 ) );
}

$imports = array();
foreach ( $bundle_specs as $index => $spec ) {
	if ( ! is_array( $spec ) ) {
		$imports[] = array( \'success\' => false, \'index\' => $index, \'error\' => array( \'code\' => \'agent_bundle_spec_invalid\', \'message\' => \'Agent bundle spec must be an object.\' ) );
		continue;
	}
	if ( ! isset( $spec[\'source\'] ) && ! isset( $spec[\'bundle\'] ) ) {
		$imports[] = array( \'success\' => false, \'index\' => $index, \'error\' => array( \'code\' => \'agent_bundle_source_missing\', \'message\' => \'Agent bundle spec requires source or bundle.\' ) );
		continue;
	}

	$input = array( \'on_conflict\' => (string) ( $spec[\'on_conflict\'] ?? \'upgrade\' ) );
	if ( isset( $spec[\'source\'] ) && \'\' !== trim( (string) $spec[\'source\'] ) ) {
		$input[\'source\'] = trim( (string) $spec[\'source\'] );
	}
	foreach ( array( \'slug\', \'token_env\' ) as $field ) {
		if ( isset( $spec[ $field ] ) && \'\' !== trim( (string) $spec[ $field ] ) ) {
			$input[ $field ] = trim( (string) $spec[ $field ] );
		}
	}
	$input[\'owner_id\'] = isset( $spec[\'owner_id\'] ) && (int) $spec[\'owner_id\'] > 0 ? (int) $spec[\'owner_id\'] : ( get_current_user_id() ?: 1 );
	if ( isset( $spec[\'import_principal\'] ) && is_array( $spec[\'import_principal\'] ) ) {
		$input[\'import_principal\'] = $spec[\'import_principal\'];
	}
	$result = apply_filters( \'wp_agent_runtime_import_bundle\', null, $spec, $input, $index );
	if ( null === $result ) {
		$result = new WP_Error( \'wp_codebox_agent_bundle_importer_unavailable\', \'No browser runtime agent bundle importer handled this bundle spec.\', array( \'index\' => $index ) );
	}
	$imports[] = is_wp_error( $result )
		? array( \'success\' => false, \'index\' => $index, \'source\' => isset( $input[\'source\'] ) ? $input[\'source\'] : \'inline\', \'error\' => array( \'code\' => $result->get_error_code(), \'message\' => $result->get_error_message(), \'data\' => $result->get_error_data() ) )
		: array_merge( array( \'index\' => $index, \'source\' => isset( $input[\'source\'] ) ? $input[\'source\'] : \'inline\' ), is_array( $result ) ? $result : array( \'result\' => $result ) );
}

return $imports;
}

class WP_Codebox_Browser_Filesystem_Write_Tool {
	public function handle_tool_call( array $parameters, array $tool_def = array() ): array {
		global $wp_codebox_browser_artifact_environment;
		$environment = is_array( $wp_codebox_browser_artifact_environment ?? null ) ? $wp_codebox_browser_artifact_environment : array();
		$root = (string) ( $environment[\'root\'] ?? \'wp-codebox-output/\' );
		$base_path = rtrim( (string) ( $environment[\'base_path\'] ?? \'/wordpress/wp-content/uploads/wp-codebox/artifacts\' ), \'/\' );
		$path = str_replace( chr( 92 ), \'/\', (string) ( $parameters[\'path\'] ?? \'\' ) );
		$path = ltrim( preg_replace( \'#/+#\', \'/\', $path ), \'/\' );
		if ( \'\' === $path || str_contains( $path, \'..\' ) || ! str_starts_with( $path, $root ) ) {
			return array( \'success\' => false, \'error\' => \'Path must stay inside the configured artifact bundle root.\', \'root\' => $root );
		}

		$content = (string) ( $parameters[\'content\'] ?? \'\' );
		if ( \'base64\' === (string) ( $parameters[\'encoding\'] ?? \'utf-8\' ) ) {
			$decoded = base64_decode( $content, true );
			if ( false === $decoded ) {
				return array( \'success\' => false, \'error\' => \'Base64 content could not be decoded.\' );
			}
			$content = $decoded;
		}

		$absolute = $base_path . \'/\' . $path;
		$directory = dirname( $absolute );
		if ( ! is_dir( $directory ) && ! mkdir( $directory, 0777, true ) ) {
			return array( \'success\' => false, \'error\' => \'Could not create artifact directory.\', \'path\' => $path );
		}
		if ( false === file_put_contents( $absolute, $content ) ) {
			return array( \'success\' => false, \'error\' => \'Could not write artifact file.\', \'path\' => $path );
		}

		return array(
			\'success\' => true,
			\'path\' => $path,
			\'playground_path\' => $absolute,
			\'bytes\' => strlen( $content ),
			\'sha256\' => hash( \'sha256\', $content ),
		);
	}
}

function wp_codebox_browser_runtime_tool_name( string $tool_id ): string {
$tool_id = trim( $tool_id );
if ( \'filesystem-write\' === $tool_id || \'client/filesystem-write\' === $tool_id ) {
	return \'client/filesystem-write\';
}

return \'\';
}

function wp_codebox_browser_runtime_tool_declarations( array $tool_names ): array {
global $wp_codebox_browser_artifact_environment;

$declarations = array();
if ( ! in_array( \'client/filesystem-write\', $tool_names, true ) ) {
	return $declarations;
}

$environment = is_array( $wp_codebox_browser_artifact_environment ?? null ) ? $wp_codebox_browser_artifact_environment : array();
$root = (string) ( $environment[\'root\'] ?? \'wp-codebox-output/\' );
$base_path = rtrim( (string) ( $environment[\'base_path\'] ?? \'/wordpress/wp-content/uploads/wp-codebox/artifacts\' ), \'/\' );
$declarations[\'client/filesystem-write\'] = array(
	\'name\'        => \'client/filesystem-write\',
	\'source\'      => \'client\',
	\'description\' => sprintf( \'Write one generated artifact file inside %s/%s. Call this once per file required by the caller artifact contract.\', $base_path, $root ),
	\'executor\'    => \'client\',
	\'scope\'       => \'run\',
	\'parameters\'  => array(
		\'type\'       => \'object\',
		\'required\'   => array( \'path\', \'content\' ),
		\'properties\' => array(
			\'path\'     => array( \'type\' => \'string\', \'description\' => sprintf( \'Relative artifact path under %s, for example %sindex.html.\', $root, $root ) ),
			\'content\'  => array( \'type\' => \'string\', \'description\' => \'Full file contents. Use UTF-8 text unless encoding is base64.\' ),
			\'encoding\' => array( \'type\' => \'string\', \'enum\' => array( \'utf-8\', \'base64\' ) ),
		),
	),
	\'runtime\'     => array(
		\'environment\'      => \'runtime_local\',
		\'capability_scope\' => \'runtime_local\',
	),
);

return $declarations;
}

function wp_codebox_browser_runtime_tool_callback( array $request, array $payload ) {
unset( $payload );

if ( \'client/filesystem-write\' !== (string) ( $request[\'tool_name\'] ?? \'\' ) ) {
	return null;
}

$handler = new WP_Codebox_Browser_Filesystem_Write_Tool();
$parameters = is_array( $request[\'parameters\'] ?? null ) ? $request[\'parameters\'] : array();
$tool_def = is_array( $request[\'tool_def\'] ?? null ) ? $request[\'tool_def\'] : array();
return $handler->handle_tool_call( $parameters, $tool_def );
}

add_filter( \'wp_agent_runtime_resolved_tools\', function ( array $tools, $mode, array $args ) {
	global $wp_codebox_browser_artifact_environment;
	$environment = is_array( $wp_codebox_browser_artifact_environment ?? null ) ? $wp_codebox_browser_artifact_environment : array();
	$root = (string) ( $environment[\'root\'] ?? \'wp-codebox-output/\' );
	$base_path = rtrim( (string) ( $environment[\'base_path\'] ?? \'/wordpress/wp-content/uploads/wp-codebox/artifacts\' ), \'/\' );
	$tools[\'filesystem-write\'] = array(
		\'name\'        => \'filesystem-write\',
		\'description\' => sprintf( \'Write one generated artifact file inside %s/%s. Call this once per file required by the caller artifact contract.\', $base_path, $root ),
		\'class\'       => \'WP_Codebox_Browser_Filesystem_Write_Tool\',
		\'method\'      => \'handle_tool_call\',
		\'parameters\'  => array(
			\'type\'       => \'object\',
			\'required\'   => array( \'path\', \'content\' ),
			\'properties\' => array(
				\'path\'     => array( \'type\' => \'string\', \'description\' => sprintf( \'Relative artifact path under %s, for example %sindex.html.\', $root, $root ) ),
				\'content\'  => array( \'type\' => \'string\', \'description\' => \'Full file contents. Use UTF-8 text unless encoding is base64.\' ),
				\'encoding\' => array( \'type\' => \'string\', \'enum\' => array( \'utf-8\', \'base64\' ) ),
			),
		),
		\'access_level\' => \'public\',
		\'modes\'        => is_array( $mode ) ? $mode : array( (string) $mode ),
	);
	return $tools;
}, 20, 3 );

$wp_codebox_playground_root = defined( \'ABSPATH\' ) ? wp_normalize_path( ABSPATH ) : \'\';
$wp_codebox_is_playground = \'/wordpress/\' === $wp_codebox_playground_root && ( \'Emscripten\' === PHP_OS_FAMILY || ( defined( \'WP_CODEBOX_BROWSER_PLAYGROUND_RUNNER\' ) && WP_CODEBOX_BROWSER_PLAYGROUND_RUNNER ) );

if ( function_exists( \'wp_register_ability\' ) ) {
if ( ! did_action( \'wp_abilities_api_categories_init\' ) ) {
	do_action( \'wp_abilities_api_categories_init\' );
}
if ( ! did_action( \'wp_abilities_api_init\' ) ) {
	do_action( \'wp_abilities_api_init\' );
}
}

if ( is_readable( $task_path ) ) {
$raw_payload = json_decode( (string) file_get_contents( $task_path ), true );
if ( is_array( $raw_payload ) ) {
	$payload = array_replace_recursive( $payload, $raw_payload );
}
}

$wp_codebox_browser_artifact_environment = wp_codebox_browser_artifact_environment( $payload );
$provider_proxy_diagnostics = wp_codebox_browser_install_provider_proxy( $payload );

$agent = sanitize_key( (string) ( $payload[\'agent\'] ?? \'wp-codebox-sandbox\' ) );
$message = (string) ( $payload[\'message\'] ?? ( $payload[\'task_input\'][\'goal\'] ?? \'\' ) );
$session_id = (string) ( $payload[\'session_id\'] ?? ' . var_export( $session_id, true ) . ' );
$runtime_user_id = (int) ( $payload[\'user_id\'] ?? ( function_exists( \'get_current_user_id\' ) ? get_current_user_id() : 0 ) );
if ( $runtime_user_id <= 0 ) {
	$runtime_user_id = 1;
}
if ( function_exists( \'wp_set_current_user\' ) ) {
	wp_set_current_user( $runtime_user_id );
}
$agent_bundle_imports = array();
$sandbox_tool_ids = array();
$sandbox_policy = is_array( $payload[\'task_input\'][\'sandbox_tool_policy\'] ?? null ) ? $payload[\'task_input\'][\'sandbox_tool_policy\'] : array();
foreach ( is_array( $sandbox_policy[\'tools\'] ?? null ) ? $sandbox_policy[\'tools\'] : array() as $tool_policy_entry ) {
	if ( ! is_array( $tool_policy_entry ) || empty( $tool_policy_entry[\'allowed\'] ) ) {
		continue;
	}
	$tool_id = trim( (string) ( $tool_policy_entry[\'id\'] ?? \'\' ) );
	$tool_name = wp_codebox_browser_runtime_tool_name( $tool_id );
	if ( \'\' !== $tool_name ) {
		$sandbox_tool_ids[] = $tool_name;
	}
}
if ( empty( $sandbox_tool_ids ) && is_array( $payload[\'task_input\'][\'allowed_tools\'] ?? null ) ) {
	foreach ( $payload[\'task_input\'][\'allowed_tools\'] as $tool_id ) {
		$tool_id = trim( (string) $tool_id );
		$tool_name = wp_codebox_browser_runtime_tool_name( $tool_id );
		if ( \'\' !== $tool_name ) {
			$sandbox_tool_ids[] = $tool_name;
		}
}
}
$sandbox_tool_ids = array_values( array_unique( $sandbox_tool_ids ) );
$runtime_tool_declarations = wp_codebox_browser_runtime_tool_declarations( $sandbox_tool_ids );
$base_input = array(
\'agent\' => $agent,
\'message\' => $message,
\'user_id\' => $runtime_user_id,
\'provider\' => (string) ( $payload[\'provider\'] ?? ( is_array( $payload[\'task_input\'] ?? null ) ? ( $payload[\'task_input\'][\'provider\'] ?? \'\' ) : \'\' ) ),
\'model\' => (string) ( $payload[\'model\'] ?? ( is_array( $payload[\'task_input\'] ?? null ) ? ( $payload[\'task_input\'][\'model\'] ?? \'\' ) : \'\' ) ),
\'session_owner\' => array(
	\'type\' => \'browser-playground\',
	\'key\' => $session_id,
	\'label\' => \'WP Codebox Browser Playground\',
),
\'principal\' => array(
	\'acting_user_id\' => 0,
	\'effective_agent_id\' => $agent,
	\'auth_source\' => \'runtime\',
	\'request_context\' => \'runtime\',
	\'token_id\' => null,
	\'request_metadata\' => array(
		\'source\' => \'wp-codebox\',
		\'mode\' => \'browser-playground\',
		\'codebox_session_id\' => $session_id,
	),
	\'workspace_id\' => \'wp-codebox\',
	\'client_id\' => \'wp-codebox-browser-runner\',
	\'audience_id\' => $session_id,
	\'audience_claims\' => array(
		\'runtime_type\' => \'wordpress-playground\',
	),
	\'owner_type\' => \'runtime\',
	\'owner_key\' => $session_id,
),
\'client_context\' => array(
	\'source\' => \'peer-agent\',
	\'client_name\' => \'wp-codebox-browser-runner\',
	\'peer_agent_call\' => true,
	\'caller_session_id\' => $session_id,
	\'task_input\' => $payload[\'task_input\'] ?? array(),
	\'runtime_tools\' => $runtime_tool_declarations,
	\'runtime_tool_callback\' => \'wp_codebox_browser_runtime_tool_callback\',
),
);
if ( ! empty( $sandbox_tool_ids ) ) {
	$base_input[\'tool_policy\'] = array(
		\'mode\' => \'allow\',
		\'tools\' => $sandbox_tool_ids,
	);
	$base_input[\'allow_only\'] = $sandbox_tool_ids;
	$base_input[\'completion_assertions\'] = array(
		\'required_tool_names\' => $sandbox_tool_ids,
	);
}
$input = array_replace_recursive( $base_input, is_array( $invocation[\'input\'] ?? null ) ? $invocation[\'input\'] : array() );
$event_sink_attached = false;
if ( interface_exists( "\\DataMachine\\Engine\\AI\\LoopEventSinkInterface" ) && class_exists( "WP_Codebox_Browser_Event_File_Sink" ) ) {
	file_put_contents( $event_path, "" );
	$input[\'event_sink\'] = new WP_Codebox_Browser_Event_File_Sink( $event_path );
	$event_sink_attached = true;
}
$invocation_type = (string) ( $invocation[\'type\'] ?? \'ability\' );

if ( ! $wp_codebox_is_playground ) {
$response = new WP_Error(
	\'wp_codebox_browser_runner_not_playground\',
	\'The browser agent runner runtime-principal authorization is only allowed inside the disposable WordPress Playground sandbox.\',
	array(
		\'execution_scope\' => \'disposable-playground\',
		\'permission_model\' => \'runtime-principal\',
		\'detected_root\' => $wp_codebox_playground_root,
		\'detected_php_os_family\' => PHP_OS_FAMILY,
	)
);
} else {
$agent_bundle_imports = wp_codebox_browser_import_agent_bundles( is_array( $payload[\'agent_bundles\'] ?? null ) ? $payload[\'agent_bundles\'] : array() );
$wp_codebox_browser_runtime_principal_permission = static function ( bool $allowed, $principal, array $permission_input ) use ( $session_id ): bool {
	if ( ! $principal instanceof AgentsAPI\\AI\\WP_Agent_Execution_Principal ) {
		return $allowed;
	}
	if ( \'runtime\' !== $principal->auth_source || \'runtime\' !== $principal->request_context ) {
		return $allowed;
	}
	if ( \'wp-codebox-browser-runner\' !== $principal->client_id || \'wp-codebox\' !== $principal->workspace_id || \'runtime\' !== $principal->owner_type ) {
		return $allowed;
	}
	if ( $session_id !== $principal->audience_id || $session_id !== $principal->owner_key ) {
		return $allowed;
	}
	if ( \'wordpress-playground\' !== (string) ( $principal->audience_claims[\'runtime_type\'] ?? \'\' ) ) {
		return $allowed;
	}
	return \'wp-codebox\' === (string) ( $permission_input[\'principal\'][\'workspace_id\'] ?? \'\' ) && \'wp-codebox-browser-runner\' === (string) ( $permission_input[\'principal\'][\'client_id\'] ?? \'\' );
};
add_filter( \'agents_chat_runtime_principal_permission\', $wp_codebox_browser_runtime_principal_permission, 999, 3 );

try {
	$failed_imports = array_filter( $agent_bundle_imports, static fn( $import ) => is_array( $import ) && empty( $import[\'success\'] ) );
	if ( ! empty( $failed_imports ) ) {
		$response = new WP_Error( \'wp_codebox_agent_bundle_import_failed\', \'One or more runtime agent bundles failed to import before sandbox invocation.\', array( \'agent_bundle_imports\' => array_values( $failed_imports ) ) );
	} elseif ( \'task\' === $invocation_type ) {
		$hook = (string) ( $invocation[\'hook\'] ?? $invocation[\'name\'] ?? \'\' );
		if ( \'\' === $hook || ! has_filter( $hook ) ) {
			$response = new WP_Error( \'wp_codebox_browser_task_unavailable\', \'The requested sandbox task hook is not registered inside the Playground site.\', array( \'hook\' => $hook ) );
		} else {
			$response = apply_filters( $hook, null, $input, $payload );
		}
	} else {
		$ability_name = (string) ( $invocation[\'name\'] ?? \'agents/chat\' );
		$ability = function_exists( \'wp_get_ability\' ) ? wp_get_ability( $ability_name ) : null;
		if ( ! $ability instanceof WP_Ability ) {
			$response = new WP_Error( \'wp_codebox_browser_ability_unavailable\', \'The requested ability is not available inside the Playground site.\', array( \'ability\' => $ability_name ) );
		} else {
			$response = $ability->execute( $input );
		}
	}
} catch ( Throwable $exception ) {
	$response = $exception;
} finally {
	if ( function_exists( \'remove_filter\' ) ) {
		remove_filter( \'agents_chat_runtime_principal_permission\', $wp_codebox_browser_runtime_principal_permission, 999 );
	}
}
}

$captures = array();
foreach ( $capture_paths as $capture ) {
if ( is_array( $capture ) ) {
	$captures[] = wp_codebox_browser_capture_file( $capture );
}
}
$artifact_bundle = wp_codebox_browser_capture_artifact_bundle( $payload );

$invocation_metadata = array_filter(
array(
	\'type\' => $invocation_type,
	\'name\' => (string) ( $invocation[\'name\'] ?? \'\' ),
	\'hook\' => (string) ( $invocation[\'hook\'] ?? \'\' ),
),
static fn( $value ) => \'\' !== $value
);
$diagnostics = array(
\'capture_count\' => count( $captures ),
\'captured_paths\' => array_values( array_map( static fn( $capture ) => (string) ( $capture[\'path\'] ?? \'\' ), $captures ) ),
\'agent_bundle_imports\' => $agent_bundle_imports,
\'event_stream\' => array(
	\'path\' => $event_path,
	\'sink_attached\' => $event_sink_attached,
	\'exists\' => is_readable( $event_path ),
	\'size\' => is_readable( $event_path ) ? filesize( $event_path ) : 0,
),
\'provider_proxy\' => $provider_proxy_diagnostics,
\'sandbox_tool_ids\' => $sandbox_tool_ids,
\'input_controls\' => wp_codebox_browser_input_control_diagnostics( is_array( $input ?? null ) ? $input : array() ),
\'artifact_capture\' => wp_codebox_browser_artifact_capture_diagnostics( $payload, $artifact_bundle ),
\'response\' => wp_codebox_browser_response_diagnostics( $response ?? null ),
);
$provenance = array(
\'generated_by\' => \'wp-codebox/browser-runner\',
\'session_id\' => $session_id,
\'task_path\' => $task_path,
\'result_path\' => $result_path,
\'started_at\' => $started_at,
\'completed_at\' => gmdate( \'c\' ),
);

if ( is_wp_error( $response ) || $response instanceof Throwable ) {
$error = array(
	\'code\' => wp_codebox_browser_normalize_error( $response )[\'code\'],
	\'message\' => wp_codebox_browser_normalize_error( $response )[\'message\'],
	\'data\' => wp_codebox_browser_normalize_error( $response )[\'data\'] ?? null,
);
$result = array(
		\'success\' => false,
		\'schema\' => \'wp-codebox/browser-materialization/v1\',
		\'status\' => \'error\',
		\'session_id\' => $session_id,
		\'execution_scope\' => \'disposable-playground\',
		\'permission_model\' => \'runtime-principal\',
		\'invocation\' => $invocation_metadata,
		\'captures\' => $captures,
		\'diagnostics\' => $diagnostics,
		\'error\' => $error,
		\'errors\' => array( $error ),
		\'provenance\' => $provenance,
);
} else {
$result = array(
		\'success\' => true,
		\'schema\' => \'wp-codebox/browser-materialization/v1\',
		\'status\' => \'completed\',
		\'session_id\' => $session_id,
		\'execution_scope\' => \'disposable-playground\',
		\'permission_model\' => \'runtime-principal\',
		\'invocation\' => $invocation_metadata,
		\'task_input\' => $payload[\'task_input\'] ?? array(),
		\'response\' => $response,
		\'captures\' => $captures,
		\'diagnostics\' => $diagnostics,
		\'errors\' => array(),
		\'provenance\' => $provenance,
		\'artifacts\' => $payload[\'artifacts\'] ?? array(),
);
if ( ! empty( $artifact_bundle ) ) {
	$result[\'artifact_bundle\'] = $artifact_bundle;
	if ( is_array( $result[\'response\'] ?? null ) && empty( $result[\'response\'][\'artifact_bundle\'] ) ) {
		$result[\'response\'][\'artifact_bundle\'] = $artifact_bundle;
	}
}
}

file_put_contents( $result_path, wp_json_encode( $result ) );
echo wp_json_encode( $result );
';
}

/** @param array<string,mixed> $playground Playground config. */
private static function browser_artifact_base_path( array $playground ): string {
	return self::normalize_absolute_browser_path( (string) ( $playground['artifact_base_path'] ?? '/wordpress/wp-content/uploads/wp-codebox/artifacts' ) );
}

/** @param array<string,mixed> $playground Playground config. */
private static function browser_artifact_base_url( array $playground ): string {
	return self::normalize_absolute_browser_path( (string) ( $playground['artifact_base_url'] ?? '/wp-content/uploads/wp-codebox/artifacts' ) );
}

/** @param array<int,array<string,string>> $artifacts Artifact files. @param array<string,mixed> $playground Playground config. */
private static function browser_preview_url( array $artifacts, array $playground ): string {
	$preview_url = trim( (string) ( $playground['preview_url'] ?? '' ) );
	if ( '' !== $preview_url ) {
		return self::normalize_absolute_browser_path( $preview_url );
	}

	$first_file = $artifacts[0]['url_path'] ?? '';
	return '' !== $first_file ? $first_file : '/';
}

private static function normalize_absolute_browser_path( string $path ): string {
	$path = '/' . ltrim( trim( $path ), '/' );
	$path = rtrim( $path, '/' );
	return '' === $path ? '/' : $path;
}

private static function join_browser_path( string $base, string $path ): string {
	return rtrim( $base, '/' ) . '/' . ltrim( $path, '/' );
}

/** @param array<string,mixed> $blueprint Blueprint override. @param array<string,mixed> $playground Playground config. @return array<string,mixed> */
private static function browser_playground_blueprint( array $blueprint, array $playground ): array {
	if ( ! empty( $blueprint ) ) {
		return $blueprint;
	}

	return array(
		'preferredVersions' => array(
			'wp'  => (string) ( $playground['wp'] ?? 'latest' ),
			'php' => (string) ( $playground['php'] ?? 'latest' ),
		),
		'features'          => array(
			'networking' => true,
		),
		'steps'             => array(),
	);
}
}
