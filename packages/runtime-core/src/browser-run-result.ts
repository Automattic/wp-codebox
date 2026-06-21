import { normalizeMaterializationArtifactRefs, persistedBrowserArtifactRefs, type MaterializationArtifactRef, type MaterializationDiagnostic } from "./materialization-contracts.js"

export const BROWSER_RUN_RESULT_SCHEMA = "wp-codebox/browser-run-result/v1" as const

export type BrowserRunResultStatus = "completed" | "failed" | "skipped"

export interface BrowserRunResultEnvelopeBase {
  schema: typeof BROWSER_RUN_RESULT_SCHEMA
  operation: string
  status: BrowserRunResultStatus
  success: boolean
  result: Record<string, unknown> | null
  artifactRefs: MaterializationArtifactRef[]
  diagnostics: MaterializationDiagnostic[]
  metadata?: Record<string, unknown>
}

export interface CompletedBrowserRunResultEnvelope extends BrowserRunResultEnvelopeBase {
  status: "completed"
  success: true
  result: Record<string, unknown>
}

export interface FailedBrowserRunResultEnvelope extends BrowserRunResultEnvelopeBase {
  status: "failed"
  success: false
  error: {
    name: string
    message: string
    code?: string
  }
}

export interface SkippedBrowserRunResultEnvelope extends BrowserRunResultEnvelopeBase {
  status: "skipped"
  success: false
  reason?: string
}

export type BrowserRunResultEnvelope = CompletedBrowserRunResultEnvelope | FailedBrowserRunResultEnvelope | SkippedBrowserRunResultEnvelope

export function browserRunResultEnvelope(input: {
  operation: string
  status?: BrowserRunResultStatus
  result?: Record<string, unknown> | null
  artifactRefs?: MaterializationArtifactRef[]
  diagnostics?: MaterializationDiagnostic[]
  metadata?: Record<string, unknown>
  error?: { name?: string; message?: string; code?: string } | Error | string
  reason?: string
}): BrowserRunResultEnvelope {
  const status = input.status ?? (input.error ? "failed" : "completed")
  const base = stripUndefined({
    schema: BROWSER_RUN_RESULT_SCHEMA,
    operation: input.operation,
    status,
    success: status === "completed",
    result: input.result ?? null,
    artifactRefs: normalizeMaterializationArtifactRefs(input.artifactRefs),
    diagnostics: input.diagnostics ?? [],
    metadata: input.metadata,
  })

  if (status === "failed") {
    return stripUndefined({
      ...base,
      status,
      success: false as const,
      error: normalizeError(input.error, "Browser run failed."),
    })
  }

  if (status === "skipped") {
    return stripUndefined({
      ...base,
      status,
      success: false as const,
      reason: input.reason,
    })
  }

  return {
    ...base,
    status,
    success: true as const,
    result: input.result ?? {},
  }
}

export function normalizeBrowserRunResult(input: unknown, operation = "browser-run"): BrowserRunResultEnvelope {
  const source = asRecord(input)
  if (source?.schema === BROWSER_RUN_RESULT_SCHEMA) {
    return browserRunResultEnvelope({
      operation: stringValue(source.operation) || operation,
      status: browserRunResultStatus(source.status) ?? (source.success === false ? "failed" : undefined),
      result: asRecord(source.result) ?? null,
      artifactRefs: Array.isArray(source.artifactRefs) ? source.artifactRefs as MaterializationArtifactRef[] : [],
      diagnostics: Array.isArray(source.diagnostics) ? source.diagnostics.map(materializationDiagnostic).filter(isDefined) : [],
      metadata: asRecord(source.metadata),
      error: errorObject(source.error),
      reason: stringValue(source.reason) || undefined,
    })
  }

  const result = browserRunPayload(source)
  const success = source?.success === true || result?.success === true
  const status = success ? "completed" : source?.status === "skipped" ? "skipped" : "failed"
  return browserRunResultEnvelope({
    operation,
    status,
    result,
    artifactRefs: persistedBrowserArtifactRefs(result ?? source),
    error: success ? undefined : errorObject(source?.error) ?? errorObject(result?.error) ?? "Browser run failed.",
    reason: status === "skipped" ? stringValue(source?.reason) : undefined,
  })
}

function browserRunPayload(source: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!source) return null
  return asRecord(source.result) ?? asRecord(source.data) ?? asRecord(source.response) ?? source
}

function browserRunResultStatus(value: unknown): BrowserRunResultStatus | undefined {
  return value === "completed" || value === "failed" || value === "skipped" ? value : undefined
}

function materializationDiagnostic(input: unknown): MaterializationDiagnostic | undefined {
  const source = asRecord(input)
  const code = stringValue(source?.code)
  const message = stringValue(source?.message)
  if (!code || !message) return undefined
  const severity: MaterializationDiagnostic["severity"] = source?.severity === "info" || source?.severity === "warning" || source?.severity === "error" ? source.severity : undefined
  return stripUndefined({
    code,
    message,
    severity,
    phase: stringValue(source?.phase),
    metadata: asRecord(source?.metadata),
  })
}

function normalizeError(input: { name?: string; message?: string; code?: string } | Error | string | undefined, fallbackMessage: string): FailedBrowserRunResultEnvelope["error"] {
  if (input instanceof Error) return stripUndefined({ name: input.name || "Error", message: input.message || fallbackMessage, code: "code" in input && typeof input.code === "string" ? input.code : undefined })
  if (typeof input === "string") return { name: "Error", message: input || fallbackMessage }
  return stripUndefined({
    name: stringValue(input?.name) || "Error",
    message: stringValue(input?.message) || fallbackMessage,
    code: stringValue(input?.code),
  })
}

function errorObject(value: unknown): FailedBrowserRunResultEnvelope["error"] | undefined {
  const source = asRecord(value)
  const message = stringValue(source?.message)
  return message ? normalizeError({ name: stringValue(source?.name) || "Error", message, code: stringValue(source?.code) }, message) : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function stringValue(value: unknown): string {
  return typeof value === "string" && value.trim() ? value : ""
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T
}
