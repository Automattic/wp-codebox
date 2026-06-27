<?php
declare(strict_types=1);

define( 'ABSPATH', __DIR__ );

function is_wp_error( mixed $value ): bool {
	return $value instanceof WP_Error;
}

final class WP_Error {
	public function __construct( private string $code, private string $message, private array $data = array() ) {}
	public function get_error_code(): string { return $this->code; }
	public function get_error_message(): string { return $this->message; }
	public function get_error_data(): array { return $this->data; }
}

require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-runtime-provider-registry.php';
require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-abilities.php';

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

$invalid = WP_Codebox_Abilities::run_runtime_package( array( 'schema' => 'wp-codebox/runtime-package-task/v1', 'package' => array( 'slug' => 'example-agent' ) ) );
assert( is_wp_error( $invalid ) );
assert( 'wp_codebox_runtime_package_task_invalid' === $invalid->get_error_code() );

fwrite( STDOUT, "PHP runtime package public contract smoke passed\n" );
