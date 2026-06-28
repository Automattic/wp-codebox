import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdtempSync } from "node:fs"
import { resolveSandboxTaskCode } from "../packages/cli/src/agent-code.js"
import { phpRuntimeComponentLifecycleActionReplayFunction, phpRuntimeComponentLifecycleReplayFunction } from "../packages/runtime-core/src/index.js"
import { bootstrapPhpCode } from "../packages/runtime-playground/src/php-bootstrap.js"

const lifecycleReplaySnippet = phpRuntimeComponentLifecycleReplayFunction("contained_runtime_test")
assert.match(lifecycleReplaySnippet, /function contained_runtime_test_component_lifecycle_replay_prepare\(\): array/)
assert.match(lifecycleReplaySnippet, /'schema' => 'wp-codebox\/runtime-component-lifecycle-replay\/v1'/)
assert.doesNotMatch(lifecycleReplaySnippet, /wp_codebox|WP_CODEBOX/)

const replayOutput = execFileSync(
  "php",
  [
    "-r",
    `${lifecycleReplaySnippet}

class WP_Hook {
    public array $callbacks = array();
}

$wp_filter = array('init' => new WP_Hook());
$wp_actions = array('init' => 1);
$wp_current_filter = array();
$GLOBALS['calls'] = array();

function did_action($hook_name) { return (int) ($GLOBALS['wp_actions'][$hook_name] ?? 0); }
function wp_get_abilities() { return array('before' => true, 'after' => true); }

$GLOBALS['wp_filter']['init']->callbacks[10]['existing'] = array('function' => static function () { $GLOBALS['calls'][] = 'existing'; }, 'accepted_args' => 0);
$state = contained_runtime_test_component_lifecycle_replay_prepare();
$GLOBALS['wp_filter']['init']->callbacks[20]['new'] = array('function' => static function () { $GLOBALS['calls'][] = 'new'; }, 'accepted_args' => 0);
$diagnostic = contained_runtime_test_component_lifecycle_replay_complete($state);

echo json_encode(array(
    'calls' => $GLOBALS['calls'],
    'did_init' => did_action('init'),
    'init' => $diagnostic['hooks']['init'],
    'abilities_added' => $diagnostic['abilities_added'],
));`,
  ],
  { encoding: "utf8" },
)

assert.deepEqual(JSON.parse(replayOutput), {
  calls: ["new"],
  did_init: 1,
  init: { replayed_callbacks: 1, previous_did_action: 1 },
  abilities_added: [],
})

const actionReplaySnippet = phpRuntimeComponentLifecycleActionReplayFunction("contained_runtime_replay_component_lifecycle")
assert.match(actionReplaySnippet, /function contained_runtime_replay_component_lifecycle\(\): array/)
assert.doesNotMatch(actionReplaySnippet, /wp_codebox|WP_CODEBOX/)

const actionOutput = execFileSync(
  "php",
  [
    "-r",
    `${actionReplaySnippet}

$wp_actions = array();
function do_action($hook_name) { $GLOBALS['wp_actions'][$hook_name] = (int) ($GLOBALS['wp_actions'][$hook_name] ?? 0) + 1; }
function did_action($hook_name) { return (int) ($GLOBALS['wp_actions'][$hook_name] ?? 0); }

echo json_encode(contained_runtime_replay_component_lifecycle());`,
  ],
  { encoding: "utf8" },
)

assert.deepEqual(JSON.parse(actionOutput), {
  plugins_loaded: 1,
  init: 1,
  wp_abilities_api_categories_init: 1,
  wp_abilities_api_init: 1,
  contained_runtime_abilities_ready: 1,
})

const bootstrappedRunPhp = bootstrapPhpCode({
  metadata: {
    recipe: {
      inputs: {
        extra_plugins: [{ slug: "example", pluginFile: "example/example.php", activate: true }],
        component_manifest: { schema: "wp-codebox/component-manifest/v1", components: [], providers: [] },
      },
    },
  },
} as never, "<?php echo 'ok';", [])
assert.match(bootstrappedRunPhp, /contained_runtime_run_php_component_lifecycle_replay_prepare/)
assert.match(bootstrappedRunPhp, /CONTAINED_RUNTIME_COMPONENT_MANIFEST_JSON/)
assert.doesNotMatch(bootstrappedRunPhp, /wp_codebox_run_php|wp_codebox_component_manifest|WP_CODEBOX_COMPONENT_MANIFEST_JSON/)

const sandboxAgentCode = await resolveSandboxTaskCode({
  task: "Say hello",
  agent: "wp-codebox-sandbox",
  provider: "codex",
  model: "gpt-5.5",
  sandboxToolPolicy: { schema: "wp-codebox/sandbox-tool-policy/v1", version: 1, tools: [] },
})
assert.doesNotMatch(sandboxAgentCode, /wp_codebox_register_sandbox_chat_handler\(\)/)
assert.doesNotMatch(sandboxAgentCode, /wp_agent_chat_handler/)
assert.doesNotMatch(sandboxAgentCode, /wp_codebox_execute_sandbox_chat_turn/)

const sandboxAgentCodeWithRuntimeTask = await resolveSandboxTaskCode({
  task: "Run fuzz suite",
  agent: "wp-codebox-sandbox",
  runtimeTask: {
    ability: "wp-codebox/fuzz-suite",
    input: { metadata: { workload_path: "${package.root}/bench/fuzz.php" } },
  },
  sandboxToolPolicy: { schema: "wp-codebox/sandbox-tool-policy/v1", version: 1, tools: [] },
})
assert.match(sandboxAgentCodeWithRuntimeTask, /json_decode\(<<<'WP_CODEBOX_LITERAL_/)
assert.doesNotMatch(sandboxAgentCodeWithRuntimeTask, /json_decode\(".*\$\{package\.root\}/s)

const bundleRoot = mkdtempSync(join(tmpdir(), "wp-codebox-runtime-package-bundle-"))
const workspaceRoot = join(bundleRoot, "workspace")
const bundlePath = join(workspaceRoot, "bundles", "store-idea-agent")
mkdirSync(join(bundlePath, "pipelines"), { recursive: true })
mkdirSync(join(bundlePath, "flows"), { recursive: true })
mkdirSync(join(bundlePath, "memory", "agent"), { recursive: true })
writeFileSync(join(bundlePath, "manifest.json"), JSON.stringify({ bundle_slug: "store-idea-agent", bundle_version: "1", agent: { slug: "store-idea-agent", label: "Store Idea Agent" } }))
writeFileSync(join(bundlePath, "pipelines", "store-idea-artifact-pipeline.json"), JSON.stringify({ slug: "store-idea-artifact-pipeline", name: "Store Idea Artifact Pipeline", steps: [{ step_position: 0, step_type: "ai", step_config: { label: "Generate" } }] }))
writeFileSync(join(bundlePath, "flows", "store-idea-artifact-flow.json"), JSON.stringify({ slug: "store-idea-artifact-flow", name: "Store Idea Artifact", pipeline_slug: "store-idea-artifact-pipeline", schedule: "manual", max_items: [], steps: [{ step_position: 0, step_type: "ai" }] }))
writeFileSync(join(bundlePath, "memory", "agent", "SOUL.md"), "# Store Idea Agent\n")
const sandboxAgentCodeWithRuntimePackageBundle = await resolveSandboxTaskCode({
  task: "Run runtime package",
  agent: "wp-codebox-sandbox",
  runtimeTask: {
    ability: "wp-codebox/run-runtime-package",
    input: { package: { slug: "store-idea-agent", source: "/workspace/example/bundles/store-idea-agent" } },
  },
  sandboxWorkspace: {
    schema: "wp-codebox/sandbox-workspace/v1",
    root: "/workspace",
    defaultMode: "repo-backed",
    mounts: [{ target: "/workspace/example", source: workspaceRoot, mode: "readwrite", sourceMode: "repo-backed" } as never],
  },
  sandboxToolPolicy: { schema: "wp-codebox/sandbox-tool-policy/v1", version: 1, tools: [] },
})
assert.match(sandboxAgentCodeWithRuntimePackageBundle, /"bundle_slug":"store-idea-agent"/)
assert.match(sandboxAgentCodeWithRuntimePackageBundle, /"bundle":\{"bundle_version":"1","bundle_slug":"store-idea-agent"/)

const sandboxAgentCodeWithTools = await resolveSandboxTaskCode({
  task: "Inspect workspace",
  agent: "wp-codebox-sandbox",
  provider: "codex",
  model: "gpt-5.5",
  sandboxToolPolicy: {
    schema: "wp-codebox/sandbox-tool-policy/v1",
    version: 1,
    metadata: {},
    tools: [
      {
        id: "workspace_ls",
        runtime_tool_id: "workspace_ls",
        execution_location: "sandbox",
        transport_visibility: "sandbox",
        allowed: true,
        runtime: {
          environment: "runtime_local",
          capability_scope: "runtime_local",
        },
      },
    ],
  },
})
assert.match(sandboxAgentCodeWithTools, /"allow_only":\["workspace_ls"\]/)
assert.match(sandboxAgentCodeWithTools, /"completion_assertions":\{"required_tool_names":\["workspace_ls"\]\}/)
