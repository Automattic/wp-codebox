import { readFile } from "node:fs/promises"
import { resolveCommandPath, validateBrowserInteractionScript, type BrowserInteractionStep } from "@automattic/wp-codebox-core"
import { argValue } from "./commands.js"

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

  return []
}

async function parseBrowserStepsPayload(raw: string, name: string): Promise<unknown> {
  let text = raw
  let sourcePath: string | undefined
  if (raw.startsWith("@")) {
    sourcePath = resolveCommandPath(raw.slice(1))
    try {
      text = await readFile(sourcePath, "utf8")
    } catch (error) {
      throw new Error(`${name} could not read ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`${name} must be valid JSON${sourcePath ? ` from ${sourcePath}` : ""}: ${error instanceof Error ? error.message : String(error)}`)
  }
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
