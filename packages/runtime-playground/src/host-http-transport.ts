import { randomBytes, timingSafeEqual } from "node:crypto"
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http"
import { request as httpsRequest } from "node:https"
import { BlockList, isIP } from "node:net"
import { lookup } from "node:dns/promises"
import type { PlaygroundCliServer } from "./preview-server.js"

export const HOST_HTTP_TRANSPORT_SCHEMA = "wp-codebox/host-http-transport-request/v1"
export const HOST_HTTP_TRANSPORT_MAX_MESSAGE_BYTES = 64 * 1024
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024
const MAX_TIMEOUT_MS = 60_000
const MAX_HEADER_BYTES = 64 * 1024

export type HostHttpTransportMessage = {
  schema: typeof HOST_HTTP_TRANSPORT_SCHEMA
  id: string
  method: "GET"
  url: string
  ips: string[]
  timeoutMs: number
  maxBytes: number
}

export type HostHttpTransportResult = {
  schema: "wp-codebox/host-http-transport-response/v1"
  id: string
  success: boolean
  response?: { statusCode: number; headers: Record<string, string[]>; bodyBase64: string; ip: string }
  error?: { code: string; message: string }
}

export type HostHttpNetworkPolicy = "allow" | "deny" | { allowHosts: string[] }
type PinnedRequester = (url: URL, ip: string, maxBytes: number, signal: AbortSignal) => Promise<{ statusCode: number; headers: Record<string, string[]>; bodyBase64: string }>
type HostResolver = (host: string) => Promise<string[]>
type HostHttpTransportDependencies = { requester?: PinnedRequester; resolveHost?: HostResolver; signal?: AbortSignal }

export function installHostHttpTransportRoute(server: PlaygroundCliServer, networkPolicy: HostHttpNetworkPolicy): { url: string; token: string } | undefined {
  if (!server.previewRoutes) return undefined
  const route = `/__wp-codebox/host-http-transport-${randomBytes(12).toString("hex")}`
  const token = randomBytes(32).toString("base64url")
  server.previewRoutes.add(async (incoming, outgoing) => {
    const requestUrl = new URL(incoming.url ?? "/", server.serverUrl)
    if (requestUrl.pathname !== route) return false
    if (incoming.method !== "POST" || !validBearerToken(incoming.headers.authorization, token)) {
      writeJson(outgoing, 404, { error: "Not found." })
      return true
    }
    let body: string
    try {
      body = await readBoundedBody(incoming)
    } catch (error) {
      writeJson(outgoing, 400, { error: error instanceof Error ? error.message : "Invalid request." })
      return true
    }
    const message = parseHostHttpTransportMessage(body)
    if (!message) {
      writeJson(outgoing, 400, hostHttpError("", "invalid_request", "The host HTTP request is invalid or contains a non-public target."))
      return true
    }
    const controller = new AbortController()
    const abort = () => controller.abort(new Error("The host HTTP bridge client disconnected."))
    incoming.once("aborted", abort)
    outgoing.once("close", abort)
    try {
      writeJson(outgoing, 200, await executeHostHttpTransportRequest(message, networkPolicy, { signal: controller.signal }))
    } finally {
      incoming.off("aborted", abort)
      outgoing.off("close", abort)
    }
    return true
  })
  return { url: new URL(route, server.serverUrl).toString(), token }
}

const privateAddresses = new BlockList()
for (const [network, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) privateAddresses.addSubnet(network, prefix, "ipv4")
for (const [network, prefix] of [["::", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8]] as const) privateAddresses.addSubnet(network, prefix, "ipv6")

export function parseHostHttpTransportMessage(data: string): HostHttpTransportMessage | undefined {
  if (Buffer.byteLength(data) > HOST_HTTP_TRANSPORT_MAX_MESSAGE_BYTES) return undefined
  let value: unknown
  try {
    value = JSON.parse(data)
  } catch {
    return undefined
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const message = value as Partial<HostHttpTransportMessage>
  if (message.schema !== HOST_HTTP_TRANSPORT_SCHEMA || message.method !== "GET" || typeof message.id !== "string" || message.id.length < 1 || message.id.length > 128 || typeof message.url !== "string" || !Array.isArray(message.ips) || message.ips.length < 1 || message.ips.length > 16 || !Number.isInteger(message.timeoutMs) || !Number.isInteger(message.maxBytes)) return undefined
  if (message.timeoutMs! < 1 || message.timeoutMs! > MAX_TIMEOUT_MS || message.maxBytes! < 1 || message.maxBytes! > MAX_RESPONSE_BYTES || message.ips.some((ip) => typeof ip !== "string" || !isPublicIp(ip))) return undefined
  try {
    const url = new URL(message.url)
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || !url.hostname) return undefined
  } catch {
    return undefined
  }
  return message as HostHttpTransportMessage
}

export async function executeHostHttpTransportRequest(message: HostHttpTransportMessage, networkPolicy: HostHttpNetworkPolicy, dependencies: HostHttpTransportDependencies = {}): Promise<HostHttpTransportResult> {
	if (!validHostHttpTransportMessage(message)) return hostHttpError(message.id, "invalid_request", "The host HTTP request is invalid or contains a non-public target.")
	const url = new URL(message.url)
	if (!networkPolicyAllows(networkPolicy, url)) return hostHttpError(message.id, "network_denied", "Runtime network policy does not allow the host HTTP target.")
	const deadline = Date.now() + message.timeoutMs
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(new Error("The host HTTP request deadline was exhausted.")), message.timeoutMs)
	const abort = () => controller.abort(dependencies.signal?.reason)
	if (dependencies.signal?.aborted) abort()
	else dependencies.signal?.addEventListener("abort", abort, { once: true })
	const requester = dependencies.requester ?? requestPinnedIp
	let requestIps = message.ips
	let lastError: Error | undefined
	try {
		if (typeof networkPolicy === "object") {
			const resolveHost = dependencies.resolveHost ?? resolvePublicHost
			let resolved: string[]
			try {
				resolved = await abortable(resolveHost(url.hostname), controller.signal)
			} catch {
				return hostHttpError(message.id, controller.signal.aborted ? "deadline_exhausted" : "host_resolution_failed", controller.signal.aborted ? "The host HTTP request deadline was exhausted." : "The allowed host could not be resolved by the host transport.")
			}
			requestIps = message.ips.filter((ip) => resolved.some((candidate) => sameIp(ip, candidate)))
			if (requestIps.length === 0) return hostHttpError(message.id, "target_ip_mismatch", "The supplied target addresses do not match host-side resolution for the allowed host.")
		}
		for (const ip of requestIps) {
			if (controller.signal.aborted || Date.now() >= deadline) return hostHttpError(message.id, "deadline_exhausted", "The host HTTP request deadline was exhausted.")
			try {
				const response = await requester(url, ip, message.maxBytes, controller.signal)
				return { schema: "wp-codebox/host-http-transport-response/v1", id: message.id, success: true, response: { ...response, ip } }
			} catch (error) {
				lastError = error instanceof Error ? error : new Error("Host HTTP request failed.")
				if (controller.signal.aborted) return hostHttpError(message.id, "deadline_exhausted", "The host HTTP request deadline was exhausted.")
				if ((lastError as NodeJS.ErrnoException).code === "WP_CODEBOX_HOST_HTTP_TOO_LARGE") return hostHttpError(message.id, "response_too_large", lastError.message)
			}
		}
	} finally {
		clearTimeout(timer)
		dependencies.signal?.removeEventListener("abort", abort)
	}
	return hostHttpError(message.id, "connect_failed", lastError?.message ?? "Could not connect to the validated public target.")
}

async function resolvePublicHost(host: string): Promise<string[]> {
	return (await lookup(host, { all: true, verbatim: true })).map(({ address }) => address).filter(isPublicIp)
}

function sameIp(left: string, right: string): boolean {
	const family = isIP(left)
	if (family === 0 || family !== isIP(right)) return false
	const addresses = new BlockList()
	addresses.addAddress(right, family === 4 ? "ipv4" : "ipv6")
	return addresses.check(left, family === 4 ? "ipv4" : "ipv6")
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason)
	return new Promise((resolve, reject) => {
		const abort = () => reject(signal.reason)
		signal.addEventListener("abort", abort, { once: true })
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
	})
}

function requestPinnedIp(url: URL, ip: string, maxBytes: number, signal: AbortSignal): Promise<{ statusCode: number; headers: Record<string, string[]>; bodyBase64: string }> {
	return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: "GET",
      headers: { Host: url.host, "User-Agent": "WP-Codebox-Host-HTTP/1.0", Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1", Connection: "close" },
		lookup: (_hostname, options, callback) => {
			const family = isIP(ip) as 4 | 6
			const done = callback as unknown as (...args: unknown[]) => void
			if (typeof options === "object" && options.all) done(null, [{ address: ip, family }])
			else done(null, ip, family)
		},
      maxHeaderSize: MAX_HEADER_BYTES,
      servername: url.protocol === "https:" ? url.hostname : undefined,
		}, (response) => {
      const chunks: Buffer[] = []
      let bytes = 0
      response.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        bytes += buffer.length
		if (bytes > maxBytes) {
			const error = new Error("The host HTTP response exceeded the maximum allowed size.") as NodeJS.ErrnoException
			error.code = "WP_CODEBOX_HOST_HTTP_TOO_LARGE"
			request.destroy(error)
          return
        }
        chunks.push(buffer)
      })
      response.on("end", () => resolve({ statusCode: response.statusCode ?? 0, headers: normalizeHeaders(response.headers), bodyBase64: Buffer.concat(chunks).toString("base64") }))
      response.on("error", reject)
		})
		const abort = () => request.destroy(signal.reason instanceof Error ? signal.reason : new Error("The host HTTP request was aborted."))
		if (signal.aborted) abort()
		else signal.addEventListener("abort", abort, { once: true })
		request.on("error", reject)
		request.on("close", () => signal.removeEventListener("abort", abort))
		request.end()
	})
}

function normalizeHeaders(headers: IncomingHttpHeaders): Record<string, string[]> {
  const normalized: Record<string, string[]> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    normalized[name.toLowerCase()] = Array.isArray(value) ? value.map(String) : [String(value)]
  }
  return normalized
}

function isPublicIp(ip: string): boolean {
	const family = isIP(ip)
	return family === 4 ? !privateAddresses.check(ip, "ipv4") : family === 6 ? !privateAddresses.check(ip, "ipv6") : false
}

function validHostHttpTransportMessage(message: HostHttpTransportMessage): boolean {
	return parseHostHttpTransportMessage(JSON.stringify(message)) !== undefined
}

function networkPolicyAllows(policy: HostHttpNetworkPolicy, url: URL): boolean {
	if (policy === "deny") return false
	if (policy === "allow") return true
	const host = url.hostname.toLowerCase()
	const port = url.port || (url.protocol === "https:" ? "443" : "80")
	return policy.allowHosts.some((candidate) => {
		const normalized = candidate.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "")
		return normalized === host || normalized === `${host}:${port}`
	})
}

function hostHttpError(id: string, code: string, message: string): HostHttpTransportResult {
  return { schema: "wp-codebox/host-http-transport-response/v1", id, success: false, error: { code, message } }
}

function validBearerToken(authorization: string | undefined, token: string): boolean {
  const supplied = authorization?.startsWith("Bearer ") ? authorization.slice(7) : ""
  const left = Buffer.from(supplied)
  const right = Buffer.from(token)
  return left.length === right.length && timingSafeEqual(left, right)
}

function readBoundedBody(incoming: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    incoming.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.length
      if (bytes > HOST_HTTP_TRANSPORT_MAX_MESSAGE_BYTES) {
        reject(new Error("The host HTTP bridge request is too large."))
        incoming.destroy()
        return
      }
      chunks.push(buffer)
    })
    incoming.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    incoming.on("error", reject)
  })
}

function writeJson(outgoing: ServerResponse, statusCode: number, payload: unknown): void {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`)
  outgoing.writeHead(statusCode, { "content-type": "application/json", "content-length": String(body.length), "cache-control": "no-store" })
  outgoing.end(body)
}
