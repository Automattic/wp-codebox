<?php
declare(strict_types=1);

define( 'ABSPATH', __DIR__ );

$GLOBALS['wp_codebox_test_filters'] = array();

function is_wp_error( mixed $value ): bool {
	return $value instanceof WP_Error;
}

function add_filter( string $hook, callable $callback, int $priority = 10, int $accepted_args = 1 ): void {
	$GLOBALS['wp_codebox_test_filters'][ $hook ][ $priority ][] = array( $callback, $accepted_args );
}

function remove_all_filters( string $hook ): void {
	unset( $GLOBALS['wp_codebox_test_filters'][ $hook ] );
}

function apply_filters( string $hook, mixed $value, mixed ...$args ): mixed {
	if ( empty( $GLOBALS['wp_codebox_test_filters'][ $hook ] ) ) {
		return $value;
	}

	ksort( $GLOBALS['wp_codebox_test_filters'][ $hook ] );
	foreach ( $GLOBALS['wp_codebox_test_filters'][ $hook ] as $callbacks ) {
		foreach ( $callbacks as [ $callback, $accepted_args ] ) {
			$value = $callback( ...array_slice( array_merge( array( $value ), $args ), 0, $accepted_args ) );
		}
	}

	return $value;
}

final class WP_Error {
	public function __construct( private string $code, private string $message, private array $data = array() ) {}
	public function get_error_code(): string { return $this->code; }
	public function get_error_message(): string { return $this->message; }
	public function get_error_data(): array { return $this->data; }
}

final class WP_Codebox_Abilities {
	/** @param array<string,mixed> $input @return array<string,mixed> */
	public static function run_agent_task( array $input ): array {
		return array(
			'success' => true,
			'schema'  => 'wp-codebox/agent-task-run/v1',
			'status'  => 'completed',
			'task'    => $input['goal'] ?? '',
		);
	}

	/** @param array<string,mixed> $input @return array<string,mixed> */
	public static function create_browser_task_contract( array $input ): array {
		return array(
			'success' => true,
			'schema'  => 'wp-codebox/browser-task-contract/v1',
			'status'  => 'ready',
			'task'    => $input['goal'] ?? '',
		);
	}
}

require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-runtime-task-runner.php';

function assert_same_contract( mixed $expected, mixed $actual, string $label ): void {
	if ( $expected !== $actual ) {
		fwrite( STDERR, $label . " failed. Expected: " . json_encode( $expected ) . " Actual: " . json_encode( $actual ) . "\n" );
		exit( 1 );
	}
}

$runner = new WP_Codebox_Runtime_Task_Runner();

$missing_task = $runner->run( array( 'schema' => 'wp-codebox/runtime-task-request/v1' ) );
assert_same_contract( true, is_wp_error( $missing_task ), 'missing task returns error' );
assert_same_contract( 'wp-codebox/runtime-task-error/v1', $missing_task->get_error_data()['schema'] ?? null, 'missing task error schema' );

add_filter(
	'wp_codebox_runtime_task_providers',
	static function ( array $providers ): array {
		array_unshift(
			$providers,
			array(
				'id'       => 'example-runtime',
				'matches'  => static fn( array $input ): bool => 'example-runtime' === ( $input['target_id'] ?? '' ),
				'callback' => static function ( array $input ): array {
					return array(
						'success' => true,
						'status'  => 'completed',
						'public'  => array(
							'run_id' => 'run-1',
							'echo'   => $input,
						),
						'private' => array(
							'token' => 'secret-token',
						),
					);
				},
			)
		);

		return $providers;
	},
	10,
	1
);

$provided = $runner->run(
	array(
		'schema'    => 'wp-codebox/runtime-task-request/v1',
		'task'      => 'Ship it',
		'target_id' => 'example-runtime',
	)
);
assert_same_contract( 'wp-codebox/runtime-task-result/v1', $provided['schema'] ?? null, 'provider result schema' );
assert_same_contract( 'example-runtime', $provided['execution'] ?? null, 'provider execution label' );
assert_same_contract( 'wp-codebox/runtime-task-request/v1', $provided['result']['echo']['schema'] ?? null, 'provider receives public schema unchanged' );
assert_same_contract( 'run-1', $provided['upstream_refs']['run_id'] ?? null, 'provider run id preserved' );
assert_same_contract( false, str_contains( json_encode( $provided ), 'secret-token' ), 'private provider result omitted' );

remove_all_filters( 'wp_codebox_runtime_task_providers' );
$fallback = $runner->run(
	array(
		'schema'    => 'wp-codebox/runtime-task-request/v1',
		'task'      => 'Prepare browser',
		'target_id' => 'wp-codebox/browser-playground',
	)
);
assert_same_contract( 'wp-codebox/runtime-task-result/v1', $fallback['schema'] ?? null, 'fallback result schema' );
assert_same_contract( 'wp-codebox-runtime', $fallback['execution'] ?? null, 'fallback execution label' );
assert_same_contract( 'wp-codebox/browser-task-contract/v1', $fallback['result']['schema'] ?? null, 'fallback uses browser target' );

add_filter(
	'wp_codebox_runtime_task_providers',
	static fn( array $providers ): array => array(
		array(
			'id'       => 'example-runtime',
			'callback' => static fn( array $input ): WP_Error => new WP_Error(
				'private_runtime_failure',
				'private runtime blew up',
				array(
					'status'  => 502,
					'private' => array( 'adapter' => 'secret-adapter' ),
					'public'  => array(
						'code'    => 'wp_codebox_runtime_task_failed_publicly',
						'message' => 'The selected runtime failed.',
						'status'  => 503,
					),
				)
			),
		),
	),
	10,
	1
);
$failed = $runner->run(
	array(
		'schema' => 'wp-codebox/runtime-task-request/v1',
		'task'   => 'Fail safely',
	)
);
assert_same_contract( true, is_wp_error( $failed ), 'provider failure is public error' );
assert_same_contract( 'wp_codebox_runtime_task_failed_publicly', $failed->get_error_code(), 'provider public error code' );
assert_same_contract( 'The selected runtime failed.', $failed->get_error_message(), 'provider public error message' );
assert_same_contract( 503, $failed->get_error_data()['status'] ?? null, 'provider public error status' );
assert_same_contract( false, str_contains( json_encode( $failed ), 'secret-adapter' ), 'private provider error omitted' );

fwrite( STDOUT, "PHP runtime task runner smoke passed\n" );
