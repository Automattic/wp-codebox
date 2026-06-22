<?php
declare(strict_types=1);

define( 'ABSPATH', __DIR__ . '/../' );
define( 'WP_CONTENT_DIR', __DIR__ );

class WP_Error {
	public function __construct( public string $code = '', public string $message = '', public array $data = array() ) {}
	public function get_error_message(): string { return $this->message; }
}

function is_wp_error( mixed $value ): bool {
	return $value instanceof WP_Error;
}

function wp_json_encode( mixed $value, int $flags = 0 ): string|false {
	return json_encode( $value, $flags );
}

function home_url( string $path = '/' ): string {
	return 'https://example.test' . ( str_starts_with( $path, '/' ) ? $path : '/' . $path );
}

function wp_parse_url( string $url, int $component = -1 ): mixed {
	return -1 === $component ? parse_url( $url ) : parse_url( $url, $component );
}

function wp_remote_request( string $url, array $args = array() ): array|WP_Error {
	if ( str_contains( $url, '/server-error/' ) ) {
		return array( 'status' => 500, 'headers' => array( 'content-type' => 'text/html' ), 'body' => 'error' );
	}
	return array( 'status' => 200, 'headers' => array( 'content-type' => 'text/html' ), 'body' => '<html></html>' );
}

function wp_remote_retrieve_response_code( array $response ): int {
	return (int) ( $response['status'] ?? 0 );
}

function wp_remote_retrieve_header( array $response, string $header ): string {
	return (string) ( $response['headers'][ strtolower( $header ) ] ?? '' );
}

function wp_remote_retrieve_body( array $response ): string {
	return (string) ( $response['body'] ?? '' );
}

function wp_upload_dir( mixed $time = null, bool $create_dir = true ): array {
	return array( 'basedir' => WP_CONTENT_DIR . '/uploads' );
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

require_once __DIR__ . '/../packages/wordpress-plugin/src/trait-wp-codebox-abilities-execution.php';

class WP_Codebox_Fuzz_Suite_Runner_Smoke {
	use WP_Codebox_Abilities_Execution;
}

$result = WP_Codebox_Fuzz_Suite_Runner_Smoke::run_fuzz_suite(
	array(
		'schema' => 'wp-codebox/fuzz-suite/v1',
		'id'     => 'php-smoke-suite',
		'cases'  => array(
			array(
				'id'        => 'browser-coverage',
				'phases'    => array(
					'action' => array(
						array( 'command' => 'wordpress.trace-browser-coverage', 'args' => array( 'surface=frontend', 'paths=/,/shop/' ) ),
					),
				),
				'artifacts' => array(
					array( 'name' => 'frontend_rendering_request_coverage', 'path' => 'browser-coverage/frontend_rendering_request_coverage.json', 'metadata' => array( 'semantic_key' => 'fuzz.report' ) ),
				),
			),
			array(
				'case_id'   => 'collect-artifact',
				'phases'    => array(
					'assert' => array(
						array( 'command' => 'wordpress.collect-workload-result', 'args' => array( 'artifact=report' ) ),
					),
				),
				'artifacts' => array(
					array( 'name' => 'report', 'path' => 'php-smoke/report.json', 'metadata' => array( 'semantic_key' => 'fuzz.report' ) ),
				),
			),
			array(
				'id'     => 'unsupported-step',
				'phases' => array(
					'action' => array(
						array( 'command' => 'wordpress.unsupported-fuzz-command' ),
					),
				),
			),
			array(
				'id'     => 'runtime-action-rest',
				'target' => array( 'kind' => 'runtime-action' ),
				'input'  => array( 'type' => 'rest_request', 'path' => '/wp/v2/status', 'method' => 'GET' ),
			),
			array(
				'id'     => 'runtime-action-wp-cli',
				'target' => array( 'kind' => 'runtime-action' ),
				'input'  => array( 'type' => 'wp_cli', 'command' => 'option get blogname' ),
			),
		),
	)
);

assert( is_array( $result ) );
assert( 'wp-codebox/fuzz-suite-result/v1' === $result['schema'] );
assert( true === $result['success'] );
assert( 'passed' === $result['status'] );
assert( 5 === $result['summary']['total'] );
assert( 3 === $result['summary']['passed'] );
assert( 2 === $result['summary']['skipped'] );
assert( 'browser-coverage' === $result['cases'][0]['id'] );
assert( 'passed' === $result['cases'][0]['status'] );
assert( is_file( WP_CONTENT_DIR . '/uploads/browser-coverage/frontend_rendering_request_coverage.json' ) );
$coverage = json_decode( file_get_contents( WP_CONTENT_DIR . '/uploads/browser-coverage/frontend_rendering_request_coverage.json' ), true );
assert( 'wp-codebox/browser-request-coverage/v1' === $coverage['schema'] );
assert( 2 === $coverage['summary']['covered'] );
assert( 'collect-artifact' === $result['cases'][1]['id'] );
assert( 'passed' === $result['cases'][1]['status'] );
assert( 'browser-coverage/frontend_rendering_request_coverage.json' === $result['artifactRefs'][0]['path'] );
assert( 'wp_codebox_fuzz_step_unsupported' === $result['cases'][2]['diagnostics'][0]['code'] );
assert( 'runtime-action-rest' === $result['cases'][3]['id'] );
assert( 'passed' === $result['cases'][3]['status'] );
assert( 'wordpress.rest-request' === $result['cases'][3]['metadata']['observations'][0]['command'] );
assert( 'runtime-action-wp-cli' === $result['cases'][4]['id'] );
assert( 'skipped' === $result['cases'][4]['status'] );
assert( 'wordpress.wp-cli' === $result['cases'][4]['metadata']['observations'][0]['command'] );

$unsafe = WP_Codebox_Fuzz_Suite_Runner_Smoke::run_fuzz_suite(
	array(
		'schema' => 'wp-codebox/fuzz-suite/v1',
		'id'     => 'unsafe-suite',
		'cases'  => array( array( 'id' => 'unsafe', 'input' => array( 'php_code' => 'echo 1;' ) ) ),
	)
);

assert( $unsafe instanceof WP_Error );
assert( 'wp_codebox_fuzz_suite_unsafe_input' === $unsafe->code );

echo "PHP fuzz suite runner smoke passed.\n";
