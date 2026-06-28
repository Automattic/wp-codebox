<?php
/**
 * Plugin Name: WP Codebox
 * Plugin URI: https://github.com/Automattic/wp-codebox
 * Description: Secure coding environments inside WordPress. WordPress ability surface for launching disposable WP Codebox Playground sandboxes that can't touch your host site.
 * Version: 0.10.2
 * Requires at least: 6.9
 * Requires PHP: 8.2
 * Author: Automattic
 * License: GPL-2.0-or-later
 * Text Domain: wp-codebox
 */

if ( ! defined( 'WPINC' ) ) {
	die;
}

define( 'WP_CODEBOX_PLUGIN_VERSION', '0.10.2' );
define( 'WP_CODEBOX_PLUGIN_PATH', plugin_dir_path( __FILE__ ) );
define( 'WP_CODEBOX_PLUGIN_URL', plugin_dir_url( __FILE__ ) );

require_once __DIR__ . '/src/class-wp-codebox-task-input-contract.php';
require_once __DIR__ . '/src/class-wp-codebox-agent-workload.php';
require_once __DIR__ . '/src/class-wp-codebox-runtime-tool-policy-descriptor.php';
require_once __DIR__ . '/src/class-wp-codebox-sandbox-tool-policy-normalizer.php';
require_once __DIR__ . '/src/class-wp-codebox-path-policy.php';
require_once __DIR__ . '/src/class-wp-codebox-agent-task.php';
require_once __DIR__ . '/src/class-wp-codebox-provider-credentials.php';
require_once __DIR__ . '/src/class-wp-codebox-runtime-dependency-plan.php';
require_once __DIR__ . '/src/class-wp-codebox-runtime-profile-resolver.php';
require_once __DIR__ . '/src/class-wp-codebox-runtime-recipe-resolver.php';
require_once __DIR__ . '/src/class-wp-codebox-browser-task-builder.php';
require_once __DIR__ . '/src/class-wp-codebox-connector-credential-resolvers.php';
require_once __DIR__ . '/src/class-wp-codebox-inheritance.php';
require_once __DIR__ . '/src/class-wp-codebox-redaction-policy.php';
require_once __DIR__ . '/src/class-wp-codebox-host-request-normalizer.php';
require_once __DIR__ . '/src/class-wp-codebox-host-tool-policy-validator.php';
require_once __DIR__ . '/src/class-wp-codebox-host-preview-args-builder.php';
require_once __DIR__ . '/src/class-wp-codebox-host-runtime-config-builder.php';
require_once __DIR__ . '/src/class-wp-codebox-agent-runtime-config-resolver.php';
require_once __DIR__ . '/src/class-wp-codebox-host-recipe-builder.php';
require_once __DIR__ . '/src/class-wp-codebox-status-taxonomy.php';
require_once __DIR__ . '/src/class-wp-codebox-host-run-result-normalizer.php';
require_once __DIR__ . '/src/class-wp-codebox-managed-host-command.php';
require_once __DIR__ . '/src/class-wp-codebox-runner-workspace-backend.php';
require_once __DIR__ . '/src/class-wp-codebox-runner-workspace-adapter.php';
require_once __DIR__ . '/src/class-wp-codebox-parent-site-seed-exporter.php';
require_once __DIR__ . '/src/class-wp-codebox-json.php';
require_once __DIR__ . '/src/class-wp-codebox-run-plan.php';
require_once __DIR__ . '/src/class-wp-codebox-fanout-aggregation.php';
require_once __DIR__ . '/src/class-wp-codebox-agent-process-runner.php';
require_once __DIR__ . '/src/class-wp-codebox-agent-run-result-builder.php';
require_once __DIR__ . '/src/class-wp-codebox-agent-outcome-classifier.php';
require_once __DIR__ . '/src/class-wp-codebox-runtime-provider-registry.php';
require_once __DIR__ . '/src/class-wp-codebox-wordpress-workload-runner.php';
require_once __DIR__ . '/src/class-wp-codebox-fuzz-suite-runner.php';
require_once __DIR__ . '/src/class-wp-codebox-agents-api-adapter.php';
require_once __DIR__ . '/src/class-wp-codebox-agent-runtime-invoker.php';
require_once __DIR__ . '/src/class-wp-codebox-browser-runner-template.php';
require_once __DIR__ . '/src/class-wp-codebox-browser-provider-auth-strategies.php';
require_once __DIR__ . '/src/class-wp-codebox-php-ai-client-browser-provider-adapter.php';
require_once __DIR__ . '/src/class-wp-codebox-browser-provider-bridge.php';
require_once __DIR__ . '/src/class-wp-codebox-agent-sandbox-runner.php';
require_once __DIR__ . '/src/class-wp-codebox-patch-approval-filter.php';
require_once __DIR__ . '/src/class-wp-codebox-artifacts.php';
require_once __DIR__ . '/src/class-wp-codebox-pending-artifact-apply.php';
require_once __DIR__ . '/src/class-wp-codebox-preview-options.php';
require_once __DIR__ . '/src/class-wp-codebox-abilities.php';
require_once __DIR__ . '/src/class-wp-codebox-api.php';

if ( defined( 'WP_CLI' ) && WP_CLI ) {
	require_once __DIR__ . '/src/class-wp-codebox-cli-command.php';
}

// The Agents API adapter probes the abilities registry (wp_get_ability) to
// decide whether to register its runtime profiles/provider. As of WordPress 7.0
// the Abilities API moved into core and WP_Abilities_Registry::get_instance()
// emits a _doing_it_wrong notice when accessed before the `init` action. Hook
// this on `wp_abilities_api_init` — the same signal the plugin's own abilities
// register on — so the registry is never touched before it is initialized.
add_action( 'wp_abilities_api_init', array( WP_Codebox_Agents_API_Adapter::class, 'register_if_available' ) );
add_action( 'plugins_loaded', array( WP_Codebox_Php_Ai_Client_Browser_Provider_Adapter::class, 'register' ), 20 );
new WP_Codebox_Abilities();
WP_Codebox_Browser_Provider_Bridge::register();

if ( defined( 'WP_CLI' ) && WP_CLI ) {
	WP_Codebox_CLI_Command::register();
}

add_action( 'plugins_loaded', static function (): void {
	new WP_Codebox_Pending_Artifact_Apply();
}, 20 );

add_action(
	'wp_enqueue_scripts',
	static function (): void {
		$script = WP_CODEBOX_PLUGIN_PATH . 'assets/browser-runtime.js';
		if ( ! file_exists( $script ) ) {
			return;
		}

		wp_register_script(
			'wp-codebox-browser-runtime',
			WP_CODEBOX_PLUGIN_URL . 'assets/browser-runtime.js',
			array(),
			(string) filemtime( $script ),
			array( 'in_footer' => true )
		);
	}
);
