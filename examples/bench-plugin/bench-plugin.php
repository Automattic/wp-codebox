<?php
/**
 * Plugin Name: Bench Plugin
 * Description: Fixture plugin for WP Codebox bench command smoke tests.
 * Version: 0.1.0
 */

defined( 'ABSPATH' ) || exit;

function wp_codebox_bench_plugin_value(): int {
	return 7;
}

add_action(
	'rest_api_init',
	static function (): void {
		register_rest_route(
			'wp-codebox-bench/v1',
			'/value',
			array(
				'methods'             => 'GET',
				'callback'            => static fn (): array => array( 'value' => wp_codebox_bench_plugin_value() ),
				'permission_callback' => '__return_true',
			)
		);
	}
);
