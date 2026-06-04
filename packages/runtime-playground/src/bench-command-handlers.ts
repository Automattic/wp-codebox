export interface BenchRunCodeOptions {
  componentId: string
  pluginSlug: string
  iterations: number
  warmupIterations: number
  dependencySlugs: string[]
  env: Record<string, unknown>
  bootstrapFiles: string[]
  workloads: unknown[]
  wpCliBridge?: { url: string; token: string }
}

export function benchRunCode(options: BenchRunCodeOptions): string {
  return `require_once ABSPATH . 'wp-admin/includes/plugin.php';

$component_id = ${JSON.stringify(options.componentId)};
$plugin_slug = ${JSON.stringify(options.pluginSlug)};
$plugin_path = WP_PLUGIN_DIR . '/' . $plugin_slug;
$iterations = max(1, (int) ${JSON.stringify(String(options.iterations))});
$warmup_iterations = max(0, (int) ${JSON.stringify(String(options.warmupIterations))});
$dependency_slugs = json_decode(${JSON.stringify(JSON.stringify(options.dependencySlugs))}, true);
$bench_env = json_decode(${JSON.stringify(JSON.stringify(options.env))}, true);
$bootstrap_files = json_decode(${JSON.stringify(JSON.stringify(options.bootstrapFiles))}, true);
$configured_workloads = json_decode(${JSON.stringify(JSON.stringify(options.workloads))}, true);
$wp_cli_bridge_url = ${JSON.stringify(options.wpCliBridge?.url ?? null)};
$wp_cli_bridge_token = ${JSON.stringify(options.wpCliBridge?.token ?? null)};

if (is_array($bench_env)) {
    foreach ($bench_env as $name => $value) {
        if (is_string($name) && preg_match('/^[A-Za-z_][A-Za-z0-9_]*$/', $name)) {
            $string_value = is_scalar($value) ? (string) $value : wp_json_encode($value);
            putenv($name . '=' . $string_value);
            $_ENV[$name] = $string_value;
        }
    }
}

function wp_codebox_bench_percentile(array $samples, float $percentile): float {
    if (empty($samples)) {
        return 0.0;
    }

    sort($samples, SORT_NUMERIC);
    $index = (int) ceil($percentile * count($samples)) - 1;
    $index = max(0, min(count($samples) - 1, $index));
    return (float) $samples[$index];
}

function wp_codebox_bench_aggregate(array $samples, string $prefix = '', string $suffix = ''): array {
    sort($samples, SORT_NUMERIC);
    $count = count($samples);
    $sum = array_sum($samples);
    $key_prefix = $prefix === '' ? '' : $prefix . '_';

    return array(
        $key_prefix . 'mean' . $suffix => $count > 0 ? $sum / $count : 0.0,
        $key_prefix . 'p50' . $suffix => wp_codebox_bench_percentile($samples, 0.50),
        $key_prefix . 'p95' . $suffix => wp_codebox_bench_percentile($samples, 0.95),
        $key_prefix . 'p99' . $suffix => wp_codebox_bench_percentile($samples, 0.99),
        $key_prefix . 'min' . $suffix => $count > 0 ? (float) $samples[0] : 0.0,
        $key_prefix . 'max' . $suffix => $count > 0 ? (float) $samples[$count - 1] : 0.0,
    );
}

function wp_codebox_bench_record_payload($payload, array &$metric_samples, ?array &$metadata, ?array &$artifacts = null): void {
    if (!is_array($payload)) {
        return;
    }

    if (isset($payload['metadata']) && is_array($payload['metadata'])) {
        $metadata = $payload['metadata'];
    }

    if (isset($payload['artifacts']) && is_array($payload['artifacts'])) {
        $artifacts = $payload['artifacts'];
    }

    $metrics = array();
    if (isset($payload['metrics']) && is_array($payload['metrics'])) {
        $metrics = $payload['metrics'];
    } else {
        $metrics = $payload;
        unset($metrics['metadata'], $metrics['artifacts']);
    }

    foreach ($metrics as $name => $value) {
        if (!is_string($name) || $name === '' || !is_numeric($value)) {
            continue;
        }

        $sample = (float) $value;
        if (is_finite($sample)) {
            $metric_samples[$name][] = $sample;
        }
    }
}

function wp_codebox_bench_run_wp_cli_step(array $step) {
    global $wp_cli_bridge_url, $wp_cli_bridge_token;
    $command = isset($step['command']) && is_string($step['command']) ? trim($step['command']) : '';
    if ($command === '') {
        throw new RuntimeException('wp-cli bench workload steps require a command.');
    }
    if (!is_string($wp_cli_bridge_url) || $wp_cli_bridge_url === '' || !is_string($wp_cli_bridge_token) || $wp_cli_bridge_token === '') {
        throw new RuntimeException('wordpress.bench wp-cli workload steps require the WP-CLI bridge.');
    }

    $parse = isset($step['parse']) && is_string($step['parse']) ? $step['parse'] : '';
    $response = wp_remote_post($wp_cli_bridge_url . '/execute', array(
        'headers' => array(
            'authorization' => 'Bearer ' . $wp_cli_bridge_token,
            'content-type' => 'application/json',
        ),
        'body' => wp_json_encode(array('type' => 'wp_cli', 'command' => $command), JSON_UNESCAPED_SLASHES),
        'timeout' => 300,
    ));
    if (is_wp_error($response)) {
        throw new RuntimeException('WP-CLI bench workload bridge request failed: ' . $response->get_error_message());
    }
    $body = wp_remote_retrieve_body($response);
    $result = json_decode($body, true);
    if (!is_array($result)) {
        throw new RuntimeException('WP-CLI bench workload bridge returned invalid JSON.');
    }
    if (empty($result['success'])) {
        $error = isset($result['error']) && is_string($result['error']) ? $result['error'] : 'WP-CLI command failed';
        throw new RuntimeException('WP-CLI bench workload step failed: ' . $command . ' - ' . $error);
    }
    $stdout = isset($result['stdout']) ? (string) $result['stdout'] : '';
    if ($parse === 'json' && $stdout !== '') {
        $decoded = json_decode($stdout, true);
        if (json_last_error() === JSON_ERROR_NONE) {
            return $decoded;
        }
    }
    return $stdout;
}

function wp_codebox_bench_snapshot_wordpress_hook_callbacks(string $hook_name): array {
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

function wp_codebox_bench_defer_new_wordpress_hook_callbacks(string $hook_name, array $before): array {
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
    usort($deferred, static function (array $left, array $right): int {
        return ($left['priority'] ?? 10) <=> ($right['priority'] ?? 10);
    });
    return $deferred;
}

function wp_codebox_bench_run_deferred_wordpress_hook_callbacks(array $deferred, array $args = array(), ?string $hook_name = null): void {
    global $wp_current_filter;
    $pushed_hook = false;
    if (is_string($hook_name) && $hook_name !== '') {
        if (!is_array($wp_current_filter)) {
            $wp_current_filter = array();
        }
        $wp_current_filter[] = $hook_name;
        $pushed_hook = true;
    }
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
        if ($pushed_hook) {
            array_pop($wp_current_filter);
        }
    }
}

function wp_codebox_bench_plugin_file_for_slug(string $plugin_slug, string $role): string {
    $plugin_slug = sanitize_key($plugin_slug);
    if ($plugin_slug === '') {
        throw new RuntimeException('wordpress.bench received an empty ' . $role . ' plugin slug. ' . wp_codebox_bench_plugin_slug_diagnostic($plugin_slug, $role, 'empty plugin slug'));
    }

    $plugin_dir = WP_PLUGIN_DIR . '/' . $plugin_slug;
    if (!is_dir($plugin_dir)) {
        throw new RuntimeException('wordpress.bench could not find ' . $role . ' plugin directory for slug "' . $plugin_slug . '". ' . wp_codebox_bench_plugin_slug_diagnostic($plugin_slug, $role, 'missing plugin directory'));
    }

    $candidate_files = array($plugin_dir . '/' . $plugin_slug . '.php');
    foreach (glob($plugin_dir . '/*.php') ?: array() as $candidate_file) {
        if (basename($candidate_file) !== 'db.php' && !in_array($candidate_file, $candidate_files, true)) {
            $candidate_files[] = $candidate_file;
        }
    }

    $checked_files = array();
    foreach ($candidate_files as $candidate_file) {
        $checked_files[] = $candidate_file;
        if (!is_file($candidate_file) || !is_readable($candidate_file)) {
            continue;
        }
        $contents = file_get_contents($candidate_file, false, null, 0, 8192);
        if (is_string($contents) && strpos($contents, 'Plugin Name:') !== false) {
            return $plugin_slug . '/' . basename($candidate_file);
        }
    }

    throw new RuntimeException('wordpress.bench could not locate a readable plugin header for ' . $role . ' slug "' . $plugin_slug . '". ' . wp_codebox_bench_plugin_slug_diagnostic($plugin_slug, $role, 'missing readable plugin header', $checked_files));
}

function wp_codebox_bench_plugin_slug_diagnostic(string $plugin_slug, string $role, string $error, array $checked_files = array()): string {
    $plugin_dir = WP_PLUGIN_DIR . '/' . $plugin_slug;
    return 'diagnostic=' . wp_json_encode(array(
        'schema' => 'wp-codebox/bench-plugin-load-diagnostic/v1',
        'role' => $role,
        'plugin_slug' => $plugin_slug,
        'expected_directory' => $plugin_dir,
        'directory_exists' => is_dir($plugin_dir),
        'wp_plugin_dir' => WP_PLUGIN_DIR,
        'checked_files' => $checked_files,
        'error' => $error,
    ), JSON_UNESCAPED_SLASHES);
}

function wp_codebox_bench_plugin_load_diagnostic(string $plugin_basename, string $role, string $error = ''): string {
    $absolute_plugin_file = WP_PLUGIN_DIR . '/' . $plugin_basename;
    $real_plugin_file = realpath($absolute_plugin_file);
    $included_files = array_map(static fn($file) => realpath($file) ?: $file, get_included_files());
    $included = in_array($real_plugin_file ?: $absolute_plugin_file, $included_files, true);

    return 'diagnostic=' . wp_json_encode(array(
        'schema' => 'wp-codebox/bench-plugin-load-diagnostic/v1',
        'role' => $role,
        'plugin_slug' => dirname($plugin_basename),
        'plugin_file' => $plugin_basename,
        'expected_file_path' => $absolute_plugin_file,
        'file_exists' => is_file($absolute_plugin_file),
        'file_readable' => is_readable($absolute_plugin_file),
        'active' => function_exists('is_plugin_active') ? is_plugin_active($plugin_basename) : null,
        'included' => $included,
        'wp_plugin_dir' => WP_PLUGIN_DIR,
        'error' => $error,
    ), JSON_UNESCAPED_SLASHES);
}

function wp_codebox_bench_mark_plugin_active(string $plugin_basename): void {
    $active_plugins = (array) get_option('active_plugins', array());
    if (!in_array($plugin_basename, $active_plugins, true)) {
        $active_plugins[] = $plugin_basename;
        sort($active_plugins);
        update_option('active_plugins', array_values($active_plugins));
    }
}

function wp_codebox_bench_include_plugin_file(string $plugin_basename, string $role): void {
    $absolute_plugin_file = WP_PLUGIN_DIR . '/' . $plugin_basename;
    if (!is_file($absolute_plugin_file) || !is_readable($absolute_plugin_file)) {
        throw new RuntimeException('wordpress.bench cannot include plugin file "' . $plugin_basename . '". ' . wp_codebox_bench_plugin_load_diagnostic($plugin_basename, $role, 'missing or unreadable plugin file'));
    }

    wp_codebox_bench_assert_plugin_autoload_ready($plugin_basename);

    try {
        require_once $absolute_plugin_file;
        wp_codebox_bench_mark_plugin_active($plugin_basename);
    } catch (Throwable $e) {
        throw new RuntimeException('wordpress.bench failed to include plugin "' . $plugin_basename . '". ' . wp_codebox_bench_plugin_load_diagnostic($plugin_basename, $role, $e->getMessage()), 0, $e);
    }

    $diagnostic = wp_codebox_bench_plugin_load_diagnostic($plugin_basename, $role, 'plugin file was not included');
    if (strpos($diagnostic, '"included":true') === false) {
        throw new RuntimeException('wordpress.bench failed to verify included plugin "' . $plugin_basename . '". ' . $diagnostic);
    }
}

function wp_codebox_bench_assert_plugin_autoload_ready(string $plugin_basename): void {
    $plugin_slug = dirname($plugin_basename);
    if ($plugin_slug === '.' || $plugin_slug === '') {
        return;
    }

    $plugin_dir = WP_PLUGIN_DIR . '/' . $plugin_slug;
    $autoload_markers = array(
        $plugin_dir . '/vendor/autoload.php',
        $plugin_dir . '/vendor/autoload_packages.php',
    );
    foreach ($autoload_markers as $autoload_marker) {
        if (is_file($autoload_marker) && is_readable($autoload_marker)) {
            return;
        }
    }

    $source_autoloader = $plugin_dir . '/src/Autoloader.php';
    if (!is_file($source_autoloader) || !is_readable($source_autoloader)) {
        return;
    }

    $source = file_get_contents($source_autoloader, false, null, 0, 4096);
    if (is_string($source) && (strpos($source, 'vendor/autoload.php') !== false || strpos($source, 'vendor/autoload_packages.php') !== false)) {
        throw new RuntimeException('wordpress.bench cannot fully bootstrap plugin "' . $plugin_basename . '" because its source autoloader requires a missing vendor autoload file. Checked: ' . implode(', ', $autoload_markers) . '. Provide a built dependency/plugin with Composer package autoload files before running heavyweight benchmark workloads.');
    }
}

$plugins_to_activate = array();
$plugin_roles = array();
$activated_plugins = array();
foreach (is_array($dependency_slugs) ? $dependency_slugs : array() as $dependency_slug) {
    $dependency_file = wp_codebox_bench_plugin_file_for_slug((string) $dependency_slug, 'dependency');
    $plugins_to_activate[] = $dependency_file;
    $plugin_roles[$dependency_file] = 'dependency';
}
$plugin_file = wp_codebox_bench_plugin_file_for_slug($plugin_slug, 'component');
$plugins_to_activate[] = $plugin_file;
$plugin_roles[$plugin_file] = 'component';
$plugins_to_activate = array_values(array_unique($plugins_to_activate));
foreach ($plugins_to_activate as $plugin_to_activate) {
    wp_codebox_bench_assert_plugin_autoload_ready($plugin_to_activate);
}
foreach ($plugins_to_activate as $plugin_to_activate) {
    if (is_plugin_active($plugin_to_activate)) {
        continue;
    }
    $activation = activate_plugin($plugin_to_activate);
    if (is_wp_error($activation)) {
        throw new RuntimeException('wordpress.bench failed to activate plugin "' . $plugin_to_activate . '". ' . wp_codebox_bench_plugin_load_diagnostic($plugin_to_activate, $plugin_roles[$plugin_to_activate] ?? 'plugin', $activation->get_error_message()));
    }
    $activated_plugins[] = $plugin_to_activate;
}

$pre_plugins_loaded_callbacks = wp_codebox_bench_snapshot_wordpress_hook_callbacks('plugins_loaded');
$pre_init_callbacks = wp_codebox_bench_snapshot_wordpress_hook_callbacks('init');
foreach ($plugins_to_activate as $plugin_to_activate) {
    wp_codebox_bench_include_plugin_file($plugin_to_activate, $plugin_roles[$plugin_to_activate] ?? 'plugin');
}
$loaded_bootstrap_file = '';
foreach (is_array($bootstrap_files) ? $bootstrap_files : array() as $bootstrap_file) {
    if (!is_string($bootstrap_file) || $bootstrap_file === '' || str_contains($bootstrap_file, '..')) {
        continue;
    }
    $bootstrap_path = $plugin_path . '/' . ltrim($bootstrap_file, '/');
    if (file_exists($bootstrap_path)) {
        require_once $bootstrap_path;
        $loaded_bootstrap_file = $bootstrap_file;
        break;
    }
}
if (is_array($bootstrap_files) && count($bootstrap_files) > 0 && $loaded_bootstrap_file === '') {
    throw new RuntimeException('No configured wordpress.bench bootstrap files were found.');
}

$deferred_plugins_loaded_callbacks = wp_codebox_bench_defer_new_wordpress_hook_callbacks('plugins_loaded', $pre_plugins_loaded_callbacks);
$pre_replayed_plugins_loaded_init_callbacks = wp_codebox_bench_snapshot_wordpress_hook_callbacks('init');
wp_codebox_bench_run_deferred_wordpress_hook_callbacks($deferred_plugins_loaded_callbacks, array(), 'plugins_loaded');
$deferred_init_callbacks = wp_codebox_bench_defer_new_wordpress_hook_callbacks('init', $pre_init_callbacks);
$deferred_init_callbacks = array_merge($deferred_init_callbacks, wp_codebox_bench_defer_new_wordpress_hook_callbacks('init', $pre_replayed_plugins_loaded_init_callbacks));
usort($deferred_init_callbacks, static function (array $left, array $right): int {
    return ($left['priority'] ?? 10) <=> ($right['priority'] ?? 10);
});
wp_codebox_bench_run_deferred_wordpress_hook_callbacks($deferred_init_callbacks, array(), 'init');
if (did_action('rest_api_init')) {
    $GLOBALS['wp_rest_server'] = null;
    do_action('rest_api_init', rest_get_server());
}

function wp_codebox_bench_run_configured_workload(array $workload, string $plugin_path) {
    $steps = isset($workload['run']) && is_array($workload['run']) ? $workload['run'] : array($workload);
    $payload = array('metrics' => array(), 'metadata' => array(), 'artifacts' => array());
    if (isset($workload['metadata']) && is_array($workload['metadata'])) {
        $payload['metadata'] = array_merge($payload['metadata'], $workload['metadata']);
    }
    if (isset($workload['artifacts']) && is_array($workload['artifacts'])) {
        $payload['artifacts'] = array_merge($payload['artifacts'], $workload['artifacts']);
    }
    foreach ($steps as $step) {
        if (!is_array($step)) {
            continue;
        }
        $type = isset($step['type']) ? (string) $step['type'] : 'php';
        if ($type === 'php') {
            if (isset($step['file']) && is_string($step['file'])) {
                $file = $plugin_path . '/' . ltrim($step['file'], '/');
                $callable = require $file;
                $result = is_callable($callable) ? $callable() : $callable;
            } else {
                $result = null;
                $code = isset($step['code']) && is_string($step['code']) ? $step['code'] : '';
                if ($code !== '') {
                    $runner = static function () use ($code, &$result): void {
                        $result = eval($code);
                    };
                    $runner();
                }
            }
        } elseif ($type === 'ability') {
            if (!function_exists('wp_get_ability')) {
                throw new RuntimeException('The WordPress Abilities API is not available in this runtime.');
            }
            $ability_name = isset($step['name']) ? (string) $step['name'] : (isset($step['ability']) ? (string) $step['ability'] : '');
            $ability = wp_get_ability($ability_name);
            if (!$ability) {
                throw new RuntimeException('Ability is not registered: ' . $ability_name);
            }
            $result = $ability->execute(isset($step['input']) && is_array($step['input']) ? $step['input'] : array());
            if (is_wp_error($result)) {
                throw new RuntimeException($result->get_error_message());
            }
        } elseif ($type === 'wp-cli') {
            $result = wp_codebox_bench_run_wp_cli_step($step);
        } else {
            throw new RuntimeException('Unsupported bench workload step type: ' . $type);
        }
        if (is_array($result)) {
            if (isset($result['metrics']) && is_array($result['metrics'])) {
                $payload['metrics'] = array_merge($payload['metrics'], $result['metrics']);
            }
            if (isset($result['metadata']) && is_array($result['metadata'])) {
                $payload['metadata'] = array_merge($payload['metadata'], $result['metadata']);
            }
            if (isset($result['artifacts']) && is_array($result['artifacts'])) {
                $payload['artifacts'] = array_merge($payload['artifacts'], $result['artifacts']);
            }
        }
    }
    return $payload;
}

$bench_dir = $plugin_path . '/tests/bench';
$workload_files = is_dir($bench_dir) ? glob($bench_dir . '/*.php') : array();
sort($workload_files, SORT_STRING);

$scenarios = array();
foreach ($workload_files as $workload_file) {
    $callable = require $workload_file;
    if (!is_callable($callable)) {
        continue;
    }

    $timings = array();
    $metric_samples = array();
    $metadata = null;
    $artifacts = null;
    $artifacts = null;

    if (function_exists('memory_reset_peak_usage')) {
        memory_reset_peak_usage();
    }

    $total_iterations = $iterations + $warmup_iterations;
    for ($i = 0; $i < $total_iterations; $i++) {
        $is_warmup = $i < $warmup_iterations;
        $started = hrtime(true);
        $payload = $callable();
        $elapsed_ms = (hrtime(true) - $started) / 1000000;

        if (!$is_warmup) {
            $timings[] = $elapsed_ms;
            wp_codebox_bench_record_payload($payload, $metric_samples, $metadata, $artifacts);
        }
    }

    $metrics = wp_codebox_bench_aggregate($timings, '', '_ms');
    ksort($metric_samples);
    foreach ($metric_samples as $metric => $samples) {
        $metrics += wp_codebox_bench_aggregate($samples, $metric);
    }

    $relative_file = substr($workload_file, strlen($plugin_path) + 1);
    $scenario = array(
        'id' => preg_replace('/\\.php$/', '', basename($workload_file)),
        'source' => 'in_tree',
        'file' => $relative_file,
        'iterations' => $iterations,
        'metrics' => $metrics,
        'memory' => array('peak_bytes' => memory_get_peak_usage(true)),
    );

    if (is_array($metadata) && !empty($metadata)) {
        $scenario['metadata'] = $metadata;
    }

    $scenarios[] = $scenario;
}

foreach (is_array($configured_workloads) ? $configured_workloads : array() as $index => $workload) {
    if (!is_array($workload)) {
        continue;
    }
    $scenario_id = isset($workload['id']) && is_string($workload['id']) ? $workload['id'] : 'configured-' . $index;
    $timings = array();
    $metric_samples = array();
    $metadata = null;
    $total_iterations = $iterations + $warmup_iterations;
    for ($i = 0; $i < $total_iterations; $i++) {
        $is_warmup = $i < $warmup_iterations;
        $started = hrtime(true);
        $payload = wp_codebox_bench_run_configured_workload($workload, $plugin_path);
        $elapsed_ms = (hrtime(true) - $started) / 1000000;
        if (!$is_warmup) {
            $timings[] = $elapsed_ms;
            wp_codebox_bench_record_payload($payload, $metric_samples, $metadata, $artifacts);
        }
    }
    $metrics = wp_codebox_bench_aggregate($timings, '', '_ms');
    ksort($metric_samples);
    foreach ($metric_samples as $metric => $samples) {
        $metrics += wp_codebox_bench_aggregate($samples, $metric);
    }
    $scenario = array(
        'id' => $scenario_id,
        'source' => 'config',
        'iterations' => $iterations,
        'metrics' => $metrics,
        'memory' => array('peak_bytes' => memory_get_peak_usage(true)),
    );
    if (is_array($metadata) && !empty($metadata)) {
        $scenario['metadata'] = $metadata;
    }
    if (is_array($artifacts) && !empty($artifacts)) {
        $scenario['artifacts'] = $artifacts;
    }
    $scenarios[] = $scenario;
}

echo wp_json_encode(array(
    'component_id' => $component_id,
    'iterations' => $iterations,
    'warmup_iterations' => $warmup_iterations,
    'scenarios' => $scenarios,
), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);`
}
