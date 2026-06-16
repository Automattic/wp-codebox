import { createHash } from "node:crypto"

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function stableJson(value: unknown): string {
  return stableJsonValue(value, new WeakSet(), 0)
}

function stableJsonValue(value: unknown, seen: WeakSet<object>, depth: number): string {
  if (depth > 30) {
    return JSON.stringify("[max-depth]")
  }
  if (value instanceof Error) {
    return stableJsonValue(errorJsonRecord(value), seen, depth + 1)
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value)
  }
  if (seen.has(value)) {
    return JSON.stringify("[circular]")
  }
  seen.add(value)

  if (Array.isArray(value)) {
    const json = `[${value.slice(0, 2000).map((item) => stableJsonValue(item, seen, depth + 1)).join(",")}]`
    seen.delete(value)
    return json
  }

  const json = `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .slice(0, 300)
    .map((key) => {
      const item = (value as Record<string, unknown>)[key]
      return typeof item === "function" || typeof item === "symbol" ? undefined : `${JSON.stringify(key)}:${stableJsonValue(item, seen, depth + 1)}`
    })
    .filter((item): item is string => Boolean(item))
    .join(",")}}`
  seen.delete(value)
  return json
}

export function normalizeJsonValue(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (depth > 30) {
    return "[max-depth]"
  }
  if (value instanceof Error) {
    return normalizeJsonValue(errorJsonRecord(value), seen, depth + 1)
  }
  if (!value || typeof value !== "object") {
    return value
  }
  if (seen.has(value)) {
    return "[circular]"
  }
  seen.add(value)

  if (Array.isArray(value)) {
    const normalized = value.slice(0, 2000).map((item) => normalizeJsonValue(item, seen, depth + 1))
    seen.delete(value)
    return normalized
  }

  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).slice(0, 300)) {
    if (typeof item !== "function" && typeof item !== "symbol") {
      output[key] = normalizeJsonValue(item, seen, depth + 1)
    }
  }
  seen.delete(value)
  return output
}

function errorJsonRecord(error: Error): Record<string, unknown> {
  const record = error as Error & Record<string, unknown>
  const output: Record<string, unknown> = {
    name: error.name,
    message: error.message,
  }

  for (const [key, item] of Object.entries(record)) {
    if (key !== "name" && key !== "message" && key !== "stack" && typeof item !== "function" && typeof item !== "symbol") {
      output[key] = item
    }
  }
  if (record.cause && !("cause" in output)) {
    output.cause = record.cause
  }

  return output
}

export function sha256StableJson(value: unknown, trailingNewline = false): string {
  return createHash("sha256").update(`${stableJson(value)}${trailingNewline ? "\n" : ""}`).digest("hex")
}

export function stripUndefined<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T
}

export function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []

  const items: string[] = []
  for (const item of value) {
    const normalized = String(item).trim()
    if (normalized !== "" && !items.includes(normalized)) items.push(normalized)
  }

  return items
}
