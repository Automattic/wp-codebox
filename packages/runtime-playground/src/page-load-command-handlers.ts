import { argValue, booleanArg, commaListArg, jsonObjectArg } from "./command-args.js"
import { wordpressQueryRecorderPhp } from "./query-recorder.js"
import { wordpressFixtureUserPhpCode, type WordPressUserSessionResolution } from "./wordpress-user-sessions.js"

export type PageLoadSurface = "admin" | "frontend"

export interface PageLoadCommandInput {
  command: "wordpress.admin-page-load" | "wordpress.frontend-page-load" | "wordpress.simulated-admin-page-load" | "wordpress.simulated-frontend-page-load"
  surface: PageLoadSurface
  method: string
  path: string
  query: Record<string, unknown>
  body: Record<string, unknown>
  captureDiagnostics: string[]
  capture: { queries?: boolean }
  userSession?: WordPressUserSessionResolution
}

export function pageLoadInputFromArgs(args: string[], surface: PageLoadSurface, command?: PageLoadCommandInput["command"]): PageLoadCommandInput {
  const url = argValue(args, "url")?.trim()
  const path = url || argValue(args, "path")?.trim() || (surface === "admin" ? "index.php" : "/")
  return {
    command: command ?? (surface === "admin" ? "wordpress.simulated-admin-page-load" : "wordpress.simulated-frontend-page-load"),
    surface,
    method: (argValue(args, "method")?.trim() || "GET").toUpperCase(),
    path,
    query: jsonObjectArg(args, "query-json"),
    body: jsonObjectArg(args, "body-json"),
    captureDiagnostics: commaListArg(args, "capture-diagnostics"),
    capture: captureFromArgs(args),
  }
}

export function pageLoadPhpCode(input: PageLoadCommandInput): string {
  const userSessionMetadata = input.userSession?.metadata
  return `${wordpressQueryRecorderPhp()}
$wp_codebox_page_load_started_at = gmdate('Y-m-d\\TH:i:s.v\\Z');
$wp_codebox_page_load_start_time = microtime(true);
$wp_codebox_page_load_start_memory = memory_get_usage(true);
$wp_codebox_page_load_command = ${JSON.stringify(input.command)};
$wp_codebox_page_load_surface = ${JSON.stringify(input.surface)};
$wp_codebox_page_load_method = ${JSON.stringify(input.method)};
$wp_codebox_page_load_path = ${JSON.stringify(input.path)};
$wp_codebox_page_load_query = json_decode(${JSON.stringify(JSON.stringify(input.query))}, true);
$wp_codebox_page_load_body = json_decode(${JSON.stringify(JSON.stringify(input.body))}, true);
$wp_codebox_page_load_capture = json_decode(${JSON.stringify(JSON.stringify(input.captureDiagnostics))}, true);
$wp_codebox_page_load_capture_request = json_decode(${JSON.stringify(JSON.stringify(input.capture ?? {}))}, true);
$wp_codebox_page_load_user_session = json_decode(${JSON.stringify(JSON.stringify(userSessionMetadata ?? null))}, true);
$wp_codebox_page_load_capture_queries_requested = is_array($wp_codebox_page_load_capture_request) && array_key_exists('queries', $wp_codebox_page_load_capture_request) ? (bool) $wp_codebox_page_load_capture_request['queries'] : in_array('wpdb-queries', $wp_codebox_page_load_capture, true);
$wp_codebox_page_load_query_recorder_start = $wp_codebox_page_load_capture_queries_requested ? wp_codebox_query_recorder_start('page-load', 50, 500) : array('status' => 'uncaptured', 'reason' => 'query_capture_not_requested');
$wp_codebox_page_load_notices = array();
$wp_codebox_page_load_errors = array();
$wp_codebox_page_load_redirect = null;
$wp_codebox_page_load_headers = array();

${input.userSession ? wordpressFixtureUserPhpCode(input.userSession.user) : ""}

set_error_handler(static function($severity, $message, $file, $line) use (&$wp_codebox_page_load_notices) {
    $wp_codebox_page_load_notices[] = array('channel' => 'php', 'message' => (string) $message, 'severity' => ($severity & (E_ERROR | E_USER_ERROR | E_RECOVERABLE_ERROR)) ? 'error' : 'warning', 'metadata' => array('file' => (string) $file, 'line' => (int) $line));
    return false;
});

add_filter('wp_redirect', static function($location, $status) use (&$wp_codebox_page_load_redirect) {
    $wp_codebox_page_load_redirect = array('location' => (string) $location, 'status' => (int) $status, 'source' => 'wp_redirect');
    return false;
}, 999, 2);
add_action('doing_it_wrong_run', static function($function_name, $message, $version) use (&$wp_codebox_page_load_notices) {
    $wp_codebox_page_load_notices[] = array('channel' => 'doing_it_wrong', 'message' => (string) $message, 'severity' => 'warning', 'metadata' => array('function' => (string) $function_name, 'version' => (string) $version));
}, 10, 3);
add_action('deprecated_function_run', static function($function_name, $replacement, $version) use (&$wp_codebox_page_load_notices) {
    $wp_codebox_page_load_notices[] = array('channel' => 'deprecated', 'message' => (string) $function_name, 'severity' => 'warning', 'metadata' => array('replacement' => (string) $replacement, 'version' => (string) $version));
}, 10, 3);

$wp_codebox_page_load_parts = parse_url($wp_codebox_page_load_path);
if (!is_array($wp_codebox_page_load_parts)) {
    throw new RuntimeException('Page-load target path is invalid.');
}
$wp_codebox_page_load_path_only = (string) ($wp_codebox_page_load_parts['path'] ?? $wp_codebox_page_load_path);
$wp_codebox_page_load_url_query = array();
if (isset($wp_codebox_page_load_parts['query'])) {
    parse_str((string) $wp_codebox_page_load_parts['query'], $wp_codebox_page_load_url_query);
}
$wp_codebox_page_load_query = array_merge($wp_codebox_page_load_url_query, is_array($wp_codebox_page_load_query) ? $wp_codebox_page_load_query : array());
$wp_codebox_page_load_body = is_array($wp_codebox_page_load_body) ? $wp_codebox_page_load_body : array();

if ($wp_codebox_page_load_surface === 'admin') {
    $wp_codebox_page_load_relative_path = preg_replace('#^https?://[^/]+#', '', $wp_codebox_page_load_path_only);
    $wp_codebox_page_load_relative_path = preg_replace('#^/?wp-admin/#', '', (string) $wp_codebox_page_load_relative_path);
    $wp_codebox_page_load_relative_path = ltrim((string) $wp_codebox_page_load_relative_path, '/');
    if ($wp_codebox_page_load_relative_path === '') {
        $wp_codebox_page_load_relative_path = 'index.php';
    }
    $wp_codebox_page_load_request_uri = wp_parse_url(admin_url($wp_codebox_page_load_relative_path), PHP_URL_PATH);
} else {
    $wp_codebox_page_load_relative_path = '/' . ltrim((string) $wp_codebox_page_load_path_only, '/');
    $wp_codebox_page_load_request_uri = $wp_codebox_page_load_relative_path;
}
if (!empty($wp_codebox_page_load_query)) {
    $wp_codebox_page_load_request_uri .= '?' . http_build_query($wp_codebox_page_load_query);
}

$_SERVER['REQUEST_METHOD'] = $wp_codebox_page_load_method;
$_SERVER['REQUEST_URI'] = $wp_codebox_page_load_request_uri;
$_SERVER['SCRIPT_NAME'] = $wp_codebox_page_load_surface === 'admin' ? '/wp-admin/' . $wp_codebox_page_load_relative_path : '/index.php';
$_SERVER['PHP_SELF'] = $_SERVER['SCRIPT_NAME'];
$_GET = $wp_codebox_page_load_query;
$_POST = in_array($wp_codebox_page_load_method, array('POST', 'PUT', 'PATCH'), true) ? $wp_codebox_page_load_body : array();
$_REQUEST = array_merge($_GET, $_POST);

ob_start();
try {
    if ($wp_codebox_page_load_surface === 'admin') {
        if (!defined('WP_ADMIN')) {
            define('WP_ADMIN', true);
        }
        require_once ABSPATH . 'wp-admin/includes/admin.php';
        if (!is_user_logged_in()) {
            $wp_codebox_page_load_redirect = array('location' => wp_login_url($wp_codebox_page_load_request_uri), 'status' => 302, 'source' => 'auth_redirect');
        } else {
            do_action('admin_init');
            $wp_codebox_page_load_hook_suffix = basename($wp_codebox_page_load_relative_path);
            if (function_exists('set_current_screen')) {
                set_current_screen($wp_codebox_page_load_hook_suffix === 'index.php' ? 'dashboard' : preg_replace('/\\.php$/', '', $wp_codebox_page_load_hook_suffix));
            }
            do_action('current_screen', function_exists('get_current_screen') ? get_current_screen() : null);
            do_action('load-' . $wp_codebox_page_load_hook_suffix);
            do_action('admin_notices');
            do_action('all_admin_notices');
        }
    } else {
        $GLOBALS['wp']->parse_request();
        $GLOBALS['wp']->query_posts();
        $GLOBALS['wp']->register_globals();
        $GLOBALS['wp']->send_headers();
        do_action('wp');
        do_action('template_redirect');
    }
} catch (Throwable $wp_codebox_page_load_throwable) {
    $wp_codebox_page_load_errors[] = array('code' => 'page-load-exception', 'message' => $wp_codebox_page_load_throwable->getMessage(), 'severity' => 'error', 'metadata' => array('class' => get_class($wp_codebox_page_load_throwable)));
}
$wp_codebox_page_load_buffer = ob_get_clean();
restore_error_handler();

$wp_codebox_page_load_screen = function_exists('get_current_screen') ? get_current_screen() : null;
$wp_codebox_page_load_queried = function_exists('get_queried_object') ? get_queried_object() : null;
$wp_codebox_page_load_identity = array(
    'url' => $wp_codebox_page_load_surface === 'admin' ? admin_url($wp_codebox_page_load_relative_path) : home_url($wp_codebox_page_load_relative_path),
    'path' => $wp_codebox_page_load_relative_path,
    'screenId' => is_object($wp_codebox_page_load_screen) && isset($wp_codebox_page_load_screen->id) ? (string) $wp_codebox_page_load_screen->id : null,
    'screenBase' => is_object($wp_codebox_page_load_screen) && isset($wp_codebox_page_load_screen->base) ? (string) $wp_codebox_page_load_screen->base : null,
    'hookSuffix' => isset($wp_codebox_page_load_hook_suffix) ? (string) $wp_codebox_page_load_hook_suffix : null,
    'adminPage' => $wp_codebox_page_load_surface === 'admin' ? (string) $wp_codebox_page_load_relative_path : null,
    'postId' => function_exists('is_singular') && is_singular() ? (int) get_queried_object_id() : null,
    'postType' => function_exists('get_post_type') && get_queried_object_id() ? (string) get_post_type(get_queried_object_id()) : null,
    'queriedObjectId' => function_exists('get_queried_object_id') ? (int) get_queried_object_id() : null,
    'queriedObjectType' => is_object($wp_codebox_page_load_queried) ? get_class($wp_codebox_page_load_queried) : null,
    'template' => function_exists('get_page_template_slug') && get_queried_object_id() ? (string) get_page_template_slug(get_queried_object_id()) : null,
    'queryVars' => isset($GLOBALS['wp_query']->query_vars) && is_array($GLOBALS['wp_query']->query_vars) ? $GLOBALS['wp_query']->query_vars : array(),
    'bodyClasses' => function_exists('get_body_class') ? get_body_class() : array(),
);
$wp_codebox_page_load_identity = array_filter($wp_codebox_page_load_identity, static fn($value) => $value !== null && $value !== '');

$wp_codebox_page_load_query_count = 0;
$wp_codebox_page_load_query_time_ms = 0.0;
$wp_codebox_page_load_query_fingerprints = array();
$wp_codebox_page_load_query_report = $wp_codebox_page_load_capture_queries_requested && ($wp_codebox_page_load_query_recorder_start['status'] ?? null) === 'captured' ? wp_codebox_query_recorder_report('page-load') : array('status' => (string) ($wp_codebox_page_load_query_recorder_start['status'] ?? 'unavailable'), 'reason' => $wp_codebox_page_load_query_recorder_start['reason'] ?? 'query_recorder_unavailable', 'queryCount' => 0, 'totalTimeMs' => 0, 'fingerprints' => array(), 'repeatedQueries' => array());
$wp_codebox_page_load_query_capture_status = (string) ($wp_codebox_page_load_query_report['status'] ?? 'unavailable');
$wp_codebox_page_load_query_capture_reason = $wp_codebox_page_load_query_report['reason'] ?? null;
$wp_codebox_page_load_query_count = (int) ($wp_codebox_page_load_query_report['queryCount'] ?? 0);
$wp_codebox_page_load_query_time_ms = (float) ($wp_codebox_page_load_query_report['totalTimeMs'] ?? 0);
$wp_codebox_page_load_query_fingerprints = is_array($wp_codebox_page_load_query_report['fingerprints'] ?? null) ? $wp_codebox_page_load_query_report['fingerprints'] : array();
$wp_codebox_page_load_repeated_queries = is_array($wp_codebox_page_load_query_report['repeatedQueries'] ?? null) ? $wp_codebox_page_load_query_report['repeatedQueries'] : array();
$wp_codebox_page_load_finished_at = gmdate('Y-m-d\\TH:i:s.v\\Z');
$wp_codebox_page_load_status = !empty($wp_codebox_page_load_errors) ? 'error' : ($wp_codebox_page_load_redirect ? 'redirect' : 'ok');
$wp_codebox_page_load_result = array(
    'schema' => 'wp-codebox/wordpress-page-load-result/v1',
    'mode' => 'simulated',
    'command' => $wp_codebox_page_load_command,
    'status' => $wp_codebox_page_load_status,
    'target' => array('kind' => $wp_codebox_page_load_surface, 'path' => $wp_codebox_page_load_path, 'method' => $wp_codebox_page_load_method, 'query' => $wp_codebox_page_load_query, 'body' => $wp_codebox_page_load_body, 'userSession' => is_array($wp_codebox_page_load_user_session) ? $wp_codebox_page_load_user_session : null),
    'identity' => $wp_codebox_page_load_identity,
    'http' => array('status' => $wp_codebox_page_load_redirect ? (int) ($wp_codebox_page_load_redirect['status'] ?? 302) : 200, 'headers' => $wp_codebox_page_load_headers),
    'redirect' => $wp_codebox_page_load_redirect,
    'notices' => $wp_codebox_page_load_notices,
    'errors' => $wp_codebox_page_load_errors,
    'performance' => array('schema' => 'wp-codebox/performance-observation/v1', 'command' => $wp_codebox_page_load_command, 'target' => $wp_codebox_page_load_path, 'source' => 'in-process', 'kind' => 'simulated-page-load', 'timing' => array('status' => 'captured', 'startedAt' => $wp_codebox_page_load_started_at, 'finishedAt' => $wp_codebox_page_load_finished_at, 'durationMs' => round((microtime(true) - $wp_codebox_page_load_start_time) * 1000, 3)), 'memory' => array('status' => 'captured', 'startBytes' => $wp_codebox_page_load_start_memory, 'endBytes' => memory_get_usage(true), 'deltaBytes' => memory_get_usage(true) - $wp_codebox_page_load_start_memory, 'peakBytes' => memory_get_peak_usage(true)), 'database' => array('status' => $wp_codebox_page_load_query_capture_status, 'reason' => $wp_codebox_page_load_query_capture_reason, 'queryCount' => $wp_codebox_page_load_query_count, 'totalTimeMs' => round($wp_codebox_page_load_query_time_ms, 3), 'fingerprints' => array_values($wp_codebox_page_load_query_fingerprints), 'repeatedQueries' => $wp_codebox_page_load_repeated_queries), 'hooks' => array('status' => 'unsupported', 'reason' => 'hook_timing_not_instrumented', 'timings' => array()), 'network' => array('status' => 'unsupported', 'reason' => 'in_process_page_load'), 'browser' => array('status' => 'unsupported', 'reason' => 'not_a_browser_observation'), 'capture' => array('requested' => array('queries' => $wp_codebox_page_load_capture_queries_requested), 'queries' => array('requested' => $wp_codebox_page_load_capture_queries_requested, 'status' => $wp_codebox_page_load_query_capture_status, 'reason' => $wp_codebox_page_load_query_capture_reason)), 'metadata' => array('runner' => 'wp-codebox/runtime-playground', 'surface' => $wp_codebox_page_load_surface)),
    'artifactRefs' => array(),
    'diagnostics' => array('bufferBytes' => strlen((string) $wp_codebox_page_load_buffer), 'capture' => $wp_codebox_page_load_capture),
);
echo wp_json_encode($wp_codebox_page_load_result, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);`
}

function captureFromArgs(args: string[]): PageLoadCommandInput["capture"] {
  const capture = jsonObjectArg(args, "capture-json") as PageLoadCommandInput["capture"]
  const name = argValue(args, "capture-queries") !== undefined ? "capture-queries" : argValue(args, "enable-query-capture") !== undefined ? "enable-query-capture" : undefined
  if (name) {
    capture.queries = booleanArg(args, name)
  }
  return capture
}
