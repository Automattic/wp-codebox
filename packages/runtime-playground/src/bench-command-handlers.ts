import { phpEnvAssignmentFunction } from "./php-snippets.js"

export interface BenchRunCodeOptions {
  componentId: string
  pluginSlug: string
  iterations: number
  warmupIterations: number
  dependencySlugs: string[]
  env: Record<string, unknown>
  bootstrapFiles: string[]
  workloads: unknown[]
  scenarioIds?: string[]
  lifecycle: Record<string, unknown>
  resetPolicy: Record<string, unknown>
  wpCliBridge?: { url: string; token: string }
}

export function benchRunCode(options: BenchRunCodeOptions): string {
  return `require_once ABSPATH . 'wp-admin/includes/plugin.php';
${phpEnvAssignmentFunction("wp_codebox_bench_apply_env", "wp_json_encode")}

$component_id = ${JSON.stringify(options.componentId)};
$plugin_slug = ${JSON.stringify(options.pluginSlug)};
$plugin_path = WP_PLUGIN_DIR . '/' . $plugin_slug;
$iterations = max(1, (int) ${JSON.stringify(String(options.iterations))});
$warmup_iterations = max(0, (int) ${JSON.stringify(String(options.warmupIterations))});
$dependency_slugs = ${phpJsonDecodeExpression(options.dependencySlugs)};
$bench_env = ${phpJsonDecodeExpression(options.env)};
$bootstrap_files = ${phpJsonDecodeExpression(options.bootstrapFiles)};
$configured_workloads = ${phpJsonDecodeExpression(options.workloads)};
$selected_scenario_ids = ${phpJsonDecodeExpression(options.scenarioIds ?? [])};
$bench_lifecycle = ${phpJsonDecodeExpression(options.lifecycle)};
$bench_reset_policy = ${phpJsonDecodeExpression(options.resetPolicy)};
$wp_cli_bridge_url = ${JSON.stringify(options.wpCliBridge?.url ?? null)};
$wp_cli_bridge_token = ${JSON.stringify(options.wpCliBridge?.token ?? null)};

wp_codebox_bench_apply_env($bench_env);

function wp_codebox_bench_percentile(array $samples, float $percentile): float {
    if (empty($samples)) {
        return 0.0;
    }

    sort($samples, SORT_NUMERIC);
    $index = (int) ceil($percentile * count($samples)) - 1;
    $index = max(0, min(count($samples) - 1, $index));
    return (float) $samples[$index];
}

function wp_codebox_bench_metric_unit(string $name): string {
    if (str_ends_with($name, '_ms') || $name === 'duration') {
        return 'ms';
    }
    if (str_ends_with($name, '_bytes')) {
        return 'bytes';
    }
    if (str_ends_with($name, '_count')) {
        return 'count';
    }
    return 'unitless';
}

function wp_codebox_bench_metric_summary(array $samples, string $unit): array {
    sort($samples, SORT_NUMERIC);
    $count = count($samples);
    $sum = array_sum($samples);
    $mean = $count > 0 ? $sum / $count : 0.0;
    $variance_sum = 0.0;
    foreach ($samples as $sample) {
        $delta = (float) $sample - $mean;
        $variance_sum += $delta * $delta;
    }
    $standard_deviation = $count > 0 ? sqrt($variance_sum / $count) : 0.0;

    return array(
        'unit' => $unit,
        'samples' => array(
            'count' => $count,
            'mean' => $mean,
            'p50' => wp_codebox_bench_percentile($samples, 0.50),
            'p95' => wp_codebox_bench_percentile($samples, 0.95),
            'p99' => wp_codebox_bench_percentile($samples, 0.99),
            'min' => $count > 0 ? (float) $samples[0] : 0.0,
            'max' => $count > 0 ? (float) $samples[$count - 1] : 0.0,
            'standard_deviation' => $standard_deviation,
            'relative_standard_deviation' => $mean !== 0.0 ? $standard_deviation / abs($mean) : 0.0,
            'values' => array_values(array_map('floatval', $samples)),
        ),
    );
}

function wp_codebox_bench_metrics(array $timings, array $metric_samples): array {
    ksort($metric_samples);
    $metrics = array('duration' => wp_codebox_bench_metric_summary($timings, 'ms'));
    foreach ($metric_samples as $metric => $samples) {
        $metrics[$metric] = wp_codebox_bench_metric_summary($samples, wp_codebox_bench_metric_unit($metric));
    }
    return $metrics;
}

function wp_codebox_bench_record_payload($payload, array &$metric_samples, ?array &$metadata, ?array &$artifacts = null, ?array &$steps = null, ?array &$diagnostics = null): void {
    if (!is_array($payload)) {
        return;
    }

    if (isset($payload['metadata']) && is_array($payload['metadata'])) {
        $metadata = $payload['metadata'];
    }

    if (isset($payload['artifacts']) && is_array($payload['artifacts'])) {
        $artifacts = $payload['artifacts'];
    }

    if (isset($payload['steps']) && is_array($payload['steps'])) {
        $steps = $payload['steps'];
    }

    if (isset($payload['diagnostics']) && is_array($payload['diagnostics'])) {
        $diagnostics = $payload['diagnostics'];
    }

    $metrics = array();
    if (isset($payload['metrics']) && is_array($payload['metrics'])) {
        $metrics = $payload['metrics'];
    } else {
        $metrics = $payload;
        unset($metrics['metadata'], $metrics['artifacts'], $metrics['steps'], $metrics['diagnostics']);
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

function wp_codebox_bench_lifecycle_steps(array $lifecycle, string $phase): array {
    $steps = isset($lifecycle[$phase]) && is_array($lifecycle[$phase]) ? $lifecycle[$phase] : array();
    if (isset($steps['type']) || isset($steps['run']) || isset($steps['code']) || isset($steps['file'])) {
        return array($steps);
    }
    return $steps;
}

function wp_codebox_bench_run_lifecycle_phase(array $lifecycle, string $phase, string $plugin_path, array &$diagnostics): void {
    foreach (wp_codebox_bench_lifecycle_steps($lifecycle, $phase) as $index => $step) {
        if (!is_array($step)) {
            continue;
        }
        try {
            wp_codebox_bench_run_configured_workload($step, $plugin_path);
        } catch (Throwable $e) {
            $diagnostics[] = array(
                'schema' => 'wp-codebox/bench-lifecycle-diagnostic/v1',
                'severity' => 'error',
                'phase' => $phase,
                'index' => $index,
                'message' => $e->getMessage(),
            );
            throw new RuntimeException('wordpress.bench lifecycle ' . $phase . '[' . $index . '] failed: ' . $e->getMessage(), 0, $e);
        }
    }
}

function wp_codebox_bench_normalize_reset_mode($mode): string {
    return in_array($mode, array('none', 'object-cache'), true) ? $mode : 'none';
}

function wp_codebox_bench_reset(array $policy, string $scope, array &$events): void {
    $mode = wp_codebox_bench_normalize_reset_mode($policy[$scope] ?? 'none');
    if ($mode === 'none') {
        return;
    }
    if ($mode === 'object-cache') {
        if (function_exists('wp_cache_flush_runtime')) {
            wp_cache_flush_runtime();
        } elseif (function_exists('wp_cache_flush')) {
            wp_cache_flush();
        }
    }
    $events[] = array('scope' => $scope, 'mode' => $mode);
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

function wp_codebox_bench_metric_prefix(array $step, string $fallback): string {
    $prefix = isset($step['metric-prefix']) && is_string($step['metric-prefix']) ? $step['metric-prefix'] : $fallback;
    $prefix = preg_replace('/[^A-Za-z0-9_]+/', '_', trim($prefix));
    $prefix = trim((string) $prefix, '_');
    return $prefix !== '' ? $prefix : $fallback;
}

function wp_codebox_bench_response_shape($value, int $depth = 0) {
    if ($value === null) {
        return 'null';
    }
    if (is_array($value)) {
        if (array_is_list($value)) {
            return array(
                'type' => 'array',
                'length' => count($value),
                'items' => count($value) > 0 && $depth < 3 ? wp_codebox_bench_response_shape($value[0], $depth + 1) : null,
            );
        }
        if ($depth >= 3) {
            $keys = array_keys($value);
            sort($keys, SORT_STRING);
            return array('type' => 'object', 'keys' => $keys);
        }
        $keys = array_keys($value);
        sort($keys, SORT_STRING);
        $shape = array();
        foreach (array_slice($keys, 0, 50) as $key) {
            $shape[$key] = wp_codebox_bench_response_shape($value[$key], $depth + 1);
        }
        return array('type' => 'object', 'keys' => $shape);
    }
    if (is_bool($value)) {
        return 'boolean';
    }
    if (is_int($value) || is_float($value)) {
        return 'number';
    }
    return is_string($value) ? 'string' : gettype($value);
}

function wp_codebox_bench_redacted_response_summary($response): array {
    $serialized = wp_json_encode($response, JSON_UNESCAPED_SLASHES);
    return array(
        'redacted' => true,
        'bytes' => is_string($serialized) ? strlen($serialized) : 0,
        'shape' => wp_codebox_bench_response_shape($response),
    );
}

function wp_codebox_bench_command_step_record(array $step, string $type, float $duration_ms): array {
    $record = array(
        'schema' => 'wp-codebox/bench-command-step/v1',
        'type' => $type,
        'timing' => array('duration_ms' => $duration_ms),
    );
    foreach (array('name', 'ability', 'command', 'method', 'path', 'route') as $field) {
        if (isset($step[$field]) && is_scalar($step[$field])) {
            $record[$field] = (string) $step[$field];
        }
    }
    return $record;
}

function wp_codebox_bench_run_command_step(array $step, string $type, callable $runner): array {
    $started = hrtime(true);
    $result = $runner($step);
    $duration_ms = (hrtime(true) - $started) / 1000000;
    return array(
        'result' => $result,
        'duration_ms' => $duration_ms,
        'record' => wp_codebox_bench_command_step_record($step, $type, $duration_ms),
    );
}

function wp_codebox_bench_command_step_payload(array $execution, string $prefix, array $metrics = array(), array $record = array()): array {
    $duration_ms = isset($execution['duration_ms']) && is_numeric($execution['duration_ms']) ? (float) $execution['duration_ms'] : 0.0;
    $payload = array(
        'metrics' => array_merge(array($prefix . '_duration_ms' => $duration_ms), $metrics),
        'steps' => array(array_merge(is_array($execution['record'] ?? null) ? $execution['record'] : array(), $record)),
        'diagnostics' => array(),
    );

    $result = $execution['result'] ?? null;
    if (is_array($result)) {
        foreach (array('metrics', 'metadata', 'artifacts', 'diagnostics') as $field) {
            if (isset($result[$field]) && is_array($result[$field])) {
                $payload[$field] = array_merge(isset($payload[$field]) && is_array($payload[$field]) ? $payload[$field] : array(), $result[$field]);
            }
        }
        if (isset($result['steps']) && is_array($result['steps'])) {
            $payload['steps'] = array_merge($payload['steps'], $result['steps']);
        }
    }

    return $payload;
}

function wp_codebox_bench_run_rest_request_step(array $step): array {
    if (!class_exists('WP_REST_Request') || !function_exists('rest_do_request')) {
        throw new RuntimeException('The WordPress REST API is not available in this runtime.');
    }

    $path = '';
    if (isset($step['path']) && is_string($step['path'])) {
        $path = trim($step['path']);
    } elseif (isset($step['route']) && is_string($step['route'])) {
        $path = trim($step['route']);
    }
    if ($path === '') {
        throw new RuntimeException('rest-request bench workload steps require path or route.');
    }

    $method = isset($step['method']) && is_string($step['method']) ? strtoupper(trim($step['method'])) : 'GET';
    $route = '/' . ltrim(preg_replace('#^/wp-json#', '', $path), '/');
    $headers = isset($step['headers']) && is_array($step['headers']) ? $step['headers'] : array();
    $params = isset($step['params']) && is_array($step['params']) ? $step['params'] : array();
    $body = '';
    if (array_key_exists('body-json', $step)) {
        $body = is_string($step['body-json']) ? $step['body-json'] : wp_json_encode($step['body-json']);
    } elseif (array_key_exists('body', $step)) {
        $body = is_scalar($step['body']) ? (string) $step['body'] : wp_json_encode($step['body']);
    }

    $request = new WP_REST_Request($method, $route);
    foreach ($headers as $name => $value) {
        if (is_string($name)) {
            $request->set_header($name, $value);
        }
    }
    foreach ($params as $name => $value) {
        if (is_string($name)) {
            $request->set_param($name, $value);
        }
    }
    if ($body !== '') {
        $request->set_body($body);
    }

    $execution = wp_codebox_bench_run_command_step($step, 'rest-request', static fn(array $_step) => rest_do_request($request));
    $response = $execution['result'];
    if (is_wp_error($response)) {
        throw new RuntimeException('REST bench workload step failed: ' . $response->get_error_message());
    }

    $status = method_exists($response, 'get_status') ? (int) $response->get_status() : 0;
    $prefix = wp_codebox_bench_metric_prefix($step, 'rest');
    $record = array('method' => $method, 'path' => $path, 'route' => $route, 'status' => $status);
    if (isset($step['id']) && is_scalar($step['id'])) {
        $record['route_id'] = (string) $step['id'];
    }
    if (isset($step['metadata']) && is_array($step['metadata']) && isset($step['metadata']['route_matrix_index']) && is_numeric($step['metadata']['route_matrix_index'])) {
        $record['route_matrix_index'] = (int) $step['metadata']['route_matrix_index'];
    }
    if (isset($step['metadata']) && is_array($step['metadata']) && isset($step['metadata']['rest_request_case_index']) && is_numeric($step['metadata']['rest_request_case_index'])) {
        $record['rest_request_case_index'] = (int) $step['metadata']['rest_request_case_index'];
    }
    if (isset($step['case_id']) && is_scalar($step['case_id'])) {
        $record['case_id'] = (string) $step['case_id'];
    } elseif (isset($step['caseId']) && is_scalar($step['caseId'])) {
        $record['case_id'] = (string) $step['caseId'];
    }
    if (!empty($step['capture-response'])) {
        $record['response'] = wp_codebox_bench_redacted_response_summary(rest_get_server()->response_to_data($response, false));
    }

    return wp_codebox_bench_command_step_payload($execution, $prefix, array($prefix . '_status' => $status), $record);
}

function wp_codebox_bench_run_ability_step(array $step): array {
    if (!function_exists('wp_get_ability')) {
        throw new RuntimeException('The WordPress Abilities API is not available in this runtime.');
    }
    $ability_name = isset($step['name']) ? (string) $step['name'] : (isset($step['ability']) ? (string) $step['ability'] : '');
    $ability = wp_get_ability($ability_name);
    if (!$ability) {
        throw new RuntimeException('Ability is not registered: ' . $ability_name);
    }

    $execution = wp_codebox_bench_run_command_step($step, 'ability', static fn(array $_step) => $ability->execute(isset($step['input']) && is_array($step['input']) ? $step['input'] : array()));
    if (is_wp_error($execution['result'] ?? null)) {
        throw new RuntimeException($execution['result']->get_error_message());
    }

    return wp_codebox_bench_command_step_payload($execution, wp_codebox_bench_metric_prefix($step, 'ability'), array(), array('name' => $ability_name));
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

    $manifest_file = wp_codebox_bench_manifest_plugin_file_for_slug($plugin_slug, $role);
    if ($manifest_file !== null) {
        return $manifest_file;
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

function wp_codebox_bench_manifest_plugin_file_for_slug(string $plugin_slug, string $role): ?string {
    $manifest = $GLOBALS['wp_codebox_component_manifest'] ?? null;
    if (!is_array($manifest)) {
        $json = defined('WP_CODEBOX_COMPONENT_MANIFEST_JSON') ? WP_CODEBOX_COMPONENT_MANIFEST_JSON : '';
        $decoded = is_string($json) && $json !== '' ? json_decode($json, true) : null;
        $manifest = is_array($decoded) ? $decoded : null;
    }
    if (!is_array($manifest)) {
        return null;
    }

    foreach (array('components', 'providers') as $section) {
        foreach (is_array($manifest[$section] ?? null) ? $manifest[$section] : array() as $entry) {
            if (!is_array($entry) || (string) ($entry['slug'] ?? '') !== $plugin_slug) {
                continue;
            }

            $entrypoint = trim(str_replace('\\\\', '/', (string) ($entry['entrypoint'] ?? $entry['pluginFile'] ?? '')));
            if ($entrypoint === '' || str_starts_with($entrypoint, '/') || str_contains($entrypoint, '..') || !str_ends_with($entrypoint, '.php')) {
                throw new RuntimeException('wordpress.bench manifest contains unsafe ' . $role . ' entrypoint for slug "' . $plugin_slug . '". ' . wp_codebox_bench_plugin_slug_diagnostic($plugin_slug, $role, 'unsafe manifest entrypoint'));
            }
            if (!str_starts_with($entrypoint, $plugin_slug . '/')) {
                throw new RuntimeException('wordpress.bench manifest entrypoint for ' . $role . ' slug "' . $plugin_slug . '" must be relative to the mounted plugin slug. ' . wp_codebox_bench_plugin_slug_diagnostic($plugin_slug, $role, 'manifest entrypoint slug mismatch'));
            }

            $absolute = WP_PLUGIN_DIR . '/' . $entrypoint;
            if (!is_file($absolute) || !is_readable($absolute)) {
                throw new RuntimeException('wordpress.bench manifest entrypoint for ' . $role . ' slug "' . $plugin_slug . '" is not readable. ' . wp_codebox_bench_plugin_slug_diagnostic($plugin_slug, $role, 'manifest entrypoint missing', array($absolute)));
            }

            return $entrypoint;
        }
    }

    return null;
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
$plugin_file = wp_codebox_bench_plugin_file_for_slug($plugin_slug, 'component');
$plugins_to_activate[] = $plugin_file;
$plugin_roles[$plugin_file] = 'component';
foreach (is_array($dependency_slugs) ? $dependency_slugs : array() as $dependency_slug) {
    $dependency_file = wp_codebox_bench_plugin_file_for_slug((string) $dependency_slug, 'dependency');
    $plugins_to_activate[] = $dependency_file;
    $plugin_roles[$dependency_file] = 'dependency';
}
$plugins_to_activate = array_values(array_unique($plugins_to_activate));
foreach ($plugins_to_activate as $plugin_to_activate) {
    wp_codebox_bench_assert_plugin_autoload_ready($plugin_to_activate);
}

$pre_plugins_loaded_callbacks = wp_codebox_bench_snapshot_wordpress_hook_callbacks('plugins_loaded');
$pre_init_callbacks = wp_codebox_bench_snapshot_wordpress_hook_callbacks('init');

foreach (array($plugin_file) as $plugin_to_activate) {
    if (is_plugin_active($plugin_to_activate)) {
        continue;
    }
    $activation = activate_plugin($plugin_to_activate);
    if (is_wp_error($activation)) {
        throw new RuntimeException('wordpress.bench failed to activate plugin "' . $plugin_to_activate . '". ' . wp_codebox_bench_plugin_load_diagnostic($plugin_to_activate, $plugin_roles[$plugin_to_activate] ?? 'plugin', $activation->get_error_message()));
    }
    $activated_plugins[] = $plugin_to_activate;
}
wp_codebox_bench_include_plugin_file($plugin_file, $plugin_roles[$plugin_file] ?? 'component');

foreach ($plugins_to_activate as $plugin_to_activate) {
    if ($plugin_to_activate === $plugin_file) {
        continue;
    }
    if (!is_plugin_active($plugin_to_activate)) {
        $activation = activate_plugin($plugin_to_activate);
        if (is_wp_error($activation)) {
            throw new RuntimeException('wordpress.bench failed to activate plugin "' . $plugin_to_activate . '". ' . wp_codebox_bench_plugin_load_diagnostic($plugin_to_activate, $plugin_roles[$plugin_to_activate] ?? 'plugin', $activation->get_error_message()));
        }
        $activated_plugins[] = $plugin_to_activate;
    }
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

function wp_codebox_bench_workload_run_steps(array $workload): array {
    $steps = isset($workload['run']) && is_array($workload['run']) ? $workload['run'] : array();
    $route_matrix = isset($workload['route_matrix']) && is_array($workload['route_matrix']) ? $workload['route_matrix'] : array();
    $rest_request_cases = isset($workload['rest_request_cases']) && is_array($workload['rest_request_cases']) ? $workload['rest_request_cases'] : array();
    if (empty($rest_request_cases) && isset($workload['request_cases']) && is_array($workload['request_cases'])) {
        $rest_request_cases = $workload['request_cases'];
    }

    foreach ($route_matrix as $index => $route) {
        if (!is_array($route)) {
            continue;
        }
        $step = array_merge($route, array('type' => 'rest-request'));
        if (!isset($step['metric-prefix']) && isset($route['id']) && is_string($route['id'])) {
            $step['metric-prefix'] = 'rest_' . $route['id'];
        }
        if (!isset($step['metadata']) || !is_array($step['metadata'])) {
            $step['metadata'] = array();
        }
        $step['metadata'] = array_merge(array('route_matrix_index' => $index), $step['metadata']);
        $steps[] = $step;
    }

    foreach ($rest_request_cases as $index => $request_case) {
        if (!is_array($request_case)) {
            continue;
        }
        $step = array_merge($request_case, array('type' => 'rest-request'));
        if (!isset($step['path']) && isset($request_case['route'])) {
            $step['path'] = $request_case['route'];
        }
        if (!isset($step['metric-prefix'])) {
            $case_id = isset($request_case['id']) && is_string($request_case['id']) ? $request_case['id'] : (isset($request_case['case_id']) && is_string($request_case['case_id']) ? $request_case['case_id'] : 'case_' . $index);
            $step['metric-prefix'] = 'rest_' . preg_replace('/[^A-Za-z0-9_]+/', '_', $case_id);
        }
        if (!isset($step['metadata']) || !is_array($step['metadata'])) {
            $step['metadata'] = array();
        }
        $step['metadata'] = array_merge(array('rest_request_case_index' => $index), $step['metadata']);
        if (!isset($step['case_id']) && isset($request_case['id']) && is_scalar($request_case['id'])) {
            $step['case_id'] = (string) $request_case['id'];
        }
        $steps[] = $step;
    }

    return !empty($steps) ? $steps : array($workload);
}

function wp_codebox_bench_run_configured_workload(array $workload, string $plugin_path) {
    $steps = wp_codebox_bench_workload_run_steps($workload);
    $payload = array('metrics' => array(), 'metadata' => array(), 'artifacts' => array(), 'steps' => array(), 'diagnostics' => array());
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
            $result = wp_codebox_bench_run_ability_step($step);
        } elseif ($type === 'wp-cli') {
            $result = wp_codebox_bench_run_wp_cli_step($step);
        } elseif ($type === 'rest-request' || $type === 'rest') {
            $result = wp_codebox_bench_run_rest_request_step($step);
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
            if (isset($result['steps']) && is_array($result['steps'])) {
                $payload['steps'] = array_merge($payload['steps'], $result['steps']);
            }
            if (isset($result['diagnostics']) && is_array($result['diagnostics'])) {
                $payload['diagnostics'] = array_merge($payload['diagnostics'], $result['diagnostics']);
            }
        }
    }
    return $payload;
}

function wp_codebox_bench_selected_scenario_ids(array $ids): array {
    $selected = array();
    foreach ($ids as $id) {
        if (!is_string($id)) {
            continue;
        }
        $id = trim($id);
        if ($id !== '') {
            $selected[$id] = true;
        }
    }
    return $selected;
}

function wp_codebox_bench_scenario_selected(string $scenario_id, array $selected_ids): bool {
    return empty($selected_ids) || isset($selected_ids[$scenario_id]);
}

function wp_codebox_bench_configured_scenario_id(array $workload, int $index): string {
    return isset($workload['id']) && is_string($workload['id']) ? $workload['id'] : 'configured-' . $index;
}

function wp_codebox_bench_configured_scenario_source(array $workload): string {
    return isset($workload['source']) && is_string($workload['source']) && trim($workload['source']) !== '' ? trim($workload['source']) : 'config';
}

function wp_codebox_bench_configured_overrides_discovered(array $workload): bool {
    return isset($workload['overridesDiscovered']) && $workload['overridesDiscovered'] === true;
}

$bench_dir = $plugin_path . '/tests/bench';
$workload_files = is_dir($bench_dir) ? glob($bench_dir . '/*.php') : array();
sort($workload_files, SORT_STRING);

$selected_scenario_ids = is_array($selected_scenario_ids) ? wp_codebox_bench_selected_scenario_ids($selected_scenario_ids) : array();
$configured_workloads = is_array($configured_workloads) ? $configured_workloads : array();
$configured_override_scenario_ids = array();
foreach ($configured_workloads as $index => $workload) {
    if (!is_array($workload)) {
        continue;
    }
    if (wp_codebox_bench_configured_overrides_discovered($workload)) {
        $configured_override_scenario_ids[wp_codebox_bench_configured_scenario_id($workload, $index)] = true;
    }
}
if (!empty($selected_scenario_ids)) {
    $available_scenario_ids = array();
    foreach ($workload_files as $workload_file) {
        $available_scenario_ids[preg_replace('/\\.php$/', '', basename($workload_file))] = true;
    }
    foreach ($configured_workloads as $index => $workload) {
        if (!is_array($workload)) {
            continue;
        }
        $available_scenario_ids[wp_codebox_bench_configured_scenario_id($workload, $index)] = true;
    }
    if (empty(array_intersect_key($selected_scenario_ids, $available_scenario_ids))) {
        throw new RuntimeException('wordpress.bench selected scenario ids did not match any known scenarios. diagnostic=' . wp_json_encode(array(
            'schema' => 'wp-codebox/bench-scenario-selection-diagnostic/v1',
            'selected_scenario_ids' => array_keys($selected_scenario_ids),
            'available_scenario_ids' => array_keys($available_scenario_ids),
        ), JSON_UNESCAPED_SLASHES));
    }
}

$bench_lifecycle = is_array($bench_lifecycle) ? $bench_lifecycle : array();
$bench_reset_policy = is_array($bench_reset_policy) ? $bench_reset_policy : array();
$lifecycle_diagnostics = array();
$reset_events = array();

wp_codebox_bench_run_lifecycle_phase($bench_lifecycle, 'setup', $plugin_path, $lifecycle_diagnostics);

$scenarios = array();
foreach ($workload_files as $workload_file) {
    $scenario_id = preg_replace('/\\.php$/', '', basename($workload_file));
    if (!wp_codebox_bench_scenario_selected($scenario_id, $selected_scenario_ids)) {
        continue;
    }
    if (isset($configured_override_scenario_ids[$scenario_id])) {
        continue;
    }

    $callable = require $workload_file;
    if (!is_callable($callable)) {
        continue;
    }

    $timings = array();
    $metric_samples = array();
    $metadata = null;
    $artifacts = null;
    $steps = null;
    $diagnostics = null;

    if (function_exists('memory_reset_peak_usage')) {
        memory_reset_peak_usage();
    }

    wp_codebox_bench_reset($bench_reset_policy, 'betweenScenarios', $reset_events);
    wp_codebox_bench_run_lifecycle_phase($bench_lifecycle, 'prepare', $plugin_path, $lifecycle_diagnostics);

    $total_iterations = $iterations + $warmup_iterations;
    for ($i = 0; $i < $total_iterations; $i++) {
        $is_warmup = $i < $warmup_iterations;
        wp_codebox_bench_reset($bench_reset_policy, 'betweenIterations', $reset_events);
        wp_codebox_bench_run_lifecycle_phase($bench_lifecycle, $is_warmup ? 'warmup' : 'measure', $plugin_path, $lifecycle_diagnostics);
        $started = hrtime(true);
        $payload = $callable();
        $elapsed_ms = (hrtime(true) - $started) / 1000000;

        if (!$is_warmup) {
            $timings[] = $elapsed_ms;
            wp_codebox_bench_record_payload($payload, $metric_samples, $metadata, $artifacts, $steps, $diagnostics);
        }
    }

    $relative_file = substr($workload_file, strlen($plugin_path) + 1);
    $scenario = array(
        'id' => $scenario_id,
        'source' => 'in_tree',
        'file' => $relative_file,
        'iterations' => $iterations,
        'metrics' => wp_codebox_bench_metrics($timings, $metric_samples),
        'memory' => array('peak_bytes' => memory_get_peak_usage(true)),
        'diagnostics' => array(),
        'provenance' => array('workload_file' => $relative_file),
    );

    if (is_array($metadata) && !empty($metadata)) {
        $scenario['metadata'] = $metadata;
    }
    if (is_array($artifacts) && !empty($artifacts)) {
        $scenario['artifacts'] = $artifacts;
    }
    if (is_array($steps) && !empty($steps)) {
        $scenario['steps'] = $steps;
    }
    if (is_array($diagnostics) && !empty($diagnostics)) {
        $scenario['diagnostics'] = $diagnostics;
    }

    wp_codebox_bench_run_lifecycle_phase($bench_lifecycle, 'teardown', $plugin_path, $lifecycle_diagnostics);

    $scenarios[] = $scenario;
}

foreach ($configured_workloads as $index => $workload) {
    if (!is_array($workload)) {
        continue;
    }
    $scenario_id = wp_codebox_bench_configured_scenario_id($workload, $index);
    if (!wp_codebox_bench_scenario_selected($scenario_id, $selected_scenario_ids)) {
        continue;
    }

    $timings = array();
    $metric_samples = array();
    $metadata = null;
    $artifacts = null;
    $steps = null;
    $diagnostics = null;

    wp_codebox_bench_reset($bench_reset_policy, 'betweenScenarios', $reset_events);
    wp_codebox_bench_run_lifecycle_phase($bench_lifecycle, 'prepare', $plugin_path, $lifecycle_diagnostics);
    $total_iterations = $iterations + $warmup_iterations;
    for ($i = 0; $i < $total_iterations; $i++) {
        $is_warmup = $i < $warmup_iterations;
        wp_codebox_bench_reset($bench_reset_policy, 'betweenIterations', $reset_events);
        wp_codebox_bench_run_lifecycle_phase($bench_lifecycle, $is_warmup ? 'warmup' : 'measure', $plugin_path, $lifecycle_diagnostics);
        $started = hrtime(true);
        $payload = wp_codebox_bench_run_configured_workload($workload, $plugin_path);
        $elapsed_ms = (hrtime(true) - $started) / 1000000;
        if (!$is_warmup) {
            $timings[] = $elapsed_ms;
            wp_codebox_bench_record_payload($payload, $metric_samples, $metadata, $artifacts, $steps, $diagnostics);
        }
    }
    $scenario = array(
        'id' => $scenario_id,
        'source' => wp_codebox_bench_configured_scenario_source($workload),
        'iterations' => $iterations,
        'metrics' => wp_codebox_bench_metrics($timings, $metric_samples),
        'memory' => array('peak_bytes' => memory_get_peak_usage(true)),
        'diagnostics' => array(),
        'provenance' => array('workload_index' => $index),
    );
    if (is_array($metadata) && !empty($metadata)) {
        $scenario['metadata'] = $metadata;
    }
    if (is_array($artifacts) && !empty($artifacts)) {
        $scenario['artifacts'] = $artifacts;
    }
    if (is_array($steps) && !empty($steps)) {
        $scenario['steps'] = $steps;
    }
    if (is_array($diagnostics) && !empty($diagnostics)) {
        $scenario['diagnostics'] = $diagnostics;
    }
    wp_codebox_bench_run_lifecycle_phase($bench_lifecycle, 'teardown', $plugin_path, $lifecycle_diagnostics);
    $scenarios[] = $scenario;
}

if (!empty($selected_scenario_ids) && empty($scenarios)) {
    throw new RuntimeException('wordpress.bench selected scenario ids did not match any runnable scenarios. diagnostic=' . wp_json_encode(array(
        'schema' => 'wp-codebox/bench-scenario-selection-diagnostic/v1',
        'selected_scenario_ids' => array_keys($selected_scenario_ids),
    ), JSON_UNESCAPED_SLASHES));
}

echo wp_json_encode(array(
    'schema' => 'wp-codebox/bench-results/v1',
    'component_id' => $component_id,
    'iterations' => $iterations,
    'warmup_iterations' => $warmup_iterations,
    'lifecycle' => array(
        'phases' => array_values(array_filter(array('setup', 'prepare', 'warmup', 'measure', 'teardown'), static function (string $phase) use ($bench_lifecycle): bool {
            return count(wp_codebox_bench_lifecycle_steps($bench_lifecycle, $phase)) > 0;
        })),
        'diagnostics' => $lifecycle_diagnostics,
    ),
    'reset_policy' => array(
        'betweenIterations' => wp_codebox_bench_normalize_reset_mode($bench_reset_policy['betweenIterations'] ?? 'none'),
        'betweenScenarios' => wp_codebox_bench_normalize_reset_mode($bench_reset_policy['betweenScenarios'] ?? 'none'),
        'events' => $reset_events,
    ),
    'scenarios' => $scenarios,
    'diagnostics' => empty($scenarios) ? array(array(
        'severity' => 'warning',
        'code' => 'no-benchmark-scenarios',
        'message' => 'wordpress.bench completed without runnable scenarios.',
    )) : array(),
    'provenance' => array(
        'command' => 'wordpress.bench',
        'generated_at' => gmdate('c'),
        'component' => array(
            'id' => $component_id,
            'plugin_slug' => $plugin_slug,
            'dependency_slugs' => array_values($dependency_slugs),
            'bootstrap_files' => array_values($bootstrap_files),
        ),
        'runtime' => array(
            'wordpress_version' => get_bloginfo('version'),
            'php_version' => PHP_VERSION,
        ),
        'definition' => array(
            'schema' => 'wp-codebox/benchmark-definition/v1',
            'component_id' => $component_id,
            'plugin_slug' => $plugin_slug,
            'iterations' => $iterations,
            'warmup_iterations' => $warmup_iterations,
            'dependency_slugs' => array_values($dependency_slugs),
            'env' => $bench_env,
            'bootstrap_files' => array_values($bootstrap_files),
            'workloads' => is_array($configured_workloads) ? $configured_workloads : array(),
        ),
    ),
), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);`
}

function phpJsonDecodeExpression(value: unknown): string {
  const encoded = Buffer.from(JSON.stringify(value), "utf8").toString("base64")
  return `json_decode(base64_decode(${JSON.stringify(encoded)}), true)`
}
