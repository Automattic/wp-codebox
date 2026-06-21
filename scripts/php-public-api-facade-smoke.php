<?php
declare(strict_types=1);

define( 'ABSPATH', __DIR__ );

if ( ! class_exists( 'WP_Error' ) ) {
	final class WP_Error {
		public function __construct( private string $code = '', private string $message = '', private mixed $data = null ) {}
		public function get_error_code(): string { return $this->code; }
		public function get_error_message(): string { return $this->message; }
		public function get_error_data(): mixed { return $this->data; }
	}
}

require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-api.php';

function expect( bool $condition, string $message ): void {
	if ( ! $condition ) {
		fwrite( STDERR, $message . PHP_EOL );
		exit( 1 );
	}
}

$expected_methods = array(
	'execute_ability',
	'run_agent_task',
	'run_agent_task_batch',
	'run_agent_task_fanout',
	'create_browser_session',
	'create_browser_contained_site_session',
	'get_browser_session_status',
	'preview_reuse_decision',
	'open_browser_session',
	'open_or_create_browser_session',
	'list_artifacts',
	'get_artifact',
	'preflight_artifact_apply',
	'stage_artifact_apply',
	'apply_approved_artifact',
	'prepare_runner_workspace',
	'capture_runner_workspace',
	'run_runner_workspace_command',
	'publish_runner_workspace',
);

$reflection = new ReflectionClass( WP_Codebox_API::class );
foreach ( $expected_methods as $method ) {
	expect( $reflection->hasMethod( $method ), 'Missing public API method: ' . $method );
	expect( $reflection->getMethod( $method )->isPublic(), 'API method is not public: ' . $method );
}

$blocked = WP_Codebox_API::execute_ability( 'datamachine-code/workspace-show', array() );
expect( $blocked instanceof WP_Error, 'Expected non-wp-codebox ability names to be rejected.' );
expect( 'wp_codebox_api_ability_not_supported' === $blocked->get_error_code(), 'Expected unsupported ability error code.' );

fwrite( STDOUT, "PHP public API facade smoke passed\n" );
