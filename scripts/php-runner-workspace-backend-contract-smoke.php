<?php

define( 'ABSPATH', __DIR__ );

require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-runner-workspace-adapter.php';

function assert_same( mixed $expected, mixed $actual, string $label ): void {
	if ( $expected !== $actual ) {
		fwrite( STDERR, $label . ' failed: expected ' . var_export( $expected, true ) . ', got ' . var_export( $actual, true ) . PHP_EOL );
		exit( 1 );
	}
}

function assert_empty_list( array $actual, string $label ): void {
	if ( array() !== $actual ) {
		fwrite( STDERR, $label . ' failed: expected no issues, got ' . var_export( $actual, true ) . PHP_EOL );
		exit( 1 );
	}
}

$schema = WP_Codebox_Runner_Workspace_Adapter::backend_schema();
assert_same( 'wp-codebox/runner-workspace-backend/v1', $schema['$id'], 'backend schema id' );
assert_same( 'wp-codebox/runner-workspace-backend/v1', $schema['properties']['schema']['const'], 'backend schema const' );
assert_same( 1, $schema['properties']['version']['const'], 'backend schema version const' );

$valid = array(
	'schema'    => 'wp-codebox/runner-workspace-backend/v1',
	'version'   => 1,
	'id'        => 'example-backend',
	'abilities' => array(
		'workspace_adopt'              => 'example-workspace/adopt',
		'workspace_show'               => 'example-workspace/show',
		'workspace_clone'              => 'example-workspace/clone',
		'workspace_worktree_add'       => 'example-workspace/worktree-add',
		'workspace_git_status'         => 'example-workspace/git-status',
		'workspace_git_diff'           => 'example-workspace/git-diff',
		'run_runner_workspace_command' => 'example-workspace/run-command',
		'publish_runner_workspace'     => 'example-workspace/publish',
	),
);
assert_empty_list( WP_Codebox_Runner_Workspace_Adapter::backend_config_issues( $valid ), 'valid backend config' );

$legacy_without_schema = $valid;
unset( $legacy_without_schema['schema'], $legacy_without_schema['version'] );
assert_empty_list( WP_Codebox_Runner_Workspace_Adapter::backend_config_issues( $legacy_without_schema ), 'legacy backend config without schema' );

$invalid = $valid;
$invalid['schema'] = 'example/backend/v1';
$invalid['abilities']['workspace_show'] = 'not a namespaced ability';
$invalid['abilities']['unknown_operation'] = 'example-workspace/unknown';
$issues = WP_Codebox_Runner_Workspace_Adapter::backend_config_issues( $invalid );
assert_same( 'schema', $issues[0]['field'], 'invalid schema issue field' );
assert_same( 'abilities.workspace_show', $issues[1]['field'], 'invalid ability issue field' );
assert_same( 'abilities.unknown_operation', $issues[2]['field'], 'unknown operation issue field' );

fwrite( STDOUT, "PHP runner workspace backend contract smoke passed\n" );
