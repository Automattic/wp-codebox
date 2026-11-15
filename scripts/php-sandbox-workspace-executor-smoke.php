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

	$baseline = sys_get_temp_dir() . '/wp-codebox-sandbox-baseline-' . bin2hex( random_bytes( 6 ) );
	mkdir( $baseline, 0755, true );
	copy( $root_real . '/README.md', $baseline . '/README.md' );
	mkdir( $baseline . '/src', 0755, true );
	copy( $root_real . '/src/app.php', $baseline . '/src/app.php' );
	$context  = array( 'workspace_root' => $root_real, 'workspace_baseline_root' => $baseline, 'writable_paths' => array( 'src/**', 'notes/**', 'patch-target.txt', 'created/**' ) );
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

	WP_Codebox_Sandbox_Workspace_Executor::reset_mutation_ledger();

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
	$unwritable = $call( 'workspace_write', array( 'path' => 'README.md', 'content' => 'blocked' ) );
	assert_true( false === $unwritable['success'] && 'writable_path_denied' === $unwritable['error_type'], 'write rejects paths outside writable policy' );

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
	$status = $call( 'workspace_git_status', array() );
	assert_true( true === $status['success'] && $status['result']['changed'], 'status compares sandbox workspace to baseline without git' );
	$diff = $call( 'workspace_git_diff', array() );
	assert_true( true === $diff['success'] && str_contains( $diff['result']['diff'], 'patch-target.txt' ), 'diff returns baseline patch without git' );
	$show = $call( 'workspace_show', array() );
	assert_true( '/workspace' === $show['result']['root'], 'show redacts host workspace root' );

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

	$tools = WP_Codebox_Sandbox_Workspace_Executor::tool_declarations_for_enabled_tools(
		array( 'enabled_tools' => array( 'workspace_read', 'workspace_edit', 'workspace_worktree_add' ) )
	);
	assert_true( array( 'workspace_read', 'workspace_edit' ) === array_keys( $tools ), 'only enabled canonical workspace tools are declared' );
	foreach ( $tools as $tool_name => $tool ) {
		assert_true( $tool_name === $tool['name'], "{$tool_name} has a canonical name" );
		assert_true( 'wp-codebox/sandbox-workspace' === $tool['runtime']['executor_target'], "{$tool_name} routes to sandbox executor target" );
		assert_true( isset( $tool['parameters']['properties'] ), "{$tool_name} includes a parameter schema" );
	}

	// --- mutation ledger (issue #2567) -------------------------------
	// Content-free record of write attempts lets the host tell a lost write
	// from a rejected or never-attempted one.
	$ledger = WP_Codebox_Sandbox_Workspace_Executor::mutation_ledger();
	assert_true( 'wp-codebox/sandbox-workspace-mutations/v1' === $ledger['schema'], 'ledger carries its schema' );
	$ledger_tools = array_values( array_unique( array_column( $ledger['calls'], 'tool' ) ) );
	assert_true( array() === array_diff( $ledger_tools, array( 'workspace_write', 'workspace_edit', 'workspace_apply_patch' ) ), 'ledger records mutation tools only' );
	assert_true( array( 'tool' => 'workspace_write', 'status' => 'succeeded', 'paths' => array( 'notes/todo.txt' ) ) === $ledger['calls'][0], 'ledger records a successful write with its path' );
	$denied = array_values( array_filter( $ledger['calls'], static fn( array $entry ): bool => 'writable_path_denied' === ( $entry['error_type'] ?? '' ) ) );
	assert_true( 1 <= count( $denied ) && 'failed' === $denied[0]['status'] && array( 'README.md' ) === $denied[0]['paths'], 'ledger records a rejected write with its path and reason' );
	$patched = array_values( array_filter( $ledger['calls'], static fn( array $entry ): bool => 'workspace_apply_patch' === $entry['tool'] && 'succeeded' === $entry['status'] ) );
	assert_true( array( 'patch-target.txt' ) === $patched[0]['paths'], 'ledger records apply-patch changed files' );
	assert_true( ! str_contains( (string) json_encode( $ledger ), 'line1' ), 'ledger never records file contents' );
	WP_Codebox_Sandbox_Workspace_Executor::reset_mutation_ledger();
	assert_true( array() === WP_Codebox_Sandbox_Workspace_Executor::mutation_ledger()['calls'], 'ledger resets between runs' );

	// --- nested writable globs (issue #2567) --------------------------
	$nested_context = array( 'workspace_root' => $root_real, 'writable_paths' => array( 'plugins/extrachill-shop/docs/user/**' ) );
	$nested_write   = $executor->executeWP_Agent_Tool_Call(
		array( 'tool_name' => 'workspace_write', 'parameters' => array( 'path' => 'plugins/extrachill-shop/docs/user/getting-started.md', 'content' => "nested\n" ) ),
		array( 'name' => 'workspace_write' ),
		$nested_context
	);
	assert_true( true === $nested_write['success'] && is_file( $root_real . '/plugins/extrachill-shop/docs/user/getting-started.md' ), 'nested writable glob accepts a new file in a new directory' );
	$nested_sibling = $executor->executeWP_Agent_Tool_Call(
		array( 'tool_name' => 'workspace_write', 'parameters' => array( 'path' => 'plugins/extrachill-shop/docs/admin.md', 'content' => 'x' ) ),
		array( 'name' => 'workspace_write' ),
		$nested_context
	);
	assert_true( false === $nested_sibling['success'] && 'writable_path_denied' === $nested_sibling['error_type'], 'nested writable glob rejects siblings outside the subtree' );

	// Writable-path matching mirrors runtime-core writablePathMatches so the
	// host apply gate never drops a change the sandbox accepted.
	foreach ( array(
		array( 'plugins/extrachill-shop/docs/user/a.md', 'plugins/extrachill-shop/docs/user/**', true ),
		array( 'plugins/extrachill-shop/docs/user/x/a.md', 'plugins/extrachill-shop/docs/user/**', true ),
		array( 'plugins/extrachill-shop/docs/user', 'plugins/extrachill-shop/docs/user/**', true ),
		array( 'plugins/extrachill-shop/docs/a.md', 'plugins/extrachill-shop/docs/user/**', false ),
		array( 'plugins/extrachill-shop/docs/userx/a.md', 'plugins/extrachill-shop/docs/user/**', false ),
		array( 'docs/user/a.md', './docs/user/**', true ),
		array( 'docs/user/a.md', '/docs/user/', true ),
		array( 'docs/a.md', 'docs/**/*.md', true ),
		array( 'docs/x/y/a.md', 'docs/**/*.md', true ),
		array( 'docs/x/y/a.txt', 'docs/**/*.md', false ),
		array( 'plugins/foo/docs/user/a.md', 'plugins/*/docs/user/**', true ),
		array( 'plugins/foo/bar/docs/user/a.md', 'plugins/*/docs/user/**', false ),
		array( 'docs/user/a.md', 'docs/user/*.md', true ),
		array( 'docs/user/x/a.md', 'docs/user/*.md', false ),
		array( 'docs/a.md', 'docs/[!b]*.md', true ),
		array( 'docs/b.md', 'docs/[!b]*.md', false ),
		array( 'README.md', 'README.md', true ),
		array( 'README.md.bak', 'README.md', false ),
		array( 'anything.md', '.', false ),
	) as list( $path, $pattern, $expected ) ) {
		assert_true( $expected === WP_Codebox_Sandbox_Workspace_Executor::writable_pattern_matches( $path, $pattern ), "writable pattern parity: {$path} vs {$pattern}" );
	}

	// -----------------------------------------------------------------
	// Production shape: the seeded sandbox snapshot excludes .git and the host
	// supplies no filesystem baseline. Status/diff must still work against the
	// seed state, captured before each file's first mutation (wp-codebox#2591).
	// -----------------------------------------------------------------
	$seed_root = sys_get_temp_dir() . '/wp-codebox-sandbox-seed-' . bin2hex( random_bytes( 6 ) );
	mkdir( $seed_root . '/docs', 0755, true );
	$guide_lines = array();
	for ( $line = 1; $line <= 40; ++$line ) {
		$guide_lines[] = "Line {$line} of the guide.";
	}
	$guide = implode( "\n", $guide_lines ) . "\n";
	file_put_contents( $seed_root . '/docs/guide.md', $guide );
	file_put_contents( $seed_root . '/docs/old.md', "# Old\n" );
	file_put_contents( $seed_root . '/docs/untouched.md', "# Untouched\n" );
	$seed_real    = (string) realpath( $seed_root );
	$seed_context = array( 'workspace_root' => $seed_real, 'writable_paths' => array( 'docs/**' ) );
	$seed_call    = static function ( string $tool_name, array $parameters ) use ( $executor, $seed_context ): array {
		return $executor->executeWP_Agent_Tool_Call( array( 'tool_name' => $tool_name, 'parameters' => $parameters ), array( 'name' => $tool_name ), $seed_context );
	};
	WP_Codebox_Sandbox_Workspace_Executor::reset_mutation_ledger();

	$clean = $seed_call( 'workspace_git_status', array() );
	assert_true( true === $clean['success'], 'seed status succeeds without .git or a filesystem baseline' );
	assert_true( false === $clean['result']['changed'] && array() === $clean['result']['files'], 'seed status is clean before any mutation' );
	assert_true( 'seed' === $clean['result']['baseline'], 'seed status reports the seed baseline' );
	$clean_diff = $seed_call( 'workspace_git_diff', array() );
	assert_true( true === $clean_diff['success'] && '' === $clean_diff['result']['diff'], 'seed diff is empty before any mutation' );

	$seed_call( 'workspace_edit', array( 'path' => 'docs/guide.md', 'old_string' => 'Line 20 of the guide.', 'new_string' => 'Line twenty of the guide.' ) );
	$seed_call( 'workspace_edit', array( 'path' => 'docs/guide.md', 'old_string' => 'Line 21 of the guide.', 'new_string' => "Line 21 of the guide.\nAn added line." ) );
	$seed_call( 'workspace_write', array( 'path' => 'docs/new.md', 'content' => "# New\n" ) );
	$seed_call( 'workspace_apply_patch', array( 'patch' => "--- a/docs/old.md\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-# Old\n" ) );
	$seed_call( 'workspace_write', array( 'path' => 'docs/untouched.md', 'content' => "# Untouched\n" ) );
	$failed_edit = $seed_call( 'workspace_edit', array( 'path' => 'docs/untouched.md', 'old_string' => 'missing', 'new_string' => 'x' ) );
	assert_true( false === $failed_edit['success'], 'failed edit stays failed' );

	$seed_status = $seed_call( 'workspace_git_status', array() );
	assert_true( true === $seed_status['success'], 'seed status succeeds after mutations' );
	assert_true( array( 'docs/guide.md', 'docs/new.md', 'docs/old.md' ) === $seed_status['result']['files'], 'seed status lists modified, added, and deleted files; rewrites with identical content are clean' );
	assert_true(
		array(
			array( 'path' => 'docs/guide.md', 'status' => 'modified' ),
			array( 'path' => 'docs/new.md', 'status' => 'added' ),
			array( 'path' => 'docs/old.md', 'status' => 'deleted' ),
		) === $seed_status['result']['changes'],
		'seed status classifies each change'
	);
	assert_true( array( 'added' => 1, 'modified' => 1, 'deleted' => 1 ) === $seed_status['result']['summary'], 'seed status summarizes change counts' );

	$seed_diff = $seed_call( 'workspace_git_diff', array() );
	assert_true( true === $seed_diff['success'], 'seed diff succeeds after mutations' );
	$diff_text = $seed_diff['result']['diff'];
	assert_true( str_contains( $diff_text, "--- a/docs/guide.md\n+++ b/docs/guide.md\n@@ -17,8 +17,9 @@\n" ), 'seed diff emits a context hunk, not a whole-file rewrite' );
	assert_true( str_contains( $diff_text, "-Line 20 of the guide.\n+Line twenty of the guide.\n Line 21 of the guide.\n+An added line.\n" ), 'seed diff shows the exact changed lines' );
	assert_true( ! str_contains( $diff_text, 'Line 1 of the guide.' ) && ! str_contains( $diff_text, 'Line 40 of the guide.' ), 'seed diff omits unchanged lines outside context' );
	assert_true( str_contains( $diff_text, "--- /dev/null\n+++ b/docs/new.md\n@@ -0,0 +1,1 @@\n+# New\n" ), 'seed diff shows added files' );
	assert_true( str_contains( $diff_text, "--- a/docs/old.md\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-# Old\n" ), 'seed diff shows deleted files' );

	$one_diff = $seed_call( 'workspace_git_diff', array( 'path' => 'docs/new.md' ) );
	assert_true( array( 'docs/new.md' ) === $one_diff['result']['files'] && ! str_contains( $one_diff['result']['diff'], 'guide.md' ), 'seed diff honors the optional path filter' );

	// The seed diff is a valid patch: reverting it onto a fresh seed copy reproduces the edited workspace.
	$replay_root = sys_get_temp_dir() . '/wp-codebox-sandbox-replay-' . bin2hex( random_bytes( 6 ) );
	mkdir( $replay_root . '/docs', 0755, true );
	file_put_contents( $replay_root . '/docs/guide.md', $guide );
	file_put_contents( $replay_root . '/docs/old.md', "# Old\n" );
	$replay_real    = (string) realpath( $replay_root );
	$replay_context = array( 'workspace_root' => $replay_real, 'writable_paths' => array( 'docs/**' ) );
	$replayed       = $executor->executeWP_Agent_Tool_Call( array( 'tool_name' => 'workspace_apply_patch', 'parameters' => array( 'patch' => $diff_text ) ), array( 'name' => 'workspace_apply_patch' ), $replay_context );
	assert_true( true === $replayed['success'], 'seed diff applies cleanly as a patch' );
	assert_true( file_get_contents( $seed_real . '/docs/guide.md' ) === file_get_contents( $replay_real . '/docs/guide.md' ), 'replayed seed diff reproduces the edited file' );
	assert_true( is_file( $replay_real . '/docs/new.md' ) && ! is_file( $replay_real . '/docs/old.md' ), 'replayed seed diff reproduces adds and deletes' );

	WP_Codebox_Sandbox_Workspace_Executor::reset_mutation_ledger();
	$after_reset = $seed_call( 'workspace_git_status', array() );
	assert_true( false === $after_reset['result']['changed'], 'reset clears the seed baseline for the next run' );

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
	$rrmdir( $baseline );
	$rrmdir( $seed_real );
	$rrmdir( $replay_real );

	fwrite( STDOUT, "OK php-sandbox-workspace-executor-smoke\n" );
}
