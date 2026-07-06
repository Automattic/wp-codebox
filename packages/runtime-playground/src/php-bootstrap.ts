import { readFile } from "node:fs/promises"
import { argValue, normalizePhpCode, phpBody } from "./commands.js"
import { phpEnvAssignments, phpRuntimeRecipePluginPreloadFunction, phpWpConfigDefineAssignments } from "./php-snippets.js"
import { normalizeRuntimeEnvRecord, resolveCommandPath, type RuntimeCreateSpec } from "@automattic/wp-codebox-core"

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
${secretEnvPhp(spec)}
${componentManifestPhp(spec)}
require_once '/wordpress/wp-load.php';
${phpBody(code)}`
}

export function bootstrapPhpCode(spec: RuntimeCreateSpec, code: string, args: string[], wpCliBridge?: PhpBootstrapBridge): string {
  if (argValue(args, "bootstrap") === "none") {
    return code
  }

  const command = splitLeadingStrictTypesDeclare(code)

  return `<?php
${command.strictTypesDeclare ? `${command.strictTypesDeclare}\n` : ""}${phpFatalDiagnosticPhp()}
${pluginRuntimeBootstrapPhp(spec)}
${saveQueriesBootstrapPhp(args)}
${runtimeEnvPhp(spec)}
${secretEnvPhp(spec)}
${componentManifestPhp(spec)}
require_once '/wordpress/wp-load.php';
${recipeActivePluginBootstrapPhp(spec, args)}
${wpCliBridge ? `putenv(${JSON.stringify(`WP_CODEBOX_TERMINAL_ACTION_URL=${wpCliBridge.url}`)});
putenv(${JSON.stringify(`WP_CODEBOX_TERMINAL_ACTION_TOKEN=${wpCliBridge.token}`)});
` : ""}
${command.body}`
}

export function splitLeadingStrictTypesDeclare(code: string): { strictTypesDeclare: string; body: string } {
  const normalized = normalizePhpCode(code)
  const match = normalized.match(/^<\?php\s*(declare\s*\(\s*strict_types\s*=\s*1\s*\)\s*;)\s*/i)

  return match
    ? { strictTypesDeclare: match[1], body: normalized.slice(match[0].length) }
    : { strictTypesDeclare: "", body: phpBody(normalized) }
}

function saveQueriesBootstrapPhp(args: string[]): string {
  const capture = argValue(args, "capture-diagnostics")
  if (!capture?.split(",").map((item) => item.trim()).includes("wpdb-queries")) {
    return ""
  }

  return `if (!defined('SAVEQUERIES')) {
    define('SAVEQUERIES', true);
}
`
}

function phpFatalDiagnosticPhp(): string {
  return `register_shutdown_function(static function (): void {
    $contained_runtime_fatal = error_get_last();
    if (!is_array($contained_runtime_fatal) || !in_array($contained_runtime_fatal['type'] ?? 0, array(E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR, E_USER_ERROR), true)) {
        return;
    }
    echo "\nWP_CODEBOX_PHP_FATAL_DIAGNOSTIC:" . json_encode(array(
        'schema' => 'wp-codebox/php-fatal-diagnostic/v1',
        'message' => isset($contained_runtime_fatal['message']) ? (string) $contained_runtime_fatal['message'] : '',
        'file' => isset($contained_runtime_fatal['file']) ? (string) $contained_runtime_fatal['file'] : '',
        'line' => isset($contained_runtime_fatal['line']) ? (int) $contained_runtime_fatal['line'] : 0,
        'type' => isset($contained_runtime_fatal['type']) ? (int) $contained_runtime_fatal['type'] : 0,
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

function recipeActivePluginBootstrapPhp(spec: RuntimeCreateSpec, args: string[]): string {
  if (argValue(args, "recipe-active-plugins") === "none") {
    return ""
  }

  const plugins = recipeActivePluginMetadata(spec)
  if (plugins.length === 0) {
    return ""
  }

  return `${phpRuntimeRecipePluginPreloadFunction("contained_runtime_run_php")}
$contained_runtime_run_php_active_plugins = json_decode(base64_decode('${Buffer.from(JSON.stringify(plugins), "utf8").toString("base64")}'), true);
foreach (is_array($contained_runtime_run_php_active_plugins) ? $contained_runtime_run_php_active_plugins : array() as $contained_runtime_run_php_active_plugin) {
    if (is_array($contained_runtime_run_php_active_plugin)) {
        contained_runtime_run_php_preload_recipe_plugin($contained_runtime_run_php_active_plugin, true, 'active-recipe-plugin', 'wordpress.run-php');
    }
}
`
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
    return normalizePhpCode(await readFile(resolveCommandPath(codeFile), "utf8"))
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
  const wpConfigDefines = phpWpConfigDefineAssignments(runtime.wpConfigDefines ?? {}).trim()
  if (wpConfigDefines) {
    lines.push(wpConfigDefines)
  }

  return lines.length > 0 ? `${lines.join("\n")}\n` : ""
}

function componentManifestPhp(spec: RuntimeCreateSpec): string {
  const manifest = componentManifest(spec)
  if (!manifest) {
    return ""
  }

  const encoded = Buffer.from(JSON.stringify(manifest), "utf8").toString("base64")
  return `$contained_runtime_component_manifest = json_decode(base64_decode('${encoded}'), true);
if (is_array($contained_runtime_component_manifest)) {
    $GLOBALS['contained_runtime_component_manifest'] = $contained_runtime_component_manifest;
    if (!defined('CONTAINED_RUNTIME_COMPONENT_MANIFEST_JSON')) {
        define('CONTAINED_RUNTIME_COMPONENT_MANIFEST_JSON', json_encode($contained_runtime_component_manifest, JSON_UNESCAPED_SLASHES));
    }
}
`
}

function componentManifest(spec: RuntimeCreateSpec): unknown {
  const recipeManifest = metadataInputs(spec.metadata?.recipe)?.component_manifest
  if (recipeManifest && typeof recipeManifest === "object" && !Array.isArray(recipeManifest)) {
    return recipeManifest
  }

  const taskManifest = metadataInputs(spec.metadata?.task)?.component_manifest
  if (taskManifest && typeof taskManifest === "object" && !Array.isArray(taskManifest)) {
    return taskManifest
  }

  return undefined
}

function metadataInputs(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }

  const inputs = (value as { inputs?: unknown }).inputs
  return inputs && typeof inputs === "object" && !Array.isArray(inputs) ? inputs as Record<string, unknown> : undefined
}

function secretEnvPhp(spec: RuntimeCreateSpec): string {
  return phpEnvAssignments(normalizeRuntimeEnvRecord(spec.secretEnv ?? {}, { field: "secretEnv" }))
}

function runtimeEnvPhp(spec: RuntimeCreateSpec): string {
  return phpEnvAssignments(normalizeRuntimeEnvRecord(spec.runtimeEnv ?? {}, { field: "runtimeEnv" }))
}
