<?php
/**
 * Real-dispatch integration test for the runner-workspace executor.
 *
 * Proves the codebox runner executor dispatches through the LIVE Agents API
 * tool-execution contract using the real Agents API classes (no shims for the
 * registry or execution core):
 *
 *   1. The runner executor's register() wires it onto the `agents_api_tool_executors`
 *      filter under its target id, and declares its tools with
 *      runtime.executor_target = wp-codebox/runner-workspace.
 *   2. A tool call for a runner-declared tool routes through
 *      WP_Agent_Tool_Execution_Core -> WP_Agent_Tool_Executor_Registry to the
 *      runner executor (NOT the caller-provided default executor), against a real
 *      temp git workspace, with no Data Machine Code.
 *   3. Backward compatibility: a tool with no executor_target falls back to the
 *      default executor exactly as before.
 *
 * This is the gate for flipping the CLI runner mount off Data Machine Code: it
 * shows the runner agent-facing surface is served by the codebox-native executor
 * through the same contract the merged agents-api dispatch proof exercises.
 *
 * Requires a real Agents API checkout. Resolution order:
 *   - WP_CODEBOX_AGENTS_API_PATH env var (plugin root, the same var the CLI uses)
 *   - sibling checkouts under the workspace root (../agents-api, ../agents-api@*)
 *
 * Run: WP_CODEBOX_AGENTS_API_PATH=/path/to/agents-api php scripts/php-runner-workspace-executor-dispatch-smoke.php
 *
 * @package WPCodebox
 */

declare( strict_types=1 );

if ( ! defined( 'ABSPATH' ) ) {
	define( 'ABSPATH', __DIR__ . '/' );
}

$failures = array();
$passes   = 0;

/** @param mixed $condition */
function assert_true( $condition, string $message, array &$failures, int &$passes ): void {
	if ( $condition ) {
		++$passes;
		return;
	}
	$failures[] = $message;
	fwrite( STDERR, "FAIL: {$message}\n" );
}

function run_git( string $cwd, array $args ): void {
	$command = array_merge( array( 'git', '-C', $cwd ), $args );
	$process = proc_open( $command, array( 1 => array( 'pipe', 'w' ), 2 => array( 'pipe', 'w' ) ), $pipes, $cwd );
	if ( is_resource( $process ) ) {
		stream_get_contents( $pipes[1] );
		stream_get_contents( $pipes[2] );
		fclose( $pipes[1] );
		fclose( $pipes[2] );
		proc_close( $process );
	}
}

/**
 * Resolve a real Agents API checkout that carries the per-target executor registry.
 */
function resolve_agents_api_root(): string {
	$candidates = array();

	$env = getenv( 'WP_CODEBOX_AGENTS_API_PATH' );
	if ( is_string( $env ) && '' !== trim( $env ) ) {
		$candidates[] = rtrim( trim( $env ), '/' );
	}

	$workspace_root = dirname( dirname( __DIR__ ) ); // .../wp-codebox@<slug> lives under the workspace root.
	foreach ( glob( $workspace_root . '/agents-api*', GLOB_ONLYDIR ) ?: array() as $sibling ) {
		$candidates[] = $sibling;
	}

	foreach ( $candidates as $candidate ) {
		if ( is_file( $candidate . '/src/Tools/class-wp-agent-tool-executor-registry.php' )
			&& is_file( $candidate . '/src/Tools/class-wp-agent-tool-execution-core.php' ) ) {
			return $candidate;
		}
	}

	return '';
}

// ---------------------------------------------------------------------------
// Minimal WordPress filter substrate. The Agents API registry + execution core
// classes themselves are the REAL classes; only the host's add_filter /
// apply_filters primitives are shimmed (as every PHP smoke in this repo does).
// ---------------------------------------------------------------------------
$GLOBALS['wp_codebox_test_filters'] = array();

if ( ! function_exists( 'add_filter' ) ) {
	function add_filter( string $hook, callable $callback, int $priority = 10, int $accepted_args = 1 ): bool {
		unset( $priority, $accepted_args );
		$GLOBALS['wp_codebox_test_filters'][ $hook ][] = $callback;
		return true;
	}
}

if ( ! function_exists( 'apply_filters' ) ) {
	function apply_filters( string $hook, mixed $value, mixed ...$args ): mixed {
		foreach ( $GLOBALS['wp_codebox_test_filters'][ $hook ] ?? array() as $callback ) {
			$value = $callback( $value, ...$args );
		}
		return $value;
	}
}

$agents_api_root = resolve_agents_api_root();
if ( '' === $agents_api_root ) {
	// No real Agents API checkout is reachable in this environment (e.g. a bare
	// PHP CI image with no sibling agents-api). Skip rather than fake a pass: the
	// dispatch proof is only meaningful against the real registry + execution core.
	// Run it locally / where agents-api is provisioned via WP_CODEBOX_AGENTS_API_PATH.
	fwrite(
		STDOUT,
		"skip - runner workspace executor dispatch: no real Agents API checkout resolved.\n"
		. "       Set WP_CODEBOX_AGENTS_API_PATH to an agents-api checkout whose main has the merged\n"
		. "       per-target tool-executor dispatch to run this proof.\n"
	);
	exit( 0 );
}

$agents_api_tools = $agents_api_root . '/src/Tools';
require_once $agents_api_root . '/src/Runtime/class-wp-agent-citation-metadata.php';
require_once $agents_api_tools . '/class-wp-agent-tool-call.php';
require_once $agents_api_tools . '/class-wp-agent-tool-declaration.php';
require_once $agents_api_tools . '/class-wp-agent-tool-parameters.php';
require_once $agents_api_tools . '/class-wp-agent-tool-result.php';
require_once $agents_api_tools . '/class-wp-agent-tool-executor.php';
require_once $agents_api_tools . '/class-wp-agent-tool-source-registry.php';
require_once $agents_api_tools . '/class-wp-agent-tool-executor-registry.php';
require_once $agents_api_tools . '/class-wp-agent-tool-execution-core.php';

use AgentsAPI\AI\Tools\WP_Agent_Tool_Execution_Core;
use AgentsAPI\AI\Tools\WP_Agent_Tool_Executor;
use AgentsAPI\AI\Tools\WP_Agent_Tool_Executor_Registry;
use AgentsAPI\AI\Tools\WP_Agent_Tool_Result;
use AgentsAPI\AI\Tools\WP_Agent_Tool_Source_Registry;

assert_true( interface_exists( WP_Agent_Tool_Executor::class ), 'real Agents API tool-executor interface loaded', $failures, $passes );
assert_true( class_exists( WP_Agent_Tool_Executor_Registry::class ), 'real Agents API tool-executor registry loaded', $failures, $passes );
assert_true( class_exists( WP_Agent_Tool_Execution_Core::class ), 'real Agents API tool-execution core loaded', $failures, $passes );
assert_true( class_exists( WP_Agent_Tool_Source_Registry::class ), 'real Agents API tool-source registry loaded', $failures, $passes );

// ---------------------------------------------------------------------------
// Load the codebox runner-workspace executor surface.
// ---------------------------------------------------------------------------
$plugin_src = dirname( __DIR__ ) . '/packages/wordpress-plugin/src';
require_once $plugin_src . '/class-wp-codebox-runner-workspace-tools.php';
require_once $plugin_src . '/trait-wp-codebox-runner-workspace-executor-behavior.php';
require_once $plugin_src . '/class-wp-codebox-runner-workspace-executor.php';

// The substrate-presence gate the sandbox executor harness flagged: both the
// executor interface AND the source registry must be loaded before register().
assert_true(
	WP_Codebox_Runner_Workspace_Executor::substrate_exists(),
	'runner executor substrate gate satisfied (executor interface + source registry loaded)',
	$failures,
	$passes
);

// ---------------------------------------------------------------------------
// Real, isolated git workspace the runner executor operates against.
// ---------------------------------------------------------------------------
$root = sys_get_temp_dir() . '/wp-codebox-runner-dispatch-' . bin2hex( random_bytes( 6 ) );
mkdir( $root . '/src', 0777, true );
run_git( $root, array( 'init', '-q', '-b', 'main' ) );
run_git( $root, array( 'config', 'user.email', 'runner@example.test' ) );
run_git( $root, array( 'config', 'user.name', 'Runner' ) );
file_put_contents( $root . '/src/app.php', "<?php\n// gamma marker\necho 'hi';\n" );
run_git( $root, array( 'add', '-A' ) );
run_git( $root, array( 'commit', '-q', '-m', 'seed' ) );
$root_real = realpath( $root );

// ---------------------------------------------------------------------------
// Register the runner executor onto the LIVE contract.
// ---------------------------------------------------------------------------
$registered = WP_Codebox_Runner_Workspace_Executor::register();
assert_true( true === $registered, 'runner executor register() returns true with the substrate present', $failures, $passes );

$context = array( 'workspace_root' => $root_real );

$executors = apply_filters( WP_Agent_Tool_Executor_Registry::EXECUTORS_FILTER, array(), $context );
assert_true( isset( $executors['wp-codebox/runner-workspace'] ), 'runner executor registered under its target id on agents_api_tool_executors', $failures, $passes );
assert_true(
	( $executors['wp-codebox/runner-workspace'] ?? null ) instanceof WP_Agent_Tool_Executor,
	'registered runner executor satisfies the real WP_Agent_Tool_Executor contract',
	$failures,
	$passes
);

// Tool declarations carry the executor target and a host executor kind.
$sources = apply_filters( 'agents_api_tool_sources', array(), $context, null );
assert_true( isset( $sources['wp-codebox-runner'] ), 'runner tool source registered under its slug', $failures, $passes );
$declared = is_callable( $sources['wp-codebox-runner'] ?? null ) ? $sources['wp-codebox-runner']( $context, null ) : array();
$expected_tools = array(
	'wp-codebox-runner/workspace-read',
	'wp-codebox-runner/workspace-ls',
	'wp-codebox-runner/workspace-grep',
	'wp-codebox-runner/workspace-write',
	'wp-codebox-runner/workspace-edit',
	'wp-codebox-runner/workspace-apply-patch',
	'wp-codebox-runner/workspace-git-status',
	'wp-codebox-runner/workspace-git-diff',
	'wp-codebox-runner/workspace-git-add',
	'wp-codebox-runner/workspace-git-commit',
	'wp-codebox-runner/workspace-git-push',
	'wp-codebox-runner/create-github-pull-request',
	'wp-codebox-runner/create-github-issue',
	'wp-codebox-runner/comment-github-pull-request',
);
foreach ( $expected_tools as $tool_name ) {
	assert_true( isset( $declared[ $tool_name ] ), "tool source declares {$tool_name}", $failures, $passes );
	assert_true(
		'wp-codebox/runner-workspace' === ( $declared[ $tool_name ]['runtime']['executor_target'] ?? null ),
		"{$tool_name} routes to the runner-workspace executor target",
		$failures,
		$passes
	);
	assert_true( 'host' === ( $declared[ $tool_name ]['executor'] ?? null ), "{$tool_name} is a host-executed tool", $failures, $passes );
}

// ---------------------------------------------------------------------------
// Default executor: records calls so we can prove it is bypassed for targeted
// tools and used for untargeted ones.
// ---------------------------------------------------------------------------
$default_executor = new class implements WP_Agent_Tool_Executor {
	/** @var array<int,string> */
	public array $calls = array();

	/**
	 * @param array<mixed> $tool_call Prepared tool call.
	 * @param array<mixed> $tool_definition Tool declaration.
	 * @param array<mixed> $context Runtime context.
	 * @return array<mixed>
	 */
	public function executeWP_Agent_Tool_Call( array $tool_call, array $tool_definition, array $context = array() ): array {
		unset( $tool_definition, $context );
		$tool_name     = is_string( $tool_call['tool_name'] ?? null ) ? $tool_call['tool_name'] : '';
		$this->calls[] = $tool_name;
		return WP_Agent_Tool_Result::success( $tool_name, array( 'handled_by' => 'default' ) );
	}
};

// Build the available-tools map the execution core mediates against: the real
// runner declarations plus one untargeted control tool.
$available_tools = $declared;
$available_tools['host/search'] = array(
	'name'        => 'host/search',
	'source'      => 'host',
	'description' => 'Control tool with no executor target.',
	'executor'    => 'host',
	'parameters'  => array(
		'type'       => 'object',
		'required'   => array( 'query' ),
		'properties' => array( 'query' => array( 'type' => 'string' ) ),
	),
);

$core = new WP_Agent_Tool_Execution_Core();

// [1] A targeted runner tool dispatches to the runner executor against the real
// git workspace, NOT the default executor.
$read_result = $core->executeTool(
	'wp-codebox-runner/workspace-read',
	array( 'path' => 'src/app.php' ),
	$available_tools,
	$default_executor,
	$context + array( 'tool_call_id' => 'call-runner-read' )
);
assert_true( true === ( $read_result['success'] ?? false ), 'targeted runner read dispatch succeeds', $failures, $passes );
assert_true(
	str_contains( (string) ( $read_result['result']['content'] ?? '' ), 'gamma marker' ),
	'runner executor returned real workspace file content through the contract',
	$failures,
	$passes
);
assert_true(
	'wp-codebox/runner-workspace' === ( $read_result['runtime']['executor_target'] ?? null ),
	'dispatched result carries the runner executor target in runtime metadata',
	$failures,
	$passes
);
assert_true( ! in_array( 'wp-codebox-runner/workspace-read', $default_executor->calls, true ), 'default executor was NOT invoked for the targeted runner tool', $failures, $passes );

// [2] A targeted git tool also routes to the runner executor against the repo.
$status_result = $core->executeTool(
	'wp-codebox-runner/workspace-git-status',
	array(),
	$available_tools,
	$default_executor,
	$context + array( 'tool_call_id' => 'call-runner-status' )
);
assert_true( true === ( $status_result['success'] ?? false ), 'targeted runner git-status dispatch succeeds', $failures, $passes );
assert_true( 'main' === ( $status_result['result']['branch'] ?? null ), 'runner executor reported the real git branch through the contract', $failures, $passes );

// [3] Backward compatibility: an untargeted tool falls back to the default executor.
$control_result = $core->executeTool(
	'host/search',
	array( 'query' => 'anything' ),
	$available_tools,
	$default_executor,
	array( 'tool_call_id' => 'call-control' )
);
assert_true( true === ( $control_result['success'] ?? false ), 'untargeted control tool dispatch succeeds', $failures, $passes );
assert_true( 'default' === ( $control_result['result']['handled_by'] ?? null ), 'untargeted tool was handled by the default executor', $failures, $passes );
assert_true( in_array( 'host/search', $default_executor->calls, true ), 'default executor recorded the untargeted tool call', $failures, $passes );

// [4] Registry helpers resolve the runner target generically (real registry).
$registry = WP_Agent_Tool_Executor_Registry::fromFilters( $context );
assert_true( $registry->hasExecutors(), 'real registry built from the filter exposes registered executors', $failures, $passes );
assert_true(
	$registry->executorForTarget( 'wp-codebox/runner-workspace' ) instanceof WP_Agent_Tool_Executor,
	'registry resolves the runner executor by target id',
	$failures,
	$passes
);
assert_true(
	'wp-codebox/runner-workspace' === WP_Agent_Tool_Executor_Registry::targetIdFromDeclaration( $declared['wp-codebox-runner/workspace-write'] ),
	'targetIdFromDeclaration reads the runner executor target off a declaration',
	$failures,
	$passes
);
assert_true(
	'' === WP_Agent_Tool_Executor_Registry::targetIdFromDeclaration( $available_tools['host/search'] ),
	'targetIdFromDeclaration is empty for an untargeted tool',
	$failures,
	$passes
);

// ---------------------------------------------------------------------------
// Cleanup.
// ---------------------------------------------------------------------------
$rrmdir = static function ( string $dir ) use ( &$rrmdir ): void {
	foreach ( scandir( $dir ) ?: array() as $entry ) {
		if ( '.' === $entry || '..' === $entry ) {
			continue;
		}
		$path = $dir . '/' . $entry;
		is_dir( $path ) ? $rrmdir( $path ) : unlink( $path );
	}
	rmdir( $dir );
};
if ( is_string( $root_real ) && is_dir( $root_real ) ) {
	$rrmdir( $root_real );
}

if ( array() !== $failures ) {
	fwrite( STDERR, sprintf( "\n%d passed, %d FAILED\n", $passes, count( $failures ) ) );
	exit( 1 );
}

fwrite( STDOUT, sprintf( "ok - runner workspace executor dispatch: %d assertions passed (real Agents API contract at %s)\n", $passes, $agents_api_root ) );
exit( 0 );
