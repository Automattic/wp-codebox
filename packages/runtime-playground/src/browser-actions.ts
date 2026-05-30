import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { validateBrowserInteractionScript, type BrowserInteractionStep } from "@chubes4/wp-codebox-core"
import { argValue, jsonArrayArg } from "./commands.js"

export type BrowserActionInput = Record<string, unknown> & { type: string }

export async function browserInteractionStepsFromArgs(args: string[]): Promise<BrowserInteractionStep[]> {
  const stepsRaw = argValue(args, "steps-json")
  if (typeof stepsRaw === "string" && stepsRaw.trim().length > 0) {
    const parsed = await parseBrowserStepsPayload(stepsRaw.trim(), "steps-json")
    const result = validateBrowserInteractionScript(parsed)
    if (!result.valid) {
      throw new Error(`wordpress.browser-actions steps-json is invalid: ${result.issues.map((issue) => `[${issue.index}] ${issue.message}`).join("; ")}`)
    }
    return result.steps
  }

  // Back-compat: accept the legacy actions-json shape and normalize it to steps.
  return browserActionsFromArgs(args).map(normalizeLegacyBrowserAction)
}

async function parseBrowserStepsPayload(raw: string, name: string): Promise<unknown> {
  let text = raw
  if (raw.startsWith("@")) {
    const path = raw.slice(1)
    text = await readFile(resolve(path), "utf8")
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`${name} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Normalize a legacy actions-json action into the steps contract. */
function normalizeLegacyBrowserAction(action: BrowserActionInput): BrowserInteractionStep {
  const kind = action.type === "wait" ? "waitFor" : (action.type as BrowserInteractionStep["kind"])
  const step: BrowserInteractionStep = { kind }
  if (typeof action.url === "string") step.url = action.url
  if (typeof action.selector === "string") step.selector = action.selector
  if (typeof action.text === "string") step.text = action.text
  if (typeof action.value === "string") step.value = action.value
  if (typeof action.key === "string") step.key = action.key
  if (typeof action.waitFor === "string") step.waitFor = action.waitFor
  if (typeof action.duration === "string") step.duration = action.duration
  return step
}

function browserActionsFromArgs(args: string[]): BrowserActionInput[] {
  return jsonArrayArg(args, "actions-json").map((action, index) => {
    if (!action || typeof action !== "object" || Array.isArray(action)) {
      throw new Error(`wordpress.browser-actions actions-json[${index}] must be an object`)
    }
    const typedAction = action as BrowserActionInput
    if (typeof typedAction.type !== "string" || typedAction.type.length === 0) {
      throw new Error(`wordpress.browser-actions actions-json[${index}].type is required`)
    }
    return typedAction
  })
}

export function browserActionLoadState(waitFor: unknown): "domcontentloaded" | "load" | "networkidle" {
  if (waitFor === undefined || waitFor === null || waitFor === "") {
    return "domcontentloaded"
  }
  if (waitFor === "domcontentloaded" || waitFor === "load" || waitFor === "networkidle") {
    return waitFor
  }
  throw new Error(`wordpress.browser-actions navigate waitFor supports domcontentloaded, load, networkidle: ${waitFor}`)
}

export function browserStepTimeoutMs(step: BrowserInteractionStep, fallbackMs: number): number {
  if (typeof step.timeout === "string" && step.timeout.length > 0) {
    return durationStringMs(step.timeout)
  }
  return fallbackMs
}

export function durationStringMs(raw: string | undefined): number {
  if (!raw) {
    return 0
  }
  const match = raw.trim().match(/^(\d+(?:\.\d+)?)(ms|s)$/)
  if (!match) {
    throw new Error(`wordpress.browser-actions duration must be a duration like 500ms or 2s: ${raw}`)
  }
  const value = Number.parseFloat(match[1])
  return Math.max(0, Math.round(match[2] === "ms" ? value : value * 1000))
}

export function sanitizeScreenshotName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "step"
}

export function browserDeepEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b)
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null"
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`
  }
  const keys = Object.keys(value as Record<string, unknown>).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(",")}}`
}
