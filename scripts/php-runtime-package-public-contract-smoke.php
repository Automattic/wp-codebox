<?php
declare(strict_types=1);

define( 'ABSPATH', __DIR__ );

function is_wp_error( mixed $value ): bool {
	return $value instanceof WP_Error;
}
function wp_json_encode( mixed $value, int $flags = 0, int $depth = 512 ): string|false { return json_encode( $value, $flags, $depth ); }

final class WP_Error {
	public function __construct( private string $code, private string $message, private array $data = array() ) {}
	public function get_error_code(): string { return $this->code; }
	public function get_error_message(): string { return $this->message; }
	public function get_error_data(): array { return $this->data; }
}

require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-runtime-provider-registry.php';
require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-runtime-package-executor.php';
require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-abilities.php';

$GLOBALS['wp_codebox_runtime_package_smoke_filters'] = array();
function add_filter( string $hook, callable $callback, int $priority = 10, int $accepted_args = 1 ): void {
	unset( $priority, $accepted_args );
	$GLOBALS['wp_codebox_runtime_package_smoke_filters'][ $hook ][] = $callback;
}
function apply_filters( string $hook, mixed $value, mixed ...$args ): mixed {
	foreach ( $GLOBALS['wp_codebox_runtime_package_smoke_filters'][ $hook ] ?? array() as $callback ) {
		$value = $callback( $value, ...$args );
	}
	return $value;
}
function get_current_user_id(): int { return 1; }
function wp_agent_import_runtime_bundles( array $bundles, array $options ): array {
	$GLOBALS['wp_codebox_runtime_package_imports'] = array( 'bundles' => $bundles, 'options' => $options );
	return array_map(
		static function( array $bundle ): array {
			$document = json_decode( (string) file_get_contents( (string) $bundle['source'] ), true );
			$slug     = (string) ( $document['agent']['agent_slug'] ?? '' );
			$GLOBALS['wp_codebox_runtime_package_registered_agents'][ $slug ] = true;
			return array( 'success' => true, 'agent_slug' => $slug );
		},
		$bundles
	);
}
function wp_get_agent( string $slug ): ?object { return ! empty( $GLOBALS['wp_codebox_runtime_package_registered_agents'][ $slug ] ) ? (object) array( 'slug' => $slug ) : null; }
function wp_codebox_smoke_package_digest( string $root ): string {
	$files = array();
	$iterator = new RecursiveIteratorIterator( new RecursiveDirectoryIterator( $root, FilesystemIterator::SKIP_DOTS ), RecursiveIteratorIterator::LEAVES_ONLY );
	foreach ( $iterator as $file ) {
		$files[ str_replace( '\\', '/', substr( $file->getPathname(), strlen( $root ) + 1 ) ) ] = hash_file( 'sha256', $file->getPathname() );
	}
	ksort( $files, SORT_STRING );
	$context = hash_init( 'sha256' );
	foreach ( $files as $path => $digest ) {
		hash_update( $context, $path . "\0" . $digest . "\n" );
	}
	return hash_final( $context );
}

final class WP_Codebox_Runtime_Package_Smoke_Ability {
	public function execute( array $input ): array {
		$GLOBALS['wp_codebox_runtime_package_smoke_input'] = $input;
		return array(
			'success'         => true,
			'outputs'         => array( 'summary' => 'native semantic output', 'agent' => $input['agent'] ?? '' ),
			'typed_artifacts' => array(
				array(
					'output_key' => 'concept_packet',
					'schema'     => 'wp-site-generator/ConceptPacket/v1',
					'payload'    => array( 'title' => 'Runtime package concept' ),
				),
			),
		);
	}
}
function wp_get_ability( string $name ): ?WP_Codebox_Runtime_Package_Smoke_Ability {
	$GLOBALS['wp_codebox_runtime_package_smoke_abilities'][] = $name;
	return 'agents/chat' === $name ? new WP_Codebox_Runtime_Package_Smoke_Ability() : null;
}

WP_Codebox_Runtime_Provider_Registry::register(
	'contract-runtime',
	static fn( array $input ): array => array(
		'schema'      => 'upstream/runtime-package-result/v1',
		'success'     => true,
		'outputs'     => array( 'summary' => 'semantic output' ),
		'artifacts'   => array( array( 'name' => 'report', 'type' => 'markdown', 'path' => 'files/report.md' ) ),
		'received'    => $input,
		'diagnostics' => array(),
	),
	array( 'default' => true, 'label' => 'Contract runtime' )
);

$task = array(
	'schema'                => 'wp-codebox/runtime-package-task/v1',
	'package'               => array( 'slug' => 'example-agent', 'source' => '/workspace/bundles/example-agent' ),
	'workflow'              => array( 'id' => 'example-agent' ),
	'input'                 => array( 'prompt' => 'ship' ),
	'artifact_declarations' => array( array( 'name' => 'report', 'type' => 'markdown', 'required' => true ) ),
	'required_artifacts'    => array( 'report' ),
	'metadata'              => array( 'caller' => 'contract-smoke' ),
);

$result = WP_Codebox_Abilities::run_runtime_package( $task );
assert( ! is_wp_error( $result ) );
assert( 'wp-codebox/runtime-package-result/v1' === $result['schema'] );
assert( 'success' === $result['status'] );
assert( true === $result['success'] );
assert( $task['package'] === $result['package'] );
assert( array( 'summary' => 'semantic output' ) === $result['outputs'] );
assert( array( 'name' => 'report', 'type' => 'markdown', 'path' => 'files/report.md' ) === $result['artifacts'][0] );
assert( array() === $result['diagnostics'] );
assert( 'contract-runtime' === $result['metadata']['runtime_provider']['id'] );
assert( isset( $result['metadata']['received'] ) );

$bundle_root = realpath( (string) ( getenv( 'WP_CODEBOX_RUNTIME_PACKAGE_FIXTURE' ) ?: __DIR__ . '/../tests/fixtures/wpsg-runtime-package' ) );
assert( false !== $bundle_root );
$staged_bundle_root = sys_get_temp_dir() . '/wp-codebox-runtime-package-' . bin2hex( random_bytes( 8 ) );
mkdir( $staged_bundle_root, 0700, true );
$staged_bundle_file = $staged_bundle_root . '/package.agent.json';
copy( $bundle_root . '/.agent.json', $staged_bundle_file );

$wpsg_like_task = array(
	'schema'                => 'wp-codebox/runtime-package-task/v1',
	'package'               => array( 'slug' => 'store-idea-agent', 'source' => $staged_bundle_file, 'external_source' => array( 'digest' => 'sha256-bytes-v1:' . hash_file( 'sha256', $staged_bundle_file ) ) ),
	'workflow'              => array( 'id' => 'agents/chat' ),
	'input'                 => array( 'prompt' => 'Industry: open', 'provider' => 'openai', 'model' => 'gpt-5.5' ),
	'artifact_declarations' => array( array( 'name' => 'concept_packet', 'type' => 'typed_artifact', 'required' => true ) ),
	'required_artifacts'    => array( 'concept_packet' ),
	'metadata'              => array( 'caller' => 'wpsg-like-contract-smoke', 'imported_agent' => array( 'slug' => 'store-idea-agent' ) ),
);

WP_Codebox_Runtime_Package_Executor::register_runtime_provider();
$native = WP_Codebox_Abilities::run_runtime_package( $wpsg_like_task + array( 'runtime_provider' => 'codebox-runtime-package' ) );
assert( ! is_wp_error( $native ) );
assert( true === $native['success'] );
assert( 'native semantic output' === $native['outputs']['summary'] );
assert( 'store-idea-agent' === $native['outputs']['agent'] );
assert( 'agents/chat' === $native['metadata']['workflow_id'] );
assert( 'concept_packet' === $native['artifacts'][0]['name'] );
assert( 'Industry: open' === $GLOBALS['wp_codebox_runtime_package_smoke_input']['message'] );
assert( 'openai' === $GLOBALS['wp_codebox_runtime_package_smoke_input']['provider'] );
assert( 'gpt-5.5' === $GLOBALS['wp_codebox_runtime_package_smoke_input']['model'] );
assert( 'codebox-runtime-package' === $native['metadata']['runtime_provider']['id'] );
assert( 'store-idea-agent' === $GLOBALS['wp_codebox_runtime_package_imports']['bundles'][0]['slug'] );
assert( 1 === $GLOBALS['wp_codebox_runtime_package_imports']['options']['owner_id'] );
assert( ! in_array( 'agents/run-runtime-package', $GLOBALS['wp_codebox_runtime_package_smoke_abilities'], true ) );

$GLOBALS['wp_codebox_private_runtime_package_import'] = array(
	'digest'   => $wpsg_like_task['package']['external_source']['digest'],
	'imports'  => array( array( 'success' => true, 'agent_slug' => 'store-idea-agent' ) ),
	'identity' => array( 'slug' => 'store-idea-agent' ),
);
$GLOBALS['wp_codebox_runtime_package_registered_agents']['store-idea-agent'] = true;
$bootstrap_task = $wpsg_like_task;
$bootstrap_task['package']['slug']               = 'caller-controlled-agent';
$bootstrap_task['package']['bootstrap_imported'] = true;
$bootstrap_task['input']['agent']                = 'caller-controlled-agent';
$bootstrap = WP_Codebox_Abilities::run_runtime_package( $bootstrap_task + array( 'runtime_provider' => 'codebox-runtime-package' ) );
assert( ! is_wp_error( $bootstrap ) );
assert( 'store-idea-agent' === $GLOBALS['wp_codebox_runtime_package_smoke_input']['agent'] );

file_put_contents( $staged_bundle_file, "tampered\n" );
$tampered = WP_Codebox_Abilities::run_runtime_package( $wpsg_like_task + array( 'runtime_provider' => 'codebox-runtime-package' ) );
assert( is_wp_error( $tampered ) );
assert( 'wp_codebox_runtime_package_digest_mismatch' === $tampered->get_error_code() );

$cleanup = new RecursiveIteratorIterator( new RecursiveDirectoryIterator( $staged_bundle_root, FilesystemIterator::SKIP_DOTS ), RecursiveIteratorIterator::CHILD_FIRST );
unlink( $staged_bundle_file );
rmdir( $staged_bundle_root );

$invalid = WP_Codebox_Abilities::run_runtime_package( array( 'schema' => 'wp-codebox/runtime-package-task/v1', 'package' => array( 'slug' => 'example-agent' ) ) );
assert( is_wp_error( $invalid ) );
assert( 'wp_codebox_runtime_package_task_invalid' === $invalid->get_error_code() );

fwrite( STDOUT, "PHP runtime package public contract smoke passed\n" );
