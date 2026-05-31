import { cleanWpCliOutput } from "./wp-cli-command-handlers.js"

export interface PluginCheckFinding {
  code?: string
  type?: string
  severity?: string
  message?: string
  file?: string
  line?: number
  column?: number
  docs?: string
  raw: Record<string, unknown>
}

export interface PluginCheckNormalizedOutput {
  schema: "wp-codebox/plugin-check/v1"
  command: "wordpress.plugin-check"
  targetPlugin: string
  exitCode: number
  status: "passed" | "failed"
  summary: {
    total: number
    errors: number
    warnings: number
    notices: number
    info: number
    unknown: number
  }
  findings: PluginCheckFinding[]
  rawFormat: "json" | "text"
}

export function normalizePluginCheckOutput(rawOutput: string, exitCode: number, pluginSlug: string): PluginCheckNormalizedOutput {
  const parsed = parsePluginCheckJson(rawOutput)
  const findings = parsed ? collectPluginCheckFindings(parsed) : []
  const summary = findings.reduce<PluginCheckNormalizedOutput["summary"]>((counts, finding) => {
    counts.total++
    const severity = pluginCheckSeverity(finding)
    counts[severity]++
    return counts
  }, { total: 0, errors: 0, warnings: 0, notices: 0, info: 0, unknown: 0 })
  const effectiveExitCode = exitCode === 0 && summary.errors > 0 ? 1 : exitCode

  return {
    schema: "wp-codebox/plugin-check/v1",
    command: "wordpress.plugin-check",
    targetPlugin: pluginSlug,
    exitCode: effectiveExitCode,
    status: effectiveExitCode === 0 && summary.errors === 0 ? "passed" : "failed",
    summary,
    findings,
    rawFormat: parsed ? "json" : "text",
  }
}

function parsePluginCheckJson(rawOutput: string): unknown | undefined {
  const trimmed = rawOutput.trim()
  if (!trimmed) {
    return []
  }

  try {
    return JSON.parse(trimmed)
  } catch {
    const firstJson = trimmed.match(/[\[{]/)
    if (!firstJson) {
      return undefined
    }

    try {
      return JSON.parse(trimmed.slice(firstJson.index))
    } catch {
      return undefined
    }
  }
}

function collectPluginCheckFindings(value: unknown, inheritedFile = "", inheritedType = ""): PluginCheckFinding[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectPluginCheckFindings(item, inheritedFile, inheritedType))
  }

  if (!value || typeof value !== "object") {
    return []
  }

  const record = value as Record<string, unknown>
  if (looksLikePluginCheckFinding(record)) {
    return [normalizePluginCheckFinding(record, inheritedFile, inheritedType)]
  }

  return Object.entries(record).flatMap(([key, child]) => collectPluginCheckFindings(
    child,
    looksLikePathKey(key) ? key : inheritedFile,
    pluginCheckTypeKey(key) ?? inheritedType,
  ))
}

function looksLikePluginCheckFinding(record: Record<string, unknown>): boolean {
  return ["message", "code", "type", "severity"].some((key) => typeof record[key] === "string")
}

function looksLikePathKey(key: string): boolean {
  return key.includes("/") || key.endsWith(".php") || key.endsWith(".js") || key.endsWith(".css")
}

function pluginCheckTypeKey(key: string): string | undefined {
  if (key === "errors" || key === "warnings") {
    return key.slice(0, -1)
  }
  return undefined
}

function normalizePluginCheckFinding(record: Record<string, unknown>, inheritedFile: string, inheritedType: string): PluginCheckFinding {
  const file = stringField(record, "file") || stringField(record, "filename") || stringField(record, "path") || inheritedFile || undefined
  const line = numberField(record, "line") ?? numberField(record, "line_number")
  const column = numberField(record, "column") ?? numberField(record, "column_number")
  const type = stringField(record, "type") || inheritedType

  return {
    ...(stringField(record, "code") ? { code: stringField(record, "code") } : {}),
    ...(type ? { type } : {}),
    ...(stringField(record, "severity") ? { severity: stringField(record, "severity") } : {}),
    ...(stringField(record, "message") ? { message: stringField(record, "message") } : {}),
    ...(file ? { file } : {}),
    ...(typeof line === "number" ? { line } : {}),
    ...(typeof column === "number" ? { column } : {}),
    ...(stringField(record, "docs") || stringField(record, "documentation") ? { docs: stringField(record, "docs") || stringField(record, "documentation") } : {}),
    raw: record,
  }
}

function pluginCheckSeverity(finding: PluginCheckFinding): "errors" | "warnings" | "notices" | "info" | "unknown" {
  const value = `${finding.severity ?? finding.type ?? finding.code ?? ""}`.toLowerCase()
  if (value.includes("error")) {
    return "errors"
  }
  if (value.includes("warning") || value.includes("warn")) {
    return "warnings"
  }
  if (value.includes("notice")) {
    return "notices"
  }
  if (value.includes("info")) {
    return "info"
  }
  return "unknown"
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === "string" && record[key].trim() !== "" ? record[key] : undefined
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

export interface ThemeCheckFinding {
  type: string
  severity: "error" | "warning" | "required" | "recommended" | "info" | "unknown"
  message: string
}

export interface ThemeCheckNormalizedOutput {
  schema: "wp-codebox/theme-check/v1"
  command: "wordpress.theme-check"
  targetTheme: string
  status: "passed" | "failed" | "error"
  exitCode: number
  summary: {
    total: number
    errors: number
    warnings: number
    required: number
    recommended: number
    info: number
    unknown: number
  }
  findings: ThemeCheckFinding[]
  raw: {
    format: "json" | "text"
    parseError?: string
  }
}

export function themeCheckRunCode(theme: string): string {
  return `$theme_slug = ${JSON.stringify(theme)};
$plugin_dir = WP_PLUGIN_DIR . '/theme-check';
if (!file_exists($plugin_dir . '/theme-check.php')) {
    throw new RuntimeException('Theme Check plugin is not installed in the sandbox.');
}

require_once $plugin_dir . '/checkbase.php';
require_once $plugin_dir . '/main.php';

$theme = wp_get_theme($theme_slug);
if (!$theme->exists()) {
    throw new RuntimeException("Theme '{$theme_slug}' not found.");
}

$success = run_themechecks_against_theme($theme, $theme_slug);
$messages = array();
global $themechecks;
foreach ($themechecks as $check) {
    if ($check instanceof themecheck) {
        $error = (array) $check->getError();
        if (!empty($error)) {
            $messages = array_merge($messages, $error);
        }
    }
}

$processed = array_map(function ($message) {
    if (preg_match('/<span[^>]*>(.*?)<\/span>(.*)/', $message, $matches)) {
        $key = $matches[1];
        $value = $matches[2];
    } else {
        $key = '';
        $value = $message;
    }

    $key = wp_strip_all_tags($key);
    $key = html_entity_decode($key, ENT_QUOTES, 'UTF-8');
    $key = rtrim($key, ':');

    $value = wp_strip_all_tags($value);
    $value = html_entity_decode($value, ENT_QUOTES, 'UTF-8');
    $value = ltrim($value, ': ');

    return array(
        'type' => trim($key),
        'value' => trim($value),
    );
}, $messages);

echo wp_json_encode(array(
    'exitCode' => $success ? 0 : 1,
    'findings' => $processed,
), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);`
}

export function normalizeThemeCheckOutput(rawOutput: string, exitCode: number, targetTheme: string): ThemeCheckNormalizedOutput {
  const trimmed = cleanWpCliOutput(rawOutput).trim()
  const findings: ThemeCheckFinding[] = []
  let format: ThemeCheckNormalizedOutput["raw"]["format"] = "json"
  let parseError: string | undefined
  let effectiveExitCode = exitCode

  try {
    const parsed = trimmed ? JSON.parse(extractJsonPayload(trimmed)) : []
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof parsed.exitCode === "number") {
      effectiveExitCode = parsed.exitCode
    }
    const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.findings) ? parsed.findings : undefined
    if (!rows) {
      throw new Error("Theme Check JSON output must be an array or an object with findings")
    }

    for (const item of rows) {
      if (!item || typeof item !== "object") {
        continue
      }

      const record = item as Record<string, unknown>
      const rawType = typeof record.type === "string" ? record.type.trim() : ""
      const rawMessage = typeof record.value === "string" ? record.value.trim() : ""
      const prefixed = !rawType ? rawMessage.match(/^(ERROR|WARNING|REQUIRED|RECOMMENDED|INFO)\s*:?\s*(.*)$/i) : null
      const type = prefixed?.[1] ?? rawType
      const message = prefixed?.[2]?.trim() || rawMessage
      if (!type && !message) {
        continue
      }

      findings.push({
        type,
        severity: themeCheckSeverity(type),
        message,
      })
    }
  } catch (error) {
    format = "text"
    parseError = error instanceof Error ? error.message : String(error)
    if (trimmed) {
      findings.push({ type: "raw", severity: "unknown", message: trimmed })
    }
  }

  const summary = {
    total: findings.length,
    errors: findings.filter((finding) => finding.severity === "error").length,
    warnings: findings.filter((finding) => finding.severity === "warning").length,
    required: findings.filter((finding) => finding.severity === "required").length,
    recommended: findings.filter((finding) => finding.severity === "recommended").length,
    info: findings.filter((finding) => finding.severity === "info").length,
    unknown: findings.filter((finding) => finding.severity === "unknown").length,
  }

  return {
    schema: "wp-codebox/theme-check/v1",
    command: "wordpress.theme-check",
    targetTheme,
    status: format === "text" && effectiveExitCode !== 0 ? "error" : effectiveExitCode === 0 ? "passed" : "failed",
    exitCode: effectiveExitCode,
    summary,
    findings,
    raw: {
      format,
      ...(parseError ? { parseError } : {}),
    },
  }
}

function extractJsonPayload(output: string): string {
  const firstObject = output.indexOf("{")
  const firstArray = output.indexOf("[")
  const starts = [firstObject, firstArray].filter((index) => index >= 0)
  if (starts.length === 0) {
    return output
  }

  const start = Math.min(...starts)
  const end = output[start] === "[" ? output.lastIndexOf("]") : output.lastIndexOf("}")
  return end > start ? output.slice(start, end + 1) : output.slice(start)
}

function themeCheckSeverity(type: string): ThemeCheckFinding["severity"] {
  const normalized = type.trim().toLowerCase()
  if (["error", "errors"].includes(normalized)) {
    return "error"
  }
  if (["warning", "warnings"].includes(normalized)) {
    return "warning"
  }
  if (["required", "requirement"].includes(normalized)) {
    return "required"
  }
  if (["recommended", "recommendation"].includes(normalized)) {
    return "recommended"
  }
  if (["info", "information", "notice"].includes(normalized)) {
    return "info"
  }

  return "unknown"
}
