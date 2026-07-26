import assert from "node:assert/strict"
import test from "node:test"

import { evaluateAdversarialBrowserOracles, minimizeAdversarialBrowserJourney, planAdversarialBrowserJourney } from "../packages/runtime-core/src/adversarial-browser.js"
import { browserAccessibilityFindingFingerprint, type BrowserAccessibilityFinding } from "../packages/runtime-core/src/browser-accessibility.js"

const descriptors = [
  { id: "input:name", kind: "input" as const, selector: "#name", type: "text" },
  { id: "button:save", kind: "button" as const, selector: "#save", type: "submit" },
]

test("browser adversary discovers hostile inputs and repeated interactions deterministically", () => {
  const first = planAdversarialBrowserJourney({ seed: "ui-seed", startUrl: "/fixture", descriptors, maxSteps: 8 })
  const second = planAdversarialBrowserJourney({ seed: "ui-seed", startUrl: "/fixture", descriptors, maxSteps: 8 })
  assert.deepEqual(first, second)
  assert.equal(first.steps.filter((step) => step.kind === "click").length, 2)
  assert.ok(first.steps.some((step) => step.kind === "fill"))
})

test("generic browser oracles report crashes, dead controls, layout, accessibility, duplicate effects, and stuck state", () => {
  const normalized = {
    oracle: "keyboard",
    rule: "keyboard-reachable",
    code: "browser-keyboard-unreachable",
    impact: "serious",
    classification: "actionable-element-unreachable-by-keyboard",
    target: { locator: "div[role=button]", frameId: "document", tag: "div", role: "button" },
  } satisfies Omit<BrowserAccessibilityFinding, "fingerprint">
  const result = evaluateAdversarialBrowserOracles({
    pageErrors: ["uncaught fixture error"],
    controls: [{ id: "save", expectedAction: true, actionObserved: false }],
    loadingIndicators: [{ id: "spinner", visibleForMs: 20_000 }],
    boxes: [{ id: "dialog", x: 900, y: 0, width: 300, height: 100, viewportWidth: 1024, viewportHeight: 768 }],
    accessibilityViolations: [{ rule: "label", target: "#name" }],
    accessibilityFindings: [{ ...normalized, fingerprint: browserAccessibilityFindingFingerprint(normalized) }],
    effects: [{ id: "save", count: 2 }],
  })
  assert.equal(result.failed, true)
  assert.deepEqual(new Set(result.failures.map((failure) => failure.oracle)), new Set(["crash", "dead-control", "stuck-interaction", "layout", "accessibility", "duplicate-effect"]))
  assert(result.failures.some((failure) => failure.code === "browser-keyboard-unreachable"))
})

test("browser journeys minimize automatically to the shortest reproduced failure", async () => {
  const journey = planAdversarialBrowserJourney({ seed: "ui-seed", startUrl: "/fixture", descriptors, maxSteps: 8 }).steps
  const minimized = await minimizeAdversarialBrowserJourney(journey, async (candidate) => candidate.filter((step) => step.kind === "click").length >= 2)
  assert.deepEqual(minimized, [{ kind: "click", selector: "#save" }, { kind: "click", selector: "#save" }])
})
