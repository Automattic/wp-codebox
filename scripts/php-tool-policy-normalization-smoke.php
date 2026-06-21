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
require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-agent-workload.php';
require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-runtime-tool-policy-descriptor.php';
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
assert_same( 'wp-codebox/tool-bridge/v1', $task_input['tool_bridge']['schema'], 'tool bridge schema' );
assert_same( 'wp-codebox/host-tool-policy/v1', $task_input['tool_bridge']['host_policy']['schema'], 'host policy schema' );
assert_same( 'filesystem-write', $task_input['tool_bridge']['host_policy']['tools'][0]['id'], 'host policy tool id' );
assert_same( 'filesystem_write', $task_input['tool_bridge']['host_policy']['tools'][0]['runtime_tool_id'], 'host policy runtime tool id' );
assert_same( 'wp_codebox_browser_runtime_tool_callback', $task_input['tool_bridge']['dispatcher']['callback'], 'tool bridge dispatcher callback' );
assert_same( 'allowlist', $task_input['tool_bridge']['authorization']['mode'], 'tool bridge authorization mode' );
assert_same( 'wp-codebox/sandbox-tool-policy/v1', $task_input['tool_bridge']['sandbox_tool_policy']['schema'], 'tool bridge carries policy' );

$validator = new WP_Codebox_Host_Tool_Policy_Validator();
assert_same( null, $validator->validate_task_tools( $task_input ), 'validator accepts normalized semantic policy' );
assert_same( null, $validator->validate_allowed_tools( array( 'filesystem_write' ), $task_input ), 'validator accepts generated runtime tool id alias' );

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
assert_same( null, $validator->validate_allowed_tools( array( 'custom_filesystem_write' ), $explicit_policy ), 'validator accepts explicit runtime tool id alias' );

$bridge_policy = ( new WP_Codebox_Sandbox_Tool_Policy_Normalizer() )->tool_bridge_from_allowed_tools( array( 'filesystem-write' ) );
$bridge_task_input = WP_Codebox_Agent_Task::normalize_input(
	array(
		'goal'          => 'Create a page',
		'allowed_tools' => array( 'filesystem-write' ),
		'tool_bridge'   => $bridge_policy,
	)
);
assert_not_error( $bridge_task_input, 'explicit tool bridge normalizes' );
assert_same( 'filesystem_write', $bridge_task_input['sandbox_tool_policy']['tools'][0]['runtime_tool_id'], 'explicit tool bridge policy selected' );

$descriptor_policy = array(
	'schema'  => 'wp-codebox/sandbox-tool-policy/v1',
	'version' => 1,
	'tools'   => array(
		array(
			'id'                   => 'filesystem-write',
			'runtime_tool_id'      => 'client/filesystem-write',
			'aliases'              => array( 'filesystem_write' ),
			'execution_location'   => 'sandbox',
			'transport_visibility' => 'sandbox',
			'allowed'              => true,
			'runtime'              => array(
				'environment'      => 'runtime_local',
				'capability_scope' => 'runtime_local',
			),
			'metadata'             => array(
				'aliases' => array( 'write_file' ),
				'schema'  => 'example/input/v1',
				'policy'  => array( 'permission' => 'write' ),
			),
		),
		array(
			'id'                   => 'browser-review',
			'runtime_tool_id'      => 'client/browser-review',
			'execution_location'   => 'parent',
			'transport_visibility' => 'parent',
			'allowed'              => true,
			'runtime'              => array(
				'environment'      => 'control_plane',
				'capability_scope' => 'control_plane',
			),
		),
		array(
			'id'                   => 'internal-token',
			'runtime_tool_id'      => 'client/internal-token',
			'execution_location'   => 'sandbox',
			'transport_visibility' => 'hidden',
			'allowed'              => true,
			'runtime'              => array(
				'environment'      => 'runtime_local',
				'capability_scope' => 'runtime_local',
			),
		),
	),
	'metadata' => array( 'source' => 'php-tool-policy-normalization-smoke' ),
);

$resolver = new WP_Codebox_Runtime_Tool_Policy_Descriptor();
$effective = $resolver->resolve_effective_runtime_tool_policy( $descriptor_policy );
assert_same( array( 'client/filesystem-write' ), $effective['allowedRuntimeToolIds'], 'effective allowed runtime ids match runtime-core' );
assert_same( array( 'client/filesystem-write' ), $effective['visibleRuntimeToolIds'], 'effective visible runtime ids match runtime-core' );
assert_same( array( 'client/browser-review' ), $effective['parentOnlyRuntimeToolIds'], 'effective parent runtime ids match runtime-core' );
assert_same( array( 'client/internal-token' ), $effective['hiddenRuntimeToolIds'], 'effective hidden runtime ids match runtime-core' );
assert_same( 'client/filesystem-write', $resolver->resolve_runtime_tool_alias( $descriptor_policy, 'write_file' )['runtimeToolId'], 'metadata alias resolves' );
assert_same( 'example/input/v1', $resolver->resolve_runtime_tool_alias( $descriptor_policy, 'filesystem_write' )['schema'], 'metadata schema mirrors descriptor' );
assert_same( array( 'permission' => 'write' ), $resolver->resolve_runtime_tool_alias( $descriptor_policy, 'filesystem_write' )['policy'], 'metadata policy mirrors descriptor' );
assert_same( 'parent-only', $resolver->denial_reason( $resolver->resolve_runtime_tool_alias( $descriptor_policy, 'client/browser-review' ) ), 'parent-only tool denied by descriptor' );
assert_same( 'hidden', $resolver->denial_reason( $resolver->resolve_runtime_tool_alias( $descriptor_policy, 'client/internal-token' ) ), 'hidden tool denied by descriptor' );

fwrite( STDOUT, "PHP tool policy normalization smoke passed\n" );
