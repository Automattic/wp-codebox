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

function add_filter( string $hook, callable $callback, int $priority = 10, int $accepted_args = 1 ): void {
	$GLOBALS['wp_codebox_test_filters'][ $hook ][ $priority ][] = array( $callback, $accepted_args );
}

function apply_filters( string $hook, mixed $value, mixed ...$args ): mixed {
	foreach ( $GLOBALS['wp_codebox_test_filters'][ $hook ] ?? array() as $filters ) {
		foreach ( $filters as $filter ) {
			$value = $filter[0]( $value, ...array_slice( $args, 0, (int) $filter[1] - 1 ) );
		}
	}
	return $value;
}

function wp_parse_url( string $url, int $component = -1 ): mixed {
	return -1 === $component ? parse_url( $url ) : parse_url( $url, $component );
}

function home_url( string $path = '/' ): string {
	return 'https://example.test' . ( str_starts_with( $path, '/' ) ? $path : '/' . $path );
}

function wp_remote_request( string $url, array $args = array() ): array|WP_Error {
	$preempt = apply_filters( 'pre_http_request', false, $args, $url );
	if ( false !== $preempt ) {
		return $preempt;
	}
	return array( 'status' => 200, 'body' => 'ok' );
}

function wp_remote_get( string $url, array $args = array() ): array|WP_Error {
	return wp_remote_request( $url, array_merge( $args, array( 'method' => 'GET' ) ) );
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

require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-wordpress-runtime-primitives.php';
require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-wordpress-workload-runner.php';
require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-agents-api-adapter.php';
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

$php_workload_path = tempnam( sys_get_temp_dir(), 'wp-codebox-workload-' );
assert( is_string( $php_workload_path ) );
file_put_contents(
	$php_workload_path,
	<<<'PHP'
<?php
return static function ( array $input, array $args ): array {
	return array(
		'status' => 'passed',
		'observation' => array(
			'input_schema' => $input['schema'] ?? '',
			'arg_type' => $args['type'] ?? '',
		),
		'artifactRefs' => array(
			array( 'name' => 'php-report', 'path' => 'workload/php-report.json' ),
		),
	);
};
PHP
);

$php_result = WP_Codebox_WordPress_Workload_Runner_Smoke::run_wordpress_workload(
	array(
		'schema' => 'wp-codebox/wordpress-workload-run/v1',
		'steps'  => array(
			array( 'command' => 'wordpress.run-workload', 'args' => array( 'type=php', 'path=' . $php_workload_path ) ),
			array( 'command' => 'wordpress.collect-workload-result', 'args' => array( 'artifact=php-report' ) ),
		),
	)
);

assert( is_array( $php_result ) );
assert( true === $php_result['success'] );
assert( 'completed' === $php_result['status'] );
assert( 'passed' === $php_result['steps'][0]['status'] );
assert( 'wp-codebox/wordpress-workload-run/v1' === $php_result['steps'][0]['observation']['input_schema'] );
assert( 'php' === $php_result['steps'][0]['observation']['arg_type'] );
assert( 'workload/php-report.json' === $php_result['artifacts'][0]['path'] );
assert( 'wp-codebox/wordpress-workload-result-collection/v1' === $php_result['steps'][1]['observation']['payload']['schema'] );
assert( 1 === $php_result['steps'][1]['observation']['payload']['summary']['steps'] );
assert( 'workload/php-report.json' === $php_result['steps'][1]['observation']['payload']['artifactRefs'][0]['path'] );
@unlink( $php_workload_path );

$missing_collection_result = WP_Codebox_WordPress_Workload_Runner_Smoke::run_wordpress_workload(
	array(
		'schema' => 'wp-codebox/wordpress-workload-run/v1',
		'steps'  => array(
			array( 'command' => 'wordpress.collect-workload-result', 'args' => array( 'artifact=missing-rest-db-query-profile' ) ),
		),
	)
);

assert( is_array( $missing_collection_result ) );
assert( false === $missing_collection_result['success'] );
assert( 'failed' === $missing_collection_result['status'] );
assert( 'failed' === $missing_collection_result['steps'][0]['status'] );
assert( 'wp_codebox_workload_result_artifact_missing' === $missing_collection_result['steps'][0]['diagnostics'][0]['code'] );

$guardrail_workload_path = tempnam( sys_get_temp_dir(), 'wp-codebox-guardrail-' );
assert( is_string( $guardrail_workload_path ) );
file_put_contents(
	$guardrail_workload_path,
	<<<'PHP'
<?php
return static function (): array {
	$blocked = wp_remote_get( 'https://blocked-service.invalid/path?token=secret-value&_wpnonce=nonce-value', array( 'headers' => array( 'Authorization' => 'Bearer secret', 'X-WP-Nonce' => 'nonce-value', 'X-Public' => 'visible' ) ) );
	$guardrail = wp_codebox_bench_run_external_http_guardrail_step( array( 'action' => 'collect' ) );
	return array(
		'status' => $blocked instanceof WP_Error ? 'passed' : 'failed',
		'artifactRefs' => array(
			array( 'name' => 'external-http-guardrail', 'path' => 'workload/guardrail.json', 'payload' => $guardrail ),
		),
	);
};
PHP
);

$guardrail_result = WP_Codebox_WordPress_Workload_Runner_Smoke::run_wordpress_workload(
	array(
		'schema'   => 'wp-codebox/wordpress-workload-run/v1',
		'steps'    => array(
			array( 'command' => 'wordpress.ensure-external-http-guardrail', 'args' => array( 'allowlist=allowed-service.invalid', 'block_network=true' ) ),
			array( 'command' => 'wordpress.run-workload', 'args' => array( 'type=php', 'path=' . $guardrail_workload_path ) ),
			array( 'command' => 'wordpress.collect-workload-result', 'args' => array( 'artifact=external-http-guardrail', 'command=wordpress.run-workload' ) ),
		),
	)
);

assert( is_array( $guardrail_result ) );
assert( true === $guardrail_result['success'] );
$blocked_request = $guardrail_result['steps'][2]['observation']['payload']['artifactRefs'][0]['payload']['requests'][0];
assert( 'blocked' === $blocked_request['classification'] );
assert( str_contains( $blocked_request['url'], 'token=[redacted]' ) );
assert( str_contains( $blocked_request['url'], '_wpnonce=[redacted]' ) );
assert( '[redacted]' === $blocked_request['headers']['Authorization'] );
assert( '[redacted]' === $blocked_request['headers']['X-WP-Nonce'] );
assert( 'visible' === $blocked_request['headers']['X-Public'] );
assert( 'wp-codebox/wordpress-workload-result-collection/v1' === $guardrail_result['steps'][2]['observation']['payload']['schema'] );
@unlink( $guardrail_workload_path );

$not_callable_path = tempnam( sys_get_temp_dir(), 'wp-codebox-workload-' );
assert( is_string( $not_callable_path ) );
file_put_contents( $not_callable_path, "<?php\nreturn array();\n" );
$not_callable = WP_Codebox_WordPress_Workload_Runner_Smoke::run_wordpress_workload(
	array(
		'schema' => 'wp-codebox/wordpress-workload-run/v1',
		'steps'  => array(
			array( 'command' => 'wordpress.run-workload', 'args' => array( 'type=php', 'path=' . $not_callable_path ) ),
		),
	)
);

assert( is_array( $not_callable ) );
assert( false === $not_callable['success'] );
assert( 'failed' === $not_callable['status'] );
assert( 'wp_codebox_wordpress_workload_php_not_callable' === $not_callable['diagnostics'][0]['code'] );
@unlink( $not_callable_path );

$package_root = sys_get_temp_dir() . '/wp-codebox-workload-package-' . bin2hex( random_bytes( 4 ) );
mkdir( $package_root );
$package_workload = $package_root . '/bench.php';
file_put_contents( $package_workload, "<?php\nreturn static function (): array { return array( 'status' => 'passed' ); };\n" );
$package_workload_real = realpath( $package_workload );
assert( is_string( $package_workload_real ) );
$stage_method = new ReflectionMethod( WP_Codebox_Agents_API_Adapter::class, 'stage_runtime_package_wordpress_workload_files' );
$staged_input = $stage_method->invoke(
	null,
	array(
		'package' => array( 'source' => $package_root ),
		'input'   => array(
			'schema' => 'wp-codebox/wordpress-workload-run/v1',
			'steps'  => array(
				array( 'command' => 'wordpress.run-workload', 'args' => array( 'type=php', 'path=${package.root}/bench.php' ) ),
			),
		),
	)
);

assert( is_array( $staged_input ) );
assert( str_starts_with( $staged_input['input']['steps'][0]['args'][1], 'path=/tmp/wp-codebox-workloads/' ) );
assert( $package_workload_real === $staged_input['input']['staged_files'][0]['source'] );
assert( 'wordpress-php-workload' === $staged_input['input']['staged_files'][0]['metadata']['kind'] );
@unlink( $package_workload );
@rmdir( $package_root );

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
