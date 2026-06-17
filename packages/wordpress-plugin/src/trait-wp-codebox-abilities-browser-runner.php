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

	$runner_php      = self::browser_agent_runner_php( $task_input, $session_id, $task_path, $result_path, $invocation, $captures );
	$runner_contract = self::browser_agent_runner_contract( $runner_php );

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
						'code=' . $runner_php,
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
			'runner_contract' => $runner_contract,
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

/** @param array<string,mixed> $task_input Normalized task input. @return array<string,mixed> */
private static function browser_runner_component_manifest( array $task_input ): array {
	$providers = array();
	foreach ( is_array( $task_input['provider_plugin_paths'] ?? null ) ? $task_input['provider_plugin_paths'] : array() as $path ) {
		$path = (string) $path;
		if ( '' === $path ) {
			continue;
		}

		$providers[] = array(
			'slug'   => basename( $path ),
			'source' => $path,
		);
	}

	$components = array();
	foreach ( is_array( $task_input['component_contracts'] ?? null ) ? $task_input['component_contracts'] : array() as $index => $contract ) {
		if ( ! is_array( $contract ) ) {
			continue;
		}

		$path = (string) ( $contract['path'] ?? '' );
		$components[] = array_filter(
			array(
				'slug'          => (string) ( $contract['slug'] ?? ( '' !== $path ? basename( $path ) : '' ) ),
				'source'        => $path,
				'loadAs'        => (string) ( $contract['loadAs'] ?? 'mu-plugin' ),
				'activate'      => isset( $contract['activate'] ) ? (bool) $contract['activate'] : null,
				'contractIndex' => $index,
				'requestedPath' => $path,
			),
			static fn( mixed $value ): bool => null !== $value && '' !== $value
		);
	}

	return array(
		'schema'     => 'wp-codebox/component-manifest/v1',
		'components' => $components,
		'providers'  => $providers,
	);
}

private static function browser_agent_runner_php( array $task_input, string $session_id, string $task_path, string $result_path, array $invocation, array $captures ): string {
	$default_payload = array(
		'agent'      => 'wp-codebox-sandbox',
		'message'    => (string) $task_input['goal'],
		'session_id' => $session_id,
		'task_input' => $task_input,
		'component_manifest' => self::browser_runner_component_manifest( $task_input ),
		'artifacts'  => array(),
	);
	$default_invocation = $invocation;
	$default_captures   = $captures;

		return WP_Codebox_Browser_Runner_Template::bootstrap_fragment( $task_path, $result_path, $default_payload, $default_invocation, $default_captures ) . WP_Codebox_Agent_Runtime_Invoker::browser_runtime_php() . '
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
' . WP_Codebox_Browser_Runner_Template::artifact_capture_policy_fragment( self::BROWSER_CAPTURE_MAX_BYTES ) . '
' . WP_Codebox_Browser_Runner_Template::runtime_event_sink_fragment() . '
' . WP_Codebox_Browser_Runner_Template::provider_transport_registration_fragment() . '
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

function wp_codebox_browser_required_artifact_error( array $payload, array $artifact_bundle, array $diagnostics ) {
$contract = wp_codebox_browser_artifact_contract( $payload );
$schema = trim( (string) ( $contract[\'schema\'] ?? \'\' ) );
if ( \'\' === $schema || ! empty( $artifact_bundle ) ) {
	return null;
}

$artifact_capture = is_array( $diagnostics[\'artifact_capture\'] ?? null ) ? $diagnostics[\'artifact_capture\'] : wp_codebox_browser_artifact_capture_diagnostics( $payload, $artifact_bundle );
return new WP_Error(
	\'wp_codebox_browser_artifact_bundle_missing\',
	\'The browser runner completed without capturing the required artifact bundle. Ensure the agent writes the contracted entrypoint before completion.\',
	array(
		\'status\' => 424,
		\'contract_schema\' => $schema,
		\'artifact_capture\' => $artifact_capture,
		\'response\' => is_array( $diagnostics[\'response\'] ?? null ) ? $diagnostics[\'response\'] : array(),
	)
);
}
' . WP_Codebox_Browser_Runner_Template::execution_metrics_fragment() . '

function wp_codebox_browser_input_control_diagnostics( array $input ): array {
return array_filter( array(
	\'has_tool_policy\' => is_array( $input[\'tool_policy\'] ?? null ),
	\'tool_policy_mode\' => is_scalar( $input[\'tool_policy\'][\'mode\'] ?? null ) ? (string) $input[\'tool_policy\'][\'mode\'] : null,
	\'tool_policy_tools\' => is_array( $input[\'tool_policy\'][\'tools\'] ?? null ) ? array_values( array_map( \'strval\', $input[\'tool_policy\'][\'tools\'] ) ) : null,
	\'allow_only\' => is_array( $input[\'allow_only\'] ?? null ) ? array_values( array_map( \'strval\', $input[\'allow_only\'] ) ) : null,
	\'completion_required_tool_names\' => is_array( $input[\'completion_assertions\'][\'required_tool_names\'] ?? null ) ? array_values( array_map( \'strval\', $input[\'completion_assertions\'][\'required_tool_names\'] ) ) : null,
) );
}
' . WP_Codebox_Browser_Runner_Template::runtime_tool_registration_fragment() . '
$wp_codebox_playground_root = defined( \'ABSPATH\' ) ? wp_normalize_path( ABSPATH ) : \'\';
$wp_codebox_is_playground = \'/wordpress/\' === $wp_codebox_playground_root && ( \'Emscripten\' === PHP_OS_FAMILY || ( defined( \'WP_CODEBOX_BROWSER_PLAYGROUND_RUNNER\' ) && WP_CODEBOX_BROWSER_PLAYGROUND_RUNNER ) );

$runtime_lifecycle = wp_codebox_browser_runtime_replay_ability_lifecycle();

if ( is_readable( $task_path ) ) {
$raw_payload = json_decode( (string) file_get_contents( $task_path ), true );
if ( is_array( $raw_payload ) ) {
	$payload = array_replace_recursive( $payload, $raw_payload );
}
}

$wp_codebox_browser_artifact_environment = wp_codebox_browser_artifact_environment( $payload );
$provider_proxy_diagnostics = wp_codebox_browser_install_provider_proxy( $payload );
$ability_tool_resolution = wp_codebox_browser_runtime_ability_tool_declarations( $payload );
$wp_codebox_browser_runtime_ability_tools = is_array( $ability_tool_resolution[\'tools\'] ?? null ) ? $ability_tool_resolution[\'tools\'] : array();
add_filter( \'datamachine_ability_tools\', function ( array $tools ) use ( &$wp_codebox_browser_runtime_ability_tools ): array {
	return array_merge( $tools, $wp_codebox_browser_runtime_ability_tools );
}, 20, 1 );
$ability_tool_diagnostics = wp_codebox_browser_runtime_ability_tool_diagnostics( $wp_codebox_browser_runtime_ability_tools );

$session_id = (string) ( $payload[\'session_id\'] ?? ' . var_export( $session_id, true ) . ' );
$agent_bundle_imports = array();
$runtime_invocation_preflight = array();
$sandbox_tool_ids = array();
$sandbox_policy = is_array( $payload[\'task_input\'][\'sandbox_tool_policy\'] ?? null ) ? $payload[\'task_input\'][\'sandbox_tool_policy\'] : array();
foreach ( is_array( $sandbox_policy[\'tools\'] ?? null ) ? $sandbox_policy[\'tools\'] : array() as $tool_policy_entry ) {
	if ( ! is_array( $tool_policy_entry ) || empty( $tool_policy_entry[\'allowed\'] ) ) {
		continue;
	}
	$tool_id = trim( (string) ( $tool_policy_entry[\'id\'] ?? \'\' ) );
	$runtime_tool_id = trim( (string) ( $tool_policy_entry[\'runtime_tool_id\'] ?? \'\' ) );
	$tool_name = wp_codebox_browser_runtime_tool_name( \'\' !== $runtime_tool_id ? $runtime_tool_id : $tool_id );
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
$ability_tool_ids = array_values( array_map( \'strval\', array_keys( $wp_codebox_browser_runtime_ability_tools ) ) );
$allowed_tool_ids = array_values( array_unique( array_merge( $sandbox_tool_ids, $ability_tool_ids ) ) );
$input = wp_codebox_browser_runtime_prepare_input( $payload, $invocation, $session_id, $runtime_tool_declarations, $wp_codebox_browser_runtime_ability_tools, $allowed_tool_ids, $sandbox_tool_ids );
$event_sink_attached = false;

$event_sink = wp_codebox_browser_runtime_event_sink( $event_path, $input, $payload );
if ( null !== $event_sink ) {
	file_put_contents( $event_path, "" );
	$input[\'event_sink\'] = $event_sink;
	$event_sink_attached = true;
}
$invocation_type = (string) ( $invocation[\'type\'] ?? \'ability\' );

/* WP_CODEBOX_BROWSER_RUNNER_BODY_START */
$runtime_invocation = wp_codebox_browser_runtime_invoke_agent_task( $payload, $invocation, $input, $session_id, $wp_codebox_is_playground, $wp_codebox_playground_root );
$response = $runtime_invocation[\'response\'] ?? null;
$agent_bundle_imports = is_array( $runtime_invocation[\'agent_bundle_imports\'] ?? null ) ? $runtime_invocation[\'agent_bundle_imports\'] : array();
$runtime_invocation_preflight = is_array( $runtime_invocation[\'preflight\'] ?? null ) ? $runtime_invocation[\'preflight\'] : array();

/* WP_CODEBOX_BROWSER_RUNNER_BODY_END */
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
\'runtime_invocation\' => $runtime_invocation_preflight,
\'event_stream\' => array(
	\'path\' => $event_path,
	\'sink_attached\' => $event_sink_attached,
	\'exists\' => is_readable( $event_path ),
	\'size\' => is_readable( $event_path ) ? filesize( $event_path ) : 0,
),
\'provider_proxy\' => $provider_proxy_diagnostics,
\'sandbox_tool_ids\' => $sandbox_tool_ids,
\'ability_tools\' => $ability_tool_diagnostics,
\'ability_tool_declaration_errors\' => is_array( $ability_tool_resolution[\'invalid\'] ?? null ) ? $ability_tool_resolution[\'invalid\'] : array(),
\'allowed_tool_ids\' => $allowed_tool_ids,
\'runtime_lifecycle\' => $runtime_lifecycle,
\'input_controls\' => wp_codebox_browser_input_control_diagnostics( is_array( $input ?? null ) ? $input : array() ),
\'artifact_capture\' => wp_codebox_browser_artifact_capture_diagnostics( $payload, $artifact_bundle ),
\'response\' => wp_codebox_browser_response_diagnostics( $response ?? null ),
);
if ( ! is_wp_error( $response ?? null ) && ! ( ( $response ?? null ) instanceof Throwable ) ) {
	$artifact_error = wp_codebox_browser_required_artifact_error( $payload, $artifact_bundle, $diagnostics );
	if ( is_wp_error( $artifact_error ) ) {
		$response = $artifact_error;
	}
}
$execution_metrics = wp_codebox_browser_execution_metrics( $payload, $invocation_metadata, $captures, $artifact_bundle, $diagnostics, $response ?? null, $started_monotonic );
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
		\'schema\' => \'' . WP_Codebox_Browser_Runner_Template::result_envelope_schema() . '\',
		\'status\' => \'error\',
		\'session_id\' => $session_id,
		\'execution_scope\' => \'disposable-playground\',
		\'permission_model\' => \'runtime-principal\',
		\'invocation\' => $invocation_metadata,
		\'captures\' => $captures,
		\'diagnostics\' => $diagnostics,
		\'execution_metrics\' => $execution_metrics,
		\'error\' => $error,
		\'errors\' => array( $error ),
		\'provenance\' => $provenance,
);
} else {
$result = array(
		\'success\' => true,
		\'schema\' => \'' . WP_Codebox_Browser_Runner_Template::result_envelope_schema() . '\',
		\'status\' => \'completed\',
		\'session_id\' => $session_id,
		\'execution_scope\' => \'disposable-playground\',
		\'permission_model\' => \'runtime-principal\',
		\'invocation\' => $invocation_metadata,
		\'task_input\' => $payload[\'task_input\'] ?? array(),
		\'response\' => $response,
		\'captures\' => $captures,
		\'diagnostics\' => $diagnostics,
		\'execution_metrics\' => $execution_metrics,
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

/** @return array<string,string> */
private static function browser_agent_runner_contract( string $runner_php ): array {
	$body_start = '/* WP_CODEBOX_BROWSER_RUNNER_BODY_START */';
	$body_end   = '/* WP_CODEBOX_BROWSER_RUNNER_BODY_END */';
	$start_pos  = strpos( $runner_php, $body_start );
	$end_pos    = strpos( $runner_php, $body_end );

	if ( false === $start_pos || false === $end_pos || $end_pos <= $start_pos ) {
		return array(
			'schema' => 'wp-codebox/browser-runner-contract/v1',
		);
	}

	return array(
		'schema'      => 'wp-codebox/browser-runner-contract/v1',
		'php_prelude' => substr( $runner_php, 0, $start_pos ),
		'php_footer'  => substr( $runner_php, $end_pos + strlen( $body_end ) ),
	);
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
