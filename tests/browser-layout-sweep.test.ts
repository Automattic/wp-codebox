import assert from "node:assert/strict"
import { once } from "node:events"
import { readFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import { join } from "node:path"
import test from "node:test"

import { chromium, type Browser } from "playwright"

import { commandRegistry } from "../packages/runtime-core/src/command-registry.js"
import { settleByFrameStability } from "../packages/runtime-playground/dist/browser-frame-stability.js"
import {
  groupLayoutFindings,
  layoutSweepOptionsFromArgs,
  prepareLayoutSweepPage,
  runLayoutSweep,
  runLayoutSweepCommand,
  type LayoutSweepFindingSample,
  type LayoutSweepOpenPageOptions,
  type LayoutSweepPage,
  type LayoutSweepReport,
} from "../packages/runtime-playground/dist/browser-layout-sweep.js"
import { withTempDir } from "../scripts/test-kit.js"

// ---------------------------------------------------------------------------
// Synthetic fixtures served over a real HTTP server to a real Playwright page.

const FIXTURES: Record<string, string> = {
  "/settle": `<!doctype html>
<html><head><style>body{margin:0}#box{height:50px;background:teal;width:0px}</style></head>
<body>
<div id="box"></div>
<script>
  function applyWidth() { document.getElementById('box').style.width = window.innerWidth + 'px'; }
  // Layout is applied one animation frame after resize, not synchronously with the resize event.
  window.addEventListener('resize', function () { requestAnimationFrame(applyWidth); });
  applyWidth();
</script>
</body></html>`,

  // Three independent containers:
  //  - #modeSwitch: --layout-mode flips at exactly 765px with no height change (signature-only boundary).
  //  - #jumpy: height steps abruptly from 100 to 300 at exactly 765px with no mode change (height-only boundary).
  //  - #fluid: height scales continuously with width via aspect-ratio (must never be flagged as a jump).
  "/breakpoint": `<!doctype html>
<html><head><style>
*{box-sizing:border-box}
body{margin:0;font-family:sans-serif}
.layout-container{width:100%}
.layout-item{display:block;font-size:14px}
#modeSwitch{--layout-mode:narrow;height:150px;background:#f7f7f7}
@media (min-width:765px){ #modeSwitch{--layout-mode:wide} }
#jumpy{height:100px;background:#eee}
@media (min-width:765px){ #jumpy{height:300px} }
#fluid{width:100%;aspect-ratio:3/1;background:#ddd}
</style></head>
<body>
<div id="modeSwitch" class="layout-container"><div class="layout-item">mode</div></div>
<div id="jumpy" class="layout-container"><div class="layout-item">jump</div></div>
<div id="fluid" class="layout-container"><div class="layout-item">fluid</div></div>
</body></html>`,

  // One container per invariant kind under test.
  "/mixed": `<!doctype html>
<html><head><style>
*{box-sizing:border-box}
body{margin:0;font-family:sans-serif}
.layout-container{position:relative}
.layout-item{position:relative;display:block}
#hscroll-spacer{width:4000px;height:1px}
#overflow-container{width:300px;height:1600px}
#overflow-container .layout-item{width:100px;height:20px;font-size:24px;line-height:1.4}
#clipped-container{width:300px;height:40px}
#clipped-container .layout-item{width:100px;height:20px;overflow:hidden;font-size:24px}
#leak-container{width:300px;height:30px}
#leak-container .layout-item{width:280px;font-size:24px}
#overlap-container{width:100%;height:120px}
#overlap-container .item-a{position:absolute;left:0;top:0;width:200px;height:50px}
#overlap-container .item-b{position:absolute;left:150px;top:0;width:200px;height:50px}
@media (min-width:900px){ #overlap-container .item-b{left:260px} }
#collapsed-container{width:300px;height:100px}
#collapsed-container .layout-item{width:300px;height:1px;overflow:hidden}
#collapsed-container svg{display:block;width:40px;height:40px}
#tiny-text-container{width:300px;height:100px}
#tiny-text-container .layout-item{font-size:6px}
</style></head>
<body>
<div id="hscroll-spacer"></div>
<div id="overflow-container" class="layout-container"><div class="layout-item">This overflow text is intentionally tall enough to spill past its fixed height item box across every tested width for this invariant check.</div></div>
<div id="clipped-container" class="layout-container"><div class="layout-item">Clipped text stays inside its item and container because overflow hides it, so it is never reported.</div></div>
<div id="leak-container" class="layout-container"><div class="layout-item">This leak text is intentionally long so it extends well past the bottom of its shallow container across every tested width for this invariant check.</div></div>
<div id="overlap-container" class="layout-container"><div class="layout-item item-a">A</div><div class="layout-item item-b">B</div></div>
<div id="collapsed-container" class="layout-container"><div class="layout-item"><svg viewBox="0 0 1 1"><rect width="1" height="1"/></svg></div></div>
<div id="tiny-text-container" class="layout-container"><div class="layout-item">tiny</div></div>
</body></html>`,

  // A component-specific mode signal: layout and overlap change together at a
  // breakpoint that only --component-viewport announces.
  "/custom-mode": `<!doctype html>
<html><head><style>
*{box-sizing:border-box}
body{margin:0}
.c{position:relative;--component-viewport:narrow;height:100px}
.c .i{position:absolute;top:0;width:100px;height:40px}
.c .a{left:0}
.c .b{left:60px}
@media (min-width:800px){ .c{--component-viewport:wide;height:300px} .c .b{left:200px} }
</style></head>
<body><div id="custom" class="c"><div class="i a">A</div><div class="i b">B</div></div></body></html>`,

  // Fully static: no responsive behavior, nothing should ever be flagged.
  "/deterministic": `<!doctype html>
<html><head><style>
body{margin:0}
.layout-container{width:300px;height:150px;background:#eee}
.layout-item{width:280px;height:100px;font-size:16px}
</style></head>
<body><div class="layout-container"><div class="layout-item">stable content</div></div></body></html>`,
}

const server: Server = createServer((request, response) => {
  const html = FIXTURES[request.url ?? "/"]
  if (!html) {
    response.writeHead(404)
    response.end()
    return
  }
  response.writeHead(200, { "content-type": "text/html" })
  response.end(html)
})
server.listen(0, "127.0.0.1")
await once(server, "listening")
const address = server.address()
if (!address || typeof address === "string") throw new Error("layout-sweep test server did not expose a TCP address")
const baseUrl = `http://127.0.0.1:${address.port}`

test.after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
})

function openPageFor(browser: Browser, url: string): (options: LayoutSweepOpenPageOptions) => Promise<LayoutSweepPage> {
  return async (options) => {
    const context = await browser.newContext({
      viewport: { width: options.width, height: options.height },
      deviceScaleFactor: options.deviceScaleFactor ?? 1,
    })
    const page = await context.newPage()
    const watched = await prepareLayoutSweepPage(page, url, options)
    return { page, errors: watched.errors, missingResources: watched.missingResources, close: () => context.close() }
  }
}

function findingsOf(report: LayoutSweepReport, kind: string): LayoutSweepReport["findings"] {
  return report.findings.filter((finding) => finding.kind === kind)
}

// ---------------------------------------------------------------------------

test("settling by frame stability matches a long fixed wait when layout is applied on the next animation frame", async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const settledContext = await browser.newContext({ viewport: { width: 320, height: 200 } })
    const settledPage = await settledContext.newPage()
    await settledPage.goto(`${baseUrl}/settle`)
    await settledPage.setViewportSize({ width: 620, height: 200 })
    const settled = await settleByFrameStability(settledPage, () => settledPage.evaluate(() => document.getElementById("box")!.getBoundingClientRect().width))
    assert.equal(settled.stable, true)
    assert.ok(typeof settled.frames === "number" && settled.frames <= 5, `settling should converge quickly, got ${settled.frames} frames`)
    await settledContext.close()

    const waitedContext = await browser.newContext({ viewport: { width: 320, height: 200 } })
    const waitedPage = await waitedContext.newPage()
    await waitedPage.goto(`${baseUrl}/settle`)
    await waitedPage.setViewportSize({ width: 620, height: 200 })
    await waitedPage.waitForTimeout(500)
    const waited = await waitedPage.evaluate(() => document.getElementById("box")!.getBoundingClientRect().width)
    await waitedContext.close()

    assert.equal(settled.snapshot, 620)
    assert.equal(waited, 620)
    assert.equal(settled.snapshot, waited)
  } finally {
    await browser.close()
  }
})

test("adaptive refinement locates a media-query breakpoint to the pixel and a height jump to 2px, without flagging smooth proportional growth", async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const url = `${baseUrl}/breakpoint`
    const report = await runLayoutSweep({
      browser,
      url,
      openPage: openPageFor(browser, url),
      options: {
        url,
        containerSelector: ".layout-container",
        itemSelector: ".layout-item",
        minWidth: 700,
        maxWidth: 1000,
        profile: "quick",
        seed: 1,
        concurrency: 2,
        scenarios: ["sweep"],
        height: 400,
      },
    })

    assert.ok(
      report.boundaries.some((boundary) => boundary.kind === "signature" && boundary.low === 764 && boundary.high === 765),
      `expected a signature boundary pinned to a single pixel at 764/765, got ${JSON.stringify(report.boundaries)}`,
    )
    assert.ok(
      report.boundaries.some((boundary) => boundary.kind === "height" && boundary.low === 764 && boundary.high === 766),
      `expected a height boundary narrowed to 2px at 764/766, got ${JSON.stringify(report.boundaries)}`,
    )

    const jumps = findingsOf(report, "jump")
    assert.equal(jumps.length, 1, `expected exactly one jump finding, got ${JSON.stringify(jumps)}`)
    assert.match(jumps[0]!.item ?? jumps[0]!.container ?? "", /jumpy/)
    // The step is at min-width:765px, the first width inside the narrowed 764/766 bracket.
    assert.equal(jumps[0]!.sample.width, 765)
    assert.equal(jumps[0]!.worstMagnitude, 200)

    assert.equal(report.findings.some((finding) => finding.kind === "jump" && (finding.container ?? "").includes("fluid")), false, "smooth proportional growth must not be reported as a jump")

    for (const kind of ["overflow", "leak", "hscroll", "overlap", "collapsed", "tiny-text", "distort"]) {
      assert.equal(findingsOf(report, kind).length, 0, `unexpected ${kind} finding on the adaptive-refinement fixture`)
    }
  } finally {
    await browser.close()
  }
})

test("each layout invariant fires on its minimal fixture, and findings group by kind, container, and item", async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const url = `${baseUrl}/mixed`
    const report = await runLayoutSweep({
      browser,
      url,
      openPage: openPageFor(browser, url),
      options: {
        url,
        containerSelector: ".layout-container",
        itemSelector: ".layout-item",
        minWidth: 700,
        maxWidth: 1000,
        profile: "quick",
        seed: 1,
        concurrency: 2,
        scenarios: ["sweep"],
        height: 600,
      },
    })

    const overflow = findingsOf(report, "overflow")
    assert.ok(overflow.length > 0)
    assert.ok(overflow.every((finding) => (finding.container ?? "").includes("overflow-container")))

    const leak = findingsOf(report, "leak")
    assert.ok(leak.length > 0)
    assert.ok(leak.every((finding) => (finding.container ?? "").includes("leak-container")))

    const hscroll = findingsOf(report, "hscroll")
    assert.ok(hscroll.length > 0)
    assert.ok(hscroll.every((finding) => finding.container === null && finding.item === null))

    const overlap = findingsOf(report, "overlap")
    assert.ok(overlap.length > 0, "overlap must be reported relative to the anchor at the widest tested width")
    assert.ok(overlap.every((finding) => (finding.container ?? "").includes("overlap-container")))

    assert.ok(report.findings.every((finding) => !(finding.container ?? "").includes("clipped-container")), "text hidden by overflow clipping is not a layout finding")

    const collapsed = findingsOf(report, "collapsed")
    assert.ok(collapsed.length > 0)
    assert.ok(collapsed.every((finding) => (finding.container ?? "").includes("collapsed-container")))

    const tinyText = findingsOf(report, "tiny-text")
    assert.ok(tinyText.length > 0)
    assert.ok(tinyText.every((finding) => (finding.container ?? "").includes("tiny-text-container")))

    // Grouping: every finding of a given kind for the same container/item collapses into a single group.
    assert.equal(collapsed.length, 1, "repeated collapsed findings across widths must group into one entry")
    assert.ok(collapsed[0]!.count >= 1, "the collapsed group must aggregate its per-width occurrences")
    assert.equal(collapsed[0]!.identity.kind, "collapsed")
    assert.match(collapsed[0]!.identity.container ?? "", /collapsed-container/)
    assert.equal(collapsed[0]!.suppressed, false)

    // Accepted identities are marked suppressed without inventing a new group.
    const acceptedIdentity = { kind: collapsed[0]!.identity.kind, container: collapsed[0]!.identity.container, item: collapsed[0]!.identity.item }
    const suppressedReport = await runLayoutSweep({
      browser,
      url,
      openPage: openPageFor(browser, url),
      options: {
        url,
        containerSelector: ".layout-container",
        itemSelector: ".layout-item",
        minWidth: 700,
        maxWidth: 1000,
        profile: "quick",
        seed: 1,
        concurrency: 2,
        scenarios: ["sweep"],
        height: 600,
        accepted: [acceptedIdentity],
      },
    })
    const suppressedGroup = suppressedReport.findings.find((group) => group.kind === "collapsed")
    assert.ok(suppressedGroup)
    assert.equal(suppressedGroup!.suppressed, true)
    const stillUnsuppressed = suppressedReport.findings.filter((group) => group.kind !== "collapsed")
    assert.ok(stillUnsuppressed.every((group) => group.suppressed === false))
    assert.equal(suppressedReport.unsuppressedFindings, suppressedReport.findings.length - 1)
  } finally {
    await browser.close()
  }
})

test("mode-property separates breakpoint bands so a mode switch is neither a jump nor a new overlap", async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const url = `${baseUrl}/custom-mode`
    const sweep = (modeProperty?: string) => runLayoutSweep({
      browser,
      url,
      openPage: openPageFor(browser, url),
      options: { url, containerSelector: ".c", itemSelector: ":scope > .i", modeProperty, minWidth: 700, maxWidth: 900, profile: "quick", seed: 1, concurrency: 1, scenarios: ["sweep"], height: 400 },
    })
    // Without the component's signal the switch reads as a height jump, and
    // the authored narrow overlap reads as new relative to the wide anchor.
    const unaware = await sweep()
    assert.ok(findingsOf(unaware, "jump").length > 0)
    assert.ok(findingsOf(unaware, "overlap").length > 0)
    // With it, the switch is a band boundary and each band has its own anchor.
    const aware = await sweep("--component-viewport")
    assert.equal(findingsOf(aware, "jump").length, 0, JSON.stringify(aware.findings))
    assert.equal(findingsOf(aware, "overlap").length, 0, JSON.stringify(aware.findings))
    assert.ok(aware.boundaries.some((boundary) => boundary.kind === "signature" && boundary.low === 799 && boundary.high === 800))
  } finally {
    await browser.close()
  }
})

test("history and storm report no drift on a deterministic page", async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const url = `${baseUrl}/deterministic`
    const report = await runLayoutSweep({
      browser,
      url,
      openPage: openPageFor(browser, url),
      options: {
        url,
        containerSelector: ".layout-container",
        itemSelector: ".layout-item",
        minWidth: 320,
        maxWidth: 420,
        profile: "quick",
        seed: 3,
        concurrency: 2,
        scenarios: ["history", "storm"],
        historySteps: 6,
        storms: 2,
        height: 400,
      },
    })
    assert.equal(report.findings.length, 0, `expected no findings on a deterministic page, got ${JSON.stringify(report.findings)}`)
    assert.equal(report.status, "passed")
    assert.equal(findingsOf(report, "history").length, 0)
    assert.equal(findingsOf(report, "storm").length, 0)
    assert.equal(findingsOf(report, "unstable").length, 0)
  } finally {
    await browser.close()
  }
})

test("the same seed reproduces the same report", async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const url = `${baseUrl}/breakpoint`
    const optionsFor = () => ({
      url,
      containerSelector: ".layout-container",
      itemSelector: ".layout-item",
      minWidth: 700,
      maxWidth: 1000,
      profile: "quick" as const,
      seed: 42,
      concurrency: 1,
      scenarios: ["sweep", "history", "storm"],
      historySteps: 4,
      storms: 1,
      height: 400,
    })
    const first = await runLayoutSweep({ browser, url, openPage: openPageFor(browser, url), options: optionsFor() })
    const second = await runLayoutSweep({ browser, url, openPage: openPageFor(browser, url), options: optionsFor() })

    const strip = (report: LayoutSweepReport) => {
      const { timings: _timings, ...rest } = report
      return rest
    }
    assert.deepEqual(strip(first), strip(second))
    assert.ok(first.findings.some((finding) => finding.kind === "jump"), "the reproducibility fixture should still produce a non-trivial report")
    assert.ok(first.traces.historyWidths.length > 0)
    assert.ok(first.traces.stormWidths.length > 0)
  } finally {
    await browser.close()
  }
})

test("wordpress.layout-sweep is registered with validation, policy, and a recipe entry", () => {
  const definition = commandRegistry.find((entry) => entry.id === "wordpress.layout-sweep")
  assert.ok(definition, "wordpress.layout-sweep must be registered")
  assert.equal(definition!.recipe, true)
  assert.match(definition!.policyRequirement ?? "", /wordpress\.layout-sweep/)
  const requiredNames = new Set((definition!.acceptedArgs ?? []).filter((arg) => arg.required).map((arg) => arg.name))
  assert.ok(requiredNames.has("url"))
  assert.ok(requiredNames.has("container-selector"))
  assert.ok(requiredNames.has("item-selector"))
  assert.deepEqual(definition!.handler, { kind: "playground", method: "runLayoutSweep" })
  const outputSchema = JSON.stringify(definition!.outputSchema)
  assert.match(outputSchema, /wp-codebox\/layout-sweep\/v1/)
})

test("layoutSweepOptionsFromArgs parses accepted identities and rejects unknown scenarios", () => {
  const accepted = [{ kind: "overflow", container: "#0 container", item: null }]
  const options = layoutSweepOptionsFromArgs([
    "url=/preview",
    "container-selector=.layout-container",
    "item-selector=.layout-item",
    `accepted=${JSON.stringify(accepted)}`,
    "scenarios=sweep,history",
  ])
  assert.deepEqual(options.accepted, accepted)
  assert.deepEqual(options.scenarios, ["sweep", "history"])
  assert.throws(() => layoutSweepOptionsFromArgs(["url=/preview", "container-selector=.c", "item-selector=.i", "scenarios=not-a-real-scenario"]), /scenarios must be/)
  assert.throws(() => layoutSweepOptionsFromArgs(["container-selector=.c", "item-selector=.i"]), /requires url/)
  assert.equal(layoutSweepOptionsFromArgs(["url=/p", "container-selector=.c", "item-selector=.i", "mode-property=--canvas-viewport"]).modeProperty, "--canvas-viewport")
  assert.equal(layoutSweepOptionsFromArgs(["url=/p", "container-selector=.c", "item-selector=.i"]).modeProperty, "--layout-mode")
  assert.throws(() => layoutSweepOptionsFromArgs(["url=/p", "container-selector=.c", "item-selector=.i", "mode-property=color"]), /custom property/)
})

test("groupLayoutFindings groups by kind, container, and item and marks accepted identities suppressed", () => {
  const replay = { command: "wordpress.layout-sweep" as const, args: ["url=/preview"] }
  const findings: LayoutSweepFindingSample[] = [
    { scenario: "sweep", kind: "overflow", container: "#0 a", item: "#0 div", width: 320, by: 4 },
    { scenario: "sweep", kind: "overflow", container: "#0 a", item: "#0 div", width: 400, by: 10 },
    { scenario: "sweep", kind: "overflow", container: "#0 a", item: "#1 div", width: 320, by: 2 },
    { scenario: "sweep", kind: "leak", container: "#0 a", item: "#0 div", width: 320, by: 6 },
  ]
  const grouped = groupLayoutFindings(findings, [], replay)
  assert.equal(grouped.length, 3)
  const overflowGroup = grouped.find((group) => group.kind === "overflow" && group.item === "#0 div")
  assert.ok(overflowGroup)
  assert.equal(overflowGroup!.count, 2)
  assert.deepEqual(overflowGroup!.widthRange, [320, 400])
  assert.equal(overflowGroup!.worstMagnitude, 10)
  assert.equal(overflowGroup!.suppressed, false)

  const suppressed = groupLayoutFindings(findings, [{ kind: "overflow", container: "#0 a", item: "#0 div" }], replay)
  const suppressedGroup = suppressed.find((group) => group.kind === "overflow" && group.item === "#0 div")
  assert.equal(suppressedGroup!.suppressed, true)
  const otherOverflowGroup = suppressed.find((group) => group.kind === "overflow" && group.item === "#1 div")
  assert.equal(otherOverflowGroup!.suppressed, false)
})

test("wordpress.layout-sweep command wiring writes artifacts and reports findings in status without failing the command", async () => {
  await withTempDir("wp-codebox-layout-sweep-", async (artifactRoot) => {
    const server1 = { serverUrl: `${baseUrl}/deterministic`, playground: { run: async () => ({ text: "" }) }, async [Symbol.asyncDispose]() {} }
    const passing = await runLayoutSweepCommand({
      artifactRoot,
      server: server1 as never,
      spec: {
        command: "wordpress.layout-sweep",
        args: [`url=${baseUrl}/deterministic`, "container-selector=.layout-container", "item-selector=.layout-item", "min-width=320", "max-width=420", "scenarios=sweep", "concurrency=1"],
      },
    })
    const passingOutput = JSON.parse(passing.output)
    assert.equal(passingOutput.schema, "wp-codebox/layout-sweep/v1")
    assert.equal(passingOutput.status, "passed")
    assert.deepEqual(passingOutput.files, {
      summary: "files/browser/layout-sweep/summary.json",
      findings: "files/browser/layout-sweep/findings.json",
    })
    const persistedSummary = JSON.parse(await readFile(join(artifactRoot, passingOutput.files.summary), "utf8"))
    assert.equal(persistedSummary.status, "passed")

    const server2 = { serverUrl: `${baseUrl}/mixed`, playground: { run: async () => ({ text: "" }) }, async [Symbol.asyncDispose]() {} }
    // Findings are reported, not thrown: the command succeeds with status failed.
    const reporting = await runLayoutSweepCommand({
      artifactRoot,
      server: server2 as never,
      spec: {
        command: "wordpress.layout-sweep",
        args: [`url=${baseUrl}/mixed`, "container-selector=.layout-container", "item-selector=.layout-item", "min-width=700", "max-width=1000", "scenarios=sweep", "concurrency=2"],
      },
    })
    const reportingOutput = JSON.parse(reporting.output)
    assert.equal(reportingOutput.status, "failed")
    assert.ok(reportingOutput.unsuppressedFindings > 0)
    const failedFindings = JSON.parse(await readFile(join(artifactRoot, "files/browser/layout-sweep/findings.json"), "utf8"))
    assert.ok(Array.isArray(failedFindings))
    assert.ok(failedFindings.length > 0)
  })
})

console.log("browser layout sweep tests passed")
