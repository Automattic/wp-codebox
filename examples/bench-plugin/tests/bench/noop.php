<?php

return static function (): array {
	$response = rest_do_request( new WP_REST_Request( 'GET', '/wp-codebox-bench/v1/value' ) );
	$data     = rest_get_server()->response_to_data( $response, false );

	return array(
		'metrics'  => array(
			'fixture_value'      => wp_codebox_bench_plugin_value(),
			'rest_route_visible' => isset( $data['value'] ) && 7 === (int) $data['value'] ? 1 : 0,
		),
		'metadata' => array(
			'fixture' => 'bench-plugin',
		),
	);
};
