<?php
/**
 * Pure-PHP smoke for the WP Codebox WordPress plugin ability surface.
 *
 * Run: php tests/smoke-wordpress-plugin.php
 */

declare( strict_types=1 );

if ( ! defined( 'ABSPATH' ) ) {
	define( 'ABSPATH', sys_get_temp_dir() . '/wp-codebox-wordpress-plugin/' );
}

$plugin_bundle_root = sys_get_temp_dir() . '/wp-codebox-wordpress-plugin-bundle-' . getmypid();
if ( ! defined( 'WP_CODEBOX_PLUGIN_PATH' ) ) {
	define( 'WP_CODEBOX_PLUGIN_PATH', $plugin_bundle_root . '/wp-codebox/' );
}

if ( ! class_exists( 'WP_Ability' ) ) {
	class WP_Ability {}
}

if ( ! class_exists( 'WP_Error' ) ) {
	class WP_Error {
		public function __construct( private string $code = '', private string $message = '', private array $data = array() ) {}
		public function get_error_code(): string { return $this->code; }
		public function get_error_message(): string { return $this->message; }
		public function get_error_data(): array { return $this->data; }
	}
}

if ( ! class_exists( 'WP_CLI' ) ) {
	class WP_CLI {
		public static function add_command( string $name, callable $callable ): void { $GLOBALS['wp_codebox_cli_commands'][ $name ] = $callable; }
		public static function line( string $message ): void { $GLOBALS['wp_codebox_cli_lines'][] = $message; }
		public static function warning( string $message ): void { $GLOBALS['wp_codebox_cli_warnings'][] = $message; }
		public static function error( string $message ): void { throw new RuntimeException( $message ); }
	}
}

if ( ! class_exists( 'WP_Post' ) ) {
	class WP_Post {
		public function __construct( public int $ID, public string $post_type, public string $post_status, public string $post_name, public string $post_title, public string $post_content = '', public string $post_excerpt = '', public string $post_mime_type = '' ) {}
	}
}

if ( ! class_exists( 'WP_Term' ) ) {
	class WP_Term {
		public function __construct( public int $term_id, public string $taxonomy, public string $slug, public string $name, public string $description = '' ) {}
	}
}

if ( ! class_exists( 'WP_User' ) ) {
	class WP_User {
		public function __construct( public int $ID, public string $display_name, public array $roles ) {}
	}
}

if ( ! function_exists( 'is_wp_error' ) ) {
	function is_wp_error( $thing ): bool { return $thing instanceof WP_Error; }
}

$GLOBALS['wp_codebox_registered_abilities']         = array();
$GLOBALS['wp_codebox_registered_ability_categories'] = array();
$GLOBALS['wp_codebox_actions']                      = array();
$GLOBALS['wp_codebox_did_actions']                  = array();
$GLOBALS['wp_codebox_current_action']              = null;
$GLOBALS['wp_codebox_filters']                      = array();
$GLOBALS['wp_codebox_mock_abilities']              = array();
$GLOBALS['wp_codebox_options']                      = array();
$GLOBALS['wp_codebox_site_options']                 = array();
$GLOBALS['wp_codebox_cli_commands']                 = array();
$GLOBALS['wp_codebox_cli_lines']                    = array();
$GLOBALS['wp_codebox_cli_warnings']                 = array();

function wp_register_ability( string $name, array $definition ): void {
	if ( isset( $definition['category'] ) && ! isset( $GLOBALS['wp_codebox_registered_ability_categories'][ $definition['category'] ] ) ) {
		return;
	}

	$GLOBALS['wp_codebox_registered_abilities'][ $name ] = $definition;
}

function wp_register_ability_category( string $slug, array $args ): void {
	if ( ! doing_action( 'wp_abilities_api_categories_init' ) ) {
		return;
	}

	$GLOBALS['wp_codebox_registered_ability_categories'][ $slug ] = $args;
}
function wp_get_ability( string $name ): mixed { return $GLOBALS['wp_codebox_mock_abilities'][ $name ] ?? null; }

function doing_action( string $hook ): bool {
	return $hook === $GLOBALS['wp_codebox_current_action'];
}
function did_action( string $hook ): int { return (int) ( $GLOBALS['wp_codebox_did_actions'][ $hook ] ?? 0 ); }
function add_action( string $hook, callable $callback, int $priority = 10 ): void {
	$GLOBALS['wp_codebox_actions'][ $hook ][ $priority ][] = $callback;
}
function do_action( string $hook ): void {
	$previous_action = $GLOBALS['wp_codebox_current_action'];
	$GLOBALS['wp_codebox_current_action'] = $hook;
	$GLOBALS['wp_codebox_did_actions'][ $hook ] = (int) ( $GLOBALS['wp_codebox_did_actions'][ $hook ] ?? 0 ) + 1;
	$callbacks = $GLOBALS['wp_codebox_actions'][ $hook ] ?? array();
	ksort( $callbacks );
	foreach ( $callbacks as $priority_callbacks ) {
		foreach ( $priority_callbacks as $callback ) {
			$callback();
		}
	}
	$GLOBALS['wp_codebox_current_action'] = $previous_action;
}
function add_filter( string $hook, callable $callback, int $priority = 10 ): void { $GLOBALS['wp_codebox_filters'][ $hook ] = $callback; }
function has_filter( string $hook ): bool { return array_key_exists( $hook, $GLOBALS['wp_codebox_filters'] ); }
function current_user_can( string $capability ): bool { return 'manage_options' === $capability && ( $GLOBALS['wp_codebox_current_user_can_manage_options'] ?? true ); }
function apply_filters( string $hook, mixed $value, mixed ...$args ): mixed {
	if ( ! array_key_exists( $hook, $GLOBALS['wp_codebox_filters'] ) ) {
		return $value;
	}

	$filter = $GLOBALS['wp_codebox_filters'][ $hook ];
	if ( is_callable( $filter ) ) {
		return $filter( $value, ...$args );
	}

	return $filter;
}
function wp_codebox_smoke_sandbox_tool_policy( array $tools ): array {
	$entries = array();
	foreach ( $tools as $tool => $attributes ) {
		$attributes = is_array( $attributes ) ? $attributes : array();
		$execution_location = (string) ( $attributes['execution_location'] ?? 'sandbox' );
		$transport_visibility = (string) ( $attributes['transport_visibility'] ?? 'sandbox' );
		$entries[] = array(
			'id'                   => (string) $tool,
			'runtime_tool_id'      => (string) ( $attributes['runtime_tool_id'] ?? str_replace( array( 'datamachine/', '-', '.' ), array( '', '_', '_' ), (string) $tool ) ),
			'execution_location'   => $execution_location,
			'transport_visibility' => $transport_visibility,
			'allowed'              => (bool) ( $attributes['allowed'] ?? true ),
			'runtime'              => array(
				'environment'      => 'sandbox' === $execution_location ? 'runtime_local' : 'control_plane',
				'capability_scope' => in_array( $transport_visibility, array( 'sandbox', 'both' ), true ) ? 'runtime_local' : 'control_plane',
			),
		);
	}

	return array(
		'schema'   => 'wp-codebox/sandbox-tool-policy/v1',
		'version'  => 1,
		'tools'    => $entries,
		'metadata' => array( 'source' => 'smoke' ),
	);
}
function wp_parse_url( string $url ): array|false { return parse_url( $url ); }
function wp_json_encode( mixed $value, int $flags = 0, int $depth = 512 ): string|false { return json_encode( $value, $flags, $depth ); }
function wp_safe_remote_get( string $url, array $args = array() ): array|WP_Error {
	$GLOBALS['wp_codebox_remote_gets'][] = array( 'url' => $url, 'args' => $args );
	return $GLOBALS['wp_codebox_remote_responses'][ $url ] ?? new WP_Error( 'not_found', 'Remote URL not mocked.' );
}
function wp_remote_retrieve_response_code( array $response ): int { return (int) ( $response['response']['code'] ?? 0 ); }
function wp_remote_retrieve_body( array $response ): string { return (string) ( $response['body'] ?? '' ); }
function is_multisite(): bool { return (bool) ( $GLOBALS['wp_codebox_is_multisite'] ?? false ); }
function get_option( string $name, mixed $default = null ): mixed { return $GLOBALS['wp_codebox_options'][ $name ] ?? $default; }
function get_site_option( string $name, mixed $default = null ): mixed { return $GLOBALS['wp_codebox_site_options'][ $name ] ?? $default; }
function home_url( string $path = '' ): string { return 'https://parent.example.test' . $path; }
function wp_upload_dir(): array { return $GLOBALS['wp_codebox_upload_dir']; }
function sanitize_key( string $key ): string { return strtolower( preg_replace( '/[^a-zA-Z0-9_\-]/', '', $key ) ?? '' ); }
function sanitize_title( string $title ): string { return strtolower( preg_replace( '/[^a-zA-Z0-9_\-]/', '-', $title ) ?? '' ); }
function sanitize_text_field( string $text ): string { return trim( preg_replace( '/[\r\n\t]+/', ' ', $text ) ?? '' ); }
function wp_normalize_path( string $path ): string { return str_replace( '\\', '/', $path ); }
function absint( mixed $value ): int { return abs( (int) $value ); }
function get_stylesheet(): string { return 'twentytwentyfive'; }
function get_posts( array $args ): array {
	if ( 'attachment' === ( $args['post_type'] ?? '' ) ) {
		return array( new WP_Post( 5, 'attachment', 'inherit', 'seed-image', 'Seed Image', '', '', 'image/png' ) );
	}

	return array( new WP_Post( 7, 'page', 'publish', 'seed-page', 'Seed Page', '<!-- wp:paragraph --><p>Seeded</p><!-- /wp:paragraph -->' ) );
}
function get_terms( array $args ): array { return array( new WP_Term( 3, 'category', 'seed-category', 'Seed Category' ) ); }
function get_users( array $args ): array { return array( new WP_User( 11, 'Private User', array( 'editor' ) ) ); }

require __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-task-input-contract.php';
require __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-agent-task.php';
require __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-inheritance.php';
require __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-agent-sandbox-runner.php';
require __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-artifacts.php';
require __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-data-machine-pending-actions.php';
require __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-preview-options.php';
require __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-abilities.php';
require __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-cli-command.php';

$source_root            = dirname( __DIR__ );
$browser_runtime_source = (string) file_get_contents( $source_root . '/packages/wordpress-plugin/assets/browser-runtime.js' );
$root                   = sys_get_temp_dir() . '/wp-codebox-wordpress-plugin-' . getmypid();
foreach ( array( 'agents-api', 'data-machine', 'data-machine-code', 'plugin-root/agents-api', 'ai-provider-test', 'ai-provider-inherited', 'editable-plugin', 'artifacts', 'artifact-network-root', 'theme-package' ) as $dir ) {
	mkdir( $root . '/' . $dir, 0777, true );
}
$GLOBALS['wp_codebox_upload_dir'] = array(
	'basedir' => $root . '/uploads',
	'baseurl' => 'https://parent.example.test/uploads',
);
mkdir( $GLOBALS['wp_codebox_upload_dir']['basedir'], 0777, true );
foreach ( array( 'agents-api', 'data-machine', 'data-machine-code' ) as $component_slug ) {
	file_put_contents( $root . '/' . $component_slug . '/' . $component_slug . '.php', '<?php /* ' . $component_slug . ' */' );
}
foreach ( array( 'ai-provider-test', 'ai-provider-inherited' ) as $provider_slug ) {
	file_put_contents( $root . '/' . $provider_slug . '/' . $provider_slug . '.php', '<?php /* Plugin Name: ' . $provider_slug . ' */' );
}
file_put_contents( $root . '/wp-codebox.js', "#!/usr/bin/env node\n" );
file_put_contents( $root . '/theme-package/style.css', '/* Theme Name: Packaged Starter */' );
file_put_contents( $root . '/theme-package/index.php', '<?php echo "packaged starter";' );
mkdir( WP_CODEBOX_PLUGIN_PATH . 'vendor/wp-codebox-cli/bin', 0777, true );
mkdir( WP_CODEBOX_PLUGIN_PATH . 'vendor/wp-codebox-cli/vendor/node/bin', 0777, true );
file_put_contents( WP_CODEBOX_PLUGIN_PATH . 'vendor/wp-codebox-cli/bin/wp-codebox', "#!/usr/bin/env bash\n" );
file_put_contents( WP_CODEBOX_PLUGIN_PATH . 'vendor/wp-codebox-cli/vendor/node/bin/node', "#!/usr/bin/env bash\n" );
chmod( WP_CODEBOX_PLUGIN_PATH . 'vendor/wp-codebox-cli/bin/wp-codebox', 0755 );
chmod( WP_CODEBOX_PLUGIN_PATH . 'vendor/wp-codebox-cli/vendor/node/bin/node', 0755 );
if ( ! defined( 'WP_PLUGIN_DIR' ) ) {
	define( 'WP_PLUGIN_DIR', $root . '/plugin-root' );
}

$failures = array();
$total    = 0;
$assert   = function ( string $label, bool $condition ) use ( &$failures, &$total ): void {
	++$total;
	if ( $condition ) {
		echo "  ok {$label}\n";
		return;
	}

	$failures[] = $label;
	echo "  fail {$label}\n";
};

$preview_fixture = json_decode( file_get_contents( __DIR__ . '/../contracts/preview-options.fixture.json' ), true );
$assert( 'preview option schema matches shared fixture', WP_Codebox_Preview_Options::input_schema() === $preview_fixture['options'] );
foreach ( $preview_fixture['cases'] as $preview_case ) {
	$normalized = WP_Codebox_Preview_Options::normalize( $preview_case['input'] );
	if ( $preview_case['valid'] ) {
		$assert( 'preview fixture valid: ' . $preview_case['name'], ! is_wp_error( $normalized ) && $normalized === $preview_case['normalized'] );
	} else {
		$assert( 'preview fixture invalid: ' . $preview_case['name'], is_wp_error( $normalized ) && $preview_case['code'] === $normalized->get_error_code() );
	}
}

$stable_json = function ( mixed $value ) use ( &$stable_json ): string {
	if ( ! is_array( $value ) ) {
		return json_encode( $value, JSON_UNESCAPED_SLASHES );
	}

	if ( array_is_list( $value ) ) {
		return '[' . implode( ',', array_map( $stable_json, $value ) ) . ']';
	}

	ksort( $value, SORT_STRING );
	$parts = array();
	foreach ( $value as $key => $item ) {
		$parts[] = json_encode( (string) $key, JSON_UNESCAPED_SLASHES ) . ':' . $stable_json( $item );
	}

	return '{' . implode( ',', $parts ) . '}';
};

$task_input_fixtures = json_decode( (string) file_get_contents( __DIR__ . '/fixtures/task-input-normalization.json' ), true );
$task_input_fixtures = is_array( $task_input_fixtures ) ? $task_input_fixtures : array();
$task_input_fixture_by_name = array();
foreach ( $task_input_fixtures as $fixture ) {
	if ( is_array( $fixture ) && isset( $fixture['name'] ) ) {
		$task_input_fixture_by_name[ (string) $fixture['name'] ] = $fixture;
	}
}

$manifest_self_hash = function ( array $manifest ) use ( $stable_json ): string {
	foreach ( $manifest['files'] as &$file ) {
		if ( 'manifest.json' === ( $file['path'] ?? '' ) ) {
			$file['sha256'] = array( 'algorithm' => 'sha256', 'value' => str_repeat( '0', 64 ) );
		}
	}
	unset( $file );

	return hash( 'sha256', "wp-codebox/artifact-manifest-self/v1\n" . $stable_json( $manifest ) );
};

$copy_directory = function ( string $source, string $destination ) use ( &$copy_directory ): void {
	mkdir( $destination, 0777, true );
	foreach ( scandir( $source ) ?: array() as $entry ) {
		if ( '.' === $entry || '..' === $entry ) {
			continue;
		}

		$source_path      = $source . '/' . $entry;
		$destination_path = $destination . '/' . $entry;
		if ( is_dir( $source_path ) ) {
			$copy_directory( $source_path, $destination_path );
			continue;
		}

		copy( $source_path, $destination_path );
	}
};

$refresh_manifest_hashes = function ( string $bundle_path ) use ( $manifest_self_hash ): void {
	$manifest_path = $bundle_path . '/manifest.json';
	$manifest      = json_decode( (string) file_get_contents( $manifest_path ), true );
	foreach ( $manifest['files'] as &$manifest_file ) {
		if ( 'manifest.json' !== $manifest_file['path'] ) {
			$manifest_file['sha256'] = array( 'algorithm' => 'sha256', 'value' => hash_file( 'sha256', $bundle_path . '/' . $manifest_file['path'] ) );
		}
	}
	unset( $manifest_file );
	foreach ( $manifest['files'] as &$manifest_file ) {
		if ( 'manifest.json' === $manifest_file['path'] ) {
			$manifest_file['sha256'] = array( 'algorithm' => 'sha256', 'value' => $manifest_self_hash( $manifest ) );
		}
	}
	unset( $manifest_file );
	file_put_contents( $manifest_path, json_encode( $manifest, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES ) . "\n" );
};

$violation_codes = static function ( WP_Error $error ): array {
	$data       = $error->get_error_data();
	$violations = is_array( $data['violations'] ?? null ) ? $data['violations'] : array();

	return array_values( array_filter( array_map( static fn( mixed $violation ): string => is_array( $violation ) ? (string) ( $violation['code'] ?? '' ) : '', $violations ) ) );
};

echo "WP Codebox WordPress plugin - smoke\n";

new WP_Codebox_Data_Machine_Pending_Actions();
new WP_Codebox_Abilities();
WP_Codebox_CLI_Command::register();

do_action( 'wp_abilities_api_init' );
$assert( 'ability registration waits for category registration', ! isset( $GLOBALS['wp_codebox_registered_abilities']['wp-codebox/run-agent-task'] ) );

do_action( 'wp_abilities_api_categories_init' );
do_action( 'wp_abilities_api_init' );

$category = $GLOBALS['wp_codebox_registered_ability_categories']['wp-codebox'] ?? null;
$assert( 'wp-codebox ability category registered', is_array( $category ) );
$assert( 'category exposes label and description', isset( $category['label'] ) && isset( $category['description'] ) );

$cli_commands = $GLOBALS['wp_codebox_cli_commands'];
$assert( 'wp codebox artifacts list command registered', is_callable( $cli_commands['codebox artifacts list'] ?? null ) );
$assert( 'wp codebox artifacts get command registered', is_callable( $cli_commands['codebox artifacts get'] ?? null ) );
$assert( 'wp codebox artifacts preflight-apply command registered', is_callable( $cli_commands['codebox artifacts preflight-apply'] ?? null ) );
$assert( 'wp codebox artifacts stage-apply command registered', is_callable( $cli_commands['codebox artifacts stage-apply'] ?? null ) );
$assert( 'wp codebox artifacts apply command registered', is_callable( $cli_commands['codebox artifacts apply'] ?? null ) );
$assert( 'wp codebox browser-session create command registered', is_callable( $cli_commands['codebox browser-session create'] ?? null ) );
$assert( 'wp codebox run-agent-task command registered', is_callable( $cli_commands['codebox run-agent-task'] ?? null ) );
$assert( 'wp codebox run-agent-task-fanout command registered', is_callable( $cli_commands['codebox run-agent-task-fanout'] ?? null ) );

$ability = $GLOBALS['wp_codebox_registered_abilities']['wp-codebox/run-agent-task'] ?? null;
$assert( 'run-agent-task ability registered', is_array( $ability ) );
$assert( 'ability is REST visible', true === ( $ability['meta']['show_in_rest'] ?? false ) );
$assert( 'ability requires canonical goal input', array( 'goal' ) === ( $ability['input_schema']['required'] ?? array() ) && ! isset( $ability['input_schema']['properties']['task'] ) );
$assert( 'ability exposes task target schema', isset( $ability['input_schema']['properties']['target']['properties']['kind'] ) );
$assert( 'ability exposes canonical task input metadata schema', 'wp-codebox/task-input/v1' === ( $ability['output_schema']['properties']['task_input']['properties']['schema']['const'] ?? '' ) && 1 === ( $ability['output_schema']['properties']['task_input']['properties']['version']['const'] ?? 0 ) );
$assert( 'ability exposes allowed tools schema', 'array' === ( $ability['input_schema']['properties']['allowed_tools']['type'] ?? '' ) );
$assert( 'ability exposes sandbox tool policy schema', 'object' === ( $ability['input_schema']['properties']['sandbox_tool_policy']['type'] ?? '' ) );
$assert( 'ability exposes expected artifacts schema', 'array' === ( $ability['input_schema']['properties']['expected_artifacts']['type'] ?? '' ) );
$assert( 'ability exposes policy and context schema', 'object' === ( $ability['input_schema']['properties']['policy']['type'] ?? '' ) && 'object' === ( $ability['input_schema']['properties']['context']['type'] ?? '' ) );
$assert( 'ability exposes generic mounts schema', 'array' === ( $ability['input_schema']['properties']['mounts']['type'] ?? '' ) && 'object' === ( $ability['input_schema']['properties']['mounts']['items']['properties']['metadata']['type'] ?? '' ) );
$assert( 'ability exposes generic component contracts schema', 'array' === ( $ability['input_schema']['properties']['component_contracts']['type'] ?? '' ) && 'object' === ( $ability['input_schema']['properties']['component_contracts']['items']['properties']['readiness_probe']['type'] ?? '' ) );
$assert( 'ability exposes bounded parent-site seed schema', 'array' === ( $ability['input_schema']['properties']['site_seeds']['type'] ?? '' ) && array( 'parent_site' ) === ( $ability['input_schema']['properties']['site_seeds']['items']['properties']['type']['enum'] ?? array() ) );
$assert( 'ability exposes inheritance request schema', 'object' === ( $ability['input_schema']['properties']['inherit']['type'] ?? '' ) && 'array' === ( $ability['input_schema']['properties']['inherit']['properties']['connectors']['type'] ?? '' ) );
$assert( 'ability exposes connector credential envelope schema', 'object' === ( $ability['input_schema']['properties']['inherit']['properties']['credentials']['type'] ?? '' ) && 'array' === ( $ability['input_schema']['properties']['inherit']['properties']['credentials']['properties']['secrets']['type'] ?? '' ) );
$assert( 'ability exposes external sandbox session schema', 'string' === ( $ability['input_schema']['properties']['sandbox_session_id']['type'] ?? '' ) && 'object' === ( $ability['input_schema']['properties']['orchestrator']['type'] ?? '' ) && 'object' === ( $ability['output_schema']['properties']['session']['type'] ?? '' ) );
$assert( 'session schema pins external orchestrator persistence', array( 'external-orchestrator' ) === ( $ability['output_schema']['properties']['session']['properties']['persistence']['enum'] ?? array() ) && str_contains( $ability['output_schema']['properties']['session']['properties']['persistence']['description'] ?? '', 'does not persist' ) );
$assert( 'session schema keeps durable lifecycle external', array( 'ready', 'completed' ) === ( $ability['output_schema']['properties']['session']['properties']['status']['enum'] ?? array() ) && str_contains( $ability['output_schema']['properties']['session']['properties']['status']['description'] ?? '', 'external orchestrator' ) );
$assert( 'ability exposes preview configuration schema', 'integer' === ( $ability['input_schema']['properties']['preview_port']['type'] ?? '' ) && 'string' === ( $ability['input_schema']['properties']['preview_bind']['type'] ?? '' ) && 'string' === ( $ability['input_schema']['properties']['preview_public_url']['type'] ?? '' ) );
$assert( 'ability exposes strict remediation outcome schema', isset( $ability['output_schema']['properties']['outcome']['properties']['kind']['enum'] ) && in_array( 'provider_error', $ability['output_schema']['properties']['outcome']['properties']['kind']['enum'], true ) );
$assert( 'ability exposes generic completion outcome schema', isset( $ability['output_schema']['properties']['completion_outcome']['properties']['status']['enum'] ) && in_array( 'blocked', $ability['output_schema']['properties']['completion_outcome']['properties']['status']['enum'], true ) );
$assert( 'ability omits raw code input', ! isset( $ability['input_schema']['properties']['code'] ) && ! isset( $ability['input_schema']['properties']['code_file'] ) );
$assert( 'permission defaults to manage_options', true === call_user_func( $ability['permission_callback'] ) );

$batch_ability = $GLOBALS['wp_codebox_registered_abilities']['wp-codebox/run-agent-task-batch'] ?? null;
$assert( 'run-agent-task-batch ability registered', is_array( $batch_ability ) );
$assert( 'batch ability is REST visible', true === ( $batch_ability['meta']['show_in_rest'] ?? false ) );
$assert( 'batch ability requires tasks', array( 'tasks' ) === ( $batch_ability['input_schema']['required'] ?? array() ) );
$assert( 'batch ability exposes preview configuration schema', 'integer' === ( $batch_ability['input_schema']['properties']['preview_port']['type'] ?? '' ) && 'string' === ( $batch_ability['input_schema']['properties']['preview_bind']['type'] ?? '' ) && 'string' === ( $batch_ability['input_schema']['properties']['preview_public_url']['type'] ?? '' ) );
$assert( 'batch ability contract does not expose unimplemented concurrency', ! isset( $batch_ability['input_schema']['properties']['concurrency'] ) && ! isset( $batch_ability['output_schema']['properties']['concurrency'] ) );
$assert( 'batch ability exposes per-task run outputs', isset( $batch_ability['output_schema']['properties']['runs']['items']['properties']['artifact_id'] ) && isset( $batch_ability['output_schema']['properties']['runs']['items']['properties']['preview_url'] ) && isset( $batch_ability['output_schema']['properties']['runs']['items']['properties']['error'] ) );

$fanout_ability = $GLOBALS['wp_codebox_registered_abilities']['wp-codebox/run-agent-task-fanout'] ?? null;
$assert( 'run-agent-task-fanout ability registered', is_array( $fanout_ability ) );
$assert( 'fanout ability is REST visible', true === ( $fanout_ability['meta']['show_in_rest'] ?? false ) );
$assert( 'fanout ability requires workers and exposes concurrency', array( 'workers' ) === ( $fanout_ability['input_schema']['required'] ?? array() ) && 'integer' === ( $fanout_ability['input_schema']['properties']['concurrency']['type'] ?? '' ) );
$assert( 'fanout ability exposes canonical request and worker schemas', 'wp-codebox/agent-fanout-request/v1' === ( $fanout_ability['input_schema']['properties']['schema']['const'] ?? '' ) && 'wp-codebox/agent-fanout-worker/v1' === ( $fanout_ability['input_schema']['properties']['workers']['items']['properties']['schema']['const'] ?? '' ) );
$assert( 'fanout ability output exposes parent child rollup fields', isset( $fanout_ability['output_schema']['properties']['completed'] ) && isset( $fanout_ability['output_schema']['properties']['cancelled'] ) && isset( $fanout_ability['output_schema']['properties']['failures'] ) && isset( $fanout_ability['output_schema']['properties']['runs'] ) );
$assert( 'fanout ability pins result and artifact event references', 'wp-codebox/agent-fanout-result/v1' === ( $fanout_ability['output_schema']['properties']['schema']['const'] ?? '' ) && 'wp-codebox/agent-fanout-artifacts/v1' === ( $fanout_ability['output_schema']['properties']['artifacts']['properties']['schema']['const'] ?? '' ) && 'string' === ( $fanout_ability['output_schema']['properties']['artifacts']['properties']['events']['type'] ?? '' ) );

$host_delegation_ability = $GLOBALS['wp_codebox_registered_abilities']['wp-codebox/request-host-delegation'] ?? null;
$assert( 'host delegation ability registered', is_array( $host_delegation_ability ) );
$assert( 'host delegation ability is REST visible', true === ( $host_delegation_ability['meta']['show_in_rest'] ?? false ) );
$assert( 'host delegation ability exposes canonical request and result schemas', 'wp-codebox/host-delegation-request/v1' === ( $host_delegation_ability['input_schema']['properties']['schema']['const'] ?? '' ) && 'wp-codebox/host-delegation-result/v1' === ( $host_delegation_ability['output_schema']['properties']['schema']['const'] ?? '' ) && array( 'unavailable', 'accepted', 'completed', 'failed' ) === ( $host_delegation_ability['output_schema']['properties']['status']['enum'] ?? array() ) );
$host_delegation_unavailable = call_user_func(
	$host_delegation_ability['execute_callback'],
	array(
		'schema'     => 'wp-codebox/host-delegation-request/v1',
		'request_id' => 'host-delegation-unavailable',
		'goal'       => 'Run this on the host if available.',
	)
);
$assert( 'host delegation returns structured unavailable result without provider', ! is_wp_error( $host_delegation_unavailable ) && false === ( $host_delegation_unavailable['success'] ?? true ) && 'unavailable' === ( $host_delegation_unavailable['status'] ?? '' ) && 'wp_codebox_host_delegation_unavailable' === ( $host_delegation_unavailable['error']['code'] ?? '' ) && array( 'host-delegation.requested', 'host-delegation.unavailable' ) === array_map( static fn( array $event ): string => (string) ( $event['event'] ?? '' ), $host_delegation_unavailable['events'] ?? array() ) );

$browser_session_ability = $GLOBALS['wp_codebox_registered_abilities']['wp-codebox/create-browser-playground-session'] ?? null;
$assert( 'browser Playground session ability registered', is_array( $browser_session_ability ) );
$assert( 'browser Playground session ability is REST visible', true === ( $browser_session_ability['meta']['show_in_rest'] ?? false ) );
$assert( 'browser Playground session requires canonical goal input', array( 'goal' ) === ( $browser_session_ability['input_schema']['required'] ?? array() ) && ! isset( $browser_session_ability['input_schema']['properties']['task'] ) );
$assert( 'browser Playground session exposes artifact file schema', 'array' === ( $browser_session_ability['input_schema']['properties']['artifact_files']['type'] ?? '' ) );
$assert( 'browser Playground session exposes site blueprint artifact schema', 'object' === ( $browser_session_ability['input_schema']['properties']['site_blueprint_artifact']['type'] ?? '' ) && 'object' === ( $browser_session_ability['input_schema']['properties']['site_blueprint_artifact']['properties']['blueprint']['type'] ?? '' ) );
$assert( 'browser Playground session declares site blueprint artifact output', 'object' === ( $browser_session_ability['output_schema']['properties']['site_blueprint_artifact']['type'] ?? '' ) );
$assert( 'browser Playground session exposes explicit trusted orchestrator authorization schema', 'object' === ( $browser_session_ability['input_schema']['properties']['authorization']['type'] ?? '' ) && array( 'browser-session:create' ) === ( $browser_session_ability['input_schema']['properties']['authorization']['properties']['scope']['enum'] ?? array() ) );
$assert( 'browser Playground session exposes non-secret agent bundle import principal schema', 'object' === ( $browser_session_ability['input_schema']['properties']['agent_bundles']['items']['properties']['import_principal']['type'] ?? '' ) );
$assert( 'browser Playground session output declares browser execution', array( 'browser-playground' ) === ( $browser_session_ability['output_schema']['properties']['execution']['enum'] ?? array() ) );
$assert( 'browser Playground session exposes generic sandbox invocation schema', array( 'ability', 'task' ) === ( $browser_session_ability['input_schema']['properties']['browser_runner']['properties']['invocation']['properties']['type']['enum'] ?? array() ) && 'string' === ( $browser_session_ability['input_schema']['properties']['browser_runner']['properties']['invocation']['properties']['hook']['type'] ?? '' ) );
$assert( 'browser Playground session exposes generic capture path schema', 'array' === ( $browser_session_ability['input_schema']['properties']['browser_runner']['properties']['capture_paths']['type'] ?? '' ) && 'integer' === ( $browser_session_ability['input_schema']['properties']['browser_runner']['properties']['capture_paths']['items']['properties']['max_bytes']['type'] ?? '' ) && 'object' === ( $browser_session_ability['output_schema']['properties']['materialization']['type'] ?? '' ) );

$browser_materializer_ability = $GLOBALS['wp_codebox_registered_abilities']['wp-codebox/create-browser-materializer-contract'] ?? null;
$assert( 'browser materializer contract ability registered', is_array( $browser_materializer_ability ) );
$assert( 'browser materializer contract ability is REST visible', true === ( $browser_materializer_ability['meta']['show_in_rest'] ?? false ) );
$assert( 'browser materializer contract requires canonical goal input', array( 'goal' ) === ( $browser_materializer_ability['input_schema']['required'] ?? array() ) && ! isset( $browser_materializer_ability['input_schema']['properties']['task'] ) );
$assert( 'browser materializer contract exposes recipe materialization authorization and compact output', 'object' === ( $browser_materializer_ability['output_schema']['properties']['recipe']['type'] ?? '' ) && 'object' === ( $browser_materializer_ability['output_schema']['properties']['materialization']['type'] ?? '' ) && 'object' === ( $browser_materializer_ability['output_schema']['properties']['authorization']['type'] ?? '' ) && 'object' === ( $browser_materializer_ability['output_schema']['properties']['compact']['type'] ?? '' ) );

$browser_task_contract_ability = $GLOBALS['wp_codebox_registered_abilities']['wp-codebox/create-browser-task-contract'] ?? null;
$assert( 'browser task contract ability registered', is_array( $browser_task_contract_ability ) );
$assert( 'browser task contract ability is REST visible', true === ( $browser_task_contract_ability['meta']['show_in_rest'] ?? false ) );
$assert( 'browser task contract requires canonical goal input', array( 'goal' ) === ( $browser_task_contract_ability['input_schema']['required'] ?? array() ) && ! isset( $browser_task_contract_ability['input_schema']['properties']['task'] ) );
$browser_task_phase_kinds = $browser_task_contract_ability['input_schema']['properties']['phases']['items']['properties']['kind']['enum'] ?? array();
$assert( 'browser task contract exposes phase and compact schema', 'array' === ( $browser_task_contract_ability['input_schema']['properties']['phases']['type'] ?? '' ) && in_array( 'materializer', $browser_task_phase_kinds, true ) && in_array( 'agent', $browser_task_phase_kinds, true ) && in_array( 'aggregator', $browser_task_phase_kinds, true ) && in_array( 'host-delegation', $browser_task_phase_kinds, true ) && 'array' === ( $browser_task_contract_ability['output_schema']['properties']['phases']['type'] ?? '' ) && 'object' === ( $browser_task_contract_ability['output_schema']['properties']['compact']['type'] ?? '' ) );
$assert( 'browser task contract exposes explicit host-side phase execution flag', 'boolean' === ( $browser_task_contract_ability['input_schema']['properties']['execute_phases']['type'] ?? '' ) && false === ( $browser_task_contract_ability['input_schema']['properties']['execute_phases']['default'] ?? null ) );

$agents_api_executor_targets = apply_filters( 'agents_api_executor_targets', array() );
$wp_agent_executor_targets = apply_filters( 'wp_agent_executor_targets', array() );
$assert( 'Agents API executor registry advertises browser and host targets', isset( $agents_api_executor_targets['wp-codebox/browser-playground'] ) && isset( $agents_api_executor_targets['wp-codebox/host-playground'] ) );
$assert( 'WP Agent executor registry alias advertises browser and host targets', isset( $wp_agent_executor_targets['wp-codebox/browser-playground'] ) && isset( $wp_agent_executor_targets['wp-codebox/host-playground'] ) );
$assert( 'Agents API browser executor target delegates to browser task contract shape', 'wp-codebox/browser-playground' === ( $agents_api_executor_targets['wp-codebox/browser-playground']['id'] ?? '' ) && ! isset( $agents_api_executor_targets['wp-codebox/browser-playground']['legacy_abilities'] ) && 'wp-codebox/browser-task-contract/v1' === ( $agents_api_executor_targets['wp-codebox/browser-playground']['output_schema']['properties']['schema']['const'] ?? '' ) );
$assert( 'Agents API host executor target delegates to host sandbox result shape', 'wp-codebox/host-playground' === ( $agents_api_executor_targets['wp-codebox/host-playground']['id'] ?? '' ) && ! isset( $agents_api_executor_targets['wp-codebox/host-playground']['legacy_abilities'] ) );
$assert( 'Agents API executor targets accept only generic task input schema', 'agents-api/task-input/v1' === ( $agents_api_executor_targets['wp-codebox/browser-playground']['input_schema']['properties']['schema']['const'] ?? '' ) && ! isset( $agents_api_executor_targets['wp-codebox/browser-playground']['input_schema']['x-wp-codebox-accepted-schemas'] ) );
$sentinel_executor_result = array( 'schema' => 'sentinel/result' );
$assert( 'Agents API executor dispatch leaves unrelated targets untouched', $sentinel_executor_result === apply_filters( 'agents_api_execute_task', $sentinel_executor_result, array( 'goal' => 'Ignore unrelated target.' ), 'other/executor' ) );

$browser_connector_ability = $GLOBALS['wp_codebox_registered_abilities']['wp-codebox/browser-connector-request'] ?? null;
$assert( 'browser connector request ability registered', is_array( $browser_connector_ability ) );
$assert( 'browser connector request ability is REST visible', true === ( $browser_connector_ability['meta']['show_in_rest'] ?? false ) );
$assert( 'browser connector request uses canonical schemas', 'wp-codebox/browser-connector-request/v1' === ( $browser_connector_ability['input_schema']['properties']['schema']['const'] ?? '' ) && 'wp-codebox/browser-connector-response/v1' === ( $browser_connector_ability['output_schema']['properties']['schema']['const'] ?? '' ) );
$assert( 'browser connector request uses connector-specific authorization scope', array( 'browser-connector:request' ) === ( $browser_connector_ability['input_schema']['properties']['authorization']['properties']['scope']['enum'] ?? array() ) );

$browser_provider_ability = $GLOBALS['wp_codebox_registered_abilities']['wp-codebox/execute-browser-provider-request'] ?? null;
$assert( 'browser provider request ability registered', is_array( $browser_provider_ability ) );
$assert( 'browser provider request ability is REST visible', true === ( $browser_provider_ability['meta']['show_in_rest'] ?? false ) );
$assert( 'browser provider request requires connector-scoped input', array( 'operation', 'request', 'inherit' ) === ( $browser_provider_ability['input_schema']['required'] ?? array() ) && 'object' === ( $browser_provider_ability['input_schema']['properties']['inherit']['type'] ?? '' ) );
$assert( 'browser provider request exposes redacted response envelope schema', 'wp-codebox/browser-provider-adapter-response/v1' === ( $browser_provider_ability['output_schema']['properties']['schema']['const'] ?? '' ) && 'object' === ( $browser_provider_ability['output_schema']['properties']['audit']['type'] ?? '' ) );

$trusted_browser_authorization = array(
	'authorization' => array(
		'schema' => 'wp-codebox/trusted-orchestrator-authorization/v1',
		'caller' => 'studio-web',
		'scope'  => 'browser-session:create',
	),
);
$GLOBALS['wp_codebox_filters']['wp_codebox_trusted_browser_session_callers'] = array( 'studio-web' => array( 'browser-session:create', 'artifact:write' ) );
$GLOBALS['wp_codebox_current_user_can_manage_options'] = false;
$assert( 'browser Playground session keeps default protection for untrusted users', false === call_user_func( $browser_session_ability['permission_callback'], array( 'goal' => 'Denied without trusted caller.' ) ) );
$assert( 'browser Playground session allows trusted orchestrator caller with browser-session scope', true === call_user_func( $browser_session_ability['permission_callback'], $trusted_browser_authorization ) );
$assert( 'browser Playground session denies untrusted orchestrator caller', false === call_user_func( $browser_session_ability['permission_callback'], array( 'authorization' => array( 'caller' => 'unknown-product', 'scope' => 'browser-session:create' ) ) ) );
$assert( 'browser Playground session denies trusted caller without browser-session scope', false === call_user_func( $browser_session_ability['permission_callback'], array( 'authorization' => array( 'caller' => 'studio-web', 'scope' => 'artifact:write' ) ) ) );
$assert( 'browser materializer contract reuses trusted browser-session authorization', true === call_user_func( $browser_materializer_ability['permission_callback'], $trusted_browser_authorization ) && false === call_user_func( $browser_materializer_ability['permission_callback'], array( 'authorization' => array( 'caller' => 'studio-web', 'scope' => 'artifact:write' ) ) ) );
$assert( 'browser task contract reuses trusted browser-session authorization', true === call_user_func( $browser_task_contract_ability['permission_callback'], $trusted_browser_authorization ) && false === call_user_func( $browser_task_contract_ability['permission_callback'], array( 'authorization' => array( 'caller' => 'studio-web', 'scope' => 'artifact:write' ) ) ) );
$assert( 'browser provider request reuses trusted browser-session authorization', true === call_user_func( $browser_provider_ability['permission_callback'], $trusted_browser_authorization ) && false === call_user_func( $browser_provider_ability['permission_callback'], array( 'authorization' => array( 'caller' => 'studio-web', 'scope' => 'artifact:write' ) ) ) );
$GLOBALS['wp_codebox_current_user_can_manage_options'] = true;

$GLOBALS['wp_codebox_filters']['wp_codebox_resolve_inheritance'] = function ( array $resolution, array $request ): array {
	$resolution['connectors'] = array(
		array(
			'name'       => $request['connectors'][0] ?? 'primary-ai',
			'status'     => 'resolved',
			'provider'   => 'openai',
			'model'      => 'gpt-5.5',
			'secret_env_values' => array( 'OPENAI_API_KEY' => 'sk-browser-provider-secret' ),
			'credentials' => array(
				'schema'    => 'wp-codebox/connector-credentials/v1',
				'connector' => $request['connectors'][0] ?? 'primary-ai',
				'scope'     => 'connector',
				'status'    => 'available',
				'secrets'   => array(
					array(
						'name'   => 'OPENAI_API_KEY',
						'status' => 'available',
						'value'  => 'sk-browser-provider-secret',
					),
				),
			),
		),
	);

	return $resolution;
};

$provider_missing_adapter = call_user_func(
	$browser_provider_ability['execute_callback'],
	array(
		'operation' => 'chat.completions',
		'inherit'   => array( 'connectors' => array( 'primary-ai' ) ),
		'request'   => array( 'messages' => array( array( 'role' => 'user', 'content' => 'Hello' ) ) ),
	)
);
$assert( 'browser provider request fails closed without adapter', is_wp_error( $provider_missing_adapter ) && 'wp_codebox_browser_provider_adapter_missing' === $provider_missing_adapter->get_error_code() );
$assert( 'browser provider missing-adapter error is redacted', is_wp_error( $provider_missing_adapter ) && ! str_contains( json_encode( $provider_missing_adapter->get_error_data() ), 'sk-browser-provider-secret' ) );

$captured_provider_adapter_request = array();
$GLOBALS['wp_codebox_filters']['wp_codebox_browser_provider_request'] = function ( mixed $response, array $adapter_request ) use ( &$captured_provider_adapter_request ): array {
	$captured_provider_adapter_request = $adapter_request;
	return array(
		'response' => array(
			'id'      => 'provider-response-1',
			'text'    => 'Adapter handled the request.',
			'api_key' => 'sk-browser-provider-secret',
		),
		'audit' => array(
			'token' => 'sk-browser-provider-secret',
		),
	);
};
$provider_adapter_response = call_user_func(
	$browser_provider_ability['execute_callback'],
	array(
		'operation'          => 'chat.completions',
		'inherit'            => array( 'connectors' => array( 'primary-ai' ) ),
		'connector'          => 'primary-ai',
		'sandbox_session_id' => 'browser-session-123',
		'request'            => array(
			'messages' => array( array( 'role' => 'user', 'content' => 'Hello' ) ),
			'api_key'  => 'sk-browser-provider-secret',
		),
	)
);
$provider_adapter_encoded = json_encode( $provider_adapter_response );
$assert( 'browser provider adapter receives generic redacted connector context', ! is_wp_error( $provider_adapter_response ) && 'wp-codebox/browser-provider-adapter-request/v1' === ( $captured_provider_adapter_request['schema'] ?? '' ) && 'openai' === ( $captured_provider_adapter_request['provider'] ?? '' ) && 'gpt-5.5' === ( $captured_provider_adapter_request['model'] ?? '' ) && 'primary-ai' === ( $captured_provider_adapter_request['connector']['name'] ?? '' ) && 'browser-session-123' === ( $captured_provider_adapter_request['context']['session_id'] ?? '' ) );
$assert( 'browser provider adapter request excludes raw provider secrets', ! str_contains( json_encode( $captured_provider_adapter_request ), 'sk-browser-provider-secret' ) && '[redacted]' === ( $captured_provider_adapter_request['request']['api_key'] ?? '' ) );
$assert( 'browser provider response envelope redacts adapter secrets', ! is_wp_error( $provider_adapter_response ) && 'wp-codebox/browser-provider-adapter-response/v1' === ( $provider_adapter_response['schema'] ?? '' ) && ! str_contains( $provider_adapter_encoded, 'sk-browser-provider-secret' ) && '[redacted]' === ( $provider_adapter_response['response']['api_key'] ?? '' ) );
unset( $GLOBALS['wp_codebox_filters']['wp_codebox_resolve_inheritance'], $GLOBALS['wp_codebox_filters']['wp_codebox_browser_provider_request'] );

$artifact_abilities = array(
	'wp-codebox/list-artifacts',
	'wp-codebox/get-artifact',
	'wp-codebox/discard-artifact',
	'wp-codebox/persist-browser-artifact',
	'wp-codebox/review-artifact',
	'wp-codebox/apply-artifact-preflight',
	'wp-codebox/apply-approved-artifact',
	'wp-codebox/stage-artifact-apply',
);
foreach ( $artifact_abilities as $artifact_ability_name ) {
	$artifact_ability = $GLOBALS['wp_codebox_registered_abilities'][ $artifact_ability_name ] ?? null;
	$assert( $artifact_ability_name . ' ability registered', is_array( $artifact_ability ) );
	$assert( $artifact_ability_name . ' is REST visible', true === ( $artifact_ability['meta']['show_in_rest'] ?? false ) );
}
$persist_browser_artifact_ability = $GLOBALS['wp_codebox_registered_abilities']['wp-codebox/persist-browser-artifact'] ?? null;
$assert( 'persist-browser-artifact exposes explicit trusted orchestrator authorization schema', is_array( $persist_browser_artifact_ability ) && 'object' === ( $persist_browser_artifact_ability['input_schema']['properties']['authorization']['type'] ?? '' ) && array( 'artifact:write' ) === ( $persist_browser_artifact_ability['input_schema']['properties']['authorization']['properties']['scope']['enum'] ?? array() ) );
$trusted_artifact_authorization = array(
	'authorization' => array(
		'schema' => 'wp-codebox/trusted-orchestrator-authorization/v1',
		'caller' => 'studio-web',
		'scope'  => 'artifact:write',
	),
);
$GLOBALS['wp_codebox_current_user_can_manage_options'] = false;
$assert( 'persist-browser-artifact keeps default protection for untrusted users', false === call_user_func( $persist_browser_artifact_ability['permission_callback'], array( 'files' => array() ) ) );
$GLOBALS['wp_codebox_filters']['wp_codebox_can_run_agent_task'] = true;
$assert( 'persist-browser-artifact ignores global agent-task bypass without artifact authorization', false === call_user_func( $persist_browser_artifact_ability['permission_callback'], array( 'files' => array() ) ) );
unset( $GLOBALS['wp_codebox_filters']['wp_codebox_can_run_agent_task'] );
$assert( 'persist-browser-artifact allows trusted orchestrator caller with artifact write scope', true === call_user_func( $persist_browser_artifact_ability['permission_callback'], $trusted_artifact_authorization ) );
$assert( 'persist-browser-artifact denies untrusted orchestrator caller', false === call_user_func( $persist_browser_artifact_ability['permission_callback'], array( 'authorization' => array( 'caller' => 'unknown-product', 'scope' => 'artifact:write' ) ) ) );
$assert( 'persist-browser-artifact denies trusted caller without artifact write scope', false === call_user_func( $persist_browser_artifact_ability['permission_callback'], array( 'authorization' => array( 'caller' => 'studio-web', 'scope' => 'browser-session:create' ) ) ) );
$GLOBALS['wp_codebox_current_user_can_manage_options'] = true;

$component_contracts = array(
	array( 'slug' => 'agents-api', 'path' => $root . '/agents-api', 'activate' => false, 'loadAs' => 'mu-plugin', 'readiness_probe' => array( 'type' => 'ability', 'name' => 'agents/chat' ) ),
	array( 'slug' => 'data-machine', 'path' => $root . '/data-machine', 'activate' => false, 'loadAs' => 'mu-plugin' ),
	array( 'slug' => 'data-machine-code', 'path' => $root . '/data-machine-code', 'activate' => false, 'loadAs' => 'mu-plugin' ),
);
$GLOBALS['wp_codebox_filters']['wp_codebox_component_contracts'] = $component_contracts;
// The generic runtime ships no built-in components. A consumer integration
// registers the agent-stack components + their release sources via these
// filters (mirrors how extrachill-roadie wires the Extra Chill platform in).
$GLOBALS['wp_codebox_filters']['wp_codebox_browser_runtime_required_components'] = static function ( array $slugs ): array {
	foreach ( array( 'agents-api', 'data-machine', 'data-machine-code' ) as $required ) {
		if ( ! in_array( $required, $slugs, true ) ) {
			$slugs[] = $required;
		}
	}
	return $slugs;
};
$GLOBALS['wp_codebox_filters']['wp_codebox_browser_runtime_component_registry'] = static function ( array $registry ): array {
	$defaults = array(
		'agents-api'        => 'https://github.com/Automattic/agents-api/releases/latest/download/agents-api.zip',
		'data-machine'      => 'https://github.com/Extra-Chill/data-machine/releases/latest/download/data-machine.zip',
		'data-machine-code' => 'https://github.com/Extra-Chill/data-machine-code/releases/latest/download/data-machine-code.zip',
	);
	foreach ( $defaults as $slug => $url ) {
		if ( isset( $registry[ $slug ] ) ) {
			continue;
		}
		$registry[ $slug ] = array(
			'resource'         => 'url',
			'url'              => $url,
			'targetFolderName' => $slug,
			'activate'         => true,
			'provenance'       => array( 'source' => 'runtime-component-registry' ),
		);
	}
	return $registry;
};
$GLOBALS['wp_codebox_filters']['wp_codebox_bin'] = $root . '/wp-codebox.js';
$GLOBALS['wp_codebox_filters']['wp_codebox_default_agent'] = 'site-coder';
$GLOBALS['wp_codebox_filters']['wp_codebox_default_provider'] = 'openai';
$GLOBALS['wp_codebox_filters']['wp_codebox_default_model'] = 'gpt-5.5';
$GLOBALS['wp_codebox_filters']['wp_codebox_default_secret_env'] = array( 'OPENAI_API_KEY' );
$GLOBALS['wp_codebox_filters']['wp_codebox_browser_plugin_allowed_hosts'] = array( 'example.test', 'downloads.wordpress.org', 'github.com' );
$GLOBALS['wp_codebox_filters']['wp_codebox_browser_theme_allowed_hosts'] = array( 'example.test', 'downloads.wordpress.org' );
$recipe_run_source = file_get_contents( $source_root . '/packages/cli/src/commands/recipe-run.ts' );
$assert( 'recipe extra plugin activation exposes lifecycle hook', false !== $recipe_run_source && str_contains( $recipe_run_source, "do_action('wp_codebox_runtime_plugin_activated', $" . "plugin_file)" ) );
$agent_code_source = file_get_contents( $source_root . '/packages/cli/src/agent-code.ts' );
$assert( 'CLI sandbox delegates runtime bundle imports through generic helper', false !== $agent_code_source && str_contains( $agent_code_source, "wp_agent_import_runtime_bundles" ) && str_contains( $agent_code_source, "apply_filters('wp_agent_runtime_import_bundle'" ) && ! str_contains( $agent_code_source, "wp_get_ability('datamachine/import-agent')" ) && ! str_contains( $agent_code_source, 'DataMachine\\Core\\Database\\Agents\\Agents' ) );
$assert( 'CLI sandbox runs caller runtime tasks through generic ability payload', false !== $agent_code_source && str_contains( $agent_code_source, 'normalizeRuntimeTask' ) && str_contains( $agent_code_source, "'runtime_task_ability_unavailable'" ) && ! str_contains( $agent_code_source, "'datamachine/run-agent-bundle'" ) && ! str_contains( $agent_code_source, 'ExecuteWorkflowAbility' ) );
$assert( 'CLI sandbox preserves runtime bundle import principal without Data Machine permission helper', false !== $agent_code_source && str_contains( $agent_code_source, "'import_principal'" ) && ! str_contains( $agent_code_source, 'DataMachine\\Abilities\\PermissionHelper::run_as_authenticated($execute' ) );
$assert( 'CLI sandbox uses Agents API runtime-principal authorization instead of Data Machine chat mode glue', false !== $agent_code_source && str_contains( $agent_code_source, "agents_chat_runtime_principal_permission" ) && ! str_contains( $agent_code_source, 'datamachine_settings' ) && ! str_contains( $agent_code_source, 'datamachine_agent_modes' ) && ! str_contains( $agent_code_source, 'datamachine_agent_mode_sandbox' ) && ! str_contains( $agent_code_source, 'datamachine_directives' ) && ! str_contains( $agent_code_source, 'WP_Codebox_Sandbox_Perception_Directive' ) );
$assert( 'CLI sandbox materializes the WP Codebox default agent through the generic agent registry', false !== $agent_code_source && str_contains( $agent_code_source, 'wp_codebox_ensure_sandbox_default_agent' ) && str_contains( $agent_code_source, 'AgentRegistry::register' ) && str_contains( $agent_code_source, 'AgentRegistry::reconcile' ) && ! str_contains( $agent_code_source, 'DataMachine\\Core\\Database\\Agents\\Agents' ) );
$GLOBALS['wp_codebox_mock_abilities']['agents/chat'] = new WP_Ability();
$GLOBALS['wp_codebox_remote_responses']['https://github.com/example/generic-runtime-helper/releases/download/v1.0.0/generic-runtime-helper.zip'] = array(
	'response' => array( 'code' => 200 ),
	'body'     => "PK\x03\x04server-packaged-plugin",
);
$GLOBALS['wp_codebox_remote_responses']['https://github.com/example/static-site-importer/releases/download/v1.0.0/static-site-importer.zip'] = array(
	'response' => array( 'code' => 200 ),
	'body'     => "PK\x03\x04static-site-importer",
);
$GLOBALS['wp_codebox_remote_responses']['https://github.com/example/generic-mu-runtime/releases/download/v1.0.0/generic-mu-runtime.zip'] = array(
	'response' => array( 'code' => 200 ),
	'body'     => "PK\x03\x04generic-mu-runtime",
);
$GLOBALS['wp_codebox_remote_responses']['https://github.com/Automattic/agents-api/releases/latest/download/agents-api.zip'] = array(
	'response' => array( 'code' => 200 ),
	'body'     => "PK\x03\x04agents-api",
);
$GLOBALS['wp_codebox_remote_responses']['https://github.com/Extra-Chill/data-machine/releases/latest/download/data-machine.zip'] = array(
	'response' => array( 'code' => 200 ),
	'body'     => "PK\x03\x04data-machine",
);
$GLOBALS['wp_codebox_remote_responses']['https://github.com/Extra-Chill/data-machine-code/releases/latest/download/data-machine-code.zip'] = array(
	'response' => array( 'code' => 200 ),
	'body'     => "PK\x03\x04data-machine-code",
);
mkdir( $root . '/plugin-root/data-machine', 0777, true );
mkdir( $root . '/plugin-root/data-machine-code', 0777, true );
mkdir( $root . '/plugin-root/generic-caller-plugin', 0777, true );
file_put_contents( $root . '/plugin-root/generic-caller-plugin/generic-caller-plugin.php', '<?php /* Plugin Name: Generic Caller Plugin */' );

$browser_session_input = array(
		'goal'                  => 'Prepare a browser Playground preview.',
		'sandbox_session_id'    => 'browser-session-123',
		'target'                => array( 'kind' => 'sandbox-runtime' ),
		'allowed_tools'         => array( 'filesystem-write', 'filesystem-write', '' ),
		'sandbox_tool_policy'   => wp_codebox_smoke_sandbox_tool_policy( array( 'filesystem-write' => array( 'runtime_tool_id' => 'filesystem_write' ) ) ),
		'expected_artifacts'    => array( 'repair-summary', 'changed-files' ),
		'provider_plugin_paths' => array( $root . '/ai-provider-test' ),
		'inherit'               => array( 'connectors' => array( 'openai' ) ),
		'orchestrator'          => array( 'id' => 'example-orchestrator' ),
		'authorization'         => array(
			'schema' => 'wp-codebox/trusted-orchestrator-authorization/v1',
			'caller' => 'studio-web',
			'scope'  => 'browser-session:create',
		),
		'browser_plugins'       => array(
			array(
				'slug'   => 'agents-api',
				'url'    => 'https://example.test/agents-api.zip',
				'sha256' => str_repeat( 'a', 64 ),
			),
		),
		'runtime'               => array(
			'prepared'   => array(
				'enabled' => true,
				'cache_key' => 'known-site-runtime',
			),
			'plugins'    => array(
				array(
					'slug'     => 'generic-runtime-helper',
					'url'      => 'https://github.com/example/generic-runtime-helper/releases/download/v1.0.0/generic-runtime-helper.zip',
					'activate' => false,
				),
				array(
					'slug' => 'static-site-importer',
					'url'  => 'https://github.com/example/static-site-importer/releases/download/v1.0.0/static-site-importer.zip',
				),
				array(
					'slug'    => 'generic-caller-plugin',
					'path'    => $root . '/plugin-root/generic-caller-plugin',
				),
				array(
					'slug'             => 'example-git-plugin',
					'resource'         => 'git:directory',
					'url'              => 'https://github.com/example/example-git-plugin',
					'ref'              => 'main',
					'refType'          => 'branch',
					'path'             => 'plugins/example-git-plugin',
					'targetFolderName' => 'example-git-plugin',
				),
			),
			'mu_plugins' => array(
				array(
					'slug'    => 'caller-runtime',
					'file'    => 'caller-runtime.php',
					'content' => '<?php add_filter( "caller_runtime_task", static function ( $result, $input ) { return array( "summary" => "caller-owned sandbox task ran", "changed_files" => array( "example.php" ), "input" => $input ); }, 10, 2 );',
				),
			),
			'themes'     => array(
				array(
					'slug'     => 'example-starter',
					'activate' => true,
					'files'    => array(
						array(
							'path'    => 'style.css',
							'content' => '/* Theme Name: Example Starter */',
						),
					),
				),
				array(
					'slug'     => 'packaged-starter',
					'path'     => $root . '/theme-package',
					'activate' => false,
				),
			),
			'bootstrap'  => array(
				array(
					'operation' => 'set_option',
					'args'      => array(
						'name'  => 'blogname',
						'value' => 'Browser Preview',
					),
				),
			),
		),
		'browser_runner'       => array(
			'capture_paths' => array(
				array(
					'path'      => '/wordpress/wp-content/uploads/wp-codebox/artifacts/materialization/report.json',
					'name'      => 'materialization-report',
					'kind'      => 'report',
					'mime_type' => 'application/json',
					'max_bytes' => 4096,
				),
			),
			'invocation' => array(
				'type'  => 'task',
				'hook'  => 'caller_runtime_task',
				'input' => array(
					'diagnostics' => array( 'example' => 'ready' ),
				),
			),
		),
		'artifact_files'        => array(
			array(
				'path'    => 'repair-output/index.html',
				'content' => '<main>Preview</main>',
				'kind'    => 'static-html',
			),
			array(
				'path'    => 'repair-output/assets/app.css',
				'content' => 'body { color: #111; }',
				'kind'    => 'stylesheet',
			),
			array(
				'path'    => 'repair-output/assets/app.js',
				'content' => 'console.log( "preview" );',
				'kind'    => 'script',
			),
			array(
				'path'           => 'repair-output/assets/photo.png',
				'content_base64' => base64_encode( "\x89PNG\r\n\x1a\nfixture" ),
				'encoding'       => 'base64',
				'kind'           => 'image',
			),
			array(
				'path'           => 'repair-output/assets/photo.jpg',
				'content_base64' => base64_encode( "\xff\xd8fixture\xff\xd9" ),
				'encoding'       => 'base64',
				'kind'           => 'image',
			),
			array(
				'path'           => 'repair-output/assets/hero.webp',
				'content_base64' => base64_encode( 'RIFFfixtureWEBP' ),
				'encoding'       => 'base64',
				'kind'           => 'image',
			),
			array(
				'path'      => 'repair-output/assets/icon.svg',
				'content'   => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>',
				'mime_type' => 'image/svg+xml',
				'kind'      => 'image',
			),
		),
	);

$browser_session = call_user_func(
	$browser_session_ability['execute_callback'],
	$browser_session_input
);
$assert( 'browser Playground session returns without shelling out', ! is_wp_error( $browser_session ) && true === ( $browser_session['success'] ?? false ) );
$assert( 'browser runtime admin bar operation does not fall through', str_contains( $browser_runtime_source, "'target' => 'frontendAdminBar'" ) && str_contains( $browser_runtime_source, "\n\t\t\tbreak;\n\n\t\tcase 'writeReviewFile':" ) );
$assert( 'browser runtime operation envelopes expose success boolean', str_contains( $browser_runtime_source, 'const success = result?.success === true;' ) && str_contains( $browser_runtime_source, "\n\t\t\tsuccess,\n\t\t\tstatus: success ? 'ok' : 'error'," ) );
$assert( 'browser Playground session schema is stable', ! is_wp_error( $browser_session ) && 'wp-codebox/browser-playground-session/v1' === ( $browser_session['schema'] ?? '' ) );
$assert( 'browser Playground session pins browser execution', ! is_wp_error( $browser_session ) && 'browser-playground' === ( $browser_session['execution'] ?? '' ) );
$assert( 'browser Playground session identifies disposable execution scope', ! is_wp_error( $browser_session ) && 'disposable-playground' === ( $browser_session['execution_scope'] ?? '' ) && 'disposable-playground' === ( $browser_session['session']['execution_scope'] ?? '' ) );
$assert( 'browser Playground session identifies runtime-principal permission model', ! is_wp_error( $browser_session ) && 'runtime-principal' === ( $browser_session['permission_model'] ?? '' ) && 'runtime-principal' === ( $browser_session['session']['permission_model'] ?? '' ) );
$assert( 'browser Playground session emits canonical sandbox session envelope', ! is_wp_error( $browser_session ) && 'wp-codebox/sandbox-session/v1' === ( $browser_session['session']['schema'] ?? '' ) && 'browser-session-123' === ( $browser_session['session']['id'] ?? '' ) && 'ready' === ( $browser_session['session']['status'] ?? '' ) && 'external-orchestrator' === ( $browser_session['session']['persistence'] ?? '' ) );
$assert( 'browser Playground session returns trusted authorization provenance in session envelope', ! is_wp_error( $browser_session ) && 'studio-web' === ( $browser_session['session']['authorization']['caller'] ?? '' ) && 'browser-session:create' === ( $browser_session['session']['authorization']['scope'] ?? '' ) && true === ( $browser_session['session']['authorization']['authorized'] ?? false ) && 'trusted-caller-grant' === ( $browser_session['session']['authorization']['reason'] ?? '' ) );
$assert( 'browser Playground session includes Playground client URLs', ! is_wp_error( $browser_session ) && str_contains( $browser_session['playground']['client_module_url'] ?? '', 'playground.wordpress.net' ) && str_contains( $browser_session['playground']['remote_url'] ?? '', 'playground.wordpress.net' ) );
$assert( 'browser Playground session includes Playground CORS proxy URL', ! is_wp_error( $browser_session ) && 'https://wordpress-playground-cors-proxy.net/?' === ( $browser_session['playground']['cors_proxy_url'] ?? '' ) && 'https://wordpress-playground-cors-proxy.net' === ( $browser_session['playground']['provenance']['cors_proxy_url']['origin'] ?? '' ) );
$assert( 'browser Playground session includes default blueprint', ! is_wp_error( $browser_session ) && true === ( $browser_session['playground']['blueprint']['features']['networking'] ?? false ) && is_array( $browser_session['playground']['blueprint']['steps'] ?? null ) );
$assert( 'browser Playground session defaults to latest WordPress and PHP', ! is_wp_error( $browser_session ) && 'latest' === ( $browser_session['playground']['blueprint']['preferredVersions']['wp'] ?? '' ) && 'latest' === ( $browser_session['playground']['blueprint']['preferredVersions']['php'] ?? '' ) );
$assert( 'browser Playground session logs in before admin workflows', ! is_wp_error( $browser_session ) && 'login' === ( $browser_session['playground']['blueprint']['steps'][0]['step'] ?? '' ) && 'admin' === ( $browser_session['playground']['blueprint']['steps'][0]['username'] ?? '' ) );
$assert( 'browser Playground session installs caller browser plugins without duplicating packaged components', ! is_wp_error( $browser_session ) && 'installPlugin' === ( $browser_session['playground']['blueprint']['steps'][1]['step'] ?? '' ) && 'https://example.test/agents-api.zip' === ( $browser_session['playground']['blueprint']['steps'][1]['pluginData']['url'] ?? '' ) && 1 === count( array_filter( $browser_session['plugins'], static fn( array $plugin ): bool => 'agents-api' === ( $plugin['slug'] ?? '' ) ) ) );
$assert( 'browser Playground session packages required host runtime plugins', ! is_wp_error( $browser_session ) && str_starts_with( (string) ( $browser_session['plugins'][1]['url'] ?? '' ), 'data:application/zip;base64,' ) && str_starts_with( (string) ( $browser_session['plugins'][2]['url'] ?? '' ), 'data:application/zip;base64,' ) && 64 === strlen( (string) ( $browser_session['plugins'][1]['provenance']['sha256'] ?? '' ) ) );
$browser_steps = ! is_wp_error( $browser_session ) ? ( $browser_session['playground']['blueprint']['steps'] ?? array() ) : array();
$browser_plugin_by_slug = static fn( string $slug ): array => array_values( array_filter( $browser_session['plugins'] ?? array(), static fn( array $plugin ): bool => $slug === ( $plugin['slug'] ?? '' ) ) )[0] ?? array();
$browser_step_with_plugin_slug = static fn( string $slug ): array => array_values( array_filter( $browser_steps, static fn( array $step ): bool => $slug === ( $step['options']['targetFolderName'] ?? $step['pluginData']['targetFolderName'] ?? $step['pluginData']['slug'] ?? '' ) ) )[0] ?? array();
$browser_step_with_code = static fn( string $needle ): array => array_values( array_filter( $browser_steps, static fn( array $step ): bool => 'runPHP' === ( $step['step'] ?? '' ) && str_contains( (string) ( $step['code'] ?? '' ), $needle ) ) )[0] ?? array();
$assert( 'browser Playground session accepts structured runtime dependencies', ! is_wp_error( $browser_session ) && 'wp-codebox/browser-runtime-dependencies/v1' === ( $browser_session['runtime']['schema'] ?? '' ) && 8 === ( $browser_session['runtime']['summary']['plugins'] ?? 0 ) && 2 === ( $browser_session['runtime']['component_plugins'] ?? 0 ) && 1 === ( $browser_session['runtime']['summary']['mu_plugins'] ?? 0 ) && 2 === ( $browser_session['runtime']['summary']['themes'] ?? 0 ) && 1 === ( $browser_session['runtime']['summary']['bootstrap'] ?? 0 ) );
$assert( 'browser Playground session server-packages remote runtime plugins after required components', ! is_wp_error( $browser_session ) && str_starts_with( (string) ( $browser_plugin_by_slug( 'generic-runtime-helper' )['url'] ?? '' ), 'data:application/zip;base64,' ) && false === ( $browser_plugin_by_slug( 'generic-runtime-helper' )['activate'] ?? true ) && 'runtime-plugin-remote-package' === ( $browser_plugin_by_slug( 'generic-runtime-helper' )['provenance']['source'] ?? '' ) );
$assert( 'browser Playground session packages release ZIP runtime plugins without exposing source URLs', ! is_wp_error( $browser_session ) && str_starts_with( (string) ( $browser_plugin_by_slug( 'static-site-importer' )['url'] ?? '' ), 'data:application/zip;base64,' ) && ! str_contains( (string) ( $browser_step_with_plugin_slug( 'static-site-importer' )['pluginData']['url'] ?? '' ), 'github.com' ) && 'runtime-plugin-remote-package' === ( $browser_plugin_by_slug( 'static-site-importer' )['provenance']['source'] ?? '' ) );
$assert( 'browser Playground session packages server runtime plugin paths', ! is_wp_error( $browser_session ) && str_starts_with( (string) ( $browser_plugin_by_slug( 'generic-caller-plugin' )['url'] ?? '' ), 'data:application/zip;base64,' ) && 64 === strlen( (string) ( $browser_plugin_by_slug( 'generic-caller-plugin' )['provenance']['sha256'] ?? '' ) ) && 'runtime-plugin-path' === ( $browser_plugin_by_slug( 'generic-caller-plugin' )['provenance']['source'] ?? '' ) );
$assert( 'browser Playground session compiles git directory runtime plugins', ! is_wp_error( $browser_session ) && 'git:directory' === ( $browser_step_with_plugin_slug( 'example-git-plugin' )['pluginData']['resource'] ?? '' ) && 'plugins/example-git-plugin' === ( $browser_step_with_plugin_slug( 'example-git-plugin' )['pluginData']['path'] ?? '' ) && 'example-git-plugin' === ( $browser_step_with_plugin_slug( 'example-git-plugin' )['options']['targetFolderName'] ?? '' ) );
$assert( 'browser Playground session compiles caller mu-plugin runtime dependency', ! is_wp_error( $browser_session ) && str_contains( (string) ( $browser_step_with_code( '/wordpress/wp-content/mu-plugins/caller-runtime.php' )['code'] ?? '' ), 'caller_runtime_task' ) );
$assert( 'browser Playground session compiles theme runtime dependency', ! is_wp_error( $browser_session ) && str_contains( (string) ( $browser_step_with_code( '/wordpress/wp-content/themes/example-starter/style.css' )['code'] ?? '' ), "require_once '/wordpress/wp-load.php'" ) && str_contains( (string) ( $browser_step_with_code( '/wordpress/wp-content/themes/example-starter/style.css' )['code'] ?? '' ), "require_once ABSPATH . WPINC . '/theme.php'" ) && str_contains( (string) ( $browser_step_with_code( '/wordpress/wp-content/themes/example-starter/style.css' )['code'] ?? '' ), "switch_theme( 'example-starter' )" ) );
$packaged_theme = array_values( array_filter( $browser_session['runtime']['themes'] ?? array(), static fn( array $theme ): bool => 'packaged-starter' === ( $theme['slug'] ?? '' ) ) )[0] ?? array();
$assert( 'browser Playground session packages runtime theme paths', ! is_wp_error( $browser_session ) && true === ( $packaged_theme['local_package'] ?? false ) && str_starts_with( (string) ( $packaged_theme['url'] ?? '' ), 'data:application/zip;base64,' ) && 'runtime-theme-path' === ( $packaged_theme['provenance']['source'] ?? '' ) && 64 === strlen( (string) ( $packaged_theme['provenance']['sha256'] ?? '' ) ) );
$assert( 'browser Playground session compiles packaged theme installer', ! is_wp_error( $browser_session ) && str_contains( (string) ( $browser_step_with_code( 'Could not read browser theme package' )['code'] ?? '' ), '/wordpress/wp-content/themes' ) && str_contains( (string) ( $browser_step_with_code( 'Could not read browser theme package' )['code'] ?? '' ), 'Browser theme package hash mismatch' ) );
$assert( 'browser Playground session exposes prepared runtime miss and fallback blueprint', ! is_wp_error( $browser_session ) && 'wp-codebox/browser-prepared-runtime/v1' === ( $browser_session['runtime']['prepared_runtime']['schema'] ?? '' ) && 'miss' === ( $browser_session['runtime']['prepared_runtime']['status'] ?? '' ) && 'fallback' === ( $browser_session['runtime']['prepared_runtime']['selected'] ?? '' ) && 'known-site-runtime' === ( $browser_session['runtime']['prepared_runtime']['cache_key'] ?? '' ) && 64 === strlen( (string) ( $browser_session['runtime']['prepared_runtime']['input_hash'] ?? '' ) ) && isset( $browser_session['playground']['prepared_runtime']['fallback_blueprint']['steps'] ) );
$assert( 'browser Playground session compiles named bootstrap runtime operation', ! is_wp_error( $browser_session ) && str_contains( (string) ( $browser_step_with_code( "update_option( 'blogname', 'Browser Preview' )" )['code'] ?? '' ), "require_once '/wordpress/wp-load.php'" ) );
$assert( 'browser Playground session records trusted origins', ! is_wp_error( $browser_session ) && 'https://playground.wordpress.net' === ( $browser_session['playground']['provenance']['client_module_url']['origin'] ?? '' ) );
$assert( 'browser Playground session records browser plugin provenance', ! is_wp_error( $browser_session ) && 'example.test' === ( $browser_session['plugins'][0]['provenance']['host'] ?? '' ) && str_repeat( 'a', 64 ) === ( $browser_session['plugins'][0]['provenance']['sha256'] ?? '' ) );
$assert( 'browser Playground session includes recipe', ! is_wp_error( $browser_session ) && 'wp-codebox/workspace-recipe/v1' === ( $browser_session['recipe']['schema'] ?? '' ) );
$assert( 'browser Playground recipe uses generic artifact directory', ! is_wp_error( $browser_session ) && '/wordpress/wp-content/uploads/wp-codebox/artifacts' === ( $browser_session['recipe']['artifacts']['directory'] ?? '' ) );
$assert( 'browser Playground recipe invokes caller task inside site', ! is_wp_error( $browser_session ) && 'task' === ( $browser_session['recipe']['browser']['invocation']['type'] ?? '' ) && 'caller_runtime_task' === ( $browser_session['recipe']['browser']['invocation']['hook'] ?? '' ) && str_contains( (string) ( $browser_session['recipe']['workflow']['steps'][0]['args'][0] ?? '' ), 'has_filter( $hook )' ) && str_contains( (string) ( $browser_session['recipe']['workflow']['steps'][0]['args'][0] ?? '' ), 'caller_runtime_task' ) );
$assert( 'browser Playground recipe captures generic output reports', ! is_wp_error( $browser_session ) && '/wordpress/wp-content/uploads/wp-codebox/artifacts/materialization/report.json' === ( $browser_session['recipe']['browser']['captures'][0]['path'] ?? '' ) && 'materialization-report' === ( $browser_session['recipe']['browser']['captures'][0]['name'] ?? '' ) && 4096 === ( $browser_session['recipe']['browser']['captures'][0]['max_bytes'] ?? 0 ) );
$assert( 'browser Playground session exposes materialization descriptor', ! is_wp_error( $browser_session ) && 'wp-codebox/browser-materialization/v1' === ( $browser_session['materialization']['schema'] ?? '' ) && 'pending' === ( $browser_session['materialization']['status'] ?? '' ) && '/tmp/wp-codebox-agent-result.json' === ( $browser_session['materialization']['result_path'] ?? '' ) && 'wp-codebox/browser-materialization-error/v1' === ( $browser_session['materialization']['error_schema'] ?? '' ) );
$assert( 'browser Playground session exposes materialization diagnostics and provenance', ! is_wp_error( $browser_session ) && 2 === ( $browser_session['materialization']['diagnostics']['capture_count'] ?? 0 ) && array() === ( $browser_session['materialization']['errors'] ?? null ) && 'wp-codebox/browser-runner' === ( $browser_session['materialization']['provenance']['generated_by'] ?? '' ) );
$assert( 'browser Playground recipe normalizes captured runner result', ! is_wp_error( $browser_session ) && str_contains( (string) ( $browser_session['recipe']['workflow']['steps'][0]['args'][0] ?? '' ), 'wp_codebox_browser_capture_file' ) && str_contains( (string) ( $browser_session['recipe']['workflow']['steps'][0]['args'][0] ?? '' ), 'wp-codebox/browser-capture/v1' ) && str_contains( (string) ( $browser_session['recipe']['workflow']['steps'][0]['args'][0] ?? '' ), 'wp-codebox/browser-materialization/v1' ) );
$assert( 'browser Playground recipe emits normalized materialization metadata', ! is_wp_error( $browser_session ) && str_contains( (string) ( $browser_session['recipe']['workflow']['steps'][0]['args'][0] ?? '' ), "'diagnostics' => \$diagnostics" ) && str_contains( (string) ( $browser_session['recipe']['workflow']['steps'][0]['args'][0] ?? '' ), "'errors' => array()" ) && str_contains( (string) ( $browser_session['recipe']['workflow']['steps'][0]['args'][0] ?? '' ), "'provenance' => \$provenance" ) );
$assert( 'browser Playground recipe keeps ability invocation path generic', ! is_wp_error( $browser_session ) && str_contains( (string) ( $browser_session['recipe']['workflow']['steps'][0]['args'][0] ?? '' ), 'wp_get_ability( $ability_name )' ) && str_contains( (string) ( $browser_session['recipe']['workflow']['steps'][0]['args'][0] ?? '' ), 'wp_codebox_browser_ability_unavailable' ) );
$assert( 'browser Playground recipe initializes abilities before invocation', ! is_wp_error( $browser_session ) && str_contains( (string) ( $browser_session['recipe']['workflow']['steps'][0]['args'][0] ?? '' ), 'wp_abilities_api_categories_init' ) && str_contains( (string) ( $browser_session['recipe']['workflow']['steps'][0]['args'][0] ?? '' ), 'wp_abilities_api_init' ) );
$assert( 'browser Playground recipe loads WordPress as internal REST runner request', ! is_wp_error( $browser_session ) && str_contains( (string) ( $browser_session['recipe']['workflow']['steps'][0]['args'][0] ?? '' ), "\$_GET['rest_route'] = '/wp-codebox/browser-runner';" ) );
$assert( 'browser Playground recipe installs caller mu-plugin before invocation', ! is_wp_error( $browser_session ) && ! empty( $browser_step_with_code( 'caller_runtime_task' ) ) && str_contains( (string) ( $browser_session['recipe']['workflow']['steps'][0]['args'][0] ?? '' ), 'caller_runtime_task' ) );
$assert( 'browser Playground recipe keeps invocation fixed after parent validation', ! is_wp_error( $browser_session ) && ! str_contains( (string) ( $browser_session['recipe']['workflow']['steps'][0]['args'][0] ?? '' ), '$payload[\'invocation\']' ) );
$assert( 'browser Playground recipe guards runtime-principal authorization to Playground', ! is_wp_error( $browser_session ) && str_contains( (string) ( $browser_session['recipe']['workflow']['steps'][0]['args'][0] ?? '' ), "'/wordpress/' === \$wp_codebox_playground_root" ) && str_contains( (string) ( $browser_session['recipe']['workflow']['steps'][0]['args'][0] ?? '' ), 'WP_CODEBOX_BROWSER_PLAYGROUND_RUNNER' ) && str_contains( (string) ( $browser_session['recipe']['workflow']['steps'][0]['args'][0] ?? '' ), 'wp_codebox_browser_runner_not_playground' ) );

$prepared_hit_input = $browser_session_input;
$prepared_hit_input['runtime']['prepared']['input_hash'] = (string) ( $browser_session['runtime']['prepared_runtime']['input_hash'] ?? '' );
$prepared_hit_input['runtime']['prepared']['blueprint'] = array(
	'steps' => array(
		array(
			'step' => 'runPHP',
			'code' => '<?php echo "prepared runtime restored";',
		),
	),
);
$prepared_hit_session = call_user_func( $browser_session_ability['execute_callback'], $prepared_hit_input );
$assert( 'browser Playground session selects prepared blueprint on hash hit', ! is_wp_error( $prepared_hit_session ) && 'hit' === ( $prepared_hit_session['runtime']['prepared_runtime']['status'] ?? '' ) && 'prepared' === ( $prepared_hit_session['runtime']['prepared_runtime']['selected'] ?? '' ) && 'prepared' === ( $prepared_hit_session['playground']['prepared_runtime']['selected'] ?? '' ) && 1 === count( $prepared_hit_session['playground']['blueprint']['steps'] ?? array() ) && str_contains( (string) ( $prepared_hit_session['playground']['blueprint']['steps'][0]['code'] ?? '' ), 'prepared runtime restored' ) );
$prepared_stale_input = $prepared_hit_input;
$prepared_stale_input['runtime']['prepared']['input_hash'] = str_repeat( '0', 64 );
$prepared_stale_session = call_user_func( $browser_session_ability['execute_callback'], $prepared_stale_input );
$assert( 'browser Playground session invalidates prepared blueprint by input hash', ! is_wp_error( $prepared_stale_session ) && 'miss' === ( $prepared_stale_session['runtime']['prepared_runtime']['status'] ?? '' ) && 'fallback' === ( $prepared_stale_session['runtime']['prepared_runtime']['selected'] ?? '' ) && 'input-hash-mismatch' === ( $prepared_stale_session['runtime']['prepared_runtime']['invalidation']['reason'] ?? '' ) && count( $prepared_stale_session['playground']['blueprint']['steps'] ?? array() ) > 1 );

$browser_materializer_contract = call_user_func(
	$browser_materializer_ability['execute_callback'],
	$browser_session_input
);
$assert( 'browser materializer contract returns recipe-only envelope', ! is_wp_error( $browser_materializer_contract ) && true === ( $browser_materializer_contract['success'] ?? false ) && 'wp-codebox/browser-materializer-contract/v1' === ( $browser_materializer_contract['schema'] ?? '' ) && ! isset( $browser_materializer_contract['session'] ) && 'browser-session-123' === ( $browser_materializer_contract['session_id'] ?? '' ) );
$assert( 'browser materializer contract preserves trusted authorization shape', ! is_wp_error( $browser_materializer_contract ) && ( $browser_session['session']['authorization'] ?? array() ) === ( $browser_materializer_contract['authorization'] ?? array() ) );
$assert( 'browser materializer contract returns same runnable recipe as duplicate session', ! is_wp_error( $browser_materializer_contract ) && ( $browser_session['recipe'] ?? array() ) === ( $browser_materializer_contract['recipe'] ?? array() ) );
$assert( 'browser materializer contract returns same materialization descriptor as duplicate session', ! is_wp_error( $browser_materializer_contract ) && ( $browser_session['materialization'] ?? array() ) === ( $browser_materializer_contract['materialization'] ?? array() ) );
$assert( 'browser materializer contract preserves runnable context for existing browser session', ! is_wp_error( $browser_materializer_contract ) && ( $browser_session['task_payload'] ?? array() ) === ( $browser_materializer_contract['task_payload'] ?? array() ) && ( $browser_session['playground'] ?? array() ) === ( $browser_materializer_contract['playground'] ?? array() ) && ( $browser_session['artifacts'] ?? array() ) === ( $browser_materializer_contract['artifacts'] ?? array() ) );
$browser_materializer_compact_encoded = wp_json_encode( $browser_materializer_contract['compact'] ?? array() );
$assert( 'browser materializer contract exposes compact product DTO with runnable recipe fields', ! is_wp_error( $browser_materializer_contract ) && 'wp-codebox/browser-materializer-product-dto/v1' === ( $browser_materializer_contract['compact']['schema'] ?? '' ) && 'wp-codebox/workspace-recipe/v1' === ( $browser_materializer_contract['compact']['recipe']['schema'] ?? '' ) && isset( $browser_materializer_contract['compact']['recipe']['workflow'] ) && isset( $browser_materializer_contract['compact']['recipe']['browser']['task_path'] ) && isset( $browser_materializer_contract['compact']['task_payload']['schema'] ) );
$assert( 'browser materializer compact DTO omits raw runtime payloads', is_string( $browser_materializer_compact_encoded ) && ! str_contains( $browser_materializer_compact_encoded, '"pluginData"' ) && ! str_contains( $browser_materializer_compact_encoded, '"content"' ) && ! str_contains( $browser_materializer_compact_encoded, '"content_base64"' ) && ! str_contains( $browser_materializer_compact_encoded, 'data:application/zip;base64' ) && ! str_contains( $browser_materializer_compact_encoded, 'sk-browser-provider-secret' ) );

$browser_task_contract_input = array_replace_recursive(
	$browser_session_input,
	array(
		'phases' => array(
			array(
				'name'  => 'static-site-materializer',
				'kind'  => 'materializer',
				'input' => array(
					'goal'           => 'Materialize generated browser artifacts.',
					'browser_runner' => array(
						'task_path'     => '/tmp/materializer-task.json',
						'result_path'   => '/tmp/materializer-result.json',
						'invocation'    => array(
							'type' => 'task',
							'hook' => 'caller_runtime_task',
						),
						'capture_paths' => array(
							array(
								'path'      => '/wordpress/wp-content/uploads/wp-codebox/artifacts/materializer/report.json',
								'name'      => 'phase-report',
								'kind'      => 'report',
								'mime_type' => 'application/json',
								'max_bytes' => 2048,
							),
						),
					),
				),
			),
		),
	)
);
$browser_task_contract = call_user_func(
	$browser_task_contract_ability['execute_callback'],
	$browser_task_contract_input
);
$assert( 'browser task contract returns primary session and phases', ! is_wp_error( $browser_task_contract ) && true === ( $browser_task_contract['success'] ?? false ) && 'wp-codebox/browser-task-contract/v1' === ( $browser_task_contract['schema'] ?? '' ) && 'wp-codebox/browser-playground-session/v1' === ( $browser_task_contract['primary']['schema'] ?? '' ) && 1 === count( $browser_task_contract['phases'] ?? array() ) );
$assert( 'browser task contract preserves primary browser session envelope', ! is_wp_error( $browser_task_contract ) && ( $browser_task_contract['primary']['session'] ?? array() ) === ( $browser_task_contract['session'] ?? array() ) && 'browser-session-123' === ( $browser_task_contract['session']['id'] ?? '' ) );
$assert( 'browser task contract composes named materializer phase contract', ! is_wp_error( $browser_task_contract ) && 'static-site-materializer' === ( $browser_task_contract['phases'][0]['name'] ?? '' ) && 'materializer' === ( $browser_task_contract['phases'][0]['kind'] ?? '' ) && 'wp-codebox/browser-materializer-contract/v1' === ( $browser_task_contract['phases'][0]['contract']['schema'] ?? '' ) );
$assert( 'browser task contract shares parent session id with materializer by default', ! is_wp_error( $browser_task_contract ) && 'browser-session-123' === ( $browser_task_contract['phases'][0]['contract']['session_id'] ?? '' ) && '/tmp/materializer-result.json' === ( $browser_task_contract['phases'][0]['contract']['materialization']['result_path'] ?? '' ) );
$browser_task_compact_encoded = wp_json_encode( $browser_task_contract['compact'] ?? array() );
$assert( 'browser task contract exposes compact product DTO with primary runner fields', ! is_wp_error( $browser_task_contract ) && 'wp-codebox/browser-task-product-dto/v1' === ( $browser_task_contract['compact']['schema'] ?? '' ) && 'wp-codebox/browser-playground-session/v1' === ( $browser_task_contract['compact']['primary']['schema'] ?? '' ) && 'wp-codebox/browser-session-product-dto/v1' === ( $browser_task_contract['compact']['primary']['dto_schema'] ?? '' ) && 'wp-codebox/workspace-recipe/v1' === ( $browser_task_contract['compact']['primary']['recipe']['schema'] ?? '' ) && isset( $browser_task_contract['compact']['primary']['recipe']['workflow'] ) && isset( $browser_task_contract['compact']['primary']['recipe']['browser']['task_path'] ) && isset( $browser_task_contract['compact']['primary']['task_payload']['schema'] ) );
$assert( 'browser task compact DTO preserves named materializer phases', ! is_wp_error( $browser_task_contract ) && 'static-site-materializer' === ( $browser_task_contract['compact']['phases'][0]['name'] ?? '' ) && 'materializer' === ( $browser_task_contract['compact']['phases'][0]['kind'] ?? '' ) && 'wp-codebox/browser-materializer-product-dto/v1' === ( $browser_task_contract['compact']['phases'][0]['contract']['schema'] ?? '' ) && '/tmp/materializer-result.json' === ( $browser_task_contract['compact']['phases'][0]['contract']['materialization']['result_path'] ?? '' ) );
$assert( 'browser task compact DTO omits raw runtime payloads', is_string( $browser_task_compact_encoded ) && ! str_contains( $browser_task_compact_encoded, '"pluginData"' ) && ! str_contains( $browser_task_compact_encoded, '"content"' ) && ! str_contains( $browser_task_compact_encoded, '"content_base64"' ) && ! str_contains( $browser_task_compact_encoded, 'data:application/zip;base64' ) && ! str_contains( $browser_task_compact_encoded, 'sk-browser-provider-secret' ) );

$materializer_task_contract = call_user_func(
	$browser_task_contract_ability['execute_callback'],
	array_replace_recursive(
		$browser_session_input,
		array(
			'materializers' => array(
				array(
					'goal'           => 'Materialize generated browser artifacts through canonical input.',
					'browser_runner' => array(
						'result_path' => '/tmp/materializer-result.json',
					),
				),
			),
		)
	)
);
$assert( 'browser task contract preserves materializer phase input', ! is_wp_error( $materializer_task_contract ) && 1 === count( $materializer_task_contract['phases'] ?? array() ) && 'materializer' === ( $materializer_task_contract['phases'][0]['kind'] ?? '' ) && 'wp-codebox/browser-materializer-contract/v1' === ( $materializer_task_contract['phases'][0]['contract']['schema'] ?? '' ) && '/tmp/materializer-result.json' === ( $materializer_task_contract['phases'][0]['contract']['materialization']['result_path'] ?? '' ) );

$browser_phase_fanout_bin = $root . '/wp-codebox-browser-phase-fanout-fixture';
file_put_contents(
	$browser_phase_fanout_bin,
	 <<<'PHP'
#!/usr/bin/env php
<?php
$artifacts = '';
for ( $i = 1; $i < $argc; $i++ ) {
	if ( '--artifacts' === $argv[ $i ] && isset( $argv[ $i + 1 ] ) ) {
		$artifacts = $argv[ $i + 1 ];
	}
}
if ( '' === $artifacts ) {
	fwrite( STDERR, "missing artifacts\n" );
	exit( 2 );
}
@mkdir( $artifacts, 0777, true );
$worker_id = basename( dirname( $artifacts ) );
echo json_encode(
	array(
		'success' => true,
		'session' => array(
			'artifacts' => array(
				'id' => 'browser-phase-artifact-' . $worker_id,
			),
		),
		'evidence_refs' => array(
			array( 'kind' => 'worker-result', 'uri' => $artifacts . '/result.json' ),
		),
	),
	JSON_UNESCAPED_SLASHES
) . "\n";
PHP
);
chmod( $browser_phase_fanout_bin, 0755 );

$generic_phase_task_contract = call_user_func(
	$browser_task_contract_ability['execute_callback'],
	array_replace_recursive(
		$browser_session_input,
		array(
			'phases' => array(
				array(
					'name'     => 'agent-fanout',
					'kind'     => 'agent',
					'label'    => 'Agent Fanout',
					'status'   => 'queued',
					'metadata' => array(
						'runner' => 'browser-playground',
					),
					'request'  => array(
						'schema'          => 'wp-codebox/agent-fanout-request/v1',
						'concurrency'     => 1,
						'workers'         => array(
							array( 'id' => 'browser_worker', 'goal' => 'Cook the browser phase worker.' ),
						),
						'artifacts_path'  => $root . '/artifacts/browser-phase-fanout-prepare',
						'wp_codebox_bin'  => $browser_phase_fanout_bin,
						'orchestrator'    => array( 'type' => 'browser-task-contract' ),
					),
				),
				array(
					'name'     => 'aggregate-results',
					'kind'     => 'aggregator',
					'label'    => 'Aggregate Results',
					'metadata' => array(
						'inputs' => array( 'agent-fanout' ),
					),
				),
			),
		)
	)
);
$assert( 'browser task contract prepares agent and aggregator phase descriptors without executing host-side fanout', ! is_wp_error( $generic_phase_task_contract ) && 2 === count( $generic_phase_task_contract['phases'] ?? array() ) && 'agent' === ( $generic_phase_task_contract['phases'][0]['kind'] ?? '' ) && 'aggregator' === ( $generic_phase_task_contract['phases'][1]['kind'] ?? '' ) && ! isset( $generic_phase_task_contract['phases'][0]['contract'] ) && ! isset( $generic_phase_task_contract['phases'][0]['result'] ) && 'queued' === ( $generic_phase_task_contract['phases'][0]['status'] ?? '' ) && 'pending' === ( $generic_phase_task_contract['phases'][1]['status'] ?? '' ) && ! is_file( $root . '/artifacts/browser-phase-fanout-prepare/fanout/result.json' ) );
$generic_phase_executed_task_contract = call_user_func(
	$browser_task_contract_ability['execute_callback'],
	array_replace_recursive(
		$browser_session_input,
		array(
			'execute_phases' => true,
			'phases'         => array(
				array(
					'name'     => 'agent-fanout',
					'kind'     => 'agent',
					'label'    => 'Agent Fanout',
					'status'   => 'queued',
					'metadata' => array(
						'runner' => 'browser-playground',
					),
					'request'  => array(
						'schema'          => 'wp-codebox/agent-fanout-request/v1',
						'concurrency'     => 1,
						'workers'         => array(
							array( 'id' => 'browser_worker', 'goal' => 'Cook the browser phase worker.' ),
						),
						'artifacts_path'  => $root . '/artifacts/browser-phase-fanout',
						'wp_codebox_bin'  => $browser_phase_fanout_bin,
						'orchestrator'    => array( 'type' => 'browser-task-contract' ),
					),
				),
				array(
					'name'     => 'aggregate-results',
					'kind'     => 'aggregator',
					'label'    => 'Aggregate Results',
					'metadata' => array(
						'inputs' => array( 'agent-fanout' ),
					),
				),
			),
		)
	)
);
$assert( 'browser task contract executes agent fanout phase requests only when execute_phases is explicit', ! is_wp_error( $generic_phase_executed_task_contract ) && 'completed' === ( $generic_phase_executed_task_contract['phases'][0]['status'] ?? '' ) && 'wp-codebox/agent-fanout-result/v1' === ( $generic_phase_executed_task_contract['phases'][0]['result']['schema'] ?? '' ) && 1 === ( $generic_phase_executed_task_contract['phases'][0]['result']['completed'] ?? 0 ) && is_file( $root . '/artifacts/browser-phase-fanout/fanout/result.json' ) && is_file( $root . '/artifacts/browser-phase-fanout/fanout/events.jsonl' ) );
$assert( 'browser task compact DTO preserves generic phase metadata and explicit fanout result for product UIs', ! is_wp_error( $generic_phase_executed_task_contract ) && 'agent-fanout' === ( $generic_phase_executed_task_contract['compact']['phases'][0]['name'] ?? '' ) && 0 === ( $generic_phase_executed_task_contract['compact']['phases'][0]['index'] ?? null ) && 'Agent Fanout' === ( $generic_phase_executed_task_contract['compact']['phases'][0]['label'] ?? '' ) && 'browser-playground' === ( $generic_phase_executed_task_contract['compact']['phases'][0]['metadata']['runner'] ?? '' ) && 'wp-codebox/agent-fanout-result/v1' === ( $generic_phase_executed_task_contract['compact']['phases'][0]['result']['schema'] ?? '' ) && 'aggregate-results' === ( $generic_phase_executed_task_contract['compact']['phases'][1]['name'] ?? '' ) && 1 === ( $generic_phase_executed_task_contract['compact']['phases'][1]['index'] ?? null ) );

$GLOBALS['wp_codebox_host_delegation_requests'] = array();
add_filter(
	'wp_codebox_host_delegation_request',
	static function ( mixed $result, array $request ): array {
		$GLOBALS['wp_codebox_host_delegation_requests'][] = $request;
		return array(
			'success'  => true,
			'schema'   => 'wp-codebox/host-delegation-result/v1',
			'status'   => 'completed',
			'provider' => 'smoke-host-provider',
			'result'   => array(
				'summary'       => 'Host provider completed the delegated request.',
				'artifact_refs' => array(
					array( 'path' => 'host-delegation/result.json', 'kind' => 'host-delegation-result' ),
				),
			),
			'artifacts' => array(
				'schema' => 'wp-codebox/host-delegation-artifacts/v1',
				'path'   => 'host-delegation',
			),
		);
	}
);
$host_delegation_phase_task_contract = call_user_func(
	$browser_task_contract_ability['execute_callback'],
	array_replace_recursive(
		$browser_session_input,
		array(
			'phases' => array(
				array(
					'name'     => 'server-workspace-offload',
					'kind'     => 'host-delegation',
					'label'    => 'Server Workspace Offload',
					'metadata' => array( 'reason' => 'workspace-required' ),
					'request'  => array(
						'schema'     => 'wp-codebox/host-delegation-request/v1',
						'request_id' => 'host-delegation-phase-1',
						'goal'       => 'Run the workspace phase on a host provider.',
						'execution'  => array( 'capability' => 'workspace-task' ),
						'orchestrator' => array( 'type' => 'browser-task-contract' ),
					),
				),
			),
		)
	)
);
$assert( 'browser task contract prepares host delegation phase requests without executing host providers', ! is_wp_error( $host_delegation_phase_task_contract ) && 0 === count( $GLOBALS['wp_codebox_host_delegation_requests'] ?? array() ) && ! isset( $host_delegation_phase_task_contract['phases'][0]['result'] ) && 'pending' === ( $host_delegation_phase_task_contract['phases'][0]['status'] ?? '' ) );
$host_delegation_phase_executed_task_contract = call_user_func(
	$browser_task_contract_ability['execute_callback'],
	array_replace_recursive(
		$browser_session_input,
		array(
			'execute_phases' => true,
			'phases'         => array(
				array(
					'name'     => 'server-workspace-offload',
					'kind'     => 'host-delegation',
					'label'    => 'Server Workspace Offload',
					'metadata' => array( 'reason' => 'workspace-required' ),
					'request'  => array(
						'schema'     => 'wp-codebox/host-delegation-request/v1',
						'request_id' => 'host-delegation-phase-1',
						'goal'       => 'Run the workspace phase on a host provider.',
						'execution'  => array( 'capability' => 'workspace-task' ),
						'orchestrator' => array( 'type' => 'browser-task-contract' ),
					),
				),
			),
		)
	)
);
$host_delegation_phase_events = ! is_wp_error( $host_delegation_phase_executed_task_contract ) ? array_map( static fn( array $event ): string => (string) ( $event['event'] ?? '' ), $host_delegation_phase_executed_task_contract['phases'][0]['result']['events'] ?? array() ) : array();
$assert( 'browser task contract executes host delegation phase requests only when execute_phases is explicit', ! is_wp_error( $host_delegation_phase_executed_task_contract ) && 1 === count( $GLOBALS['wp_codebox_host_delegation_requests'] ?? array() ) && 'browser-session-123' === ( $GLOBALS['wp_codebox_host_delegation_requests'][0]['sandbox_session_id'] ?? '' ) && 'wp-codebox/host-delegation-result/v1' === ( $host_delegation_phase_executed_task_contract['phases'][0]['result']['schema'] ?? '' ) && 'completed' === ( $host_delegation_phase_executed_task_contract['phases'][0]['status'] ?? '' ) && 'smoke-host-provider' === ( $host_delegation_phase_executed_task_contract['phases'][0]['result']['provider'] ?? '' ) && array( 'host-delegation.requested', 'host-delegation.completed' ) === $host_delegation_phase_events );
$assert( 'browser task compact DTO preserves host delegation result for product UIs', ! is_wp_error( $host_delegation_phase_executed_task_contract ) && 'host-delegation' === ( $host_delegation_phase_executed_task_contract['compact']['phases'][0]['kind'] ?? '' ) && 'server-workspace-offload' === ( $host_delegation_phase_executed_task_contract['compact']['phases'][0]['name'] ?? '' ) && 'workspace-required' === ( $host_delegation_phase_executed_task_contract['compact']['phases'][0]['metadata']['reason'] ?? '' ) && 'wp-codebox/host-delegation-result/v1' === ( $host_delegation_phase_executed_task_contract['compact']['phases'][0]['result']['schema'] ?? '' ) );
$GLOBALS['wp_codebox_filters']['wp_codebox_host_delegation_request'] = static fn(): array => array( 'artifact_refs' => array( array( 'path' => 'bare-provider/result.json' ) ) );
$host_delegation_bare_provider = call_user_func(
	$host_delegation_ability['execute_callback'],
	array(
		'schema'     => 'wp-codebox/host-delegation-request/v1',
		'request_id' => 'host-delegation-bare-provider',
		'goal'       => 'Wrap a bare provider payload.',
	)
);
$assert( 'host delegation wraps bare provider payloads as completed results', ! is_wp_error( $host_delegation_bare_provider ) && true === ( $host_delegation_bare_provider['success'] ?? false ) && 'completed' === ( $host_delegation_bare_provider['status'] ?? '' ) && 'bare-provider/result.json' === ( $host_delegation_bare_provider['result']['artifact_refs'][0]['path'] ?? '' ) );

$agents_api_browser_executor_result = apply_filters(
	'agents_api_execute_task',
	null,
	array(
		'target'     => 'wp-codebox/browser-playground',
		'task_input' => array_replace( $browser_task_contract_input, array( 'schema' => 'agents-api/task-input/v1' ) ),
	),
	'wp-codebox/browser-playground'
);
$assert( 'Agents API browser executor returns the browser task contract shape', ! is_wp_error( $agents_api_browser_executor_result ) && ( $browser_task_contract['schema'] ?? '' ) === ( $agents_api_browser_executor_result['schema'] ?? '' ) && ( $browser_task_contract['session']['id'] ?? '' ) === ( $agents_api_browser_executor_result['session']['id'] ?? '' ) && ( $browser_task_contract['compact']['schema'] ?? '' ) === ( $agents_api_browser_executor_result['compact']['schema'] ?? '' ) );
$agents_api_browser_executor_metrics_encoded = wp_json_encode( $agents_api_browser_executor_result['execution_metrics'] ?? array() );
$assert( 'Agents API browser executor exposes normalized execution metrics', ! is_wp_error( $agents_api_browser_executor_result ) && 'agents-api/execution-metrics/v1' === ( $agents_api_browser_executor_result['execution_metrics']['schema'] ?? '' ) && 'wp-codebox/browser-playground' === ( $agents_api_browser_executor_result['execution_metrics']['executor'] ?? '' ) && 'contract' === ( $agents_api_browser_executor_result['execution_metrics']['phase'] ?? '' ) && 'pending' === ( $agents_api_browser_executor_result['execution_metrics']['status'] ?? '' ) && isset( $agents_api_browser_executor_result['execution_metrics']['payload_bytes']['task_payload'] ) && '/tmp/wp-codebox-agent-events.jsonl' === ( $agents_api_browser_executor_result['execution_metrics']['diagnostics_refs']['event_stream_path'] ?? '' ) );
$assert( 'Agents API browser executor metrics are secret-safe summaries', is_string( $agents_api_browser_executor_metrics_encoded ) && ! str_contains( $agents_api_browser_executor_metrics_encoded, 'sk-browser-provider-secret' ) && ! str_contains( $agents_api_browser_executor_metrics_encoded, 'data:application/zip;base64' ) && ! str_contains( $agents_api_browser_executor_metrics_encoded, 'pluginData' ) );

$wp_agent_browser_task_handler_result = apply_filters(
	'wp_agent_task_handler',
	null,
	array(
		'target' => 'wp-codebox/browser-playground',
		'input'  => $browser_task_contract_input,
	)
);
$assert( 'WP Agent task handler alias returns the browser task contract shape', ! is_wp_error( $wp_agent_browser_task_handler_result ) && ( $browser_task_contract['schema'] ?? '' ) === ( $wp_agent_browser_task_handler_result['schema'] ?? '' ) && ( $browser_task_contract['session']['id'] ?? '' ) === ( $wp_agent_browser_task_handler_result['session']['id'] ?? '' ) );

$invalid_browser_task_contract = call_user_func(
	$browser_task_contract_ability['execute_callback'],
	array_replace_recursive(
		$browser_session_input,
		array(
			'phases' => array(
				array(
					'kind' => 'host-task',
				),
			),
		)
	)
);
$assert( 'browser task contract rejects unsupported phase kinds', is_wp_error( $invalid_browser_task_contract ) && 'wp_codebox_browser_phase_kind_invalid' === $invalid_browser_task_contract->get_error_code() );

$runner_report_path = $root . '/browser-materialization-report.json';
add_filter(
	'caller_runtime_task',
	static function ( $result, array $input, array $payload ) use ( $runner_report_path ): array {
		file_put_contents(
			'/tmp/wp-codebox-agent-events.jsonl',
			wp_json_encode(
				array(
					'schema'     => 'wp-codebox/browser-agent-event/v1',
					'event'      => 'tool.completed',
					'payload'    => array(
						'tool_name'   => 'client/filesystem-write',
						'duration_ms' => 37,
						'success'     => true,
					),
					'emitted_at' => gmdate( 'c' ),
				)
			) . "\n"
		);
		file_put_contents(
			$runner_report_path,
			wp_json_encode(
				array(
					'schema'       => 'caller/materialization-report/v1',
					'summary'      => 'caller-owned sandbox task ran',
					'diagnostics'  => $input['diagnostics'] ?? array(),
					'payload_goal' => $payload['task_input']['goal'] ?? '',
				)
			)
		);

		return array(
			'summary'       => 'caller-owned sandbox task ran',
			'changed_files' => array( 'example.php' ),
			'diagnostics'   => $input['diagnostics'] ?? array(),
		);
	},
	10
);
$runner_php = (string) ( $browser_session['recipe']['workflow']['steps'][0]['args'][0] ?? '' );
$assert( 'browser Playground generated runner has no Studio Web-specific artifact paths', ! str_contains( $runner_php, '/wordpress/wp-content/uploads/studio-web' ) && ! str_contains( $runner_php, 'studio-web/website' ) );
$assert( 'browser Playground generated runner defaults to generic Codebox artifacts path', str_contains( $runner_php, '/wordpress/wp-content/uploads/wp-codebox/artifacts' ) && str_contains( $runner_php, 'wp-codebox-output/' ) );
$runner_contract = $browser_session['recipe']['browser']['runner_contract'] ?? array();
$assert( 'browser Playground recipe exposes reusable runner PHP contract prelude', is_array( $runner_contract ) && 'wp-codebox/browser-runner-contract/v1' === ( $runner_contract['schema'] ?? '' ) && str_contains( (string) ( $runner_contract['php_prelude'] ?? '' ), 'function wp_codebox_browser_artifact_environment' ) && str_contains( (string) ( $runner_contract['php_prelude'] ?? '' ), '$wp_codebox_is_playground' ) && str_contains( (string) ( $runner_contract['php_prelude'] ?? '' ), '$capture_paths' ) );
$assert( 'browser Playground recipe exposes reusable runner PHP contract footer', is_array( $runner_contract ) && str_contains( (string) ( $runner_contract['php_footer'] ?? '' ), 'wp_codebox_browser_artifact_capture_diagnostics' ) && str_contains( (string) ( $runner_contract['php_footer'] ?? '' ), 'file_put_contents( $result_path' ) );
$runner_php = preg_replace( '/^code=/', '', $runner_php ) ?? $runner_php;
$runner_php = preg_replace( '/^<\?php\s*/', '', $runner_php ) ?? $runner_php;
$runner_php = str_replace( "require_once '/wordpress/wp-load.php';", '', $runner_php );
$runner_php = str_replace( '/wordpress/wp-content/uploads/wp-codebox/artifacts/materialization/report.json', $runner_report_path, $runner_php );
$runner_php = preg_replace( '/\$wp_codebox_is_playground = .*?;\n/', '$wp_codebox_is_playground = true;' . "\n", $runner_php ) ?? $runner_php;
$runner_artifact_root = rtrim( ABSPATH, '/' ) . '/wp-content/uploads/wp-codebox/artifacts/generic-output';
if ( ! is_dir( $runner_artifact_root . '/assets' ) ) {
	mkdir( $runner_artifact_root . '/assets', 0777, true );
}
file_put_contents( $runner_artifact_root . '/index.html', '<main>Generic caller artifact</main>' );
file_put_contents( $runner_artifact_root . '/assets/logo.png', "\x89PNG\r\n\x1a\ngeneric" );
$runner_task_payload = $browser_session['recipe']['browser']['task_payload'] ?? array();
$runner_task_payload['artifacts'] = array(
	'schema'     => 'caller/generic-browser-artifact-bundle/v1',
	'root'       => 'generic-output',
	'entrypoint' => 'generic-output/index.html',
	'roles'      => array(
		'preview' => 'generic-output/index.html',
	),
	'metadata'   => array(
		'caller' => 'wordpress-plugin-smoke',
		'labels' => array( 'non-studio-web' ),
	),
	'files'      => array(
		array(
			'path'            => 'generic-output/index.html',
			'playground_path' => $runner_artifact_root . '/index.html',
			'url_path'        => '/wp-content/uploads/wp-codebox/artifacts/generic-output/index.html',
			'kind'            => 'html',
			'mime_type'       => 'text/html',
			'roles'           => array( 'preview' ),
			'metadata'        => array( 'opaque' => 'entrypoint' ),
		),
		array(
			'path'            => 'generic-output/assets/logo.png',
			'playground_path' => $runner_artifact_root . '/assets/logo.png',
			'url_path'        => '/wp-content/uploads/wp-codebox/artifacts/generic-output/assets/logo.png',
			'kind'            => 'image',
			'mime_type'       => 'image/png',
			'metadata'        => array( 'opaque' => 'binary' ),
		),
		array(
			'path'            => '../escape.html',
			'playground_path' => $runner_artifact_root . '/index.html',
			'kind'            => 'html',
		),
		array(
			'path'            => 'generic-output/missing.txt',
			'playground_path' => $runner_artifact_root . '/missing.txt',
			'kind'            => 'text',
		),
	),
);
$runner_task_path = (string) ( $browser_session['recipe']['browser']['task_path'] ?? '' );
if ( '' !== $runner_task_path ) {
	if ( ! is_dir( dirname( $runner_task_path ) ) ) {
		mkdir( dirname( $runner_task_path ), 0777, true );
	}
	file_put_contents( $runner_task_path, wp_json_encode( $runner_task_payload ) );
}
ob_start();
eval( $runner_php );
$runner_output = ob_get_clean();
$runner_result = json_decode( (string) $runner_output, true );
$runner_result_path = (string) ( $browser_session['recipe']['browser']['result_path'] ?? '' );
$runner_result_file = is_readable( $runner_result_path ) ? json_decode( (string) file_get_contents( $runner_result_path ), true ) : null;
$assert( 'browser Playground generated runner invokes caller task hook', is_array( $runner_result ) && true === ( $runner_result['success'] ?? false ) && 'completed' === ( $runner_result['status'] ?? '' ) && 'caller-owned sandbox task ran' === ( $runner_result['response']['summary'] ?? '' ) );
$assert( 'browser Playground generated runner captures normalized materialization evidence', is_array( $runner_result ) && 'wp-codebox/browser-materialization/v1' === ( $runner_result['schema'] ?? '' ) && 'wp-codebox/browser-capture/v1' === ( $runner_result['captures'][0]['schema'] ?? '' ) && true === ( $runner_result['captures'][0]['exists'] ?? false ) && 'caller/materialization-report/v1' === ( $runner_result['captures'][0]['json']['schema'] ?? '' ) );
$assert( 'browser Playground generated runner writes result evidence file', is_array( $runner_result_file ) && $runner_result === $runner_result_file );
$assert( 'browser Playground generated runner records diagnostics and provenance', is_array( $runner_result ) && array() === ( $runner_result['errors'] ?? null ) && 'wp-codebox/browser-runner' === ( $runner_result['provenance']['generated_by'] ?? '' ) && '/tmp/wp-codebox-agent-result.json' === ( $runner_result['provenance']['result_path'] ?? '' ) );
$assert( 'browser Playground generated runner captures agent event stream diagnostics', is_array( $runner_result ) && 2 === ( $runner_result['diagnostics']['capture_count'] ?? 0 ) && '/tmp/wp-codebox-agent-events.jsonl' === ( $runner_result['diagnostics']['event_stream']['path'] ?? '' ) && false === ( $runner_result['diagnostics']['event_stream']['sink_attached'] ?? true ) && '/tmp/wp-codebox-agent-events.jsonl' === ( $runner_result['captures'][1]['path'] ?? '' ) && 'events' === ( $runner_result['captures'][1]['kind'] ?? '' ) );
$runner_metrics_encoded = wp_json_encode( $runner_result['execution_metrics'] ?? array() );
$assert( 'browser Playground generated runner emits normalized execution metrics', is_array( $runner_result ) && 'agents-api/execution-metrics/v1' === ( $runner_result['execution_metrics']['schema'] ?? '' ) && 'wp-codebox/browser-playground' === ( $runner_result['execution_metrics']['executor'] ?? '' ) && 'execution' === ( $runner_result['execution_metrics']['phase'] ?? '' ) && 'completed' === ( $runner_result['execution_metrics']['status'] ?? '' ) && 1 === ( $runner_result['execution_metrics']['tool_calls']['count'] ?? 0 ) && 37 === ( $runner_result['execution_metrics']['tool_calls']['duration_ms'] ?? 0 ) && 2 === ( $runner_result['execution_metrics']['artifacts']['capture_count'] ?? 0 ) );
$assert( 'browser Playground execution metrics summarize artifacts without raw payloads or secrets', is_string( $runner_metrics_encoded ) && isset( $runner_result['execution_metrics']['artifact_bytes']['captures'] ) && ! str_contains( $runner_metrics_encoded, 'sk-browser-provider-secret' ) && ! str_contains( $runner_metrics_encoded, '<main>Generic caller artifact</main>' ) && ! str_contains( $runner_metrics_encoded, 'RIFFfixtureWEBP' ) );
$assert( 'browser Playground generated runner captures caller-owned artifact schema', is_array( $runner_result ) && 'caller/generic-browser-artifact-bundle/v1' === ( $runner_result['artifact_bundle']['schema'] ?? '' ) && 'caller/generic-browser-artifact-bundle/v1' === ( $runner_result['response']['artifact_bundle']['schema'] ?? '' ) );
$assert( 'browser Playground generated runner preserves caller artifact metadata and roles', is_array( $runner_result ) && array( 'non-studio-web' ) === ( $runner_result['artifact_bundle']['metadata']['labels'] ?? array() ) && array( 'preview' => 'generic-output/index.html' ) === ( $runner_result['artifact_bundle']['roles'] ?? array() ) && array( 'preview' ) === ( $runner_result['artifact_bundle']['files'][0]['roles'] ?? array() ) && 'entrypoint' === ( $runner_result['artifact_bundle']['files'][0]['metadata']['opaque'] ?? '' ) );
$assert( 'browser Playground generated runner captures text and base64 artifact files', is_array( $runner_result ) && 2 === count( $runner_result['artifact_bundle']['files'] ?? array() ) && '<main>Generic caller artifact</main>' === ( $runner_result['artifact_bundle']['files'][0]['content'] ?? '' ) && 'utf-8' === ( $runner_result['artifact_bundle']['files'][0]['encoding'] ?? '' ) && 'base64' === ( $runner_result['artifact_bundle']['files'][1]['encoding'] ?? '' ) && hash( 'sha256', "\x89PNG\r\n\x1a\ngeneric" ) === ( $runner_result['artifact_bundle']['files'][1]['sha256'] ?? '' ) );
$tool_artifact_base = rtrim( ABSPATH, '/' ) . '/wp-content/uploads/wp-codebox/artifacts';
$tool_task_payload  = array(
	'artifacts' => array(
		'schema'     => 'caller/tool-written-browser-artifact-bundle/v1',
		'root'       => 'tool-output',
		'entrypoint' => 'tool-output/index.html',
		'base_path'  => $tool_artifact_base,
		'base_url'   => '/wp-content/uploads/wp-codebox/artifacts',
	),
);
$GLOBALS['wp_codebox_browser_artifact_environment'] = function_exists( 'wp_codebox_browser_artifact_environment' ) ? wp_codebox_browser_artifact_environment( $tool_task_payload ) : array();
$filesystem_write_tool = class_exists( 'WP_Codebox_Browser_Filesystem_Write_Tool' ) ? new WP_Codebox_Browser_Filesystem_Write_Tool() : null;
$tool_write_result = $filesystem_write_tool ? $filesystem_write_tool->handle_tool_call( array( 'path' => 'tool-output/index.html', 'content' => '<main>Tool Output</main>' ) ) : array();
$tool_capture = function_exists( 'wp_codebox_browser_capture_artifact_bundle' ) ? wp_codebox_browser_capture_artifact_bundle( $tool_task_payload ) : array();
$assert( 'browser Playground filesystem-write uses caller artifact base and root', true === ( $tool_write_result['success'] ?? false ) && $tool_artifact_base . '/tool-output/index.html' === ( $tool_write_result['playground_path'] ?? '' ) );
$assert( 'browser Playground artifact capture discovers caller-rooted files', 'caller/tool-written-browser-artifact-bundle/v1' === ( $tool_capture['schema'] ?? '' ) && 'tool-output/index.html' === ( $tool_capture['files'][0]['path'] ?? '' ) && '<main>Tool Output</main>' === ( $tool_capture['files'][0]['content'] ?? '' ) );
$runner_missing_entrypoint = function_exists( 'wp_codebox_browser_capture_artifact_bundle' ) ? wp_codebox_browser_capture_artifact_bundle( array( 'artifacts' => array_merge( $runner_task_payload['artifacts'], array( 'entrypoint' => 'generic-output/missing.html' ) ) ) ) : array( 'missing_function' => true );
$assert( 'browser Playground generated runner skips missing artifact entrypoints safely', array() === $runner_missing_entrypoint );
$assert( 'browser Playground session emits ready-to-code signal only when blueprint prerequisites are present', ! is_wp_error( $browser_session ) && true === ( $browser_session['signals']['ready_to_code']['emitted'] ?? false ) && 'ready_to_code' === ( $browser_session['signals']['ready_to_code']['name'] ?? '' ) && true === ( $browser_session['signals']['ready_to_code']['requirements']['component:agents-api'] ?? false ) && true === ( $browser_session['signals']['ready_to_code']['requirements']['component:data-machine'] ?? false ) && true === ( $browser_session['signals']['ready_to_code']['requirements']['component:data-machine-code'] ?? false ) && true === ( $browser_session['signals']['ready_to_code']['requirements']['provider_secret'] ?? false ) && true === ( $browser_session['signals']['ready_to_code']['requirements']['runtime_dependencies'] ?? false ) );
$assert( 'browser Playground session exposes runtime dependency readiness metadata', ! is_wp_error( $browser_session ) && 'wp-codebox/browser-runtime-readiness/v1' === ( $browser_session['signals']['ready_to_code']['requirement_metadata']['runtime_dependencies']['schema'] ?? '' ) && 'caller-runtime' === ( $browser_session['signals']['ready_to_code']['requirement_metadata']['runtime_dependencies']['mu_plugins'][0]['slug'] ?? '' ) && 'example-starter' === ( $browser_session['signals']['ready_to_code']['requirement_metadata']['runtime_dependencies']['themes'][0]['slug'] ?? '' ) );
$assert( 'browser Playground session preserves safe artifact files', ! is_wp_error( $browser_session ) && 'repair-output/index.html' === ( $browser_session['artifacts']['files'][0]['path'] ?? '' ) );
$assert( 'browser Playground session exposes artifact write paths', ! is_wp_error( $browser_session ) && '/wordpress/wp-content/uploads/wp-codebox/artifacts/repair-output/index.html' === ( $browser_session['artifacts']['files'][0]['playground_path'] ?? '' ) );
$assert( 'browser Playground session exposes artifact URL paths', ! is_wp_error( $browser_session ) && '/wp-content/uploads/wp-codebox/artifacts/repair-output/index.html' === ( $browser_session['artifacts']['files'][0]['url_path'] ?? '' ) );
$assert( 'browser Playground session preserves mixed text and binary artifact trees', ! is_wp_error( $browser_session ) && 'text/css' === ( $browser_session['artifacts']['files'][1]['mime_type'] ?? '' ) && 'text/javascript' === ( $browser_session['artifacts']['files'][2]['mime_type'] ?? '' ) && 'image/png' === ( $browser_session['artifacts']['files'][3]['mime_type'] ?? '' ) && 'image/jpeg' === ( $browser_session['artifacts']['files'][4]['mime_type'] ?? '' ) && 'image/webp' === ( $browser_session['artifacts']['files'][5]['mime_type'] ?? '' ) && 'image/svg+xml' === ( $browser_session['artifacts']['files'][6]['mime_type'] ?? '' ) );
$assert( 'browser Playground session returns binary artifact metadata', ! is_wp_error( $browser_session ) && 'base64' === ( $browser_session['artifacts']['files'][3]['encoding'] ?? '' ) && strlen( "\x89PNG\r\n\x1a\nfixture" ) === ( $browser_session['artifacts']['files'][3]['size'] ?? 0 ) && hash( 'sha256', "\x89PNG\r\n\x1a\nfixture" ) === ( $browser_session['artifacts']['files'][3]['sha256'] ?? '' ) && isset( $browser_session['artifacts']['files'][3]['content_base64'] ) );
$assert( 'browser Playground session keeps existing text artifact content', ! is_wp_error( $browser_session ) && 'utf-8' === ( $browser_session['artifacts']['files'][0]['encoding'] ?? '' ) && '<main>Preview</main>' === ( $browser_session['artifacts']['files'][0]['content'] ?? '' ) && hash( 'sha256', '<main>Preview</main>' ) === ( $browser_session['artifacts']['files'][0]['sha256'] ?? '' ) );
$assert( 'browser Playground session exposes preview URL', ! is_wp_error( $browser_session ) && '/wp-content/uploads/wp-codebox/artifacts/repair-output/index.html' === ( $browser_session['playground']['preview_url'] ?? '' ) && '/wp-content/uploads/wp-codebox/artifacts/repair-output/index.html' === ( $browser_session['artifacts']['preview_url'] ?? '' ) );
$assert( 'browser Playground session normalizes task input lists', ! is_wp_error( $browser_session ) && array( 'filesystem-write' ) === ( $browser_session['task_input']['allowed_tools'] ?? array() ) );
$assert( 'browser Playground session returns canonical task input metadata', ! is_wp_error( $browser_session ) && 'wp-codebox/task-input/v1' === ( $browser_session['task_input']['schema'] ?? '' ) && 1 === ( $browser_session['task_input']['version'] ?? 0 ) );
$assert( 'browser Playground session exposes canonical task string', ! is_wp_error( $browser_session ) && 'Prepare a browser Playground preview.' === ( $browser_session['task'] ?? '' ) );
$assert( 'browser Playground agents/chat runner exposes sandbox tools through runtime declarations', str_contains( $runner_php, "wp_codebox_browser_runtime_tool_declarations" ) && str_contains( $runner_php, "client/filesystem-write" ) && str_contains( $runner_php, "WP_Codebox_Browser_Filesystem_Write_Tool" ) );
$assert( 'browser Playground agents/chat runner requires model-visible runtime tool names', str_contains( $runner_php, "'runtime_tools' => \$runtime_tool_declarations" ) && str_contains( $runner_php, "'runtime_tool_callback' => 'wp_codebox_browser_runtime_tool_callback'" ) && str_contains( $runner_php, "'tool_policy'" ) && str_contains( $runner_php, "'allow_only'" ) && str_contains( $runner_php, "'completion_assertions'" ) && str_contains( $runner_php, "'required_tool_names'" ) && str_contains( $runner_php, '$sandbox_tool_ids' ) );
$browser_capture_paths = array_map( static fn( array $capture ): string => (string) ( $capture['path'] ?? '' ), $browser_session['recipe']['browser']['captures'] ?? array() );
$assert( 'browser Playground agents/chat runner wires loop events into a captured JSONL file', str_contains( $runner_php, 'LoopEventSinkInterface' ) && str_contains( $runner_php, 'WP_Codebox_Browser_Event_File_Sink' ) && str_contains( $runner_php, 'event_sink' ) && str_contains( $runner_php, '/tmp/wp-codebox-agent-events.jsonl' ) && in_array( '/tmp/wp-codebox-agent-events.jsonl', $browser_capture_paths, true ) );

$normalize_browser_bundle_ability = $GLOBALS['wp_codebox_registered_abilities']['wp-codebox/normalize-browser-artifact-bundle'] ?? null;
$browser_bundle_input            = array(
	'schema_id'  => 'caller/browser-bundle/v1',
	'root'       => 'site',
	'entrypoint' => 'index.html',
	'roles'      => array(
		'preview' => 'index.html',
		'assets'  => array( 'assets/logo.png' ),
	),
	'provenance' => array(
		'caller' => 'wordpress-plugin-smoke',
	),
	'metadata'   => array(
		'opaque' => array( 'product' => 'fixture' ),
	),
	'files'      => array(
		array(
			'path'    => 'assets/app.css',
			'content' => 'body{color:#111}',
			'kind'    => 'stylesheet',
			'roles'   => array( 'style' ),
		),
		array(
			'path'           => 'assets/logo.png',
			'content_base64' => base64_encode( "\x89PNG\r\n\x1a\nbundle" ),
			'encoding'       => 'base64',
			'kind'           => 'image',
		),
		array(
			'path'      => 'index.html',
			'content'   => '<main>Normalized</main>',
			'mime_type' => 'text/html',
			'kind'      => 'html',
		),
	),
);
$normalized_browser_bundle       = is_array( $normalize_browser_bundle_ability ) ? call_user_func( $normalize_browser_bundle_ability['execute_callback'], $browser_bundle_input ) : new WP_Error( 'missing_ability', 'normalize-browser-artifact-bundle missing.' );
$normalized_browser_bundle_again = is_array( $normalize_browser_bundle_ability ) ? call_user_func( $normalize_browser_bundle_ability['execute_callback'], $browser_bundle_input ) : null;
$assert( 'normalize-browser-artifact-bundle returns caller-owned schema envelope', ! is_wp_error( $normalized_browser_bundle ) && true === ( $normalized_browser_bundle['success'] ?? false ) && 'wp-codebox/browser-artifact-bundle-normalization/v1' === ( $normalized_browser_bundle['schema'] ?? '' ) && 'caller/browser-bundle/v1' === ( $normalized_browser_bundle['caller_schema'] ?? '' ) );
$assert( 'normalize-browser-artifact-bundle scopes root and entrypoint', ! is_wp_error( $normalized_browser_bundle ) && 'site' === ( $normalized_browser_bundle['root'] ?? '' ) && 'site/index.html' === ( $normalized_browser_bundle['entrypoint'] ?? '' ) );
$assert( 'normalize-browser-artifact-bundle supports mixed text and base64 files', ! is_wp_error( $normalized_browser_bundle ) && 'site/assets/logo.png' === ( $normalized_browser_bundle['files'][1]['path'] ?? '' ) && 'base64' === ( $normalized_browser_bundle['files'][1]['encoding'] ?? '' ) && hash( 'sha256', "\x89PNG\r\n\x1a\nbundle" ) === ( $normalized_browser_bundle['files'][1]['sha256'] ?? '' ) && 'site/index.html' === ( $normalized_browser_bundle['files'][2]['path'] ?? '' ) && '<main>Normalized</main>' === ( $normalized_browser_bundle['files'][2]['content'] ?? '' ) );
$assert( 'normalize-browser-artifact-bundle preserves opaque roles', ! is_wp_error( $normalized_browser_bundle ) && array( 'assets' => array( 'assets/logo.png' ), 'preview' => 'index.html' ) === ( $normalized_browser_bundle['roles'] ?? array() ) && array( 'style' ) === ( $normalized_browser_bundle['files'][0]['roles'] ?? array() ) );
$assert( 'normalize-browser-artifact-bundle output is stable', ! is_wp_error( $normalized_browser_bundle ) && $normalized_browser_bundle === $normalized_browser_bundle_again );
$normalized_browser_invalid_path = is_array( $normalize_browser_bundle_ability ) ? call_user_func( $normalize_browser_bundle_ability['execute_callback'], array_merge( $browser_bundle_input, array( 'files' => array( array( 'path' => '/escape.html', 'content' => 'nope' ) ) ) ) ) : null;
$assert( 'normalize-browser-artifact-bundle rejects invalid paths', is_wp_error( $normalized_browser_invalid_path ) && 'wp_codebox_browser_artifact_path_invalid' === $normalized_browser_invalid_path->get_error_code() );
$normalized_browser_missing_entrypoint = is_array( $normalize_browser_bundle_ability ) ? call_user_func( $normalize_browser_bundle_ability['execute_callback'], array_merge( $browser_bundle_input, array( 'entrypoint' => 'missing.html' ) ) ) : null;
$assert( 'normalize-browser-artifact-bundle rejects missing entrypoint', is_wp_error( $normalized_browser_missing_entrypoint ) && 'wp_codebox_browser_artifact_entrypoint_missing' === $normalized_browser_missing_entrypoint->get_error_code() );
$normalized_browser_duplicate = is_array( $normalize_browser_bundle_ability ) ? call_user_func( $normalize_browser_bundle_ability['execute_callback'], array_merge( $browser_bundle_input, array( 'files' => array( array( 'path' => 'index.html', 'content' => 'one' ), array( 'path' => 'site/index.html', 'content' => 'two' ) ) ) ) ) : null;
$assert( 'normalize-browser-artifact-bundle rejects duplicate files', is_wp_error( $normalized_browser_duplicate ) && 'wp_codebox_browser_artifact_path_duplicate' === $normalized_browser_duplicate->get_error_code() );

$persisted_browser_artifact       = is_array( $persist_browser_artifact_ability ) ? call_user_func(
	$persist_browser_artifact_ability['execute_callback'],
	array(
		'artifacts_path' => $root . '/artifacts',
		'authorization'  => array(
			'schema' => 'wp-codebox/trusted-orchestrator-authorization/v1',
			'caller' => 'studio-web',
			'scope'  => 'artifact:write',
		),
		'session_id'     => 'browser-session-123',
		'session'        => array(
			'id'              => 'browser-session-123',
			'createdAt'       => '2026-06-02T00:00:00+00:00',
			'metadata'        => array(
				'tab_id' => 'tab-abc',
			),
			'materialization' => array(
				'run_id' => 'materialization-run-123',
			),
		),
		'provenance'     => array(
			'task' => array(
				'id'     => 'issue-437-smoke',
				'source' => 'wordpress-plugin-smoke',
			),
		),
		'caller_schema'  => 'example/browser-artifact/v1',
		'caller_schema_id' => 'example-browser-artifact',
		'caller_kind'    => 'browser-preview',
		'caller_metadata' => array(
			'project_id' => 'project-123',
			'labels'     => array( 'canonical', 'browser' ),
		),
		'materialization' => array(
			'status' => 'ready',
			'paths'  => array( 'index' => 'site/index.html' ),
		),
		'review_hints'   => array(
			'severity' => 'low',
		),
		'apply_target'   => array(
			'type' => 'project-artifact',
			'id'   => 'target-123',
		),
		'files'          => array(
			array(
				'path'      => 'site/index.html',
				'content'   => '<main>Persisted</main>',
				'mime_type' => 'text/html',
				'kind'      => 'html',
			),
			array(
				'path'           => 'site/assets/photo.png',
				'content_base64' => base64_encode( "\x89PNG\r\n\x1a\nparent-persisted" ),
				'encoding'       => 'base64',
				'kind'           => 'image',
			),
		),
	)
) : new WP_Error( 'missing_ability', 'persist-browser-artifact missing.' );
$assert( 'persist-browser-artifact stores canonical artifact bundle', ! is_wp_error( $persisted_browser_artifact ) && true === ( $persisted_browser_artifact['success'] ?? false ) && 'wp-codebox/browser-artifact-persistence/v1' === ( $persisted_browser_artifact['schema'] ?? '' ) && str_starts_with( (string) ( $persisted_browser_artifact['artifact_id'] ?? '' ), 'artifact-bundle-sha256-' ) );
$assert( 'persist-browser-artifact writes manifest and metadata', ! is_wp_error( $persisted_browser_artifact ) && is_file( (string) ( $persisted_browser_artifact['artifact']['paths']['manifest'] ?? '' ) ) && is_file( (string) ( $persisted_browser_artifact['artifact']['paths']['metadata'] ?? '' ) ) );
$assert( 'persist-browser-artifact records browser file metadata', ! is_wp_error( $persisted_browser_artifact ) && 'site/assets/photo.png' === ( $persisted_browser_artifact['artifact']['changed_files']['files'][1]['path'] ?? '' ) && 'files/browser/site/assets/photo.png' === ( $persisted_browser_artifact['artifact']['changed_files']['files'][1]['artifactPath'] ?? '' ) && 'image/png' === ( $persisted_browser_artifact['artifact']['changed_files']['files'][1]['mimeType'] ?? '' ) && hash( 'sha256', "\x89PNG\r\n\x1a\nparent-persisted" ) === ( $persisted_browser_artifact['artifact']['changed_files']['files'][1]['sha256']['value'] ?? '' ) );
$assert( 'persist-browser-artifact preserves caller schema metadata', ! is_wp_error( $persisted_browser_artifact ) && 'example/browser-artifact/v1' === ( $persisted_browser_artifact['artifact']['metadata']['caller']['schema'] ?? '' ) && 'example-browser-artifact' === ( $persisted_browser_artifact['artifact']['metadata']['caller']['schemaId'] ?? '' ) && 'browser-preview' === ( $persisted_browser_artifact['artifact']['metadata']['caller']['kind'] ?? '' ) && 'project-123' === ( $persisted_browser_artifact['artifact']['metadata']['caller']['metadata']['project_id'] ?? '' ) );
$assert( 'persist-browser-artifact preserves provenance and review hints', ! is_wp_error( $persisted_browser_artifact ) && 'wordpress-plugin-smoke' === ( $persisted_browser_artifact['artifact']['metadata']['provenance']['task']['source'] ?? '' ) && 'wordpress-plugin-smoke' === ( $persisted_browser_artifact['artifact']['review']['provenance']['task']['source'] ?? '' ) && 'low' === ( $persisted_browser_artifact['artifact']['review']['reviewHints']['severity'] ?? '' ) );
$assert( 'persist-browser-artifact preserves materialization and session metadata', ! is_wp_error( $persisted_browser_artifact ) && 'ready' === ( $persisted_browser_artifact['artifact']['metadata']['caller']['materialization']['status'] ?? '' ) && 'project-artifact' === ( $persisted_browser_artifact['artifact']['metadata']['caller']['applyTarget']['type'] ?? '' ) && 'tab-abc' === ( $persisted_browser_artifact['artifact']['metadata']['runtime']['metadata']['tab_id'] ?? '' ) && 'materialization-run-123' === ( $persisted_browser_artifact['artifact']['metadata']['runtime']['materialization']['run_id'] ?? '' ) );
$assert( 'persist-browser-artifact preserves text and binary files', ! is_wp_error( $persisted_browser_artifact ) && 'utf-8' === ( $persisted_browser_artifact['artifact']['changed_files']['files'][0]['encoding'] ?? '' ) && 'base64' === ( $persisted_browser_artifact['artifact']['changed_files']['files'][1]['encoding'] ?? '' ) && strlen( '<main>Persisted</main>' ) === ( $persisted_browser_artifact['artifact']['changed_files']['files'][0]['size'] ?? 0 ) && strlen( "\x89PNG\r\n\x1a\nparent-persisted" ) === ( $persisted_browser_artifact['artifact']['changed_files']['files'][1]['size'] ?? 0 ) );
$assert( 'persist-browser-artifact returns trusted authorization provenance', ! is_wp_error( $persisted_browser_artifact ) && 'studio-web' === ( $persisted_browser_artifact['authorization']['caller'] ?? '' ) && 'artifact:write' === ( $persisted_browser_artifact['authorization']['scope'] ?? '' ) && true === ( $persisted_browser_artifact['authorization']['authorized'] ?? false ) && 'trusted-caller-grant' === ( $persisted_browser_artifact['authorization']['reason'] ?? '' ) );
$assert( 'persist-browser-artifact lists persisted bundle', ! is_wp_error( $persisted_browser_artifact ) && ! is_wp_error( call_user_func( $GLOBALS['wp_codebox_registered_abilities']['wp-codebox/list-artifacts']['execute_callback'], array( 'artifacts_path' => $root . '/artifacts' ) ) ) );
$persisted_browser_duplicate = is_array( $persist_browser_artifact_ability ) ? call_user_func(
	$persist_browser_artifact_ability['execute_callback'],
	array(
		'artifacts_path' => $root . '/artifacts',
		'caller_schema'  => 'example/browser-artifact/v2',
		'caller_metadata' => array( 'project_id' => 'project-456' ),
		'files'          => array(
			array(
				'path'      => 'site/index.html',
				'content'   => '<main>Persisted</main>',
				'mime_type' => 'text/html',
				'kind'      => 'html',
			),
			array(
				'path'           => 'site/assets/photo.png',
				'content_base64' => base64_encode( "\x89PNG\r\n\x1a\nparent-persisted" ),
				'encoding'       => 'base64',
				'kind'           => 'image',
			),
		),
	)
) : null;
$assert( 'persist-browser-artifact rejects duplicate content digest independently of caller metadata', is_wp_error( $persisted_browser_duplicate ) && 'wp_codebox_artifact_already_exists' === $persisted_browser_duplicate->get_error_code() && ( $persisted_browser_artifact['artifact_id'] ?? '' ) === ( $persisted_browser_duplicate->get_error_data()['artifact_id'] ?? null ) );
$persisted_browser_traversal = is_array( $persist_browser_artifact_ability ) ? call_user_func(
	$persist_browser_artifact_ability['execute_callback'],
	array(
		'artifacts_path' => $root . '/artifacts',
		'files'          => array( array( 'path' => '../escape.html', 'content' => 'nope' ) ),
	)
) : null;
$assert( 'persist-browser-artifact rejects traversal paths', is_wp_error( $persisted_browser_traversal ) && 'wp_codebox_browser_artifact_path_invalid' === $persisted_browser_traversal->get_error_code() );
$persisted_browser_php = is_array( $persist_browser_artifact_ability ) ? call_user_func(
	$persist_browser_artifact_ability['execute_callback'],
	array(
		'artifacts_path' => $root . '/artifacts',
		'files'          => array( array( 'path' => 'site/shell.php', 'content' => '<?php echo "nope";' ) ),
	)
) : null;
$assert( 'persist-browser-artifact rejects server executable extensions', is_wp_error( $persisted_browser_php ) && 'wp_codebox_browser_artifact_extension_blocked' === $persisted_browser_php->get_error_code() );

$GLOBALS['wp_codebox_filters']['wp_codebox_default_provider'] = '';
$GLOBALS['wp_codebox_filters']['wp_codebox_default_model']    = '';
$GLOBALS['wp_codebox_filters']['wp_codebox_resolve_inheritance'] = function ( array $resolution, array $request ) use ( $root ): array {
	$resolution['connectors'] = array(
		array(
			'name'       => $request['connectors'][0] ?? 'primary-ai',
			'status'     => 'resolved',
			'provider'   => 'openai',
			'model'      => 'gpt-5.5',
			'provider_plugin_paths' => array( $root . '/ai-provider-inherited' ),
			'secret_env_values' => array( 'OPENAI_API_KEY' => 'sk-browser-secret-value' ),
			'credentials' => array(
				'schema'    => 'wp-codebox/connector-credentials/v1',
				'connector' => $request['connectors'][0] ?? 'primary-ai',
				'scope'     => 'connector',
				'status'    => 'available',
				'secrets'   => array(
					array(
						'name'   => 'OPENAI_API_KEY',
						'source' => 'connector',
						'status' => 'available',
						'value'  => 'sk-browser-secret-value',
					),
				),
			),
		),
	);

	return $resolution;
};
$browser_inherited_session = call_user_func(
	$browser_session_ability['execute_callback'],
	array(
		'goal'    => 'Invoke a browser agent with inherited connector metadata.',
		'inherit' => array( 'connectors' => array( 'primary-ai' ) ),
		'agent_bundles' => array(
			array(
				'source'           => 'https://example.test/site-generator-agent.json',
				'slug'             => 'site-generator',
				'import_principal' => array(
					'agent_id'     => 123,
					'owner_id'     => 1,
					'token_id'     => 456,
					'capabilities' => array( 'runtime_import_agent' ),
					'scope'        => array(
						'ability_allow' => array( 'runtime/import-agent' ),
					),
				),
			),
			array(
				'bundle' => array(
					'bundle_version' => '1.0.0',
					'agent'          => array(
						'agent_slug'   => 'repair-agent',
						'agent_name'   => 'Repair Agent',
						'agent_config' => array(),
					),
				),
				'slug' => 'repair-agent',
			),
		),
	)
);
$browser_inherited_encoded = ! is_wp_error( $browser_inherited_session ) ? json_encode( $browser_inherited_session, JSON_UNESCAPED_SLASHES ) : '';
$assert( 'browser Playground session resolves inherited provider and model', ! is_wp_error( $browser_inherited_session ) && 'openai' === ( $browser_inherited_session['provider'] ?? '' ) && 'gpt-5.5' === ( $browser_inherited_session['model'] ?? '' ) );
$assert( 'browser Playground session packages inherited provider plugin path', ! is_wp_error( $browser_inherited_session ) && 1 === count( array_filter( $browser_inherited_session['plugins'] ?? array(), static fn( array $plugin ): bool => 'ai-provider-inherited' === ( $plugin['slug'] ?? '' ) ) ) );
$assert( 'browser Playground session embeds first-class browser task payload', ! is_wp_error( $browser_inherited_session ) && 'wp-codebox/browser-agent-task-payload/v1' === ( $browser_inherited_session['task_payload']['schema'] ?? '' ) && 'openai' === ( $browser_inherited_session['recipe']['browser']['task_payload']['provider'] ?? '' ) && 'gpt-5.5' === ( $browser_inherited_session['recipe']['browser']['task_payload']['model'] ?? '' ) );
$assert( 'browser Playground session records inherited connector credential provenance without values', ! is_wp_error( $browser_inherited_session ) && 'wp-codebox/connector-credentials/v1' === ( $browser_inherited_session['inheritance']['connectors'][0]['credentials']['schema'] ?? '' ) && 'available' === ( $browser_inherited_session['task_payload']['inheritance']['connectors'][0]['credentials']['secrets'][0]['status'] ?? '' ) && str_contains( $browser_inherited_encoded, 'OPENAI_API_KEY' ) && ! str_contains( $browser_inherited_encoded, 'sk-browser-secret-value' ) && ! str_contains( $browser_inherited_encoded, 'secret_env_values' ) );
$browser_connector_handler_saw_secret = false;
$GLOBALS['wp_codebox_filters']['wp_codebox_browser_connector_request'] = function ( mixed $response, array $request ) use ( &$browser_connector_handler_saw_secret ): array {
	$browser_connector_handler_saw_secret = 'sk-browser-secret-value' === ( $request['credentials']['OPENAI_API_KEY'] ?? '' );
	return array(
		'schema'            => 'caller/provider-response/v1',
		'ok'                => true,
		'credentials'       => $request['credentials'],
		'secret_env_values' => $request['credentials'],
	);
};
$browser_connector_response = is_array( $browser_connector_ability ) ? call_user_func(
	$browser_connector_ability['execute_callback'],
	array(
		'schema'    => 'wp-codebox/browser-connector-request/v1',
		'connector' => 'primary-ai',
		'provider'  => 'openai',
		'model'     => 'gpt-5.5',
		'operation' => 'chat.completions.create',
		'payload'   => array( 'messages' => array( array( 'role' => 'user', 'content' => 'hello' ) ) ),
	)
) : null;
$browser_connector_response_encoded = ! is_wp_error( $browser_connector_response ) ? json_encode( $browser_connector_response, JSON_UNESCAPED_SLASHES ) : '';
$assert( 'browser connector bridge dispatches available credential values only to server-side handler', ! is_wp_error( $browser_connector_response ) && true === ( $browser_connector_response['success'] ?? false ) && true === $browser_connector_handler_saw_secret );
$assert( 'browser connector bridge response redacts credential values', ! is_wp_error( $browser_connector_response ) && 'wp-codebox/browser-connector-response/v1' === ( $browser_connector_response['schema'] ?? '' ) && 'available' === ( $browser_connector_response['credentials']['status'] ?? '' ) && str_contains( $browser_connector_response_encoded, 'OPENAI_API_KEY' ) && ! str_contains( $browser_connector_response_encoded, 'sk-browser-secret-value' ) && ! str_contains( $browser_connector_response_encoded, 'secret_env_values' ) );
unset( $GLOBALS['wp_codebox_filters']['wp_codebox_browser_connector_request'] );
$browser_connector_no_handler = is_array( $browser_connector_ability ) ? call_user_func(
	$browser_connector_ability['execute_callback'],
	array(
		'connector' => 'primary-ai',
		'provider'  => 'openai',
		'model'     => 'gpt-5.5',
		'operation' => 'chat.completions.create',
	)
) : null;
$assert( 'browser connector bridge fails closed without handler', ! is_wp_error( $browser_connector_no_handler ) && false === ( $browser_connector_no_handler['success'] ?? true ) && 'failed-closed' === ( $browser_connector_no_handler['status'] ?? '' ) && 'wp_codebox_browser_connector_handler_missing' === ( $browser_connector_no_handler['error']['code'] ?? '' ) );

$GLOBALS['wp_codebox_filters']['wp_codebox_resolve_inheritance'] = function ( array $resolution, array $request ): array {
	$resolution['connectors'] = array(
		array(
			'name'        => $request['connectors'][0] ?? 'primary-ai',
			'status'      => 'resolved',
			'provider'    => 'openai',
			'model'       => 'gpt-5.5',
			'credentials' => array(
				'schema'  => 'wp-codebox/connector-credentials/v1',
				'status'  => 'missing',
				'secrets' => array( array( 'name' => 'OPENAI_API_KEY', 'status' => 'missing', 'reason' => 'not configured' ) ),
			),
		),
	);
	return $resolution;
};
$browser_connector_missing = is_array( $browser_connector_ability ) ? call_user_func( $browser_connector_ability['execute_callback'], array( 'connector' => 'primary-ai', 'operation' => 'chat.completions.create' ) ) : null;
$assert( 'browser connector bridge fails closed for missing credentials', ! is_wp_error( $browser_connector_missing ) && false === ( $browser_connector_missing['success'] ?? true ) && 'failed-closed' === ( $browser_connector_missing['status'] ?? '' ) && 'wp_codebox_connector_credentials_unavailable' === ( $browser_connector_missing['error']['code'] ?? '' ) && 'missing' === ( $browser_connector_missing['credentials']['status'] ?? '' ) );

$GLOBALS['wp_codebox_filters']['wp_codebox_resolve_inheritance'] = function ( array $resolution, array $request ): array {
	$resolution['connectors'] = array(
		array(
			'name'        => $request['connectors'][0] ?? 'primary-ai',
			'status'      => 'resolved',
			'provider'    => 'openai',
			'model'       => 'gpt-5.5',
			'secret_env_values' => array( 'OPENAI_API_KEY' => 'sk-denied-secret-value' ),
			'credentials' => array(
				'schema'  => 'wp-codebox/connector-credentials/v1',
				'status'  => 'denied',
				'secrets' => array( array( 'name' => 'OPENAI_API_KEY', 'status' => 'denied', 'reason' => 'scope denied' ) ),
			),
		),
	);
	return $resolution;
};
$browser_connector_denied = is_array( $browser_connector_ability ) ? call_user_func( $browser_connector_ability['execute_callback'], array( 'connector' => 'primary-ai', 'operation' => 'chat.completions.create' ) ) : null;
$browser_connector_denied_encoded = ! is_wp_error( $browser_connector_denied ) ? json_encode( $browser_connector_denied, JSON_UNESCAPED_SLASHES ) : '';
$assert( 'browser connector bridge fails closed for denied credentials without leaking values', ! is_wp_error( $browser_connector_denied ) && false === ( $browser_connector_denied['success'] ?? true ) && 'denied' === ( $browser_connector_denied['credentials']['status'] ?? '' ) && ! str_contains( $browser_connector_denied_encoded, 'sk-denied-secret-value' ) );
$assert( 'browser Playground recipe defaults to agents chat invocation with embedded payload', ! is_wp_error( $browser_inherited_session ) && 'ability' === ( $browser_inherited_session['recipe']['browser']['invocation']['type'] ?? '' ) && 'agents/chat' === ( $browser_inherited_session['recipe']['browser']['invocation']['name'] ?? '' ) && str_contains( (string) ( $browser_inherited_session['recipe']['workflow']['steps'][0]['args'][0] ?? '' ), 'wp_get_ability( $ability_name )' ) );
$browser_runner_code = (string) ( $browser_inherited_session['recipe']['workflow']['steps'][0]['args'][0] ?? '' );
$assert( 'browser Playground recipe authorizes agents chat through scoped runtime principal only inside sandbox', ! is_wp_error( $browser_inherited_session ) && str_contains( $browser_runner_code, 'agents_chat_runtime_principal_permission' ) && str_contains( $browser_runner_code, '$wp_codebox_is_playground' ) && str_contains( $browser_runner_code, "'wp-codebox-browser-runner'" ) && ! str_contains( $browser_runner_code, 'agents_chat_permission' ) && ! str_contains( $browser_runner_code, 'agents_conversation_sessions_permission' ) );
$assert( 'browser Playground recipe provides bounded user context to agents chat', ! is_wp_error( $browser_inherited_session ) && str_contains( $browser_runner_code, "function_exists( 'get_current_user_id' ) ? get_current_user_id() : 0" ) && str_contains( $browser_runner_code, "wp_set_current_user( \$runtime_user_id );" ) && str_contains( $browser_runner_code, "'user_id' => \$runtime_user_id" ) );
$assert( 'browser Playground recipe passes inherited provider and model to agents chat', ! is_wp_error( $browser_inherited_session ) && str_contains( $browser_runner_code, "\$payload['task_input']['provider']" ) && str_contains( $browser_runner_code, "\$payload['task_input']['model']" ) );
$assert( 'browser Playground recipe keeps sandbox id in client context instead of transcript session id', ! is_wp_error( $browser_inherited_session ) && str_contains( $browser_runner_code, "'caller_session_id' => \$session_id" ) && ! str_contains( $browser_runner_code, "'message' => \$message,\n\t'session_id' => \$session_id" ) );
$assert( 'browser Playground recipe passes Agents API runtime principal', ! is_wp_error( $browser_inherited_session ) && str_contains( $browser_runner_code, "'auth_source' => 'runtime'" ) && str_contains( $browser_runner_code, "'request_context' => 'runtime'" ) && str_contains( $browser_runner_code, "'owner_type' => 'runtime'" ) && str_contains( $browser_runner_code, "'runtime_type' => 'wordpress-playground'" ) );
$provider_proxy_offset = strpos( $browser_runner_code, 'function wp_codebox_browser_install_provider_proxy' );
$provider_proxy_end    = false !== $provider_proxy_offset ? strpos( $browser_runner_code, 'function wp_codebox_browser_safe_artifact_path', $provider_proxy_offset ) : false;
$provider_proxy_code   = false !== $provider_proxy_offset && false !== $provider_proxy_end ? substr( $browser_runner_code, $provider_proxy_offset, $provider_proxy_end - $provider_proxy_offset ) : '';
$assert( 'browser Playground recipe installs generic wp-ai-client provider proxy', ! is_wp_error( $browser_inherited_session ) && str_contains( $provider_proxy_code, 'setProviderRequestAuthentication' ) && str_contains( $provider_proxy_code, 'setHttpTransporter' ) && str_contains( $provider_proxy_code, 'post_message_to_js' ) && str_contains( $provider_proxy_code, 'wp-codebox/browser-provider-proxy-request/v1' ) );
$assert( 'browser provider proxy binds provider-compatible placeholder authentication', ! is_wp_error( $browser_inherited_session ) && str_contains( $provider_proxy_code, 'ApiKeyRequestAuthentication' ) && str_contains( $provider_proxy_code, 'wp-codebox-browser-provider-proxy' ) && str_contains( $provider_proxy_code, "'request_authentication_class'" ) );
$assert( 'browser provider proxy derives connector scope from generic inheritance', ! is_wp_error( $browser_inherited_session ) && str_contains( $provider_proxy_code, "\$payload['inheritance']['connectors']" ) && str_contains( $provider_proxy_code, "'inherit'            => \$this->inherit" ) );
$assert( 'browser provider proxy consumes bounded adapter HTTP envelope', ! is_wp_error( $browser_inherited_session ) && str_contains( $provider_proxy_code, "\$response['response']" ) && str_contains( $provider_proxy_code, '$status < 100 || $status > 599' ) );
$assert( 'browser provider proxy source is independent of Data Machine', ! is_wp_error( $browser_inherited_session ) && ! str_contains( $provider_proxy_code, 'datamachine_' ) && ! str_contains( $provider_proxy_code, 'DataMachine' ) );
$assert( 'generated browser runner only references Data Machine for the existing loop event sink interface', ! is_wp_error( $browser_inherited_session ) && ! str_contains( $browser_runner_code, 'datamachine_' ) && str_contains( $browser_runner_code, '\\DataMachine\\Engine\\AI\\LoopEventSinkInterface' ) && substr_count( $browser_runner_code, 'DataMachine' ) === substr_count( $browser_runner_code, '\\DataMachine\\Engine\\AI\\LoopEventSinkInterface' ) );
$assert( 'browser Playground recipe preserves and imports multiple runtime agent bundles before agents chat', ! is_wp_error( $browser_inherited_session ) && 2 === count( $browser_inherited_session['recipe']['inputs']['agent_bundles'] ?? array() ) && 2 === count( $browser_inherited_session['task_payload']['agent_bundles'] ?? array() ) && str_contains( $browser_runner_code, 'wp_codebox_browser_import_agent_bundles' ) && str_contains( $browser_runner_code, 'wp_agent_import_runtime_bundles' ) && str_contains( $browser_runner_code, 'wp_agent_runtime_import_bundle' ) && strpos( $browser_runner_code, 'wp_codebox_browser_import_agent_bundles' ) < strpos( $browser_runner_code, 'wp_get_ability( $ability_name )' ) );
$assert( 'browser Playground recipe preserves non-secret runtime import principal', ! is_wp_error( $browser_inherited_session ) && 123 === ( $browser_inherited_session['task_payload']['agent_bundles'][0]['import_principal']['agent_id'] ?? null ) && array( 'runtime/import-agent' ) === ( $browser_inherited_session['task_payload']['agent_bundles'][0]['import_principal']['scope']['ability_allow'] ?? array() ) );
$assert( 'browser Playground recipe delegates runtime bundle imports through generic helper', ! is_wp_error( $browser_inherited_session ) && str_contains( $browser_runner_code, "wp_agent_import_runtime_bundles" ) && str_contains( $browser_runner_code, "apply_filters( 'wp_agent_runtime_import_bundle'" ) && ! str_contains( $browser_runner_code, '\\DataMachine\\Abilities\\PermissionHelper' ) && ! str_contains( $browser_runner_code, "wp_get_ability( 'datamachine/import-agent' )" ) );
$assert( 'browser Playground recipe leaves inline runtime bundle transport to Agents API helper', ! is_wp_error( $browser_inherited_session ) && ! str_contains( $browser_runner_code, '$temp_source = $temp_base . \'.json\';' ) );
$GLOBALS['wp_codebox_filters']['wp_codebox_default_provider'] = 'openai';
$GLOBALS['wp_codebox_filters']['wp_codebox_default_model']    = 'gpt-5.5';
unset( $GLOBALS['wp_codebox_filters']['wp_codebox_resolve_inheritance'] );

$browser_packaged_mu_session = call_user_func(
	$browser_session_ability['execute_callback'],
	array(
		'goal'    => 'Prepare a browser Playground with packaged runtime infrastructure.',
		'runtime' => array(
			'mu_plugins' => array(
				array(
					'slug'             => 'generic-mu-runtime',
					'file'             => 'generic-mu-runtime-loader.php',
					'url'              => 'https://github.com/example/generic-mu-runtime/releases/download/v1.0.0/generic-mu-runtime.zip',
					'targetFolderName' => 'generic-mu-runtime',
					'entry'            => 'generic-mu-runtime.php',
				),
			),
		),
	)
);
$packaged_mu_steps = ! is_wp_error( $browser_packaged_mu_session ) ? ( $browser_packaged_mu_session['playground']['blueprint']['steps'] ?? array() ) : array();
$packaged_mu_code  = (string) ( $packaged_mu_steps[1]['code'] ?? '' );
$assert( 'browser Playground session packages runtime mu-plugin dependencies through safe delivery', ! is_wp_error( $browser_packaged_mu_session ) && 1 === ( $browser_packaged_mu_session['runtime']['summary']['mu_plugins'] ?? 0 ) && str_starts_with( (string) ( $browser_packaged_mu_session['runtime']['mu_plugins'][0]['url'] ?? '' ), 'data:application/zip;base64,' ) && ! str_contains( (string) ( $browser_packaged_mu_session['runtime']['mu_plugins'][0]['local_package_fetch_url'] ?? '' ), 'github.com' ) && 'runtime-mu-plugin-remote-package' === ( $browser_packaged_mu_session['runtime']['mu_plugins'][0]['provenance']['source'] ?? '' ) );
$assert( 'browser Playground session installs packaged runtime mu-plugin into visible Playground without source URL fetches', ! is_wp_error( $browser_packaged_mu_session ) && 'runPHP' === ( $packaged_mu_steps[1]['step'] ?? '' ) && ! in_array( 'installPlugin', array_map( static fn( array $step ): string => (string) ( $step['step'] ?? '' ), $packaged_mu_steps ), true ) && ! str_contains( $packaged_mu_code, 'github.com/example/generic-mu-runtime' ) && str_contains( $packaged_mu_code, 'data:application/zip;base64,' ) && str_contains( $packaged_mu_code, '/wordpress/wp-content/mu-plugins/generic-mu-runtime' ) && str_contains( $packaged_mu_code, '/wordpress/wp-content/mu-plugins/generic-mu-runtime-loader.php' ) );

$GLOBALS['wp_codebox_filters']['wp_codebox_browser_plugin_data_url_max_bytes'] = static fn(): int => 1;
$browser_url_package_session = call_user_func(
	$browser_session_ability['execute_callback'],
	array(
		'goal'    => 'Prepare browser Playground with URL-delivered packages.',
		'runtime' => array(
			'plugins' => array(
				array(
					'slug'    => 'generic-caller-plugin',
					'package' => 'server',
					'path'    => $root . '/plugin-root/generic-caller-plugin',
				),
			),
		),
	)
);
unset( $GLOBALS['wp_codebox_filters']['wp_codebox_browser_plugin_data_url_max_bytes'] );
$assert( 'browser Playground session uses stable package URLs when inline budget is exceeded', ! is_wp_error( $browser_url_package_session ) && str_starts_with( (string) ( $browser_url_package_session['plugins'][0]['url'] ?? '' ), 'https://parent.example.test/uploads/wp-codebox/browser-runtime-plugins/generic-caller-plugin-' ) && ! str_starts_with( (string) ( $browser_url_package_session['plugins'][0]['url'] ?? '' ), 'data:application/zip;base64,' ) && ( $browser_url_package_session['plugins'][0]['url'] ?? '' ) === ( $browser_url_package_session['playground']['blueprint']['steps'][1]['pluginData']['url'] ?? '' ) && 64 === strlen( (string) ( $browser_url_package_session['plugins'][0]['provenance']['sha256'] ?? '' ) ) );

$GLOBALS['wp_codebox_filters']['wp_codebox_browser_plugin_data_url_max_bytes'] = static fn(): int => 1;
$previous_upload_dir = $GLOBALS['wp_codebox_upload_dir'];
$GLOBALS['wp_codebox_upload_dir']['baseurl'] = 'http://127.0.0.1:63498/uploads';
$browser_local_url_package_session = call_user_func(
	$browser_session_ability['execute_callback'],
	array(
		'goal'    => 'Prepare browser Playground with local URL-delivered packages.',
		'runtime' => array(
			'plugins' => array(
				array(
					'slug'    => 'generic-caller-plugin',
					'package' => 'server',
					'path'    => $root . '/plugin-root/generic-caller-plugin',
				),
			),
		),
	)
);
$GLOBALS['wp_codebox_upload_dir'] = $previous_upload_dir;
unset( $GLOBALS['wp_codebox_filters']['wp_codebox_browser_plugin_data_url_max_bytes'] );
$assert( 'browser Playground session inlines loopback package URLs instead of emitting broken URL resources', ! is_wp_error( $browser_local_url_package_session ) && str_starts_with( (string) ( $browser_local_url_package_session['plugins'][0]['url'] ?? '' ), 'data:application/zip;base64,' ) && 'http://localhost:63498/uploads/wp-codebox/browser-runtime-plugins/' === substr( (string) ( $browser_local_url_package_session['plugins'][0]['local_package_fetch_url'] ?? '' ), 0, 66 ) && 'installPlugin' === ( $browser_local_url_package_session['playground']['blueprint']['steps'][1]['step'] ?? '' ) && str_starts_with( (string) ( $browser_local_url_package_session['playground']['blueprint']['steps'][1]['pluginData']['url'] ?? '' ), 'data:application/zip;base64,' ) && ! str_contains( (string) json_encode( $browser_local_url_package_session['playground']['blueprint']['steps'][1] ), 'http://127.0.0.1:63498/uploads/wp-codebox/browser-runtime-plugins/generic-caller-plugin-' ) );

$browser_site_blueprint_session = call_user_func(
	$browser_session_ability['execute_callback'],
	array(
		'goal'                    => 'Prepare a pulled live-site copy.',
		'provider_plugin_paths'   => array( $root . '/ai-provider-test' ),
		'inherit'                 => array( 'connectors' => array( 'openai' ) ),
		'site_blueprint_artifact' => array(
			'schema'     => 'wp-codebox/site-blueprint-artifact/v1',
			'id'         => 'wpcom-site-123-backup-456',
			'blueprint'  => array(
				'features' => array( 'networking' => true ),
				'steps'    => array(
					array(
						'step' => 'runPHP',
						'code' => '<?php update_option( "blogname", "Pulled Site" );',
					),
				),
			),
			'provenance' => array(
				'provider'       => 'wpcom-sync',
				'remote_site_id' => 123,
			),
		),
	)
);
$assert( 'browser Playground session compiles site blueprint artifact before agent runtime', ! is_wp_error( $browser_site_blueprint_session ) && true === ( $browser_site_blueprint_session['success'] ?? false ) && 'runPHP' === ( $browser_site_blueprint_session['playground']['blueprint']['steps'][1]['step'] ?? '' ) && str_contains( (string) ( $browser_site_blueprint_session['playground']['blueprint']['steps'][1]['code'] ?? '' ), 'Pulled Site' ) );
$assert( 'browser Playground session echoes site blueprint artifact provenance', ! is_wp_error( $browser_site_blueprint_session ) && 'wpcom-site-123-backup-456' === ( $browser_site_blueprint_session['site_blueprint_artifact']['id'] ?? '' ) && 'wpcom-sync' === ( $browser_site_blueprint_session['site_blueprint_artifact']['provenance']['provider'] ?? '' ) );

$browser_invalid_site_blueprint = call_user_func(
	$browser_session_ability['execute_callback'],
	array(
		'goal'                    => 'Prepare an invalid pulled site copy.',
		'site_blueprint_artifact' => array( 'id' => 'missing-blueprint' ),
	)
);
$assert( 'browser Playground session rejects malformed site blueprint artifacts', is_wp_error( $browser_invalid_site_blueprint ) && 'wp_codebox_site_blueprint_artifact_invalid' === $browser_invalid_site_blueprint->get_error_code() );

$browser_parent_only_tool = call_user_func(
	$browser_session_ability['execute_callback'],
	array(
		'goal'                  => 'Prepare a browser preview with a parent-only tool.',
		'allowed_tools'         => array( 'datamachine/workspace-git-push' ),
		'sandbox_tool_policy'   => wp_codebox_smoke_sandbox_tool_policy( array( 'datamachine/workspace-git-push' => array( 'runtime_tool_id' => 'workspace_git_push', 'execution_location' => 'parent', 'transport_visibility' => 'parent', 'allowed' => false ) ) ),
		'provider_plugin_paths' => array( $root . '/ai-provider-test' ),
		'inherit'               => array( 'connectors' => array( 'openai' ) ),
	)
);
$assert( 'browser Playground session rejects parent-only Data Machine tools before recipe emission', is_wp_error( $browser_parent_only_tool ) && 'wp_codebox_tool_not_allowed' === $browser_parent_only_tool->get_error_code() );

$browser_not_allowlisted_tool = call_user_func(
	$browser_session_ability['execute_callback'],
	array(
		'goal'                  => 'Prepare a browser preview with an unconfigured tool.',
		'allowed_tools'         => array( 'datamachine/workspace-write' ),
		'sandbox_tool_policy'   => wp_codebox_smoke_sandbox_tool_policy( array( 'datamachine/workspace-read' => array( 'runtime_tool_id' => 'workspace_read' ) ) ),
		'provider_plugin_paths' => array( $root . '/ai-provider-test' ),
		'inherit'               => array( 'connectors' => array( 'openai' ) ),
	)
);
$assert( 'browser Playground session rejects tools outside configured allow-list before recipe emission', is_wp_error( $browser_not_allowlisted_tool ) && 'wp_codebox_tool_not_allowed' === $browser_not_allowlisted_tool->get_error_code() && 'not-in-policy' === ( $browser_not_allowlisted_tool->get_error_data()['denied_tools'][0]['reason'] ?? '' ) );

$browser_insecure_plugin_url = call_user_func(
	$browser_session_ability['execute_callback'],
	array(
		'goal'            => 'Prepare a browser preview with an insecure plugin URL.',
		'browser_plugins' => array( array( 'url' => 'http://example.test/plugin.zip' ) ),
	)
);
$assert( 'browser Playground session rejects insecure browser plugin URLs', is_wp_error( $browser_insecure_plugin_url ) && 'wp_codebox_browser_plugin_url_insecure' === $browser_insecure_plugin_url->get_error_code() );

$browser_plugin_allowed_hosts_filter = $GLOBALS['wp_codebox_filters']['wp_codebox_browser_plugin_allowed_hosts'] ?? null;
unset( $GLOBALS['wp_codebox_filters']['wp_codebox_browser_plugin_allowed_hosts'] );
$browser_loopback_plugin_url = call_user_func(
	$browser_session_ability['execute_callback'],
	array(
		'goal'            => 'Prepare a browser preview with a loopback plugin URL.',
		'browser_plugins' => array( array( 'url' => 'http://127.0.0.1:8888/plugin.zip' ) ),
	)
);
if ( null !== $browser_plugin_allowed_hosts_filter ) {
	$GLOBALS['wp_codebox_filters']['wp_codebox_browser_plugin_allowed_hosts'] = $browser_plugin_allowed_hosts_filter;
}
$assert( 'browser Playground session accepts loopback browser plugin URLs', ! is_wp_error( $browser_loopback_plugin_url ) );

$browser_untrusted_plugin_host = call_user_func(
	$browser_session_ability['execute_callback'],
	array(
		'goal'            => 'Prepare a browser preview with an untrusted plugin host.',
		'browser_plugins' => array( array( 'url' => 'https://evil.example/plugin.zip' ) ),
	)
);
$assert( 'browser Playground session rejects untrusted browser plugin hosts', is_wp_error( $browser_untrusted_plugin_host ) && 'wp_codebox_browser_plugin_host_not_allowed' === $browser_untrusted_plugin_host->get_error_code() );

$browser_untrusted_playground_origin = call_user_func(
	$browser_session_ability['execute_callback'],
	array(
		'goal'       => 'Prepare a browser preview with an untrusted Playground client.',
		'playground' => array( 'client_module_url' => 'https://evil.example/client.js' ),
	)
);
$assert( 'browser Playground session rejects untrusted Playground origins', is_wp_error( $browser_untrusted_playground_origin ) && 'wp_codebox_browser_origin_not_allowed' === $browser_untrusted_playground_origin->get_error_code() );

$browser_untrusted_cors_proxy = call_user_func(
	$browser_session_ability['execute_callback'],
	array(
		'goal'       => 'Prepare a browser preview with an untrusted Playground CORS proxy.',
		'playground' => array( 'cors_proxy_url' => 'https://evil.example/cors-proxy?' ),
	)
);
$assert( 'browser Playground session rejects untrusted CORS proxy origins', is_wp_error( $browser_untrusted_cors_proxy ) && 'wp_codebox_browser_origin_not_allowed' === $browser_untrusted_cors_proxy->get_error_code() && 'cors_proxy_url' === ( $browser_untrusted_cors_proxy->get_error_data()['field'] ?? '' ) );

$component_contracts_filter = $GLOBALS['wp_codebox_filters']['wp_codebox_component_contracts'] ?? null;
unset( $GLOBALS['wp_codebox_filters']['wp_codebox_component_contracts'] );
$browser_canonical_component_session = call_user_func(
	$browser_session_ability['execute_callback'],
	array(
		'goal'                  => 'Prepare a browser preview with canonical runtime components.',
		'provider_plugin_paths' => array( $root . '/ai-provider-test' ),
		'inherit'               => array( 'connectors' => array( 'openai' ) ),
		'browser_runner'        => array( 'invocation' => array( 'type' => 'task', 'hook' => 'canonical_runtime_task' ) ),
	)
);
if ( null !== $component_contracts_filter ) {
	$GLOBALS['wp_codebox_filters']['wp_codebox_component_contracts'] = $component_contracts_filter;
}
$canonical_component_urls = ! is_wp_error( $browser_canonical_component_session ) ? array_values( array_map( static fn( array $plugin ): string => (string) ( $plugin['url'] ?? '' ), $browser_canonical_component_session['plugins'] ?? array() ) ) : array();
$canonical_component_remote_get_urls = array_values( array_map( static fn( array $request ): string => (string) ( $request['url'] ?? '' ), $GLOBALS['wp_codebox_remote_gets'] ?? array() ) );
$assert( 'browser Playground session uses canonical registry components without path packaging by default', ! is_wp_error( $browser_canonical_component_session ) && true === ( $browser_canonical_component_session['success'] ?? false ) && in_array( 'https://github.com/Automattic/agents-api/releases/latest/download/agents-api.zip', $canonical_component_remote_get_urls, true ) && in_array( 'https://github.com/Extra-Chill/data-machine/releases/latest/download/data-machine.zip', $canonical_component_remote_get_urls, true ) && in_array( 'https://github.com/Extra-Chill/data-machine-code/releases/latest/download/data-machine-code.zip', $canonical_component_remote_get_urls, true ) && 3 === count( array_filter( $browser_canonical_component_session['plugins'] ?? array(), static fn( array $plugin ): bool => 'runtime-component-registry' === ( $plugin['provenance']['source'] ?? '' ) && ! empty( $plugin['local_package'] ) ) ) );
$assert( 'browser Playground canonical registry components avoid direct GitHub and localhost browser fetches', ! is_wp_error( $browser_canonical_component_session ) && ! str_contains( implode( "\n", $canonical_component_urls ), 'github.com/' ) && ! str_contains( implode( "\n", $canonical_component_urls ), 'localhost' ) && ! str_contains( implode( "\n", $canonical_component_urls ), '127.0.0.1' ) );

$browser_session_missing_prereqs = call_user_func(
	$browser_session_ability['execute_callback'],
	array(
		'goal' => 'Prepare a browser preview without coding prerequisites.',
	)
);
$assert( 'browser Playground session with missing prerequisites returns blocked state', ! is_wp_error( $browser_session_missing_prereqs ) && false === ( $browser_session_missing_prereqs['success'] ?? true ) && 'blocked' === ( $browser_session_missing_prereqs['status'] ?? '' ) && 'blocked' === ( $browser_session_missing_prereqs['session']['status'] ?? '' ) );
$assert( 'browser Playground blocked session identifies disposable execution scope', ! is_wp_error( $browser_session_missing_prereqs ) && 'disposable-playground' === ( $browser_session_missing_prereqs['execution_scope'] ?? '' ) && 'disposable-playground' === ( $browser_session_missing_prereqs['session']['execution_scope'] ?? '' ) );
$assert( 'browser Playground blocked session identifies runtime-principal permission model', ! is_wp_error( $browser_session_missing_prereqs ) && 'runtime-principal' === ( $browser_session_missing_prereqs['permission_model'] ?? '' ) && 'runtime-principal' === ( $browser_session_missing_prereqs['session']['permission_model'] ?? '' ) );
$assert( 'browser Playground session with missing prerequisites does not emit ready-to-code or recipe', ! is_wp_error( $browser_session_missing_prereqs ) && false === ( $browser_session_missing_prereqs['signals']['ready_to_code']['emitted'] ?? true ) && ! array_key_exists( 'recipe', $browser_session_missing_prereqs ) && in_array( 'provider_plugin', $browser_session_missing_prereqs['signals']['ready_to_code']['missing'] ?? array(), true ) && in_array( 'provider_secret', $browser_session_missing_prereqs['signals']['ready_to_code']['missing'] ?? array(), true ) );

unset( $GLOBALS['wp_codebox_mock_abilities']['agents/chat'] );
$browser_session_missing_agents_api = call_user_func(
	$browser_session_ability['execute_callback'],
	array(
		'goal'                  => 'Prepare a browser preview without Agents API.',
		'provider_plugin_paths' => array( $root . '/ai-provider-test' ),
		'inherit'               => array( 'connectors' => array( 'openai' ) ),
	)
);
$assert( 'browser Playground session blocks when caller-declared Agents API prerequisite is missing', ! is_wp_error( $browser_session_missing_agents_api ) && false === ( $browser_session_missing_agents_api['success'] ?? true ) && in_array( 'component:agents-api', $browser_session_missing_agents_api['signals']['ready_to_code']['missing'] ?? array(), true ) && ! array_key_exists( 'recipe', $browser_session_missing_agents_api ) );
$GLOBALS['wp_codebox_mock_abilities']['agents/chat'] = new WP_Ability();

$component_contracts_filter = $GLOBALS['wp_codebox_filters']['wp_codebox_component_contracts'];
$GLOBALS['wp_codebox_filters']['wp_codebox_component_contracts'] = array_values( array_filter( $component_contracts_filter, static fn( array $contract ): bool => 'data-machine' !== ( $contract['slug'] ?? '' ) ) );
$registry_filter = $GLOBALS['wp_codebox_filters']['wp_codebox_browser_runtime_component_registry'] ?? null;
// Register only agents-api + data-machine-code (omit data-machine) so the
// missing-Data-Machine prerequisite path is exercised. The generic default is
// empty, so the consumer-style registration here is the full source of truth.
$GLOBALS['wp_codebox_filters']['wp_codebox_browser_runtime_component_registry'] = static function ( array $registry ): array {
	$defaults = array(
		'agents-api'        => 'https://github.com/Automattic/agents-api/releases/latest/download/agents-api.zip',
		'data-machine-code' => 'https://github.com/Extra-Chill/data-machine-code/releases/latest/download/data-machine-code.zip',
	);
	foreach ( $defaults as $slug => $url ) {
		$registry[ $slug ] = array(
			'resource'         => 'url',
			'url'              => $url,
			'targetFolderName' => $slug,
			'activate'         => true,
			'provenance'       => array( 'source' => 'runtime-component-registry' ),
		);
	}
	unset( $registry['data-machine'] );
	return $registry;
};
$browser_session_missing_data_machine = call_user_func(
	$browser_session_ability['execute_callback'],
	array(
		'goal'                  => 'Prepare a browser preview without Data Machine.',
		'provider_plugin_paths' => array( $root . '/ai-provider-test' ),
		'inherit'               => array( 'connectors' => array( 'openai' ) ),
	)
);
$assert( 'browser Playground session blocks when caller-declared component prerequisite is missing', ! is_wp_error( $browser_session_missing_data_machine ) && false === ( $browser_session_missing_data_machine['success'] ?? true ) && in_array( 'component:data-machine', $browser_session_missing_data_machine['signals']['ready_to_code']['missing'] ?? array(), true ) && ! array_key_exists( 'recipe', $browser_session_missing_data_machine ) );
$GLOBALS['wp_codebox_filters']['wp_codebox_component_contracts'] = $component_contracts_filter;
if ( null !== $registry_filter ) {
	$GLOBALS['wp_codebox_filters']['wp_codebox_browser_runtime_component_registry'] = $registry_filter;
} else {
	unset( $GLOBALS['wp_codebox_filters']['wp_codebox_browser_runtime_component_registry'] );
}

$browser_session_missing_secret = call_user_func(
	$browser_session_ability['execute_callback'],
	array(
		'goal'                  => 'Prepare a browser preview without provider secret.',
		'provider_plugin_paths' => array( $root . '/ai-provider-test' ),
	)
);
$assert( 'browser Playground session blocks when provider secret prerequisite is missing', ! is_wp_error( $browser_session_missing_secret ) && false === ( $browser_session_missing_secret['success'] ?? true ) && in_array( 'provider_secret', $browser_session_missing_secret['signals']['ready_to_code']['missing'] ?? array(), true ) && ! array_key_exists( 'recipe', $browser_session_missing_secret ) );
rmdir( $root . '/plugin-root/data-machine-code' );
rmdir( $root . '/plugin-root/data-machine' );
unlink( $root . '/plugin-root/generic-caller-plugin/generic-caller-plugin.php' );
rmdir( $root . '/plugin-root/generic-caller-plugin' );

$custom_browser_session = call_user_func(
	$browser_session_ability['execute_callback'],
	array(
		'goal'           => 'Prepare a custom browser preview.',
		'playground'     => array(
			'artifact_base_path' => '/wordpress/wp-content/uploads/example-preview',
			'artifact_base_url'  => '/wp-content/uploads/example-preview',
			'preview_url'        => '/wp-content/uploads/example-preview/repair-output/index.html',
		),
		'artifact_files' => array(
			array(
				'path'    => 'repair-output/index.html',
				'content' => '<main>Custom</main>',
			),
		),
	)
);
$assert( 'browser Playground session honors custom artifact base path', ! is_wp_error( $custom_browser_session ) && '/wordpress/wp-content/uploads/example-preview/repair-output/index.html' === ( $custom_browser_session['artifacts']['files'][0]['playground_path'] ?? '' ) );
$assert( 'browser Playground session honors custom preview URL', ! is_wp_error( $custom_browser_session ) && '/wp-content/uploads/example-preview/repair-output/index.html' === ( $custom_browser_session['playground']['preview_url'] ?? '' ) );

$invalid_browser_file = call_user_func(
	$browser_session_ability['execute_callback'],
	array(
		'goal'           => 'Prepare an unsafe browser preview.',
		'artifact_files' => array(
			array(
				'path'    => '../secret.txt',
				'content' => 'nope',
			),
		),
	)
);
$assert( 'browser Playground session rejects unsafe artifact paths', is_wp_error( $invalid_browser_file ) && 'wp_codebox_browser_artifact_path_invalid' === $invalid_browser_file->get_error_code() );

$browser_executable_artifact = call_user_func(
	$browser_session_ability['execute_callback'],
	array(
		'goal'           => 'Prepare an executable artifact.',
		'artifact_files' => array(
			array(
				'path'    => 'uploads/shell.php',
				'content' => '<?php echo "nope";',
			),
		),
	)
);
$assert( 'browser Playground session rejects server-side executable artifact extensions', is_wp_error( $browser_executable_artifact ) && 'wp_codebox_browser_artifact_extension_blocked' === $browser_executable_artifact->get_error_code() && 'php' === ( $browser_executable_artifact->get_error_data()['extension'] ?? '' ) );

$browser_oversized_artifact = call_user_func(
	$browser_session_ability['execute_callback'],
	array(
		'goal'           => 'Prepare an oversized artifact.',
		'artifact_files' => array(
			array(
				'path'    => 'assets/large.txt',
				'content' => str_repeat( 'a', 5242881 ),
			),
		),
	)
);
$assert( 'browser Playground session rejects oversized artifact files explicitly', is_wp_error( $browser_oversized_artifact ) && 'wp_codebox_browser_artifact_file_too_large' === $browser_oversized_artifact->get_error_code() && 5242881 === ( $browser_oversized_artifact->get_error_data()['size'] ?? 0 ) && 5242880 === ( $browser_oversized_artifact->get_error_data()['max_size'] ?? 0 ) );

$captured_command  = '';
$captured_commands = array();
$captured_recipe   = '';
$captured_recipes  = array();
$captured_secret_env = array();
$captured_timeout  = null;
$command_count     = 0;
$runner           = new WP_Codebox_Agent_Sandbox_Runner(
	array(
		'shell_available' => fn() => true,
		'command_runner'  => function ( string $command, array $secret_env = array(), int $timeout_seconds = 0 ) use ( &$captured_command, &$captured_commands, &$captured_recipe, &$captured_recipes, &$captured_secret_env, &$captured_timeout, &$command_count ): array {
			++$command_count;
			$captured_command    = $command;
			$captured_commands[] = $command;
			$captured_secret_env = $secret_env;
			$captured_timeout    = $timeout_seconds;
			if ( preg_match( "/--recipe '([^']+)'/", $command, $matches ) && is_readable( $matches[1] ) ) {
				$captured_recipe   = (string) file_get_contents( $matches[1] );
				$captured_recipes[] = $captured_recipe;
			}
			$artifact_id = 1 === $command_count ? 'artifact-bundle-sha256-fixture' : 'artifact-bundle-sha256-fixture-' . $command_count;
			return array(
				'exit_code' => 0,
				'output'    => json_encode(
					array(
						'success'   => true,
						'runtime'   => array( 'backend' => 'wordpress-playground' ),
						'artifacts' => array(
							'id'      => $artifact_id,
							'preview' => array(
								'url'      => str_contains( $command, 'https://preview.example.test/session-123/' ) ? 'https://preview.example.test/session-123/' : ( str_contains( $command, 'https://preview.example.test/batch/' ) ? 'https://preview.example.test/batch/' : 'http://127.0.0.1:' . ( 12344 + $command_count ) ),
								'localUrl' => 'http://127.0.0.1:' . ( 12344 + $command_count ),
							),
						),
						'agentResult' => array(
							'schema'       => 'wp-codebox/agent-result/v1',
							'status'       => 'completed',
							'actionable'   => false,
							'summary'      => 'Agent sandbox completed without actionable file changes.',
							'noOpReason'   => 'no_file_changes',
							'changedFiles' => array(
								'count'    => 0,
								'paths'    => array(),
								'artifact' => 'files/changed-files.json',
							),
							'patch'        => array(
								'bytes'    => 0,
								'artifact' => 'files/patch.diff',
							),
							'transcript'   => array(
								'artifact'       => 'files/transcript.json',
								'executionCount' => 1,
							),
						),
						'agentTaskResult' => array(
							'schema'      => 'wp-codebox/agent-task-result/v1',
							'success'     => true,
							'status'      => 'completed',
							'outputs'     => array(
								'issue_number' => 614,
								'issue_url'    => 'https://github.com/Automattic/wp-codebox/issues/614',
							),
							'diagnostics' => array(
								'runtime' => array( 'run_id' => 'runtime-run-123' ),
							),
							'raw'         => array(
								'agent_runtime' => array(
									'success' => true,
									'result'  => array( 'outputs' => array( 'issue_number' => 614 ) ),
								),
							),
						),
						'completionOutcome' => array(
							'schema'       => 'wp-codebox/sandbox-completion-outcome/v1',
							'status'       => 'partial',
							'summary'      => 'Agent sandbox completed without actionable file changes.',
							'changedFiles' => array(
								'count'    => 0,
								'paths'    => array(),
								'artifact' => 'files/changed-files.json',
							),
							'patch'        => array(
								'bytes'    => 0,
								'artifact' => 'files/patch.diff',
							),
							'verification' => array(
								'transcript' => array( 'artifact' => 'files/transcript.json', 'executionCount' => 1 ),
								'commands'   => array(
									array( 'command' => 'wp-codebox.agent-sandbox-run', 'exitCode' => 0 ),
								),
							),
							'blockers'     => array(),
							'provenance'   => array(
								'artifactBundleId'  => $artifact_id,
								'artifactDirectory' => 'artifact-directory-fixture',
							),
						),
					)
				),
			);
		},
	)
);

$result = $runner->run(
	array(
		'goal'           => 'Run a chat-requested sandbox task.',
		'sandbox_session_id' => 'parent-job-123',
		'session_id'     => 'agent-chat-session-456',
		'orchestrator'   => array(
			'type'   => 'external-job-system',
			'id'     => 'parent-control-plane',
			'job_id' => 'job-123',
		),
		'artifacts_path' => $root . '/artifacts',
		'provider_plugin_paths' => array( $root . '/ai-provider-test' ),
		'component_contracts' => $component_contracts,
		'secret_env'     => array( 'GITHUB_TOKEN' ),
		'preview_hold_seconds' => 30,
		'preview_port'   => 45678,
		'preview_bind'   => '127.0.0.1',
		'preview_public_url' => 'https://preview.example.test/session-123/',
		'task_timeout_seconds' => 7200,
		'mounts'         => array(
			array(
				'source'   => $root . '/editable-plugin',
				'target'   => '/wordpress/wp-content/plugins/editable-plugin',
				'mode'     => 'readwrite',
				'metadata' => array(
					'kind'                        => 'component',
					'slug'                        => 'editable-plugin',
					'repo'                        => 'example/editable-plugin',
					'default_branch'              => 'main',
					'repo_root_relative_to_mount' => '.',
					'editable'                    => true,
				),
			),
		),
	)
);

$assert( 'runner succeeds with filter-provided component contracts', ! is_wp_error( $result ) && true === ( $result['success'] ?? false ) );
$assert( 'runner schema is stable', ! is_wp_error( $result ) && 'wp-codebox/agent-task-run/v1' === ( $result['schema'] ?? '' ) );
$assert( 'runner returns caller-owned sandbox session envelope', ! is_wp_error( $result ) && 'wp-codebox/sandbox-session/v1' === ( $result['session']['schema'] ?? '' ) && 'parent-job-123' === ( $result['session']['id'] ?? '' ) && 'external-orchestrator' === ( $result['session']['persistence'] ?? '' ) );
$assert( 'runner keeps agent session separate from sandbox session', ! is_wp_error( $result ) && 'agent-chat-session-456' === ( $result['session']['agent_session_id'] ?? '' ) && str_contains( $captured_recipe, 'session-id=agent-chat-session-456' ) );
$assert( 'runner returns orchestrator correlation and artifact refs', ! is_wp_error( $result ) && 'job-123' === ( $result['session']['orchestrator']['job_id'] ?? '' ) && 'artifact-bundle-sha256-fixture' === ( $result['session']['artifacts']['bundle_id'] ?? '' ) );
$assert( 'runner returns public preview URL in session artifact metadata', ! is_wp_error( $result ) && 'https://preview.example.test/session-123/' === ( $result['session']['artifacts']['preview_url'] ?? '' ) && 'https://preview.example.test/session-123/' === ( $result['run']['artifacts']['preview']['url'] ?? '' ) );
$assert( 'runner surfaces normalized agent result summary', ! is_wp_error( $result ) && 'wp-codebox/agent-result/v1' === ( $result['agent_result']['schema'] ?? '' ) && false === ( $result['agent_result']['actionable'] ?? true ) && 'no_file_changes' === ( $result['agent_result']['noOpReason'] ?? '' ) && 'files/transcript.json' === ( $result['agent_result']['transcript']['artifact'] ?? '' ) );
$assert( 'runner surfaces single runtime agent task result envelope', ! is_wp_error( $result ) && 'wp-codebox/agent-task-result/v1' === ( $result['agent_task_result']['schema'] ?? '' ) && 614 === ( $result['agent_task_result']['outputs']['issue_number'] ?? 0 ) && ! isset( $result['agent_task_result']['scenarios'] ) && 'files/agent-task-result.json' === ( $result['session']['artifacts']['agent_task_result'] ?? '' ) );
$assert( 'runner surfaces generic completion outcome', ! is_wp_error( $result ) && 'wp-codebox/sandbox-completion-outcome/v1' === ( $result['completion_outcome']['schema'] ?? '' ) && 'partial' === ( $result['completion_outcome']['status'] ?? '' ) && 'files/completion-outcome.json' === ( $result['session']['artifacts']['completion_outcome'] ?? '' ) );
$assert( 'runner returns normalized canonical task input', ! is_wp_error( $result ) && 'wp-codebox/task-input/v1' === ( $result['task_input']['schema'] ?? '' ) && 'Run a chat-requested sandbox task.' === ( $result['task_input']['goal'] ?? '' ) );
$assert( 'runner invokes recipe-run', str_contains( $captured_command, 'recipe-run' ) );
$assert( 'runner uses node for JS CLI', str_contains( $captured_command, 'node' ) && str_contains( $captured_command, 'wp-codebox.js' ) );
$assert( 'runner passes preview hold to CLI', str_contains( $captured_command, '--preview-hold' ) && str_contains( $captured_command, "'30'" ) );
$assert( 'runner passes preview configuration to CLI', str_contains( $captured_command, '--preview-port' ) && str_contains( $captured_command, "'45678'" ) && str_contains( $captured_command, '--preview-bind' ) && str_contains( $captured_command, "'127.0.0.1'" ) && str_contains( $captured_command, '--preview-public-url' ) && str_contains( $captured_command, "'https://preview.example.test/session-123/'" ) );
$assert( 'runner recipe uses agent step', str_contains( $captured_recipe, 'wp-codebox.agent-sandbox-run' ) );
$assert( 'runner recipe passes task', str_contains( $captured_recipe, 'Run a chat-requested sandbox task.' ) );
$assert( 'runner recipe passes default agent', str_contains( $captured_recipe, 'site-coder' ) );
$assert( 'runner recipe passes sandbox mode', str_contains( $captured_recipe, 'sandbox' ) );
$assert( 'runner recipe passes default provider', str_contains( $captured_recipe, 'openai' ) );
$assert( 'runner recipe passes default model', str_contains( $captured_recipe, 'gpt-5.5' ) );
$assert( 'runner recipe passes provider plugin path', str_contains( $captured_recipe, 'ai-provider-test' ) );
$assert( 'runner recipe loads runtime components as mu-plugins', str_contains( $captured_recipe, '"slug":"agents-api","activate":false,"loadAs":"mu-plugin"' ) && str_contains( $captured_recipe, '"slug":"data-machine","activate":false,"loadAs":"mu-plugin"' ) && str_contains( $captured_recipe, '"slug":"data-machine-code","activate":false,"loadAs":"mu-plugin"' ) );
$assert( 'runner recipe passes generic mount metadata', str_contains( $captured_recipe, 'example/editable-plugin' ) && str_contains( $captured_recipe, 'repo_root_relative_to_mount' ) );
$assert( 'runner recipe passes secret env name only', str_contains( $captured_recipe, 'GITHUB_TOKEN' ) && ! str_contains( $captured_recipe, 'GITHUB_TOKEN=' ) );
$assert( 'runner passes timeout to command runner and recipe', 7200 === $captured_timeout && str_contains( $captured_recipe, 'timeout-seconds=7200' ) );
$assert( 'runner does not pass raw code options', ! str_contains( $captured_command, '--code ' ) && ! str_contains( $captured_command, '--code-file' ) );

$caller_adapter_result = $runner->run(
	array(
		'runtime_task' => array(
			'ability' => 'runtime/run-agent-bundle',
			'input'   => array(
				'source'              => '/wordpress/wp-content/wp-codebox-inputs/site-generator-agent.json',
				'flow'                => 'static-site-manual-flow',
				'wait_for_completion' => true,
				'dry_run'             => true,
			),
			'metadata' => array(
				'owner' => 'caller-adapter',
			),
		),
		'component_contracts' => $component_contracts,
		'parent_request' => array(
			'schema'               => 'wp-codebox/task-input/v1',
			'version'              => 1,
			'goal'                 => 'Run the canonical parent Codebox task.',
			'expected_artifacts'   => array( 'patch' ),
			'policy'               => array( 'kind' => 'audit-remediation' ),
			'context'              => array( 'group_key' => 'smoke' ),
			'provider'             => 'openai',
			'model'                => 'gpt-5.5',
			'provider_plugin_paths' => array( $root . '/ai-provider-test' ),
			'agent_bundles'        => array(
				array(
					'source'      => $root . '/site-generator-agent.json',
					'slug'        => 'site-generator',
					'on_conflict' => 'upgrade',
				),
				array(
					'bundle' => array(
						'bundle_version' => '1.0.0',
						'agent'          => array(
							'agent_slug'   => 'repair-agent',
							'agent_name'   => 'Repair Agent',
							'agent_config' => array(),
						),
					),
					'slug'   => 'repair-agent',
				),
			),
			'secret_env'           => array( 'GITHUB_TOKEN' ),
			'mounts'               => array(
				array(
					'source'   => $root . '/editable-plugin',
					'target'   => '/workspace/editable-plugin',
					'mode'     => 'readwrite',
					'metadata' => array( 'kind' => 'caller-audit-fanout' ),
				),
			),
			'runtime_stack_mounts' => array(
				array(
					'source' => $root . '/agents-api',
					'target' => '/runtime/agents-api',
					'mode'   => 'readonly',
				),
			),
			'runtime_overlays'     => array(
				array(
					'id'     => 'caller-runtime-overlay',
					'source' => $root . '/data-machine-code',
				),
			),
			'task_timeout_seconds' => 3600,
			'max_turns'            => 8,
			'sandbox_session_id'   => 'caller-sandbox-session-123',
			'group_key'            => 'caller-group-key',
			'audit_findings'       => array( array( 'id' => 'finding-1', 'summary' => 'Finding one' ) ),
			'artifacts'            => $root . '/artifacts/caller-adapter',
			'orchestrator'         => array(
				'type'          => 'caller-adapter',
				'id'            => 'caller-agent-task',
				'job_id'        => 'caller-job-123',
				'agent_task_id' => 'agent-task-123',
			),
			'workspaces'           => array(
				array( 'seed' => array( 'slug' => 'editable-plugin', 'path' => $root . '/editable-plugin' ) ),
			),
			'component_contracts'  => $component_contracts,
		),
	)
);
$caller_adapter_recipe = json_decode( $captured_recipe, true );
$caller_adapter_step_args = $caller_adapter_recipe['workflow']['steps'][0]['args'] ?? array();
$caller_adapter_runtime_task_arg = '';
foreach ( $caller_adapter_step_args as $caller_adapter_step_arg ) {
	if ( is_string( $caller_adapter_step_arg ) && str_starts_with( $caller_adapter_step_arg, 'runtime-task-json=' ) ) {
		$caller_adapter_runtime_task_arg = substr( $caller_adapter_step_arg, strlen( 'runtime-task-json=' ) );
		break;
	}
}
$caller_adapter_runtime_task = '' !== $caller_adapter_runtime_task_arg ? json_decode( $caller_adapter_runtime_task_arg, true ) : array();
$assert( 'runner accepts canonical parent request', ! is_wp_error( $caller_adapter_result ) && true === ( $caller_adapter_result['success'] ?? false ) && 'caller-sandbox-session-123' === ( $caller_adapter_result['session']['id'] ?? '' ) );
$assert( 'runner maps canonical parent artifacts and orchestrator metadata', ! is_wp_error( $caller_adapter_result ) && $root . '/artifacts/caller-adapter' === ( $caller_adapter_result['artifacts'] ?? '' ) && 'caller-job-123' === ( $caller_adapter_result['session']['orchestrator']['job_id'] ?? '' ) && 'agent-task-123' === ( $caller_adapter_result['session']['orchestrator']['agent_task_id'] ?? '' ) );
$assert( 'runner returns stable canonical parent diagnostics evidence and metadata refs', ! is_wp_error( $caller_adapter_result ) && in_array( (string) ( $caller_adapter_result['status'] ?? '' ), array( 'completed', 'failed' ), true ) && 'wp-codebox/agent-task-diagnostics/v1' === ( $caller_adapter_result['diagnostics']['schema'] ?? '' ) && 'wp-codebox/agent-task-evidence-refs/v1' === ( $caller_adapter_result['evidence_refs']['schema'] ?? '' ) && 'artifact-bundle-sha256-fixture-2' === ( $caller_adapter_result['evidence_refs']['artifact_bundle_id'] ?? '' ) && 'files/agent-task-result.json' === ( $caller_adapter_result['evidence_refs']['agent_task_result'] ?? '' ) && 'files/transcript.json' === ( $caller_adapter_result['evidence_refs']['transcript'] ?? '' ) && 'wp-codebox/agent-task-run-metadata/v1' === ( $caller_adapter_result['run_metadata']['schema'] ?? '' ) && 'caller-sandbox-session-123' === ( $caller_adapter_result['run_metadata']['sandbox_session_id'] ?? '' ) );
$assert( 'runner maps canonical parent provider plugins and secrets', in_array( 'provider-plugin-slugs=ai-provider-test', $caller_adapter_step_args, true ) && str_contains( $captured_recipe, 'GITHUB_TOKEN' ) && ! str_contains( $captured_recipe, 'GITHUB_TOKEN=' ) );
$assert( 'runner preserves multiple runtime agent bundles in recipe inputs and step args', 2 === count( $caller_adapter_recipe['inputs']['agent_bundles'] ?? array() ) && str_contains( implode( "\n", $caller_adapter_step_args ), 'agent-bundles-json=' ) && str_contains( $captured_recipe, 'site-generator-agent.json' ) && str_contains( $captured_recipe, 'repair-agent' ) );
$assert( 'runner passes generic runtime task execution request to sandbox step', is_array( $caller_adapter_runtime_task ) && 'runtime/run-agent-bundle' === ( $caller_adapter_runtime_task['ability'] ?? '' ) && 'static-site-manual-flow' === ( $caller_adapter_runtime_task['input']['flow'] ?? '' ) && true === ( $caller_adapter_runtime_task['input']['wait_for_completion'] ?? false ) && true === ( $caller_adapter_runtime_task['input']['dry_run'] ?? false ) );
$assert( 'runner maps canonical parent timeout and max turns', 3600 === $captured_timeout && in_array( 'timeout-seconds=3600', $caller_adapter_step_args, true ) && in_array( 'max-turns=8', $caller_adapter_step_args, true ) );
$assert( 'runner maps canonical parent runtime stack mounts and overlays', '/runtime/agents-api' === ( $caller_adapter_recipe['runtime']['stack']['mounts'][0]['target'] ?? '' ) && 'caller-runtime-overlay' === ( $caller_adapter_recipe['runtime']['overlays'][0]['id'] ?? '' ) );
$assert( 'runner maps canonical parent workspaces without downstream recipe generation', 1 === count( $caller_adapter_recipe['inputs']['workspaces'] ?? array() ) && ! str_contains( $captured_recipe, 'Use Data Machine Code workspace repos' ) );
$assert( 'runner maps canonical parent component contracts', str_contains( $captured_recipe, 'agents-api' ) && str_contains( $captured_recipe, 'data-machine' ) && str_contains( $captured_recipe, 'data-machine-code' ) );
$assert( 'runner passes canonical parent task context to sandbox agent', str_contains( $captured_recipe, 'caller-group-key' ) && str_contains( $captured_recipe, 'finding-1' ) && str_contains( $captured_recipe, 'agent-task-123' ) );

$GLOBALS['wp_codebox_options']['blogname'] = 'Parent Seed Site';
$GLOBALS['wp_codebox_options']['active_plugins'] = array( 'agents-api/agents-api.php' );
$seed_result = $runner->run(
	array(
		'goal'           => 'Run with a bounded parent-site seed.',
		'artifacts_path' => $root . '/artifacts',
		'site_seeds'    => array(
			array(
				'type'   => 'parent_site',
				'name'   => 'parent-site-smoke',
				'scopes' => array(
					'posts'         => array( 'postTypes' => array( 'page' ), 'maxRecords' => 1 ),
					'terms'         => array( 'taxonomies' => array( 'category' ), 'maxRecords' => 1 ),
					'options'       => array( 'names' => array( 'blogname' ), 'maxRecords' => 1 ),
					'users'         => array( 'roles' => array( 'editor' ), 'anonymize' => true, 'maxRecords' => 1 ),
					'media'         => array( 'maxRecords' => 1 ),
					'activePlugins' => true,
					'activeTheme'   => true,
				),
			),
		),
	)
);
$seed_recipe = json_decode( $captured_recipe, true );
$seed_path   = (string) ( $seed_recipe['inputs']['siteSeeds'][0]['source'] ?? '' );
$assert( 'runner exports bounded parent-site seed as fixture', ! is_wp_error( $seed_result ) && 'fixture' === ( $seed_recipe['inputs']['siteSeeds'][0]['type'] ?? '' ) && 'json' === ( $seed_recipe['inputs']['siteSeeds'][0]['format'] ?? '' ) );
$assert( 'runner cleans temporary parent-site seed fixture after run', ! is_wp_error( $seed_result ) && '' !== $seed_path && ! file_exists( $seed_path ) );
$assert( 'runner preserves parent-site seed scope in recipe', ! is_wp_error( $seed_result ) && 1 === ( $seed_recipe['inputs']['siteSeeds'][0]['scopes']['posts']['maxRecords'] ?? 0 ) && true === ( $seed_recipe['inputs']['siteSeeds'][0]['scopes']['users']['anonymize'] ?? false ) );

unset( $GLOBALS['wp_codebox_filters']['wp_codebox_bin'] );
$bundled_runtime_result = $runner->run(
	array(
		'goal'           => 'Run with the packaged WP Codebox CLI runtime.',
		'artifacts_path' => $root . '/artifacts',
	)
);
$assert( 'runner defaults to packaged CLI wrapper when present', ! is_wp_error( $bundled_runtime_result ) && str_contains( $captured_command, WP_CODEBOX_PLUGIN_PATH . 'vendor/wp-codebox-cli/bin/wp-codebox' ) );
$assert( 'runner preflights packaged Node runtime', ! is_wp_error( $bundled_runtime_result ) && ! str_contains( $captured_command, 'node: not found' ) );

$GLOBALS['wp_codebox_filters']['wp_codebox_bin'] = $root . '/wp-codebox.js';

$GLOBALS['wp_codebox_filters']['wp_codebox_default_provider'] = '';
$GLOBALS['wp_codebox_filters']['wp_codebox_default_model']    = '';
$GLOBALS['wp_codebox_filters']['wp_codebox_resolve_inheritance'] = function ( array $resolution, array $request ) use ( $root ): array {
	$resolution['connectors'] = array(
		array(
			'name'       => $request['connectors'][0] ?? 'primary-ai',
			'status'     => 'resolved',
			'provider'   => 'openai',
			'model'      => 'gpt-5.5',
			'provider_plugin_paths' => array( $root . '/ai-provider-inherited' ),
			'secret_env' => array( 'OPENAI_API_KEY' ),
			'secret_env_values' => array( 'OPENAI_API_KEY' => 'sk-test-secret-value' ),
			'credentials' => array(
				'schema'    => 'wp-codebox/connector-credentials/v1',
				'connector' => $request['connectors'][0] ?? 'primary-ai',
				'scope'     => 'connector',
				'status'    => 'available',
				'secrets'   => array(
					array(
						'name'   => 'OPENAI_API_KEY',
						'status' => 'available',
						'scope'  => 'primary-ai',
						'source' => 'parent-env',
					),
				),
			),
			'value'      => 'sk-test-secret-value',
			'token'      => 'sk-test-secret-value',
		),
	);
	$resolution['settings']   = array(
		array(
			'name'   => $request['settings'][0] ?? 'mode_models',
			'status' => 'resolved',
			'scope'  => 'site',
			'value'  => 'sk-test-secret-value',
		),
	);

	return $resolution;
};

$inherit_result = $runner->run(
	array(
		'goal'           => 'Use inherited connector configuration.',
		'artifacts_path' => $root . '/artifacts',
		'inherit'        => array(
			'connectors' => array( 'primary-ai' ),
			'settings'   => array( 'mode_models' ),
		),
	)
);
$inherit_recipe    = json_decode( $captured_recipe, true );
$inherit_step_args = $inherit_recipe['workflow']['steps'][0]['args'] ?? array();
$inherit_result_encoded = ! is_wp_error( $inherit_result ) ? json_encode( $inherit_result, JSON_UNESCAPED_SLASHES ) : '';
$assert( 'runner resolves inherited connector provider', ! is_wp_error( $inherit_result ) && in_array( 'provider=openai', $inherit_step_args, true ) );
$assert( 'runner resolves inherited connector model', ! is_wp_error( $inherit_result ) && in_array( 'model=gpt-5.5', $inherit_step_args, true ) );
$assert( 'runner mounts inherited provider plugin path', ! is_wp_error( $inherit_result ) && str_contains( $captured_recipe, 'ai-provider-inherited' ) && in_array( 'provider-plugin-slugs=ai-provider-inherited', $inherit_step_args, true ) );
$assert( 'runner transports inherited secret env name only', ! is_wp_error( $inherit_result ) && in_array( 'OPENAI_API_KEY', $inherit_recipe['inputs']['secretEnv'] ?? array(), true ) && ! str_contains( $captured_recipe, 'OPENAI_API_KEY=' ) );
$assert( 'runner passes inherited secret env value to command runner', ! is_wp_error( $inherit_result ) && 'sk-test-secret-value' === ( $captured_secret_env['OPENAI_API_KEY'] ?? '' ) );
$assert( 'runner records connector credential provenance without value', ! is_wp_error( $inherit_result ) && 'wp-codebox/connector-credentials/v1' === ( $inherit_recipe['inputs']['inheritance']['connectors'][0]['credentials']['schema'] ?? '' ) && 'available' === ( $inherit_recipe['inputs']['inheritance']['connectors'][0]['credentials']['secrets'][0]['status'] ?? '' ) );
$assert( 'runner records sanitized inheritance status', ! is_wp_error( $inherit_result ) && 'primary-ai' === ( $inherit_recipe['inputs']['inheritance']['connectors'][0]['name'] ?? '' ) && 'resolved' === ( $inherit_recipe['inputs']['inheritance']['settings'][0]['status'] ?? '' ) );
$assert( 'runner drops inherited secret values from recipe', ! str_contains( $captured_recipe, 'sk-test-secret-value' ) && ! str_contains( $captured_recipe, 'token' ) );
$assert( 'runner keeps process secret env out of recipe artifacts', ! str_contains( $captured_recipe, 'process_secret_env' ) );
$assert( 'runner keeps process secret env out of response', ! str_contains( $inherit_result_encoded, 'process_secret_env' ) && ! str_contains( $inherit_result_encoded, 'sk-test-secret-value' ) );

$GLOBALS['wp_codebox_filters']['wp_codebox_resolve_inheritance'] = function ( array $resolution, array $request ): array {
	$resolution['connectors'] = array(
		array(
			'name'        => $request['connectors'][0] ?? 'primary-ai',
			'status'      => 'resolved',
			'provider'    => 'openai',
			'model'       => 'gpt-5.5',
			'credentials' => array(
				'schema'    => 'wp-codebox/connector-credentials/v1',
				'connector' => $request['connectors'][0] ?? 'primary-ai',
				'scope'     => 'connector',
				'status'    => 'denied',
				'reason'    => 'scope not approved',
				'secrets'   => array(
					array(
						'name'   => 'OPENAI_API_KEY',
						'status' => 'denied',
						'scope'  => 'primary-ai',
						'source' => 'connector',
						'reason' => 'scope not approved',
					),
				),
			),
		),
	);

	return $resolution;
};

$denied_credentials = $runner->run(
	array(
		'goal'           => 'Use denied connector credentials.',
		'artifacts_path' => $root . '/artifacts',
		'inherit'        => array( 'connectors' => array( 'primary-ai' ) ),
	)
);
$assert( 'denied connector credential scope fails closed', is_wp_error( $denied_credentials ) && 'wp_codebox_connector_credentials_unavailable' === $denied_credentials->get_error_code() );
$assert( 'denied connector credential failure is observable and redacted', is_wp_error( $denied_credentials ) && 'wp-codebox/connector-credential-failure/v1' === ( $denied_credentials->get_error_data()['schema'] ?? '' ) && ! str_contains( json_encode( $denied_credentials->get_error_data() ), 'sk-test-secret-value' ) );

$GLOBALS['wp_codebox_filters']['wp_codebox_resolve_inheritance'] = function ( array $resolution, array $request ): array {
	$resolution['connectors'] = array(
		array(
			'name'        => $request['connectors'][0] ?? 'primary-ai',
			'status'      => 'resolved',
			'provider'    => 'openai',
			'model'       => 'gpt-5.5',
			'credentials' => array(
				'schema'    => 'wp-codebox/connector-credentials/v1',
				'connector' => $request['connectors'][0] ?? 'primary-ai',
				'scope'     => 'connector',
				'status'    => 'missing',
				'secrets'   => array(
					array( 'name' => 'OPENAI_API_KEY', 'status' => 'missing', 'scope' => 'primary-ai', 'source' => 'parent-env' ),
				),
			),
		),
	);

	return $resolution;
};

$missing_credentials = $runner->run(
	array(
		'goal'           => 'Use missing connector credentials.',
		'artifacts_path' => $root . '/artifacts',
		'inherit'        => array( 'connectors' => array( 'primary-ai' ) ),
	)
);
$assert( 'missing connector credential scope fails closed', is_wp_error( $missing_credentials ) && 'wp_codebox_connector_credentials_unavailable' === $missing_credentials->get_error_code() );

$GLOBALS['wp_codebox_filters']['wp_codebox_default_provider'] = 'openai';
$GLOBALS['wp_codebox_filters']['wp_codebox_default_model']    = 'gpt-5.5';
unset( $GLOBALS['wp_codebox_filters']['wp_codebox_resolve_inheritance'] );

$raw_code = $runner->run(
	array(
		'goal'           => 'Run a chat-requested sandbox task.',
		'artifacts_path' => $root . '/artifacts',
		'code'           => '<?php echo "raw";',
	)
);
$assert( 'raw code input fails closed', is_wp_error( $raw_code ) && 'wp_codebox_raw_code_forbidden' === $raw_code->get_error_code() );

$raw_code_file = $runner->run(
	array(
		'goal'           => 'Run a chat-requested sandbox task.',
		'artifacts_path' => $root . '/artifacts',
		'code_file'      => '/tmp/raw.php',
	)
);
$assert( 'raw code file input fails closed', is_wp_error( $raw_code_file ) && 'wp_codebox_raw_code_forbidden' === $raw_code_file->get_error_code() );

$invalid_mount = $runner->run(
	array(
		'goal'           => 'Run a chat-requested sandbox task.',
		'artifacts_path' => $root . '/artifacts',
		'mounts'         => array(
			array(
				'source' => $root . '/missing-plugin',
				'target' => '/wordpress/wp-content/plugins/missing-plugin',
			),
		),
	)
);
$assert( 'invalid mount input fails closed', is_wp_error( $invalid_mount ) && 'wp_codebox_mount_source_invalid' === $invalid_mount->get_error_code() );

$invalid_preview_bind = $runner->run(
	array(
		'goal'           => 'Run a chat-requested sandbox task.',
		'artifacts_path' => $root . '/artifacts',
		'preview_bind'   => '0.0.0.0',
	)
);
$assert( 'preview bind without preview port fails closed', is_wp_error( $invalid_preview_bind ) && 'wp_codebox_preview_bind_requires_port' === $invalid_preview_bind->get_error_code() );

$invalid_preview_url = $runner->run(
	array(
		'goal'               => 'Run a chat-requested sandbox task.',
		'artifacts_path'     => $root . '/artifacts',
		'preview_public_url' => 'file:///tmp/preview',
	)
);
$assert( 'invalid preview public URL fails closed', is_wp_error( $invalid_preview_url ) && 'wp_codebox_preview_public_url_invalid' === $invalid_preview_url->get_error_code() );

$structured_result = $runner->run(
	array(
		'goal'               => 'Add a focused product feature.',
		'target'             => array(
			'kind' => 'plugin',
			'path' => 'wp-content/plugins/simple-plugin',
		),
		'allowed_tools'      => array( 'workspace.read', 'workspace.write', 'datamachine/workspace-read', '' ),
		'sandbox_tool_policy' => wp_codebox_smoke_sandbox_tool_policy(
			array(
				'workspace.read' => array( 'runtime_tool_id' => 'workspace_read' ),
				'workspace.write' => array( 'runtime_tool_id' => 'workspace_write' ),
				'datamachine/workspace-read' => array( 'runtime_tool_id' => 'workspace_read' ),
			)
		),
		'expected_artifacts' => array( 'patch', 'tests', 'patch' ),
		'policy'             => array( 'applyBack' => 'reviewed' ),
		'context'            => array( 'issue' => 'https://github.com/Automattic/wp-codebox/issues/29' ),
		'artifacts_path'     => $root . '/artifacts',
	)
);

$assert( 'runner accepts structured task input', ! is_wp_error( $structured_result ) && 'Add a focused product feature.' === ( $structured_result['task_input']['goal'] ?? '' ) );
$assert( 'runner preserves structured target', ! is_wp_error( $structured_result ) && 'plugin' === ( $structured_result['task_input']['target']['kind'] ?? '' ) );
$assert( 'runner normalizes task input lists', ! is_wp_error( $structured_result ) && array( 'workspace.read', 'workspace.write', 'datamachine/workspace-read' ) === ( $structured_result['task_input']['allowed_tools'] ?? array() ) && array( 'patch', 'tests' ) === ( $structured_result['task_input']['expected_artifacts'] ?? array() ) );
$assert( 'runner returns canonical structured task input shape', ! is_wp_error( $structured_result ) && array_key_exists( 'context', $structured_result['task_input'] ?? array() ) && 1 === ( $structured_result['task_input']['version'] ?? 0 ) );
$assert( 'runner passes structured task contract to recipe', str_contains( $captured_recipe, 'wp-codebox/task-input/v1' ) && str_contains( $captured_recipe, 'allowed_tools' ) );
$assert( 'runner leaves preview config unset by default', ! str_contains( $captured_command, '--preview-port' ) && ! str_contains( $captured_command, '--preview-bind' ) && ! str_contains( $captured_command, '--preview-public-url' ) );

$missing_tool_policy_result = $runner->run(
	array(
		'goal'           => 'Try a tool without a resolved policy snapshot.',
		'allowed_tools'  => array( 'workspace.read' ),
		'artifacts_path' => $root . '/artifacts',
	)
);
$assert( 'missing sandbox tool policy snapshot fails closed', is_wp_error( $missing_tool_policy_result ) && 'wp_codebox_sandbox_tool_policy_invalid' === $missing_tool_policy_result->get_error_code() );

$host_browser_equivalent_input = array(
	'goal'               => 'Prepare a browser Playground preview.',
	'target'             => array( 'kind' => 'sandbox-runtime' ),
	'allowed_tools'      => array( 'filesystem-write', 'filesystem-write', '' ),
	'sandbox_tool_policy' => wp_codebox_smoke_sandbox_tool_policy( array( 'filesystem-write' => array( 'runtime_tool_id' => 'filesystem_write' ) ) ),
	'expected_artifacts' => array( 'repair-summary', 'changed-files' ),
);
$host_browser_equivalent_task = WP_Codebox_Agent_Task::normalize_input( $host_browser_equivalent_input );
$assert( 'host and browser preparation share task input normalization', ! is_wp_error( $host_browser_equivalent_task ) && array_intersect_key( $browser_session['task_input'] ?? array(), $host_browser_equivalent_task ) === $host_browser_equivalent_task );

$remediation_artifact_run = function ( string $name, array $files ): array {
	$directory = sys_get_temp_dir() . '/wp-codebox-remediation-artifact-' . $name . '-' . uniqid( '', true );
	mkdir( $directory . '/files', 0777, true );
	file_put_contents(
		$directory . '/files/changed-files.json',
		json_encode( array( 'schema' => 'wp-codebox/changed-files/v1', 'files' => $files ), JSON_PRETTY_PRINT )
	);

	return array(
		'artifacts' => array(
			'id'        => 'artifact-' . $name,
			'directory' => $directory,
		),
	);
};

$remediation_run = function ( array $agent_payload, int $exit_code = 0, array $run_overrides = array() ) use ( $root ): array|WP_Error {
	$strict_runner = new WP_Codebox_Agent_Sandbox_Runner(
		array(
			'shell_available' => fn() => true,
			'command_runner'  => function () use ( $agent_payload, $exit_code, $run_overrides ): array {
				$run = array_merge(
					array(
						'success'    => 0 === $exit_code,
						'schema'     => 'wp-codebox/recipe-run/v1',
						'executions' => array(
							array(
								'command'  => 'wp-codebox.agent-sandbox-run',
								'exitCode' => $exit_code,
								'stdout'   => json_encode( array( 'result' => $agent_payload ) ),
								'stderr'   => '',
							),
						),
					),
					$run_overrides
				);

				return array(
					'exit_code' => $exit_code,
					'output'    => json_encode( $run ),
				);
			},
		)
	);

	return $strict_runner->run(
		array(
			'goal'               => 'Remediate audit finding.',
			'target'             => array( 'kind' => 'audit-remediation' ),
			'expected_artifacts' => array( 'fix_artifact', 'false_positive_artifact' ),
			'artifacts_path'     => $root . '/artifacts',
		)
	);
};

$provider_error_result = $remediation_run(
	array(
		'run_outcome' => array(
			'schema'         => 'agents-api.run-outcome',
			'version'        => 1,
			'status'         => 'failed',
			'completed'      => false,
			'stop_reason'    => 'provider_error',
			'retryable'      => true,
			'provider_error' => array(
				'message' => 'Provider timeout after OpenAI 429 Too Many Requests.',
				'type'    => 'provider_rate_limited',
			),
		),
	),
	1
);
$assert( 'strict remediation outcome classifies provider timeout and 429', ! is_wp_error( $provider_error_result ) && false === ( $provider_error_result['success'] ?? true ) && 'provider_error' === ( $provider_error_result['outcome']['kind'] ?? '' ) && true === ( $provider_error_result['outcome']['retryable'] ?? false ) );
$assert( 'strict remediation outcome preserves provider and Agents API diagnostics', ! is_wp_error( $provider_error_result ) && str_contains( $provider_error_result['outcome']['provider_error']['message'] ?? '', 'Provider timeout' ) && false === ( $provider_error_result['outcome']['metadata']['agents_api']['run_outcome']['completed'] ?? true ) && 'provider_error' === ( $provider_error_result['outcome']['diagnostics']['agents_api_stop_reason'] ?? '' ) );

$pending_runtime_tool_result = $remediation_run(
	array(
		'run_outcome' => array(
			'schema'      => 'agents-api.run-outcome',
			'version'     => 1,
			'status'      => 'runtime_tool_pending',
			'completed'   => false,
			'stop_reason' => 'runtime_tool_pending',
			'retryable'   => false,
		),
	)
);
$assert( 'strict remediation outcome preserves pending runtime tools', ! is_wp_error( $pending_runtime_tool_result ) && false === ( $pending_runtime_tool_result['success'] ?? true ) && 'runtime_tool_pending' === ( $pending_runtime_tool_result['outcome']['kind'] ?? '' ) && false === ( $pending_runtime_tool_result['outcome']['retryable'] ?? true ) && true === ( $pending_runtime_tool_result['outcome']['diagnostics']['pending_runtime_tool'] ?? false ) );

$text_false_positive_result = $remediation_run(
	array(
		'answer'   => 'This looks like a false positive; no code changes are needed.',
		'metadata' => array( 'datamachine' => array( 'completed' => true, 'max_turns_reached' => false ) ),
	)
);
$assert( 'strict remediation outcome returns noop artifact for text-only false-positive conclusions without artifact', ! is_wp_error( $text_false_positive_result ) && true === ( $text_false_positive_result['success'] ?? false ) && 'noop_artifact' === ( $text_false_positive_result['outcome']['kind'] ?? '' ) && true === ( $text_false_positive_result['outcome']['false_positive'] ?? false ) );

$normal_no_pr_result = $remediation_run(
	array(
		'answer'   => 'Done.',
		'metadata' => array( 'datamachine' => array( 'completed' => true, 'max_turns_reached' => false ) ),
	)
);
$assert( 'strict remediation outcome returns unable-to-remediate terminal outcome without artifact', ! is_wp_error( $normal_no_pr_result ) && true === ( $normal_no_pr_result['success'] ?? false ) && 'unable_to_remediate' === ( $normal_no_pr_result['outcome']['kind'] ?? '' ) );

$completed_run_outcome_result = $remediation_run(
	array(
		'answer'      => 'Done.',
		'run_outcome' => array(
			'schema'      => 'agents-api.run-outcome',
			'version'     => 1,
			'status'      => 'completed',
			'completed'   => true,
			'stop_reason' => 'natural',
			'retryable'   => false,
		),
	)
);
$assert( 'strict remediation outcome preserves completed Agents API outcome', ! is_wp_error( $completed_run_outcome_result ) && true === ( $completed_run_outcome_result['success'] ?? false ) && 'unable_to_remediate' === ( $completed_run_outcome_result['outcome']['kind'] ?? '' ) && true === ( $completed_run_outcome_result['outcome']['diagnostics']['agents_api_completed'] ?? false ) && 'natural' === ( $completed_run_outcome_result['outcome']['diagnostics']['agents_api_stop_reason'] ?? '' ) );

$fix_artifact_result = $remediation_run(
	array(
		'metadata' => array( 'datamachine' => array( 'completed' => true, 'max_turns_reached' => false ) ),
	),
	0,
	$remediation_artifact_run( 'fix', array( array( 'path' => '/wordpress/wp-content/plugins/example/example.php', 'relativePath' => 'example.php', 'status' => 'modified' ) ) )
);
$assert( 'strict remediation outcome accepts changed fix artifact', ! is_wp_error( $fix_artifact_result ) && true === ( $fix_artifact_result['success'] ?? false ) && 'fix_artifact' === ( $fix_artifact_result['outcome']['kind'] ?? '' ) && 'example.php' === ( $fix_artifact_result['outcome']['artifact']['changed_files'][0]['relative_path'] ?? '' ) );

$false_positive_artifact_result = $remediation_run(
	array(
		'false_positive' => true,
		'metadata'       => array( 'datamachine' => array( 'completed' => true, 'max_turns_reached' => false ) ),
	),
	0,
	$remediation_artifact_run( 'false-positive', array( array( 'path' => '/wordpress/wp-content/plugins/example/tests/audit.php', 'relativePath' => 'tests/audit.php', 'status' => 'modified' ) ) )
);
$assert( 'strict remediation outcome accepts changed false-positive artifact', ! is_wp_error( $false_positive_artifact_result ) && true === ( $false_positive_artifact_result['success'] ?? false ) && 'false_positive_artifact' === ( $false_positive_artifact_result['outcome']['kind'] ?? '' ) && true === ( $false_positive_artifact_result['outcome']['false_positive'] ?? false ) );

$max_turns_result = $remediation_run(
	array(
		'answer'      => 'Still working.',
		'run_outcome' => array(
			'schema'      => 'agents-api.run-outcome',
			'version'     => 1,
			'status'      => 'incomplete',
			'completed'   => false,
			'stop_reason' => 'max_turns',
			'retryable'   => true,
		),
	)
);
$assert( 'strict remediation outcome preserves max turns exhaustion from Agents API outcome', ! is_wp_error( $max_turns_result ) && false === ( $max_turns_result['success'] ?? true ) && 'max_turns_exceeded' === ( $max_turns_result['outcome']['kind'] ?? '' ) && true === ( $max_turns_result['outcome']['diagnostics']['max_turns_reached'] ?? false ) && 'max_turns' === ( $max_turns_result['outcome']['diagnostics']['agents_api_stop_reason'] ?? '' ) );

$parent_only_tool = $runner->run(
	array(
		'goal'           => 'Try a parent-only workspace mutation.',
		'allowed_tools'  => array( 'datamachine/workspace-git-push' ),
		'sandbox_tool_policy' => wp_codebox_smoke_sandbox_tool_policy( array( 'datamachine/workspace-git-push' => array( 'runtime_tool_id' => 'workspace_git_push', 'execution_location' => 'parent', 'transport_visibility' => 'parent', 'allowed' => false ) ) ),
		'artifacts_path' => $root . '/artifacts',
	)
);
$assert( 'parent-only Data Machine tool request fails closed', is_wp_error( $parent_only_tool ) && 'wp_codebox_tool_not_allowed' === $parent_only_tool->get_error_code() );
$assert( 'tool denial includes structured redacted details', is_wp_error( $parent_only_tool ) && 'wp-codebox/tool-allowlist-denial/v1' === ( $parent_only_tool->get_error_data()['schema'] ?? '' ) && 'parent-only' === ( $parent_only_tool->get_error_data()['denied_tools'][0]['reason'] ?? '' ) );

$not_allowlisted_tool = $runner->run(
	array(
		'goal'           => 'Try an unconfigured sandbox tool.',
		'allowed_tools'  => array( 'datamachine/workspace-write' ),
		'sandbox_tool_policy' => wp_codebox_smoke_sandbox_tool_policy( array( 'datamachine/workspace-read' => array( 'runtime_tool_id' => 'workspace_read' ) ) ),
		'artifacts_path' => $root . '/artifacts',
	)
);
$assert( 'configured Data Machine tool allow-list fails closed', is_wp_error( $not_allowlisted_tool ) && 'wp_codebox_tool_not_allowed' === $not_allowlisted_tool->get_error_code() );
$assert( 'configured allow-list denial reports allowed tools', is_wp_error( $not_allowlisted_tool ) && array( 'datamachine/workspace-read' ) === ( $not_allowlisted_tool->get_error_data()['allowed_tools'] ?? array() ) && 'not-in-policy' === ( $not_allowlisted_tool->get_error_data()['denied_tools'][0]['reason'] ?? '' ) );

$batch_result = $runner->run_batch(
	array(
		'tasks'          => array(
			array( 'goal' => 'Fix issue one.' ),
			array( 'goal' => 'Fix issue two.' ),
		),
		'sandbox_session_id' => 'parent-batch-789',
		'artifacts_path' => $root . '/artifacts',
		'provider_plugin_paths' => array( $root . '/ai-provider-test' ),
		'preview_port'   => 45679,
		'preview_bind'   => '127.0.0.1',
		'preview_public_url' => 'https://preview.example.test/batch/',
	)
);

$assert( 'batch runner succeeds with filter-provided component contracts', ! is_wp_error( $batch_result ) && true === ( $batch_result['success'] ?? false ) );
$assert( 'batch runner schema is stable', ! is_wp_error( $batch_result ) && 'wp-codebox/agent-task-batch/v1' === ( $batch_result['schema'] ?? '' ) );
$assert( 'batch runner returns normalized task inputs', ! is_wp_error( $batch_result ) && 2 === count( $batch_result['task_inputs'] ?? array() ) && 'Fix issue one.' === ( $batch_result['task_inputs'][0]['goal'] ?? '' ) );
$batch_recipes = array_slice( $captured_recipes, -2 );
$batch_commands = array_slice( $captured_commands, -2 );
$assert( 'batch runner invokes recipe-run once per task', 2 === count( $batch_result['runs'] ?? array() ) && 2 === count( $batch_recipes ) && str_contains( $captured_commands[ count( $captured_commands ) - 1 ] ?? '', 'recipe-run' ) );
$assert( 'batch runner emits one agent step per isolated recipe', 1 === substr_count( $batch_recipes[0] ?? '', 'wp-codebox.agent-sandbox-run' ) && 1 === substr_count( $batch_recipes[1] ?? '', 'wp-codebox.agent-sandbox-run' ) );
$assert( 'batch runner returns sequential isolation contract', 'sequential-isolated-sandboxes' === ( $batch_result['execution'] ?? '' ) && ! array_key_exists( 'concurrency', $batch_result ) );
$assert( 'batch runner returns per-task artifact refs', ! is_wp_error( $batch_result ) && '' !== ( $batch_result['runs'][0]['artifact_id'] ?? '' ) && '' !== ( $batch_result['runs'][1]['artifact_id'] ?? '' ) && ( $batch_result['runs'][0]['artifact_id'] ?? '' ) !== ( $batch_result['runs'][1]['artifact_id'] ?? '' ) );
$assert( 'batch runner returns per-task agent result summaries', ! is_wp_error( $batch_result ) && 'wp-codebox/agent-result/v1' === ( $batch_result['runs'][0]['agent_result']['schema'] ?? '' ) && 'files/transcript.json' === ( $batch_result['runs'][1]['agent_result']['transcript']['artifact'] ?? '' ) );
$assert( 'batch runner returns per-task preview URLs', ! is_wp_error( $batch_result ) && 'https://preview.example.test/batch/' === ( $batch_result['runs'][0]['preview_url'] ?? '' ) && 'https://preview.example.test/batch/' === ( $batch_result['runs'][1]['preview_url'] ?? '' ) );
$assert( 'batch runner assigns per-task sandbox session ids', ! is_wp_error( $batch_result ) && 'parent-batch-789:1' === ( $batch_result['runs'][0]['session']['id'] ?? '' ) && 'parent-batch-789:2' === ( $batch_result['runs'][1]['session']['id'] ?? '' ) );
$assert( 'batch runner reports per-task counts', ! is_wp_error( $batch_result ) && 2 === ( $batch_result['total'] ?? 0 ) && 2 === ( $batch_result['completed'] ?? 0 ) && 0 === ( $batch_result['failed'] ?? -1 ) );
$assert( 'batch runner recipe passes default provider', str_contains( $batch_recipes[0] ?? '', 'openai' ) && str_contains( $batch_recipes[1] ?? '', 'openai' ) );
$assert( 'batch runner recipe passes default model', str_contains( $batch_recipes[0] ?? '', 'gpt-5.5' ) && str_contains( $batch_recipes[1] ?? '', 'gpt-5.5' ) );
$assert( 'batch runner recipe passes provider plugin path', str_contains( $batch_recipes[0] ?? '', 'ai-provider-test' ) && str_contains( $batch_recipes[1] ?? '', 'ai-provider-test' ) );
$assert( 'batch runner recipe passes secret env name only', str_contains( $batch_recipes[0] ?? '', 'OPENAI_API_KEY' ) && str_contains( $batch_recipes[1] ?? '', 'OPENAI_API_KEY' ) );
$assert( 'batch runner passes preview configuration to each CLI run', str_contains( $batch_commands[0] ?? '', '--preview-port' ) && str_contains( $batch_commands[0] ?? '', "'45679'" ) && str_contains( $batch_commands[0] ?? '', '--preview-bind' ) && str_contains( $batch_commands[0] ?? '', "'127.0.0.1'" ) && str_contains( $batch_commands[0] ?? '', '--preview-public-url' ) && str_contains( $batch_commands[0] ?? '', "'https://preview.example.test/batch/'" ) && str_contains( $batch_commands[1] ?? '', '--preview-port' ) && str_contains( $batch_commands[1] ?? '', "'45679'" ) && str_contains( $batch_commands[1] ?? '', '--preview-bind' ) && str_contains( $batch_commands[1] ?? '', "'127.0.0.1'" ) && str_contains( $batch_commands[1] ?? '', '--preview-public-url' ) && str_contains( $batch_commands[1] ?? '', "'https://preview.example.test/batch/'" ) );

$failing_batch_count  = 0;
$failing_batch_runner = new WP_Codebox_Agent_Sandbox_Runner(
	array(
		'shell_available' => fn() => true,
		'command_runner'  => function () use ( &$failing_batch_count ): array {
			++$failing_batch_count;
			if ( 2 === $failing_batch_count ) {
				return array(
					'exit_code' => 1,
					'output'    => json_encode( array( 'success' => false, 'error' => 'fixture failure' ) ),
				);
			}

			return array(
				'exit_code' => 0,
				'output'    => json_encode(
					array(
						'success'   => true,
						'artifacts' => array(
							'id'      => 'artifact-bundle-sha256-partial-success',
							'preview' => array( 'url' => 'http://127.0.0.1:22345' ),
						),
					)
				),
			);
		},
	)
);
$partial_batch = $failing_batch_runner->run_batch(
	array(
		'tasks'          => array(
			array( 'goal' => 'Succeed once.' ),
			array( 'goal' => 'Fail once.' ),
		),
		'artifacts_path' => $root . '/artifacts',
	)
);
$assert( 'batch runner continues after per-task failure', ! is_wp_error( $partial_batch ) && false === ( $partial_batch['success'] ?? true ) && 1 === ( $partial_batch['completed'] ?? 0 ) && 1 === ( $partial_batch['failed'] ?? 0 ) );
$assert( 'batch runner returns per-task errors', ! is_wp_error( $partial_batch ) && 'failed' === ( $partial_batch['runs'][1]['status'] ?? '' ) && 'wp_codebox_run_failed' === ( $partial_batch['runs'][1]['error']['code'] ?? '' ) );

$fanout_bin = $root . '/wp-codebox-fanout-fixture';
file_put_contents(
	$fanout_bin,
	<<<'PHP'
#!/usr/bin/env php
<?php
$artifacts = '';
for ( $i = 1; $i < $argc; $i++ ) {
	if ( '--artifacts' === $argv[ $i ] && isset( $argv[ $i + 1 ] ) ) {
		$artifacts = $argv[ $i + 1 ];
	}
}
if ( '' === $artifacts ) {
	fwrite( STDERR, "missing artifacts\n" );
	exit( 2 );
}
@mkdir( $artifacts, 0777, true );
$worker_id = basename( dirname( $artifacts ) );
$fanout_root = dirname( $artifacts, 3 );
$active_path = $fanout_root . '/active.json';
$lock_path = $fanout_root . '/active.lock';
$lock = fopen( $lock_path, 'c+' );
if ( $lock ) {
	flock( $lock, LOCK_EX );
	$active = is_readable( $active_path ) ? json_decode( (string) file_get_contents( $active_path ), true ) : array();
	$active = is_array( $active ) ? $active : array();
	$count = (int) ( $active['count'] ?? 0 ) + 1;
	$active['count'] = $count;
	$active['max'] = max( (int) ( $active['max'] ?? 0 ), $count );
	file_put_contents( $active_path, json_encode( $active ) );
	flock( $lock, LOCK_UN );
}
usleep( str_contains( $worker_id, 'timeout' ) ? 2000000 : 350000 );
if ( $lock ) {
	flock( $lock, LOCK_EX );
	$active = is_readable( $active_path ) ? json_decode( (string) file_get_contents( $active_path ), true ) : array();
	$active = is_array( $active ) ? $active : array();
	$active['count'] = max( 0, (int) ( $active['count'] ?? 1 ) - 1 );
	file_put_contents( $active_path, json_encode( $active ) );
	flock( $lock, LOCK_UN );
	fclose( $lock );
}
$payload = array(
	'success' => ! str_contains( $worker_id, 'fail' ),
	'artifacts' => array(
		'id' => 'fanout-artifact-' . $worker_id,
		'preview' => array( 'url' => 'http://127.0.0.1/fanout/' . $worker_id ),
	),
	'agentResult' => array(
		'schema' => 'wp-codebox/agent-result/v1',
		'status' => str_contains( $worker_id, 'fail' ) ? 'failed' : 'completed',
		'transcript' => array( 'artifact' => 'files/transcript.json' ),
	),
	'agentTaskResult' => array(
		'schema' => 'wp-codebox/agent-task-result/v1',
		'success' => ! str_contains( $worker_id, 'fail' ),
		'status' => str_contains( $worker_id, 'fail' ) ? 'failed' : 'completed',
	),
	'completionOutcome' => array(
		'schema' => 'wp-codebox/sandbox-completion-outcome/v1',
		'success' => ! str_contains( $worker_id, 'fail' ),
		'status' => str_contains( $worker_id, 'fail' ) ? 'blocked' : 'completed',
	),
);
echo json_encode( $payload, JSON_UNESCAPED_SLASHES ) . "\n";
exit( str_contains( $worker_id, 'fail' ) ? 7 : 0 );
PHP
);
chmod( $fanout_bin, 0755 );

$fanout_runner = new WP_Codebox_Agent_Sandbox_Runner( array( 'shell_available' => fn() => true ) );
$fanout_result = $fanout_runner->run_fanout(
	array(
		'workers' => array(
			array( 'id' => 'alpha', 'goal' => 'Run alpha.', 'agent' => 'fanout-a' ),
			array( 'id' => 'bravo', 'goal' => 'Run bravo.', 'agent' => 'fanout-b' ),
			array( 'id' => 'charlie', 'goal' => 'Run charlie.', 'agent' => 'fanout-c' ),
		),
		'concurrency'        => 2,
		'sandbox_session_id' => 'parent-fanout-123',
		'artifacts_path'     => $root . '/artifacts/fanout-success',
		'wp_codebox_bin'     => $fanout_bin,
		'component_contracts' => $component_contracts,
		'orchestrator'       => array( 'type' => 'studio-web', 'id' => 'fanout-smoke' ),
	)
);
$fanout_active = json_decode( (string) file_get_contents( $root . '/artifacts/fanout-success/fanout/active.json' ), true );
$fanout_event_lines = array_values( array_filter( explode( "\n", trim( (string) file_get_contents( $root . '/artifacts/fanout-success/fanout/events.jsonl' ) ) ) ) );
$fanout_events      = array_map( static fn( string $line ): array => json_decode( $line, true ), $fanout_event_lines );
$fanout_event_names = array_map( static fn( array $event ): string => (string) ( $event['event'] ?? '' ), $fanout_events );
$assert( 'fanout runner succeeds with bounded parallel workers', ! is_wp_error( $fanout_result ) && true === ( $fanout_result['success'] ?? false ) && 3 === ( $fanout_result['completed'] ?? 0 ) && 0 === ( $fanout_result['failed'] ?? -1 ) && 2 === ( $fanout_result['concurrency'] ?? 0 ) );
$assert( 'fanout runner enforces concurrency bound while running concurrently', ! is_wp_error( $fanout_result ) && 2 === ( $fanout_active['max'] ?? 0 ) );
$assert( 'fanout runner assigns parent and child session envelopes', ! is_wp_error( $fanout_result ) && 'parent-fanout-123' === ( $fanout_result['session']['id'] ?? '' ) && 'parent-fanout-123:alpha' === ( $fanout_result['runs'][0]['session']['id'] ?? '' ) && 'parent-fanout-123:bravo' === ( $fanout_result['session']['children'][1]['session_id'] ?? '' ) );
$assert( 'fanout runner writes stable namespaced artifacts', ! is_wp_error( $fanout_result ) && is_file( $root . '/artifacts/fanout-success/fanout/plan.json' ) && is_file( $root . '/artifacts/fanout-success/fanout/events.jsonl' ) && is_file( $root . '/artifacts/fanout-success/fanout/workers/alpha/result.json' ) && is_file( $root . '/artifacts/fanout-success/fanout/aggregate/result.json' ) && 'wp-codebox/agent-fanout-artifacts/v1' === ( $fanout_result['artifacts']['schema'] ?? '' ) && 'alpha' === ( $fanout_result['runs'][0]['artifacts']['namespace'] ?? '' ) );
$assert( 'fanout runner emits canonical lifecycle events', ! is_wp_error( $fanout_result ) && array( 'fanout.started', 'worker.started', 'worker.completed', 'aggregation.started', 'aggregation.completed', 'fanout.completed' ) === array_values( array_intersect( array( 'fanout.started', 'worker.started', 'worker.completed', 'aggregation.started', 'aggregation.completed', 'fanout.completed' ), $fanout_event_names ) ) && count( array_filter( $fanout_events, static fn( array $event ): bool => 'wp-codebox/agent-fanout-event/v1' === ( $event['schema'] ?? '' ) ) ) === count( $fanout_events ) );
$assert( 'fanout runner preserves opaque orchestrator metadata', ! is_wp_error( $fanout_result ) && 'studio-web' === ( $fanout_result['orchestrator']['type'] ?? '' ) && 'fanout-smoke' === ( $fanout_result['session']['orchestrator']['id'] ?? '' ) );

$fanout_failure = $fanout_runner->run_fanout(
	array(
		'workers' => array(
			array( 'id' => 'ok-worker', 'goal' => 'Succeed.' ),
			array( 'id' => 'fail-worker', 'goal' => 'Fail.' ),
		),
		'concurrency'        => 2,
		'sandbox_session_id' => 'parent-fanout-fail',
		'artifacts_path'     => $root . '/artifacts/fanout-failure',
		'wp_codebox_bin'     => $fanout_bin,
		'component_contracts' => $component_contracts,
	)
);
$assert( 'fanout runner rolls up worker failures', ! is_wp_error( $fanout_failure ) && false === ( $fanout_failure['success'] ?? true ) && 1 === ( $fanout_failure['completed'] ?? 0 ) && 1 === ( $fanout_failure['failed'] ?? 0 ) && 'fail-worker' === ( $fanout_failure['failures'][0]['worker_id'] ?? '' ) );
$assert( 'fanout failure includes worker id agent error and artifact refs', ! is_wp_error( $fanout_failure ) && 'wp_codebox_run_failed' === ( $fanout_failure['failures'][0]['error']['code'] ?? '' ) && str_contains( (string) ( $fanout_failure['failures'][0]['artifacts']['path'] ?? '' ), '/workers/fail-worker/artifacts' ) );
$fanout_failure_event_lines = array_values( array_filter( explode( "\n", trim( (string) file_get_contents( $root . '/artifacts/fanout-failure/fanout/events.jsonl' ) ) ) ) );
$fanout_failure_events      = array_map( static fn( string $line ): array => json_decode( $line, true ), $fanout_failure_event_lines );
$fanout_failure_names       = array_map( static fn( array $event ): string => (string) ( $event['event'] ?? '' ), $fanout_failure_events );
$assert( 'fanout runner emits failure lifecycle events', in_array( 'worker.failed', $fanout_failure_names, true ) && in_array( 'fanout.failed', $fanout_failure_names, true ) );

$fanout_timeout = $fanout_runner->run_fanout(
	array(
		'workers' => array( array( 'id' => 'timeout-worker', 'goal' => 'Timeout.', 'timeout_seconds' => 1 ) ),
		'concurrency'        => 1,
		'sandbox_session_id' => 'parent-fanout-timeout',
		'artifacts_path'     => $root . '/artifacts/fanout-timeout',
		'wp_codebox_bin'     => $fanout_bin,
		'component_contracts' => $component_contracts,
	)
);
$assert( 'fanout runner reports timeout failures', ! is_wp_error( $fanout_timeout ) && false === ( $fanout_timeout['success'] ?? true ) && 1 === ( $fanout_timeout['failed'] ?? 0 ) && 'wp_codebox_run_timeout' === ( $fanout_timeout['failures'][0]['error']['code'] ?? '' ) );

$duplicate_fanout = $fanout_runner->run_fanout(
	array(
		'workers' => array(
			array( 'id' => 'same', 'goal' => 'One.' ),
			array( 'id' => 'same', 'goal' => 'Two.' ),
		),
		'wp_codebox_bin'  => $fanout_bin,
		'component_contracts' => $component_contracts,
	)
);
$assert( 'fanout runner rejects artifact namespace collisions', is_wp_error( $duplicate_fanout ) && 'wp_codebox_fanout_worker_id_duplicate' === $duplicate_fanout->get_error_code() );

$invalid_concurrency = $fanout_runner->run_fanout(
	array(
		'workers' => array( array( 'id' => 'alpha', 'goal' => 'Run alpha.' ) ),
		'concurrency'     => 99,
		'wp_codebox_bin'  => $fanout_bin,
		'component_contracts' => $component_contracts,
	)
);
$assert( 'fanout runner rejects unsafe concurrency bounds', is_wp_error( $invalid_concurrency ) && 'wp_codebox_fanout_concurrency_invalid' === $invalid_concurrency->get_error_code() );

$pending_action_handlers_filter     = $GLOBALS['wp_codebox_filters']['datamachine_pending_action_handlers'] ?? null;
$GLOBALS['wp_codebox_is_multisite'] = true;
$GLOBALS['wp_codebox_filters']      = array_filter(
	array( 'datamachine_pending_action_handlers' => $pending_action_handlers_filter ),
	static fn( mixed $filter ): bool => null !== $filter
);
$GLOBALS['wp_codebox_site_options'] = array(
	'wp_codebox_component_contracts' => $component_contracts,
	'wp_codebox_bin'             => $root . '/wp-codebox.js',
	'wp_codebox_artifacts_root'  => $root . '/artifact-network-root',
);

$network_result = $runner->run( array( 'goal' => 'Use network-level WP Codebox configuration.' ) );
$assert( 'multisite runner reads network-level options', ! is_wp_error( $network_result ) && str_starts_with( (string) ( $network_result['artifacts'] ?? '' ), $root . '/artifact-network-root' ) );

$GLOBALS['wp_codebox_is_multisite'] = false;
$GLOBALS['wp_codebox_filters']      = array_filter(
	array(
		'wp_codebox_component_contracts'        => $component_contracts,
		'wp_codebox_bin'                        => $root . '/wp-codebox.js',
		'wp_codebox_default_agent'              => 'site-coder',
		'wp_codebox_default_provider'           => 'openai',
		'wp_codebox_default_model'              => 'gpt-5.5',
		'wp_codebox_default_secret_env'         => array( 'OPENAI_API_KEY' ),
		'datamachine_pending_action_handlers'   => $pending_action_handlers_filter,
	),
	static fn( mixed $filter ): bool => null !== $filter
);

$missing_task = $runner->run( array( 'artifacts_path' => $root . '/artifacts' ) );
$assert( 'missing task fails closed', is_wp_error( $missing_task ) && 'wp_codebox_task_missing' === $missing_task->get_error_code() );

$missing_tasks = $runner->run_batch( array( 'artifacts_path' => $root . '/artifacts' ) );
$assert( 'missing batch tasks fails closed', is_wp_error( $missing_tasks ) && 'wp_codebox_tasks_missing' === $missing_tasks->get_error_code() );

$artifact_root = $root . '/artifact-store';
$bundle_dir    = $artifact_root . '/runtime-test';
mkdir( $bundle_dir . '/files', 0777, true );
$changed_files_json = json_encode(
	array(
		'schema' => 'wp-codebox/changed-files/v1',
		'files'  => array(
			array(
				'path'         => '/wordpress/wp-content/plugins/example/generated.txt',
				'status'       => 'added',
				'mountIndex'   => 0,
				'mountTarget'  => '/wordpress/wp-content/plugins/example',
				'relativePath' => 'generated.txt',
				'patchPath'    => 'files/diffs/mount-0.patch',
			),
			array(
				'path'         => '/wordpress/wp-content/plugins/example/unapproved.txt',
				'status'       => 'added',
				'mountIndex'   => 0,
				'mountTarget'  => '/wordpress/wp-content/plugins/example',
				'relativePath' => 'unapproved.txt',
				'patchPath'    => 'files/diffs/mount-0.patch',
			),
		),
	),
	JSON_PRETTY_PRINT
) . "\n";
$approved_patch_diff = "diff --git a/generated.txt b/generated.txt\n+cooked\n";
$patch_diff          = $approved_patch_diff . "diff --git a/unapproved.txt b/unapproved.txt\n+unsafe\n";
$content_digest      = hash( 'sha256', "wp-codebox/artifact-content/v1\nfiles/changed-files.json\n" . $changed_files_json . "\nfiles/patch.diff\n" . $patch_diff );
$artifact_id         = 'artifact-bundle-sha256-' . $content_digest;
$metadata = array(
	'artifacts'  => array( 'patch' => 'files/patch.diff' ),
	'provenance' => array(
		'task' => array(
			'requester' => 'chat:user-7',
		),
	),
);
$test_results = array(
	'schema'           => 'wp-codebox/test-results/v1',
	'status'           => 'unknown',
	'summary'          => array(
		'total'   => 0,
		'passed'  => 0,
		'failed'  => 0,
		'skipped' => 0,
		'unknown' => 0,
	),
	'suites'           => array(),
	'rawLogReferences' => array(),
);
$review = array(
	'schema'       => 'wp-codebox/artifact-review/v1',
	'artifactId'   => $artifact_id,
	'summary'      => 'Sandbox produced changes in 1 file.',
	'actions'      => array(
		array(
			'kind'                  => 'approve',
			'label'                 => 'Approve all changes',
			'requiresApprovedFiles' => true,
		),
	),
	'evidence'     => array(
		'artifactContentDigest' => $content_digest,
		'changedFiles'          => 'files/changed-files.json',
		'patch'                 => 'files/patch.diff',
		'patchSha256'           => hash( 'sha256', $patch_diff ),
	),
	'changedFiles' => array(
		array(
			'path'   => '/wordpress/wp-content/plugins/example/generated.txt',
			'status' => 'added',
		),
	),
);
file_put_contents( $bundle_dir . '/metadata.json', json_encode( $metadata, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES ) . "\n" );
file_put_contents( $bundle_dir . '/files/changed-files.json', $changed_files_json );
file_put_contents( $bundle_dir . '/files/patch.diff', $patch_diff );
file_put_contents( $bundle_dir . '/files/test-results.json', json_encode( $test_results, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES ) . "\n" );
file_put_contents( $bundle_dir . '/files/review.json', json_encode( $review, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES ) . "\n" );
$manifest = array(
	'id'            => $artifact_id,
	'contentDigest' => array(
		'algorithm' => 'sha256',
		'inputs'    => array( 'files/changed-files.json', 'files/patch.diff' ),
		'value'     => $content_digest,
	),
	'createdAt'     => '2026-05-19T00:00:00Z',
	'runtime'       => array( 'type' => 'php-smoke-fixture' ),
	'files'         => array(
		array( 'path' => 'manifest.json', 'kind' => 'manifest', 'contentType' => 'application/json' ),
		array( 'path' => 'metadata.json', 'kind' => 'metadata', 'contentType' => 'application/json' ),
		array( 'path' => 'files/changed-files.json', 'kind' => 'changed-files', 'contentType' => 'application/json' ),
		array( 'path' => 'files/patch.diff', 'kind' => 'patch', 'contentType' => 'text/x-diff' ),
		array( 'path' => 'files/test-results.json', 'kind' => 'test-results', 'contentType' => 'application/json' ),
		array( 'path' => 'files/review.json', 'kind' => 'review', 'contentType' => 'application/json' ),
	),
);
foreach ( $manifest['files'] as &$manifest_file ) {
	if ( 'manifest.json' !== $manifest_file['path'] ) {
		$manifest_file['sha256'] = array( 'algorithm' => 'sha256', 'value' => hash_file( 'sha256', $bundle_dir . '/' . $manifest_file['path'] ) );
	}
}
unset( $manifest_file );
$manifest['files'][0]['sha256'] = array( 'algorithm' => 'sha256', 'value' => $manifest_self_hash( $manifest ) );
file_put_contents( $bundle_dir . '/manifest.json', json_encode( $manifest, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES ) . "\n" );

$artifacts = new WP_Codebox_Artifacts();
$listed    = $artifacts->list( array( 'artifacts_path' => $artifact_root ) );
$assert( 'artifact listing succeeds', ! is_wp_error( $listed ) && 1 === count( $listed['artifacts'] ?? array() ) );
$assert( 'artifact listing detects test results', ! is_wp_error( $listed ) && true === ( $listed['artifacts'][0]['has_test_results'] ?? false ) );

call_user_func( $GLOBALS['wp_codebox_cli_commands']['codebox artifacts list'], array(), array( 'artifacts-path' => $artifact_root, 'format' => 'json' ) );
$cli_list_output = json_decode( end( $GLOBALS['wp_codebox_cli_lines'] ), true );
$assert( 'wp codebox artifacts list emits JSON service result', is_array( $cli_list_output ) && 'wp-codebox/artifact-list/v1' === ( $cli_list_output['schema'] ?? '' ) && $artifact_id === ( $cli_list_output['artifacts'][0]['id'] ?? '' ) );

$read_artifact = $artifacts->get(
	array(
		'artifacts_path' => $artifact_root,
		'artifact_id'    => $artifact_id,
	)
);
$assert( 'artifact get returns canonical changed files', ! is_wp_error( $read_artifact ) && 'wp-codebox/changed-files/v1' === ( $read_artifact['artifact']['changed_files']['schema'] ?? '' ) );
$assert( 'artifact get returns test results', ! is_wp_error( $read_artifact ) && 'wp-codebox/test-results/v1' === ( $read_artifact['artifact']['test_results']['schema'] ?? '' ) );
$assert( 'artifact get returns review payload', ! is_wp_error( $read_artifact ) && 'wp-codebox/artifact-review/v1' === ( $read_artifact['artifact']['review']['schema'] ?? '' ) );
$assert( 'artifact get verifies content digest', ! is_wp_error( $read_artifact ) && $content_digest === ( $read_artifact['artifact']['content_digest'] ?? '' ) );

$GLOBALS['wp_codebox_filters']['wp_codebox_bin'] = dirname( __DIR__ ) . '/packages/cli/dist/index.js';

$preflight_apply_payloads = array();
$GLOBALS['wp_codebox_filters']['wp_codebox_apply_approved_artifact'] = function ( mixed $value, array $payload ) use ( &$preflight_apply_payloads ): mixed {
	$preflight_apply_payloads[] = $payload;
	return $value;
};
$apply_preflight = $artifacts->apply_preflight(
	array(
		'artifacts_path'  => $artifact_root,
		'artifact_id'     => $artifact_id,
		'approved_files'  => array( '/wordpress/wp-content/plugins/example/generated.txt', '/wordpress/wp-content/plugins/example/unapproved.txt' ),
		'approver'        => 'site-user:preflight',
		'apply_target'    => array( 'repo' => 'Automattic/wp-codebox' ),
	)
);
$assert( 'artifact apply preflight returns verified adapter payload without delegation', ! is_wp_error( $apply_preflight ) && 'wp-codebox/artifact-apply-preflight/v1' === ( $apply_preflight['schema'] ?? '' ) && true === ( $apply_preflight['verification']['valid'] ?? false ) && $content_digest === ( $apply_preflight['content_digest'] ?? '' ) && hash( 'sha256', $patch_diff ) === ( $apply_preflight['patch_sha256'] ?? '' ) && array() === $preflight_apply_payloads );
$assert( 'artifact apply preflight payload preserves apply target and approved files', ! is_wp_error( $apply_preflight ) && array( 'repo' => 'Automattic/wp-codebox' ) === ( $apply_preflight['payload']['apply_target'] ?? array() ) && array( '/wordpress/wp-content/plugins/example/generated.txt', '/wordpress/wp-content/plugins/example/unapproved.txt' ) === ( $apply_preflight['payload']['approved_files'] ?? array() ) && $patch_diff === ( $apply_preflight['payload']['patch'] ?? '' ) );

call_user_func( $GLOBALS['wp_codebox_cli_commands']['codebox artifacts preflight-apply'], array( $artifact_id ), array( 'artifacts-path' => $artifact_root, 'approved-files' => '/wordpress/wp-content/plugins/example/generated.txt,/wordpress/wp-content/plugins/example/unapproved.txt', 'format' => 'json' ) );
$cli_preflight_output = json_decode( end( $GLOBALS['wp_codebox_cli_lines'] ), true );
$assert( 'wp codebox artifacts preflight-apply emits JSON service result', is_array( $cli_preflight_output ) && 'wp-codebox/artifact-apply-preflight/v1' === ( $cli_preflight_output['schema'] ?? '' ) && $artifact_id === ( $cli_preflight_output['artifact_id'] ?? '' ) );

$missing_approval_preflight = $artifacts->apply_preflight(
	array(
		'artifacts_path'  => $artifact_root,
		'artifact_id'     => $artifact_id,
		'approved_files'  => array( '/wordpress/wp-content/plugins/example/generated.txt' ),
	)
);
$assert( 'artifact apply preflight requires every changed file approval', is_wp_error( $missing_approval_preflight ) && 'wp_codebox_approved_files_incomplete' === $missing_approval_preflight->get_error_code() && array( '/wordpress/wp-content/plugins/example/unapproved.txt' ) === ( $missing_approval_preflight->get_error_data()['files'] ?? array() ) );
unset( $GLOBALS['wp_codebox_filters']['wp_codebox_apply_approved_artifact'] );

$malformed_manifest_root = $root . '/artifact-malformed-manifest';
mkdir( $malformed_manifest_root . '/broken', 0777, true );
file_put_contents( $malformed_manifest_root . '/broken/manifest.json', "{\n" );
$verify_output = array();
$verify_exit   = 0;
exec( 'node ' . escapeshellarg( $GLOBALS['wp_codebox_filters']['wp_codebox_bin'] ) . ' artifacts verify --bundle ' . escapeshellarg( $malformed_manifest_root . '/broken' ) . ' --json 2>&1', $verify_output, $verify_exit );
$verify_result = json_decode( implode( "\n", $verify_output ), true );
$assert( 'generic verifier reports malformed manifest fixtures', 1 === $verify_exit && false === ( $verify_result['valid'] ?? true ) && 'malformed-manifest' === ( $verify_result['violations'][0]['code'] ?? '' ) );

$digest_fixture_root = $root . '/artifact-digest-fixture';
$copy_directory( $bundle_dir, $digest_fixture_root . '/runtime-test' );
file_put_contents( $digest_fixture_root . '/runtime-test/files/patch.diff', $patch_diff . "diff --git a/tampered.txt b/tampered.txt\n+tampered\n" );
$digest_failure = $artifacts->apply_preflight(
	array(
		'artifacts_path'  => $digest_fixture_root,
		'artifact_id'     => $artifact_id,
		'approved_files'  => array( '/wordpress/wp-content/plugins/example/generated.txt', '/wordpress/wp-content/plugins/example/unapproved.txt' ),
	)
);
$assert( 'artifact apply preflight rejects digest mismatch before payload creation', is_wp_error( $digest_failure ) && 'wp_codebox_artifact_digest_mismatch' === $digest_failure->get_error_code() );

$missing_patch_fixture_root = $root . '/artifact-missing-patch-fixture';
$copy_directory( $bundle_dir, $missing_patch_fixture_root . '/runtime-test' );
unlink( $missing_patch_fixture_root . '/runtime-test/files/patch.diff' );
$missing_patch_failure = $artifacts->apply_preflight(
	array(
		'artifacts_path'  => $missing_patch_fixture_root,
		'artifact_id'     => $artifact_id,
		'approved_files'  => array( '/wordpress/wp-content/plugins/example/generated.txt', '/wordpress/wp-content/plugins/example/unapproved.txt' ),
	)
);
$assert( 'artifact apply preflight rejects missing patch before payload creation', is_wp_error( $missing_patch_failure ) && 'wp_codebox_patch_missing' === $missing_patch_failure->get_error_code() );

$hash_fixture_root = $root . '/artifact-hash-fixture';
$copy_directory( $bundle_dir, $hash_fixture_root . '/runtime-test' );
file_put_contents( $hash_fixture_root . '/runtime-test/metadata.json', "{}\n" );
$hash_failure = $artifacts->apply_approved(
	array(
		'artifacts_path' => $hash_fixture_root,
		'artifact_id'    => $artifact_id,
		'approved_files' => array( '/wordpress/wp-content/plugins/example/generated.txt' ),
	)
);
$assert( 'approved artifact apply rejects hash mismatch fixtures before delegation', is_wp_error( $hash_failure ) && 'wp_codebox_artifact_verification_failed' === $hash_failure->get_error_code() && in_array( 'file-hash-mismatch', $violation_codes( $hash_failure ), true ) );

$reference_fixture_root = $root . '/artifact-reference-fixture';
$copy_directory( $bundle_dir, $reference_fixture_root . '/runtime-test' );
$reference_metadata = $metadata;
$reference_metadata['artifacts']['patch'] = 'files/missing.diff';
file_put_contents( $reference_fixture_root . '/runtime-test/metadata.json', json_encode( $reference_metadata, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES ) . "\n" );
$refresh_manifest_hashes( $reference_fixture_root . '/runtime-test' );
$reference_failure = WP_Codebox_Data_Machine_Pending_Actions::stage_apply_artifact(
	array(
		'artifacts_path' => $reference_fixture_root,
		'artifact_id'    => $artifact_id,
		'approved_files' => array( '/wordpress/wp-content/plugins/example/generated.txt' ),
	)
);
$assert( 'pending artifact apply rejects malformed references before staging', is_wp_error( $reference_failure ) && 'wp_codebox_artifact_verification_failed' === $reference_failure->get_error_code() && in_array( 'malformed-reference', $violation_codes( $reference_failure ), true ) && 'https://github.com/Automattic/wp-codebox/issues/176' === ( $reference_failure->get_error_data()['issue_url'] ?? '' ) );

$review_fixture_root = $root . '/artifact-review-fixture';
$copy_directory( $bundle_dir, $review_fixture_root . '/runtime-test' );
$review_apply_payloads = array();
$GLOBALS['wp_codebox_filters']['wp_codebox_apply_approved_artifact'] = function ( mixed $value, array $payload ) use ( &$review_apply_payloads ): array {
	$review_apply_payloads[] = $payload;
	return array(
		'schema'          => 'wp-codebox/apply-result/v1',
		'adapter'         => 'review-approve-adapter',
		'status'          => 'queued',
		'target'          => is_array( $payload['apply_target'] ?? null ) ? $payload['apply_target'] : array(),
		'applied_files'   => $payload['approved_files'] ?? array(),
		'audit_reference' => 'review-approve:test',
	);
};
$approved_review = $artifacts->review_artifact(
	array(
		'artifacts_path'  => $review_fixture_root,
		'artifact_id'     => $artifact_id,
		'action'          => 'approve',
		'approved_files'  => array( '/wordpress/wp-content/plugins/example/generated.txt', '' ),
		'approver'        => 'site-user:reviewer',
		'reason'          => 'Ship the generated fix.',
		'decided_at'      => '2026-05-20T00:00:00Z',
		'apply_target'    => array( 'repo' => 'Automattic/wp-codebox' ),
		'context'         => array( 'product' => 'studio-web' ),
	)
);
$assert( 'artifact review approve returns generic decision result', ! is_wp_error( $approved_review ) && 'wp-codebox/artifact-review-result/v1' === ( $approved_review['schema'] ?? '' ) && 'approve' === ( $approved_review['action'] ?? '' ) && 'wp-codebox/artifact-apply/v1' === ( $approved_review['result']['schema'] ?? '' ) );
$assert( 'artifact review approve preserves approved files and provenance', ! is_wp_error( $approved_review ) && array( '/wordpress/wp-content/plugins/example/generated.txt' ) === ( $approved_review['decision']['approved_files'] ?? array() ) && 'chat:user-7' === ( $approved_review['decision']['requester'] ?? '' ) && 'chat:user-7' === ( $approved_review['decision']['provenance']['artifact']['task']['requester'] ?? '' ) );
$assert( 'artifact review approve returns browser decision message shape', ! is_wp_error( $approved_review ) && 'wp-codebox:artifact-review-decision' === ( $approved_review['message']['type'] ?? '' ) && 'wp-codebox/artifact-review-decision/v1' === ( $approved_review['message']['payload']['schema'] ?? '' ) && 'wp-codebox/wordpress-plugin' === ( $approved_review['message']['payload']['source'] ?? '' ) );
$assert( 'artifact review approve delegates approval consequence to adapter', 1 === count( $review_apply_payloads ) && array( 'repo' => 'Automattic/wp-codebox' ) === ( $review_apply_payloads[0]['apply_target'] ?? array() ) );

$captured_review_decisions = array();
$GLOBALS['wp_codebox_filters']['wp_codebox_review_artifact_decision'] = function ( mixed $value, array $payload ) use ( &$captured_review_decisions ): array {
	$captured_review_decisions[] = $payload['decision'];
	return array(
		'schema'          => 'wp-codebox/artifact-review-result/v1',
		'adapter'         => 'review-state-adapter',
		'status'          => $payload['decision']['action'],
		'audit_reference' => 'review-state:' . $payload['decision']['action'],
	);
};
$rejected_review = $artifacts->review_artifact(
	array(
		'artifacts_path' => $review_fixture_root,
		'artifact_id'    => $artifact_id,
		'action'         => 'reject',
		'approver'       => 'site-user:reviewer',
		'reason'         => 'Wrong target.',
	)
);
$changes_review = $artifacts->review_artifact(
	array(
		'artifacts_path' => $review_fixture_root,
		'artifact_id'    => $artifact_id,
		'action'         => 'request-changes',
		'approver'       => 'site-user:reviewer',
		'reason'         => 'Limit the patch to generated.txt.',
	)
);
$assert( 'artifact review reject normalizes decision without approved files', ! is_wp_error( $rejected_review ) && 'reject' === ( $rejected_review['decision']['action'] ?? '' ) && array() === ( $rejected_review['decision']['approved_files'] ?? array() ) && 'Wrong target.' === ( $rejected_review['decision']['reason'] ?? '' ) );
$assert( 'artifact review request-changes normalizes decision message', ! is_wp_error( $changes_review ) && 'request-changes' === ( $changes_review['message']['payload']['action'] ?? '' ) && 'review-state-adapter' === ( $changes_review['result']['adapter'] ?? '' ) );
$assert( 'artifact review hook receives reject and request-changes decisions', array( 'reject', 'request-changes' ) === array_map( static fn( array $decision ): string => (string) $decision['action'], $captured_review_decisions ) );
$review_audit_path = $review_fixture_root . '/review-audit.jsonl';
$review_audit_lines = is_file( $review_audit_path ) ? array_values( array_filter( explode( "\n", trim( (string) file_get_contents( $review_audit_path ) ) ) ) ) : array();
$review_audit_first = isset( $review_audit_lines[0] ) ? json_decode( $review_audit_lines[0], true ) : array();
$assert( 'artifact review audit records decisions separately from apply consequences', 3 === count( $review_audit_lines ) && 'wp-codebox/artifact-review-audit/v1' === ( $review_audit_first['schema'] ?? '' ) && 'approve' === ( $review_audit_first['action'] ?? '' ) );
unset( $GLOBALS['wp_codebox_filters']['wp_codebox_review_artifact_decision'] );

$GLOBALS['wp_codebox_filters']['wp_codebox_apply_approved_artifact'] = function ( mixed $value, array $payload ): array {
	return array(
		'schema'          => 'wp-codebox/apply-result/v1',
		'adapter'         => 'test-adapter',
		'status'          => 'pr-opened',
		'target'          => is_array( $payload['apply_target'] ?? null ) ? $payload['apply_target'] : array( 'repo' => 'Automattic/wp-codebox' ),
		'applied_files'   => array( 'generated.txt' ),
		'commit'          => 'abc1234',
		'pr_url'          => 'https://github.com/Automattic/wp-codebox/pull/999',
		'audit_reference' => 'external-apply-record:test-999',
		'patch'           => $payload['patch'],
		'access_token'    => 'secret-token-value',
	);
};
$applied = $artifacts->apply_approved(
	array(
		'artifacts_path'  => $artifact_root,
		'artifact_id'     => $artifact_id,
		'approved_files'  => array( '/wordpress/wp-content/plugins/example/generated.txt' ),
		'approver'        => 'site-user:1',
		'apply_target'    => array(
			'repo'   => 'Automattic/wp-codebox',
			'branch' => 'codebox/test-adapter',
		),
	)
);
$assert( 'approved artifact apply returns typed adapter result', ! is_wp_error( $applied ) && 'wp-codebox/apply-result/v1' === ( $applied['result']['schema'] ?? '' ) && 'test-adapter' === ( $applied['result']['adapter'] ?? '' ) && 'pr-opened' === ( $applied['result']['status'] ?? '' ) && array( 'generated.txt' ) === ( $applied['result']['applied_files'] ?? array() ) && array( 'repo' => 'Automattic/wp-codebox', 'branch' => 'codebox/test-adapter' ) === ( $applied['result']['target'] ?? array() ) && hash( 'sha256', $approved_patch_diff ) === ( $applied['patch_sha256'] ?? '' ) && $content_digest === ( $applied['content_digest'] ?? '' ) );

$captured_stage_args = array();
$GLOBALS['wp_codebox_filters']['wp_codebox_stage_pending_apply_artifact'] = function ( mixed $value, array $stage_args ) use ( &$captured_stage_args ): array {
	$captured_stage_args = $stage_args;
	return array(
		'staged'    => true,
		'action_id' => 'act_test',
		'payload'   => array(
			'pending_action' => array(
				'kind'        => $stage_args['kind'],
				'apply_input' => $stage_args['apply_input'],
				'preview'     => $stage_args['preview_data'],
			),
		),
	);
};
$staged = WP_Codebox_Data_Machine_Pending_Actions::stage_apply_artifact(
	array(
		'artifacts_path'  => $artifact_root,
		'artifact_id'     => $artifact_id,
		'approved_files'  => array( '/wordpress/wp-content/plugins/example/generated.txt', '' ),
		'approver'        => 'site-user:1',
		'apply_target'    => array( 'repo' => 'Automattic/wp-codebox' ),
		'context'         => array( 'session_id' => 'chat-123' ),
	)
);
$assert( 'pending artifact apply can be staged', ! is_wp_error( $staged ) && true === ( $staged['staged'] ?? false ) && WP_Codebox_Data_Machine_Pending_Actions::KIND === ( $captured_stage_args['kind'] ?? '' ) );
$assert( 'pending artifact apply stores exact apply input', $artifact_id === ( $captured_stage_args['apply_input']['artifact_id'] ?? '' ) && array( '/wordpress/wp-content/plugins/example/generated.txt' ) === ( $captured_stage_args['apply_input']['approved_files'] ?? array() ) && array( 'repo' => 'Automattic/wp-codebox' ) === ( $captured_stage_args['apply_input']['apply_target'] ?? array() ) );
$assert( 'pending artifact apply preview includes review and changed files', 'wp-codebox/pending-apply-preview/v1' === ( $captured_stage_args['preview_data']['schema'] ?? '' ) && 'wp-codebox/artifact-review/v1' === ( $captured_stage_args['preview_data']['review']['schema'] ?? '' ) && 'wp-codebox/changed-files/v1' === ( $captured_stage_args['preview_data']['changed_files']['schema'] ?? '' ) );
$assert( 'pending artifact apply preview includes successful bundle verification', true === ( $captured_stage_args['preview_data']['verification']['valid'] ?? false ) && 'wp-codebox/artifact-bundle-verification/v1' === ( $captured_stage_args['preview_data']['verification']['schema'] ?? '' ) );

$handlers = apply_filters( 'datamachine_pending_action_handlers', array() );
$assert( 'pending artifact apply handler registers with Data Machine', isset( $handlers[ WP_Codebox_Data_Machine_Pending_Actions::KIND ]['apply'] ) && is_callable( $handlers[ WP_Codebox_Data_Machine_Pending_Actions::KIND ]['apply'] ) );
$pending_handler_result = call_user_func(
	$handlers[ WP_Codebox_Data_Machine_Pending_Actions::KIND ]['apply'],
	array(
		'artifacts_path'  => $artifact_root,
		'artifact_id'     => $artifact_id,
		'approved_files'  => array( '/wordpress/wp-content/plugins/example/generated.txt' ),
		'approver'        => 'site-user:1',
	)
);
$assert( 'pending artifact apply handler delegates to approved artifact apply', ! is_wp_error( $pending_handler_result ) && true === ( $pending_handler_result['success'] ?? false ) && $artifact_id === ( $pending_handler_result['artifact_id'] ?? '' ) );

$audit_path      = $artifact_root . '/apply-audit.jsonl';
$audit_lines     = is_file( $audit_path ) ? array_values( array_filter( explode( "\n", trim( (string) file_get_contents( $audit_path ) ) ) ) ) : array();
$success_audit   = isset( $audit_lines[0] ) ? json_decode( $audit_lines[0], true ) : array();
$success_encoded = isset( $audit_lines[0] ) ? $audit_lines[0] : '';
$assert( 'approved artifact apply writes success audit record', is_array( $success_audit ) && 'wp-codebox/apply-audit/v1' === ( $success_audit['schema'] ?? '' ) && 'success' === ( $success_audit['status'] ?? '' ) );
$assert( 'success audit records reviewed principals and files', 'chat:user-7' === ( $success_audit['requester'] ?? '' ) && 'site-user:1' === ( $success_audit['approver'] ?? '' ) && array( '/wordpress/wp-content/plugins/example/generated.txt' ) === ( $success_audit['approved_files'] ?? array() ) );
$assert( 'success audit records applied patch digest and adapter metadata', $artifact_id === ( $success_audit['artifact_id'] ?? '' ) && $content_digest === ( $success_audit['content_digest'] ?? '' ) && hash( 'sha256', $approved_patch_diff ) === ( $success_audit['patch_sha256'] ?? '' ) && 'test-adapter' === ( $success_audit['adapter'] ?? '' ) && 'https://github.com/Automattic/wp-codebox/pull/999' === ( $success_audit['result']['pr_url'] ?? '' ) );
$assert( 'success audit excludes raw patch body and secrets', ! str_contains( $success_encoded, 'diff --git' ) && ! str_contains( $success_encoded, 'secret-token-value' ) && ! array_key_exists( 'patch', $success_audit['result'] ?? array() ) && ! array_key_exists( 'access_token', $success_audit['result'] ?? array() ) );

$GLOBALS['wp_codebox_filters']['wp_codebox_apply_approved_artifact'] = function (): array {
	return array(
		'adapter' => 'malformed-adapter',
		'pr_url'  => 'https://github.com/Automattic/wp-codebox/pull/998',
	);
};
$malformed_apply = $artifacts->apply_approved(
	array(
		'artifacts_path'  => $artifact_root,
		'artifact_id'     => $artifact_id,
		'approved_files'  => array( '/wordpress/wp-content/plugins/example/generated.txt' ),
		'approver'        => 'site-user:3',
	)
);
$audit_lines      = is_file( $audit_path ) ? array_values( array_filter( explode( "\n", trim( (string) file_get_contents( $audit_path ) ) ) ) ) : array();
$malformed_audit  = isset( $audit_lines[2] ) ? json_decode( $audit_lines[2], true ) : array();
$assert( 'approved artifact rejects malformed adapter result', is_wp_error( $malformed_apply ) && 'wp_codebox_apply_result_invalid' === $malformed_apply->get_error_code() && is_array( $malformed_audit ) && 'failure' === ( $malformed_audit['status'] ?? '' ) && 'wp_codebox_apply_result_invalid' === ( $malformed_audit['error']['code'] ?? '' ) );

$GLOBALS['wp_codebox_filters']['wp_codebox_apply_approved_artifact'] = function (): WP_Error {
	return new WP_Error( 'wp_codebox_adapter_failed', 'Adapter failed to apply artifact.', array( 'status' => 502, 'adapter' => 'test-adapter', 'patch' => 'diff --git should not persist', 'password' => 'secret-password-value' ) );
};
$failed_apply = $artifacts->apply_approved(
	array(
		'artifacts_path'  => $artifact_root,
		'artifact_id'     => $artifact_id,
		'approved_files'  => array( '/wordpress/wp-content/plugins/example/generated.txt' ),
		'approver'        => 'site-user:2',
	)
);
$audit_lines   = is_file( $audit_path ) ? array_values( array_filter( explode( "\n", trim( (string) file_get_contents( $audit_path ) ) ) ) ) : array();
$failure_audit = isset( $audit_lines[3] ) ? json_decode( $audit_lines[3], true ) : array();
$failure_encoded = isset( $audit_lines[3] ) ? $audit_lines[3] : '';
$assert( 'approved artifact apply writes adapter failure audit record', is_wp_error( $failed_apply ) && is_array( $failure_audit ) && 'failure' === ( $failure_audit['status'] ?? '' ) && 'test-adapter' === ( $failure_audit['adapter'] ?? '' ) && 'wp_codebox_adapter_failed' === ( $failure_audit['error']['code'] ?? '' ) );
$assert( 'failure audit records approver and excludes raw patch body and secrets', 'site-user:2' === ( $failure_audit['approver'] ?? '' ) && ! str_contains( $failure_encoded, 'diff --git' ) && ! str_contains( $failure_encoded, 'secret-password-value' ) && '[redacted]' === ( $failure_audit['error']['data']['patch'] ?? '' ) && '[redacted]' === ( $failure_audit['error']['data']['password'] ?? '' ) );

$unknown_apply = $artifacts->apply_approved(
	array(
		'artifacts_path' => $artifact_root,
		'artifact_id'    => $artifact_id,
		'approved_files' => array( '/wordpress/wp-content/plugins/example/unknown.txt' ),
	)
);
$assert( 'approved artifact rejects unknown files', is_wp_error( $unknown_apply ) && 'wp_codebox_approved_files_invalid' === $unknown_apply->get_error_code() );

$discarded = $artifacts->discard(
	array(
		'artifacts_path' => $artifact_root,
		'artifact_id'    => $artifact_id,
	)
);
$assert( 'artifact discard removes bundle inside root', ! is_wp_error( $discarded ) && ! is_dir( $bundle_dir ) );

if ( ! empty( $failures ) ) {
	echo "\nFAIL: " . count( $failures ) . " assertion(s) failed out of {$total}\n";
	foreach ( $failures as $failure ) {
		echo "  - {$failure}\n";
	}
	exit( 1 );
}

echo "\nOK ({$total} assertions)\n";
exit( 0 );
