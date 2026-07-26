import { redactString } from "@automattic/wp-codebox-core"
import type { BrowserArtifact } from "./browser-artifacts.js"

const URL_KEY_PATTERN = /(?:url|uri|href|origin|location|filename|src|action)$/i
const DIAGNOSTIC_KEY_PATTERN = /(?:error|message|stack|reason)$/i
const URL_VALUE_PATTERN = /^(?:data|https?|wss?):/i

export function sanitizeBrowserResultValue<T>(value: T, key = ""): T {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeBrowserResultValue(entry)) as T
  }
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      return value
    }
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, sanitizeBrowserResultValue(entryValue, entryKey)])) as T
  }
  if (typeof value !== "string") {
    return value
  }
  if (URL_KEY_PATTERN.test(key) || URL_VALUE_PATTERN.test(value)) {
    return sanitizeBrowserResultUrl(value) as T
  }
  if (DIAGNOSTIC_KEY_PATTERN.test(key)) {
    return redactString(value, { redactAllUrlQueryValues: true, redactUrlHash: true, redactQueryAssignments: true }) as T
  }
  return value
}

export function sanitizeBrowserArtifact(artifact: BrowserArtifact): BrowserArtifact {
  return sanitizeBrowserResultValue(artifact)
}

export function browserCommandResult(artifact: BrowserArtifact, output: unknown): { artifact: BrowserArtifact; output: string } {
  return {
    artifact: sanitizeBrowserArtifact(artifact),
    output: `${JSON.stringify(sanitizeBrowserResultValue(output), null, 2)}\n`,
  }
}

function sanitizeBrowserResultUrl(value: string): string {
  if (/^data:/i.test(value)) {
    return "data:[redacted]"
  }
  return redactString(value, { redactAllUrlQueryValues: true, redactUrlHash: true, redactQueryAssignments: true })
}
