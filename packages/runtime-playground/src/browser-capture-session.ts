import { redactString } from "@automattic/wp-codebox-core"
import type { BrowserProbeErrorRecord, BrowserProbeNetworkRecord, BrowserProbeWebSocketRecord } from "./browser-artifacts.js"
import { browserCommandLivenessPolicy } from "./browser-liveness.js"
import { serializeBrowserConsoleMessage, serializeBrowserError, serializeBrowserFinishedRequest, serializeBrowserRequestFailure } from "./browser-metrics.js"
import type { Browser, Page, Request } from "playwright"
import { assertPlaywrightBrowserReady } from "./playwright-browser-provenance.js"

export async function launchChromiumBrowser(): Promise<Browser> {
  const { chromium } = await import("playwright")
  await assertPlaywrightBrowserReady()
  return chromium.launch(
    process.env.WP_CODEBOX_BROWSER_CHANNEL
      ? { channel: process.env.WP_CODEBOX_BROWSER_CHANNEL }
      : undefined,
  )
}

export function chromiumBrowserMetadata(browser: Browser): { name: "chromium"; channel: string; version: string } {
  return {
    name: "chromium",
    channel: process.env.WP_CODEBOX_BROWSER_CHANNEL || "bundled",
    version: browser.version(),
  }
}

export interface BrowserNavigationTracker {
  navigating(): boolean
  waitForSettlement(timeoutMs: number): Promise<boolean>
  dispose(): void
}

export type BrowserHtmlCaptureResult = {
  status: "captured"
  html: string
  attempts: number
  waitedMs: number
  navigationObserved: boolean
} | {
  status: "navigation_unsettled"
  attempts: number
  waitedMs: number
  navigationObserved: true
  reason: string
}

export function trackBrowserNavigation(page: Page): BrowserNavigationTracker {
  const active = new Set<Request>()
  const waiters = new Set<() => void>()
  const notify = () => {
    if (active.size > 0) return
    for (const resolve of waiters) resolve()
    waiters.clear()
  }
  const onRequest = (request: Request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) active.add(request)
  }
  const onRequestFailed = (request: Request) => {
    if (!active.has(request)) return
    active.clear()
    notify()
  }
  const onDomContentLoaded = () => {
    active.clear()
    notify()
  }
  page.on("request", onRequest)
  page.on("requestfailed", onRequestFailed)
  page.on("domcontentloaded", onDomContentLoaded)

  return {
    navigating: () => active.size > 0,
    async waitForSettlement(timeoutMs) {
      if (active.size === 0) return true
      if (timeoutMs <= 0) return false
      return await new Promise<boolean>((resolve) => {
        let timeout: ReturnType<typeof setTimeout> | undefined
        const settled = () => {
          if (timeout) clearTimeout(timeout)
          waiters.delete(settled)
          resolve(true)
        }
        waiters.add(settled)
        if (active.size === 0) {
          settled()
          return
        }
        timeout = setTimeout(() => {
          waiters.delete(settled)
          resolve(false)
        }, timeoutMs)
      })
    },
    dispose() {
      page.off("request", onRequest)
      page.off("requestfailed", onRequestFailed)
      page.off("domcontentloaded", onDomContentLoaded)
      active.clear()
      notify()
    },
  }
}

export async function captureBrowserPageHtml(page: Page, navigation: BrowserNavigationTracker, timeoutMs: number): Promise<BrowserHtmlCaptureResult> {
  const startedAt = Date.now()
  const deadline = startedAt + Math.max(0, timeoutMs)
  let attempts = 0
  let navigationObserved = navigation.navigating()
  let reason = "Navigation did not settle before the browser capture budget expired."

  while (true) {
    if (navigation.navigating()) {
      navigationObserved = true
      const settled = await navigation.waitForSettlement(Math.max(0, deadline - Date.now()))
      if (!settled) return { status: "navigation_unsettled", attempts, waitedMs: Date.now() - startedAt, navigationObserved: true, reason }
    }

    attempts += 1
    try {
      const content = await captureBrowserContentWithin(page, Math.max(0, deadline - Date.now()))
      if (content.status === "timeout") {
        return { status: "navigation_unsettled", attempts, waitedMs: Date.now() - startedAt, navigationObserved: true, reason: "page.content did not settle before the browser capture budget expired." }
      }
      return { status: "captured", html: content.html, attempts, waitedMs: Date.now() - startedAt, navigationObserved }
    } catch (error) {
      if (!browserContentNavigationRace(error)) throw error
      navigationObserved = true
      reason = error instanceof Error ? error.message : String(error)
      const remainingMs = Math.max(0, deadline - Date.now())
      if (remainingMs <= 0) return { status: "navigation_unsettled", attempts, waitedMs: Date.now() - startedAt, navigationObserved: true, reason }
      if (!navigation.navigating()) await page.waitForTimeout(Math.min(10, remainingMs))
      const settled = await navigation.waitForSettlement(remainingMs)
      if (!settled || Date.now() >= deadline) return { status: "navigation_unsettled", attempts, waitedMs: Date.now() - startedAt, navigationObserved: true, reason }
    }
  }
}

async function captureBrowserContentWithin(page: Page, timeoutMs: number): Promise<{ status: "captured"; html: string } | { status: "timeout" }> {
  if (timeoutMs <= 0) return { status: "timeout" }
  const content = page.content()
  content.catch(() => undefined)
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      content.then((html) => ({ status: "captured" as const, html })),
      new Promise<{ status: "timeout" }>((resolve) => {
        timeout = setTimeout(() => resolve({ status: "timeout" }), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function browserContentNavigationRace(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /page\.content: Unable to retrieve content because the page is navigating and changing the content\./i.test(message)
}

export function attachBrowserCaptureListeners({
  captureConsole,
  captureErrors,
  captureNetwork,
  captureWebSocket,
  consoleMessages,
  errors,
  network,
  networkTasks,
  onConsole,
  onNetwork,
  onPageError,
  onWebSocket,
  page,
  webSockets,
}: {
  captureConsole: boolean
  captureErrors: boolean
  captureNetwork: boolean
  captureWebSocket?: boolean
  consoleMessages: Record<string, unknown>[]
  errors: BrowserProbeErrorRecord[]
  network: BrowserProbeNetworkRecord[]
  networkTasks?: Array<Promise<void>>
  onConsole?: () => void
  onNetwork?: () => void
  onPageError?: () => void
  onWebSocket?: () => void
  page: Page
  webSockets?: BrowserProbeWebSocketRecord[]
}): void {
  if (captureConsole) {
    page.on("console", (message) => {
      onConsole?.()
      consoleMessages.push(serializeBrowserConsoleMessage(message))
    })
  }
  if (captureErrors) {
    page.on("pageerror", (error) => {
      onPageError?.()
      errors.push(serializeBrowserError("pageerror", error))
    })
  }
  if (captureNetwork) {
    page.on("requestfinished", (request) => {
      const timestamp = new Date().toISOString()
      const task = serializeBrowserFinishedRequest(request, timestamp).then((record) => {
        onNetwork?.()
        network.push(record)
      }).catch(() => undefined)
      networkTasks?.push(task)
    })
    page.on("requestfailed", (request) => {
      onNetwork?.()
      network.push(serializeBrowserRequestFailure(request, new Date().toISOString()))
    })
  }
  if (captureWebSocket && webSockets) {
    page.on("websocket", (socket) => {
      onWebSocket?.()
      const record = createBrowserWebSocketRecord(socket.url(), new Date().toISOString())
      webSockets.push(record)
      socket.on("framesent", ({ payload }) => {
        onWebSocket?.()
        record.framesSent += 1
        record.bytesSent += browserWebSocketPayloadBytes(payload)
        record.lastFrameAt = new Date().toISOString()
      })
      socket.on("framereceived", ({ payload }) => {
        onWebSocket?.()
        record.framesReceived += 1
        record.bytesReceived += browserWebSocketPayloadBytes(payload)
        record.lastFrameAt = new Date().toISOString()
      })
      socket.on("socketerror", () => {
        onWebSocket?.()
        record.errors += 1
        record.lastErrorAt = new Date().toISOString()
      })
      socket.on("close", () => {
        onWebSocket?.()
        record.closedAt = new Date().toISOString()
      })
    })
  }
}

export function createBrowserWebSocketRecord(url: string, openedAt: string): BrowserProbeWebSocketRecord {
  return {
    url: redactBrowserWebSocketUrl(url),
    openedAt,
    framesSent: 0,
    framesReceived: 0,
    bytesSent: 0,
    bytesReceived: 0,
    errors: 0,
  }
}

export function browserWebSocketPayloadBytes(payload: string | Buffer): number {
  return typeof payload === "string" ? Buffer.byteLength(payload, "utf8") : payload.byteLength
}

function redactBrowserWebSocketUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const search = [...parsed.searchParams.keys()].length > 0
      ? `?${[...parsed.searchParams.keys()].map((key) => `${encodeURIComponent(key)}=[redacted]`).join("&")}`
      : ""
    return `${parsed.origin}${parsed.pathname}${search}${parsed.hash ? "#[redacted]" : ""}`
  } catch {
    return redactString(url, { redactAllUrlQueryValues: true, redactUrlHash: true, redactQueryAssignments: true })
  }
}

export async function settleBrowserNetworkTasks(networkTasks: Array<Promise<void>>, timeoutMs = browserCommandLivenessPolicy().networkSettleTimeoutMs): Promise<void> {
  if (networkTasks.length === 0) {
    return
  }

  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.allSettled(networkTasks),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs)
      }),
    ])
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
  }
}
