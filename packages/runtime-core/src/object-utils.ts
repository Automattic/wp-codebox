import { createHash } from "node:crypto"

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value)
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`
  }

  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
    .join(",")}}`
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
