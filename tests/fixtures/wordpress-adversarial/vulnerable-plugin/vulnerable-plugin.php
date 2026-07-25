<?php
/**
 * Plugin Name: WP Codebox Adversarial Vulnerable Fixture
 * Description: Intentionally vulnerable, neutral fixture for disposable runtime campaigns only.
 * Version: 0.0.0
 */

declare(strict_types=1);

add_action('rest_api_init', static function (): void {
	register_rest_route('wp-codebox-vulnerable/v1', '/authorization', array(
		'methods'             => 'POST',
		'permission_callback' => '__return_true', // Intentionally vulnerable: no authorization or nonce check.
		'callback'            => static function (WP_REST_Request $request): WP_REST_Response {
			update_option('wp_codebox_vulnerable_authorization', $request->get_json_params(), false);
			return new WP_REST_Response(array('saved' => true, 'violations' => array('authorization-bypass', 'nonce-bypass')));
		},
	));

	register_rest_route('wp-codebox-vulnerable/v1', '/injection', array(
		'methods'             => 'POST',
		'permission_callback' => '__return_true',
		'callback'            => static function (WP_REST_Request $request): WP_REST_Response {
			$expression = (string) $request->get_param('expression');
			// Intentionally vulnerable. This fixture is mounted only in a disposable, network-denied runtime.
			$result = eval('return ' . $expression . ';'); // phpcs:ignore Squiz.PHP.Eval.Discouraged
			return new WP_REST_Response(array('result' => $result, 'violations' => array('code-execution-indicator')));
		},
	));

	register_rest_route('wp-codebox-vulnerable/v1', '/partial-state', array(
		'methods'             => 'POST',
		'permission_callback' => '__return_true',
		'callback'            => static function (): WP_Error {
			update_option('wp_codebox_vulnerable_partial_state', 'committed-before-error', false);
			return new WP_Error('fixture_failure', 'The fixture failed after committing state.', array('status' => 500, 'violations' => array('partial-state-commit')));
		},
	));

	register_rest_route('wp-codebox-vulnerable/v1', '/race', array(
		'methods'             => 'POST',
		'permission_callback' => '__return_true',
		'callback'            => static function (): WP_REST_Response {
			$count = (int) get_option('wp_codebox_vulnerable_race_count', 0);
			usleep(50000); // Intentionally widens the read-modify-write race window.
			update_option('wp_codebox_vulnerable_race_count', $count + 1, false);
			return new WP_REST_Response(array('count' => $count + 1, 'violations' => array('lost-update-race')));
		},
	));

	register_rest_route('wp-codebox-vulnerable/v1', '/external-service', array(
		'methods'             => 'POST',
		'permission_callback' => '__return_true',
		'callback'            => static function (): WP_REST_Response {
			$response = wp_remote_get('https://fixture.invalid/authorize', array('timeout' => 1));
			if (is_wp_error($response)) {
				// Intentionally vulnerable: dependency failure is treated as authorization success.
				return new WP_REST_Response(array('authorized' => true, 'violations' => array('external-service-fail-open')));
			}
			return new WP_REST_Response(array('authorized' => 200 === wp_remote_retrieve_response_code($response)));
		},
	));
});

$wp_codebox_vulnerable_ajax = static function (): void {
	// Intentionally vulnerable: no check_ajax_referer() or capability check.
	update_option('wp_codebox_vulnerable_ajax', wp_unslash($_POST['value'] ?? ''), false);
	wp_send_json_success(array('violations' => array('ajax-nonce-bypass')));
};
add_action('wp_ajax_wp_codebox_vulnerable_save', $wp_codebox_vulnerable_ajax);
add_action('wp_ajax_nopriv_wp_codebox_vulnerable_save', $wp_codebox_vulnerable_ajax);

function wp_codebox_adversarial_vulnerable_xmlrpc($args): array {
	update_option('wp_codebox_vulnerable_xmlrpc', $args, false);
	return array('saved' => true, 'violations' => array('xmlrpc-authorization-bypass'));
}

add_filter('xmlrpc_methods', static function (array $methods): array {
	$methods['wpCodebox.vulnerable'] = 'wp_codebox_adversarial_vulnerable_xmlrpc';
	return $methods;
});

add_shortcode('wp_codebox_vulnerable', static function (array $attributes): string {
	// Intentionally vulnerable reflected markup for injection campaigns.
	return '<div class="wp-codebox-vulnerable">' . ($attributes['value'] ?? '') . '</div>';
});

add_action('admin_menu', static function (): void {
	add_management_page('Vulnerable Fixture', 'Vulnerable Fixture', 'read', 'wp-codebox-vulnerable', static function (): void {
		?>
		<div class="wrap"><h1>Vulnerable Fixture</h1>
			<button class="wp-codebox-vulnerable-save">Save once</button>
			<span class="spinner"></span><output class="wp-codebox-vulnerable-count">0</output>
		</div>
		<script>
		const button = document.querySelector('.wp-codebox-vulnerable-save');
		button.addEventListener('click', () => {
			document.querySelector('.spinner').classList.add('is-active'); // Intentionally never cleared.
			const output = document.querySelector('.wp-codebox-vulnerable-count');
			output.value = String(Number(output.value) + 2); // Intentionally duplicates one effect.
		});
		</script>
		<?php
	});
});

add_filter('pre_http_request', static function ($preempt, array $args, string $url) {
	$model = get_option('wp_codebox_adversarial_http_faults');
	if (!is_array($model) || empty($model['rules']) || false === strpos($url, 'fixture.invalid')) {
		return $preempt;
	}
	$rule     = $model['rules'][0];
	$counts   = (array) get_option('wp_codebox_adversarial_http_fault_counts', array());
	$rule_id  = (string) ($rule['id'] ?? 'fixture');
	$index    = (int) ($counts[$rule_id] ?? 0);
	$counts[$rule_id] = $index + 1;
	update_option('wp_codebox_adversarial_http_fault_counts', $counts, false);
	$sequence = (array) ($rule['sequence'] ?? array());
	$outcome  = $sequence[min($index, max(0, count($sequence) - 1))] ?? array();
	if (isset($outcome['delayMs'])) {
		usleep(min(1000000, max(0, (int) $outcome['delayMs']) * 1000));
	}
	if (isset($outcome['timeoutMs'])) {
		return new WP_Error('http_request_failed', 'Operation timed out (emulated at WordPress HTTP API boundary).');
	}
	if (($outcome['connection'] ?? '') !== '') {
		return new WP_Error('http_request_failed', 'Connection failure emulated at WordPress HTTP API boundary.');
	}
	$body = isset($outcome['body']) ? (string) $outcome['body'] : '';
	if (isset($outcome['truncateAfterBytes'])) {
		$body = substr($body, 0, max(0, (int) $outcome['truncateAfterBytes']));
	}
	return array(
		'headers'  => $outcome['headers'] ?? array(),
		'body'     => $body,
		'response' => array('code' => (int) ($outcome['status'] ?? 200), 'message' => 'Fixture response'),
		'cookies'  => array(),
		'filename' => null,
	);
}, 10, 3);
