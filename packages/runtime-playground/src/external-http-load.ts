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
  latency: Record<string, number>
  diagnostics: Array<Record<string, unknown>>
  provenance: {
    source: "host-side-external-http"
    transport: "runtime-preview-http"
    runtimeScope: "single-runtime"
    target: string
    method: string
  }
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
        const response = await fetch(resolvedUrl, { method, headers, body })
        statusDistribution[String(response.status)] = (statusDistribution[String(response.status)] ?? 0) + 1
        await response.arrayBuffer()
        latenciesMs.push(performance.now() - started)
        if (expectedStatuses.includes(response.status)) {
          successCount++
        } else {
          failureCount++
          diagnostics.push({ code: "unexpected_status", requestIndex, expectedStatuses, actualStatus: response.status })
        }
      } catch (error) {
        latenciesMs.push(performance.now() - started)
        failureCount++
        diagnostics.push({ code: "request_failed", requestIndex, message: errorMessage(error) })
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
    latency: numericSummary(latenciesMs),
    diagnostics,
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
