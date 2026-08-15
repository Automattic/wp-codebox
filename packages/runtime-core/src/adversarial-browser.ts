import { createHash } from "node:crypto"

import type { BrowserActionCorpusDescriptor, BrowserInteractionStep } from "./browser-interaction.js"
import type { BrowserAccessibilityFinding } from "./browser-accessibility.js"

export const ADVERSARIAL_BROWSER_PLAN_SCHEMA = "wp-codebox/adversarial-browser-plan/v1" as const
export const ADVERSARIAL_BROWSER_ORACLE_RESULT_SCHEMA = "wp-codebox/adversarial-browser-oracle-result/v1" as const
export const CLOCK_CONTROL_CAPABILITIES_SCHEMA = "wp-codebox/clock-control-capabilities/v1" as const

export type AdversarialBrowserOracle = "crash" | "dead-control" | "stuck-interaction" | "layout" | "accessibility" | "duplicate-effect"

export interface AdversarialBrowserPlan {
  schema: typeof ADVERSARIAL_BROWSER_PLAN_SCHEMA
  seed: string
  startUrl: string
  steps: BrowserInteractionStep[]
  descriptorIds: string[]
  matrix: { viewport: "desktop" | "mobile"; locale: string; timezone: string; slowDevice: boolean }
  replay: { seed: string; startUrl: string; steps: BrowserInteractionStep[] }
}

export interface AdversarialBrowserObservation {
  pageErrors?: string[]
  consoleErrors?: string[]
  unhandledRejections?: string[]
  controls?: Array<{ id: string; expectedAction: boolean; actionObserved: boolean; disabled?: boolean }>
  loadingIndicators?: Array<{ id: string; visibleForMs: number }>
  boxes?: Array<{ id: string; x: number; y: number; width: number; height: number; viewportWidth: number; viewportHeight: number; focused?: boolean; visible?: boolean; clipped?: boolean }>
  accessibilityViolations?: Array<{ rule: string; target: string; impact?: string }>
  accessibilityFindings?: BrowserAccessibilityFinding[]
  effects?: Array<{ id: string; count: number; expectedMaximum?: number }>
}

export interface AdversarialBrowserOracleResult {
  schema: typeof ADVERSARIAL_BROWSER_ORACLE_RESULT_SCHEMA
  failed: boolean
  failures: Array<{ oracle: AdversarialBrowserOracle; code: string; message: string; target?: string }>
}

export interface ClockControlCapability {
  surface: "runtime" | "wordpress" | "browser" | "scheduler" | "database"
  freeze: boolean
  advance: boolean
  skew: boolean
  restore: boolean
  fidelity: "exact" | "emulated" | "unsupported"
  reason?: string
}

export interface ClockControlCapabilities {
  schema: typeof CLOCK_CONTROL_CAPABILITIES_SCHEMA
  adapter: string
  capabilities: ClockControlCapability[]
}

export function planAdversarialBrowserJourney(input: { seed: string; startUrl: string; descriptors: BrowserActionCorpusDescriptor[]; maxSteps?: number; locale?: string; timezone?: string }): AdversarialBrowserPlan {
  const maximum = Math.max(1, Math.min(input.maxSteps ?? 12, 100))
  const descriptors = input.descriptors.filter((item) => !item.disabled && !item.readonly && item.selector).sort((left, right) => seededOrder(input.seed, left.id) - seededOrder(input.seed, right.id) || left.id.localeCompare(right.id))
  const steps: BrowserInteractionStep[] = [{ kind: "navigate", url: input.startUrl, waitFor: "load" }]
  const descriptorIds: string[] = []
  for (const descriptor of descriptors) {
    if (steps.length >= maximum) break
    const generated = adversarialDescriptorSteps(descriptor, input.seed)
    for (const step of generated) {
      if (steps.length >= maximum) break
      steps.push(step)
      descriptorIds.push(descriptor.id)
    }
  }
  if (steps.length < maximum) steps.push({ kind: "capture" })
  const matrix = {
    viewport: seededOrder(input.seed, "viewport") % 2 === 0 ? "desktop" as const : "mobile" as const,
    locale: input.locale ?? "en-US",
    timezone: input.timezone ?? "UTC",
    slowDevice: seededOrder(input.seed, "device") % 2 === 0,
  }
  return { schema: ADVERSARIAL_BROWSER_PLAN_SCHEMA, seed: input.seed, startUrl: input.startUrl, steps: steps.slice(0, maximum), descriptorIds, matrix, replay: { seed: input.seed, startUrl: input.startUrl, steps: steps.slice(0, maximum) } }
}

export function evaluateAdversarialBrowserOracles(observation: AdversarialBrowserObservation, stuckThresholdMs = 10_000): AdversarialBrowserOracleResult {
  const failures: AdversarialBrowserOracleResult["failures"] = []
  for (const message of [...(observation.pageErrors ?? []), ...(observation.unhandledRejections ?? [])]) failures.push({ oracle: "crash", code: "browser-runtime-error", message })
  for (const message of observation.consoleErrors ?? []) failures.push({ oracle: "crash", code: "browser-console-error", message })
  for (const control of observation.controls ?? []) {
    if (control.expectedAction && !control.actionObserved && !control.disabled) failures.push({ oracle: "dead-control", code: "browser-dead-control", message: `Control ${control.id} accepted input without an observable action.`, target: control.id })
  }
  for (const indicator of observation.loadingIndicators ?? []) {
    if (indicator.visibleForMs >= stuckThresholdMs) failures.push({ oracle: "stuck-interaction", code: "browser-stuck-loading", message: `Loading indicator remained visible for ${indicator.visibleForMs}ms.`, target: indicator.id })
  }
  for (const box of observation.boxes ?? []) {
    const overflow = box.x < 0 || box.y < 0 || box.x + box.width > box.viewportWidth || box.y + box.height > box.viewportHeight
    if (overflow || box.clipped) failures.push({ oracle: "layout", code: "browser-layout-overflow", message: `Element ${box.id} is clipped or outside the viewport.`, target: box.id })
    if (box.focused && box.visible === false) failures.push({ oracle: "layout", code: "browser-invisible-focus", message: `Focused element ${box.id} is not visible.`, target: box.id })
  }
  for (const violation of observation.accessibilityViolations ?? []) failures.push({ oracle: "accessibility", code: `browser-a11y-${violation.rule}`, message: `Accessibility rule ${violation.rule} failed.`, target: violation.target })
  for (const finding of observation.accessibilityFindings ?? []) failures.push({ oracle: finding.oracle === "accessibility" ? "accessibility" : finding.oracle === "focus" ? "layout" : "dead-control", code: finding.code, message: `${finding.classification} (${finding.impact}).`, target: finding.target.locator })
  for (const effect of observation.effects ?? []) {
    if (effect.count > (effect.expectedMaximum ?? 1)) failures.push({ oracle: "duplicate-effect", code: "browser-duplicate-effect", message: `Effect ${effect.id} occurred ${effect.count} times.`, target: effect.id })
  }
  return { schema: ADVERSARIAL_BROWSER_ORACLE_RESULT_SCHEMA, failed: failures.length > 0, failures }
}

export async function minimizeAdversarialBrowserJourney(steps: BrowserInteractionStep[], preservesFailure: (candidate: BrowserInteractionStep[]) => Promise<boolean>): Promise<BrowserInteractionStep[]> {
  let current = [...steps]
  let chunk = Math.max(1, Math.floor(current.length / 2))
  while (current.length > 1 && chunk >= 1) {
    let reduced = false
    for (let start = 0; start < current.length; start += chunk) {
      const candidate = [...current.slice(0, start), ...current.slice(start + chunk)]
      if (candidate.length === 0) continue
      if (await preservesFailure(candidate)) { current = candidate; reduced = true; break }
    }
    if (!reduced) chunk = Math.floor(chunk / 2)
  }
  return current
}

export function clockControlCapabilities(adapter: string, capabilities: ClockControlCapability[]): ClockControlCapabilities {
  return { schema: CLOCK_CONTROL_CAPABILITIES_SCHEMA, adapter, capabilities }
}

function adversarialDescriptorSteps(descriptor: BrowserActionCorpusDescriptor, seed: string): BrowserInteractionStep[] {
  if (descriptor.kind === "input" || descriptor.kind === "textarea") {
    const values = ["", "A".repeat(4096), "\u202e\u2066hostile\u2069", "'\"<>\\", "😀".repeat(64)]
    const value = values[seededOrder(seed, descriptor.id) % values.length] as string
    return [{ kind: "fill", selector: descriptor.selector, value }]
  }
  if (descriptor.kind === "select") {
    const value = descriptor.optionValues?.[seededOrder(seed, descriptor.id) % Math.max(descriptor.optionValues.length, 1)]
    return value === undefined ? [] : [{ kind: "select", selector: descriptor.selector, value }]
  }
  if (descriptor.kind === "button") return [{ kind: "click", selector: descriptor.selector }, { kind: "click", selector: descriptor.selector }]
  if (descriptor.kind === "link") return [{ kind: "click", selector: descriptor.selector }]
  return []
}

function seededOrder(seed: string, value: string): number {
  return createHash("sha256").update(`${seed}:${value}`).digest().readUInt32BE(0)
}
