import type { RuntimeCommandDiagnosticsCaptureKind, RuntimeCommandDiagnosticsCaptureSpec } from "./runtime-contracts.js"

export const COMMAND_DIAGNOSTICS_ARTIFACT_SCHEMA = "wp-codebox/command-diagnostics/v1" as const

export const COMMAND_DIAGNOSTICS_CAPTURE_KINDS = ["wpdb-queries"] as const satisfies readonly RuntimeCommandDiagnosticsCaptureKind[]

export const COMMAND_DIAGNOSTICS_DEFAULT_MAX_ITEMS = 50
export const COMMAND_DIAGNOSTICS_DEFAULT_MAX_BYTES = 64 * 1024
export const COMMAND_DIAGNOSTICS_MAX_ITEMS = 500
export const COMMAND_DIAGNOSTICS_MAX_BYTES = 512 * 1024

export function normalizeCommandDiagnosticsCaptureSpec(spec?: RuntimeCommandDiagnosticsCaptureSpec): RuntimeCommandDiagnosticsCaptureSpec | undefined {
  const capture = [...new Set((spec?.capture ?? []).filter(isCommandDiagnosticsCaptureKind))]
  if (capture.length === 0) {
    return undefined
  }

  return {
    capture,
    maxItems: boundedInteger(spec?.maxItems, COMMAND_DIAGNOSTICS_DEFAULT_MAX_ITEMS, COMMAND_DIAGNOSTICS_MAX_ITEMS),
    maxBytes: boundedInteger(spec?.maxBytes, COMMAND_DIAGNOSTICS_DEFAULT_MAX_BYTES, COMMAND_DIAGNOSTICS_MAX_BYTES),
  }
}

export function commandDiagnosticsCaptureSpecFromArgs(args: readonly string[], explicit?: RuntimeCommandDiagnosticsCaptureSpec): RuntimeCommandDiagnosticsCaptureSpec | undefined {
  const argSpec = normalizeCommandDiagnosticsCaptureSpec({
    capture: commaListArg(args, "capture-diagnostics") as RuntimeCommandDiagnosticsCaptureKind[],
    maxItems: integerArg(args, "diagnostics-max-items"),
    maxBytes: integerArg(args, "diagnostics-max-bytes"),
  })

  const explicitSpec = normalizeCommandDiagnosticsCaptureSpec(explicit)
  if (!argSpec && !explicitSpec) {
    return undefined
  }

  return normalizeCommandDiagnosticsCaptureSpec({
    capture: [...(explicitSpec?.capture ?? []), ...(argSpec?.capture ?? [])],
    maxItems: argSpec?.maxItems ?? explicitSpec?.maxItems,
    maxBytes: argSpec?.maxBytes ?? explicitSpec?.maxBytes,
  })
}

export function commandDiagnosticsCaptureArgs(spec?: RuntimeCommandDiagnosticsCaptureSpec): string[] {
  const normalized = normalizeCommandDiagnosticsCaptureSpec(spec)
  if (!normalized) {
    return []
  }

  return [
    `capture-diagnostics=${normalized.capture?.join(",")}`,
    `diagnostics-max-items=${normalized.maxItems}`,
    `diagnostics-max-bytes=${normalized.maxBytes}`,
  ]
}

function isCommandDiagnosticsCaptureKind(value: unknown): value is RuntimeCommandDiagnosticsCaptureKind {
  return typeof value === "string" && (COMMAND_DIAGNOSTICS_CAPTURE_KINDS as readonly string[]).includes(value)
}

function commaListArg(args: readonly string[], name: string): string[] {
  const prefix = `${name}=`
  const value = args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
  return value ? value.split(",").map((item) => item.trim()).filter(Boolean) : []
}

function integerArg(args: readonly string[], name: string): number | undefined {
  const prefix = `${name}=`
  const value = args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
  if (!value || !/^\d+$/.test(value)) {
    return undefined
  }
  return Number.parseInt(value, 10)
}

function boundedInteger(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isInteger(value) || typeof value !== "number" || value <= 0) {
    return fallback
  }
  return Math.min(value, max)
}
