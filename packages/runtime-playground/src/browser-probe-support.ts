import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { redactString, resolveCommandPath, type BrowserInteractionStep, type RuntimeCreateSpec } from "@automattic/wp-codebox-core"
import { normalizeBrowserStorageStatePayload, type BrowserStorageStateImportSummary } from "./browser-auth-storage-state.js"
import type { BrowserProbeArtifactRef, BrowserProbeAuthSummary, BrowserProbeErrorRecord, BrowserProbeNetworkCountSummary, BrowserProbeNetworkRecord, BrowserProbeWaterfallArtifact, BrowserProbeWaterfallEntry, BrowserRedirectDiagnosticsSummary, BrowserWordPressDiagnosticsSummary } from "./browser-artifacts.js"
import { browserCommandLivenessPolicy, isBrowserCommandLivenessError, withBrowserCommandLiveness, type BrowserCommandLivenessPolicy } from "./browser-liveness.js"
import { bootstrapPhpCode } from "./php-bootstrap.js"
import { phpBrowserWordPressDiagnosticsPlugin } from "./php-snippets.js"
import { assertPlaygroundResponseOk, type PlaygroundRunResponse } from "./playground-command-errors.js"
import type { PlaygroundCliServer } from "./preview-server.js"
import { resolveBrowserPreviewUrl } from "./browser-preview-routing.js"
import { argValue, cleanWpCliOutput } from "./commands.js"

export interface BrowserStorageStateImport {
  storageState: import("./browser-auth-storage-state.js").BrowserAuthStorageState
  summary: BrowserStorageStateImportSummary
}

export interface BrowserCommandProgressEvent {
  command: string
  phase: "checkpoint"
  checkpoint: BrowserProbeScriptCheckpoint
  progress: ReturnType<ReturnType<typeof createBrowserProbeProgressTracker>["summary"]>
}

export interface BrowserProbeScriptCheckpoint {
  name: string
  metadata?: unknown
  timestamp: string
}

export function browserProbeWaterfallArtifact(network: BrowserProbeNetworkRecord[], startedAt: string): BrowserProbeWaterfallArtifact {
  return {
    schema: "wp-codebox/browser-waterfall/v1",
    version: 1,
    capturedAt: now(),
    startedAt,
    summary: {
      requests: network.length,
      responses: network.filter((record) => record.type === "response").length,
      failures: network.filter((record) => record.type === "requestfailed").length,
      transferSizeBytes: network.reduce((total, record) => total + finiteNumber(record.transferSize, 0), 0),
    },
    log: {
      version: "1.2",
      creator: { name: "wp-codebox", version: "1" },
      entries: network.map(browserProbeWaterfallEntry),
    },
  }
}

function browserProbeWaterfallEntry(record: BrowserProbeNetworkRecord): BrowserProbeWaterfallEntry {
  const timings = browserProbeWaterfallTimings(record.timing ?? {})
  const startedDateTime = browserProbeWaterfallStartedDateTime(record)
  const responseEnd = finiteNumber(record.timing?.responseEnd, 0)
  const fallbackTime = Math.max(0, Date.parse(record.timestamp) - Date.parse(startedDateTime))
  const time = responseEnd > 0 ? responseEnd : fallbackTime
  return {
    startedDateTime,
    time,
    request: {
      method: record.method,
      url: redactBrowserArtifactUrl(record.url),
    },
    response: {
      status: record.status ?? 0,
      statusText: record.statusText ?? (record.type === "requestfailed" ? "Request Failed" : ""),
      content: { mimeType: record.contentType ?? "" },
      redirectURL: "",
    },
    cache: {},
    timings,
    _wpCodebox: {
      type: record.type,
      resourceType: record.resourceType,
      timestamp: record.timestamp,
      ...(typeof record.ok === "boolean" ? { ok: record.ok } : {}),
      ...(typeof record.transferSize === "number" ? { transferSize: record.transferSize } : {}),
      ...(typeof record.requestBodySize === "number" ? { requestBodySize: record.requestBodySize } : {}),
      ...(typeof record.responseBodySize === "number" ? { responseBodySize: record.responseBodySize } : {}),
      ...(record.failure ? { failure: record.failure } : {}),
    },
  }
}

function browserProbeWaterfallTimings(timing: Record<string, number>): BrowserProbeWaterfallEntry["timings"] {
  const requestStart = finiteNumber(timing.requestStart, 0)
  const responseStart = finiteNumber(timing.responseStart, 0)
  const responseEnd = finiteNumber(timing.responseEnd, responseStart)
  const dns = timingDelta(timing.domainLookupStart, timing.domainLookupEnd)
  const connect = timingDelta(timing.connectStart, timing.connectEnd)
  const ssl = timingDelta(timing.secureConnectionStart, timing.connectEnd)
  return {
    blocked: Math.max(0, requestStart),
    dns,
    connect,
    ssl,
    send: timingDelta(timing.requestStart, timing.requestStart),
    wait: responseStart >= requestStart ? responseStart - requestStart : 0,
    receive: responseEnd >= responseStart ? responseEnd - responseStart : 0,
  }
}

function browserProbeWaterfallStartedDateTime(record: BrowserProbeNetworkRecord): string {
  const startTime = record.timing?.startTime
  if (typeof startTime === "number" && Number.isFinite(startTime) && startTime > 0) {
    return new Date(startTime).toISOString()
  }
  return record.timestamp
}

function timingDelta(start: number | undefined, end: number | undefined): number {
  if (typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
    return -1
  }
  return end - start
}

function finiteNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function redactBrowserArtifactUrl(url: string): string {
  return redactString(url, { redactAllUrlQueryValues: true, redactUrlHash: true, redactQueryAssignments: true })
}

export function addBrowserProbeNetworkCount(target: Record<string, BrowserProbeNetworkCountSummary>, key: string, record: BrowserProbeNetworkRecord): void {
  const summary = target[key] ?? { requests: 0, responses: 0, failures: 0, transferSizeBytes: 0 }
  summary.requests += 1
  if (record.type === "response") {
    summary.responses += 1
  }
  if (record.type === "requestfailed") {
    summary.failures += 1
  }
  summary.transferSizeBytes += typeof record.transferSize === "number" && Number.isFinite(record.transferSize) ? record.transferSize : 0
  target[key] = summary
}

export function sortBrowserProbeNetworkCounts(value: Record<string, BrowserProbeNetworkCountSummary>): Record<string, BrowserProbeNetworkCountSummary> {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
}

export function requestHost(url: string): string | undefined {
  try {
    return new URL(url).host
  } catch {
    return undefined
  }
}

export function browserProbeArtifactRefs(browserFilesDirectory: string, capture: Set<string>, input: {
  checkpoints: boolean
  console: boolean
  errors: boolean
  html?: string
  lifecycle: boolean
  memory: boolean
  network: boolean
  waterfall: boolean
  performance: boolean
  redirectDiagnostics: boolean
  screenshot?: string
  wordpressDiagnostics: boolean
}): Record<string, BrowserProbeArtifactRef> {
  return {
    ...(input.console ? { console: { path: `${browserFilesDirectory}/console.jsonl`, kind: "jsonl" as const } } : {}),
    ...(input.checkpoints ? { checkpoints: { path: `${browserFilesDirectory}/checkpoints.jsonl`, kind: "jsonl" as const } } : {}),
    ...(input.errors ? { errors: { path: `${browserFilesDirectory}/errors.jsonl`, kind: "jsonl" as const } } : {}),
    ...(input.html ? { html: { path: `${browserFilesDirectory}/snapshot.html`, kind: "html" as const, sha256: input.html } } : {}),
    ...(input.lifecycle ? { lifecycle: { path: `${browserFilesDirectory}/lifecycle.json`, kind: "json" as const } } : {}),
    ...(input.memory ? { memory: { path: `${browserFilesDirectory}/memory.json`, kind: "json" as const } } : {}),
    ...(input.network ? { network: { path: `${browserFilesDirectory}/network.jsonl`, kind: "jsonl" as const } } : {}),
    ...(input.waterfall ? { waterfall: { path: `${browserFilesDirectory}/waterfall.json`, kind: "json" as const } } : {}),
    ...(input.performance ? { performance: { path: `${browserFilesDirectory}/performance.json`, kind: "json" as const } } : {}),
    ...(input.redirectDiagnostics ? { redirectDiagnostics: { path: `${browserFilesDirectory}/redirect-diagnostics.json`, kind: "json" as const } } : {}),
    review: { path: `${browserFilesDirectory}/review.json`, kind: "json" as const },
    ...(capture.has("screenshot") ? { screenshot: { path: `${browserFilesDirectory}/screenshot.png`, kind: "png" as const, ...(input.screenshot ? { sha256: input.screenshot } : {}) } } : {}),
    ...(input.wordpressDiagnostics ? { wordpressDiagnostics: { path: `${browserFilesDirectory}/wordpress-diagnostics.json`, kind: "json" as const } } : {}),
    summary: { path: `${browserFilesDirectory}/summary.json`, kind: "json" as const },
  }
}

export function safeBrowserProbeUrl(value: string | undefined): string | null {
  if (!value) {
    return null
  }
  if (/^data:/i.test(value)) {
    return "data:[redacted]"
  }
  return value
}

export interface BrowserRedirectDiagnosticsArtifact {
  schema: "wp-codebox/browser-redirect-diagnostics/v1"
  version: 1
  capturedAt: string
  status: BrowserRedirectDiagnosticsSummary["status"]
  classification: BrowserRedirectDiagnosticsSummary["classification"]
  reason: string
  error?: { name: string; message: string }
  chain: BrowserRedirectDiagnosticsChainEntry[]
  summary: BrowserRedirectDiagnosticsSummary
}

export interface BrowserRedirectDiagnosticsChainEntry {
  url: string
  method: string
  status?: number
  statusText?: string
  timestamp: string
  host?: string
  path?: string
  queryKeys: string[]
  redactedQueryKeys: string[]
}

export function browserRedirectDiagnosticsArtifact({
  artifactPath,
  error,
  finalAttemptedUrl,
  network,
  requestedUrl,
}: {
  artifactPath: string
  error?: Error
  finalAttemptedUrl: string
  network: BrowserProbeNetworkRecord[]
  requestedUrl: string
}): BrowserRedirectDiagnosticsArtifact | undefined {
  const errorMessage = error?.message ?? ""
  const tooManyRedirects = /ERR_TOO_MANY_REDIRECTS/i.test(errorMessage)
  const documentEvents = network.filter((record) => record.resourceType === "document")
  const redirectResponses = documentEvents.filter((record) => record.type === "response" && typeof record.status === "number" && record.status >= 300 && record.status < 400)
  const chain = documentEvents.map(browserRedirectDiagnosticsChainEntry)
  const repeatedUrls = repeatedBrowserRedirectValues(chain.map((entry) => entry.url), "url")
  const repeatedHosts = repeatedBrowserRedirectValues(chain.map((entry) => entry.host).filter((host): host is string => Boolean(host)), "host")
  const repeatedPaths = repeatedBrowserRedirectValues(chain.map((entry) => entry.path).filter((path): path is string => Boolean(path)), "path")
  const hasRepeatedTarget = repeatedUrls.length > 0 || repeatedHosts.length > 0 || repeatedPaths.length > 0

  if (!tooManyRedirects && redirectResponses.length === 0 && !hasRepeatedTarget) {
    return undefined
  }

  const finalAttempted = browserRedirectSafeUrl(extractBrowserNavigationUrl(errorMessage) ?? finalAttemptedUrl)
  const firstUrl = chain[0]?.url ?? browserRedirectSafeUrl(requestedUrl)
  const lastUrl = chain.at(-1)?.url ?? finalAttempted
  const sanitizedQueryKeys = [...new Set(chain.flatMap((entry) => entry.queryKeys))].sort()
  const redactedQueryKeys = [...new Set(chain.flatMap((entry) => entry.redactedQueryKeys))].sort()
  const classification: BrowserRedirectDiagnosticsSummary["classification"] = tooManyRedirects || hasRepeatedTarget ? "redirect-loop" : "redirect-chain"
  const reason = tooManyRedirects
    ? "playwright reported ERR_TOO_MANY_REDIRECTS"
    : hasRepeatedTarget ? "document navigation repeated URL, host, or path values" : "document navigation included redirect responses"
  const summary: BrowserRedirectDiagnosticsSummary = {
    status: "captured",
    artifact: artifactPath,
    classification,
    reason,
    documentEvents: chain.length,
    redirectResponses: redirectResponses.length,
    repeatedUrls,
    repeatedHosts,
    repeatedPaths,
    ...(firstUrl ? { firstUrl } : {}),
    ...(lastUrl ? { lastUrl } : {}),
    ...(finalAttempted ? { finalAttemptedUrl: finalAttempted } : {}),
    sanitizedQueryKeys,
    redactedQueryKeys,
  }

  return {
    schema: "wp-codebox/browser-redirect-diagnostics/v1",
    version: 1,
    capturedAt: now(),
    status: "captured",
    classification,
    reason,
    ...(error ? { error: { name: error.name, message: sanitizeBrowserRedirectMessage(error.message) } } : {}),
    chain,
    summary,
  }
}

export function browserRedirectDiagnosticsChainEntry(record: BrowserProbeNetworkRecord): BrowserRedirectDiagnosticsChainEntry {
  const parsed = parseBrowserRedirectUrl(record.url)
  return {
    url: browserRedirectSafeUrl(record.url),
    method: record.method,
    ...(typeof record.status === "number" ? { status: record.status } : {}),
    ...(record.statusText ? { statusText: record.statusText } : {}),
    timestamp: record.timestamp,
    ...(parsed ? { host: parsed.host, path: parsed.pathname } : {}),
    queryKeys: parsed?.queryKeys ?? [],
    redactedQueryKeys: parsed?.redactedQueryKeys ?? [],
  }
}

export function browserRedirectSafeUrl(value: string): string {
  if (/^data:/i.test(value)) {
    return "data:[redacted]"
  }
  const parsed = parseBrowserRedirectUrl(value)
  if (!parsed) {
    return value
  }
  const search = parsed.queryKeys.length > 0
    ? `?${parsed.queryKeys.map((key) => `${encodeURIComponent(key)}=[redacted]`).join("&")}`
    : ""
  return `${parsed.origin}${parsed.pathname}${search}${parsed.hash ? "#[redacted]" : ""}`
}

export function parseBrowserRedirectUrl(value: string): { origin: string; host: string; pathname: string; hash: string; queryKeys: string[]; redactedQueryKeys: string[] } | undefined {
  try {
    const url = new URL(value)
    const queryKeys = [...new Set([...url.searchParams.keys()])].sort()
    return {
      origin: url.origin,
      host: url.host,
      pathname: url.pathname || "/",
      hash: url.hash,
      queryKeys,
      redactedQueryKeys: queryKeys.filter(isSensitiveBrowserRedirectQueryKey),
    }
  } catch {
    return undefined
  }
}

export function isSensitiveBrowserRedirectQueryKey(key: string): boolean {
  const tokens = key.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  return tokens.some((token) => ["auth", "bearer", "code", "cookie", "credential", "key", "login", "nonce", "pass", "password", "secret", "session", "state", "token"].includes(token))
}

export function repeatedBrowserRedirectValues<Key extends "url" | "host" | "path">(values: string[], key: Key): Array<Record<Key, string> & { count: number }> {
  const counts = new Map<string, number>()
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .sort(([leftValue, leftCount], [rightValue, rightCount]) => rightCount - leftCount || leftValue.localeCompare(rightValue))
    .map(([value, count]) => ({ [key]: value, count }) as Record<Key, string> & { count: number })
}

export function extractBrowserNavigationUrl(message: string): string | undefined {
  return message.match(/\bat\s+(https?:\/\/\S+)/i)?.[1]?.replace(/[),.]+$/, "")
}

export function sanitizeBrowserRedirectMessage(message: string): string {
  return message.replace(/https?:\/\/[^\s"')]+/gi, (url) => browserRedirectSafeUrl(url.replace(/[),.]+$/, "")))
}

export interface BrowserWordPressDiagnosticRecord {
  schema: "wp-codebox/browser-wordpress-diagnostic-record/v1"
  classification: "php-fatal" | "http-5xx-status" | "http-response-code-5xx"
  severity: "error"
  errorType?: number
  message: string
  file?: string
  line?: number
  status?: number
  statusHeader?: string
  requestUri?: string
  backtrace?: Array<{ file?: string; line?: number; function?: string; class?: string; type?: string }>
  capturedAt: string
}

export interface BrowserWordPressDiagnosticsArtifact {
  schema: "wp-codebox/browser-wordpress-diagnostics/v1"
  version: 1
  capturedAt: string
  status: BrowserWordPressDiagnosticsSummary["status"]
  document5xxResponses: Array<{ url: string; status: number; statusText?: string; responseTextPreview?: string; responseTextSha256?: string; responseTextTruncated?: boolean }>
  diagnostics: BrowserWordPressDiagnosticRecord[]
  summary: BrowserWordPressDiagnosticsSummary
}

const BROWSER_WORDPRESS_DIAGNOSTICS_LOG = "/wordpress/wp-content/wp-codebox-browser-diagnostics.jsonl"
const BROWSER_WORDPRESS_DIAGNOSTICS_MU_PLUGIN = "/wordpress/wp-content/mu-plugins/000-wp-codebox-browser-diagnostics.php"
const BROWSER_WORDPRESS_DIAGNOSTICS_PLUGIN = phpBrowserWordPressDiagnosticsPlugin()

export async function installBrowserWordPressDiagnostics(
  runPlaygroundCommand: ((command: string, server: PlaygroundCliServer, options: { code: string } | { scriptPath: string }) => Promise<PlaygroundRunResponse>) | undefined,
  server: PlaygroundCliServer,
): Promise<boolean> {
  if (runPlaygroundCommand) {
    try {
      const response = await runPlaygroundCommand("wordpress.browser-diagnostics-setup", server, {
        code: `<?php
$directory = '/wordpress/wp-content/mu-plugins';
if (!is_dir($directory)) {
    mkdir($directory, 0777, true);
}
file_put_contents(${JSON.stringify(BROWSER_WORDPRESS_DIAGNOSTICS_MU_PLUGIN)}, base64_decode(${JSON.stringify(Buffer.from(BROWSER_WORDPRESS_DIAGNOSTICS_PLUGIN, "utf8").toString("base64"))}));
file_put_contents(${JSON.stringify(BROWSER_WORDPRESS_DIAGNOSTICS_LOG)}, '');
`,
      })
      assertPlaygroundResponseOk("wordpress.browser-diagnostics-setup", response)
      return true
    } catch {
      // Browser diagnostics are best-effort; preserve the browser command outcome.
    }
  }

  if (!server.playground.writeFile) {
    return false
  }

  try {
    await server.playground.writeFile(BROWSER_WORDPRESS_DIAGNOSTICS_MU_PLUGIN, BROWSER_WORDPRESS_DIAGNOSTICS_PLUGIN)
    await server.playground.writeFile(BROWSER_WORDPRESS_DIAGNOSTICS_LOG, "")
    return true
  } catch {
    return false
  }
}

export async function browserWordPressDiagnosticsArtifact({
  artifactPath,
  network,
  ready,
  server,
}: {
  artifactPath: string
  network: BrowserProbeNetworkRecord[]
  ready: boolean
  server: PlaygroundCliServer
}): Promise<BrowserWordPressDiagnosticsArtifact | undefined> {
  const document5xxResponses = network
    .filter((record) => record.type === "response" && record.resourceType === "document" && typeof record.status === "number" && record.status >= 500 && record.status < 600)
    .map((record) => ({
      url: browserRedirectSafeUrl(safeBrowserProbeUrl(record.url) ?? record.url),
      status: record.status as number,
      ...(record.statusText ? { statusText: record.statusText } : {}),
      ...(record.responseTextPreview ? { responseTextPreview: record.responseTextPreview } : {}),
      ...(record.responseTextSha256 ? { responseTextSha256: record.responseTextSha256 } : {}),
      ...(typeof record.responseTextTruncated === "boolean" ? { responseTextTruncated: record.responseTextTruncated } : {}),
    }))

  if (document5xxResponses.length === 0) {
    return undefined
  }

  const diagnostics = ready ? await readBrowserWordPressDiagnostics(server) : []
  const fatalErrors = diagnostics.filter((diagnostic) => diagnostic.classification === "php-fatal").length
  const classifications = [...new Set(diagnostics.map((diagnostic) => diagnostic.classification))].sort()
  const status: BrowserWordPressDiagnosticsSummary["status"] = !ready
    ? "unavailable"
    : diagnostics.length > 0 ? "captured" : "clean"
  const summary: BrowserWordPressDiagnosticsSummary = {
    status,
    artifact: artifactPath,
    document5xxResponses: document5xxResponses.length,
    diagnostics: diagnostics.length,
    fatalErrors,
    classifications,
  }

  return {
    schema: "wp-codebox/browser-wordpress-diagnostics/v1",
    version: 1,
    capturedAt: now(),
    status,
    document5xxResponses,
    diagnostics,
    summary,
  }
}

export async function readBrowserWordPressDiagnostics(server: PlaygroundCliServer): Promise<BrowserWordPressDiagnosticRecord[]> {
  if (!server.playground.readFileAsText) {
    return []
  }

  let contents = ""
  try {
    contents = await server.playground.readFileAsText(BROWSER_WORDPRESS_DIAGNOSTICS_LOG)
  } catch {
    return []
  }

  return contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseBrowserWordPressDiagnosticRecord)
    .filter((record): record is BrowserWordPressDiagnosticRecord => Boolean(record))
}

export function parseBrowserWordPressDiagnosticRecord(line: string): BrowserWordPressDiagnosticRecord | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined
  }

  const record = parsed as Record<string, unknown>
  if (record.schema !== "wp-codebox/browser-wordpress-diagnostic-record/v1" || !isBrowserWordPressDiagnosticClassification(record.classification)) {
    return undefined
  }

  const classification = record.classification

  return {
    schema: "wp-codebox/browser-wordpress-diagnostic-record/v1",
    classification,
    severity: "error",
    ...(typeof record.errorType === "number" && Number.isFinite(record.errorType) ? { errorType: record.errorType } : {}),
    message: sanitizeBrowserWordPressDiagnosticString(typeof record.message === "string" ? record.message : ""),
    ...(typeof record.file === "string" && record.file.length > 0 ? { file: sanitizeBrowserWordPressDiagnosticString(record.file) } : {}),
    ...(typeof record.line === "number" && Number.isFinite(record.line) ? { line: record.line } : {}),
    ...(typeof record.status === "number" && Number.isFinite(record.status) ? { status: record.status } : {}),
    ...(typeof record.statusHeader === "string" && record.statusHeader.length > 0 ? { statusHeader: sanitizeBrowserWordPressDiagnosticString(record.statusHeader) } : {}),
    ...(typeof record.requestUri === "string" && record.requestUri.length > 0 ? { requestUri: sanitizeBrowserWordPressDiagnosticRequestUri(record.requestUri) } : {}),
    ...(Array.isArray(record.backtrace) ? { backtrace: sanitizeBrowserWordPressDiagnosticBacktrace(record.backtrace) } : {}),
    capturedAt: typeof record.capturedAt === "string" ? record.capturedAt : now(),
  }
}

export function isBrowserWordPressDiagnosticClassification(value: unknown): value is BrowserWordPressDiagnosticRecord["classification"] {
  return value === "php-fatal" || value === "http-5xx-status" || value === "http-response-code-5xx"
}

export function sanitizeBrowserWordPressDiagnosticString(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => browserRedirectSafeUrl(url))
    .replace(/([?&][^=&#\s"'<>]+)=([^&#\s"'<>]+)/g, "$1=[redacted]")
    .replace(/((?:access[_-]?token|auth|bearer|code|cookie|credential|key|login|nonce|pass|password|secret|session|state|token)["'\s:=]+)[^\s"'<>]+/gi, "$1[redacted]")
}

export function sanitizeBrowserWordPressDiagnosticRequestUri(value: string): string {
  try {
    const parsed = new URL(value, "http://wp-codebox.local")
    const queryKeys = [...new Set([...parsed.searchParams.keys()])].sort()
    const query = queryKeys.length > 0 ? `?${queryKeys.map((key) => `${encodeURIComponent(key)}=[redacted]`).join("&")}` : ""
    return `${parsed.pathname || "/"}${query}${parsed.hash ? "#[redacted]" : ""}`
  } catch {
    return sanitizeBrowserWordPressDiagnosticString(value)
  }
}

export function sanitizeBrowserWordPressDiagnosticBacktrace(value: unknown[]): BrowserWordPressDiagnosticRecord["backtrace"] {
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return []
    }
    const frame = entry as Record<string, unknown>
    return [{
      ...(typeof frame.file === "string" && frame.file.length > 0 ? { file: sanitizeBrowserWordPressDiagnosticString(frame.file) } : {}),
      ...(typeof frame.line === "number" && Number.isFinite(frame.line) ? { line: frame.line } : {}),
      ...(typeof frame.function === "string" && frame.function.length > 0 ? { function: sanitizeBrowserWordPressDiagnosticString(frame.function) } : {}),
      ...(typeof frame.class === "string" && frame.class.length > 0 ? { class: sanitizeBrowserWordPressDiagnosticString(frame.class) } : {}),
      ...(typeof frame.type === "string" && frame.type.length > 0 ? { type: sanitizeBrowserWordPressDiagnosticString(frame.type) } : {}),
    }]
  }).slice(0, 12)
}

export async function installWordPressAdminAuthCookies({
  cookieUrls,
  command,
  page,
  runPlaygroundCommand,
  runtimeSpec,
  server,
  userId,
}: {
  cookieUrls?: string[]
  command: string
  page: import("playwright").Page
  runPlaygroundCommand?: (command: string, server: PlaygroundCliServer, options: { code: string } | { scriptPath: string }) => Promise<PlaygroundRunResponse>
  runtimeSpec?: RuntimeCreateSpec
  server: PlaygroundCliServer
  userId: number
}): Promise<BrowserProbeAuthSummary> {
  if (!runPlaygroundCommand) {
    throw new Error(`${command} auth=wordpress-admin requires Playground PHP command support`)
  }
  if (!runtimeSpec) {
    throw new Error(`${command} auth=wordpress-admin requires a runtime spec`)
  }

  const authCommand = `${command}.auth`
  const urls = uniqueBrowserAuthCookieUrls(cookieUrls ?? [server.serverUrl])
  const response = await runPlaygroundCommand(authCommand, server, { code: bootstrapPhpCode(runtimeSpec, wordpressAdminAuthCookiePhpCode(urls, userId), []) })
  assertPlaygroundResponseOk(authCommand, response)
  const cookies = JSON.parse(cleanWpCliOutput(response.text)) as Array<{ name?: string; value?: string; domain?: string; path?: string; expires?: number; httpOnly?: boolean; secure?: boolean; sameSite?: "Lax" }>
  await page.context().addCookies(cookies.map((cookie) => ({
    name: String(cookie.name ?? ""),
    value: String(cookie.value ?? ""),
    domain: String(cookie.domain ?? new URL(server.serverUrl).hostname),
    path: typeof cookie.path === "string" && cookie.path.length > 0 ? cookie.path : "/",
    expires: typeof cookie.expires === "number" ? cookie.expires : Math.floor(Date.now() / 1000) + 3600,
    httpOnly: cookie.httpOnly !== false,
    secure: cookie.secure === true,
    sameSite: cookie.sameSite ?? "Lax",
  })))

  return { mode: "wordpress-admin", userId, cookieCount: cookies.length, cookieHosts: browserAuthCookieHostSummary(cookies) }
}

export function wordpressAdminAuthCookiePhpCode(browserUrls: string[], userId: number): string {
  return `
$user_id = ${JSON.stringify(userId)};
$user = get_user_by( 'id', $user_id );
if ( ! $user ) {
    throw new RuntimeException( 'Browser auth requires the requested WordPress user to exist.' );
}
wp_set_current_user( $user_id );
$expiration = time() + HOUR_IN_SECONDS;
$token = '';
if ( class_exists( 'WP_Session_Tokens' ) ) {
    $token = WP_Session_Tokens::get_instance( $user_id )->create( $expiration );
}
$browser_urls = ${JSON.stringify(browserUrls)};
$cookies = array();
foreach ( $browser_urls as $browser_url ) {
    $browser_host = wp_parse_url( $browser_url, PHP_URL_HOST );
    if ( ! $browser_host ) {
        continue;
    }
    $secure = 'https' === wp_parse_url( $browser_url, PHP_URL_SCHEME );
    foreach ( array( array( AUTH_COOKIE, 'auth', false ), array( SECURE_AUTH_COOKIE, 'secure_auth', true ) ) as $admin_cookie ) {
        $cookies[] = array(
            'name'     => $admin_cookie[0],
            'value'    => wp_generate_auth_cookie( $user_id, $expiration, $admin_cookie[1], $token ),
            'domain'   => $browser_host,
            'path'     => defined( 'ADMIN_COOKIE_PATH' ) && ADMIN_COOKIE_PATH ? ADMIN_COOKIE_PATH : '/wp-admin',
            'expires'  => $expiration,
            'httpOnly' => true,
            'secure'   => $admin_cookie[2],
            'sameSite' => 'Lax',
        );
    }
    $logged_in_cookie = array(
        'name'     => LOGGED_IN_COOKIE,
        'value'    => wp_generate_auth_cookie( $user_id, $expiration, 'logged_in', $token ),
        'domain'   => $browser_host,
        'path'     => defined( 'COOKIEPATH' ) && COOKIEPATH ? COOKIEPATH : '/',
        'expires'  => $expiration,
        'httpOnly' => true,
        'secure'   => $secure,
        'sameSite' => 'Lax',
    );
    $cookies[] = $logged_in_cookie;
    if ( defined( 'SITECOOKIEPATH' ) && SITECOOKIEPATH && SITECOOKIEPATH !== COOKIEPATH ) {
        $logged_in_cookie['path'] = SITECOOKIEPATH;
        $cookies[] = $logged_in_cookie;
    }
}
echo wp_json_encode( $cookies );
`
}

export function browserActionTargetUrls(steps: BrowserInteractionStep[], effectiveOrigin: string, fallbackUrl: string): string[] {
  const urls = steps
    .filter((step) => step.kind === "navigate" && typeof step.url === "string" && step.url.trim().length > 0)
    .map((step) => resolveBrowserPreviewUrl(String(step.url), effectiveOrigin))
  return urls.length > 0 ? urls : [fallbackUrl]
}

export function uniqueBrowserAuthCookieUrls(urls: string[]): string[] {
  const unique = new Map<string, string>()
  for (const url of urls) {
    try {
      const parsed = new URL(url)
      unique.set(`${parsed.protocol}//${normalizeBrowserCookieHost(parsed.hostname)}`, `${parsed.protocol}//${parsed.hostname}/`)
    } catch {
      // Ignore invalid cookie URL inputs; callers still include the local server URL.
    }
  }
  return [...unique.values()]
}

export function normalizeBrowserCookieHost(host: string): string {
  return host.trim().toLowerCase().replace(/:\d+$/, "")
}

export function browserAuthCookieHostSummary(cookies: Array<{ domain?: string }>): Array<{ host: string; cookieCount: number }> {
  const counts = new Map<string, number>()
  for (const cookie of cookies) {
    const host = normalizeBrowserCookieHost(String(cookie.domain ?? ""))
    if (!host) continue
    counts.set(host, (counts.get(host) ?? 0) + 1)
  }
  return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([host, cookieCount]) => ({ host, cookieCount }))
}

export function browserAuthRequest(args: string[]): { userId: number } | undefined {
  const auth = argValue(args, "auth")?.trim()
  if (!auth) {
    return undefined
  }
  if (auth !== "wordpress-admin") {
    throw new Error(`Browser auth supports wordpress-admin: ${auth}`)
  }
  return { userId: positiveIntegerArg(args, "auth-user-id", 1) }
}

function positiveIntegerArg(args: string[], name: string, fallback: number): number {
  const raw = argValue(args, name)?.trim()
  if (!raw) {
    return fallback
  }
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer: ${raw}`)
  }
  return parsed
}

export async function browserStorageStateImportFromArgs(args: string[], command: string): Promise<BrowserStorageStateImport | undefined> {
  const raw = argValue(args, "storage-state")?.trim()
  if (!raw) {
    return undefined
  }

  const source = raw.startsWith("@") ? "file" : "inline"
  const text = source === "file" ? await readFile(resolveCommandPath(raw.slice(1)), "utf8") : raw
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch (error) {
    throw new BrowserStorageStateImportError(`${command} storage-state must be valid JSON`, {
      status: "error",
      source,
      cookieCount: 0,
      cookieHosts: [],
      originCount: 0,
      diagnostics: [{ code: "storage-state-json-invalid", severity: "error", message: error instanceof Error ? error.message : String(error) }],
    })
  }

  const normalized = normalizeBrowserStorageStatePayload(payload, source)
  if (normalized.summary.status !== "ready") {
    throw new BrowserStorageStateImportError(`${command} storage-state is unsupported`, normalized.summary)
  }
  return normalized
}

export function browserStorageStateAuthSummary(summary: BrowserStorageStateImportSummary): BrowserProbeAuthSummary {
  return {
    mode: "storage-state",
    storageState: summary,
    cookieCount: summary.cookieCount,
    cookieHosts: summary.cookieHosts,
  }
}

export class BrowserStorageStateImportError extends Error {
  constructor(message: string, readonly storageState: BrowserStorageStateImportSummary) {
    super(message)
    this.name = "BrowserStorageStateImportError"
  }

  toJSON(): { name: string; message: string; storageState: BrowserStorageStateImportSummary } {
    return { name: this.name, message: this.message, storageState: this.storageState }
  }
}

export function now(): string {
  return new Date().toISOString()
}

export async function fileSha256(path: string): Promise<string> {
  return sha256(await readFile(path))
}

export function sha256(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex")
}

export type BrowserProbeProgressSource = "navigation" | "network" | "console" | "pageerror" | "checkpoint" | "script" | "duration" | "probe-error"

export class BrowserProbeTerminalFailureError extends Error {
  readonly code = "browser-probe-terminal-failure"

  constructor(readonly failure: { message: string; reason?: string; details?: unknown; timestamp: string }) {
    super(`Browser probe reported a terminal failure: ${failure.message}`)
    this.name = "BrowserProbeTerminalFailureError"
  }
}

export class BrowserProbeStallError extends Error {
  readonly code = "browser-probe-stalled"

  constructor(readonly idleMs: number, readonly stallTimeoutMs: number, readonly lastProgressSource: BrowserProbeProgressSource, readonly lastCheckpoint?: BrowserProbeScriptCheckpoint) {
    super(`Browser probe stalled after ${idleMs}ms without progress; last progress source was ${lastProgressSource}${lastCheckpoint ? ` (${lastCheckpoint.name})` : ""}`)
    this.name = "BrowserProbeStallError"
  }
}

export function createBrowserProbeProgressTracker(startedAt: string, stallTimeoutMs: number): {
  mark(source: BrowserProbeProgressSource, timestamp?: string, checkpoint?: BrowserProbeScriptCheckpoint): void
  fail(source: BrowserProbeProgressSource, error: Error): void
  terminalFailure(failure: { message: string; reason?: string; details?: unknown; timestamp: string }): void
  lastProgressElapsedMs(): number
  summary(): {
    status: "active" | "failed" | "stalled"
    startedAt: string
    lastProgressAt: string
    lastProgressSource: BrowserProbeProgressSource
    idleMs: number
    stallTimeoutMs?: number
    lastCheckpoint?: BrowserProbeScriptCheckpoint
    terminalFailure?: { message: string; reason?: string; details?: unknown; timestamp: string }
  }
} {
  let status: "active" | "failed" | "stalled" = "active"
  let lastProgressAt = startedAt
  let lastProgressSource: BrowserProbeProgressSource = "navigation"
  let lastCheckpoint: BrowserProbeScriptCheckpoint | undefined
  let terminalFailure: { message: string; reason?: string; details?: unknown; timestamp: string } | undefined

  return {
    mark(source, timestamp = now(), checkpoint) {
      lastProgressAt = timestamp
      lastProgressSource = source
      if (checkpoint) {
        lastCheckpoint = checkpoint
      }
    },
    fail(source, error) {
      lastProgressAt = now()
      lastProgressSource = source
      status = error instanceof BrowserProbeStallError ? "stalled" : "failed"
      if (error instanceof BrowserProbeTerminalFailureError) {
        terminalFailure = error.failure
      }
    },
    terminalFailure(failure) {
      status = "failed"
      terminalFailure = failure
      lastProgressAt = failure.timestamp
      lastProgressSource = "probe-error"
    },
    lastProgressElapsedMs() {
      return Math.max(0, Date.now() - Date.parse(lastProgressAt))
    },
    summary() {
      return {
        status,
        startedAt,
        lastProgressAt,
        lastProgressSource,
        idleMs: this.lastProgressElapsedMs(),
        ...(stallTimeoutMs > 0 ? { stallTimeoutMs } : {}),
        ...(lastCheckpoint ? { lastCheckpoint } : {}),
        ...(terminalFailure ? { terminalFailure } : {}),
      }
    },
  }
}

export async function withBrowserProbeLiveness<T>(page: import("playwright").Page, progress: ReturnType<typeof createBrowserProbeProgressTracker>, failFast: boolean, operation: Promise<T>, policy: Required<BrowserCommandLivenessPolicy>, phase: string): Promise<T> {
  const result = await withBrowserCommandLiveness({
    command: "wordpress.browser-probe",
    phase,
    operation,
    policy,
    idle: () => {
      const summary = progress.summary()
      return { idleMs: summary.idleMs, lastProgressSource: summary.lastProgressSource }
    },
    poll: async () => {
      try {
        const state = await page.evaluate(() => {
          const probe = (globalThis as typeof globalThis & {
            __wpCodeboxBrowserProbe?: {
              checkpoints?: Array<{ name?: unknown; metadata?: unknown; timestamp?: unknown }>
              terminalFailure?: { message?: unknown; reason?: unknown; details?: unknown; timestamp?: unknown }
            }
          }).__wpCodeboxBrowserProbe
          const checkpoints = Array.isArray(probe?.checkpoints) ? probe.checkpoints : []
          const latestCheckpoint = [...checkpoints].reverse().find((checkpoint) => typeof checkpoint.timestamp === "string")
          const latestCheckpointTimestamp = typeof latestCheckpoint?.timestamp === "string" ? latestCheckpoint.timestamp : undefined
          const checkpoint = latestCheckpoint && latestCheckpointTimestamp ? {
            name: typeof latestCheckpoint.name === "string" ? latestCheckpoint.name : "checkpoint",
            metadata: latestCheckpoint.metadata,
            timestamp: latestCheckpointTimestamp,
          } : undefined
          const failure = probe?.terminalFailure
          return {
            checkpoint,
            terminalFailure: failure && typeof failure.message === "string" ? {
              message: failure.message,
              reason: typeof failure.reason === "string" ? failure.reason : undefined,
              details: failure.details,
              timestamp: typeof failure.timestamp === "string" ? failure.timestamp : new Date().toISOString(),
            } : undefined,
          }
        })
        if (state.checkpoint) {
          progress.mark("checkpoint", state.checkpoint.timestamp, state.checkpoint)
        }
        if (state.terminalFailure) {
          progress.terminalFailure(state.terminalFailure)
          throw new BrowserProbeTerminalFailureError(state.terminalFailure)
        }
      } catch (error) {
        if (error instanceof BrowserProbeTerminalFailureError) {
          throw error
        }
        // The page may be navigating or already closed; the outer operation remains authoritative.
      }
    },
    onTimeout: async () => {
      await page.close().catch(() => undefined)
    },
  }).catch((error) => {
    if (isBrowserCommandLivenessError(error) && error.code === "browser-command-idle-timeout") {
      const summary = progress.summary()
      throw new BrowserProbeStallError(summary.idleMs, policy.idleTimeoutMs, summary.lastProgressSource, summary.lastCheckpoint)
    }
    throw error
  })
  const terminalFailure = failFast ? await browserProbeTerminalFailure(page) : undefined
  if (terminalFailure) {
    progress.terminalFailure(terminalFailure)
    throw new BrowserProbeTerminalFailureError(terminalFailure)
  }
  return result
}

export function livenessRemainingWallTimeMs(startedAtMs: number, totalTimeoutMs: number): number {
  if (totalTimeoutMs <= 0) {
    return browserCommandLivenessPolicy().wallTimeoutMs
  }
  return Math.max(1, totalTimeoutMs - (Date.now() - startedAtMs))
}

export function normalizeBrowserProbeScriptCheckpoint(checkpoint: unknown): BrowserProbeScriptCheckpoint | undefined {
  if (!checkpoint || typeof checkpoint !== "object") {
    return undefined
  }
  const record = checkpoint as { name?: unknown; metadata?: unknown; timestamp?: unknown }
  return {
    name: typeof record.name === "string" && record.name.length > 0 ? record.name : "checkpoint",
    ...(typeof record.metadata !== "undefined" ? { metadata: record.metadata } : {}),
    timestamp: typeof record.timestamp === "string" ? record.timestamp : now(),
  }
}

export async function browserProbeTerminalFailure(page: import("playwright").Page): Promise<{ message: string; reason?: string; details?: unknown; timestamp: string } | undefined> {
  return page.evaluate(() => {
    const failure = (globalThis as typeof globalThis & {
      __wpCodeboxBrowserProbe?: {
        terminalFailure?: { message?: unknown; reason?: unknown; details?: unknown; timestamp?: unknown }
      }
    }).__wpCodeboxBrowserProbe?.terminalFailure
    if (!failure || typeof failure.message !== "string") {
      return undefined
    }
    return {
      message: failure.message,
      reason: typeof failure.reason === "string" ? failure.reason : undefined,
      details: failure.details,
      timestamp: typeof failure.timestamp === "string" ? failure.timestamp : new Date().toISOString(),
    }
  }).catch(() => undefined)
}
