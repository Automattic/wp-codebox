import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"

const root = new URL("../", import.meta.url)
const rootPath = root.pathname.replace(/'/g, "'\\''")

const php = spawnSync("php", ["-r", `
define('ABSPATH', '${rootPath}');
function sanitize_key( $key ) { return strtolower( preg_replace( '/[^a-zA-Z0-9_-]/', '', (string) $key ) ); }
function sanitize_text_field( $value ) { return trim( (string) $value ); }
class WP_Error {
	public function __construct( public string $code = '', public string $message = '', public array $data = array() ) {}
}
require '${rootPath}packages/wordpress-plugin/src/class-wp-codebox-browser-runner-template.php';
require '${rootPath}packages/wordpress-plugin/src/class-wp-codebox-agent-runtime-invoker.php';
require '${rootPath}packages/wordpress-plugin/src/trait-wp-codebox-abilities-browser-runner.php';

class Browser_Runner_Template_Test_Harness {
	private const BROWSER_ARTIFACT_MAX_BYTES = 5242880;
	private const BROWSER_CAPTURE_MAX_BYTES  = 262144;
	use WP_Codebox_Abilities_Browser_Runner;

	private static function safe_key( string $key ): string {
		return sanitize_key( $key );
	}
}

$method = new ReflectionMethod( Browser_Runner_Template_Test_Harness::class, 'browser_agent_runner_php' );
$runner_php = $method->invoke( null, array(
	'goal' => 'Capture generated browser output.',
	'provider_plugin_paths' => array( '/plugins/provider-one' ),
	'component_contracts' => array( array( 'path' => '/components/demo-plugin', 'loadAs' => 'plugin', 'activate' => true ) ),
	'context' => array(
		'output' => array(
			'artifact_bundle' => array(
				'schema' => 'wp-codebox/website-bundle/v1',
				'root' => 'wp-codebox-output',
				'entrypoint' => 'wp-codebox-output/index.html',
			),
		),
	),
), 'session-template-test', '/tmp/task.json', '/tmp/result.json', array(
	'type' => 'ability',
	'name' => 'agents/chat',
	'hook' => 'agents/chat',
	'input' => array( 'temperature' => 0 ),
), array( array(
	'path' => '/tmp/custom-report.json',
	'name' => 'custom-report',
	'kind' => 'report',
	'mime_type' => 'application/json',
	'max_bytes' => 2048,
) ) );
$lint_path = tempnam( sys_get_temp_dir(), 'wp-codebox-browser-runner-' );
file_put_contents( $lint_path, $runner_php );
$lint_output = array();
$lint_status = 1;
exec( escapeshellarg( PHP_BINARY ) . ' -l ' . escapeshellarg( $lint_path ) . ' 2>&1', $lint_output, $lint_status );
unlink( $lint_path );
$lint_text = implode( "\n", $lint_output );
$lint_line = preg_match( '/line (\\d+)/', $lint_text, $lint_match ) ? (int) $lint_match[1] : 0;
$runner_lines = explode( "\n", $runner_php );

echo json_encode( array(
	'sha256' => hash( 'sha256', $runner_php ),
	'lint' => array(
		'status' => $lint_status,
		'output' => $lint_text,
		'line_count' => count( $runner_lines ),
		'open_tag_lines' => array_values( array_keys( array_filter( $runner_lines, static fn( $line ) => str_contains( $line, '<?php' ) ) ) ),
		'context' => $lint_line > 0 ? array_slice( $runner_lines, max( 0, $lint_line - 4 ), 7 ) : array(),
	),
	'function_counts' => array(
		'event_sink' => substr_count( $runner_php, 'function wp_codebox_browser_runtime_event_sink' ),
		'capture_file' => substr_count( $runner_php, 'function wp_codebox_browser_capture_file' ),
		'provider_proxy' => substr_count( $runner_php, 'function wp_codebox_browser_install_provider_proxy' ),
		'execution_metrics' => substr_count( $runner_php, 'function wp_codebox_browser_execution_metrics' ),
	),
	'contains' => array(
		'event_schema' => str_contains( $runner_php, 'wp-codebox/browser-agent-event/v1' ),
		'capture_schema' => str_contains( $runner_php, 'wp-codebox/browser-capture/v1' ),
		'provider_request_schema' => str_contains( $runner_php, 'wp-codebox/browser-provider-proxy-request/v1' ),
		'result_schema' => str_contains( $runner_php, 'wp-codebox/browser-materialization/v1' ),
		'tool_bridge_policy' => str_contains( $runner_php, "['tool_bridge']['sandbox_tool_policy']" ),
		'agents_adapter_helper' => str_contains( $runner_php, 'function wp_codebox_browser_runtime_execute_ability' ),
		'no_embedded_adapter_class' => ! str_contains( $runner_php, 'WP_Codebox_Agents_API_Adapter::' ),
		'contract_markers' => str_contains( $runner_php, 'WP_CODEBOX_BROWSER_RUNNER_BODY_START' ) && str_contains( $runner_php, 'WP_CODEBOX_BROWSER_RUNNER_BODY_END' ),
	),
) );
`], {
  cwd: root.pathname,
  encoding: "utf8",
})

assert.equal(php.status, 0, php.stderr)
const result = JSON.parse(php.stdout)

assert.match(result.sha256, /^[a-f0-9]{64}$/)
assert.equal(result.lint.status, 0, JSON.stringify(result.lint, null, 2))
assert.deepEqual(result.function_counts, {
  event_sink: 1,
  capture_file: 1,
  provider_proxy: 1,
  execution_metrics: 1,
})
assert.deepEqual(result.contains, {
  event_schema: true,
  capture_schema: true,
  provider_request_schema: true,
  result_schema: true,
  tool_bridge_policy: true,
  agents_adapter_helper: true,
  no_embedded_adapter_class: true,
  contract_markers: true,
})

console.log("browser runner template contract ok")
