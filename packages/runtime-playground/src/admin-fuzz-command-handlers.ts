import type { RuntimeCreateSpec } from "@automattic/wp-codebox-core"
import { argValue, commaListArg, positiveIntegerArg } from "./command-args.js"
import { wordpressQueryRecorderPhp } from "./query-recorder.js"
import { wordpressFixtureUserPhpCode, type WordPressFixtureUserSpec } from "./wordpress-user-sessions.js"

export interface AdminFuzzCommandInput {
  safeMethods: string[]
  maxPages: number
  captureDiagnostics: string[]
  user: WordPressFixtureUserSpec
}

export function adminFuzzInputFromArgs(args: string[], runtimeSpec: RuntimeCreateSpec): AdminFuzzCommandInput {
  const safeMethods = commaListArg(args, "safe_methods").map((method) => method.toUpperCase())
  const unsupportedMethods = safeMethods.filter((method) => method !== "GET" && method !== "HEAD")
  if (unsupportedMethods.length > 0) {
    throw new Error(`wordpress.fuzz-admin-pages supports safe_methods GET and HEAD only; unsupported: ${unsupportedMethods.join(", ")}`)
  }

  return {
    safeMethods: safeMethods.length > 0 ? safeMethods : ["GET"],
    maxPages: positiveIntegerArg(args, argValue(args, "max_pages") === undefined ? "max-pages" : "max_pages", 25),
    captureDiagnostics: commaListArg(args, "capture-diagnostics"),
    user: adminFuzzUser(args, runtimeSpec),
  }
}

export function adminFuzzPhpCode(input: AdminFuzzCommandInput): string {
  return `<?php
${wordpressQueryRecorderPhp()}
$wp_codebox_admin_fuzz_started_at = gmdate('Y-m-d\\TH:i:s.v\\Z');
$wp_codebox_admin_fuzz_start_time = microtime(true);
$wp_codebox_admin_fuzz_start_memory = memory_get_usage(true);
$wp_codebox_admin_fuzz_safe_methods = json_decode(${JSON.stringify(JSON.stringify(input.safeMethods))}, true);
$wp_codebox_admin_fuzz_max_pages = ${JSON.stringify(input.maxPages)};
$wp_codebox_admin_fuzz_capture = json_decode(${JSON.stringify(JSON.stringify(input.captureDiagnostics))}, true);
$wp_codebox_admin_fuzz_capture_queries = in_array('wpdb-queries', is_array($wp_codebox_admin_fuzz_capture) ? $wp_codebox_admin_fuzz_capture : array(), true);
$wp_codebox_admin_fuzz_diagnostics = array();
$wp_codebox_admin_fuzz_errors = array();
$wp_codebox_admin_fuzz_pages = array();
$wp_codebox_admin_fuzz_coverage = array();

${wordpressFixtureUserPhpCode(input.user)}

if (!defined('WP_ADMIN')) {
    define('WP_ADMIN', true);
}
$_SERVER['REQUEST_METHOD'] = 'GET';
$_SERVER['REQUEST_URI'] = '/wp-admin/index.php';
$_SERVER['SCRIPT_NAME'] = '/wp-admin/index.php';
$_SERVER['PHP_SELF'] = '/wp-admin/index.php';

set_error_handler(static function($severity, $message, $file, $line) use (&$wp_codebox_admin_fuzz_diagnostics) {
    $wp_codebox_admin_fuzz_diagnostics[] = array('code' => 'php-warning', 'message' => (string) $message, 'severity' => ($severity & (E_ERROR | E_USER_ERROR | E_RECOVERABLE_ERROR)) ? 'error' : 'warning', 'metadata' => array('file' => (string) $file, 'line' => (int) $line));
    return false;
});

try {
    require_once ABSPATH . 'wp-admin/includes/admin.php';
    do_action('admin_init');
    require ABSPATH . 'wp-admin/menu.php';
} catch (Throwable $wp_codebox_admin_fuzz_throwable) {
    $wp_codebox_admin_fuzz_errors[] = array('code' => 'admin-menu-load-exception', 'message' => $wp_codebox_admin_fuzz_throwable->getMessage(), 'severity' => 'error', 'metadata' => array('class' => get_class($wp_codebox_admin_fuzz_throwable)));
}

function wp_codebox_admin_fuzz_page_url(string $menu_slug, string $parent_slug = ''): string {
    if ($menu_slug === '') {
        return admin_url();
    }
    if (strpos($menu_slug, '.php') !== false) {
        return admin_url($menu_slug);
    }
    if ($parent_slug !== '' && strpos($parent_slug, '.php') !== false) {
        return admin_url($parent_slug . '?page=' . rawurlencode($menu_slug));
    }
    return admin_url('admin.php?page=' . rawurlencode($menu_slug));
}

function wp_codebox_admin_fuzz_page(string $menu_slug, string $title, string $capability, string $parent_slug = ''): array {
    $page = array(
        'menuSlug' => $menu_slug,
        'pageTitle' => wp_strip_all_tags($title),
        'menuTitle' => wp_strip_all_tags($title),
        'capability' => $capability,
        'canAccess' => $capability === '' ? null : current_user_can($capability),
        'canonicalUrl' => wp_codebox_admin_fuzz_page_url($menu_slug, $parent_slug),
    );
    if ($parent_slug !== '') {
        $page['parentSlug'] = $parent_slug;
    }
    return $page;
}

foreach ((array) ($GLOBALS['menu'] ?? array()) as $wp_codebox_admin_fuzz_item) {
    if (is_array($wp_codebox_admin_fuzz_item)) {
        $wp_codebox_admin_fuzz_pages[] = wp_codebox_admin_fuzz_page((string) ($wp_codebox_admin_fuzz_item[2] ?? ''), (string) ($wp_codebox_admin_fuzz_item[0] ?? ''), (string) ($wp_codebox_admin_fuzz_item[1] ?? ''));
    }
}
foreach ((array) ($GLOBALS['submenu'] ?? array()) as $wp_codebox_admin_fuzz_parent_slug => $wp_codebox_admin_fuzz_items) {
    foreach ((array) $wp_codebox_admin_fuzz_items as $wp_codebox_admin_fuzz_item) {
        if (is_array($wp_codebox_admin_fuzz_item)) {
            $wp_codebox_admin_fuzz_pages[] = wp_codebox_admin_fuzz_page((string) ($wp_codebox_admin_fuzz_item[2] ?? ''), (string) ($wp_codebox_admin_fuzz_item[0] ?? ''), (string) ($wp_codebox_admin_fuzz_item[1] ?? ''), (string) $wp_codebox_admin_fuzz_parent_slug);
        }
    }
}

$wp_codebox_admin_fuzz_seen = array();
$wp_codebox_admin_fuzz_targets = array();
foreach ($wp_codebox_admin_fuzz_pages as $wp_codebox_admin_fuzz_page) {
    $wp_codebox_admin_fuzz_url = (string) ($wp_codebox_admin_fuzz_page['canonicalUrl'] ?? '');
    if ($wp_codebox_admin_fuzz_url === '' || isset($wp_codebox_admin_fuzz_seen[$wp_codebox_admin_fuzz_url])) {
        continue;
    }
    $wp_codebox_admin_fuzz_seen[$wp_codebox_admin_fuzz_url] = true;
    $wp_codebox_admin_fuzz_targets[] = $wp_codebox_admin_fuzz_page;
    if (count($wp_codebox_admin_fuzz_targets) >= $wp_codebox_admin_fuzz_max_pages) {
        break;
    }
}

foreach ($wp_codebox_admin_fuzz_targets as $wp_codebox_admin_fuzz_target) {
    $wp_codebox_admin_fuzz_url = (string) ($wp_codebox_admin_fuzz_target['canonicalUrl'] ?? '');
    $wp_codebox_admin_fuzz_path = wp_parse_url($wp_codebox_admin_fuzz_url, PHP_URL_PATH);
    $wp_codebox_admin_fuzz_query = wp_parse_url($wp_codebox_admin_fuzz_url, PHP_URL_QUERY);
    parse_str(is_string($wp_codebox_admin_fuzz_query) ? $wp_codebox_admin_fuzz_query : '', $wp_codebox_admin_fuzz_query_vars);
    $_SERVER['REQUEST_METHOD'] = 'GET';
    $_SERVER['REQUEST_URI'] = (string) $wp_codebox_admin_fuzz_path . ($wp_codebox_admin_fuzz_query ? '?' . $wp_codebox_admin_fuzz_query : '');
    $_SERVER['SCRIPT_NAME'] = (string) $wp_codebox_admin_fuzz_path;
    $_SERVER['PHP_SELF'] = (string) $wp_codebox_admin_fuzz_path;
    $_GET = is_array($wp_codebox_admin_fuzz_query_vars) ? $wp_codebox_admin_fuzz_query_vars : array();
    $_POST = array();
    $_REQUEST = $_GET;

    $wp_codebox_admin_fuzz_target_started_at = microtime(true);
    $wp_codebox_admin_fuzz_query_start = $wp_codebox_admin_fuzz_capture_queries ? wp_codebox_query_recorder_start('admin-fuzz', 50, 500) : array('status' => 'uncaptured', 'reason' => 'query_capture_not_requested');
    $wp_codebox_admin_fuzz_target_errors = array();
    ob_start();
    try {
        $wp_codebox_admin_fuzz_hook_suffix = basename((string) $wp_codebox_admin_fuzz_path);
        if (function_exists('set_current_screen')) {
            set_current_screen($wp_codebox_admin_fuzz_hook_suffix === 'index.php' ? 'dashboard' : preg_replace('/\\.php$/', '', $wp_codebox_admin_fuzz_hook_suffix));
        }
        do_action('current_screen', function_exists('get_current_screen') ? get_current_screen() : null);
        do_action('load-' . $wp_codebox_admin_fuzz_hook_suffix);
        do_action('admin_notices');
        do_action('all_admin_notices');
    } catch (Throwable $wp_codebox_admin_fuzz_target_throwable) {
        $wp_codebox_admin_fuzz_target_errors[] = array('code' => 'admin-page-load-exception', 'message' => $wp_codebox_admin_fuzz_target_throwable->getMessage(), 'severity' => 'error', 'metadata' => array('class' => get_class($wp_codebox_admin_fuzz_target_throwable)));
    }
    $wp_codebox_admin_fuzz_buffer = ob_get_clean();
    $wp_codebox_admin_fuzz_query_report = $wp_codebox_admin_fuzz_capture_queries && ($wp_codebox_admin_fuzz_query_start['status'] ?? null) === 'captured' ? wp_codebox_query_recorder_report('admin-fuzz') : array('status' => (string) ($wp_codebox_admin_fuzz_query_start['status'] ?? 'unavailable'), 'reason' => $wp_codebox_admin_fuzz_query_start['reason'] ?? 'query_recorder_unavailable', 'queryCount' => 0, 'totalTimeMs' => null, 'timingStatus' => 'unavailable', 'timingReason' => $wp_codebox_admin_fuzz_query_start['reason'] ?? 'query_recorder_unavailable', 'fingerprints' => array(), 'repeatedQueries' => array());
    $wp_codebox_admin_fuzz_coverage[] = array(
        'target' => $wp_codebox_admin_fuzz_target,
        'method' => 'GET',
        'status' => empty($wp_codebox_admin_fuzz_target_errors) ? 'ok' : 'error',
        'durationMs' => round((microtime(true) - $wp_codebox_admin_fuzz_target_started_at) * 1000, 3),
        'bufferBytes' => strlen((string) $wp_codebox_admin_fuzz_buffer),
        'errors' => $wp_codebox_admin_fuzz_target_errors,
        'database' => array('status' => (string) ($wp_codebox_admin_fuzz_query_report['status'] ?? 'unavailable'), 'reason' => $wp_codebox_admin_fuzz_query_report['reason'] ?? null, 'queryCount' => (int) ($wp_codebox_admin_fuzz_query_report['queryCount'] ?? 0), 'totalTimeMs' => isset($wp_codebox_admin_fuzz_query_report['totalTimeMs']) ? round((float) $wp_codebox_admin_fuzz_query_report['totalTimeMs'], 3) : null, 'timingStatus' => (string) ($wp_codebox_admin_fuzz_query_report['timingStatus'] ?? 'unavailable'), 'timingReason' => $wp_codebox_admin_fuzz_query_report['timingReason'] ?? null, 'fingerprints' => is_array($wp_codebox_admin_fuzz_query_report['fingerprints'] ?? null) ? array_values($wp_codebox_admin_fuzz_query_report['fingerprints']) : array(), 'repeatedQueries' => is_array($wp_codebox_admin_fuzz_query_report['repeatedQueries'] ?? null) ? $wp_codebox_admin_fuzz_query_report['repeatedQueries'] : array()),
    );
}

restore_error_handler();
$wp_codebox_admin_fuzz_finished_at = gmdate('Y-m-d\\TH:i:s.v\\Z');
$wp_codebox_admin_fuzz_result = array(
    'schema' => 'wp-codebox/wordpress-admin-page-coverage/v1',
    'command' => 'wordpress.fuzz-admin-pages',
    'status' => empty($wp_codebox_admin_fuzz_errors) ? 'ok' : 'error',
    'safeMethods' => array_values($wp_codebox_admin_fuzz_safe_methods),
    'adminUrl' => admin_url(),
    'menuLoaded' => isset($GLOBALS['menu']) && is_array($GLOBALS['menu']),
    'pages' => $wp_codebox_admin_fuzz_pages,
    'coverage' => $wp_codebox_admin_fuzz_coverage,
    'totals' => array('pagesDiscovered' => count($wp_codebox_admin_fuzz_pages), 'pagesCovered' => count($wp_codebox_admin_fuzz_coverage), 'errors' => count($wp_codebox_admin_fuzz_errors)),
    'performance' => array('schema' => 'wp-codebox/performance-observation/v1', 'command' => 'wordpress.fuzz-admin-pages', 'target' => 'wp-admin', 'source' => 'in-process', 'kind' => 'admin-page-fuzz', 'timing' => array('status' => 'captured', 'startedAt' => $wp_codebox_admin_fuzz_started_at, 'finishedAt' => $wp_codebox_admin_fuzz_finished_at, 'durationMs' => round((microtime(true) - $wp_codebox_admin_fuzz_start_time) * 1000, 3)), 'memory' => array('status' => 'captured', 'startBytes' => $wp_codebox_admin_fuzz_start_memory, 'endBytes' => memory_get_usage(true), 'deltaBytes' => memory_get_usage(true) - $wp_codebox_admin_fuzz_start_memory, 'peakBytes' => memory_get_peak_usage(true))),
    'errors' => $wp_codebox_admin_fuzz_errors,
    'diagnostics' => $wp_codebox_admin_fuzz_diagnostics,
    'artifactRefs' => array(),
);
echo wp_json_encode($wp_codebox_admin_fuzz_result, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);`
}

function adminFuzzUser(args: string[], runtimeSpec: RuntimeCreateSpec): WordPressFixtureUserSpec {
  const userName = argValue(args, "user")?.trim()
  const fixtureUsers = fixtureUsersFromRuntimeSpec(runtimeSpec)
  const fixtureUser = userName ? fixtureUsers.find((user) => user.name === userName || user.username === userName) : fixtureUsers.find((user) => (user.role ?? "administrator") === "administrator")
  return fixtureUser ?? { name: "wp-codebox-admin-fuzz", username: "wp_codebox_admin_fuzz", email: "wp-codebox-admin-fuzz@example.test", role: "administrator" }
}

function fixtureUsersFromRuntimeSpec(runtimeSpec: RuntimeCreateSpec): WordPressFixtureUserSpec[] {
  const recipe = runtimeSpec.metadata?.recipe && typeof runtimeSpec.metadata.recipe === "object" && !Array.isArray(runtimeSpec.metadata.recipe) ? runtimeSpec.metadata.recipe as { inputs?: { fixtureUsers?: unknown } } : undefined
  const task = runtimeSpec.metadata?.task && typeof runtimeSpec.metadata.task === "object" && !Array.isArray(runtimeSpec.metadata.task) ? runtimeSpec.metadata.task as { inputs?: { fixtureUsers?: unknown } } : undefined
  const users = Array.isArray(recipe?.inputs?.fixtureUsers) ? recipe.inputs.fixtureUsers : Array.isArray(task?.inputs?.fixtureUsers) ? task.inputs.fixtureUsers : []
  return users.filter((user): user is Record<string, unknown> => Boolean(user) && typeof user === "object" && !Array.isArray(user)).map((user) => ({
    ...(typeof user.name === "string" ? { name: user.name } : {}),
    ...(typeof user.username === "string" ? { username: user.username } : {}),
    ...(typeof user.email === "string" ? { email: user.email } : {}),
    ...(typeof user.role === "string" ? { role: user.role } : {}),
    ...(typeof user.displayName === "string" ? { displayName: user.displayName } : {}),
    ...(typeof user.password === "string" ? { password: user.password } : {}),
  }))
}
