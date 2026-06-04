import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { sandboxAllowedRuntimeToolIds, SANDBOX_WORKSPACE_ROOT, type SandboxToolPolicySnapshot, type SandboxWorkspaceContract } from "@automattic/wp-codebox-core"

export interface AgentBundleSpec {
  source?: string
  bundle?: Record<string, unknown>
  slug?: string
  on_conflict?: "error" | "skip" | "upgrade"
  owner_id?: number
  token_env?: string
  import_principal?: Record<string, unknown>
}

export interface AgentSandboxCodeOptions {
  task: string
  agent?: string
  mode?: string
  provider?: string
  model?: string
  sessionId?: string
  maxTurns?: string
  timeoutSeconds?: string
  agentBundles?: AgentBundleSpec[]
  runtimeTask?: Record<string, unknown>
  sandboxToolPolicy?: SandboxToolPolicySnapshot
  code?: string
  codeFile?: string
  sandboxWorkspace?: SandboxWorkspaceContract
}

export async function resolveSandboxTaskCode(options: AgentSandboxCodeOptions): Promise<string> {
  if (options.agent) {
    return agentChatTaskCode(options)
  }

  if (options.code) {
    return options.code
  }

  if (options.codeFile) {
    return readFile(resolve(options.codeFile), "utf8")
  }

  return `echo json_encode(array('task_received' => true), JSON_PRETTY_PRINT);`
}

function agentChatTaskCode(options: AgentSandboxCodeOptions): string {
  const mode = options.mode ?? "sandbox"
  const agentModes = sandboxAgentModes(mode)
  const sandboxToolPolicy = options.sandboxToolPolicy
  if (!sandboxToolPolicy) {
    throw new Error("wp-codebox.agent-sandbox-run requires sandbox-tool-policy-json for agent runs")
  }
  const runtimeToolIds = sandboxAllowedRuntimeToolIds(sandboxToolPolicy)
  const input: Record<string, unknown> = {
    agent: options.agent,
    message: options.task,
    mode,
    modes: agentModes,
    client_context: {
      source: "bridge",
      client_name: "wp-codebox",
      connector_id: "wp-codebox-cli",
      codebox_session_id: options.sessionId ?? null,
      mode,
      agent_modes: agentModes,
      workspace_root: SANDBOX_WORKSPACE_ROOT,
      sandbox_workspace: options.sandboxWorkspace ?? null,
      default_workspace: defaultSandboxWorkspace(options.sandboxWorkspace),
      tool_contract: sandboxToolContract(sandboxToolPolicy),
    },
    principal: runtimePrincipal(options.agent, options.sessionId, mode),
  }

  if (options.maxTurns) {
    input.max_turns = Number.parseInt(options.maxTurns, 10)
  }
  if (options.provider) {
    input.provider = options.provider
  }
  if (options.model) {
    input.model = options.model
  }
  if (runtimeToolIds.length) {
    const toolPolicy = { mode: "allow", tools: runtimeToolIds }
    input.tool_policy = toolPolicy
    input.allow_only = runtimeToolIds
  }

  const timeoutSeconds = Number.parseInt(options.timeoutSeconds ?? '', 10)
  const timeoutLimit = Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds : 0
  const agentBundles = normalizeAgentBundleSpecs(options.agentBundles ?? [])
  const runtimeTask = normalizeRuntimeTask(options.runtimeTask, input)

  return `
if (function_exists('wp_set_current_user')) {
    wp_set_current_user(1);
}

if (${timeoutLimit} > 0 && function_exists('set_time_limit')) {
    set_time_limit(${timeoutLimit});
}

if (!defined('DATAMACHINE_WORKSPACE_PATH')) {
    define('DATAMACHINE_WORKSPACE_PATH', ${JSON.stringify(SANDBOX_WORKSPACE_ROOT)});
}

add_filter('datamachine_code_remote_workspace_backend_should_handle', '__return_false', 100);

$sandbox_workspace_adoptions = array();
if (function_exists('wp_get_ability')) {
    $sandbox_adopt_callback = static function () use (&$sandbox_workspace_adoptions): void {
        $sandbox_adopt_ability = wp_get_ability('datamachine/workspace-adopt');
        if (!$sandbox_adopt_ability || !method_exists($sandbox_adopt_ability, 'execute')) {
            return;
        }
        foreach (glob(rtrim(DATAMACHINE_WORKSPACE_PATH, '/') . '/*', GLOB_ONLYDIR) ?: array() as $sandbox_workspace_dir) {
            $sandbox_workspace_name = basename($sandbox_workspace_dir);
            if (is_file($sandbox_workspace_dir . '/.git')) {
                $sandbox_workspace_adoptions[$sandbox_workspace_name] = array(
                    'success' => true,
                    'skipped' => true,
                    'reason' => 'linked_worktree_mount',
                    'message' => 'Mounted linked worktrees are treated as sandbox workspaces, not Data Machine primary checkouts.',
                );
                continue;
            }
            $sandbox_adopt_result = $sandbox_adopt_ability->execute(array(
                'path' => $sandbox_workspace_dir,
                'name' => $sandbox_workspace_name,
            ));
            $sandbox_workspace_adoptions[$sandbox_workspace_name] = is_wp_error($sandbox_adopt_result)
                ? array('success' => false, 'error' => $sandbox_adopt_result->get_error_message())
                : $sandbox_adopt_result;
        }
    };
    if (class_exists('DataMachine\\Abilities\\PermissionHelper')) {
        DataMachine\\Abilities\\PermissionHelper::run_as_authenticated($sandbox_adopt_callback, 1);
    } else {
        $sandbox_adopt_callback();
    }
}
$sandbox_stack['workspace_adoptions'] = $sandbox_workspace_adoptions;

$sandbox_agent_bundles = json_decode(${JSON.stringify(JSON.stringify(agentBundles))}, true);
$sandbox_agent_bundle_imports = wp_codebox_import_sandbox_agent_bundles(is_array($sandbox_agent_bundles) ? $sandbox_agent_bundles : array());
$sandbox_stack['agent_bundle_imports'] = $sandbox_agent_bundle_imports;
$sandbox_agent_bundle_import_failures = array_filter($sandbox_agent_bundle_imports, static fn($import) => is_array($import) && empty($import['success']));
$sandbox_runtime_task = json_decode(${JSON.stringify(JSON.stringify(runtimeTask))}, true);
$sandbox_stack['runtime_task'] = is_array($sandbox_runtime_task) ? $sandbox_runtime_task : null;

add_filter('agents_chat_runtime_principal_permission', static function (bool $allowed, $principal, array $input): bool {
    if (!$principal instanceof AgentsAPI\AI\WP_Agent_Execution_Principal) {
        return $allowed;
    }
    if ('runtime' !== $principal->auth_source || 'runtime' !== $principal->request_context) {
        return $allowed;
    }
    if ('wp-codebox-cli' !== $principal->client_id || 'wp-codebox' !== $principal->workspace_id || 'runtime' !== $principal->owner_type) {
        return $allowed;
    }
    if ('wordpress-playground' !== (string) ($principal->audience_claims['runtime_type'] ?? '')) {
        return $allowed;
    }
    return 'wp-codebox' === (string) ($input['principal']['workspace_id'] ?? '') && 'wp-codebox-cli' === (string) ($input['principal']['client_id'] ?? '');
}, 100, 3);

function wp_codebox_import_sandbox_agent_bundles(array $bundle_specs): array {
    if (empty($bundle_specs)) {
        return array();
    }

    if (function_exists('wp_agent_import_runtime_bundles')) {
        return wp_agent_import_runtime_bundles($bundle_specs, array('owner_id' => get_current_user_id() ?: 1));
    }

    $imports = array();
    foreach ($bundle_specs as $index => $spec) {
        if (!is_array($spec)) {
            $imports[] = array('success' => false, 'index' => $index, 'error' => array('code' => 'agent_bundle_spec_invalid', 'message' => 'Agent bundle spec must be an object.'));
            continue;
        }

        if (!isset($spec['source']) && !isset($spec['bundle'])) {
            $imports[] = array('success' => false, 'index' => $index, 'error' => array('code' => 'agent_bundle_source_missing', 'message' => 'Agent bundle spec requires source or bundle.'));
            continue;
        }

        $input = array('on_conflict' => (string) ($spec['on_conflict'] ?? 'upgrade'));
        if (isset($spec['source']) && '' !== trim((string) $spec['source'])) {
            $input['source'] = trim((string) $spec['source']);
        }
        foreach (array('slug', 'token_env') as $field) {
            if (isset($spec[$field]) && '' !== trim((string) $spec[$field])) {
                $input[$field] = trim((string) $spec[$field]);
            }
        }
        if (isset($spec['owner_id']) && (int) $spec['owner_id'] > 0) {
            $input['owner_id'] = (int) $spec['owner_id'];
        } else {
            $input['owner_id'] = get_current_user_id() ?: 1;
        }
        if (isset($spec['import_principal']) && is_array($spec['import_principal'])) {
            $input['import_principal'] = $spec['import_principal'];
        }

        $result = apply_filters('wp_agent_runtime_import_bundle', null, $spec, $input, $index);
        if (null === $result) {
            $result = new WP_Error('wp_codebox_agent_bundle_importer_unavailable', 'No runtime agent bundle importer handled this bundle spec.', array('index' => $index));
        }
        $imports[] = is_wp_error($result)
            ? array('success' => false, 'index' => $index, 'source' => isset($input['source']) ? $input['source'] : 'inline', 'error' => array('code' => $result->get_error_code(), 'message' => $result->get_error_message(), 'data' => $result->get_error_data()))
            : array_merge(array('index' => $index, 'source' => isset($input['source']) ? $input['source'] : 'inline'), is_array($result) ? $result : array('result' => $result));
    }

    return $imports;
}

$runtime_task_run = is_array($sandbox_runtime_task) && !empty($sandbox_runtime_task);
$ability_name = $runtime_task_run ? (string) ($sandbox_runtime_task['ability'] ?? '') : 'agents/chat';
$ability = empty($sandbox_agent_bundle_import_failures) && function_exists('wp_get_ability') ? wp_get_ability($ability_name) : null;
if (!empty($sandbox_agent_bundle_import_failures)) {
    $sandbox_agent_runtime = array(
        'agent_runtime' => array(
            'success' => false,
            'error' => array(
                'code' => 'agent_bundle_import_failed',
                'message' => 'One or more runtime agent bundles failed to import before sandbox invocation.',
                'data' => array('agent_bundle_imports' => array_values($sandbox_agent_bundle_import_failures)),
            ),
        ),
    );
} elseif (!$ability || !method_exists($ability, 'execute')) {
    $sandbox_agent_runtime = array(
        'agent_runtime' => array(
            'success' => false,
            'error' => array(
                'code' => $runtime_task_run ? 'runtime_task_ability_unavailable' : 'agents_chat_unavailable',
                'message' => $runtime_task_run ? 'The requested runtime task ability is not available inside the sandbox.' : 'The canonical agents/chat ability is not available inside the sandbox.',
            ),
        ),
    );
} else {
    $agent_input = ${JSON.stringify(JSON.stringify(input))};
    $runtime_task_input = $runtime_task_run && is_array($sandbox_runtime_task['input'] ?? null) ? $sandbox_runtime_task['input'] : array();
    $agent_result = $ability->execute($runtime_task_run ? $runtime_task_input : json_decode($agent_input, true));
    if (is_wp_error($agent_result)) {
        $sandbox_agent_runtime = array(
            'agent_runtime' => array(
                'success' => false,
                'input' => json_decode($agent_input, true),
                'error' => array(
                    'code' => $agent_result->get_error_code(),
                    'message' => $agent_result->get_error_message(),
                    'data' => $agent_result->get_error_data(),
                ),
            ),
        );
    } else {
        $sandbox_agent_runtime = array(
            'agent_runtime' => array(
                'success' => true,
                'input' => json_decode($agent_input, true),
                'result' => $agent_result,
            ),
        );
    }
}

echo json_encode($sandbox_agent_runtime, JSON_PRETTY_PRINT);
`
}

function sandboxToolContract(policy: SandboxToolPolicySnapshot): Record<string, unknown> {
  return {
    schema: policy.schema,
    version: policy.version,
    modes: ["chat", "sandbox"],
    tools: sandboxAllowedRuntimeToolIds(policy),
    policy,
  }
}

function runtimePrincipal(agent: string | undefined, sessionId: string | undefined, mode: string): Record<string, unknown> {
  const runtimeId = sessionId?.trim() || "wp-codebox-runtime"
  return {
    acting_user_id: 0,
    effective_agent_id: agent || "wp-codebox-agent",
    auth_source: "runtime",
    request_context: "runtime",
    token_id: null,
    request_metadata: {
      source: "wp-codebox",
      mode,
      codebox_session_id: sessionId ?? null,
    },
    workspace_id: "wp-codebox",
    client_id: "wp-codebox-cli",
    audience_id: runtimeId,
    audience_claims: {
      runtime_type: "wordpress-playground",
    },
    owner_type: "runtime",
    owner_key: runtimeId,
  }
}

function sandboxAgentModes(mode: string): string[] {
  return Array.from(new Set([mode, "chat"].filter(Boolean)))
}

function defaultSandboxWorkspace(workspace: SandboxWorkspaceContract | undefined): Record<string, unknown> | null {
  if (!workspace?.mounts.length) return null
  const mount = workspace.mounts.find((entry) => entry.mode === "readwrite" && entry.target.startsWith(SANDBOX_WORKSPACE_ROOT)) ?? workspace.mounts[0]
  return mount ? { ...mount } : null
}

function normalizeAgentBundleSpecs(specs: AgentBundleSpec[]): AgentBundleSpec[] {
  return specs.flatMap((spec) => {
    if (!spec || typeof spec !== "object") return []
    const source = typeof spec.source === "string" ? spec.source.trim() : ""
    const bundle = spec.bundle && typeof spec.bundle === "object" && !Array.isArray(spec.bundle) ? spec.bundle : undefined
    if (!source && !bundle) return []

    const normalized: AgentBundleSpec = {}
    if (source) normalized.source = source
    if (bundle) normalized.bundle = bundle
    if (typeof spec.slug === "string" && spec.slug.trim()) normalized.slug = spec.slug.trim()
    normalized.on_conflict = spec.on_conflict && ["error", "skip", "upgrade"].includes(spec.on_conflict) ? spec.on_conflict : "upgrade"
    if (Number.isSafeInteger(spec.owner_id) && Number(spec.owner_id) > 0) normalized.owner_id = Number(spec.owner_id)
    if (typeof spec.token_env === "string" && spec.token_env.trim()) normalized.token_env = spec.token_env.trim()
    if (spec.import_principal && typeof spec.import_principal === "object" && !Array.isArray(spec.import_principal)) normalized.import_principal = spec.import_principal
    return [normalized]
  })
}

function normalizeRuntimeTask(config: Record<string, unknown> | undefined, agentInput: Record<string, unknown>): Record<string, unknown> | null {
  if (!config || typeof config !== "object" || Array.isArray(config)) return null

  const ability = stringFromKeys(config, ["ability", "ability_name", "abilityName"])
  if (!ability) return null

  const taskInput = recordValue(config.input) ?? {}
  const input: Record<string, unknown> = {
    ...taskInput,
  }
  if (!recordValue(input.task_input)) {
    input.task_input = agentInput
  }

  const normalized: Record<string, unknown> = { ability, input }
  if (typeof config.wait_for_completion === "boolean") {
    normalized.wait_for_completion = config.wait_for_completion
  }
  if (typeof config.label === "string" && config.label.trim()) {
    normalized.label = config.label.trim()
  }

  const metadata = recordValue(config.metadata)
  if (metadata) {
    normalized.metadata = metadata
  }

  return normalized
}

function stringFromKeys(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = typeof record[key] === "string" ? record[key].trim() : ""
    if (value) return value
  }
  return ""
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

export function agentSandboxRunCode(task: string, code: string, providerPlugins: Array<{ slug: string }>): string {
  return `<?php
require_once ABSPATH . 'wp-admin/includes/plugin.php';

if (!defined('DATAMACHINE_WORKSPACE_PATH')) {
    define('DATAMACHINE_WORKSPACE_PATH', ${JSON.stringify(SANDBOX_WORKSPACE_ROOT)});
}

add_filter('datamachine_code_remote_workspace_backend_should_handle', '__return_false', 100);

add_filter('datamachine_should_load_full_runtime', '__return_true', 1);

$plugins = array_merge(array(
    'agents-api/agents-api.php',
    'data-machine/data-machine.php',
    'data-machine-code/data-machine-code.php',
), wp_codebox_provider_plugin_entries(json_decode(${JSON.stringify(JSON.stringify(providerPlugins))}, true)));

function wp_codebox_plugin_entry_path(string $plugin): ?array {
    $plugin = ltrim($plugin, '/');
    if ('' === $plugin || str_contains($plugin, '..') || !str_ends_with($plugin, '.php')) {
        return null;
    }
    $normal_path = WP_PLUGIN_DIR . '/' . $plugin;
    if (file_exists($normal_path)) {
        return array('path' => $normal_path, 'load_as' => 'plugin');
    }
    $mu_path = WPMU_PLUGIN_DIR . '/wp-codebox-runtime/' . $plugin;
    if (file_exists($mu_path)) {
        return array('path' => $mu_path, 'load_as' => 'mu-plugin');
    }
    return null;
}

function wp_codebox_provider_plugin_entries(array $provider_plugins): array {
    $entries = array();
    foreach ($provider_plugins as $plugin) {
        $slug = isset($plugin['slug']) ? sanitize_key((string) $plugin['slug']) : '';
        if ('' === $slug) {
            continue;
        }
        $candidates = array($slug . '/plugin.php', $slug . '/' . $slug . '.php');
        foreach ($candidates as $candidate) {
            if (wp_codebox_plugin_entry_path($candidate)) {
                $entries[] = $candidate;
                break;
            }
        }
    }
    return $entries;
}

$activation_results = array();

foreach ($plugins as $plugin) {
    $entry = wp_codebox_plugin_entry_path($plugin);
    if (!$entry) {
        $activation_results[$plugin] = array('active' => false, 'error' => 'Plugin is not mounted.');
        continue;
    }
    $result = null;
    if ('mu-plugin' === $entry['load_as']) {
        require_once $entry['path'];
    } else {
        $result = activate_plugin($plugin);
    }
    $activation_results[$plugin] = array(
        'active' => 'mu-plugin' === $entry['load_as'] ? true : is_plugin_active($plugin),
        'load_as' => $entry['load_as'],
        'error' => is_wp_error($result) ? $result->get_error_message() : null,
    );
}

do_action('plugins_loaded');
do_action('init');
do_action('wp_abilities_api_categories_init');
do_action('wp_abilities_api_init');

$sandbox_task = ${phpStringLiteral(task)};
$sandbox_stack = array(
    'plugins' => $activation_results,
    'signals' => array(
        'agents_api_loaded' => defined('AGENTS_API_LOADED'),
        'agents_registry_class' => class_exists('WP_Agents_Registry'),
        'data_machine_version' => defined('DATAMACHINE_VERSION') ? DATAMACHINE_VERSION : null,
        'data_machine_permission_helper' => class_exists('DataMachine\\Abilities\\PermissionHelper'),
        'data_machine_code_version' => defined('DATAMACHINE_CODE_VERSION') ? DATAMACHINE_CODE_VERSION : null,
        'data_machine_code_workspace' => class_exists('DataMachineCode\\Workspace\\Workspace'),
        'provider_plugins' => wp_codebox_provider_plugin_entries(json_decode(${JSON.stringify(JSON.stringify(providerPlugins))}, true)),
    ),
);

ob_start();
${phpBody(code)}
$sandbox_output = ob_get_clean();

echo json_encode(
    array(
        'command' => 'agent-sandbox.run',
        'task' => $sandbox_task,
        'wp_loaded' => function_exists('wp_insert_post'),
        'stack' => $sandbox_stack,
        'output' => $sandbox_output,
    ),
    JSON_PRETTY_PRINT
);
`
}

function phpBody(code: string): string {
  return code.trimStart().replace(/^<\?php\s*/, "")
}

function phpStringLiteral(value: string): string {
  const marker = `WP_CODEBOX_LITERAL_${Math.random().toString(36).slice(2).toUpperCase()}`
  return `<<<'${marker}'\n${value}\n${marker}`
}

export function agentRuntimeProbeCode(providerPlugins: Array<{ slug: string }>): string {
  return `<?php
require_once ABSPATH . 'wp-admin/includes/plugin.php';

add_filter('datamachine_should_load_full_runtime', '__return_true', 1);

$plugins = array_merge(array(
    'agents-api/agents-api.php',
    'data-machine/data-machine.php',
    'data-machine-code/data-machine-code.php',
), wp_codebox_provider_plugin_entries(json_decode(${JSON.stringify(JSON.stringify(providerPlugins))}, true)));

function wp_codebox_plugin_entry_path(string $plugin): ?array {
    $plugin = ltrim($plugin, '/');
    if ('' === $plugin || str_contains($plugin, '..') || !str_ends_with($plugin, '.php')) {
        return null;
    }
    $normal_path = WP_PLUGIN_DIR . '/' . $plugin;
    if (file_exists($normal_path)) {
        return array('path' => $normal_path, 'load_as' => 'plugin');
    }
    $mu_path = WPMU_PLUGIN_DIR . '/wp-codebox-runtime/' . $plugin;
    if (file_exists($mu_path)) {
        return array('path' => $mu_path, 'load_as' => 'mu-plugin');
    }
    return null;
}

function wp_codebox_provider_plugin_entries(array $provider_plugins): array {
    $entries = array();
    foreach ($provider_plugins as $plugin) {
        $slug = isset($plugin['slug']) ? sanitize_key((string) $plugin['slug']) : '';
        if ('' === $slug) {
            continue;
        }
        $candidates = array($slug . '/plugin.php', $slug . '/' . $slug . '.php');
        foreach ($candidates as $candidate) {
            if (wp_codebox_plugin_entry_path($candidate)) {
                $entries[] = $candidate;
                break;
            }
        }
    }
    return $entries;
}

$activation_results = array();

foreach ($plugins as $plugin) {
    $entry = wp_codebox_plugin_entry_path($plugin);
    if (!$entry) {
        $activation_results[$plugin] = array('active' => false, 'error' => 'Plugin is not mounted.');
        continue;
    }
    $result = null;
    if ('mu-plugin' === $entry['load_as']) {
        require_once $entry['path'];
    } else {
        $result = activate_plugin($plugin);
    }
    $activation_results[$plugin] = array(
        'active' => 'mu-plugin' === $entry['load_as'] ? true : is_plugin_active($plugin),
        'load_as' => $entry['load_as'],
        'error' => is_wp_error($result) ? $result->get_error_message() : null,
    );
}

do_action('plugins_loaded');
do_action('init');
do_action('wp_abilities_api_categories_init');
do_action('wp_abilities_api_init');

echo json_encode(
    array(
        'command' => 'agent-runtime.probe',
        'wp_loaded' => function_exists('wp_insert_post'),
        'plugins' => $activation_results,
        'signals' => array(
            'agents_api_loaded' => defined('AGENTS_API_LOADED'),
            'agents_registry_class' => class_exists('WP_Agents_Registry'),
            'data_machine_version' => defined('DATAMACHINE_VERSION') ? DATAMACHINE_VERSION : null,
            'data_machine_permission_helper' => class_exists('DataMachine\\\\Abilities\\\\PermissionHelper'),
            'data_machine_code_version' => defined('DATAMACHINE_CODE_VERSION') ? DATAMACHINE_CODE_VERSION : null,
            'data_machine_code_workspace' => class_exists('DataMachineCode\\\\Workspace\\\\Workspace'),
            'provider_plugins' => wp_codebox_provider_plugin_entries(json_decode(${JSON.stringify(JSON.stringify(providerPlugins))}, true)),
        ),
    ),
    JSON_PRETTY_PRINT
);
`
}
