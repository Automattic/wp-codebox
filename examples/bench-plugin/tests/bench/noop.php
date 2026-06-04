<?php

return static function (): array {
	$response = rest_do_request( new WP_REST_Request( 'GET', '/wp-codebox-bench/v1/value' ) );
	$data     = rest_get_server()->response_to_data( $response, false );

	return array(
		'metrics'  => array(
			'fixture_value'                 => wp_codebox_bench_plugin_value(),
			'dependency_value'              => wp_codebox_bench_dependency_value(),
			'dependency_active'             => is_plugin_active( 'bench-dependency/dependency-main.php' ) ? 1 : 0,
			'dependency_plugins_loaded_callback_count' => (int) $GLOBALS['wp_codebox_bench_dependency_boot']['plugins_loaded_callbacks'],
			'dependency_init_callback_count'           => (int) $GLOBALS['wp_codebox_bench_dependency_boot']['init_callbacks'],
			'rest_route_visible'            => isset( $data['value'] ) && 7 === (int) $data['value'] ? 1 : 0,
			'included_before_plugins_loaded' => 0 === (int) $GLOBALS['wp_codebox_bench_plugin_boot']['plugins_loaded_at_include'] ? 1 : 0,
			'included_before_init'           => 0 === (int) $GLOBALS['wp_codebox_bench_plugin_boot']['init_at_include'] ? 1 : 0,
			'plugins_loaded_callback_count'  => (int) $GLOBALS['wp_codebox_bench_plugin_boot']['plugins_loaded_callbacks'],
			'init_callback_count'            => (int) $GLOBALS['wp_codebox_bench_plugin_boot']['init_callbacks'],
		),
		'metadata' => array(
			'fixture' => 'bench-plugin',
		),
	);
};
