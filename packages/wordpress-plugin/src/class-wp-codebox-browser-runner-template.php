<?php
/**
 * Browser runner generated PHP templates.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

/** String-only builders for generated browser runner PHP fragments. */
final class WP_Codebox_Browser_Runner_Template {
	/**
	 * Builds the generated PHP bootstrap fragment for the browser runner.
	 *
	 * @param string                  $task_path   Absolute Playground path for the staged task payload.
	 * @param string                  $result_path Absolute Playground path for runner result output.
	 * @param array<string,mixed>     $payload     Default runner payload.
	 * @param array<string,mixed>     $invocation  Normalized runner invocation.
	 * @param array<int,array<string,mixed>> $captures Normalized capture paths.
	 */
	public static function bootstrap_fragment( string $task_path, string $result_path, array $payload, array $invocation, array $captures ): string {
		return '<?php
$_GET[\'rest_route\'] = \'/wp-codebox/browser-runner\';
require_once \'/wordpress/wp-load.php\';

if ( function_exists( \'get_current_user_id\' ) && function_exists( \'wp_set_current_user\' ) && get_current_user_id() <= 0 ) {
	wp_set_current_user( 1 );
}

$task_path = ' . var_export( $task_path, true ) . ';
$result_path = ' . var_export( $result_path, true ) . ';
$event_path = "/tmp/wp-codebox-agent-events.jsonl";
$payload = ' . var_export( $payload, true ) . ';
$invocation = ' . var_export( $invocation, true ) . ';
$capture_paths = ' . var_export( $captures, true ) . ';
$started_at = gmdate( \'c\' );
$started_monotonic = microtime( true );
';
	}
}
