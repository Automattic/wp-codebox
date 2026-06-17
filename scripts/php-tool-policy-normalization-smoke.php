<?php

define( 'ABSPATH', __DIR__ );

final class WP_Error {
	private string $code;
	/** @var array<string,mixed> */
	private array $data;

	/** @param array<string,mixed> $data */
	public function __construct( string $code = '', string $message = '', array $data = array() ) {
		unset( $message );
		$this->code = $code;
		$this->data = $data;
	}

	public function get_error_code(): string {
		return $this->code;
	}

	/** @return array<string,mixed> */
	public function get_error_data(): array {
		return $this->data;
	}
}

function is_wp_error( mixed $value ): bool {
	return $value instanceof WP_Error;
}

require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-task-input-contract.php';
require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-sandbox-tool-policy-normalizer.php';
require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-agent-task.php';
require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-host-tool-policy-validator.php';

function assert_same( mixed $expected, mixed $actual, string $label ): void {
	if ( $expected !== $actual ) {
		fwrite( STDERR, $label . ' failed: expected ' . var_export( $expected, true ) . ', got ' . var_export( $actual, true ) . PHP_EOL );
		exit( 1 );
	}
}

function assert_not_error( mixed $actual, string $label ): void {
	if ( is_wp_error( $actual ) ) {
		fwrite( STDERR, $label . ' failed: unexpected WP_Error ' . $actual->get_error_code() . PHP_EOL );
		exit( 1 );
	}
}

$task_input = WP_Codebox_Agent_Task::normalize_input(
	array(
		'goal'          => 'Create a page',
		'allowed_tools' => array( 'filesystem-write' ),
	)
);

assert_not_error( $task_input, 'semantic allowed tool normalizes' );
assert_same( 'wp-codebox/sandbox-tool-policy/v1', $task_input['sandbox_tool_policy']['schema'], 'policy schema' );
assert_same( 'filesystem-write', $task_input['sandbox_tool_policy']['tools'][0]['id'], 'semantic policy id' );
assert_same( 'filesystem_write', $task_input['sandbox_tool_policy']['tools'][0]['runtime_tool_id'], 'provider-safe runtime tool id' );
assert_same( 'runtime_local', $task_input['sandbox_tool_policy']['tools'][0]['runtime']['environment'], 'runtime environment' );
assert_same( 'runtime_local', $task_input['sandbox_tool_policy']['tools'][0]['runtime']['capability_scope'], 'runtime scope' );

$validator = new WP_Codebox_Host_Tool_Policy_Validator();
assert_same( null, $validator->validate_task_tools( $task_input ), 'validator accepts normalized semantic policy' );

$explicit_policy = WP_Codebox_Agent_Task::normalize_input(
	array(
		'goal'                => 'Create a page',
		'allowed_tools'       => array( 'filesystem-write' ),
		'sandbox_tool_policy' => array(
			'schema'  => 'wp-codebox/sandbox-tool-policy/v1',
			'version' => 1,
			'tools'   => array(
				array(
					'id'                   => 'filesystem-write',
					'runtime_tool_id'      => 'custom_filesystem_write',
					'execution_location'   => 'sandbox',
					'transport_visibility' => 'sandbox',
					'allowed'              => true,
					'runtime'              => array(
						'environment'      => 'runtime_local',
						'capability_scope' => 'runtime_local',
					),
				),
			),
		),
	)
);

assert_not_error( $explicit_policy, 'explicit policy remains accepted' );
assert_same( 'custom_filesystem_write', $explicit_policy['sandbox_tool_policy']['tools'][0]['runtime_tool_id'], 'explicit runtime id preserved' );

fwrite( STDOUT, "PHP tool policy normalization smoke passed\n" );
