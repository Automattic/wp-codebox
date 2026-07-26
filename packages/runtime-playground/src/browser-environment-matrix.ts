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

export const PLAYWRIGHT_BROWSER_ENVIRONMENT_CAPABILITIES = [
  "browser.environment.viewport",
  "browser.environment.device",
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
  if (requested.deviceScaleFactor !== undefined) exact("browser.environment.device-scale-factor")
  if (requested.isMobile !== undefined) exact("browser.environment.mobile")
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

  const effective = mergeDeviceEnvironment(requested, device)
  return {
    effective,
    capabilities: capabilities.sort((left, right) => left.id.localeCompare(right.id)),
    provider: { id: options.providerId ?? "playwright", browser: browser.browserType().name(), ...(options.channel ? { channel: options.channel } : {}), version: browser.version() },
  }
}

export async function createPlaywrightBrowserEnvironmentContext(browser: Browser, resolved: ResolvedBrowserEnvironment, options: PlaywrightBrowserEnvironmentOptions = {}): Promise<{ context: BrowserContext; page: Page; close(): Promise<void> }> {
  const { devices } = await import("playwright")
  const environment = resolved.effective
  const device = environment.device ? devices[environment.device] : undefined
  const viewport = orientedViewport(environment.viewport ?? device?.viewport ?? undefined, environment.orientation)
  const contextOptions: BrowserContextOptions = {
    ...(device ?? {}),
    ...(viewport ? { viewport, screen: viewport } : {}),
    ...(environment.deviceScaleFactor !== undefined ? { deviceScaleFactor: environment.deviceScaleFactor } : {}),
    ...(environment.isMobile !== undefined ? { isMobile: environment.isMobile } : {}),
    ...(environment.hasTouch !== undefined ? { hasTouch: environment.hasTouch } : {}),
    ...(environment.locale ? { locale: environment.locale } : {}),
    ...(environment.timezone ? { timezoneId: environment.timezone } : {}),
    ...(environment.colorScheme ? { colorScheme: environment.colorScheme } : {}),
    ...(environment.reducedMotion ? { reducedMotion: environment.reducedMotion } : {}),
    ...(environment.forcedColors ? { forcedColors: environment.forcedColors } : {}),
    ...(environment.contrast ? { contrast: environment.contrast } : {}),
    ...(environment.online !== undefined ? { offline: !environment.online } : {}),
    ...(environment.geolocation ? { geolocation: { latitude: environment.geolocation.latitude, longitude: environment.geolocation.longitude, ...(environment.geolocation.accuracy !== undefined ? { accuracy: environment.geolocation.accuracy } : {}) } } : {}),
    ...(environment.geolocation?.permission === "granted" ? { permissions: ["geolocation"] } : {}),
  }
  const context = await browser.newContext(contextOptions)
  const page = await context.newPage()
  const geolocationPermissionCleanup = environment.geolocation?.permission === "denied" ? await applyPlaywrightGeolocationPermission(page, "denied") : undefined
  await applyPlaywrightPageEnvironment(page, environment, options)
  return { context, page, close: async () => { await geolocationPermissionCleanup?.(); await context.close() } }
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
