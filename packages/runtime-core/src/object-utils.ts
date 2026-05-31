export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
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
