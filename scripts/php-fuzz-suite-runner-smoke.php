<?php
declare(strict_types=1);

$wp_codebox_smoke_root = sys_get_temp_dir() . '/wp-codebox-fuzz-smoke-' . getmypid() . '/';
mkdir( $wp_codebox_smoke_root . 'wp-admin/includes', 0777, true );
register_shutdown_function(
	static function () use ( $wp_codebox_smoke_root ): void {
		@unlink( $wp_codebox_smoke_root . 'rest-db-query-profile.workload.json' );
		@unlink( $wp_codebox_smoke_root . 'wp-admin/menu.php' );
		@unlink( $wp_codebox_smoke_root . 'wp-admin/includes/admin.php' );
		@rmdir( $wp_codebox_smoke_root . 'wp-admin/includes' );
		@rmdir( $wp_codebox_smoke_root . 'wp-admin' );
		@rmdir( $wp_codebox_smoke_root );
	}
);
file_put_contents( $wp_codebox_smoke_root . 'wp-admin/includes/admin.php', "<?php\n" );
file_put_contents(
	$wp_codebox_smoke_root . 'wp-admin/menu.php',
	"<?php\narray_keys( \$submenu );\n\$menu[2] = array( 'Loaded', 'read', 'loaded.php' );\n\$submenu['loaded.php'][0] = array( 'Loaded child', 'read', 'loaded-child.php' );\n"
);
define( 'ABSPATH', $wp_codebox_smoke_root );
define( 'WP_CONTENT_DIR', __DIR__ );
define( 'ARRAY_A', 'ARRAY_A' );

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

function get_temp_dir(): string {
	return sys_get_temp_dir();
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
	global $wpdb;
	if ( is_object( $wpdb ) && is_array( $wpdb->queries ?? null ) ) {
		$wpdb->queries[] = array( 'SELECT * FROM wp_posts WHERE post_type = "post"', 0.002, 'rest_do_request' );
		$wpdb->queries[] = array( 'SELECT option_value FROM wp_options WHERE option_name = "blogname"', 0.001, 'rest_do_request' );
	}
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
	$GLOBALS['wp_codebox_rest_server_route_contexts'][] = array(
		'wp_rest_route'  => $GLOBALS['wp']->query_vars['rest_route'] ?? null,
		'get_rest_route' => $_GET['rest_route'] ?? null,
	);
	return new WP_Codebox_Test_REST_Server();
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

class WP_Codebox_Test_WPDB {
	public string $prefix = 'wp_';
	public array $queries = array();

	public function get_results( string $query, mixed $output = null ): array {
		if ( 'SHOW TABLE STATUS' === $query ) {
			return array(
				array( 'Name' => 'wp_posts', 'Engine' => 'InnoDB', 'Rows' => 3, 'Data_length' => 100, 'Index_length' => 40, 'Collation' => 'utf8mb4_unicode_ci' ),
				array( 'Name' => 'wp_wc_orders', 'Engine' => 'InnoDB', 'Rows' => 2, 'Data_length' => 80, 'Index_length' => 20, 'Collation' => 'utf8mb4_unicode_ci' ),
			);
		}
		if ( 'DESCRIBE `wp_posts`' === $query ) {
			return array(
				array( 'Field' => 'ID', 'Type' => 'bigint unsigned', 'Null' => 'NO', 'Key' => 'PRI', 'Default' => null, 'Extra' => 'auto_increment' ),
				array( 'Field' => 'post_title', 'Type' => 'text', 'Null' => 'NO', 'Key' => '', 'Default' => null, 'Extra' => '' ),
			);
		}
		if ( 'DESCRIBE `wp_wc_orders`' === $query ) {
			return array(
				array( 'Field' => 'id', 'Type' => 'bigint unsigned', 'Null' => 'NO', 'Key' => 'PRI', 'Default' => null, 'Extra' => 'auto_increment' ),
			);
		}
		if ( 'SHOW INDEX FROM `wp_posts`' === $query ) {
			return array( array( 'Key_name' => 'PRIMARY', 'Column_name' => 'ID', 'Non_unique' => 0, 'Seq_in_index' => 1 ) );
		}
		if ( 'SHOW INDEX FROM `wp_wc_orders`' === $query ) {
			return array( array( 'Key_name' => 'PRIMARY', 'Column_name' => 'id', 'Non_unique' => 0, 'Seq_in_index' => 1 ) );
		}
		return array();
	}
}

$GLOBALS['wpdb'] = new WP_Codebox_Test_WPDB();
$GLOBALS['wp'] = (object) array( 'query_vars' => array( 'rest_route' => '/wc/store/v1/products' ) );
$_GET['rest_route'] = '/wc/store/v1/products';
$GLOBALS['wp_codebox_rest_server_route_contexts'] = array();

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

$json_workload_path = $wp_codebox_smoke_root . 'rest-db-query-profile.workload.json';
file_put_contents(
	$json_workload_path,
	wp_json_encode(
		array(
			'id'       => 'rest-db-query-profile',
			'source'   => 'config',
			'run'      => array(
				array(
					'type' => 'php',
					'code' => 'return array( "metadata" => array( "loaded" => true ) );',
				),
				array(
					'type'               => 'rest-db-query-profiler',
					'metric-prefix'      => 'rest_db_query_profile',
					'sampleLimit'        => 50,
					'queryLengthLimit'   => 500,
					'rest_request_cases' => array(
						array( 'id' => 'status', 'method' => 'GET', 'path' => '/wp/v2/status', 'params' => array( 'per_page' => 1 ) ),
					),
				),
			),
			'metadata' => array( 'runner' => 'wp-codebox', 'workload' => 'rest-db-query-profile' ),
		),
		JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES
	)
);

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
				'id'     => 'database-inventory',
				'phases' => array(
					'action' => array(
						array( 'command' => 'wordpress.inventory-database', 'args' => array( 'artifact=db_inventory' ) ),
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
			array(
				'id'        => 'json-workload-profiler',
				'phases'    => array(
					'action' => array(
						array( 'command' => 'wordpress.run-workload', 'args' => array( 'path=' . $json_workload_path ) ),
					),
				),
				'artifacts' => array(
					array( 'name' => 'workload_result', 'path' => 'workloads/rest-db-query-profile.json', 'metadata' => array( 'semantic_key' => 'fuzz.report' ) ),
				),
			),
		),
	)
);

assert( is_array( $result ) );
assert( 'wp-codebox/fuzz-suite-result/v1' === $result['schema'] );
assert( true === $result['success'] );
assert( 'passed' === $result['status'] );
assert( '/wc/store/v1/products' === $GLOBALS['wp']->query_vars['rest_route'] );
assert( '/wc/store/v1/products' === $_GET['rest_route'] );
assert( null === $GLOBALS['wp_codebox_rest_server_route_contexts'][0]['wp_rest_route'] );
assert( null === $GLOBALS['wp_codebox_rest_server_route_contexts'][0]['get_rest_route'] );
assert( 21 === $result['summary']['total'] );
assert( 10 === $result['summary']['passed'] );
assert( 11 === $result['summary']['skipped'] );
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
assert( 'passed' === $result['cases'][4]['status'] );
assert( 'passed' === $result['cases'][5]['status'] );
assert( 'rest-route-inventory' === $result['cases'][5]['id'] );
assert( 1 === $result['cases'][5]['metadata']['observations'][0]['route_count'] );
assert( 'sample' === $result['cases'][5]['metadata']['observations'][0]['namespaces'][0] );
assert( 'passed' === $result['cases'][6]['status'] );
assert( 'database-inventory' === $result['cases'][6]['id'] );
assert( 2 === $result['cases'][6]['metadata']['observations'][0]['table_count'] );
assert( 'wp-codebox/wordpress-database-inventory/v1' === $result['cases'][6]['metadata']['observations'][0]['payload']['schema'] );
assert( 'core' === $result['cases'][6]['metadata']['observations'][0]['payload']['tables'][0]['classification'] );
assert( 'prefixed' === $result['cases'][6]['metadata']['observations'][0]['payload']['tables'][1]['classification'] );
assert( 'passed' === $result['cases'][7]['status'] );
assert( 'admin-page-coverage' === $result['cases'][7]['id'] );
assert( 3 === $result['cases'][7]['metadata']['observations'][0]['target_count'] );
assert( 1 === $result['cases'][7]['metadata']['observations'][0]['skipped_count'] );
assert( 'wp-codebox/wordpress-admin-page-coverage/v1' === $result['cases'][7]['metadata']['observations'][0]['payload']['schema'] );
assert( 'https://example.test/wp-admin/edit.php?post_type=product' === $result['cases'][7]['metadata']['observations'][0]['payload']['targets'][1]['canonicalUrl'] );
assert( 'passed' === $result['cases'][8]['status'] );
assert( 'passed' === $result['cases'][9]['status'] );
assert( 'command-target' === $result['cases'][10]['id'] );
assert( 'wp_codebox_fuzz_target_command_unsupported' === $result['cases'][10]['skipReason'] );
assert( 'runtime-target' === $result['cases'][11]['id'] );
assert( 'wp_codebox_fuzz_target_command_unsupported' === $result['cases'][11]['skipReason'] );
assert( 'runtime-action-wp-cli' === $result['cases'][12]['id'] );
assert( 'wp_codebox_fuzz_runtime_action_wp_cli_unsupported' === $result['cases'][12]['skipReason'] );
assert( 'wordpress.wp-cli' === $result['cases'][12]['metadata']['observations'][0]['command'] );
assert( 'wp_codebox_fuzz_runtime_action_php_unsupported' === $result['cases'][13]['skipReason'] );
assert( 'wp_codebox_fuzz_runtime_action_browser_unsupported' === $result['cases'][14]['skipReason'] );
assert( 'wp_codebox_fuzz_runtime_action_browser_probe_unsupported' === $result['cases'][15]['skipReason'] );
assert( 'wp_codebox_fuzz_runtime_action_editor_open_unsupported' === $result['cases'][16]['skipReason'] );
assert( 'wp_codebox_fuzz_runtime_action_admin_page_unsupported' === $result['cases'][17]['skipReason'] );
assert( 'wp_codebox_fuzz_runtime_action_page_unsupported' === $result['cases'][18]['skipReason'] );
assert( 'wp_codebox_fuzz_runtime_action_unsupported' === $result['cases'][19]['skipReason'] );
assert( 'json-workload-profiler' === $result['cases'][20]['id'] );
assert( 'passed' === $result['cases'][20]['status'] );
assert( 'workloads/rest-db-query-profile.json' === $result['cases'][20]['metadata']['observations'][0]['artifact'] );
assert( 'array' !== ( $result['cases'][20]['metadata']['observations'][0]['return_type'] ?? null ) );
assert( is_file( WP_CONTENT_DIR . '/uploads/workloads/rest-db-query-profile.json' ) );
$workload_report = json_decode( file_get_contents( WP_CONTENT_DIR . '/uploads/workloads/rest-db-query-profile.json' ), true );
assert( 'wp-codebox/json-workload-result/v1' === $workload_report['schema'] );
assert( 2 === $workload_report['steps'][1]['observation']['queryCount'] );
assert( 2 === $workload_report['steps'][1]['requests'][0]['queryCount'] );
assert( 'SELECT * FROM wp_posts WHERE post_type = "post"' === $workload_report['steps'][1]['requests'][0]['sampledQueries'][0]['sql'] );

$GLOBALS['menu'] = null;
$GLOBALS['submenu'] = null;
$admin_menu_result = WP_Codebox_Fuzz_Suite_Runner_Smoke::run_fuzz_suite(
	array(
		'schema' => 'wp-codebox/fuzz-suite/v1',
		'id'     => 'admin-menu-global-suite',
		'cases'  => array(
			array(
				'id'     => 'admin-menu-global-bindings',
				'phases' => array(
					'action' => array(
						array( 'command' => 'wordpress.fuzz-admin-pages', 'args' => array( 'max_pages=2' ) ),
					),
				),
			),
		),
	)
);
assert( true === $admin_menu_result['success'] );
assert( 'passed' === $admin_menu_result['cases'][0]['status'] );
assert( 2 === $admin_menu_result['cases'][0]['metadata']['observations'][0]['target_count'] );
assert( 'loaded.php' === $admin_menu_result['cases'][0]['metadata']['observations'][0]['payload']['targets'][0]['menuSlug'] );

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
