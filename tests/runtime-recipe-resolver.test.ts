import assert from "node:assert/strict"
import { phpStringLiteral, repoRoot, runPhpJson } from "../scripts/test-kit.js"

const result = await runPhpJson<{
  resolved: {
    runtime: { components: string[]; plugins: Array<{ slug: string }>; resolved_recipe: { schema: string; summary: { packages: number } } }
    inherit: { connectors: string[] }
    provider_plugin_paths: string[]
    secret_env: string[]
    placement: { required_capabilities: string[] }
  }
  local_task: {
    runtime: { components: string[] }
    inherit: { connectors: string[] }
    placement: { required_capabilities: string[] }
  }
}>(`
define('ABSPATH', ${phpStringLiteral(repoRoot)});
class WP_Error {
	public function __construct( public string $code = '', public string $message = '', public array $data = array() ) {}
}
function is_wp_error( $value ) { return $value instanceof WP_Error; }
function wp_json_encode( $value, $flags = 0 ) { return json_encode( $value, $flags ); }
function sanitize_key( $value ) { return strtolower( preg_replace( '/[^a-zA-Z0-9_-]/', '', (string) $value ) ); }
function apply_filters( $hook, $value, ...$args ) {
	if ( 'wp_codebox_runtime_package_registry' !== $hook ) {
		return $value;
	}

	$value['agents'] = array(
		'id' => 'agents',
		'label' => 'Agents runtime',
		'provides' => array( 'agents.runtime' ),
		'requires' => array( 'wordpress.playground' ),
		'runtime' => array(
			'components' => array( 'agents-api' ),
			'plugins' => array( array( 'slug' => 'agents-api', 'url' => 'https://example.test/agents-api.zip', 'activate' => true ) ),
		),
		'placement_capabilities' => array( 'agents.runtime' ),
	);
	$value['data-machine'] = array(
		'id' => 'data-machine',
		'provides' => array( 'data-machine.runtime' ),
		'requires' => array( 'agents' ),
		'runtime' => array(
			'components' => array( 'data-machine', 'data-machine-code' ),
			'plugins' => array(
				array( 'slug' => 'data-machine', 'url' => 'https://example.test/data-machine.zip', 'activate' => true ),
				array( 'slug' => 'data-machine-code', 'url' => 'https://example.test/data-machine-code.zip', 'activate' => true ),
			),
			'bootstrap' => array( array( 'operation' => 'set_option', 'args' => array( 'name' => 'datamachine_runtime', 'value' => 'sandbox' ) ) ),
		),
	);
	$value['provider-connector'] = array(
		'id' => 'provider-connector',
		'provides' => array( 'provider.connector' ),
		'requires' => array( 'agents.runtime' ),
		'inherit' => array( 'connectors' => array( 'primary-ai' ) ),
		'provider_plugin_paths' => array( '/opt/provider-plugin' ),
		'secret_env' => array( 'PROVIDER_TOKEN', 'bad-name' ),
	);

	return $value;
}

require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-runtime-recipe-resolver.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-runtime-dependency-plan.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-task-input-contract.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-runtime-tool-policy-descriptor.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-sandbox-tool-policy-normalizer.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-agent-task.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-browser-task-builder.php`)};

$input = array(
	'runtime_recipe' => array(
		'capabilities' => array( 'data-machine.runtime', 'provider.connector' ),
	),
	'runtime' => array(
		'plugins' => array( array( 'slug' => 'caller-plugin', 'url' => 'https://example.test/caller.zip' ) ),
	),
	'inherit' => array( 'connectors' => array( 'existing' ) ),
	'placement' => array( 'required_capabilities' => array( 'artifact.website-bundle' ) ),
);

$resolved = WP_Codebox_Runtime_Recipe_Resolver::apply_to_input( $input, array( 'connectors' => array(), 'settings' => array() ) );
$local_task = WP_Codebox_Browser_Task_Builder::local_browser_task_input( array(
	'sandbox_session_id' => 'runtime-session',
	'runtime_capabilities' => array( 'provider.connector' ),
) );

echo json_encode( array( 'resolved' => $resolved, 'local_task' => $local_task ), JSON_UNESCAPED_SLASHES );
`)

assert.deepEqual(result.resolved.runtime.components, ["agents-api", "data-machine", "data-machine-code"])
assert.deepEqual(result.resolved.runtime.plugins.map((plugin: { slug: string }) => plugin.slug), ["caller-plugin", "agents-api", "data-machine", "data-machine-code"])
assert.deepEqual(result.resolved.inherit.connectors, ["existing", "primary-ai"])
assert.deepEqual(result.resolved.provider_plugin_paths, ["/opt/provider-plugin"])
assert.deepEqual(result.resolved.secret_env, ["PROVIDER_TOKEN"])
assert.deepEqual(result.resolved.placement.required_capabilities, ["artifact.website-bundle", "wordpress.playground", "browser.preview", "agents.runtime"])
assert.equal(result.resolved.runtime.resolved_recipe.schema, "wp-codebox/runtime-recipe-resolution/v1")
assert.equal(result.resolved.runtime.resolved_recipe.summary.packages, 4)
assert.deepEqual(result.local_task.runtime.components, ["agents-api"])
assert.deepEqual(result.local_task.inherit.connectors, ["primary-ai"])
assert.deepEqual(result.local_task.placement.required_capabilities, ["wordpress.playground", "browser.preview", "agents.runtime"])

console.log("runtime recipe resolver ok")
