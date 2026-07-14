// Behavioral proof that the sandbox agent runtime runs a loop turn natively
// through the Agents API registry + the canonical agents/chat ability WITHOUT
// Data Machine installed.
//
// The wp-codebox sandbox generates PHP (see agent-code.ts) that:
//   1. registers the requested agent in Agents API's own WP_Agents_Registry, and
//   2. dispatches the canonical `agents/chat` ability.
//
// In a real sandbox, step 2 routes through the `wp_agent_chat_handler` filter to
// the Agents API default handler (WP_Agent_Default_Chat_Handler, priority 1000),
// which resolves the agent from WP_Agents_Registry and runs one conversation-loop
// turn. This test executes the generated PHP under `php` with:
//   - Data Machine's Agents class deliberately ABSENT (class never defined), and
//   - a stub `agents/chat` ability standing in for the Agents API default handler
//     that, like the real handler, RESOLVES THE AGENT FROM THE REGISTRY and fails
//     if it was not registered there.
//
// It asserts the agent was registered natively (not via Data Machine), the loop
// produced a reply, and Data Machine was never present. This is the unit-level
// proof of the agent-resolution + handler-dispatch path; a full Playground boot
// with the real default handler + a real provider turn is exercised separately by
// the Agents API plugin's own suite.

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { canonicalExternalNativeAgentIdentity } from "../.github/scripts/run-agent-task/materialize-external-native-package.mjs"
import { resolveSandboxTaskCode } from "../packages/cli/src/agent-code.js"

// No `provider` is supplied, so the generated provider-validation short-circuits
// (it only inspects the wp-ai-client registry when a provider id is present),
// keeping the stubbed environment minimal and deterministic.
const sandboxAgentCode = await resolveSandboxTaskCode({
  task: "Say hello",
  agent: "wp-codebox-sandbox",
  sandboxToolPolicy: { schema: "wp-codebox/sandbox-tool-policy/v1", version: 1, tools: [] },
})

// Guardrail: the generated runtime must not reach for Data Machine at all.
assert.doesNotMatch(sandboxAgentCode, /DataMachine\\Core\\Database\\Agents\\Agents|data_machine_agent_create_failed/)

// PHP test harness: minimal WordPress + Agents API registry shims, plus a stub
// `agents/chat` ability that mimics the Agents API default chat handler by
// resolving the agent from the native registry. Data Machine's Agents class is
// intentionally never declared.
const phpPreamble = `
$sandbox_stack = array('signals' => array(), 'plugins' => array());

function wp_set_current_user($id) { return $id; }
function add_filter($hook, $cb, $prio = 10, $args = 1) { return true; }
function apply_filters($hook, $value) { return $value; }
function sanitize_title($s) { return trim(strtolower(preg_replace('/[^a-z0-9]+/i', '-', (string) $s) ?? ''), '-'); }
function get_current_user_id() { return 1; }
function is_wp_error($v) { return $v instanceof WP_Error; }
function wp_json_encode($v, $flags = 0) { return json_encode($v, $flags); }
function wp_get_abilities() { return array('agents/chat' => true); }

class WP_Error {
    public function __construct(public string $code = '', public string $message = '', public array $data = array()) {}
    public function get_error_code() { return $this->code; }
    public function get_error_message() { return $this->message; }
    public function get_error_data() { return $this->data; }
}

final class WP_Agents_Registry {
    private array $agents = array();
    public static ?WP_Agents_Registry $instance = null;
    public static function get_instance(): ?WP_Agents_Registry {
        if (self::$instance === null) { self::$instance = new self(); }
        return self::$instance;
    }
    public function register($slug, array $args = array()) {
        $slug = sanitize_title((string) $slug);
        if ('' === $slug || isset($this->agents[$slug])) { return null; }
        $this->agents[$slug] = $args;
        return (object) array('slug' => $slug, 'args' => $args);
    }
    public function is_registered($slug): bool { return isset($this->agents[sanitize_title((string) $slug)]); }
    public function get_registered($slug) { return $this->agents[sanitize_title((string) $slug)] ?? null; }
}

function wp_get_agent($slug) {
    $registry = WP_Agents_Registry::get_instance();
    return ($registry && $registry->is_registered($slug)) ? (object) array('slug' => sanitize_title((string) $slug)) : null;
}

function wp_get_ability($name) {
    $GLOBALS['ability_resolved'] = true;
    if (isset($GLOBALS['external_import']) && (!($GLOBALS['external_import']['before_ability'] ?? false) || file_exists((string) ($GLOBALS['external_import']['source'] ?? '')))) { return null; }
    if ('wp-codebox/run-runtime-package' === $name) {
        return new class {
            public function execute(array $task) {
                $GLOBALS['ability_invocations'][] = 'wp-codebox/run-runtime-package';
                $slug = (string) ($task['metadata']['imported_agent']['slug'] ?? '');
                if ('' === $slug || $slug !== (string) ($GLOBALS['wp_codebox_private_runtime_package_import']['identity']['slug'] ?? '')) {
                    return new WP_Error('wp_codebox_runtime_package_imported_agent_unresolved', 'Imported agent identity did not resolve.');
                }
                return wp_get_ability('agents/chat')->execute(array('agent' => $slug));
            }
        };
    }
    if ('agents/chat' !== $name) { return null; }
    return new class {
        public function execute(array $input) {
            $GLOBALS['ability_invocations'][] = 'agents/chat:' . (string) ($input['agent'] ?? '');
            // Mirror the Agents API default handler: resolve the agent from the
            // native registry; a missing registration is a hard error.
            $slug = isset($input['agent']) ? sanitize_title((string) $input['agent']) : '';
            $registry = WP_Agents_Registry::get_instance();
            if ('' !== $slug && (!$registry || !$registry->is_registered($slug))) {
                return new WP_Error('agents_chat_agent_not_found', 'Agent is not registered.', array('status' => 404));
            }
            // One deterministic conversation-loop turn in canonical output shape.
            return array(
                'session_id' => 'sess-no-dm-1',
                'reply'      => 'Native handler reply: hello',
                'messages'   => array(
                    array('role' => 'user', 'content' => 'hi'),
                    array('role' => 'assistant', 'content' => 'Native handler reply: hello'),
                ),
                'completed'  => true,
                'metadata'   => array('agents_api' => array(
                    'handler'                    => 'wp-agent-default-chat-handler',
                    'agent_resolved_from_registry' => ('' !== $slug && $registry && $registry->is_registered($slug)),
                    'data_machine_present'       => class_exists('DataMachine\\\\Core\\\\Database\\\\Agents\\\\Agents'),
                    'registered_config'          => ('' !== $slug && $registry) ? $registry->get_registered($slug) : null,
                    'external_package_imported'  => !empty($GLOBALS['external_import']['bytes']),
                    'ability_invocations'        => $GLOBALS['ability_invocations'] ?? array(),
                )),
            );
        }
    };
}
`

const output = execFileSync("php", ["-r", `${phpPreamble}\n${sandboxAgentCode}`], { encoding: "utf8" })

const parsed = JSON.parse(output) as {
  agent_runtime?: {
    success?: boolean
    result?: {
      reply?: unknown
      completed?: unknown
      metadata?: { agents_api?: Record<string, unknown> }
    }
    error?: { code?: string; message?: string }
  }
}

const runtime = parsed.agent_runtime
assert.ok(runtime, "agent_runtime payload missing")
assert.equal(runtime?.success, true, `expected success; got error: ${JSON.stringify(runtime?.error)}`)

const result = runtime?.result
assert.ok(result, "agent_runtime.result missing")
assert.equal(result?.reply, "Native handler reply: hello")
assert.equal(result?.completed, true)

const agentsApiMeta = result?.metadata?.agents_api ?? {}
// The agent the sandbox registered must be resolvable from the native registry...
assert.equal(agentsApiMeta.agent_resolved_from_registry, true, "agent was not resolved from the Agents API registry")
// ...and Data Machine must NOT have been present for the loop to run.
assert.equal(agentsApiMeta.data_machine_present, false, "Data Machine must not be required for the native loop")
assert.equal(agentsApiMeta.handler, "wp-agent-default-chat-handler")

// The registered agent's default config must carry provider/model under the keys
// the Agents API default handler reads ('provider'/'model'), so the native loop
// can source them from agent config alone when a request omits them.
assert.match(sandboxAgentCode, /'provider' => \$configured_provider/)
assert.match(sandboxAgentCode, /'model' => \$configured_model/)

// A public standalone package is embedded in the runtime recipe, imported before
// ability resolution, and its importer-only source is removed before tools run.
const docsAgentDirectory = process.env.DOCS_AGENT_DIR
const publicPackageBytes = docsAgentDirectory
  ? await readFile(join(docsAgentDirectory, "bundles", "technical-docs-agent", "native", "technical-docs-maintenance-agent.agent.json"))
  : await readFile(new URL("./fixtures/external-native-package/technical-bootstrap-agent.agent.json", import.meta.url))
const publicAgentSlug = canonicalExternalNativeAgentIdentity(publicPackageBytes).slug
const skillsPackageBytes = await readFile(new URL("./fixtures/external-native-package/skills-agent.agent.json", import.meta.url))
assert.deepEqual(canonicalExternalNativeAgentIdentity(skillsPackageBytes), { slug: "skills-agent" })
assert.deepEqual(canonicalExternalNativeAgentIdentity(publicPackageBytes), { slug: docsAgentDirectory ? "technical-docs-maintenance-agent" : "technical-bootstrap-agent" })
const publicPackageDigest = `sha256-bytes-v1:${await import("node:crypto").then(({ createHash }) => createHash("sha256").update(publicPackageBytes).digest("hex"))}`
const bootstrapCode = await resolveSandboxTaskCode({
  task: "Say hello",
  agent: "wp-codebox-sandbox",
  runtimeTask: {
    ability: "wp-codebox/run-runtime-package",
    input: {
      package: { slug: publicAgentSlug, source: "public-external-package", bootstrap: { encoding: "base64", bytes: publicPackageBytes.toString("base64"), digest: publicPackageDigest } },
    },
  },
  sandboxToolPolicy: { schema: "wp-codebox/sandbox-tool-policy/v1", version: 1, tools: [] },
})
const bootstrapOutput = execFileSync("php", ["-r", `${phpPreamble}
function wp_agent_import_runtime_bundles($bundles, $options) {
    $source = $bundles[0]['source'] ?? '';
    $GLOBALS['external_import'] = array('before_ability' => !isset($GLOBALS['ability_resolved']), 'bytes' => is_file($source) ? file_get_contents($source) : false, 'source' => $source);
    $package = json_decode((string) $GLOBALS['external_import']['bytes'], true);
    $slug = $package['agent']['agent_slug'] ?? '';
    WP_Agents_Registry::get_instance()->register($slug, array('source' => 'canonical-importer'));
    return array(array('success' => true, 'agent_slug' => $slug));
}
${bootstrapCode}`], {
  encoding: "utf8",
})
const bootstrapParsed = JSON.parse(bootstrapOutput) as { agent_runtime?: { success?: boolean, result?: { metadata?: { agents_api?: { external_package_imported?: boolean, ability_invocations?: string[] } } } } }
assert.equal(bootstrapParsed.agent_runtime?.success, true, JSON.stringify(bootstrapParsed))
assert.equal(bootstrapParsed.agent_runtime?.result?.metadata?.agents_api?.external_package_imported, true, "decoded public bytes must reach the canonical importer")
assert.equal((bootstrapParsed.agent_runtime?.result?.metadata?.agents_api?.registered_config as { source?: string } | undefined)?.source, "canonical-importer", "canonical importer must register the declared package agent")
assert.deepEqual(bootstrapParsed.agent_runtime?.result?.metadata?.agents_api?.ability_invocations, ["wp-codebox/run-runtime-package", `agents/chat:${publicAgentSlug}`], "the imported identity must be selected after canonical import")
assert.match(bootstrapCode, new RegExp(publicPackageBytes.toString("base64")))
assert.match(bootstrapCode, /wp_codebox_import_external_runtime_agent_package/)
assert.ok(bootstrapCode.indexOf("wp_codebox_import_external_runtime_agent_package") < bootstrapCode.indexOf("wp_codebox_resolve_runtime_task_ability"))
assert.match(bootstrapCode, /base64_decode\(\$bootstrap\['bytes'\], true\)/)

const spoofedBootstrapCode = await resolveSandboxTaskCode({
  task: "Say hello",
  agent: "wp-codebox-sandbox",
  runtimeTask: {
    ability: "wp-codebox/run-runtime-package",
    input: {
      package: { slug: publicAgentSlug, source: "public-external-package", bootstrap: { encoding: "base64", bytes: publicPackageBytes.toString("base64"), digest: publicPackageDigest } },
      input: { agent: "caller-controlled-agent" },
    },
  },
  sandboxToolPolicy: { schema: "wp-codebox/sandbox-tool-policy/v1", version: 1, tools: [] },
})
const spoofedBootstrapOutput = execFileSync("php", ["-r", `${phpPreamble}
function wp_agent_import_runtime_bundles($bundles, $options) {
    $package = json_decode((string) file_get_contents((string) ($bundles[0]['source'] ?? '')), true);
    $slug = $package['agent']['agent_slug'] ?? '';
    WP_Agents_Registry::get_instance()->register($slug, array('source' => 'canonical-importer'));
    return array(array('success' => true, 'agent_slug' => $slug));
}
${spoofedBootstrapCode}`], { encoding: "utf8" })
const spoofedBootstrap = JSON.parse(spoofedBootstrapOutput) as { agent_runtime?: { success?: boolean, error?: { code?: string } } }
assert.equal(spoofedBootstrap.agent_runtime?.success, false)
assert.equal(spoofedBootstrap.agent_runtime?.error?.code, "wp_codebox_external_runtime_package_identity_mismatch")

const failedImportOutput = execFileSync("php", ["-r", `${phpPreamble}
function wp_agent_import_runtime_bundles($bundles, $options) { $GLOBALS['external_source'] = $bundles[0]['source']; return array(array('success' => false)); }
${bootstrapCode}`], {
  encoding: "utf8",
})
const failedImport = JSON.parse(failedImportOutput) as { agent_runtime?: { success?: boolean } }
assert.equal(failedImport.agent_runtime?.success, false, "Import failure must stop before the agent loop starts")

const ambiguousPackageBytes = Buffer.from('{"schema_version":1,"bundle_slug":"public-agent","agent":{"agent_slug":"public-agent"},"package_slug":"caller-controlled"}\n')
const ambiguousPackageDigest = await import("node:crypto").then(({ createHash }) => `sha256-bytes-v1:${createHash("sha256").update(ambiguousPackageBytes).digest("hex")}`)
const ambiguousPackageCode = await resolveSandboxTaskCode({
  task: "Say hello",
  agent: "wp-codebox-sandbox",
  runtimeTask: {
    ability: "wp-codebox/run-runtime-package",
    input: {
      package: { source: "public-external-package", bootstrap: { encoding: "base64", bytes: ambiguousPackageBytes.toString("base64"), digest: ambiguousPackageDigest } },
    },
  },
  sandboxToolPolicy: { schema: "wp-codebox/sandbox-tool-policy/v1", version: 1, tools: [] },
})
const ambiguousPackageOutput = execFileSync("php", ["-r", `${phpPreamble}\n${ambiguousPackageCode}`], { encoding: "utf8" })
const ambiguousPackage = JSON.parse(ambiguousPackageOutput) as { agent_runtime?: { success?: boolean, error?: { code?: string } } }
assert.equal(ambiguousPackage.agent_runtime?.success, false)
assert.equal(ambiguousPackage.agent_runtime?.error?.code, "wp_codebox_external_runtime_package_json_invalid")

console.log("agent-no-data-machine-loop: native agents/chat loop turn ran without Data Machine")
