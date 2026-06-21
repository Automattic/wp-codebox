<?php
declare(strict_types=1);

define( 'ABSPATH', __DIR__ );

final class WP_Error {
	private string $code;
	private string $message;
	private mixed $data;

	public function __construct( string $code = '', string $message = '', mixed $data = null ) {
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

$GLOBALS['wp_codebox_test_abilities'] = array();
$GLOBALS['wp_codebox_test_filters']   = array();
$GLOBALS['wp_codebox_ability_calls']  = array();
$GLOBALS['wp_codebox_ability_lookups'] = array();

function add_filter( string $hook, callable $callback, int $priority = 10, int $accepted_args = 1 ): void {
	unset( $priority, $accepted_args );
	$GLOBALS['wp_codebox_test_filters'][ $hook ][] = $callback;
}

function apply_filters( string $hook, mixed $value, mixed ...$args ): mixed {
	foreach ( $GLOBALS['wp_codebox_test_filters'][ $hook ] ?? array() as $callback ) {
		$value = $callback( $value, ...$args );
	}

	return $value;
}

function wp_get_ability( string $name ): ?object {
	$GLOBALS['wp_codebox_ability_lookups'][] = $name;
	return $GLOBALS['wp_codebox_test_abilities'][ $name ] ?? null;
}

function register_test_ability( string $name, callable $callback ): void {
	$GLOBALS['wp_codebox_test_abilities'][ $name ] = new class( $name, $callback ) {
		public function __construct( private string $name, private mixed $callback ) {}

		public function execute( array $input ): mixed {
			$GLOBALS['wp_codebox_ability_calls'][] = array( 'name' => $this->name, 'input' => $input );
			return ( $this->callback )( $input );
		}
	};
}

function assert_same_contract( mixed $expected, mixed $actual, string $label ): void {
	if ( $expected !== $actual ) {
		fwrite( STDERR, $label . " failed.\nExpected: " . json_encode( $expected, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT ) . "\nActual: " . json_encode( $actual, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT ) . "\n" );
		exit( 1 );
	}
}

function assert_no_backend_leak( mixed $value, string $label ): void {
	$json = json_encode( $value, JSON_UNESCAPED_SLASHES );
	if ( ! is_string( $json ) || str_contains( $json, 'datamachine-code' ) ) {
		fwrite( STDERR, $label . " leaked backend identifiers.\nActual: " . json_encode( $value, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT ) . "\n" );
		exit( 1 );
	}
}

require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-abilities.php';

add_filter(
	'wp_codebox_runner_workspace_backend',
	// Private adapter mapping: Codebox calls its runner-workspace contract and this
	// test maps outward to a host ability registry. The host does not parse
	// Codebox sandbox tool policy schemas.
	static fn(): array => array(
		'id'        => 'datamachine-code',
		'abilities' => array(
			'workspace_adopt'                => 'datamachine-code/workspace-adopt',
			'workspace_show'                 => 'datamachine-code/workspace-show',
			'workspace_clone'                => 'datamachine-code/workspace-clone',
			'workspace_worktree_add'         => 'datamachine-code/workspace-worktree-add',
			'workspace_git_status'           => 'datamachine-code/workspace-git-status',
			'workspace_git_diff'             => 'datamachine-code/workspace-git-diff',
			'run_runner_workspace_command'   => 'datamachine-code/run-runner-workspace-command',
			'publish_runner_workspace'       => 'datamachine-code/publish-runner-workspace',
		),
	)
);

register_test_ability( 'datamachine-code/workspace-adopt', static fn( array $input ): array => array( 'success' => true, 'handle' => 'wp-codebox@task', 'path' => $input['path'] ) );
register_test_ability( 'datamachine-code/workspace-show', static fn(): WP_Error => new WP_Error( 'missing', 'not found' ) );
register_test_ability( 'datamachine-code/workspace-clone', static fn(): array => array( 'success' => true ) );
register_test_ability( 'datamachine-code/workspace-worktree-add', static fn( array $input ): array => array( 'success' => true, 'handle' => 'wp-codebox@task', 'path' => '/tmp/wp-codebox@task', 'branch' => $input['branch'] ) );
register_test_ability( 'datamachine-code/workspace-git-status', static fn(): array => array( 'success' => true, 'name' => 'wp-codebox@task', 'repo' => 'wp-codebox', 'files' => array( ' M src/keep.php', ' M vendor/skip.php' ) ) );
register_test_ability( 'datamachine-code/workspace-git-diff', static fn(): array => array( 'success' => true, 'diff' => "diff --git a/src/keep.php b/src/keep.php\n+keep\ndiff --git a/vendor/skip.php b/vendor/skip.php\n+skip\n" ) );
register_test_ability( 'datamachine-code/run-runner-workspace-command', static fn( array $input ): array => array( 'success' => true, 'command' => $input['command'], 'exit_code' => 0, 'stdout' => 'ok' ) );
register_test_ability( 'datamachine-code/publish-runner-workspace', static fn( array $input ): array => array( 'success' => true, 'workspace_handle' => $input['workspace_handle'], 'head' => 'agent/change', 'commit_sha' => 'abc123', 'pr_number' => 7, 'pr_url' => 'https://example.test/pr/7' ) );

$prepared = WP_Codebox_Abilities::prepare_runner_workspace( array( 'repo' => 'Automattic/wp-codebox', 'checkout_path' => '/tmp/checkout', 'branch' => 'agent/change' ) );
assert_same_contract( true, $prepared['success'], 'prepare success' );
assert_same_contract( 'wp-codebox/runner-workspace-prepare-result/v1', $prepared['schema'], 'prepare schema' );
assert_same_contract( 'wp-codebox@task', $prepared['handle'], 'prepare handle' );

$captured = WP_Codebox_Abilities::capture_runner_workspace( array( 'workspace' => 'wp-codebox@task', 'repo' => 'wp-codebox', 'exclude_paths' => array( 'vendor/**' ) ) );
assert_same_contract( true, $captured['success'], 'capture success' );
assert_same_contract( array( 'src/keep.php' ), $captured['status']['files'], 'capture excludes files' );
assert_same_contract( false, str_contains( $captured['diff']['diff'], 'vendor/skip.php' ), 'capture excludes diff section' );

$published = WP_Codebox_Abilities::publish_runner_workspace(
	array(
		'workspace'      => 'wp-codebox@task',
		'repo'           => 'wp-codebox',
		'commit_message' => 'Test change',
		'title'          => 'Test change',
		'body'           => 'Body',
	)
);
assert_same_contract( true, $published['success'], 'publish success' );
assert_same_contract( 7, $published['pull_request']['number'], 'publish PR number' );

$command = WP_Codebox_Abilities::run_runner_workspace_command( array( 'workspace' => 'wp-codebox@task', 'repo' => 'wp-codebox', 'command' => 'php -l file.php' ) );
assert_same_contract( true, $command['success'], 'command success' );
assert_same_contract( 'completed', $command['status'], 'command status' );

$GLOBALS['wp_codebox_test_abilities']['datamachine-code/workspace-git-status'] = new class() {
	public function execute( array $input ): WP_Error {
		unset( $input );
		return new WP_Error( 'datamachine-code/workspace-git-status', 'datamachine-code/workspace-git-status exploded', array( 'ability' => 'datamachine-code/workspace-git-status' ) );
	}
};

$failure = WP_Codebox_Abilities::capture_runner_workspace( array( 'workspace' => 'wp-codebox@task' ) );
assert_same_contract( false, $failure['success'], 'failure success' );
assert_same_contract( 'runner workspace backend exploded', $failure['error']['message'], 'public error redacts backend ability slug' );
assert_same_contract( false, array_key_exists( 'ability', $failure['error']['data'] ?? array() ), 'public error removes backend ability key' );
assert_no_backend_leak( $failure, 'wp error failure' );

$GLOBALS['wp_codebox_test_abilities']['datamachine-code/run-runner-workspace-command'] = new class() {
	public function execute( array $input ): array {
		unset( $input );
		return array(
			'success'      => false,
			'failure_type' => 'datamachine-code/run-runner-workspace-command',
			'error'        => array(
				'code'    => 'datamachine-code/run-runner-workspace-command',
				'message' => 'datamachine-code/run-runner-workspace-command failed',
				'data'    => array( 'backend_ability' => 'datamachine-code/run-runner-workspace-command' ),
			),
		);
	}
};

$backend_failure = WP_Codebox_Abilities::run_runner_workspace_command( array( 'workspace' => 'wp-codebox@task', 'repo' => 'wp-codebox', 'command' => 'php -l file.php' ) );
assert_same_contract( false, $backend_failure['success'], 'backend failure success' );
assert_same_contract( 'runner workspace backend', $backend_failure['failure_type'], 'backend failure type redacted' );
assert_no_backend_leak( $backend_failure, 'backend failure' );

$GLOBALS['wp_codebox_test_filters']['wp_codebox_runner_workspace_backend'] = array(
	static fn(): array => array(
		'id'        => 'datamachine-code',
		'abilities' => array(
			'run_runner_workspace_command' => 'datamachine-code',
		),
	),
);
$GLOBALS['wp_codebox_ability_lookups'] = array();

$invalid_map_failure = WP_Codebox_Abilities::run_runner_workspace_command( array( 'workspace' => 'wp-codebox@task', 'repo' => 'wp-codebox', 'command' => 'php -l file.php' ) );
assert_same_contract( false, $invalid_map_failure['success'], 'invalid map failure success' );
assert_same_contract( 'backend_unavailable', $invalid_map_failure['failure_type'], 'invalid map failure type' );
assert_same_contract( false, in_array( 'datamachine-code', $GLOBALS['wp_codebox_ability_lookups'], true ), 'invalid backend ability is not looked up' );
assert_no_backend_leak( $invalid_map_failure, 'invalid map failure' );

fwrite( STDOUT, "PHP runner workspace adapter boundary smoke passed\n" );
