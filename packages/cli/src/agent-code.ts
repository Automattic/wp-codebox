import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { normalizeAgentBundles, phpRuntimeComponentLifecycleActionReplayFunction, sandboxAllowedRuntimeToolIds, type SandboxToolPolicySnapshot, type SandboxWorkspaceContract, type StructuredArtifactPayload, type TaskInputAgentBundle } from "@automattic/wp-codebox-core"
import { SANDBOX_WORKSPACE_ROOT } from "@automattic/wp-codebox-core/internals"

export type AgentBundleSpec = TaskInputAgentBundle

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
  structuredArtifacts?: StructuredArtifactPayload[]
  sandboxToolPolicy?: SandboxToolPolicySnapshot
  code?: string
  codeFile?: string
  sandboxWorkspace?: SandboxWorkspaceContract
}

export async function resolveSandboxTaskCode(options: AgentSandboxCodeOptions): Promise<string> {
  if (options.code) {
    return options.code
  }

  if (options.codeFile) {
    return readFile(resolve(options.codeFile), "utf8")
  }

  if (options.agent) {
    return agentChatTaskCode(options)
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
  const sandboxWorkspace = options.sandboxWorkspace
  const defaultWorkspace = defaultSandboxWorkspace(sandboxWorkspace)
  const input: Record<string, unknown> = {
    agent: options.agent,
    message: sandboxTaskMessage(options.task, sandboxWorkspace, defaultWorkspace, sandboxToolPolicy),
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
      sandbox_workspace: sandboxWorkspace,
      default_workspace: defaultWorkspace,
      tool_contract: sandboxToolContract(sandboxToolPolicy),
      structured_artifacts: options.structuredArtifacts ?? [],
    },
    structured_artifacts: options.structuredArtifacts ?? [],
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
    input.completion_assertions = { required_tool_names: runtimeToolIds }
  }

  const timeoutSeconds = Number.parseInt(options.timeoutSeconds ?? '', 10)
  const timeoutLimit = Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds : 0
  const agentBundles = normalizeAgentBundles(options.agentBundles ?? [])
  const runtimeTask = normalizeRuntimeTask(options.runtimeTask, input)
  return `
if (function_exists('wp_set_current_user')) {
    wp_set_current_user(1);
}

if (${timeoutLimit} > 0 && function_exists('set_time_limit')) {
    set_time_limit(${timeoutLimit});
}

$sandbox_agent_bundles = json_decode(${JSON.stringify(JSON.stringify(agentBundles))}, true);
$sandbox_agent_bundle_imports = wp_codebox_import_sandbox_agent_bundles(is_array($sandbox_agent_bundles) ? $sandbox_agent_bundles : array());
$sandbox_stack['agent_bundle_imports'] = $sandbox_agent_bundle_imports;
$sandbox_agent_bundle_import_failures = array_filter($sandbox_agent_bundle_imports, static fn($import) => is_array($import) && empty($import['success']));
$sandbox_runtime_task = json_decode(${JSON.stringify(JSON.stringify(runtimeTask))}, true);
$sandbox_stack['runtime_task'] = is_array($sandbox_runtime_task) ? $sandbox_runtime_task : null;

add_filter('agents_chat_runtime_principal_permission', static function (bool $allowed, $principal, array $input): bool {
    if (!$principal instanceof AgentsAPI\\AI\\WP_Agent_Execution_Principal) {
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

$sandbox_default_agent = sanitize_title((string) (${JSON.stringify(input.agent)}));
$sandbox_stack['default_agent'] = wp_codebox_ensure_sandbox_default_agent(
    $sandbox_default_agent,
    json_decode(${JSON.stringify(JSON.stringify(input))}, true)
);

function wp_codebox_ensure_sandbox_default_agent(string $agent_slug, array $agent_input): array {
    if ('' === $agent_slug) {
        return array('success' => false, 'skipped' => true, 'reason' => 'agent_slug_missing');
    }

    if (function_exists('wp_get_agent') && wp_get_agent($agent_slug)) {
        return array('success' => true, 'agent' => $agent_slug, 'existing' => true);
    }

    if (!class_exists('WP_Agents_Registry')) {
        return array('success' => false, 'agent' => $agent_slug, 'reason' => 'agent_registry_unavailable');
    }

    $owner_id = function_exists('get_current_user_id') ? (int) get_current_user_id() : 0;
    if ($owner_id <= 0) {
        $owner_id = 1;
    }

    $default_config = array_filter(array(
        'default_provider' => (string) ($agent_input['provider'] ?? ''),
        'default_model' => (string) ($agent_input['model'] ?? ''),
    ), static fn($value): bool => '' !== $value);

    $registry = WP_Agents_Registry::get_instance();
    if (!$registry || !method_exists($registry, 'register')) {
        return array('success' => false, 'agent' => $agent_slug, 'reason' => 'agent_registry_unavailable');
    }

    $registered = $registry->register($agent_slug, array(
        'label' => 'WP Codebox Sandbox',
        'description' => 'Default sandbox agent for WP Codebox runtime tasks.',
        'owner_resolver' => static fn(): int => $owner_id,
        'default_config' => $default_config,
        'meta' => array(
            'source_plugin' => 'wp-codebox',
            'source_type' => 'runtime-default-agent',
            'source_package' => 'wp-codebox',
        ),
    ));

    return array(
        'success' => null !== $registered || (function_exists('wp_get_agent') && (bool) wp_get_agent($agent_slug)),
        'agent' => $agent_slug,
        'created' => null !== $registered,
    );
}

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

function wp_codebox_json_encode_agent_runtime_payload($value): string {
    $json = wp_json_encode($value, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    if (false !== $json) {
        return $json;
    }

    $fallback = array(
        'agent_runtime' => array(
            'success' => false,
            'error' => array(
                'code' => 'runtime_payload_json_encode_failed',
                'message' => function_exists('json_last_error_msg') ? json_last_error_msg() : 'Runtime payload JSON encoding failed.',
            ),
        ),
    );

    return (string) wp_json_encode($fallback, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
}

function wp_codebox_validate_requested_provider(array $agent_input, array $sandbox_stack) {
    $provider = trim((string) ($agent_input['provider'] ?? ''));
    if ('' === $provider) {
        return null;
    }

    $registry = null;
    $ai_client_class = \\WordPress\\AiClient\\AiClient::class;
    if (class_exists($ai_client_class) && method_exists($ai_client_class, 'defaultRegistry')) {
        $registry = $ai_client_class::defaultRegistry();
    }

    $provider_registry_class = \\WordPress\\AiClient\\Providers\\ProviderRegistry::class;
    if (null === $registry && class_exists($provider_registry_class)) {
        $registry = new $provider_registry_class();
    }

    if (!is_object($registry)) {
        return array(
            'code' => 'wp_codebox_provider_registry_unavailable',
            'message' => 'The requested provider could not be validated because the wp-ai-client provider registry is unavailable inside the sandbox.',
            'data' => array(
                'provider' => $provider,
                'registered_provider_ids' => array(),
                'ai_client_available' => class_exists($ai_client_class),
                'ai_client_default_registry_available' => class_exists($ai_client_class) && method_exists($ai_client_class, 'defaultRegistry'),
                'provider_registry_available' => class_exists($provider_registry_class),
                'provider_plugins' => $sandbox_stack['signals']['provider_plugins'] ?? array(),
                'provider_plugin_files' => $sandbox_stack['signals']['provider_plugin_files'] ?? array(),
                'plugin_activation' => $sandbox_stack['plugins'] ?? array(),
            ),
        );
    }

    $registered_provider_ids = wp_codebox_registered_provider_ids($registry);
    if (method_exists($registry, 'hasProvider') && $registry->hasProvider($provider)) {
        return null;
    }
    if (!method_exists($registry, 'hasProvider') && method_exists($registry, 'isProviderConfigured') && $registry->isProviderConfigured($provider)) {
        return null;
    }

    return array(
        'code' => 'wp_codebox_provider_not_registered',
        'message' => sprintf('Requested provider "%s" is not registered in wp-ai-client after sandbox provider plugins were loaded.', $provider),
        'data' => array(
            'provider' => $provider,
            'registered_provider_ids' => $registered_provider_ids,
            'provider_plugins' => $sandbox_stack['signals']['provider_plugins'] ?? array(),
            'provider_plugin_files' => $sandbox_stack['signals']['provider_plugin_files'] ?? array(),
            'plugin_activation' => $sandbox_stack['plugins'] ?? array(),
        ),
    );
}

function wp_codebox_registered_provider_ids(object $registry): array {
    if (!method_exists($registry, 'getRegisteredProviderIds')) {
        return array();
    }

    $provider_ids = $registry->getRegisteredProviderIds();
    if (!is_array($provider_ids)) {
        return array();
    }

    $provider_ids = array_values(array_filter(array_map('strval', $provider_ids), static fn(string $provider_id): bool => '' !== $provider_id));
    sort($provider_ids);
    return $provider_ids;
}

$runtime_task_run = is_array($sandbox_runtime_task) && !empty($sandbox_runtime_task);
$ability_name = $runtime_task_run ? (string) ($sandbox_runtime_task['ability'] ?? '') : 'agents/chat';
$ability = empty($sandbox_agent_bundle_import_failures) && function_exists('wp_get_ability') ? wp_get_ability($ability_name) : null;
$registered_ability_ids = function_exists('wp_get_abilities') ? array_keys(wp_get_abilities()) : array();
sort($registered_ability_ids);
$sandbox_stack['abilities'] = array(
    'count' => count($registered_ability_ids),
    'ids' => $registered_ability_ids,
    'requested' => $ability_name,
    'requested_available' => null !== $ability,
);
$agent_input = ${JSON.stringify(JSON.stringify(input))};
$decoded_agent_input = json_decode($agent_input, true);
$provider_validation_error = wp_codebox_validate_requested_provider(is_array($decoded_agent_input) ? $decoded_agent_input : array(), $sandbox_stack);
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
} elseif (null !== $provider_validation_error) {
    $sandbox_agent_runtime = array(
        'agent_runtime' => array(
            'success' => false,
            'input' => is_array($decoded_agent_input) ? $decoded_agent_input : null,
            'error' => $provider_validation_error,
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
    $runtime_task_input = $runtime_task_run && is_array($sandbox_runtime_task['input'] ?? null) ? $sandbox_runtime_task['input'] : array();
    $agent_result = $ability->execute($runtime_task_run ? $runtime_task_input : $decoded_agent_input);
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

echo wp_codebox_json_encode_agent_runtime_payload($sandbox_agent_runtime);
`
}

function sandboxTaskMessage(task: string, workspace: SandboxWorkspaceContract | undefined, defaultWorkspace: Record<string, unknown> | null, policy?: SandboxToolPolicySnapshot): string {
  const guidance = sandboxWorkspaceGuidance(workspace, defaultWorkspace, policy)
  return guidance ? `${guidance}\n\n${task}` : task
}

function sandboxWorkspaceGuidance(workspace: SandboxWorkspaceContract | undefined, defaultWorkspace: Record<string, unknown> | null, policy?: SandboxToolPolicySnapshot): string {
  if (!workspace && !defaultWorkspace) return ""

  const target = typeof defaultWorkspace?.target === "string" && defaultWorkspace.target.trim()
    ? defaultWorkspace.target.trim()
    : workspace?.root || SANDBOX_WORKSPACE_ROOT
  const mounts = Array.isArray(workspace?.mounts) ? workspace.mounts : []
  const mountLines = mounts
    .filter((mount) => typeof mount?.target === "string" && mount.target.trim())
    .map((mount) => {
      const mode = typeof mount.mode === "string" && mount.mode.trim() ? ` (${mount.mode.trim()})` : ""
      const sourceMode = typeof mount.sourceMode === "string" && mount.sourceMode.trim() ? `, source: ${mount.sourceMode.trim()}` : ""
      return `- mounted workspace: ${mount.target.trim()}${mode}${sourceMode}`
    })
  const runtimeTools = policy ? sandboxAllowedRuntimeToolIds(policy) : []
  const workspaceToolLines = runtimeTools.length
    ? [`- Available workspace tools: ${runtimeTools.map((tool) => `\`${tool}\``).join(", ")}. Use these tools directly when the task asks you to inspect files, git status, or workspace contents.`]
    : []

  return [
    "WP Codebox sandbox workspace guidance:",
    `- current repository root: ${target}`,
    ...mountLines,
    ...workspaceToolLines,
    "- Use the current repository root above as the mounted filesystem workspace for this task.",
    "- Use the exact mounted target from this context when the task refers to the repo, workspace, or project.",
    "- Make the needed workspace tool calls before your final answer when the task asks you to inspect files, git status, or workspace contents.",
    "- Final answers should report completed inspection results, not future inspection steps.",
    "- For sandbox file inspection, report the workspace root you verified and the sandbox capability needed for any deeper inspection.",
  ].join("\n")
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

export function agentSandboxRunCode(task: string, code: string, providerPlugins: Array<{ slug: string; pluginFile?: string; loadAs?: string }>): string {
  return `<?php
require_once ABSPATH . 'wp-admin/includes/plugin.php';

$plugins = array_merge(array(
    'agents-api/agents-api.php',
), wp_codebox_provider_plugin_entries(json_decode(${JSON.stringify(JSON.stringify(providerPlugins))}, true)));

${providerPluginResolutionPhp()}

function wp_codebox_json_encode_sandbox_payload($value): string {
    $json = wp_json_encode($value, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    if (false !== $json) {
        return $json;
    }

    $fallback = array(
        'command' => 'agent-sandbox.run',
        'wp_loaded' => function_exists('wp_insert_post'),
        'output' => '',
        'error' => array(
            'code' => 'runtime_payload_json_encode_failed',
            'message' => function_exists('json_last_error_msg') ? json_last_error_msg() : 'Runtime payload JSON encoding failed.',
        ),
    );

    return (string) wp_json_encode($fallback, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
}

${phpRuntimeComponentLifecycleActionReplayFunction("wp_codebox_runtime_replay_component_lifecycle")}

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

$runtime_lifecycle = wp_codebox_runtime_replay_component_lifecycle();

$sandbox_task = ${phpStringLiteral(task)};
$sandbox_stack = array(
    'plugins' => $activation_results,
        'signals' => array(
            'agents_api_loaded' => defined('AGENTS_API_LOADED'),
            'agents_registry_class' => class_exists('WP_Agents_Registry'),
            'runtime_lifecycle' => $runtime_lifecycle,
            'provider_plugins' => wp_codebox_provider_plugin_entries(json_decode(${JSON.stringify(JSON.stringify(providerPlugins))}, true)),
            'provider_plugin_files' => wp_codebox_provider_plugin_file_diagnostics(json_decode(${JSON.stringify(JSON.stringify(providerPlugins))}, true)),
        ),
);

ob_start();
${phpBody(code)}
$sandbox_output = ob_get_clean();

echo wp_codebox_json_encode_sandbox_payload(
    array(
        'command' => 'agent-sandbox.run',
        'task' => $sandbox_task,
        'wp_loaded' => function_exists('wp_insert_post'),
        'stack' => $sandbox_stack,
        'output' => $sandbox_output,
    )
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

export function agentRuntimeProbeCode(providerPlugins: Array<{ slug: string; pluginFile?: string; loadAs?: string }>): string {
  return `<?php
require_once ABSPATH . 'wp-admin/includes/plugin.php';

$plugins = array_merge(array(
    'agents-api/agents-api.php',
), wp_codebox_provider_plugin_entries(json_decode(${JSON.stringify(JSON.stringify(providerPlugins))}, true)));

${providerPluginResolutionPhp()}

${phpRuntimeComponentLifecycleActionReplayFunction("wp_codebox_runtime_replay_component_lifecycle")}

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

$runtime_lifecycle = wp_codebox_runtime_replay_component_lifecycle();

echo json_encode(
    array(
        'command' => 'agent-runtime.probe',
        'wp_loaded' => function_exists('wp_insert_post'),
        'plugins' => $activation_results,
        'signals' => array(
            'agents_api_loaded' => defined('AGENTS_API_LOADED'),
            'agents_registry_class' => class_exists('WP_Agents_Registry'),
            'runtime_lifecycle' => $runtime_lifecycle,
            'provider_plugins' => wp_codebox_provider_plugin_entries(json_decode(${JSON.stringify(JSON.stringify(providerPlugins))}, true)),
            'provider_plugin_files' => wp_codebox_provider_plugin_file_diagnostics(json_decode(${JSON.stringify(JSON.stringify(providerPlugins))}, true)),
        ),
    ),
    JSON_PRETTY_PRINT
);
`
}

function providerPluginResolutionPhp(): string {
  return `function wp_codebox_plugin_entry_path(string $plugin): ?array {
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
        $matched = wp_codebox_resolve_provider_plugin_entry($plugin, $slug);
        if (null !== $matched) {
            $entries[] = $matched;
        }
    }
    return $entries;
}

function wp_codebox_provider_plugin_file_diagnostics(array $provider_plugins): array {
    $diagnostics = array();
    foreach ($provider_plugins as $plugin) {
        $slug = isset($plugin['slug']) ? sanitize_key((string) $plugin['slug']) : '';
        if ('' === $slug) {
            continue;
        }

        $entry = null;
        $entry_path = null;
        $load_as = null;
        foreach (wp_codebox_provider_plugin_entries(array($plugin)) as $candidate) {
            $candidate_entry = wp_codebox_plugin_entry_path($candidate);
            if ($candidate_entry) {
                $entry = $candidate;
                $entry_path = $candidate_entry['path'];
                $load_as = $candidate_entry['load_as'];
                break;
            }
        }

        $diagnostics[] = array(
            'slug' => $slug,
            'source' => isset($plugin['source']) ? (string) $plugin['source'] : '',
            'plugin_file' => $entry,
            'mounted_path' => $entry_path,
            'load_as' => $load_as,
            'mounted' => null !== $entry_path,
        );
    }
    return $diagnostics;
}

function wp_codebox_resolve_provider_plugin_entry(array $plugin, string $slug): ?string {
    $explicit = isset($plugin['pluginFile']) ? ltrim((string) $plugin['pluginFile'], '/') : '';
    if ('' !== $explicit && wp_codebox_plugin_entry_path($explicit)) {
        return $explicit;
    }

    $candidates = array($slug . '/' . $slug . '.php', $slug . '/plugin.php');
    foreach ($candidates as $candidate) {
        if (wp_codebox_plugin_entry_path($candidate)) {
            return $candidate;
        }
    }

    return wp_codebox_provider_plugin_entry_by_header($slug);
}

function wp_codebox_provider_plugin_entry_by_header(string $slug): ?string {
    // The conventional entries (<slug>/plugin.php, <slug>/<slug>.php) are absent.
    // This happens when the plugin directory was renamed so its name no longer
    // matches the entry file (e.g. a Lab workspace synced under a uniquified
    // <slug>-<hash>-<uuid> directory). Fall back to the single top-level *.php
    // file declaring a WordPress plugin header.
    foreach (array(WP_PLUGIN_DIR . '/' . $slug, WPMU_PLUGIN_DIR . '/wp-codebox-runtime/' . $slug) as $dir) {
        if (!is_dir($dir)) {
            continue;
        }
        $files = glob($dir . '/*.php') ?: array();
        sort($files);
        foreach ($files as $file) {
            $header = @file_get_contents($file, false, null, 0, 8192);
            if (false !== $header && preg_match('/Plugin Name:[ \\t]*[^ \\t\\r\\n]/', $header)) {
                $candidate = $slug . '/' . basename($file);
                if (wp_codebox_plugin_entry_path($candidate)) {
                    return $candidate;
                }
            }
        }
    }
    return null;
}`
}
