import { createHash } from "node:crypto"

import type { BrowserAdaptiveAction } from "./browser-adaptive-exploration.js"
import { isPlainObject, stableJson, stripUndefined } from "./object-utils.js"

export const BROWSER_ACCESSIBILITY_SCHEMA = "wp-codebox/browser-accessibility/v1" as const
export const BROWSER_ACCESSIBILITY_RULES = [
  "accessible-name",
  "keyboard-reachable",
  "tab-order",
  "focus-visible",
  "focus-loss",
  "dialog-focus",
  "aria-state",
] as const

export type BrowserAccessibilityRule = typeof BROWSER_ACCESSIBILITY_RULES[number]
export type BrowserAccessibilityImpact = "minor" | "moderate" | "serious" | "critical"
export type BrowserAccessibilityScanPhase = "initial" | "novel-state" | "final" | "replay"

export interface BrowserAccessibilityContract {
  schema: typeof BROWSER_ACCESSIBILITY_SCHEMA
  ruleTags: BrowserAccessibilityRule[]
  includeScopes: string[]
  excludeScopes: string[]
  impactThreshold: BrowserAccessibilityImpact
  cadence: Array<"initial" | "novel-state" | "final">
  capabilities: {
    rules: "required" | "optional"
    focus: "required" | "optional"
    accessibilityTree: "required" | "optional" | "disabled"
  }
  budgets: {
    maxScans: number
    maxViolationsPerScan: number
    maxTargetsPerViolation: number
    maxFocusTransitions: number
    maxTreeChars: number
    maxKeyboardActions: number
    maxFrames: number
  }
}

export interface BrowserAccessibilityTargetEvidence {
  locator: string
  frameId: string
  tag: string
  role?: string
  states?: Partial<Record<"expanded" | "selected" | "checked" | "busy" | "pressed" | "hidden" | "inert", string>>
  box?: { x: number; y: number; width: number; height: number; viewportWidth: number; viewportHeight: number }
}

export interface BrowserAccessibilityFinding {
  oracle: "accessibility" | "keyboard" | "focus"
  rule: BrowserAccessibilityRule
  code: string
  impact: BrowserAccessibilityImpact
  classification: string
  fingerprint: string
  target: BrowserAccessibilityTargetEvidence
  stateDigest?: string
  transitionId?: string
  actionId?: string
  expected?: string
  actual?: string
}

export interface BrowserAccessibilityFocusTransition {
  index: number
  phase: BrowserAccessibilityScanPhase
  actionId?: string
  from?: string
  to: string
  visible: boolean
  insideDialog: boolean
}

export interface BrowserAccessibilityScan {
  index: number
  phase: BrowserAccessibilityScanPhase
  status: "passed" | "findings" | "unsupported" | "inconclusive"
  stateDigest?: string
  transitionId?: string
  actionId?: string
  findings: BrowserAccessibilityFinding[]
  accessibilityTree?: { status: "captured" | "unsupported" | "inconclusive"; snapshot?: string; reason?: string; truncated?: boolean }
  diagnostics: Array<{ code: string; message: string }>
  artifacts?: { screenshot?: string; domSnapshot?: string }
}

export interface BrowserAccessibilityEvidence {
  schema: typeof BROWSER_ACCESSIBILITY_SCHEMA
  collector: { name: string; version: string; capabilities: { rules: "supported" | "unsupported"; focus: "supported" | "unsupported"; accessibilityTree: "supported" | "unsupported" } }
  contract: BrowserAccessibilityContract
  scans: BrowserAccessibilityScan[]
  focusHistory: BrowserAccessibilityFocusTransition[]
  diagnostics: Array<{ code: string; message: string }>
  summary: { scans: number; findings: number; passed: number; unsupported: number; inconclusive: number; truncated: boolean }
}

export interface BrowserAccessibilityCollector {
  beforeAction(action: BrowserAdaptiveAction): Promise<void>
  scan(input: { phase: BrowserAccessibilityScanPhase; stateDigest?: string; transitionId?: string; action?: BrowserAdaptiveAction; record?: boolean }): Promise<BrowserAccessibilityScan>
  reset(): Promise<void>
  evidence(): BrowserAccessibilityEvidence
}

export function browserAccessibilityContract(input: unknown): BrowserAccessibilityContract | undefined {
  if (!isPlainObject(input) || input.enabled === false) return undefined
  const budgets = object(input.budgets)
  const capabilities = object(input.capabilities)
  const requestedRules = array(input.ruleTags ?? input.rule_tags).filter((value): value is BrowserAccessibilityRule => (BROWSER_ACCESSIBILITY_RULES as readonly unknown[]).includes(value))
  const requestedCadence = array(input.cadence).filter((value): value is "initial" | "novel-state" | "final" => value === "initial" || value === "novel-state" || value === "final")
  return {
    schema: BROWSER_ACCESSIBILITY_SCHEMA,
    ruleTags: requestedRules.length > 0 ? [...new Set(requestedRules)] : [...BROWSER_ACCESSIBILITY_RULES],
    includeScopes: boundedStrings(input.includeScopes ?? input.include_scopes, 20),
    excludeScopes: boundedStrings(input.excludeScopes ?? input.exclude_scopes, 20),
    impactThreshold: impact(input.impactThreshold ?? input.impact_threshold),
    cadence: requestedCadence.length > 0 ? [...new Set(requestedCadence)] : ["initial", "novel-state", "final"],
    capabilities: {
      rules: requirement(capabilities.rules),
      focus: requirement(capabilities.focus),
      accessibilityTree: capabilities.accessibilityTree === "disabled" || capabilities.accessibility_tree === "disabled" ? "disabled" : requirement(capabilities.accessibilityTree ?? capabilities.accessibility_tree),
    },
    budgets: {
      maxScans: integer(budgets.maxScans ?? budgets.max_scans, 32, 1, 500),
      maxViolationsPerScan: integer(budgets.maxViolationsPerScan ?? budgets.max_violations_per_scan, 25, 1, 200),
      maxTargetsPerViolation: integer(budgets.maxTargetsPerViolation ?? budgets.max_targets_per_violation, 3, 1, 20),
      maxFocusTransitions: integer(budgets.maxFocusTransitions ?? budgets.max_focus_transitions, 100, 1, 1_000),
      maxTreeChars: integer(budgets.maxTreeChars ?? budgets.max_tree_chars, 20_000, 256, 200_000),
      maxKeyboardActions: integer(budgets.maxKeyboardActions ?? budgets.max_keyboard_actions, 12, 0, 50),
      maxFrames: integer(budgets.maxFrames ?? budgets.max_frames, 16, 1, 100),
    },
  }
}

export function browserAccessibilityFindingFingerprint(finding: Omit<BrowserAccessibilityFinding, "fingerprint">): string {
  const stable = stripUndefined({
    oracle: finding.oracle,
    rule: finding.rule,
    code: finding.code,
    impact: finding.impact,
    classification: finding.classification,
    target: {
      locator: normalizeLocator(finding.target.locator),
      frameId: finding.target.frameId,
      tag: finding.target.tag,
      role: finding.target.role,
      states: finding.target.states,
    },
    expected: finding.expected,
    actual: finding.actual,
  })
  return createHash("sha256").update("wp-codebox/browser-accessibility-finding/v1\n").update(stableJson(stable)).digest("hex")
}

function normalizeLocator(value: string): string {
  return value.replace(/([_:-](?:[a-z]{0,4})?)[a-f0-9]{8,}/gi, "$1<generated>").slice(0, 240)
}

function object(value: unknown): Record<string, unknown> { return isPlainObject(value) ? value : {} }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : [] }
function boundedStrings(value: unknown, maximum: number): string[] { return array(value).filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, maximum).map((item) => item.trim().slice(0, 240)) }
function requirement(value: unknown): "required" | "optional" { return value === "required" ? "required" : "optional" }
function impact(value: unknown): BrowserAccessibilityImpact { return value === "minor" || value === "moderate" || value === "critical" ? value : "serious" }
function integer(value: unknown, fallback: number, minimum: number, maximum: number): number { const numeric = Number(value); return Number.isFinite(numeric) ? Math.max(minimum, Math.min(maximum, Math.floor(numeric))) : fallback }
