import assert from "node:assert/strict"
import { createServer } from "node:http"
import test from "node:test"
import { chromium, type Page } from "playwright"

import {
  BROWSER_ADAPTIVE_EXPLORATION_SCHEMA,
  browserAdaptiveExplorationContract,
  planBrowserAdaptiveStateActions,
} from "../packages/runtime-core/src/browser-adaptive-exploration.js"
import { getCommandDefinition } from "../packages/runtime-core/src/command-registry.js"
import { exploreAdaptiveBrowserStateMachine } from "../packages/runtime-playground/src/browser-adaptive-explorer.js"
import { browserPreviewTopology, routeBrowserPreviewContextNetwork } from "../packages/runtime-playground/src/browser-preview-routing.js"
import { closeHttpServer, listenLocalHttpServer } from "../packages/runtime-playground/src/preview-server.js"

const modalFixture = `<!doctype html>
<style>button,input,select { display:block; width:180px; height:30px; margin:8px; }</style>
<button id="open-modal">Open dynamic modal</button>
<script>
document.querySelector('#open-modal').addEventListener('click', () => {
  if (document.querySelector('#dynamic-modal')) return;
  setTimeout(() => {
    const modal = document.createElement('div');
    modal.id = 'dynamic-modal';
    modal.innerHTML = '<form id="modal-form"><label>Delayed value <input id="delayed-value"></label><button id="modal-save" type="submit">Save modal</button></form>';
    modal.querySelector('#modal-save').addEventListener('click', (event) => { event.preventDefault(); setTimeout(() => { throw new Error('dynamic modal defect'); }, 0); });
    document.body.append(modal);
  }, 60);
});
</script>`

const delayedRouteFixture = `<!doctype html>
<style>button,input,select { display:block; width:180px; height:30px; margin:8px; }</style>
<button id="configure">Configure</button>
<script>
document.querySelector('#configure').addEventListener('click', () => setTimeout(() => {
  history.pushState({ stage: 2 }, '', '#configured');
  const label = document.createElement('label');
  label.innerHTML = 'Conditional field <input id="conditional-field" name="conditional">';
  document.body.append(label);
}, 80));
</script>`

const interceptedRepeatFixture = `<!doctype html>
<style>
button { display:block; width:180px; height:30px; margin:8px; }
#overlay { position:fixed; inset:0; z-index:10; background:white; }
</style>
<button id="open-overlay">Open overlay</button>
<button id="continue">Continue <span id="count">0</span></button>
<script>
document.querySelector('#open-overlay').addEventListener('click', () => {
  if (document.querySelector('#overlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'overlay';
  overlay.innerHTML = '<button id="overlay-action">Overlay action</button>';
  document.body.append(overlay);
});
document.querySelector('#continue').addEventListener('click', () => {
  const count = document.querySelector('#count');
  count.textContent = String(Number(count.textContent) + 1);
});
</script>`

test("adaptive browser exploration is an additive public browser-actions mode", () => {
  const definition = getCommandDefinition("wordpress.browser-actions")
  const argument = definition?.acceptedArgs.find((candidate) => candidate.name === "adaptive-exploration-json")
  assert.equal(argument?.format, "JSON object")
  assert.match(argument?.description ?? "", /bounded deterministic state graph/)
  assert(definition?.acceptedArgs.some((candidate) => candidate.name === "action-corpus-json"), "one-shot corpus remains public")
  assert(definition?.acceptedArgs.some((candidate) => candidate.name === "steps-json"), "authored steps remain public")
})

test("adaptive contract normalizes every safety and exploration bound", () => {
  const contract = browserAdaptiveExplorationContract({
    seed: "bounded",
    startUrl: "/fixture",
    actionFamilies: ["click", "fill", "double-submit", "unknown"],
    budgets: { maxActions: 0, maxStates: 9999, maxTransitions: 7, maxDurationMs: 1, maxArtifactBytes: 2, maxErrors: 3 },
    revisitPolicy: { maxStateVisits: 0, maxActionVisits: 99 },
    descriptorLimits: { maxPerState: 4, maxDiagnostics: 5, maxTextLength: 1 },
    stabilization: { pollIntervalMs: 1, quietWindowMs: 1, maxWaitMs: 1, maxMutationRecords: 0 },
  })
  assert.equal(contract.schema, BROWSER_ADAPTIVE_EXPLORATION_SCHEMA)
  assert.deepEqual(contract.actionFamilies, ["click", "fill", "double-submit"])
  assert.equal(contract.budgets.maxActions, 1)
  assert.equal(contract.budgets.maxStates, 250)
  assert.equal(contract.budgets.maxArtifactBytes, 1024)
  assert.equal(contract.revisitPolicy.maxStateVisits, 1)
  assert.equal(contract.descriptorLimits.maxTextLength, 64)
  assert.equal(contract.stabilization.pollIntervalMs, 10)

  const allFamilies = browserAdaptiveExplorationContract({ seed: "families", startUrl: "/fixture" })
  const planned = planBrowserAdaptiveStateActions({
    digest: "state",
    url: "/fixture",
    historyLength: 1,
    historyStateDigest: "history",
    descriptorDigest: "descriptors",
    descriptors: [
      { id: "input", kind: "input", selector: "#field", type: "text", formId: "form", frameId: "document" },
      { id: "select", kind: "select", selector: "#choice", optionValues: ["one"], formId: "form", frameId: "document" },
      { id: "submit", kind: "button", selector: "#submit", type: "submit", formId: "form", frameId: "document" },
      { id: "link", kind: "link", selector: "#link", frameId: "document" },
    ],
    frames: [{ id: "document", url: "/fixture", scope: "document" }],
    visits: 1,
    depth: 0,
    loadingIndicators: 0,
  }, allFamilies)
  assert.deepEqual(new Set(planned.map((action) => action.family)), new Set(["click", "fill", "select", "submit", "keyboard", "back", "reload", "repeat", "double-submit"]))
})

test("rediscovery finds, minimizes, and replays a defect revealed by a dynamic modal", async () => {
  const run = await runFixture(modalFixture, {
    seed: "modal-seed",
    budgets: { maxActions: 80, maxStates: 24, maxTransitions: 80, maxDurationMs: 30_000, maxArtifactBytes: 2_000_000, maxErrors: 10 },
    actionFamilies: ["click", "fill", "submit", "repeat", "double-submit"],
  })
  assert.equal(run.result.status, "findings")
  assert.equal(run.result.findings.length, 1)
  const finding = run.result.findings[0]!
  assert(run.result.states.some((state) => state.descriptors.some((descriptor) => descriptor.selector === "#modal-save")), "modal controls must be discovered after interaction")
  assert(run.result.transitions.some((transition) => transition.novelty.newDescriptors >= 2 && transition.novelty.mutationRecords > 0), "modal transition must retain bounded mutation novelty")
  assert(finding.originalPath.length >= 2, "the failure requires opening the modal before its generated final action")
  assert(finding.minimizedPath.length <= finding.originalPath.length)
  assert.deepEqual(finding.replay.actions, finding.minimizedPath)
  assert.equal(finding.replay.expectedFingerprint, finding.fingerprint)
  assert.equal(finding.replay.expectedStateDigest, finding.stateDigest)
})

test("bounded stabilization captures delayed conditional fields and route state", async () => {
  const run = await runFixture(delayedRouteFixture, {
    seed: "delayed-route",
    failOnFinding: false,
    budgets: { maxActions: 20, maxStates: 12, maxTransitions: 20, maxDurationMs: 20_000 },
    actionFamilies: ["click", "fill"],
  })
  const transition = run.result.transitions.find((candidate) => candidate.destinationUrl.endsWith("#configured"))
  assert(transition, "route transition should be observed after bounded stabilization")
  assert(transition.novelty.newDescriptors >= 1)
  assert(transition.timing.polls >= 2)
  const destination = run.result.states.find((state) => state.digest === transition.destinationDigest)
  assert(destination?.descriptors.some((descriptor) => descriptor.selector === "#conditional-field"))
})

test("identical seed and DOM produce deterministic state and action graph identity", async () => {
  const input = {
    seed: "deterministic-graph",
    failOnFinding: false,
    budgets: { maxActions: 8, maxStates: 8, maxTransitions: 8, maxDurationMs: 15_000 },
    actionFamilies: ["click", "fill"],
  }
  const first = await runFixture(delayedRouteFixture, input)
  const second = await runFixture(delayedRouteFixture, input)
  const stableGraph = (result: typeof first.result) => ({
    states: result.states.map((state) => ({ digest: state.digest, descriptorDigest: state.descriptorDigest, descriptors: state.descriptors.map((descriptor) => descriptor.id) })),
    transitions: result.transitions.map((transition) => ({ source: transition.sourceDigest, destination: transition.destinationDigest, action: transition.action.id, status: transition.status, newDescriptors: transition.novelty.newDescriptors })),
  })
  assert.deepEqual(stableGraph(second.result), stableGraph(first.result))
})

test("partially failed actions retain evidence without creating unreplayable frontier paths", async () => {
  const input = {
    seed: "partial-repeat",
    failOnFinding: false,
    budgets: { maxActions: 8, maxStates: 8, maxTransitions: 8, maxDurationMs: 15_000, maxErrors: 4 },
    actionFamilies: ["repeat"],
  }
  const first = await runFixture(interceptedRepeatFixture, input)
  const second = await runFixture(interceptedRepeatFixture, input)
  const failedIndex = first.result.transitions.findIndex((transition) => transition.status === "error" && transition.action.steps[0]?.selector === "#open-overlay")
  const failed = first.result.transitions[failedIndex]
  assert(failed, "the intercepted second click must remain as error transition evidence")
  assert.equal(failed.action.steps.length, 2)
  assert.equal(failed.diagnostic?.code, "browser_adaptive_action_error")
  assert(!first.result.states.some((state) => state.digest === failed.destinationDigest), "the partially reached destination must not become a replayable state")
  assert(first.result.transitions.slice(failedIndex + 1).some((transition) => transition.status !== "error" && transition.action.steps[0]?.selector === "#continue"), "other actions from the replayable source must continue")
  assert(!first.result.diagnostics.some((diagnostic) => diagnostic.code === "browser_adaptive_reset_replay_failed" || diagnostic.code === "browser_adaptive_source_state_not_reproduced"))
  assert(!first.result.transitions.some((transition) => transition.diagnostic?.code === "browser_adaptive_source_state_not_reproduced"))
  assert.equal(first.result.findings.length, 0, "a failed full action must not produce an unreplayable finding or minimization path")
  assert.notEqual(first.result.summary.budgetExhausted, "maxDurationMs")

  const stableGraph = (result: typeof first.result) => ({
    states: result.states.map((state) => state.digest),
    transitions: result.transitions.map((transition) => ({ source: transition.sourceDigest, destination: transition.destinationDigest, action: transition.action.id, status: transition.status, diagnostic: transition.diagnostic?.code })),
    summary: result.summary,
  })
  assert.deepEqual(stableGraph(second.result), stableGraph(first.result))
})

test("cancellation during a partially failed action retains bounded non-replayable evidence", async () => {
  const controller = new AbortController()
  const run = await runFixture(interceptedRepeatFixture, {
    seed: "partial-repeat",
    failOnFinding: false,
    budgets: { maxActions: 8, maxStates: 8, maxTransitions: 8, maxDurationMs: 15_000, maxErrors: 4 },
    actionFamilies: ["repeat"],
  }, controller.signal, () => setTimeout(() => controller.abort("cancel during intercepted click"), 250))
  const failed = run.result.transitions.find((transition) => transition.status === "error")
  assert(failed)
  assert.equal(run.result.status, "incomplete")
  assert.equal(run.result.summary.budgetExhausted, "cancelled")
  assert(!run.result.states.some((state) => state.digest === failed.destinationDigest))
  assert.equal(run.result.findings.length, 0)
  assert(!run.result.diagnostics.some((diagnostic) => diagnostic.code === "browser_adaptive_reset_replay_failed"))
})

test("adaptive exploration follows routed canonical multisite links and rejects redirect escapes", async () => {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://preview.invalid").pathname
    response.setHeader("content-type", "text/html")
    if (path === "/escape/") {
      response.statusCode = 302
      response.setHeader("location", "https://outside.example/private?token=secret")
      response.end()
      return
    }
    const next = path === "/" ? "http://localhost/alpha/" : path === "/alpha/" ? "/beta/" : undefined
    response.end(`<!doctype html><style>a{display:block;width:180px;height:30px}</style><h1>${path}</h1>${next ? `<a id="next" href="${next}">Next</a>` : ""}`)
  })
  const effectiveOrigin = await listenLocalHttpServer(server)
  const topology = browserPreviewTopology(["route-host=localhost,preview.test", "network-policy=block", "allow-host=localhost,cdn.example.test"], undefined, effectiveOrigin)
  try {
    const first = await runRoutedFixture(topology, effectiveOrigin)
    const second = await runRoutedFixture(topology, effectiveOrigin)
    assert(first.states.some((state) => state.url === "http://localhost/alpha/"))
    assert(first.states.some((state) => state.url === "http://localhost/beta/"))
    assert(!first.diagnostics.some((diagnostic) => diagnostic.code === "browser_adaptive_cross_origin_action_rejected"))
    assert(first.diagnostics.some((diagnostic) => diagnostic.code === "browser_adaptive_routed_action_allowed" && diagnostic.metadata?.rawHrefOrigin === "http://localhost" && diagnostic.metadata?.effectiveOrigin === new URL(effectiveOrigin).origin && diagnostic.metadata?.routeDecision === "routed-preview" && diagnostic.metadata?.reason === "declared-route-host"))
    assert.deepEqual(stableAdaptiveEvidence(second), stableAdaptiveEvidence(first))

    const escape = await runRoutedFixture(topology, effectiveOrigin, "<a id='escape' href='http://localhost/escape/'>Escape</a>")
    const diagnostic = escape.diagnostics.find((item) => item.code === "browser_adaptive_redirect_scope_escape_rejected")
    assert.deepEqual(diagnostic?.metadata, {
      rawHrefOrigin: "https://outside.example",
      effectiveOrigin: new URL(effectiveOrigin).origin,
      routeDecision: "external",
      reason: "redirect-host-not-routed-to-preview",
    })
    assert.equal(escape.transitions[0]?.status, "rejected")
    assert(!JSON.stringify(diagnostic).includes("secret"), "redirect evidence must not retain query secrets")
  } finally {
    await closeHttpServer(server)
  }
})

test("loops, budgets, cancellation, frames, and partial evidence remain bounded", async () => {
  const loopFixture = `<!doctype html><style>button,input,a,iframe { display:block;width:100px;height:30px }</style><button id="toggle">Toggle</button><form id="first"><input name="query"></form><form id="second"><input name="query"></form><a id="external" href="https://example.test/outside">External</a><iframe id="same" srcdoc="<style>button{width:100px;height:30px}</style><button id='framed'>Framed</button>"></iframe><script>toggle.onclick=()=>document.body.classList.toggle('on')</script>`
  const bounded = await runFixture(loopFixture, {
    seed: "loop-bound",
    failOnFinding: false,
    budgets: { maxActions: 4, maxStates: 3, maxTransitions: 4, maxDurationMs: 15_000, maxArtifactBytes: 200_000 },
    revisitPolicy: { maxStateVisits: 1, maxActionVisits: 1 },
    actionFamilies: ["click", "reload"],
  })
  assert(bounded.result.summary.actions <= 4)
  assert(bounded.result.summary.transitions <= 4)
  assert(bounded.result.summary.states <= 3)
  assert(bounded.result.states.some((state) => state.frames.some((frame) => frame.id === "frame:0")))
  assert(bounded.result.states.some((state) => state.descriptors.some((descriptor) => descriptor.frameId === "frame:0" && descriptor.selector === "#framed")))
  const repeated = bounded.result.states[0]!.descriptors.filter((descriptor) => descriptor.name === "query")
  assert.equal(repeated.length, 2)
  assert.equal(new Set(repeated.map((descriptor) => descriptor.selector)).size, 2, "repeated controls retain #2027 unique selectors")
  assert(bounded.result.diagnostics.some((diagnostic) => diagnostic.code === "browser_adaptive_cross_origin_action_rejected"))

  const controller = new AbortController()
  controller.abort("fixture cancellation")
  const cancelled = await runFixture(loopFixture, { seed: "cancelled", failOnFinding: false }, controller.signal)
  assert.equal(cancelled.result.status, "incomplete")
  assert.equal(cancelled.result.summary.budgetExhausted, "cancelled")
  assert.equal(cancelled.result.transitions.length, 0)
  assert(cancelled.result.states.length >= 1, "partial initial-state evidence is retained")
})

test("no-reset exploration remains a truthful linear state chain", async () => {
  const linear = await runFixture(`<!doctype html><style>button{display:block;width:100px;height:30px}</style><button id="advance">Stage one</button><script>advance.onclick=()=>{ advance.textContent = advance.textContent === 'Stage one' ? 'Stage two' : 'Stage three' }</script>`, {
    seed: "linear-no-reset",
    failOnFinding: false,
    resetPolicy: { mode: "none" },
    revisitPolicy: { maxStateVisits: 2, maxActionVisits: 1 },
    budgets: { maxActions: 3, maxStates: 4, maxTransitions: 3, maxDurationMs: 10_000 },
    actionFamilies: ["click"],
  })
  assert(linear.result.transitions.length >= 2)
  for (let index = 1; index < linear.result.transitions.length; index += 1) {
    assert.equal(linear.result.transitions[index]!.sourceDigest, linear.result.transitions[index - 1]!.destinationDigest)
  }
})

async function runFixture(html: string, input: Record<string, unknown>, signal?: AbortSignal, beforeExplore?: () => void) {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  const consoleMessages: object[] = []
  const errors: object[] = []
  const network: object[] = []
  page.on("console", (message) => consoleMessages.push({ type: message.type(), text: message.text() }))
  page.on("pageerror", (error) => errors.push({ message: error.message }))
  page.on("request", (request) => network.push({ url: request.url(), method: request.method() }))
  await page.addInitScript("globalThis.__name = value => value")
  const startUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
  await page.goto(startUrl, { waitUntil: "load" })
  const contract = browserAdaptiveExplorationContract({ startUrl, stabilization: { pollIntervalMs: 25, quietWindowMs: 100, maxWaitMs: 1500, maxMutationRecords: 40 }, ...input })
  try {
    beforeExplore?.()
    const result = await exploreAdaptiveBrowserStateMachine({ page, baseUrl: startUrl, contract, observations: { consoleMessages, errors, network }, signal })
    return { result, contract }
  } finally {
    await browser.close()
  }
}

async function runRoutedFixture(topology: ReturnType<typeof browserPreviewTopology>, effectiveOrigin: string, initialHtml?: string) {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext()
  await routeBrowserPreviewContextNetwork(context, topology.networkPolicy, effectiveOrigin)
  const page = await context.newPage()
  const consoleMessages: object[] = []
  const errors: object[] = []
  const network: object[] = []
  page.on("console", (message) => consoleMessages.push({ type: message.type(), text: message.text() }))
  page.on("pageerror", (error) => errors.push({ message: error.message }))
  page.on("request", (request) => network.push({ url: request.url(), method: request.method() }))
  await page.addInitScript("globalThis.__name = value => value")
  await page.goto(effectiveOrigin, { waitUntil: "load" })
  if (initialHtml) await page.setContent(`<!doctype html><style>a{display:block;width:180px;height:30px}</style>${initialHtml}`)
  const contract = browserAdaptiveExplorationContract({
    seed: "routed-multisite",
    startUrl: effectiveOrigin,
    failOnFinding: false,
    resetPolicy: { mode: "none" },
    actionFamilies: ["click"],
    budgets: { maxActions: initialHtml ? 1 : 2, maxStates: 4, maxTransitions: 2, maxDurationMs: 10_000 },
    stabilization: { pollIntervalMs: 25, quietWindowMs: 50, maxWaitMs: 500, maxMutationRecords: 20 },
  })
  try {
    return await exploreAdaptiveBrowserStateMachine({ page, baseUrl: effectiveOrigin, contract, observations: { consoleMessages, errors, network }, navigationScope: topology.navigationScope })
  } finally {
    await browser.close()
  }
}

function stableAdaptiveEvidence(result: Awaited<ReturnType<typeof runRoutedFixture>>) {
  return {
    states: result.states.map((state) => ({ digest: state.digest, url: state.url, descriptors: state.descriptors.map((descriptor) => descriptor.id) })),
    transitions: result.transitions.map((transition) => ({ source: transition.sourceDigest, destination: transition.destinationDigest, action: transition.action.id, status: transition.status })),
    diagnostics: result.diagnostics,
  }
}
