import { basename, join } from "node:path"
import type { BrowserInteractionStep } from "@automattic/wp-codebox-core"
import type { Page } from "playwright"
import { browserActionLoadState, browserDeepEqual, browserStepTimeoutMs, durationStringMs, sanitizeScreenshotName } from "./browser-actions.js"
import type { BrowserProbeErrorRecord, BrowserStepAssertion, BrowserStepRecord } from "./browser-artifacts.js"

export interface BrowserStepOutcome {
  assertion?: BrowserStepAssertion
  screenshot?: string
  screenshotIsDefault?: boolean
  error?: BrowserProbeErrorRecord
}

function now(): string {
  return new Date().toISOString()
}

export async function executeBrowserInteractionStep(
  page: Page,
  step: BrowserInteractionStep,
  baseUrl: string,
  stepTimeoutMs: number,
  defaultScreenshotPath: string,
  browserDirectory: string,
): Promise<BrowserStepOutcome> {
  const timeout = browserStepTimeoutMs(step, stepTimeoutMs)

  switch (step.kind) {
    case "navigate": {
      const url = resolveBrowserActionUrl((step.url ?? "").trim(), baseUrl)
      await page.goto(url, { waitUntil: browserActionLoadState(step.waitFor), timeout })
      return {}
    }
    case "click": {
      await browserStepLocator(page, step).click({ timeout })
      return {}
    }
    case "hover": {
      await browserStepLocator(page, step).hover({ timeout })
      return {}
    }
    case "fill": {
      await page.locator(requireSelector(step, "fill")).fill(String(step.value ?? ""), { timeout })
      return {}
    }
    case "type": {
      const locator = page.locator(requireSelector(step, "type"))
      await locator.click({ timeout })
      await locator.pressSequentially(String(step.value ?? ""), { timeout })
      return {}
    }
    case "press": {
      const key = String(step.key ?? "")
      if (typeof step.selector === "string" && step.selector.length > 0) {
        await page.locator(step.selector).press(key, { timeout })
      } else {
        await page.keyboard.press(key)
      }
      return {}
    }
    case "drag": {
      const source = page.locator(requireFrom(step))
      if (step.to && "selector" in step.to) {
        await source.dragTo(page.locator(step.to.selector), { timeout })
      } else if (step.to) {
        const box = await source.boundingBox({ timeout })
        const startX = box ? box.x + box.width / 2 : 0
        const startY = box ? box.y + box.height / 2 : 0
        await page.mouse.move(startX, startY)
        await page.mouse.down()
        await page.mouse.move(step.to.x, step.to.y, { steps: 8 })
        await page.mouse.up()
      }
      return {}
    }
    case "select": {
      const locator = page.locator(requireSelector(step, "select"))
      const values = Array.isArray(step.values) ? step.values : [String(step.value ?? "")]
      await locator.selectOption(values, { timeout })
      return {}
    }
    case "waitFor": {
      await browserStepWaitFor(page, step, timeout)
      return {}
    }
    case "evaluate": {
      const result = await page.evaluate(async (source) => {
        // Support both a bare expression ("a.b.c") and a multi-statement body
        // that returns explicitly. If the source already returns, run it as a
        // body; otherwise evaluate it as an expression and return its value.
        const body = /(^|[^.\w])return[\s(;]/.test(source) ? source : `return (\n${source}\n)`
        const run = new Function(`return (async () => {\n${body}\n})()`)
        return run()
      }, String(step.expression ?? ""))
      if (Object.prototype.hasOwnProperty.call(step, "assert")) {
        const passed = browserDeepEqual(result, step.assert)
        return {
          assertion: { kind: "evaluate", expression: step.expression, expected: step.assert, actual: result, passed },
        }
      }
      return {}
    }
    case "expect": {
      const selector = requireSelector(step, "expect")
      const state = step.state ?? "visible"
      const passed = await browserExpectState(page, selector, state, timeout)
      return { assertion: { kind: "expect", selector, state, passed } }
    }
    case "screenshot": {
      const path = typeof step.name === "string" && step.name.length > 0
        ? join(browserDirectory, `screenshot-${sanitizeScreenshotName(step.name)}.png`)
        : defaultScreenshotPath
      await page.screenshot({ path, fullPage: true })
      const isDefault = path === defaultScreenshotPath
      return {
        screenshot: isDefault ? "files/browser/screenshot.png" : `files/browser/${basename(path)}`,
        screenshotIsDefault: isDefault,
      }
    }
    case "capture":
      return {}
  }

  throw new Error(`wordpress.browser-actions step kind is not supported: ${step.kind}`)
}

function browserStepLocator(page: Page, step: BrowserInteractionStep) {
  if (typeof step.selector === "string" && step.selector.length > 0) {
    return page.locator(step.selector)
  }
  if (typeof step.text === "string" && step.text.length > 0) {
    return page.getByText(step.text)
  }
  throw new Error(`wordpress.browser-actions ${step.kind} requires selector or text`)
}

function requireSelector(step: BrowserInteractionStep, kind: string): string {
  if (typeof step.selector !== "string" || step.selector.length === 0) {
    throw new Error(`wordpress.browser-actions ${kind} requires selector`)
  }
  return step.selector
}

function requireFrom(step: BrowserInteractionStep): string {
  if (typeof step.from !== "string" || step.from.length === 0) {
    throw new Error("wordpress.browser-actions drag requires from selector")
  }
  return step.from
}

async function browserStepWaitFor(page: Page, step: BrowserInteractionStep, timeout: number): Promise<void> {
  if (typeof step.selector === "string" && step.selector.length > 0) {
    await page.locator(step.selector).waitFor({ timeout })
    return
  }
  const waitFor = typeof step.waitFor === "string" ? step.waitFor : "load"
  if (waitFor === "domcontentloaded" || waitFor === "load" || waitFor === "networkidle") {
    await page.waitForLoadState(waitFor)
    return
  }
  if (waitFor === "duration") {
    await page.waitForTimeout(durationStringMs(step.duration))
    return
  }
  if (waitFor.startsWith("selector:")) {
    await page.locator(waitFor.slice("selector:".length)).waitFor({ timeout })
    return
  }
  throw new Error(`wordpress.browser-actions waitFor supports selector, domcontentloaded, load, networkidle, duration, selector:<sel>: ${waitFor}`)
}

async function browserExpectState(page: Page, selector: string, state: string, timeout: number): Promise<boolean> {
  const locator = page.locator(selector)
  try {
    switch (state) {
      case "visible":
      case "hidden":
      case "attached":
      case "detached":
        await locator.waitFor({ state, timeout })
        return true
      case "enabled":
        await locator.waitFor({ state: "visible", timeout })
        return await locator.isEnabled()
      case "disabled":
        await locator.waitFor({ state: "visible", timeout })
        return await locator.isDisabled()
      case "checked":
        await locator.waitFor({ state: "visible", timeout })
        return await locator.isChecked()
      case "unchecked":
        await locator.waitFor({ state: "visible", timeout })
        return !(await locator.isChecked())
      case "editable":
        await locator.waitFor({ state: "visible", timeout })
        return await locator.isEditable()
      default:
        return false
    }
  } catch {
    return false
  }
}

export function browserStepRecord(
  index: number,
  step: BrowserInteractionStep,
  status: BrowserStepRecord["status"],
  startedAt: string,
  startedAtMs: number,
  finalUrl: string,
  outcome: BrowserStepOutcome,
): BrowserStepRecord {
  return {
    index,
    kind: step.kind,
    status,
    startedAt,
    finishedAt: now(),
    durationMs: Math.max(0, Date.now() - startedAtMs),
    ...(typeof step.url === "string" ? { url: step.url } : {}),
    ...(typeof step.selector === "string" ? { selector: step.selector } : {}),
    ...(typeof step.text === "string" ? { text: step.text } : {}),
    ...(typeof step.key === "string" ? { key: step.key } : {}),
    ...(typeof step.waitFor === "string" ? { waitFor: step.waitFor } : {}),
    ...(typeof step.duration === "string" ? { duration: step.duration } : {}),
    ...(outcome.assertion ? { assertion: outcome.assertion } : {}),
    ...(outcome.screenshot ? { screenshot: outcome.screenshot } : {}),
    finalUrl,
    ...(outcome.error ? { error: outcome.error } : {}),
  }
}

export function browserAssertionsSummary(records: BrowserStepRecord[]) {
  const results = records
    .map((record) => record.assertion)
    .filter((assertion): assertion is BrowserStepAssertion => assertion !== undefined)
  const passed = results.filter((assertion) => assertion.passed).length
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    results,
  }
}

function resolveBrowserActionUrl(pathOrUrl: string, baseUrl: string): string {
  try {
    return new URL(pathOrUrl).toString()
  } catch {
    return new URL(pathOrUrl, baseUrl).toString()
  }
}
