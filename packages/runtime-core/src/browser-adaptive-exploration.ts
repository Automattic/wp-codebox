import { createHash } from "node:crypto"

import type { BrowserActionCorpusDescriptor, BrowserInteractionStep, BrowserRandomWalkContext } from "./browser-interaction.js"
import { browserAccessibilityContract, type BrowserAccessibilityContract, type BrowserAccessibilityEvidence } from "./browser-accessibility.js"
import { isPlainObject, stableJson, stripUndefined } from "./object-utils.js"
import { browserEnvironment, browserEnvironmentDigest, type BrowserEnvironment } from "./browser-environment-matrix.js"

export const BROWSER_ADAPTIVE_EXPLORATION_SCHEMA = "wp-codebox/browser-adaptive-exploration/v1" as const
export const BROWSER_ADAPTIVE_EXPLORATION_ARTIFACT_SCHEMA = "wp-codebox/browser-adaptive-exploration-artifact/v1" as const

export const BROWSER_ADAPTIVE_ACTION_FAMILIES = ["click", "fill", "select", "submit", "keyboard", "back", "reload", "repeat", "double-submit"] as const
export type BrowserAdaptiveActionFamily = typeof BROWSER_ADAPTIVE_ACTION_FAMILIES[number]

const TEXT_FILLABLE_INPUT_TYPES = new Set(["text", "search", "tel", "url", "email", "password", "number"])
const CLICKABLE_INPUT_TYPES = new Set(["checkbox", "radio", "button", "reset", "submit", "image"])
const SUBMIT_INPUT_TYPES = new Set(["submit", "image"])

export interface BrowserAdaptiveExplorationContract {
  schema: typeof BROWSER_ADAPTIVE_EXPLORATION_SCHEMA
  context: BrowserRandomWalkContext
  seed: string
  startUrl: string
  budgets: {
    maxActions: number
    maxStates: number
    maxTransitions: number
    maxDurationMs: number
    maxArtifactBytes: number
    maxErrors: number
  }
  actionFamilies: BrowserAdaptiveActionFamily[]
  resetPolicy: { mode: "none" | "start-url" }
  revisitPolicy: { maxStateVisits: number; maxActionVisits: number }
  descriptorLimits: { maxPerState: number; maxDiagnostics: number; maxTextLength: number }
  stabilization: { pollIntervalMs: number; quietWindowMs: number; maxWaitMs: number; maxMutationRecords: number }
  oraclePolicy: { policyBlocks: "evidence" | "finding" }
  failOnFinding: boolean
  accessibility?: BrowserAccessibilityContract
  metadata?: Record<string, unknown>
  environment: BrowserEnvironment
  environmentDigest: string
}

export interface BrowserAdaptiveFrameIdentity {
  id: string
  parentId?: string
  url: string
  scope: "document" | "same-origin-frame"
}

export interface BrowserAdaptiveState {
  digest: string
  url: string
  historyLength: number
  historyStateDigest: string
  descriptorDigest: string
  descriptors: BrowserActionCorpusDescriptor[]
  frames: BrowserAdaptiveFrameIdentity[]
  visits: number
  depth: number
  loadingIndicators: number
}

export interface BrowserAdaptiveAction {
  id: string
  family: BrowserAdaptiveActionFamily
  frameId: string
  descriptorId?: string
  descriptor?: BrowserActionCorpusDescriptor
  steps: BrowserInteractionStep[]
  input?: string | string[]
}

export interface BrowserAdaptiveTransition {
  id: string
  sourceDigest: string
  destinationDigest?: string
  action: BrowserAdaptiveAction
  sourceUrl: string
  destinationUrl: string
  history: { before: number; after: number; beforeStateDigest: string; afterStateDigest: string }
  timing: { durationMs: number; stabilizationMs: number; polls: number }
  novelty: { newState: boolean; newDescriptors: number; mutationRecords: number; mutationEvidenceTruncated: boolean }
  observations: {
    networkEvents: number
    consoleErrors: string[]
    pageErrors: string[]
    loadingBefore: number
    loadingAfter: number
    oracleFingerprints: string[]
    networkFailures?: BrowserAdaptiveNetworkFailure[]
    networkFailureSummary?: {
      total: number
      retained: number
      policyBlocks: number
      oracleFindings: number
      truncated: boolean
    }
    accessibilityFindingFingerprints?: string[]
  }
  status: "ok" | "revisited" | "rejected" | "error" | "cancelled"
  diagnostic?: { code: string; message: string }
}

export interface BrowserAdaptiveNetworkFailure {
  url: string
  host?: string
  urlClassification: "same-origin" | "external" | "invalid"
  policyDecision: "blocked" | "allowed" | "recorded" | "unknown"
  policyReason: string
  failure?: string
  oracleFinding: boolean
}

export interface BrowserAdaptiveFinding {
  fingerprint: string
  stateDigest?: string
  transitionId: string
  originalPath: BrowserAdaptiveAction[]
  minimizedPath: BrowserAdaptiveAction[]
  replay: {
    schema: typeof BROWSER_ADAPTIVE_EXPLORATION_SCHEMA
    seed: string
    startUrl: string
    expectedFingerprint: string
    expectedStateDigest?: string
    actions: BrowserAdaptiveAction[]
    resetPolicy: BrowserAdaptiveExplorationContract["resetPolicy"]
    environment: BrowserEnvironment
    environmentDigest: string
  }
}

export interface BrowserAdaptiveExplorationResult {
  schema: typeof BROWSER_ADAPTIVE_EXPLORATION_SCHEMA
  status: "completed" | "findings" | "incomplete"
  seed: string
  startUrl: string
  states: BrowserAdaptiveState[]
  transitions: BrowserAdaptiveTransition[]
  findings: BrowserAdaptiveFinding[]
  accessibility?: BrowserAccessibilityEvidence
  diagnostics: Array<{ code: string; message: string; metadata?: Record<string, unknown> }>
  summary: {
    actions: number
    states: number
    transitions: number
    revisits: number
    errors: number
    findings: number
    budgetExhausted?: keyof BrowserAdaptiveExplorationContract["budgets"] | "maxKeyboardActions" | "cancelled" | "frontier"
  }
  replay: { schema: typeof BROWSER_ADAPTIVE_EXPLORATION_SCHEMA; seed: string; startUrl: string; environment: BrowserEnvironment; environmentDigest: string; contract: BrowserAdaptiveExplorationContract }
}

export interface BrowserAdaptiveExplorationArtifact {
  schema: typeof BROWSER_ADAPTIVE_EXPLORATION_ARTIFACT_SCHEMA
  contract: BrowserAdaptiveExplorationContract
  result: BrowserAdaptiveExplorationResult
  capturedAt: string
}

export function browserAdaptiveExplorationContract(input: Record<string, unknown>): BrowserAdaptiveExplorationContract {
  const context: BrowserRandomWalkContext = input.context === "admin" || input.context === "editor" ? input.context : "browser"
  const budgets = object(input.budgets)
  const revisit = object(input.revisitPolicy ?? input.revisit_policy)
  const descriptors = object(input.descriptorLimits ?? input.descriptor_limits)
  const stabilization = object(input.stabilization)
  const oraclePolicy = object(input.oraclePolicy ?? input.oracle_policy)
  const reset = object(input.resetPolicy ?? input.reset_policy)
  const accessibility = browserAccessibilityContract(input.accessibility)
  const families = Array.isArray(input.actionFamilies ?? input.action_families)
    ? (input.actionFamilies ?? input.action_families) as unknown[]
    : []
  const actionFamilies = [...new Set(families.filter((value): value is BrowserAdaptiveActionFamily => (BROWSER_ADAPTIVE_ACTION_FAMILIES as readonly unknown[]).includes(value)))]
  const startUrl = string(input.startUrl ?? input.start_url) ?? (context === "admin" ? "/wp-admin/" : context === "editor" ? "/wp-admin/post-new.php" : "/")
  const environment = browserEnvironment(isPlainObject(input.environment) ? input.environment as BrowserEnvironment : {})
  return stripUndefined({
    schema: BROWSER_ADAPTIVE_EXPLORATION_SCHEMA,
    context,
    seed: string(input.seed) ?? "browser-adaptive-exploration",
    startUrl,
    budgets: {
      maxActions: integer(budgets.maxActions ?? budgets.max_actions, 32, 1, 500),
      maxStates: integer(budgets.maxStates ?? budgets.max_states, 24, 1, 250),
      maxTransitions: integer(budgets.maxTransitions ?? budgets.max_transitions, 64, 1, 1_000),
      maxDurationMs: integer(budgets.maxDurationMs ?? budgets.max_duration_ms, 120_000, 100, 3_600_000),
      maxArtifactBytes: integer(budgets.maxArtifactBytes ?? budgets.max_artifact_bytes, 5 * 1_048_576, accessibility ? 1_048_576 : 1_024, 100 * 1_048_576),
      maxErrors: integer(budgets.maxErrors ?? budgets.max_errors, 20, 1, 1_000),
    },
    actionFamilies: actionFamilies.length > 0 ? actionFamilies : [...BROWSER_ADAPTIVE_ACTION_FAMILIES],
    resetPolicy: { mode: reset.mode === "none" ? "none" as const : "start-url" as const },
    revisitPolicy: {
      maxStateVisits: integer(revisit.maxStateVisits ?? revisit.max_state_visits, 2, 1, 20),
      maxActionVisits: integer(revisit.maxActionVisits ?? revisit.max_action_visits, 1, 1, 20),
    },
    descriptorLimits: {
      maxPerState: integer(descriptors.maxPerState ?? descriptors.max_per_state, 80, 1, 500),
      maxDiagnostics: integer(descriptors.maxDiagnostics ?? descriptors.max_diagnostics, 20, 1, 200),
      maxTextLength: integer(descriptors.maxTextLength ?? descriptors.max_text_length, 2_000, 64, 20_000),
    },
    stabilization: {
      pollIntervalMs: integer(stabilization.pollIntervalMs ?? stabilization.poll_interval_ms, 50, 10, 1_000),
      quietWindowMs: integer(stabilization.quietWindowMs ?? stabilization.quiet_window_ms, 150, 20, 10_000),
      maxWaitMs: integer(stabilization.maxWaitMs ?? stabilization.max_wait_ms, 3_000, 50, 60_000),
      maxMutationRecords: integer(stabilization.maxMutationRecords ?? stabilization.max_mutation_records, 100, 1, 5_000),
    },
    oraclePolicy: { policyBlocks: (oraclePolicy.policyBlocks ?? oraclePolicy.policy_blocks) === "finding" ? "finding" as const : "evidence" as const },
    failOnFinding: input.failOnFinding !== false && input.fail_on_finding !== false,
    accessibility,
    metadata: isPlainObject(input.metadata) ? input.metadata : undefined,
    environment,
    environmentDigest: browserEnvironmentDigest(environment),
  })
}

export function browserAdaptiveDigest(kind: "state" | "descriptors" | "oracle" | "action", value: unknown): string {
  return createHash("sha256").update(`wp-codebox/browser-adaptive-${kind}/v1\n`).update(stableJson(value)).digest("hex")
}

export function orderBrowserAdaptiveActions(actions: readonly BrowserAdaptiveAction[], seed: string, stateDigest: string): BrowserAdaptiveAction[] {
  return [...actions].sort((left, right) => browserAdaptiveDigest("action", `${seed}:${stateDigest}:${left.id}`).localeCompare(browserAdaptiveDigest("action", `${seed}:${stateDigest}:${right.id}`)) || left.id.localeCompare(right.id))
}

export function planBrowserAdaptiveStateActions(state: BrowserAdaptiveState, contract: BrowserAdaptiveExplorationContract): BrowserAdaptiveAction[] {
  const actions: BrowserAdaptiveAction[] = []
  const add = (family: BrowserAdaptiveActionFamily, descriptor: BrowserActionCorpusDescriptor | undefined, steps: BrowserInteractionStep[], input?: string | string[]) => {
    if (!contract.actionFamilies.includes(family)) return
    const frameId = descriptor?.frameId ?? "document"
    const id = `${family}:${frameId}:${descriptor?.id ?? state.digest}`
    actions.push({ id, family, frameId, ...(descriptor ? { descriptorId: descriptor.id } : {}), steps, ...(input !== undefined ? { input } : {}) })
  }
  const addClicks = (descriptor: BrowserActionCorpusDescriptor, submit: boolean) => {
    const selector = descriptor.selector
    add("click", descriptor, [{ kind: "click", selector }])
    const navigates = descriptor.kind === "link" && Boolean(descriptor.href)
    if (!navigates) add("repeat", descriptor, [{ kind: "click", selector }, { kind: "click", selector }])
    if (submit && descriptor.formId) {
      add("submit", descriptor, [{ kind: "click", selector }])
      add("double-submit", descriptor, [{ kind: "click", selector }, { kind: "click", selector }])
    }
  }
  for (const descriptor of state.descriptors) {
    if (descriptor.disabled || descriptor.readonly) continue
    const selector = descriptor.selector
    const inputType = (descriptor.type ?? "text").toLowerCase()
    if (descriptor.kind === "textarea" || (descriptor.kind === "input" && TEXT_FILLABLE_INPUT_TYPES.has(inputType))) {
      const value = generatedValue(contract.seed, descriptor)
      add("fill", descriptor, [{ kind: "fill", selector, value }], value)
      add("keyboard", descriptor, [{ kind: "press", selector, key: "Enter" }])
      if (descriptor.formId) add("submit", descriptor, [{ kind: "fill", selector, value }, { kind: "press", selector, key: "Enter" }], value)
      add("repeat", descriptor, [{ kind: "fill", selector, value }, { kind: "fill", selector, value }], value)
    } else if (descriptor.kind === "input" && CLICKABLE_INPUT_TYPES.has(inputType)) {
      addClicks(descriptor, SUBMIT_INPUT_TYPES.has(inputType))
    } else if (descriptor.kind === "select") {
      const values = descriptor.optionValues?.filter(Boolean) ?? []
      if (values.length > 0) {
        const value = values[parseInt(browserAdaptiveDigest("action", `${contract.seed}:${descriptor.id}`).slice(0, 8), 16) % values.length] as string
        add("select", descriptor, [{ kind: "select", selector, value }], value)
      }
    } else if (descriptor.kind !== "input") {
      addClicks(descriptor, inputType === "submit")
    }
  }
  if (contract.accessibility && contract.actionFamilies.includes("keyboard")) {
    const sequences = [["Tab"], ["Tab", "Tab"], ["Tab", "Tab", "Tab"], ["Tab", "Tab", "Tab", "Tab"], ["Shift+Tab"], ["Tab", "Enter"], ["Tab", "Space"], ["Tab", "Escape"], ["Tab", "ArrowDown"], ["Tab", "ArrowUp"], ["Tab", "ArrowRight"], ["Tab", "ArrowLeft"]]
      .slice(0, contract.accessibility.budgets.maxKeyboardActions)
    for (const keys of sequences) {
      const steps = keys.map((key) => ({ kind: "press" as const, key }))
      actions.push({ id: `keyboard:document:${keys.join(">")}`, family: "keyboard", frameId: "document", steps })
    }
  }
  add("back", undefined, [])
  add("reload", undefined, [])
  return actions
}

function object(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {}
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

function integer(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const numeric = typeof value === "number" ? value : Number(value)
  return Number.isFinite(numeric) ? Math.max(minimum, Math.min(maximum, Math.floor(numeric))) : fallback
}

function generatedValue(seed: string, descriptor: BrowserActionCorpusDescriptor): string {
  const suffix = browserAdaptiveDigest("action", `${seed}:${descriptor.frameId}:${descriptor.id}`).slice(0, 10)
  if (descriptor.type === "email") return `adaptive-${suffix}@example.test`
  if (descriptor.type === "number") return String(parseInt(suffix.slice(0, 6), 16) % 1_000)
  if (descriptor.type === "url") return `https://example.test/${suffix}`
  return `adaptive-${suffix}`
}
