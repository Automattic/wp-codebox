import { readdir, readFile, stat } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
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

async function agentChatTaskCode(options: AgentSandboxCodeOptions): Promise<string> {
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
  const runtimeTask = await normalizeRuntimeTask(options.runtimeTask, input, sandboxWorkspace)
  return `
if (function_exists('wp_set_current_user')) {
    wp_set_current_user(1);
}

if (${timeoutLimit} > 0 && function_exists('set_time_limit')) {
    set_time_limit(${timeoutLimit});
}

$sandbox_agent_bundles = json_decode(${phpStringLiteral(JSON.stringify(agentBundles))}, true);
$sandbox_agent_bundle_imports = wp_codebox_import_sandbox_agent_bundles(is_array($sandbox_agent_bundles) ? $sandbox_agent_bundles : array());
$sandbox_stack['agent_bundle_imports'] = $sandbox_agent_bundle_imports;
$sandbox_agent_bundle_import_failures = array_filter($sandbox_agent_bundle_imports, static fn($import) => is_array($import) && empty($import['success']));
$sandbox_runtime_task = json_decode(${phpStringLiteral(JSON.stringify(runtimeTask))}, true);
$sandbox_stack['runtime_task'] = is_array($sandbox_runtime_task) ? $sandbox_runtime_task : null;
$sandbox_external_runtime_package_import = wp_codebox_import_external_runtime_agent_package(is_array($sandbox_runtime_task) ? $sandbox_runtime_task : array());
$sandbox_stack['external_runtime_package_import'] = $sandbox_external_runtime_package_import;
if (!empty($sandbox_external_runtime_package_import['success']) && empty($sandbox_external_runtime_package_import['skipped'])) {
    $sandbox_imported_agent = (string) ($sandbox_external_runtime_package_import['identity']['slug'] ?? '');
    $sandbox_external_runtime_package_import = wp_codebox_bind_external_runtime_package_identity($sandbox_runtime_task, $sandbox_imported_agent, $sandbox_external_runtime_package_import);
    $sandbox_stack['external_runtime_package_import'] = $sandbox_external_runtime_package_import;
}

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
    json_decode(${phpStringLiteral(JSON.stringify(input))}, true)
);

function wp_codebox_ensure_sandbox_default_agent(string $agent_slug, array $agent_input): array {
    if ('' === $agent_slug) {
        return array('success' => false, 'skipped' => true, 'reason' => 'agent_slug_missing');
    }

    if (function_exists('wp_get_agent') && wp_get_agent($agent_slug)) {
        return array('success' => true, 'agent' => $agent_slug, 'existing' => true);
    }

    if (!class_exists('WP_Agents_Registry')) {
        $adapter_result = apply_filters('wp_codebox_runtime_agent_registry_ensure_agent', null, $agent_slug, $agent_input);
        if (null !== $adapter_result) {
            return is_array($adapter_result) ? $adapter_result : array('success' => (bool) $adapter_result, 'agent' => $agent_slug, 'created' => (bool) $adapter_result, 'adapter' => 'wp_codebox_runtime_agent_registry_ensure_agent');
        }
        return array('success' => false, 'agent' => $agent_slug, 'reason' => 'agent_registry_unavailable');
    }

    $owner_id = function_exists('get_current_user_id') ? (int) get_current_user_id() : 0;
    if ($owner_id <= 0) {
        $owner_id = 1;
    }

    $configured_provider = (string) ($agent_input['provider'] ?? '');
    $configured_model = (string) ($agent_input['model'] ?? '');
    // The Agents API default chat handler resolves provider/model from the
    // registered agent's default config under the canonical 'provider'/'model'
    // keys, so the native (no-Data-Machine) loop can run from agent config alone
    // when a request omits them. 'default_provider'/'default_model' are retained
    // for runtime adapters that read that shape.
    $default_config = array_filter(array(
        'provider' => $configured_provider,
        'model' => $configured_model,
        'default_provider' => $configured_provider,
        'default_model' => $configured_model,
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

    if (!function_exists('wp_agent_import_runtime_bundles')) {
        return array(array('success' => false, 'error' => array('code' => 'wp_codebox_agent_bundle_importer_unavailable', 'message' => 'Canonical wp_agent_import_runtime_bundles() is unavailable.')));
    }
    $imports = wp_agent_import_runtime_bundles($bundle_specs, array('owner_id' => get_current_user_id() ?: 1));
    return is_array($imports) ? $imports : array(array('success' => false, 'error' => array('code' => 'wp_codebox_agent_bundle_importer_invalid_result', 'message' => 'Canonical wp_agent_import_runtime_bundles() returned an invalid result.')));
}

function wp_codebox_import_external_runtime_agent_package(array $runtime_task): array {
    $package = is_array($runtime_task['input']['package'] ?? null) ? $runtime_task['input']['package'] : array();
    $bootstrap = is_array($package['bootstrap'] ?? null) ? $package['bootstrap'] : array();
    if (empty($bootstrap)) {
        return array('success' => true, 'skipped' => true);
    }

    $expected_digest = (string) ($bootstrap['digest'] ?? '');
    $directory = sys_get_temp_dir() . '/wp-codebox-agent-' . bin2hex(random_bytes(16));
    $path = $directory . '/package.agent.json';
    $bytes = '';
    try {
        if ('base64' !== ($bootstrap['encoding'] ?? '') || !preg_match('/^sha256-bytes-v1:([a-f0-9]{64})$/', $expected_digest) || !is_string($bootstrap['bytes'] ?? null)) {
            return array('success' => false, 'error' => array('code' => 'wp_codebox_external_runtime_package_input_invalid', 'message' => 'Public external runtime package bytes or digest are unavailable.'));
        }
        $bytes = base64_decode($bootstrap['bytes'], true);
        if (false === $bytes || '' === $bytes || !hash_equals($expected_digest, 'sha256-bytes-v1:' . hash('sha256', $bytes))) {
            return array('success' => false, 'error' => array('code' => 'wp_codebox_external_runtime_package_digest_mismatch', 'message' => 'Public external runtime package bytes failed digest verification.'));
        }
        $decoded = json_decode($bytes, true);
        $agent = is_array($decoded['agent'] ?? null) ? $decoded['agent'] : array();
        $agent_slug = (string) ($agent['agent_slug'] ?? '');
        if (!is_array($decoded) || array_is_list($decoded) || JSON_ERROR_NONE !== json_last_error() || 1 !== ($decoded['schema_version'] ?? null) || !is_string($decoded['bundle_slug'] ?? null) || !preg_match('/^[a-z0-9]+(?:-[a-z0-9]+)*$/', $decoded['bundle_slug']) || !preg_match('/^[a-z0-9]+(?:-[a-z0-9]+)*$/', $agent_slug) || isset($decoded['slug']) || isset($decoded['agent_slug']) || isset($decoded['package_slug']) || isset($decoded['agents']) || isset($agent['slug'])) {
            return array('success' => false, 'error' => array('code' => 'wp_codebox_external_runtime_package_json_invalid', 'message' => 'Public external runtime package must declare exactly one canonical agent.agent_slug identity.'));
        }
        if (!function_exists('wp_agent_import_runtime_bundles')) {
            return array('success' => false, 'error' => array('code' => 'wp_codebox_agent_bundle_importer_unavailable', 'message' => 'Canonical wp_agent_import_runtime_bundles() is unavailable.'));
        }
        if (!mkdir($directory, 0700, true)) {
            return array('success' => false, 'error' => array('code' => 'wp_codebox_private_runtime_package_materialization_failed', 'message' => 'Private runtime package could not be materialized for bootstrap import.'));
        }
        $written = file_put_contents($path, $bytes);
        if (false === $written || strlen($bytes) !== $written) {
            return array('success' => false, 'error' => array('code' => 'wp_codebox_external_runtime_package_materialization_failed', 'message' => 'Public external runtime package could not be written completely for bootstrap import.'));
        }
        if (!hash_equals($expected_digest, 'sha256-bytes-v1:' . hash_file('sha256', $path))) {
            return array('success' => false, 'error' => array('code' => 'wp_codebox_external_runtime_package_digest_mismatch', 'message' => 'Public external runtime package bytes changed before canonical import.'));
        }
        $imports = wp_agent_import_runtime_bundles(array(array('source' => $path, 'on_conflict' => 'upgrade')), array('owner_id' => get_current_user_id() ?: 1));
        $imported_slugs = is_array($imports) ? array_values(array_unique(array_filter(array_map(static fn($import): string => is_array($import) ? (string) ($import['agent_slug'] ?? '') : '', $imports)))) : array();
        if (!is_array($imports) || count($imports) !== 1 || !empty(array_filter($imports, static fn($import): bool => is_array($import) && empty($import['success']))) || array($agent_slug) !== $imported_slugs || !function_exists('wp_get_agent') || !wp_get_agent($agent_slug)) {
            return array('success' => false, 'error' => array('code' => 'wp_codebox_external_runtime_package_import_failed', 'message' => 'Canonical runtime package import failed.'));
        }
        $GLOBALS['wp_codebox_private_runtime_package_import'] = array('digest' => $expected_digest, 'imports' => $imports, 'identity' => array('slug' => $agent_slug));
        return array('success' => true, 'imports' => $imports, 'identity' => array('slug' => $agent_slug));
    } finally {
        $bytes = '';
        if (is_file($path)) { @unlink($path); }
        if (is_dir($directory)) { @rmdir($directory); }
    }
}

function wp_codebox_bind_external_runtime_package_identity(&$runtime_task, string $agent_slug, array $import): array {
    if (!is_array($runtime_task) || '' === $agent_slug) {
        return array('success' => false, 'error' => array('code' => 'wp_codebox_external_runtime_package_identity_missing', 'message' => 'Canonical runtime package import did not produce one agent identity.'));
    }
    $task_input = is_array($runtime_task['input'] ?? null) ? $runtime_task['input'] : null;
    $package = is_array($task_input['package'] ?? null) ? $task_input['package'] : null;
    $chat_input = is_array($task_input['input'] ?? null) ? $task_input['input'] : array();
    $metadata = is_array($task_input['metadata'] ?? null) ? $task_input['metadata'] : array();
    $requested_package_slug = is_array($package) ? (string) ($package['slug'] ?? '') : '';
    $requested_agent_slug = is_array($chat_input) ? (string) ($chat_input['agent'] ?? '') : '';
    $metadata_agent_slug = is_array($metadata['imported_agent'] ?? null) ? (string) ($metadata['imported_agent']['slug'] ?? '') : '';
    if (!is_array($package) || ('' !== $requested_package_slug && !hash_equals($agent_slug, $requested_package_slug)) || ('' !== $requested_agent_slug && !hash_equals($agent_slug, $requested_agent_slug)) || ('' !== $metadata_agent_slug && !hash_equals($agent_slug, $metadata_agent_slug))) {
        return array('success' => false, 'error' => array('code' => 'wp_codebox_external_runtime_package_identity_mismatch', 'message' => 'Runtime package execution must use the single agent identity verified during canonical import.'));
    }
    $package['slug'] = $agent_slug;
    $package['bootstrap_imported'] = true;
    $chat_input['agent'] = $agent_slug;
    $metadata['imported_agent'] = array('slug' => $agent_slug);
    $task_input['package'] = $package;
    $task_input['input'] = $chat_input;
    $task_input['metadata'] = $metadata;
    $runtime_task['input'] = $task_input;
    return $import;
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

function wp_codebox_runtime_task_ability_candidates(string $requested_ability): array {
    $aliases = function_exists('apply_filters') ? apply_filters('wp_codebox_runtime_task_ability_aliases', array()) : array();
    $candidates = array($requested_ability);
    if (is_array($aliases) && isset($aliases[$requested_ability]) && is_array($aliases[$requested_ability])) {
        $candidates = array_merge($candidates, array_values($aliases[$requested_ability]));
    }
    $candidates = array_values(array_unique(array_filter(array_map('strval', $candidates), static fn(string $ability): bool => '' !== $ability)));
    return !empty($candidates) ? $candidates : array($requested_ability);
}

function wp_codebox_resolve_runtime_task_ability(string $requested_ability): array {
    $candidates = wp_codebox_runtime_task_ability_candidates($requested_ability);
    if (!function_exists('wp_get_ability')) {
        return array('name' => $requested_ability, 'ability' => null, 'candidates' => $candidates);
    }
    foreach ($candidates as $candidate) {
        $ability = wp_get_ability($candidate);
        if (null !== $ability && method_exists($ability, 'execute')) {
            return array('name' => $candidate, 'ability' => $ability, 'candidates' => $candidates);
        }
    }
    return array('name' => $requested_ability, 'ability' => null, 'candidates' => $candidates);
}

$runtime_task_run = is_array($sandbox_runtime_task) && !empty($sandbox_runtime_task);
$requested_ability_name = $runtime_task_run ? (string) ($sandbox_runtime_task['ability'] ?? '') : 'agents/chat';
$resolved_runtime_task_ability = empty($sandbox_agent_bundle_import_failures) ? wp_codebox_resolve_runtime_task_ability($requested_ability_name) : array('name' => $requested_ability_name, 'ability' => null, 'candidates' => array($requested_ability_name));
$ability_name = (string) ($resolved_runtime_task_ability['name'] ?? $requested_ability_name);
$ability = $resolved_runtime_task_ability['ability'] ?? null;
$registered_ability_ids = function_exists('wp_get_abilities') ? array_keys(wp_get_abilities()) : array();
sort($registered_ability_ids);
$runtime_task_preflight = array(
    'schema' => 'wp-codebox/runtime-task-ability-preflight/v1',
    'runtime_task_requested' => $runtime_task_run,
    'ability' => $requested_ability_name,
    'resolved_ability' => $ability_name,
    'ability_candidates' => $resolved_runtime_task_ability['candidates'] ?? array($requested_ability_name),
    'registry_available' => function_exists('wp_get_ability'),
    'available' => null !== $ability && method_exists($ability, 'execute'),
    'registered_ability_ids' => $registered_ability_ids,
);
$sandbox_stack['abilities'] = array(
    'count' => count($registered_ability_ids),
    'ids' => $registered_ability_ids,
    'requested' => $ability_name,
    'requested_available' => null !== $ability,
    'runtime_task_preflight' => $runtime_task_preflight,
);
$agent_input = ${phpStringLiteral(JSON.stringify(input))};
$decoded_agent_input = json_decode($agent_input, true);
$provider_validation_error = wp_codebox_validate_requested_provider(is_array($decoded_agent_input) ? $decoded_agent_input : array(), $sandbox_stack);
if (empty($sandbox_external_runtime_package_import['success'])) {
    $sandbox_agent_runtime = array(
        'agent_runtime' => array(
            'success' => false,
            'error' => $sandbox_external_runtime_package_import['error'] ?? array('code' => 'wp_codebox_external_runtime_package_import_failed', 'message' => 'Public external runtime package import failed before agent availability.'),
        ),
    );
} elseif (!empty($sandbox_agent_bundle_import_failures)) {
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
                'code' => $runtime_task_run ? 'runtime_task_ability_missing_preflight' : 'agents_chat_unavailable',
                'message' => $runtime_task_run ? 'The requested runtime task ability failed sandbox readiness preflight.' : 'The canonical agents/chat ability is not available inside the sandbox.',
                'data' => array('preflight' => $runtime_task_preflight),
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
  const runtimeId = sessionId?.trim() || "contained-runtime"
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

async function normalizeRuntimeTask(config: Record<string, unknown> | undefined, agentInput: Record<string, unknown>, workspace?: SandboxWorkspaceContract): Promise<Record<string, unknown> | null> {
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

  const normalized: Record<string, unknown> = { ability, input: await runtimeTaskInputWithInlineBundle(ability, input, workspace) }
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

async function runtimeTaskInputWithInlineBundle(ability: string, input: Record<string, unknown>, workspace?: SandboxWorkspaceContract): Promise<Record<string, unknown>> {
  if (ability !== 'wp-codebox/run-runtime-package') return input
  const packageDescriptor = recordValue(input.package)
  if (!packageDescriptor || recordValue(packageDescriptor.bundle)) return input
  const source = typeof packageDescriptor.source === 'string' ? packageDescriptor.source.trim() : ''
  if (!source) return input
  const hostPath = workspaceHostPath(source, workspace)
  if (!hostPath) return input
  const bundle = await readDataMachineBundleDirectory(hostPath)
  if (!bundle) return input
  return { ...input, package: { ...packageDescriptor, bundle } }
}

function workspaceHostPath(sandboxPath: string, workspace?: SandboxWorkspaceContract): string {
  const mounts = Array.isArray(workspace?.mounts) ? workspace.mounts : []
  for (const mount of mounts) {
    const mountRecord = mount as unknown as Record<string, unknown>
    const target = typeof mount?.target === 'string' ? mount.target.replace(/\/+$/, '') : ''
    const source = typeof mountRecord.source === 'string' ? mountRecord.source.replace(/\/+$/, '') : ''
    if (!target || !source) continue
    if (sandboxPath === target || sandboxPath.startsWith(`${target}/`)) {
      return join(source, sandboxPath.slice(target.length).replace(/^\/+/, ''))
    }
  }
  return ''
}

async function readDataMachineBundleDirectory(directory: string): Promise<Record<string, unknown> | null> {
  try {
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as Record<string, unknown>
    const pipelines = await readJsonDocuments(join(directory, 'pipelines'))
    const flows = await readJsonDocuments(join(directory, 'flows'))
    const memory = await readTextFiles(join(directory, 'memory'))
    return {
      bundle_version: String(manifest.bundle_version ?? '1'),
      bundle_slug: String(manifest.bundle_slug ?? recordValue(manifest.agent)?.slug ?? 'agent-bundle'),
      source_ref: String(manifest.source_ref ?? ''),
      source_revision: String(manifest.source_revision ?? ''),
      bundle_schema_version: 1,
      exported_at: String(manifest.exported_at ?? new Date().toISOString()),
      agent: bundleAgentFromManifest(recordValue(manifest.agent) ?? {}),
      files: agentMemoryFiles(memory),
      pipelines: pipelines.map((pipeline, index) => legacyPipeline(pipeline, index + 1)),
      flows: flows.map((flow, index) => legacyFlow(flow, index + 1, pipelines)),
      artifact_files: {},
      extension_artifacts: [],
      extras: {},
      abilities_manifest: {},
    }
  } catch {
    return null
  }
}

async function readJsonDocuments(directory: string): Promise<Record<string, unknown>[]> {
  try {
    const entries = (await readdir(directory)).filter((entry) => entry.endsWith('.json')).sort()
    return Promise.all(entries.map(async (entry) => JSON.parse(await readFile(join(directory, entry), 'utf8')) as Record<string, unknown>))
  } catch {
    return []
  }
}

async function readTextFiles(directory: string, base = directory): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  try {
    for (const entry of await readdir(directory)) {
      const full = join(directory, entry)
      const info = await stat(full)
      if (info.isDirectory()) Object.assign(files, await readTextFiles(full, base))
      if (info.isFile()) files[relative(base, full).replace(/\\/g, '/')] = await readFile(full, 'utf8')
    }
  } catch {}
  return files
}

function bundleAgentFromManifest(agent: Record<string, unknown>): Record<string, unknown> {
  return {
    agent_slug: String(agent.slug ?? 'agent'),
    agent_name: String(agent.label ?? agent.slug ?? 'Agent'),
    description: String(agent.description ?? ''),
    agent_config: recordValue(agent.agent_config) ?? {},
  }
}

function agentMemoryFiles(memory: Record<string, string>): Record<string, string> {
  const files: Record<string, string> = {}
  for (const [path, contents] of Object.entries(memory)) {
    if (path.startsWith('agent/')) files[path.slice('agent/'.length)] = contents
  }
  return files
}

function legacyPipeline(pipeline: Record<string, unknown>, id: number): Record<string, unknown> {
  const config: Record<string, unknown> = {}
  for (const step of Array.isArray(pipeline.steps) ? pipeline.steps : []) {
    if (!recordValue(step)) continue
    const position = Number((step as Record<string, unknown>).step_position ?? Object.keys(config).length)
    const key = `${id}_bundle_step_${position}`
    config[key] = { ...(recordValue((step as Record<string, unknown>).step_config) ?? {}), pipeline_step_id: key, step_type: String((step as Record<string, unknown>).step_type ?? ''), execution_order: position }
  }
  return { original_id: id, portable_slug: String(pipeline.slug ?? `pipeline-${id}`), pipeline_name: String(pipeline.name ?? 'Pipeline'), pipeline_config: config, memory_file_contents: {} }
}

function legacyFlow(flow: Record<string, unknown>, id: number, pipelines: Record<string, unknown>[]): Record<string, unknown> {
  const pipelineIndex = Math.max(0, pipelines.findIndex((pipeline) => pipeline.slug === flow.pipeline_slug))
  const pipelineId = pipelineIndex + 1
  const config: Record<string, unknown> = {}
  for (const step of Array.isArray(flow.steps) ? flow.steps : []) {
    if (!recordValue(step)) continue
    const position = Number((step as Record<string, unknown>).step_position ?? Object.keys(config).length)
    const pipelineStepId = `${pipelineId}_bundle_step_${position}`
    const key = `${pipelineStepId}_${id}`
    config[key] = { ...step as Record<string, unknown>, flow_step_id: key, pipeline_step_id: pipelineStepId, pipeline_id: pipelineId, flow_id: id, execution_order: position }
  }
  return { original_id: id, original_pipeline_id: pipelineId, portable_slug: String(flow.slug ?? `flow-${id}`), flow_name: String(flow.name ?? 'Flow'), flow_config: config, scheduling_config: { enabled: String(flow.schedule ?? 'manual') !== 'manual', interval: String(flow.schedule ?? 'manual'), max_items: Array.isArray(flow.max_items) ? flow.max_items : [] }, memory_file_contents: {} }
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

export function agentSandboxRunCode(task: string, code: string, providerPlugins: Array<{ slug: string; pluginFile?: string; loadAs?: string }>, runtimeComponents: Array<{ slug: string; pluginFile?: string; loadAs?: string }> = []): string {
  return `<?php
require_once ABSPATH . 'wp-admin/includes/plugin.php';

$plugins = array_merge(wp_codebox_provider_plugin_entries(json_decode(${phpStringLiteral(JSON.stringify(runtimeComponents))}, true)), array(
), wp_codebox_provider_plugin_entries(json_decode(${phpStringLiteral(JSON.stringify(providerPlugins))}, true)));

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
            'provider_plugins' => wp_codebox_provider_plugin_entries(json_decode(${phpStringLiteral(JSON.stringify(providerPlugins))}, true)),
            'provider_plugin_files' => wp_codebox_provider_plugin_file_diagnostics(json_decode(${phpStringLiteral(JSON.stringify(providerPlugins))}, true)),
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

export function agentRuntimeProbeCode(providerPlugins: Array<{ slug: string; pluginFile?: string; loadAs?: string }>, runtimeComponents: Array<{ slug: string; pluginFile?: string; loadAs?: string }> = []): string {
  return `<?php
require_once ABSPATH . 'wp-admin/includes/plugin.php';

$plugins = array_merge(wp_codebox_provider_plugin_entries(json_decode(${phpStringLiteral(JSON.stringify(runtimeComponents))}, true)), wp_codebox_provider_plugin_entries(json_decode(${phpStringLiteral(JSON.stringify(providerPlugins))}, true)));

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
            'provider_plugins' => wp_codebox_provider_plugin_entries(json_decode(${phpStringLiteral(JSON.stringify(providerPlugins))}, true)),
            'provider_plugin_files' => wp_codebox_provider_plugin_file_diagnostics(json_decode(${phpStringLiteral(JSON.stringify(providerPlugins))}, true)),
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
    $mu_path = WPMU_PLUGIN_DIR . '/contained-runtime/' . $plugin;
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
    foreach (array(WP_PLUGIN_DIR . '/' . $slug, WPMU_PLUGIN_DIR . '/contained-runtime/' . $slug) as $dir) {
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
