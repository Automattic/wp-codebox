import { phpEnvAssignmentFunction, phpWpConfigDefineAppenderFunction } from "./php-snippets.js"

export interface PhpunitRunCodeOptions {
  pluginSlug: string
  cwd: string
  autoloadFile: string
  projectAutoloadFile?: string
  testsDir: string
  testRoot?: string
  phpunitXml: string
  selectedTestFile: string
  changedTestFiles: unknown[]
  phpunitArgs: string[]
  env: Record<string, unknown>
  wpConfigDefines: Record<string, unknown>
  dependencyMounts: string[]
  bootstrapFiles: string[]
  preloadFiles?: string[]
  bootstrapMode: string
  projectBootstrap: string
  multisite: boolean
  /**
   * Sandbox-internal, writable path for the structured diagnostics log. Defaults
   * to a /tmp path so diagnostics survive read-only plugin mounts and a mid-install
   * die() or exit().
   */
  resultFile?: string
}

export interface CorePhpunitRunCodeOptions {
  coreRoot: string
  testsDir: string
  phpunitXml: string
  selectedTestFile: string
  changedTestFiles: unknown[]
  autoloadFile: string
  wpConfigDefines: Record<string, unknown>
  multisite: boolean
  /**
   * Sandbox-internal, writable path for the structured diagnostics log. Defaults
   * to a /tmp path so diagnostics survive read-only core mounts and a mid-require
   * die() in WordPress core's bootstrap.php (see issue #314).
   */
  resultFile?: string
}

export const CORE_PHPUNIT_RESULT_FILE = "/tmp/wp-codebox-core-phpunit-result.txt"
export const PLUGIN_PHPUNIT_RESULT_FILE = "/tmp/wp-codebox-phpunit-result.txt"

interface PhpunitConfigDiscoveryPhpOptions {
  functionName: string
  logFunction: string
  missingConfigMessage: string
  parseFailureMessage: string
  includeParseFailureDetail: boolean
  loadedConfigMessage: string
  fallbackXmlDist: boolean
  restrictDirectoriesToTests: boolean
  basePathExpression: string
  uniqueReturnValues: boolean
  replaceDefaultMatchers: boolean
}

interface PhpunitChangedTestFilterPhpOptions {
  relativeFunctionName: string
  filterFunctionName: string
  logFunction: string
  rootParameterName: string
  testsPathFallback: boolean
  emptyWantedNotice: boolean
}

function phpunitConfigDiscoveryPhp(options: PhpunitConfigDiscoveryPhpOptions): string {
  const fallbackXmlDist = options.fallbackXmlDist ? `
    if (!is_readable($xml_path) && basename($xml_path) === 'phpunit.xml.dist') {
        $alternate = dirname($xml_path) . '/phpunit.xml';
        if (is_readable($alternate)) {
            $xml_path = $alternate;
        }
    }` : ""
  const directoryRestriction = options.restrictDirectoriesToTests ? `
        $normalized = trim(str_replace('\\\\', '/', $raw), '/');
        if ($raw === '' || ($normalized !== 'tests' && strpos($normalized, 'tests/') !== 0)) {
            continue;
        }` : `
        if ($raw === '') {
            continue;
        }`
  const returnValues = options.uniqueReturnValues
    ? "array(array_values(array_unique($directories)), array_values(array_unique($suffixes)), array_values(array_unique($prefixes)), $excludes, array_values(array_unique($files)))"
    : "array($directories, $suffixes, $prefixes, $excludes, $files)"
  const parseFailureLog = options.includeParseFailureDetail
    ? `${options.logFunction}('${options.parseFailureMessage}' . $first . '); using defaults');`
    : `${options.logFunction}('${options.parseFailureMessage}');`
  const suffixAssignment = options.replaceDefaultMatchers ? "$suffixes = $config_suffixes;" : "$suffixes = array_merge($suffixes, $config_suffixes);"
  const prefixAssignment = options.replaceDefaultMatchers ? "$prefixes = $config_prefixes;" : "$prefixes = array_merge($prefixes, $config_prefixes);"

  return `function ${options.functionName}($xml_path, $test_dir_default) {
    $directories = array($test_dir_default);
    $suffixes = array('Test.php');
    $prefixes = array('test-');
    $excludes = array();
    $files = array();
    $return_values = static function() use (&$directories, &$suffixes, &$prefixes, &$excludes, &$files) {
        return ${returnValues};
    };${fallbackXmlDist}
    if (!is_readable($xml_path)) {
        ${options.logFunction}('${options.missingConfigMessage}' . $xml_path . '; using defaults');
        return $return_values();
    }
    $prev = libxml_use_internal_errors(true);
    $xml = @simplexml_load_file($xml_path);
    $errors = libxml_get_errors();
    libxml_clear_errors();
    libxml_use_internal_errors($prev);
    if ($xml === false) {
        $first = $errors ? trim($errors[0]->message) : 'unknown';
        ${parseFailureLog}
        return $return_values();
    }
    $base = ${options.basePathExpression};
    $config_dirs = array();
    $config_suffixes = array();
    $config_prefixes = array();
    foreach ($xml->xpath('//testsuite/directory') ?: array() as $dir) {
        $raw = trim((string) $dir);${directoryRestriction}
        $config_dirs[] = $raw[0] === '/' ? rtrim($raw, '/') : rtrim($base . '/' . $raw, '/');
        foreach (explode(',', (string) ($dir['suffix'] ?? '')) as $suffix) {
            $suffix = trim($suffix);
            if ($suffix !== '') {
                $config_suffixes[] = $suffix;
            }
        }
        foreach (explode(',', (string) ($dir['prefix'] ?? '')) as $prefix) {
            $prefix = trim($prefix);
            if ($prefix !== '') {
                $config_prefixes[] = $prefix;
            }
        }
    }
    foreach ($xml->xpath('//testsuite/exclude') ?: array() as $exclude) {
        $raw = trim((string) $exclude);
        if ($raw !== '') {
            $excludes[] = $raw[0] === '/' ? rtrim($raw, '/') : rtrim($base . '/' . $raw, '/');
        }
    }
    foreach ($xml->xpath('//testsuite/file') ?: array() as $file) {
        $raw = trim((string) $file);
        if ($raw !== '') {
            $files[] = $raw[0] === '/' ? $raw : $base . '/' . $raw;
        }
    }
    if (!empty($config_dirs)) {
        $directories = $config_dirs;
        ${options.logFunction}('${options.loadedConfigMessage}' . $xml_path);
    }
    if (!empty($config_suffixes)) {
        ${suffixAssignment}
    }
    if (!empty($config_prefixes)) {
        ${prefixAssignment}
    }
    return $return_values();
}`
}

function phpunitDiscoveryPhp(functionName: string, logFunction: string): string {
  return `function ${functionName}(array $directories, array $suffixes, array $prefixes, array $excludes, array $files = array()) {
    $found = array();
    foreach ($files as $file) {
        if (!is_string($file) || $file === '') {
            continue;
        }
        if (!is_file($file) || pathinfo($file, PATHINFO_EXTENSION) !== 'php') {
            ${logFunction}('NOTICE:test file does not exist: ' . $file);
            continue;
        }
        foreach ($excludes as $exclude) {
            if (strpos($file, $exclude) === 0) {
                continue 2;
            }
        }
        $found[] = $file;
    }
    foreach ($directories as $dir) {
        if (!is_dir($dir)) {
            ${logFunction}('NOTICE:test directory does not exist: ' . $dir);
            continue;
        }
        $iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir, RecursiveDirectoryIterator::SKIP_DOTS), RecursiveIteratorIterator::LEAVES_ONLY);
        foreach ($iterator as $file) {
            if (!$file->isFile() || $file->getExtension() !== 'php') {
                continue;
            }
            $path = $file->getPathname();
            foreach ($excludes as $exclude) {
                if (strpos($path, $exclude) === 0) {
                    continue 2;
                }
            }
            $base = $file->getBasename();
            $matches = false;
            foreach ($suffixes as $suffix) {
                if ($suffix !== '' && substr($base, -strlen($suffix)) === $suffix) {
                    $matches = true;
                    break;
                }
            }
            if (!$matches) {
                foreach ($prefixes as $prefix) {
                    if ($prefix !== '' && strpos($base, $prefix) === 0) {
                        $matches = true;
                        break;
                    }
                }
            }
            if ($matches) {
                $found[] = $path;
            }
        }
    }
    sort($found);
    return array_values(array_unique($found));
}`
}

function phpunitChangedTestFilterPhp(options: PhpunitChangedTestFilterPhpOptions): string {
  const testsPathFallback = options.testsPathFallback ? ` elseif (strpos($path, '/tests/') !== false) {
        $path = substr($path, strpos($path, '/tests/') + 1);
    }` : ""
  const emptyWantedNotice = options.emptyWantedNotice ? `
    if (empty($wanted)) {
        ${options.logFunction}('NOTICE:changed tests did not contain usable test paths');
        return array();
    }` : ""

  return `function ${options.filterFunctionName}(array $test_files, string $changed_files_json, string $${options.rootParameterName}): array {
    $decoded = json_decode($changed_files_json, true);
    if (!is_array($decoded) || empty($decoded)) {
        return $test_files;
    }
    $wanted = array();
    foreach ($decoded as $entry) {
        if (!is_scalar($entry)) {
            continue;
        }
        $normalized = ${options.relativeFunctionName}((string) $entry, $${options.rootParameterName});
        if ($normalized !== '') {
            $wanted[$normalized] = true;
        }
    }${emptyWantedNotice}
    $filtered = array();
    foreach ($test_files as $file) {
        if (isset($wanted[${options.relativeFunctionName}((string) $file, $${options.rootParameterName})])) {
            $filtered[] = $file;
        }
    }
    ${options.logFunction}('SCOPED_TEST_FILES requested=' . count($wanted) . ' matched=' . count($filtered));
    return $filtered;
}

function ${options.relativeFunctionName}(string $path, string $${options.rootParameterName}): string {
    $path = trim(str_replace('\\\\', '/', $path));
    $${options.rootParameterName} = rtrim(str_replace('\\\\', '/', $${options.rootParameterName}), '/');
    if (strpos($path, $${options.rootParameterName} . '/') === 0) {
        $path = substr($path, strlen($${options.rootParameterName}) + 1);
    }${testsPathFallback}
    while (strpos($path, './') === 0) {
        $path = substr($path, 2);
    }
    return ltrim($path, '/');
}`
}

function phpunitArgsPhp(functionName: string, logFunction: string): string {
  return `function ${functionName}(array $argv) {
    $arguments = array('colors' => 'never', 'testdox' => true, 'verbose' => false, 'extensions' => array());
    $args = array_slice($argv, 1);
    for ($i = 0; $i < count($args); $i++) {
        $arg = $args[$i];
        if ($arg === '--filter' && isset($args[$i + 1])) {
            $arguments['filter'] = $args[++$i];
            ${logFunction}('NOTICE:phpunit filter applied: ' . $arguments['filter']);
            continue;
        }
        if (strpos($arg, '--filter=') === 0) {
            $arguments['filter'] = substr($arg, strlen('--filter='));
            ${logFunction}('NOTICE:phpunit filter applied: ' . $arguments['filter']);
            continue;
        }
        if ($arg === '--list-tests') {
            $arguments['listTests'] = true;
            continue;
        }
        if ($arg === '--no-testdox') {
            $arguments['testdox'] = false;
            continue;
        }
        if ($arg === '--verbose' || $arg === '-v') {
            $arguments['verbose'] = true;
            continue;
        }
    }
    return $arguments;
}`
}

export function phpunitRunCode(options: PhpunitRunCodeOptions): string {
  return `error_reporting(E_ALL);
ini_set('display_errors', '1');
ini_set('display_startup_errors', '1');

$plugin_slug = ${JSON.stringify(options.pluginSlug)};
$plugin_path = '/wordpress/wp-content/plugins/' . $plugin_slug;
$runtime_cwd = ${JSON.stringify(options.cwd || `/wordpress/wp-content/plugins/${options.pluginSlug}`)};
$result_file = ${JSON.stringify(options.resultFile ?? PLUGIN_PHPUNIT_RESULT_FILE)};
$current_stage = 'preboot';
$pg_stage_output_buffering = false;
$autoload_file = ${JSON.stringify(options.autoloadFile)};
$project_autoload_file = ${JSON.stringify(options.projectAutoloadFile ?? "")};
$tests_dir = ${JSON.stringify(options.testsDir)};
$test_root = ${JSON.stringify(options.testRoot || `/wordpress/wp-content/plugins/${options.pluginSlug}/tests`)};
$selected_test_file = ${JSON.stringify(options.selectedTestFile)};
$changed_test_files_raw = ${JSON.stringify(JSON.stringify(options.changedTestFiles))};
$phpunit_args_raw = json_decode(${JSON.stringify(JSON.stringify(options.phpunitArgs))}, true);
$bench_env = json_decode(${JSON.stringify(JSON.stringify(options.env))}, true);
$wp_config_defines = json_decode(${JSON.stringify(JSON.stringify(options.wpConfigDefines))}, true);
$dep_mounts = ${JSON.stringify(options.dependencyMounts.join("\\n"))};
$bootstrap_files = json_decode(${JSON.stringify(JSON.stringify(options.bootstrapFiles))}, true);
$preload_files = json_decode(${JSON.stringify(JSON.stringify(options.preloadFiles ?? []))}, true);
$bootstrap_mode = ${JSON.stringify(options.bootstrapMode || "managed")};
$project_bootstrap = ${JSON.stringify(options.projectBootstrap)};
$multisite = ${JSON.stringify(options.multisite)};

@file_put_contents($result_file, '');

function pg_log($msg) {
    global $result_file;
    if (!in_array('file', stream_get_wrappers(), true)) {
        @stream_wrapper_restore('file');
    }
    file_put_contents($result_file, $msg . "\n", FILE_APPEND);
}

${phpEnvAssignmentFunction("pg_apply_env", "json_encode", "pg_log('NOTICE: skipping invalid bench_env key: ' . var_export($name, true));")}

${phpWpConfigDefineAppenderFunction("pg_append_wp_config_defines", "pg_log('NOTICE: skipping invalid wp_config_defines key: ' . var_export($name, true));")}

function pg_diagnostic_context(): string {
    global $current_stage;
    $hook = function_exists('current_filter') ? current_filter() : null;
    if (!is_string($hook) || $hook === '') {
        $hook = 'none';
    }
    $installing = function_exists('wp_installing') && wp_installing() ? 'true' : 'false';
    return 'stage=' . ($current_stage ?: 'unknown') . ' hook=' . $hook . ' wp_installing=' . $installing;
}

function &pg_stage_timings_ref(): array {
    static $timings = array('_starts_ns' => array(), '_durations_ms' => array());
    return $timings;
}

function pg_stage_begin($stage) {
    global $current_stage;
    $current_stage = $stage;
    $timings = &pg_stage_timings_ref();
    $timings['_starts_ns'][$stage] = hrtime(true);
    pg_log('STAGE_BEGIN:' . $stage);
}

function pg_stage_ok($stage) {
    $timings = &pg_stage_timings_ref();
    if (isset($timings['_starts_ns'][$stage])) {
        $timings['_durations_ms'][$stage] = (hrtime(true) - $timings['_starts_ns'][$stage]) / 1000000;
    }
    pg_log('STAGE_OK:' . $stage);
}

function pg_stage_fail($stage, Throwable $e) {
    pg_log('STAGE_FAIL:' . $stage . ':' . get_class($e) . ': ' . $e->getMessage() . ' at ' . $e->getFile() . ':' . $e->getLine());
    pg_log('TRACE:');
    foreach (explode("\n", $e->getTraceAsString()) as $line) {
        pg_log('  ' . $line);
    }
}

function pg_install_diagnostics_handlers() {
    set_error_handler(function ($severity, $message, $file, $line) {
        if (!(error_reporting() & $severity)) {
            return false;
        }
        $labels = array(E_WARNING => 'WARNING', E_NOTICE => 'NOTICE', E_DEPRECATED => 'DEPRECATED', E_USER_WARNING => 'USER_WARNING', E_USER_NOTICE => 'USER_NOTICE', E_USER_DEPRECATED => 'USER_DEPRECATED', E_STRICT => 'STRICT');
        pg_log('NOTICE:' . ($labels[$severity] ?? ('E_' . $severity)) . ': ' . $message . ' at ' . $file . ':' . $line . ' context=' . pg_diagnostic_context());
        return false;
    });
    register_shutdown_function(function () {
        global $current_stage, $pg_stage_output_buffering;
        if (!empty($pg_stage_output_buffering)) {
            $buffered = '';
            while (ob_get_level() > 0) {
                $chunk = ob_get_clean();
                if ($chunk !== false) {
                    $buffered = $chunk . $buffered;
                }
            }
            $buffered = trim($buffered);
            if ($buffered !== '') {
                pg_log('STAGE_DIE:' . $current_stage . ':' . $buffered);
            }
        }
        $error = error_get_last();
        if ($error && in_array($error['type'], array(E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR), true)) {
            pg_log('STAGE_FATAL:' . $current_stage . ':' . $error['message'] . ' at ' . $error['file'] . ':' . $error['line']);
        }
    });
}

function pg_snapshot_wordpress_hook_callbacks(string $hook_name): array {
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

function pg_remove_new_wordpress_hook_callbacks(string $hook_name, array $before): void {
    global $wp_filter;
    if (!isset($wp_filter[$hook_name]) || !isset($wp_filter[$hook_name]->callbacks)) {
        return;
    }
    foreach ($wp_filter[$hook_name]->callbacks as $priority => $callbacks) {
        foreach (array_keys($callbacks) as $callback_id) {
            if (!isset($before[$priority . ':' . $callback_id])) {
                unset($wp_filter[$hook_name]->callbacks[$priority][$callback_id]);
            }
        }
        if (empty($wp_filter[$hook_name]->callbacks[$priority])) {
            unset($wp_filter[$hook_name]->callbacks[$priority]);
        }
    }
}

function pg_defer_new_wordpress_hook_callbacks(string $hook_name, array $before): array {
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
    usort($deferred, static function (array $left, array $right): int { return $left['priority'] <=> $right['priority']; });
    return $deferred;
}

function pg_run_deferred_wordpress_hook_callbacks(array $deferred, array $args = array(), ?string $hook_name = null): void {
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

function pg_reopen_wordpress_action(string $hook_name): bool {
    global $wp_actions;
    if (!function_exists('did_action') || did_action($hook_name) === 0) {
        return false;
    }
    if (!is_array($wp_actions)) {
        $wp_actions = array();
    }
    $wp_actions[$hook_name] = 0;
    pg_log('NOTICE:reopened WordPress action after install: ' . $hook_name);
    return true;
}

function pg_fire_reopened_wordpress_action(string $hook_name, bool $reopened): void {
    if ($reopened && function_exists('do_action')) {
        do_action($hook_name);
    }
}

function pg_fire_runtime_abilities_ready(): void {
    if (!function_exists('do_action')) {
        return;
    }
    do_action('contained_runtime_abilities_ready');
    if (function_exists('did_action')) {
        pg_log('NOTICE:runtime ability lifecycle ready: wp_abilities_api_categories_init=' . did_action('wp_abilities_api_categories_init') . '; wp_abilities_api_init=' . did_action('wp_abilities_api_init') . '; contained_runtime_abilities_ready=' . did_action('contained_runtime_abilities_ready'));
    }
}

function pg_preload_wp_cli_namespaced_functions(string $autoload_file): void {
    if ($autoload_file === '') {
        return;
    }
    $vendor_dir = dirname($autoload_file);
    $wp_cli_root = $vendor_dir . '/wp-cli/wp-cli';
    if (!defined('WP_CLI_ROOT')) {
        define('WP_CLI_ROOT', $wp_cli_root);
    }
    if (!defined('WP_CLI_VENDOR_DIR')) {
        define('WP_CLI_VENDOR_DIR', $vendor_dir);
    }
    if (!defined('WP_CLI_VERSION') && is_readable($wp_cli_root . '/VERSION')) {
        define('WP_CLI_VERSION', trim(file_get_contents($wp_cli_root . '/VERSION')));
    }
    if (!defined('WP_CLI_START_MICROTIME')) {
        define('WP_CLI_START_MICROTIME', microtime(true));
    }
    if (!function_exists('WP_CLI\\Utils\\parse_str_to_argv') && is_readable($wp_cli_root . '/php/utils.php')) {
        require_once $wp_cli_root . '/php/utils.php';
    }
    if (!function_exists('WP_CLI\\Dispatcher\\get_path') && is_readable($wp_cli_root . '/php/dispatcher.php')) {
        require_once $wp_cli_root . '/php/dispatcher.php';
    }
    if (!function_exists('WP_CLI\\Utils\\get_upgrader') && is_readable($wp_cli_root . '/php/utils-wp.php')) {
        require_once $wp_cli_root . '/php/utils-wp.php';
    }
}

function pg_run_boot_stage(array $cfg = []): ?string {
    global $autoload_file;
    pg_stage_begin('boot');
    try {
        $harness_autoload = trim((string) ($cfg['autoload_file'] ?? $autoload_file));
        $autoload_required = !empty($cfg['autoload_required']);
        $extra_defines = $cfg['extra_defines'] ?? array();
        $table_prefix = isset($cfg['table_prefix']) && is_string($cfg['table_prefix']) && $cfg['table_prefix'] !== '' ? $cfg['table_prefix'] : 'wptests_';
        $config_path = '/tmp/wp-tests-config.php';
        $config = "<?php\n";
        pg_append_wp_config_defines($config, $extra_defines);
        $config .= '$table_prefix = ' . var_export($table_prefix, true) . ";\n";
        $config .= <<<'CONFIG'
define('DB_NAME', ':memory:');
define('DB_USER', 'root');
define('DB_PASSWORD', '');
define('DB_HOST', 'localhost');
define('DB_CHARSET', 'utf8');
define('WP_TESTS_DOMAIN', 'example.org');
define('WP_TESTS_EMAIL', 'admin@example.org');
define('WP_TESTS_TITLE', 'Test Blog');
define('WP_PHP_BINARY', 'php');
define('ABSPATH', '/wordpress/');
define('FS_CHMOD_FILE', 0644);
define('FS_CHMOD_DIR', 0755);
define('FS_METHOD', 'direct');
CONFIG;
        file_put_contents($config_path, $config);
        if ($harness_autoload !== '' && is_readable($harness_autoload)) {
            pg_preload_wp_cli_namespaced_functions($harness_autoload);
            require_once $harness_autoload;
        } elseif ($autoload_required || $harness_autoload !== '') {
            throw new RuntimeException('configured PHPUnit harness autoload file is not readable: ' . $harness_autoload . '; mount the WP Codebox PHPUnit harness or clear autoload-file when using bootstrap-mode=project with a project bootstrap that loads PHPUnit.');
        } else {
            pg_log('NOTICE:project bootstrap mode continuing without configured PHPUnit harness autoload');
        }
        pg_stage_ok('boot');
        return $config_path;
    } catch (Throwable $e) {
        pg_stage_fail('boot', $e);
        exit(1);
    }
}

function pg_resolve_runtime_cwd(string $cwd, string $plugin_path): string {
    $cwd = trim(str_replace('\\\\', '/', $cwd));
    if ($cwd === '') {
        return $plugin_path;
    }
    if ($cwd[0] !== '/') {
        $cwd = rtrim($plugin_path, '/') . '/' . ltrim($cwd, '/');
    }
    $real = realpath($cwd);
    if ($real === false || !is_dir($real)) {
        throw new RuntimeException('cwd is not a readable sandbox directory: ' . $cwd);
    }
    return $real;
}

function pg_resolve_test_root(string $root, string $plugin_path): string {
    $root = trim(str_replace('\\\\', '/', $root));
    if ($root === '') {
        $root = $plugin_path . '/tests';
    } elseif ($root[0] !== '/') {
        $root = rtrim($plugin_path, '/') . '/' . ltrim($root, '/');
    }
    $real = realpath($root);
    if ($real === false || !is_dir($real)) {
        throw new RuntimeException('test root is not a readable sandbox directory: ' . $root);
    }
    return $real;
}

function pg_manifest_component_entry(string $plugin_slug): ?array {
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
            if (is_array($entry) && (string) ($entry['slug'] ?? '') === $plugin_slug) {
                return $entry;
            }
        }
    }

    return null;
}

function pg_manifest_component_plugin_file(string $plugin_slug, string $plugin_path): ?string {
    $entry = pg_manifest_component_entry($plugin_slug);
    if ($entry === null) {
        return null;
    }

    $entrypoint = trim(str_replace('\\\\', '/', (string) ($entry['entrypoint'] ?? $entry['pluginFile'] ?? '')));
    if ($entrypoint === '' || str_starts_with($entrypoint, '/') || str_contains($entrypoint, '..') || !str_ends_with($entrypoint, '.php')) {
        throw new RuntimeException('manifest contains unsafe component entrypoint for slug ' . $plugin_slug);
    }
    if (!str_starts_with($entrypoint, $plugin_slug . '/')) {
        throw new RuntimeException('manifest component entrypoint must be relative to the mounted plugin slug: ' . $entrypoint);
    }

    $relative = substr($entrypoint, strlen($plugin_slug) + 1);
    $file = rtrim($plugin_path, '/') . '/' . $relative;
    $real = realpath($file);
    $plugin_real = realpath($plugin_path);
    if ($real === false || $plugin_real === false || strpos($real, rtrim($plugin_real, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR) !== 0 || !is_file($real) || !is_readable($real)) {
        throw new RuntimeException('manifest component entrypoint is not readable under mounted plugin path: ' . $entrypoint);
    }

    return $real;
}

function pg_plugin_real_path(string $relative_path, string $kind): ?string {
    global $plugin_path;
    $relative_path = trim(str_replace('\\\\', '/', $relative_path));
    if ($relative_path === '' || strpos($relative_path, '..') !== false || strpos($relative_path, "\0") !== false) {
        pg_log('NOTICE:invalid ' . $kind . ' path: ' . var_export($relative_path, true));
        return null;
    }
    $path = $plugin_path . '/' . ltrim($relative_path, '/');
    $real = realpath($path);
    $plugin_real = realpath($plugin_path);
    if ($real === false || $plugin_real === false || strpos($real, rtrim($plugin_real, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR) !== 0 || !is_file($real)) {
        pg_log('NOTICE:' . $kind . ' file not found under plugin path: ' . $relative_path);
        return null;
    }
    return $real;
}

function pg_project_bootstrap_from_config(string $xml_path): string {
    if (!is_readable($xml_path) && basename($xml_path) === 'phpunit.xml.dist') {
        $alternate = dirname($xml_path) . '/phpunit.xml';
        if (is_readable($alternate)) {
            $xml_path = $alternate;
        }
    }
    if (!is_readable($xml_path)) {
        return '';
    }
    $prev = libxml_use_internal_errors(true);
    $xml = @simplexml_load_file($xml_path);
    libxml_clear_errors();
    libxml_use_internal_errors($prev);
    if ($xml === false) {
        return '';
    }
    return trim((string) ($xml['bootstrap'] ?? ''));
}

function pg_project_bootstrap_real_path(string $bootstrap, string $xml_path, bool $from_config): ?string {
    if ($from_config) {
        $xml_real = realpath($xml_path);
        if ($xml_real === false) {
            return null;
        }

        $base_dir = dirname($xml_real);
        $candidate = $bootstrap !== '' && $bootstrap[0] === '/' ? $bootstrap : $base_dir . '/' . $bootstrap;
        $real = realpath($candidate);
        $base_real = realpath($base_dir);
        if ($real === false || $base_real === false || !is_file($real) || !is_readable($real)) {
            return null;
        }

        $base_parent = dirname($base_real);
        if ($real !== $base_parent && strpos($real, rtrim($base_parent, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR) !== 0) {
            return null;
        }

        return $real;
    }

    return pg_plugin_real_path($bootstrap, 'project bootstrap');
}

function pg_prepare_project_bootstrap_environment(string $config_path): void {
    global $tests_dir;
    $tests_dir = rtrim($tests_dir, '/');
    foreach (array(
        'WP_TESTS_DIR' => $tests_dir,
        'WP_TESTS_CONFIG_FILE_PATH' => $config_path,
        'WP_PHPUNIT__TESTS_CONFIG' => $config_path,
    ) as $name => $value) {
        putenv($name . '=' . $value);
        $_ENV[$name] = $value;
        $_SERVER[$name] = $value;
    }
}

function pg_skip_project_bootstrap_shell_install(): void {
    putenv('WP_TESTS_SKIP_INSTALL=1');
    $_ENV['WP_TESTS_SKIP_INSTALL'] = '1';
    $_SERVER['WP_TESTS_SKIP_INSTALL'] = '1';
    pg_log('NOTICE:using existing Playground install; project bootstrap shell install skipped');
}

function pg_run_project_bootstrap_stage(array $cfg): void {
    global $pg_stage_output_buffering;
    pg_stage_begin('project_bootstrap');
    try {
        $bootstrap = trim((string) ($cfg['project_bootstrap'] ?? ''));
        $phpunit_xml = (string) ($cfg['phpunit_xml'] ?? '');
        $from_config = false;
        if ($bootstrap === '') {
            $bootstrap = pg_project_bootstrap_from_config($phpunit_xml);
            $from_config = $bootstrap !== '';
        }
        $bootstrap_real = pg_project_bootstrap_real_path($bootstrap, $phpunit_xml, $from_config);
        if ($bootstrap_real === null) {
            throw new RuntimeException('project bootstrap not found; pass project-bootstrap=<relative path> or declare phpunit bootstrap');
        }
        pg_log('PROJECT_BOOTSTRAP:' . $bootstrap);
        $pg_stage_output_buffering = true;
        ob_start();
        require_once $bootstrap_real;
        while (ob_get_level() > 0) {
            @ob_end_clean();
        }
        $pg_stage_output_buffering = false;
        pg_stage_ok('project_bootstrap');
    } catch (Throwable $e) {
        $pg_stage_output_buffering = false;
        pg_stage_fail('project_bootstrap', $e);
        exit(1);
    }
}

function pg_run_project_autoload_stage(string $project_autoload_file): void {
    $project_autoload_file = trim(str_replace('\\\\', '/', $project_autoload_file));
    if ($project_autoload_file === '') {
        return;
    }
    pg_stage_begin('project_autoload');
    try {
        $real = realpath($project_autoload_file);
        if ($real === false || !is_file($real) || !is_readable($real)) {
            throw new RuntimeException('project autoload file is not readable: ' . $project_autoload_file);
        }
        pg_log('PROJECT_AUTOLOAD:' . $project_autoload_file);
        require_once $real;
        pg_stage_ok('project_autoload');
    } catch (Throwable $e) {
        pg_stage_fail('project_autoload', $e);
        exit(1);
    }
}

function pg_run_install_stage(array $cfg) {
    global $argv, $pg_stage_output_buffering;
    pg_stage_begin('install');
    try {
        $tests_dir = $cfg['tests_dir'];
        $config_path = $cfg['config_path'];
        $ms_tests = !empty($cfg['multisite']) ? 'run_ms_tests' : 'no_ms_tests';
        $argv = array('install.php', $config_path, $ms_tests, 'no_core_tests');
        $_SERVER['argv'] = $argv;
        $pg_stage_output_buffering = true;
        ob_start();
        require_once $tests_dir . '/includes/install.php';
        while (ob_get_level() > 0) {
            @ob_end_clean();
        }
        $pg_stage_output_buffering = false;
        pg_stage_ok('install');
    } catch (Throwable $e) {
        $pg_stage_output_buffering = false;
        pg_stage_fail('install', $e);
        exit(1);
    }
}

function pg_run_load_deps_stage(array $cfg): array {
    pg_stage_begin('load_deps');
    try {
        $loaded = array();
        foreach (explode("\n", (string) ($cfg['dep_mounts'] ?? '')) as $dep_mount) {
            $dep_mount = trim($dep_mount);
            if ($dep_mount === '') {
                continue;
            }
            foreach (glob($dep_mount . '/*.php') ?: array() as $dep_file) {
                if (basename($dep_file) === 'db.php') {
                    continue;
                }
                if (strpos(file_get_contents($dep_file), 'Plugin Name:') !== false) {
                    require_once $dep_file;
                    $loaded[] = $dep_file;
                    break;
                }
            }
        }
        pg_stage_ok('load_deps');
        return $loaded;
    } catch (Throwable $e) {
        pg_stage_fail('load_deps', $e);
        exit(1);
    }
}

function pg_run_load_component_stage(array $cfg): ?string {
    pg_stage_begin('load_component');
    try {
        $plugin_path = $cfg['plugin_path'];
        $plugin_slug = (string) ($cfg['plugin_slug'] ?? basename($plugin_path));
        $loaded_file = null;
        $style_css = $plugin_path . '/style.css';
        if (file_exists($style_css) && strpos(file_get_contents($style_css), 'Theme Name:') !== false) {
            pg_log('THEME_DETECTED');
            if (file_exists($plugin_path . '/functions.php')) {
                require_once $plugin_path . '/functions.php';
            }
        } else {
            $manifest_file = pg_manifest_component_plugin_file($plugin_slug, $plugin_path);
            foreach ($manifest_file !== null ? array($manifest_file) : (glob($plugin_path . '/*.php') ?: array()) as $main_file) {
                if (basename($main_file) === 'db.php') {
                    continue;
                }
                if ($manifest_file !== null || strpos(file_get_contents($main_file), 'Plugin Name:') !== false) {
                    pg_log('PLUGIN_DETECTED ' . basename($main_file));
                    pg_log('PLUGIN_LOAD_CONTEXT ' . basename($main_file) . ' activate=false ' . pg_diagnostic_context());
                    require_once $main_file;
                    $loaded_file = $main_file;
                    break;
                }
            }
            if ($loaded_file === null) {
                pg_log("NOTICE:no plugin entry file with 'Plugin Name:' header found in " . $plugin_path);
            }
        }
        pg_stage_ok('load_component');
        return $loaded_file;
    } catch (Throwable $e) {
        pg_stage_fail('load_component', $e);
        exit(1);
    }
}

function pg_run_activation_stage(array $cfg): void {
    pg_stage_begin('activation');
    try {
        foreach (($cfg['plugin_files'] ?? array()) as $plugin_file) {
            if (is_string($plugin_file) && $plugin_file !== '') {
                pg_activate_plugin_file($plugin_file, !empty($cfg['multisite']));
            }
        }
        pg_stage_ok('activation');
    } catch (Throwable $e) {
        pg_stage_fail('activation', $e);
        exit(1);
    }
}

function pg_activate_plugin_file(string $plugin_file, bool $network_wide): void {
    if (!function_exists('plugin_basename') || !function_exists('do_action')) {
        pg_log('NOTICE:cannot activate plugin entry before WordPress plugin API is available: ' . $plugin_file);
        return;
    }
    $plugin_basename = plugin_basename($plugin_file);
    pg_log('PLUGIN_ACTIVATE ' . $plugin_basename . ($network_wide ? ' network_wide=1' : ''));
    pg_log('PLUGIN_ACTIVATE_BEGIN ' . $plugin_basename . ' ' . pg_diagnostic_context());
    do_action('activate_' . $plugin_basename, $network_wide);
    pg_mark_plugin_active($plugin_basename, $network_wide);
    do_action('activated_plugin', $plugin_basename, false, $network_wide);
    pg_log('PLUGIN_ACTIVATE_OK ' . $plugin_basename . ' ' . pg_diagnostic_context());
}

function pg_mark_plugin_active(string $plugin_basename, bool $network_wide): void {
    if ($network_wide && function_exists('get_site_option') && function_exists('update_site_option')) {
        $active_plugins = (array) get_site_option('active_sitewide_plugins', array());
        $active_plugins[$plugin_basename] = time();
        update_site_option('active_sitewide_plugins', $active_plugins);
        return;
    }
    if (!function_exists('get_option') || !function_exists('update_option')) {
        return;
    }
    $active_plugins = (array) get_option('active_plugins', array());
    if (!in_array($plugin_basename, $active_plugins, true)) {
        $active_plugins[] = $plugin_basename;
        sort($active_plugins);
        update_option('active_plugins', array_values($active_plugins));
    }
}

${phpunitChangedTestFilterPhp({
    relativeFunctionName: "pg_component_relative_path",
    filterFunctionName: "pg_filter_changed_test_files",
    logFunction: "pg_log",
    rootParameterName: "plugin_path",
    testsPathFallback: true,
    emptyWantedNotice: true,
  })}

pg_install_diagnostics_handlers();

pg_stage_begin('cwd');
try {
    $runtime_cwd = pg_resolve_runtime_cwd($runtime_cwd, $plugin_path);
    $test_root = pg_resolve_test_root($test_root, $plugin_path);
    chdir($runtime_cwd);
    pg_log('CWD:' . $runtime_cwd);
    pg_log('TEST_ROOT:' . $test_root);
    pg_stage_ok('cwd');
} catch (Throwable $e) {
    pg_stage_fail('cwd', $e);
    exit(1);
}

pg_apply_env($bench_env);

if (!is_array($wp_config_defines)) {
    $wp_config_defines = array();
}
if ($multisite) {
    $wp_config_defines += array(
        'WP_TESTS_MULTISITE' => true,
        'MULTISITE' => true,
        'SUBDOMAIN_INSTALL' => false,
        'DOMAIN_CURRENT_SITE' => 'example.org',
        'PATH_CURRENT_SITE' => '/',
        'SITE_ID_CURRENT_SITE' => 1,
        'BLOG_ID_CURRENT_SITE' => 1,
    );
    putenv('WP_MULTISITE=1');
    $_ENV['WP_MULTISITE'] = '1';
}

$legacy_project_autoload_file = '';
if ($bootstrap_mode === 'project' && $project_autoload_file === '' && $autoload_file !== '' && $autoload_file !== '/wp-codebox-vendor/autoload.php') {
    $legacy_project_autoload_file = $autoload_file;
}
$harness_autoload_file = $legacy_project_autoload_file !== '' ? '/wp-codebox-vendor/autoload.php' : $autoload_file;

$config_path = pg_run_boot_stage(array('extra_defines' => $wp_config_defines, 'table_prefix' => $bootstrap_mode === 'project' ? 'wp_' : 'wptests_', 'autoload_file' => $harness_autoload_file, 'autoload_required' => $bootstrap_mode !== 'project' || $harness_autoload_file !== ''));
if ($bootstrap_mode === 'project') {
    pg_prepare_project_bootstrap_environment($config_path);
    pg_skip_project_bootstrap_shell_install();
    pg_run_project_bootstrap_stage(array('project_bootstrap' => $project_bootstrap, 'phpunit_xml' => ${JSON.stringify(options.phpunitXml)}));
    pg_run_project_autoload_stage($project_autoload_file !== '' ? $project_autoload_file : $legacy_project_autoload_file);
} else {
    if ($bootstrap_mode !== 'managed') {
        pg_log('NOTICE:unknown bootstrap-mode ' . var_export($bootstrap_mode, true) . '; using managed');
    }
$pre_component_plugins_loaded_callbacks = pg_snapshot_wordpress_hook_callbacks('plugins_loaded');
$pre_component_init_callbacks = pg_snapshot_wordpress_hook_callbacks('init');
$pre_component_shutdown_callbacks = pg_snapshot_wordpress_hook_callbacks('shutdown');
$deferred_install_plugins_loaded_callbacks = array();
$deferred_install_init_callbacks = array();
$loaded_dep_files = array();
$loaded_component_file = null;

require_once $tests_dir . '/includes/functions.php';
tests_add_filter('muplugins_loaded', function () use ($plugin_slug, $plugin_path, $dep_mounts, $pre_component_plugins_loaded_callbacks, $pre_component_init_callbacks, &$deferred_install_plugins_loaded_callbacks, &$deferred_install_init_callbacks, &$loaded_dep_files, &$loaded_component_file) {
    $loaded_dep_files = pg_run_load_deps_stage(array('dep_mounts' => $dep_mounts));
    $loaded_component_file = pg_run_load_component_stage(array('plugin_slug' => $plugin_slug, 'plugin_path' => $plugin_path, 'activate' => false));
    $deferred_install_plugins_loaded_callbacks = pg_defer_new_wordpress_hook_callbacks('plugins_loaded', $pre_component_plugins_loaded_callbacks);
    $deferred_install_init_callbacks = pg_defer_new_wordpress_hook_callbacks('init', $pre_component_init_callbacks);
});

pg_run_install_stage(array('config_path' => $config_path, 'tests_dir' => $tests_dir, 'multisite' => $multisite));
pg_remove_new_wordpress_hook_callbacks('shutdown', $pre_component_shutdown_callbacks);
$activation_files = $loaded_dep_files;
if ($loaded_component_file !== null) {
    $activation_files[] = $loaded_component_file;
}
pg_run_activation_stage(array('plugin_files' => $activation_files, 'multisite' => $multisite));

$pre_replayed_plugins_loaded_init_callbacks = pg_snapshot_wordpress_hook_callbacks('init');
$reopened_ability_categories_init = pg_reopen_wordpress_action('wp_abilities_api_categories_init');
$reopened_ability_init = pg_reopen_wordpress_action('wp_abilities_api_init');
pg_run_deferred_wordpress_hook_callbacks($deferred_install_plugins_loaded_callbacks, array(), 'plugins_loaded');
$deferred_install_init_callbacks = array_merge($deferred_install_init_callbacks, pg_defer_new_wordpress_hook_callbacks('init', $pre_replayed_plugins_loaded_init_callbacks));
usort($deferred_install_init_callbacks, static function (array $left, array $right): int {
    return ($left['priority'] ?? 10) <=> ($right['priority'] ?? 10);
});
pg_run_deferred_wordpress_hook_callbacks($deferred_install_init_callbacks, array(), 'init');
pg_fire_reopened_wordpress_action('wp_abilities_api_categories_init', $reopened_ability_categories_init);
pg_fire_reopened_wordpress_action('wp_abilities_api_init', $reopened_ability_init);
pg_fire_runtime_abilities_ready();

pg_stage_begin('load_fixtures');
try {
    global $phpmailer;
    require_once $tests_dir . '/includes/mock-mailer.php';
    $phpmailer = new MockPHPMailer(true);
    require_once $tests_dir . '/includes/functions.php';
    $GLOBALS['_wp_die_disabled'] = false;
    tests_add_filter('wp_die_handler', '_wp_die_handler_filter');
    tests_add_filter('wp_rest_server_class', '_wp_rest_server_class_filter');
    tests_add_filter('async_update_translation', '__return_false');
    tests_add_filter('automatic_updater_disabled', '__return_true');
    foreach (array('phpunit6/compat.php', 'phpunit-adapter-testcase.php', 'abstract-testcase.php', 'testcase.php', 'testcase-rest-api.php', 'testcase-rest-controller.php', 'testcase-rest-post-type-controller.php', 'testcase-xmlrpc.php', 'testcase-ajax.php', 'testcase-canonical.php', 'testcase-xml.php', 'exceptions.php', 'utils.php', 'spy-rest-server.php', 'class-wp-rest-test-search-handler.php', 'class-wp-rest-test-configurable-controller.php', 'class-wp-fake-block-type.php', 'class-wp-fake-hasher.php', 'class-wp-sitemaps-test-provider.php', 'class-wp-sitemaps-empty-test-provider.php', 'class-wp-sitemaps-large-test-provider.php') as $file) {
        require_once $tests_dir . '/includes/' . $file;
    }
    pg_stage_ok('load_fixtures');
} catch (Throwable $e) {
    pg_stage_fail('load_fixtures', $e);
    exit(1);
}

pg_stage_begin('load_bootstrap_files');
try {
    if (is_array($bootstrap_files)) {
        foreach ($bootstrap_files as $bootstrap_file) {
            if (!is_string($bootstrap_file) || $bootstrap_file === '' || strpos($bootstrap_file, '..') !== false) {
                pg_log('NOTICE:skipping invalid bootstrap file entry: ' . var_export($bootstrap_file, true));
                continue;
            }
            $bootstrap_path = $plugin_path . '/' . ltrim($bootstrap_file, '/');
            $bootstrap_real = realpath($bootstrap_path);
            $plugin_real = realpath($plugin_path);
            if ($bootstrap_real === false || $plugin_real === false || strpos($bootstrap_real, rtrim($plugin_real, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR) !== 0 || !is_file($bootstrap_real)) {
                pg_log('NOTICE:bootstrap file not found under plugin path: ' . $bootstrap_file);
                continue;
            }
            pg_log('BOOTSTRAP_FILE:' . $bootstrap_file);
            require_once $bootstrap_real;
        }
    }
    pg_stage_ok('load_bootstrap_files');
} catch (Throwable $e) {
    pg_stage_fail('load_bootstrap_files', $e);
    exit(1);
}

pg_stage_begin('load_preload_files');
try {
    if (is_array($preload_files)) {
        foreach ($preload_files as $preload_file) {
            if (!is_string($preload_file) || $preload_file === '' || strpos($preload_file, '..') !== false || $preload_file[0] !== '/') {
                pg_log('NOTICE:skipping invalid preload file entry: ' . var_export($preload_file, true));
                continue;
            }
            $preload_real = realpath($preload_file);
            if ($preload_real === false || strpos($preload_real, '/wordpress/') !== 0 || !is_file($preload_real)) {
                pg_log('NOTICE:preload file not found under /wordpress: ' . $preload_file);
                continue;
            }
            pg_log('PRELOAD_FILE:' . $preload_file);
            require_once $preload_real;
        }
    }
    pg_stage_ok('load_preload_files');
} catch (Throwable $e) {
    pg_stage_fail('load_preload_files', $e);
    exit(1);
}
}

${phpunitConfigDiscoveryPhp({
    functionName: "wp_codebox_phpunit_parse_config",
    logFunction: "pg_log",
    missingConfigMessage: "NOTICE:phpunit.xml.dist not readable at ",
    parseFailureMessage: "NOTICE:phpunit.xml.dist parse failed (",
    includeParseFailureDetail: true,
    loadedConfigMessage: "NOTICE:phpunit.xml.dist loaded from ",
    fallbackXmlDist: true,
    restrictDirectoriesToTests: !options.testRoot,
    basePathExpression: "dirname($xml_path)",
    uniqueReturnValues: false,
    replaceDefaultMatchers: true,
  })}

${phpunitDiscoveryPhp("wp_codebox_phpunit_discover", "pg_log")}

pg_stage_begin('discover_tests');
try {
    $test_dir = $test_root;
    if (!is_dir($test_dir)) {
        pg_log('NO_TEST_FILES');
        pg_log('NOTICE:tests directory not found at ' . $test_dir);
        pg_stage_ok('discover_tests');
        exit(1);
    }
    list($directories, $suffixes, $prefixes, $excludes, $configured_files) = wp_codebox_phpunit_parse_config(${JSON.stringify(options.phpunitXml)}, $test_dir);
    $test_files = wp_codebox_phpunit_discover($directories, $suffixes, $prefixes, $excludes, $configured_files);
    $test_files = pg_filter_changed_test_files($test_files, $changed_test_files_raw, $test_dir);
    if ($selected_test_file !== '') {
        $selected_abs = $selected_test_file[0] === '/' ? $selected_test_file : $test_dir . '/' . ltrim($selected_test_file, '/');
        if (!in_array($selected_abs, $test_files, true)) {
            $selected_real = realpath($selected_abs);
            $tests_real = realpath($test_dir);
            if ($selected_real === false || $tests_real === false || strpos($selected_real, rtrim($tests_real, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR) !== 0 || !is_file($selected_real)) {
                pg_log('NO_TEST_FILES');
                pg_log('NOTICE:requested PHPUnit test file not found under tests/: ' . $selected_test_file);
                pg_stage_ok('discover_tests');
                exit(1);
            }
            pg_log('NOTICE:using explicitly requested PHPUnit test file outside discovery set: ' . $selected_test_file);
            $selected_abs = $selected_real;
        }
        $test_files = array($selected_abs);
    }
    pg_log('DISCOVERY: dirs=' . implode(',', $directories) . ' files=' . count($configured_files) . ' suffixes=' . implode(',', $suffixes) . ' prefixes=' . implode(',', $prefixes) . ' excludes=' . count($excludes) . ' found=' . count($test_files));
    if (empty($test_files)) {
        pg_log('NO_TEST_FILES');
        pg_stage_ok('discover_tests');
        exit(1);
    }
    pg_stage_ok('discover_tests');
} catch (Throwable $e) {
    pg_stage_fail('discover_tests', $e);
    exit(1);
}

pg_stage_begin('load_tests');
$suite = new PHPUnit\\Framework\\TestSuite('WP Codebox PHPUnit Tests');
$before_classes = get_declared_classes();
try {
    foreach ($test_files as $test_file) {
        require_once $test_file;
    }
} catch (Throwable $e) {
    pg_stage_fail('load_tests', $e);
    exit(1);
}
$after_classes = get_declared_classes();
foreach (array_diff($after_classes, $before_classes) as $class_name) {
    try {
        $ref = new ReflectionClass($class_name);
        if (!$ref->isAbstract() && $ref->isSubclassOf('PHPUnit\\Framework\\TestCase')) {
            $suite->addTestSuite($class_name);
        }
    } catch (Throwable $e) {
        pg_log('NOTICE:reflection failed for ' . $class_name . ': ' . $e->getMessage());
    }
}
pg_stage_ok('load_tests');

${phpunitArgsPhp("wp_codebox_phpunit_args", "pg_log")}

function wp_codebox_phpunit_print_test_list($test) {
    if ($test instanceof PHPUnit\\Framework\\TestSuite) {
        foreach ($test->tests() as $child) {
            wp_codebox_phpunit_print_test_list($child);
        }
        return;
    }
    if ($test instanceof PHPUnit\\Framework\\TestCase) {
        echo get_class($test) . '::' . $test->getName() . PHP_EOL;
    }
}

pg_stage_begin('run_tests');
pg_log('RUNNING ' . count($test_files) . ' TEST FILES');
try {
    $phpunit_argv = array('phpunit');
    if (is_array($phpunit_args_raw)) {
        foreach ($phpunit_args_raw as $arg) {
            if (is_scalar($arg)) {
                $phpunit_argv[] = (string) $arg;
            }
        }
    }
    $phpunit_args = wp_codebox_phpunit_args($phpunit_argv);
    if (!empty($phpunit_args['listTests'])) {
        wp_codebox_phpunit_print_test_list($suite);
        pg_log('ALL TESTS PASSED');
        pg_log('TESTS: ' . $suite->count() . ' FAILURES: 0 ERRORS: 0');
        pg_stage_ok('run_tests');
        exit(0);
    }
    $runner = new PHPUnit\\TextUI\\TestRunner();
    $result = $runner->run($suite, $phpunit_args);
    pg_log($result->wasSuccessful() ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED');
    pg_log('TESTS: ' . $result->count() . ' FAILURES: ' . count($result->failures()) . ' ERRORS: ' . count($result->errors()));
    pg_stage_ok('run_tests');
    exit($result->wasSuccessful() ? 0 : 1);
} catch (Throwable $e) {
    pg_stage_fail('run_tests', $e);
    exit(1);
}`
}

export function corePhpunitRunCode(options: CorePhpunitRunCodeOptions): string {
  return `error_reporting(E_ALL);
ini_set('display_errors', '1');
ini_set('display_startup_errors', '1');

$core_root = rtrim(${JSON.stringify(options.coreRoot)}, '/');
$tests_dir = rtrim(${JSON.stringify(options.testsDir)}, '/');
$phpunit_xml = ${JSON.stringify(options.phpunitXml)};
$selected_test_file = ${JSON.stringify(options.selectedTestFile)};
$changed_test_files_raw = ${JSON.stringify(JSON.stringify(options.changedTestFiles))};
$autoload_file = ${JSON.stringify(options.autoloadFile)};
$wp_config_defines = json_decode(${JSON.stringify(JSON.stringify(options.wpConfigDefines))}, true);
$multisite = ${JSON.stringify(options.multisite)};
$result_file = ${JSON.stringify(options.resultFile ?? CORE_PHPUNIT_RESULT_FILE)};
$current_stage = 'preboot';
@file_put_contents($result_file, '');

function core_pg_log($msg) {
    global $result_file;
    file_put_contents($result_file, $msg . "\n", FILE_APPEND);
}

${phpWpConfigDefineAppenderFunction("core_pg_append_wp_config_defines", undefined, false)}

function core_pg_stage_begin($stage) {
    global $current_stage;
    $current_stage = $stage;
    core_pg_log('STAGE_BEGIN:' . $stage);
}

function core_pg_stage_ok($stage) {
    core_pg_log('STAGE_OK:' . $stage);
}

function core_pg_stage_fail($stage, Throwable $e) {
    core_pg_log('STAGE_FAIL:' . $stage . ':' . get_class($e) . ': ' . $e->getMessage() . ' at ' . $e->getFile() . ':' . $e->getLine());
    core_pg_log('TRACE:');
    foreach (explode("\n", $e->getTraceAsString()) as $line) {
        core_pg_log('  ' . $line);
    }
}

function core_pg_install_diagnostics_handlers() {
    set_error_handler(function ($severity, $message, $file, $line) {
        if (!(error_reporting() & $severity)) {
            return false;
        }
        core_pg_log('NOTICE:E_' . $severity . ': ' . $message . ' at ' . $file . ':' . $line);
        return false;
    });
    register_shutdown_function(function () {
        global $current_stage, $core_pg_bootstrap_buffering;
        // WordPress core's tests/phpunit/includes/bootstrap.php can die() mid-require
        // (e.g. "Looks like you're using PHPUnit 0") when the Composer test toolchain
        // is absent. die() is not catchable, so capture whatever it printed via the
        // output buffer started around the bootstrap require and flush it here so the
        // TS layer always gets a structured diagnostic instead of an empty crash (#314).
        if (!empty($core_pg_bootstrap_buffering)) {
            $buffered = '';
            while (ob_get_level() > 0) {
                $chunk = ob_get_clean();
                if ($chunk !== false) {
                    $buffered = $chunk . $buffered;
                }
            }
            $buffered = trim($buffered);
            if ($buffered !== '') {
                core_pg_log('STAGE_DIE:' . $current_stage . ':' . $buffered);
            }
        }
        $error = error_get_last();
        if ($error && in_array($error['type'], array(E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR), true)) {
            core_pg_log('STAGE_FATAL:' . $current_stage . ':' . $error['message'] . ' at ' . $error['file'] . ':' . $error['line']);
        }
    });
}

/**
 * Pre-flight the Composer test toolchain that WordPress core's
 * tests/phpunit/includes/bootstrap.php hard-requires. Returns a precise,
 * human-readable failure message when something is missing, or null when the
 * required paths are present. Mirrors the polyfills + PHPUnit checks the core
 * bootstrap performs before it die()s (#314).
 */
function core_pg_preflight_core_toolchain(string $core_root, string $tests_dir, string $autoload_file): ?string {
    $bootstrap = $tests_dir . '/includes/bootstrap.php';
    if (!is_readable($bootstrap)) {
        return 'core PHPUnit tests bootstrap not found or unreadable at ' . $bootstrap
            . '; ensure the mounted checkout is a wordpress-develop tree with tests/phpunit/includes/bootstrap.php.';
    }

    $vendor_autoload = $core_root . '/vendor/autoload.php';
    $polyfills_autoload = $core_root . '/vendor/yoast/phpunit-polyfills/phpunitpolyfills-autoload.php';
    $missing = array();
    if (!is_readable($vendor_autoload)) {
        $missing[] = 'Composer autoload (' . $vendor_autoload . ')';
    }
    if (!is_readable($polyfills_autoload)) {
        $missing[] = 'Yoast PHPUnit Polyfills autoload (' . $polyfills_autoload . ')';
    }
    if (!is_readable($autoload_file)) {
        $missing[] = 'configured autoload-file (' . $autoload_file . ')';
    }

    if (empty($missing)) {
        return null;
    }

    return 'core PHPUnit requires Composer dev dependencies (PHPUnit + yoast/phpunit-polyfills) in the mounted checkout, but the following are missing: '
        . implode('; ', $missing)
        . '. Run \`composer install\` (or \`composer update -W\`) in the wordpress-develop checkout before mounting it, or mount a checkout that already has vendor/ installed. '
        . "WordPress core's tests/phpunit/includes/bootstrap.php die()s without these, which is why this fails before any tests run.";
}

function core_pg_write_tests_config(string $core_root, array $extra_defines): string {
    $config_path = $core_root . '/wp-tests-config.php';
    if (is_readable($config_path)) {
        return $config_path;
    }

    $config = "<?php\n";
    core_pg_append_wp_config_defines($config, $extra_defines);
    $config .= "\n";
    $config .= "define('DB_NAME', ':memory:');\n";
    $config .= "define('DB_USER', 'root');\n";
    $config .= "define('DB_PASSWORD', '');\n";
    $config .= "define('DB_HOST', 'localhost');\n";
    $config .= "define('DB_CHARSET', 'utf8');\n";
    $config .= "define('DB_COLLATE', '');\n";
    $config .= "define('WP_TESTS_DOMAIN', 'example.org');\n";
    $config .= "define('WP_TESTS_EMAIL', 'admin@example.org');\n";
    $config .= "define('WP_TESTS_TITLE', 'Test Blog');\n";
    $config .= "define('WP_PHP_BINARY', 'php');\n";
    $config .= "define('WP_RUN_CORE_TESTS', true);\n";
    $config .= "define('ABSPATH', '" . addslashes($core_root) . "/');\n";
    $config .= "define('FS_METHOD', 'direct');\n";
    $config .= "\$table_prefix = 'wptests_';\n";
    file_put_contents($config_path, $config);

    return $config_path;
}

${phpunitConfigDiscoveryPhp({
    functionName: "core_pg_parse_phpunit_config",
    logFunction: "core_pg_log",
    missingConfigMessage: "NOTICE:phpunit config not readable at ",
    parseFailureMessage: "NOTICE:phpunit config parse failed; using defaults",
    includeParseFailureDetail: false,
    loadedConfigMessage: "NOTICE:phpunit config loaded from ",
    fallbackXmlDist: false,
    restrictDirectoriesToTests: false,
    basePathExpression: "dirname($xml_path)",
    uniqueReturnValues: true,
    replaceDefaultMatchers: false,
  })}

${phpunitDiscoveryPhp("core_pg_discover_tests", "core_pg_log")}

${phpunitChangedTestFilterPhp({
    relativeFunctionName: "core_pg_relative_path",
    filterFunctionName: "core_pg_filter_changed_test_files",
    logFunction: "core_pg_log",
    rootParameterName: "core_root",
    testsPathFallback: false,
    emptyWantedNotice: false,
  })}

${phpunitArgsPhp("core_pg_phpunit_args", "core_pg_log")}

core_pg_install_diagnostics_handlers();

core_pg_stage_begin('boot');
try {
    if (!is_dir($core_root)) {
        throw new RuntimeException('core root is not a directory: ' . $core_root);
    }
    if (!is_dir($tests_dir)) {
        throw new RuntimeException('core tests directory is not a directory: ' . $tests_dir);
    }
    $preflight_error = core_pg_preflight_core_toolchain($core_root, $tests_dir, $autoload_file);
    if ($preflight_error !== null) {
        throw new RuntimeException($preflight_error);
    }
    if (!is_array($wp_config_defines)) {
        $wp_config_defines = array();
    }
    if ($multisite) {
        $wp_config_defines += array(
            'WP_TESTS_MULTISITE' => true,
            'MULTISITE' => true,
            'SUBDOMAIN_INSTALL' => false,
            'DOMAIN_CURRENT_SITE' => 'example.org',
            'PATH_CURRENT_SITE' => '/',
            'SITE_ID_CURRENT_SITE' => 1,
            'BLOG_ID_CURRENT_SITE' => 1,
        );
        putenv('WP_MULTISITE=1');
        $_ENV['WP_MULTISITE'] = '1';
    }
    require_once $autoload_file;
    $config_path = core_pg_write_tests_config($core_root, $wp_config_defines);
    define('WP_TESTS_CONFIG_FILE_PATH', $config_path);
    core_pg_stage_ok('boot');
} catch (Throwable $e) {
    core_pg_stage_fail('boot', $e);
    exit(1);
}

core_pg_stage_begin('bootstrap');
// WordPress core's bootstrap.php can die() mid-require if the test toolchain is
// incomplete. die() is not a Throwable, so the catch below never runs; instead the
// shutdown handler flushes this buffer + the current stage to the result file so we
// still surface a structured diagnostic rather than an empty crash (#314).
$core_pg_bootstrap_buffering = true;
ob_start();
try {
    require_once $tests_dir . '/includes/bootstrap.php';
    $core_pg_bootstrap_buffering = false;
    while (ob_get_level() > 0) {
        ob_end_clean();
    }
    core_pg_stage_ok('bootstrap');
} catch (Throwable $e) {
    $core_pg_bootstrap_buffering = false;
    while (ob_get_level() > 0) {
        ob_end_clean();
    }
    core_pg_stage_fail('bootstrap', $e);
    exit(1);
}

core_pg_stage_begin('discover_tests');
try {
    list($directories, $suffixes, $prefixes, $excludes, $configured_files) = core_pg_parse_phpunit_config($phpunit_xml, $tests_dir . '/tests');
    $test_files = core_pg_discover_tests($directories, $suffixes, $prefixes, $excludes, $configured_files);
    $test_files = core_pg_filter_changed_test_files($test_files, $changed_test_files_raw, $core_root);
    if ($selected_test_file !== '') {
        $selected_abs = $selected_test_file[0] === '/' ? $selected_test_file : $core_root . '/' . ltrim($selected_test_file, '/');
        if (!in_array($selected_abs, $test_files, true)) {
            core_pg_log('NO_TEST_FILES');
            core_pg_log('NOTICE:requested PHPUnit test file not discovered: ' . $selected_test_file);
            core_pg_stage_ok('discover_tests');
            exit(1);
        }
        $test_files = array($selected_abs);
    }
    core_pg_log('DISCOVERY: dirs=' . implode(',', $directories) . ' files=' . count($configured_files) . ' suffixes=' . implode(',', $suffixes) . ' prefixes=' . implode(',', $prefixes) . ' excludes=' . count($excludes) . ' found=' . count($test_files));
    if (empty($test_files)) {
        core_pg_log('NO_TEST_FILES');
        core_pg_stage_ok('discover_tests');
        exit(1);
    }
    core_pg_stage_ok('discover_tests');
} catch (Throwable $e) {
    core_pg_stage_fail('discover_tests', $e);
    exit(1);
}

core_pg_stage_begin('load_tests');
$suite = new PHPUnit\\Framework\\TestSuite('WP Codebox WordPress Core Tests');
$before_classes = get_declared_classes();
try {
    foreach ($test_files as $test_file) {
        require_once $test_file;
    }
} catch (Throwable $e) {
    core_pg_stage_fail('load_tests', $e);
    exit(1);
}
$after_classes = get_declared_classes();
foreach (array_diff($after_classes, $before_classes) as $class_name) {
    try {
        $ref = new ReflectionClass($class_name);
        if (!$ref->isAbstract() && $ref->isSubclassOf('PHPUnit\\Framework\\TestCase')) {
            $suite->addTestSuite($class_name);
        }
    } catch (Throwable $e) {
        core_pg_log('NOTICE:reflection failed for ' . $class_name . ': ' . $e->getMessage());
    }
}
core_pg_stage_ok('load_tests');

core_pg_stage_begin('run_tests');
core_pg_log('RUNNING ' . count($test_files) . ' TEST FILES');
try {
    $phpunit_args = core_pg_phpunit_args($argv ?? array());
    $runner = new PHPUnit\\TextUI\\TestRunner();
    $result = $runner->run($suite, $phpunit_args);
    core_pg_log($result->wasSuccessful() ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED');
    core_pg_log('TESTS: ' . $result->count() . ' FAILURES: ' . count($result->failures()) . ' ERRORS: ' . count($result->errors()));
    core_pg_stage_ok('run_tests');
    exit($result->wasSuccessful() ? 0 : 1);
} catch (Throwable $e) {
    core_pg_stage_fail('run_tests', $e);
    exit(1);
}`
}
