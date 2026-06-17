export const REDACTED_VALUE = "[redacted]"

export interface SensitiveKeyOptions {
  pattern?: RegExp
  extraPattern?: RegExp
}

export interface RedactJsonOptions extends SensitiveKeyOptions {
  redactStrings?: boolean
}

export interface RedactStringOptions extends SensitiveKeyOptions {
  redactAllUrlQueryValues?: boolean
  redactUrlHash?: boolean
  redactQueryAssignments?: boolean
}

const SENSITIVE_KEY_PATTERN = /(?:secret|token|credential|password|pass|api[_-]?key|private[_-]?key|authorization|auth|cookie|bearer|nonce|session|state|code|login)/i
const SECRET_LIKE_VALUE_PATTERN = /\b(?:sk-[A-Za-z0-9_-]{20,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16})\b/
const SECRET_LIKE_VALUE_GLOBAL_PATTERN = /\b(?:sk-[A-Za-z0-9_-]{20,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16})\b/g

export function isSensitiveKey(key: string, options: SensitiveKeyOptions = {}): boolean {
  return (options.pattern ?? SENSITIVE_KEY_PATTERN).test(key) || Boolean(options.extraPattern?.test(key))
}

export function isRedactedValue(value: string): boolean {
  return /^\[?redacted\]?$/i.test(value) || value === "" || value === "***"
}

export function containsSecretLikeValue(value: string): boolean {
  return !isRedactedValue(value) && SECRET_LIKE_VALUE_PATTERN.test(value)
}

export function redactJsonValue(value: unknown, options: RedactJsonOptions = {}, key = ""): unknown {
  if (isSensitiveKey(key, options)) {
    return REDACTED_VALUE
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactJsonValue(entry, options))
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redactJsonValue(entryValue, options, entryKey)]))
  }
  if (typeof value === "string" && options.redactStrings !== false) {
    return redactString(value, options)
  }
  return value
}

export function redactString(value: string, options: RedactStringOptions = {}): string {
  return value
    .replace(/https?:\/\/[^\s"'<>]+/gi, (match) => redactUrl(match, options))
    .replace(SECRET_LIKE_VALUE_GLOBAL_PATTERN, REDACTED_VALUE)
    .replace(/([?&][^=&#\s"'<>]+)=([^&#\s"'<>]+)/g, options.redactQueryAssignments ? `$1=${REDACTED_VALUE}` : "$&")
    .replace(/((?:[A-Za-z0-9_-]*)(?:access[_-]?token|auth|bearer|code|cookie|credential|key|login|nonce|pass|password|secret|session|state|token)(?:[A-Za-z0-9_-]*)(?:["'\s:=]+))[^&#\s"'<>]+/gi, `$1${REDACTED_VALUE}`)
}

export function redactUrl(value: string, options: RedactStringOptions = {}): string {
  try {
    const url = new URL(value)
    const queryKeys = [...new Set([...url.searchParams.keys()])].sort()
    const query = queryKeys.length > 0
      ? `?${queryKeys.map((key) => `${encodeURIComponent(key)}=${shouldRedactUrlQueryKey(key, options) ? REDACTED_VALUE : encodeURIComponent(url.searchParams.get(key) ?? "")}`).join("&")}`
      : ""
    return `${url.origin}${url.pathname}${query}${url.hash && options.redactUrlHash ? `#${REDACTED_VALUE}` : url.hash}`
  } catch {
    return value
  }
}

function shouldRedactUrlQueryKey(key: string, options: RedactStringOptions): boolean {
  return Boolean(options.redactAllUrlQueryValues) || isSensitiveKey(key, options)
}
