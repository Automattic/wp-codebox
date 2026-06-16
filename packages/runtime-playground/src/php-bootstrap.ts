import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { argValue, isSafeEnvName, normalizePhpCode, phpBody } from "./commands.js"
import type { RuntimeCreateSpec } from "@automattic/wp-codebox-core"

interface PhpBootstrapBridge {
  url: string
  token: string
}

export function bootstrapAbilityPhpCode(spec: RuntimeCreateSpec, code: string): string {
  return `<?php
${phpFatalDiagnosticPhp()}
define( 'REST_REQUEST', true );
$_SERVER['REQUEST_URI'] = '/wp-json/wp-codebox/ability';
${runtimeEnvPhp(spec)}
require_once '/wordpress/wp-load.php';
${secretEnvPhp(spec)}
${phpBody(code)}`
}

export function bootstrapPhpCode(spec: RuntimeCreateSpec, code: string, args: string[], wpCliBridge?: PhpBootstrapBridge): string {
  if (argValue(args, "bootstrap") === "none") {
    return code
  }

  return `<?php
${phpFatalDiagnosticPhp()}
${pluginRuntimeBootstrapPhp(spec)}
${runtimeEnvPhp(spec)}
require_once '/wordpress/wp-load.php';
${recipeActivePluginBootstrapPhp(spec)}
${secretEnvPhp(spec)}
${wpCliBridge ? `putenv(${JSON.stringify(`HOMEBOY_TERMINAL_ACTION_URL=${wpCliBridge.url}`)});
putenv(${JSON.stringify(`HOMEBOY_TERMINAL_ACTION_TOKEN=${wpCliBridge.token}`)});
` : ""}
${phpBody(code)}`
}

function phpFatalDiagnosticPhp(): string {
  return `register_shutdown_function(static function (): void {
    $wp_codebox_fatal = error_get_last();
    if (!is_array($wp_codebox_fatal) || !in_array($wp_codebox_fatal['type'] ?? 0, array(E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR, E_USER_ERROR), true)) {
        return;
    }
    echo "\nWP_CODEBOX_PHP_FATAL_DIAGNOSTIC:" . json_encode(array(
        'schema' => 'wp-codebox/php-fatal-diagnostic/v1',
        'message' => isset($wp_codebox_fatal['message']) ? (string) $wp_codebox_fatal['message'] : '',
        'file' => isset($wp_codebox_fatal['file']) ? (string) $wp_codebox_fatal['file'] : '',
        'line' => isset($wp_codebox_fatal['line']) ? (int) $wp_codebox_fatal['line'] : 0,
        'type' => isset($wp_codebox_fatal['type']) ? (int) $wp_codebox_fatal['type'] : 0,
    ), JSON_UNESCAPED_SLASHES) . "\n";
});`
}

interface RecipePluginMetadata {
  slug?: unknown
  pluginFile?: unknown
  target?: unknown
  activate?: unknown
  loadAs?: unknown
}

function recipeActivePluginBootstrapPhp(spec: RuntimeCreateSpec): string {
  const plugins = recipeActivePluginMetadata(spec)
  if (plugins.length === 0) {
    return ""
  }

  return `${runtimeComponentLifecycleReplayPhp("wp_codebox_run_php")}
$wp_codebox_run_php_active_plugins = json_decode(base64_decode('${Buffer.from(JSON.stringify(plugins), "utf8").toString("base64")}'), true);
function wp_codebox_run_php_plugin_load_diagnostic(array $plugin, string $error = ''): string {
    $plugin_file = isset($plugin['pluginFile']) ? (string) $plugin['pluginFile'] : '';
    $absolute_plugin_file = WP_PLUGIN_DIR . '/' . $plugin_file;
    $real_plugin_file = realpath($absolute_plugin_file);
    $included_files = array_map(static fn($file) => realpath($file) ?: $file, get_included_files());
    $included = in_array($real_plugin_file ?: $absolute_plugin_file, $included_files, true);
    return 'diagnostic=' . wp_json_encode(array(
        'schema' => 'wp-codebox/run-php-plugin-load-diagnostic/v1',
        'role' => 'active-recipe-plugin',
        'plugin_slug' => isset($plugin['slug']) ? (string) $plugin['slug'] : dirname($plugin_file),
        'plugin_file' => $plugin_file,
        'mounted_path' => isset($plugin['target']) ? (string) $plugin['target'] : WP_PLUGIN_DIR . '/' . dirname($plugin_file),
        'expected_file_path' => $absolute_plugin_file,
        'file_exists' => is_file($absolute_plugin_file),
        'file_readable' => is_readable($absolute_plugin_file),
        'active' => function_exists('is_plugin_active') ? is_plugin_active($plugin_file) : null,
        'included' => $included,
        'wp_plugin_dir' => WP_PLUGIN_DIR,
        'error' => $error,
    ), JSON_UNESCAPED_SLASHES);
}
function wp_codebox_run_php_include_active_plugin(array $plugin): void {
    $plugin_file = isset($plugin['pluginFile']) ? (string) $plugin['pluginFile'] : '';
    if ($plugin_file === '' || str_starts_with($plugin_file, '/') || str_contains($plugin_file, '..') || !str_ends_with($plugin_file, '.php')) {
        throw new RuntimeException('wordpress.run-php cannot include unsafe recipe plugin file "' . $plugin_file . '". ' . wp_codebox_run_php_plugin_load_diagnostic($plugin, 'unsafe plugin file'));
    }
    $absolute_plugin_file = WP_PLUGIN_DIR . '/' . $plugin_file;
    if (!is_file($absolute_plugin_file) || !is_readable($absolute_plugin_file)) {
        throw new RuntimeException('wordpress.run-php cannot include recipe plugin file "' . $plugin_file . '". ' . wp_codebox_run_php_plugin_load_diagnostic($plugin, 'missing or unreadable plugin file'));
    }
    $lifecycle = wp_codebox_run_php_component_lifecycle_replay_prepare();
    try {
        require_once $absolute_plugin_file;
    } catch (Throwable $e) {
        throw new RuntimeException('wordpress.run-php failed to include recipe plugin "' . $plugin_file . '". ' . wp_codebox_run_php_plugin_load_diagnostic($plugin, $e->getMessage()), 0, $e);
    } finally {
        wp_codebox_run_php_component_lifecycle_replay_complete($lifecycle);
    }
    $diagnostic = wp_codebox_run_php_plugin_load_diagnostic($plugin, 'plugin file was not included');
    if (strpos($diagnostic, '"included":true') === false) {
        throw new RuntimeException('wordpress.run-php failed to verify included recipe plugin "' . $plugin_file . '". ' . $diagnostic);
    }
}
foreach (is_array($wp_codebox_run_php_active_plugins) ? $wp_codebox_run_php_active_plugins : array() as $wp_codebox_run_php_active_plugin) {
    if (is_array($wp_codebox_run_php_active_plugin)) {
        wp_codebox_run_php_include_active_plugin($wp_codebox_run_php_active_plugin);
    }
}
`
}

function runtimeComponentLifecycleReplayPhp(prefix: string): string {
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

function recipeActivePluginMetadata(spec: RuntimeCreateSpec): RecipePluginMetadata[] {
  const recipe = spec.metadata?.recipe && typeof spec.metadata.recipe === "object" && !Array.isArray(spec.metadata.recipe)
    ? spec.metadata.recipe as { inputs?: { extra_plugins?: unknown } }
    : undefined
  const task = spec.metadata?.task && typeof spec.metadata.task === "object" && !Array.isArray(spec.metadata.task)
    ? spec.metadata.task as { inputs?: { extra_plugins?: unknown } }
    : undefined
  const extraPlugins = Array.isArray(recipe?.inputs?.extra_plugins)
    ? recipe.inputs.extra_plugins
    : Array.isArray(task?.inputs?.extra_plugins)
      ? task.inputs.extra_plugins
      : []

  const plugins: RecipePluginMetadata[] = extraPlugins
    .filter((plugin): plugin is RecipePluginMetadata => Boolean(plugin) && typeof plugin === "object" && !Array.isArray(plugin))
    .filter((plugin) => plugin.loadAs !== "mu-plugin" && plugin.activate !== false)
    .map((plugin) => ({
      slug: typeof plugin.slug === "string" ? plugin.slug : undefined,
      pluginFile: typeof plugin.pluginFile === "string" && /^[^/][^:]*\.php$/.test(plugin.pluginFile) && !plugin.pluginFile.includes("..") ? plugin.pluginFile : undefined,
      target: typeof plugin.target === "string" ? plugin.target : undefined,
      activate: plugin.activate,
      loadAs: plugin.loadAs,
    }))

  return plugins.filter((plugin) => typeof plugin.pluginFile === "string")
}

export async function phpCodeFromArgs(args: string[], command = "wordpress.run-php"): Promise<string> {
  const inlineCode = argValue(args, "code")
  if (inlineCode) {
    return normalizePhpCode(inlineCode)
  }

  const codeFile = argValue(args, "code-file")
  if (codeFile) {
    return normalizePhpCode(await readFile(resolve(codeFile), "utf8"))
  }

  throw new Error(`${command} requires code=<php> or code-file=<path>`)
}

function pluginRuntimeBootstrapPhp(spec: RuntimeCreateSpec): string {
  const pluginRuntime = spec.metadata?.recipe && typeof spec.metadata.recipe === "object" && !Array.isArray(spec.metadata.recipe)
    ? (spec.metadata.recipe as { inputs?: { pluginRuntime?: unknown } }).inputs?.pluginRuntime
    : undefined
  if (!pluginRuntime || typeof pluginRuntime !== "object" || Array.isArray(pluginRuntime)) {
    return ""
  }

  const runtime = pluginRuntime as { php?: { memoryLimit?: unknown; maxExecutionTime?: unknown }; wpConfigDefines?: Record<string, unknown> }
  const lines: string[] = []
  const memoryLimit = typeof runtime.php?.memoryLimit === "string" ? runtime.php.memoryLimit : undefined
  if (memoryLimit && /^[0-9]+[KMG]?$/.test(memoryLimit)) {
    lines.push(`@ini_set('memory_limit', ${JSON.stringify(memoryLimit)});`)
  }
  const maxExecutionTime = runtime.php?.maxExecutionTime
  if (Number.isInteger(maxExecutionTime) && typeof maxExecutionTime === "number" && maxExecutionTime >= 0 && maxExecutionTime <= 3600) {
    lines.push(`@set_time_limit(${maxExecutionTime});`)
  }
  for (const [name, value] of Object.entries(runtime.wpConfigDefines ?? {})) {
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(name) || (!["string", "number", "boolean"].includes(typeof value) && value !== null)) {
      continue
    }
    lines.push(`if (!defined(${JSON.stringify(name)})) { define(${JSON.stringify(name)}, ${phpLiteral(value as string | number | boolean | null)}); }`)
  }

  return lines.length > 0 ? `${lines.join("\n")}\n` : ""
}

function secretEnvPhp(spec: RuntimeCreateSpec): string {
  const entries = Object.entries(spec.secretEnv ?? {}).filter(([name]) => isSafeEnvName(name))
  if (entries.length === 0) {
    return ""
  }

  return `${entries
    .map(([name, value]) => `putenv(${JSON.stringify(`${name}=${value}`)});`)
    .join("\n")}\n`
}

function runtimeEnvPhp(spec: RuntimeCreateSpec): string {
  const entries = Object.entries(spec.runtimeEnv ?? {}).filter(([name]) => isSafeEnvName(name))
  if (entries.length === 0) {
    return ""
  }

  return `${entries
    .map(([name, value]) => `putenv(${JSON.stringify(`${name}=${value}`)});`)
    .join("\n")}\n`
}

function phpLiteral(value: string | number | boolean | null): string {
  if (typeof value === "string") {
    return JSON.stringify(value)
  }
  if (value === null) {
    return "null"
  }
  return String(value)
}
