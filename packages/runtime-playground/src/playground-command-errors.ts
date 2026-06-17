import { isSensitiveKey } from "@automattic/wp-codebox-core"

export interface PlaygroundRunResponse {
  bytes?: unknown
  cause?: unknown
  exitCode?: number
  errors?: string
  httpStatusCode?: number
  originalErrorClassName?: string
  text: string
}

export interface PlaygroundCliBufferedOutput {
  stdout?: string
  stderr?: string
  truncated?: boolean
}

export class PlaygroundCommandError extends Error {
  readonly code = "wp-codebox-playground-command-failed"

  constructor(readonly command: string, readonly response: PlaygroundRunResponse) {
    super(playgroundFailureMessage(command, response))
    this.name = "PlaygroundCommandError"
  }
}

export class PlaygroundCommandCrashError extends Error {
  readonly code = "wp-codebox-playground-command-crashed"

  constructor(readonly command: string, readonly cause: unknown) {
    super(playgroundCrashMessage(command, cause))
    this.name = "PlaygroundCommandCrashError"
  }
}

export class PlaygroundCliExitError extends Error {
  readonly code = "wp-codebox-playground-cli-exited"

  constructor(readonly exitCode: number, readonly output?: PlaygroundCliBufferedOutput) {
    super(playgroundCliExitMessage(exitCode, output))
    this.name = "PlaygroundCliExitError"
  }
}

export function assertPlaygroundResponseOk(command: string, response: PlaygroundRunResponse): void {
  if (typeof response.exitCode === "number" && response.exitCode !== 0) {
    throw new PlaygroundCommandError(command, response)
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Extract a human-readable failure message from the structured PHPUnit
 * diagnostics log (.pg-test-result.txt). The PHP runner emits STAGE_FAIL / STAGE_DIE /
 * STAGE_FATAL markers; when a bootstrap/install script die()s mid-require, the shutdown
 * handler records STAGE_DIE with whatever the script printed.
 * Returns undefined when the log contains no recognizable failure marker (#314).
 */
export function extractPhpunitFailureMessage(log: string): string | undefined {
  if (!log.trim()) {
    return undefined
  }

  const lines = log.split("\n")
  const stageFail = lines.find((line) => line.startsWith("STAGE_FAIL:"))
  const stageDie = lines.find((line) => line.startsWith("STAGE_DIE:"))
  const stageFatal = lines.find((line) => line.startsWith("STAGE_FATAL:"))

  const detail = (marker: string | undefined): string | undefined => {
    if (!marker) {
      return undefined
    }
    // Format is MARKER:<stage>:<message...>; drop the marker and stage prefix.
    const withoutMarker = marker.slice(marker.indexOf(":") + 1)
    const withoutStage = withoutMarker.slice(withoutMarker.indexOf(":") + 1)
    return withoutStage.trim() || withoutMarker.trim()
  }

  const messages = [detail(stageFail), detail(stageDie), detail(stageFatal)].filter(
    (value): value is string => Boolean(value),
  )

  if (messages.length === 0) {
    return undefined
  }

  return messages.join(" | ")
}

function playgroundFailureMessage(command: string, response: PlaygroundRunResponse): string {
  const lines = [`${command} failed with exit code ${response.exitCode ?? "unknown"}`]
  const diagnostics = playgroundResponseDiagnostics(response)

  if (diagnostics.length > 0) {
    lines.push("", "--- Playground response diagnostics ---", ...diagnostics)
  }

  return lines.join("\n")
}

function playgroundResponseDiagnostics(response: PlaygroundRunResponse): string[] {
  const metadata: string[] = []
  const sections: string[] = []
  let capturedOutput = false

  for (const [value, label] of [
    [response.originalErrorClassName, "originalErrorClassName"],
    [response.httpStatusCode, "httpStatusCode"],
    [response.exitCode, "exitCode"],
    [diagnosticCauseMessage(response.cause), "cause"],
  ] as const) {
    if ((typeof value === "number" || typeof value === "string") && value !== "") {
      metadata.push(`${label}=${value}`)
    }
  }

  for (const [value, label] of [
    [response.errors, "Playground errors"],
    [response.text, "Playground output"],
    [response.bytes, "Playground response bytes"],
  ] as const) {
    const text = label === "Playground response bytes" ? diagnosticBytesText(value) : diagnosticText(value)
    if (text) {
      capturedOutput = true
      sections.push(`--- ${label} ---`, text)
    }
  }

  if (!capturedOutput && (metadata.length > 0 || hasEmptyByteMap(response.bytes) || response.errors === "" || response.text === "")) {
    sections.push("No Playground response bytes, errors, or text were captured. The PHP fatal payload was absent from the wordpress.run-php response; inspect runtime command artifacts and Playground server diagnostics for the failing PHP process.")
  }

  return [...metadata, ...sections]
}

function playgroundCrashMessage(command: string, cause: unknown): string {
  const lines = [`${command} crashed before producing a structured response`, "", errorMessage(cause)]
  const diagnostics = playgroundCrashDiagnostics(cause)

  if (diagnostics.length > 0) {
    lines.push("", "--- Playground crash diagnostics ---", ...diagnostics)
  }

  return lines.join("\n")
}

function playgroundCrashDiagnostics(cause: unknown): string[] {
  const records = diagnosticRecords(cause)
  const metadata: string[] = []
  const sections: string[] = []
  const seenSections = new Set<string>()
  let capturedOutput = false

  for (const record of records) {
    for (const [key, label] of [
      ["httpStatusCode", "httpStatusCode"],
      ["statusCode", "statusCode"],
      ["status", "status"],
      ["exitCode", "exitCode"],
    ] as const) {
      const value = record[key]
      if ((typeof value === "number" || typeof value === "string") && !metadata.includes(`${label}=${value}`)) {
        metadata.push(`${label}=${value}`)
      }
    }

    for (const [key, label] of [
      ["stderr", "Playground stderr"],
      ["stdout", "Playground stdout"],
      ["errors", "Playground errors"],
      ["body", "Playground response body"],
      ["text", "Playground response text"],
      ["output", "Playground output"],
    ] as const) {
      const value = diagnosticText(record[key])
      const sectionKey = `${label}\n${value}`
      if (value && !seenSections.has(sectionKey)) {
        capturedOutput = true
        sections.push(`--- ${label} ---`, value)
        seenSections.add(sectionKey)
      }
    }

    const headers = diagnosticHeaders(record.headers)
    if (headers) {
      const sectionKey = `Playground response headers\n${headers}`
      if (!seenSections.has(sectionKey)) {
        sections.push("--- Playground response headers ---", headers)
        seenSections.add(sectionKey)
      }
    }
  }

  if (!capturedOutput && metadata.length > 0) {
    sections.push("No Playground stdout, stderr, or response body was captured.")
  }

  return [...metadata, ...sections]
}

function diagnosticRecords(value: unknown, seen = new Set<unknown>()): Record<string, unknown>[] {
  if (!value || typeof value !== "object" || seen.has(value)) {
    return []
  }
  seen.add(value)

  const record = diagnosticRecord(value)
  return [
    record,
    ...["cause", "response", "result", "data", "output"].flatMap((key) => diagnosticRecords(record[key], seen)),
  ]
}

function diagnosticRecord(value: object): Record<string, unknown> {
  const record: Record<string, unknown> = {}
  for (const key of diagnosticPropertyNames(value)) {
    const descriptor = getPropertyDescriptor(value, key)
    if (!descriptor || !("value" in descriptor || descriptor.get)) {
      continue
    }

    try {
      record[key] = "value" in descriptor ? descriptor.value : descriptor.get?.call(value)
    } catch {
      // Ignore throwing diagnostic accessors; they are not useful crash context.
    }
  }

  return record
}

function diagnosticPropertyNames(value: object): string[] {
  const names = new Set<string>()
  let current: object | null = value
  while (current && current !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(current)) {
      names.add(name)
    }
    current = Object.getPrototypeOf(current) as object | null
  }
  return [...names]
}

function getPropertyDescriptor(value: object, key: string): PropertyDescriptor | undefined {
  let current: object | null = value
  while (current && current !== Object.prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key)
    if (descriptor) {
      return descriptor
    }
    current = Object.getPrototypeOf(current) as object | null
  }
  return undefined
}

function diagnosticText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return playgroundOutputDiagnostic(value.trim())
  }
  if (value instanceof ArrayBuffer) {
    return playgroundOutputDiagnostic(new TextDecoder().decode(value).trim())
  }
  if (value instanceof Uint8Array) {
    return playgroundOutputDiagnostic(new TextDecoder().decode(value).trim())
  }
  if (ArrayBuffer.isView(value)) {
    return playgroundOutputDiagnostic(new TextDecoder().decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)).trim())
  }
  if (!value || typeof value !== "object" || typeof value === "function") {
    return undefined
  }

  try {
    return playgroundOutputDiagnostic(JSON.stringify(value, null, 2))
  } catch {
    return undefined
  }
}

function diagnosticBytesText(value: unknown): string | undefined {
  const bytes = byteMapFromUnknown(value)
  if (!bytes || bytes.length === 0) {
    return undefined
  }

  return playgroundOutputDiagnostic(new TextDecoder().decode(Uint8Array.from(bytes)).trim())
}

function diagnosticCauseMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined
  }

  const message = (value as { message?: unknown }).message
  return typeof message === "string" && message.trim() ? message.trim() : undefined
}

function diagnosticHeaders(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }

  const lines: string[] = []
  for (const [rawName, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const name = rawName.toLowerCase()
    if (isSensitiveKey(name, { extraPattern: /\bkey\b/i })) {
      continue
    }
    if (!["content-type", "server", "x-powered-by"].includes(name) && !name.startsWith("x-wp-") && !name.startsWith("x-playground-")) {
      continue
    }
    const valueText = headerValueText(rawValue)
    if (valueText) {
      lines.push(`${rawName}: ${valueText}`)
    }
  }

  return lines.length > 0 ? truncateDiagnostic(lines.join("\n")) : undefined
}

function headerValueText(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number") {
    return String(value).slice(0, 500)
  }
  if (Array.isArray(value)) {
    const values = value.filter((item): item is string | number => typeof item === "string" || typeof item === "number")
    return values.length > 0 ? values.map(String).join(", ").slice(0, 500) : undefined
  }
  return undefined
}

function playgroundOutputDiagnostic(raw: string): string {
  const text = raw.trim()
  const decoded = decodeByteMapText(text)
  const fatal = phpFatalSummary(decoded ?? text)

  if (fatal) {
    const rawBytes = Buffer.byteLength(text, "utf8")
    const decodedSuffix = decoded ? ` Decoded from serialized response bytes (${rawBytes} bytes).` : ""
    return `${fatal}\n[Raw Playground output omitted from normal error output.${decodedSuffix} Inspect the thrown PlaygroundCommandError response for full diagnostics.]`
  }

  if (decoded) {
    return `${truncateDiagnostic(decoded) ?? ""}\n[Raw serialized response bytes omitted from normal error output. Inspect the thrown PlaygroundCommandError response for full diagnostics.]`
  }

  return truncateDiagnostic(text) ?? ""
}

function phpFatalSummary(text: string): string | undefined {
  const normalized = stripHtml(text).replace(/\s+/g, " ").trim()
  const diagnostic = wpCodeboxPhpFatalSummary(normalized)
  if (diagnostic) {
    return diagnostic
  }

  const fatal = normalized.match(/(?:PHP )?Fatal error:\s+(.+?)(?=(?: Stack trace:| thrown in |$))/)
  if (!fatal) {
    return undefined
  }

  const thrown = normalized.match(/thrown in ([^\s]+) on line (\d+)/)
  const location = thrown ? `\nLocation: ${thrown[1]}:${thrown[2]}` : ""
  return `PHP fatal: ${fatal[1].trim()}${location}`
}

function wpCodeboxPhpFatalSummary(text: string): string | undefined {
  const marker = text.match(/WP_CODEBOX_PHP_FATAL_DIAGNOSTIC:({.+?})(?:\s|$)/)
  if (!marker) {
    return undefined
  }

  const diagnostic = parseJsonObject(marker[1]) as { message?: unknown; file?: unknown; line?: unknown } | undefined
  if (!diagnostic || typeof diagnostic.message !== "string" || !diagnostic.message.trim()) {
    return undefined
  }

  const file = typeof diagnostic.file === "string" ? diagnostic.file : ""
  const line = typeof diagnostic.line === "number" ? diagnostic.line : 0
  const location = file && line > 0 ? `\nLocation: ${file}:${line}` : ""
  return `PHP fatal: ${diagnostic.message.trim()}${location}`
}

function stripHtml(text: string): string {
  return text
    .replace(/<br\s*\/?>(\s*)/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
}

function decodeByteMapText(text: string): string | undefined {
  const parsed = parseJsonObject(text)
  if (!parsed) {
    return undefined
  }

  const bytes = findByteMap(parsed)
  if (!bytes) {
    return undefined
  }

  return new TextDecoder().decode(Uint8Array.from(bytes)).trim()
}

function parseJsonObject(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function findByteMap(value: unknown, seen = new Set<unknown>()): number[] | undefined {
  if (!value || typeof value !== "object" || seen.has(value)) {
    return undefined
  }
  seen.add(value)

  const record = value as Record<string, unknown>
  const bytes = byteMapValues(record)
  if (bytes) {
    return bytes
  }

  for (const item of Object.values(record)) {
    const nested = findByteMap(item, seen)
    if (nested) {
      return nested
    }
  }

  return undefined
}

function byteMapFromUnknown(value: unknown): number[] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }

  return byteMapValues(value as Record<string, unknown>)
}

function hasEmptyByteMap(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value as Record<string, unknown>).length === 0)
}

function byteMapValues(record: Record<string, unknown>): number[] | undefined {
  const keys = Object.keys(record)
  if (keys.length === 0 || keys.some((key) => !/^\d+$/.test(key))) {
    return undefined
  }

  const bytes = keys
    .map((key) => Number(key))
    .sort((left, right) => left - right)
    .map((key) => record[String(key)])

  if (bytes.some((value) => typeof value !== "number" || value < 0 || value > 255 || !Number.isInteger(value))) {
    return undefined
  }

  return bytes as number[]
}

function truncateDiagnostic(value: string): string | undefined {
  if (!value) {
    return undefined
  }
  const maxLength = 20_000
  return value.length > maxLength ? `${value.slice(0, maxLength)}\n[diagnostic truncated]` : value
}

function playgroundCliExitMessage(exitCode: number, output: PlaygroundCliBufferedOutput | undefined): string {
  const lines = [`WordPress Playground CLI exited while booting the runtime with exit code ${exitCode}.`]
  const stderr = output?.stderr?.trim()
  const stdout = output?.stdout?.trim()

  if (stderr) {
    lines.push("", "--- Playground CLI stderr ---", stderr)
  }

  if (stdout) {
    lines.push("", "--- Playground CLI stdout ---", stdout)
  }

  if (output?.truncated) {
    lines.push("", "[Playground CLI output was truncated]")
  }

  return lines.join("\n")
}
