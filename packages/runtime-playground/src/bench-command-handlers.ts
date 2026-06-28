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

if (!getenv('WP_CODEBOX_BENCH_SHARED_STATE')) {
    $wp_codebox_bench_shared_state = rtrim(sys_get_temp_dir(), DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR . 'wp-codebox-bench-shared-state-' . getmypid();
    if (!is_dir($wp_codebox_bench_shared_state) && !mkdir($wp_codebox_bench_shared_state, 0777, true) && !is_dir($wp_codebox_bench_shared_state)) {
        throw new RuntimeException('wordpress.bench could not create shared state directory.');
    }
    putenv('WP_CODEBOX_BENCH_SHARED_STATE=' . $wp_codebox_bench_shared_state);
    $_ENV['WP_CODEBOX_BENCH_SHARED_STATE'] = $wp_codebox_bench_shared_state;
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

function wp_codebox_bench_host_node_bridge_failure_detail(array $result): string {
    $parts = array();
    foreach (array('error', 'stdout', 'stderr') as $field) {
        $value = isset($result[$field]) ? trim((string) $result[$field]) : '';
        if ($value !== '') {
            $parts[] = $field . ': ' . $value;
        }
    }
    return implode(' ', $parts);
}

function wp_codebox_bench_run_host_node_command(array $args, array $env, string $cwd): array {
    global $wp_cli_bridge_url, $wp_cli_bridge_token;
    if (!is_string($wp_cli_bridge_url) || $wp_cli_bridge_url === '' || !is_string($wp_cli_bridge_token) || $wp_cli_bridge_token === '') {
        throw new RuntimeException('artifact-postprocess workload steps require the host command bridge.');
    }

    $response = wp_remote_post($wp_cli_bridge_url . '/execute', array(
        'headers' => array(
            'authorization' => 'Bearer ' . $wp_cli_bridge_token,
            'content-type' => 'application/json',
        ),
        'body' => wp_json_encode(array('type' => 'host_node', 'args' => array_values($args), 'env' => $env, 'cwd' => $cwd), JSON_UNESCAPED_SLASHES),
        'timeout' => 300,
    ));
    if (is_wp_error($response)) {
        throw new RuntimeException('artifact-postprocess host command bridge request failed: ' . $response->get_error_message());
    }
    $body = wp_remote_retrieve_body($response);
    $result = json_decode($body, true);
    if (!is_array($result)) {
        throw new RuntimeException('artifact-postprocess host command bridge returned invalid JSON.');
    }
    $bridge_detail = wp_codebox_bench_host_node_bridge_failure_detail($result);
    $bridge_error = isset($result['error']) && is_string($result['error']) ? trim($result['error']) : '';
    if (!isset($result['exitCode']) && $bridge_detail !== '') {
        throw new RuntimeException('artifact-postprocess host command bridge failed: ' . $bridge_detail);
    }
    return array(
        'stdout' => isset($result['stdout']) ? (string) $result['stdout'] : '',
        'stderr' => isset($result['stderr']) ? (string) $result['stderr'] : '',
        'exit_code' => isset($result['exitCode']) && is_numeric($result['exitCode']) ? (int) $result['exitCode'] : 1,
        'error' => $bridge_error,
        'detail' => $bridge_detail,
    );
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

function wp_codebox_bench_safe_relative_path($value, string $label): string {
    if (!is_string($value) || trim($value) === '') {
        throw new RuntimeException($label . ' is required.');
    }
    $path = str_replace(chr(92), '/', trim($value));
    if (str_starts_with($path, '/') || preg_match('#^[A-Za-z]:/#', $path)) {
        throw new RuntimeException($label . ' must be a relative path.');
    }
    $parts = array();
    foreach (explode('/', $path) as $part) {
        if ($part === '' || $part === '.') {
            continue;
        }
        if ($part === '..') {
            throw new RuntimeException($label . ' must not contain parent traversal.');
        }
        $parts[] = $part;
    }
    if (empty($parts)) {
        throw new RuntimeException($label . ' must not resolve to the root directory.');
    }
    return implode('/', $parts);
}

function wp_codebox_bench_resolve_contained_path(string $root, string $relative_path, string $label): string {
    $root = rtrim(str_replace(chr(92), '/', $root), '/');
    $resolved = $root . '/' . wp_codebox_bench_safe_relative_path($relative_path, $label);
    $parent = dirname($resolved);
    $real_root = realpath($root);
    $real_parent = realpath($parent);
    if (!is_string($real_root) || !is_string($real_parent) || ($real_parent !== $real_root && !str_starts_with($real_parent, $real_root . DIRECTORY_SEPARATOR))) {
        throw new RuntimeException($label . ' must resolve inside its approved root.');
    }
    return $resolved;
}

function wp_codebox_bench_artifact_postprocess_helper_path(array $step, string $plugin_path): string {
    $helper = $step['helperPath'] ?? ($step['helper'] ?? ($step['scriptPath'] ?? ($step['script'] ?? null)));
    $helper_path = wp_codebox_bench_resolve_contained_path($plugin_path, wp_codebox_bench_safe_relative_path($helper, 'artifact-postprocess helper path'), 'artifact-postprocess helper path');
    if (!str_ends_with($helper_path, '.mjs')) {
        throw new RuntimeException('artifact-postprocess helper path must reference a .mjs file.');
    }
    if (!is_file($helper_path)) {
        throw new RuntimeException('artifact-postprocess helper file does not exist: ' . basename($helper_path));
    }
    return $helper_path;
}

function wp_codebox_bench_artifact_postprocess_scan_input(string $root, int $max_input_bytes, int $max_artifacts): array {
    $real_root = realpath($root);
    if (!is_string($real_root) || !is_dir($real_root)) {
        throw new RuntimeException('artifact-postprocess input artifact root must exist.');
    }
    $bytes = 0;
    $artifacts = 0;
    $iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($real_root, FilesystemIterator::SKIP_DOTS));
    foreach ($iterator as $file) {
        if (!$file->isFile() || $file->isLink()) {
            continue;
        }
        ++$artifacts;
        $bytes += (int) $file->getSize();
        if ($artifacts > $max_artifacts) {
            throw new RuntimeException('artifact-postprocess input artifact count exceeds maxArtifacts.');
        }
        if ($bytes > $max_input_bytes) {
            throw new RuntimeException('artifact-postprocess input bytes exceed maxInputBytes.');
        }
    }
    return array('artifact_count' => $artifacts, 'bytes' => $bytes);
}

function wp_codebox_bench_artifact_postprocess_expand_value($value, array $placeholders) {
    if (is_string($value)) {
        return strtr($value, $placeholders);
    }
    if (is_array($value)) {
        $expanded = array();
        foreach ($value as $key => $item) {
            $expanded[$key] = wp_codebox_bench_artifact_postprocess_expand_value($item, $placeholders);
        }
        return $expanded;
    }
    return $value;
}

function wp_codebox_bench_artifact_postprocess_content_type(string $path): string {
    $extension = strtolower(pathinfo($path, PATHINFO_EXTENSION));
    if ($extension === 'json') {
        return 'application/json';
    }
    if ($extension === 'jsonl') {
        return 'application/x-ndjson';
    }
    if ($extension === 'md') {
        return 'text/markdown';
    }
    if ($extension === 'html') {
        return 'text/html';
    }
    return 'application/octet-stream';
}

function wp_codebox_bench_run_artifact_postprocess_step(array $step, string $plugin_path): array {
    $command = isset($step['command']) && is_string($step['command']) ? trim($step['command']) : 'node';
    if ($command !== 'node') {
        throw new RuntimeException('artifact-postprocess workload steps only support the node command.');
    }
    $helper_path = wp_codebox_bench_artifact_postprocess_helper_path($step, $plugin_path);
    $input_root_value = $step['inputArtifactRoot'] ?? ($step['input-artifact-root'] ?? ($step['artifactRoot'] ?? ($step['artifact-root'] ?? '')));
    if (!is_string($input_root_value) || trim($input_root_value) === '') {
        throw new RuntimeException('artifact-postprocess inputArtifactRoot is required.');
    }
    $input_root = realpath($input_root_value);
    if (!is_string($input_root) || !is_dir($input_root)) {
        throw new RuntimeException('artifact-postprocess input artifact root must exist.');
    }
    $output_relative = wp_codebox_bench_safe_relative_path($step['outputArtifactPath'] ?? ($step['output-artifact-path'] ?? ''), 'artifact-postprocess outputArtifactPath');
    $output_path = rtrim($input_root, '/') . '/' . $output_relative;
    $max_input_bytes = isset($step['maxInputBytes']) && is_numeric($step['maxInputBytes']) ? max(0, (int) $step['maxInputBytes']) : (isset($step['max-input-bytes']) && is_numeric($step['max-input-bytes']) ? max(0, (int) $step['max-input-bytes']) : 10485760);
    $max_artifacts = isset($step['maxArtifacts']) && is_numeric($step['maxArtifacts']) ? max(0, (int) $step['maxArtifacts']) : (isset($step['max-artifacts']) && is_numeric($step['max-artifacts']) ? max(0, (int) $step['max-artifacts']) : 1000);
    $input_summary = wp_codebox_bench_artifact_postprocess_scan_input($input_root, $max_input_bytes, $max_artifacts);
    if (!is_dir(dirname($output_path)) && !mkdir(dirname($output_path), 0777, true) && !is_dir(dirname($output_path))) {
        throw new RuntimeException('artifact-postprocess could not create output artifact directory.');
    }
    $placeholders = array(
        '\${helperPath}' => $helper_path,
        '\${inputArtifactRoot}' => $input_root,
        '\${outputArtifactPath}' => $output_path,
        '\${outputArtifactRelativePath}' => $output_relative,
        '\${expectedOutputSchema}' => isset($step['expectedOutputSchema']) && is_string($step['expectedOutputSchema']) ? $step['expectedOutputSchema'] : (isset($step['expected-output-schema']) && is_string($step['expected-output-schema']) ? $step['expected-output-schema'] : ''),
    );
    $args = isset($step['args']) && is_array($step['args']) ? array_values($step['args']) : array('\${helperPath}', '\${inputArtifactRoot}', '\${outputArtifactPath}');
    $expanded_args = array_map(static fn($arg) => is_scalar($arg) ? (string) wp_codebox_bench_artifact_postprocess_expand_value((string) $arg, $placeholders) : '', $args);
    if (!in_array($helper_path, $expanded_args, true)) {
        array_unshift($expanded_args, $helper_path);
    }
    $env = getenv();
    $env = is_array($env) ? $env : array();
    $env['WP_CODEBOX_ARTIFACT_INPUT_ROOT'] = $input_root;
    $env['WP_CODEBOX_ARTIFACT_OUTPUT_PATH'] = $output_path;
    $env['WP_CODEBOX_ARTIFACT_OUTPUT_RELATIVE_PATH'] = $output_relative;
    foreach (is_array($step['env'] ?? null) ? $step['env'] : array() as $name => $value) {
        if (is_string($name) && preg_match('/^[A-Z_][A-Z0-9_]*$/', $name)) {
            $env[$name] = is_scalar($value) ? (string) wp_codebox_bench_artifact_postprocess_expand_value((string) $value, $placeholders) : '';
        }
    }

    $execution = wp_codebox_bench_run_command_step($step, 'artifact-postprocess', static function () use ($command, $expanded_args, $env, $helper_path): array {
        $result = wp_codebox_bench_run_host_node_command($expanded_args, $env, dirname($helper_path));
        $stdout = $result['stdout'];
        $stderr = $result['stderr'];
        $exit_code = $result['exit_code'];
        if ($exit_code !== 0) {
            $detail = isset($result['detail']) && is_string($result['detail']) ? trim($result['detail']) : '';
            if ($detail === '') {
                $detail = trim((string) $stderr);
            }
            if ($detail === '') {
                $detail = trim((string) $stdout);
            }
            if ($detail === '' && isset($result['error']) && is_string($result['error'])) {
                $detail = trim($result['error']);
            }
            throw new RuntimeException('artifact-postprocess helper failed with exit code ' . $exit_code . ': ' . $detail);
        }
        return array('stdout' => (string) $stdout, 'stderr' => (string) $stderr, 'exit_code' => $exit_code);
    });
    if (!is_file($output_path)) {
        throw new RuntimeException('artifact-postprocess helper did not create the expected output artifact.');
    }
    $bytes = filesize($output_path);
    $bytes = is_int($bytes) ? $bytes : 0;
    $expected_schema = isset($step['expectedOutputSchema']) && is_string($step['expectedOutputSchema']) ? $step['expectedOutputSchema'] : (isset($step['expected-output-schema']) && is_string($step['expected-output-schema']) ? $step['expected-output-schema'] : '');
    $artifact_name = isset($step['artifactName']) && is_string($step['artifactName']) && trim($step['artifactName']) !== '' ? trim($step['artifactName']) : (isset($step['name']) && is_string($step['name']) && trim($step['name']) !== '' ? trim($step['name']) : preg_replace('/\.[^.]+$/', '', basename($output_relative)));
    $metadata = is_array($step['metadata'] ?? null) ? $step['metadata'] : array();
    $metadata = array_merge($metadata, array(
        'schema' => $expected_schema,
        'semantic' => isset($step['semantic']) && is_string($step['semantic']) ? $step['semantic'] : 'artifact-postprocess',
        'inputArtifactRoot' => $input_root,
        'input' => $input_summary,
    ));
    $artifact = array(
        'path' => $output_relative,
        'kind' => isset($step['artifactKind']) && is_string($step['artifactKind']) && trim($step['artifactKind']) !== '' ? trim($step['artifactKind']) : 'artifact-postprocess',
        'contentType' => wp_codebox_bench_artifact_postprocess_content_type($output_relative),
        'sha256' => hash_file('sha256', $output_path),
        'bytes' => $bytes,
        'source' => 'artifact-postprocess',
        'name' => $artifact_name,
        'metadata' => $metadata,
    );
    $payload = wp_codebox_bench_command_step_payload($execution, wp_codebox_bench_metric_prefix($step, 'artifact_postprocess'), array(
        'artifact_postprocess_input_bytes' => (float) $input_summary['bytes'],
        'artifact_postprocess_input_artifacts_count' => (float) $input_summary['artifact_count'],
        'artifact_postprocess_output_bytes' => (float) $bytes,
    ), array('outputArtifactPath' => $output_relative, 'helper' => basename($helper_path)));
    $payload['artifacts'][$artifact_name] = $artifact;
    $payload['metadata']['artifact_postprocess_schema'] = $expected_schema;
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

function wp_codebox_bench_redact_sql_query(string $sql, int $limit = 500): string {
    $redacted = preg_replace("/'(?:''|[^'])*'/", "'?'", $sql);
    $redacted = preg_replace('/\\b\\d+(?:\\.\\d+)?\\b/', '?', is_string($redacted) ? $redacted : $sql);
    $redacted = preg_replace('/\\s+/', ' ', is_string($redacted) ? $redacted : $sql);
    $redacted = trim((string) $redacted);
    return strlen($redacted) > $limit ? substr($redacted, 0, $limit) . '...' : $redacted;
}

function wp_codebox_bench_rest_db_query_profile_summary(array $queries): array {
    $total_time = 0.0;
    $by_operation = array();
    foreach ($queries as $query) {
        $sql = isset($query[0]) ? (string) $query[0] : '';
        $duration = isset($query[1]) && is_numeric($query[1]) ? (float) $query[1] : 0.0;
        $total_time += $duration;
        $operation = strtoupper(strtok(ltrim($sql), " \t\n\r") ?: 'UNKNOWN');
        if (!isset($by_operation[$operation])) {
            $by_operation[$operation] = array('operation' => $operation, 'count' => 0, 'time_ms' => 0.0);
        }
        ++$by_operation[$operation]['count'];
        $by_operation[$operation]['time_ms'] += $duration * 1000;
    }
    $operations = array_values($by_operation);
    usort($operations, static fn(array $left, array $right): int => ($right['count'] <=> $left['count']) ?: strcmp($left['operation'], $right['operation']));
    return array('query_count' => count($queries), 'total_time_ms' => $total_time * 1000, 'operations' => $operations);
}

function wp_codebox_bench_rest_db_query_profile_case_step(array $request_case, int $index): array {
    $step = array_merge($request_case, array('type' => 'rest-request'));
    if (!isset($step['path']) && isset($request_case['route'])) {
        $step['path'] = $request_case['route'];
    }
    if (!isset($step['metadata']) || !is_array($step['metadata'])) {
        $step['metadata'] = array();
    }
    $step['metadata'] = array_merge(array('rest_request_case_index' => $index), $step['metadata']);
    if (!isset($step['case_id']) && isset($request_case['id']) && is_scalar($request_case['id'])) {
        $step['case_id'] = (string) $request_case['id'];
    }
    if (!isset($step['metric-prefix'])) {
        $case_id = isset($step['case_id']) && is_string($step['case_id']) ? $step['case_id'] : 'case_' . $index;
        $step['metric-prefix'] = 'rest_profile_' . preg_replace('/[^A-Za-z0-9_]+/', '_', $case_id);
    }
    return $step;
}

function wp_codebox_bench_rest_db_query_profile_filter_query($query, array &$captured_queries) {
    $captured_queries[] = array((string) $query, 0.0, 'query filter');
    return $query;
}

function wp_codebox_bench_rest_request_cases_from_source(array $source): array {
    $type = isset($source['type']) && is_string($source['type']) ? $source['type'] : '';
    if ($type !== 'artifact') {
        throw new RuntimeException('rest_request_cases_source only supports artifact sources.');
    }

    $root = getenv('WP_CODEBOX_BENCH_SHARED_STATE');
    if (!is_string($root) || $root === '' || !is_dir($root)) {
        throw new RuntimeException('rest_request_cases_source artifact root is unavailable.');
    }

    $artifact_globs = isset($source['artifact_globs']) && is_array($source['artifact_globs']) ? $source['artifact_globs'] : array();
    $max_route_cases = isset($source['maxRouteCases']) && is_numeric($source['maxRouteCases']) ? max(0, (int) $source['maxRouteCases']) : 100;
    $max_artifact_bytes = isset($source['maxArtifactBytes']) && is_numeric($source['maxArtifactBytes']) ? max(0, (int) $source['maxArtifactBytes']) : 1048576;
    $expected_schema = isset($source['schema']) && is_string($source['schema']) ? $source['schema'] : '';
    $cases = array();
    if ($max_route_cases === 0) {
        return $cases;
    }

    foreach ($artifact_globs as $artifact_glob) {
        if (!is_string($artifact_glob) || $artifact_glob === '' || str_starts_with($artifact_glob, '/') || str_contains($artifact_glob, '..')) {
            throw new RuntimeException('rest_request_cases_source artifact_globs must be safe relative glob paths.');
        }
        foreach (glob(rtrim($root, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR . $artifact_glob) ?: array() as $artifact_path) {
            if (!is_file($artifact_path)) {
                continue;
            }
            $bytes = filesize($artifact_path);
            if ($bytes === false || $bytes > $max_artifact_bytes) {
                throw new RuntimeException('rest_request_cases_source artifact exceeds maxArtifactBytes.');
            }
            $artifact = json_decode((string) file_get_contents($artifact_path), true);
            if (!is_array($artifact)) {
                throw new RuntimeException('rest_request_cases_source artifact is not valid JSON.');
            }
            if ($expected_schema !== '' && isset($artifact['schema']) && $artifact['schema'] !== $expected_schema) {
                continue;
            }
            foreach (isset($artifact['cases']) && is_array($artifact['cases']) ? $artifact['cases'] : array() as $request_case) {
                if (!is_array($request_case)) {
                    continue;
                }
                $cases[] = $request_case;
                if (count($cases) >= $max_route_cases) {
                    return $cases;
                }
            }
        }
    }

    return $cases;
}

function wp_codebox_bench_run_rest_db_query_profiler_step(array $step): array {
    global $wpdb;

    if (!is_object($wpdb)) {
        throw new RuntimeException('wordpress.bench rest-db-query-profiler requires wpdb.');
    }
    if (!class_exists('WP_REST_Request') || !function_exists('rest_do_request')) {
        throw new RuntimeException('The WordPress REST API is not available in this runtime.');
    }
    if (!defined('SAVEQUERIES')) {
        define('SAVEQUERIES', true);
    }

    $prefix = wp_codebox_bench_metric_prefix($step, 'rest_db_query_profile');
    $sample_limit = isset($step['sampleLimit']) && is_numeric($step['sampleLimit']) ? max(0, (int) $step['sampleLimit']) : 50;
    $query_length_limit = isset($step['queryLengthLimit']) && is_numeric($step['queryLengthLimit']) ? max(80, (int) $step['queryLengthLimit']) : 500;
    $request_cases = isset($step['rest_request_cases']) && is_array($step['rest_request_cases']) ? $step['rest_request_cases'] : array();
    if (empty($request_cases) && isset($step['request_cases']) && is_array($step['request_cases'])) {
        $request_cases = $step['request_cases'];
    }
    if (empty($request_cases) && isset($step['rest_request_cases_source']) && is_array($step['rest_request_cases_source'])) {
        $request_cases = wp_codebox_bench_rest_request_cases_from_source($step['rest_request_cases_source']);
        if (empty($request_cases)) {
            throw new RuntimeException('rest_request_cases_source did not resolve any request cases.');
        }
    }
    if (empty($request_cases)) {
        $request_cases = array($step);
    }

    $previous_save_queries = property_exists($wpdb, 'save_queries') ? $wpdb->save_queries : null;
    $wpdb->save_queries = true;
    $case_profiles = array();
    $steps = array();
    $total_queries = 0;
    $total_time_ms = 0.0;
    $profile_started = hrtime(true);

    try {
        foreach ($request_cases as $index => $request_case) {
            if (!is_array($request_case)) {
                continue;
            }
            $case_step = wp_codebox_bench_rest_db_query_profile_case_step($request_case, $index);
            $captured_queries = array();
            $query_filter = static function ($query) use (&$captured_queries) {
                return wp_codebox_bench_rest_db_query_profile_filter_query($query, $captured_queries);
            };
            $before = is_array($wpdb->queries ?? null) ? count($wpdb->queries) : 0;
            if (function_exists('add_filter')) {
                add_filter('query', $query_filter, PHP_INT_MAX, 1);
            }
            try {
                $payload = wp_codebox_bench_run_rest_request_step($case_step);
            } finally {
                if (function_exists('remove_filter')) {
                    remove_filter('query', $query_filter, PHP_INT_MAX);
                }
            }
            $after_queries = is_array($wpdb->queries ?? null) ? array_slice($wpdb->queries, $before) : array();
            if (empty($after_queries) && !empty($captured_queries)) {
                $after_queries = $captured_queries;
            }
            $summary = wp_codebox_bench_rest_db_query_profile_summary($after_queries);
            $samples = array();
            foreach (array_slice($after_queries, 0, $sample_limit) as $query) {
                $samples[] = array(
                    'sql' => wp_codebox_bench_redact_sql_query(isset($query[0]) ? (string) $query[0] : '', $query_length_limit),
                    'time_ms' => isset($query[1]) && is_numeric($query[1]) ? (float) $query[1] * 1000 : 0.0,
                    'caller' => isset($query[2]) ? wp_codebox_bench_redact_sql_query((string) $query[2], $query_length_limit) : '',
                );
            }
            $case_id = isset($case_step['case_id']) ? (string) $case_step['case_id'] : 'case-' . $index;
            $case_profiles[] = array(
                'case_id' => $case_id,
                'method' => isset($case_step['method']) ? strtoupper((string) $case_step['method']) : 'GET',
                'path' => isset($case_step['path']) ? (string) $case_step['path'] : (isset($case_step['route']) ? (string) $case_step['route'] : ''),
                'summary' => $summary,
                'samples' => $samples,
            );
            $total_queries += (int) $summary['query_count'];
            $total_time_ms += (float) $summary['total_time_ms'];
            if (isset($payload['steps']) && is_array($payload['steps'])) {
                $steps = array_merge($steps, $payload['steps']);
            }
        }
    } finally {
        if ($previous_save_queries !== null) {
            $wpdb->save_queries = $previous_save_queries;
        }
    }

    $artifact = array(
        'schema' => 'wp-codebox/wordpress-rest-db-query-profile/v1',
        'summary' => array(
            'case_count' => count($case_profiles),
            'query_count' => $total_queries,
            'total_time_ms' => $total_time_ms,
            'sample_limit' => $sample_limit,
            'query_length_limit' => $query_length_limit,
        ),
        'cases' => $case_profiles,
    );
    $duration_ms = (hrtime(true) - $profile_started) / 1000000;
    $execution = array(
        'result' => $artifact,
        'duration_ms' => $duration_ms,
        'record' => wp_codebox_bench_command_step_record($step, 'rest-db-query-profiler', $duration_ms),
    );
    $payload = wp_codebox_bench_command_step_payload($execution, $prefix, array(
        $prefix . '_cases_count' => count($case_profiles),
        $prefix . '_queries_count' => $total_queries,
        $prefix . '_query_time_ms' => $total_time_ms,
    ), array('cases' => count($case_profiles), 'queries' => $total_queries));
    $payload['artifacts']['rest-db-query-profile'] = $artifact;
    $payload['steps'] = array_merge($payload['steps'], $steps);
    return $payload;
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

function wp_codebox_bench_run_db_inventory_step(array $step): array {
    global $wpdb;

    if (!is_object($wpdb)) {
        throw new RuntimeException('wordpress.bench db-inventory requires wpdb.');
    }

    $prefix = wp_codebox_bench_metric_prefix($step, 'db_inventory');
    $include_columns = !array_key_exists('include-columns', $step) || !empty($step['include-columns']);
    $include_indexes = !array_key_exists('include-indexes', $step) || !empty($step['include-indexes']);
    $tables = array();
    $table_status = $wpdb->get_results('SHOW TABLE STATUS', ARRAY_A);

    foreach (is_array($table_status) ? $table_status : array() as $table) {
        $name = isset($table['Name']) ? (string) $table['Name'] : '';
        if ($name === '') {
            continue;
        }
        $record = array(
            'name' => $name,
            'engine' => isset($table['Engine']) ? (string) $table['Engine'] : '',
            'rowCount' => isset($table['Rows']) ? (int) $table['Rows'] : 0,
            'dataBytes' => isset($table['Data_length']) ? (int) $table['Data_length'] : 0,
            'indexBytes' => isset($table['Index_length']) ? (int) $table['Index_length'] : 0,
        );
        $record['totalBytes'] = $record['dataBytes'] + $record['indexBytes'];

        if ($include_columns) {
            $columns = $wpdb->get_results('SHOW FULL COLUMNS FROM \`' . str_replace('\`', '\`\`', $name) . '\`', ARRAY_A);
            $record['columns'] = array_map(static fn($column) => array(
                'name' => isset($column['Field']) ? (string) $column['Field'] : '',
                'type' => isset($column['Type']) ? (string) $column['Type'] : '',
                'nullable' => isset($column['Null']) ? $column['Null'] === 'YES' : null,
                'key' => isset($column['Key']) ? (string) $column['Key'] : '',
                'default' => $column['Default'] ?? null,
                'extra' => isset($column['Extra']) ? (string) $column['Extra'] : '',
            ), is_array($columns) ? $columns : array());
        }

        if ($include_indexes) {
            $indexes = $wpdb->get_results('SHOW INDEX FROM \`' . str_replace('\`', '\`\`', $name) . '\`', ARRAY_A);
            $record['indexes'] = array_map(static fn($index) => array(
                'name' => isset($index['Key_name']) ? (string) $index['Key_name'] : '',
                'column' => isset($index['Column_name']) ? (string) $index['Column_name'] : '',
                'unique' => isset($index['Non_unique']) ? (int) $index['Non_unique'] === 0 : false,
                'sequence' => isset($index['Seq_in_index']) ? (int) $index['Seq_in_index'] : 0,
            ), is_array($indexes) ? $indexes : array());
        }

        $tables[] = $record;
    }

    usort($tables, static fn($left, $right) => strcmp($left['name'], $right['name']));
    $column_count = array_sum(array_map(static fn($table) => isset($table['columns']) && is_array($table['columns']) ? count($table['columns']) : 0, $tables));
    $index_count = array_sum(array_map(static fn($table) => isset($table['indexes']) && is_array($table['indexes']) ? count($table['indexes']) : 0, $tables));
    $row_count = array_sum(array_map(static fn($table) => (int) ($table['rowCount'] ?? 0), $tables));
    $total_bytes = array_sum(array_map(static fn($table) => (int) ($table['totalBytes'] ?? 0), $tables));
    $inventory = array(
        'schema' => 'wp-codebox/wordpress-db-inventory/v1',
        'tables' => $tables,
        'totals' => array(
            'tableCount' => count($tables),
            'rowCount' => $row_count,
            'columnCount' => $column_count,
            'indexCount' => $index_count,
            'totalBytes' => $total_bytes,
        ),
    );

    $execution = wp_codebox_bench_run_command_step($step, 'db-inventory', static fn(array $_step) => $inventory);
    $payload = wp_codebox_bench_command_step_payload($execution, $prefix, array(
        $prefix . '_tables_count' => count($tables),
        $prefix . '_rows_count' => $row_count,
        $prefix . '_columns_count' => $column_count,
        $prefix . '_indexes_count' => $index_count,
        $prefix . '_bytes' => $total_bytes,
    ), array('tables' => count($tables), 'columns' => $column_count, 'indexes' => $index_count));
    $payload['artifacts']['db-inventory'] = $inventory;
    return $payload;
}

function wp_codebox_bench_external_http_guardrail_state(): array {
    if (!isset($GLOBALS['wp_codebox_external_http_guardrail']) || !is_array($GLOBALS['wp_codebox_external_http_guardrail'])) {
        $GLOBALS['wp_codebox_external_http_guardrail'] = array(
            'installed' => false,
            'events' => array(),
            'policy' => array(
                'allowlistDomains' => array(),
                'blockNetwork' => false,
                'redactUrls' => true,
                'blockResponse' => array('code' => 599, 'message' => 'External HTTP blocked by WP Codebox guardrail', 'body' => ''),
            ),
        );
    }
    return $GLOBALS['wp_codebox_external_http_guardrail'];
}

function wp_codebox_bench_normalize_external_http_guardrail_policy(array $step): array {
    $allowlist = array();
    foreach (is_array($step['allowlistDomains'] ?? null) ? $step['allowlistDomains'] : array() as $domain) {
        if (is_string($domain) && trim($domain) !== '') {
            $allowlist[] = strtolower(trim($domain, " \t\n\r\0\x0B."));
        }
    }
    $allowlist = array_values(array_unique($allowlist));
    $block_response = is_array($step['blockResponse'] ?? null) ? $step['blockResponse'] : array();
    $code = isset($block_response['code']) && is_numeric($block_response['code']) ? (int) $block_response['code'] : 599;
    if ($code < 100 || $code > 599) {
        $code = 599;
    }
    return array(
        'allowlistDomains' => $allowlist,
        'blockNetwork' => array_key_exists('blockNetwork', $step) ? (bool) $step['blockNetwork'] : !empty($allowlist),
        'redactUrls' => !array_key_exists('redactUrls', $step) || (bool) $step['redactUrls'],
        'blockResponse' => array(
            'code' => $code,
            'message' => isset($block_response['message']) && is_string($block_response['message']) ? $block_response['message'] : 'External HTTP blocked by WP Codebox guardrail',
            'body' => isset($block_response['body']) && is_string($block_response['body']) ? $block_response['body'] : '',
        ),
    );
}

function wp_codebox_bench_external_http_guardrail_redact_url(string $url): string {
    $parts = wp_parse_url($url);
    if (!is_array($parts) || empty($parts['host'])) {
        return preg_replace('/([?&][^=&#]+)=([^&#]*)/', '$1=redacted', preg_replace('/#.*/', '', $url));
    }
    $redacted = ($parts['scheme'] ?? 'http') . '://';
    if (!empty($parts['user'])) {
        $redacted .= 'redacted@';
    }
    $redacted .= $parts['host'];
    if (!empty($parts['port'])) {
        $redacted .= ':' . $parts['port'];
    }
    $redacted .= $parts['path'] ?? '';
    if (!empty($parts['query'])) {
        $redacted .= '?redacted=1';
    }
    return $redacted;
}

function wp_codebox_bench_external_http_guardrail_host_allowed(string $host, array $allowlist): bool {
    $host = strtolower(trim($host, '.'));
    if ($host === '') {
        return false;
    }
    foreach ($allowlist as $domain) {
        $domain = strtolower(trim((string) $domain, '.'));
        if ($domain !== '' && ($host === $domain || str_ends_with($host, '.' . $domain))) {
            return true;
        }
    }
    return false;
}

function wp_codebox_bench_external_http_guardrail_summary(array $events, int $sample_limit = 20): array {
    $hosts = array();
    $allowed_count = 0;
    $blocked_count = 0;
    foreach ($events as $event) {
        $host = isset($event['data']['host']) ? (string) $event['data']['host'] : 'unknown';
        if (!isset($hosts[$host])) {
            $hosts[$host] = array('host' => $host, 'count' => 0, 'allowed' => 0, 'blocked' => 0);
        }
        ++$hosts[$host]['count'];
        if (!empty($event['data']['blocked']) || ($event['event'] ?? '') === 'http.blocked') {
            ++$hosts[$host]['blocked'];
            ++$blocked_count;
        } else {
            ++$hosts[$host]['allowed'];
            ++$allowed_count;
        }
    }
    $host_values = array_values($hosts);
    usort($host_values, static fn(array $left, array $right): int => ($right['count'] <=> $left['count']) ?: strcmp($left['host'], $right['host']));
    return array(
        'event_count' => count($events),
        'allowed_count' => $allowed_count,
        'blocked_count' => $blocked_count,
        'hosts' => $host_values,
        'samples' => array_slice($events, 0, max(0, $sample_limit)),
    );
}

function wp_codebox_bench_install_external_http_guardrail(array $policy): void {
    $state = wp_codebox_bench_external_http_guardrail_state();
    $state['policy'] = $policy;
    $state['events'] = array();
    $GLOBALS['wp_codebox_external_http_guardrail'] = $state;
    if (!empty($state['installed'])) {
        return;
    }
    $GLOBALS['wp_codebox_external_http_guardrail']['installed'] = true;
    add_filter('pre_http_request', static function ($preempt, $parsed_args, $url) {
        $state = wp_codebox_bench_external_http_guardrail_state();
        $policy = is_array($state['policy'] ?? null) ? $state['policy'] : array();
        $host = strtolower((string) wp_parse_url((string) $url, PHP_URL_HOST));
        $allowed = wp_codebox_bench_external_http_guardrail_host_allowed($host, is_array($policy['allowlistDomains'] ?? null) ? $policy['allowlistDomains'] : array());
        $blocked = !empty($policy['blockNetwork']) && !$allowed;
        $event_url = !array_key_exists('redactUrls', $policy) || !empty($policy['redactUrls']) ? wp_codebox_bench_external_http_guardrail_redact_url((string) $url) : (string) $url;
        $GLOBALS['wp_codebox_external_http_guardrail']['events'][] = array(
            'schema' => 'wp-codebox/wordpress-external-http-guardrail-event/v1',
            'event' => $blocked ? 'http.blocked' : 'http.allowed',
            'timestamp' => gmdate('c'),
            'data' => array(
                'id' => substr(hash('sha256', (string) $url), 0, 16),
                'url' => $event_url,
                'host' => $host,
                'method' => $parsed_args['method'] ?? 'GET',
                'allowed' => $allowed,
                'blocked' => $blocked,
            ),
        );
        if (!$blocked) {
            return $preempt;
        }
        $block_response = is_array($policy['blockResponse'] ?? null) ? $policy['blockResponse'] : array();
        return array(
            'headers' => array(),
            'body' => (string) ($block_response['body'] ?? ''),
            'response' => array(
                'code' => (int) ($block_response['code'] ?? 599),
                'message' => (string) ($block_response['message'] ?? 'External HTTP blocked by WP Codebox guardrail'),
            ),
            'cookies' => array(),
            'filename' => null,
        );
    }, 10, 3);
}

function wp_codebox_bench_run_external_http_guardrail_step(array $step): array {
    $action = isset($step['action']) && is_string($step['action']) ? $step['action'] : 'collect';
    $prefix = wp_codebox_bench_metric_prefix($step, 'external_http_guardrail');
    if ($action === 'install') {
        $policy = wp_codebox_bench_normalize_external_http_guardrail_policy($step);
        $execution = wp_codebox_bench_run_command_step($step, 'external-http-guardrail', static function () use ($policy): array {
            wp_codebox_bench_install_external_http_guardrail($policy);
            return array('metadata' => array('external_http_guardrail_policy' => $policy));
        });
        return wp_codebox_bench_command_step_payload($execution, $prefix, array(), array('action' => 'install'));
    }
    if ($action === 'reset') {
        $GLOBALS['wp_codebox_external_http_guardrail']['events'] = array();
        return array('metrics' => array($prefix . '_event_count' => 0), 'steps' => array(array('schema' => 'wp-codebox/bench-command-step/v1', 'type' => 'external-http-guardrail', 'action' => 'reset')));
    }
    if ($action !== 'collect') {
        throw new RuntimeException('external-http-guardrail bench workload steps support install, collect, or reset actions.');
    }
    $execution = wp_codebox_bench_run_command_step($step, 'external-http-guardrail', static function (array $step): array {
        $state = wp_codebox_bench_external_http_guardrail_state();
        $events = is_array($state['events'] ?? null) ? $state['events'] : array();
        $summary = wp_codebox_bench_external_http_guardrail_summary($events, isset($step['sampleLimit']) && is_numeric($step['sampleLimit']) ? (int) $step['sampleLimit'] : 20);
        $artifact = array(
            'schema' => 'wp-codebox/wordpress-external-http-guardrail/v1',
            'policy' => $state['policy'] ?? array(),
            'summary' => $summary,
            'events' => $events,
        );
        return array(
            'metrics' => array(
                'event_count' => $summary['event_count'],
                'allowed_count' => $summary['allowed_count'],
                'blocked_count' => $summary['blocked_count'],
                'host_count' => count($summary['hosts']),
            ),
            'artifacts' => array('external-http-guardrail' => $artifact),
            'metadata' => array('external_http_guardrail_schema' => $artifact['schema']),
        );
    });
    $result = is_array($execution['result'] ?? null) ? $execution['result'] : array();
    return wp_codebox_bench_command_step_payload($execution, $prefix, array(
        $prefix . '_event_count' => (float) ($result['metrics']['event_count'] ?? 0),
        $prefix . '_allowed_count' => (float) ($result['metrics']['allowed_count'] ?? 0),
        $prefix . '_blocked_count' => (float) ($result['metrics']['blocked_count'] ?? 0),
        $prefix . '_host_count' => (float) ($result['metrics']['host_count'] ?? 0),
    ), array('action' => 'collect'));
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
    $manifest = $GLOBALS['contained_runtime_component_manifest'] ?? null;
    if (!is_array($manifest)) {
        $json = defined('CONTAINED_RUNTIME_COMPONENT_MANIFEST_JSON') ? CONTAINED_RUNTIME_COMPONENT_MANIFEST_JSON : '';
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
$plugin_roles[$plugin_file] = 'component';
foreach (is_array($dependency_slugs) ? $dependency_slugs : array() as $dependency_slug) {
    $dependency_file = wp_codebox_bench_plugin_file_for_slug((string) $dependency_slug, 'dependency');
    $plugins_to_activate[] = $dependency_file;
    $plugin_roles[$dependency_file] = 'dependency';
}
$plugins_to_activate[] = $plugin_file;
$plugins_to_activate = array_values(array_unique($plugins_to_activate));
foreach ($plugins_to_activate as $plugin_to_activate) {
    wp_codebox_bench_assert_plugin_autoload_ready($plugin_to_activate);
}

$pre_plugins_loaded_callbacks = wp_codebox_bench_snapshot_wordpress_hook_callbacks('plugins_loaded');
$pre_init_callbacks = wp_codebox_bench_snapshot_wordpress_hook_callbacks('init');

foreach ($plugins_to_activate as $plugin_to_activate) {
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

function wp_codebox_bench_required_value_specs($values, string $type): array {
    $specs = array();
    foreach (is_array($values) ? $values : array() as $value) {
        if (is_string($value) && trim($value) !== '') {
            $specs[] = array('type' => $type, 'value' => trim($value));
        } elseif (is_array($value)) {
            $spec = array_merge(array('type' => $type), $value);
            if (!isset($spec['value']) && isset($spec['name'])) {
                $spec['value'] = $spec['name'];
            }
            $specs[] = $spec;
        }
    }
    return $specs;
}

function wp_codebox_bench_required_artifact_specs_from_declarations($declarations): array {
    $specs = array();
    foreach (is_array($declarations) ? $declarations : array() as $key => $declaration) {
        if (is_array($declaration) && !empty($declaration['required'])) {
            $spec = array('type' => 'artifact');
            if (is_string($key) && $key !== '') {
                $spec['value'] = $key;
            }
            foreach (array('name', 'kind', 'schema', 'semantic_key', 'semantic') as $field) {
                if (isset($declaration[$field]) && is_string($declaration[$field]) && trim($declaration[$field]) !== '') {
                    $spec[$field] = trim($declaration[$field]);
                }
            }
            if (!isset($spec['value']) && isset($spec['name'])) {
                $spec['value'] = $spec['name'];
            }
            $specs[] = $spec;
        }
    }
    return $specs;
}

function wp_codebox_bench_workload_required_specs(array $workload): array {
    return array_merge(
        wp_codebox_bench_required_value_specs($workload['required_artifacts'] ?? ($workload['requiredArtifacts'] ?? array()), 'artifact'),
        wp_codebox_bench_required_value_specs($workload['required_artifact_kinds'] ?? ($workload['requiredArtifactKinds'] ?? array()), 'artifact_kind'),
        wp_codebox_bench_required_value_specs($workload['required_observations'] ?? ($workload['requiredObservations'] ?? array()), 'observation'),
        wp_codebox_bench_required_artifact_specs_from_declarations($workload['artifacts'] ?? array())
    );
}

function wp_codebox_bench_artifact_matches_required_spec(string $key, array $artifact, array $spec): bool {
    if (($spec['type'] ?? '') === 'artifact_kind') {
        $expected_kind = isset($spec['value']) && is_string($spec['value']) ? trim($spec['value']) : (isset($spec['kind']) && is_string($spec['kind']) ? trim($spec['kind']) : '');
        return $expected_kind !== '' && isset($artifact['kind']) && is_string($artifact['kind']) && $artifact['kind'] === $expected_kind;
    }

    $metadata = isset($artifact['metadata']) && is_array($artifact['metadata']) ? $artifact['metadata'] : array();
    $candidates = array($key);
    foreach (array('name', 'kind', 'source', 'path') as $field) {
        if (isset($artifact[$field]) && is_string($artifact[$field])) {
            $candidates[] = $artifact[$field];
        }
    }
    foreach (array('schema', 'semantic', 'semantic_key') as $field) {
        if (isset($metadata[$field]) && is_string($metadata[$field])) {
            $candidates[] = $metadata[$field];
        }
    }

    foreach (array('value', 'name', 'kind', 'schema', 'semantic_key', 'semantic') as $field) {
        if (!isset($spec[$field]) || !is_string($spec[$field]) || trim($spec[$field]) === '') {
            continue;
        }
        $expected = trim($spec[$field]);
        foreach ($candidates as $candidate) {
            if ($candidate === $expected) {
                return true;
            }
        }
    }
    return false;
}

function wp_codebox_bench_step_matches_required_spec(array $step, array $spec): bool {
    $expected = isset($spec['value']) && is_string($spec['value']) ? trim($spec['value']) : '';
    if ($expected === '') {
        return false;
    }
    foreach (array('type', 'name', 'command', 'ability', 'path', 'route') as $field) {
        if (isset($step[$field]) && is_scalar($step[$field]) && (string) $step[$field] === $expected) {
            return true;
        }
    }
    return false;
}

function wp_codebox_bench_payload_satisfies_required_spec(array $payload, array $spec): bool {
    foreach (is_array($payload['artifacts'] ?? null) ? $payload['artifacts'] : array() as $key => $artifact) {
        if (is_array($artifact) && wp_codebox_bench_artifact_matches_required_spec((string) $key, $artifact, $spec)) {
            return true;
        }
    }
    if (($spec['type'] ?? '') === 'observation') {
        foreach (is_array($payload['steps'] ?? null) ? $payload['steps'] : array() as $step) {
            if (is_array($step) && wp_codebox_bench_step_matches_required_spec($step, $spec)) {
                return true;
            }
        }
    }
    return false;
}

function wp_codebox_bench_required_spec_label(array $spec): string {
    foreach (array('value', 'name', 'kind', 'schema', 'semantic_key', 'semantic') as $field) {
        if (isset($spec[$field]) && is_string($spec[$field]) && trim($spec[$field]) !== '') {
            return ($spec['type'] ?? 'required') . ':' . trim($spec[$field]);
        }
    }
    return (string) ($spec['type'] ?? 'required');
}

function wp_codebox_bench_assert_required_observations(array $workload, array $payload): void {
    $required_specs = wp_codebox_bench_workload_required_specs($workload);
    if (empty($required_specs)) {
        return;
    }

    $missing = array();
    foreach ($required_specs as $spec) {
        if (!is_array($spec) || wp_codebox_bench_payload_satisfies_required_spec($payload, $spec)) {
            continue;
        }
        $missing[] = wp_codebox_bench_required_spec_label($spec);
    }
    if (empty($missing)) {
        return;
    }

    $artifact_keys = array_keys(is_array($payload['artifacts'] ?? null) ? $payload['artifacts'] : array());
    $step_types = array_values(array_filter(array_map(static fn($step) => is_array($step) && isset($step['type']) ? (string) $step['type'] : null, is_array($payload['steps'] ?? null) ? $payload['steps'] : array())));
    throw new RuntimeException('wordpress.bench required observations were not produced for workload "' . (string) ($workload['id'] ?? 'configured') . '". diagnostic=' . wp_json_encode(array(
        'schema' => 'wp-codebox/bench-required-observation-diagnostic/v1',
        'workload_id' => (string) ($workload['id'] ?? 'configured'),
        'missing' => $missing,
        'actual' => array(
            'artifact_keys' => $artifact_keys,
            'step_count' => count(is_array($payload['steps'] ?? null) ? $payload['steps'] : array()),
            'step_types' => $step_types,
        ),
    ), JSON_UNESCAPED_SLASHES));
}

function wp_codebox_bench_run_configured_workload(array $workload, string $plugin_path) {
    $steps = wp_codebox_bench_workload_run_steps($workload);
    $payload = array('metrics' => array(), 'metadata' => array(), 'artifacts' => array(), 'steps' => array(), 'diagnostics' => array());
    if (isset($workload['metadata']) && is_array($workload['metadata'])) {
        $payload['metadata'] = array_merge($payload['metadata'], $workload['metadata']);
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
		} elseif ($type === 'db-inventory') {
			$result = wp_codebox_bench_run_db_inventory_step($step);
		} elseif ($type === 'rest-db-query-profiler') {
			$result = wp_codebox_bench_run_rest_db_query_profiler_step($step);
		} elseif ($type === 'external-http-guardrail') {
			$result = wp_codebox_bench_run_external_http_guardrail_step($step);
		} elseif ($type === 'artifact-postprocess') {
			$result = wp_codebox_bench_run_artifact_postprocess_step($step, $plugin_path);
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
    wp_codebox_bench_assert_required_observations($workload, $payload);
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
