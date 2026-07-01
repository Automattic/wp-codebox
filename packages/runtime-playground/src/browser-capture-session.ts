import { redactString } from "@automattic/wp-codebox-core"
import type { BrowserProbeErrorRecord, BrowserProbeNetworkRecord, BrowserProbeWebSocketRecord } from "./browser-artifacts.js"
import { browserCommandLivenessPolicy } from "./browser-liveness.js"
import { serializeBrowserConsoleMessage, serializeBrowserError, serializeBrowserFinishedRequest, serializeBrowserRequestFailure } from "./browser-metrics.js"
import type { Browser, Page } from "playwright"

export async function launchChromiumBrowser(): Promise<Browser> {
  const { chromium } = await import("playwright")
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
