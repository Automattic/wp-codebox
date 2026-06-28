<?php
/**
 * Deterministic contract test for the git-less sandbox-workspace executor.
 *
 * Proves the six file tools (read/ls/grep/write/edit/apply-patch) operate on a
 * bounded sandbox working root, that path-escape attempts are rejected, and that
 * the tool surface resolves through the Agents API executor `target_id`.
 */

declare(strict_types=1);

// -----------------------------------------------------------------
// Minimal Agents API substrate so the executor registers + dispatches.
// -----------------------------------------------------------------
namespace AgentsAPI\AI\Tools {
	interface WP_Agent_Tool_Executor {
		/**
		 * @param array<string,mixed> $tool_call Tool call.
		 * @param array<string,mixed> $tool_definition Tool declaration.
		 * @param array<string,mixed> $context Runtime context.
		 * @return array<string,mixed>
		 */
		public function executeWP_Agent_Tool_Call( array $tool_call, array $tool_definition, array $context = array() ): array;
	}

	class WP_Agent_Tool_Source_Registry {}
}

namespace {

	error_reporting( E_ALL );
	define( 'ABSPATH', __DIR__ . '/' );

	$GLOBALS['wp_codebox_test_filters'] = array();

	function add_filter( string $hook, callable $callback, int $priority = 10, int $accepted_args = 1 ): bool {
		$GLOBALS['wp_codebox_test_filters'][ $hook ][] = $callback;
		return true;
	}

	function apply_filters( string $hook, mixed $value, mixed ...$args ): mixed {
		foreach ( $GLOBALS['wp_codebox_test_filters'][ $hook ] ?? array() as $callback ) {
			$value = $callback( $value, ...$args );
		}
		return $value;
	}

	function wp_json_encode( mixed $value ): string|false {
		return json_encode( $value );
	}

	function assert_true( bool $condition, string $message ): void {
		if ( ! $condition ) {
			fwrite( STDERR, "FAIL: {$message}\n" );
			exit( 1 );
		}
	}

	require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-sandbox-workspace-executor.php';

	// -----------------------------------------------------------------
	// Build a bounded sandbox working root with seed content.
	// -----------------------------------------------------------------
	$root = sys_get_temp_dir() . '/wp-codebox-sandbox-' . bin2hex( random_bytes( 6 ) );
	mkdir( $root . '/src', 0755, true );
	file_put_contents( $root . '/src/app.php', "<?php\n// alpha\necho 'hello';\n// beta\n" );
	file_put_contents( $root . '/README.md', "# Title\n\nNeedle line here.\n" );
	$root_real = realpath( $root );
	assert_true( is_string( $root_real ), 'working root realpath resolves' );

	$context  = array( 'workspace_root' => $root_real );
	$executor = new WP_Codebox_Sandbox_Workspace_Executor();

	/**
	 * Invoke a tool the way the mediation runner would: by tool_name + parameters.
	 *
	 * @param array<string,mixed> $parameters Tool parameters.
	 * @return array<string,mixed>
	 */
	$call = static function ( string $tool_name, array $parameters ) use ( $executor, $context ): array {
		return $executor->executeWP_Agent_Tool_Call(
			array( 'tool_name' => $tool_name, 'parameters' => $parameters ),
			array( 'name' => $tool_name ),
			$context
		);
	};

	// --- write -------------------------------------------------------
	$write = $call( 'workspace_write', array( 'path' => 'notes/todo.txt', 'content' => "line1\nline2\n" ) );
	assert_true( true === $write['success'], 'write succeeds' );
	assert_true( true === $write['result']['created'], 'write reports created' );
	assert_true( 12 === $write['result']['size'], 'write reports byte size' );
	assert_true( 'wp-codebox/sandbox-workspace' === $write['runtime']['executor_target'], 'write carries executor target' );
	assert_true( is_file( $root_real . '/notes/todo.txt' ), 'write created the file on disk' );

	// --- read --------------------------------------------------------
	$read = $call( 'workspace_read', array( 'path' => 'notes/todo.txt' ) );
	assert_true( true === $read['success'], 'read succeeds' );
	assert_true( "line1\nline2\n" === $read['result']['content'], 'read returns written content' );
	assert_true( 3 === $read['result']['lines_read'], 'read counts lines incl trailing newline' );

	$read_slice = $call( 'workspace_read', array( 'path' => 'src/app.php', 'offset' => 2, 'limit' => 2 ) );
	assert_true( "// alpha\necho 'hello';" === $read_slice['result']['content'], 'read offset/limit slices lines' );
	assert_true( 2 === $read_slice['result']['offset'], 'read slice reports start offset' );

	// --- ls ----------------------------------------------------------
	$ls = $call( 'workspace_ls', array() );
	$names = array_map( static fn( array $e ): string => $e['name'], $ls['result']['entries'] );
	assert_true( in_array( 'src', $names, true ), 'ls lists src dir' );
	assert_true( in_array( 'README.md', $names, true ), 'ls lists README' );
	assert_true( in_array( 'notes', $names, true ), 'ls lists newly written dir' );
	assert_true( 'directory' === $ls['result']['entries'][0]['type'], 'ls sorts directories first' );

	$ls_sub = $call( 'workspace_ls', array( 'path' => 'src' ) );
	$sub_names = array_map( static fn( array $e ): string => $e['name'], $ls_sub['result']['entries'] );
	assert_true( array( 'app.php' ) === $sub_names, 'ls of subdir lists its file' );

	// --- grep --------------------------------------------------------
	$grep = $call( 'workspace_grep', array( 'pattern' => 'Needle' ) );
	assert_true( true === $grep['success'], 'grep succeeds' );
	assert_true( 1 === $grep['result']['count'], 'grep finds one match' );
	assert_true( 'README.md' === $grep['result']['matches'][0]['path'], 'grep reports relative path' );
	assert_true( 3 === $grep['result']['matches'][0]['line'], 'grep reports line number' );

	$grep_inc = $call( 'workspace_grep', array( 'pattern' => 'echo', 'include' => '*.php' ) );
	assert_true( 1 === $grep_inc['result']['count'], 'grep include glob filters to php' );

	$grep_ctx = $call( 'workspace_grep', array( 'pattern' => 'alpha', 'path' => 'src/app.php', 'context_lines' => 1 ) );
	assert_true( 3 === count( $grep_ctx['result']['matches'][0]['context'] ), 'grep returns context window' );

	// --- edit --------------------------------------------------------
	$edit = $call( 'workspace_edit', array( 'path' => 'src/app.php', 'old_string' => "echo 'hello';", 'new_string' => "echo 'world';" ) );
	assert_true( true === $edit['success'], 'edit succeeds' );
	assert_true( 1 === $edit['result']['replacements'], 'edit reports one replacement' );
	assert_true( str_contains( file_get_contents( $root_real . '/src/app.php' ), "echo 'world';" ), 'edit changed the file' );

	$edit_ambiguous = $call( 'workspace_edit', array( 'path' => 'src/app.php', 'old_string' => '//' ) );
	assert_true( false === $edit_ambiguous['success'], 'edit fails closed on ambiguous match' );
	assert_true( 'ambiguous_match' === $edit_ambiguous['error_type'], 'edit ambiguity error type' );

	$edit_all = $call( 'workspace_edit', array( 'path' => 'src/app.php', 'old' => '//', 'new' => '#', 'replace_all' => true ) );
	assert_true( 2 === $edit_all['result']['replacements'], 'edit replace_all counts every occurrence' );

	// --- apply-patch (modify) ---------------------------------------
	file_put_contents( $root_real . '/patch-target.txt', "one\ntwo\nthree\n" );
	$patch = "--- a/patch-target.txt\n+++ b/patch-target.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n";
	$applied = $call( 'workspace_apply_patch', array( 'patch' => $patch ) );
	assert_true( true === $applied['success'], 'apply-patch succeeds' );
	assert_true( array( 'patch-target.txt' ) === $applied['result']['changed_files'], 'apply-patch reports changed file' );
	assert_true( "one\nTWO\nthree\n" === file_get_contents( $root_real . '/patch-target.txt' ), 'apply-patch applied the hunk' );

	// --- apply-patch (create new file) ------------------------------
	$create_patch = "--- /dev/null\n+++ b/created/new.txt\n@@ -0,0 +1,2 @@\n+fresh\n+content\n";
	$created = $call( 'workspace_apply_patch', array( 'patch' => $create_patch ) );
	assert_true( true === $created['success'], 'apply-patch creates new file' );
	assert_true( "fresh\ncontent\n" === file_get_contents( $root_real . '/created/new.txt' ), 'apply-patch wrote new file content' );

	// --- apply-patch fails closed on context mismatch ----------------
	$bad_patch = "--- a/patch-target.txt\n+++ b/patch-target.txt\n@@ -1,3 +1,3 @@\n one\n-WRONG\n+x\n three\n";
	$bad = $call( 'workspace_apply_patch', array( 'patch' => $bad_patch ) );
	assert_true( false === $bad['success'], 'apply-patch fails closed on context mismatch' );
	assert_true( 'patch_context_mismatch' === $bad['error_type'], 'apply-patch mismatch error type' );
	assert_true( "one\nTWO\nthree\n" === file_get_contents( $root_real . '/patch-target.txt' ), 'apply-patch left file unchanged after failure' );

	// -----------------------------------------------------------------
	// Path-escape attempts are rejected across every mutating/reading tool.
	// -----------------------------------------------------------------
	foreach ( array(
		array( 'workspace_read', array( 'path' => '../escape.txt' ) ),
		array( 'workspace_write', array( 'path' => '../escape.txt', 'content' => 'x' ) ),
		array( 'workspace_ls', array( 'path' => '../..' ) ),
		array( 'workspace_edit', array( 'path' => '../escape.txt', 'old_string' => 'a', 'new_string' => 'b' ) ),
		array( 'workspace_read', array( 'path' => '/etc/hosts' ) ),
	) as $attempt ) {
		$result = $call( $attempt[0], $attempt[1] );
		assert_true( false === $result['success'], $attempt[0] . ' rejects path escape' );
		assert_true( in_array( $result['error_type'], array( 'path_escape', 'invalid_path', 'path_not_found' ), true ), $attempt[0] . ' returns containment error type' );
	}
	assert_true( ! file_exists( dirname( $root_real ) . '/escape.txt' ), 'no file escaped the working root' );

	// An apply-patch that targets outside the root must be rejected.
	$escape_patch = "--- /dev/null\n+++ b/../escape-via-patch.txt\n@@ -0,0 +1,1 @@\n+nope\n";
	$escape_patch_result = $call( 'workspace_apply_patch', array( 'patch' => $escape_patch ) );
	assert_true( false === $escape_patch_result['success'], 'apply-patch rejects path escape' );
	assert_true( ! file_exists( dirname( $root_real ) . '/escape-via-patch.txt' ), 'apply-patch did not escape the root' );

	// -----------------------------------------------------------------
	// The surface resolves through the Agents API executor target_id.
	// -----------------------------------------------------------------
	assert_true( 'wp-codebox/sandbox-workspace' === WP_Codebox_Sandbox_Workspace_Executor::TARGET_ID, 'target id constant' );

	$registered = WP_Codebox_Sandbox_Workspace_Executor::register();
	assert_true( true === $registered, 'register returns true when substrate present' );

	$targets = apply_filters( 'agents_api_executor_targets', array() );
	assert_true( isset( $targets['wp-codebox/sandbox-workspace'] ), 'executor target registered under target_id' );
	assert_true( 'sandbox-workspace' === $targets['wp-codebox/sandbox-workspace']['kind'], 'target metadata kind' );

	$executors = apply_filters( 'agents_api_tool_executors', array() );
	assert_true( isset( $executors['wp-codebox/sandbox-workspace'] ), 'executor adapter registered under target_id' );
	assert_true( $executors['wp-codebox/sandbox-workspace'] instanceof AgentsAPI\AI\Tools\WP_Agent_Tool_Executor, 'executor satisfies the contract interface' );

	$dispatched = $executors['wp-codebox/sandbox-workspace']->executeWP_Agent_Tool_Call(
		array( 'tool_name' => 'client/workspace_read', 'parameters' => array( 'path' => 'README.md' ) ),
		array( 'name' => 'client/workspace_read' ),
		$context
	);
	assert_true( true === $dispatched['success'], 'registered executor dispatches client/-prefixed tool name' );
	assert_true( str_contains( $dispatched['result']['content'], 'Needle' ), 'registered executor returns file content' );

	$sources = apply_filters( 'agents_api_tool_sources', array() );
	assert_true( isset( $sources['client'] ), 'client tool source registered' );
	$tools = $sources['client']();
	foreach ( array( 'client/workspace_read', 'client/workspace_ls', 'client/workspace_grep', 'client/workspace_write', 'client/workspace_edit', 'client/workspace_apply_patch' ) as $tool_name ) {
		assert_true( isset( $tools[ $tool_name ] ), "tool source declares {$tool_name}" );
		assert_true( 'wp-codebox/sandbox-workspace' === $tools[ $tool_name ]['runtime']['executor_target'], "{$tool_name} routes to sandbox executor target" );
		assert_true( 'client' === $tools[ $tool_name ]['executor'], "{$tool_name} is a client-executed tool" );
	}

	// Cleanup.
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
	$rrmdir( $root_real );

	fwrite( STDOUT, "OK php-sandbox-workspace-executor-smoke\n" );
}
