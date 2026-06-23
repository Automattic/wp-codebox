import { isSafeEnvName } from "./commands.js"

export { phpRuntimeComponentLifecycleReplayFunction, phpRuntimeRecipePluginPreloadFunction } from "@automattic/wp-codebox-core"

export type PhpScalar = string | number | boolean | null

export function phpEnvAssignments(env: Record<string, unknown>): string {
  const lines = Object.entries(env)
    .filter(([name]) => isSafeEnvName(name))
    .map(([name, value]) => `putenv(${JSON.stringify(`${name}=${String(value)}`)});`)

  return lines.length > 0 ? `${lines.join("\n")}\n` : ""
}

export function phpWpConfigDefineAssignments(defines: Record<string, unknown>): string {
  const lines = Object.entries(defines)
    .filter((entry): entry is [string, PhpScalar] => isPhpConstantName(entry[0]) && isPhpScalar(entry[1]))
    .map(([name, value]) => phpWpConfigDefineAssignment(name, value))

  return lines.length > 0 ? `${lines.join("\n")}\n` : ""
}

export function phpWpConfigDefineAssignment(name: string, value: PhpScalar): string {
  if (!isPhpConstantName(name)) {
    throw new Error(`Invalid PHP constant name: ${name}`)
  }

  return `if (!defined(${JSON.stringify(name)})) { define(${JSON.stringify(name)}, ${phpLiteral(value)}); }`
}

export function phpLiteral(value: PhpScalar): string {
  if (typeof value === "string") {
    return JSON.stringify(value)
  }
  if (value === null) {
    return "null"
  }
  return String(value)
}

export function isPhpConstantName(name: string): boolean {
  return /^[A-Z_][A-Z0-9_]*$/i.test(name)
}

export function isPhpScalar(value: unknown): value is PhpScalar {
  return value === null || ["string", "number", "boolean"].includes(typeof value)
}

export function phpEnvAssignmentFunction(functionName: string, jsonFunction = "json_encode", invalidKeyLogExpression?: string): string {
  return `function ${functionName}($env): void {
    if (!is_array($env)) {
        return;
    }
    foreach ($env as $name => $value) {
        if (is_string($name) && preg_match('/^[A-Za-z_][A-Za-z0-9_]*$/', $name)) {
            $string_value = is_scalar($value) ? (string) $value : ${jsonFunction}($value);
            putenv($name . '=' . $string_value);
            $_ENV[$name] = $string_value;
        }${invalidKeyLogExpression ? ` else {
            ${invalidKeyLogExpression}
        }` : ""}
    }
}`
}

export function phpWpConfigDefineAppenderFunction(functionName: string, invalidKeyLogExpression?: string, includeComment = true): string {
  return `function ${functionName}(string &$config, $extra_defines): void {
    if (empty($extra_defines) || !is_array($extra_defines)) {
        return;
    }${includeComment ? `
    $config .= "\n// Recipe-declared wp-config defines.\n";
` : ""}
    foreach ($extra_defines as $name => $value) {
        if (!is_string($name) || !preg_match('/^[A-Z_][A-Z0-9_]*$/i', $name)) {${invalidKeyLogExpression ? `
            ${invalidKeyLogExpression}` : ""}
            continue;
        }
        $config .= sprintf("if (!defined('%s')) { define('%s', %s); }\n", $name, $name, var_export($value, true));
    }
}`
}

export function phpBrowserWordPressDiagnosticsPlugin(): string {
  return `<?php
/**
 * Plugin Name: WP Codebox Browser Diagnostics
 */

if ( ! defined( 'WPINC' ) ) {
    return;
}

function wp_codebox_browser_diagnostics_write( array $record ): void {
    file_put_contents( WP_CONTENT_DIR . '/wp-codebox-browser-diagnostics.jsonl', wp_json_encode( $record ) . "\n", FILE_APPEND | LOCK_EX );
}

function wp_codebox_browser_diagnostics_backtrace(): array {
    $frames = debug_backtrace( DEBUG_BACKTRACE_IGNORE_ARGS, 12 );
    $frames = array_slice( $frames, 2 );

    return array_map(
        static function ( array $frame ): array {
            return array_filter(
                array(
                    'file'     => isset( $frame['file'] ) ? (string) $frame['file'] : null,
                    'line'     => isset( $frame['line'] ) ? (int) $frame['line'] : null,
                    'function' => isset( $frame['function'] ) ? (string) $frame['function'] : null,
                    'class'    => isset( $frame['class'] ) ? (string) $frame['class'] : null,
                    'type'     => isset( $frame['type'] ) ? (string) $frame['type'] : null,
                ),
                static fn ( $value ) => null !== $value && '' !== $value
            );
        },
        $frames
    );
}

add_filter(
    'status_header',
    static function ( string $status_header, int $code ): string {
        if ( $code >= 500 && $code < 600 ) {
            wp_codebox_browser_diagnostics_write(
                array(
                    'schema'         => 'wp-codebox/browser-wordpress-diagnostic-record/v1',
                    'classification' => 'http-5xx-status',
                    'severity'       => 'error',
                    'status'         => $code,
                    'statusHeader'   => $status_header,
                    'requestUri'     => isset( $_SERVER['REQUEST_URI'] ) ? (string) $_SERVER['REQUEST_URI'] : '',
                    'message'        => 'WordPress emitted a 5xx status header during browser navigation.',
                    'backtrace'      => wp_codebox_browser_diagnostics_backtrace(),
                    'capturedAt'     => gmdate( 'c' ),
                )
            );
        }

        return $status_header;
    },
    10,
    2
);

register_shutdown_function(
    static function (): void {
        $error = error_get_last();
        $fatal_types = array( E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR, E_USER_ERROR, E_RECOVERABLE_ERROR );
        if ( is_array( $error ) && in_array( $error['type'] ?? null, $fatal_types, true ) ) {
            wp_codebox_browser_diagnostics_write(
                array(
                    'schema'         => 'wp-codebox/browser-wordpress-diagnostic-record/v1',
                    'classification' => 'php-fatal',
                    'severity'       => 'error',
                    'errorType'      => (int) ( $error['type'] ?? 0 ),
                    'message'        => (string) ( $error['message'] ?? '' ),
                    'file'           => (string) ( $error['file'] ?? '' ),
                    'line'           => (int) ( $error['line'] ?? 0 ),
                    'capturedAt'     => gmdate( 'c' ),
                )
            );
            return;
        }

        $status = http_response_code();
        if ( is_int( $status ) && $status >= 500 && $status < 600 ) {
            wp_codebox_browser_diagnostics_write(
                array(
                    'schema'         => 'wp-codebox/browser-wordpress-diagnostic-record/v1',
                    'classification' => 'http-response-code-5xx',
                    'severity'       => 'error',
                    'status'         => $status,
                    'requestUri'     => isset( $_SERVER['REQUEST_URI'] ) ? (string) $_SERVER['REQUEST_URI'] : '',
                    'message'        => 'Browser navigation finished with a 5xx HTTP response code and no PHP fatal.',
                    'capturedAt'     => gmdate( 'c' ),
                )
            );
        }
    }
);
`
}
