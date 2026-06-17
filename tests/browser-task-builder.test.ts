import assert from "node:assert/strict"

import { phpStringLiteral, repoRoot, runPhpJson } from "../scripts/test-kit.js"

const rootPath = phpStringLiteral(repoRoot)
const result = await runPhpJson<any>(`
define('ABSPATH', ${rootPath});
class WP_Error {
	public function __construct( public string $code = '', public string $message = '', public array $data = array() ) {}
}
function is_wp_error( $value ) { return $value instanceof WP_Error; }
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-task-input-contract.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-runtime-tool-policy-descriptor.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-sandbox-tool-policy-normalizer.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-agent-task.php`)};
require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-runtime-dependency-plan.php`)};
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

echo json_encode( array( 'task_input' => $task_input, 'payload' => $payload, 'explicit_plan_payload' => $explicit_plan_payload, 'local_task' => $local_task, 'intent_task' => $intent_task, 'fanout_request' => $fanout_request ), JSON_UNESCAPED_SLASHES );
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
assert.equal(result.local_task.mode, "sandbox")
assert.equal(result.local_task.target.kind, "browser-playground")
assert.equal(result.local_task.target.ref, "session-123")
assert.equal(result.local_task.context.execution, "wp-codebox-browser-playground")
assert.equal(result.local_task.context.caller, "test")
assert.deepEqual(result.local_task.placement.allowed_targets, ["browser"])
assert.deepEqual(result.local_task.placement.required_capabilities, ["wordpress.playground", "browser.preview", "artifact.website-bundle"])
assert.equal(result.local_task.browser_runner.invocation.name, "agents/chat")
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

console.log("browser task builder ok")
