import { createHash, randomBytes } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { BrowserArtifact } from "./browser-artifacts.js"
import { promoteBrowserMetricsToBenchResults } from "./browser-metrics.js"
import { writePluginCheckArtifacts, writeThemeCheckArtifacts, type PluginCheckArtifact, type ThemeCheckArtifact } from "./check-artifacts.js"
import {
  abilityInputFromArgs,
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
  phpunitRunCode,
  pluginStateInputFromArgs,
  pluginStatePhpCode,
  PLUGIN_PHPUNIT_RESULT_FILE,
  positiveIntegerArg,
  httpRequestInputFromArgs,
  runHttpRequest,
  restRequestInputFromArgs,
  restRequestPhpCode,
  themeCheckRunCode,
} from "./commands.js"
import { bootstrapAbilityPhpCode, bootstrapPhpCode, phpCodeFromArgs } from "./php-bootstrap.js"
import { assertPlaygroundResponseOk, type PlaygroundRunResponse } from "./playground-command-errors.js"
import type { PlaygroundCliServer } from "./preview-server.js"
import { persistCorePhpunitResult, persistPluginPhpunitResult, persistVfsDiagnosticFileToHost, readCorePhpunitDiagnostic, readPluginPhpunitDiagnostic } from "./runtime-diagnostics.js"
import type { RuntimeWpCliBridge } from "./runtime-wp-cli-bridge.js"
import { COMMAND_DIAGNOSTICS_ARTIFACT_SCHEMA, commandDiagnosticsCaptureArgs, commandDiagnosticsCaptureSpecFromArgs, createRuntimeCommandResultEnvelope, redactJsonValue, type ExecutionSpec, type MountSpec, type RuntimeCommandResultEnvelope, type RuntimeCreateSpec, type RuntimeEpisodeTraceRef } from "@automattic/wp-codebox-core"
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
  wpdbQueries?: Array<{ fingerprint: string; count: number; sampleMs?: number; caller?: string }>
}

function runPhpCommandDiagnosticsPhp(code: string, marker: string, maxItems: number, maxBytes: number): string {
  return `
$wp_codebox_command_diagnostics_start = isset($GLOBALS['wpdb']->queries) && is_array($GLOBALS['wpdb']->queries) ? count($GLOBALS['wpdb']->queries) : 0;
${code.replace(/^<\?php\s*/, "")}
$wp_codebox_command_diagnostics_queries = array();
if (isset($GLOBALS['wpdb']->queries) && is_array($GLOBALS['wpdb']->queries)) {
    $wp_codebox_command_diagnostics_slice = array_slice($GLOBALS['wpdb']->queries, $wp_codebox_command_diagnostics_start);
    foreach ($wp_codebox_command_diagnostics_slice as $wp_codebox_command_diagnostics_query) {
        $wp_codebox_command_diagnostics_sql = is_array($wp_codebox_command_diagnostics_query) && isset($wp_codebox_command_diagnostics_query[0]) ? (string) $wp_codebox_command_diagnostics_query[0] : '';
        if ($wp_codebox_command_diagnostics_sql === '') {
            continue;
        }
        $wp_codebox_command_diagnostics_fingerprint = preg_replace('/\\s+/', ' ', trim($wp_codebox_command_diagnostics_sql));
        $wp_codebox_command_diagnostics_fingerprint = preg_replace("/'(?:''|[^'])*'/", "'?'", $wp_codebox_command_diagnostics_fingerprint);
        $wp_codebox_command_diagnostics_fingerprint = preg_replace('/\\b\\d+(?:\\.\\d+)?\\b/', '?', $wp_codebox_command_diagnostics_fingerprint);
        $wp_codebox_command_diagnostics_key = hash('sha256', $wp_codebox_command_diagnostics_fingerprint);
        if (!isset($wp_codebox_command_diagnostics_queries[$wp_codebox_command_diagnostics_key])) {
            $wp_codebox_command_diagnostics_queries[$wp_codebox_command_diagnostics_key] = array(
                'fingerprint' => $wp_codebox_command_diagnostics_fingerprint,
                'count' => 0,
                'sampleMs' => is_array($wp_codebox_command_diagnostics_query) && isset($wp_codebox_command_diagnostics_query[1]) ? round(((float) $wp_codebox_command_diagnostics_query[1]) * 1000, 3) : null,
                'caller' => is_array($wp_codebox_command_diagnostics_query) && isset($wp_codebox_command_diagnostics_query[2]) ? substr((string) $wp_codebox_command_diagnostics_query[2], 0, 240) : null,
            );
        }
        $wp_codebox_command_diagnostics_queries[$wp_codebox_command_diagnostics_key]['count']++;
    }
}
$wp_codebox_command_diagnostics_payload = array(
    'schema' => 'wp-codebox/command-diagnostics/v1',
    'command' => 'wordpress.run-php',
    'capture' => array('wpdb-queries'),
    'limits' => array('maxItems' => ${maxItems}, 'maxBytes' => ${maxBytes}),
    'summary' => array('captured' => 0, 'truncated' => false, 'bytes' => 0),
    'wpdbQueries' => array_values($wp_codebox_command_diagnostics_queries),
);
$wp_codebox_command_diagnostics_payload['summary']['captured'] = count($wp_codebox_command_diagnostics_payload['wpdbQueries']);
if (count($wp_codebox_command_diagnostics_payload['wpdbQueries']) > ${maxItems}) {
    $wp_codebox_command_diagnostics_payload['wpdbQueries'] = array_slice($wp_codebox_command_diagnostics_payload['wpdbQueries'], 0, ${maxItems});
    $wp_codebox_command_diagnostics_payload['summary']['truncated'] = true;
}
$wp_codebox_command_diagnostics_json = json_encode($wp_codebox_command_diagnostics_payload, JSON_UNESCAPED_SLASHES);
if (strlen($wp_codebox_command_diagnostics_json) > ${maxBytes}) {
    $wp_codebox_command_diagnostics_payload['wpdbQueries'] = array();
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
  const expectedResultSchema = expectedAbilityResultSchemaFromArgs(spec.args ?? [])
  const response = await runPlaygroundCommand("wordpress.ability", server, { code: bootstrapAbilityPhpCode(runtimeSpec, abilityPhpCode(name, input)) })
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

export async function runHttpRequestCommand({
  baseUrl,
  spec,
}: {
  baseUrl: string
  spec: ExecutionSpec
}): Promise<string> {
  return runHttpRequest(httpRequestInputFromArgs(spec.args ?? []), baseUrl)
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
