import { normalizeWordPressAdminActionContract, WORDPRESS_ADMIN_ACTION_FAMILY_DESCRIPTORS, WORDPRESS_ADMIN_ACTION_SUPPORTED_FAMILIES, type WordPressAdminActionContract } from "@automattic/wp-codebox-core"
import { argValue, jsonObjectArg } from "./command-args.js"
import { wordpressQueryRecorderPhp } from "./query-recorder.js"

export function adminActionInputFromArgs(args: string[]): WordPressAdminActionContract {
  const rawAction = jsonObjectArg(args, "action-json")
  const boundary = rawAction.destructiveBoundary ?? (argValue(args, "destructive-boundary-json") === undefined ? undefined : jsonObjectArg(args, "destructive-boundary-json"))
  return normalizeWordPressAdminActionContract({ ...rawAction, destructiveBoundary: boundary } as Partial<WordPressAdminActionContract> & { family?: unknown; destructiveBoundary?: unknown })
}

export function adminActionPhpCode(action: WordPressAdminActionContract): string {
  return `<?php
${wordpressQueryRecorderPhp()}
$wp_codebox_admin_action_started_at = gmdate('Y-m-d\\TH:i:s.v\\Z');
$wp_codebox_admin_action_start_time = microtime(true);
$wp_codebox_admin_action_start_memory = memory_get_usage(true);
$wp_codebox_admin_action = json_decode(${JSON.stringify(JSON.stringify(action))}, true);
$wp_codebox_admin_action_family_descriptors = json_decode(${JSON.stringify(JSON.stringify(WORDPRESS_ADMIN_ACTION_FAMILY_DESCRIPTORS))}, true);
$wp_codebox_admin_action_supported_families = json_decode(${JSON.stringify(JSON.stringify(WORDPRESS_ADMIN_ACTION_SUPPORTED_FAMILIES))}, true);
$wp_codebox_admin_action_diagnostics = array();
$wp_codebox_admin_action_errors = array();
$wp_codebox_admin_action_executed = null;

if (!defined('WP_ADMIN')) {
    define('WP_ADMIN', true);
}

function wp_codebox_admin_action_diagnostic(string $code, string $message, string $severity = 'info', array $metadata = array()): array {
    return array('code' => $code, 'message' => $message, 'severity' => $severity, 'metadata' => (object) $metadata);
}

function wp_codebox_admin_action_error(string $code, string $message, array $metadata = array()): array {
    return array('code' => $code, 'message' => $message, 'metadata' => (object) $metadata);
}

$wp_codebox_admin_action_boundary = is_array($wp_codebox_admin_action['destructiveBoundary'] ?? null) ? $wp_codebox_admin_action['destructiveBoundary'] : array();
if (($wp_codebox_admin_action_boundary['disposableRuntime'] ?? null) !== true || ($wp_codebox_admin_action_boundary['destructive'] ?? null) !== true || ($wp_codebox_admin_action_boundary['artifactPolicy'] ?? null) !== 'capture' || ($wp_codebox_admin_action_boundary['teardown'] ?? null) !== 'discard-runtime') {
    $wp_codebox_admin_action_errors[] = wp_codebox_admin_action_error('missing-destructive-boundary', 'wordpress.admin-action requires disposableRuntime=true, destructive=true, artifactPolicy=capture, teardown=discard-runtime.');
}

$wp_codebox_admin_action_family = (string) ($wp_codebox_admin_action['family'] ?? '');
if (!in_array($wp_codebox_admin_action_family, $wp_codebox_admin_action_supported_families, true)) {
    $wp_codebox_admin_action_errors[] = wp_codebox_admin_action_error('unsupported-action-family', 'This runtime does not execute the requested admin action family.', array('family' => $wp_codebox_admin_action_family));
}

if (empty($wp_codebox_admin_action_errors)) {
    $wp_codebox_admin_action_method = strtoupper((string) ($wp_codebox_admin_action['method'] ?? 'POST')) === 'GET' ? 'GET' : 'POST';
    $wp_codebox_admin_action_query = is_array($wp_codebox_admin_action['query'] ?? null) ? $wp_codebox_admin_action['query'] : array();
    $wp_codebox_admin_action_body = is_array($wp_codebox_admin_action['body'] ?? null) ? $wp_codebox_admin_action['body'] : array();
    $_GET = $wp_codebox_admin_action_query;
    $_POST = $wp_codebox_admin_action_method === 'POST' ? $wp_codebox_admin_action_body : array();
    $_REQUEST = array_merge($_GET, $_POST);
    $_SERVER['REQUEST_METHOD'] = $wp_codebox_admin_action_method;
    $_SERVER['REQUEST_URI'] = '/wp-admin/admin.php';
    $_SERVER['SCRIPT_NAME'] = '/wp-admin/admin.php';
    $_SERVER['PHP_SELF'] = '/wp-admin/admin.php';

    try {
        require_once ABSPATH . 'wp-admin/includes/admin.php';
        do_action('admin_init');

        if ($wp_codebox_admin_action_family === 'admin-hook') {
            $wp_codebox_admin_action_hook = (string) ($wp_codebox_admin_action['hook'] ?? '');
            if ($wp_codebox_admin_action_hook === '') {
                $wp_codebox_admin_action_errors[] = wp_codebox_admin_action_error('missing-hook', 'admin-hook actions require hook.');
            } else {
                do_action($wp_codebox_admin_action_hook);
                $wp_codebox_admin_action_executed = array('family' => 'admin-hook', 'hook' => $wp_codebox_admin_action_hook, 'method' => $wp_codebox_admin_action_method);
            }
        } elseif ($wp_codebox_admin_action_family === 'ajax') {
            $wp_codebox_admin_action_name = (string) ($wp_codebox_admin_action['action'] ?? '');
            if ($wp_codebox_admin_action_name === '') {
                $wp_codebox_admin_action_errors[] = wp_codebox_admin_action_error('missing-action', 'ajax actions require action.');
            } else {
                $_REQUEST['action'] = $wp_codebox_admin_action_name;
                $_POST['action'] = $wp_codebox_admin_action_name;
                do_action('wp_ajax_' . $wp_codebox_admin_action_name);
                $wp_codebox_admin_action_executed = array('family' => 'ajax', 'hook' => 'wp_ajax_' . $wp_codebox_admin_action_name, 'method' => $wp_codebox_admin_action_method);
            }
        } elseif ($wp_codebox_admin_action_family === 'admin-post') {
            $wp_codebox_admin_action_name = (string) ($wp_codebox_admin_action['action'] ?? '');
            if ($wp_codebox_admin_action_name === '') {
                $wp_codebox_admin_action_errors[] = wp_codebox_admin_action_error('missing-action', 'admin-post actions require action.');
            } else {
                $_REQUEST['action'] = $wp_codebox_admin_action_name;
                $_POST['action'] = $wp_codebox_admin_action_name;
                do_action('admin_post_' . $wp_codebox_admin_action_name);
                $wp_codebox_admin_action_executed = array('family' => 'admin-post', 'hook' => 'admin_post_' . $wp_codebox_admin_action_name, 'method' => $wp_codebox_admin_action_method);
            }
        }
    } catch (Throwable $wp_codebox_admin_action_throwable) {
        $wp_codebox_admin_action_errors[] = wp_codebox_admin_action_error('admin-action-exception', $wp_codebox_admin_action_throwable->getMessage(), array('class' => get_class($wp_codebox_admin_action_throwable)));
    }
}

$wp_codebox_admin_action_finished_at = gmdate('Y-m-d\\TH:i:s.v\\Z');
$wp_codebox_admin_action_result = array(
    'schema' => 'wp-codebox/wordpress-admin-action-result/v1',
    'command' => 'wordpress.admin-action',
    'status' => !empty($wp_codebox_admin_action_errors) && $wp_codebox_admin_action_family !== '' && !in_array($wp_codebox_admin_action_family, $wp_codebox_admin_action_supported_families, true) ? 'unsupported' : (empty($wp_codebox_admin_action_errors) ? 'ok' : 'error'),
    'action' => $wp_codebox_admin_action,
    'disposableDestructiveBoundary' => $wp_codebox_admin_action_boundary,
    'familyDescriptors' => $wp_codebox_admin_action_family_descriptors,
    'executed' => $wp_codebox_admin_action_executed,
    'diagnostics' => $wp_codebox_admin_action_diagnostics,
    'errors' => $wp_codebox_admin_action_errors,
    'artifacts' => (object) array(),
    'artifactRefs' => array(),
    'performance' => array('schema' => 'wp-codebox/performance-observation/v1', 'command' => 'wordpress.admin-action', 'target' => $wp_codebox_admin_action_family, 'source' => 'in-process', 'kind' => 'admin-action', 'timing' => array('status' => 'captured', 'startedAt' => $wp_codebox_admin_action_started_at, 'finishedAt' => $wp_codebox_admin_action_finished_at, 'durationMs' => round((microtime(true) - $wp_codebox_admin_action_start_time) * 1000, 3)), 'memory' => array('status' => 'captured', 'startBytes' => $wp_codebox_admin_action_start_memory, 'endBytes' => memory_get_usage(true), 'deltaBytes' => memory_get_usage(true) - $wp_codebox_admin_action_start_memory, 'peakBytes' => memory_get_peak_usage(true))),
);
echo wp_json_encode($wp_codebox_admin_action_result, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);`
}
