<?php
/**
 * Deterministic runner-workspace tool engine + executor test.
 *
 * Proves the codebox-native runner workspace tool surface operates on a real
 * temp git repository with no Data Machine Code dependency and no network:
 *   - file tools: write -> read -> edit -> grep
 *   - git tools:  status -> add -> commit -> diff
 *   - git push contract construction (argv, no network)
 *   - GitHub PR/issue/comment request construction (env-token auth, no network)
 *   - executor target_id resolution + workspace-root binding through the executor
 *
 * Run: php tests/runner-workspace-tools.php
 *
 * @package WPCodebox
 */

declare( strict_types=1 );

// Minimal shims so the engine/executor load outside a WordPress runtime.
if ( ! defined( 'ABSPATH' ) ) {
	define( 'ABSPATH', __DIR__ );
}

$plugin_src = dirname( __DIR__ ) . '/packages/wordpress-plugin/src';
require_once $plugin_src . '/class-wp-codebox-runner-workspace-tools.php';
require_once $plugin_src . '/trait-wp-codebox-runner-workspace-executor-behavior.php';
require_once $plugin_src . '/class-wp-codebox-runner-workspace-executor.php';

$failures = array();
$passes   = 0;

/** @param mixed $condition */
function assert_true( $condition, string $message, array &$failures, int &$passes ): void {
	if ( $condition ) {
		$passes++;
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

// ---------------------------------------------------------------------------
// Set up a real, isolated git repository.
// ---------------------------------------------------------------------------
$root = sys_get_temp_dir() . '/wp-codebox-runner-workspace-' . bin2hex( random_bytes( 6 ) );
mkdir( $root, 0777, true );
run_git( $root, array( 'init', '-q', '-b', 'main' ) );
run_git( $root, array( 'config', 'user.email', 'runner@example.com' ) );
run_git( $root, array( 'config', 'user.name', 'Runner' ) );
$root = realpath( $root );

register_shutdown_function( static function () use ( $root ): void {
	if ( is_string( $root ) && is_dir( $root ) ) {
		exec( 'rm -rf ' . escapeshellarg( $root ) );
	}
} );

$tools = new WP_Codebox_Runner_Workspace_Tools( $root );

// ---------------------------------------------------------------------------
// File tools: write -> read -> edit -> grep
// ---------------------------------------------------------------------------
$write = $tools->write( array( 'path' => 'src/app.php', 'content' => "<?php\n// alpha marker\necho 'hello';\n" ) );
assert_true( ! empty( $write['success'] ), 'write succeeds', $failures, $passes );
assert_true( 'src/app.php' === ( $write['path'] ?? '' ), 'write returns relative path', $failures, $passes );

$read = $tools->read( array( 'path' => 'src/app.php' ) );
assert_true( ! empty( $read['success'] ) && str_contains( (string) $read['content'], 'alpha marker' ), 'read returns written content', $failures, $passes );

$edit = $tools->edit( array( 'path' => 'src/app.php', 'old' => 'alpha marker', 'new' => 'beta marker' ) );
assert_true( ! empty( $edit['success'] ) && 1 === ( $edit['replacements'] ?? 0 ), 'edit replaces unique string', $failures, $passes );

$read_after = $tools->read( array( 'path' => 'src/app.php' ) );
assert_true( str_contains( (string) $read_after['content'], 'beta marker' ), 'edit persisted to disk', $failures, $passes );

$grep = $tools->grep( array( 'query' => 'beta marker' ) );
assert_true( ! empty( $grep['success'] ) && 1 === count( $grep['matches'] ), 'grep finds the edited marker', $failures, $passes );
assert_true( 'src/app.php' === ( $grep['matches'][0]['path'] ?? '' ), 'grep reports the correct path', $failures, $passes );

$grep_empty = $tools->grep( array( 'query' => 'string-that-does-not-exist-anywhere' ) );
assert_true( ! empty( $grep_empty['success'] ) && array() === $grep_empty['matches'], 'grep with no matches is a clean empty result', $failures, $passes );

// Path-escape confinement.
$escape = $tools->read( array( 'path' => '../../../etc/hosts' ) );
assert_true( empty( $escape['success'] ) && 'wp_codebox_runner_workspace_path_escape' === ( $escape['error']['code'] ?? '' ), 'path traversal is rejected', $failures, $passes );

// ---------------------------------------------------------------------------
// ls
// ---------------------------------------------------------------------------
$ls = $tools->ls( array( 'path' => 'src' ) );
$ls_names = array_map( static fn( array $e ): string => $e['name'], $ls['entries'] ?? array() );
assert_true( ! empty( $ls['success'] ) && in_array( 'app.php', $ls_names, true ), 'ls lists workspace files', $failures, $passes );

// ---------------------------------------------------------------------------
// Git tools: status -> add -> commit -> diff
// ---------------------------------------------------------------------------
$status = $tools->git_status();
assert_true( ! empty( $status['success'] ) && 'main' === $status['branch'], 'git_status reports branch', $failures, $passes );
assert_true( $status['dirty'] >= 1, 'git_status sees the untracked file', $failures, $passes );

$add = $tools->git_add( array( 'paths' => array( 'src/app.php' ) ) );
assert_true( ! empty( $add['success'] ), 'git_add stages the file', $failures, $passes );

$commit = $tools->git_commit( array( 'message' => 'Add app', 'author_name' => 'Runner', 'author_email' => 'runner@example.com' ) );
assert_true( ! empty( $commit['success'] ) && 40 === strlen( (string) $commit['sha'] ), 'git_commit returns a sha', $failures, $passes );

$clean = $tools->git_status();
assert_true( 0 === $clean['dirty'], 'git_status is clean after commit', $failures, $passes );

// Modify and diff.
$tools->write( array( 'path' => 'src/app.php', 'content' => "<?php\n// beta marker\necho 'goodbye';\n" ) );
$diff = $tools->git_diff();
assert_true( ! empty( $diff['success'] ) && str_contains( (string) $diff['diff'], 'goodbye' ), 'git_diff shows working-tree changes', $failures, $passes );

// ---------------------------------------------------------------------------
// apply_patch
// ---------------------------------------------------------------------------
run_git( $root, array( 'checkout', '--', 'src/app.php' ) );
$patch = "diff --git a/src/app.php b/src/app.php\n"
	. "index 0000000..1111111 100644\n"
	. "--- a/src/app.php\n"
	. "+++ b/src/app.php\n"
	. "@@ -1,3 +1,3 @@\n"
	. " <?php\n"
	. "-// beta marker\n"
	. "+// gamma marker\n"
	. " echo 'hello';\n";
$apply = $tools->apply_patch( array( 'patch' => $patch ) );
assert_true( ! empty( $apply['success'] ), 'apply_patch applies a unified diff', $failures, $passes );
assert_true( str_contains( (string) $tools->read( array( 'path' => 'src/app.php' ) )['content'], 'gamma marker' ), 'apply_patch changed the file', $failures, $passes );

// ---------------------------------------------------------------------------
// git push contract (construction only, no network)
// ---------------------------------------------------------------------------
$push = $tools->build_git_push( array( 'remote' => 'origin', 'branch' => 'feat/x', 'set_upstream' => true ) );
assert_true(
	$push['argv'] === array( 'git', 'push', '--set-upstream', 'origin', 'feat/x' ),
	'build_git_push constructs the expected argv',
	$failures,
	$passes
);

// ---------------------------------------------------------------------------
// GitHub request construction (env-token auth, no network)
// ---------------------------------------------------------------------------
putenv( 'GITHUB_TOKEN=test-token-123' );
$pr = $tools->build_create_pull_request( array(
	'repo'  => 'Automattic/wp-codebox',
	'title' => 'My PR',
	'head'  => 'feat/x',
	'base'  => 'main',
	'body'  => 'Body text',
) );
assert_true( ! empty( $pr['success'] ), 'build_create_pull_request succeeds with a token', $failures, $passes );
assert_true( 'POST' === $pr['method'], 'PR request is a POST', $failures, $passes );
assert_true( 'https://api.github.com/repos/Automattic/wp-codebox/pulls' === $pr['url'], 'PR request targets the pulls endpoint', $failures, $passes );
assert_true( 'token test-token-123' === ( $pr['headers']['Authorization'] ?? '' ), 'PR request carries the env token', $failures, $passes );
$pr_body = json_decode( (string) $pr['body'], true );
assert_true( 'feat/x' === ( $pr_body['head'] ?? '' ) && 'main' === ( $pr_body['base'] ?? '' ), 'PR body has head/base', $failures, $passes );

$issue = $tools->build_create_issue( array( 'repo' => 'Automattic/wp-codebox', 'title' => 'Bug', 'labels' => array( 'bug' ) ) );
assert_true( 'https://api.github.com/repos/Automattic/wp-codebox/issues' === ( $issue['url'] ?? '' ), 'issue request targets the issues endpoint', $failures, $passes );

$comment = $tools->build_comment_pull_request( array( 'repo' => 'Automattic/wp-codebox', 'number' => 42, 'body' => 'LGTM' ) );
assert_true( 'https://api.github.com/repos/Automattic/wp-codebox/issues/42/comments' === ( $comment['url'] ?? '' ), 'PR comment targets the issue-comments endpoint', $failures, $passes );

// Missing-token failure surfaces (does not silently no-op).
putenv( 'GITHUB_TOKEN' );
putenv( 'GH_TOKEN' );
$no_token = $tools->build_create_issue( array( 'repo' => 'Automattic/wp-codebox', 'title' => 'X' ) );
assert_true( empty( $no_token['success'] ) && 'wp_codebox_runner_workspace_github_token_missing' === ( $no_token['error']['code'] ?? '' ), 'missing GitHub token is surfaced, not faked', $failures, $passes );

// ---------------------------------------------------------------------------
// Executor: target_id resolution + workspace-root binding (no DMC)
// ---------------------------------------------------------------------------
assert_true( WP_Codebox_Runner_Workspace_Executor::TARGET_ID === 'wp-codebox/runner-workspace', 'executor exposes its target id', $failures, $passes );

$executor = new WP_Codebox_Runner_Workspace_Executor();

// Resolve root from explicit parameter.
$exec_read = $executor->execute_tool( 'workspace-read', array( 'path' => 'src/app.php', 'workspace_root' => $root ) );
assert_true( ! empty( $exec_read['success'] ) && str_contains( (string) $exec_read['content'], 'gamma marker' ), 'executor binds tool to workspace root (explicit param)', $failures, $passes );

// Resolve root from sandbox_workspace context mounts (readwrite mount target).
$context = array( 'sandbox_workspace' => array( 'mounts' => array( array( 'mode' => 'readwrite', 'target' => $root ) ) ) );
$exec_status = $executor->execute_tool( 'workspace-git-status', array(), $context );
assert_true( ! empty( $exec_status['success'] ) && 'main' === ( $exec_status['branch'] ?? '' ), 'executor resolves root from client context', $failures, $passes );

// Namespaced tool name is accepted.
$exec_ns = $executor->execute_tool( 'wp-codebox/workspace-ls', array( 'path' => 'src', 'workspace_root' => $root ) );
assert_true( ! empty( $exec_ns['success'] ), 'executor accepts namespaced tool names', $failures, $passes );

// Unknown tool is rejected.
$exec_unknown = $executor->execute_tool( 'not-a-tool', array( 'workspace_root' => $root ) );
assert_true( empty( $exec_unknown['success'] ) && 'wp_codebox_runner_workspace_unknown_tool' === ( $exec_unknown['error']['code'] ?? '' ), 'executor rejects unknown tools', $failures, $passes );

// Missing workspace root is rejected.
$exec_no_root = $executor->execute_tool( 'workspace-read', array( 'path' => 'src/app.php' ) );
assert_true( empty( $exec_no_root['success'] ) && 'wp_codebox_runner_workspace_root_unavailable' === ( $exec_no_root['error']['code'] ?? '' ), 'executor requires a workspace root', $failures, $passes );

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
if ( array() !== $failures ) {
	fwrite( STDERR, sprintf( "\n%d passed, %d FAILED\n", $passes, count( $failures ) ) );
	exit( 1 );
}

fwrite( STDOUT, sprintf( "ok - runner workspace tools: %d assertions passed\n", $passes ) );
exit( 0 );
