import assert from "node:assert/strict"
import { phpStringLiteral, repoRoot, runPhpJson } from "../scripts/test-kit.js"

const result = await runPhpJson<{
  has_agents_api_adapter: boolean
  response: { success: boolean; agent: string; message: string }
  preflight: { invocation_type: string; provider_ready: boolean; hook: string }
  ability_names: string[]
}>(`
define('ABSPATH', ${phpStringLiteral(repoRoot)});
class WP_Error {
	public function __construct( public string $code = '', public string $message = '', public array $data = array() ) {}
}
function is_wp_error( $value ) { return $value instanceof WP_Error; }
function sanitize_key( $value ) { return strtolower( preg_replace( '/[^a-z0-9_\-]/', '', (string) $value ) ); }
function get_current_user_id() { return 1; }
function wp_set_current_user( $user_id ) { return $user_id; }
function wp_json_encode( $value, $flags = 0 ) { return json_encode( $value, $flags ); }

$GLOBALS['wp_filter'] = array();
function add_filter( $hook, $callback, $priority = 10, $accepted_args = 1 ) {
	$GLOBALS['wp_filter'][ $hook ][ $priority ][] = array( 'function' => $callback, 'accepted_args' => $accepted_args );
	return true;
}
function remove_filter( $hook, $callback, $priority = 10 ) { unset( $GLOBALS['wp_filter'][ $hook ][ $priority ] ); return true; }
function has_filter( $hook ) { return ! empty( $GLOBALS['wp_filter'][ $hook ] ); }
function apply_filters( $hook, $value, ...$args ) {
	foreach ( $GLOBALS['wp_filter'][ $hook ] ?? array() as $callbacks ) {
		foreach ( $callbacks as $callback ) {
			$value = call_user_func_array( $callback['function'], array_slice( array_merge( array( $value ), $args ), 0, $callback['accepted_args'] ) );
		}
	}
	return $value;
}

require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-agent-runtime-invoker.php`)};
eval( WP_Codebox_Agent_Runtime_Invoker::browser_runtime_php() );

add_filter( 'wp_codebox_browser_runtime_task', static function ( $response, array $input ): array {
	return array( 'success' => true, 'agent' => $input['agent'], 'message' => $input['message'] );
}, 10, 2 );

$payload = array( 'agent' => 'generic-agent', 'message' => 'Run generic runtime', 'task_input' => array() );
$invocation = array( 'type' => 'task', 'hook' => 'wp_codebox_browser_runtime_task' );
$input = wp_codebox_browser_runtime_prepare_input( $payload, $invocation, 'generic-session', array(), array(), array(), array() );
$result = wp_codebox_browser_runtime_invoke_agent_task( $payload, $invocation, $input, 'generic-session', true, '/wordpress' );

echo json_encode( array(
	'has_agents_api_adapter' => class_exists( 'WP_Codebox_Agents_API_Adapter' ),
	'response' => $result['response'],
	'preflight' => $result['preflight'],
	'ability_names' => wp_codebox_browser_runtime_agents_ability_names(),
), JSON_UNESCAPED_SLASHES );
`)

assert.equal(result.has_agents_api_adapter, false)
assert.deepEqual(result.response, { success: true, agent: "generic-agent", message: "Run generic runtime" })
assert.equal(result.preflight.invocation_type, "task")
assert.equal(result.preflight.provider_ready, true)
assert.equal(result.preflight.hook, "wp_codebox_browser_runtime_task")
assert.deepEqual(result.ability_names, [])

console.log("browser runtime generic invoker ok")
