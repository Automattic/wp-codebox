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

	/** Builds the generated PHP execution metrics helpers fragment. */
	public static function execution_metrics_fragment(): string {
		return '
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

function wp_codebox_browser_json_bytes( $value ): int {
$encoded = wp_json_encode( $value, JSON_UNESCAPED_SLASHES );
return is_string( $encoded ) ? strlen( $encoded ) : 0;
}

function wp_codebox_browser_failure_class( string $code ): string {
if ( "" === $code ) {
    return "";
}
if ( str_contains( $code, "timeout" ) ) {
    return "timeout";
}
if ( str_contains( $code, "permission" ) || str_contains( $code, "authorization" ) || str_contains( $code, "not_playground" ) ) {
    return "authorization";
}
if ( str_contains( $code, "unavailable" ) || str_contains( $code, "missing" ) ) {
    return "dependency_unavailable";
}
if ( str_contains( $code, "invalid" ) ) {
    return "invalid_request";
}

return "runtime_error";
}

function wp_codebox_browser_artifact_metrics( array $artifact_bundle ): array {
$files = is_array( $artifact_bundle["files"] ?? null ) ? $artifact_bundle["files"] : array();
$bytes = 0;
foreach ( $files as $file ) {
    if ( ! is_array( $file ) ) {
        continue;
    }
    if ( is_string( $file["content"] ?? null ) ) {
        $bytes += strlen( $file["content"] );
    } elseif ( is_string( $file["content_base64"] ?? null ) ) {
        $decoded = base64_decode( $file["content_base64"], true );
        $bytes += is_string( $decoded ) ? strlen( $decoded ) : strlen( $file["content_base64"] );
    }
}

return array_filter( array(
    "schema" => (string) ( $artifact_bundle["schema"] ?? "" ),
    "file_count" => count( $files ),
    "bytes" => $bytes,
    "entrypoint" => (string) ( $artifact_bundle["entrypoint"] ?? "" ),
) );
}

function wp_codebox_browser_capture_metrics( array $captures ): array {
$records = array();
$bytes = 0;
foreach ( $captures as $capture ) {
    if ( ! is_array( $capture ) ) {
        continue;
    }
    $size = isset( $capture["size"] ) ? (int) $capture["size"] : 0;
    $bytes += $size;
    $records[] = array_filter( array(
        "path" => (string) ( $capture["path"] ?? "" ),
        "name" => (string) ( $capture["name"] ?? "" ),
        "kind" => (string) ( $capture["kind"] ?? "" ),
        "exists" => isset( $capture["exists"] ) ? (bool) $capture["exists"] : null,
        "bytes" => $size,
        "sha256" => (string) ( $capture["sha256"] ?? "" ),
        "truncated" => isset( $capture["truncated"] ) ? (bool) $capture["truncated"] : null,
    ), static fn( $value ) => null !== $value && "" !== $value );
}

return array(
    "count" => count( $captures ),
    "bytes" => $bytes,
    "records" => $records,
);
}

function wp_codebox_browser_event_metrics( string $event_path ): array {
$metrics = array(
    "path" => $event_path,
    "exists" => is_readable( $event_path ),
    "bytes" => is_readable( $event_path ) ? (int) filesize( $event_path ) : 0,
    "event_count" => 0,
    "tool_call_count" => 0,
    "tool_duration_ms" => 0,
    "tools" => array(),
);
if ( ! is_readable( $event_path ) ) {
    return $metrics;
}

$lines = file( $event_path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES );
foreach ( is_array( $lines ) ? $lines : array() as $line ) {
    $event = json_decode( (string) $line, true );
    if ( ! is_array( $event ) ) {
        continue;
    }
    ++$metrics["event_count"];
    $payload = is_array( $event["payload"] ?? null ) ? $event["payload"] : array();
    $tool_name = is_scalar( $payload["tool_name"] ?? null ) ? (string) $payload["tool_name"] : "";
    if ( "" === $tool_name && is_string( $event["event"] ?? null ) && str_contains( (string) $event["event"], "tool" ) ) {
        $tool_name = "unknown";
    }
    if ( "" === $tool_name ) {
        continue;
    }

    ++$metrics["tool_call_count"];
    $duration = isset( $payload["duration_ms"] ) && is_numeric( $payload["duration_ms"] ) ? (int) $payload["duration_ms"] : ( isset( $payload["elapsed_ms"] ) && is_numeric( $payload["elapsed_ms"] ) ? (int) $payload["elapsed_ms"] : 0 );
    $metrics["tool_duration_ms"] += $duration;
    if ( ! isset( $metrics["tools"][ $tool_name ] ) ) {
        $metrics["tools"][ $tool_name ] = array( "count" => 0, "duration_ms" => 0 );
    }
    ++$metrics["tools"][ $tool_name ]["count"];
    $metrics["tools"][ $tool_name ]["duration_ms"] += $duration;
}

ksort( $metrics["tools"] );
return $metrics;
}

function wp_codebox_browser_execution_metrics( array $payload, array $invocation_metadata, array $captures, array $artifact_bundle, array $diagnostics, $response, float $started_monotonic ): array {
$failed = is_wp_error( $response ) || $response instanceof Throwable;
$error = $failed ? wp_codebox_browser_normalize_error( $response ) : array();
$event_metrics = wp_codebox_browser_event_metrics( (string) ( $diagnostics["event_stream"]["path"] ?? "/tmp/wp-codebox-agent-events.jsonl" ) );
$capture_metrics = wp_codebox_browser_capture_metrics( $captures );
$artifact_metrics = wp_codebox_browser_artifact_metrics( $artifact_bundle );
$elapsed_ms = max( 0, (int) round( ( microtime( true ) - $started_monotonic ) * 1000 ) );

return array_filter( array(
    "schema" => "wp-codebox/execution-metrics/v1",
    "executor" => "wp-codebox/browser-playground",
    "phase" => "execution",
    "status" => $failed ? "error" : "completed",
    "execution" => "browser-playground",
    "execution_scope" => "disposable-playground",
    "permission_model" => "runtime-principal",
    "timings_ms" => array(
        "total_ms" => $elapsed_ms,
        "agent_loop_ms" => $elapsed_ms,
        "tool_calls_ms" => (int) $event_metrics["tool_duration_ms"],
        "browser_startup_ms" => null,
        "playground_startup_ms" => null,
        "blueprint_run_ms" => null,
    ),
    "tool_calls" => array(
        "count" => (int) $event_metrics["tool_call_count"],
        "duration_ms" => (int) $event_metrics["tool_duration_ms"],
        "by_tool" => $event_metrics["tools"],
    ),
    "payload_bytes" => array_filter( array(
        "task_payload" => wp_codebox_browser_json_bytes( $payload ),
        "invocation" => wp_codebox_browser_json_bytes( $invocation_metadata ),
        "response_summary" => wp_codebox_browser_json_bytes( $diagnostics["response"] ?? array() ),
    ), static fn( $bytes ) => is_int( $bytes ) && $bytes > 0 ),
    "artifact_bytes" => array(
        "captures" => (int) $capture_metrics["bytes"],
        "artifact_bundle" => (int) ( $artifact_metrics["bytes"] ?? 0 ),
    ),
    "artifacts" => array(
        "capture_count" => (int) $capture_metrics["count"],
        "artifact_file_count" => (int) ( $artifact_metrics["file_count"] ?? 0 ),
        "artifact_schema" => (string) ( $artifact_metrics["schema"] ?? "" ),
        "entrypoint" => (string) ( $artifact_metrics["entrypoint"] ?? "" ),
    ),
    "diagnostics_refs" => array(
        "event_stream" => array_diff_key( $event_metrics, array( "tools" => true ) ),
        "captures" => $capture_metrics["records"],
        "provider_proxy" => array_filter( array(
            "installed" => isset( $diagnostics["provider_proxy"]["installed"] ) ? (bool) $diagnostics["provider_proxy"]["installed"] : null,
            "early_return" => (string) ( $diagnostics["provider_proxy"]["early_return"] ?? "" ),
            "connector_count" => isset( $diagnostics["provider_proxy"]["connector_count"] ) ? (int) $diagnostics["provider_proxy"]["connector_count"] : null,
        ), static fn( $value ) => null !== $value && "" !== $value ),
    ),
    "failure" => $failed ? array(
        "class" => wp_codebox_browser_failure_class( (string) ( $error["code"] ?? "" ) ),
        "code" => (string) ( $error["code"] ?? "" ),
    ) : array(),
) );
}
';
	}

	/** Builds the generated PHP runtime-local tool registration fragment. */
	public static function runtime_tool_registration_fragment(): string {
		return '
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
if ( in_array( $tool_id, array( \'filesystem-write\', \'filesystem_write\', \'client/filesystem-write\' ), true ) ) {
	return \'filesystem_write\';
}

return \'\';
}

function wp_codebox_browser_runtime_tool_declarations( array $tool_names ): array {
global $wp_codebox_browser_artifact_environment;

$declarations = array();
if ( ! in_array( \'filesystem_write\', $tool_names, true ) ) {
	return $declarations;
}

$environment = is_array( $wp_codebox_browser_artifact_environment ?? null ) ? $wp_codebox_browser_artifact_environment : array();
$root = (string) ( $environment[\'root\'] ?? \'wp-codebox-output/\' );
$base_path = rtrim( (string) ( $environment[\'base_path\'] ?? \'/wordpress/wp-content/uploads/wp-codebox/artifacts\' ), \'/\' );
$declarations[\'filesystem_write\'] = array(
	\'name\'        => \'filesystem_write\',
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

function wp_codebox_browser_runtime_ability_tool_declarations( array $payload ): array {
$task_input = is_array( $payload[\'task_input\'] ?? null ) ? $payload[\'task_input\'] : array();
$declared = is_array( $task_input[\'ability_tools\'] ?? null ) ? $task_input[\'ability_tools\'] : array();
$tools = array();
$invalid = array();

foreach ( $declared as $index => $declaration ) {
if ( ! is_array( $declaration ) ) {
	$invalid[] = array( \'index\' => $index, \'code\' => \'ability_tool_declaration_invalid\', \'message\' => \'Ability tool declaration must be an object.\' );
	continue;
}

$name = trim( (string) ( $declaration[\'name\'] ?? \'\' ) );
$ability = trim( (string) ( $declaration[\'ability\'] ?? \'\' ) );
if ( \'\' === $name || \'\' === $ability ) {
	$invalid[] = array( \'index\' => $index, \'code\' => \'ability_tool_declaration_incomplete\', \'message\' => \'Ability tool declaration requires name and ability.\' );
	continue;
}

$tool = $declaration;
unset( $tool[\'name\'] );
$tool[\'ability\'] = $ability;
if ( ! isset( $tool[\'modes\'] ) ) {
	$tool[\'modes\'] = array( \'chat\' );
}
$tools[ $name ] = $tool;
}

return array(
	\'tools\' => $tools,
	\'invalid\' => $invalid,
);
}

function wp_codebox_browser_runtime_ability_tool_diagnostics( array $ability_tools ): array {
$registered = array();
$missing = array();
$registry_available = class_exists( \'WP_Abilities_Registry\' );
$registry = $registry_available ? WP_Abilities_Registry::get_instance() : null;

foreach ( $ability_tools as $name => $declaration ) {
$ability = is_array( $declaration ) ? (string) ( $declaration[\'ability\'] ?? \'\' ) : \'\';
$is_registered = false;
if ( $registry && method_exists( $registry, \'is_registered\' ) && \'\' !== $ability ) {
	$is_registered = (bool) $registry->is_registered( $ability );
}

$row = array(
	\'name\' => (string) $name,
	\'ability\' => $ability,
	\'registered\' => $is_registered,
);
if ( $is_registered ) {
	$registered[] = $row;
} else {
	$missing[] = $row;
}
}

return array(
	\'count\' => count( $ability_tools ),
	\'names\' => array_values( array_map( \'strval\', array_keys( $ability_tools ) ) ),
	\'registry_available\' => $registry_available,
	\'registered\' => $registered,
	\'missing\' => $missing,
);
}

function wp_codebox_browser_runtime_replay_ability_lifecycle(): array {
if ( function_exists( \'wp_register_ability\' ) ) {
if ( ! did_action( \'wp_abilities_api_categories_init\' ) ) {
	do_action( \'wp_abilities_api_categories_init\' );
}
if ( ! did_action( \'wp_abilities_api_init\' ) ) {
	do_action( \'wp_abilities_api_init\' );
}
}

do_action( \'wp_codebox_runtime_abilities_ready\' );

return array(
	\'wp_abilities_api_categories_init\' => function_exists( \'did_action\' ) ? did_action( \'wp_abilities_api_categories_init\' ) : null,
	\'wp_abilities_api_init\' => function_exists( \'did_action\' ) ? did_action( \'wp_abilities_api_init\' ) : null,
	\'wp_codebox_runtime_abilities_ready\' => function_exists( \'did_action\' ) ? did_action( \'wp_codebox_runtime_abilities_ready\' ) : null,
);
}

function wp_codebox_browser_runtime_tool_callback( array $request, array $payload ) {
unset( $payload );

if ( ! in_array( (string) ( $request[\'tool_name\'] ?? \'\' ), array( \'filesystem_write\', \'client/filesystem-write\' ), true ) ) {
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
';
	}

	/** Returns the generated PHP result envelope schema. */
	public static function result_envelope_schema(): string {
		return 'wp-codebox/browser-materialization/v1';
	}

	/** Builds the generated PHP provider transport registration fragment. */
	public static function provider_transport_registration_fragment(): string {
		return WP_Codebox_Agent_Runtime_Invoker::browser_provider_proxy_php();
	}
}
