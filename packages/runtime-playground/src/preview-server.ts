import { createServer as createHttpServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http"
import { createServer as createNetServer } from "node:net"
import { Transform } from "node:stream"
import type { PreviewLease } from "@automattic/wp-codebox-core"
import { createPreviewProxyRequestTrace, recordPreviewProxyRequest, snapshotPreviewProxyRequestTrace, type PlaygroundPreviewProxyRequestOutcome, type PlaygroundPreviewProxyRequestTrace } from "./preview-proxy-request-trace.js"

export interface PlaygroundServerRunResponse {
  exitCode?: number
  errors?: string
  text: string
}

export interface PlaygroundCliServer {
  playground: {
    run(options: ({ code: string } | { scriptPath: string }) & { env?: Record<string, string> }): Promise<PlaygroundServerRunResponse>
    onMessage?(listener: (data: string) => Promise<string | void> | string | void): Promise<(() => Promise<void> | void) | void> | (() => Promise<void> | void) | void
    readFileAsText?(path: string): string | Promise<string>
    unlink?(path: string): Promise<void> | void
    writeFile?(path: string, contents: string): Promise<void>
  }
  serverUrl: string
  wordpressUrl?: string
  requestWorkerEndpoint?: { route: string; token: string; payloadDirectory: string }
  previewLease?: PreviewLease
  previewRoutes?: PlaygroundPreviewRouteRegistry
  previewProxyDiagnostics?: PlaygroundPreviewProxyDiagnostics
  hostHttpTransport?: { url: string; token: string }
  [Symbol.asyncDispose](): Promise<void>
}

export interface PlaygroundPreviewProxyDiagnostics {
  schema: "wp-codebox/preview-proxy-diagnostics/v1"
  upstreamConcurrency: "serialized"
  maxConcurrentUpstreamRequests: 1
  queue: "fifo"
  bind: string
  targetOrigin: string
  requestTrace: PlaygroundPreviewProxyRequestTrace
}

export interface PlaygroundPreviewRouteRegistry {
  add(handler: PlaygroundPreviewRouteHandler): () => void
}

export type PlaygroundPreviewRouteHandler = (incoming: IncomingMessage, outgoing: ServerResponse) => Promise<boolean> | boolean

interface PlaygroundPreviewProxy {
  serverUrl: string
  previewRoutes: PlaygroundPreviewRouteRegistry
  diagnostics(): PlaygroundPreviewProxyDiagnostics
  dispose(): Promise<void>
}

type PreviewProxyServer = ReturnType<typeof createHttpServer>

export class PlaygroundPreviewPortUnavailableError extends Error {
  readonly code = "wp-codebox-preview-port-in-use"

  constructor(readonly port: number, readonly cause: unknown) {
    super(`--preview-port ${port} is unavailable: EADDRINUSE. Choose another port or stop the process currently using it.`)
    this.name = "PlaygroundPreviewPortUnavailableError"
  }
}

export async function withPreviewProxy(server: PlaygroundCliServer, port: number, bind = "127.0.0.1"): Promise<PlaygroundCliServer> {
  let proxy: PlaygroundPreviewProxy | undefined
  try {
    proxy = await startPreviewProxy(server.serverUrl, port, bind)
  } catch (error) {
    await server[Symbol.asyncDispose]()
    throw error
  }

  return {
    ...server,
    serverUrl: proxy.serverUrl,
    wordpressUrl: server.wordpressUrl ?? server.serverUrl,
    previewRoutes: proxy.previewRoutes,
    get previewProxyDiagnostics() {
      return proxy?.diagnostics()
    },
    async [Symbol.asyncDispose]() {
      await proxy.dispose()
      await server[Symbol.asyncDispose]()
    },
  }
}

async function startPreviewProxy(targetUrl: string, port: number, bind: string): Promise<PlaygroundPreviewProxy> {
  const target = new URL(targetUrl)
  const routes = createPreviewRouteRegistry()
  const requestTrace = createPreviewProxyRequestTrace()
  const proxy = previewProxyServer(target, routes, requestTrace)
  const servers = [proxy]

  await listenPreviewProxy(proxy, port, bind)

  if (bind === "127.0.0.1") {
    const ipv6Proxy = previewProxyServer(target, routes, requestTrace)
    try {
      await listenPreviewProxy(ipv6Proxy, port, "::1")
      servers.push(ipv6Proxy)
    } catch (error) {
      if (!errorHasCode(error, "EADDRNOTAVAIL")) {
        await closePreviewProxyServers(servers)
        throw error
      }
    }
  }

  const address = proxy.address()
  const resolvedPort = address && typeof address === "object" ? address.port : port
  const reportedHost = bind === "0.0.0.0" ? "127.0.0.1" : bind

  return {
    serverUrl: `http://${formatPreviewHost(reportedHost)}:${resolvedPort}`,
    previewRoutes: routes,
    diagnostics() {
      return {
        schema: "wp-codebox/preview-proxy-diagnostics/v1",
        upstreamConcurrency: "serialized",
        maxConcurrentUpstreamRequests: 1,
        queue: "fifo",
        bind,
        targetOrigin: target.origin,
        requestTrace: snapshotPreviewProxyRequestTrace(requestTrace),
      }
    },
    async dispose() {
      await closePreviewProxyServers(servers)
    },
  }
}

function previewProxyServer(target: URL, routes: InternalPreviewRouteRegistry, requestTrace: PlaygroundPreviewProxyRequestTrace): PreviewProxyServer {
  const upstreamQueue = createPreviewProxyQueue()

  return createHttpServer(async (incoming, outgoing) => {
    try {
      if (await routes.handle(incoming, outgoing)) {
        return
      }
    } catch (error) {
      writeProxyError(outgoing, error instanceof Error ? error : new Error(String(error)))
      return
    }

    upstreamQueue(
      () => proxyPreviewRequest(target, incoming, outgoing, requestTrace),
      () => incoming.aborted || incoming.destroyed || outgoing.destroyed,
      (cancel) => {
        incoming.once("aborted", cancel)
        outgoing.once("close", cancel)
        return () => {
          incoming.off("aborted", cancel)
          outgoing.off("close", cancel)
        }
      },
    ).catch((error: Error) => writeProxyError(outgoing, error))
  })
}

interface InternalPreviewRouteRegistry extends PlaygroundPreviewRouteRegistry {
  handle(incoming: IncomingMessage, outgoing: ServerResponse): Promise<boolean>
}

function createPreviewRouteRegistry(): InternalPreviewRouteRegistry {
  const handlers = new Set<PlaygroundPreviewRouteHandler>()
  return {
    add(handler) {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
    async handle(incoming, outgoing) {
      for (const handler of handlers) {
        if (await handler(incoming, outgoing)) {
          return true
        }
      }
      return false
    },
  }
}

function proxyPreviewRequest(target: URL, incoming: IncomingMessage, outgoing: ServerResponse, requestTrace: PlaygroundPreviewProxyRequestTrace): Promise<void> {
  return new Promise((resolve) => {
    const requestTarget = previewProxyRequestTarget(incoming, target)
    let settled = false
    let clientCanceled = false
    let targetResponse: IncomingMessage | undefined
    const settle = () => {
      if (settled) {
        return
      }
      settled = true
      resolve()
    }
    const abortUpstream = () => {
      clientCanceled = true
      targetRequest.destroy()
      targetResponse?.destroy()
      settle()
    }

    const targetRequest = httpRequest(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        method: incoming.method,
        path: requestTarget.path,
        headers: proxyRequestHeaders(incoming.headers, requestTarget),
      },
      (response) => {
        targetResponse = response
        const headers = proxyResponseHeaders(response.headers, requestTarget, target)
        const responseOutcome: PlaygroundPreviewProxyRequestOutcome = {
          outcome: "response",
          status: response.statusCode ?? 502,
          upstreamLocation: headerValue(response.headers.location),
          visibleLocation: headerValue(headers.location),
        }
        let outcomeRecorded = false
        const recordOutcome = (outcome: PlaygroundPreviewProxyRequestOutcome) => {
          if (!outcomeRecorded) {
            outcomeRecorded = true
            recordPreviewProxyRequest(requestTrace, incoming, requestTarget.path, outcome)
          }
        }
        const bodyTransform = previewProxyResponseBodyTransform(headers, requestTarget, target)
        if (bodyTransform) {
          delete headers["content-length"]
          delete headers["content-md5"]
          delete headers.etag
        }
        outgoing.writeHead(response.statusCode ?? 502, response.statusMessage, headers)
        response.on("error", (error) => {
          recordOutcome({ ...responseOutcome, outcome: "upstream-error" })
          outgoing.destroy(error)
          settle()
        })
        response.on("end", () => {
          recordOutcome(responseOutcome)
          settle()
        })
        response.on("close", () => {
          if (!response.complete && !clientCanceled) {
            recordOutcome({ ...responseOutcome, outcome: "upstream-error" })
          }
          settle()
        })
        outgoing.on("finish", settle)
        outgoing.on("close", settle)
        if (bodyTransform) {
          bodyTransform.on("error", (error) => outgoing.destroy(error))
          response.pipe(bodyTransform).pipe(outgoing)
        } else {
          response.pipe(outgoing)
        }
      },
    )

    targetRequest.on("error", (error) => {
      if (!clientCanceled) {
        recordPreviewProxyRequest(requestTrace, incoming, requestTarget.path, { outcome: "upstream-error" })
      }
      writeProxyError(outgoing, error)
      settle()
    })
    incoming.on("aborted", abortUpstream)
    incoming.on("error", () => {
      abortUpstream()
    })
    outgoing.on("error", abortUpstream)
    outgoing.on("close", abortUpstream)
    incoming.pipe(targetRequest)
  })
}

interface PreviewProxyRequestTarget {
  upstreamHost: string
  visibleHost: string
  path: string
  port: string
  protocol: "http:" | "https:"
  rewriteTargetOrigin: boolean
}

function previewProxyRequestTarget(incoming: IncomingMessage, target: URL): PreviewProxyRequestTarget {
  const rawUrl = incoming.url ?? "/"
  try {
    const url = new URL(rawUrl)
    if (url.protocol === "http:" || url.protocol === "https:") {
      return {
        upstreamHost: url.host,
        visibleHost: url.host,
        path: `${url.pathname}${url.search}`,
        port: url.port || (url.protocol === "https:" ? "443" : "80"),
        protocol: url.protocol,
        rewriteTargetOrigin: false,
      }
    }
  } catch {
    // Origin-form requests use the proxy listener's HTTP authority.
  }
  const host = incoming.headers.host ?? "localhost"
  const authority = new URL(`http://${host}`)
  return { upstreamHost: target.host, visibleHost: authority.host, path: rawUrl, port: authority.port || "80", protocol: "http:", rewriteTargetOrigin: true }
}

function createPreviewProxyQueue(): (
  task: () => Promise<void>,
  isCanceled: () => boolean,
  observeCancellation: (cancel: () => void) => () => void,
) => Promise<void> {
  let active = false
  interface PendingRequest {
    task: () => Promise<void>
    isCanceled: () => boolean
    stopObservingCancellation: () => void
    resolve: () => void
    reject: (error: unknown) => void
  }
  const pending: PendingRequest[] = []

  function release(): void {
    let next = pending.shift()
    while (next) {
      next.stopObservingCancellation()
      if (!next.isCanceled()) {
        run(next)
        return
      }
      next.resolve()
      next = pending.shift()
    }
    active = false
  }

  function run(request: PendingRequest): void {
    request.stopObservingCancellation()
    if (request.isCanceled()) {
      request.resolve()
      release()
      return
    }
    let task: Promise<void>
    try {
      task = request.task()
    } catch (error) {
      request.reject(error)
      release()
      return
    }
    task.then(request.resolve, request.reject).finally(release)
  }

  return (task, isCanceled, observeCancellation) => new Promise<void>((resolve, reject) => {
    const request: PendingRequest = {
      task,
      isCanceled,
      stopObservingCancellation: () => {},
      resolve,
      reject,
    }
    const cancel = () => {
      const index = pending.indexOf(request)
      if (index === -1) {
        return
      }
      pending.splice(index, 1)
      request.stopObservingCancellation()
      resolve()
    }
    request.stopObservingCancellation = observeCancellation(cancel)

    if (active) {
      pending.push(request)
      return
    }

    active = true
    run(request)
  })
}

async function listenPreviewProxy(proxy: PreviewProxyServer, port: number, bind: string): Promise<void> {
  await new Promise<void>((resolveListen, rejectListen) => {
    proxy.once("error", rejectListen)
    proxy.listen(port, bind, () => resolveListen())
  })
}

async function closePreviewProxyServers(servers: PreviewProxyServer[]): Promise<void> {
  for (const proxy of servers) {
    if (!proxy.listening) {
      continue
    }

    await new Promise<void>((resolveClose, rejectClose) => {
      proxy.close((error) => error ? rejectClose(error) : resolveClose())
    })
  }
}

function formatPreviewHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host
}

function proxyRequestHeaders(headers: IncomingHttpHeaders, requestTarget: PreviewProxyRequestTarget): IncomingHttpHeaders {
  const forwarded = { ...headers }
  delete forwarded.connection
  delete forwarded["transfer-encoding"]
  delete forwarded.forwarded
  delete forwarded["x-forwarded-for"]
  delete forwarded["x-forwarded-host"]
  delete forwarded["x-forwarded-port"]
  delete forwarded["x-forwarded-proto"]
  if (requestTarget.rewriteTargetOrigin) {
    forwarded["accept-encoding"] = "identity"
  }

  return {
    ...forwarded,
    host: requestTarget.upstreamHost,
    "x-forwarded-host": requestTarget.visibleHost,
    "x-forwarded-port": requestTarget.port,
    "x-forwarded-proto": requestTarget.protocol.slice(0, -1),
  }
}

function proxyResponseHeaders(headers: IncomingHttpHeaders, requestTarget: PreviewProxyRequestTarget, target: URL): IncomingHttpHeaders {
  const forwarded = { ...headers }
  delete forwarded.connection
  delete forwarded["transfer-encoding"]

  if (typeof forwarded.location === "string") {
    try {
      const location = new URL(forwarded.location, target)
      if (location.origin === target.origin) {
        location.protocol = requestTarget.protocol
        const visible = new URL(`${requestTarget.protocol}//${requestTarget.visibleHost}`)
        location.hostname = visible.hostname
        location.port = visible.port
        forwarded.location = location.toString()
      }
    } catch {
      // Preserve malformed upstream locations for the browser to diagnose.
    }
  }

  return forwarded
}

function previewProxyResponseBodyTransform(headers: IncomingHttpHeaders, requestTarget: PreviewProxyRequestTarget, target: URL): Transform | undefined {
  if (!requestTarget.rewriteTargetOrigin || requestTarget.visibleHost === target.host || !previewProxyTextResponse(headers)) {
    return undefined
  }

  const contentEncoding = headerValue(headers["content-encoding"])
  if (contentEncoding && contentEncoding.toLowerCase() !== "identity") {
    return undefined
  }

  return originRewriteTransform(
    [target.origin, `${target.protocol}//${target.hostname}`],
    `${requestTarget.protocol}//${requestTarget.visibleHost}`,
  )
}

function previewProxyTextResponse(headers: IncomingHttpHeaders): boolean {
  const contentType = headerValue(headers["content-type"])
  return !!contentType && (/^text\//i.test(contentType) || /\b(?:html|css|javascript|json|xml|svg)\b/i.test(contentType))
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function originRewriteTransform(internalOrigins: string[], visibleOrigin: string): Transform {
  const searches = [...new Set(internalOrigins)]
    .filter((origin) => origin !== visibleOrigin)
    .map((origin) => Buffer.from(origin))
    .sort((left, right) => right.length - left.length)
  const replacement = Buffer.from(visibleOrigin)
  const overlap = Math.max(...searches.map((search) => search.length), 1)
  let pending = Buffer.alloc(0)

  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      pending = Buffer.concat([pending, chunk])
      let match = nextOriginMatch(pending, searches)
      while (match) {
        this.push(pending.subarray(0, match.index))
        this.push(replacement)
        pending = pending.subarray(match.index + match.search.length)
        match = nextOriginMatch(pending, searches)
      }

      const safeLength = Math.max(0, pending.length - overlap)
      if (safeLength > 0) {
        this.push(pending.subarray(0, safeLength))
        pending = pending.subarray(safeLength)
      }
      callback()
    },
    flush(callback) {
      let match = nextOriginMatch(pending, searches, true)
      while (match) {
        this.push(pending.subarray(0, match.index))
        this.push(replacement)
        pending = pending.subarray(match.index + match.search.length)
        match = nextOriginMatch(pending, searches, true)
      }
      this.push(pending)
      callback()
    },
  })
}

function nextOriginMatch(buffer: Buffer, searches: Buffer[], allowTerminal = false): { index: number; search: Buffer } | undefined {
  let match: { index: number; search: Buffer } | undefined
  for (const search of searches) {
    let index = buffer.indexOf(search)
    while (index !== -1) {
      const end = index + search.length
      const boundary = end < buffer.length ? String.fromCharCode(buffer[end]!) : undefined
      const completeOrigin = boundary ? /[\/?#\s'"<>)\]},;\\]/.test(boundary) : allowTerminal
      if (completeOrigin) {
        if (!match || index < match.index || (index === match.index && search.length > match.search.length)) {
          match = { index, search }
        }
        break
      }
      index = buffer.indexOf(search, index + 1)
    }
  }
  return match
}

function writeProxyError(outgoing: ServerResponse, error: Error): void {
  if (outgoing.headersSent) {
    outgoing.destroy(error)
    return
  }

  const body = Buffer.from(`Preview proxy failed: ${error.message}\n`, "utf8")
  outgoing.writeHead(502, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": String(body.byteLength),
  })
  outgoing.end(body)
}

export function errorHasCode(error: unknown, code: string): boolean {
  if (!error || typeof error !== "object") {
    return false
  }

  if ("code" in error && error.code === code) {
    return true
  }

  if ("cause" in error && errorHasCode(error.cause, code)) {
    return true
  }

  return error instanceof Error && error.message.includes(code)
}

export async function assertPreviewPortAvailable(port: number): Promise<void> {
  const server = createNetServer()
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen)
      server.listen(port, "127.0.0.1", () => resolveListen())
    })
  } catch (error) {
    if (errorHasCode(error, "EADDRINUSE")) {
      throw new PlaygroundPreviewPortUnavailableError(port, error)
    }

    throw error
  } finally {
    if (server.listening) {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose())
      })
    }
  }
}

export function readBridgeJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = ""
    request.on("data", (chunk) => {
      body += chunk.toString()
      if (body.length > 1024 * 1024) {
        reject(new Error("Request body too large"))
        request.destroy()
      }
    })
    request.on("end", () => {
      try {
        const parsed = body ? JSON.parse(body) : {}
        resolve(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {})
      } catch (error) {
        reject(error)
      }
    })
    request.on("error", reject)
  })
}

export function writeBridgeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" })
  response.end(`${JSON.stringify(payload)}\n`)
}

export function listenLocalHttpServer(server: ReturnType<typeof createHttpServer>): Promise<string> {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen)
      const address = server.address()
      if (!address || typeof address === "string") {
        rejectListen(new Error("Runtime WP-CLI bridge did not expose a TCP address"))
        return
      }
      resolveListen(`http://${address.address}:${address.port}`)
    })
  })
}

export function closeHttpServer(server: ReturnType<typeof createHttpServer>): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose())
  })
}
