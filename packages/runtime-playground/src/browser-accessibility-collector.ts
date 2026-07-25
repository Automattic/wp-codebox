import {
  BROWSER_ACCESSIBILITY_SCHEMA,
  browserAccessibilityFindingFingerprint,
  type BrowserAccessibilityCollector,
  type BrowserAccessibilityContract,
  type BrowserAccessibilityEvidence,
  type BrowserAccessibilityFinding,
  type BrowserAccessibilityScan,
  type BrowserAccessibilityScanPhase,
  type BrowserAdaptiveAction,
} from "@automattic/wp-codebox-core"
import type { Frame, Page } from "playwright"

interface PageAccessibilityState {
  url: string
  focusedDocument?: boolean
  active: ElementEvidence
  activeInScope: boolean
  activeDialogKey?: string
  dialogs: ElementEvidence[]
  findings: Array<Omit<BrowserAccessibilityFinding, "fingerprint" | "stateDigest" | "transitionId" | "actionId">>
  diagnostics: Array<{ code: string; message: string }>
  includeScopeMatches: number
}

interface ElementEvidence {
  locator: string
  frameId: string
  tag: string
  role?: string
  visible: boolean
  insideDialog: boolean
  states?: BrowserAccessibilityFinding["target"]["states"]
  box?: BrowserAccessibilityFinding["target"]["box"]
}

export function createBrowserAccessibilityCollector(page: Page, contract: BrowserAccessibilityContract): BrowserAccessibilityCollector {
  const scans: BrowserAccessibilityScan[] = []
  const focusHistory: BrowserAccessibilityEvidence["focusHistory"] = []
  const diagnostics: BrowserAccessibilityEvidence["diagnostics"] = []
  const dialogTriggers = new Map<string, ElementEvidence>()
  let before: PageAccessibilityState | undefined
  let previousActiveKey: string | undefined
  let previousActiveLocator: string | undefined
  let currentAction: BrowserAdaptiveAction | undefined
  let truncated = false
  let scanAttempts = 0

  return {
    async beforeAction(action) {
      currentAction = action
      before = await inspectPage(page, contract)
    },
    async scan(input) {
      if (scanAttempts >= contract.budgets.maxScans) {
        truncated = true
        if (!diagnostics.some((item) => item.code === "browser_accessibility_scan_budget_exhausted")) diagnostics.push({ code: "browser_accessibility_scan_budget_exhausted", message: "The accessibility scan budget was exhausted." })
        return { index: scanAttempts, phase: input.phase, status: "inconclusive", stateDigest: input.stateDigest, transitionId: input.transitionId, actionId: input.action?.id, findings: [], diagnostics: [{ code: "browser_accessibility_scan_budget_exhausted", message: "The accessibility scan budget was exhausted." }] }
      }
      scanAttempts += 1
      const state = await inspectPage(page, contract)
      const findings = [...state.findings]
      const action = input.action ?? currentAction

      if (contract.ruleTags.includes("focus-loss") && action && state.url === before?.url && state.active.locator === "body" && before.active.locator !== "body" && before.activeInScope) {
        findings.push(finding("focus", "focus-loss", "browser-focus-lost", "serious", "focus-lost-to-document", before.active, "focus retained or moved intentionally", "document body"))
      }

      if (contract.ruleTags.includes("dialog-focus")) {
        const beforeDialogs = new Set((before?.dialogs ?? []).map(elementKey))
        const currentDialogs = new Set(state.dialogs.map(elementKey))
        for (const dialog of state.dialogs) {
          const key = elementKey(dialog)
          if (!beforeDialogs.has(key) && action) dialogTriggers.set(key, before?.active ?? state.active)
          if (state.activeDialogKey !== key) {
            findings.push(finding("focus", "dialog-focus", "browser-dialog-focus-entry", "serious", "dialog-focus-not-contained", dialog, "focus inside the open dialog", state.active.locator))
          }
        }
        for (const dialog of before?.dialogs ?? []) {
          const key = elementKey(dialog)
          if (currentDialogs.has(key)) continue
          const trigger = dialogTriggers.get(key)
          if (trigger && elementKey(state.active) !== elementKey(trigger)) {
            findings.push(finding("focus", "dialog-focus", "browser-dialog-focus-restoration", "serious", "dialog-focus-not-restored", dialog, trigger.locator, state.active.locator))
          }
          dialogTriggers.delete(key)
        }
      }

      const retained = findings
        .filter((item) => impactRank(item.impact) >= impactRank(contract.impactThreshold))
        .slice(0, contract.budgets.maxViolationsPerScan)
        .map((item) => {
          const contextual = { ...item, stateDigest: input.stateDigest, transitionId: input.transitionId, actionId: action?.id }
          return { ...contextual, fingerprint: browserAccessibilityFindingFingerprint(contextual) }
        })
      if (findings.length > retained.length) truncated = true

      const activeKey = elementKey(state.active)
      if (activeKey !== previousActiveKey && focusHistory.length < contract.budgets.maxFocusTransitions) {
        focusHistory.push({ index: focusHistory.length, phase: input.phase, actionId: action?.id, from: previousActiveLocator, to: state.active.locator, visible: state.active.visible, insideDialog: state.active.insideDialog })
      } else if (activeKey !== previousActiveKey) {
        truncated = true
      }
      previousActiveKey = activeKey
      previousActiveLocator = state.active.locator

      const tree = await accessibilityTree(page, contract)
      const requiredUnavailable = tree.status !== "captured" && contract.capabilities.accessibilityTree === "required"
      const treeUnavailable = tree.status !== "captured" && contract.capabilities.accessibilityTree !== "disabled"
      const scopeInconclusive = state.diagnostics.some((item) => item.code === "browser_accessibility_scope_invalid" || item.code === "browser_accessibility_scope_unmatched")
      const status: BrowserAccessibilityScan["status"] = retained.length > 0 ? "findings" : treeUnavailable ? "unsupported" : scopeInconclusive ? "inconclusive" : "passed"
      const scan: BrowserAccessibilityScan = {
        index: scanAttempts - 1,
        phase: input.phase,
        status,
        stateDigest: input.stateDigest,
        transitionId: input.transitionId,
        actionId: action?.id,
        findings: retained,
        accessibilityTree: tree,
        diagnostics: [...state.diagnostics, ...(requiredUnavailable ? [{ code: "browser_accessibility_tree_required_unavailable", message: "The required accessibility-tree capability was unavailable." }] : [])],
      }
      if (input.record !== false) scans.push(scan)
      before = state
      currentAction = undefined
      return scan
    },
    async reset() {
      before = undefined
      previousActiveKey = undefined
      previousActiveLocator = undefined
      currentAction = undefined
      dialogTriggers.clear()
    },
    evidence() {
      const findingCount = scans.reduce((count, scan) => count + scan.findings.length, 0)
      return {
        schema: BROWSER_ACCESSIBILITY_SCHEMA,
        collector: {
          name: "playground-browser-accessibility",
          version: "1",
          capabilities: {
            rules: "supported",
            focus: "supported",
            accessibilityTree: scans.some((scan) => scan.accessibilityTree?.status === "captured") ? "supported" : "unsupported",
          },
        },
        contract,
        scans,
        focusHistory,
        diagnostics,
        summary: {
          scans: scanAttempts,
          findings: findingCount,
          passed: scans.filter((scan) => scan.status === "passed").length,
          unsupported: scans.filter((scan) => scan.status === "unsupported").length,
          inconclusive: scans.filter((scan) => scan.status === "inconclusive").length,
          truncated,
        },
      }
    },
  }
}

async function inspectPage(page: Page, contract: BrowserAccessibilityContract): Promise<PageAccessibilityState> {
  await page.evaluate("globalThis.__name ||= value => value")
  const states: PageAccessibilityState[] = []
  const diagnostics: PageAccessibilityState["diagnostics"] = []
  for (const identity of accessibilityFrameIdentities(page, contract.budgets.maxFrames)) {
    try {
      await identity.frame.evaluate("globalThis.__name ||= value => value")
      states.push(await inspectFrame(identity.frame, identity.id, contract))
    } catch {
      diagnostics.push({ code: "browser_accessibility_frame_unsupported", message: `Frame ${identity.id} could not be inspected.` })
    }
  }
  const main = states.find((state) => state.url === page.url()) ?? states[0]
  const focused = [...states].reverse().find((state) => state.focusedDocument)
  const stateDiagnostics = states.flatMap((state) => state.diagnostics)
  if (contract.includeScopes.length > 0 && states.reduce((count, state) => count + state.includeScopeMatches, 0) === 0) {
    stateDiagnostics.push({ code: "browser_accessibility_scope_unmatched", message: "No declared accessibility include scope matched an inspectable frame; the scan is inconclusive." })
  }
  return {
    url: page.url(),
    active: focused?.active ?? main?.active ?? { locator: "body", frameId: "document", tag: "body", visible: true, insideDialog: false },
    activeInScope: focused?.activeInScope ?? main?.activeInScope ?? false,
    activeDialogKey: focused?.activeDialogKey ?? main?.activeDialogKey,
    dialogs: states.flatMap((state) => state.dialogs),
    findings: states.flatMap((state) => state.findings).slice(0, contract.budgets.maxViolationsPerScan * contract.budgets.maxTargetsPerViolation),
    diagnostics: [...stateDiagnostics, ...diagnostics],
    includeScopeMatches: states.reduce((count, state) => count + state.includeScopeMatches, 0),
  }
}

async function inspectFrame(frame: Frame, frameId: string, contract: BrowserAccessibilityContract): Promise<PageAccessibilityState> {
  return frame.evaluate(({ includeScopes, excludeScopes, rules, maxTargets, frameId }) => {
    const bounded = (value: string) => value.replace(/([_:-](?:[a-z]{0,4})?)[a-f0-9]{8,}$/i, "$1<generated>").slice(0, 240)
    const path = (element: Element | null): string => {
      if (!element || element === document.documentElement || element === document.body) return element === document.body ? "body" : "document"
      const parts: string[] = []
      let current: Element | null = element
      while (current && current !== document.body && parts.length < 6) {
        let part = current.tagName.toLowerCase()
        const role = current.hasAttribute("role")
        if (role) part += "[role]"
        const parent: Element | null = current.parentElement
        if (parent) {
          const peers = Array.from(parent.children).filter((child) => child.tagName === current?.tagName && child.hasAttribute("role") === role)
          if (peers.length > 1) part += `:nth-of-type(${Array.from(parent.children).filter((child) => child.tagName === current?.tagName).indexOf(current) + 1})`
        }
        parts.unshift(part)
        current = parent
      }
      return bounded(parts.join(" > ") || element.tagName.toLowerCase())
    }
    const rendered = (element: Element) => {
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      const hiddenAncestor = element.closest("[hidden],[inert],[aria-hidden='true']")
      return !hiddenAncestor && rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0"
    }
    const visible = (element: Element) => { const rect = element.getBoundingClientRect(); return rendered(element) && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth }
    const role = (element: Element) => element.getAttribute("role")?.split(/\s+/).find((candidate) => validRoles.has(candidate)) || ({ BUTTON: "button", SUMMARY: "button", A: (element as HTMLAnchorElement).href ? "link" : undefined, INPUT: (element as HTMLInputElement).type === "checkbox" ? "checkbox" : (element as HTMLInputElement).type === "radio" ? "radio" : "textbox", SELECT: "combobox", TEXTAREA: "textbox" } as Record<string, string | undefined>)[element.tagName]
    const evidence = (element: Element | null): ElementEvidence => {
      const target = element ?? document.body
      const rect = target.getBoundingClientRect()
      const states: NonNullable<ElementEvidence["states"]> = Object.fromEntries(["expanded", "selected", "checked", "busy", "pressed", "hidden"].flatMap((name) => {
        const value = target.getAttribute(`aria-${name}`)
        return value === null ? [] : [[name, value.slice(0, 120)]]
      }))
      if (target.closest("[inert]")) states.inert = "true"
      return { locator: path(target), frameId, tag: target.tagName.toLowerCase(), role: role(target), visible: visible(target), insideDialog: Boolean(target.closest("dialog,[role='dialog'],[role='alertdialog']")), states, box: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height), viewportWidth: innerWidth, viewportHeight: innerHeight } }
    }
    const invalidScopes = [...includeScopes, ...excludeScopes].filter((selector) => { try { document.querySelector(selector); return false } catch { return true } })
    const includeScopeMatches = includeScopes.reduce((count, selector) => { try { return count + (document.querySelector(selector) ? 1 : 0) } catch { return count } }, 0)
    const inScope = (element: Element) => {
      const included = includeScopes.length === 0 || includeScopes.some((selector) => { try { return element.matches(selector) || Boolean(element.closest(selector)) } catch { return false } })
      const excluded = excludeScopes.some((selector) => { try { return element.matches(selector) || Boolean(element.closest(selector)) } catch { return false } })
      return included && !excluded
    }
    const name = (element: Element) => {
      const labelledBy = element.getAttribute("aria-labelledby")?.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ").trim()
      if (labelledBy) return labelledBy
      const aria = element.getAttribute("aria-label")?.trim()
      if (aria) return aria
      const title = element.getAttribute("title")?.trim()
      if (title) return title
      const input = element as HTMLInputElement
      if (input.labels && Array.from(input.labels).some((label) => (label.textContent || "").trim())) return "<labelled>"
      if (element.tagName === "INPUT" && ["submit", "reset", "button"].includes(input.type)) return input.value || (input.type === "submit" ? "Submit" : input.type === "reset" ? "Reset" : "")
      if (element.tagName === "INPUT" && input.type === "image") return input.alt
      const descendantAlt = element.querySelector("img[alt]")?.getAttribute("alt")?.trim()
      if (descendantAlt) return descendantAlt
      const svgTitle = element.querySelector("svg title")?.textContent?.trim()
      if (svgTitle) return svgTitle
      const semanticRole = role(element)
      return semanticRole && new Set(["button", "link", "checkbox", "radio", "switch", "tab", "option", "menuitem"]).has(semanticRole) ? ((element as HTMLElement).innerText || "").replace(/\s+/g, " ").trim() : ""
    }
    const interactiveRoles = new Set(["button", "link", "checkbox", "radio", "switch", "tab", "option", "menuitem", "combobox", "textbox", "slider", "spinbutton"])
    const validRoles = new Set(["alert", "alertdialog", "application", "article", "banner", "blockquote", "button", "caption", "cell", "checkbox", "code", "columnheader", "combobox", "complementary", "contentinfo", "definition", "deletion", "dialog", "directory", "document", "emphasis", "feed", "figure", "form", "generic", "grid", "gridcell", "group", "heading", "img", "insertion", "link", "list", "listbox", "listitem", "log", "main", "marquee", "math", "menu", "menubar", "menuitem", "menuitemcheckbox", "menuitemradio", "meter", "navigation", "none", "note", "option", "paragraph", "presentation", "progressbar", "radio", "radiogroup", "region", "row", "rowgroup", "rowheader", "scrollbar", "search", "searchbox", "separator", "slider", "spinbutton", "status", "strong", "subscript", "suggestion", "superscript", "switch", "tab", "table", "tablist", "tabpanel", "term", "textbox", "time", "timer", "toolbar", "tooltip", "tree", "treegrid", "treeitem"])
    const findings: PageAccessibilityState["findings"] = []
    const add = (oracle: BrowserAccessibilityFinding["oracle"], rule: BrowserAccessibilityFinding["rule"], code: string, impact: BrowserAccessibilityFinding["impact"], classification: string, element: Element, expected?: string, actual?: string) => {
      if (findings.length < maxTargets && rules.includes(rule)) findings.push({ oracle, rule, code, impact, classification, target: evidence(element), expected: expected?.slice(0, 120), actual: actual?.slice(0, 120) })
    }
    const elements = Array.from(document.querySelectorAll("button,a[href],input:not([type=hidden]),select,textarea,summary,[role],[tabindex],[aria-controls]" )).filter(inScope)
    for (const element of elements) {
      const semanticRole = role(element)
      const explicitRole = element.getAttribute("role")?.trim()
      const interactive = Boolean(semanticRole && interactiveRoles.has(semanticRole))
      if (explicitRole && !explicitRole.split(/\s+/).some((candidate) => validRoles.has(candidate))) add("accessibility", "accessible-name", "browser-role-invalid", "serious", "invalid-role-relationship", element, "valid ARIA role", explicitRole)
      if (interactive && visible(element) && !name(element)) add("accessibility", "accessible-name", "browser-accessible-name-missing", "serious", "interactive-control-without-accessible-name", element, "non-empty accessible name", "missing")
      const native = ["BUTTON", "A", "INPUT", "SELECT", "TEXTAREA", "SUMMARY"].includes(element.tagName)
      if (interactive && !native && visible(element) && (element as HTMLElement).tabIndex < 0) add("keyboard", "keyboard-reachable", "browser-keyboard-unreachable", "serious", "actionable-element-unreachable-by-keyboard", element, "tabIndex >= 0", String((element as HTMLElement).tabIndex))
      if (!interactive && (element as HTMLElement).tabIndex >= 0) add("keyboard", "tab-order", "browser-unexpected-tab-stop", "moderate", "non-interactive-element-in-tab-order", element, "interactive semantics", semanticRole || "none")
      const controls = element.getAttribute("aria-controls")
      const expanded = element.getAttribute("aria-expanded")
      if (controls && expanded !== null) {
        if (expanded !== "true" && expanded !== "false") add("accessibility", "aria-state", "browser-aria-expanded-invalid", "serious", "invalid-aria-state-token", element, "true or false", expanded)
        const controlled = controls.split(/\s+/).map((id) => document.getElementById(id)).filter((item): item is HTMLElement => Boolean(item))
        if (controlled.length === 0) add("accessibility", "aria-state", "browser-aria-controls-missing", "serious", "aria-relationship-target-missing", element, "at least one existing controlled target", "missing")
        else {
          const actual = controlled.some(rendered)
          if ((expanded === "true") !== actual) add("accessibility", "aria-state", "browser-aria-expanded-drift", "serious", "aria-state-divergence", element, String(actual), expanded)
        }
      }
      const ariaChecked = element.getAttribute("aria-checked")
      if (ariaChecked !== null && !["true", "false", "mixed"].includes(ariaChecked)) add("accessibility", "aria-state", "browser-aria-checked-invalid", "serious", "invalid-aria-state-token", element, "true, false, or mixed", ariaChecked)
      if (ariaChecked !== null && "checked" in element && String((element as HTMLInputElement).checked) !== ariaChecked) add("accessibility", "aria-state", "browser-aria-checked-drift", "serious", "aria-state-divergence", element, String((element as HTMLInputElement).checked), ariaChecked)
      const ariaSelected = element.getAttribute("aria-selected")
      if (ariaSelected !== null && !["true", "false"].includes(ariaSelected)) add("accessibility", "aria-state", "browser-aria-selected-invalid", "serious", "invalid-aria-state-token", element, "true or false", ariaSelected)
      if (ariaSelected !== null && "selected" in element && String((element as HTMLOptionElement).selected) !== ariaSelected) add("accessibility", "aria-state", "browser-aria-selected-drift", "serious", "aria-state-divergence", element, String((element as HTMLOptionElement).selected), ariaSelected)
      for (const [attribute, allowed] of [["aria-busy", ["true", "false"]], ["aria-pressed", ["true", "false", "mixed"]]] as const) {
        const value = element.getAttribute(attribute)
        if (value !== null && !(allowed as readonly string[]).includes(value)) add("accessibility", "aria-state", `browser-${attribute}-invalid`, "serious", "invalid-aria-state-token", element, allowed.join(", "), value)
      }
    }
    const active = evidence(document.activeElement)
    const activeInScope = Boolean(document.activeElement && inScope(document.activeElement))
    const activeDialog = document.activeElement?.closest("dialog,[role='dialog'],[role='alertdialog']")
    const activeDialogKey = activeDialog ? `${frameId}\n${path(activeDialog)}` : undefined
    if (rules.includes("focus-visible") && document.activeElement && document.activeElement !== document.body && activeInScope && !active.visible) findings.push({ oracle: "focus", rule: "focus-visible", code: "browser-focused-element-hidden", impact: "serious", classification: "focus-in-hidden-inert-or-offscreen-content", target: active, expected: "visible and operable", actual: active.states?.inert === "true" ? "inert" : "hidden, clipped, or offscreen" })
    const dialogs = Array.from(document.querySelectorAll("dialog,[role='dialog'],[role='alertdialog']")).filter((element) => {
      let nativeModal = false
      try { nativeModal = element.matches(":modal") } catch { nativeModal = element.tagName === "DIALOG" && (element as HTMLDialogElement).open }
      return (nativeModal || element.getAttribute("aria-modal") === "true") && visible(element) && inScope(element)
    }).map(evidence)
    return { url: location.href, focusedDocument: document.hasFocus(), active, activeInScope, activeDialogKey, dialogs, findings, diagnostics: invalidScopes.length > 0 ? [{ code: "browser_accessibility_scope_invalid", message: "One or more accessibility scope selectors were invalid; the scan is inconclusive." }] : [], includeScopeMatches }
  }, { includeScopes: contract.includeScopes, excludeScopes: contract.excludeScopes, rules: contract.ruleTags, maxTargets: contract.budgets.maxViolationsPerScan * contract.budgets.maxTargetsPerViolation, frameId })
}

async function accessibilityTree(page: Page, contract: BrowserAccessibilityContract): Promise<NonNullable<BrowserAccessibilityScan["accessibilityTree"]>> {
  if (contract.capabilities.accessibilityTree === "disabled") return { status: "unsupported", reason: "disabled_by_contract" }
  try {
    const raw = await page.locator("body").ariaSnapshot({ timeout: 2_000 })
    const redacted = raw.replace(/"(?:[^"\\]|\\.)*"/g, '"<redacted>"').replace(/(^|\n)(\s*-?\s*\/?(?:text|url|value|description|placeholder):\s*).*/gi, "$1$2<redacted>")
    const snapshot = redacted.slice(0, contract.budgets.maxTreeChars)
    return { status: "captured", snapshot, truncated: redacted.length > snapshot.length }
  } catch (error) {
    return { status: "unsupported", reason: (error instanceof Error ? error.message : String(error)).slice(0, 240) }
  }
}

function finding(oracle: BrowserAccessibilityFinding["oracle"], rule: BrowserAccessibilityFinding["rule"], code: string, impact: BrowserAccessibilityFinding["impact"], classification: string, target: ElementEvidence, expected?: string, actual?: string): Omit<BrowserAccessibilityFinding, "fingerprint" | "stateDigest" | "transitionId" | "actionId"> {
  return { oracle, rule, code, impact, classification, target, expected, actual }
}

function elementKey(element: ElementEvidence): string { return `${element.frameId}\n${element.locator}` }

function impactRank(impact: BrowserAccessibilityFinding["impact"]): number { return { minor: 0, moderate: 1, serious: 2, critical: 3 }[impact] }

function accessibilityFrameIdentities(page: Page, maximum: number): Array<{ id: string; frame: Frame }> {
  const identities: Array<{ id: string; frame: Frame }> = [{ id: "document", frame: page.mainFrame() }]
  const walk = (parent: Frame, parentId: string) => parent.childFrames().forEach((frame, index) => {
    if (identities.length >= maximum) return
    const id = parentId === "document" ? `frame:${index}` : `${parentId}.${index}`
    identities.push({ id, frame })
    walk(frame, id)
  })
  walk(page.mainFrame(), "document")
  return identities
}
