export interface BenchRunCodeOptions {
  componentId: string
  pluginSlug: string
  iterations: number
  warmupIterations: number
  dependencySlugs: string[]
  env: Record<string, unknown>
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

$plugins_to_activate = array();
foreach (is_array($dependency_slugs) ? $dependency_slugs : array() as $dependency_slug) {
    $dependency_slug = sanitize_key((string) $dependency_slug);
    $dependency_file = WP_PLUGIN_DIR . '/' . $dependency_slug . '/' . $dependency_slug . '.php';
    if (file_exists($dependency_file)) {
        $plugins_to_activate[] = $dependency_slug . '/' . $dependency_slug . '.php';
    }
}
$plugin_file = $plugin_path . '/' . $plugin_slug . '.php';
if (file_exists($plugin_file)) {
    $plugins_to_activate[] = $plugin_slug . '/' . $plugin_slug . '.php';
}
foreach ($plugins_to_activate as $plugin_to_activate) {
    if (is_plugin_active($plugin_to_activate)) {
        continue;
    }
    $activation = activate_plugin($plugin_to_activate);
    if (is_wp_error($activation)) {
        throw new RuntimeException($activation->get_error_message());
    }
}
if (!empty($plugins_to_activate)) {
    do_action('plugins_loaded');
    do_action('init');
}
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
