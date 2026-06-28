<?php
declare(strict_types=1);

define( 'ABSPATH', __DIR__ );

$GLOBALS['wp_codebox_test_abilities'] = array();
$GLOBALS['wp_codebox_test_filters']   = array();

function apply_filters( string $hook_name, mixed $value, mixed ...$args ): mixed {
	unset( $args );
	return array_key_exists( $hook_name, $GLOBALS['wp_codebox_test_filters'] ) ? $GLOBALS['wp_codebox_test_filters'][ $hook_name ] : $value;
}

function is_wp_error( mixed $value ): bool {
	return $value instanceof WP_Error;
}

function wp_get_ability( string $name ): ?WP_Ability {
	return $GLOBALS['wp_codebox_test_abilities'][ $name ] ?? null;
}

function sanitize_key( string $key ): string {
	return strtolower( preg_replace( '/[^a-zA-Z0-9_\-]/', '', $key ) ?? '' );
}

final class WP_Error {
	public function __construct( private string $code, private string $message, private array $data = array() ) {}
	public function get_error_code(): string { return $this->code; }
	public function get_error_message(): string { return $this->message; }
	public function get_error_data(): array { return $this->data; }
}

final class WP_Ability {
	/** @var array<string,mixed> */
	public array $last_input = array();
	/** @param array<string,mixed> $result */
	public function __construct( private array $result = array( 'success' => true ) ) {}
	/** @param array<string,mixed> $input @return array<string,mixed> */
	public function execute( array $input ): array {
		$this->last_input = $input;
		return array_merge( $this->result, array( 'received' => $input ) );
	}
}

require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-runtime-provider-registry.php';
require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-agents-api-adapter.php';

function assert_no_agents_api_schema_leaks( mixed $value, string $path = '$' ): void {
	if ( is_string( $value ) && ( preg_match( '#^agents-api(?:[./][A-Za-z0-9_-]+)*/v[0-9]+$#', $value ) || preg_match( '#^agents-api\.[A-Za-z0-9_.-]+$#', $value ) ) ) {
		fwrite( STDERR, "Raw Agents API schema leaked at {$path}: {$value}\n" );
		exit( 1 );
	}

	if ( ! is_array( $value ) ) {
		return;
	}

	foreach ( $value as $key => $item ) {
		assert_no_agents_api_schema_leaks( $item, $path . '.' . (string) $key );
	}
}

$names = WP_Codebox_Agents_API_Adapter::ability_names();
assert( 'agents/chat' === $names['chat'] );
assert( 'agents/run-task' === $names['run_task'] );
assert( 'agents/run-runtime-package' === $names['run_runtime_package'] );
assert( 'agents/get-task-run' === $names['get_task_run'] );
assert( 'agents/get-chat-run' === $names['get_chat_run'] );

$default_invocation = WP_Codebox_Agents_API_Adapter::browser_runtime_default_invocation();
assert( array( 'type' => 'ability', 'name' => 'agents/chat' ) === $default_invocation );

$runtime_task_invocation = WP_Codebox_Agents_API_Adapter::browser_runtime_default_invocation(
	array(
		'runtime_task' => array(
			'kind'    => 'bundle',
			'ability' => 'runtime-package/run',
			'input'   => array(
				'package'  => array( 'slug' => 'example-agent' ),
				'workflow' => array( 'id' => 'example-artifact-flow' ),
			),
		),
	)
);
assert( array( 'type' => 'ability', 'name' => 'agents/run-runtime-package' ) === $runtime_task_invocation );

$adapter = new WP_Codebox_Agents_API_Adapter();
assert( false === $adapter->is_available( WP_Codebox_Agents_API_Adapter::default_chat_ability() ) );

WP_Codebox_Agents_API_Adapter::register_runtime_provider();
$early_providers = WP_Codebox_Runtime_Provider_Registry::providers();
assert( isset( $early_providers['agents-api-adapter'] ) );
assert( 'codebox-agent-runtime' === $early_providers['agents-api-adapter']['id'] );
assert( 'Codebox agent runtime' === $early_providers['agents-api-adapter']['label'] );
assert( 'runtime-profile' === $early_providers['agents-api-adapter']['kind'] );
assert( array( 'codebox.runtime-package' ) === $early_providers['agents-api-adapter']['capabilities'] );
assert( 'agents-api-adapter' === WP_Codebox_Runtime_Provider_Registry::default_provider() );
$early_runtime_package = WP_Codebox_Runtime_Provider_Registry::invoke( array( 'package' => array( 'id' => 'example' ) ) );
assert( is_wp_error( $early_runtime_package ) );
assert( 'wp_codebox_agents_api_ability_unavailable' === $early_runtime_package->get_error_code() );

$GLOBALS['wp_codebox_test_abilities'][ $names['chat'] ]                = new WP_Ability( array( 'schema' => 'agents-api/chat-result/v1', 'raw' => array( 'schema' => 'agents-api.chat-result' ) ) );
$GLOBALS['wp_codebox_test_abilities'][ $names['run_task'] ]            = new WP_Ability( array( 'schema' => 'agents-api/task-result/v1' ) );
$GLOBALS['wp_codebox_test_abilities'][ $names['run_runtime_package'] ] = new WP_Ability( array( 'schema' => 'agents-api/runtime-package-result/v1', 'outputs' => array( 'summary' => 'ok' ), 'artifacts' => array( array( 'name' => 'report', 'type' => 'markdown' ) ) ) );
$GLOBALS['wp_codebox_test_abilities'][ $names['get_task_run'] ]        = new WP_Ability( array( 'status' => 'running' ) );
$GLOBALS['wp_codebox_test_abilities'][ $names['get_chat_run'] ]        = new WP_Ability( array( 'status' => 'running' ) );

assert( true === $adapter->is_available( WP_Codebox_Agents_API_Adapter::default_chat_ability() ) );
$chat = $adapter->chat( array( 'message' => 'hello' ) );
$task = $adapter->run_task( array( 'goal' => 'ship' ) );
$package = $adapter->run_runtime_package( array( 'runtime_package' => 'example-agent' ) );
assert( 'wp-codebox/agent-chat-result/v1' === $chat['schema'] );
assert( 'wp-codebox/agent-task-result/v1' === $task['schema'] );
assert( 'wp-codebox/runtime-package-result/v1' === $package['schema'] );
assert( 'success' === $package['status'] );
assert( true === $package['success'] );
assert( array( 'summary' => 'ok' ) === $package['outputs'] );
assert( array( 'name' => 'report', 'type' => 'markdown' ) === $package['artifacts'][0] );
assert( array( 'slug' => 'example-agent' ) === $GLOBALS['wp_codebox_test_abilities'][ $names['run_runtime_package'] ]->last_input['package'] );
assert( array( 'id' => 'example-agent' ) === $GLOBALS['wp_codebox_test_abilities'][ $names['run_runtime_package'] ]->last_input['workflow'] );

$package_with_contract_task = $adapter->run_runtime_package(
	array(
		'schema'                => 'wp-codebox/runtime-package-task/v1',
		'package'               => array( 'slug' => 'example-agent', 'source' => 'bundles/example-agent' ),
		'input'                 => array( 'prompt' => 'typed output' ),
		'artifact_declarations' => array(
			array( 'name' => 'report', 'type' => 'markdown', 'required' => true ),
		),
		'task_input'            => array(
			'client_context' => array(
				'default_workspace' => array( 'target' => sys_get_temp_dir() ),
			),
		),
	)
);
assert( ! isset( $package_with_contract_task['received']['schema'] ) );
assert( array( 'report' ) === $GLOBALS['wp_codebox_test_abilities'][ $names['run_runtime_package'] ]->last_input['required_artifacts'] );
assert( array( 'id' => 'example-agent' ) === $GLOBALS['wp_codebox_test_abilities'][ $names['run_runtime_package'] ]->last_input['workflow'] );

$package_with_absolute_runtime_package = $adapter->run_runtime_package( array( 'runtime_package' => '/workspace/example-project/bundles/example-generator' ) );
assert( array( 'slug' => 'example-generator', 'source' => '/workspace/example-project/bundles/example-generator' ) === $GLOBALS['wp_codebox_test_abilities'][ $names['run_runtime_package'] ]->last_input['package'] );
assert( array( 'id' => 'example-generator' ) === $GLOBALS['wp_codebox_test_abilities'][ $names['run_runtime_package'] ]->last_input['workflow'] );

$package_with_descriptor = $adapter->run_runtime_package(
	array(
		'runtime_package' => 'example-agent',
		'metadata'        => array( 'runtime_package_descriptor' => array( 'slug' => 'example-agent', 'source' => 'bundles/example-agent' ) ),
	)
);
assert( array( 'slug' => 'example-agent', 'source' => 'bundles/example-agent' ) === $GLOBALS['wp_codebox_test_abilities'][ $names['run_runtime_package'] ]->last_input['package'] );
assert( array( 'id' => 'example-agent' ) === $GLOBALS['wp_codebox_test_abilities'][ $names['run_runtime_package'] ]->last_input['workflow'] );

$package_with_explicit_workflow = $adapter->run_runtime_package(
	array(
		'runtime_package' => 'example-agent',
		'workflow'        => array( 'id' => 'custom-workflow' ),
	)
);
assert( array( 'id' => 'custom-workflow' ) === $GLOBALS['wp_codebox_test_abilities'][ $names['run_runtime_package'] ]->last_input['workflow'] );

$workspace_root = sys_get_temp_dir() . '/wp-codebox-runtime-package-' . getmypid();
mkdir( $workspace_root . '/bundles/example-agent', 0777, true );
mkdir( $workspace_root . '/bundles/example-generator', 0777, true );
$package_with_workspace_source = $adapter->run_runtime_package(
	array(
		'runtime_package' => 'example-agent',
		'provider'        => 'codex',
		'model'           => 'gpt-5.5',
		'input'           => array( 'wait_for_completion' => true, 'topic' => 'coffee' ),
		'metadata'        => array( 'runtime_package_descriptor' => array( 'slug' => 'example-agent', 'source' => 'bundles/example-agent' ) ),
		'task_input'      => array(
			'client_context' => array(
				'default_workspace' => array( 'target' => $workspace_root ),
			),
		),
	)
);
assert( array( 'slug' => 'example-agent', 'source' => $workspace_root . '/bundles/example-agent' ) === $GLOBALS['wp_codebox_test_abilities'][ $names['run_runtime_package'] ]->last_input['package'] );
assert( true === $GLOBALS['wp_codebox_test_abilities'][ $names['run_runtime_package'] ]->last_input['input']['wait_for_completion'] );
assert( 'coffee' === $GLOBALS['wp_codebox_test_abilities'][ $names['run_runtime_package'] ]->last_input['input']['topic'] );
assert( array( 'provider' => 'codex', 'model' => 'gpt-5.5', 'wait_for_completion' => true ) === $GLOBALS['wp_codebox_test_abilities'][ $names['run_runtime_package'] ]->last_input['options'] );

$package_with_options_only_controls = $adapter->run_runtime_package(
	array(
		'runtime_package' => 'example-agent',
		'input'           => array( 'topic' => 'tea' ),
		'options'         => array( 'wait_for_completion' => true, 'time_budget_ms' => 1200000 ),
	)
);
assert( 'tea' === $GLOBALS['wp_codebox_test_abilities'][ $names['run_runtime_package'] ]->last_input['input']['topic'] );
assert( true === $GLOBALS['wp_codebox_test_abilities'][ $names['run_runtime_package'] ]->last_input['input']['wait_for_completion'] );
assert( 1200000 === $GLOBALS['wp_codebox_test_abilities'][ $names['run_runtime_package'] ]->last_input['input']['time_budget_ms'] );
assert( array( 'wait_for_completion' => true, 'time_budget_ms' => 1200000 ) === $GLOBALS['wp_codebox_test_abilities'][ $names['run_runtime_package'] ]->last_input['options'] );

$runtime_package_browser_input = WP_Codebox_Agents_API_Adapter::browser_runtime_invocation_input(
	array(
		'agent'          => 'example-agent',
		'provider'       => 'codex',
		'model'          => 'gpt-5.5',
		'client_context' => array(),
	),
	array(
		'agent'      => 'example-agent',
		'task_input' => array(
			'runtime_task' => array(
				'kind'    => 'bundle',
				'ability' => 'runtime-package/run',
				'input'   => array(
					'package'  => array( 'slug' => 'example-agent', 'source' => 'bundles/example-agent' ),
					'workflow' => array( 'id' => 'example-artifact-flow' ),
					'input'    => array( 'wait_for_completion' => true ),
				),
			),
		),
	),
	array( 'type' => 'ability', 'name' => 'agents/run-runtime-package' ),
	'codebox-session'
);
assert( array( 'slug' => 'example-agent', 'source' => 'bundles/example-agent' ) === $runtime_package_browser_input['package'] );
assert( array( 'id' => 'example-artifact-flow' ) === $runtime_package_browser_input['workflow'] );
assert( array( 'wait_for_completion' => true ) === $runtime_package_browser_input['input'] );
assert( 'runtime' === $runtime_package_browser_input['principal']['auth_source'] );

$package_with_workspace_relative_runtime_package = $adapter->run_runtime_package(
	array(
		'runtime_package' => 'bundles/example-generator',
		'task_input'      => array(
			'client_context' => array(
				'default_workspace' => array( 'target' => $workspace_root ),
			),
		),
	)
);
assert( array( 'slug' => 'example-generator', 'source' => $workspace_root . '/bundles/example-generator' ) === $GLOBALS['wp_codebox_test_abilities'][ $names['run_runtime_package'] ]->last_input['package'] );
assert( array( 'id' => 'example-generator' ) === $GLOBALS['wp_codebox_test_abilities'][ $names['run_runtime_package'] ]->last_input['workflow'] );
assert( 'running' === $adapter->get_task_run( array( 'run_id' => 'task-run', 'session_id' => 'session' ) )['status'] );
assert( 'running' === $adapter->get_chat_run( array( 'run_id' => 'chat-run', 'session_id' => 'session' ) )['status'] );
assert_no_agents_api_schema_leaks( $chat, 'chat' );
assert_no_agents_api_schema_leaks( $task, 'task' );
assert_no_agents_api_schema_leaks( $package, 'package' );

$missing = $adapter->cancel_task_run( array( 'run_id' => 'task-run', 'session_id' => 'session' ) );
assert( is_wp_error( $missing ) );
assert( 'wp_codebox_agents_api_ability_unavailable' === $missing->get_error_code() );

WP_Codebox_Agents_API_Adapter::register_runtime_provider();
$providers = WP_Codebox_Runtime_Provider_Registry::providers();
assert( isset( $providers['agents-api-adapter'] ) );
assert( 'codebox-agent-runtime' === $providers['agents-api-adapter']['id'] );
assert( 'agents-api-adapter' === WP_Codebox_Runtime_Provider_Registry::default_provider() );

$default_registered_runtime_package = WP_Codebox_Runtime_Provider_Registry::invoke( array( 'package' => array( 'id' => 'example' ) ) );
assert( ! is_wp_error( $default_registered_runtime_package ) );
assert( 'codebox-agent-runtime' === $default_registered_runtime_package['runtime_provider']['id'] );
assert( false === str_contains( json_encode( $default_registered_runtime_package['runtime_provider'] ), 'agents-api' ) );

$runtime_package = WP_Codebox_Runtime_Provider_Registry::invoke( array( 'runtime_provider_id' => 'agents-api-adapter', 'package' => array( 'id' => 'example' ) ) );
assert( ! is_wp_error( $runtime_package ) );
assert( 'wp-codebox/runtime-package-result/v1' === $runtime_package['schema'] );
assert( 'codebox-agent-runtime' === $runtime_package['runtime_provider']['id'] );
assert_no_agents_api_schema_leaks( $runtime_package, 'runtime-package-registry' );

$GLOBALS['wp_codebox_test_filters']['wp_codebox_default_runtime_provider'] = 'agents-api-adapter';
assert( 'agents-api-adapter' === WP_Codebox_Runtime_Provider_Registry::default_provider() );
$default_runtime_package = WP_Codebox_Runtime_Provider_Registry::invoke( array( 'package' => array( 'id' => 'example' ) ) );
assert( ! is_wp_error( $default_runtime_package ) );
assert( 'codebox-agent-runtime' === $default_runtime_package['runtime_provider']['id'] );

WP_Codebox_Runtime_Provider_Registry::register(
	'Example Runtime',
	static fn( array $input ): array => array( 'schema' => 'wp-codebox/example-runtime-result/v1', 'received' => $input ),
	array( 'label' => 'Example runtime', 'capabilities' => array( 'runtime-package' ) )
);

$explicit_runtime = WP_Codebox_Runtime_Provider_Registry::invoke( array( 'runtime_provider' => array( 'id' => 'example-runtime' ) ) );
assert( ! is_wp_error( $explicit_runtime ) );
assert( 'example-runtime' === $explicit_runtime['runtime_provider']['id'] );
assert( 'wp-codebox/example-runtime-result/v1' === $explicit_runtime['schema'] );

$unknown_runtime = WP_Codebox_Runtime_Provider_Registry::invoke( array( 'runtime_provider_id' => 'missing-runtime' ) );
assert( is_wp_error( $unknown_runtime ) );
assert( 'wp_codebox_runtime_provider_unavailable' === $unknown_runtime->get_error_code() );

// Default agent-runtime substrate provisioning (issue #1591): selecting
// codebox-agent-runtime contributes the runtime substrate (agents-api) by
// default, so consumers supply domain inputs only and never hand-inject
// agents-api / data-machine / provider plugins.
$profile_registry = WP_Codebox_Agents_API_Adapter::runtime_profile_registry(
	array(
		'codebox-agent-runtime' => array(
			'id'           => 'codebox-agent-runtime',
			'capabilities' => array( 'codebox.agent-runtime' ),
		),
	)
);
$agent_runtime_component_slugs = array_map(
	static fn( array $component ): string => (string) ( $component['slug'] ?? '' ),
	is_array( $profile_registry['codebox-agent-runtime']['components'] ?? null ) ? $profile_registry['codebox-agent-runtime']['components'] : array()
);
assert( in_array( 'agents-api', $agent_runtime_component_slugs, true ) );

$required_components = WP_Codebox_Agents_API_Adapter::browser_runtime_required_components( array() );
assert( in_array( 'agents-api', $required_components, true ) );

// A host/deploy that needs additional substrate (e.g. Data Machine for bundles
// that use those abilities) extends the default set through the filter.
$GLOBALS['wp_codebox_test_filters']['wp_codebox_agent_runtime_default_components'] = array( 'agents-api', 'data-machine', 'data-machine-code' );
$extended_required = WP_Codebox_Agents_API_Adapter::browser_runtime_required_components( array() );
assert( in_array( 'data-machine', $extended_required, true ) );
assert( in_array( 'data-machine-code', $extended_required, true ) );
unset( $GLOBALS['wp_codebox_test_filters']['wp_codebox_agent_runtime_default_components'] );
