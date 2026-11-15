<?php
/**
 * Runtime package turn limits: an explicit caller max_turns reaches the
 * agents/chat loop over the imported package default, and a loop that stops at
 * its cap without a final answer becomes a canonical max_turns terminal result.
 */
declare(strict_types=1);

define( 'ABSPATH', __DIR__ );
function is_wp_error( mixed $value ): bool { return $value instanceof WP_Error; }
function get_current_user_id(): int { return 1; }
function wp_generate_uuid4(): string { return 'run-fixture'; }
final class WP_Error {
	public function __construct( private string $code, private string $message, private array $data = array() ) {}
	public function get_error_code(): string { return $this->code; }
	public function get_error_message(): string { return $this->message; }
	public function get_error_data(): array { return $this->data; }
}
final class WP_Codebox_Sandbox_Workspace_Executor {
	public static function reset_mutation_ledger(): void {}
	public static function mutation_ledger(): array { return array( 'schema' => 'wp-codebox/sandbox-workspace-mutations/v1', 'calls' => array(), 'dropped' => 0 ); }
}
final class Fixture_Agent {
	public function __construct( private array $meta ) {}
	public function get_meta(): array { return $this->meta; }
	public function get_default_config(): array { return array(); }
}
final class Fixture_Chat_Ability {
	public array $inputs = array();
	public array $result = array();
	public function execute( array $input ): array {
		$this->inputs[] = $input;
		return $this->result;
	}
}

$GLOBALS['fixture_agent_meta'] = array( 'default_max_turns' => 12 );
$GLOBALS['fixture_chat']       = new Fixture_Chat_Ability();
function wp_get_agent( string $slug ): ?Fixture_Agent { return '' === $slug ? null : new Fixture_Agent( $GLOBALS['fixture_agent_meta'] ); }
function wp_get_ability( string $name ): ?Fixture_Chat_Ability { return 'agents/chat' === $name ? $GLOBALS['fixture_chat'] : null; }

require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-runtime-package-executor.php';
require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-runtime-package-service.php';

function check( bool $condition, string $message ): void {
	if ( ! $condition ) {
		fwrite( STDERR, "FAIL: {$message}\n" );
		exit( 1 );
	}
}

/** @param array<int,array<string,mixed>> $calls */
function loop_result( int $turn_count, array $calls, string $stop_reason = 'natural' ): array {
	return array(
		'session_id' => 's',
		'reply'      => '',
		'completed'  => true,
		'metadata'   => array(
			'agents_api' => array(
				'status'             => null,
				'turn_count'         => $turn_count,
				'run_outcome'        => array( 'status' => 'completed', 'completed' => true, 'stop_reason' => $stop_reason ),
				'tool_observability' => array( 'version' => 1, 'calls' => $calls ),
			),
		),
	);
}

$executor = new WP_Codebox_Runtime_Package_Executor();
$execute  = new ReflectionMethod( $executor, 'execute_workflow' );
$task     = static fn( array $input ): array => array( 'package' => array( 'slug' => 'user-docs-maintenance-agent' ), 'input' => array_merge( array( 'agent' => 'user-docs-maintenance-agent', 'prompt' => 'Maintain docs' ), $input ) );

// 1. An explicit caller max_turns overrides the package default_max_turns.
$GLOBALS['fixture_chat']->result = loop_result( 5, array( array( 'turn' => 4, 'tool_name' => 'workspace_read' ) ) );
$result = $execute->invoke( $executor, $task( array( 'max_turns' => 40 ) ) );
check( 40 === ( $GLOBALS['fixture_chat']->inputs[0]['max_turns'] ?? null ), 'caller max_turns must reach agents/chat over the package default' );
check( 'caller' === $result['metadata']['turn_limit']['source'], 'turn-limit source records the caller override' );
check( false === $result['metadata']['turn_limit']['max_turns_reached'], 'a run that answered before the cap is not a max_turns stop' );
check( ! isset( $result['terminal_result'] ), 'no terminal result for a natural stop' );

// 2. Without a caller value the imported package default applies.
$GLOBALS['fixture_chat']->inputs = array();
$execute->invoke( $executor, $task( array() ) );
check( 12 === ( $GLOBALS['fixture_chat']->inputs[0]['max_turns'] ?? null ), 'package default_max_turns applies when the caller sets none' );

// 3. Neither declared: the agents/chat handler default is left in place.
$GLOBALS['fixture_agent_meta']   = array();
$GLOBALS['fixture_chat']->inputs = array();
$result = $execute->invoke( $executor, $task( array() ) );
check( ! array_key_exists( 'max_turns', $GLOBALS['fixture_chat']->inputs[0] ), 'no max_turns is invented when nothing declares one' );
check( 'runtime_default' === $result['metadata']['turn_limit']['source'], 'turn-limit source records the runtime default' );

// 4. The loop ran every allowed turn and was still calling tools on the last one.
$GLOBALS['fixture_agent_meta']   = array( 'default_max_turns' => 12 );
$GLOBALS['fixture_chat']->result = loop_result( 12, array( array( 'turn' => 11, 'tool_name' => 'workspace_read' ), array( 'turn' => 12, 'tool_name' => 'workspace_grep' ) ) );
$result = $execute->invoke( $executor, $task( array( 'max_turns' => 12 ) ) );
check( true === $result['metadata']['turn_limit']['max_turns_reached'], 'a capped run with final-turn tool calls is a max_turns stop' );
check( false === $result['success'], 'a max_turns stop is not a successful runtime package run' );
check( 'max_turns' === $result['terminal_result']['status'], 'a max_turns stop becomes a canonical terminal result' );
check( array( 'reached' => true, 'current' => 12, 'max' => 12 ) === $result['terminal_result']['max_turns'], 'terminal result records the cap' );
check( 'max_turns_exceeded' === $result['diagnostics'][0]['code'], 'a max_turns stop carries an error diagnostic' );

// 5. Answering on the final allowed turn (no tool calls) is a natural finish.
$GLOBALS['fixture_chat']->result = loop_result( 12, array( array( 'turn' => 11, 'tool_name' => 'workspace_write' ) ) );
$result = $execute->invoke( $executor, $task( array( 'max_turns' => 12 ) ) );
check( false === $result['metadata']['turn_limit']['max_turns_reached'], 'a final-turn answer is not a max_turns stop' );

// 6. An explicit upstream max_turns stop reason is honored regardless of counts.
$GLOBALS['fixture_chat']->result = loop_result( 3, array(), 'max_turns' );
$result = $execute->invoke( $executor, $task( array( 'max_turns' => 40 ) ) );
check( 'max_turns' === ( $result['terminal_result']['status'] ?? '' ), 'explicit max_turns stop reason becomes a terminal result' );

// 7. The runtime package service forwards the canonical terminal result to the host.
$service   = new WP_Codebox_Runtime_Package_Service();
$normalize = new ReflectionMethod( $service, 'normalize_result' );
$capped    = $execute->invoke( $executor, $task( array( 'max_turns' => 40 ) ) );
$public    = $normalize->invoke( $service, $capped, array( 'package' => array( 'slug' => 'user-docs-maintenance-agent', 'source' => 'public-external-package' ) ) );
check( false === $public['success'] && 'failed' === $public['status'], 'service reports the capped run as failed' );
check( 'max_turns' === ( $public['terminal_result']['status'] ?? '' ), 'service preserves the max_turns terminal result' );
check( true === $public['metadata']['turn_limit']['max_turns_reached'], 'service preserves the turn-limit record' );

fwrite( STDOUT, "PHP runtime package max turns smoke passed\n" );
