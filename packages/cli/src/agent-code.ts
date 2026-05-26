import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { SANDBOX_DMC_PARENT_ONLY_ABILITIES, SANDBOX_DMC_SAFE_ABILITIES, SANDBOX_WORKSPACE_ROOT } from "@chubes4/wp-codebox-core"

export interface AgentSandboxCodeOptions {
  task: string
  agent?: string
  mode?: string
  provider?: string
  model?: string
  sessionId?: string
  maxTurns?: string
  code?: string
  codeFile?: string
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
  const agentConfig = scopedAgentConfig(mode, options.provider, options.model)
  const input: Record<string, unknown> = {
    agent: options.agent,
    message: options.task,
    session_id: options.sessionId ?? null,
    mode,
    modes: agentModes,
    client_context: {
      source: "bridge",
      client_name: "wp-codebox",
      connector_id: "wp-codebox-cli",
      mode,
      agent_modes: agentModes,
      workspace_root: SANDBOX_WORKSPACE_ROOT,
      tool_contract: sandboxToolContract(),
    },
  }

  if (options.maxTurns) {
    input.max_turns = Number.parseInt(options.maxTurns, 10)
  }

  return `
if (function_exists('wp_set_current_user')) {
    wp_set_current_user(1);
}

if (!defined('DATAMACHINE_WORKSPACE_PATH')) {
    define('DATAMACHINE_WORKSPACE_PATH', ${JSON.stringify(SANDBOX_WORKSPACE_ROOT)});
}

$sandbox_workspace_adoptions = array();
if (function_exists('wp_get_ability')) {
    $sandbox_adopt_callback = static function () use (&$sandbox_workspace_adoptions): void {
        $sandbox_adopt_ability = wp_get_ability('datamachine/workspace-adopt');
        if (!$sandbox_adopt_ability || !method_exists($sandbox_adopt_ability, 'execute')) {
            return;
        }
        foreach (glob(rtrim(DATAMACHINE_WORKSPACE_PATH, '/') . '/*', GLOB_ONLYDIR) ?: array() as $sandbox_workspace_dir) {
            $sandbox_workspace_name = basename($sandbox_workspace_dir);
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

if (class_exists('DataMachine\\Core\\Database\\Agents\\Agents')) {
    $sandbox_agent_slug = sanitize_title((string) (${JSON.stringify(input.agent)}));
    if ('' !== $sandbox_agent_slug) {
        $sandbox_agents = new DataMachine\\Core\\Database\\Agents\\Agents();
        $sandbox_agent_config = json_decode(${JSON.stringify(JSON.stringify(agentConfig))}, true);
        $sandbox_agent_id = $sandbox_agents->create_if_missing(
            $sandbox_agent_slug,
            'Sandbox Agent',
            1,
            $sandbox_agent_config
        );
        if ($sandbox_agent_id > 0 && method_exists($sandbox_agents, 'update_agent')) {
            $sandbox_agents->update_agent($sandbox_agent_id, array('agent_config' => $sandbox_agent_config));
        }
    }
}

$sandbox_model_settings = json_decode(${JSON.stringify(JSON.stringify(scopedSettings(mode, options.provider, options.model)))}, true);
if (is_array($sandbox_model_settings) && !empty($sandbox_model_settings)) {
    update_option('datamachine_settings', array_merge(get_option('datamachine_settings', array()), $sandbox_model_settings));
}

add_filter('agents_chat_permission', static function () {
    return true;
}, 100, 2);

add_filter('datamachine_code_sandbox_safe_abilities', static function () {
    return json_decode(${JSON.stringify(JSON.stringify([...SANDBOX_DMC_SAFE_ABILITIES]))}, true);
}, 100);

add_filter('datamachine_code_sandbox_parent_only_abilities', static function () {
    return json_decode(${JSON.stringify(JSON.stringify([...SANDBOX_DMC_PARENT_ONLY_ABILITIES]))}, true);
}, 100);

add_action('datamachine_agent_modes', static function () {
    if (class_exists('DataMachine\\Engine\\AI\\AgentModeRegistry')) {
        DataMachine\\Engine\\AI\\AgentModeRegistry::register('sandbox', 25, array(
            'label' => 'Sandbox',
            'description' => 'WP Codebox sandbox execution with reviewed artifact output.',
        ));
    }
}, 100);

add_filter('datamachine_agent_mode_sandbox', static function (string $content): string {
    $guidance = ${JSON.stringify(sandboxModeGuidance())};
    return trim($content) === '' ? $guidance : trim($content) . "\n\n" . $guidance;
}, 100, 1);

$ability = function_exists('wp_get_ability') ? wp_get_ability('agents/chat') : null;
if (!$ability || !method_exists($ability, 'execute')) {
    $sandbox_agent_runtime = array(
        'agent_runtime' => array(
            'success' => false,
            'error' => array(
                'code' => 'agents_chat_unavailable',
                'message' => 'The canonical agents/chat ability is not available inside the sandbox.',
            ),
        ),
    );
} else {
    $agent_input = ${JSON.stringify(JSON.stringify(input))};
    $agent_result = $ability->execute(json_decode($agent_input, true));
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

function sandboxToolContract(): Record<string, unknown> {
  return {
    schema: "wp-codebox/sandbox-dmc-tools/v1",
    modes: ["pipeline", "sandbox"],
    tools: sandboxToolNames(),
    safe_abilities: [...SANDBOX_DMC_SAFE_ABILITIES],
    parent_only_abilities: [...SANDBOX_DMC_PARENT_ONLY_ABILITIES],
  }
}

function sandboxToolNames(): string[] {
  return SANDBOX_DMC_SAFE_ABILITIES.map((ability) => ability.replace(/^datamachine\//, "").replaceAll("-", "_"))
}

function sandboxAgentModes(mode: string): string[] {
  return Array.from(new Set([mode, "pipeline"].filter(Boolean)))
}

function sandboxModeGuidance(): string {
  return `# WP Codebox Sandbox Context

You are running inside a disposable WP Codebox sandbox. The sandbox can produce a reviewed artifact bundle from workspace changes.

Use the available workspace tools by their exact names: ${sandboxToolNames().join(", ")}.

Do not invent alternate tool names such as read_file, read-file, write_file, or edit_file. For file inspection use workspace_read, workspace_ls, and workspace_grep. For changes use workspace_write, workspace_edit, or workspace_apply_patch.

The sandbox workspace root is ${SANDBOX_WORKSPACE_ROOT}. Keep changes focused on the requested task and prefer patchable repository edits over prose-only answers.`
}

function scopedAgentConfig(mode: string, provider: string | undefined, model: string | undefined): Record<string, unknown> {
  const toolPolicy = {
    mode: "allow",
    tools: sandboxToolNames(),
  }

  if (!provider && !model) {
    return { tool_policy: toolPolicy }
  }

  return {
    ...(provider ? { default_provider: provider } : {}),
    ...(model ? { default_model: model } : {}),
    tool_policy: toolPolicy,
    mode_models: {
      [mode]: {
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
      },
    },
  }
}

function scopedSettings(mode: string, provider: string | undefined, model: string | undefined): Record<string, unknown> {
  if (!provider && !model) {
    return {}
  }

  return {
    ...(provider ? { default_provider: provider } : {}),
    ...(model ? { default_model: model } : {}),
    mode_models: {
      [mode]: {
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
      },
    },
  }
}

export function agentSandboxRunCode(task: string, code: string, providerPlugins: Array<{ slug: string }>): string {
  return `<?php
require_once ABSPATH . 'wp-admin/includes/plugin.php';

if (!defined('DATAMACHINE_WORKSPACE_PATH')) {
    define('DATAMACHINE_WORKSPACE_PATH', ${JSON.stringify(SANDBOX_WORKSPACE_ROOT)});
}

add_filter('datamachine_should_load_full_runtime', '__return_true', 1);

$plugins = array_merge(array(
    'agents-api/agents-api.php',
    'data-machine/data-machine.php',
    'data-machine-code/data-machine-code.php',
), wp_codebox_provider_plugin_entries(json_decode(${JSON.stringify(JSON.stringify(providerPlugins))}, true)));

function wp_codebox_provider_plugin_entries(array $provider_plugins): array {
    $entries = array();
    foreach ($provider_plugins as $plugin) {
        $slug = isset($plugin['slug']) ? sanitize_key((string) $plugin['slug']) : '';
        if ('' === $slug) {
            continue;
        }
        $candidates = array($slug . '/plugin.php', $slug . '/' . $slug . '.php');
        foreach ($candidates as $candidate) {
            if (file_exists(WP_PLUGIN_DIR . '/' . $candidate)) {
                $entries[] = $candidate;
                break;
            }
        }
    }
    return $entries;
}

$activation_results = array();

foreach ($plugins as $plugin) {
    $result = activate_plugin($plugin);
    $activation_results[$plugin] = array(
        'active' => is_plugin_active($plugin),
        'error' => is_wp_error($result) ? $result->get_error_message() : null,
    );
}

do_action('plugins_loaded');
do_action('init');
do_action('wp_abilities_api_categories_init');
do_action('wp_abilities_api_init');

$sandbox_task = ${JSON.stringify(task)};
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

export function agentRuntimeProbeCode(providerPlugins: Array<{ slug: string }>): string {
  return `<?php
require_once ABSPATH . 'wp-admin/includes/plugin.php';

add_filter('datamachine_should_load_full_runtime', '__return_true', 1);

$plugins = array_merge(array(
    'agents-api/agents-api.php',
    'data-machine/data-machine.php',
    'data-machine-code/data-machine-code.php',
), wp_codebox_provider_plugin_entries(json_decode(${JSON.stringify(JSON.stringify(providerPlugins))}, true)));

function wp_codebox_provider_plugin_entries(array $provider_plugins): array {
    $entries = array();
    foreach ($provider_plugins as $plugin) {
        $slug = isset($plugin['slug']) ? sanitize_key((string) $plugin['slug']) : '';
        if ('' === $slug) {
            continue;
        }
        $candidates = array($slug . '/plugin.php', $slug . '/' . $slug . '.php');
        foreach ($candidates as $candidate) {
            if (file_exists(WP_PLUGIN_DIR . '/' . $candidate)) {
                $entries[] = $candidate;
                break;
            }
        }
    }
    return $entries;
}

$activation_results = array();

foreach ($plugins as $plugin) {
    $result = activate_plugin($plugin);
    $activation_results[$plugin] = array(
        'active' => is_plugin_active($plugin),
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
