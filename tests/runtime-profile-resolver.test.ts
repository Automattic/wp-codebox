import assert from "node:assert/strict"
import { phpStringLiteral, repoRoot, runPhpJson } from "../scripts/test-kit.js"

const result = await runPhpJson<{
  default_error: { code: string; data: { errors: Array<{ code: string; profile: string }> } }
  input: {
    runtime: { components: Array<{ slug: string }>; plugins: Array<{ slug: string }>; resolved_profile: { schema: string; summary: { profiles: number }; profiles: Array<{ id: string; aliases?: string[] }> } }
    runtime_profile: { provider_plugins: Array<{ slug: string }>; runtime_overlays: Array<{ id: string }> }
    placement: { required_capabilities: string[] }
  }
  unresolved: {
    runtime: { components: Array<{ slug: string }> }
  }
}>(`
define('ABSPATH', ${phpStringLiteral(repoRoot)});
class WP_Error {
	public function __construct( public string $code = '', public string $message = '', public array $data = array() ) {}
}
function is_wp_error( $value ) { return $value instanceof WP_Error; }
function wp_json_encode( $value, $flags = 0 ) { return json_encode( $value, $flags ); }
function apply_filters( $hook, $value, ...$args ) {
	if ( 'wp_codebox_runtime_profile_registry' !== $hook || empty( $GLOBALS['wp_codebox_register_datamachine_profiles'] ) ) {
		return $value;
	}

	$value['data-machine'] = array(
		'id' => 'data-machine',
		'label' => 'Data Machine runtime',
		'aliases' => array( 'data-runtime' ),
		'capabilities' => array( 'data-machine', 'datamachine.runtime' ),
		'requires' => array( 'agents-api' ),
		'components' => array( array( 'slug' => 'data-machine' ) ),
	);
	$value['data-machine-code'] = array(
		'id' => 'data-machine-code',
		'label' => 'Data Machine Code runtime',
		'aliases' => array( 'coding-agent-runtime' ),
		'capabilities' => array( 'data-machine-code', 'datamachine-code.runtime' ),
		'requires' => array( 'data-runtime' ),
		'components' => array( array( 'slug' => 'data-machine-code' ) ),
	);

	return $value;
}

require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-runtime-profile-resolver.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-runtime-recipe-resolver.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-runtime-dependency-plan.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-task-input-contract.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-runtime-tool-policy-descriptor.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-sandbox-tool-policy-normalizer.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-agent-task.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-browser-task-builder.php`)};

$default_resolution = WP_Codebox_Runtime_Profile_Resolver::resolve( array( 'profiles' => array( 'data-machine-code' ) ) );

$GLOBALS['wp_codebox_register_datamachine_profiles'] = true;

$input = WP_Codebox_Browser_Task_Builder::local_browser_task_input( array(
	'sandbox_session_id' => 'runtime-profile-session',
	'runtime_profile' => array(
		'profiles' => array( 'coding-agent-runtime' ),
		'components' => array( 'workspace-overlay' ),
		'capabilities' => array( 'provider.openai' ),
		'runtime_overlays' => array( array( 'id' => 'codex-runtime-overlay' ) ),
	),
) );

$unresolved = WP_Codebox_Browser_Task_Builder::local_browser_task_input( array(
	'sandbox_session_id' => 'runtime-profile-session',
	'runtime_profile' => array(
		'components' => array( 'repo-local-component' ),
	),
) );

echo json_encode( array( 'default_error' => array( 'code' => $default_resolution->code, 'data' => $default_resolution->data ), 'input' => $input, 'unresolved' => $unresolved ), JSON_UNESCAPED_SLASHES );
`)

assert.equal(result.default_error.code, "wp_codebox_runtime_profile_unresolved")
assert.deepEqual(result.default_error.data.errors, [{ code: "profile_not_registered", profile: "data-machine-code" }])
assert.deepEqual(result.input.runtime.components.map((component) => component.slug), [
  "agents-api",
  "data-machine",
  "data-machine-code",
  "workspace-overlay",
])
assert.deepEqual(result.input.runtime.plugins.map((plugin) => plugin.slug), ["ai-provider-for-openai"])
assert.deepEqual(result.input.runtime_profile.provider_plugins.map((plugin) => plugin.slug), ["ai-provider-for-openai"])
assert.deepEqual(result.input.runtime_profile.runtime_overlays.map((overlay) => overlay.id), ["codex-runtime-overlay"])
assert.deepEqual(result.input.placement.required_capabilities, ["wordpress.playground", "browser.preview", "agents.runtime"])
assert.equal(result.input.runtime.resolved_profile.schema, "wp-codebox/runtime-profile-resolution/v1")
assert.equal(result.input.runtime.resolved_profile.summary.profiles, 5)
assert.equal(result.input.runtime.resolved_profile.profiles.find((profile) => profile.id === "data-machine-code")?.aliases?.[0], "coding-agent-runtime")
assert.deepEqual(result.unresolved.runtime.components.map((component) => component.slug), ["repo-local-component"])

console.log("runtime profile resolver ok")
