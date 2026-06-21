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
	/** @param array<string,mixed> $result */
	public function __construct( private array $result = array( 'success' => true ) ) {}
	/** @param array<string,mixed> $input @return array<string,mixed> */
	public function execute( array $input ): array {
		return array_merge( $this->result, array( 'received' => $input ) );
	}
}

require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-agents-api-adapter.php';

$names = WP_Codebox_Agents_API_Adapter::ability_names();
assert( 'agents/chat' === $names['chat'] );
assert( 'agents/run-task' === $names['run_task'] );
assert( 'agents/run-runtime-package' === $names['run_runtime_package'] );
assert( 'agents/get-task-run' === $names['get_task_run'] );
assert( 'agents/get-chat-run' === $names['get_chat_run'] );

$adapter = new WP_Codebox_Agents_API_Adapter();
assert( false === $adapter->is_available( WP_Codebox_Agents_API_Adapter::CHAT ) );

$GLOBALS['wp_codebox_test_abilities'][ WP_Codebox_Agents_API_Adapter::CHAT ]                = new WP_Ability( array( 'schema' => 'agents-api/chat-result/v1' ) );
$GLOBALS['wp_codebox_test_abilities'][ WP_Codebox_Agents_API_Adapter::RUN_TASK ]            = new WP_Ability( array( 'schema' => 'agents-api/task-result/v1' ) );
$GLOBALS['wp_codebox_test_abilities'][ WP_Codebox_Agents_API_Adapter::RUN_RUNTIME_PACKAGE ] = new WP_Ability( array( 'schema' => 'agents-api/runtime-package-result/v1' ) );
$GLOBALS['wp_codebox_test_abilities'][ WP_Codebox_Agents_API_Adapter::GET_TASK_RUN ]        = new WP_Ability( array( 'status' => 'running' ) );
$GLOBALS['wp_codebox_test_abilities'][ WP_Codebox_Agents_API_Adapter::GET_CHAT_RUN ]        = new WP_Ability( array( 'status' => 'running' ) );

assert( true === $adapter->is_available( WP_Codebox_Agents_API_Adapter::CHAT ) );
assert( 'agents-api/chat-result/v1' === $adapter->chat( array( 'message' => 'hello' ) )['schema'] );
assert( 'agents-api/task-result/v1' === $adapter->run_task( array( 'goal' => 'ship' ) )['schema'] );
assert( 'agents-api/runtime-package-result/v1' === $adapter->run_runtime_package( array( 'package' => array() ) )['schema'] );
assert( 'running' === $adapter->get_task_run( array( 'run_id' => 'task-run', 'session_id' => 'session' ) )['status'] );
assert( 'running' === $adapter->get_chat_run( array( 'run_id' => 'chat-run', 'session_id' => 'session' ) )['status'] );

$missing = $adapter->cancel_task_run( array( 'run_id' => 'task-run', 'session_id' => 'session' ) );
assert( is_wp_error( $missing ) );
assert( 'wp_codebox_agents_api_ability_unavailable' === $missing->get_error_code() );
