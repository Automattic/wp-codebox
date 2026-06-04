<?php
/**
 * Plugin Name: Bench Dependency
 * Description: Fixture dependency for WP Codebox bench command smoke tests.
 * Version: 0.1.0
 */

defined( 'ABSPATH' ) || exit;

$GLOBALS['wp_codebox_bench_dependency_boot'] = array(
	'plugins_loaded_callbacks' => 0,
	'init_callbacks'           => 0,
);

add_action(
	'plugins_loaded',
	static function (): void {
		$GLOBALS['wp_codebox_bench_dependency_boot']['plugins_loaded_callbacks']++;
	}
);

add_action(
	'init',
	static function (): void {
		$GLOBALS['wp_codebox_bench_dependency_boot']['init_callbacks']++;
	}
);

function wp_codebox_bench_dependency_value(): int {
	return 11;
}
