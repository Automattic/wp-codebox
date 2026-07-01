import { argValue, booleanArg, jsonArrayArg } from "./command-args.js"

export interface WordPressExecutionActionInput {
  hook?: string
  args: unknown[]
  mutates: boolean
  capability?: string
  destructiveBoundary: string
  operation?: "run-hook" | "schedule-single"
  timestamp?: number
}

export function wordpressExecutionActionInputFromArgs(args: string[], command: "wordpress.invoke-hook" | "wordpress.invoke-cron-event"): WordPressExecutionActionInput {
  const hook = argValue(args, "hook")?.trim()
  if (!hook) {
    throw new Error(`${command} requires hook=<hook-name>`)
  }

  const operation = command === "wordpress.invoke-cron-event" ? cronOperationFromArgs(args) : undefined
  return {
    hook,
    args: jsonArrayArg(args, "args-json"),
    mutates: booleanArg(args, "mutates", false),
    capability: argValue(args, "capability")?.trim() || undefined,
    destructiveBoundary: argValue(args, "destructive-boundary")?.trim() || "disposable-runtime",
    operation,
    timestamp: operation === "schedule-single" ? cronTimestampFromArgs(args) : undefined,
  }
}

export function wordpressExecutionActionPhpCode(input: WordPressExecutionActionInput, command: "wordpress.invoke-hook" | "wordpress.invoke-cron-event"): string {
  return `<?php
$wp_codebox_execution_input = json_decode(base64_decode('${Buffer.from(JSON.stringify(input), "utf8").toString("base64")}'), true);
if (!is_array($wp_codebox_execution_input)) {
    throw new RuntimeException('${command} received invalid execution input.');
}

function wp_codebox_execution_safety(array $input): array {
    return array(
        'mutates' => !empty($input['mutates']),
        'requiresMutationDeclaration' => true,
        'capabilityField' => 'capability',
        'capability' => isset($input['capability']) ? (string) $input['capability'] : null,
        'destructiveBoundaryField' => 'destructive-boundary',
        'destructiveBoundary' => isset($input['destructiveBoundary']) ? (string) $input['destructiveBoundary'] : 'disposable-runtime',
        'defaultDestructiveBoundary' => 'disposable-runtime',
        'rollbackRequired' => false,
    );
}

function wp_codebox_execution_diagnostic(string $surface, string $code, string $message): array {
    return array('surface' => $surface, 'code' => $code, 'message' => $message);
}

function wp_codebox_execution_allowed(array $input): array {
    $capability = isset($input['capability']) ? (string) $input['capability'] : '';
    if ($capability === '') {
        return array(true, null);
    }
    if (!function_exists('current_user_can')) {
        return array(false, wp_codebox_execution_diagnostic('execution', 'capability-check-unavailable', 'current_user_can() is unavailable.'));
    }
    if (!current_user_can($capability)) {
        return array(false, wp_codebox_execution_diagnostic('execution', 'capability-denied', 'The current WordPress user does not satisfy the requested capability.'));
    }
    return array(true, null);
}

$wp_codebox_execution_hook = (string) ($wp_codebox_execution_input['hook'] ?? '');
$wp_codebox_execution_args = is_array($wp_codebox_execution_input['args'] ?? null) ? array_values($wp_codebox_execution_input['args']) : array();
$wp_codebox_execution_safety = wp_codebox_execution_safety($wp_codebox_execution_input);
$wp_codebox_execution_diagnostics = array();
list($wp_codebox_execution_allowed, $wp_codebox_execution_denial) = wp_codebox_execution_allowed($wp_codebox_execution_input);
if (!$wp_codebox_execution_allowed) {
    if ($wp_codebox_execution_denial) {
        $wp_codebox_execution_diagnostics[] = $wp_codebox_execution_denial;
    }
    echo wp_json_encode(array(
        'schema' => 'wp-codebox/wordpress-execution-action-result/v1',
        'command' => '${command}',
        'status' => 'error',
        'target' => array('hook' => $wp_codebox_execution_hook, 'operation' => (string) ($wp_codebox_execution_input['operation'] ?? 'run-hook')),
        'safety' => $wp_codebox_execution_safety,
        'result' => array('executed' => false),
        'diagnostics' => $wp_codebox_execution_diagnostics,
    ), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
    return;
}

$wp_codebox_execution_before = function_exists('did_action') ? did_action($wp_codebox_execution_hook) : 0;
$wp_codebox_execution_operation = (string) ($wp_codebox_execution_input['operation'] ?? 'run-hook');
$wp_codebox_execution_result = array('hook' => $wp_codebox_execution_hook, 'argsCount' => count($wp_codebox_execution_args));
$wp_codebox_execution_status = 'ok';

if ('${command}' === 'wordpress.invoke-cron-event' && $wp_codebox_execution_operation === 'schedule-single') {
    if (!function_exists('wp_schedule_single_event')) {
        $wp_codebox_execution_status = 'unsupported';
        $wp_codebox_execution_diagnostics[] = wp_codebox_execution_diagnostic('execution', 'cron-scheduling-unavailable', 'wp_schedule_single_event() is unavailable.');
        $wp_codebox_execution_result['scheduled'] = false;
    } else {
        $wp_codebox_execution_timestamp = isset($wp_codebox_execution_input['timestamp']) ? (int) $wp_codebox_execution_input['timestamp'] : time();
        $wp_codebox_execution_scheduled = wp_schedule_single_event($wp_codebox_execution_timestamp, $wp_codebox_execution_hook, $wp_codebox_execution_args);
        $wp_codebox_execution_result['operation'] = 'schedule-single';
        $wp_codebox_execution_result['timestamp'] = $wp_codebox_execution_timestamp;
        $wp_codebox_execution_result['scheduled'] = $wp_codebox_execution_scheduled === true;
        if (is_wp_error($wp_codebox_execution_scheduled)) {
            $wp_codebox_execution_status = 'error';
            $wp_codebox_execution_diagnostics[] = wp_codebox_execution_diagnostic('execution', 'cron-schedule-error', $wp_codebox_execution_scheduled->get_error_message());
        }
    }
} else {
    do_action_ref_array($wp_codebox_execution_hook, $wp_codebox_execution_args);
    $wp_codebox_execution_after = function_exists('did_action') ? did_action($wp_codebox_execution_hook) : $wp_codebox_execution_before;
    $wp_codebox_execution_result['operation'] = 'run-hook';
    $wp_codebox_execution_result['executed'] = true;
    $wp_codebox_execution_result['didActionBefore'] = $wp_codebox_execution_before;
    $wp_codebox_execution_result['didActionAfter'] = $wp_codebox_execution_after;
    $wp_codebox_execution_result['didActionDelta'] = $wp_codebox_execution_after - $wp_codebox_execution_before;
}

echo wp_json_encode(array(
    'schema' => 'wp-codebox/wordpress-execution-action-result/v1',
    'command' => '${command}',
    'status' => $wp_codebox_execution_status,
    'target' => array('hook' => $wp_codebox_execution_hook, 'operation' => $wp_codebox_execution_operation),
    'safety' => $wp_codebox_execution_safety,
    'result' => $wp_codebox_execution_result,
    'diagnostics' => $wp_codebox_execution_diagnostics,
), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);`
}

function cronOperationFromArgs(args: string[]): "run-hook" | "schedule-single" {
  const operation = argValue(args, "operation")?.trim() || "run-hook"
  if (operation !== "run-hook" && operation !== "schedule-single") {
    throw new Error("wordpress.invoke-cron-event operation must be run-hook or schedule-single")
  }
  return operation
}

function cronTimestampFromArgs(args: string[]): number {
  const raw = argValue(args, "timestamp")?.trim()
  if (!raw) {
    return Math.floor(Date.now() / 1000)
  }
  const timestamp = Number.parseInt(raw, 10)
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    throw new Error("wordpress.invoke-cron-event timestamp must be a positive Unix timestamp")
  }
  return timestamp
}
