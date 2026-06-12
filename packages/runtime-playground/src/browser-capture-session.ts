import type { BrowserProbeErrorRecord, BrowserProbeNetworkRecord } from "./browser-artifacts.js"
import { serializeBrowserConsoleMessage, serializeBrowserError, serializeBrowserFinishedRequest, serializeBrowserRequestFailure } from "./browser-metrics.js"
import type { Browser, Page } from "playwright"

const BROWSER_NETWORK_TASK_SETTLE_TIMEOUT_MS = 1_000

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
  consoleMessages,
  errors,
  network,
  networkTasks,
  onConsole,
  onNetwork,
  onPageError,
  page,
}: {
  captureConsole: boolean
  captureErrors: boolean
  captureNetwork: boolean
  consoleMessages: Record<string, unknown>[]
  errors: BrowserProbeErrorRecord[]
  network: BrowserProbeNetworkRecord[]
  networkTasks?: Array<Promise<void>>
  onConsole?: () => void
  onNetwork?: () => void
  onPageError?: () => void
  page: Page
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
}

export async function settleBrowserNetworkTasks(networkTasks: Array<Promise<void>>, timeoutMs = BROWSER_NETWORK_TASK_SETTLE_TIMEOUT_MS): Promise<void> {
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
