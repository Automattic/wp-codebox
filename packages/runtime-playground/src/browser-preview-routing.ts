import type { RuntimeCreateSpec } from "@automattic/wp-codebox-core"
import type { BrowserProbeNetworkPolicySummary, BrowserProbePreviewMode, BrowserProbePreviewRouting } from "./browser-artifacts.js"
import { argValue, commaListArg, strictBooleanArg } from "./commands.js"
import type { Page, Route } from "playwright"

const BROWSER_PREVIEW_ROUTE_DRAIN_TIMEOUT_MS = 5_000

export interface BrowserPreviewNetworkPolicy {
  mode: "allow" | "block" | "record"
  allowHosts: Set<string>
  blockHosts: Set<string>
  routeHosts: Set<string>
  firstPartyHosts: Set<string>
  recordExternal: boolean
  stats: Map<string, { requests: number; external: boolean; blocked: number; routed: number }>
}

export interface BrowserPreviewTopology {
  preview: BrowserProbePreviewRouting
  networkPolicy: BrowserPreviewNetworkPolicy
  routedHosts: string[]
  origins: { localPreviewOrigin: string; requestedPreviewOrigin?: string; effectivePreviewOrigin: string }
  resolveUrl(pathOrUrl: string): string
  authCookieUrls(targetUrls: string[]): string[]
}

export interface BrowserPreviewRouteTracker {
  pending: Set<Promise<void>>
  errors: unknown[]
}

export function createBrowserPreviewRouteTracker(): BrowserPreviewRouteTracker {
  return { pending: new Set(), errors: [] }
}

export function browserPreviewRouting(args: string[], runtimeSpec: RuntimeCreateSpec | undefined, localPreviewOrigin: string): BrowserProbePreviewRouting {
  const publicOrigin = runtimeSpec?.preview?.publicUrl
  const requestedMode = browserPreviewMode(args, publicOrigin)
  const effectiveMode: BrowserProbePreviewMode = requestedMode === "local" || !publicOrigin ? "local" : requestedMode
  const effectiveOrigin = effectiveMode === "local" ? localPreviewOrigin : (publicOrigin ?? localPreviewOrigin)
  const diagnostics: BrowserProbePreviewRouting["diagnostics"] = []

  if ((requestedMode === "public" || requestedMode === "secure") && !publicOrigin) {
    diagnostics.push({
      code: "preview-public-origin-missing",
      severity: "error",
      message: `wordpress.browser-probe preview-mode=${requestedMode} requires runtime.preview.publicUrl or --preview-public-url`,
      details: { requestedMode, localOrigin: localPreviewOrigin },
    })
  }

  if (requestedMode === "secure" && publicOrigin) {
    const protocol = urlProtocol(publicOrigin)
    if (protocol !== "https:") {
      diagnostics.push({
        code: "preview-public-origin-not-https",
        severity: "error",
        message: "wordpress.browser-probe preview-mode=secure requires an HTTPS public preview origin",
        details: { publicOrigin, protocol },
      })
    }
  }

  return {
    requestedMode,
    effectiveMode,
    localOrigin: localPreviewOrigin,
    effectiveOrigin,
    ...(publicOrigin ? { publicOrigin } : {}),
    diagnostics,
  }
}

export function browserPreviewTopology(args: string[], runtimeSpec: RuntimeCreateSpec | undefined, localPreviewOrigin: string): BrowserPreviewTopology {
  const preview = browserPreviewRouting(args, runtimeSpec, localPreviewOrigin)
  const routedHosts = commaListArg(args, "route-host")
  const networkPolicy = browserPreviewNetworkPolicy(args, routedHosts, preview)

  return {
    preview,
    networkPolicy,
    routedHosts,
    origins: browserPreviewOrigins(preview),
    resolveUrl(pathOrUrl) {
      return resolveBrowserPreviewUrl(pathOrUrl, preview.effectiveOrigin)
    },
    authCookieUrls(targetUrls) {
      return browserPreviewAuthCookieUrls(localPreviewOrigin, routedHosts, targetUrls)
    },
  }
}

export function browserPreviewOrigins(preview: BrowserProbePreviewRouting): { localPreviewOrigin: string; requestedPreviewOrigin?: string; effectivePreviewOrigin: string } {
  return {
    localPreviewOrigin: preview.localOrigin,
    requestedPreviewOrigin: preview.publicOrigin,
    effectivePreviewOrigin: preview.effectiveOrigin,
  }
}

export function browserPreviewReadinessError(preview: BrowserProbePreviewRouting): Error | undefined {
  const diagnostic = preview.diagnostics.find((item) => item.severity === "error")
  if (!diagnostic) {
    return undefined
  }

  return new Error(diagnostic.message)
}

export function browserPreviewSecureContextError(preview: BrowserProbePreviewRouting): Error | undefined {
  if (preview.requestedMode !== "secure" || preview.secureContext !== false) {
    return undefined
  }

  const diagnostic = {
    code: "preview-secure-context-unavailable",
    severity: "error" as const,
    message: "wordpress.browser-probe preview-mode=secure reached the preview, but the page did not report a secure browser context",
    details: { effectiveOrigin: preview.effectiveOrigin, secureContext: preview.secureContext },
  }
  preview.diagnostics.push(diagnostic)
  return new Error(diagnostic.message)
}

export function resolveBrowserPreviewUrl(pathOrUrl: string, baseUrl: string): string {
  try {
    return new URL(pathOrUrl).toString()
  } catch {
    return new URL(pathOrUrl, baseUrl).toString()
  }
}

export function browserPreviewAuthCookieUrls(localPreviewOrigin: string, routedHosts: string[], targetUrls: string[]): string[] {
  const urls = [localPreviewOrigin]
  for (const host of routedHosts.map(normalizeBrowserPreviewHost).filter(Boolean)) {
    const matchingTarget = targetUrls.find((targetUrl) => normalizeBrowserPreviewHost(browserPreviewUrlHostname(targetUrl) ?? "") === host)
    const protocol = matchingTarget ? new URL(matchingTarget).protocol : browserPreviewAuthCookieProtocol(targetUrls)
    urls.push(`${protocol}//${host}/`)
  }
  return uniqueBrowserPreviewAuthCookieUrls(urls)
}

export function browserPreviewNetworkPolicy(args: string[], routeHosts: string[], preview: BrowserProbePreviewRouting): BrowserPreviewNetworkPolicy {
  const mode = browserPreviewNetworkPolicyMode(args)
  const allowHosts = new Set(commaListArg(args, "allow-host").map(normalizeBrowserPreviewHost).filter(Boolean))
  const blockHosts = new Set(commaListArg(args, "block-host").map(normalizeBrowserPreviewHost).filter(Boolean))
  const routedHosts = new Set(routeHosts.map(normalizeBrowserPreviewHost).filter(Boolean))
  const firstPartyHosts = new Set<string>()
  for (const origin of [preview.localOrigin, preview.effectiveOrigin, preview.publicOrigin]) {
    const host = origin ? browserPreviewUrlHostname(origin) : undefined
    if (host) {
      firstPartyHosts.add(host)
    }
  }

  return {
    mode,
    allowHosts,
    blockHosts,
    routeHosts: routedHosts,
    firstPartyHosts,
    recordExternal: strictBooleanArg(args, "record-external", false),
    stats: new Map(),
  }
}

export function browserPreviewNetworkPolicyIsActive(policy: BrowserPreviewNetworkPolicy): boolean {
  return policy.mode !== "record" || policy.allowHosts.size > 0 || policy.blockHosts.size > 0 || policy.routeHosts.size > 0 || policy.recordExternal
}

export function browserPreviewNeedsContextRouting(policy: BrowserPreviewNetworkPolicy): boolean {
  return policy.mode === "block" || policy.blockHosts.size > 0 || policy.routeHosts.size > 0 || policy.recordExternal
}

export function browserPreviewNetworkPolicySummary(policy: BrowserPreviewNetworkPolicy): BrowserProbeNetworkPolicySummary {
  const hosts = Object.fromEntries([...policy.stats.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([host, stat]) => [host, { ...stat }]))
  return {
    mode: policy.mode,
    allowHosts: [...policy.allowHosts].sort(),
    blockHosts: [...policy.blockHosts].sort(),
    routeHosts: [...policy.routeHosts].sort(),
    recordExternal: policy.recordExternal,
    externalRequests: Object.values(hosts).filter((stat) => stat.external).reduce((total, stat) => total + stat.requests, 0),
    blockedRequests: Object.values(hosts).reduce((total, stat) => total + stat.blocked, 0),
    hosts: policy.recordExternal ? hosts : Object.fromEntries(Object.entries(hosts).filter(([, stat]) => stat.blocked > 0 || stat.routed > 0)),
  }
}

export async function routeBrowserPreviewPageNetwork(page: Page, policy: BrowserPreviewNetworkPolicy, previewOrigin: string, tracker?: BrowserPreviewRouteTracker): Promise<void> {
  await routeBrowserPreviewNetwork(page.route.bind(page), policy, previewOrigin, tracker)
}

export async function routeBrowserPreviewContextNetwork(context: import("playwright").BrowserContext, policy: BrowserPreviewNetworkPolicy, previewOrigin: string, tracker?: BrowserPreviewRouteTracker): Promise<void> {
  await routeBrowserPreviewNetwork(context.route.bind(context), policy, previewOrigin, tracker)
}

export async function drainBrowserPreviewRouteTracker(tracker: BrowserPreviewRouteTracker, timeoutMs = BROWSER_PREVIEW_ROUTE_DRAIN_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (tracker.pending.size > 0) {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      throw new Error(`wordpress.browser-probe route-host timed out waiting for ${tracker.pending.size} routed request(s) to finish`)
    }

    const result = await Promise.race([
      Promise.allSettled([...tracker.pending]).then(() => "drained" as const),
      wait(remainingMs).then(() => "timeout" as const),
    ])
    if (result === "timeout") {
      throw new Error(`wordpress.browser-probe route-host timed out waiting for ${tracker.pending.size} routed request(s) to finish`)
    }
  }

  if (tracker.errors.length > 0) {
    const error = tracker.errors[0]
    throw error instanceof Error ? error : new Error(String(error))
  }
}

function browserPreviewMode(args: string[], publicOrigin: string | undefined): BrowserProbePreviewMode {
  const raw = argValue(args, "preview-mode")?.trim() || (publicOrigin ? "public" : "local")
  if (raw === "local" || raw === "public" || raw === "secure") {
    return raw
  }

  throw new Error(`wordpress.browser-probe preview-mode supports local, public, secure: ${raw}`)
}

async function routeBrowserPreviewNetwork(routePattern: (url: string, handler: (route: Route) => Promise<void>) => Promise<unknown>, policy: BrowserPreviewNetworkPolicy, previewOrigin: string, tracker?: BrowserPreviewRouteTracker): Promise<void> {
  if (!browserPreviewNeedsContextRouting(policy)) {
    return
  }

  const origin = new URL(previewOrigin)
  await routePattern("**/*", async (route) => {
    const request = route.request()
    let requestUrl: URL
    try {
      requestUrl = new URL(request.url())
    } catch {
      await route.continue()
      return
    }

    const host = normalizeBrowserPreviewHost(requestUrl.hostname)
    const stat = browserPreviewNetworkPolicyHostStat(policy, host)
    stat.requests += 1
    stat.external = !policy.firstPartyHosts.has(host)

    if (policy.blockHosts.has(host) || (policy.mode === "block" && stat.external && !policy.allowHosts.has(host))) {
      stat.blocked += 1
      await route.abort("blockedbyclient")
      return
    }

    if (!policy.routeHosts.has(host)) {
      await route.continue()
      return
    }

    stat.routed += 1
    const task = fulfillBrowserPreviewRoutedHost(route, requestUrl, policy.routeHosts, origin)
    tracker?.pending.add(task)
    try {
      await task
    } catch (error) {
      tracker?.errors.push(error)
      throw error
    } finally {
      tracker?.pending.delete(task)
    }
  })
}

async function fulfillBrowserPreviewRoutedHost(route: Route, requestUrl: URL, routedHosts: Set<string>, localOrigin: URL): Promise<void> {
  const response = await fetchBrowserPreviewRoutedHost(route, requestUrl, routedHosts, localOrigin)
  if (!response) {
    return
  }
  await route.fulfill({ response })
}

function browserPreviewNetworkPolicyMode(args: string[]): BrowserPreviewNetworkPolicy["mode"] {
  const raw = argValue(args, "network-policy")?.trim() || "record"
  if (raw === "allow" || raw === "block" || raw === "record") {
    return raw
  }

  throw new Error(`wordpress.browser-probe network-policy supports allow, block, record: ${raw}`)
}

function browserPreviewNetworkPolicyHostStat(policy: BrowserPreviewNetworkPolicy, host: string): { requests: number; external: boolean; blocked: number; routed: number } {
  let stat = policy.stats.get(host)
  if (!stat) {
    stat = { requests: 0, external: false, blocked: 0, routed: 0 }
    policy.stats.set(host, stat)
  }
  return stat
}

function browserPreviewUrlHostname(url: string): string | undefined {
  try {
    return normalizeBrowserPreviewHost(new URL(url).hostname)
  } catch {
    return undefined
  }
}

function uniqueBrowserPreviewAuthCookieUrls(urls: string[]): string[] {
  const unique = new Map<string, string>()
  for (const url of urls) {
    try {
      const parsed = new URL(url)
      unique.set(`${parsed.protocol}//${normalizeBrowserPreviewHost(parsed.hostname)}`, `${parsed.protocol}//${parsed.hostname}/`)
    } catch {
      // Ignore invalid cookie URL inputs; callers still include the local preview origin.
    }
  }
  return [...unique.values()]
}

function browserPreviewAuthCookieProtocol(targetUrls: string[]): string {
  for (const targetUrl of targetUrls) {
    try {
      return new URL(targetUrl).protocol
    } catch {
      // Keep looking for a usable target URL.
    }
  }
  return "http:"
}

function normalizeBrowserPreviewHost(host: string): string {
  return host.trim().toLowerCase().replace(/:\d+$/, "")
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchBrowserPreviewRoutedHost(route: Route, requestUrl: URL, routedHosts: Set<string>, origin: URL): Promise<Awaited<ReturnType<Route["fetch"]>> | undefined> {
  let currentUrl = requestUrl
  for (let redirectCount = 0; redirectCount < 10; redirectCount++) {
    const routedUrl = new URL(currentUrl.toString())
    routedUrl.protocol = origin.protocol
    routedUrl.hostname = origin.hostname
    routedUrl.port = origin.port

    let response: Awaited<ReturnType<Route["fetch"]>>
    try {
      response = await route.fetch({
        url: routedUrl.toString(),
        headers: {
          ...route.request().headers(),
          host: currentUrl.host,
          "x-forwarded-host": currentUrl.host,
          "x-forwarded-port": currentUrl.port || (currentUrl.protocol === "https:" ? "443" : "80"),
          "x-forwarded-proto": currentUrl.protocol.replace(":", ""),
        },
        maxRedirects: 0,
      })
    } catch (error) {
      if (!isBrowserPreviewRouteFetchRecoverableError(error)) {
        throw error
      }

      await route.abort("failed").catch(() => undefined)
      return undefined
    }

    const location = response.headers().location
    if (!location || response.status() < 300 || response.status() >= 400) {
      return response
    }

    const redirectedUrl = new URL(location, currentUrl)
    if (!routedHosts.has(redirectedUrl.hostname.toLowerCase())) {
      return response
    }

    currentUrl = redirectedUrl
  }

  if (route.request().resourceType() !== "document") {
    await route.abort("failed").catch(() => undefined)
    return undefined
  }

  throw new Error(`wordpress.browser-probe route-host exceeded redirect limit for ${requestUrl.href}`)
}

export function isBrowserPreviewRouteFetchRequestContextDisposedError(error: unknown): boolean {
  return error instanceof Error && /\broute\.fetch:\s*Request context disposed\.?/i.test(error.message)
}

export function isBrowserPreviewRouteFetchRecoverableError(error: unknown): boolean {
  return isBrowserPreviewRouteFetchRequestContextDisposedError(error) || isBrowserPreviewRouteFetchContentDecodingError(error)
}

export function isBrowserPreviewRouteFetchContentDecodingError(error: unknown): boolean {
  return error instanceof Error && /\broute\.fetch:\s*failed to decompress\b/i.test(error.message)
}

function urlProtocol(url: string): string | undefined {
  try {
    return new URL(url).protocol
  } catch {
    return undefined
  }
}
