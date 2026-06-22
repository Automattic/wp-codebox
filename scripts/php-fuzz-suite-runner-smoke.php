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

function wp_json_encode( mixed $value ): string|false {
	return json_encode( $value );
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

class WP_Codebox_Test_REST_Server {
	public function get_routes(): array {
		return array(
			'/wp/v2/status' => array(
				array( 'methods' => array( 'GET' => true ) ),
			),
			'/sample/v1/items' => array(
				array( 'methods' => array( 'GET' => true, 'POST' => true ) ),
			),
		);
	}
}

function rest_get_server(): WP_Codebox_Test_REST_Server {
	return new WP_Codebox_Test_REST_Server();
}

function home_url( string $path = '' ): string {
	return 'https://example.test' . $path;
}

function wp_remote_request( string $url, array $args = array() ): array {
	return array( 'response' => array( 'code' => str_contains( $url, '/healthy' ) ? 200 : 404 ) );
}

function wp_remote_retrieve_response_code( array $response ): int {
	return (int) ( $response['response']['code'] ?? 0 );
}

function admin_url( string $path = '' ): string {
	return 'https://example.test/wp-admin/' . ltrim( $path, '/' );
}

function current_user_can( string $capability ): bool {
	return 'denied_cap' !== $capability;
}

function is_user_logged_in(): bool {
	return true;
}

function wp_get_current_user(): object {
	return (object) array( 'ID' => 1, 'roles' => array( 'administrator' ) );
}

function wp_strip_all_tags( string $value ): string {
	return strip_tags( $value );
}

function wp_has_ability( string $name ): bool {
	return 'example/echo' === $name;
}

function wp_call_ability( string $name, array $input ): array|WP_Error {
	return 'example/echo' === $name ? array( 'echo' => $input ) : new WP_Error( 'missing_ability', 'Ability missing.' );
}

require_once __DIR__ . '/../packages/wordpress-plugin/src/trait-wp-codebox-abilities-execution.php';

class WP_Codebox_Fuzz_Suite_Runner_Smoke {
	use WP_Codebox_Abilities_Execution;
}

$GLOBALS['menu'] = array(
	array( 'Dashboard', 'read', 'index.php' ),
	array( 'Products', 'manage_woocommerce', 'edit.php?post_type=product' ),
	array( 'Denied', 'denied_cap', 'denied.php' ),
);
$GLOBALS['submenu'] = array(
	'edit.php?post_type=product' => array(
		array( 'Add New', 'manage_woocommerce', 'post-new.php?post_type=product' ),
	),
);

$result = WP_Codebox_Fuzz_Suite_Runner_Smoke::run_fuzz_suite(
	array(
		'schema' => 'wp-codebox/fuzz-suite/v1',
		'id'     => 'php-smoke-suite',
		'cases'  => array(
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
				'id'     => 'rest-target',
				'target' => array( 'kind' => 'rest', 'id' => '/wp/v2/status' ),
				'input'  => array( 'method' => 'GET' ),
			),
			array(
				'id'     => 'rest-route-inventory',
				'phases' => array(
					'action' => array(
						array( 'command' => 'wordpress.inventory-rest-routes', 'args' => array( 'namespaces=sample/v1', 'artifact=route_inventory' ) ),
					),
				),
			),
			array(
				'id'     => 'admin-page-coverage',
				'phases' => array(
					'action' => array(
						array( 'command' => 'wordpress.fuzz-admin-pages', 'args' => array( 'max_pages=3' ) ),
					),
				),
			),
			array(
				'id'     => 'http-target',
				'target' => array( 'kind' => 'http', 'id' => '/healthy' ),
				'input'  => array( 'method' => 'GET' ),
			),
			array(
				'id'     => 'ability-target',
				'target' => array( 'kind' => 'ability', 'id' => 'example/echo' ),
				'input'  => array( 'input' => array( 'message' => 'hello' ) ),
			),
			array(
				'id'     => 'command-target',
				'target' => array( 'kind' => 'command', 'id' => 'inspect-mounted-inputs' ),
				'input'  => array( 'args' => array( '--json' ) ),
			),
			array(
				'id'     => 'runtime-target',
				'target' => array( 'kind' => 'runtime', 'entrypoint' => 'wordpress.run-php' ),
				'input'  => array( 'args' => array( 'bootstrap=none' ) ),
			),
			array(
				'id'     => 'runtime-action-wp-cli',
				'target' => array( 'kind' => 'runtime-action' ),
				'input'  => array( 'type' => 'wp_cli', 'command' => 'option get blogname' ),
			),
			array(
				'id'     => 'runtime-action-php',
				'target' => array( 'kind' => 'runtime-action' ),
				'input'  => array( 'type' => 'php' ),
			),
			array(
				'id'     => 'runtime-action-browser',
				'target' => array( 'kind' => 'runtime-action' ),
				'input'  => array( 'type' => 'browser', 'operation' => 'navigate', 'url' => '/sample-page/' ),
			),
			array(
				'id'     => 'runtime-action-browser-probe',
				'target' => array( 'kind' => 'runtime-action' ),
				'input'  => array( 'type' => 'browser_probe', 'url' => '/sample-page/' ),
			),
			array(
				'id'     => 'runtime-action-editor',
				'target' => array( 'kind' => 'runtime-action' ),
				'input'  => array( 'type' => 'editor_open', 'target' => 'post-new', 'post_type' => 'page' ),
			),
			array(
				'id'     => 'runtime-action-admin-page',
				'target' => array( 'kind' => 'runtime-action' ),
				'input'  => array( 'type' => 'admin_page', 'path' => 'plugins.php' ),
			),
			array(
				'id'     => 'runtime-action-page',
				'target' => array( 'kind' => 'runtime-action' ),
				'input'  => array( 'type' => 'page', 'path' => '/sample-page/' ),
			),
			array(
				'id'     => 'runtime-action-unknown',
				'target' => array( 'kind' => 'runtime-action' ),
				'input'  => array( 'type' => 'filesystem' ),
			),
		),
	)
);

assert( is_array( $result ) );
assert( 'wp-codebox/fuzz-suite-result/v1' === $result['schema'] );
assert( true === $result['success'] );
assert( 'passed' === $result['status'] );
assert( 18 === $result['summary']['total'] );
assert( 7 === $result['summary']['passed'] );
assert( 11 === $result['summary']['skipped'] );
assert( 'collect-artifact' === $result['cases'][0]['id'] );
assert( 'passed' === $result['cases'][0]['status'] );
assert( 'php-smoke/report.json' === $result['artifactRefs'][0]['path'] );
assert( 'wp_codebox_fuzz_step_unsupported' === $result['cases'][1]['diagnostics'][0]['code'] );
assert( 'runtime-action-rest' === $result['cases'][2]['id'] );
assert( 'passed' === $result['cases'][2]['status'] );
assert( 'wordpress.rest-request' === $result['cases'][2]['metadata']['observations'][0]['command'] );
assert( 'passed' === $result['cases'][3]['status'] );
assert( 'passed' === $result['cases'][4]['status'] );
assert( 'rest-route-inventory' === $result['cases'][4]['id'] );
assert( 1 === $result['cases'][4]['metadata']['observations'][0]['route_count'] );
assert( 'sample' === $result['cases'][4]['metadata']['observations'][0]['namespaces'][0] );
assert( 'passed' === $result['cases'][5]['status'] );
assert( 'admin-page-coverage' === $result['cases'][5]['id'] );
assert( 3 === $result['cases'][5]['metadata']['observations'][0]['target_count'] );
assert( 1 === $result['cases'][5]['metadata']['observations'][0]['skipped_count'] );
assert( 'wp-codebox/wordpress-admin-page-coverage/v1' === $result['cases'][5]['metadata']['observations'][0]['payload']['schema'] );
assert( 'https://example.test/wp-admin/edit.php?post_type=product' === $result['cases'][5]['metadata']['observations'][0]['payload']['targets'][1]['canonicalUrl'] );
assert( 'passed' === $result['cases'][6]['status'] );
assert( 'passed' === $result['cases'][7]['status'] );
assert( 'command-target' === $result['cases'][8]['id'] );
assert( 'wp_codebox_fuzz_target_command_unsupported' === $result['cases'][8]['skipReason'] );
assert( 'runtime-target' === $result['cases'][9]['id'] );
assert( 'wp_codebox_fuzz_target_command_unsupported' === $result['cases'][9]['skipReason'] );
assert( 'runtime-action-wp-cli' === $result['cases'][10]['id'] );
assert( 'wp_codebox_fuzz_runtime_action_wp_cli_unsupported' === $result['cases'][10]['skipReason'] );
assert( 'wordpress.wp-cli' === $result['cases'][10]['metadata']['observations'][0]['command'] );
assert( 'wp_codebox_fuzz_runtime_action_php_unsupported' === $result['cases'][11]['skipReason'] );
assert( 'wp_codebox_fuzz_runtime_action_browser_unsupported' === $result['cases'][12]['skipReason'] );
assert( 'wp_codebox_fuzz_runtime_action_browser_probe_unsupported' === $result['cases'][13]['skipReason'] );
assert( 'wp_codebox_fuzz_runtime_action_editor_open_unsupported' === $result['cases'][14]['skipReason'] );
assert( 'wp_codebox_fuzz_runtime_action_admin_page_unsupported' === $result['cases'][15]['skipReason'] );
assert( 'wp_codebox_fuzz_runtime_action_page_unsupported' === $result['cases'][16]['skipReason'] );
assert( 'wp_codebox_fuzz_runtime_action_unsupported' === $result['cases'][17]['skipReason'] );

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
