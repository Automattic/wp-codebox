import assert from "node:assert/strict"
import test from "node:test"
import { chromium, type Page } from "playwright"

import { browserAccessibilityContract } from "../packages/runtime-core/src/browser-accessibility.js"
import { browserAdaptiveExplorationContract, type BrowserAdaptiveAction } from "../packages/runtime-core/src/browser-adaptive-exploration.js"
import { createBrowserAccessibilityCollector } from "../packages/runtime-playground/src/browser-accessibility-collector.js"
import { boundAdaptiveExplorationArtifact } from "../packages/runtime-playground/src/browser-actions-runner.js"
import { exploreAdaptiveBrowserStateMachine } from "../packages/runtime-playground/src/browser-adaptive-explorer.js"

const brokenControls = `<!doctype html>
<style>button,[role=button],#offscreen { display:block; width:120px; height:30px; margin:8px } #offscreen { position:absolute; left:-5000px }</style>
<button id="named">Named</button>
<input type="submit" value="Save"><button><img alt="Icon action"></button>
<button id="unnamed"></button><button></button>
<div id="custom" role="button">Custom action</div>
<div id="tab-stop" tabindex="0">Decorative</div>
<button id="toggle" aria-controls="panel" aria-expanded="false">Toggle</button><div id="panel">Panel</div>
<button id="offscreen">Offscreen</button><a href="https://example.test/private?token=secret">Private</a>`

const dialogFixture = `<!doctype html>
<button id="open">Open dialog</button>
<div id="dialog" role="dialog" aria-modal="true" hidden><button id="close">Close</button></div>
<script>
document.querySelector('#open').onclick=()=>{ document.querySelector('#dialog').hidden=false };
document.querySelector('#close').onclick=()=>{ document.querySelector('#dialog').hidden=true; document.body.focus() };
</script>`

test("collector classifies bounded accessibility, keyboard, focus, and ARIA failures", async () => {
  await withPage(brokenControls, async (page) => {
    const contract = requiredContract()
    const collector = createBrowserAccessibilityCollector(page, contract)
    await page.locator("#offscreen").focus()
    const scan = await collector.scan({ phase: "initial", stateDigest: "state-a" })
    const codes = new Set(scan.findings.map((finding) => finding.code))
    assert(codes.has("browser-accessible-name-missing"))
    assert(codes.has("browser-keyboard-unreachable"))
    assert(codes.has("browser-unexpected-tab-stop"))
    assert(codes.has("browser-focused-element-hidden"))
    assert(codes.has("browser-aria-expanded-drift"))
    assert(scan.findings.every((finding) => finding.target.locator.length <= 240))
    assert(!JSON.stringify(scan).includes("Custom action"), "findings do not retain accessible text")
    assert(scan.accessibilityTree?.snapshot?.includes("<redacted>"), "tree names are redacted")
    assert(!JSON.stringify(scan).includes("token=secret"), "tree URLs are redacted")

    const unnamed = scan.findings.filter((finding) => finding.code === "browser-accessible-name-missing")
    assert.equal(unnamed.length, 2, "valid value and descendant-alt names pass")
    assert.equal(new Set(unnamed.map((finding) => finding.fingerprint)).size, unnamed.length, "distinct targets cannot collide")

    await collector.reset()
    await page.reload({ waitUntil: "load" })
    await page.locator("#offscreen").focus()
    const replay = await collector.scan({ phase: "replay", stateDigest: "state-b", record: false })
    assert.deepEqual(replay.findings.map((finding) => finding.fingerprint), scan.findings.map((finding) => finding.fingerprint), "volatile transition context does not affect fingerprints")
  })
})

test("collector detects dialog entry, containment, and restoration failures", async () => {
  await withPage(dialogFixture, async (page) => {
    const collector = createBrowserAccessibilityCollector(page, requiredContract())
    await page.locator("#open").focus()
    const openAction = action("open", "#open")
    await collector.beforeAction(openAction)
    await page.locator("#open").click()
    const opened = await collector.scan({ phase: "novel-state", transitionId: "open", action: openAction })
    assert(opened.findings.some((finding) => finding.code === "browser-dialog-focus-entry"))

    await page.locator("#close").focus()
    const closeAction = action("close", "#close")
    await collector.beforeAction(closeAction)
    await page.locator("#close").click()
    const closed = await collector.scan({ phase: "novel-state", transitionId: "close", action: closeAction })
    assert(closed.findings.some((finding) => finding.code === "browser-dialog-focus-restoration"))
    assert(collector.evidence().focusHistory.length <= requiredContract().budgets.maxFocusTransitions)
  })
})

test("non-modal dialogs do not imply focus containment", async () => {
  await withPage("<!doctype html><div role='dialog'>Persistent panel</div><button>Outside</button>", async (page) => {
    const scan = await createBrowserAccessibilityCollector(page, requiredContract()).scan({ phase: "initial" })
    assert(!scan.findings.some((finding) => finding.code.startsWith("browser-dialog-focus")))
  })
})

test("navigation focus reset and below-fold expanded content do not false-positive", async () => {
  await withPage("<!doctype html><a href='data:text/html,Next'>Next</a><div style='height:2000px'></div><button aria-controls='below' aria-expanded='true'>Toggle</button><div id='below'>Below fold</div>", async (page) => {
    const collector = createBrowserAccessibilityCollector(page, requiredContract())
    const navigate = action("navigate", "a")
    await page.locator("a").focus()
    await collector.beforeAction(navigate)
    await page.goto("data:text/html,Next", { waitUntil: "load" })
    const navigated = await collector.scan({ phase: "novel-state", action: navigate })
    assert(!navigated.findings.some((finding) => finding.code === "browser-focus-lost"))
  })
  await withPage("<!doctype html><div style='height:2000px'></div><button aria-controls='below' aria-expanded='true'>Toggle</button><div id='below'>Below fold</div>", async (page) => {
    const scan = await createBrowserAccessibilityCollector(page, requiredContract()).scan({ phase: "initial" })
    assert(!scan.findings.some((finding) => finding.code === "browser-aria-expanded-drift"))
  })
})

test("controls without nameable content and broken relationships are classified", async () => {
  await withPage("<!doctype html><select><option>Choose</option></select><button aria-controls='missing' aria-expanded='sometimes'>Toggle</button><div role='buton'>Typo</div>", async (page) => {
    const scan = await createBrowserAccessibilityCollector(page, requiredContract()).scan({ phase: "initial" })
    assert(scan.findings.some((finding) => finding.code === "browser-accessible-name-missing" && finding.target.tag === "select"))
    assert(scan.findings.some((finding) => finding.code === "browser-aria-controls-missing"))
    assert(scan.findings.some((finding) => finding.code === "browser-aria-expanded-invalid"))
    assert(scan.findings.some((finding) => finding.code === "browser-role-invalid"))
  })
})

test("same-origin frame findings retain frame identity", async () => {
  await withPage("<!doctype html><iframe srcdoc='<button></button>'></iframe>", async (page) => {
    await page.locator("iframe").contentFrame().locator("button").waitFor()
    const scan = await createBrowserAccessibilityCollector(page, requiredContract()).scan({ phase: "initial" })
    assert(scan.findings.some((finding) => finding.code === "browser-accessible-name-missing" && finding.target.frameId === "frame:0"))
  })
})

test("include and exclude scopes constrain static and focused targets", async () => {
  await withPage(`<!doctype html>
    <style>.offscreen { position:absolute; left:-5000px; width:20px; height:20px }</style>
    <section id="component">
      <input id="inside-unnamed">
      <div id="inside-custom" role="button">Action</div>
      <div id="inside-tab" tabindex="0">Tab stop</div>
      <button id="inside-aria" aria-controls="panel" aria-expanded="false">Toggle</button><div id="panel">Panel</div>
      <button id="inside-focus" class="offscreen">Inside focus</button>
      <div id="excluded"><button id="excluded-unnamed"></button></div>
    </section>
    <button id="outside-unnamed"></button><button id="outside-focus" class="offscreen">Outside focus</button>`, async (page) => {
    const contract = browserAccessibilityContract({ includeScopes: ["#component"], excludeScopes: ["#excluded"], impactThreshold: "moderate", capabilities: { accessibilityTree: "disabled" } })!
    const collector = createBrowserAccessibilityCollector(page, contract)

    await page.locator("#outside-focus").focus()
    const outsideFocused = await collector.scan({ phase: "initial" })
    assert(!outsideFocused.findings.some((finding) => finding.code === "browser-focused-element-hidden"), "out-of-scope focus is context, not a finding")
    const unnamed = outsideFocused.findings.filter((finding) => finding.code === "browser-accessible-name-missing")
    assert.equal(unnamed.length, 1)
    assert.equal(unnamed[0]?.target.tag, "input", "outside and excluded unnamed buttons are filtered")
    assert(outsideFocused.findings.some((finding) => finding.code === "browser-keyboard-unreachable"))
    assert(outsideFocused.findings.some((finding) => finding.code === "browser-unexpected-tab-stop"))
    assert(outsideFocused.findings.some((finding) => finding.code === "browser-aria-expanded-drift"))

    await page.locator("#inside-focus").focus()
    const insideFocused = await collector.scan({ phase: "novel-state" })
    assert(insideFocused.findings.some((finding) => finding.code === "browser-focused-element-hidden" && finding.target.tag === "button"))
    assert.equal(collector.evidence().focusHistory.length, 2, "bounded focus history retains cross-boundary context")
  })
})

test("focus loss is attributed only to the scoped element that lost focus", async () => {
  await withPage("<!doctype html><section id='component'><button id='inside'>Inside</button></section><button id='outside'>Outside</button>", async (page) => {
    const contract = browserAccessibilityContract({ includeScopes: ["#component"], ruleTags: ["focus-loss"], capabilities: { accessibilityTree: "disabled" } })!
    const collector = createBrowserAccessibilityCollector(page, contract)
    const blur = action("blur", "#inside")

    await page.locator("#outside").focus()
    await collector.beforeAction(blur)
    await page.evaluate(() => { document.body.tabIndex = -1; document.body.focus() })
    const outside = await collector.scan({ phase: "novel-state", action: blur })
    assert(!outside.findings.some((finding) => finding.code === "browser-focus-lost"))

    await page.locator("#inside").focus()
    await collector.beforeAction(blur)
    await page.evaluate(() => document.body.focus())
    const inside = await collector.scan({ phase: "novel-state", action: blur })
    assert(inside.findings.some((finding) => finding.code === "browser-focus-lost" && finding.target.locator !== "body"))
  })
})

test("scoped dialogs may cross focus boundaries without emitting out-of-scope targets", async () => {
  await withPage(`<!doctype html>
    <button id="outside-trigger">Open</button>
    <div id="outside-dialog" role="dialog" aria-modal="true"><button id="outside-dialog-action">Outside dialog</button></div>
    <section id="component"><div id="dialog" role="dialog" aria-modal="true" hidden><button>Close</button></div></section>
    <script>
      document.querySelector('#outside-trigger').onclick=()=>{ document.querySelector('#dialog').hidden=false };
    </script>`, async (page) => {
    const contract = browserAccessibilityContract({ includeScopes: ["#component"], ruleTags: ["dialog-focus"], capabilities: { accessibilityTree: "disabled" } })!
    const collector = createBrowserAccessibilityCollector(page, contract)
    const open = action("open", "#outside-trigger")
    await page.locator("#outside-trigger").focus()
    await collector.beforeAction(open)
    await page.locator("#outside-trigger").click()
    await page.locator("#outside-dialog-action").focus()
    const opened = await collector.scan({ phase: "novel-state", action: open })
    assert(opened.findings.some((finding) => finding.code === "browser-dialog-focus-entry" && finding.target.role === "dialog"))
    assert(opened.findings.every((finding) => finding.target.role === "dialog"))

    await collector.beforeAction(action("close", "#dialog"))
    await page.locator("#dialog").evaluate((element) => { element.setAttribute("hidden", ""); document.querySelector<HTMLElement>("#outside-trigger")?.focus() })
    const closed = await collector.scan({ phase: "novel-state" })
    assert(!closed.findings.some((finding) => finding.code === "browser-dialog-focus-restoration"), "restoration to an out-of-scope trigger remains valid")
  })
})

test("same-origin frame scopes filter static and focused findings within that frame", async () => {
  await withPage(`<!doctype html><iframe srcdoc="<style>.offscreen{position:absolute;left:-5000px;width:20px;height:20px}</style><section class='scope'><input id='inside'><button id='inside-focus' class='offscreen'>Focus</button></section><button id='outside'></button>"></iframe>`, async (page) => {
    const frame = page.locator("iframe").contentFrame()
    await frame.locator("#inside-focus").focus()
    const contract = browserAccessibilityContract({ includeScopes: [".scope"], ruleTags: ["accessible-name", "focus-visible"], capabilities: { accessibilityTree: "disabled" } })!
    const scan = await createBrowserAccessibilityCollector(page, contract).scan({ phase: "initial" })
    assert(scan.findings.some((finding) => finding.code === "browser-accessible-name-missing" && finding.target.frameId === "frame:0" && finding.target.tag === "input"))
    assert(scan.findings.some((finding) => finding.code === "browser-focused-element-hidden" && finding.target.frameId === "frame:0"))
    assert(!scan.findings.some((finding) => finding.code === "browser-accessible-name-missing" && finding.target.tag === "button"))
  })
})

test("ARIA state drift is observed after both opening and closing a controlled panel", async () => {
  await withPage(`<!doctype html><button id="toggle" aria-controls="panel" aria-expanded="false">Toggle</button><div id="panel" hidden>Panel</div><script>document.querySelector('#toggle').onclick=()=>{ const panel=document.querySelector('#panel'); panel.hidden=!panel.hidden }</script>`, async (page) => {
    const collector = createBrowserAccessibilityCollector(page, requiredContract())
    const toggle = action("toggle", "#toggle")
    await collector.beforeAction(toggle)
    await page.locator("#toggle").click()
    const opened = await collector.scan({ phase: "novel-state", transitionId: "open", action: toggle })
    assert(opened.findings.some((finding) => finding.code === "browser-aria-expanded-drift" && finding.actual === "false"))

    await page.locator("#toggle").evaluate((element) => element.setAttribute("aria-expanded", "true"))
    await collector.beforeAction(toggle)
    await page.locator("#toggle").click()
    const closed = await collector.scan({ phase: "novel-state", transitionId: "close", action: toggle })
    assert(closed.findings.some((finding) => finding.code === "browser-aria-expanded-drift" && finding.actual === "true"))
  })
})

test("adaptive exploration emits stable first-class findings and replay evidence", async () => {
  const run = async () => withPage("<!doctype html><button></button>", async (page) => {
    const startUrl = page.url()
    const contract = browserAdaptiveExplorationContract({
      seed: "accessibility-replay",
      startUrl,
      actionFamilies: ["keyboard"],
      budgets: { maxActions: 4, maxStates: 4, maxTransitions: 4, maxDurationMs: 10_000, maxArtifactBytes: 500_000 },
      accessibility: { cadence: ["initial", "novel-state", "final"], budgets: { maxScans: 6, maxKeyboardActions: 2, maxTreeChars: 2_000 } },
    })
    const collector = createBrowserAccessibilityCollector(page, contract.accessibility!)
    return exploreAdaptiveBrowserStateMachine({ page, baseUrl: startUrl, contract, accessibilityCollector: collector, observations: { consoleMessages: [], errors: [], network: [] } })
  })
  const first = await run()
  const second = await run()
  assert.equal(first.status, "findings")
  assert.equal(first.findings.length, 1)
  assert.deepEqual(first.findings[0]?.originalPath, [])
  assert.deepEqual(first.findings[0]?.minimizedPath, [])
  assert.equal(first.findings[0]?.replay.expectedFingerprint, first.findings[0]?.fingerprint)
  assert.equal(second.findings[0]?.fingerprint, first.findings[0]?.fingerprint)
  assert.equal(first.accessibility?.scans[0]?.findings[0]?.transitionId, undefined)
  assert.equal(first.accessibility?.summary.findings, 1)

  const artifact = { schema: "wp-codebox/browser-adaptive-exploration-artifact/v1" as const, contract: first.replay.contract, result: structuredClone(first), capturedAt: "2026-01-01T00:00:00.000Z" }
  artifact.result.accessibility!.scans[0]!.accessibilityTree = { status: "captured", snapshot: "sensitive".repeat(20_000) }
  boundAdaptiveExplorationArtifact(artifact, 12_000)
  assert(Buffer.byteLength(JSON.stringify(artifact, null, 2)) + 1 <= 12_000)
  assert.equal(artifact.result.findings.length, 1, "artifact bounding retains replayable findings")
})

test("adaptive transition findings retain deterministic action replay context", async () => {
  const run = async () => withPage(`<!doctype html><button id="toggle" aria-controls="panel" aria-expanded="false">Toggle</button><div id="panel" hidden>Panel</div><script>document.querySelector('#toggle').onclick=()=>{ document.querySelector('#panel').hidden=false }</script>`, async (page) => {
    const startUrl = page.url()
    const contract = browserAdaptiveExplorationContract({
      seed: "aria-transition-replay",
      startUrl,
      actionFamilies: ["click"],
      budgets: { maxActions: 6, maxStates: 4, maxTransitions: 4, maxDurationMs: 10_000, maxArtifactBytes: 500_000 },
      stabilization: { pollIntervalMs: 20, quietWindowMs: 40, maxWaitMs: 500 },
      accessibility: { ruleTags: ["aria-state"], cadence: ["initial", "novel-state"], capabilities: { accessibilityTree: "disabled" } },
    })
    return exploreAdaptiveBrowserStateMachine({ page, baseUrl: startUrl, contract, accessibilityCollector: createBrowserAccessibilityCollector(page, contract.accessibility!), observations: { consoleMessages: [], errors: [], network: [] } })
  })
  const first = await run()
  const second = await run()
  const finding = first.findings[0]
  assert(finding, JSON.stringify({ status: first.status, summary: first.summary, transitions: first.transitions, accessibility: first.accessibility }))
  assert.equal(finding.originalPath.length, 1)
  assert.deepEqual(finding.minimizedPath, finding.originalPath)
  assert.deepEqual(finding.replay.actions, finding.minimizedPath)
  assert.equal(first.transitions[0]?.observations.accessibilityFindingFingerprints?.[0], finding.fingerprint)
  assert.equal(first.accessibility?.scans.find((scan) => scan.transitionId === finding.transitionId)?.findings[0]?.code, "browser-aria-expanded-drift")
  assert.equal(second.findings[0]?.fingerprint, finding.fingerprint)
})

test("keyboard-only focus transitions are scanned within the declared scan budget", async () => {
  await withPage("<!doctype html><button>First</button><button>Second</button><button>Third</button><output>0</output><script>document.addEventListener('keydown',event=>{ if(event.key==='Tab') document.querySelector('output').textContent=String(Number(document.querySelector('output').textContent)+1) })</script>", async (page) => {
    const startUrl = page.url()
    const contract = browserAdaptiveExplorationContract({
      seed: "keyboard-focus-history",
      startUrl,
      actionFamilies: ["keyboard"],
      failOnFinding: false,
      budgets: { maxActions: 8, maxStates: 8, maxTransitions: 8, maxDurationMs: 10_000, maxArtifactBytes: 500_000 },
      stabilization: { pollIntervalMs: 20, quietWindowMs: 40, maxWaitMs: 300 },
      accessibility: { ruleTags: ["focus-visible"], cadence: ["initial", "novel-state"], capabilities: { accessibilityTree: "disabled" }, budgets: { maxScans: 20, maxKeyboardActions: 4 } },
    })
    const result = await exploreAdaptiveBrowserStateMachine({ page, baseUrl: startUrl, contract, accessibilityCollector: createBrowserAccessibilityCollector(page, contract.accessibility!), observations: { consoleMessages: [], errors: [], network: [] } })
    assert.equal(result.status, "incomplete")
    assert.equal(result.summary.budgetExhausted, "maxKeyboardActions")
    assert(result.transitions.filter((transition) => transition.action.family === "keyboard").length <= 4)
    assert(result.accessibility?.focusHistory.some((entry) => entry.to.includes("button")))
  })
})

test("focus-only keyboard transitions are scanned even when DOM state is revisited", async () => {
  await withPage("<!doctype html><button>First</button><button>Second</button>", async (page) => {
    const startUrl = page.url()
    const contract = browserAdaptiveExplorationContract({
      seed: "focus-only-revisit",
      startUrl,
      actionFamilies: ["keyboard"],
      failOnFinding: false,
      budgets: { maxActions: 3, maxStates: 2, maxTransitions: 3, maxDurationMs: 10_000, maxArtifactBytes: 500_000 },
      stabilization: { pollIntervalMs: 20, quietWindowMs: 40, maxWaitMs: 300 },
      accessibility: { ruleTags: ["focus-visible"], cadence: ["initial", "novel-state"], capabilities: { accessibilityTree: "disabled" }, budgets: { maxScans: 10, maxKeyboardActions: 2 } },
    })
    const result = await exploreAdaptiveBrowserStateMachine({ page, baseUrl: startUrl, contract, accessibilityCollector: createBrowserAccessibilityCollector(page, contract.accessibility!), observations: { consoleMessages: [], errors: [], network: [] } })
    assert(result.transitions.some((transition) => transition.action.family === "keyboard" && transition.status === "revisited"))
    assert(result.accessibility?.scans.some((scan) => scan.phase === "novel-state" && scan.actionId?.startsWith("keyboard:")))
    assert(result.accessibility?.focusHistory.some((entry) => entry.to.includes("button")))
  })
})

test("collector stops scanning at maxScans", async () => {
  await withPage("<!doctype html><button>Pass</button>", async (page) => {
    const contract = browserAccessibilityContract({ capabilities: { accessibilityTree: "disabled" }, budgets: { maxScans: 2 } })!
    const collector = createBrowserAccessibilityCollector(page, contract)
    await collector.scan({ phase: "initial" })
    await collector.scan({ phase: "novel-state" })
    const exhausted = await collector.scan({ phase: "final" })
    assert.equal(exhausted.status, "inconclusive")
    assert.equal(exhausted.diagnostics[0]?.code, "browser_accessibility_scan_budget_exhausted")
    assert.equal(collector.evidence().summary.scans, 2)
    assert.equal(collector.evidence().summary.truncated, true)
  })
})

test("optional and required accessibility-tree capability results are distinct", async () => {
  await withPage("<!doctype html><button>Pass</button>", async (page) => {
    const disabled = browserAccessibilityContract({ capabilities: { accessibilityTree: "disabled" } })!
    const optional = await createBrowserAccessibilityCollector(page, disabled).scan({ phase: "initial" })
    assert.equal(optional.status, "passed")
    assert.equal(optional.accessibilityTree?.status, "unsupported")

    const required = browserAccessibilityContract({ capabilities: { accessibilityTree: "required" } })!
    const supported = await createBrowserAccessibilityCollector(page, required).scan({ phase: "initial" })
    assert.equal(supported.status, "passed")
    assert.equal(supported.accessibilityTree?.status, "captured")
  })
})

test("invalid scopes are inconclusive rather than false passes", async () => {
  await withPage("<!doctype html><button>Pass</button>", async (page) => {
    const contract = browserAccessibilityContract({ includeScopes: ["["] })!
    const scan = await createBrowserAccessibilityCollector(page, contract).scan({ phase: "initial" })
    assert.equal(scan.status, "inconclusive")
    assert.equal(scan.diagnostics[0]?.code, "browser_accessibility_scope_invalid")
  })
})

test("valid include scopes that match no inspectable frame are inconclusive", async () => {
  await withPage("<!doctype html><button>Pass</button>", async (page) => {
    const contract = browserAccessibilityContract({ includeScopes: ["#missing"], capabilities: { accessibilityTree: "disabled" } })!
    const scan = await createBrowserAccessibilityCollector(page, contract).scan({ phase: "initial" })
    assert.equal(scan.status, "inconclusive")
    assert(scan.diagnostics.some((diagnostic) => diagnostic.code === "browser_accessibility_scope_unmatched"))
  })
})

test("accessibility-enabled contracts normalize impossible artifact budgets", () => {
  const contract = browserAdaptiveExplorationContract({ accessibility: {}, budgets: { maxArtifactBytes: 1_024 } })
  assert.equal(contract.budgets.maxArtifactBytes, 1_048_576)
})

function requiredContract() {
  return browserAccessibilityContract({ impactThreshold: "moderate", capabilities: { accessibilityTree: "required" }, budgets: { maxScans: 10, maxViolationsPerScan: 20, maxFocusTransitions: 10, maxTreeChars: 4_000 } })!
}

function action(id: string, selector: string): BrowserAdaptiveAction {
  return { id, family: "click", frameId: "document", steps: [{ kind: "click", selector }] }
}

async function withPage<T>(html: string, callback: (page: Page) => Promise<T>): Promise<T> {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  await page.addInitScript("globalThis.__name = value => value")
  await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`, { waitUntil: "load" })
  try { return await callback(page) } finally { await browser.close() }
}
