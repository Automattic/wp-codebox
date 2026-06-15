import { randomBytes } from "node:crypto"
import { createServer as createHttpServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http"
import { createServer as createNetServer } from "node:net"
import { bootstrapPhpCode } from "./php-bootstrap.js"
import { assertPlaygroundResponseOk } from "./playground-command-errors.js"
import { parseWordPressAdminAuthCookies, wordpressAdminAuthCookiePhpCode, type WordPressAdminAuthCookie } from "./wordpress-admin-auth.js"
import type { ArtifactPreviewReviewerAuth, RuntimeCreateSpec } from "@automattic/wp-codebox-core"

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
  createReviewerAuthBootstrap?(options: ReviewerAuthBootstrapOptions): Promise<ArtifactPreviewReviewerAuth>
  [Symbol.asyncDispose](): Promise<void>
}

export interface ReviewerAuthBootstrapOptions {
  runtimeId: string
  targetPath: string
  expiresAt: string
  holdSeconds: number
  userId: number
}

interface PlaygroundPreviewProxy {
  serverUrl: string
  createReviewerAuthBootstrap?: PlaygroundCliServer["createReviewerAuthBootstrap"]
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

export async function withPreviewProxy(server: PlaygroundCliServer, port: number, bind = "127.0.0.1", runtimeSpec?: RuntimeCreateSpec): Promise<PlaygroundCliServer> {
  let proxy: PlaygroundPreviewProxy | undefined
  try {
    proxy = await startPreviewProxy(server, port, bind, runtimeSpec)
  } catch (error) {
    await server[Symbol.asyncDispose]()
    throw error
  }

  return {
    ...server,
    serverUrl: proxy.serverUrl,
    ...(proxy.createReviewerAuthBootstrap ? { createReviewerAuthBootstrap: proxy.createReviewerAuthBootstrap } : {}),
    async [Symbol.asyncDispose]() {
      await proxy.dispose()
      await server[Symbol.asyncDispose]()
    },
  }
}

async function startPreviewProxy(server: PlaygroundCliServer, port: number, bind: string, runtimeSpec: RuntimeCreateSpec | undefined): Promise<PlaygroundPreviewProxy> {
  const target = new URL(server.serverUrl)
  const reviewerAuth = runtimeSpec ? createReviewerAuthBootstrapStore(server, runtimeSpec) : undefined
  const proxy = previewProxyServer(target, reviewerAuth)
  const servers = [proxy]

  await listenPreviewProxy(proxy, port, bind)

  if (bind === "127.0.0.1") {
    const ipv6Proxy = previewProxyServer(target, reviewerAuth)
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
    ...(reviewerAuth ? { createReviewerAuthBootstrap: (options) => reviewerAuth.createBootstrap(`http://${formatPreviewHost(reportedHost)}:${resolvedPort}`, options) } : {}),
    async dispose() {
      await closePreviewProxyServers(servers)
    },
  }
}

function previewProxyServer(target: URL, reviewerAuth?: ReviewerAuthBootstrapStore): PreviewProxyServer {
  const upstreamQueue = createPreviewProxyQueue()

  return createHttpServer((incoming, outgoing) => {
    if (reviewerAuth?.canHandle(incoming)) {
      reviewerAuth.handle(incoming, outgoing).catch((error: Error) => writeProxyError(outgoing, error))
      return
    }

    upstreamQueue(() => proxyPreviewRequest(target, incoming, outgoing)).catch((error: Error) => writeProxyError(outgoing, error))
  })
}

interface ReviewerAuthBootstrapEntry extends ReviewerAuthBootstrapOptions {
  token: string
  origin: string
}

interface ReviewerAuthBootstrapStore {
  canHandle(incoming: IncomingMessage): boolean
  createBootstrap(origin: string, options: ReviewerAuthBootstrapOptions): Promise<ArtifactPreviewReviewerAuth>
  handle(incoming: IncomingMessage, outgoing: ServerResponse): Promise<void>
}

function createReviewerAuthBootstrapStore(server: PlaygroundCliServer, runtimeSpec: RuntimeCreateSpec): ReviewerAuthBootstrapStore {
  const entries = new Map<string, ReviewerAuthBootstrapEntry>()
  const bootstrapPath = "/_wp-codebox/reviewer-auth/bootstrap"

  return {
    canHandle(incoming) {
      return requestPath(incoming) === bootstrapPath
    },
    async createBootstrap(origin, options) {
      const token = randomBytes(24).toString("base64url")
      entries.set(token, { ...options, token, origin })
      const url = new URL(bootstrapPath, origin)
      url.searchParams.set("token", token)
      return {
        schema: "wp-codebox/preview-reviewer-auth/v1",
        kind: "reviewer-auth-bootstrap",
        auth: "wordpress-admin",
        reviewerSafe: true,
        url: url.toString(),
        targetPath: options.targetPath,
        expiresAt: options.expiresAt,
        holdSeconds: options.holdSeconds,
        userId: options.userId,
        scope: {
          runtimeId: options.runtimeId,
          origin,
        },
      }
    },
    async handle(incoming, outgoing) {
      if (incoming.method && incoming.method !== "GET" && incoming.method !== "HEAD") {
        writeText(outgoing, 405, "Reviewer auth bootstrap only supports GET.\n")
        return
      }
      const token = requestUrl(incoming)?.searchParams.get("token") ?? ""
      const entry = entries.get(token)
      if (!entry || Date.now() >= Date.parse(entry.expiresAt)) {
        writeText(outgoing, 410, "Reviewer auth bootstrap is expired or unavailable.\n")
        return
      }

      const response = await server.playground.run({ code: bootstrapPhpCode(runtimeSpec, wordpressAdminAuthCookiePhpCode([entry.origin], entry.userId), []) })
      assertPlaygroundResponseOk("preview.reviewer-auth-bootstrap", response)
      const cookies = parseWordPressAdminAuthCookies(response.text)
      outgoing.writeHead(302, {
        "cache-control": "no-store",
        "location": entry.targetPath,
        "set-cookie": cookies.map(cookieToSetCookieHeader).filter((cookie): cookie is string => Boolean(cookie)),
      })
      outgoing.end()
    },
  }
}

function cookieToSetCookieHeader(cookie: WordPressAdminAuthCookie): string | undefined {
  const name = String(cookie.name ?? "")
  const value = String(cookie.value ?? "")
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || !value) {
    return undefined
  }

  const parts = [`${name}=${value}`]
  parts.push(`Path=${typeof cookie.path === "string" && cookie.path.length > 0 ? cookie.path : "/"}`)
  if (typeof cookie.expires === "number") {
    parts.push(`Expires=${new Date(cookie.expires * 1000).toUTCString()}`)
  }
  if (cookie.httpOnly !== false) {
    parts.push("HttpOnly")
  }
  if (cookie.secure === true) {
    parts.push("Secure")
  }
  parts.push(`SameSite=${cookie.sameSite ?? "Lax"}`)
  return parts.join("; ")
}

function requestPath(incoming: IncomingMessage): string | undefined {
  return requestUrl(incoming)?.pathname
}

function requestUrl(incoming: IncomingMessage): URL | undefined {
  try {
    return new URL(incoming.url ?? "/", "http://127.0.0.1")
  } catch {
    return undefined
  }
}

function writeText(outgoing: ServerResponse, statusCode: number, body: string): void {
  const buffer = Buffer.from(body, "utf8")
  outgoing.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": "text/plain; charset=utf-8",
    "content-length": String(buffer.byteLength),
  })
  outgoing.end(buffer)
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
