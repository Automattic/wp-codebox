import { redactError, redactString, type RuntimeCreateSpec } from "@automattic/wp-codebox-core"
import type { BrowserProbeNetworkPolicySummary, BrowserProbePreviewMode, BrowserProbePreviewRouting } from "./browser-artifacts.js"
import { argValue, commaListArg, strictBooleanArg } from "./commands.js"
import type { Page, Route } from "playwright"
import { playgroundSiteSeedMultisiteTopology, playgroundSiteSeedPrimaryUrl } from "./site-seed-multisite.js"

const BROWSER_PREVIEW_ROUTE_DRAIN_TIMEOUT_MS = 5_000
const BROWSER_PREVIEW_ROUTE_DOCUMENT_FETCH_ATTEMPTS = 3
const BROWSER_PREVIEW_ROUTE_SUBRESOURCE_FETCH_ATTEMPTS = 2
const BROWSER_PREVIEW_ROUTE_RETRY_DELAY_MS = 25

export interface BrowserPreviewNetworkPolicy {
  mode: "allow" | "block" | "record"
  allowHosts: Set<string>
  blockHosts: Set<string>
  routeHosts: Set<string>
  routeOrigins: Set<string>
  firstPartyHosts: Set<string>
  recordExternal: boolean
  stats: Map<string, { requests: number; external: boolean; blocked: number; routed: number }>
  routedRedirectEscapes: Array<{ rawOrigin: string; effectiveOrigin: string; reason: string }>
  preserveRoutedOrigin: boolean
}

export interface BrowserPreviewNavigationDecision {
  allowed: boolean
  rawOrigin?: string
  effectiveOrigin?: string
  routeDecision: "relative" | "effective-preview" | "routed-preview" | "external" | "invalid"
  reason: string
}

export interface BrowserPreviewNetworkDecision {
  url: string
  host?: string
  urlClassification: "same-origin" | "external" | "invalid"
  policyDecision: "blocked" | "allowed" | "recorded" | "unknown"
  policyReason: string
}

export interface BrowserPreviewNavigationScope {
  resolve(href: string, documentUrl: string): BrowserPreviewNavigationDecision
  drainDiagnostics(): Array<{ code: string; message: string; metadata: Record<string, unknown> }>
}

export interface BrowserPreviewTopology {
  preview: BrowserProbePreviewRouting
  networkPolicy: BrowserPreviewNetworkPolicy
  routedHosts: string[]
  origins: BrowserPreviewOrigins
  navigationScope: BrowserPreviewNavigationScope
  resolveUrl(pathOrUrl: string): string
  authCookieUrls(targetUrls: string[]): string[]
  contextOptions(): { proxy?: { server: string } }
}

export interface BrowserPreviewOrigins {
  localPreviewOrigin: string
  requestedPreviewOrigin?: string
  effectivePreviewOrigin: string
  canonicalBrowserOrigin: string
  localProxyOrigin: string
  upstreamRuntimeOrigin?: string
}

export interface BrowserPreviewRouteTracker {
  pending: Set<Promise<void>>
  errors: unknown[]
  registrations: number
}

export interface BrowserPreviewTransportFaultPolicy {
  preflight(route: Route): Promise<boolean>
  fetch(route: Route, overrides: { url?: string; postData?: Buffer }): Promise<Awaited<ReturnType<Route["fetch"]>> | undefined>
  recordHandled(route: Route): void
}

export function createBrowserPreviewRouteTracker(): BrowserPreviewRouteTracker {
  return { pending: new Set(), errors: [], registrations: 0 }
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

export function browserPreviewTopology(args: string[], runtimeSpec: RuntimeCreateSpec | undefined, localPreviewOrigin: string, upstreamRuntimeOrigin?: string): BrowserPreviewTopology {
  const declaredTopology = playgroundSiteSeedMultisiteTopology(runtimeSpec)
  const routedHosts = [...new Set([...commaListArg(args, "route-host"), ...(declaredTopology?.routeHosts ?? [])])]
  const preview = browserPreviewRouting(args, runtimeSpec, localPreviewOrigin)
  applyCanonicalRoutedPreviewOrigin(preview, playgroundSiteSeedPrimaryUrl(runtimeSpec) ?? runtimeSpec?.preview?.siteUrl, routedHosts)
  const networkPolicy = browserPreviewNetworkPolicy(args, routedHosts, preview, browserPreviewInternalRouteOrigins(preview, upstreamRuntimeOrigin))

  return {
    preview,
    networkPolicy,
    routedHosts,
    origins: browserPreviewOrigins(preview, upstreamRuntimeOrigin),
    navigationScope: browserPreviewNavigationScope(preview.effectiveOrigin, networkPolicy),
    resolveUrl(pathOrUrl) {
      return resolveBrowserPreviewUrl(pathOrUrl, preview.effectiveOrigin)
    },
    authCookieUrls(targetUrls) {
      return browserPreviewAuthCookieUrls(localPreviewOrigin, routedHosts, targetUrls)
    },
    contextOptions() {
      return networkPolicy.preserveRoutedOrigin ? { proxy: { server: new URL(localPreviewOrigin).origin } } : {}
    },
  }
}

export function browserPreviewNavigationScope(effectivePreviewOrigin: string, policy: BrowserPreviewNetworkPolicy): BrowserPreviewNavigationScope {
  const effectiveOrigin = new URL(effectivePreviewOrigin).origin
  return {
    resolve(href, documentUrl) {
      let resolved: URL
      try {
        resolved = new URL(href, documentUrl)
      } catch {
        return { allowed: false, routeDecision: "invalid", reason: "href-invalid" }
      }
      const rawOrigin = resolved.origin
      if (rawOrigin === effectiveOrigin) {
        return { allowed: true, rawOrigin, effectiveOrigin, routeDecision: absoluteHrefOrigin(href) ? "effective-preview" : "relative", reason: "effective-preview-origin" }
      }
      if (policy.routeHosts.has(normalizeBrowserPreviewHost(resolved.hostname))) {
        return { allowed: true, rawOrigin, effectiveOrigin, routeDecision: "routed-preview", reason: "declared-route-host" }
      }
      if (policy.routeOrigins.has(rawOrigin)) {
        return { allowed: true, rawOrigin, effectiveOrigin, routeDecision: "routed-preview", reason: "internal-runtime-origin" }
      }
      return { allowed: false, rawOrigin, effectiveOrigin: rawOrigin, routeDecision: "external", reason: policy.allowHosts.has(normalizeBrowserPreviewHost(resolved.hostname)) ? "network-host-allowed-but-not-routed" : "host-not-routed-to-preview" }
    },
    drainDiagnostics() {
      return policy.routedRedirectEscapes.splice(0).map((escape) => ({
        code: "browser_adaptive_redirect_scope_escape_rejected",
        message: "A routed preview redirect leaving the declared navigation scope was stopped.",
        metadata: { rawHrefOrigin: escape.rawOrigin, effectiveOrigin: escape.effectiveOrigin, routeDecision: "external", reason: escape.reason },
      }))
    },
  }
}

export function browserPreviewOrigins(preview: BrowserProbePreviewRouting, upstreamRuntimeOrigin?: string): BrowserPreviewOrigins {
  return {
    localPreviewOrigin: preview.localOrigin,
    ...(preview.publicOrigin ? { requestedPreviewOrigin: preview.publicOrigin } : {}),
    effectivePreviewOrigin: preview.effectiveOrigin,
    canonicalBrowserOrigin: new URL(preview.effectiveOrigin).origin,
    localProxyOrigin: new URL(preview.localOrigin).origin,
    ...(upstreamRuntimeOrigin ? { upstreamRuntimeOrigin: new URL(upstreamRuntimeOrigin).origin } : {}),
  }
}

function applyCanonicalRoutedPreviewOrigin(preview: BrowserProbePreviewRouting, siteUrl: string | undefined, routedHosts: string[]): void {
  if (preview.effectiveMode !== "local" || !siteUrl) {
    return
  }

  let canonical: URL
  try {
    canonical = new URL(siteUrl)
  } catch {
    return
  }
  const host = normalizeBrowserPreviewHost(canonical.hostname)
  if (!routedHosts.map(normalizeBrowserPreviewHost).includes(host)) {
    return
  }

  if (canonical.protocol !== "http:") {
    preview.diagnostics.push({
      code: "preview-canonical-origin-preservation-inconclusive",
      severity: "error",
      message: "The local Playground provider cannot preserve this declared canonical preview protocol.",
      details: { status: "inconclusive", canonicalOrigin: canonical.origin, supportedProtocols: ["http:"] },
    })
    return
  }

  preview.effectiveOrigin = canonical.toString()
  preview.diagnostics.push({
    code: "preview-canonical-routed-origin",
    severity: "info",
    message: "The declared routed preview alias is the browser-visible origin.",
    details: { canonicalOrigin: canonical.origin, localProxyOrigin: new URL(preview.localOrigin).origin },
  })
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

export function browserPreviewNetworkPolicy(args: string[], routeHosts: string[], preview: BrowserProbePreviewRouting, routeOrigins: string[] = []): BrowserPreviewNetworkPolicy {
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
    routeOrigins: new Set(routeOrigins),
    firstPartyHosts,
    recordExternal: strictBooleanArg(args, "record-external", false),
    stats: new Map(),
    routedRedirectEscapes: [],
    preserveRoutedOrigin: new URL(preview.effectiveOrigin).origin !== new URL(preview.localOrigin).origin && preview.effectiveMode === "local",
  }
}

export function browserPreviewNetworkPolicyIsActive(policy: BrowserPreviewNetworkPolicy): boolean {
  return policy.mode !== "record" || policy.allowHosts.size > 0 || policy.blockHosts.size > 0 || policy.routeHosts.size > 0 || policy.recordExternal
}

export function browserPreviewNeedsContextRouting(policy: BrowserPreviewNetworkPolicy): boolean {
  return policy.mode === "block" || policy.blockHosts.size > 0 || policy.routeHosts.size > 0 || policy.routeOrigins.size > 0 || policy.recordExternal
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

export function browserPreviewNetworkDecision(url: string, policy: BrowserPreviewNetworkPolicy): BrowserPreviewNetworkDecision {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { url, urlClassification: "invalid", policyDecision: "unknown", policyReason: "url-invalid" }
  }
  const host = normalizeBrowserPreviewHost(parsed.hostname)
  const external = !policy.firstPartyHosts.has(host)
  const evidence = { url, host, urlClassification: external ? "external" as const : "same-origin" as const }
  if (policy.blockHosts.has(host)) return { ...evidence, policyDecision: "blocked", policyReason: "declared-block-host" }
  if (policy.mode === "block" && external && !policy.allowHosts.has(host)) return { ...evidence, policyDecision: "blocked", policyReason: "external-host-blocked-by-policy" }
  if (policy.allowHosts.has(host)) return { ...evidence, policyDecision: "allowed", policyReason: "declared-allow-host" }
  if (!external) return { ...evidence, policyDecision: "allowed", policyReason: "first-party-host" }
  if (policy.mode === "allow") return { ...evidence, policyDecision: "allowed", policyReason: "network-policy-allow" }
  return { ...evidence, policyDecision: "recorded", policyReason: "network-policy-record" }
}

export async function routeBrowserPreviewPageNetwork(page: Page, policy: BrowserPreviewNetworkPolicy, previewOrigin: string, tracker?: BrowserPreviewRouteTracker): Promise<void> {
  await routeBrowserPreviewNetwork(page.route.bind(page), policy, previewOrigin, tracker)
}

export async function routeBrowserPreviewContextNetwork(context: import("playwright").BrowserContext, policy: BrowserPreviewNetworkPolicy, previewOrigin: string, tracker?: BrowserPreviewRouteTracker): Promise<void> {
  await routeBrowserPreviewNetwork(context.route.bind(context), policy, previewOrigin, tracker)
}

export function browserPreviewTransportFaultPolicy(policy: BrowserPreviewNetworkPolicy, previewOrigin: string): BrowserPreviewTransportFaultPolicy {
  const origin = new URL(previewOrigin)
  return {
    async preflight(route) {
      const requestUrl = browserPreviewRouteUrl(route)
      if (!requestUrl) return true
      if (!browserPreviewRouteIsBlocked(requestUrl, route.request().resourceType(), policy)) return true
      recordBrowserPreviewPolicyRequest(policy, requestUrl, "blocked")
      await route.abort("blockedbyclient")
      return false
    },
    async fetch(route, overrides) {
      const requestUrl = browserPreviewRouteUrl(route, overrides.url)
      if (!requestUrl) return route.fetch(overrides)
      if (browserPreviewRouteIsBlocked(requestUrl, route.request().resourceType(), policy)) {
        recordBrowserPreviewPolicyRequest(policy, requestUrl, "blocked")
        await route.abort("blockedbyclient")
        return undefined
      }
      const routed = policy.routeOrigins.has(requestUrl.origin) || policy.routeHosts.has(normalizeBrowserPreviewHost(requestUrl.hostname))
      recordBrowserPreviewPolicyRequest(policy, requestUrl, routed ? "routed" : "handled")
      return routed
        ? fetchBrowserPreviewRoutedHost(route, requestUrl, policy, origin, !policy.routeOrigins.has(requestUrl.origin), overrides)
        : route.fetch(overrides)
    },
    recordHandled(route) {
      const requestUrl = browserPreviewRouteUrl(route)
      if (!requestUrl) return
      const routed = policy.routeOrigins.has(requestUrl.origin) || policy.routeHosts.has(normalizeBrowserPreviewHost(requestUrl.hostname))
      recordBrowserPreviewPolicyRequest(policy, requestUrl, routed ? "routed" : "handled")
    },
  }
}

export async function drainBrowserPreviewRouteTracker(tracker: BrowserPreviewRouteTracker, timeoutMs = BROWSER_PREVIEW_ROUTE_DRAIN_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let observedRegistrations = -1
  while (tracker.pending.size > 0 || tracker.registrations !== observedRegistrations) {
    observedRegistrations = tracker.registrations
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      throw new Error(`wordpress.browser-probe route-host timed out waiting for ${tracker.pending.size} routed request(s) to finish`)
    }

    const pending = [...tracker.pending]
    const result = await Promise.race([
      Promise.allSettled(pending).then(() => "drained" as const),
      wait(remainingMs).then(() => "timeout" as const),
    ])
    if (result === "timeout") {
      throw new Error(`wordpress.browser-probe route-host timed out waiting for ${tracker.pending.size} routed request(s) to finish`)
    }
    await wait(0)
  }

  if (tracker.errors.length > 0) {
    throw sanitizeBrowserPreviewRouteError(tracker.errors[0])
  }
}

export async function closeBrowserAndDrainPreviewRoutes(browser: Pick<import("playwright").Browser, "close">, tracker: BrowserPreviewRouteTracker, closeTimeoutMs = 1_000): Promise<Error[]> {
  const errors: Error[] = []
  let closeTimer: ReturnType<typeof setTimeout> | undefined
  try {
    const closeResult = await Promise.race([
      browser.close().then(() => ({ status: "closed" as const }), (error: unknown) => ({ status: "failed" as const, error })),
      new Promise<{ status: "timeout" }>((resolve) => {
        closeTimer = setTimeout(() => resolve({ status: "timeout" }), closeTimeoutMs)
      }),
    ])
    if (closeResult.status === "failed") {
      errors.push(browserPreviewLifecycleError("browser-close", closeResult.error))
    } else if (closeResult.status === "timeout") {
      errors.push(browserPreviewLifecycleError("browser-close-timeout", new Error(`Browser close exceeded ${closeTimeoutMs}ms`)))
    }
  } finally {
    if (closeTimer) {
      clearTimeout(closeTimer)
    }
    try {
      await drainBrowserPreviewRouteTracker(tracker)
    } catch (error) {
      errors.push(browserPreviewLifecycleError("route-drain", error))
    }
  }
  return errors
}

// A timed-out graceful close is diagnostic-only: cleanup is already bounded and
// must not replace a result that completed before the browser shutdown stalled.
export function browserPreviewCleanupErrorIsFatal(error: Error): boolean {
  return !error.message.includes("operation=browser-close-timeout")
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
    let operation = "inspect-request"
    const task = handleBrowserPreviewRoute(route, policy, origin, (nextOperation) => {
      operation = nextOperation
    })
    if (tracker) {
      tracker.registrations += 1
      tracker.pending.add(task)
    }
    try {
      await task
    } catch (error) {
      if (!isBrowserPreviewRouteClosedError(error)) {
        tracker?.errors.push(browserPreviewRouteCallbackError(route, operation, error))
      }
      try {
        await route.abort("failed")
      } catch (abortError) {
        if (!isBrowserPreviewRouteClosedError(abortError)) {
          tracker?.errors.push(browserPreviewRouteCallbackError(route, "abort-after-error", abortError))
        }
      }
    } finally {
      tracker?.pending.delete(task)
    }
  })
}

async function handleBrowserPreviewRoute(route: Route, policy: BrowserPreviewNetworkPolicy, origin: URL, setOperation: (operation: string) => void): Promise<void> {
  const request = route.request()
  let requestUrl: URL
  try {
    requestUrl = new URL(request.url())
  } catch {
    setOperation("continue-invalid-url")
    await route.continue()
    return
  }

  const host = normalizeBrowserPreviewHost(requestUrl.hostname)
  const stat = browserPreviewNetworkPolicyHostStat(policy, host)
  stat.requests += 1
  stat.external = !policy.firstPartyHosts.has(host)

  if (policy.blockHosts.has(host)) {
    stat.blocked += 1
    setOperation("abort-policy-block")
    await route.abort("blockedbyclient")
    return
  }

  const internalRuntimeRoute = policy.routeOrigins.has(requestUrl.origin)
  if (internalRuntimeRoute || policy.routeHosts.has(host)) {
    stat.routed += 1
    if (internalRuntimeRoute && request.resourceType() === "document") {
      const previewUrl = new URL(requestUrl.toString())
      previewUrl.protocol = origin.protocol
      previewUrl.hostname = origin.hostname
      previewUrl.port = origin.port
      setOperation("redirect-internal-runtime-document")
      await route.fulfill({ status: 307, headers: { location: previewUrl.toString() }, body: "" })
      return
    }
    if (!internalRuntimeRoute && policy.preserveRoutedOrigin) {
      setOperation("continue-preserved-routed-origin")
      await route.continue()
      return
    }
    setOperation("fulfill-routed-host")
    await fulfillBrowserPreviewRoutedHost(route, requestUrl, policy, origin, !internalRuntimeRoute)
    return
  }

  if (policy.preserveRoutedOrigin || (policy.mode === "block" && stat.external && !policy.allowHosts.has(host)) || (request.resourceType() === "document" && stat.external)) {
    stat.blocked += 1
    setOperation("abort-policy-block")
    await route.abort("blockedbyclient")
    return
  }

  setOperation("continue-unrouted")
  await route.continue()
}

async function fulfillBrowserPreviewRoutedHost(route: Route, requestUrl: URL, policy: BrowserPreviewNetworkPolicy, localOrigin: URL, preserveRequestedAuthority: boolean): Promise<void> {
  const response = await fetchBrowserPreviewRoutedHost(route, requestUrl, policy, localOrigin, preserveRequestedAuthority)
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

function browserPreviewRouteUrl(route: Route, override?: string): URL | undefined {
  try {
    return new URL(override ?? route.request().url())
  } catch {
    return undefined
  }
}

function browserPreviewRouteIsBlocked(requestUrl: URL, resourceType: string, policy: BrowserPreviewNetworkPolicy): boolean {
  const host = normalizeBrowserPreviewHost(requestUrl.hostname)
  if (policy.blockHosts.has(host)) return true
  const routed = policy.routeOrigins.has(requestUrl.origin) || policy.routeHosts.has(host)
  const external = !policy.firstPartyHosts.has(host)
  return !routed && (policy.preserveRoutedOrigin || (policy.mode === "block" && external && !policy.allowHosts.has(host)) || (resourceType === "document" && external))
}

function recordBrowserPreviewPolicyRequest(policy: BrowserPreviewNetworkPolicy, requestUrl: URL, outcome: "blocked" | "routed" | "handled"): void {
  const host = normalizeBrowserPreviewHost(requestUrl.hostname)
  const stat = browserPreviewNetworkPolicyHostStat(policy, host)
  stat.requests += 1
  stat.external = !policy.firstPartyHosts.has(host)
  if (outcome === "blocked") stat.blocked += 1
  if (outcome === "routed") stat.routed += 1
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

function absoluteHrefOrigin(href: string): string | undefined {
  try {
    return new URL(href).origin
  } catch {
    return undefined
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchBrowserPreviewRoutedHost(route: Route, requestUrl: URL, policy: BrowserPreviewNetworkPolicy, origin: URL, preserveRequestedAuthority: boolean, overrides: { postData?: Buffer } = {}): Promise<Awaited<ReturnType<Route["fetch"]>> | undefined> {
  let currentUrl = requestUrl
  for (let redirectCount = 0; redirectCount < 10; redirectCount++) {
    const routedUrl = new URL(currentUrl.toString())
    routedUrl.protocol = origin.protocol
    routedUrl.hostname = origin.hostname
    routedUrl.port = origin.port

    let response: Awaited<ReturnType<Route["fetch"]>> | undefined
    const resourceType = route.request().resourceType()
    const method = route.request().method().toUpperCase()
    const methodCanRetry = browserPreviewRouteMethodCanRetry(method)
    const maxAttempts = methodCanRetry ? (resourceType === "document" ? BROWSER_PREVIEW_ROUTE_DOCUMENT_FETCH_ATTEMPTS : BROWSER_PREVIEW_ROUTE_SUBRESOURCE_FETCH_ATTEMPTS) : 1
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        response = await route.fetch({
          url: routedUrl.toString(),
          ...(overrides.postData ? { postData: overrides.postData } : {}),
          headers: {
            ...route.request().headers(),
            host: preserveRequestedAuthority ? currentUrl.host : origin.host,
            "x-forwarded-host": preserveRequestedAuthority ? currentUrl.host : origin.host,
            "x-forwarded-port": preserveRequestedAuthority ? (currentUrl.port || (currentUrl.protocol === "https:" ? "443" : "80")) : (origin.port || (origin.protocol === "https:" ? "443" : "80")),
            "x-forwarded-proto": (preserveRequestedAuthority ? currentUrl.protocol : origin.protocol).replace(":", ""),
          },
          maxRedirects: 0,
        })
        break
      } catch (error) {
        if (!isBrowserPreviewRouteFetchRecoverableError(error)) {
          throw sanitizeBrowserPreviewRouteError(error)
        }

        const retryable = isBrowserPreviewRouteFetchTransientTransportError(error)
        if (retryable && attempt < maxAttempts) {
          await wait(BROWSER_PREVIEW_ROUTE_RETRY_DELAY_MS * attempt)
          continue
        }

        if (resourceType !== "document" || !retryable) {
          await abortBrowserPreviewRoute(route, "abort-recoverable-fetch")
          return undefined
        }
        throw browserPreviewRouteFetchExhaustedError(route, currentUrl, attempt, error)
      }
    }
    if (!response) {
      return undefined
    }
    if (!methodCanRetry) {
      return response
    }

    const location = response.headers().location
    if (!location || response.status() < 300 || response.status() >= 400) {
      return response
    }

    const redirectedUrl = new URL(location, currentUrl)
    if (redirectedUrl.origin === origin.origin) {
      return response
    }
    const redirectedHost = normalizeBrowserPreviewHost(redirectedUrl.hostname)
    if (!policy.routeOrigins.has(redirectedUrl.origin) && !policy.routeHosts.has(redirectedHost)) {
      const stat = browserPreviewNetworkPolicyHostStat(policy, redirectedHost)
      stat.requests += 1
      stat.external = true
      stat.blocked += 1
      policy.routedRedirectEscapes.push({ rawOrigin: redirectedUrl.origin, effectiveOrigin: origin.origin, reason: "redirect-host-not-routed-to-preview" })
      await abortBrowserPreviewRoute(route, "abort-redirect-escape", "blockedbyclient")
      return undefined
    }

    currentUrl = redirectedUrl
  }

  if (route.request().resourceType() !== "document") {
    await abortBrowserPreviewRoute(route, "abort-redirect-limit")
    return undefined
  }

  throw new Error(`wordpress.browser-probe route-host exceeded redirect limit for ${requestUrl.href}`)
}

function browserPreviewInternalRouteOrigins(preview: BrowserProbePreviewRouting, upstreamRuntimeOrigin: string | undefined): string[] {
  if (!upstreamRuntimeOrigin) {
    return []
  }

  const upstream = new URL(upstreamRuntimeOrigin)
  const previewOrigins = new Set([new URL(preview.localOrigin).origin, new URL(preview.effectiveOrigin).origin])
  return [...new Set([upstream.origin, `${upstream.protocol}//${upstream.hostname}`])].filter((origin) => !previewOrigins.has(origin))
}

export function isBrowserPreviewRouteFetchRequestContextDisposedError(error: unknown): boolean {
  return error instanceof Error && /\broute\.fetch:\s*Request context disposed\.?/i.test(error.message)
}

export function isBrowserPreviewRouteFetchRecoverableError(error: unknown): boolean {
  return isBrowserPreviewRouteFetchRequestContextDisposedError(error) || isBrowserPreviewRouteFetchContentDecodingError(error) || isBrowserPreviewRouteFetchTransientTransportError(error)
}

export function isBrowserPreviewRouteFetchContentDecodingError(error: unknown): boolean {
  return error instanceof Error && /\broute\.fetch:\s*failed to decompress\b/i.test(error.message)
}

export function isBrowserPreviewRouteFetchTransientTransportError(error: unknown): boolean {
  return error instanceof Error && /\b(?:ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|UND_ERR_SOCKET|socket (?:hang up|closed|ended)|connection (?:reset|refused|closed)|other side closed)\b/i.test(error.message)
}

export function isBrowserPreviewRouteClosedError(error: unknown): boolean {
  return error instanceof Error && /(?:Request context disposed|Target (?:page, context or browser|page|context|browser) has been closed|Browser has been closed|context closed|page closed)/i.test(error.message)
}

function browserPreviewRouteMethodCanRetry(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS"
}

function browserPreviewRouteCallbackError(route: Route, operation: string, error: unknown): Error {
  const request = browserPreviewRouteRequestSummary(route)
  const cause = sanitizeBrowserPreviewRouteError(error).message.replace(/[\r\n]+/g, " ")
  const diagnostic = new Error(`wordpress.browser-probe route callback failed: operation=${operation} method=${request.method} resourceType=${request.resourceType} url=${request.url} cause=${cause}`)
  diagnostic.name = "BrowserPreviewRouteCallbackError"
  return diagnostic
}

function browserPreviewRouteRequestSummary(route: Route): { method: string; resourceType: string; url: string } {
  try {
    const request = route.request()
    return {
      method: request.method(),
      resourceType: request.resourceType(),
      url: redactString(request.url(), { redactAllUrlQueryValues: true, redactUrlHash: true, redactQueryAssignments: true }),
    }
  } catch {
    return { method: "unknown", resourceType: "unknown", url: "[unavailable]" }
  }
}

function browserPreviewLifecycleError(operation: string, error: unknown): Error {
  const cause = sanitizeBrowserPreviewRouteError(error).message.replace(/[\r\n]+/g, " ")
  const diagnostic = new Error(`wordpress.browser-probe route lifecycle failed: operation=${operation} cause=${cause}`)
  diagnostic.name = "BrowserPreviewRouteLifecycleError"
  return diagnostic
}

async function abortBrowserPreviewRoute(route: Route, operation: string, errorCode: Parameters<Route["abort"]>[0] = "failed"): Promise<void> {
  try {
    await route.abort(errorCode)
  } catch (error) {
    if (isBrowserPreviewRouteClosedError(error)) {
      return
    }
    const cause = sanitizeBrowserPreviewRouteError(error).message.replace(/[\r\n]+/g, " ")
    const diagnostic = new Error(`wordpress.browser-probe route operation failed: operation=${operation} cause=${cause}`)
    diagnostic.name = "BrowserPreviewRouteOperationError"
    throw diagnostic
  }
}

function browserPreviewRouteFetchExhaustedError(route: Route, requestUrl: URL, attempts: number, error: unknown): Error {
  const method = route.request().method()
  const resourceType = route.request().resourceType()
  const classification = isBrowserPreviewRouteFetchTransientTransportError(error) ? "upstream-transport" : "route-fetch"
  const safeUrl = redactString(requestUrl.toString(), { redactAllUrlQueryValues: true, redactUrlHash: true, redactQueryAssignments: true })
  const exhausted = new Error(`wordpress.browser-probe route-host fetch failed after ${attempts} attempt(s): classification=${classification} method=${method} resourceType=${resourceType} url=${safeUrl}`)
  exhausted.name = "BrowserPreviewRouteFetchError"
  return exhausted
}

function sanitizeBrowserPreviewRouteError(error: unknown): Error {
  return redactError(error, { redactAllUrlQueryValues: true, redactUrlHash: true, redactQueryAssignments: true })
}

function urlProtocol(url: string): string | undefined {
  try {
    return new URL(url).protocol
  } catch {
    return undefined
  }
}
