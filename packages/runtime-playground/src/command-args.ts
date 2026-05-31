export function argValue(args: string[], name: string): string | undefined {
  const prefix = `${name}=`
  const match = args.find((arg) => arg.startsWith(prefix))
  return match?.slice(prefix.length)
}

export function positiveIntegerArg(args: string[], name: string, fallback: number): number {
  const raw = argValue(args, name)
  if (!raw) {
    return fallback
  }

  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function nonNegativeIntegerArg(args: string[], name: string, fallback: number): number {
  const raw = argValue(args, name)
  if (!raw) {
    return fallback
  }

  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

export function booleanArg(args: string[], name: string, fallback = false): boolean {
  const raw = argValue(args, name)
  if (!raw) {
    return fallback
  }

  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase())
}

export function commaListArg(args: string[], name: string): string[] {
  return (argValue(args, name) ?? "").split(",").map((item) => item.trim()).filter(Boolean)
}

export function jsonObjectArg(args: string[], name: string): Record<string, unknown> {
  const raw = argValue(args, name)
  if (!raw) {
    return {}
  }

  const parsed = JSON.parse(raw)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object`)
  }

  return parsed as Record<string, unknown>
}

export function jsonArrayArg(args: string[], name: string): unknown[] {
  const raw = argValue(args, name)
  if (!raw) {
    return []
  }

  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON array`)
  }

  return parsed
}

export function isSafeEnvName(name: string): boolean {
  return /^[A-Z_][A-Z0-9_]*$/.test(name)
}

export function normalizePhpCode(code: string): string {
  return code.trimStart().startsWith("<?php") ? code : `<?php\n${code}`
}

export function phpBody(code: string): string {
  return code.trimStart().replace(/^<\?php\s*/, "")
}
