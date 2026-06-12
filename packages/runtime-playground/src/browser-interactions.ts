import { basename, join } from "node:path"
import type { BrowserInteractionStep } from "@automattic/wp-codebox-core"
import type { Frame, Page } from "playwright"
import { browserActionLoadState, browserDeepEqual, browserStepTimeoutMs, durationStringMs, sanitizeScreenshotName } from "./browser-actions.js"
import type { BrowserProbeErrorRecord, BrowserStepAssertion, BrowserStepReadiness, BrowserStepRecord } from "./browser-artifacts.js"
import { browserCommandLivenessPolicy, withBrowserCommandLiveness } from "./browser-liveness.js"

export interface BrowserStepOutcome {
  assertion?: BrowserStepAssertion
  readiness?: BrowserPaintedReadinessSummary
  target?: BrowserStepRecord["target"]
  screenshot?: string
  screenshotIsDefault?: boolean
  error?: BrowserProbeErrorRecord
}

type BrowserPaintedReadinessSummary = BrowserStepReadiness
type BrowserPaintedReadinessWait = "painted" | `frame-painted:${string}` | `frame-url-painted:${string}`

interface BrowserPaintedReadinessTarget {
  mode: "page" | "frame-selector" | "frame-url"
  frame: Page | Frame
  selector?: string
  urlFragment?: string
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
      const waitFor = step.waitFor
      if (isPaintedReadinessWait(waitFor)) {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout })
        return { readiness: await waitForPaintedReadiness(page, waitFor, timeout) }
      }
      await page.goto(url, { waitUntil: browserActionLoadState(waitFor), timeout })
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
      const readiness = isPaintedReadinessWait(step.waitFor) ? await waitForPaintedReadiness(page, step.waitFor, timeout) : undefined
      const path = typeof step.name === "string" && step.name.length > 0
        ? join(browserDirectory, `screenshot-${sanitizeScreenshotName(step.name)}.png`)
        : defaultScreenshotPath
      const frameTarget = await screenshotFrameTarget(page, step, timeout)
      if (frameTarget) {
        await frameTarget.frame.locator("html").first().screenshot({ path, timeout })
      } else {
        await page.screenshot({ path, fullPage: true })
      }
      const isDefault = path === defaultScreenshotPath
      return {
        ...(readiness ? { readiness } : {}),
        ...(frameTarget ? { target: { mode: frameTarget.mode as "frame-selector" | "frame-url", ...(frameTarget.selector ? { selector: frameTarget.selector } : {}), ...(frameTarget.urlFragment ? { urlFragment: frameTarget.urlFragment } : {}), ...(frameTarget.frame.url() ? { frameUrl: frameTarget.frame.url() } : {}) } } : {}),
        screenshot: isDefault ? "files/browser/screenshot.png" : `files/browser/${basename(path)}`,
        screenshotIsDefault: isDefault,
      }
    }
    case "capture":
      return {}
  }

  throw new Error(`wordpress.browser-actions step kind is not supported: ${step.kind}`)
}

async function screenshotFrameTarget(page: Page, step: BrowserInteractionStep, timeout: number): Promise<BrowserPaintedReadinessTarget | null> {
  if (typeof step.frameSelector === "string" && step.frameSelector.trim().length > 0) {
    const selector = step.frameSelector.trim()
    const locator = page.locator(selector).first()
    await locator.waitFor({ state: "attached", timeout })
    const handle = await locator.elementHandle({ timeout })
    const frame = await handle?.contentFrame()
    if (!frame) {
      throw new Error(`wordpress.browser-actions screenshot could not resolve iframe: ${selector}`)
    }
    return { mode: "frame-selector", frame, selector }
  }

  if (typeof step.frameUrl === "string" && step.frameUrl.trim().length > 0) {
    const urlFragment = step.frameUrl.trim()
    const deadline = Date.now() + timeout
    while (Date.now() <= deadline) {
      const frame = page.frames().find((candidate) => candidate !== page.mainFrame() && candidate.url().includes(urlFragment))
      if (frame) {
        return { mode: "frame-url", frame, urlFragment }
      }
      await page.waitForTimeout(100)
    }
    throw new Error(`wordpress.browser-actions screenshot could not resolve iframe URL fragment: ${urlFragment}`)
  }

  return null
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
  if (typeof step.selector === "string" && step.selector.length > 0) {
    await page.locator(step.selector).waitFor({ timeout })
    return {}
  }
  const waitFor: string = typeof step.waitFor === "string" ? step.waitFor : "load"
  if (isPaintedReadinessWait(waitFor)) {
    return { readiness: await waitForPaintedReadiness(page, waitFor, timeout) }
  }
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

function isPaintedReadinessWait(waitFor: unknown): waitFor is BrowserPaintedReadinessWait {
  return waitFor === "painted" || (typeof waitFor === "string" && (waitFor.startsWith("frame-painted:") || waitFor.startsWith("frame-url-painted:")))
}

async function waitForPaintedReadiness(page: Page, waitFor: BrowserPaintedReadinessWait, timeout: number): Promise<BrowserPaintedReadinessSummary> {
  const startedAt = Date.now()
  const target = await paintedReadinessTarget(page, waitFor, timeout)
  const result = await target.frame.waitForFunction(() => {
    const visible = Array.from(document.body?.querySelectorAll("*") ?? [])
      .map((element) => {
        const rect = element.getBoundingClientRect()
        const computed = window.getComputedStyle(element)
        if (rect.width <= 0 || rect.height <= 0 || computed.display === "none" || computed.visibility === "hidden" || computed.opacity === "0") {
          return null
        }
        const text = (element.textContent || "").replace(/\s+/g, " ").trim()
        const hasPaintedBox = computed.backgroundColor !== "rgba(0, 0, 0, 0)" || computed.backgroundImage !== "none" || Number.parseFloat(computed.borderTopWidth || "0") > 0 || Number.parseFloat(computed.borderRightWidth || "0") > 0 || Number.parseFloat(computed.borderBottomWidth || "0") > 0 || Number.parseFloat(computed.borderLeftWidth || "0") > 0
        return { textLength: text.length, hasPaintedBox }
      })
      .filter((entry): entry is { textLength: number; hasPaintedBox: boolean } => Boolean(entry))
    const visibleElementCount = visible.length
    const textLength = visible.reduce((total, entry) => total + entry.textLength, 0)
    const paintedBoxCount = visible.filter((entry) => entry.hasPaintedBox).length
    if (visibleElementCount === 0 || (textLength === 0 && paintedBoxCount === 0)) {
      return false
    }
    return { visibleElementCount, textLength }
  }, undefined, { timeout })
  const summary = await result.jsonValue() as { visibleElementCount: number; textLength: number }
  await withBrowserCommandLiveness({
    command: "wordpress.browser-actions",
    phase: "painted-readiness-stabilization",
    operation: target.frame.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))),
    policy: { wallTimeoutMs: browserCommandLivenessPolicy().readinessStabilizationTimeoutMs, idleTimeoutMs: 0 },
  })
  return {
    mode: target.mode,
    ...(target.selector ? { selector: target.selector } : {}),
    ...(target.urlFragment ? { urlFragment: target.urlFragment } : {}),
    ready: true,
    waitedMs: Math.max(0, Date.now() - startedAt),
    visibleElementCount: summary.visibleElementCount,
    textLength: summary.textLength,
    ...(target.frame.url() ? { frameUrl: target.frame.url() } : {}),
  }
}

async function paintedReadinessTarget(page: Page, waitFor: BrowserPaintedReadinessWait, timeout: number): Promise<BrowserPaintedReadinessTarget> {
  if (waitFor === "painted") {
    return { mode: "page", frame: page }
  }
  if (waitFor.startsWith("frame-painted:")) {
    const selector = waitFor.slice("frame-painted:".length).trim()
    if (!selector) {
      throw new Error("wordpress.browser-actions frame-painted wait requires an iframe selector")
    }
    const locator = page.locator(selector).first()
    await locator.waitFor({ state: "attached", timeout })
    const handle = await locator.elementHandle({ timeout })
    const frame = await handle?.contentFrame()
    if (!frame) {
      throw new Error(`wordpress.browser-actions frame-painted wait could not resolve iframe: ${selector}`)
    }
    return { mode: "frame-selector", frame, selector }
  }
  if (waitFor.startsWith("frame-url-painted:")) {
    const urlFragment = waitFor.slice("frame-url-painted:".length).trim()
    if (!urlFragment) {
      throw new Error("wordpress.browser-actions frame-url-painted wait requires a URL fragment")
    }
    const deadline = Date.now() + timeout
    while (Date.now() <= deadline) {
      const frame = page.frames().find((candidate) => candidate !== page.mainFrame() && candidate.url().includes(urlFragment))
      if (frame) {
        return { mode: "frame-url", frame, urlFragment }
      }
      await page.waitForTimeout(100)
    }
    throw new Error(`wordpress.browser-actions frame-url-painted wait could not resolve iframe URL fragment: ${urlFragment}`)
  }
  throw new Error(`Unsupported painted readiness wait: ${waitFor}`)
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
    ...(outcome.target ? { target: outcome.target } : {}),
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
