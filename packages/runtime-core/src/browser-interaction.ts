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

export const BROWSER_RANDOM_WALK_SCHEMA = "wp-codebox/browser-random-walk/v1" as const

export const BROWSER_RANDOM_WALK_CONTEXTS = ["browser", "admin", "editor"] as const
export type BrowserRandomWalkContext = typeof BROWSER_RANDOM_WALK_CONTEXTS[number]

export const BROWSER_RANDOM_WALK_ACTION_FAMILIES = ["click", "fill", "press", "select", "navigate", "capture"] as const
export type BrowserRandomWalkActionFamily = typeof BROWSER_RANDOM_WALK_ACTION_FAMILIES[number]

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
  /** Optional iframe selector for `screenshot`; captures the iframe document instead of the top page. */
  frameSelector?: string
  /** Optional iframe URL fragment for `screenshot`; captures the matching iframe document instead of the top page. */
  frameUrl?: string
  /** Optional wait duration (e.g. 500ms, 2s) for `waitFor`/`navigate`. */
  duration?: string
  /** Per-step timeout override (e.g. 5s). */
  timeout?: string
}

export interface BrowserRandomWalkContract {
  schema: typeof BROWSER_RANDOM_WALK_SCHEMA
  context: BrowserRandomWalkContext
  seed: string
  maxSteps: number
  actionFamilies: BrowserRandomWalkActionFamily[]
  startUrl?: string
  resetPolicy?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export interface BrowserRandomWalkPlan {
  schema: typeof BROWSER_RANDOM_WALK_SCHEMA
  status: "planned" | "unsupported"
  context: BrowserRandomWalkContext
  seed: string
  maxSteps: number
  actionFamilies: BrowserRandomWalkActionFamily[]
  steps: BrowserInteractionStep[]
  replay: Record<string, unknown>
  diagnostics: { code: string; message: string; metadata?: Record<string, unknown> }[]
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

export function browserRandomWalkContract(input: Record<string, unknown>): BrowserRandomWalkContract {
  const context = normalizeBrowserRandomWalkContext(input.context)
  const seed = typeof input.seed === "string" && input.seed.length > 0 ? input.seed : "browser-random-walk"
  const maxSteps = normalizeBrowserRandomWalkMaxSteps(input.maxSteps ?? input.max_steps)
  const families = normalizeBrowserRandomWalkActionFamilies(input.actionFamilies ?? input.action_families)
  return {
    schema: BROWSER_RANDOM_WALK_SCHEMA,
    context,
    seed,
    maxSteps,
    actionFamilies: families,
    startUrl: typeof input.startUrl === "string" ? input.startUrl : typeof input.start_url === "string" ? input.start_url : undefined,
    resetPolicy: isPlainObject(input.resetPolicy) ? input.resetPolicy : isPlainObject(input.reset_policy) ? input.reset_policy : undefined,
    metadata: isPlainObject(input.metadata) ? input.metadata : undefined,
  }
}

export function planBrowserRandomWalk(input: Record<string, unknown>): BrowserRandomWalkPlan {
  const contract = browserRandomWalkContract(input)
  const diagnostics: BrowserRandomWalkPlan["diagnostics"] = []
  const steps: BrowserInteractionStep[] = []
  const startUrl = contract.startUrl ?? defaultBrowserRandomWalkStartUrl(contract.context)

  if (!startUrl) {
    diagnostics.push({ code: "browser_random_walk_start_url_required", message: `Random walk context ${contract.context} requires startUrl.` })
  } else {
    steps.push({ kind: "navigate", url: startUrl, waitFor: "load" })
  }

  const budget = Math.max(contract.maxSteps - steps.length, 0)
  for (let index = 0; index < budget; index += 1) {
    const family = pickDeterministic(contract.actionFamilies, `${contract.seed}:${index}`)
    const step = browserRandomWalkStep(family, contract, index)
    if (step) steps.push(step)
  }

  if (steps.length === 0) {
    diagnostics.push({ code: "browser_random_walk_no_executable_steps", message: "Random walk planning produced no executable browser interaction steps." })
  }

  return {
    schema: BROWSER_RANDOM_WALK_SCHEMA,
    status: diagnostics.length > 0 ? "unsupported" : "planned",
    context: contract.context,
    seed: contract.seed,
    maxSteps: contract.maxSteps,
    actionFamilies: contract.actionFamilies,
    steps,
    replay: {
      schema: BROWSER_RANDOM_WALK_SCHEMA,
      seed: contract.seed,
      maxSteps: contract.maxSteps,
      actionFamilies: contract.actionFamilies,
      context: contract.context,
      startUrl,
      resetPolicy: contract.resetPolicy,
    },
    diagnostics,
  }
}

function normalizeBrowserRandomWalkContext(value: unknown): BrowserRandomWalkContext {
  return (BROWSER_RANDOM_WALK_CONTEXTS as readonly string[]).includes(String(value)) ? value as BrowserRandomWalkContext : "browser"
}

function normalizeBrowserRandomWalkMaxSteps(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(numeric)) return 8
  return Math.max(1, Math.min(Math.floor(numeric), 50))
}

function normalizeBrowserRandomWalkActionFamilies(value: unknown): BrowserRandomWalkActionFamily[] {
  const raw = Array.isArray(value) ? value : []
  const normalized = raw.filter((item): item is BrowserRandomWalkActionFamily => (BROWSER_RANDOM_WALK_ACTION_FAMILIES as readonly string[]).includes(String(item)))
  return normalized.length > 0 ? [...new Set(normalized)] : ["click", "fill", "press", "capture"]
}

function defaultBrowserRandomWalkStartUrl(context: BrowserRandomWalkContext): string | undefined {
  if (context === "admin") return "/wp-admin/"
  if (context === "editor") return "/wp-admin/post-new.php"
  return "/"
}

function browserRandomWalkStep(family: BrowserRandomWalkActionFamily, contract: BrowserRandomWalkContract, index: number): BrowserInteractionStep | undefined {
  if (family === "navigate") return { kind: "navigate", url: contract.startUrl ?? defaultBrowserRandomWalkStartUrl(contract.context), waitFor: "load" }
  if (family === "click") return { kind: "click", selector: "a, button, input[type='submit'], .button" }
  if (family === "fill") return { kind: "fill", selector: "input[type='search'], input[type='text'], textarea", value: `fuzz-${contract.seed}-${index}` }
  if (family === "press") return { kind: "press", key: index % 2 === 0 ? "Tab" : "Escape" }
  if (family === "select") return { kind: "select", selector: "select", value: "" }
  if (family === "capture") return { kind: "capture" }
  return undefined
}

function pickDeterministic<T>(items: readonly T[], seed: string): T {
  return items[deterministicHash(seed) % items.length] as T
}

function deterministicHash(input: string): number {
  let hash = 2166136261
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}
