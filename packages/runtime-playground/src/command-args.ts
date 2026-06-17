import { parseCommandJsonArray, parseCommandJsonObject, parseCommandStringList } from "@automattic/wp-codebox-core"

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

export function strictBooleanArg(args: string[], name: string, fallback: boolean): boolean {
  const raw = argValue(args, name)?.trim().toLowerCase()
  if (!raw) {
    return fallback
  }
  if (["1", "true", "yes", "on"].includes(raw)) {
    return true
  }
  if (["0", "false", "no", "off"].includes(raw)) {
    return false
  }
  throw new Error(`${name} must be true or false`)
}

export function durationArg(args: string[], name: string, fallbackMs: number): number {
  const raw = argValue(args, name)?.trim()
  if (!raw) {
    return fallbackMs
  }

  const match = raw.match(/^(\d+(?:\.\d+)?)(ms|s)$/)
  if (!match) {
    throw new Error(`${name} must be a duration like 500ms or 2s`)
  }

  const value = Number.parseFloat(match[1])
  return Math.max(0, Math.round(match[2] === "ms" ? value : value * 1000))
}

export function viewportArg(args: string[], name: string): { width: number; height: number } | undefined {
  const raw = argValue(args, name)?.trim()
  if (!raw) {
    return undefined
  }

  const match = raw.match(/^(\d+)x(\d+)$/i)
  if (!match) {
    throw new Error(`${name} must use <width>x<height>, for example 390x844: ${raw}`)
  }

  const width = Number.parseInt(match[1] ?? "", 10)
  const height = Number.parseInt(match[2] ?? "", 10)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`${name} width and height must be positive integers: ${raw}`)
  }

  return { width, height }
}

export function commaListArg(args: string[], name: string): string[] {
  return parseCommandStringList(argValue(args, name))
}

export function jsonObjectArg(args: string[], name: string): Record<string, unknown> {
  return parseCommandJsonObject(argValue(args, name), name)
}

export function jsonArrayArg(args: string[], name: string): unknown[] {
  return parseCommandJsonArray(argValue(args, name), name)
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
