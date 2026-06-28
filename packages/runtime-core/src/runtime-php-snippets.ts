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
    $hooks = array('plugins_loaded', 'init', 'wp_abilities_api_categories_init', 'wp_abilities_api_init', 'contained_runtime_abilities_ready');
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

export function phpRuntimeRecipePluginPreloadFunction(prefix: string): string {
  const diagnostic = `${prefix}_recipe_plugin_preload_diagnostic`
  const diagnosticString = `${prefix}_recipe_plugin_preload_diagnostic_string`
  const preload = `${prefix}_preload_recipe_plugin`
  const prepare = `${prefix}_component_lifecycle_replay_prepare`
  const complete = `${prefix}_component_lifecycle_replay_complete`

  return `${phpRuntimeComponentLifecycleReplayFunction(prefix)}
if (!function_exists('${preload}')) {
function ${diagnostic}(array $plugin, string $role, string $error = ''): array {
    $plugin_file = isset($plugin['pluginFile']) ? (string) $plugin['pluginFile'] : '';
    $plugin_dir = dirname($plugin_file);
    $absolute_plugin_file = defined('WP_PLUGIN_DIR') ? WP_PLUGIN_DIR . '/' . $plugin_file : $plugin_file;
    $real_plugin_file = realpath($absolute_plugin_file);
    $included_files = array_map(static fn($file) => realpath($file) ?: $file, get_included_files());
    $autoload = defined('WP_PLUGIN_DIR') ? WP_PLUGIN_DIR . '/' . $plugin_dir . '/vendor/autoload.php' : '';
    $package_autoload = defined('WP_PLUGIN_DIR') ? WP_PLUGIN_DIR . '/' . $plugin_dir . '/vendor/autoload_packages.php' : '';
    $classmap = defined('WP_PLUGIN_DIR') ? WP_PLUGIN_DIR . '/' . $plugin_dir . '/vendor/composer/autoload_classmap.php' : '';
    return array(
        'schema' => 'wp-codebox/recipe-plugin-preload-diagnostic/v1',
        'role' => $role,
        'plugin_slug' => isset($plugin['slug']) ? (string) $plugin['slug'] : dirname($plugin_file),
        'plugin_file' => $plugin_file,
        'plugin_dir' => $plugin_dir,
        'mounted_path' => isset($plugin['target']) ? (string) $plugin['target'] : (defined('WP_PLUGIN_DIR') ? WP_PLUGIN_DIR . '/' . dirname($plugin_file) : ''),
        'expected_file_path' => $absolute_plugin_file,
        'file_exists' => is_file($absolute_plugin_file),
        'file_readable' => is_readable($absolute_plugin_file),
        'active' => function_exists('is_plugin_active') ? is_plugin_active($plugin_file) : null,
        'included' => in_array($real_plugin_file ?: $absolute_plugin_file, $included_files, true),
        'wp_plugin_dir' => defined('WP_PLUGIN_DIR') ? WP_PLUGIN_DIR : null,
        'autoload' => array(
            'path' => $autoload,
            'exists' => $autoload !== '' ? is_file($autoload) : false,
            'readable' => $autoload !== '' ? is_readable($autoload) : false,
            'included' => $autoload !== '' ? in_array(realpath($autoload) ?: $autoload, $included_files, true) : false,
        ),
        'package_autoload' => array(
            'path' => $package_autoload,
            'exists' => $package_autoload !== '' ? is_file($package_autoload) : false,
            'readable' => $package_autoload !== '' ? is_readable($package_autoload) : false,
            'size' => ($package_autoload !== '' && is_file($package_autoload)) ? filesize($package_autoload) : null,
            'sha1' => ($package_autoload !== '' && is_file($package_autoload)) ? sha1_file($package_autoload) : null,
            'included' => $package_autoload !== '' ? in_array(realpath($package_autoload) ?: $package_autoload, $included_files, true) : false,
        ),
        'classmap' => array(
            'path' => $classmap,
            'exists' => $classmap !== '' ? is_file($classmap) : false,
            'readable' => $classmap !== '' ? is_readable($classmap) : false,
        ),
        'error' => $error,
    );
}
function ${diagnosticString}(array $plugin, string $role, string $error = ''): string {
    $diagnostic = ${diagnostic}($plugin, $role, $error);
    $json = function_exists('wp_json_encode') ? wp_json_encode($diagnostic, JSON_UNESCAPED_SLASHES) : json_encode($diagnostic, JSON_UNESCAPED_SLASHES);
    return 'diagnostic=' . (is_string($json) ? $json : '{}');
}
function ${preload}(array $plugin, bool $include_plugin_file, string $role = 'recipe-plugin', string $command_label = 'wordpress.run-php'): array {
    $plugin_file = isset($plugin['pluginFile']) ? (string) $plugin['pluginFile'] : '';
    if ($plugin_file === '' || str_starts_with($plugin_file, '/') || str_contains($plugin_file, '..') || !str_ends_with($plugin_file, '.php')) {
        throw new RuntimeException($command_label . ' cannot preload unsafe recipe plugin file "' . $plugin_file . '". ' . ${diagnosticString}($plugin, $role, 'unsafe plugin file'));
    }
    $absolute_plugin_file = WP_PLUGIN_DIR . '/' . $plugin_file;
    if (!is_file($absolute_plugin_file) || !is_readable($absolute_plugin_file)) {
        throw new RuntimeException($command_label . ' cannot preload recipe plugin file "' . $plugin_file . '". ' . ${diagnosticString}($plugin, $role, 'missing or unreadable plugin file'));
    }
    $plugin_dir = dirname($plugin_file);
    $plugin_package_autoload = WP_PLUGIN_DIR . '/' . $plugin_dir . '/vendor/autoload_packages.php';
    if ('.' !== $plugin_dir && is_file($plugin_package_autoload)) {
        require_once $plugin_package_autoload;
    } else {
        $plugin_autoload = WP_PLUGIN_DIR . '/' . $plugin_dir . '/vendor/autoload.php';
        if ('.' !== $plugin_dir && is_file($plugin_autoload)) {
            require_once $plugin_autoload;
        }
    }
    if (!$include_plugin_file) {
        return ${diagnostic}($plugin, $role);
    }
    $lifecycle = ${prepare}();
    try {
        require_once $absolute_plugin_file;
    } catch (Throwable $e) {
        throw new RuntimeException($command_label . ' failed to include recipe plugin "' . $plugin_file . '". ' . ${diagnosticString}($plugin, $role, $e->getMessage()), 0, $e);
    } finally {
        ${complete}($lifecycle);
    }
    $diagnostic = ${diagnostic}($plugin, $role, 'plugin file was not included');
    if (empty($diagnostic['included'])) {
        throw new RuntimeException($command_label . ' failed to verify included recipe plugin "' . $plugin_file . '". diagnostic=' . (function_exists('wp_json_encode') ? wp_json_encode($diagnostic, JSON_UNESCAPED_SLASHES) : json_encode($diagnostic, JSON_UNESCAPED_SLASHES)));
    }
    return ${diagnostic}($plugin, $role);
}
}`
}

export function phpRuntimeComponentLifecycleActionReplayFunction(functionName: string): string {
  return `function ${functionName}(): array {
    do_action('plugins_loaded');
    do_action('init');
    do_action('wp_abilities_api_categories_init');
    do_action('wp_abilities_api_init');
    do_action('contained_runtime_abilities_ready');

    return array(
        'plugins_loaded' => function_exists('did_action') ? did_action('plugins_loaded') : null,
        'init' => function_exists('did_action') ? did_action('init') : null,
        'wp_abilities_api_categories_init' => function_exists('did_action') ? did_action('wp_abilities_api_categories_init') : null,
        'wp_abilities_api_init' => function_exists('did_action') ? did_action('wp_abilities_api_init') : null,
        'contained_runtime_abilities_ready' => function_exists('did_action') ? did_action('contained_runtime_abilities_ready') : null,
    );
}`
}
