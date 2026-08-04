import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import {
  runBrowserEnvironmentMatrix,
  type BrowserEnvironment,
  type BrowserEnvironmentCapabilityResult,
  type BrowserEnvironmentCell,
  type BrowserEnvironmentCellExecution,
  type BrowserEnvironmentMatrix,
  type BrowserEnvironmentMatrixReport,
  type ResolvedBrowserEnvironment,
} from "@automattic/wp-codebox-core"
import type { Browser, BrowserContext, BrowserContextOptions, Page } from "playwright"
import type { BrowserArtifactSummary } from "./browser-artifacts.js"
import type { BrowserPreviewRouteTracker } from "./browser-preview-routing.js"

export const PLAYWRIGHT_BROWSER_ENVIRONMENT_CAPABILITIES = [
  "browser.environment.viewport",
  "browser.environment.device",
  "browser.environment.user-agent",
  "browser.environment.permissions",
  "browser.environment.device-scale-factor",
  "browser.environment.mobile",
  "browser.environment.touch",
  "browser.environment.orientation",
  "browser.environment.zoom",
  "browser.environment.color-scheme",
  "browser.environment.reduced-motion",
  "browser.environment.forced-colors",
  "browser.environment.contrast",
  "browser.environment.locale",
  "browser.environment.timezone",
  "browser.environment.network-profile",
  "browser.environment.cpu-profile",
  "browser.environment.online-state",
  "browser.environment.clock",
  "browser.environment.geolocation",
  "browser.environment.capability-state",
] as const

export interface BrowserEnvironmentNetworkProfile {
  offline?: boolean
  latencyMs: number
  downloadThroughputBytesPerSecond: number
  uploadThroughputBytesPerSecond: number
}

export interface BrowserEnvironmentCpuProfile { slowdownRate: number }

export interface PlaywrightBrowserEnvironmentOptions {
  providerId?: string
  channel?: string
  networkProfiles?: Record<string, BrowserEnvironmentNetworkProfile>
  cpuProfiles?: Record<string, BrowserEnvironmentCpuProfile>
  contextOptions?: BrowserContextOptions
}

export interface PlaywrightBrowserEnvironmentExecutionInput {
  browser: Browser
  context: BrowserContext
  page: Page
  cell: BrowserEnvironmentCell
  resolved: ResolvedBrowserEnvironment
  artifactNamespace: string
  signal: AbortSignal
}

export interface PlaywrightBrowserEnvironmentRuntime {
  context: BrowserContext
  page: Page
  close(): Promise<void>
}

export interface PlaywrightBrowserEnvironmentSession {
  browser: Browser
  requested: BrowserEnvironment
  resolved: ResolvedBrowserEnvironment
  routeTracker?: BrowserPreviewRouteTracker
  runtime: PlaywrightBrowserEnvironmentRuntime
}

export async function resolvePlaywrightBrowserEnvironment(cell: BrowserEnvironmentCell, browser: Browser, options: PlaywrightBrowserEnvironmentOptions = {}): Promise<ResolvedBrowserEnvironment> {
  const { devices } = await import("playwright")
  const requested = cell.requested
  const device = requested.device ? devices[requested.device] : undefined
  const capabilities: BrowserEnvironmentCapabilityResult[] = []
  const exact = (id: string) => capabilities.push({ id, fidelity: "exact" })
  const emulated = (id: string, reason: string) => capabilities.push({ id, fidelity: "emulated", reason })
  const unsupported = (id: string, reason: string) => capabilities.push({ id, fidelity: "unsupported", reason })

  if (requested.viewport) exact("browser.environment.viewport")
  if (requested.device) device ? exact("browser.environment.device") : unsupported("browser.environment.device", `Unknown device profile: ${requested.device}`)
  if (requested.userAgent) exact("browser.environment.user-agent")
  if (requested.permissions) exact("browser.environment.permissions")
  if (requested.deviceScaleFactor !== undefined) exact("browser.environment.device-scale-factor")
  if (requested.isMobile !== undefined) emulated("browser.environment.mobile", "Playwright applies the mobile context setting, but the page has no authoritative API for reading the context flag back.")
  if (requested.hasTouch !== undefined) exact("browser.environment.touch")
  if (requested.orientation) exact("browser.environment.orientation")
  if (requested.colorScheme) exact("browser.environment.color-scheme")
  if (requested.reducedMotion) exact("browser.environment.reduced-motion")
  if (requested.forcedColors) exact("browser.environment.forced-colors")
  if (requested.contrast) exact("browser.environment.contrast")
  if (requested.locale) exact("browser.environment.locale")
  if (requested.timezone) exact("browser.environment.timezone")
  if (requested.online !== undefined) exact("browser.environment.online-state")
  if (requested.clock) exact("browser.environment.clock")
  if (requested.geolocation) {
    requested.geolocation.permission !== "denied" || browser.browserType().name() === "chromium"
      ? exact("browser.environment.geolocation")
      : unsupported("browser.environment.geolocation", "This provider cannot express an explicit denied geolocation permission without Chromium browser permission controls.")
  }
  if (requested.capabilities) exact("browser.environment.capability-state")
  if (requested.zoom !== undefined) emulated("browser.environment.zoom", "Applied as page scale through the browser debugging protocol; OS-level zoom and browser chrome are outside the page context.")
  if (requested.networkProfile) options.networkProfiles?.[requested.networkProfile] ? emulated("browser.environment.network-profile", "Latency and throughput are applied through the browser debugging protocol.") : unsupported("browser.environment.network-profile", `Unknown network profile: ${requested.networkProfile}`)
  if (requested.cpuProfile) options.cpuProfiles?.[requested.cpuProfile] ? emulated("browser.environment.cpu-profile", "CPU slowdown is applied through the browser debugging protocol.") : unsupported("browser.environment.cpu-profile", `Unknown CPU profile: ${requested.cpuProfile}`)

  const merged = mergeDeviceEnvironment(requested, device)
  const effectivePermissions = requested.permissions || requested.geolocation
    ? [...new Set([...(requested.permissions ?? []).filter((permission) => permission !== "geolocation"), ...(requested.geolocation?.permission === "granted" ? ["geolocation"] : [])])]
    : undefined
  const effective = { ...merged, ...(effectivePermissions ? { permissions: effectivePermissions } : {}) }
  return {
    effective,
    capabilities: capabilities.sort((left, right) => left.id.localeCompare(right.id)),
    provider: { id: options.providerId ?? "playwright", browser: browser.browserType().name(), ...(options.channel ? { channel: options.channel } : {}), version: browser.version() },
  }
}

export function browserEnvironmentCell(requested: BrowserEnvironment): BrowserEnvironmentCell {
  return { id: "browser-environment", index: 0, seed: "browser-environment", selections: {}, requested, requiredCapabilities: [], optionalCapabilities: [] }
}

export async function createPlaywrightBrowserEnvironmentContext(browser: Browser, resolved: ResolvedBrowserEnvironment, options: PlaywrightBrowserEnvironmentOptions = {}): Promise<PlaywrightBrowserEnvironmentRuntime> {
  const { devices } = await import("playwright")
  const environment = resolved.effective
  const device = environment.device ? devices[environment.device] : undefined
  const viewport = orientedViewport(environment.viewport ?? device?.viewport ?? undefined, environment.orientation)
  const contextOptions: BrowserContextOptions = {
    ...(device ?? {}),
    ...(options.contextOptions ?? {}),
    ...(viewport ? { viewport, screen: viewport } : {}),
    ...(environment.deviceScaleFactor !== undefined ? { deviceScaleFactor: environment.deviceScaleFactor } : {}),
    ...(environment.isMobile !== undefined ? { isMobile: environment.isMobile } : {}),
    ...(environment.hasTouch !== undefined ? { hasTouch: environment.hasTouch } : {}),
    ...(environment.userAgent ? { userAgent: environment.userAgent } : {}),
    ...(environment.locale ? { locale: environment.locale } : {}),
    ...(environment.timezone ? { timezoneId: environment.timezone } : {}),
    ...(environment.colorScheme ? { colorScheme: environment.colorScheme } : {}),
    ...(environment.reducedMotion ? { reducedMotion: environment.reducedMotion } : {}),
    ...(environment.forcedColors ? { forcedColors: environment.forcedColors } : {}),
    ...(environment.contrast ? { contrast: environment.contrast } : {}),
    ...(environment.online !== undefined ? { offline: !environment.online } : {}),
    ...(environment.geolocation ? { geolocation: { latitude: environment.geolocation.latitude, longitude: environment.geolocation.longitude, ...(environment.geolocation.accuracy !== undefined ? { accuracy: environment.geolocation.accuracy } : {}) } } : {}),
    ...(environment.permissions?.length || environment.geolocation?.permission === "granted" ? { permissions: [...new Set([...(environment.permissions ?? []).filter((permission) => permission !== "geolocation"), ...(environment.geolocation?.permission === "granted" ? ["geolocation"] : [])])] } : {}),
  }
  const context = await browser.newContext(contextOptions)
  const page = await context.newPage()
  const geolocationPermissionCleanup = environment.geolocation?.permission === "denied" ? await applyPlaywrightGeolocationPermission(page, "denied") : undefined
  await applyPlaywrightPageEnvironment(page, environment, options)
  return { context, page, close: async () => { await geolocationPermissionCleanup?.(); await context.close() } }
}

export async function observePlaywrightBrowserEnvironment(page: Page, requested: BrowserEnvironment, resolved: ResolvedBrowserEnvironment): Promise<NonNullable<BrowserArtifactSummary["environment"]>> {
  const observed: NonNullable<NonNullable<BrowserArtifactSummary["environment"]>["observed"]> | undefined = await page.evaluate(async () => {
    let geolocationPermission: "granted" | "denied" | "prompt" | "unsupported" | undefined
    try {
      const state = (await navigator.permissions.query({ name: "geolocation" })).state
      geolocationPermission = state === "granted" || state === "denied" || state === "prompt" ? state : "unsupported"
    } catch {
      geolocationPermission = "unsupported"
    }
    return {
      viewport: { width: innerWidth, height: innerHeight },
      deviceScaleFactor: devicePixelRatio,
      hasTouch: navigator.maxTouchPoints > 0,
      maxTouchPoints: navigator.maxTouchPoints,
      userAgent: navigator.userAgent,
      locale: navigator.language,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || undefined,
      online: navigator.onLine,
      ...(geolocationPermission ? { geolocationPermission } : {}),
    }
  }).catch(() => undefined)
  const observedGeolocation = requested.geolocation && observed?.geolocationPermission === "granted"
    ? await page.evaluate(() => new Promise<{ latitude: number; longitude: number; accuracy: number } | undefined>((resolve) => navigator.geolocation.getCurrentPosition(
      ({ coords }) => resolve({ latitude: coords.latitude, longitude: coords.longitude, accuracy: coords.accuracy }),
      () => resolve(undefined),
      { timeout: 1_000 },
    ))).catch(() => undefined)
    : undefined
  if (observed && observedGeolocation) observed.geolocation = observedGeolocation
  const unsupported = resolved.capabilities.filter(({ fidelity }) => fidelity === "unsupported").map(({ id }) => id)
  const inconclusive: string[] = []
  if (requested.device) inconclusive.push("browser.environment.device")
  if (requested.isMobile !== undefined) inconclusive.push("browser.environment.mobile")
  if (requested.hasTouch !== undefined && observed && requested.hasTouch !== observed.hasTouch) {
    const capability = "browser.environment.touch"
    unsupported.push(capability)
  } else if (requested.hasTouch !== undefined && !observed) {
    inconclusive.push("browser.environment.touch")
  }
  if (requested.geolocation && !observed?.geolocation) inconclusive.push("browser.environment.geolocation.coordinates")
  if (requested.permissions?.some((permission) => permission !== "geolocation")) inconclusive.push("browser.environment.permissions")
  for (const [key, capability] of [["orientation", "browser.environment.orientation"], ["zoom", "browser.environment.zoom"], ["colorScheme", "browser.environment.color-scheme"], ["reducedMotion", "browser.environment.reduced-motion"], ["forcedColors", "browser.environment.forced-colors"], ["contrast", "browser.environment.contrast"], ["networkProfile", "browser.environment.network-profile"], ["cpuProfile", "browser.environment.cpu-profile"], ["clock", "browser.environment.clock"], ["capabilities", "browser.environment.capability-state"]] as const) {
    if (requested[key] !== undefined) inconclusive.push(capability)
  }
  if (!observed) inconclusive.push("browser.environment.observation")
  const capabilities = resolved.capabilities.map((capability) => capability.id === "browser.environment.touch" && requested.hasTouch !== undefined && observed && requested.hasTouch !== observed.hasTouch
    ? { ...capability, fidelity: "unsupported" as const, reason: `Observed hasTouch=${observed.hasTouch}, requested ${requested.hasTouch}.` }
    : capability)
  return { requested, resolved: resolved.effective, ...(observed ? { observed } : {}), provider: resolved.provider, capabilities, unsupported: [...new Set(unsupported)], inconclusive: [...new Set(inconclusive)] }
}

export async function applyPlaywrightGeolocationPermission(page: Page, state: "denied"): Promise<() => Promise<void>> {
  if (page.context().browser()?.browserType().name() !== "chromium") throw new Error("Explicit denied geolocation permission is unsupported by this browser provider.")
  const session = await page.context().newCDPSession(page)
  const { targetInfo } = await session.send("Target.getTargetInfo")
  await session.send("Browser.setPermission", { permission: { name: "geolocation" }, setting: state, browserContextId: targetInfo.browserContextId })
  return () => session.detach().catch(() => undefined)
}

export async function applyPlaywrightPageEnvironment(page: Page, environment: BrowserEnvironment, options: PlaywrightBrowserEnvironmentOptions = {}): Promise<void> {
  if (environment.capabilities) {
    await page.addInitScript((capabilities) => {
      Object.defineProperty(globalThis, "__browserEnvironmentCapabilities", { value: Object.freeze(capabilities), configurable: false })
    }, environment.capabilities)
  }
  if (environment.clock?.mode === "fixed" && environment.clock.at) await page.clock.setFixedTime(environment.clock.at)
  const network = environment.networkProfile ? options.networkProfiles?.[environment.networkProfile] : undefined
  const cpu = environment.cpuProfile ? options.cpuProfiles?.[environment.cpuProfile] : undefined
  if (environment.zoom === undefined && !network && !cpu) return
  const session = await page.context().newCDPSession(page)
  try {
    const commands: Array<Promise<unknown>> = []
    if (environment.zoom !== undefined) commands.push(session.send("Emulation.setPageScaleFactor", { pageScaleFactor: environment.zoom }))
    if (cpu) commands.push(session.send("Emulation.setCPUThrottlingRate", { rate: cpu.slowdownRate }))
    if (network) {
      commands.push(session.send("Network.enable"))
      commands.push(session.send("Network.emulateNetworkConditions", { offline: network.offline ?? false, latency: network.latencyMs, downloadThroughput: network.downloadThroughputBytesPerSecond, uploadThroughput: network.uploadThroughputBytesPerSecond }))
    }
    await Promise.all(commands)
  } finally {
    await session.detach()
  }
}

export async function runPlaywrightBrowserEnvironmentMatrix(input: {
  matrix: BrowserEnvironmentMatrix
  runId: string
  artifactRoot: string
  browser: Browser
  options?: PlaywrightBrowserEnvironmentOptions
  signal?: AbortSignal
  execute(input: PlaywrightBrowserEnvironmentExecutionInput): Promise<BrowserEnvironmentCellExecution>
}): Promise<BrowserEnvironmentMatrixReport> {
  const matrixDirectory = join(input.artifactRoot, "browser-matrices", input.matrix.id)
  const reportDirectory = join(matrixDirectory, input.runId)
  await mkdir(matrixDirectory, { recursive: true })
  await mkdir(reportDirectory)
  const report = await runBrowserEnvironmentMatrix(input.matrix, {
    runId: input.runId,
    signal: input.signal,
    resolve: (cell) => resolvePlaywrightBrowserEnvironment(cell, input.browser, input.options),
    execute: async ({ cell, resolved, artifactNamespace, signal }) => {
      const runtime = await createPlaywrightBrowserEnvironmentContext(input.browser, resolved, input.options)
      try {
        return await input.execute({ browser: input.browser, context: runtime.context, page: runtime.page, cell, resolved, artifactNamespace, signal })
      } finally {
        await runtime.close()
      }
    },
  })
  await writeFile(join(reportDirectory, "matrix-report.json"), `${JSON.stringify(report, null, 2)}\n`)
  return report
}

function mergeDeviceEnvironment(environment: BrowserEnvironment, device: BrowserContextOptions | undefined): BrowserEnvironment {
  const viewport = orientedViewport(environment.viewport ?? device?.viewport ?? undefined, environment.orientation)
  return {
    ...environment,
    ...(viewport ? { viewport } : {}),
    ...(device?.deviceScaleFactor !== undefined && environment.deviceScaleFactor === undefined ? { deviceScaleFactor: device.deviceScaleFactor } : {}),
    ...(device?.isMobile !== undefined && environment.isMobile === undefined ? { isMobile: device.isMobile } : {}),
    ...(device?.hasTouch !== undefined && environment.hasTouch === undefined ? { hasTouch: device.hasTouch } : {}),
  }
}

function orientedViewport(viewport: { width: number; height: number } | undefined, orientation: BrowserEnvironment["orientation"]): { width: number; height: number } | undefined {
  if (!viewport || !orientation) return viewport
  const long = Math.max(viewport.width, viewport.height)
  const short = Math.min(viewport.width, viewport.height)
  return orientation === "landscape" ? { width: long, height: short } : { width: short, height: long }
}
