export type CommandJsonObject = Record<string, unknown>

export interface CommandOptionParseResult {
  options: Map<string, string | true>
  positionals: string[]
}

export function commandArg(name: string, value: string | number | boolean): string {
  return `${name}=${String(value)}`
}

export function commandJsonArg(name: string, value: unknown): string {
  return commandArg(name, encodeCommandJson(value))
}

export function commandStringListArg(name: string, values: readonly string[]): string {
  return commandArg(name, encodeCommandStringList(values))
}

export function encodeCommandJson(value: unknown): string {
  return JSON.stringify(value)
}

export function encodeCommandJsonObject(value: CommandJsonObject): string {
  return encodeCommandJson(value)
}

export function parseCommandJson(raw: string, label = "JSON argument"): unknown {
  try {
    return JSON.parse(raw)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${label} must be valid JSON: ${message}`)
  }
}

export function parseCommandJsonObject(raw: string | undefined, label = "JSON argument", fallback: CommandJsonObject = {}): CommandJsonObject {
  if (!raw) {
    return fallback
  }

  const parsed = parseCommandJson(raw, label)
  if (!isCommandJsonObject(parsed)) {
    throw new Error(`${label} must be a JSON object`)
  }

  return parsed
}

export function parseCommandJsonArray(raw: string | undefined, label = "JSON argument", fallback: unknown[] = []): unknown[] {
  if (!raw) {
    return fallback
  }

  const parsed = parseCommandJson(raw, label)
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON array`)
  }

  return parsed
}

export function encodeCommandStringList(values: readonly string[]): string {
  return values.map((value) => value.trim()).filter(Boolean).join(",")
}

export function parseCommandStringList(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map((item) => item.trim()).filter(Boolean)
}

export function parseCommandOptions(args: readonly string[], flags: ReadonlySet<string> = new Set()): CommandOptionParseResult {
  const options = new Map<string, string | true>()
  const positionals: string[] = []

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg.startsWith("--")) {
      positionals.push(arg)
      continue
    }

    const equals = arg.indexOf("=")
    const name = equals === -1 ? arg : arg.slice(0, equals)
    if (flags.has(name)) {
      if (equals !== -1) {
        throw new Error(`${name} does not accept a value`)
      }
      options.set(name, true)
      continue
    }

    const value = equals === -1 ? args[index + 1] : arg.slice(equals + 1)
    if (value === undefined) {
      throw new Error(`Missing value for option: ${name}`)
    }
    options.set(name, value)
    if (equals === -1) {
      index += 1
    }
  }

  return { options, positionals }
}

function isCommandJsonObject(value: unknown): value is CommandJsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}
