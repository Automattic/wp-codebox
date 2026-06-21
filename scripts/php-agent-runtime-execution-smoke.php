<?php

declare(strict_types=1);

define( 'ABSPATH', __DIR__ );

final class WP_Error {
	private string $code;
	private string $message;
	private mixed $data;

	public function __construct( string $code, string $message, mixed $data = null ) {
		$this->code    = $code;
		$this->message = $message;
		$this->data    = $data;
	}

	public function get_error_code(): string {
		return $this->code;
	}

	public function get_error_message(): string {
		return $this->message;
	}

	public function get_error_data(): mixed {
		return $this->data;
	}
}

function is_wp_error( mixed $value ): bool {
	return $value instanceof WP_Error;
}

function wp_json_encode( mixed $value, int $flags = 0 ): string|false {
	return json_encode( $value, $flags );
}

function apply_filters( string $hook_name, mixed $value, mixed ...$args ): mixed {
	unset( $hook_name, $args );
	return $value;
}

function smoke_assert( bool $condition, string $message ): void {
	if ( ! $condition ) {
		fwrite( STDERR, $message . PHP_EOL );
		exit( 1 );
	}
}

$root = dirname( __DIR__ ) . '/packages/wordpress-plugin/src/';
foreach ( array(
	'class-wp-codebox-task-input-contract.php',
	'class-wp-codebox-agent-workload.php',
	'class-wp-codebox-runtime-tool-policy-descriptor.php',
	'class-wp-codebox-sandbox-tool-policy-normalizer.php',
	'class-wp-codebox-path-policy.php',
	'class-wp-codebox-agent-task.php',
	'class-wp-codebox-provider-credentials.php',
	'class-wp-codebox-runtime-dependency-plan.php',
	'class-wp-codebox-runtime-profile-resolver.php',
	'class-wp-codebox-runtime-recipe-resolver.php',
	'class-wp-codebox-browser-task-builder.php',
	'class-wp-codebox-connector-credential-resolvers.php',
	'class-wp-codebox-inheritance.php',
	'class-wp-codebox-redaction-policy.php',
	'class-wp-codebox-host-request-normalizer.php',
	'class-wp-codebox-host-tool-policy-validator.php',
	'class-wp-codebox-host-preview-args-builder.php',
	'class-wp-codebox-host-runtime-config-builder.php',
	'class-wp-codebox-agent-runtime-config-resolver.php',
	'class-wp-codebox-host-recipe-builder.php',
	'class-wp-codebox-status-taxonomy.php',
	'class-wp-codebox-host-run-result-normalizer.php',
	'class-wp-codebox-parent-site-seed-exporter.php',
	'class-wp-codebox-json.php',
	'class-wp-codebox-run-plan.php',
	'class-wp-codebox-fanout-aggregation.php',
	'class-wp-codebox-agent-process-runner.php',
	'class-wp-codebox-agent-run-result-builder.php',
	'class-wp-codebox-agent-outcome-classifier.php',
	'class-wp-codebox-agent-sandbox-runner.php',
) as $file ) {
	require_once $root . $file;
}

$prepared_base = array(
	'input'              => array( 'goal' => 'Test task', 'provider' => 'test-provider', 'model' => 'test-model' ),
	'task_input'         => array( 'goal' => 'Test task' ),
	'task'               => 'Test task',
	'session_id'         => 'session-1',
	'paths'              => array(),
	'artifacts'          => '/tmp/wp-codebox-artifacts',
	'wp_version'         => 'latest',
	'command'            => 'wp-codebox recipe-run --recipe /tmp/recipe.json --json',
	'process_secret_env' => array(),
	'timeout_seconds'    => 1,
	'recipe_file'        => '',
	'cleanup_paths'      => array(),
);

$cases = array(
	'success'      => array(
		'command_result' => array(
			'exit_code' => 0,
			'output'    => '{"agentResult":{"summary":"Changed one file","changedFiles":{"count":1},"patch":{"bytes":10}},"agentTaskResult":{"status":"succeeded"}}',
		),
		'assert'         => static function ( array $result ): void {
			smoke_assert( true === $result['success'], 'success contract succeeds' );
			smoke_assert( 'succeeded' === $result['agent_task_run_result']['status'], 'success canonical result status is succeeded' );
		},
	),
	'non_zero'     => array(
		'command_result' => array( 'exit_code' => 2, 'output' => '{"agentResult":{}}' ),
		'assert'         => static function ( array $result ): void {
			smoke_assert( false === $result['success'], 'non-zero contract fails' );
			smoke_assert( 'non_zero_exit' === $result['error']['failure_classification'], 'non-zero classification is preserved' );
		},
	),
	'timeout'      => array(
		'command_result' => array( 'exit_code' => 124, 'output' => '', 'timed_out' => true, 'timeout_seconds' => 1 ),
		'assert'         => static function ( array $result ): void {
			smoke_assert( false === $result['success'], 'timeout contract fails' );
			smoke_assert( 'timeout' === $result['agent_task_status'], 'timeout maps to agent task timeout' );
		},
	),
	'invalid_json' => array(
		'command_result' => array( 'exit_code' => 0, 'output' => 'not-json' ),
		'assert'         => static function ( array $result ): void {
			smoke_assert( false === $result['success'], 'invalid JSON contract fails' );
			smoke_assert( 'invalid_json' === $result['error']['failure_classification'], 'invalid JSON classification is preserved' );
		},
	),
);

foreach ( $cases as $name => $case ) {
	$runner = new WP_Codebox_Agent_Sandbox_Runner(
		array(
			'shell_available' => static fn(): bool => true,
			'command_runner'  => static function ( string $command, array $secret_env, int $timeout_seconds ) use ( $case, $prepared_base ): array {
				smoke_assert( $prepared_base['command'] === $command, 'prepared command is passed to command runner' );
				smoke_assert( array() === $secret_env, 'prepared secret env is passed to command runner' );
				smoke_assert( 1 === $timeout_seconds, 'prepared timeout is passed to command runner' );
				return $case['command_result'];
			},
		)
	);

	$result = $runner->run_prepared_runtime_execution( $prepared_base );
	smoke_assert( is_array( $result ) && ! is_wp_error( $result ), $name . ' returns result envelope' );
	$case['assert']( $result );
}

echo "agent runtime execution smoke passed\n";
