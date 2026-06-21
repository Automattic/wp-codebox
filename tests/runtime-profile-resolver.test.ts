import assert from "node:assert/strict"
import { phpStringLiteral, repoRoot, runPhpJson } from "../scripts/test-kit.js"

const result = await runPhpJson<{
  input: {
    runtime: { components: Array<{ slug: string }>; plugins: Array<{ slug: string }>; resolved_profile: { schema: string; summary: { profiles: number } } }
    runtime_profile: {
      schema: string
      capabilities: string[]
      provider_plugins: Array<{ slug: string }>
      runtime_overlays: Array<{ id: string }>
      readiness: { status: string; checks: Record<string, boolean> }
      diagnostics: Array<{ code: string; status: string; severity: string; evidence: Record<string, unknown> }>
      provenance: { owner: string; resolver: string }
    }
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
function apply_filters( $hook, $value, ...$args ) { return $value; }

require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-runtime-profile-resolver.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-runtime-recipe-resolver.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-runtime-dependency-plan.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-task-input-contract.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-runtime-tool-policy-descriptor.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-sandbox-tool-policy-normalizer.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-agent-task.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-browser-task-builder.php`)};

$input = WP_Codebox_Browser_Task_Builder::local_browser_task_input( array(
	'sandbox_session_id' => 'runtime-profile-session',
	'runtime_profile' => array(
		'profiles' => array( 'data-machine-code' ),
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

echo json_encode( array( 'input' => $input, 'unresolved' => $unresolved ), JSON_UNESCAPED_SLASHES );
`)

assert.deepEqual(result.input.runtime.components.map((component) => component.slug), [
  "agents-api",
  "data-machine",
  "data-machine-code",
  "workspace-overlay",
])
assert.equal(result.input.runtime_profile.schema, "wp-codebox/runtime-profile/v1")
assert.deepEqual(result.input.runtime_profile.capabilities, [
  "wordpress.playground",
  "browser.preview",
  "agents-api",
  "agents.runtime",
  "data-machine",
  "datamachine.runtime",
  "data-machine-code",
  "datamachine-code.runtime",
  "provider.openai",
])
assert.deepEqual(result.input.runtime.plugins.map((plugin) => plugin.slug), ["ai-provider-for-openai"])
assert.deepEqual(result.input.runtime_profile.provider_plugins.map((plugin) => plugin.slug), ["ai-provider-for-openai"])
assert.deepEqual(result.input.runtime_profile.runtime_overlays.map((overlay) => overlay.id), ["codex-runtime-overlay"])
assert.equal(result.input.runtime_profile.readiness.status, "ready")
assert.equal(result.input.runtime_profile.readiness.checks.dependencies, true)
assert.equal(result.input.runtime_profile.diagnostics[0].code, "runtime_profile.resolved")
assert.equal(result.input.runtime_profile.diagnostics[0].severity, "info")
assert.equal(result.input.runtime_profile.provenance.owner, "wp-codebox")
assert.deepEqual(result.input.placement.required_capabilities, ["wordpress.playground", "browser.preview", "agents.runtime"])
assert.equal(result.input.runtime.resolved_profile.schema, "wp-codebox/runtime-profile-resolution/v1")
assert.equal(result.input.runtime.resolved_profile.summary.profiles, 5)
assert.deepEqual(result.unresolved.runtime.components.map((component) => component.slug), ["repo-local-component"])

console.log("runtime profile resolver ok")
