import assert from "node:assert/strict"

import { phpStringLiteral, repoRoot, runPhpJson } from "../scripts/test-kit.js"

const rootPath = phpStringLiteral(repoRoot)
const result = await runPhpJson<any>(`
define('ABSPATH', ${rootPath});
class WP_Error {
	public function __construct( public string $code = '', public string $message = '', public array $data = array() ) {}
}
function is_wp_error( $value ) { return $value instanceof WP_Error; }
function wp_json_encode( $value, $flags = 0 ) { return json_encode( $value, $flags ); }
function sanitize_key( $value ) { return strtolower( preg_replace( '/[^a-zA-Z0-9_-]/', '', (string) $value ) ); }
$GLOBALS['wp_codebox_test_transients'] = array();
function get_transient( $key ) { return $GLOBALS['wp_codebox_test_transients'][ $key ] ?? false; }
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-task-input-contract.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-agent-workload.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-agents-api-adapter.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-runtime-tool-policy-descriptor.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-sandbox-tool-policy-normalizer.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-agent-task.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-runtime-dependency-plan.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-runtime-recipe-resolver.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-browser-task-builder.php`)};

$task_input = WP_Codebox_Browser_Task_Builder::normalize_task_input( array(
	'goal' => 'Build a generic browser task.',
	'target' => array( 'kind' => 'site', 'ref' => 'demo' ),
	'allowed_tools' => array( 'filesystem_write', 'filesystem_write', '' ),
	'expected_artifacts' => array( 'patch', 'preview' ),
	'context' => array( 'caller' => 'test' ),
	'agent_bundles' => array(
		array( 'source' => '/tmp/agent-bundle.zip', 'on_conflict' => 'skip' ),
	),
) );

$local_task = WP_Codebox_Browser_Task_Builder::local_browser_task_input( array(
	'goal' => 'Build a local browser task.',
	'sandbox_session_id' => 'session-123',
	'provider_plugin_paths' => array( '/existing/provider' ),
	'runtime_env' => array( 'EXISTING' => '1' ),
	'runtime_profile' => array(
		'id' => 'profile-1',
		'plugins' => array( array( 'slug' => 'profile-plugin', 'url' => 'https://example.test/profile-plugin.zip', 'package' => 'browser' ) ),
		'provider_plugins' => array( array( 'slug' => 'profile-provider', 'path' => '/profile/provider' ) ),
		'extra_plugins' => array( array( 'slug' => 'browser-extra', 'url' => 'https://example.test/browser-extra.zip', 'package' => 'browser' ) ),
		'component_contracts' => array( array( 'slug' => 'profile-component', 'required' => true ) ),
		'runtime_overlays' => array( array( 'slug' => 'profile-overlay' ) ),
		'env' => array( 'PROFILE_ENV' => '1', 'EXISTING' => 'profile-default' ),
	),
	'placement' => array(
		'required_capabilities' => array( 'artifact.website-bundle' ),
	),
	'context' => array( 'caller' => 'test' ),
) );

$payload = WP_Codebox_Browser_Task_Builder::task_payload(
	array(
		'agent' => 'custom-agent',
		'mode' => 'sandbox',
		'secret_env' => array( 'OPENAI_API_KEY', 'OPENAI_API_KEY', 'bad-name' ),
	),
	$task_input,
	'session-123',
	array( array( 'path' => '/tmp/result.json', 'name' => 'result' ) ),
	array(
		'connectors' => array( array( 'provider' => 'provider-from-inheritance', 'model' => 'model-from-inheritance' ) ),
		'settings' => array(),
	)
);

$explicit_plan_payload = WP_Codebox_Browser_Task_Builder::task_payload(
	array( 'secret_env' => array( 'IGNORED_BY_PLAN' ) ),
	$task_input,
	'session-123',
	array(),
	array( 'connectors' => array(), 'settings' => array() ),
	array(
		'runtime_dependency_plan' => static fn(): WP_Codebox_Runtime_Dependency_Plan => new WP_Codebox_Runtime_Dependency_Plan(
			array( 'agent' => 'planned-agent', 'mode' => 'planned-mode', 'provider' => 'planned-provider', 'model' => 'planned-model' ),
			array( '/tmp/provider-plugin' ),
			array( array( 'slug' => 'provider-plugin', 'source' => '/tmp/provider-plugin' ) ),
			array(),
			array(),
			array( 'connectors' => array( array( 'provider' => 'planned-provider', 'model' => 'planned-model' ) ), 'settings' => array() ),
			array( 'connectors' => array( 'planned-connector' ), 'settings' => array() ),
			array( array( 'source' => '/tmp/planned-bundle.zip' ) ),
			array( 'PLANNED_SECRET', 'bad-name' )
		),
	)
);

$plan = new WP_Codebox_Runtime_Dependency_Plan(
	array( 'agent' => 'contract-agent', 'mode' => 'sandbox', 'provider' => 'contract-provider', 'model' => 'contract-model' ),
	array( '/tmp/contract-provider' ),
	array( array( 'slug' => 'contract-provider', 'source' => '/tmp/contract-provider' ) ),
	array(),
	array(),
	array( 'connectors' => array(), 'settings' => array() ),
	array( 'connectors' => array(), 'settings' => array() ),
	array(),
	array( 'CONTRACT_SECRET' ),
	array( 'CONTRACT_ENV' => '1', 'bad-name' => 'ignored' )
);
$plan_contract = $plan->to_contract();
$plan_plugin_specs = $plan->browser_provider_plugin_specs();

$intent_task = WP_Codebox_Browser_Task_Builder::browser_task_input_from_intent( array(
	'product_intent' => array(
		'product' => 'demo-product',
		'orchestrator' => 'demo-orchestrator',
		'goal' => 'Build from intent.',
		'target_kind' => 'new-site',
		'target_ref' => 'project-7',
	),
	'active_project_context' => array(
		'project_id' => 7,
		'project_kind' => 'static-site',
	),
	'desired_capabilities' => array( 'Artifact.Website-Bundle', 'artifact.website-bundle' ),
	'desired_tools' => array( 'filesystem-write', 'browser.review', 'filesystem-write' ),
	'artifacts' => array(
		'expected' => array( 'website-artifact-bundle', 'static-site-importer-report' ),
		'base_path' => '/wordpress/wp-content/uploads/demo-product',
		'base_url' => '/wp-content/uploads/demo-product',
		'preview_url' => '/?preview=1',
		'task_path' => '/tmp/demo-task.json',
		'result_path' => '/tmp/demo-result.json',
		'invocation' => array( 'type' => 'task', 'hook' => 'demo_task' ),
		'capture_paths' => array( array( 'path' => '/wordpress/wp-content/uploads/demo-product/report.json', 'name' => 'report' ) ),
	),
	'callback_refs' => array(
		'success' => array( 'ability' => 'demo/task-success', 'ref' => 'project-7' ),
	),
	'session_id' => 'demo-session',
) );

$fanout_request = WP_Codebox_Browser_Task_Builder::fanout_request( array(
	'concurrency' => 2,
	'workers' => array(
		array(
			'id' => 'Planner Worker',
			'agent' => 'demo-agent',
			'goal' => 'Plan the artifact.',
			'context' => array( 'role' => 'planner' ),
		),
	),
	'orchestrator' => array( 'id' => 'demo-orchestrator' ),
) );

$product_session = WP_Codebox_Browser_Task_Builder::product_browser_session_dto( array(
	'success' => true,
	'schema' => 'wp-codebox/browser-playground-session/v1',
	'execution' => 'browser-playground',
	'execution_scope' => 'disposable-playground',
	'permission_model' => 'runtime-principal',
	'session' => array( 'id' => 'session-123' ),
	'task' => 'Build product-safe output.',
	'task_input' => array( 'goal' => 'Build product-safe output.', 'target' => array( 'kind' => 'site', 'ref' => 'demo' ) ),
	'task_payload' => array( 'secret' => 'must-not-leak' ),
	'agent' => 'custom-agent',
	'provider' => 'test-provider',
	'model' => 'test-model',
	'playground' => array(
		'client_module_url' => 'https://example.test/client.js',
		'remote_url' => 'https://playground.wordpress.net/remote.html',
		'scope' => 'session-123',
		'preview_public_url' => 'https://preview.example.test',
		'site_url' => 'https://site.example.test',
		'preview_url' => '/?preview=1',
		'prepared_runtime' => array( 'cache_key' => 'runtime-cache-key', 'input_hash' => str_repeat( 'a', 64 ), 'status' => 'hit', 'blueprint' => array( 'must' => 'not leak' ) ),
	),
	'contained_site' => array(
		'schema' => 'wp-codebox/browser-contained-site/v1',
		'site_id' => 'runtime-cache-key',
		'preview_id' => 'preview-123',
		'session_id' => 'session-123',
		'status' => 'ready',
		'source_digest' => array( 'algorithm' => 'sha256', 'value' => str_repeat( 'a', 64 ) ),
	),
	'artifacts' => array(
		'preview_url' => '/?preview=1',
		'files' => array(
			array( 'path' => 'index.html', 'kind' => 'browser-html', 'sha256' => str_repeat( 'd', 64 ), 'size' => 42, 'content' => 'must-not-leak' ),
		),
	),
) );
$nested_primary_product_session = WP_Codebox_Browser_Task_Builder::product_browser_session_dto( array(
	'success' => true,
	'schema' => 'wp-codebox/browser-task-contract/v1',
	'session' => array( 'id' => 'nested-session-123' ),
	'primary' => array(
		'playground' => array(
			'client_module_url' => 'https://example.test/nested-client.js',
			'remote_url' => 'https://playground.wordpress.net/nested-remote.html',
			'scope' => 'nested-session-123',
			'preview_url' => '/?nested-preview=1',
			'prepared_runtime' => array( 'cache_key' => 'nested-cache-key', 'input_hash' => str_repeat( 'c', 64 ), 'status' => 'hit' ),
		),
	),
) );
$preview_lease_status = WP_Codebox_Browser_Task_Builder::preview_lease_status( $product_session );

$blueprint_ref = WP_Codebox_Browser_Task_Builder::browser_blueprint_ref( array( 'cache_key' => 'runtime-cache-key', 'input_hash' => str_repeat( 'b', 64 ), 'status' => 'hit' ) );
$GLOBALS['wp_codebox_test_transients']['wp_codebox_browser_prepared_runtime_' . substr( hash( 'sha256', 'runtime-cache-key:' . str_repeat( 'b', 64 ) ), 0, 24 )] = array(
	'schema' => 'wp-codebox/browser-prepared-runtime-artifact/v1',
	'cache_key' => 'runtime-cache-key',
	'input_hash' => str_repeat( 'b', 64 ),
	'blueprint' => array( 'steps' => array( array( 'step' => 'login' ) ) ),
);
$available_blueprint_ref = WP_Codebox_Browser_Task_Builder::browser_blueprint_ref( array( 'cache_key' => 'runtime-cache-key', 'input_hash' => str_repeat( 'b', 64 ), 'status' => 'hit' ) );
$hydrated_blueprint = WP_Codebox_Browser_Task_Builder::hydrate_browser_blueprint_ref( array( 'ref' => $blueprint_ref['ref'] ) );
$missing_blueprint = WP_Codebox_Browser_Task_Builder::hydrate_browser_blueprint_ref( array( 'ref' => 'prepared:missing-runtime:' . str_repeat( 'e', 64 ) ) );
$missing_blueprint_data = is_wp_error( $missing_blueprint ) ? $missing_blueprint->data : array();

$recipe_dto = WP_Codebox_Browser_Task_Builder::browser_recipe_dto( array(
	'schema' => 'wp-codebox/workspace-recipe/v1',
	'runtime' => array(
		'backend' => 'wordpress-playground',
		'name' => 'browser-playground',
		'wp' => 'latest',
		'blueprint' => array( 'steps' => array( array( 'step' => 'runPHP', 'code' => 'must-not-leak' ) ) ),
	),
	'workflow' => array(
		'steps' => array(
			array(
				'command' => 'wordpress.run-php',
				'args' => array( 'code=<?php /* WP_CODEBOX_BROWSER_RUNNER_BODY_START */ must-not-leak /* WP_CODEBOX_BROWSER_RUNNER_BODY_END */' ),
			),
		),
	),
	'browser' => array(
		'execution' => 'php-wasm',
		'task_path' => '/tmp/task.json',
		'result_path' => '/tmp/result.json',
		'runner_contract' => array(
			'schema' => 'wp-codebox/browser-runner-contract/v1',
			'php_prelude' => '<?php function generated_prelude() { return "must-not-leak"; }',
			'php_footer' => '<?php function generated_footer() { return "must-not-leak"; }',
		),
		'task_payload' => array( 'secret' => 'must-not-leak' ),
	),
) );

echo json_encode( array( 'task_input' => $task_input, 'payload' => $payload, 'explicit_plan_payload' => $explicit_plan_payload, 'plan_contract' => $plan_contract, 'plan_plugin_specs' => $plan_plugin_specs, 'local_task' => $local_task, 'intent_task' => $intent_task, 'fanout_request' => $fanout_request, 'product_session' => $product_session, 'nested_primary_product_session' => $nested_primary_product_session, 'preview_lease_status' => $preview_lease_status, 'blueprint_ref' => $blueprint_ref, 'available_blueprint_ref' => $available_blueprint_ref, 'hydrated_blueprint' => $hydrated_blueprint, 'missing_blueprint_data' => $missing_blueprint_data, 'recipe_dto' => $recipe_dto ), JSON_UNESCAPED_SLASHES );
`)

assert.equal(result.task_input.schema, "wp-codebox/task-input/v1")
assert.deepEqual(result.task_input.allowed_tools, ["filesystem_write"])
assert.equal(result.payload.schema, "wp-codebox/browser-agent-task-payload/v1")
assert.equal(result.payload.message, "Build a generic browser task.")
assert.equal(result.payload.session_id, "session-123")
assert.equal(result.payload.provider, "provider-from-inheritance")
assert.equal(result.payload.model, "model-from-inheritance")
assert.deepEqual(result.payload.secret_env, ["OPENAI_API_KEY"])
assert.deepEqual(result.payload.task_input.context, { caller: "test" })
assert.deepEqual(result.payload.agent_bundles, [{ source: "/tmp/agent-bundle.zip", on_conflict: "skip" }])
assert.equal(result.explicit_plan_payload.agent, "planned-agent")
assert.equal(result.explicit_plan_payload.mode, "planned-mode")
assert.equal(result.explicit_plan_payload.provider, "planned-provider")
assert.equal(result.explicit_plan_payload.model, "planned-model")
assert.deepEqual(result.explicit_plan_payload.secret_env, ["PLANNED_SECRET"])
assert.deepEqual(result.explicit_plan_payload.agent_bundles, [{ source: "/tmp/planned-bundle.zip" }])
assert.deepEqual(result.plan_contract.runtime_env, { CONTRACT_ENV: "1" })
assert.deepEqual(result.plan_plugin_specs, [{ slug: "contract-provider", path: "/tmp/contract-provider", activate: true, provenance: { source: "provider-plugin-path" } }])
assert.equal(result.local_task.mode, "sandbox")
assert.equal(result.local_task.target.kind, "browser-playground")
assert.equal(result.local_task.target.ref, "session-123")
assert.equal(result.local_task.context.execution, "wp-codebox-browser-playground")
assert.equal(result.local_task.context.caller, "test")
assert.equal(result.local_task.runtime_profile.schema, "wp-codebox/runtime-profile/v1")
assert.equal(result.local_task.runtime.plugins[0].slug, "profile-plugin")
assert.equal(result.local_task.runtime.plugins[1].slug, "profile-provider")
assert.equal(result.local_task.browser_plugins[0].slug, "browser-extra")
assert.equal(result.local_task.component_contracts[0].slug, "profile-component")
assert.equal(result.local_task.runtime_overlays[0].slug, "profile-overlay")
assert.deepEqual(result.local_task.provider_plugin_paths, ["/profile/provider", "/existing/provider"])
assert.deepEqual(result.local_task.runtime_env, { PROFILE_ENV: "1", EXISTING: "1" })
assert.equal(result.local_task.runtime_requirements, undefined)
assert.deepEqual(result.local_task.placement.allowed_targets, ["browser"])
assert.deepEqual(result.local_task.placement.required_capabilities, ["wordpress.playground", "browser.preview", "artifact.website-bundle"])
assert.equal(result.local_task.browser_runner.invocation.type, "task")
assert.equal(result.local_task.browser_runner.invocation.hook, "wp_codebox_browser_runtime_task")
assert.equal(result.intent_task.goal, "Build from intent.")
assert.equal(result.intent_task.target.kind, "new-site")
assert.equal(result.intent_task.target.ref, "project-7")
assert.deepEqual(result.intent_task.placement.required_capabilities, ["wordpress.playground", "browser.preview", "artifact.website-bundle"])
assert.deepEqual(result.intent_task.allowed_tools, ["filesystem-write", "browser.review"])
assert.equal(result.intent_task.sandbox_tool_policy.tools[0].id, "filesystem-write")
assert.equal(result.intent_task.sandbox_tool_policy.tools[0].runtime_tool_id, "filesystem_write")
assert.equal(result.intent_task.sandbox_tool_policy.tools[1].runtime_tool_id, "browser_review")
assert.equal(result.intent_task.context.product, "demo-product")
assert.equal(result.intent_task.context.active_project_context.project_id, 7)
assert.equal(result.intent_task.context.callback_refs.success.ability, "demo/task-success")
assert.equal(result.intent_task.playground.scope, "demo-session")
assert.equal(result.intent_task.playground.artifact_base_path, "/wordpress/wp-content/uploads/demo-product")
assert.equal(result.intent_task.playground.preview_url, "/?preview=1")
assert.equal(result.intent_task.browser_runner.task_path, "/tmp/demo-task.json")
assert.equal(result.intent_task.browser_runner.result_path, "/tmp/demo-result.json")
assert.equal(result.intent_task.browser_runner.invocation.hook, "demo_task")
assert.equal(result.intent_task.callback_refs.success.ref, "project-7")
assert.equal(result.fanout_request.schema, "wp-codebox/agent-fanout-request/v1")
assert.equal(result.fanout_request.concurrency, 2)
assert.equal(result.fanout_request.workers[0].schema, "wp-codebox/agent-fanout-worker/v1")
assert.equal(result.fanout_request.workers[0].id, "planner-worker")
assert.equal(result.product_session.schema, "wp-codebox/browser-session-product-dto/v1")
assert.equal(result.product_session.session_id, "session-123")
assert.equal(result.product_session.contained_site.schema, "wp-codebox/browser-contained-site/v1")
assert.equal(result.product_session.contained_site.site_id, "runtime-cache-key")
assert.equal(result.product_session.preview_boot.schema, "wp-codebox/browser-preview-boot-config/v1")
assert.equal(result.product_session.preview_boot.contained_site.site_id, "runtime-cache-key")
assert.equal(result.product_session.preview_boot.blueprint_ref, `prepared:runtime-cache-key:${"a".repeat(64)}`)
assert.equal(result.product_session.preview_boot.blueprint_ref_dto.schema, "wp-codebox/browser-blueprint-ref/v1")
assert.equal(result.product_session.preview_boot.blueprint_ref_dto.ref, `prepared:runtime-cache-key:${"a".repeat(64)}`)
assert.equal(result.product_session.preview_boot.blueprint_ref_dto.hydration_status, "expired-transient")
assert.equal(result.product_session.preview_boot.blueprint_ref_dto.hydratable, false)
assert.equal(result.product_session.preview_boot.blueprint_ref_dto.hydrator_ability, "wp-codebox/hydrate-browser-blueprint-ref")
assert.equal(result.product_session.preview_boot.preview.schema, "wp-codebox/preview-lease/v1")
assert.equal(result.product_session.preview_boot.preview.preview_public_url, "https://preview.example.test")
assert.equal(result.product_session.preview_boot.preview.local_url, "/?preview=1")
assert.equal(result.product_session.preview_ref.schema, "wp-codebox/browser-preview-ref/v1")
assert.equal(result.product_session.preview_ref.preview_id, "preview-123")
assert.equal(result.product_session.preview_ref.session_id, "session-123")
assert.equal(result.product_session.preview_ref.boot_ref, `prepared:runtime-cache-key:${"a".repeat(64)}`)
assert.deepEqual(result.product_session.artifact_refs, [{
  schema: "wp-codebox/browser-artifact-ref/v1",
  kind: "browser-html",
  path: "files/browser/index.html",
  digest: { algorithm: "sha256", value: "d".repeat(64) },
  size: 42,
}])
assert.equal(result.nested_primary_product_session.schema, "wp-codebox/browser-session-product-dto/v1")
assert.equal(result.nested_primary_product_session.preview_boot.scope, "nested-session-123")
assert.equal(result.nested_primary_product_session.preview_boot.client_module_url, "https://example.test/nested-client.js")
assert.equal(result.nested_primary_product_session.preview_boot.remote_url, "https://playground.wordpress.net/nested-remote.html")
assert.equal(result.nested_primary_product_session.preview_boot.artifacts.preview_url, "/?nested-preview=1")
assert.equal(result.nested_primary_product_session.preview_boot.blueprint_ref, `prepared:nested-cache-key:${"c".repeat(64)}`)
assert.equal(result.preview_lease_status, "active")
assert.equal(JSON.stringify(result.product_session).includes("must-not-leak"), false)
assert.equal(JSON.stringify(result.product_session).includes('"blueprint":'), false)
assert.equal(result.blueprint_ref.schema, "wp-codebox/browser-blueprint-ref/v1")
assert.equal(result.blueprint_ref.ref, `prepared:runtime-cache-key:${"b".repeat(64)}`)
assert.equal(result.blueprint_ref.hydration_status, "expired-transient")
assert.equal(result.blueprint_ref.hydratable, false)
assert.equal(result.available_blueprint_ref.hydration_status, "available")
assert.equal(result.available_blueprint_ref.hydratable, true)
assert.equal(result.hydrated_blueprint.schema, "wp-codebox/browser-blueprint-hydration/v1")
assert.equal(result.hydrated_blueprint.blueprint.steps[0].step, "login")
assert.equal(result.missing_blueprint_data.status, 409)
assert.equal(result.missing_blueprint_data.schema, "wp-codebox/browser-blueprint-ref-miss/v1")
assert.equal(result.missing_blueprint_data.action, "prepare-new")
assert.equal(result.missing_blueprint_data.preview_state, "expired-transient")
assert.equal(result.missing_blueprint_data.prepare_new_required, true)
assert.equal(result.missing_blueprint_data.reload_required, true)
assert.equal(result.missing_blueprint_data.requires_materialization, true)
assert.equal(result.missing_blueprint_data.blueprint_ref.hydration_status, "expired-transient")
assert.equal(result.missing_blueprint_data.blueprint_ref.hydratable, false)
assert.equal(result.recipe_dto.schema, "wp-codebox/browser-recipe-dto/v1")
assert.equal(result.recipe_dto.source_schema, "wp-codebox/workspace-recipe/v1")
assert.equal(result.recipe_dto.runtime.backend, "wordpress-playground")
assert.equal(result.recipe_dto.workflow.steps[0].args[0].kind, "generated-php")
assert.equal(result.recipe_dto.workflow.steps[0].args[0].runner_contract.php_prelude.type, "generated-php-fragment")
assert.equal(result.recipe_dto.browser.runner_contract.php_footer.type, "generated-php-fragment")
assert.equal(JSON.stringify(result.recipe_dto).includes("must-not-leak"), false)
assert.equal(JSON.stringify(result.recipe_dto).includes("code="), false)
assert.equal(JSON.stringify(result.recipe_dto).includes("php_prelude\":\""), false)

const readiness = await runPhpJson<any>(`
define('ABSPATH', ${rootPath});
class WP_Error {
	public function __construct( public string $code = '', public string $message = '', public array $data = array() ) {}
}
function is_wp_error( $value ) { return $value instanceof WP_Error; }
function wp_json_encode( $value, $flags = 0 ) { return json_encode( $value, $flags ); }
function apply_filters( $hook, $value, ...$args ) { return $value; }
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-agent-task.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-runtime-dependency-plan.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-browser-task-builder.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/trait-wp-codebox-abilities-inheritance.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/trait-wp-codebox-abilities-browser-runtime.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/trait-wp-codebox-abilities-browser-blueprint.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/trait-wp-codebox-abilities-execution.php`)};
class WP_Codebox_Readiness_Test_Abilities {
	use WP_Codebox_Abilities_Inheritance;
	use WP_Codebox_Abilities_Browser_Runtime;
	use WP_Codebox_Abilities_Browser_Blueprint;
	use WP_Codebox_Abilities_Execution;
}
$method = new ReflectionMethod( WP_Codebox_Readiness_Test_Abilities::class, 'browser_ready_to_code_signal' );
$generic = $method->invoke( null, array(
	'goal' => 'Materialize a static artifact.',
	'runtime_requirements' => array( 'requires_provider' => false ),
), array( 'plugins' => array(), 'components' => array() ) );
$provider = $method->invoke( null, array(
	'goal' => 'Run an AI coding agent.',
	'runtime_requirements' => array( 'requires_provider' => true ),
), array( 'plugins' => array(), 'components' => array() ) );
echo json_encode( array( 'generic' => $generic, 'provider' => $provider ), JSON_UNESCAPED_SLASHES );
`)

assert.equal(readiness.generic.emitted, true)
assert.equal(readiness.generic.requirement_metadata.runtime_requirements.requires_provider, false)
assert.equal(readiness.generic.requirements.provider_plugin, true)
assert.equal(readiness.generic.requirements.provider_secret, true)
assert.deepEqual(readiness.generic.missing, [])
assert.equal(readiness.provider.emitted, false)
assert.deepEqual(readiness.provider.missing, ["provider_secret"])

console.log("browser task builder ok")
