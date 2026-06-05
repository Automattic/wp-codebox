export interface PhpunitRunCodeOptions {
  pluginSlug: string
  autoloadFile: string
  testsDir: string
  phpunitXml: string
  selectedTestFile: string
  changedTestFiles: unknown[]
  phpunitArgs: string[]
  env: Record<string, unknown>
  wpConfigDefines: Record<string, unknown>
  dependencyMounts: string[]
  bootstrapFiles: string[]
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

export function phpunitRunCode(options: PhpunitRunCodeOptions): string {
  return `error_reporting(E_ALL);
ini_set('display_errors', '1');
ini_set('display_startup_errors', '1');

$plugin_slug = ${JSON.stringify(options.pluginSlug)};
$plugin_path = '/wordpress/wp-content/plugins/' . $plugin_slug;
$result_file = ${JSON.stringify(options.resultFile ?? PLUGIN_PHPUNIT_RESULT_FILE)};
$current_stage = 'preboot';
$pg_stage_output_buffering = false;
$autoload_file = ${JSON.stringify(options.autoloadFile)};
$tests_dir = ${JSON.stringify(options.testsDir)};
$selected_test_file = ${JSON.stringify(options.selectedTestFile)};
$changed_test_files_raw = ${JSON.stringify(JSON.stringify(options.changedTestFiles))};
$phpunit_args_raw = json_decode(${JSON.stringify(JSON.stringify(options.phpunitArgs))}, true);
$bench_env = json_decode(${JSON.stringify(JSON.stringify(options.env))}, true);
$wp_config_defines = json_decode(${JSON.stringify(JSON.stringify(options.wpConfigDefines))}, true);
$dep_mounts = ${JSON.stringify(options.dependencyMounts.join("\\n"))};
$bootstrap_files = json_decode(${JSON.stringify(JSON.stringify(options.bootstrapFiles))}, true);
$bootstrap_mode = ${JSON.stringify(options.bootstrapMode || "managed")};
$project_bootstrap = ${JSON.stringify(options.projectBootstrap)};
$multisite = ${JSON.stringify(options.multisite)};

@file_put_contents($result_file, '');

function pg_log($msg) {
    global $result_file;
    file_put_contents($result_file, $msg . "\n", FILE_APPEND);
}

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

function pg_preload_wp_cli_namespaced_functions(): void {
    global $autoload_file;
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
        $extra_defines = $cfg['extra_defines'] ?? array();
        $config_path = '/tmp/wp-tests-config.php';
        $config = "<?php\n";
        if (!empty($extra_defines) && is_array($extra_defines)) {
            $config .= "\n// Recipe-declared wp-config defines.\n";
            foreach ($extra_defines as $name => $value) {
                if (!is_string($name) || !preg_match('/^[A-Z_][A-Z0-9_]*$/i', $name)) {
                    pg_log('NOTICE: skipping invalid wp_config_defines key: ' . var_export($name, true));
                    continue;
                }
                $config .= sprintf("if (!defined('%s')) { define('%s', %s); }\n", $name, $name, var_export($value, true));
            }
        }
        $config .= <<<'CONFIG'
$table_prefix = 'wptests_';
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
        pg_preload_wp_cli_namespaced_functions();
        require_once $autoload_file;
        pg_stage_ok('boot');
        return $config_path;
    } catch (Throwable $e) {
        pg_stage_fail('boot', $e);
        exit(1);
    }
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

function pg_run_project_bootstrap_stage(array $cfg): void {
    pg_stage_begin('project_bootstrap');
    try {
        $bootstrap = trim((string) ($cfg['project_bootstrap'] ?? ''));
        if ($bootstrap === '') {
            $bootstrap = pg_project_bootstrap_from_config((string) ($cfg['phpunit_xml'] ?? ''));
        }
        $bootstrap_real = pg_plugin_real_path($bootstrap, 'project bootstrap');
        if ($bootstrap_real === null) {
            throw new RuntimeException('project bootstrap not found; pass project-bootstrap=<relative path> or declare phpunit bootstrap');
        }
        pg_log('PROJECT_BOOTSTRAP:' . $bootstrap);
        require_once $bootstrap_real;
        pg_stage_ok('project_bootstrap');
    } catch (Throwable $e) {
        pg_stage_fail('project_bootstrap', $e);
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
        $loaded_file = null;
        $style_css = $plugin_path . '/style.css';
        if (file_exists($style_css) && strpos(file_get_contents($style_css), 'Theme Name:') !== false) {
            pg_log('THEME_DETECTED');
            if (file_exists($plugin_path . '/functions.php')) {
                require_once $plugin_path . '/functions.php';
            }
        } else {
            foreach (glob($plugin_path . '/*.php') ?: array() as $main_file) {
                if (basename($main_file) === 'db.php') {
                    continue;
                }
                if (strpos(file_get_contents($main_file), 'Plugin Name:') !== false) {
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

function pg_filter_changed_test_files(array $test_files, string $changed_files_json, string $plugin_path): array {
    $decoded = json_decode($changed_files_json, true);
    if (!is_array($decoded) || empty($decoded)) {
        return $test_files;
    }
    $wanted = array();
    foreach ($decoded as $entry) {
        if (!is_scalar($entry)) {
            continue;
        }
        $normalized = pg_component_relative_path((string) $entry, $plugin_path);
        if ($normalized !== '') {
            $wanted[$normalized] = true;
        }
    }
    if (empty($wanted)) {
        pg_log('NOTICE:changed tests did not contain usable test paths');
        return array();
    }
    $filtered = array();
    foreach ($test_files as $file) {
        if (isset($wanted[pg_component_relative_path((string) $file, $plugin_path)])) {
            $filtered[] = $file;
        }
    }
    pg_log('SCOPED_TEST_FILES requested=' . count($wanted) . ' matched=' . count($filtered));
    return $filtered;
}

function pg_component_relative_path(string $path, string $plugin_path): string {
    $path = trim(str_replace('\\\\', '/', $path));
    $plugin_path = rtrim(str_replace('\\\\', '/', $plugin_path), '/');
    if (strpos($path, $plugin_path . '/') === 0) {
        $path = substr($path, strlen($plugin_path) + 1);
    } elseif (strpos($path, '/tests/') !== false) {
        $path = substr($path, strpos($path, '/tests/') + 1);
    }
    while (strpos($path, './') === 0) {
        $path = substr($path, 2);
    }
    return ltrim($path, '/');
}

pg_install_diagnostics_handlers();

if (is_array($bench_env)) {
    foreach ($bench_env as $name => $value) {
        if (is_string($name) && preg_match('/^[A-Za-z_][A-Za-z0-9_]*$/', $name)) {
            $string_value = is_scalar($value) ? (string) $value : json_encode($value);
            putenv($name . '=' . $string_value);
            $_ENV[$name] = $string_value;
        } else {
            pg_log('NOTICE: skipping invalid bench_env key: ' . var_export($name, true));
        }
    }
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

$config_path = pg_run_boot_stage(array('extra_defines' => $wp_config_defines));
if ($bootstrap_mode === 'project') {
    pg_prepare_project_bootstrap_environment($config_path);
    pg_run_project_bootstrap_stage(array('project_bootstrap' => $project_bootstrap, 'phpunit_xml' => ${JSON.stringify(options.phpunitXml)}));
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
tests_add_filter('muplugins_loaded', function () use ($plugin_path, $dep_mounts, $pre_component_plugins_loaded_callbacks, $pre_component_init_callbacks, &$deferred_install_plugins_loaded_callbacks, &$deferred_install_init_callbacks, &$loaded_dep_files, &$loaded_component_file) {
    $loaded_dep_files = pg_run_load_deps_stage(array('dep_mounts' => $dep_mounts));
    $loaded_component_file = pg_run_load_component_stage(array('plugin_path' => $plugin_path, 'activate' => false));
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
}

function wp_codebox_phpunit_parse_config($xml_path, $test_dir_default) {
    $directories = array($test_dir_default);
    $suffixes = array('Test.php');
    $prefixes = array('test-');
    $excludes = array();
    if (!is_readable($xml_path) && basename($xml_path) === 'phpunit.xml.dist') {
        $alternate = dirname($xml_path) . '/phpunit.xml';
        if (is_readable($alternate)) {
            $xml_path = $alternate;
        }
    }
    if (!is_readable($xml_path)) {
        pg_log('NOTICE:phpunit.xml.dist not readable at ' . $xml_path . '; using defaults');
        return array($directories, $suffixes, $prefixes, $excludes);
    }
    $prev = libxml_use_internal_errors(true);
    $xml = @simplexml_load_file($xml_path);
    $errors = libxml_get_errors();
    libxml_clear_errors();
    libxml_use_internal_errors($prev);
    if ($xml === false) {
        $first = $errors ? trim($errors[0]->message) : 'unknown';
        pg_log('NOTICE:phpunit.xml.dist parse failed (' . $first . '); using defaults');
        return array($directories, $suffixes, $prefixes, $excludes);
    }
    $plugin_base = dirname($test_dir_default);
    $config_dirs = array();
    $config_suffixes = array();
    $config_prefixes = array();
    foreach ($xml->xpath('//testsuite/directory') ?: array() as $dir) {
        $raw = trim((string) $dir);
        $normalized = trim(str_replace('\\\\', '/', $raw), '/');
        if ($raw === '' || ($normalized !== 'tests' && strpos($normalized, 'tests/') !== 0)) {
            continue;
        }
        $config_dirs[] = $raw[0] === '/' ? rtrim($raw, '/') : rtrim($plugin_base . '/' . $raw, '/');
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
            $excludes[] = $raw[0] === '/' ? rtrim($raw, '/') : rtrim($plugin_base . '/' . $raw, '/');
        }
    }
    if (!empty($config_dirs)) {
        $directories = $config_dirs;
        pg_log('NOTICE:phpunit.xml.dist loaded from ' . $xml_path);
    }
    if (!empty($config_suffixes)) {
        $suffixes = $config_suffixes;
    }
    if (!empty($config_prefixes)) {
        $prefixes = $config_prefixes;
    }
    return array($directories, $suffixes, $prefixes, $excludes);
}

function wp_codebox_phpunit_discover(array $directories, array $suffixes, array $prefixes, array $excludes) {
    $found = array();
    foreach ($directories as $dir) {
        if (!is_dir($dir)) {
            pg_log('NOTICE:test directory does not exist: ' . $dir);
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
}

pg_stage_begin('discover_tests');
try {
    $test_dir = $plugin_path . '/tests';
    if (!is_dir($test_dir)) {
        pg_log('NO_TEST_FILES');
        pg_log('NOTICE:tests directory not found at ' . $test_dir);
        pg_stage_ok('discover_tests');
        exit(1);
    }
    list($directories, $suffixes, $prefixes, $excludes) = wp_codebox_phpunit_parse_config(${JSON.stringify(options.phpunitXml)}, $test_dir);
    $test_files = wp_codebox_phpunit_discover($directories, $suffixes, $prefixes, $excludes);
    $test_files = pg_filter_changed_test_files($test_files, $changed_test_files_raw, $plugin_path);
    if ($selected_test_file !== '') {
        $selected_abs = $plugin_path . '/' . ltrim($selected_test_file, '/');
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
    pg_log('DISCOVERY: dirs=' . implode(',', $directories) . ' suffixes=' . implode(',', $suffixes) . ' prefixes=' . implode(',', $prefixes) . ' excludes=' . count($excludes) . ' found=' . count($test_files));
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

function wp_codebox_phpunit_args(array $argv) {
    $arguments = array('colors' => 'never', 'testdox' => true, 'verbose' => false, 'extensions' => array());
    $args = array_slice($argv, 1);
    for ($i = 0; $i < count($args); $i++) {
        $arg = $args[$i];
        if ($arg === '--filter' && isset($args[$i + 1])) {
            $arguments['filter'] = $args[++$i];
            pg_log('NOTICE:phpunit filter applied: ' . $arguments['filter']);
            continue;
        }
        if (strpos($arg, '--filter=') === 0) {
            $arguments['filter'] = substr($arg, strlen('--filter='));
            pg_log('NOTICE:phpunit filter applied: ' . $arguments['filter']);
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
}

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
    foreach ($extra_defines as $name => $value) {
        if (is_string($name) && preg_match('/^[A-Z_][A-Z0-9_]*$/i', $name)) {
            $config .= sprintf("if (!defined('%s')) { define('%s', %s); }\n", $name, $name, var_export($value, true));
        }
    }
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

function core_pg_parse_phpunit_config(string $xml_path, string $default_dir): array {
    $directories = array($default_dir);
    $suffixes = array('Test.php');
    $prefixes = array('test-');
    $excludes = array();
    if (!is_readable($xml_path)) {
        core_pg_log('NOTICE:phpunit config not readable at ' . $xml_path . '; using defaults');
        return array($directories, $suffixes, $prefixes, $excludes);
    }
    $xml = @simplexml_load_file($xml_path);
    if ($xml === false) {
        core_pg_log('NOTICE:phpunit config parse failed; using defaults');
        return array($directories, $suffixes, $prefixes, $excludes);
    }
    $base = dirname($xml_path);
    $config_dirs = array();
    foreach ($xml->xpath('//testsuite/directory') ?: array() as $dir) {
        $raw = trim((string) $dir);
        if ($raw === '') {
            continue;
        }
        $config_dirs[] = $raw[0] === '/' ? rtrim($raw, '/') : rtrim($base . '/' . $raw, '/');
        foreach (explode(',', (string) ($dir['suffix'] ?? '')) as $suffix) {
            $suffix = trim($suffix);
            if ($suffix !== '') {
                $suffixes[] = $suffix;
            }
        }
        foreach (explode(',', (string) ($dir['prefix'] ?? '')) as $prefix) {
            $prefix = trim($prefix);
            if ($prefix !== '') {
                $prefixes[] = $prefix;
            }
        }
    }
    foreach ($xml->xpath('//testsuite/exclude') ?: array() as $exclude) {
        $raw = trim((string) $exclude);
        if ($raw !== '') {
            $excludes[] = $raw[0] === '/' ? rtrim($raw, '/') : rtrim($base . '/' . $raw, '/');
        }
    }
    if (!empty($config_dirs)) {
        $directories = $config_dirs;
        core_pg_log('NOTICE:phpunit config loaded from ' . $xml_path);
    }
    return array(array_values(array_unique($directories)), array_values(array_unique($suffixes)), array_values(array_unique($prefixes)), $excludes);
}

function core_pg_discover_tests(array $directories, array $suffixes, array $prefixes, array $excludes): array {
    $found = array();
    foreach ($directories as $dir) {
        if (!is_dir($dir)) {
            core_pg_log('NOTICE:test directory does not exist: ' . $dir);
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
}

function core_pg_relative_path(string $path, string $core_root): string {
    $path = trim(str_replace('\\\\', '/', $path));
    $core_root = rtrim(str_replace('\\\\', '/', $core_root), '/');
    if (strpos($path, $core_root . '/') === 0) {
        $path = substr($path, strlen($core_root) + 1);
    }
    while (strpos($path, './') === 0) {
        $path = substr($path, 2);
    }
    return ltrim($path, '/');
}

function core_pg_filter_changed_test_files(array $test_files, string $changed_files_json, string $core_root): array {
    $decoded = json_decode($changed_files_json, true);
    if (!is_array($decoded) || empty($decoded)) {
        return $test_files;
    }
    $wanted = array();
    foreach ($decoded as $entry) {
        if (is_scalar($entry)) {
            $wanted[core_pg_relative_path((string) $entry, $core_root)] = true;
        }
    }
    $filtered = array();
    foreach ($test_files as $file) {
        if (isset($wanted[core_pg_relative_path((string) $file, $core_root)])) {
            $filtered[] = $file;
        }
    }
    core_pg_log('SCOPED_TEST_FILES requested=' . count($wanted) . ' matched=' . count($filtered));
    return $filtered;
}

function core_pg_phpunit_args(array $argv) {
    $arguments = array('colors' => 'never', 'testdox' => true, 'verbose' => false, 'extensions' => array());
    $args = array_slice($argv, 1);
    for ($i = 0; $i < count($args); $i++) {
        $arg = $args[$i];
        if ($arg === '--filter' && isset($args[$i + 1])) {
            $arguments['filter'] = $args[++$i];
            core_pg_log('NOTICE:phpunit filter applied: ' . $arguments['filter']);
            continue;
        }
        if (strpos($arg, '--filter=') === 0) {
            $arguments['filter'] = substr($arg, strlen('--filter='));
            core_pg_log('NOTICE:phpunit filter applied: ' . $arguments['filter']);
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
}

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
    list($directories, $suffixes, $prefixes, $excludes) = core_pg_parse_phpunit_config($phpunit_xml, $tests_dir . '/tests');
    $test_files = core_pg_discover_tests($directories, $suffixes, $prefixes, $excludes);
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
    core_pg_log('DISCOVERY: dirs=' . implode(',', $directories) . ' suffixes=' . implode(',', $suffixes) . ' prefixes=' . implode(',', $prefixes) . ' excludes=' . count($excludes) . ' found=' . count($test_files));
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
