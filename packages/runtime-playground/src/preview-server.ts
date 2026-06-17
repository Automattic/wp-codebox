import { createServer as createHttpServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http"
import { createServer as createNetServer } from "node:net"

export interface PlaygroundServerRunResponse {
  exitCode?: number
  errors?: string
  text: string
}

export interface PlaygroundCliServer {
  playground: {
    run(options: { code: string } | { scriptPath: string }): Promise<PlaygroundServerRunResponse>
    onMessage?(listener: (data: string) => Promise<string | void> | string | void): Promise<(() => Promise<void> | void) | void> | (() => Promise<void> | void) | void
    readFileAsText?(path: string): string | Promise<string>
    writeFile?(path: string, contents: string): Promise<void>
  }
  serverUrl: string
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
  const proxy = previewProxyServer(target, routes)
  const servers = [proxy]

  await listenPreviewProxy(proxy, port, bind)

  if (bind === "127.0.0.1") {
    const ipv6Proxy = previewProxyServer(target, routes)
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

function previewProxyServer(target: URL, routes: InternalPreviewRouteRegistry): PreviewProxyServer {
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

    upstreamQueue(() => proxyPreviewRequest(target, incoming, outgoing)).catch((error: Error) => writeProxyError(outgoing, error))
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

function proxyPreviewRequest(target: URL, incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const settle = () => {
      if (settled) {
        return
      }
      settled = true
      resolve()
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
      (targetResponse) => {
        outgoing.writeHead(targetResponse.statusCode ?? 502, targetResponse.statusMessage, proxyResponseHeaders(targetResponse.headers))
        targetResponse.on("error", (error) => {
          outgoing.destroy(error)
          settle()
        })
        outgoing.on("finish", settle)
        outgoing.on("close", settle)
        targetResponse.pipe(outgoing)
      },
    )

    targetRequest.on("error", (error) => {
      writeProxyError(outgoing, error)
      settle()
    })
    incoming.on("error", () => {
      targetRequest.destroy()
      settle()
    })
    incoming.pipe(targetRequest)
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

function proxyResponseHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const forwarded = { ...headers }
  delete forwarded.connection
  delete forwarded["transfer-encoding"]

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
