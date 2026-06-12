export interface PlaygroundRunResponse {
  exitCode?: number
  errors?: string
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
  const errors = response.errors?.trim()
  const text = response.text?.trim()

  if (errors) {
    lines.push("", "--- Playground errors ---", errors)
  }

  if (text) {
    lines.push("", "--- Playground output ---", text)
  }

  return lines.join("\n")
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
        sections.push(`--- ${label} ---`, value)
        seenSections.add(sectionKey)
      }
    }
  }

  return [...metadata, ...sections]
}

function diagnosticRecords(value: unknown, seen = new Set<unknown>()): Record<string, unknown>[] {
  if (!value || typeof value !== "object" || seen.has(value)) {
    return []
  }
  seen.add(value)

  const record = value as Record<string, unknown>
  return [
    record,
    ...["cause", "response", "result", "data", "output"].flatMap((key) => diagnosticRecords(record[key], seen)),
  ]
}

function diagnosticText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return truncateDiagnostic(value.trim())
  }
  if (value instanceof Uint8Array) {
    return truncateDiagnostic(new TextDecoder().decode(value).trim())
  }
  if (!value || typeof value !== "object" || typeof value === "function") {
    return undefined
  }

  try {
    return truncateDiagnostic(JSON.stringify(value, null, 2))
  } catch {
    return undefined
  }
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
