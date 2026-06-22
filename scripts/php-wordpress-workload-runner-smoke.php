<?php
declare(strict_types=1);

define( 'ABSPATH', __DIR__ . '/../' );

class WP_Error {
	public function __construct( public string $code = '', public string $message = '', public array $data = array() ) {}
	public function get_error_message(): string { return $this->message; }
}

function is_wp_error( mixed $value ): bool {
	return $value instanceof WP_Error;
}

class WP_REST_Request {
	public array $params = array();
	public array $headers = array();
	public array $body_params = array();
	public string $body = '';
	public function __construct( public string $method, public string $path ) {}
	public function set_param( string $key, mixed $value ): void { $this->params[ $key ] = $value; }
	public function set_header( string $key, string $value ): void { $this->headers[ $key ] = $value; }
	public function set_body_params( array $params ): void { $this->body_params = $params; }
	public function set_body( string $body ): void { $this->body = $body; }
}

class WP_Codebox_Test_REST_Response {
	public function __construct( private int $status ) {}
	public function get_status(): int { return $this->status; }
}

function rest_do_request( WP_REST_Request $request ): WP_Codebox_Test_REST_Response {
	return new WP_Codebox_Test_REST_Response( '/wp/v2/status' === $request->path ? 200 : 404 );
}

require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-wordpress-workload-runner.php';
require_once __DIR__ . '/../packages/wordpress-plugin/src/trait-wp-codebox-abilities-execution.php';

class WP_Codebox_WordPress_Workload_Runner_Smoke {
	use WP_Codebox_Abilities_Execution;
}

$result = WP_Codebox_WordPress_Workload_Runner_Smoke::run_wordpress_workload(
	array(
		'schema'    => 'wp-codebox/wordpress-workload-run/v1',
		'artifacts' => array(
			array( 'name' => 'report', 'path' => 'workload/report.json' ),
		),
		'steps'     => array(
			array( 'command' => 'wordpress.rest-request', 'args' => array( 'path=/wp/v2/status', 'method=GET' ) ),
			array( 'command' => 'wordpress.collect-workload-result', 'args' => array( 'artifact=report' ) ),
			array( 'command' => 'wordpress.unsupported-safe-step', 'advisory' => true ),
		),
	)
);

assert( is_array( $result ) );
assert( true === $result['success'] );
assert( 'wp-codebox/wordpress-workload-run-result/v1' === $result['schema'] );
assert( 'completed' === $result['status'] );
assert( 'passed' === $result['steps'][0]['status'] );
assert( 200 === $result['steps'][0]['observation']['status'] );
assert( 'workload/report.json' === $result['artifacts'][0]['path'] );
assert( 'skipped' === $result['steps'][2]['status'] );
assert( 'wp_codebox_wordpress_workload_step_unsupported' === $result['steps'][2]['diagnostics'][0]['code'] );

$unsafe = WP_Codebox_WordPress_Workload_Runner_Smoke::run_wordpress_workload(
	array(
		'schema' => 'wp-codebox/wordpress-workload-run/v1',
		'steps'  => array( array( 'command' => 'wordpress.rest-request', 'args' => array( 'path=/wp/v2/status' ), 'php_code' => 'echo 1;' ) ),
	)
);

assert( $unsafe instanceof WP_Error );
assert( 'wp_codebox_wordpress_workload_unsafe_input' === $unsafe->code );
assert( in_array( 'steps.0.php_code', $unsafe->data['unsafe_fields'], true ) );

$unsafe_command = WP_Codebox_WordPress_Workload_Runner_Smoke::run_wordpress_workload(
	array(
		'schema'  => 'wp-codebox/wordpress-workload-run/v1',
		'command' => 'wp eval',
		'steps'   => array( array( 'command' => 'wordpress.rest-request', 'args' => array( 'path=/wp/v2/status' ) ) ),
	)
);

assert( $unsafe_command instanceof WP_Error );
assert( 'wp_codebox_wordpress_workload_unsafe_input' === $unsafe_command->code );
assert( in_array( 'command', $unsafe_command->data['unsafe_fields'], true ) );

echo "PHP WordPress workload runner smoke passed.\n";
