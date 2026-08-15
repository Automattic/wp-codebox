import { clockControlCapabilities, type ClockControlCapabilities } from "@automattic/wp-codebox-core"
import type { Page } from "playwright"

export const PLAYWRIGHT_CLOCK_CONTROL_CAPABILITIES: ClockControlCapabilities = clockControlCapabilities("playwright", [
  { surface: "browser", freeze: true, advance: true, skew: true, restore: true, fidelity: "exact" },
  { surface: "runtime", freeze: false, advance: false, skew: false, restore: false, fidelity: "unsupported", reason: "Browser clock control does not alter the server process clock." },
  { surface: "wordpress", freeze: false, advance: false, skew: false, restore: false, fidelity: "unsupported", reason: "Browser clock control does not alter WordPress API clock seams." },
  { surface: "scheduler", freeze: false, advance: false, skew: false, restore: false, fidelity: "unsupported", reason: "Server scheduler control requires a runtime extension." },
  { surface: "database", freeze: false, advance: false, skew: false, restore: false, fidelity: "unsupported", reason: "Browser clock control does not alter database time functions." },
])

export interface BrowserClockController {
  capabilities: ClockControlCapabilities
  freeze(time: number | string | Date): Promise<void>
  advance(milliseconds: number): Promise<void>
  skew(time: number | string | Date): Promise<void>
  restore(): Promise<void>
}

export function createBrowserClockController(page: Page, initialTime: number | string | Date = Date.now()): BrowserClockController {
  let installed = false
  return {
    capabilities: PLAYWRIGHT_CLOCK_CONTROL_CAPABILITIES,
    async freeze(time) {
      if (!installed) { await page.clock.install({ time: initialTime }); installed = true }
      await page.clock.pauseAt(time)
    },
    async advance(milliseconds) {
      if (!installed) { await page.clock.install({ time: initialTime }); installed = true }
      await page.clock.fastForward(milliseconds)
    },
    async skew(time) {
      if (!installed) { await page.clock.install({ time: initialTime }); installed = true }
      await page.clock.setSystemTime(time)
    },
    async restore() {
      if (installed) await page.clock.resume()
    },
  }
}
