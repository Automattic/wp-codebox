export function phpRuntimeComponentLifecycleReplayFunction(prefix: string): string {
  const snapshot = `${prefix}_component_lifecycle_snapshot_hook_callbacks`
  const defer = `${prefix}_component_lifecycle_defer_new_hook_callbacks`
  const run = `${prefix}_component_lifecycle_run_deferred_hook_callbacks`
  const reopen = `${prefix}_component_lifecycle_reopen_action`
  const restore = `${prefix}_component_lifecycle_restore_action`
  const abilityNames = `${prefix}_component_lifecycle_ability_names`
  const prepare = `${prefix}_component_lifecycle_replay_prepare`
  const complete = `${prefix}_component_lifecycle_replay_complete`

  return `if (!function_exists('${prepare}')) {
function ${snapshot}(string $hook_name): array {
    global $wp_filter;
    $snapshot = array();
    if (!isset($wp_filter[$hook_name]) || !isset($wp_filter[$hook_name]->callbacks)) {
        return $snapshot;
    }
    foreach ($wp_filter[$hook_name]->callbacks as $priority => $callbacks) {
        foreach (array_keys($callbacks) as $callback_id) {
            $snapshot[$priority . ':' . $callback_id] = true;
        }
    }
    return $snapshot;
}
function ${defer}(string $hook_name, array $before): array {
    global $wp_filter;
    $deferred = array();
    if (!isset($wp_filter[$hook_name]) || !isset($wp_filter[$hook_name]->callbacks)) {
        return $deferred;
    }
    foreach ($wp_filter[$hook_name]->callbacks as $priority => $callbacks) {
        foreach ($callbacks as $callback_id => $callback) {
            if (isset($before[$priority . ':' . $callback_id])) {
                continue;
            }
            $deferred[] = array('priority' => (int) $priority, 'callback' => $callback);
            unset($wp_filter[$hook_name]->callbacks[$priority][$callback_id]);
        }
        if (empty($wp_filter[$hook_name]->callbacks[$priority])) {
            unset($wp_filter[$hook_name]->callbacks[$priority]);
        }
    }
    usort($deferred, static function (array $left, array $right): int { return ($left['priority'] ?? 10) <=> ($right['priority'] ?? 10); });
    return $deferred;
}
function ${run}(array $deferred, string $hook_name, array $args = array()): void {
    global $wp_current_filter;
    if (!is_array($wp_current_filter)) {
        $wp_current_filter = array();
    }
    $wp_current_filter[] = $hook_name;
    try {
        foreach ($deferred as $entry) {
            $callback = $entry['callback'] ?? null;
            if (!is_array($callback) || !isset($callback['function'])) {
                continue;
            }
            $accepted_args = isset($callback['accepted_args']) ? (int) $callback['accepted_args'] : count($args);
            call_user_func_array($callback['function'], array_slice($args, 0, $accepted_args));
        }
    } finally {
        array_pop($wp_current_filter);
    }
}
function ${reopen}(string $hook_name): int {
    global $wp_actions;
    $count = function_exists('did_action') ? (int) did_action($hook_name) : 0;
    if ($count > 0) {
        if (!is_array($wp_actions)) {
            $wp_actions = array();
        }
        $wp_actions[$hook_name] = 0;
    }
    return $count;
}
function ${restore}(string $hook_name, int $count): void {
    global $wp_actions;
    if ($count <= 0) {
        return;
    }
    if (!is_array($wp_actions)) {
        $wp_actions = array();
    }
    $wp_actions[$hook_name] = max($count, (int) ($wp_actions[$hook_name] ?? 0), 1);
}
function ${abilityNames}(): array {
    if (!function_exists('wp_get_abilities')) {
        return array();
    }
    $abilities = wp_get_abilities();
    return is_array($abilities) ? array_values(array_map('strval', array_keys($abilities))) : array();
}
function ${prepare}(): array {
    $hooks = array('plugins_loaded', 'init', 'wp_abilities_api_categories_init', 'wp_abilities_api_init', 'wp_codebox_runtime_abilities_ready');
    $state = array('hooks' => array(), 'abilities_before' => ${abilityNames}());
    foreach ($hooks as $hook_name) {
        $state['hooks'][$hook_name] = array(
            'callbacks' => ${snapshot}($hook_name),
            'did_action' => ${reopen}($hook_name),
        );
    }
    return $state;
}
function ${complete}(array $state): array {
    $diagnostic = array(
        'schema' => 'wp-codebox/runtime-component-lifecycle-replay/v1',
        'hooks' => array(),
        'abilities_before' => $state['abilities_before'] ?? array(),
        'abilities_after' => array(),
        'abilities_added' => array(),
    );
    foreach (($state['hooks'] ?? array()) as $hook_name => $hook_state) {
        $deferred = ${defer}((string) $hook_name, is_array($hook_state['callbacks'] ?? null) ? $hook_state['callbacks'] : array());
        ${run}($deferred, (string) $hook_name);
        ${restore}((string) $hook_name, (int) ($hook_state['did_action'] ?? 0));
        $diagnostic['hooks'][(string) $hook_name] = array('replayed_callbacks' => count($deferred), 'previous_did_action' => (int) ($hook_state['did_action'] ?? 0));
    }
    $diagnostic['abilities_after'] = ${abilityNames}();
    $diagnostic['abilities_added'] = array_values(array_diff($diagnostic['abilities_after'], is_array($diagnostic['abilities_before']) ? $diagnostic['abilities_before'] : array()));
    return $diagnostic;
}
}`
}

export function phpRuntimeComponentLifecycleActionReplayFunction(functionName: string): string {
  return `function ${functionName}(): array {
    do_action('plugins_loaded');
    do_action('init');
    do_action('wp_abilities_api_categories_init');
    do_action('wp_abilities_api_init');
    do_action('wp_codebox_runtime_abilities_ready');

    return array(
        'plugins_loaded' => function_exists('did_action') ? did_action('plugins_loaded') : null,
        'init' => function_exists('did_action') ? did_action('init') : null,
        'wp_abilities_api_categories_init' => function_exists('did_action') ? did_action('wp_abilities_api_categories_init') : null,
        'wp_abilities_api_init' => function_exists('did_action') ? did_action('wp_abilities_api_init') : null,
        'wp_codebox_runtime_abilities_ready' => function_exists('did_action') ? did_action('wp_codebox_runtime_abilities_ready') : null,
    );
}`
}
