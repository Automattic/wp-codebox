import type { IncomingMessage } from "node:http"
import { redactString } from "@automattic/wp-codebox-core"

const PREVIEW_PROXY_REQUEST_TRACE_CAPACITY = 64
const FETCH_DESTINATIONS = new Set(["audio", "audioworklet", "document", "embed", "empty", "font", "frame", "iframe", "image", "manifest", "object", "paintworklet", "report", "script", "serviceworker", "sharedworker", "style", "track", "video", "worker", "xslt"])

export interface PlaygroundPreviewProxyRequestTrace {
  scope: "service-worker"
  capacity: 64
  total: number
  dropped: number
  entries: PlaygroundPreviewProxyRequestTraceEntry[]
}

export interface PlaygroundPreviewProxyRequestTraceEntry {
  sequence: number
  method: string
  path: string
  destination: string | null
  serviceWorker: boolean
  outcome: "response" | "upstream-error"
  status?: number
  upstreamLocation?: string
  visibleLocation?: string
}

export type PlaygroundPreviewProxyRequestOutcome = Pick<PlaygroundPreviewProxyRequestTraceEntry, "outcome" | "status" | "upstreamLocation" | "visibleLocation">

export function createPreviewProxyRequestTrace(): PlaygroundPreviewProxyRequestTrace {
  return { scope: "service-worker", capacity: PREVIEW_PROXY_REQUEST_TRACE_CAPACITY, total: 0, dropped: 0, entries: [] }
}

export function snapshotPreviewProxyRequestTrace(trace: PlaygroundPreviewProxyRequestTrace): PlaygroundPreviewProxyRequestTrace {
  return { ...trace, entries: trace.entries.map((entry) => ({ ...entry })) }
}

export function recordPreviewProxyRequest(trace: PlaygroundPreviewProxyRequestTrace, incoming: IncomingMessage, path: string, outcome: PlaygroundPreviewProxyRequestOutcome): void {
  const serviceWorker = incoming.headers["service-worker"] === "script"
  if (!serviceWorker) {
    return
  }

  trace.total += 1
  trace.entries.push({
    sequence: trace.total,
    method: incoming.method ?? "GET",
    path: redactPreviewProxyUrl(path),
    destination: previewProxyFetchDestination(incoming.headers["sec-fetch-dest"]),
    serviceWorker,
    ...outcome,
    ...(outcome.upstreamLocation ? { upstreamLocation: redactPreviewProxyUrl(outcome.upstreamLocation) } : {}),
    ...(outcome.visibleLocation ? { visibleLocation: redactPreviewProxyUrl(outcome.visibleLocation) } : {}),
  })
  if (trace.entries.length > trace.capacity) {
    trace.entries.shift()
    trace.dropped += 1
  }
}

function redactPreviewProxyUrl(value: string): string {
  return redactString(value, { redactAllUrlQueryValues: true, redactUrlHash: true, redactQueryAssignments: true })
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function previewProxyFetchDestination(value: string | string[] | undefined): string | null {
  const destination = headerValue(value)?.trim().toLowerCase() ?? ""
  return FETCH_DESTINATIONS.has(destination) ? destination : null
}
