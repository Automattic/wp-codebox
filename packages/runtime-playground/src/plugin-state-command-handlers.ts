import { argValue, booleanArg } from "./command-args.js"

export interface PluginStateCommandInput {
  action: "report" | "activate" | "deactivate"
  target: string
  network: boolean
}

export function pluginStateInputFromArgs(args: string[]): PluginStateCommandInput {
  const rawAction = argValue(args, "action")?.trim() || "report"
  const action = rawAction === "status" ? "report" : rawAction
  if (action !== "report" && action !== "activate" && action !== "deactivate") {
    throw new Error("wordpress.plugin-state action must be report, status, activate, or deactivate")
  }

  const target = (argValue(args, "plugin") ?? argValue(args, "slug") ?? argValue(args, "file") ?? argValue(args, "path") ?? "").trim()
  if (!target) {
    throw new Error("wordpress.plugin-state requires plugin=<slug-or-file-or-path>, slug=<slug>, file=<plugin-file>, or path=<path>")
  }

  return {
    action,
    target,
    network: booleanArg(args, "network", false),
  }
}

export function pluginStatePhpCode(input: PluginStateCommandInput): string {
  return `<?php
$wp_codebox_plugin_state_input = json_decode(base64_decode('${Buffer.from(JSON.stringify(input), "utf8").toString("base64")}'), true);
if (!is_array($wp_codebox_plugin_state_input)) {
    throw new RuntimeException('wordpress.plugin-state received invalid input.');
}

require_once ABSPATH . 'wp-admin/includes/plugin.php';

function wp_codebox_plugin_state_normalize_active_plugins($value): array {
    return array_values(array_map('strval', is_array($value) ? $value : array()));
}

function wp_codebox_plugin_state_active_snapshot(): array {
    return array(
        'plugins' => wp_codebox_plugin_state_normalize_active_plugins(get_option('active_plugins', array())),
        'networkPlugins' => is_multisite() ? array_values(array_map('strval', array_keys((array) get_site_option('active_sitewide_plugins', array())))) : array(),
    );
}

function wp_codebox_plugin_state_plugin_headers(string $plugin_file): array {
    $plugins = function_exists('get_plugins') ? get_plugins() : array();
    $headers = isset($plugins[$plugin_file]) && is_array($plugins[$plugin_file]) ? $plugins[$plugin_file] : array();
    return array(
        'name' => isset($headers['Name']) ? (string) $headers['Name'] : '',
        'version' => isset($headers['Version']) ? (string) $headers['Version'] : '',
        'description' => isset($headers['Description']) ? (string) $headers['Description'] : '',
    );
}

function wp_codebox_plugin_state_file_diagnostic(string $plugin_file): array {
    $absolute = WP_PLUGIN_DIR . '/' . $plugin_file;
    return array(
        'pluginFile' => $plugin_file,
        'path' => $absolute,
        'exists' => is_file($absolute),
        'readable' => is_readable($absolute),
        'hasHeader' => is_file($absolute) && function_exists('get_plugin_data') && (bool) get_plugin_data($absolute, false, false)['Name'],
    );
}

function wp_codebox_plugin_state_safe_relative_file(string $value): ?string {
    $value = trim(str_replace('\\\\', '/', $value));
    $value = preg_replace('#^/wordpress/wp-content/plugins/#', '', $value);
    $value = preg_replace('#^wp-content/plugins/#', '', $value);
    $value = ltrim($value, '/');
    if ($value === '' || str_contains($value, '..') || str_contains($value, ':') || !str_ends_with($value, '.php')) {
        return null;
    }
    return $value;
}

function wp_codebox_plugin_state_resolve_target(string $target): array {
    $target = trim($target);
    $diagnostics = array();
    $plugins = function_exists('get_plugins') ? get_plugins() : array();

    $relative_file = wp_codebox_plugin_state_safe_relative_file($target);
    if ($relative_file !== null) {
        return array(
            'pluginFile' => $relative_file,
            'slug' => dirname($relative_file) === '.' ? basename($relative_file, '.php') : dirname($relative_file),
            'diagnostics' => $diagnostics,
        );
    }

    $absolute = str_starts_with($target, '/') ? realpath($target) : false;
    $plugin_root = realpath(WP_PLUGIN_DIR);
    if ($absolute && $plugin_root && str_starts_with($absolute, $plugin_root . DIRECTORY_SEPARATOR)) {
        $relative = str_replace(DIRECTORY_SEPARATOR, '/', substr($absolute, strlen($plugin_root) + 1));
        if (is_dir($absolute)) {
            $target = basename($absolute);
        } elseif (str_ends_with($relative, '.php')) {
            return array(
                'pluginFile' => $relative,
                'slug' => dirname($relative) === '.' ? basename($relative, '.php') : dirname($relative),
                'diagnostics' => $diagnostics,
            );
        }
    }

    $slug = sanitize_key($target);
    if ($slug !== $target || $slug === '') {
        $diagnostics[] = array('code' => 'target-normalized', 'message' => 'Target was normalized as a WordPress plugin slug.', 'input' => $target, 'normalized' => $slug);
    }

    foreach (array($slug . '/' . $slug . '.php', $slug . '/plugin.php', $slug . '.php') as $candidate) {
        if (isset($plugins[$candidate]) || is_file(WP_PLUGIN_DIR . '/' . $candidate)) {
            return array('pluginFile' => $candidate, 'slug' => $slug, 'diagnostics' => $diagnostics);
        }
    }

    foreach ($plugins as $plugin_file => $headers) {
        if (dirname((string) $plugin_file) === $slug) {
            return array('pluginFile' => (string) $plugin_file, 'slug' => $slug, 'diagnostics' => $diagnostics);
        }
    }

    return array('pluginFile' => '', 'slug' => $slug, 'diagnostics' => array_merge($diagnostics, array(
        array('code' => 'plugin-not-found', 'message' => 'No installed plugin matched the supplied target.', 'target' => $target),
    )));
}

$action = isset($wp_codebox_plugin_state_input['action']) ? (string) $wp_codebox_plugin_state_input['action'] : 'report';
$target = isset($wp_codebox_plugin_state_input['target']) ? (string) $wp_codebox_plugin_state_input['target'] : '';
$network = !empty($wp_codebox_plugin_state_input['network']);
$before = wp_codebox_plugin_state_active_snapshot();
$resolved = wp_codebox_plugin_state_resolve_target($target);
$plugin_file = isset($resolved['pluginFile']) ? (string) $resolved['pluginFile'] : '';
$diagnostics = isset($resolved['diagnostics']) && is_array($resolved['diagnostics']) ? $resolved['diagnostics'] : array();
$errors = array();

if ($plugin_file === '') {
    $errors[] = array('code' => 'plugin-not-found', 'message' => 'The target plugin could not be resolved.');
} elseif (!is_file(WP_PLUGIN_DIR . '/' . $plugin_file) || !is_readable(WP_PLUGIN_DIR . '/' . $plugin_file)) {
    $errors[] = array('code' => 'plugin-file-unreadable', 'message' => 'The resolved plugin file does not exist or is not readable.', 'diagnostic' => wp_codebox_plugin_state_file_diagnostic($plugin_file));
}

if ($network && !is_multisite()) {
    $errors[] = array('code' => 'network-activation-unsupported', 'message' => 'network=true requires a multisite WordPress runtime.');
}

if (empty($errors) && $action === 'activate') {
    $activation = activate_plugin($plugin_file, '', $network, true);
    if (is_wp_error($activation)) {
        $errors[] = array('code' => $activation->get_error_code() ?: 'plugin-activation-failed', 'message' => $activation->get_error_message(), 'data' => $activation->get_error_data());
    }
}

if (empty($errors) && $action === 'deactivate') {
    deactivate_plugins(array($plugin_file), false, $network);
}

$after = wp_codebox_plugin_state_active_snapshot();
$headers = $plugin_file !== '' ? wp_codebox_plugin_state_plugin_headers($plugin_file) : array('name' => '', 'version' => '', 'description' => '');
$active_before = $plugin_file !== '' && (in_array($plugin_file, $before['plugins'], true) || in_array($plugin_file, $before['networkPlugins'], true));
$active_after = $plugin_file !== '' && (in_array($plugin_file, $after['plugins'], true) || in_array($plugin_file, $after['networkPlugins'], true));

echo wp_json_encode(array(
    'schema' => 'wp-codebox/wordpress-plugin-state/v1',
    'command' => 'wordpress.plugin-state',
    'status' => empty($errors) ? 'ok' : 'error',
    'action' => $action,
    'target' => array(
        'requested' => $target,
        'slug' => isset($resolved['slug']) ? (string) $resolved['slug'] : '',
        'pluginFile' => $plugin_file,
        'path' => $plugin_file !== '' ? WP_PLUGIN_DIR . '/' . $plugin_file : '',
        'name' => $headers['name'],
        'version' => $headers['version'],
        'activeBefore' => $active_before,
        'activeAfter' => $active_after,
    ),
    'activePluginsBefore' => $before['plugins'],
    'activePluginsAfter' => $after['plugins'],
    'networkActivePluginsBefore' => $before['networkPlugins'],
    'networkActivePluginsAfter' => $after['networkPlugins'],
    'multisite' => array(
        'isMultisite' => is_multisite(),
        'requestedNetwork' => $network,
        'networkActionsSupported' => is_multisite(),
    ),
    'diagnostics' => $diagnostics,
    'errors' => $errors,
    'artifactRefs' => array(),
), JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT) . "\n";
`
}
