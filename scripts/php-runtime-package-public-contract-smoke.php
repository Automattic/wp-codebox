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

$wpsg_like_task = array(
	'schema'                => 'wp-codebox/runtime-package-task/v1',
	'package'               => array( 'slug' => 'store-idea-agent', 'source' => $bundle_root ),
	'workflow'              => array( 'id' => 'store-idea-artifact-flow' ),
	'input'                 => array( 'prompt' => 'Industry: open' ),
	'artifact_declarations' => array( array( 'name' => 'concept_packet', 'type' => 'typed_artifact', 'required' => true ) ),
	'required_artifacts'    => array( 'concept_packet' ),
	'metadata'              => array( 'caller' => 'wpsg-like-contract-smoke' ),
);

WP_Codebox_Runtime_Package_Executor::register_runtime_provider();
add_filter( 'wp_agent_runtime_import_bundle', static fn( mixed $result, array $spec ): array => array( 'success' => true, 'slug' => $spec['slug'] ?? '' ), 10, 2 );
$native = WP_Codebox_Abilities::run_runtime_package( $wpsg_like_task + array( 'runtime_provider' => 'codebox-runtime-package' ) );
assert( ! is_wp_error( $native ) );
assert( true === $native['success'] );
assert( 'native semantic output' === $native['outputs']['summary'] );
assert( 'store-idea-agent' === $native['outputs']['agent'] );
assert( 'store-idea-artifact-flow' === $native['metadata']['workflow_id'] );
assert( 'store-idea-artifact-pipeline' === $native['metadata']['pipeline_id'] );
assert( 'concept_packet' === $native['artifacts'][0]['name'] );
assert( 'store-idea-artifact-flow' === $GLOBALS['wp_codebox_runtime_package_smoke_input']['runtime_package_flow']['slug'] );
assert( 'store-idea-artifact-pipeline' === $GLOBALS['wp_codebox_runtime_package_smoke_input']['runtime_package_pipeline']['slug'] );
assert( str_contains( $GLOBALS['wp_codebox_runtime_package_smoke_input']['message'], 'ConceptPacket' ) );
assert( 'codebox-runtime-package' === $native['metadata']['runtime_provider']['id'] );
assert( ! in_array( 'agents/run-runtime-package', $GLOBALS['wp_codebox_runtime_package_smoke_abilities'], true ) );

$invalid = WP_Codebox_Abilities::run_runtime_package( array( 'schema' => 'wp-codebox/runtime-package-task/v1', 'package' => array( 'slug' => 'example-agent' ) ) );
assert( is_wp_error( $invalid ) );
assert( 'wp_codebox_runtime_package_task_invalid' === $invalid->get_error_code() );

fwrite( STDOUT, "PHP runtime package public contract smoke passed\n" );
