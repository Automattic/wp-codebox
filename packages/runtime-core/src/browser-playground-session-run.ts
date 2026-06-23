import { browserRunResultEnvelope, normalizeBrowserRunResult, type BrowserRunResultEnvelope } from "./browser-run-result.js"

export const BROWSER_PLAYGROUND_SESSION_RUN_SCHEMA = "wp-codebox/browser-playground-session-run/v1" as const
export const BROWSER_PLAYGROUND_PREVIEW_ACCESS_SCHEMA = "wp-codebox/browser-playground-preview-access/v1" as const

export interface BrowserPlaygroundSessionRunInput {
  [key: string]: unknown
}

export interface BrowserPlaygroundSessionOutput {
  success?: boolean
  schema?: string
  session?: Record<string, unknown>
  recipe?: Record<string, unknown>
  artifacts?: Record<string, unknown>
  materialization?: Record<string, unknown>
  preview_access?: Record<string, unknown>
  runtime_access?: Record<string, unknown>
  preview?: Record<string, unknown>
  [key: string]: unknown
}

export interface BrowserPlaygroundSessionExecutionOutput {
  success?: boolean
  status?: string
  browser_run_result?: unknown
  result?: unknown
  execution?: unknown
  artifacts?: unknown
  events?: unknown
  terminal_outcome?: unknown
  terminal_result?: unknown
  preview?: Record<string, unknown>
  runtime_access?: Record<string, unknown>
  error?: unknown
  errors?: unknown
  [key: string]: unknown
}

export interface BrowserPlaygroundPreviewAccess {
  schema: typeof BROWSER_PLAYGROUND_PREVIEW_ACCESS_SCHEMA
  reviewer_url?: string
  public_url?: string
  local_url?: string
  site_url?: string
  safe_for_review: boolean
  reachability: "ready" | "blocked" | "local-only" | "unavailable" | "unknown"
  lease?: Record<string, unknown>
  reviewer_access?: Record<string, unknown>
}

export interface BrowserPlaygroundSessionRunEnvelope {
  schema: typeof BROWSER_PLAYGROUND_SESSION_RUN_SCHEMA
  success: boolean
  status: "completed" | "failed" | "skipped"
  session: BrowserPlaygroundSessionOutput | null
  browser_run_result: BrowserRunResultEnvelope
  preview_access: BrowserPlaygroundPreviewAccess
  artifacts: unknown[]
  events: unknown[]
  terminal_outcome: unknown
  errors: unknown[]
}

export interface BrowserPlaygroundSessionRunner {
  createBrowserPlaygroundSession(input: BrowserPlaygroundSessionRunInput): Promise<BrowserPlaygroundSessionOutput> | BrowserPlaygroundSessionOutput
  executeBrowserPlaygroundSession(session: BrowserPlaygroundSessionOutput): Promise<BrowserPlaygroundSessionExecutionOutput> | BrowserPlaygroundSessionExecutionOutput
}

export async function runBrowserPlaygroundSession(
  input: BrowserPlaygroundSessionRunInput,
  runner: BrowserPlaygroundSessionRunner,
): Promise<BrowserPlaygroundSessionRunEnvelope> {
  let session: BrowserPlaygroundSessionOutput | null = null

  try {
    session = await runner.createBrowserPlaygroundSession(input)
    if (session.success === false) {
      const result = browserRunResultEnvelope({ operation: "run-browser-playground-session", status: "failed", error: errorFromUnknown(session.error) ?? "Browser playground session creation failed." })
      return browserPlaygroundSessionRunEnvelope(session, {}, result)
    }

    const execution = await runner.executeBrowserPlaygroundSession(session)
    const result = normalizeBrowserRunResult(execution.browser_run_result ?? execution.result ?? execution, "run-browser-playground-session")
    return browserPlaygroundSessionRunEnvelope(session, execution, result)
  } catch (error) {
    const result = browserRunResultEnvelope({ operation: "run-browser-playground-session", status: "failed", error: errorFromUnknown(error) })
    return browserPlaygroundSessionRunEnvelope(session, {}, result, [errorFromUnknown(error)])
  }
}

export function normalizeBrowserPlaygroundPreviewAccess(...sources: unknown[]): BrowserPlaygroundPreviewAccess {
  const records = sources.map(asRecord).filter(isDefined)
  const reviewerAccess = firstRecord(records, "reviewer_access") ?? firstRecord(records, "reviewerAccess")
  const runtimeAccess = firstRecord(records, "runtime_access")
  const preview = firstRecord(records, "preview")
  const lease = firstRecord(records, "lease") ?? firstRecord([runtimeAccess, preview, reviewerAccess], "lease")
  const publicUrl = firstString(records, "public_url") ?? firstString(records, "publicUrl") ?? firstString([runtimeAccess, preview, lease], "public_url") ?? firstString([runtimeAccess, preview, lease], "publicUrl")
  const localUrl = firstString(records, "local_url") ?? firstString(records, "localUrl") ?? firstString([runtimeAccess, preview, lease], "local_url") ?? firstString([runtimeAccess, preview, lease], "localUrl")
  const siteUrl = firstString(records, "site_url") ?? firstString(records, "siteUrl") ?? firstString([runtimeAccess, preview, lease], "site_url") ?? firstString([runtimeAccess, preview, lease], "siteUrl")
  const reviewerUrl = firstString(records, "reviewer_url") ?? firstString(records, "reviewerUrl") ?? firstString([reviewerAccess], "openUrl") ?? publicUrl
  const reviewerSafe = firstBoolean(records, "safe_for_review") ?? firstBoolean(records, "reviewerSafe") ?? firstBoolean([reviewerAccess], "reviewerSafe") ?? isReviewerSafeUrl(reviewerUrl)
  const reachability = reviewerSafe ? "ready" : localUrl ? "local-only" : reviewerUrl || publicUrl ? "blocked" : "unavailable"

  return stripUndefined({
    schema: BROWSER_PLAYGROUND_PREVIEW_ACCESS_SCHEMA,
    reviewer_url: reviewerUrl,
    public_url: publicUrl,
    local_url: localUrl,
    site_url: siteUrl,
    safe_for_review: reviewerSafe,
    reachability: (firstString(records, "reachability") as BrowserPlaygroundPreviewAccess["reachability"] | undefined) ?? reachability,
    lease,
    reviewer_access: reviewerAccess,
  })
}

function browserPlaygroundSessionRunEnvelope(
  session: BrowserPlaygroundSessionOutput | null,
  execution: BrowserPlaygroundSessionExecutionOutput,
  browserRunResult: BrowserRunResultEnvelope,
  caughtErrors: unknown[] = [],
): BrowserPlaygroundSessionRunEnvelope {
  return {
    schema: BROWSER_PLAYGROUND_SESSION_RUN_SCHEMA,
    success: browserRunResult.success,
    status: browserRunResult.status,
    session,
    browser_run_result: browserRunResult,
    preview_access: normalizeBrowserPlaygroundPreviewAccess(execution.preview_access, execution.runtime_access, execution.preview, session?.preview_access, session?.runtime_access, session?.preview),
    artifacts: arrayValue(execution.artifacts) ?? arrayValue(session?.artifacts) ?? [],
    events: arrayValue(execution.events) ?? [],
    terminal_outcome: execution.terminal_outcome ?? execution.terminal_result ?? null,
    errors: [...(arrayValue(execution.errors) ?? []), ...(browserRunResult.status === "failed" && "error" in browserRunResult ? [browserRunResult.error] : []), ...caughtErrors.filter(isDefined)],
  }
}

function firstRecord(records: Array<Record<string, unknown> | undefined>, key: string): Record<string, unknown> | undefined {
  for (const record of records) {
    const value = asRecord(record?.[key])
    if (value) return value
  }
  return undefined
}

function firstString(records: Array<Record<string, unknown> | undefined>, key: string): string | undefined {
  for (const record of records) {
    const value = record?.[key]
    if (typeof value === "string" && value.trim()) return value
  }
  return undefined
}

function firstBoolean(records: Array<Record<string, unknown> | undefined>, key: string): boolean | undefined {
  for (const record of records) {
    const value = record?.[key]
    if (typeof value === "boolean") return value
  }
  return undefined
}

function isReviewerSafeUrl(url: string | undefined): boolean {
  if (!url) return false
  try {
    const parsed = new URL(url)
    return parsed.protocol === "https:" && !["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"].includes(parsed.hostname)
  } catch {
    return false
  }
}

function errorFromUnknown(error: unknown): { name: string; message: string; code?: string } {
  if (error instanceof Error) {
    return stripUndefined({ name: error.name || "Error", message: error.message || "Browser playground session run failed.", code: typeof (error as Error & { code?: unknown }).code === "string" ? (error as Error & { code?: string }).code : undefined })
  }
  const record = asRecord(error)
  return stripUndefined({ name: typeof record?.name === "string" ? record.name : "Error", message: typeof record?.message === "string" ? record.message : String(error || "Browser playground session run failed."), code: typeof record?.code === "string" ? record.code : undefined })
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function arrayValue(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T
}
