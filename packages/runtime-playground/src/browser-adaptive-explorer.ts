import {
  BROWSER_ADAPTIVE_EXPLORATION_SCHEMA,
  browserAdaptiveDigest,
  orderBrowserAdaptiveActions,
  planBrowserAdaptiveStateActions,
  type BrowserActionCorpusDescriptor,
  type BrowserAdaptiveAction,
  type BrowserAdaptiveExplorationContract,
  type BrowserAdaptiveExplorationResult,
  type BrowserAdaptiveFinding,
  type BrowserAdaptiveFrameIdentity,
  type BrowserAdaptiveNetworkFailure,
  type BrowserAdaptiveState,
  type BrowserAdaptiveTransition,
  type BrowserAccessibilityCollector,
  type BrowserAccessibilityFinding as BrowserA11yFinding,
} from "@automattic/wp-codebox-core"
import { stableJson } from "@automattic/wp-codebox-core/internals"
import type { Frame, Page } from "playwright"

import { discoverBrowserActionCorpusDescriptors } from "./browser-action-discovery.js"
import { browserPreviewNetworkDecision, type BrowserPreviewNavigationScope, type BrowserPreviewNetworkPolicy } from "./browser-preview-routing.js"

interface AdaptiveObservationSources {
  consoleMessages: object[]
  errors: object[]
  network: object[]
}

interface CapturedAdaptiveState {
  state: BrowserAdaptiveState
  diagnostics: BrowserAdaptiveExplorationResult["diagnostics"]
  loading: number
}

interface StabilizationResult extends CapturedAdaptiveState {
  waitedMs: number
  polls: number
  mutationRecords: number
  mutationEvidenceTruncated: boolean
}

interface FrontierEntry {
  state: BrowserAdaptiveState
  path: BrowserAdaptiveAction[]
}

export async function exploreAdaptiveBrowserStateMachine({
  page,
  baseUrl,
  contract,
  observations,
  signal,
  now = Date.now,
  navigationScope,
  networkPolicy,
  accessibilityCollector,
  onAccessibilityFindingEvidence,
}: {
  page: Page
  baseUrl: string
  contract: BrowserAdaptiveExplorationContract
  observations: AdaptiveObservationSources
  signal?: AbortSignal
  now?: () => number
  navigationScope?: BrowserPreviewNavigationScope
  networkPolicy?: BrowserPreviewNetworkPolicy
  accessibilityCollector?: BrowserAccessibilityCollector
  onAccessibilityFindingEvidence?: (scan: Awaited<ReturnType<BrowserAccessibilityCollector["scan"]>>) => Promise<{ screenshot?: string; domSnapshot?: string }>
}): Promise<BrowserAdaptiveExplorationResult> {
  const started = now()
  const states = new Map<string, BrowserAdaptiveState>()
  const transitions: BrowserAdaptiveTransition[] = []
  const findings: BrowserAdaptiveFinding[] = []
  const diagnostics: BrowserAdaptiveExplorationResult["diagnostics"] = []
  const actionVisits = new Map<string, number>()
  let actions = 0
  let errors = 0
  let revisits = 0
  let keyboardActions = 0
  let exhausted: BrowserAdaptiveExplorationResult["summary"]["budgetExhausted"]

  const initial = await captureAdaptiveState(page, contract, 0, navigationScope)
  appendDiagnostics(diagnostics, initial.diagnostics, contract.descriptorLimits.maxDiagnostics)
  states.set(initial.state.digest, initial.state)
  const frontier: FrontierEntry[] = [{ state: initial.state, path: [] }]
  if (accessibilityCollector && contract.accessibility?.cadence.includes("initial")) {
    const scan = await accessibilityCollector.scan({ phase: "initial", stateDigest: initial.state.digest })
    if (scan.findings.length > 0 && onAccessibilityFindingEvidence) scan.artifacts = await onAccessibilityFindingEvidence(scan)
    findings.push(...adaptiveAccessibilityFindings(scan.findings, contract, [], "initial"))
    if (artifactBytes(states, transitions, diagnostics, findings) + Buffer.byteLength(stableJson(accessibilityCollector.evidence())) > adaptiveJsonArtifactBudget(contract, accessibilityCollector)) exhausted = "maxArtifactBytes"
  }
  if (artifactBytes(states, transitions, diagnostics, findings) > adaptiveJsonArtifactBudget(contract, accessibilityCollector)) exhausted = "maxArtifactBytes"

  while (frontier.length > 0 && !exhausted && findings.length === 0) {
    if (signal?.aborted) { exhausted = "cancelled"; break }
    if (now() - started >= contract.budgets.maxDurationMs) { exhausted = "maxDurationMs"; break }
    const source = frontier.shift() as FrontierEntry
    const candidates = orderBrowserAdaptiveActions(planBrowserAdaptiveStateActions(source.state, contract), contract.seed, source.state.digest)
    for (const action of candidates) {
      if (signal?.aborted) { exhausted = "cancelled"; break }
      if (actions >= contract.budgets.maxActions) { exhausted = "maxActions"; break }
      if (transitions.length >= contract.budgets.maxTransitions) { exhausted = "maxTransitions"; break }
      if (now() - started >= contract.budgets.maxDurationMs) { exhausted = "maxDurationMs"; break }
      const keyboardBudget = contract.accessibility?.budgets.maxKeyboardActions ?? Number.POSITIVE_INFINITY
      const actionVisitKey = `${source.state.digest}:${action.id}`
      const visits = actionVisits.get(actionVisitKey) ?? 0
      if (visits >= contract.revisitPolicy.maxActionVisits) continue
      actionVisits.set(actionVisitKey, visits + 1)

      if (contract.resetPolicy.mode === "start-url" && (transitions.length > 0 || source.path.length > 0)) {
        if (actions + source.path.length >= contract.budgets.maxActions) { exhausted = "maxActions"; break }
        if (keyboardActions + countKeyboardActions(source.path) > keyboardBudget) { exhausted = "maxKeyboardActions"; break }
        const restored = await restoreAdaptivePath(page, baseUrl, contract, source.path, signal, navigationScope, accessibilityCollector)
        actions += restored.executed
        keyboardActions += restored.keyboardExecuted
        appendDiagnostics(diagnostics, restored.diagnostics, contract.descriptorLimits.maxDiagnostics)
        if (!restored.state || restored.state.digest !== source.state.digest) {
          const rejected = rejectedTransition(source.state, action, page.url(), "browser_adaptive_source_state_not_reproduced", "The declared start URL and replay path did not reproduce the queued source state.")
          if (artifactBytes(states, [...transitions, rejected], diagnostics, findings) > adaptiveJsonArtifactBudget(contract, accessibilityCollector)) { exhausted = "maxArtifactBytes"; break }
          transitions.push(rejected)
          continue
        }
      }

      const beforeConsole = observations.consoleMessages.length
      const beforeErrors = observations.errors.length
      const beforeNetwork = observations.network.length
      const transitionStarted = now()
      await installMutationObservers(page, contract)
      if (action.family === "keyboard" && keyboardActions >= keyboardBudget) { exhausted = "maxKeyboardActions"; break }
      await accessibilityCollector?.beforeAction(action)
      let actionError: string | undefined
      try {
        await executeAdaptiveAction(page, action, contract.stabilization.maxWaitMs)
      } catch (error) {
        actionError = error instanceof Error ? error.message : String(error)
      }
      actions += 1
      if (action.family === "keyboard") keyboardActions += 1
      const stabilized = await stabilizeAdaptiveState(page, contract, source.path.length + 1, now, navigationScope)
      appendDiagnostics(diagnostics, stabilized.diagnostics, contract.descriptorLimits.maxDiagnostics)
      const scopeRejection = stabilized.diagnostics.find((diagnostic) => diagnostic.code === "browser_adaptive_redirect_scope_escape_rejected")
      const newConsoleRecords = consoleErrorRecords(observations.consoleMessages.slice(beforeConsole))
      const newConsoleErrors = newConsoleRecords.map(recordMessage)
      const newPageErrors = errorMessages(observations.errors.slice(beforeErrors))
      const oracleEvidence = adaptiveOracleEvidence(newConsoleRecords, observations.network.slice(beforeNetwork), newPageErrors, contract, networkPolicy)
      const fingerprints = [...oracleEvidence.fingerprints]
      const existing = states.get(stabilized.state.digest)
      const newState = !existing
      const transitionId = `transition-${transitions.length}`
      const accessibilityScan = accessibilityCollector && contract.accessibility?.cadence.includes("novel-state") && (newState || action.family === "keyboard") && !actionError
        ? await accessibilityCollector.scan({ phase: "novel-state", stateDigest: stabilized.state.digest, transitionId, action })
        : undefined
      const accessibilityFingerprints = accessibilityScan?.findings.map((finding) => finding.fingerprint) ?? []
      if (accessibilityScan && accessibilityScan.findings.length > 0 && onAccessibilityFindingEvidence) accessibilityScan.artifacts = await onAccessibilityFindingEvidence(accessibilityScan)
      fingerprints.push(...accessibilityFingerprints)
      fingerprints.sort()
      const replayableDestination = !actionError
      if (replayableDestination && newState && states.size < contract.budgets.maxStates) {
        states.set(stabilized.state.digest, stabilized.state)
      } else if (replayableDestination && newState) {
        exhausted = "maxStates"
      } else if (replayableDestination && existing) {
        revisits += 1
        existing.visits += 1
      }
      const destination = existing ?? stabilized.state
      const transition: BrowserAdaptiveTransition = {
        id: transitionId,
        sourceDigest: source.state.digest,
        destinationDigest: destination.digest,
        action,
        sourceUrl: source.state.url,
        destinationUrl: destination.url,
        history: { before: source.state.historyLength, after: destination.historyLength, beforeStateDigest: source.state.historyStateDigest, afterStateDigest: destination.historyStateDigest },
        timing: { durationMs: Math.max(0, now() - transitionStarted), stabilizationMs: stabilized.waitedMs, polls: stabilized.polls },
        novelty: {
          newState,
          newDescriptors: destination.descriptors.filter((descriptor) => !source.state.descriptors.some((candidate) => candidate.id === descriptor.id && candidate.frameId === descriptor.frameId)).length,
          mutationRecords: stabilized.mutationRecords,
          mutationEvidenceTruncated: stabilized.mutationEvidenceTruncated,
        },
        observations: {
          networkEvents: observations.network.length - beforeNetwork,
          consoleErrors: newConsoleErrors.slice(0, contract.budgets.maxErrors),
          pageErrors: newPageErrors.slice(0, contract.budgets.maxErrors),
          loadingBefore: source.state.loadingIndicators,
          loadingAfter: stabilized.loading,
          oracleFingerprints: fingerprints,
          ...(oracleEvidence.networkFailures.length > 0 ? { networkFailures: oracleEvidence.networkFailures } : {}),
          ...(oracleEvidence.networkFailureSummary ? { networkFailureSummary: oracleEvidence.networkFailureSummary } : {}),
          ...(accessibilityFingerprints.length > 0 ? { accessibilityFindingFingerprints: accessibilityFingerprints } : {}),
        },
        status: actionError ? "error" : scopeRejection ? "rejected" : newState ? "ok" : "revisited",
        ...(actionError ? { diagnostic: { code: "browser_adaptive_action_error", message: actionError } } : scopeRejection ? { diagnostic: { code: scopeRejection.code, message: scopeRejection.message } } : {}),
      }
      errors += oracleEvidence.errorCount + (actionError ? 1 : 0)
      if (artifactBytes(states, [...transitions, transition], diagnostics, findings) + (accessibilityCollector ? Buffer.byteLength(stableJson(accessibilityCollector.evidence())) : 0) > adaptiveJsonArtifactBudget(contract, accessibilityCollector)) {
        if (replayableDestination && newState) states.delete(stabilized.state.digest)
        exhausted = "maxArtifactBytes"
        break
      }
      transitions.push(transition)

      const path = [...source.path, action]
      if (replayableDestination && fingerprints.length > 0) {
        const fingerprint = fingerprints[0] as string
        const finding: BrowserAdaptiveFinding = {
          fingerprint,
          stateDigest: destination.digest,
          transitionId: transition.id,
          originalPath: path,
          minimizedPath: path,
          replay: {
            schema: BROWSER_ADAPTIVE_EXPLORATION_SCHEMA,
            seed: contract.seed,
            startUrl: contract.startUrl,
            expectedFingerprint: fingerprint,
            expectedStateDigest: destination.digest,
            actions: path,
            resetPolicy: contract.resetPolicy,
          },
        }
        if (artifactBytes(states, transitions, diagnostics, [finding]) + (accessibilityCollector ? Buffer.byteLength(stableJson(accessibilityCollector.evidence())) : 0) > adaptiveJsonArtifactBudget(contract, accessibilityCollector)) {
          exhausted = "maxArtifactBytes"
          break
        }
        findings.push(finding)
        break
      }
      if (errors >= contract.budgets.maxErrors) { exhausted = "maxErrors"; break }
      if (replayableDestination && newState && states.size <= contract.budgets.maxStates) frontier.push({ state: destination, path })
      if (replayableDestination && !newState && destination.visits < contract.revisitPolicy.maxStateVisits) frontier.push({ state: destination, path })
      if (contract.resetPolicy.mode === "none") break
    }
  }

  if (findings.length > 0 && !signal?.aborted) {
    for (const finding of findings) {
      const minimized = await minimizeAdaptiveFinding(page, baseUrl, contract, finding, observations, Math.max(0, contract.budgets.maxActions - actions), Math.max(0, (contract.accessibility?.budgets.maxKeyboardActions ?? Number.POSITIVE_INFINITY) - keyboardActions), started + contract.budgets.maxDurationMs, signal, now, navigationScope, networkPolicy, accessibilityCollector)
      actions += minimized.executed
      keyboardActions += minimized.keyboardExecuted
      finding.minimizedPath = minimized.path
      finding.replay.actions = finding.minimizedPath
      if (minimized.exhausted && !exhausted) exhausted = minimized.exhausted
    }
  }
  if (accessibilityCollector && findings.length === 0 && contract.accessibility?.cadence.includes("final")) {
    const finalState = await captureAdaptiveState(page, contract, 0, navigationScope)
    const scan = await accessibilityCollector.scan({ phase: "final", stateDigest: finalState.state.digest })
    if (scan.findings.length > 0 && onAccessibilityFindingEvidence) scan.artifacts = await onAccessibilityFindingEvidence(scan)
    findings.push(...adaptiveAccessibilityFindings(scan.findings, contract, [], "final"))
    if (artifactBytes(states, transitions, diagnostics, findings) + Buffer.byteLength(stableJson(accessibilityCollector.evidence())) > adaptiveJsonArtifactBudget(contract, accessibilityCollector)) exhausted = "maxArtifactBytes"
  }
  if (!exhausted && findings.length === 0 && frontier.length > 0) exhausted = "frontier"
  if (exhausted) appendTerminalDiagnostic(diagnostics, { code: exhausted === "cancelled" ? "browser_adaptive_cancelled" : "browser_adaptive_budget_exhausted", message: exhausted === "cancelled" ? "Adaptive exploration stopped scheduling actions after cancellation and retained partial evidence." : `Adaptive exploration stopped at the ${exhausted} bound.`, metadata: { budget: exhausted } }, contract.descriptorLimits.maxDiagnostics)

  return {
    schema: BROWSER_ADAPTIVE_EXPLORATION_SCHEMA,
    status: exhausted || accessibilityCollector?.evidence().summary.truncated || accessibilityRequirementsUnavailable(accessibilityCollector?.evidence(), contract) || accessibilityCollector?.evidence().scans.some((scan) => scan.status === "inconclusive") ? "incomplete" : findings.length > 0 ? "findings" : "completed",
    seed: contract.seed,
    startUrl: contract.startUrl,
    states: [...states.values()],
    transitions,
    findings,
    ...(accessibilityCollector ? { accessibility: accessibilityCollector.evidence() } : {}),
    diagnostics: diagnostics.slice(0, contract.descriptorLimits.maxDiagnostics),
    summary: { actions, states: states.size, transitions: transitions.length, revisits, errors, findings: findings.length, ...(exhausted ? { budgetExhausted: exhausted } : {}) },
    replay: { schema: BROWSER_ADAPTIVE_EXPLORATION_SCHEMA, seed: contract.seed, startUrl: contract.startUrl, contract },
  }
}

async function captureAdaptiveState(page: Page, contract: BrowserAdaptiveExplorationContract, depth: number, navigationScope?: BrowserPreviewNavigationScope): Promise<CapturedAdaptiveState> {
  const diagnostics: BrowserAdaptiveExplorationResult["diagnostics"] = []
  diagnostics.push(...(navigationScope?.drainDiagnostics() ?? []))
  const mainOrigin = origin(page.url())
  const frames = frameIdentities(page, contract.descriptorLimits.maxPerState)
  const descriptors: BrowserActionCorpusDescriptor[] = []
  const semanticFrames: Array<Record<string, unknown>> = []
  let loading = 0
  for (const identity of frames) {
    const frame = frameById(page, identity.id)
    if (!frame) continue
    const frameOrigin = origin(frame.url())
    if (identity.scope === "same-origin-frame" && frameOrigin && mainOrigin && frameOrigin !== mainOrigin) {
      diagnostics.push({ code: "browser_adaptive_frame_inaccessible", message: "A cross-origin frame was not explored.", metadata: { frameId: identity.id, url: frame.url() } })
      continue
    }
    try {
      const discovery = await discoverBrowserActionCorpusDescriptors(frame)
      diagnostics.push(...discovery.diagnostics.map((diagnostic) => ({ ...diagnostic, metadata: { ...diagnostic.metadata, frameId: identity.id } })))
      const scopedDescriptors = discovery.descriptors.filter((descriptor) => {
        if (!descriptor.href) return true
        const decision = navigationScope?.resolve(descriptor.href, frame.url())
        const hrefOrigin = origin(descriptor.href)
        if (decision?.allowed) {
          if (decision.routeDecision === "routed-preview") diagnostics.push({ code: "browser_adaptive_routed_action_allowed", message: "A link using a declared preview route was included in the adaptive action frontier.", metadata: { frameId: identity.id, descriptorId: descriptor.id, rawHrefOrigin: decision.rawOrigin, effectiveOrigin: decision.effectiveOrigin, routeDecision: decision.routeDecision, reason: decision.reason } })
          return true
        }
        if (!decision && (!hrefOrigin || !mainOrigin || hrefOrigin === mainOrigin)) return true
        diagnostics.push({ code: "browser_adaptive_cross_origin_action_rejected", message: "A link leaving the declared preview navigation scope was excluded from the adaptive action frontier.", metadata: { frameId: identity.id, descriptorId: descriptor.id, rawHrefOrigin: decision?.rawOrigin ?? hrefOrigin, effectiveOrigin: decision?.effectiveOrigin ?? mainOrigin, routeDecision: decision?.routeDecision ?? "external", reason: decision?.reason ?? "origin-mismatch" } })
        return false
      })
      descriptors.push(...scopedDescriptors.slice(0, contract.descriptorLimits.maxPerState).map((descriptor) => ({ ...descriptor, frameId: identity.id })))
      const semantic = await frame.evaluate(({ maxElements, maxTextLength }) => {
        const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, maxTextLength)
        const semanticId = (id: string | null) => id?.replace(/([_:-](?:[a-z]{0,4})?)[a-f0-9]{8,}$/i, "$1<generated>") || undefined
        const loadingSelectors = "[aria-busy='true'], [role='progressbar'], .loading, .spinner, [data-loading='true']"
        const visible = (element: Element) => {
          const rect = element.getBoundingClientRect()
          const style = getComputedStyle(element)
          return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
        }
        const dom = Array.from(document.body?.querySelectorAll("*") ?? []).filter(visible).slice(0, maxElements).map((element) => {
          const input = element as HTMLInputElement
          return {
            tag: element.tagName.toLowerCase(),
            id: semanticId(element.getAttribute("id")),
            class: element.getAttribute("class") || undefined,
            role: element.getAttribute("role") || undefined,
            ariaHidden: element.getAttribute("aria-hidden") || undefined,
            text: (element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120),
            value: "value" in input ? String(input.value).slice(0, 120) : undefined,
            checked: "checked" in input ? Boolean(input.checked) : undefined,
          }
        })
        return {
          title: document.title || "",
          text,
          dom,
          historyLength: history.length,
          historyState: (() => { try { const serialized = JSON.stringify(history.state); return typeof serialized === "string" ? serialized.slice(0, maxTextLength) : "null" } catch { return "[unserializable]" } })(),
          loading: Array.from(document.querySelectorAll(loadingSelectors)).filter(visible).length,
          shadowRoots: Array.from(document.querySelectorAll("*")).filter((element) => Boolean(element.shadowRoot)).length,
        }
      }, { maxElements: contract.descriptorLimits.maxPerState, maxTextLength: contract.descriptorLimits.maxTextLength })
      loading += semantic.loading
      if (semantic.shadowRoots > 0) diagnostics.push({ code: "browser_adaptive_shadow_roots_not_explored", message: "Open shadow roots were observed but are outside the current actionable descriptor scope.", metadata: { frameId: identity.id, observed: semantic.shadowRoots } })
      semanticFrames.push({ id: identity.id, url: frame.url(), title: semantic.title, text: semantic.text, dom: semantic.dom, historyLength: semantic.historyLength, historyState: semantic.historyState, loading: semantic.loading })
    } catch (error) {
      diagnostics.push({ code: "browser_adaptive_frame_inaccessible", message: "A frame could not be inspected within the bounded discovery pass.", metadata: { frameId: identity.id, url: frame.url(), reason: error instanceof Error ? error.message : String(error) } })
    }
  }
  const boundedDescriptors: BrowserActionCorpusDescriptor[] = []
  const descriptorByteBudget = Math.max(1_024, Math.floor(contract.budgets.maxArtifactBytes / 4))
  for (const descriptor of descriptors.slice(0, contract.descriptorLimits.maxPerState)) {
    if (Buffer.byteLength(stableJson([...boundedDescriptors, descriptor])) > descriptorByteBudget) break
    boundedDescriptors.push(descriptor)
  }
  if (descriptors.length > boundedDescriptors.length) diagnostics.push({ code: "browser_adaptive_descriptors_truncated", message: "Actionable descriptors were truncated at the per-state bound.", metadata: { discovered: descriptors.length, retained: boundedDescriptors.length } })
  const descriptorDigest = browserAdaptiveDigest("descriptors", boundedDescriptors.map(stableDescriptor))
  const digest = browserAdaptiveDigest("state", { frames: semanticFrames.map(({ historyLength: _historyLength, ...frame }) => frame), descriptorDigest })
  const mainSemantic = semanticFrames.find((frame) => frame.id === "document")
  return {
    state: {
      digest,
      url: page.url(),
      historyLength: typeof mainSemantic?.historyLength === "number" ? mainSemantic.historyLength : 0,
      historyStateDigest: browserAdaptiveDigest("state", mainSemantic?.historyState ?? "null"),
      descriptorDigest,
      descriptors: boundedDescriptors,
      frames: frames.filter((frame) => semanticFrames.some((semantic) => semantic.id === frame.id)),
      visits: 1,
      depth,
      loadingIndicators: loading,
    },
    diagnostics,
    loading,
  }
}

async function executeAdaptiveAction(page: Page, action: BrowserAdaptiveAction, timeout: number): Promise<void> {
  if (action.family === "back") { await page.goBack({ waitUntil: "domcontentloaded", timeout }); return }
  if (action.family === "reload") { await page.reload({ waitUntil: "domcontentloaded", timeout }); return }
  const frame = frameById(page, action.frameId)
  if (!frame) throw new Error(`Adaptive action frame is no longer available: ${action.frameId}`)
  let currentSelector: string | undefined
  if (action.descriptorId) {
    const current = (await discoverBrowserActionCorpusDescriptors(frame)).descriptors.filter((descriptor) => descriptor.id === action.descriptorId)
    if (current.length !== 1) throw new Error(`Adaptive descriptor must resolve exactly once, resolved ${current.length}: ${action.descriptorId}`)
    currentSelector = current[0]?.selector
  }
  for (const step of action.steps) {
    const selector = currentSelector ?? step.selector
    if (!selector && step.kind === "press") { await page.keyboard.press(String(step.key ?? "")); continue }
    if (!selector) throw new Error(`Adaptive ${step.kind} action requires a unique selector.`)
    const locator = frame.locator(selector)
    const count = await locator.count()
    if (count !== 1) throw new Error(`Adaptive selector must resolve exactly once, resolved ${count}: ${selector}`)
    if (step.kind === "click") await locator.click({ timeout })
    else if (step.kind === "fill") await locator.fill(String(step.value ?? ""), { timeout })
    else if (step.kind === "select") await locator.selectOption(Array.isArray(step.values) ? step.values : String(step.value ?? ""), { timeout })
    else if (step.kind === "press") await locator.press(String(step.key ?? ""), { timeout })
    else throw new Error(`Unsupported adaptive interaction step: ${step.kind}`)
  }
}

async function stabilizeAdaptiveState(page: Page, contract: BrowserAdaptiveExplorationContract, depth: number, now: () => number, navigationScope?: BrowserPreviewNavigationScope): Promise<StabilizationResult> {
  const started = now()
  const diagnostics: BrowserAdaptiveExplorationResult["diagnostics"] = []
  const diagnosticKeys = new Set<string>()
  const retainDiagnostics = (incoming: BrowserAdaptiveExplorationResult["diagnostics"]) => {
    for (const diagnostic of incoming) {
      const key = stableJson(diagnostic)
      if (!diagnosticKeys.has(key)) {
        diagnosticKeys.add(key)
        diagnostics.push(diagnostic)
      }
    }
  }
  let polls = 0
  let quietSince = started
  let previous: CapturedAdaptiveState | undefined
  while (now() - started < contract.stabilization.maxWaitMs) {
    await page.waitForTimeout(contract.stabilization.pollIntervalMs)
    const current = await captureAdaptiveState(page, contract, depth, navigationScope)
    retainDiagnostics(current.diagnostics)
    polls += 1
    if (!previous || current.state.digest !== previous.state.digest) quietSince = now()
    previous = current
    if (current.loading === 0 && now() - quietSince >= contract.stabilization.quietWindowMs) break
  }
  const state = previous ?? await captureAdaptiveState(page, contract, depth, navigationScope)
  if (!previous) retainDiagnostics(state.diagnostics)
  const mutations = await readMutationObservers(page, contract)
  return { ...state, diagnostics, waitedMs: Math.max(0, now() - started), polls, mutationRecords: mutations.count, mutationEvidenceTruncated: mutations.truncated }
}

async function installMutationObservers(page: Page, contract: BrowserAdaptiveExplorationContract): Promise<void> {
  await Promise.all(frameIdentities(page, contract.descriptorLimits.maxPerState).map(async (identity) => {
    const frame = frameById(page, identity.id)
    if (!frame) return
    await frame.evaluate(({ maximum }) => {
      const target = globalThis as typeof globalThis & { __wpCodeboxAdaptiveMutations?: { count: number; truncated: boolean; observer: MutationObserver } }
      target.__wpCodeboxAdaptiveMutations?.observer.disconnect()
      const evidence = { count: 0, truncated: false, observer: undefined as unknown as MutationObserver }
      evidence.observer = new MutationObserver((records) => {
        evidence.count += records.length
        if (evidence.count > maximum) { evidence.count = maximum; evidence.truncated = true }
      })
      if (document.documentElement) evidence.observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true })
      target.__wpCodeboxAdaptiveMutations = evidence
    }, { maximum: contract.stabilization.maxMutationRecords }).catch(() => undefined)
  }))
}

async function readMutationObservers(page: Page, contract: BrowserAdaptiveExplorationContract): Promise<{ count: number; truncated: boolean }> {
  let count = 0
  let truncated = false
  for (const identity of frameIdentities(page, contract.descriptorLimits.maxPerState)) {
    const frame = frameById(page, identity.id)
    if (!frame) continue
    const result = await frame.evaluate(() => {
      const target = globalThis as typeof globalThis & { __wpCodeboxAdaptiveMutations?: { count: number; truncated: boolean; observer: MutationObserver } }
      const evidence = target.__wpCodeboxAdaptiveMutations
      evidence?.observer.disconnect()
      return evidence ? { count: evidence.count, truncated: evidence.truncated } : { count: 0, truncated: false }
    }).catch(() => ({ count: 0, truncated: false }))
    count = Math.min(contract.stabilization.maxMutationRecords, count + result.count)
    truncated ||= result.truncated || count >= contract.stabilization.maxMutationRecords
  }
  return { count, truncated }
}

async function restoreAdaptivePath(page: Page, baseUrl: string, contract: BrowserAdaptiveExplorationContract, path: BrowserAdaptiveAction[], signal?: AbortSignal, navigationScope?: BrowserPreviewNavigationScope, accessibilityCollector?: BrowserAccessibilityCollector): Promise<{ state?: BrowserAdaptiveState; executed: number; keyboardExecuted: number; diagnostics: BrowserAdaptiveExplorationResult["diagnostics"]; oracleFingerprints: string[]; finalAccessibilityFingerprints: string[] }> {
  const diagnostics: BrowserAdaptiveExplorationResult["diagnostics"] = []
  let executed = 0
  let keyboardExecuted = 0
  const oracleFingerprints: string[] = []
  let finalAccessibilityFingerprints: string[] = []
  try {
    await accessibilityCollector?.reset()
    await page.goto(resolveUrl(contract.startUrl, baseUrl), { waitUntil: "domcontentloaded", timeout: contract.stabilization.maxWaitMs })
    await stabilizeAdaptiveState(page, contract, 0, Date.now, navigationScope)
    if (accessibilityCollector) {
      const initialScan = await accessibilityCollector.scan({ phase: "replay", record: false })
      finalAccessibilityFingerprints = initialScan.findings.map((finding) => finding.fingerprint)
      oracleFingerprints.push(...finalAccessibilityFingerprints)
    }
    for (const action of path) {
      if (signal?.aborted) return { executed, keyboardExecuted, diagnostics, oracleFingerprints, finalAccessibilityFingerprints }
      executed += 1
      if (action.family === "keyboard") keyboardExecuted += 1
      await accessibilityCollector?.beforeAction(action)
      await executeAdaptiveAction(page, action, contract.stabilization.maxWaitMs)
      const stabilized = await stabilizeAdaptiveState(page, contract, executed, Date.now, navigationScope)
      if (accessibilityCollector) {
        const scan = await accessibilityCollector.scan({ phase: "replay", stateDigest: stabilized.state.digest, action, record: false })
        finalAccessibilityFingerprints = scan.findings.map((finding) => finding.fingerprint)
        oracleFingerprints.push(...finalAccessibilityFingerprints)
      }
    }
    return { state: (await captureAdaptiveState(page, contract, path.length, navigationScope)).state, executed, keyboardExecuted, diagnostics, oracleFingerprints, finalAccessibilityFingerprints }
  } catch (error) {
    diagnostics.push({ code: "browser_adaptive_reset_replay_failed", message: "The start-URL reset path could not reproduce a queued state.", metadata: { reason: error instanceof Error ? error.message : String(error) } })
    return { executed, keyboardExecuted, diagnostics, oracleFingerprints, finalAccessibilityFingerprints }
  }
}

async function minimizeAdaptiveFinding(page: Page, baseUrl: string, contract: BrowserAdaptiveExplorationContract, finding: BrowserAdaptiveFinding, observations: AdaptiveObservationSources, maximumActions: number, maximumKeyboardActions: number, deadline: number, signal?: AbortSignal, now: () => number = Date.now, navigationScope?: BrowserPreviewNavigationScope, networkPolicy?: BrowserPreviewNetworkPolicy, accessibilityCollector?: BrowserAccessibilityCollector): Promise<{ path: BrowserAdaptiveAction[]; executed: number; keyboardExecuted: number; exhausted?: "maxActions" | "maxKeyboardActions" | "maxDurationMs" | "cancelled" }> {
  let current = [...finding.originalPath]
  let chunk = Math.max(1, Math.floor(current.length / 2))
  let executed = 0
  let keyboardExecuted = 0
  let exhausted: "maxActions" | "maxKeyboardActions" | "maxDurationMs" | "cancelled" | undefined
  while (current.length > 1 && chunk >= 1 && !signal?.aborted) {
    let reduced = false
    for (let start = 0; start < current.length; start += chunk) {
      const candidate = [...current.slice(0, start), ...current.slice(start + chunk)]
      if (candidate.length === 0) continue
      if (now() >= deadline) { exhausted = "maxDurationMs"; break }
      if (executed + candidate.length > maximumActions) { exhausted = "maxActions"; break }
      if (keyboardExecuted + countKeyboardActions(candidate) > maximumKeyboardActions) { exhausted = "maxKeyboardActions"; break }
      const beforeConsole = observations.consoleMessages.length
      const beforeErrors = observations.errors.length
      const beforeNetwork = observations.network.length
      const replay = await restoreAdaptivePath(page, baseUrl, contract, candidate, signal, navigationScope, accessibilityCollector)
      executed += replay.executed
      keyboardExecuted += replay.keyboardExecuted
      const fingerprints = adaptiveOracleEvidence(consoleErrorRecords(observations.consoleMessages.slice(beforeConsole)), observations.network.slice(beforeNetwork), errorMessages(observations.errors.slice(beforeErrors)), contract, networkPolicy).fingerprints.concat(replay.finalAccessibilityFingerprints)
      if (replay.state && fingerprints.includes(finding.fingerprint) && (!finding.stateDigest || replay.state.digest === finding.stateDigest)) {
        current = candidate
        reduced = true
        break
      }
    }
    if (exhausted) break
    if (!reduced) chunk = Math.floor(chunk / 2)
  }
  if (signal?.aborted) exhausted = "cancelled"
  return { path: current, executed, keyboardExecuted, ...(exhausted ? { exhausted } : {}) }
}

function frameIdentities(page: Page, maximum: number): BrowserAdaptiveFrameIdentity[] {
  const identities: BrowserAdaptiveFrameIdentity[] = [{ id: "document", url: page.url(), scope: "document" }]
  const walk = (parent: Frame, parentId: string) => {
    parent.childFrames().forEach((frame, index) => {
      if (identities.length >= maximum) return
      const id = parentId === "document" ? `frame:${index}` : `${parentId}.${index}`
      identities.push({ id, parentId, url: frame.url(), scope: "same-origin-frame" })
      walk(frame, id)
    })
  }
  walk(page.mainFrame(), "document")
  return identities
}

function frameById(page: Page, id: string): Frame | undefined {
  if (id === "document") return page.mainFrame()
  const indexes = id.replace(/^frame:/, "").split(".").map(Number)
  let frame = page.mainFrame()
  for (const index of indexes) {
    const next = frame.childFrames()[index]
    if (!next) return undefined
    frame = next
  }
  return frame
}

function stableDescriptor(descriptor: BrowserActionCorpusDescriptor): Record<string, unknown> {
  return { id: descriptor.id, frameId: descriptor.frameId, kind: descriptor.kind, label: descriptor.label, name: descriptor.name, role: descriptor.role, type: descriptor.type, href: descriptor.href, optionValues: descriptor.optionValues }
}

function rejectedTransition(state: BrowserAdaptiveState, action: BrowserAdaptiveAction, destinationUrl: string, code: string, message: string): BrowserAdaptiveTransition {
  return { id: `transition-rejected-${browserAdaptiveDigest("action", `${state.digest}:${action.id}`).slice(0, 12)}`, sourceDigest: state.digest, action, sourceUrl: state.url, destinationUrl, history: { before: state.historyLength, after: state.historyLength, beforeStateDigest: state.historyStateDigest, afterStateDigest: state.historyStateDigest }, timing: { durationMs: 0, stabilizationMs: 0, polls: 0 }, novelty: { newState: false, newDescriptors: 0, mutationRecords: 0, mutationEvidenceTruncated: false }, observations: { networkEvents: 0, consoleErrors: [], pageErrors: [], loadingBefore: 0, loadingAfter: 0, oracleFingerprints: [] }, status: "rejected", diagnostic: { code, message } }
}

function consoleErrorRecords(records: object[]): Record<string, unknown>[] {
  return records.map((record) => record as Record<string, unknown>).filter((record) => record.type === "error" || record.level === "error").slice(0, 100)
}

function adaptiveOracleEvidence(consoleRecords: Record<string, unknown>[], networkRecords: object[], pageErrors: string[], contract: BrowserAdaptiveExplorationContract, networkPolicy?: BrowserPreviewNetworkPolicy): { fingerprints: string[]; networkFailures: BrowserAdaptiveNetworkFailure[]; networkFailureSummary?: BrowserAdaptiveTransition["observations"]["networkFailureSummary"]; errorCount: number } {
  const failures = networkRecords.map((record) => record as Record<string, unknown>).filter((record) => record.type === "requestfailed")
  const classifiedFailures = failures.map((record): BrowserAdaptiveNetworkFailure & { expectedBlock: boolean } => {
    const url = typeof record.url === "string" ? record.url : ""
    const decision = networkPolicy ? browserPreviewNetworkDecision(url, networkPolicy) : { url, urlClassification: "invalid" as const, policyDecision: "unknown" as const, policyReason: "network-policy-unavailable" }
    const failure = networkFailureMessage(record)
    const expectedBlock = decision.policyDecision === "blocked" && /ERR_BLOCKED_BY_CLIENT|blockedbyclient/i.test(failure)
    return { ...decision, ...(failure ? { failure } : {}), oracleFinding: !expectedBlock || contract.oraclePolicy.policyBlocks === "finding", expectedBlock }
  })
  const unmatchedFailures = new Set(classifiedFailures.map((_failure, index) => index))
  const consoleMessages = consoleRecords.flatMap((record) => {
    const message = recordMessage(record)
    const locationUrl = objectRecord(record.location).url
    const match = classifiedFailures.findIndex((failure, index) => unmatchedFailures.has(index)
      && (typeof locationUrl === "string" && locationUrl ? failure.url === locationUrl : failureTokenMatches(message, failure.failure)))
    if (match < 0) return [message]
    unmatchedFailures.delete(match)
    const failure = classifiedFailures[match]!
    return failure.expectedBlock && contract.oraclePolicy.policyBlocks === "evidence" ? [] : [message]
  })
  const networkMessages = classifiedFailures.filter((failure, index) => unmatchedFailures.has(index) && failure.oracleFinding).map(networkFailureOracleMessage)
  const messages = [...consoleMessages, ...pageErrors, ...networkMessages]
  const networkFailureSummary = classifiedFailures.length > 0 ? boundedNetworkFailureEvidence(classifiedFailures, contract) : undefined
  return {
    fingerprints: [...new Set(messages.map((message) => browserAdaptiveDigest("oracle", message)))].sort(),
    networkFailures: networkFailureSummary?.failures ?? [],
    networkFailureSummary: networkFailureSummary?.summary,
    errorCount: consoleMessages.length + pageErrors.length + networkMessages.length,
  }
}

function boundedNetworkFailureEvidence(failures: Array<BrowserAdaptiveNetworkFailure & { expectedBlock: boolean }>, contract: BrowserAdaptiveExplorationContract): { failures: BrowserAdaptiveNetworkFailure[]; summary: NonNullable<BrowserAdaptiveTransition["observations"]["networkFailureSummary"]> } {
  const ordered = failures.map(({ expectedBlock: _expectedBlock, ...failure }) => failure).sort((left, right) => stableJson(left).localeCompare(stableJson(right)))
  const maximum = Math.min(contract.budgets.maxErrors, contract.descriptorLimits.maxDiagnostics)
  const byteBudget = Math.floor(contract.budgets.maxArtifactBytes / 8)
  const retained: BrowserAdaptiveNetworkFailure[] = []
  for (const failure of ordered.slice(0, maximum)) {
    if (Buffer.byteLength(stableJson([...retained, failure])) > byteBudget) break
    retained.push(failure)
  }
  return {
    failures: retained,
    summary: {
      total: failures.length,
      retained: retained.length,
      policyBlocks: failures.filter((failure) => failure.expectedBlock).length,
      oracleFindings: failures.filter((failure) => failure.oracleFinding).length,
      truncated: retained.length < failures.length,
    },
  }
}

function failureTokenMatches(message: string, failure: string | undefined): boolean {
  const token = failure?.match(/ERR_[A-Z0-9_]+/i)?.[0]
  return Boolean(token && message.toUpperCase().includes(token.toUpperCase()))
}

function networkFailureOracleMessage(failure: BrowserAdaptiveNetworkFailure): string {
  return stableJson({ type: "requestfailed", url: failure.url, failure: failure.failure, urlClassification: failure.urlClassification, policyDecision: failure.policyDecision, policyReason: failure.policyReason })
}

function networkFailureMessage(record: Record<string, unknown>): string {
  const failure = objectRecord(record.failure)
  return typeof failure.errorText === "string" ? failure.errorText : typeof record.failure === "string" ? record.failure : ""
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function errorMessages(records: object[]): string[] {
  return records.map((record) => recordMessage(record as Record<string, unknown>)).filter(Boolean).slice(0, 100)
}

function recordMessage(record: Record<string, unknown>): string {
  return typeof record.message === "string" ? record.message : typeof record.text === "string" ? record.text : stableJson(record).slice(0, 1_000)
}

function artifactBytes(states: Map<string, BrowserAdaptiveState>, transitions: BrowserAdaptiveTransition[], diagnostics: BrowserAdaptiveExplorationResult["diagnostics"], findings: BrowserAdaptiveFinding[]): number {
  return Buffer.byteLength(stableJson({ states: [...states.values()], transitions, diagnostics, findings }))
}

function adaptiveJsonArtifactBudget(contract: BrowserAdaptiveExplorationContract, collector?: BrowserAccessibilityCollector): number {
  return collector ? Math.max(512, Math.floor(contract.budgets.maxArtifactBytes / 2)) : contract.budgets.maxArtifactBytes
}

function countKeyboardActions(actions: BrowserAdaptiveAction[]): number {
  return actions.filter((action) => action.family === "keyboard").length
}

function accessibilityRequirementsUnavailable(evidence: ReturnType<BrowserAccessibilityCollector["evidence"]> | undefined, contract: BrowserAdaptiveExplorationContract): boolean {
  if (!evidence || !contract.accessibility) return false
  return (contract.accessibility.capabilities.rules === "required" && evidence.collector.capabilities.rules !== "supported")
    || (contract.accessibility.capabilities.focus === "required" && evidence.collector.capabilities.focus !== "supported")
    || (contract.accessibility.capabilities.accessibilityTree === "required" && evidence.collector.capabilities.accessibilityTree !== "supported")
}

function adaptiveAccessibilityFindings(items: BrowserA11yFinding[], contract: BrowserAdaptiveExplorationContract, path: BrowserAdaptiveAction[], transitionId: string): BrowserAdaptiveFinding[] {
  return items.map((item) => ({
    fingerprint: item.fingerprint,
    stateDigest: item.stateDigest,
    transitionId,
    originalPath: path,
    minimizedPath: path,
    replay: { schema: BROWSER_ADAPTIVE_EXPLORATION_SCHEMA, seed: contract.seed, startUrl: contract.startUrl, expectedFingerprint: item.fingerprint, expectedStateDigest: item.stateDigest, actions: path, resetPolicy: contract.resetPolicy },
  }))
}

function appendDiagnostics(target: BrowserAdaptiveExplorationResult["diagnostics"], incoming: BrowserAdaptiveExplorationResult["diagnostics"], maximum: number): void {
  const remaining = Math.max(0, maximum - target.length)
  if (remaining > 0) target.push(...incoming.slice(0, remaining))
}

function appendTerminalDiagnostic(target: BrowserAdaptiveExplorationResult["diagnostics"], diagnostic: BrowserAdaptiveExplorationResult["diagnostics"][number], maximum: number): void {
  if (target.length < maximum) target.push(diagnostic)
  else target[Math.max(0, maximum - 1)] = diagnostic
}

function origin(url: string): string | undefined {
  try { return new URL(url).origin } catch { return undefined }
}

function resolveUrl(pathOrUrl: string, baseUrl: string): string {
  try { return new URL(pathOrUrl).toString() } catch { return new URL(pathOrUrl, baseUrl).toString() }
}
