import { basename, join } from "node:path"
import type { BrowserInteractionStep } from "@automattic/wp-codebox-core"
import type { Frame, Page } from "playwright"
import { browserActionLoadState, browserDeepEqual, browserStepTimeoutMs, durationStringMs, sanitizeScreenshotName } from "./browser-actions.js"
import type { BrowserProbeErrorRecord, BrowserStepAssertion, BrowserStepReadiness, BrowserStepRecord } from "./browser-artifacts.js"

export interface BrowserStepOutcome {
  assertion?: BrowserStepAssertion
  readiness?: BrowserPaintedReadinessSummary
  screenshot?: string
  screenshotIsDefault?: boolean
  error?: BrowserProbeErrorRecord
}

type BrowserPaintedReadinessSummary = BrowserStepReadiness
type BrowserPaintedReadinessWait =
  | { mode: "page" }
  | { mode: "frame-selector"; selector: string }
  | { mode: "frame-url"; urlFragment: string }

interface BrowserPaintedReadinessTarget {
  mode: "page" | "frame-selector" | "frame-url"
  frame: Page | Frame
  selector?: string
  urlFragment?: string
}

const PAINTED_READINESS_SETTLE_MS = 750

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
      const readinessWait = parsePaintedReadinessWait(step.waitFor)
      if (readinessWait) {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout })
        return { readiness: await waitForPaintedReadiness(page, readinessWait, timeout) }
      }
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
      return await browserStepWaitFor(page, step, timeout)
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
      const readinessWait = parsePaintedReadinessWait(step.waitFor)
      const readiness = readinessWait ? await waitForPaintedReadiness(page, readinessWait, timeout) : undefined
      const path = typeof step.name === "string" && step.name.length > 0
        ? join(browserDirectory, `screenshot-${sanitizeScreenshotName(step.name)}.png`)
        : defaultScreenshotPath
      await page.screenshot({ path, fullPage: true })
      const isDefault = path === defaultScreenshotPath
      return {
        ...(readiness ? { readiness } : {}),
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

async function browserStepWaitFor(page: Page, step: BrowserInteractionStep, timeout: number): Promise<BrowserStepOutcome> {
  const readinessWait = parsePaintedReadinessWait(step.waitFor)
  if (readinessWait && typeof step.selector === "string" && step.selector.length > 0) {
    throw new Error("wordpress.browser-actions waitFor step cannot combine selector with painted readiness; use selector:<selector>, painted, frame-painted:<iframe-selector>, or frame-url-painted:<url-fragment>")
  }
  if (readinessWait) {
    return { readiness: await waitForPaintedReadiness(page, readinessWait, timeout) }
  }
  if (typeof step.selector === "string" && step.selector.length > 0) {
    await page.locator(step.selector).waitFor({ timeout })
    return {}
  }
  const waitFor: string = typeof step.waitFor === "string" ? step.waitFor : "load"
  if (waitFor === "domcontentloaded" || waitFor === "load" || waitFor === "networkidle") {
    await page.waitForLoadState(waitFor)
    return {}
  }
  if (waitFor === "duration") {
    await page.waitForTimeout(durationStringMs(step.duration))
    return {}
  }
  if (waitFor.startsWith("selector:")) {
    await page.locator(waitFor.slice("selector:".length)).waitFor({ timeout })
    return {}
  }
  throw new Error(`wordpress.browser-actions waitFor supports selector, domcontentloaded, load, networkidle, duration, selector:<sel>, painted, frame-painted:<iframe-selector>, frame-url-painted:<url-fragment>: ${waitFor}`)
}

function parsePaintedReadinessWait(waitFor: unknown): BrowserPaintedReadinessWait | undefined {
  if (waitFor === "painted") {
    return { mode: "page" }
  }
  if (typeof waitFor !== "string") {
    return undefined
  }
  if (waitFor.startsWith("frame-painted:")) {
    const selector = waitFor.slice("frame-painted:".length).trim()
    if (!selector) {
      throw new Error("wordpress.browser-actions frame-painted wait requires an iframe selector")
    }
    return { mode: "frame-selector", selector }
  }
  if (waitFor.startsWith("frame-url-painted:")) {
    const urlFragment = waitFor.slice("frame-url-painted:".length).trim()
    if (!urlFragment) {
      throw new Error("wordpress.browser-actions frame-url-painted wait requires a URL fragment")
    }
    return { mode: "frame-url", urlFragment }
  }
  return undefined
}

async function waitForPaintedReadiness(page: Page, waitFor: BrowserPaintedReadinessWait, timeout: number): Promise<BrowserPaintedReadinessSummary> {
  const startedAt = Date.now()
  const deadline = startedAt + timeout
  const target = await paintedReadinessTarget(page, waitFor, deadline)
  const result = await target.frame.waitForFunction(() => {
    let visibleElementCount = 0
    let textLength = 0
    let paintedBoxCount = 0
    for (const element of document.body?.querySelectorAll("*") ?? []) {
      const rect = element.getBoundingClientRect()
      const computed = window.getComputedStyle(element)
      if (rect.width <= 0 || rect.height <= 0 || computed.display === "none" || computed.visibility === "hidden" || computed.opacity === "0") {
        continue
      }
      visibleElementCount += 1
      textLength += (element.textContent || "").replace(/\s+/g, " ").trim().length
      if (computed.backgroundColor !== "rgba(0, 0, 0, 0)" || computed.backgroundImage !== "none" || Number.parseFloat(computed.borderTopWidth || "0") > 0 || Number.parseFloat(computed.borderRightWidth || "0") > 0 || Number.parseFloat(computed.borderBottomWidth || "0") > 0 || Number.parseFloat(computed.borderLeftWidth || "0") > 0) {
        paintedBoxCount += 1
      }
      if (textLength > 0 || paintedBoxCount > 0) {
        return { visibleElementCount, textLength, paintedBoxCount }
      }
    }
    return false
  }, undefined, { polling: 100, timeout: remainingTimeoutMs(deadline) })
  const summary = await result.jsonValue() as { visibleElementCount: number; textLength: number; paintedBoxCount: number }
  await settleAnimationFrames(target.frame, Math.min(PAINTED_READINESS_SETTLE_MS, remainingTimeoutMs(deadline)))
  return {
    mode: target.mode,
    ...(target.selector ? { selector: target.selector } : {}),
    ...(target.urlFragment ? { urlFragment: target.urlFragment } : {}),
    ready: true,
    criteria: "visible-content-or-painted-box/v1",
    waitedMs: Math.max(0, Date.now() - startedAt),
    visibleElementCount: summary.visibleElementCount,
    textLength: summary.textLength,
    paintedBoxCount: summary.paintedBoxCount,
    ...(target.frame.url() ? { frameUrl: target.frame.url() } : {}),
  }
}

async function paintedReadinessTarget(page: Page, waitFor: BrowserPaintedReadinessWait, deadline: number): Promise<BrowserPaintedReadinessTarget> {
  if (waitFor.mode === "page") {
    return { mode: "page", frame: page }
  }
  if (waitFor.mode === "frame-selector") {
    const locator = page.locator(waitFor.selector).first()
    await locator.waitFor({ state: "attached", timeout: remainingTimeoutMs(deadline) })
    const frame = await waitForContentFrame(locator, deadline)
    return { mode: "frame-selector", frame, selector: waitFor.selector }
  }
  if (waitFor.mode === "frame-url") {
    while (remainingTimeoutMs(deadline) > 0) {
      const frame = page.frames().find((candidate) => candidate !== page.mainFrame() && candidate.url().includes(waitFor.urlFragment))
      if (frame) {
        return { mode: "frame-url", frame, urlFragment: waitFor.urlFragment }
      }
      await page.waitForTimeout(100)
    }
    throw new Error(`wordpress.browser-actions frame-url-painted wait could not resolve iframe URL fragment: ${waitFor.urlFragment}`)
  }
  throw new Error("Unsupported painted readiness wait")
}

async function waitForContentFrame(locator: ReturnType<Page["locator"]>, deadline: number): Promise<Frame> {
  while (remainingTimeoutMs(deadline) > 0) {
    const handle = await locator.elementHandle({ timeout: remainingTimeoutMs(deadline) })
    try {
      const frame = await handle?.contentFrame()
      if (frame) {
        return frame
      }
    } finally {
      await handle?.dispose()
    }
    await locator.page().waitForTimeout(100)
  }
  throw new Error("wordpress.browser-actions frame-painted wait could not resolve iframe content frame")
}

async function settleAnimationFrames(frame: Page | Frame, timeout: number): Promise<void> {
  await Promise.race([
    frame.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))),
    new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, timeout))),
  ])
}

function remainingTimeoutMs(deadline: number): number {
  return Math.max(1, deadline - Date.now())
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
    ...(outcome.readiness ? { readiness: outcome.readiness } : {}),
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
  const failed = results.filter((assertion) => !assertion.passed).length
  const advisoryFailed = results.filter((assertion) => !assertion.passed && assertion.advisory).length
  return {
    total: results.length,
    passed,
    failed,
    advisoryFailed,
    fatalFailed: failed - advisoryFailed,
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
