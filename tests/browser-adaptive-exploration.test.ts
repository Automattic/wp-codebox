import assert from "node:assert/strict"
import { createServer } from "node:http"
import test from "node:test"
import { chromium, type Page } from "playwright"

import {
  BROWSER_ADAPTIVE_EXPLORATION_SCHEMA,
  browserAdaptiveDigest,
  browserAdaptiveExplorationContract,
  planBrowserAdaptiveStateActions,
} from "../packages/runtime-core/src/browser-adaptive-exploration.js"
import { getCommandDefinition } from "../packages/runtime-core/src/command-registry.js"
import { discoverBrowserActionCorpusDescriptors } from "../packages/runtime-playground/src/browser-action-discovery.js"
import { exploreAdaptiveBrowserStateMachine } from "../packages/runtime-playground/src/browser-adaptive-explorer.js"
import { attachBrowserCaptureListeners } from "../packages/runtime-playground/src/browser-capture-session.js"
import { executeBrowserInteractionStep } from "../packages/runtime-playground/src/browser-interactions.js"
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
  assert.deepEqual(contract.oraclePolicy, { policyBlocks: "evidence" })

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
      { id: "link", kind: "link", selector: "#link", href: "https://example.test/next", frameId: "document" },
    ],
    frames: [{ id: "document", url: "/fixture", scope: "document" }],
    visits: 1,
    depth: 0,
    loadingIndicators: 0,
  }, allFamilies)
  assert.deepEqual(new Set(planned.map((action) => action.family)), new Set(["click", "fill", "select", "submit", "keyboard", "back", "reload", "repeat", "double-submit"]))
})

test("adaptive planner repeats in-place controls but not navigation anchors", () => {
  const contract = browserAdaptiveExplorationContract({ seed: "navigation-semantics", startUrl: "https://example.test/start" })
  const descriptors = [
    { id: "internal", kind: "link" as const, selector: "#internal", href: "https://example.test/next", frameId: "document" },
    { id: "external", kind: "link" as const, selector: "#external", href: "https://outside.example/next", frameId: "document" },
    { id: "hash", kind: "link" as const, selector: "#hash", href: "https://example.test/start#tab", role: "tab", frameId: "document" },
    { id: "download", kind: "link" as const, selector: "#download", href: "https://example.test/report.pdf", frameId: "document" },
    { id: "anchor-button", kind: "link" as const, selector: "#anchor-button", role: "button", frameId: "document" },
    { id: "button", kind: "button" as const, selector: "#button", type: "button", frameId: "document" },
    { id: "submit", kind: "button" as const, selector: "#submit", type: "submit", formId: "form", frameId: "document" },
  ]
  const state = {
    digest: "state",
    url: "https://example.test/start",
    historyLength: 1,
    historyStateDigest: "history",
    descriptorDigest: "descriptors",
    descriptors,
    frames: [{ id: "document", url: "https://example.test/start", scope: "document" as const }],
    visits: 1,
    depth: 0,
    loadingIndicators: 0,
  }
  const planned = planBrowserAdaptiveStateActions(state, contract)
  const familiesFor = (id: string) => planned.filter((action) => action.descriptorId === id).map((action) => action.family)

  for (const id of ["internal", "external", "hash", "download"]) assert.deepEqual(familiesFor(id), ["click"], id)
  assert.deepEqual(familiesFor("anchor-button"), ["click", "repeat"])
  assert.deepEqual(familiesFor("button"), ["click", "repeat"])
  assert.deepEqual(familiesFor("submit"), ["click", "repeat", "submit", "double-submit"])
  assert.deepEqual(planBrowserAdaptiveStateActions(state, contract), planned, "semantic filtering preserves deterministic action identity and order")
})

test("adaptive planner selects actions by HTML input type capability", () => {
  const fillableTypes = ["text", "search", "tel", "url", "email", "password", "number"]
  const toggleTypes = ["checkbox", "radio"]
  const buttonTypes = ["button", "reset"]
  const submitTypes = ["submit", "image"]
  const unsupportedTypes = ["color", "date", "datetime-local", "file", "hidden", "month", "range", "time", "week"]
  const descriptors = [
    { id: "default", kind: "input" as const, selector: "#default", formId: "form", frameId: "document" },
    ...[...fillableTypes, ...toggleTypes, ...buttonTypes, ...submitTypes, ...unsupportedTypes].map((type) => ({ id: type, kind: "input" as const, selector: `#${type}`, type, formId: "form", frameId: "document" })),
    { id: "textarea", kind: "textarea" as const, selector: "#textarea", formId: "form", frameId: "document" },
    { id: "disabled", kind: "input" as const, selector: "#disabled", type: "text", disabled: true, frameId: "document" },
    { id: "readonly", kind: "input" as const, selector: "#readonly", type: "text", readonly: true, frameId: "document" },
  ]
  const contract = browserAdaptiveExplorationContract({ seed: "input-capabilities", startUrl: "/fixture" })
  const planned = planBrowserAdaptiveStateActions({
    digest: "state",
    url: "/fixture",
    historyLength: 1,
    historyStateDigest: "history",
    descriptorDigest: "descriptors",
    descriptors,
    frames: [{ id: "document", url: "/fixture", scope: "document" }],
    visits: 1,
    depth: 0,
    loadingIndicators: 0,
  }, contract)
  const familiesFor = (id: string) => planned.filter((action) => action.descriptorId === id).map((action) => action.family)

  for (const type of ["default", ...fillableTypes, "textarea"]) assert.deepEqual(familiesFor(type), ["fill", "keyboard", "submit", "repeat"], type)
  for (const type of toggleTypes) assert.deepEqual(familiesFor(type), ["click", "repeat"], type)
  for (const type of buttonTypes) assert.deepEqual(familiesFor(type), ["click", "repeat"], type)
  for (const type of submitTypes) assert.deepEqual(familiesFor(type), ["click", "repeat", "submit", "double-submit"], type)
  for (const type of [...unsupportedTypes, "disabled", "readonly"]) assert.deepEqual(familiesFor(type), [], type)
  assert(planned.filter((action) => action.steps.some((step) => step.kind === "fill")).every((action) => ["default", ...fillableTypes, "textarea"].includes(action.descriptorId ?? "")))
})

test("planned input actions execute safely in a real browser", async () => {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  const fixture = `<!doctype html>
    <style>input,textarea { display:block; width:180px; height:30px; margin:4px; }</style>
    <form id="form">
      <input id="checkbox" type="checkbox"><input id="radio" type="radio" name="choice">
      <input id="text" type="text"><input id="password" type="password"><input id="email" type="email"><input id="search" type="search">
      <textarea id="textarea"></textarea><input id="submit" type="submit" value="Submit"><input id="range" type="range"><input id="file" type="file">
    </form>
    <script>document.querySelector('#form').addEventListener('submit', (event) => event.preventDefault())</script>`
  try {
    await page.addInitScript("globalThis.__name = value => value")
    await page.setContent(fixture)
    await page.evaluate("globalThis.__name = value => value")
    const discovery = await discoverBrowserActionCorpusDescriptors(page)
    const contract = browserAdaptiveExplorationContract({ seed: "browser-input-capabilities", startUrl: page.url() })
    const actions = planBrowserAdaptiveStateActions({
      digest: "state",
      url: page.url(),
      historyLength: 1,
      historyStateDigest: "history",
      descriptorDigest: "descriptors",
      descriptors: discovery.descriptors,
      frames: [{ id: "document", url: page.url(), scope: "document" }],
      visits: 1,
      depth: 0,
      loadingIndicators: 0,
    }, contract).filter((action) => action.descriptorId)

    assert(actions.some((action) => action.descriptorId?.includes("\"type\":\"checkbox\"") && action.steps.every((step) => step.kind === "click")))
    assert(actions.some((action) => action.descriptorId?.includes("\"type\":\"radio\"") && action.steps.every((step) => step.kind === "click")))
    assert(!actions.some((action) => action.descriptorId?.includes("\"type\":\"range\"") || action.descriptorId?.includes("\"type\":\"file\"")))
    for (const action of actions) {
      await page.setContent(fixture)
      for (const step of action.steps) await executeBrowserInteractionStep(page, step, page.url(), 2_000, async () => ({ path: "unused", isDefault: false }))
    }
  } finally {
    await browser.close()
  }
})

test("real-browser descriptors keep navigation single-click and in-place controls repeatable", async () => {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  try {
    await page.addInitScript("globalThis.__name = value => value")
    await page.setContent(`<!doctype html>
      <style>a,button { display:block; width:180px; height:30px; margin:4px; }</style>
      <a id="internal" href="/next">Internal</a>
      <a id="external" href="https://outside.example/next">External</a>
      <a id="hash" href="#tab" role="tab">Hash tab</a>
      <a id="download" href="/report.pdf" download>Download</a>
      <button id="button" type="button">Increment</button>
      <form id="form"><button id="submit" type="submit">Submit</button></form>
      <output id="count">0</output>
      <script>
        document.querySelector('#button').addEventListener('click', () => { document.querySelector('#count').textContent = String(Number(document.querySelector('#count').textContent) + 1) });
        document.querySelector('#form').addEventListener('submit', (event) => event.preventDefault());
      </script>`)
    await page.evaluate("globalThis.__name = value => value")
    const discovery = await discoverBrowserActionCorpusDescriptors(page)
    const contract = browserAdaptiveExplorationContract({ seed: "browser-navigation-semantics", startUrl: page.url() })
    const planned = planBrowserAdaptiveStateActions({
      digest: "state",
      url: page.url(),
      historyLength: 1,
      historyStateDigest: "history",
      descriptorDigest: "descriptors",
      descriptors: discovery.descriptors,
      frames: [{ id: "document", url: page.url(), scope: "document" }],
      visits: 1,
      depth: 0,
      loadingIndicators: 0,
    }, contract)
    const actionFor = (selector: string, family: string) => planned.find((action) => action.steps[0]?.selector === selector && action.family === family)

    for (const selector of ["#internal", "#external", "#hash", "#download"]) {
      assert(actionFor(selector, "click"), `${selector} remains single-clickable`)
      assert(!actionFor(selector, "repeat"), `${selector} must not receive a repeat action`)
    }
    const repeat = actionFor("#button", "repeat")
    assert(repeat)
    for (const step of repeat.steps) await executeBrowserInteractionStep(page, step, page.url(), 2_000, async () => ({ path: "unused", isDefault: false }))
    assert.equal(await page.locator("#count").textContent(), "2")
    assert.equal(actionFor("#submit", "double-submit")?.steps.length, 2, "double-submit remains unchanged")
  } finally {
    await browser.close()
  }
})

test("repeat-only exploration never schedules a detached navigation target", async () => {
  let destinationRequests = 0
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://preview.invalid").pathname
    response.setHeader("content-type", "text/html")
    if (path === "/destination") destinationRequests += 1
    response.end(path === "/" ? "<!doctype html><style>a{display:block;width:180px;height:30px}</style><a id='privacy' href='/destination'>Privacy Policy</a>" : "<!doctype html><h1>Destination</h1>")
  })
  const startUrl = await listenLocalHttpServer(server)
  try {
    const run = await runUrlFixture(startUrl, {
      seed: "detached-navigation-repeat",
      failOnFinding: false,
      actionFamilies: ["repeat"],
      budgets: { maxActions: 4, maxStates: 4, maxTransitions: 4, maxDurationMs: 10_000 },
    })
    const privacy = run.result.states[0]?.descriptors.find((descriptor) => descriptor.selector === "#privacy")
    assert(privacy?.href.endsWith("/destination"))
    assert.equal(run.result.transitions.length, 0)
    assert.equal(destinationRequests, 0, "repeat planning must not issue a first or detached second navigation click")
  } finally {
    await closeHttpServer(server)
  }
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
  assert.deepEqual(finding.replay.environment, {})
  assert.equal(finding.replay.environmentDigest, run.contract.environmentDigest)

  const mobile = await runFixture(modalFixture, {
    seed: "modal-seed",
    environment: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, geolocation: { latitude: 32.7765, longitude: -79.9311, permission: "granted" } },
    budgets: { maxActions: 80, maxStates: 24, maxTransitions: 80, maxDurationMs: 30_000, maxArtifactBytes: 2_000_000, maxErrors: 10 },
    actionFamilies: ["click", "fill", "submit", "repeat", "double-submit"],
  })
  assert.notEqual(mobile.result.states[0]?.digest, run.result.states[0]?.digest)
  assert.notEqual(mobile.result.findings[0]?.fingerprint, finding.fingerprint)
  assert.deepEqual(mobile.result.replay.environment, mobile.contract.environment)
  assert.equal(mobile.result.findings[0]?.replay.environmentDigest, mobile.contract.environmentDigest)
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

test("volatile generated ids preserve semantic replay and distinct control identity", async () => {
  let render = 0
  const server = createServer((_request, response) => {
    render += 1
    const suffix = render.toString(16).padStart(10, "0")
    response.setHeader("content-type", "text/html")
    response.end(`<!doctype html>
      <style>button { display:block; width:180px; height:30px; margin:8px; }</style>
      <button id="choice-primary-dm${suffix}">Choose</button>
      <button id="choice-secondary-dm${suffix}">Choose</button>
      <output>Waiting</output>
      <script>
        document.querySelectorAll('button').forEach((button, index) => button.addEventListener('click', () => {
          document.querySelector('output').textContent = index === 0 ? 'Primary selected' : 'Secondary selected';
        }));
      </script>`)
  })
  const startUrl = await listenLocalHttpServer(server)
  try {
    const run = await runUrlFixture(startUrl, {
      seed: "volatile-generated-ids",
      failOnFinding: false,
      budgets: { maxActions: 12, maxStates: 8, maxTransitions: 8, maxDurationMs: 15_000 },
      actionFamilies: ["click"],
    })
    const initial = run.result.states[0]!
    const choices = initial.descriptors.filter((descriptor) => descriptor.label === "Choose")
    assert.equal(choices.length, 2)
    assert.equal(new Set(choices.map((descriptor) => descriptor.id)).size, 2, "semantic occurrence keeps equivalent controls distinct")
    assert.equal(new Set(choices.map((descriptor) => descriptor.selector)).size, 2, "execution retains each concrete selector")
    const choiceTransitions = run.result.transitions.filter((transition) => transition.sourceDigest === initial.digest && transition.action.descriptorId && choices.some((descriptor) => descriptor.id === transition.action.descriptorId))
    assert.equal(new Set(choiceTransitions.map((transition) => transition.destinationDigest)).size, 2, "distinct controls reach distinct semantic states")
    assert(!run.result.transitions.some((transition) => transition.diagnostic?.code === "browser_adaptive_source_state_not_reproduced"))
    assert(!run.result.diagnostics.some((diagnostic) => diagnostic.code === "browser_adaptive_reset_replay_failed"))
    assert.notEqual(run.result.summary.budgetExhausted, "maxDurationMs")
    assert(render > 2, "the fixture must generate fresh ids across resets")
  } finally {
    await closeHttpServer(server)
  }
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

test("declared network-policy blocks remain structured evidence without becoming findings", async () => {
  const run = await runNetworkOracleFixture("block", "blocked")
  const transition = run.result.transitions[0]
  assert.equal(run.result.findings.length, 0)
  assert.equal(run.result.summary.errors, 0)
  assert(transition?.observations.consoleErrors.some((message) => message.includes("ERR_BLOCKED_BY_CLIENT")), "raw browser console evidence remains available")
  assert.deepEqual(transition?.observations.networkFailures, [{
    url: "http://assets.example.invalid/tile.png",
    host: "assets.example.invalid",
    urlClassification: "external",
    policyDecision: "blocked",
    policyReason: "external-host-blocked-by-policy",
    failure: "net::ERR_BLOCKED_BY_CLIENT.Inspector",
    oracleFinding: false,
  }])
  assert.deepEqual(transition?.observations.oracleFingerprints, [])
})

test("callers can opt policy blocks back into deterministic findings and replay", async () => {
  const input = { oraclePolicy: { policyBlocks: "finding" } }
  const first = await runNetworkOracleFixture("block", "blocked", input)
  const second = await runNetworkOracleFixture("block", "blocked", input)
  const finding = first.result.findings[0]
  assert(finding)
  assert.equal(first.result.transitions[0]?.observations.networkFailures?.[0]?.oracleFinding, true)
  assert.equal(finding.fingerprint, second.result.findings[0]?.fingerprint)
  assert.deepEqual(finding.minimizedPath, finding.originalPath)
  assert.deepEqual(finding.replay.actions, finding.minimizedPath)
  assert.equal(finding.replay.expectedFingerprint, finding.fingerprint)
})

test("URL-less policy-block console records correlate before promotion and preserve canonical fingerprints", async () => {
  const evidenceOnly = await runNetworkOracleFixture("block", "blocked", {}, true)
  assert.equal(evidenceOnly.result.findings.length, 0)
  assert.deepEqual(evidenceOnly.result.transitions[0]?.observations.oracleFingerprints, [])
  assert.equal(evidenceOnly.result.transitions[0]?.observations.networkFailureSummary?.policyBlocks, 1)

  const input = { oraclePolicy: { policyBlocks: "finding" } }
  const attributed = await runNetworkOracleFixture("block", "blocked", input)
  const urlLess = await runNetworkOracleFixture("block", "blocked", input, true)
  const message = urlLess.result.transitions[0]?.observations.consoleErrors[0]
  assert(message)
  assert.equal(urlLess.result.transitions[0]?.observations.oracleFingerprints.length, 1)
  assert.equal(urlLess.result.findings[0]?.fingerprint, browserAdaptiveDigest("oracle", message))
  assert.equal(urlLess.result.findings[0]?.fingerprint, attributed.result.findings[0]?.fingerprint, "removing console location must not change the historical console fingerprint")

  const mixed = await runNetworkOracleFixture("block", "mixed", {}, true)
  assert.equal(mixed.result.findings.length, 1)
  assert.equal(mixed.result.transitions[0]?.observations.oracleFingerprints.length, 1)
  assert.equal(mixed.result.transitions[0]?.observations.networkFailureSummary?.policyBlocks, 1)
  assert.equal(mixed.result.transitions[0]?.observations.networkFailureSummary?.oracleFindings, 1)
})

test("same-URL product errors require a matching failure token before policy correlation", async () => {
  const productMessage = "same-URL product defect"
  const productFingerprint = browserAdaptiveDigest("oracle", productMessage)
  const evidence = await runNetworkOracleFixture("block", "blocked", {}, false, true)
  assert.deepEqual(evidence.result.transitions[0]?.observations.oracleFingerprints, [productFingerprint])
  assert.equal(evidence.result.findings[0]?.fingerprint, productFingerprint)

  const finding = await runNetworkOracleFixture("block", "blocked", { oraclePolicy: { policyBlocks: "finding" } }, false, true)
  const fingerprints = finding.result.transitions[0]?.observations.oracleFingerprints ?? []
  const blockMessage = finding.result.transitions[0]?.observations.consoleErrors.find((message) => message.includes("ERR_BLOCKED_BY_CLIENT"))
  assert(blockMessage)
  assert.equal(fingerprints.length, 2)
  assert(fingerprints.includes(productFingerprint))
  assert(fingerprints.includes(browserAdaptiveDigest("oracle", blockMessage)))
  assert.equal(finding.result.transitions[0]?.observations.networkFailureSummary?.policyBlocks, 1)
})

test("allow and record policies do not explain unexpected same-origin request failures", async () => {
  for (const mode of ["allow", "record"] as const) {
    const run = await runNetworkOracleFixture(mode, "unexpected")
    const failure = run.result.transitions[0]?.observations.networkFailures?.[0]
    assert.equal(run.result.findings.length, 1, mode)
    assert.equal(failure?.urlClassification, "same-origin", mode)
    assert.equal(failure?.policyDecision, "allowed", mode)
    assert.equal(failure?.policyReason, "first-party-host", mode)
    assert.equal(failure?.oracleFinding, true, mode)
  }
})

test("mixed expected and unexpected network errors only promote the product failure", async () => {
  const run = await runNetworkOracleFixture("block", "mixed")
  const failures = run.result.transitions[0]?.observations.networkFailures ?? []
  assert.equal(run.result.findings.length, 1)
  assert.equal(failures.length, 2)
  assert(failures.some((failure) => failure.policyDecision === "blocked" && failure.policyReason === "external-host-blocked-by-policy" && !failure.oracleFinding))
  assert(failures.some((failure) => failure.urlClassification === "same-origin" && failure.policyDecision === "allowed" && failure.oracleFinding))
  assert.equal(run.result.transitions[0]?.observations.oracleFingerprints.length, 1)
})

test("page exceptions remain findings alongside policy-aware network classification", async () => {
  const run = await runNetworkOracleFixture("block", "exception")
  assert.equal(run.result.findings.length, 1)
  assert(run.result.transitions[0]?.observations.pageErrors.includes("fixture page exception"))
  assert.equal(run.result.transitions[0]?.observations.networkFailures, undefined)
  assert.deepEqual(run.result.findings[0]?.replay.actions, run.result.findings[0]?.minimizedPath)
})

test("policy-block floods retain bounded deterministic evidence without stopping later findings", async () => {
  const [first, second] = await runPolicyBlockFloodFixture()
  for (const result of [first, second]) {
    const floods = result.transitions.filter((transition) => transition.observations.networkFailureSummary?.total === 80)
    assert.equal(floods.length, 3)
    assert.equal(floods.reduce((total, transition) => total + (transition.observations.networkFailures?.length ?? 0), 0), 2, "retained failures are bounded across the artifact")
    assert.deepEqual(floods.map((transition) => transition.observations.networkFailureSummary), [
      { total: 80, retained: 2, policyBlocks: 80, oracleFindings: 0, truncated: true },
      { total: 80, retained: 0, policyBlocks: 80, oracleFindings: 0, truncated: true },
      { total: 80, retained: 0, policyBlocks: 80, oracleFindings: 0, truncated: true },
    ])
    assert(floods.every((transition) => transition.observations.oracleFingerprints.length === 0))
    assert.equal(result.status, "findings")
    assert.equal(result.summary.errors, 1, "policy blocks must not consume the product error budget")
    assert.notEqual(result.summary.budgetExhausted, "maxArtifactBytes")
    assert.equal(result.findings.length, 1)
    assert.equal(result.findings[0]?.originalPath.length, 4)
    assert.deepEqual(result.findings[0]?.minimizedPath, result.findings[0]?.originalPath)
    assert.deepEqual(result.findings[0]?.replay.actions, result.findings[0]?.minimizedPath)
  }
  const stable = (result: typeof first) => ({
    status: result.status,
    summary: result.summary,
    transitions: result.transitions.map((transition) => ({ action: transition.action.id, observations: transition.observations, status: transition.status })),
    findings: result.findings,
  })
  assert.deepEqual(stable(second), stable(first))
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

async function runUrlFixture(startUrl: string, input: Record<string, unknown>) {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  const consoleMessages: object[] = []
  const errors: object[] = []
  const network: object[] = []
  page.on("console", (message) => consoleMessages.push({ type: message.type(), text: message.text() }))
  page.on("pageerror", (error) => errors.push({ message: error.message }))
  page.on("request", (request) => network.push({ url: request.url(), method: request.method() }))
  await page.addInitScript("globalThis.__name = value => value")
  await page.goto(startUrl, { waitUntil: "load" })
  const contract = browserAdaptiveExplorationContract({ startUrl, stabilization: { pollIntervalMs: 25, quietWindowMs: 100, maxWaitMs: 1500, maxMutationRecords: 40 }, ...input })
  try {
    const result = await exploreAdaptiveBrowserStateMachine({ page, baseUrl: startUrl, contract, observations: { consoleMessages, errors, network } })
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

async function runNetworkOracleFixture(mode: "allow" | "block" | "record", behavior: "blocked" | "unexpected" | "mixed" | "exception", input: Record<string, unknown> = {}, urlLessConsole = false, sameUrlProductError = false) {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://preview.invalid").pathname
    if (path === "/failed.png") {
      request.socket.destroy()
      return
    }
    response.setHeader("content-type", "text/html")
    response.end(`<!doctype html><style>button{display:block;width:180px;height:30px}</style><button id="trigger">Trigger</button><script>
      document.querySelector('#trigger').addEventListener('click', () => {
        const load = (src) => { const image = document.createElement('img'); image.src = src; document.body.append(image); };
        ${behavior === "blocked" || behavior === "mixed" ? "load('http://assets.example.invalid/tile.png');" : ""}
        ${behavior === "unexpected" || behavior === "mixed" ? "load('/failed.png');" : ""}
        ${behavior === "exception" ? "setTimeout(() => { throw new Error('fixture page exception'); }, 0);" : ""}
      });
    </script>`)
  })
  const startUrl = await listenLocalHttpServer(server)
  const topology = browserPreviewTopology([`network-policy=${mode}`], undefined, startUrl)
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext()
  await routeBrowserPreviewContextNetwork(context, topology.networkPolicy, startUrl)
  const page = await context.newPage()
  const consoleMessages: Record<string, unknown>[] = []
  const errors: Record<string, unknown>[] = []
  const network: Record<string, unknown>[] = []
  attachBrowserCaptureListeners({ captureConsole: !urlLessConsole && !sameUrlProductError, captureErrors: true, captureNetwork: true, captureWebSocket: false, consoleMessages, errors, network, page })
  if (urlLessConsole || sameUrlProductError) page.on("console", (message) => {
    const location = message.location()
    if (sameUrlProductError && message.text().includes("ERR_BLOCKED_BY_CLIENT")) consoleMessages.push({ type: "error", text: "same-URL product defect", location })
    consoleMessages.push({ type: message.type(), text: message.text(), ...(urlLessConsole ? {} : { location }) })
  })
  await page.addInitScript("globalThis.__name = value => value")
  await page.goto(startUrl, { waitUntil: "load" })
  const contract = browserAdaptiveExplorationContract({
    seed: `network-oracle-${mode}-${behavior}`,
    startUrl,
    failOnFinding: false,
    resetPolicy: { mode: "none" },
    actionFamilies: ["click"],
    budgets: { maxActions: 1, maxStates: 2, maxTransitions: 1, maxDurationMs: 10_000 },
    stabilization: { pollIntervalMs: 25, quietWindowMs: 100, maxWaitMs: 1_500, maxMutationRecords: 20 },
    ...input,
  })
  try {
    const result = await exploreAdaptiveBrowserStateMachine({ page, baseUrl: startUrl, contract, observations: { consoleMessages, errors, network }, navigationScope: topology.navigationScope, networkPolicy: topology.networkPolicy })
    return { result, contract }
  } finally {
    await browser.close()
    await closeHttpServer(server)
  }
}

async function runPolicyBlockFloodFixture() {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html")
    response.end(`<!doctype html><style>button{display:block;width:180px;height:30px}</style><button id="trigger">Load assets</button><script>
      document.querySelector('#trigger').addEventListener('click', () => {
        const stage = Number(document.querySelector('#trigger').dataset.stage || '0') + 1;
        document.querySelector('#trigger').dataset.stage = String(stage);
        document.querySelector('#trigger').textContent = 'Load assets stage ' + String(stage);
        for (let index = 0; index < 80; index += 1) {
          const image = document.createElement('img');
          image.src = 'http://assets.example.invalid/tile-' + String(stage) + '-' + String(index).padStart(3, '0') + '.png';
          document.body.append(image);
        }
        if (stage < 3) return;
        document.querySelector('#trigger').disabled = true;
        const fail = document.createElement('button');
        fail.id = 'fail';
        fail.textContent = 'Reveal defect';
        fail.addEventListener('click', () => setTimeout(() => { throw new Error('post-flood defect'); }, 0));
        document.body.append(fail);
      });
    </script>`)
  })
  const startUrl = await listenLocalHttpServer(server)
  const topology = browserPreviewTopology(["network-policy=block"], undefined, startUrl)
  const run = async () => {
    const browser = await chromium.launch({ headless: true })
    const context = await browser.newContext()
    await routeBrowserPreviewContextNetwork(context, topology.networkPolicy, startUrl)
    const page = await context.newPage()
    const consoleMessages: Record<string, unknown>[] = []
    const errors: Record<string, unknown>[] = []
    const network: Record<string, unknown>[] = []
    attachBrowserCaptureListeners({ captureConsole: true, captureErrors: true, captureNetwork: true, captureWebSocket: false, consoleMessages, errors, network, page })
    await page.addInitScript("globalThis.__name = value => value")
    await page.goto(startUrl, { waitUntil: "load" })
    const contract = browserAdaptiveExplorationContract({
      seed: "policy-block-flood",
      startUrl,
      failOnFinding: false,
      actionFamilies: ["click"],
      budgets: { maxActions: 40, maxStates: 8, maxTransitions: 20, maxDurationMs: 30_000, maxArtifactBytes: 40_000, maxErrors: 2 },
      descriptorLimits: { maxPerState: 10, maxDiagnostics: 3, maxTextLength: 500 },
      stabilization: { pollIntervalMs: 25, quietWindowMs: 100, maxWaitMs: 1_500, maxMutationRecords: 100 },
    })
    try {
      return await exploreAdaptiveBrowserStateMachine({ page, baseUrl: startUrl, contract, observations: { consoleMessages, errors, network }, navigationScope: topology.navigationScope, networkPolicy: topology.networkPolicy })
    } finally {
      await browser.close()
    }
  }
  try {
    return [await run(), await run()] as const
  } finally {
    await closeHttpServer(server)
  }
}

function stableAdaptiveEvidence(result: Awaited<ReturnType<typeof runRoutedFixture>>) {
  return {
    states: result.states.map((state) => ({ digest: state.digest, url: state.url, descriptors: state.descriptors.map((descriptor) => descriptor.id) })),
    transitions: result.transitions.map((transition) => ({ source: transition.sourceDigest, destination: transition.destinationDigest, action: transition.action.id, status: transition.status })),
    diagnostics: result.diagnostics,
  }
}
