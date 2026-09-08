export interface RuntimeExternalHttpLoadResult {
  schema: "wp-codebox/wordpress-external-http-load/v1"
  success: boolean
  requestCount: number
  concurrency: number
  maxObservedConcurrency: number
  completedCount: number
  successCount: number
  failureCount: number
  statusDistribution: Record<string, number>
  durationMs: number
  latenciesMs: number[]
  samples: RuntimeExternalHttpLoadSample[]
  latency: Record<string, number>
  diagnostics: Array<Record<string, unknown>>
  conditions: {
    expectedStatuses: number[]
  }
  provenance: {
    source: "host-side-external-http"
    transport: "runtime-preview-http"
    runtimeScope: "single-runtime"
    target: string
    method: string
  }
}

export interface RuntimeExternalHttpLoadSample {
  requestIndex: number
  durationMs: number
  status?: number
  outcome: "matched-status" | "unexpected-status" | "request-error"
  errorCode?: "fetch-failed" | "response-read-failed"
}

const RUNTIME_PREVIEW_READINESS_TIMEOUT_MS = 10_000
const RUNTIME_PREVIEW_READINESS_MAX_REDIRECTS = 3

export async function waitForRuntimePreviewReady(runtimeBaseUrl: string): Promise<void> {
  const origin = new URL(runtimeBaseUrl)
  let readinessUrl = new URL("/", origin)
  const signal = AbortSignal.timeout(RUNTIME_PREVIEW_READINESS_TIMEOUT_MS)

  for (let redirectCount = 0; redirectCount <= RUNTIME_PREVIEW_READINESS_MAX_REDIRECTS; redirectCount++) {
    const response = await fetch(readinessUrl, { redirect: "manual", signal })
    await response.arrayBuffer()
    if (response.status < 300 || response.status >= 400) {
      if (!response.ok) {
        throw new Error(`runtime preview readiness returned HTTP ${response.status}`)
      }
      return
    }

    const location = response.headers.get("location")
    if (!location) {
      throw new Error("runtime preview readiness redirect is missing Location")
    }
    readinessUrl = new URL(location, readinessUrl)
    if (readinessUrl.origin !== origin.origin) {
      throw new Error("runtime preview readiness redirect leaves the preview origin")
    }
  }

  throw new Error(`runtime preview readiness exceeded ${RUNTIME_PREVIEW_READINESS_MAX_REDIRECTS} same-origin redirects`)
}

export async function runRuntimeExternalHttpLoad(action: Record<string, unknown>, runtimeBaseUrl?: string): Promise<RuntimeExternalHttpLoadResult> {
  if (!runtimeBaseUrl) {
    throw new Error("external_http_load requires an active runtime preview origin")
  }

  const requestCount = boundedInteger(action.requestCount, "requestCount", 100)
  const concurrency = boundedInteger(action.concurrency, "concurrency", 20)
  if (concurrency > requestCount) {
    throw new Error("external_http_load concurrency must not exceed requestCount")
  }

  const baseUrl = new URL(runtimeBaseUrl)
  const inputUrl = typeof action.url === "string" && action.url.trim() !== "" ? action.url.trim() : "/"
  const resolvedUrl = new URL(inputUrl, baseUrl)
  if (resolvedUrl.origin !== baseUrl.origin) {
    throw new Error("external_http_load url must resolve to the active runtime preview origin")
  }

  const method = typeof action.method === "string" && action.method.trim() !== "" ? action.method.trim().toUpperCase() : "GET"
  const headers = normalizeHttpHeaders(action.headers)
  const body = action.body === undefined || action.body === null ? undefined : String(action.body)
  const expectedStatuses = normalizeExpectedStatuses(action.expectedStatuses ?? (action.expectedStatus === undefined ? undefined : [action.expectedStatus]))
  const statusDistribution: Record<string, number> = {}
  const latenciesMs: number[] = []
  const samples: RuntimeExternalHttpLoadSample[] = []
  const diagnostics: Array<Record<string, unknown>> = []
  let nextRequest = 0
  let activeRequests = 0
  let maxObservedConcurrency = 0
  let completedCount = 0
  let successCount = 0
  let failureCount = 0
  const loadStarted = performance.now()

  const worker = async (): Promise<void> => {
    while (true) {
      const requestIndex = nextRequest++
      if (requestIndex >= requestCount) {
        return
      }
      activeRequests++
      maxObservedConcurrency = Math.max(maxObservedConcurrency, activeRequests)
      const started = performance.now()
      try {
        const response = await fetch(resolvedUrl, { method, headers, body, redirect: "error" })
        statusDistribution[String(response.status)] = (statusDistribution[String(response.status)] ?? 0) + 1
        try {
          await response.arrayBuffer()
        } catch {
          const durationMs = performance.now() - started
          latenciesMs.push(durationMs)
          samples.push({ requestIndex, durationMs, status: response.status, outcome: "request-error", errorCode: "response-read-failed" })
          failureCount++
          diagnostics.push({ code: "response_read_failed", requestIndex, actualStatus: response.status })
          continue
        }
        const durationMs = performance.now() - started
        latenciesMs.push(durationMs)
        if (expectedStatuses.includes(response.status)) {
          successCount++
          samples.push({ requestIndex, durationMs, status: response.status, outcome: "matched-status" })
        } else {
          failureCount++
          samples.push({ requestIndex, durationMs, status: response.status, outcome: "unexpected-status" })
          diagnostics.push({ code: "unexpected_status", requestIndex, expectedStatuses, actualStatus: response.status })
        }
      } catch (error) {
        const durationMs = performance.now() - started
        latenciesMs.push(durationMs)
        samples.push({ requestIndex, durationMs, outcome: "request-error", errorCode: "fetch-failed" })
        failureCount++
        diagnostics.push({ code: "request_failed", requestIndex, errorType: errorType(error) })
      } finally {
        completedCount++
        activeRequests--
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  if (completedCount !== requestCount) {
    diagnostics.push({ code: "incomplete_execution", expected: requestCount, actual: completedCount })
  }

  return {
    schema: "wp-codebox/wordpress-external-http-load/v1",
    success: failureCount === 0 && completedCount === requestCount,
    requestCount,
    concurrency,
    maxObservedConcurrency,
    completedCount,
    successCount,
    failureCount,
    statusDistribution,
    durationMs: performance.now() - loadStarted,
    latenciesMs,
    samples,
    latency: numericSummary(latenciesMs),
    diagnostics,
    conditions: { expectedStatuses },
    provenance: {
      source: "host-side-external-http",
      transport: "runtime-preview-http",
      runtimeScope: "single-runtime",
      target: inputUrl,
      method,
    },
  }
}

function boundedInteger(value: unknown, name: string, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new Error(`external_http_load ${name} must be an integer between 1 and ${maximum}`)
  }
  return value as number
}

function normalizeExpectedStatuses(value: unknown): number[] {
  if (value === undefined) {
    return [200]
  }
  if (!Array.isArray(value) || value.length === 0 || value.some((status) => !Number.isInteger(status) || status < 100 || status > 599)) {
    throw new Error("external_http_load expectedStatuses must contain one or more HTTP status codes")
  }
  return [...new Set(value as number[])]
}

function normalizeHttpHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {}
  }
  return Object.fromEntries(Object.entries(value).map(([name, headerValue]) => [name, String(headerValue)]))
}

function numericSummary(values: number[]): Record<string, number> {
  const sorted = [...values].sort((left, right) => left - right)
  const count = sorted.length
  const mean = count > 0 ? sorted.reduce((sum, value) => sum + value, 0) / count : 0
  const percentile = (fraction: number): number => count > 0 ? sorted[Math.max(0, Math.ceil(fraction * count) - 1)] : 0
  return {
    count,
    mean,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    min: count > 0 ? sorted[0] : 0,
    max: count > 0 ? sorted[count - 1] : 0,
  }
}

function errorType(error: unknown): string {
  return error instanceof Error && error.name ? error.name : "unknown"
}
