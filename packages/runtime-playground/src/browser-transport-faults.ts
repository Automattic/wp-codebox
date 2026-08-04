import { TransportFaultEngine, negotiateTransportFaults, transportFaultCapabilities, transportFaultSafeSchedule, transportRequestMatches, type TransportFaultCapability, type TransportFaultDecision, type TransportFaultEvidence, type TransportFaultFidelity, type TransportFaultModel, type TransportFaultSafeSchedule } from "@automattic/wp-codebox-core"
import type { BrowserContext, Route } from "playwright"
import type { BrowserPreviewTransportFaultPolicy } from "./browser-preview-routing.js"

const BROWSER_TRANSPORT_FAULT_DRAIN_TIMEOUT_MS = 5_000

const browserCapabilities: TransportFaultCapability[] = [
  { semantic: "response-substitution", fidelity: "exact" },
  { semantic: "malformed-response", fidelity: "emulated", reason: "Browser routing can return malformed payload bytes but not a malformed HTTP framing layer." },
  { semantic: "truncated-response", fidelity: "emulated", reason: "Browser routing returns a shortened complete body; it cannot terminate the transport mid-frame." },
  { semantic: "chunked-response", fidelity: "unsupported", reason: "The browser routing API owns response framing." },
  { semantic: "delay", fidelity: "exact" },
  { semantic: "jitter", fidelity: "exact" },
  { semantic: "bandwidth", fidelity: "emulated", reason: "Delivery time is delayed from body size; per-chunk transport pacing is unavailable." },
  { semantic: "timeout", fidelity: "emulated", reason: "The route is aborted with the browser timeout failure code after the declared interval." },
  { semantic: "connection-refusal", fidelity: "emulated", reason: "The browser reports a connection-refused request failure through route abortion." },
  { semantic: "connection-reset", fidelity: "emulated", reason: "The browser reports a connection-reset request failure through route abortion." },
  { semantic: "half-close", fidelity: "unsupported", reason: "The browser routing API does not expose socket half-close." },
  { semantic: "disconnect-after-bytes", fidelity: "unsupported", reason: "The browser routing API cannot disconnect a response after an exact byte offset." },
  { semantic: "host-remap", fidelity: "exact" },
  { semantic: "request-corruption", fidelity: "emulated", reason: "Request payload bytes can be replaced, but HTTP framing corruption is unavailable." },
  { semantic: "response-corruption", fidelity: "emulated", reason: "Response payload bytes can be replaced, but HTTP framing corruption is unavailable." },
]

export const BROWSER_TRANSPORT_FAULT_CAPABILITIES = transportFaultCapabilities("playwright-route", browserCapabilities)

export interface BrowserTransportFaultAdapter {
  engine: TransportFaultEngine
  negotiation: ReturnType<typeof negotiateTransportFaults>
  matches(route: Route): boolean
  handle(route: Route, options?: BrowserTransportFaultApplyOptions): Promise<boolean>
  evidence(): TransportFaultEvidence[]
}

export interface BrowserTransportFaultReport {
  schema: "wp-codebox/browser-transport-fault-report/v1"
  interception: {
    browserHttp: { fidelity: TransportFaultFidelity; scope: string; serviceWorkers: "blocked" | "not-enforced"; reason?: string }
    wordpressHttp: { fidelity: "unsupported"; reason: string }
  }
  seed: string
  schedule: TransportFaultSafeSchedule
  adapter: string
  fidelity: TransportFaultCapability[]
  matchedRequests: TransportFaultEvidence[]
  consumedSequenceEntries: Array<{ ruleId: string; sequenceIndex: number; invocation: number }>
  unmatchedRules: string[]
  teardown?: BrowserTransportFaultTeardown
  replay: { schema: "wp-codebox/browser-transport-fault-replay/v1"; seed: string; structuralScheduleFingerprint: string; schedule: TransportFaultSafeSchedule; fidelity: "identity-only-redacted" }
}

export interface BrowserTransportFaultTeardown {
  status: "drained" | "timed-out"
  timeoutMs: number
  pendingHandlers: number
  pendingRouteFetches: number
  routeFetchCancellation: {
    fidelity: "emulated"
    reason: string
  }
}

export interface InstalledBrowserTransportFaults {
  adapter: BrowserTransportFaultAdapter
  inFlight(): number
  report(): BrowserTransportFaultReport
  dispose(): Promise<BrowserTransportFaultReport>
}

export interface BrowserTransportFaultApplyOptions {
  signal?: AbortSignal
  fetch?: BrowserPreviewTransportFaultPolicy["fetch"]
  recordHandled?: BrowserPreviewTransportFaultPolicy["recordHandled"]
}

export interface BrowserTransportFaultInstallOptions {
  policy?: BrowserPreviewTransportFaultPolicy
  serviceWorkersBlocked?: boolean
  drainTimeoutMs?: number
}

export function createBrowserTransportFaultAdapter(model: TransportFaultModel): BrowserTransportFaultAdapter {
  const engine = new TransportFaultEngine(model, BROWSER_TRANSPORT_FAULT_CAPABILITIES)
  const negotiation = negotiateTransportFaults(model, BROWSER_TRANSPORT_FAULT_CAPABILITIES)
  return {
    engine,
    negotiation,
    matches(route) {
      const request = route.request()
      const transportRequest = { url: request.url(), method: request.method(), headers: request.headers(), body: request.postDataBuffer() ?? undefined }
      return engine.model.rules.some(({ match }) => transportRequestMatches(match, transportRequest))
    },
    async handle(route, options) { return await applyBrowserTransportFault(route, engine, options) },
    evidence() { return [...engine.evidence] },
  }
}

/**
 * Installs a context-local schedule. Teardown aborts handler wrappers and waits
 * for underlying route.fetch promises up to drainTimeoutMs; Playwright exposes
 * no direct cancellation signal for route.fetch, so timeout state is evidence.
 */
export async function installBrowserTransportFaults(context: BrowserContext, model: TransportFaultModel, options: BrowserTransportFaultInstallOptions = {}): Promise<InstalledBrowserTransportFaults> {
  const adapter = createBrowserTransportFaultAdapter(model)
  if (!adapter.negotiation.supported) {
    throw new Error(`Browser transport fault schedule requires unsupported semantics: ${adapter.negotiation.unsupported.map(({ semantic }) => semantic).join(", ")}`)
  }
  const controller = new AbortController()
  const pending = new Set<Promise<void>>()
  const pendingRouteFetches = new Set<Promise<void>>()
  const drainTimeoutMs = options.drainTimeoutMs ?? BROWSER_TRANSPORT_FAULT_DRAIN_TIMEOUT_MS
  const trackedFetch = (route: Route, overrides: { url?: string; postData?: Buffer }) => {
    const operation = options.policy ? options.policy.fetch(route, overrides) : route.fetch(overrides)
    let tracked: Promise<void>
    tracked = operation.then(() => undefined, () => undefined).finally(() => pendingRouteFetches.delete(tracked))
    pendingRouteFetches.add(tracked)
    return operation
  }
  let finalReport: BrowserTransportFaultReport | undefined
  const handler = async (route: Route) => {
    if (disposed) {
      await route.abort("aborted").catch(() => undefined)
      return
    }
    const operation = (async () => {
      if (!adapter.matches(route)) {
        await route.fallback()
        return
      }
      if (options.policy && !await options.policy.preflight(route)) return
      if (!await adapter.handle(route, { signal: controller.signal, fetch: trackedFetch, recordHandled: options.policy?.recordHandled })) await route.fallback()
    })()
    let tracked: Promise<void>
    tracked = operation.catch(async (error) => {
      if (!isTransportFaultAbort(error)) throw error
      await route.abort("aborted").catch(() => undefined)
    }).finally(() => pending.delete(tracked))
    pending.add(tracked)
    await tracked
  }
  await context.route("**/*", handler)
  let disposed = false
  return {
    adapter,
    inFlight: () => pending.size,
    report: () => {
      if (!finalReport) throw new Error("Browser transport fault evidence is unavailable until routing is disposed and drained.")
      return finalReport
    },
    async dispose() {
      if (disposed) return finalReport ?? browserTransportFaultReport(adapter, options.serviceWorkersBlocked ?? false)
      disposed = true
      controller.abort()
      const deadline = Date.now() + drainTimeoutMs
      const handlersDrained = await drainTransportFaultTasks(pending, deadline)
      await context.unroute("**/*", handler)
      const fetchesDrained = await drainTransportFaultTasks(pendingRouteFetches, deadline)
      const teardown: BrowserTransportFaultTeardown = {
        status: handlersDrained && fetchesDrained ? "drained" : "timed-out",
        timeoutMs: drainTimeoutMs,
        pendingHandlers: pending.size,
        pendingRouteFetches: pendingRouteFetches.size,
        routeFetchCancellation: {
          fidelity: "emulated",
          reason: "Playwright route.fetch has no AbortSignal; teardown aborts the owning route wrapper and waits boundedly for the underlying fetch promise.",
        },
      }
      finalReport = browserTransportFaultReport(adapter, options.serviceWorkersBlocked ?? false, teardown)
      return finalReport
    },
  }
}

export function browserTransportFaultReport(adapter: BrowserTransportFaultAdapter, serviceWorkersBlocked = false, teardown?: BrowserTransportFaultTeardown): BrowserTransportFaultReport {
  const matchedRequests = adapter.evidence()
  const matchedRuleIds = new Set(matchedRequests.flatMap((item) => item.fault ? [item.fault.ruleId] : []))
  const required = new Set(adapter.negotiation.required)
  const schedule = transportFaultSafeSchedule(adapter.engine.model)
  return {
    schema: "wp-codebox/browser-transport-fault-report/v1",
    interception: {
      browserHttp: serviceWorkersBlocked
        ? { fidelity: "exact", scope: "HTTP(S) requests emitted by this isolated browser context, including navigation, fetch, XHR, and subresources.", serviceWorkers: "blocked" }
        : { fidelity: "emulated", scope: "HTTP(S) requests observed by Playwright routing.", serviceWorkers: "not-enforced", reason: "Service-worker-owned requests can bypass Playwright routing unless the browser context blocks service workers." },
      wordpressHttp: { fidelity: "unsupported", reason: "Playwright routing cannot observe server-side WordPress HTTP API requests; use the WordPress HTTP fault adapter for that traffic." },
    },
    seed: adapter.engine.model.seed,
    schedule,
    adapter: adapter.engine.capabilities.adapter,
    fidelity: adapter.engine.capabilities.capabilities.filter(({ semantic }) => required.has(semantic)),
    matchedRequests,
    consumedSequenceEntries: matchedRequests.flatMap((item) => item.fault ? [{ ruleId: item.fault.ruleId, sequenceIndex: item.fault.sequenceIndex, invocation: item.fault.invocation }] : []),
    unmatchedRules: adapter.engine.model.rules.map(({ id }) => id).filter((id) => !matchedRuleIds.has(id)),
    ...(teardown ? { teardown } : {}),
    replay: { schema: "wp-codebox/browser-transport-fault-replay/v1", seed: adapter.engine.model.seed, structuralScheduleFingerprint: schedule.structuralFingerprint, schedule, fidelity: "identity-only-redacted" },
  }
}

export async function applyBrowserTransportFault(route: Route, engine: TransportFaultEngine, options: BrowserTransportFaultApplyOptions = {}): Promise<boolean> {
  const request = route.request()
  const transportRequest = { url: request.url(), method: request.method(), headers: request.headers(), body: request.postDataBuffer() ?? undefined }
  const decision = engine.decide(transportRequest)
  if (!decision) return false
  const unsupported = decision.semantics.map((semantic) => engine.capabilities.capabilities.find((item) => item.semantic === semantic)).filter((item) => item?.fidelity === "unsupported")
  if (unsupported.length > 0) {
    engine.record(transportRequest, decision, { connection: "unsupported" })
    throw new Error(`Browser transport fault semantics are unsupported: ${unsupported.map((item) => item?.semantic).join(", ")}`)
  }

  if (decision.delayMs > 0) await abortableDelay(decision.delayMs, options.signal)
  if (decision.outcome.timeoutMs !== undefined) {
    await abortableDelay(decision.outcome.timeoutMs, options.signal)
    options.recordHandled?.(route)
    await route.abort("timedout")
    engine.record(transportRequest, decision, { connection: "timedout" })
    return true
  }
  if (decision.outcome.connection) {
    const code = decision.outcome.connection === "refuse" ? "connectionrefused" : decision.outcome.connection === "reset" ? "connectionreset" : "failed"
    options.recordHandled?.(route)
    await route.abort(code)
    engine.record(transportRequest, decision, { connection: decision.outcome.connection })
    return true
  }

  const continuation = browserFaultContinuation(decision, request.url(), request.postDataBuffer() ?? undefined)
  const needsResponse = browserFaultNeedsResponse(decision)
  if (!needsResponse) {
    await route.fallback(continuation)
    engine.record(transportRequest, decision)
    return true
  }

  const needsUpstream = decision.outcome.status === undefined || decision.outcome.body === undefined && decision.outcome.bodyBase64 === undefined || decision.outcome.responseCorruption || decision.outcome.truncateAfterBytes !== undefined
  const upstream = needsUpstream
    ? await abortableOperation(options.fetch ? options.fetch(route, continuation) : route.fetch(continuation), options.signal)
    : undefined
  if (needsUpstream && upstream === undefined && options.fetch) return true
  const originalBody = upstream ? await upstream.body() : Buffer.alloc(0)
  let body = decision.outcome.bodyBase64 !== undefined ? Buffer.from(decision.outcome.bodyBase64, "base64") : decision.outcome.body !== undefined ? Buffer.from(decision.outcome.body) : originalBody
  body = mutateResponseBody(body, decision)
  if (decision.outcome.bandwidthBytesPerSecond && body.length > 0) await abortableDelay(Math.ceil(body.length / decision.outcome.bandwidthBytesPerSecond * 1000), options.signal)
  const status = decision.outcome.status ?? upstream?.status() ?? 200
  const headers = { ...(upstream?.headers() ?? {}), ...(decision.outcome.headers ?? {}) }
  if (!(needsUpstream && options.fetch)) options.recordHandled?.(route)
  await route.fulfill({ status, headers, body })
  engine.record(transportRequest, decision, { status, headers, bodyBytes: body.length })
  return true
}

function browserFaultContinuation(decision: TransportFaultDecision, requestUrl: string, originalBody: Buffer | undefined): { url?: string; postData?: Buffer } {
  const continuation: { url?: string; postData?: Buffer } = {}
  if (decision.outcome.remapHost) {
    const url = new URL(requestUrl)
    const target = decision.outcome.remapHost.includes("://") ? new URL(decision.outcome.remapHost) : new URL(`${url.protocol}//${decision.outcome.remapHost}`)
    url.protocol = target.protocol
    url.hostname = target.hostname
    url.port = target.port
    continuation.url = url.toString()
  }
  if (decision.outcome.requestCorruption && originalBody) continuation.postData = corruptBytes(originalBody, decision.outcome.requestCorruption)
  return continuation
}

function browserFaultNeedsResponse(decision: TransportFaultDecision): boolean {
  const outcome = decision.outcome
  return outcome.status !== undefined || outcome.headers !== undefined || outcome.body !== undefined || outcome.bodyBase64 !== undefined || outcome.malformed === true || outcome.truncateAfterBytes !== undefined || outcome.responseCorruption !== undefined || outcome.bandwidthBytesPerSecond !== undefined
}

function mutateResponseBody(body: Buffer, decision: TransportFaultDecision): Buffer {
  let result: Buffer = Buffer.from(body)
  if (decision.outcome.malformed) result = Buffer.from([0xff, 0xfe, 0x00, ...result.subarray(0, Math.min(result.length, 16))])
  if (decision.outcome.responseCorruption) result = corruptBytes(result, decision.outcome.responseCorruption)
  if (decision.outcome.truncateAfterBytes !== undefined) result = result.subarray(0, decision.outcome.truncateAfterBytes)
  return result
}

function corruptBytes(input: Buffer, mode: "truncate" | "flip-byte" | "invalid-encoding"): Buffer {
  if (mode === "truncate") return input.subarray(0, Math.floor(input.length / 2))
  if (mode === "invalid-encoding") return Buffer.concat([Buffer.from([0xff, 0xfe]), input])
  const output = Buffer.from(input)
  if (output.length === 0) return Buffer.from([0xff])
  output[Math.floor(output.length / 2)] = (output[Math.floor(output.length / 2)] ?? 0) ^ 0xff
  return output
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, milliseconds))
  if (signal.aborted) return Promise.reject(transportFaultAbortError())
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort)
      resolve()
    }, milliseconds)
    const abort = () => {
      clearTimeout(timer)
      reject(transportFaultAbortError())
    }
    signal.addEventListener("abort", abort, { once: true })
  })
}

function abortableOperation<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation
  if (signal.aborted) return Promise.reject(transportFaultAbortError())
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(transportFaultAbortError())
    signal.addEventListener("abort", abort, { once: true })
    operation.then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value) },
      (error) => { signal.removeEventListener("abort", abort); reject(error) },
    )
  })
}

async function drainTransportFaultTasks(pending: Set<Promise<void>>, deadline: number): Promise<boolean> {
  if (pending.size === 0) return true
  const remainingMs = deadline - Date.now()
  if (remainingMs <= 0) return false
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      Promise.allSettled([...pending]).then(() => "drained" as const),
      new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), remainingMs) }),
    ])
    return result === "drained"
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function transportFaultAbortError(): Error {
  const error = new Error("Browser transport fault operation aborted during teardown.")
  error.name = "AbortError"
  return error
}

function isTransportFaultAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError"
}
