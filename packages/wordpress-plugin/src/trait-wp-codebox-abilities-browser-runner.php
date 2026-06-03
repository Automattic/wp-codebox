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
	$invocation  = self::browser_runner_invocation( $runner );
	if ( is_wp_error( $invocation ) ) {
		return $invocation;
	}
	$captures = self::browser_runner_capture_paths( $runner );
	if ( is_wp_error( $captures ) ) {
		return $captures;
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

	$permission_filters = array();
	if ( is_array( $invocation['permission_filters'] ?? null ) ) {
		$permission_filters = array_values( array_filter( array_map( static fn( $filter ): string => trim( (string) $filter ), $invocation['permission_filters'] ) ) );
	} else {
		$permission_filter = trim( (string) ( $invocation['permission_filter'] ?? '' ) );
		if ( '' !== $permission_filter ) {
			$permission_filters = array( $permission_filter );
		} elseif ( 'agents/chat' === $name ) {
			$permission_filters = array( 'agents_chat_permission', 'agents_conversation_sessions_permission' );
		}
	}
	foreach ( $permission_filters as $permission_filter ) {
		if ( ! preg_match( '#^[A-Za-z0-9_.:-]+$#', $permission_filter ) ) {
			return new WP_Error( 'wp_codebox_browser_invocation_permission_filter_invalid', 'Browser runner permission filters must be safe WordPress hook names.', array( 'status' => 400 ) );
		}
	}

	return array(
		'type'              => $type,
		'name'              => $name,
		'hook'              => $hook,
		'input'             => is_array( $invocation['input'] ?? null ) ? $invocation['input'] : array(),
		'permission_filter' => (string) ( $permission_filters[0] ?? '' ),
		'permission_filters' => $permission_filters,
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

$task_path = ' . var_export( $task_path, true ) . ';
$result_path = ' . var_export( $result_path, true ) . ';
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

function wp_codebox_browser_discover_artifact_files( array $contract, string $root ): array {
$base = \'/wordpress/wp-content/uploads/studio-web/\' . $root;
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
	);
}

return $files;
}

function wp_codebox_browser_capture_artifact_bundle( array $payload ) {
$contract = wp_codebox_browser_artifact_contract( $payload );
$schema = trim( (string) ( $contract[\'schema\'] ?? \'\' ) );
if ( \'\' === $schema ) {
	return array();
}

$root = (string) ( $contract[\'root\'] ?? \'\' );
$root = rtrim( ltrim( str_replace( chr( 92 ), "/", $root ), "/" ), "/" ) . "/";
if ( \'/\' === $root ) {
	return array();
}
$entrypoint = wp_codebox_browser_safe_artifact_path( (string) ( $contract[\'entrypoint\'] ?? $root . \'index.html\' ), $root );
if ( \'\' === $entrypoint ) {
	return array();
}
$contract_files = is_array( $contract[\'files\'] ?? null ) ? $contract[\'files\'] : array();
if ( empty( $contract_files ) ) {
	$contract_files = wp_codebox_browser_discover_artifact_files( $contract, $root );
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

function wp_codebox_browser_import_agent_bundles( array $bundle_specs ): array {
if ( empty( $bundle_specs ) ) {
	return array();
}

$imports = array();
foreach ( $bundle_specs as $index => $spec ) {
	if ( ! is_array( $spec ) ) {
		$imports[] = array( \'success\' => false, \'index\' => $index, \'error\' => array( \'code\' => \'agent_bundle_spec_invalid\', \'message\' => \'Agent bundle spec must be an object.\' ) );
		continue;
	}
	$source = isset( $spec[\'source\'] ) ? trim( (string) $spec[\'source\'] ) : \'\';
	$temp_source = \'\';
	if ( \'\' === $source && isset( $spec[\'bundle\'] ) && is_array( $spec[\'bundle\'] ) ) {
		$temp_base = tempnam( sys_get_temp_dir(), \'wp-codebox-agent-bundle-\' );
		if ( false === $temp_base ) {
			$imports[] = array( \'success\' => false, \'index\' => $index, \'error\' => array( \'code\' => \'agent_bundle_temp_failed\', \'message\' => \'Could not create a temporary agent bundle JSON file.\' ) );
			continue;
		}
		$temp_source = $temp_base . \'.json\';
		@rename( $temp_base, $temp_source );
		$json_source = wp_json_encode( $spec[\'bundle\'], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE );
		if ( ! is_string( $json_source ) || false === file_put_contents( $temp_source, $json_source ) ) {
			@unlink( $temp_source );
			$imports[] = array( \'success\' => false, \'index\' => $index, \'error\' => array( \'code\' => \'agent_bundle_write_failed\', \'message\' => \'Could not stage inline agent bundle JSON.\' ) );
			continue;
		}
		$source = $temp_source;
	}
	if ( \'\' === $source ) {
		$imports[] = array( \'success\' => false, \'index\' => $index, \'error\' => array( \'code\' => \'agent_bundle_source_missing\', \'message\' => \'Agent bundle spec requires source or bundle.\' ) );
		continue;
	}

	$input = array( \'source\' => $source, \'on_conflict\' => (string) ( $spec[\'on_conflict\'] ?? \'upgrade\' ) );
	foreach ( array( \'slug\', \'token_env\' ) as $field ) {
		if ( isset( $spec[ $field ] ) && \'\' !== trim( (string) $spec[ $field ] ) ) {
			$input[ $field ] = trim( (string) $spec[ $field ] );
		}
	}
	$input[\'owner_id\'] = isset( $spec[\'owner_id\'] ) && (int) $spec[\'owner_id\'] > 0 ? (int) $spec[\'owner_id\'] : ( get_current_user_id() ?: 1 );
	$result = apply_filters( \'wp_agent_runtime_import_bundle\', null, $spec, $input, $index );
	if ( null === $result ) {
		$result = new WP_Error( \'wp_codebox_agent_bundle_importer_unavailable\', \'No browser runtime agent bundle importer handled this bundle spec.\', array( \'index\' => $index ) );
	}
	if ( \'\' !== $temp_source ) {
		@unlink( $temp_source );
	}
	$imports[] = is_wp_error( $result )
		? array( \'success\' => false, \'index\' => $index, \'source\' => isset( $spec[\'source\'] ) ? $source : \'inline\', \'error\' => array( \'code\' => $result->get_error_code(), \'message\' => $result->get_error_message(), \'data\' => $result->get_error_data() ) )
		: array_merge( array( \'index\' => $index, \'source\' => isset( $spec[\'source\'] ) ? $source : \'inline\' ), is_array( $result ) ? $result : array( \'result\' => $result ) );
}

return $imports;
}

class WP_Codebox_Browser_Filesystem_Write_Tool {
	public function handle_tool_call( array $parameters, array $tool_def = array() ): array {
		$path = str_replace( chr( 92 ), \'/\', (string) ( $parameters[\'path\'] ?? \'\' ) );
		$path = ltrim( preg_replace( \'#/+#\', \'/\', $path ), \'/\' );
		if ( \'\' === $path || str_contains( $path, \'..\' ) || ! str_starts_with( $path, \'website/\' ) ) {
			return array( \'success\' => false, \'error\' => \'Path must stay inside the website artifact bundle root.\' );
		}

		$content = (string) ( $parameters[\'content\'] ?? \'\' );
		if ( \'base64\' === (string) ( $parameters[\'encoding\'] ?? \'utf-8\' ) ) {
			$decoded = base64_decode( $content, true );
			if ( false === $decoded ) {
				return array( \'success\' => false, \'error\' => \'Base64 content could not be decoded.\' );
			}
			$content = $decoded;
		}

		$absolute = \'/wordpress/wp-content/uploads/studio-web/\' . $path;
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

add_filter( \'datamachine_resolved_tools\', function ( array $tools, $mode, array $args ) {
	$tools[\'filesystem-write\'] = array(
		\'name\'        => \'filesystem-write\',
		\'description\' => \'Write one generated website artifact file inside /wordpress/wp-content/uploads/studio-web/website/. Call this once per file, including website/index.html and any CSS, JavaScript, metadata, or product JSON files.\',
		\'class\'       => \'WP_Codebox_Browser_Filesystem_Write_Tool\',
		\'method\'      => \'handle_tool_call\',
		\'parameters\'  => array(
			\'type\'       => \'object\',
			\'required\'   => array( \'path\', \'content\' ),
			\'properties\' => array(
				\'path\'     => array( \'type\' => \'string\', \'description\' => \'Relative artifact path under website/, for example website/index.html or website/styles.css.\' ),
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

$agent = sanitize_key( (string) ( $payload[\'agent\'] ?? \'wp-codebox-sandbox\' ) );
$message = (string) ( $payload[\'message\'] ?? ( $payload[\'task_input\'][\'goal\'] ?? \'\' ) );
$session_id = (string) ( $payload[\'session_id\'] ?? ' . var_export( $session_id, true ) . ' );
$agent_bundle_imports = array();
$base_input = array(
\'agent\' => $agent,
\'message\' => $message,
\'user_id\' => ( function_exists( \'get_current_user_id\' ) ? get_current_user_id() : 0 ) ?: 1,
\'provider\' => (string) ( $payload[\'provider\'] ?? \'\' ),
\'model\' => (string) ( $payload[\'model\'] ?? \'\' ),
\'session_owner\' => array(
	\'type\' => \'browser-playground\',
	\'key\' => $session_id,
	\'label\' => \'WP Codebox Browser Playground\',
),
\'client_context\' => array(
	\'source\' => \'peer-agent\',
	\'client_name\' => \'wp-codebox-browser-runner\',
	\'peer_agent_call\' => true,
	\'caller_session_id\' => $session_id,
	\'task_input\' => $payload[\'task_input\'] ?? array(),
),
);
$input = array_replace_recursive( $base_input, is_array( $invocation[\'input\'] ?? null ) ? $invocation[\'input\'] : array() );
$invocation_type = (string) ( $invocation[\'type\'] ?? \'ability\' );
$permission_filters = is_array( $invocation[\'permission_filters\'] ?? null ) ? $invocation[\'permission_filters\'] : array_filter( array( (string) ( $invocation[\'permission_filter\'] ?? \'\' ) ) );

if ( ! $wp_codebox_is_playground ) {
$response = new WP_Error(
	\'wp_codebox_browser_runner_not_playground\',
	\'The browser agent runner permission bypass is only allowed inside the disposable WordPress Playground sandbox.\',
	array(
		\'execution_scope\' => \'disposable-playground\',
		\'permission_model\' => \'sandbox-bypass\',
		\'detected_root\' => $wp_codebox_playground_root,
		\'detected_php_os_family\' => PHP_OS_FAMILY,
	)
);
} else {
$agent_bundle_imports = wp_codebox_browser_import_agent_bundles( is_array( $payload[\'agent_bundles\'] ?? null ) ? $payload[\'agent_bundles\'] : array() );
foreach ( $permission_filters as $permission_filter ) {
	add_filter( (string) $permission_filter, \'__return_true\', 999 );
}

try {
	$failed_imports = array_filter( $agent_bundle_imports, static fn( $import ) => is_array( $import ) && empty( $import[\'success\'] ) );
	if ( ! empty( $failed_imports ) ) {
		$response = new WP_Error( \'wp_codebox_agent_bundle_import_failed\', \'One or more Data Machine agent bundles failed to import before sandbox invocation.\', array( \'agent_bundle_imports\' => array_values( $failed_imports ) ) );
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
	foreach ( $permission_filters as $permission_filter ) {
		remove_filter( (string) $permission_filter, \'__return_true\', 999 );
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
		\'permission_model\' => \'sandbox-bypass\',
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
		\'permission_model\' => \'sandbox-bypass\',
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
