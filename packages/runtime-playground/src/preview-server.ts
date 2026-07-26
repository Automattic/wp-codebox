import { createServer as createHttpServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http"
import { createServer as createNetServer } from "node:net"
import { StringDecoder } from "node:string_decoder"
import { Transform } from "node:stream"
import type { PreviewLease } from "@automattic/wp-codebox-core"

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
  requestWorkerEndpoint?: { route: string; token: string; payloadDirectory: string }
  previewLease?: PreviewLease
  previewRoutes?: PlaygroundPreviewRouteRegistry
  previewProxyDiagnostics?: PlaygroundPreviewProxyDiagnostics
  [Symbol.asyncDispose](): Promise<void>
}

export interface PlaygroundPreviewProxyDiagnostics {
  schema: "wp-codebox/preview-proxy-diagnostics/v1"
  upstreamConcurrency: "serialized"
  maxConcurrentUpstreamRequests: 1
  queue: "fifo"
  bind: string
  targetOrigin: string
}

export interface PlaygroundPreviewRouteRegistry {
  add(handler: PlaygroundPreviewRouteHandler): () => void
}

export type PlaygroundPreviewRouteHandler = (incoming: IncomingMessage, outgoing: ServerResponse) => Promise<boolean> | boolean

interface PlaygroundPreviewProxy {
  serverUrl: string
  previewRoutes: PlaygroundPreviewRouteRegistry
  diagnostics: PlaygroundPreviewProxyDiagnostics
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
    previewRoutes: proxy.previewRoutes,
    previewProxyDiagnostics: proxy.diagnostics,
    async [Symbol.asyncDispose]() {
      await proxy.dispose()
      await server[Symbol.asyncDispose]()
    },
  }
}

async function startPreviewProxy(targetUrl: string, port: number, bind: string): Promise<PlaygroundPreviewProxy> {
  const target = new URL(targetUrl)
  const routes = createPreviewRouteRegistry()
  let proxyOrigin: string | undefined
  const proxy = previewProxyServer(target, routes, () => proxyOrigin)
  const servers = [proxy]

  await listenPreviewProxy(proxy, port, bind)

  const address = proxy.address()
  const resolvedPort = address && typeof address === "object" ? address.port : port
  const reportedHost = bind === "0.0.0.0" ? "127.0.0.1" : bind
  proxyOrigin = `http://${formatPreviewHost(reportedHost)}:${resolvedPort}`

  if (bind === "127.0.0.1") {
    const ipv6Proxy = previewProxyServer(target, routes, () => `http://[::1]:${resolvedPort}`)
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

  return {
    serverUrl: proxyOrigin,
    previewRoutes: routes,
    diagnostics: {
      schema: "wp-codebox/preview-proxy-diagnostics/v1",
      upstreamConcurrency: "serialized",
      maxConcurrentUpstreamRequests: 1,
      queue: "fifo",
      bind,
      targetOrigin: target.origin,
    },
    async dispose() {
      await closePreviewProxyServers(servers)
    },
  }
}

function previewProxyServer(target: URL, routes: InternalPreviewRouteRegistry, proxyOrigin: () => string | undefined): PreviewProxyServer {
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

    upstreamQueue(() => proxyPreviewRequest(target, proxyOrigin(), incoming, outgoing)).catch((error: Error) => writeProxyError(outgoing, error))
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

function proxyPreviewRequest(target: URL, proxyOrigin: string | undefined, incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    let targetResponse: IncomingMessage | undefined
    const settle = () => {
      if (settled) {
        return
      }
      settled = true
      resolve()
    }
    const abortUpstream = () => {
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
        path: incoming.url ?? "/",
        headers: proxyRequestHeaders(incoming.headers),
      },
      (response) => {
        targetResponse = response
        if (proxyOrigin && shouldRewriteProxyResponse(response.headers)) {
          const headers = proxyResponseHeaders(response.headers, target.origin, proxyOrigin)
          delete headers["content-length"]
          delete headers.etag
          outgoing.writeHead(response.statusCode ?? 502, response.statusMessage, headers)
          const rewrite = previewOriginRewriteStream(target.origin, proxyOrigin)
          response.on("error", (error) => {
            outgoing.destroy(error)
            settle()
          })
          rewrite.on("error", (error) => {
            outgoing.destroy(error)
            settle()
          })
          outgoing.on("finish", settle)
          outgoing.on("close", settle)
          response.pipe(rewrite).pipe(outgoing)
          return
        }

        outgoing.writeHead(response.statusCode ?? 502, response.statusMessage, proxyResponseHeaders(response.headers, target.origin, proxyOrigin))
        response.on("error", (error) => {
          outgoing.destroy(error)
          settle()
        })
        outgoing.on("finish", settle)
        outgoing.on("close", settle)
        response.pipe(outgoing)
      },
    )

    targetRequest.on("error", (error) => {
      writeProxyError(outgoing, error)
      settle()
    })
    incoming.on("error", () => {
      abortUpstream()
    })
    outgoing.on("error", abortUpstream)
    outgoing.on("close", abortUpstream)
    incoming.pipe(targetRequest)
  })
}

function shouldRewriteProxyResponse(headers: IncomingHttpHeaders): boolean {
  const contentType = String(headers["content-type"] ?? "").toLowerCase()
  const contentEncoding = String(headers["content-encoding"] ?? "identity").toLowerCase()
  return (contentEncoding === "" || contentEncoding === "identity")
    && (contentType.startsWith("text/") || /(?:^|\/)(?:[^;]+\+)?(?:json|javascript|xml)(?:;|$)/.test(contentType))
}

function rewritePreviewOrigin(body: string, targetOrigin: string, proxyOrigin: string): string {
  return body
    .replaceAll(targetOrigin, proxyOrigin)
    .replaceAll(targetOrigin.replaceAll("/", "\\/"), proxyOrigin.replaceAll("/", "\\/"))
}

function previewOriginRewriteStream(targetOrigin: string, proxyOrigin: string): Transform {
  const decoder = new StringDecoder("utf8")
  const patterns = [targetOrigin, targetOrigin.replaceAll("/", "\\/")]
  const retainedCharacters = Math.max(...patterns.map((pattern) => pattern.length)) - 1
  let pending = ""

  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const text = pending + decoder.write(chunk)
      let splitAt = Math.max(0, text.length - retainedCharacters)
      for (const pattern of patterns) {
        for (let index = Math.max(0, splitAt - pattern.length + 1); index < splitAt; index += 1) {
          if (pattern.startsWith(text.slice(index, splitAt))) splitAt = index
        }
      }
      pending = text.slice(splitAt)
      callback(null, rewritePreviewOrigin(text.slice(0, splitAt), targetOrigin, proxyOrigin))
    },
    flush(callback) {
      callback(null, rewritePreviewOrigin(pending + decoder.end(), targetOrigin, proxyOrigin))
    },
  })
}

function createPreviewProxyQueue(): (task: () => Promise<void>) => Promise<void> {
  let active = false
  const pending: Array<() => void> = []

  const acquire = async () => {
    if (!active) {
      active = true
      return
    }

    await new Promise<void>((resolve) => pending.push(resolve))
  }

  const release = () => {
    const next = pending.shift()
    if (next) {
      next()
      return
    }

    active = false
  }

  return async (task) => {
    await acquire()
    try {
      await task()
    } finally {
      release()
    }
  }
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

function proxyRequestHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const forwarded = { ...headers }
  delete forwarded.connection
  delete forwarded["transfer-encoding"]

  return {
    ...forwarded,
  }
}

function proxyResponseHeaders(headers: IncomingHttpHeaders, targetOrigin?: string, proxyOrigin?: string): IncomingHttpHeaders {
  const forwarded = { ...headers }
  delete forwarded.connection
  delete forwarded["transfer-encoding"]

  if (targetOrigin && proxyOrigin) {
    for (const [name, value] of Object.entries(forwarded)) {
      if (typeof value === "string") forwarded[name] = rewritePreviewOrigin(value, targetOrigin, proxyOrigin)
      else if (Array.isArray(value)) forwarded[name] = value.map((item) => rewritePreviewOrigin(item, targetOrigin, proxyOrigin))
    }
  }

  return forwarded
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
