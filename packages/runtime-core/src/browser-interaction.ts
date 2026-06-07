import { isPlainObject } from "./object-utils.js"

export const BROWSER_INTERACTION_SCRIPT_SCHEMA = "wp-codebox/browser-interaction-script/v1" as const

/**
 * Backend-agnostic browser interaction step contract (issue #310).
 *
 * runtime-core declares the schema; a runtime backend (e.g. runtime-playground)
 * implements the executor that maps each step onto its driver. Steps are a thin,
 * stable mapping over locator-style actions — not a test-runner DSL.
 *
 * Layer purity: this type knows nothing about Playwright or Playground. It is the
 * shared contract any backend can satisfy.
 */
export const BROWSER_INTERACTION_STEP_KINDS = [
  "navigate",
  "click",
  "fill",
  "type",
  "press",
  "drag",
  "hover",
  "select",
  "waitFor",
  "evaluate",
  "expect",
  "screenshot",
  "capture",
] as const

export type BrowserInteractionStepKind = typeof BROWSER_INTERACTION_STEP_KINDS[number]

/** Locator/element state checked by an `expect` step. */
export const BROWSER_INTERACTION_EXPECT_STATES = ["visible", "hidden", "attached", "detached", "enabled", "disabled", "checked", "unchecked", "editable"] as const

export type BrowserInteractionExpectState = typeof BROWSER_INTERACTION_EXPECT_STATES[number]

/** Drop target for a `drag` step: an element selector or absolute viewport coordinates. */
export type BrowserInteractionDragTarget = { selector: string } | { x: number; y: number }

export interface BrowserInteractionStep {
  kind: BrowserInteractionStepKind
  /** Stable locator string (CSS, `text=`, `role=button[name='...']`, etc.). */
  selector?: string
  /** Navigation target for `navigate`. */
  url?: string
  /** Visible-text locator shortcut for `click`/`hover`. */
  text?: string
  /** Input value for `fill`/`type`, or option value for `select`. */
  value?: string
  /** Keyboard key for `press`. */
  key?: string
  /** Wait/load condition: domcontentloaded|load|networkidle|selector:<sel>|duration|painted|frame-painted:<iframe-selector>|frame-url-painted:<url-fragment>. */
  waitFor?: string
  /** Drag source selector for `drag`. */
  from?: string
  /** Drag drop target for `drag`. */
  to?: BrowserInteractionDragTarget
  /** Option label/value(s) for `select`. */
  values?: string[]
  /** Arbitrary page JS for `evaluate` (policy-gated separately). */
  expression?: string
  /** Optional expected value an `evaluate` result must deep-equal to assert. */
  assert?: unknown
  /** Expected locator state for `expect`. */
  state?: BrowserInteractionExpectState
  /** Optional screenshot name for `screenshot`; screenshot steps may also use waitFor for painted-readiness waits before capture. */
  name?: string
  /** Optional wait duration (e.g. 500ms, 2s) for `waitFor`/`navigate`. */
  duration?: string
  /** Per-step timeout override (e.g. 5s). */
  timeout?: string
}

export interface BrowserInteractionStepValidationIssue {
  index: number
  message: string
}

export interface BrowserInteractionScriptValidationResult {
  valid: boolean
  steps: BrowserInteractionStep[]
  issues: BrowserInteractionStepValidationIssue[]
}

function isBrowserInteractionDragTarget(value: unknown): value is BrowserInteractionDragTarget {
  if (!isPlainObject(value)) return false
  if (typeof value.selector === "string" && value.selector.length > 0) return true
  return typeof value.x === "number" && typeof value.y === "number"
}

/**
 * Validate an ordered browser interaction script against the backend-agnostic
 * step contract. Returns normalized steps plus per-index issues; backends call
 * this before executing so every backend enforces the same contract.
 */
export function validateBrowserInteractionScript(input: unknown): BrowserInteractionScriptValidationResult {
  const issues: BrowserInteractionStepValidationIssue[] = []
  const steps: BrowserInteractionStep[] = []

  if (!Array.isArray(input)) {
    return { valid: false, steps, issues: [{ index: -1, message: "browser interaction script must be a JSON array of steps" }] }
  }

  input.forEach((raw, index) => {
    if (!isPlainObject(raw)) {
      issues.push({ index, message: "step must be an object" })
      return
    }

    const kind = raw.kind
    if (typeof kind !== "string" || !(BROWSER_INTERACTION_STEP_KINDS as readonly string[]).includes(kind)) {
      issues.push({ index, message: `step kind must be one of ${BROWSER_INTERACTION_STEP_KINDS.join(", ")}` })
      return
    }

    const step = raw as unknown as BrowserInteractionStep
    const hasSelector = typeof step.selector === "string" && step.selector.length > 0
    const hasText = typeof step.text === "string" && step.text.length > 0

    switch (kind as BrowserInteractionStepKind) {
      case "navigate":
        if (typeof step.url !== "string" || step.url.trim().length === 0) {
          issues.push({ index, message: "navigate step requires url" })
        }
        break
      case "click":
      case "hover":
        if (!hasSelector && !hasText) {
          issues.push({ index, message: `${kind} step requires selector or text` })
        }
        break
      case "fill":
      case "type":
        if (!hasSelector) issues.push({ index, message: `${kind} step requires selector` })
        if (typeof step.value !== "string") issues.push({ index, message: `${kind} step requires value` })
        break
      case "press":
        if (typeof step.key !== "string" || step.key.length === 0) {
          issues.push({ index, message: "press step requires key" })
        }
        break
      case "drag":
        if (typeof step.from !== "string" || step.from.length === 0) {
          issues.push({ index, message: "drag step requires from selector" })
        }
        if (!isBrowserInteractionDragTarget(step.to)) {
          issues.push({ index, message: "drag step requires to as { selector } or { x, y }" })
        }
        break
      case "select":
        if (!hasSelector) issues.push({ index, message: "select step requires selector" })
        if (typeof step.value !== "string" && !Array.isArray(step.values)) {
          issues.push({ index, message: "select step requires value or values" })
        }
        break
      case "waitFor":
        if (!hasSelector && typeof step.waitFor !== "string") {
          issues.push({ index, message: "waitFor step requires selector or waitFor condition" })
        }
        break
      case "evaluate":
        if (typeof step.expression !== "string" || step.expression.trim().length === 0) {
          issues.push({ index, message: "evaluate step requires expression" })
        }
        break
      case "expect":
        if (!hasSelector) issues.push({ index, message: "expect step requires selector" })
        if (step.state !== undefined && !(BROWSER_INTERACTION_EXPECT_STATES as readonly string[]).includes(step.state)) {
          issues.push({ index, message: `expect step state must be one of ${BROWSER_INTERACTION_EXPECT_STATES.join(", ")}` })
        }
        break
      case "screenshot":
      case "capture":
        break
    }

    steps.push(step)
  })

  return { valid: issues.length === 0, steps, issues }
}

/** True when an interaction script contains at least one policy-gated evaluate step. */
export function browserInteractionScriptUsesEvaluate(steps: readonly BrowserInteractionStep[]): boolean {
  return steps.some((step) => step.kind === "evaluate")
}
