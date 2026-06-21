<?php
declare(strict_types=1);

define( 'ABSPATH', __DIR__ );

$GLOBALS['wp_codebox_test_abilities'] = array();

function is_wp_error( mixed $value ): bool {
	return $value instanceof WP_Error;
}

function wp_get_ability( string $name ): ?WP_Ability {
	return $GLOBALS['wp_codebox_test_abilities'][ $name ] ?? null;
}

final class WP_Error {
	public function __construct( private string $code, private string $message, private array $data = array() ) {}
	public function get_error_code(): string { return $this->code; }
	public function get_error_message(): string { return $this->message; }
	public function get_error_data(): array { return $this->data; }
}

final class WP_Ability {
	/** @param callable(array<string,mixed>):mixed $callback */
	public function __construct( private $callback ) {}
	/** @param array<string,mixed> $input */
	public function execute( array $input ): mixed {
		return ( $this->callback )( $input );
	}
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

$GLOBALS['wp_codebox_test_abilities']['datamachine/run-runtime-task'] = new WP_Ability(
	static function ( array $input ): array {
		return array(
			'success' => true,
			'schema'  => 'datamachine/runtime-task-result/v1',
			'status'  => 'completed',
			'run_id'  => 'run-1',
			'echo'    => $input,
		);
	}
);

$upstream = $runner->run(
	array(
		'schema' => 'wp-codebox/runtime-task-request/v1',
		'task'   => 'Ship it',
	)
);
assert_same_contract( 'wp-codebox/runtime-task-result/v1', $upstream['schema'] ?? null, 'upstream result schema' );
assert_same_contract( 'runtime-task', $upstream['execution'] ?? null, 'upstream execution label' );
assert_same_contract( 'internal-runtime', $upstream['result']['schema'] ?? null, 'upstream schema sanitized' );
assert_same_contract( 'run-1', $upstream['upstream_refs']['run_id'] ?? null, 'upstream run id preserved' );

$GLOBALS['wp_codebox_test_abilities'] = array();
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

$GLOBALS['wp_codebox_test_abilities']['datamachine/run-runtime-task'] = new WP_Ability(
	static fn( array $input ): WP_Error => new WP_Error( 'datamachine_failure', 'datamachine blew up', array( 'status' => 502, 'ability' => 'datamachine/run-runtime-task' ) )
);
$failed = $runner->run(
	array(
		'schema' => 'wp-codebox/runtime-task-request/v1',
		'task'   => 'Fail safely',
	)
);
assert_same_contract( true, is_wp_error( $failed ), 'upstream failure is public error' );
assert_same_contract( 'wp_codebox_runtime_task_failed', $failed->get_error_code(), 'public error code' );
assert_same_contract( 'Runtime task execution failed.', $failed->get_error_message(), 'public error message' );
assert_same_contract( false, str_contains( json_encode( $failed->get_error_data() ), 'datamachine' ), 'public error data sanitized' );

fwrite( STDOUT, "PHP runtime task runner smoke passed\n" );
