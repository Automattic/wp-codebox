import { TransportFaultEngine, negotiateTransportFaults, transportFaultCapabilities, type TransportFaultCapability, type TransportFaultDecision, type TransportFaultEvidence, type TransportFaultModel } from "@automattic/wp-codebox-core"
import type { Route } from "playwright"

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
  handle(route: Route): Promise<boolean>
  evidence(): TransportFaultEvidence[]
}

export function createBrowserTransportFaultAdapter(model: TransportFaultModel): BrowserTransportFaultAdapter {
  const engine = new TransportFaultEngine(model, BROWSER_TRANSPORT_FAULT_CAPABILITIES)
  const negotiation = negotiateTransportFaults(model, BROWSER_TRANSPORT_FAULT_CAPABILITIES)
  return {
    engine,
    negotiation,
    async handle(route) { return await applyBrowserTransportFault(route, engine) },
    evidence() { return [...engine.evidence] },
  }
}

export async function applyBrowserTransportFault(route: Route, engine: TransportFaultEngine): Promise<boolean> {
  const request = route.request()
  const transportRequest = { url: request.url(), method: request.method(), headers: request.headers(), body: request.postDataBuffer() ?? undefined }
  const decision = engine.decide(transportRequest)
  if (!decision) return false
  const unsupported = decision.semantics.map((semantic) => engine.capabilities.capabilities.find((item) => item.semantic === semantic)).filter((item) => item?.fidelity === "unsupported")
  if (unsupported.length > 0) {
    engine.record(transportRequest, decision, { connection: "unsupported" })
    throw new Error(`Browser transport fault semantics are unsupported: ${unsupported.map((item) => item?.semantic).join(", ")}`)
  }

  if (decision.delayMs > 0) await delay(decision.delayMs)
  if (decision.outcome.timeoutMs !== undefined) {
    await delay(decision.outcome.timeoutMs)
    await route.abort("timedout")
    engine.record(transportRequest, decision, { connection: "timedout" })
    return true
  }
  if (decision.outcome.connection) {
    const code = decision.outcome.connection === "refuse" ? "connectionrefused" : decision.outcome.connection === "reset" ? "connectionreset" : "failed"
    await route.abort(code)
    engine.record(transportRequest, decision, { connection: decision.outcome.connection })
    return true
  }

  const continuation = browserFaultContinuation(decision, request.url(), request.postDataBuffer() ?? undefined)
  const needsResponse = browserFaultNeedsResponse(decision)
  if (!needsResponse) {
    await route.continue(continuation)
    engine.record(transportRequest, decision)
    return true
  }

  const upstream = decision.outcome.status === undefined || decision.outcome.body === undefined && decision.outcome.bodyBase64 === undefined || decision.outcome.responseCorruption || decision.outcome.truncateAfterBytes !== undefined
    ? await route.fetch(continuation)
    : undefined
  const originalBody = upstream ? await upstream.body() : Buffer.alloc(0)
  let body = decision.outcome.bodyBase64 !== undefined ? Buffer.from(decision.outcome.bodyBase64, "base64") : decision.outcome.body !== undefined ? Buffer.from(decision.outcome.body) : originalBody
  body = mutateResponseBody(body, decision)
  if (decision.outcome.bandwidthBytesPerSecond && body.length > 0) await delay(Math.ceil(body.length / decision.outcome.bandwidthBytesPerSecond * 1000))
  const status = decision.outcome.status ?? upstream?.status() ?? 200
  const headers = { ...(upstream?.headers() ?? {}), ...(decision.outcome.headers ?? {}) }
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
