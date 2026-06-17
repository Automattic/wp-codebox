import assert from "node:assert/strict"
import { phpStringLiteral, repoRoot, runPhpJson } from "../scripts/test-kit.js"

const result = await runPhpJson<{
  legacy_adapter_calls: string[]
  recipe: {
    schema: string
    inputs: { inherit: unknown; secretEnv: string[]; agent_bundles: unknown[]; extra_plugins: unknown[] }
    workflow: { steps: Array<{ command: string; args: string[] }> }
    runtime: { overlays: unknown[] }
  }
}>(`
define('ABSPATH', ${phpStringLiteral(repoRoot)});
class WP_Error {
	public function __construct( public string $code = '', public string $message = '', public array $data = array() ) {}
}
function is_wp_error( $value ) { return $value instanceof WP_Error; }
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-runtime-dependency-plan.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-host-recipe-builder.php`)};

$legacy_adapter_calls = array();
$dependency_plan = new WP_Codebox_Runtime_Dependency_Plan(
	array( 'agent' => 'planned-agent', 'mode' => 'planned-mode', 'provider' => 'planned-provider', 'model' => 'planned-model' ),
	array( '/plugins/planned-provider' ),
	array( array( 'source' => '/plugins/planned-provider', 'slug' => 'planned-provider', 'activate' => false ) ),
	array( array( 'source' => '/components/demo-plugin', 'slug' => 'demo-plugin', 'activate' => true, 'loadAs' => 'plugin' ) ),
	array( array( 'kind' => 'plugin', 'library' => 'demo', 'strategy' => 'replace', 'source' => '/overlays/demo' ) ),
	array( 'connectors' => array( array( 'provider' => 'planned-provider', 'model' => 'planned-model' ) ), 'settings' => array() ),
	array( 'connectors' => array( 'planned-connector' ), 'settings' => array() ),
	array( array( 'source' => '/tmp/planned-bundle.zip', 'on_conflict' => 'skip' ) ),
	array( 'PLANNED_SECRET' )
);

$builder = new WP_Codebox_Host_Recipe_Builder();
$result = $builder->build(
	array( array( 'path' => '/components/demo-plugin', 'slug' => 'demo-plugin', 'loadAs' => 'plugin', 'activate' => true ) ),
	array( 'session_id' => 'session-123' ),
	array( 'Verify plan adoption' ),
	'latest',
	null,
	array(
		'inheritance_resolution' => static fn( array $input ): array => array( 'connectors' => array(), 'settings' => array() ),
		'connector_credentials_error' => static fn( array $inheritance ): null => null,
		'runtime_dependency_plan' => static fn( array $input, array $inheritance, array $component_plugins ): WP_Codebox_Runtime_Dependency_Plan => $dependency_plan,
		'provider_plugin_paths' => static function () use ( &$legacy_adapter_calls ): array { $legacy_adapter_calls[] = 'provider_plugin_paths'; return array(); },
		'agent_bundles' => static function () use ( &$legacy_adapter_calls ): array { $legacy_adapter_calls[] = 'agent_bundles'; return array(); },
		'agent_slug' => static function () use ( &$legacy_adapter_calls ): string { $legacy_adapter_calls[] = 'agent_slug'; return ''; },
		'mode' => static function () use ( &$legacy_adapter_calls ): string { $legacy_adapter_calls[] = 'mode'; return ''; },
		'provider' => static function () use ( &$legacy_adapter_calls ): string { $legacy_adapter_calls[] = 'provider'; return ''; },
		'model' => static function () use ( &$legacy_adapter_calls ): string { $legacy_adapter_calls[] = 'model'; return ''; },
		'inheritance_request' => static function () use ( &$legacy_adapter_calls ): array { $legacy_adapter_calls[] = 'inheritance_request'; return array( 'connectors' => array(), 'settings' => array() ); },
		'secret_env_names' => static function () use ( &$legacy_adapter_calls ): array { $legacy_adapter_calls[] = 'secret_env_names'; return array(); },
		'component_plugins' => static fn( array $paths ): array => array( array( 'source' => '/components/demo-plugin', 'slug' => 'demo-plugin', 'activate' => true, 'loadAs' => 'plugin' ) ),
		'runtime_task' => static fn( array $input ): array => array(),
		'task_input' => static fn( array $input ): array => array( 'goal' => $input['goal'], 'sandbox_tool_policy' => array( 'commands' => array() ) ),
		'json_encode' => static fn( mixed $value ): string => json_encode( $value, JSON_UNESCAPED_SLASHES ),
		'task_timeout_seconds' => static fn( array $input ): int => 0,
		'recipe_mounts' => static fn( array $input ): array => array(),
		'recipe_workspaces' => static fn( array $input ): array => array(),
		'recipe_runtime' => static fn( array $input, string $wp_version, WP_Codebox_Runtime_Dependency_Plan $plan ): array => array( 'wp' => $wp_version, 'blueprint' => array( 'steps' => array() ), 'overlays' => $plan->runtime_overlays() ),
		'site_seed_recipe_entries' => static fn( array $input ): array => array( 'siteSeeds' => array(), 'cleanup_paths' => array() ),
		'runtime_env' => static fn( array $input ): array => array( 'CUSTOM_ENV' => '1' ),
	)
);

if ( is_wp_error( $result ) ) {
	fwrite( STDERR, $result->message );
	exit( 1 );
}

$recipe = json_decode( file_get_contents( $result['path'] ), true );
unlink( $result['path'] );

echo json_encode( array( 'legacy_adapter_calls' => $legacy_adapter_calls, 'recipe' => $recipe ), JSON_UNESCAPED_SLASHES );
`)

assert.deepEqual(result.legacy_adapter_calls, [])
assert.equal(result.recipe.schema, "wp-codebox/workspace-recipe/v1")
assert.deepEqual(result.recipe.inputs.inherit, { connectors: ["planned-connector"], settings: [] })
assert.deepEqual(result.recipe.inputs.secretEnv, ["PLANNED_SECRET"])
assert.deepEqual(result.recipe.inputs.agent_bundles, [{ source: "/tmp/planned-bundle.zip", on_conflict: "skip" }])
assert.deepEqual(result.recipe.inputs.extra_plugins, [
  { source: "/components/demo-plugin", slug: "demo-plugin", activate: true, loadAs: "plugin" },
  { source: "/plugins/planned-provider", slug: "planned-provider", activate: false },
])
assert.equal(result.recipe.workflow.steps[0].command, "wp-codebox.agent-sandbox-run")
assert.ok(result.recipe.workflow.steps[0].args.includes("agent=planned-agent"))
assert.ok(result.recipe.workflow.steps[0].args.includes("mode=planned-mode"))
assert.ok(result.recipe.workflow.steps[0].args.includes("provider=planned-provider"))
assert.ok(result.recipe.workflow.steps[0].args.includes("model=planned-model"))
assert.ok(result.recipe.workflow.steps[0].args.includes("provider-plugin-slugs=planned-provider"))
assert.deepEqual(result.recipe.runtime.overlays, [{ kind: "plugin", library: "demo", strategy: "replace", source: "/overlays/demo" }])

console.log("host recipe builder ok")
