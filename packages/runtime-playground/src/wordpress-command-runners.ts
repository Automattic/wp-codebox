import { createHash, randomBytes } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { BrowserArtifact } from "./browser-artifacts.js"
import { promoteBrowserMetricsToBenchResults } from "./browser-metrics.js"
import { writePluginCheckArtifacts, writeThemeCheckArtifacts, type PluginCheckArtifact, type ThemeCheckArtifact } from "./check-artifacts.js"
import {
  abilityInputFromArgs,
  abilityPrincipalFromArgs,
  abilityResponseToCommandEnvelope,
  abilityPhpCode,
  expectedAbilityResultSchemaFromArgs,
  argValue,
  benchRunCode,
  booleanArg,
  cleanWpCliOutput,
  commaListArg,
  CORE_PHPUNIT_RESULT_FILE,
  corePhpunitRunCode,
  jsonArrayArg,
  jsonObjectArg,
  nonNegativeIntegerArg,
  normalizePhpCode,
  normalizePluginCheckOutput,
  normalizeThemeCheckOutput,
  pageLoadInputFromArgs,
  pageLoadPhpCode,
  phpunitRunCode,
  pluginStateInputFromArgs,
  pluginStatePhpCode,
  PLUGIN_PHPUNIT_RESULT_FILE,
  positiveIntegerArg,
  httpRequestInputFromArgs,
  runHttpRequest,
  restRequestInputFromArgs,
  restRequestPhpCode,
  runtimeInventoryPhpCode,
  runtimeDiscoveryPhpCode,
  runtimeDiscoverySurfacesFromArgs,
  pluginSetupInputFromArgs,
  themeCheckRunCode,
  themeSetupInputFromArgs,
} from "./commands.js"
import { bootstrapAbilityPhpCode, bootstrapPhpCode, phpCodeFromArgs } from "./php-bootstrap.js"
import { assertPlaygroundResponseOk, type PlaygroundRunResponse } from "./playground-command-errors.js"
import type { PlaygroundCliServer } from "./preview-server.js"
import { persistCorePhpunitResult, persistPluginPhpunitResult, persistVfsDiagnosticFileToHost, readCorePhpunitDiagnostic, readPluginPhpunitDiagnostic } from "./runtime-diagnostics.js"
import type { RuntimeWpCliBridge } from "./runtime-wp-cli-bridge.js"
import { COMMAND_DIAGNOSTICS_ARTIFACT_SCHEMA, PERFORMANCE_OBSERVATION_SCHEMA, commandDiagnosticsCaptureArgs, commandDiagnosticsCaptureSpecFromArgs, createRuntimeCommandResultEnvelope, redactJsonValue, type ExecutionSpec, type MountSpec, type PerformanceObservation, type RuntimeCommandResultEnvelope, type RuntimeCreateSpec, type RuntimeEpisodeTraceRef } from "@automattic/wp-codebox-core"
import { wordpressUserSessionFromCommandArgs } from "./wordpress-user-sessions.js"

type RunPlaygroundCommand = (command: string, server: PlaygroundCliServer, options: { code: string } | { scriptPath: string }) => Promise<PlaygroundRunResponse>
type RunWpCliCommand = (server: PlaygroundCliServer, argv: string[]) => Promise<PlaygroundRunResponse>
type CreateRuntimeWpCliBridge = (server: PlaygroundCliServer) => Promise<RuntimeWpCliBridge>

const BROWSER_PROVIDER_PROXY_SCHEMA = "wp-codebox/browser-provider-proxy-request/v1"
const BROWSER_PROVIDER_PROXY_MAX_BYTES = 1_000_000

type BrowserProviderProxyMessage = {
  schema: typeof BROWSER_PROVIDER_PROXY_SCHEMA
  [key: string]: unknown
}

export async function runPhpCommand({
  artifactRoot,
  createRuntimeWpCliBridge,
  runPlaygroundCommand,
  runtimeSpec,
  server,
  spec,
}: {
  artifactRoot: string
  createRuntimeWpCliBridge: CreateRuntimeWpCliBridge
  runPlaygroundCommand: RunPlaygroundCommand
  runtimeSpec: RuntimeCreateSpec
  server: PlaygroundCliServer
  spec: ExecutionSpec
}): Promise<string | RuntimeCommandResultEnvelope> {
  const code = await phpCodeFromArgs(spec.args ?? [])
  const diagnosticsCapture = commandDiagnosticsCaptureSpecFromArgs(spec.args ?? [], spec.diagnostics)
  const bootstrapArgs = diagnosticsCapture ? [...(spec.args ?? []), ...commandDiagnosticsCaptureArgs(diagnosticsCapture)] : spec.args ?? []
  const marker = diagnosticsCapture ? `WP_CODEBOX_COMMAND_DIAGNOSTICS:${randomBytes(16).toString("hex")}:` : undefined
  const commandCode = diagnosticsCapture && marker ? runPhpCommandDiagnosticsPhp(code, marker, diagnosticsCapture.maxItems ?? 50, diagnosticsCapture.maxBytes ?? 64 * 1024) : code
  const bridge = argValue(spec.args ?? [], "wp-cli-bridge") === "1" ? await createRuntimeWpCliBridge(server) : undefined
  let response: PlaygroundRunResponse
  const removeProviderProxy = installBrowserProviderProxy(server)
  try {
    response = await runPlaygroundCommand("wordpress.run-php", server, { code: bootstrapPhpCode(runtimeSpec, commandCode, bootstrapArgs, bridge) })
    assertPlaygroundResponseOk("wordpress.run-php", response)
  } finally {
    await removeProviderProxy?.()
    if (bridge) {
      await bridge.close()
    }
  }

  if (!diagnosticsCapture || !marker) {
    return response.text
  }

  const parsed = splitRunPhpDiagnostics(response.text, marker)
  if (!parsed.diagnostics) {
    return response.text
  }

  const artifact = await writeCommandDiagnosticsArtifact(artifactRoot, parsed.diagnostics)
  return createRuntimeCommandResultEnvelope({
    status: "ok",
    stdout: parsed.stdout,
    diagnostics: parsed.diagnostics,
    artifactRefs: [artifact],
  })
}

interface RunPhpDiagnosticsPayload {
  schema: typeof COMMAND_DIAGNOSTICS_ARTIFACT_SCHEMA
  command: "wordpress.run-php"
  capture: string[]
  limits: { maxItems: number; maxBytes: number }
  summary: { captured: number; truncated: boolean; bytes: number }
  performance?: PerformanceObservation
  wpdbQueries?: Array<{ fingerprint: string; count: number; totalTimeMs?: number; sampleMs?: number; caller?: string }>
}

function runPhpCommandDiagnosticsPhp(code: string, marker: string, maxItems: number, maxBytes: number): string {
  return `
$wp_codebox_command_observation_started_at = gmdate('Y-m-d\\TH:i:s.v\\Z');
$wp_codebox_command_observation_start_time = microtime(true);
$wp_codebox_command_observation_start_memory = memory_get_usage(true);
$wp_codebox_command_diagnostics_start = isset($GLOBALS['wpdb']->queries) && is_array($GLOBALS['wpdb']->queries) ? count($GLOBALS['wpdb']->queries) : 0;
${code.replace(/^<\?php\s*/, "")}
$wp_codebox_command_observation_finished_at = gmdate('Y-m-d\\TH:i:s.v\\Z');
$wp_codebox_command_observation_duration_ms = round((microtime(true) - $wp_codebox_command_observation_start_time) * 1000, 3);
$wp_codebox_command_observation_end_memory = memory_get_usage(true);
$wp_codebox_command_diagnostics_queries = array();
$wp_codebox_command_diagnostics_query_count = 0;
$wp_codebox_command_diagnostics_query_time_ms = 0.0;
$wp_codebox_command_diagnostics_queries_available = isset($GLOBALS['wpdb']->queries) && is_array($GLOBALS['wpdb']->queries);
if ($wp_codebox_command_diagnostics_queries_available) {
    $wp_codebox_command_diagnostics_slice = array_slice($GLOBALS['wpdb']->queries, $wp_codebox_command_diagnostics_start);
    foreach ($wp_codebox_command_diagnostics_slice as $wp_codebox_command_diagnostics_query) {
        $wp_codebox_command_diagnostics_sql = is_array($wp_codebox_command_diagnostics_query) && isset($wp_codebox_command_diagnostics_query[0]) ? (string) $wp_codebox_command_diagnostics_query[0] : '';
        if ($wp_codebox_command_diagnostics_sql === '') {
            continue;
        }
        $wp_codebox_command_diagnostics_query_count++;
        $wp_codebox_command_diagnostics_elapsed_ms = is_array($wp_codebox_command_diagnostics_query) && isset($wp_codebox_command_diagnostics_query[1]) ? round(((float) $wp_codebox_command_diagnostics_query[1]) * 1000, 3) : null;
        if ($wp_codebox_command_diagnostics_elapsed_ms !== null) {
            $wp_codebox_command_diagnostics_query_time_ms += $wp_codebox_command_diagnostics_elapsed_ms;
        }
        $wp_codebox_command_diagnostics_fingerprint = preg_replace('/\\s+/', ' ', trim($wp_codebox_command_diagnostics_sql));
        $wp_codebox_command_diagnostics_fingerprint = preg_replace("/'(?:''|[^'])*'/", "'?'", $wp_codebox_command_diagnostics_fingerprint);
        $wp_codebox_command_diagnostics_fingerprint = preg_replace('/\\b\\d+(?:\\.\\d+)?\\b/', '?', $wp_codebox_command_diagnostics_fingerprint);
        $wp_codebox_command_diagnostics_key = hash('sha256', $wp_codebox_command_diagnostics_fingerprint);
        if (!isset($wp_codebox_command_diagnostics_queries[$wp_codebox_command_diagnostics_key])) {
            $wp_codebox_command_diagnostics_queries[$wp_codebox_command_diagnostics_key] = array(
                'fingerprint' => $wp_codebox_command_diagnostics_fingerprint,
                'count' => 0,
                'sampleMs' => $wp_codebox_command_diagnostics_elapsed_ms,
                'totalTimeMs' => 0,
                'caller' => is_array($wp_codebox_command_diagnostics_query) && isset($wp_codebox_command_diagnostics_query[2]) ? substr((string) $wp_codebox_command_diagnostics_query[2], 0, 240) : null,
            );
        }
        $wp_codebox_command_diagnostics_queries[$wp_codebox_command_diagnostics_key]['count']++;
        if ($wp_codebox_command_diagnostics_elapsed_ms !== null) {
            $wp_codebox_command_diagnostics_queries[$wp_codebox_command_diagnostics_key]['totalTimeMs'] = round($wp_codebox_command_diagnostics_queries[$wp_codebox_command_diagnostics_key]['totalTimeMs'] + $wp_codebox_command_diagnostics_elapsed_ms, 3);
        }
    }
}
$wp_codebox_command_observation_fingerprints = array_values($wp_codebox_command_diagnostics_queries);
$wp_codebox_command_observation_repeated_queries = array_values(array_filter($wp_codebox_command_observation_fingerprints, static function ($wp_codebox_command_observation_query) {
    return isset($wp_codebox_command_observation_query['count']) && $wp_codebox_command_observation_query['count'] > 1;
}));
$wp_codebox_command_diagnostics_payload = array(
    'schema' => 'wp-codebox/command-diagnostics/v1',
    'command' => 'wordpress.run-php',
    'capture' => array('wpdb-queries'),
    'limits' => array('maxItems' => ${maxItems}, 'maxBytes' => ${maxBytes}),
    'summary' => array('captured' => 0, 'truncated' => false, 'bytes' => 0),
    'performance' => array(
        'schema' => '${PERFORMANCE_OBSERVATION_SCHEMA}',
        'command' => 'wordpress.run-php',
        'timing' => array(
            'status' => 'captured',
            'startedAt' => $wp_codebox_command_observation_started_at,
            'finishedAt' => $wp_codebox_command_observation_finished_at,
            'durationMs' => $wp_codebox_command_observation_duration_ms,
        ),
        'memory' => array(
            'status' => 'captured',
            'startBytes' => $wp_codebox_command_observation_start_memory,
            'endBytes' => $wp_codebox_command_observation_end_memory,
            'deltaBytes' => $wp_codebox_command_observation_end_memory - $wp_codebox_command_observation_start_memory,
            'peakBytes' => memory_get_peak_usage(true),
        ),
        'database' => array(
            'status' => $wp_codebox_command_diagnostics_queries_available ? 'captured' : 'uncaptured',
            'reason' => $wp_codebox_command_diagnostics_queries_available ? null : 'wpdb_queries_unavailable',
            'queryCount' => $wp_codebox_command_diagnostics_query_count,
            'totalTimeMs' => round($wp_codebox_command_diagnostics_query_time_ms, 3),
            'fingerprints' => $wp_codebox_command_observation_fingerprints,
            'repeatedQueries' => $wp_codebox_command_observation_repeated_queries,
        ),
        'hooks' => array('status' => 'unsupported', 'reason' => 'hook_timing_not_instrumented', 'timings' => array()),
        'network' => array('status' => 'unsupported', 'reason' => 'php_command_has_no_network_capture'),
        'browser' => array('status' => 'unsupported', 'reason' => 'not_a_browser_observation'),
        'metadata' => array('runner' => 'wp-codebox/runtime-playground', 'surface' => 'php-command'),
    ),
    'wpdbQueries' => $wp_codebox_command_observation_fingerprints,
);
$wp_codebox_command_diagnostics_payload['summary']['captured'] = count($wp_codebox_command_diagnostics_payload['wpdbQueries']);
if (count($wp_codebox_command_diagnostics_payload['wpdbQueries']) > ${maxItems}) {
    $wp_codebox_command_diagnostics_payload['wpdbQueries'] = array_slice($wp_codebox_command_diagnostics_payload['wpdbQueries'], 0, ${maxItems});
    $wp_codebox_command_diagnostics_payload['performance']['database']['fingerprints'] = $wp_codebox_command_diagnostics_payload['wpdbQueries'];
    $wp_codebox_command_diagnostics_payload['performance']['database']['repeatedQueries'] = array_values(array_filter($wp_codebox_command_diagnostics_payload['wpdbQueries'], static function ($wp_codebox_command_observation_query) {
        return isset($wp_codebox_command_observation_query['count']) && $wp_codebox_command_observation_query['count'] > 1;
    }));
    $wp_codebox_command_diagnostics_payload['summary']['truncated'] = true;
}
$wp_codebox_command_diagnostics_json = json_encode($wp_codebox_command_diagnostics_payload, JSON_UNESCAPED_SLASHES);
if (strlen($wp_codebox_command_diagnostics_json) > ${maxBytes}) {
    $wp_codebox_command_diagnostics_payload['wpdbQueries'] = array();
    $wp_codebox_command_diagnostics_payload['performance']['database']['fingerprints'] = array();
    $wp_codebox_command_diagnostics_payload['performance']['database']['repeatedQueries'] = array();
    $wp_codebox_command_diagnostics_payload['summary']['truncated'] = true;
    $wp_codebox_command_diagnostics_json = json_encode($wp_codebox_command_diagnostics_payload, JSON_UNESCAPED_SLASHES);
}
$wp_codebox_command_diagnostics_payload['summary']['bytes'] = strlen($wp_codebox_command_diagnostics_json);
$wp_codebox_command_diagnostics_json = json_encode($wp_codebox_command_diagnostics_payload, JSON_UNESCAPED_SLASHES);
echo "\n${marker}" . json_encode($wp_codebox_command_diagnostics_payload, JSON_UNESCAPED_SLASHES) . "\n";
`
}

function splitRunPhpDiagnostics(stdout: string, marker: string): { stdout: string; diagnostics?: RunPhpDiagnosticsPayload } {
  const index = stdout.lastIndexOf(`\n${marker}`)
  if (index < 0) {
    return { stdout }
  }
  const before = stdout.slice(0, index)
  const after = stdout.slice(index + marker.length + 1).trim()
  try {
    const diagnostics = JSON.parse(after) as RunPhpDiagnosticsPayload
    return { stdout: before, diagnostics }
  } catch {
    return { stdout }
  }
}

async function writeCommandDiagnosticsArtifact(artifactRoot: string, diagnostics: RunPhpDiagnosticsPayload): Promise<RuntimeEpisodeTraceRef> {
  const artifactPath = `files/commands/wordpress-run-php-diagnostics-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}.json`
  const absolutePath = join(artifactRoot, artifactPath)
  const contents = `${JSON.stringify(diagnostics, null, 2)}\n`
  await mkdir(dirname(absolutePath), { recursive: true })
  await writeFile(absolutePath, contents)
  return {
    kind: "command-diagnostics",
    id: "wordpress.run-php:diagnostics",
    path: artifactPath,
    digest: { algorithm: "sha256", value: createHash("sha256").update(contents).digest("hex") },
  }
}

function installBrowserProviderProxy(server: PlaygroundCliServer): (() => Promise<void>) | undefined {
  if (!server.playground.onMessage) {
    return undefined
  }

  const remove = server.playground.onMessage(async (data) => {
    const message = parseBrowserProviderProxyMessage(data)
    if (!message) {
      return undefined
    }

    return JSON.stringify(await executeBrowserProviderProxyRequest(message))
  })

  return async () => {
    const cleanup = await remove
    if (typeof cleanup === "function") {
      await cleanup()
    }
  }
}

function parseBrowserProviderProxyMessage(data: string): BrowserProviderProxyMessage | undefined {
  if (data.length > BROWSER_PROVIDER_PROXY_MAX_BYTES) {
    return undefined
  }

  let message: unknown
  try {
    message = JSON.parse(data)
  } catch {
    return undefined
  }

  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return undefined
  }

  return (message as { schema?: unknown }).schema === BROWSER_PROVIDER_PROXY_SCHEMA
    ? message as BrowserProviderProxyMessage
    : undefined
}

async function executeBrowserProviderProxyRequest(message: BrowserProviderProxyMessage): Promise<Record<string, unknown>> {
  const body = JSON.stringify(message)
  if (body.length > BROWSER_PROVIDER_PROXY_MAX_BYTES) {
    return browserProviderProxyError("wp_codebox_browser_provider_proxy_payload_too_large", "Browser provider proxy request is too large.")
  }

  const endpoint = browserProviderProxyEndpoint()
  if (!endpoint || typeof fetch !== "function") {
    return browserProviderProxyError("wp_codebox_browser_provider_proxy_unavailable", "Browser provider proxy endpoint is unavailable.")
  }

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      credentials: "same-origin",
      headers: browserProviderProxyHeaders(),
      body,
    })
    const json = await response.json().catch(() => undefined)
    if (!response.ok) {
      return browserProviderProxyError("wp_codebox_browser_provider_proxy_http_error", "Browser provider proxy request failed.", { status: response.status, response: json })
    }
    if (!json || typeof json !== "object" || Array.isArray(json)) {
      return browserProviderProxyError("wp_codebox_browser_provider_proxy_malformed_response", "Browser provider proxy returned a malformed response.")
    }

    return json as Record<string, unknown>
  } catch (error) {
    return browserProviderProxyError("wp_codebox_browser_provider_proxy_fetch_failed", error instanceof Error ? error.message : "Browser provider proxy request failed.")
  }
}

function browserProviderProxyEndpoint(): string | undefined {
  const globalValue = globalThis as typeof globalThis & { location?: { origin?: string }; window?: { wpApiSettings?: { root?: string } }; wpApiSettings?: { root?: string } }
  const root = globalValue.wpApiSettings?.root ?? globalValue.window?.wpApiSettings?.root
  if (typeof root === "string" && root.length > 0) {
    return new URL("wp-codebox/v1/browser-provider-request", root).toString()
  }

  if (typeof globalValue.location?.origin === "string" && globalValue.location.origin.length > 0) {
    return new URL("/wp-json/wp-codebox/v1/browser-provider-request", globalValue.location.origin).toString()
  }

  return undefined
}

function browserProviderProxyHeaders(): Record<string, string> {
  const globalValue = globalThis as typeof globalThis & { window?: { wpApiSettings?: { nonce?: string } }; wpApiSettings?: { nonce?: string } }
  const nonce = globalValue.wpApiSettings?.nonce ?? globalValue.window?.wpApiSettings?.nonce
  return {
    "Content-Type": "application/json",
    ...(typeof nonce === "string" && nonce.length > 0 ? { "X-WP-Nonce": nonce } : {}),
  }
}

function browserProviderProxyError(code: string, message: string, data: Record<string, unknown> = {}): Record<string, unknown> {
  const redactedData = redactBrowserProviderProxyData(data)
  return {
    success: false,
    error: {
      code,
      message,
      ...(redactedData && typeof redactedData === "object" && !Array.isArray(redactedData) ? redactedData as Record<string, unknown> : {}),
    },
  }
}

function redactBrowserProviderProxyData(value: unknown): unknown {
  return redactJsonValue(value, { redactStrings: false, extraPattern: /\b(?:key|value)\b/i })
}

export async function runPluginCheckCommand({
  artifactRoot,
  runWpCliCommand,
  server,
  spec,
}: {
  artifactRoot: string
  runWpCliCommand: RunWpCliCommand
  server: PlaygroundCliServer
  spec: ExecutionSpec
}): Promise<{ artifact: PluginCheckArtifact; output: string }> {
  const args = spec.args ?? []
  const pluginSlug = argValue(args, "plugin-slug")?.trim()
  if (!pluginSlug) {
    throw new Error("wordpress.plugin-check requires plugin-slug=<slug>")
  }

  if (!/^[a-z0-9][a-z0-9_-]*$/.test(pluginSlug)) {
    throw new Error("wordpress.plugin-check plugin-slug must be a WordPress plugin slug")
  }
  const checkSlugs = commaListArg(args, "checks")

  if (!server.playground.writeFile) {
    throw new Error("wordpress.plugin-check requires a Playground backend with writeFile support")
  }

  const pluginPath = `/wordpress/wp-content/plugins/${pluginSlug}`
  const existsResponse = await runWpCliCommand(server, ["plugin", "path", pluginSlug])
  if (existsResponse.exitCode !== 0) {
    throw new Error(`wordpress.plugin-check target plugin is not installed or mounted at ${pluginPath}`)
  }

  const rawResponse = await runWpCliCommand(server, [
    "plugin",
    "check",
    pluginSlug,
    "--format=strict-json",
    "--fields=file,line,column,type,code,message,docs",
    "--mode=new",
    ...(checkSlugs.length > 0 ? [`--checks=${checkSlugs.join(",")}`] : []),
  ])
  const rawOutput = cleanWpCliOutput(rawResponse.text)
  const normalized = normalizePluginCheckOutput(rawOutput, rawResponse.exitCode ?? 0, pluginSlug)

  return {
    artifact: await writePluginCheckArtifacts(artifactRoot, pluginSlug, rawOutput, normalized),
    output: `${JSON.stringify(normalized, null, 2)}\n`,
  }
}

export async function runPluginStateCommand({
  runPlaygroundCommand,
  runtimeSpec,
  server,
  spec,
}: {
  runPlaygroundCommand: RunPlaygroundCommand
  runtimeSpec: RuntimeCreateSpec
  server: PlaygroundCliServer
  spec: ExecutionSpec
}): Promise<string> {
  const input = pluginStateInputFromArgs(spec.args ?? [])
  const response = await runPlaygroundCommand("wordpress.plugin-state", server, { code: bootstrapPhpCode(runtimeSpec, pluginStatePhpCode(input), []) })
  assertPlaygroundResponseOk("wordpress.plugin-state", response)
  return response.text
}

export async function runPluginSetupCommand({
  runWpCliArgv,
  server,
  spec,
}: {
  runWpCliArgv: RunWpCliCommand
  server: PlaygroundCliServer
  spec: ExecutionSpec
}): Promise<string> {
  if (!server.playground.writeFile) {
    throw new Error("wordpress.plugin-setup requires a Playground backend with writeFile support")
  }

  const input = pluginSetupInputFromArgs(spec.args ?? [])
  const operations: Array<{ operation: string; exitCode: number; stdout: string; stderr: string }> = []
  const errors: Array<{ code: string; message: string; exitCode?: number }> = []

  if (input.action === "install") {
    const installArgs = ["plugin", "install", input.slug as string, ...(input.activate ? [input.network ? "--activate-network" : "--activate"] : [])]
    const install = await runWpCliArgv(server, installArgs)
    operations.push(operationResult("plugin-install", install))
    if ((install.exitCode ?? 0) !== 0) {
      errors.push({ code: "plugin-install-failed", message: cleanWpCliOutput(install.text).trim() || `Plugin install failed for ${input.slug}.`, exitCode: install.exitCode })
    }
  }

  const list = await runWpCliArgv(server, ["plugin", "list", "--format=json", "--fields=name,status,update,version,title"])
  operations.push(operationResult("plugin-list", list))
  if ((list.exitCode ?? 0) !== 0) {
    errors.push({ code: "plugin-list-failed", message: cleanWpCliOutput(list.text).trim() || "Plugin list failed.", exitCode: list.exitCode })
  }

  const plugins = parseWpCliJsonList(cleanWpCliOutput(list.text))
  return `${JSON.stringify({
    schema: "wp-codebox/wordpress-plugin-setup/v1",
    command: "wordpress.plugin-setup",
    status: errors.length === 0 ? "ok" : "error",
    action: input.action,
    target: input.slug ? { slug: input.slug } : null,
    activate: input.activate,
    network: input.network,
    plugins,
    operations,
    errors,
    artifactRefs: [],
  }, null, 2)}\n`
}

export async function runThemeSetupCommand({
  runWpCliArgv,
  server,
  spec,
}: {
  runWpCliArgv: RunWpCliCommand
  server: PlaygroundCliServer
  spec: ExecutionSpec
}): Promise<string> {
  if (!server.playground.writeFile) {
    throw new Error("wordpress.theme-setup requires a Playground backend with writeFile support")
  }

  const input = themeSetupInputFromArgs(spec.args ?? [])
  const operations: Array<{ operation: string; exitCode: number; stdout: string; stderr: string }> = []
  const errors: Array<{ code: string; message: string; exitCode?: number }> = []

  if (input.action === "install") {
    const install = await runWpCliArgv(server, ["theme", "install", input.slug as string, ...(input.activate ? ["--activate"] : [])])
    operations.push(operationResult("theme-install", install))
    if ((install.exitCode ?? 0) !== 0) {
      errors.push({ code: "theme-install-failed", message: cleanWpCliOutput(install.text).trim() || `Theme install failed for ${input.slug}.`, exitCode: install.exitCode })
    }
  }

  if (input.action === "switch") {
    const activate = await runWpCliArgv(server, ["theme", "activate", input.slug as string])
    operations.push(operationResult("theme-activate", activate))
    if ((activate.exitCode ?? 0) !== 0) {
      errors.push({ code: "theme-switch-failed", message: cleanWpCliOutput(activate.text).trim() || `Theme switch failed for ${input.slug}.`, exitCode: activate.exitCode })
    }
  }

  const list = await runWpCliArgv(server, ["theme", "list", "--format=json", "--fields=name,status,update,version,title"])
  operations.push(operationResult("theme-list", list))
  if ((list.exitCode ?? 0) !== 0) {
    errors.push({ code: "theme-list-failed", message: cleanWpCliOutput(list.text).trim() || "Theme list failed.", exitCode: list.exitCode })
  }

  const themes = parseWpCliJsonList(cleanWpCliOutput(list.text))
  return `${JSON.stringify({
    schema: "wp-codebox/wordpress-theme-setup/v1",
    command: "wordpress.theme-setup",
    status: errors.length === 0 ? "ok" : "error",
    action: input.action,
    target: input.slug ? { slug: input.slug } : null,
    activate: input.activate,
    themes,
    operations,
    errors,
    artifactRefs: [],
  }, null, 2)}\n`
}

export async function runThemeCheckCommand({
  artifactRoot,
  runPlaygroundCommand,
  runWpCliArgv,
  runtimeSpec,
  server,
  spec,
}: {
  artifactRoot: string
  runPlaygroundCommand: RunPlaygroundCommand
  runWpCliArgv: RunWpCliCommand
  runtimeSpec: RuntimeCreateSpec
  server: PlaygroundCliServer
  spec: ExecutionSpec
}): Promise<{ artifact: ThemeCheckArtifact; output: string }> {
  const args = spec.args ?? []
  const theme = argValue(args, "theme")?.trim()
  if (!theme) {
    throw new Error("wordpress.theme-check requires theme=<slug>")
  }

  if (!server.playground.writeFile) {
    throw new Error("wordpress.theme-check requires a Playground backend with writeFile support")
  }

  if (!await themeCheckPluginInstalled(runPlaygroundCommand, server)) {
    const install = await runWpCliArgv(server, ["plugin", "install", "theme-check"])
    assertPlaygroundResponseOk("wordpress.theme-check", install)
  }

  const response = await runPlaygroundCommand("wordpress.theme-check", server, { code: bootstrapPhpCode(runtimeSpec, themeCheckRunCode(theme), []) })
  assertPlaygroundResponseOk("wordpress.theme-check", response)
  const raw = cleanWpCliOutput(response.text)
  const normalized = normalizeThemeCheckOutput(raw, response.exitCode ?? 0, theme)

  return {
    artifact: await writeThemeCheckArtifacts(artifactRoot, theme, raw, normalized),
    output: `${JSON.stringify(normalized, null, 2)}\n`,
  }
}

function operationResult(operation: string, response: PlaygroundRunResponse): { operation: string; exitCode: number; stdout: string; stderr: string } {
  return {
    operation,
    exitCode: response.exitCode ?? 0,
    stdout: cleanWpCliOutput(response.text).trim(),
    stderr: response.errors?.trim() ?? "",
  }
}

function parseWpCliJsonList(output: string): unknown[] {
  try {
    const value = JSON.parse(output.trim() || "[]")
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

export async function runAbilityCommand({
  runPlaygroundCommand,
  runtimeSpec,
  server,
  spec,
}: {
  runPlaygroundCommand: RunPlaygroundCommand
  runtimeSpec: RuntimeCreateSpec
  server: PlaygroundCliServer
  spec: ExecutionSpec
}): Promise<RuntimeCommandResultEnvelope> {
  const name = argValue(spec.args ?? [], "name")?.trim()
  if (!name) {
    throw new Error("wordpress.ability requires name=<ability-name>")
  }

  const input = abilityInputFromArgs(spec.args ?? [])
  const userSession = wordpressUserSessionFromCommandArgs(spec.args ?? [], runtimeSpec)
  const principal = abilityPrincipalFromArgs(spec.args ?? [])
  if (userSession && principal) {
    throw new Error("wordpress.ability accepts either user/session or principal, not both")
  }
  const expectedResultSchema = expectedAbilityResultSchemaFromArgs(spec.args ?? [])
  const response = await runPlaygroundCommand("wordpress.ability", server, { code: bootstrapAbilityPhpCode(runtimeSpec, abilityPhpCode({ name, input, userSession, principal })) })
  assertPlaygroundResponseOk("wordpress.ability", response)
  return abilityResponseToCommandEnvelope(cleanWpCliOutput(response.text), name, input, expectedResultSchema)
}

export async function runRestRequestCommand({
  runPlaygroundCommand,
  runtimeSpec,
  server,
  spec,
}: {
  runPlaygroundCommand: RunPlaygroundCommand
  runtimeSpec: RuntimeCreateSpec
  server: PlaygroundCliServer
  spec: ExecutionSpec
}): Promise<string> {
  const input = restRequestInputFromArgs(spec.args ?? [])
  input.userSession = wordpressUserSessionFromCommandArgs(spec.args ?? [], runtimeSpec)
  const response = await runPlaygroundCommand("wordpress.rest-request", server, { code: bootstrapPhpCode(runtimeSpec, restRequestPhpCode(input), []) })
  assertPlaygroundResponseOk("wordpress.rest-request", response)
  return response.text
}

export async function runRuntimeDiscoveryCommand({
  runPlaygroundCommand,
  runtimeSpec,
  server,
  spec,
}: {
  runPlaygroundCommand: RunPlaygroundCommand
  runtimeSpec: RuntimeCreateSpec
  server: PlaygroundCliServer
  spec: ExecutionSpec
}): Promise<string> {
  const surfaces = runtimeDiscoverySurfacesFromArgs(spec.args ?? [])
  const response = await runPlaygroundCommand("wordpress.runtime-discovery", server, { code: bootstrapPhpCode(runtimeSpec, runtimeDiscoveryPhpCode(surfaces), []) })
  assertPlaygroundResponseOk("wordpress.runtime-discovery", response)
  return response.text
}

export async function runRuntimeInventoryCommand({
  command,
  runPlaygroundCommand,
  runtimeSpec,
  schema,
  server,
  surface,
}: {
  command: string
  runPlaygroundCommand: RunPlaygroundCommand
  runtimeSpec: RuntimeCreateSpec
  schema: string
  server: PlaygroundCliServer
  surface: "rest" | "admin" | "database" | "frontend"
}): Promise<string> {
  const response = await runPlaygroundCommand(command, server, { code: bootstrapPhpCode(runtimeSpec, runtimeInventoryPhpCode(surface, command, schema), []) })
  assertPlaygroundResponseOk(command, response)
  return response.text
}

export async function runPageLoadCommand({
  artifactRoot,
  runPlaygroundCommand,
  runtimeSpec,
  server,
  spec,
  surface,
}: {
  artifactRoot: string
  runPlaygroundCommand: RunPlaygroundCommand
  runtimeSpec: RuntimeCreateSpec
  server: PlaygroundCliServer
  spec: ExecutionSpec
  surface: "admin" | "frontend"
}): Promise<string> {
  const input = pageLoadInputFromArgs(spec.args ?? [], surface, spec.command as Parameters<typeof pageLoadInputFromArgs>[2])
  input.userSession = wordpressUserSessionFromCommandArgs(spec.args ?? [], runtimeSpec)
  const response = await runPlaygroundCommand(input.command, server, { code: bootstrapPhpCode(runtimeSpec, pageLoadPhpCode(input), []) })
  assertPlaygroundResponseOk(input.command, response)
  const result = JSON.parse(cleanWpCliOutput(response.text)) as Record<string, unknown>
  const artifact = await writePageLoadResultArtifact(artifactRoot, input.command, result)
  result.artifactRefs = [...(Array.isArray(result.artifactRefs) ? result.artifactRefs : []), artifact]
  return `${JSON.stringify(result, null, 2)}\n`
}

async function writePageLoadResultArtifact(artifactRoot: string, command: string, result: Record<string, unknown>): Promise<{ path: string; kind: string; contentType: string; sha256: string; metadata: Record<string, unknown> }> {
  const artifactPath = `files/commands/${command.replace(/[^a-z0-9.-]+/gi, "-")}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}.json`
  const absolutePath = join(artifactRoot, artifactPath)
  const contents = `${JSON.stringify(result, null, 2)}\n`
  await mkdir(dirname(absolutePath), { recursive: true })
  await writeFile(absolutePath, contents)
  return {
    path: artifactPath,
    kind: "wordpress-page-load-result",
    contentType: "application/json",
    sha256: createHash("sha256").update(contents).digest("hex"),
    metadata: { command, schema: result.schema ?? null },
  }
}

export async function runHttpRequestCommand({
  baseUrl,
  spec,
}: {
  baseUrl: string
  spec: ExecutionSpec
}): Promise<string> {
  return runHttpRequest(httpRequestInputFromArgs(spec.args ?? []), baseUrl)
}

export async function runServerPageLoadCommand({
  baseUrl,
  spec,
}: {
  baseUrl: string
  spec: ExecutionSpec
}): Promise<string> {
  const args = spec.args ?? []
  const surface = serverPageLoadSurface(args)
  const path = argValue(args, "path")?.trim() || (surface === "admin" ? "index.php" : "/")
  const input = httpRequestInputFromArgs(serverPageLoadArgs(args, surface, path))
  input.command = "wordpress.server-page-load"
  input.pageLoadTarget = { kind: surface, path }
  return runHttpRequest(input, baseUrl)
}

function serverPageLoadArgs(args: string[], surface: "admin" | "frontend", path: string): string[] {
  const url = argValue(args, "url")?.trim()
  const resolved = url || (surface === "admin" ? `/wp-admin/${path.replace(/^\/+/, "")}` : `/${path.replace(/^\/+/, "")}`)
  return [`url=${resolved}`, ...args.filter((arg) => !arg.startsWith("surface=") && !arg.startsWith("path=") && !arg.startsWith("url="))]
}

function serverPageLoadSurface(args: string[]): "admin" | "frontend" {
  return argValue(args, "surface")?.trim().toLowerCase() === "admin" ? "admin" : "frontend"
}

export async function runBenchCommand({
  browserProbes,
  createRuntimeWpCliBridge,
  runPlaygroundCommand,
  runtimeSpec,
  server,
  spec,
}: {
  browserProbes: BrowserArtifact[]
  createRuntimeWpCliBridge: CreateRuntimeWpCliBridge
  runPlaygroundCommand: RunPlaygroundCommand
  runtimeSpec: RuntimeCreateSpec
  server: PlaygroundCliServer
  spec: ExecutionSpec
}): Promise<string> {
  const args = spec.args ?? []
  const pluginSlug = argValue(args, "plugin-slug")?.trim()
  if (!pluginSlug) {
    throw new Error("wordpress.bench requires plugin-slug=<slug>")
  }

  const componentId = argValue(args, "component-id")?.trim() || pluginSlug
  const iterations = positiveIntegerArg(args, "iterations", 3)
  const warmupIterations = nonNegativeIntegerArg(args, "warmup", 1)
  const dependencySlugs = commaListArg(args, "dependency-slugs")
  const env = jsonObjectArg(args, "env-json")
  const bootstrapFiles = jsonArrayArg(args, "bootstrap-files-json").filter((file): file is string => typeof file === "string")
  const workloads = jsonArrayArg(args, "workloads-json")
  const scenarioIds = jsonArrayArg(args, "scenario-ids-json").filter((id): id is string => typeof id === "string" && id.trim() !== "").map((id) => id.trim())
  const lifecycle = jsonObjectArg(args, "lifecycle-json")
  const resetPolicy = jsonObjectArg(args, "reset-policy-json")
  const bridge = benchWorkloadsUseWpCli([workloads, lifecycle]) ? await createRuntimeWpCliBridge(server) : undefined
  let response: PlaygroundRunResponse
  try {
    response = await runPlaygroundCommand("wordpress.bench", server, {
      code: bootstrapPhpCode(runtimeSpec, benchRunCode({ componentId, pluginSlug, iterations, warmupIterations, dependencySlugs, env, bootstrapFiles, workloads, scenarioIds, lifecycle, resetPolicy, wpCliBridge: bridge }), []),
    })
    assertPlaygroundResponseOk("wordpress.bench", response)
  } finally {
    if (bridge) {
      await bridge.close()
    }
  }

  return promoteBrowserMetricsToBenchResults(response.text, browserProbes)
}

export async function runPhpunitCommand({
  artifactRoot,
  mounts,
  runPlaygroundCommand,
  server,
  spec,
}: {
  artifactRoot: string
  mounts: MountSpec[]
  runPlaygroundCommand: RunPlaygroundCommand
  server: PlaygroundCliServer
  spec: ExecutionSpec
}): Promise<string> {
  const args = spec.args ?? []
  const explicitCode = argValue(args, "code") || argValue(args, "code-file")
  const pluginSlug = argValue(args, "plugin-slug")?.trim() || ""
  const resultFile = PLUGIN_PHPUNIT_RESULT_FILE
  const code = explicitCode ? await phpCodeFromArgs(args, "wordpress.phpunit") : normalizePhpCode(phpunitRunCode({
    pluginSlug,
    cwd: argValue(args, "cwd")?.trim() || `/wordpress/wp-content/plugins/${pluginSlug}`,
    autoloadFile: argValue(args, "autoload-file")?.trim() || "/wp-codebox-vendor/autoload.php",
    testsDir: argValue(args, "tests-dir")?.trim() || "/wp-codebox-vendor/wp-phpunit/wp-phpunit",
    phpunitXml: argValue(args, "phpunit-xml")?.trim() || `/wordpress/wp-content/plugins/${pluginSlug}/phpunit.xml.dist`,
    selectedTestFile: argValue(args, "test-file")?.trim() || "",
    changedTestFiles: jsonArrayArg(args, "changed-tests-json"),
    phpunitArgs: jsonArrayArg(args, "phpunit-args-json").filter((value): value is string => typeof value === "string"),
    env: jsonObjectArg(args, "env-json"),
    wpConfigDefines: jsonObjectArg(args, "wp-config-defines-json"),
    dependencyMounts: commaListArg(args, "dependency-mounts"),
    bootstrapFiles: jsonArrayArg(args, "bootstrap-files-json").filter((value): value is string => typeof value === "string"),
    bootstrapMode: argValue(args, "bootstrap-mode")?.trim() || "managed",
    projectBootstrap: argValue(args, "project-bootstrap")?.trim() || "",
    multisite: booleanArg(args, "multisite"),
    resultFile,
  }))
  if (!explicitCode && !pluginSlug) {
    throw new Error("wordpress.phpunit requires plugin-slug=<slug> when code/code-file is not provided")
  }
  let response: PlaygroundRunResponse
  try {
    response = await runPlaygroundCommand("wordpress.phpunit", server, { code })
  } catch (error) {
    await persistPluginPhpunitResult(server, resultFile, artifactRoot)
    await persistVfsDiagnosticFileToHost(server, resultFile, `/wordpress/wp-content/plugins/${pluginSlug}/.pg-test-result.txt`, mounts)
    const structured = await readPluginPhpunitDiagnostic(server, resultFile)
    if (structured) {
      throw new Error(`wordpress.phpunit could not run: ${structured}`)
    }
    throw error
  }

  await persistPluginPhpunitResult(server, resultFile, artifactRoot)
  await persistVfsDiagnosticFileToHost(server, resultFile, `/wordpress/wp-content/plugins/${pluginSlug}/.pg-test-result.txt`, mounts)
  assertPlaygroundResponseOk("wordpress.phpunit", response)

  return response.text
}

export async function runCorePhpunitCommand({
  artifactRoot,
  runPlaygroundCommand,
  server,
  spec,
}: {
  artifactRoot: string
  runPlaygroundCommand: RunPlaygroundCommand
  server: PlaygroundCliServer
  spec: ExecutionSpec
}): Promise<string> {
  const args = spec.args ?? []
  const explicitCode = argValue(args, "code") || argValue(args, "code-file")
  // Write structured diagnostics to a sandbox-internal /tmp path rather than inside
  // the (often read-only) core mount, so the result survives read-only mounts and a
  // mid-require die() in core's bootstrap.php and can be read back from the VFS (#314).
  const resultFile = CORE_PHPUNIT_RESULT_FILE
  const code = explicitCode ? await phpCodeFromArgs(args, "wordpress.core-phpunit") : normalizePhpCode(corePhpunitRunCode({
    coreRoot: argValue(args, "core-root")?.trim() || "/wordpress",
    testsDir: argValue(args, "tests-dir")?.trim() || "/wordpress/tests/phpunit",
    phpunitXml: argValue(args, "phpunit-xml")?.trim() || "/wordpress/tests/phpunit/phpunit.xml.dist",
    selectedTestFile: argValue(args, "test-file")?.trim() || "",
    changedTestFiles: jsonArrayArg(args, "changed-tests-json"),
    autoloadFile: argValue(args, "autoload-file")?.trim() || "/wordpress/vendor/autoload.php",
    wpConfigDefines: jsonObjectArg(args, "wp-config-defines-json"),
    multisite: booleanArg(args, "multisite"),
    resultFile,
  }))

  let response: PlaygroundRunResponse
  try {
    response = await runPlaygroundCommand("wordpress.core-phpunit", server, { code })
  } catch (error) {
    // Core's bootstrap can die() mid-require when the Composer test toolchain is
    // absent, which surfaces here as a PlaygroundCommandCrashError with empty
    // output. Recover the structured diagnostics the PHP shutdown handler flushed
    // to the result file and re-throw a clear, actionable error instead (#314).
    await persistCorePhpunitResult(server, resultFile, artifactRoot)
    const structured = await readCorePhpunitDiagnostic(server, resultFile)
    if (structured) {
      throw new Error(`wordpress.core-phpunit could not run: ${structured}`)
    }
    throw error
  }

  await persistCorePhpunitResult(server, resultFile, artifactRoot)
  assertPlaygroundResponseOk("wordpress.core-phpunit", response)

  return response.text
}

function benchWorkloadsUseWpCli(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(benchWorkloadsUseWpCli)
  }
  if (!value || typeof value !== "object") {
    return false
  }

  const record = value as { type?: unknown; run?: unknown }
  return record.type === "wp-cli" || benchWorkloadsUseWpCli(record.run)
}

async function themeCheckPluginInstalled(runPlaygroundCommand: RunPlaygroundCommand, server: PlaygroundCliServer): Promise<boolean> {
  const response = await runPlaygroundCommand("wordpress.theme-check", server, {
    code: "<?php echo file_exists('/wordpress/wp-content/plugins/theme-check/theme-check.php') ? 'yes' : 'no';",
  })

  return response.text.trim() === "yes"
}
