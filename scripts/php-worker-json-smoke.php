<?php

declare(strict_types=1);

define( 'ABSPATH', __DIR__ );

require_once dirname( __DIR__ ) . '/packages/wordpress-plugin/src/class-wp-codebox-browser-runner-template.php';

function smoke_assert( bool $condition, string $message ): void {
	if ( ! $condition ) {
		fwrite( STDERR, $message . PHP_EOL );
		exit( 1 );
	}
}

$temp_dir = sys_get_temp_dir() . '/wp-codebox-worker-json-' . bin2hex( random_bytes( 4 ) );
$task_path = $temp_dir . '/nested/task.json';
$result_path = $temp_dir . '/nested/result.json';

eval( WP_Codebox_Browser_Runner_Template::worker_json_fragment() );

smoke_assert( null === wp_codebox_worker_json_read_array_file( $task_path ), 'missing task file returns null' );
smoke_assert( wp_codebox_worker_json_write_file( $task_path, array( 'goal' => 'Override', 'nested' => array( 'right' => true ) ) ), 'task file writes JSON' );

$merged = wp_codebox_worker_json_merge_file( $task_path, array( 'goal' => 'Default', 'nested' => array( 'left' => true ) ) );
smoke_assert( 'Override' === $merged['goal'], 'task file overrides defaults' );
smoke_assert( true === $merged['nested']['left'], 'recursive merge keeps defaults' );
smoke_assert( true === $merged['nested']['right'], 'recursive merge applies overrides' );

smoke_assert( wp_codebox_worker_json_write_file( $result_path, array( 'success' => true, 'schema' => 'example/v1' ) ), 'result file writes JSON' );
$result = wp_codebox_worker_json_read_array_file( $result_path );
smoke_assert( is_array( $result ) && true === $result['success'], 'result file reads JSON' );

file_put_contents( $task_path, '{not-json' );
$fallback = wp_codebox_worker_json_merge_file( $task_path, array( 'goal' => 'Fallback' ) );
smoke_assert( array( 'goal' => 'Fallback' ) === $fallback, 'invalid JSON preserves defaults' );

echo "worker JSON smoke passed\n";
