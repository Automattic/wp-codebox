import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { chromium } from "playwright"
import { validateBrowserInteractionScript } from "../packages/runtime-core/src/browser-interaction.js"
import { executeBrowserAnnotation } from "../packages/runtime-playground/src/browser-annotations.js"
import { runBrowserActionsCommand } from "../packages/runtime-playground/src/browser-actions-runner.js"
import { wordpressRuntimeSpec } from "../scripts/test-kit.js"

test("annotation shapes and clear validate", () => {
  for (const step of [
    { kind: "annotate", shape: "highlight", selector: "button" },
    { kind: "annotate", shape: "spotlight", selector: "button" },
    { kind: "annotate", shape: "arrow", selector: "button", direction: "bottom-left" },
    { kind: "annotate", shape: "label", text: "Continue", anchor: { selector: "button" } },
    { kind: "annotate", shape: "caption", text: "Next" },
    { kind: "annotate", clear: ["one"] },
    { kind: "annotate", clear: true },
  ]) assert.equal(validateBrowserInteractionScript([step]).valid, true)
  assert.equal(validateBrowserInteractionScript([{ kind: "annotate", shape: "label", text: "x" }]).valid, false)
  assert.equal(validateBrowserInteractionScript([{ kind: "annotate", shape: "arrow", selector: "button", direction: "nearby" }]).valid, false)
  assert.equal(validateBrowserInteractionScript([{ kind: "annotate", shape: "caption", text: "Next", offset: 120 }]).valid, true)
  assert.equal(validateBrowserInteractionScript([{ kind: "annotate", shape: "caption", text: "Next", offset: -1 }]).valid, false)
  assert.equal(validateBrowserInteractionScript([{ kind: "annotate", shape: "label", text: "Next", offset: 10, anchor: { selector: "button" } }]).valid, false)
})

test("annotation renders in isolated overlay, follows scrolling, passes clicks, and clears by id", async () => {
  const server = createServer((_request, response) => { response.setHeader("content-type", "text/html"); response.end('<button id="target" style="margin-top:900px">press</button><div style="height:2000px"></div>') })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address(); assert(address && typeof address === "object")
  const url = `http://127.0.0.1:${address.port}`
  const fixture = { serverUrl: url, playground: { async run() { return { text: "", exitCode: 0 } } }, async [Symbol.asyncDispose]() {} }
  const artifactRoot = await mkdtemp(join(tmpdir(), "wp-codebox-annotations-"))
  try {
    await runBrowserActionsCommand({ artifactRoot, runtimeSpec: wordpressRuntimeSpec({ commands: ["wordpress.browser-actions"] }), server: fixture, spec: { command: "wordpress.browser-actions", args: [] }, plan: {
      steps: [{ kind: "navigate", url }, { kind: "annotate", id: "focus", shape: "highlight", selector: "#target" }, { kind: "click", selector: "#target" }, { kind: "press", key: "PageDown" }, { kind: "waitFor", waitFor: "duration", duration: "100ms" }, { kind: "annotate", clear: ["focus"] }],
      capture: new Set(["steps"]), stepTimeoutMs: 2000, totalTimeoutMs: 10000, networkSettleTimeoutMs: 100, maxDomSnapshotElements: 20,
    } })
    const records = (await readFile(join(artifactRoot, "files/browser/steps.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    assert.equal(records[1].kind, "annotate")
    assert.equal(records[2].status, "ok", "overlay must not intercept target click")
    assert.equal(records[4].status, "ok", "target scroll should complete while annotation is active")
    assert.equal(records[5].status, "ok", "annotation should clear by id")
  } finally { await rm(artifactRoot, { recursive: true, force: true }); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }
})

test("arrows point to the target edge and labels avoid adjacent controls", async () => {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 600, height: 400 } })
  try {
    await page.setContent('<button id="above" style="position:absolute;left:200px;top:80px">Above</button><button id="target" style="position:absolute;left:200px;top:150px;width:120px;height:40px">Target</button><button id="below" style="position:absolute;left:200px;top:230px">Below</button>')
    for (const direction of ["left", "right", "top", "bottom"]) {
      await executeBrowserAnnotation(page, { kind: "annotate", id: direction, shape: "arrow", selector: "#target", direction } as never)
      const error = await page.evaluate((id) => {
        const target = document.querySelector("#target")!.getBoundingClientRect()
        const node = document.querySelector("#__wp_codebox_annotations")!.shadowRoot!.querySelector(`[data-annotation-id="${id}"]`)!
        const path = node.querySelector("path")!
        const match = path.getAttribute("d")!.match(/M ([\d.]+) ([\d.]+) L ([\d.]+) ([\d.]+)/)!
        const bounds = node.getBoundingClientRect()
        const x = bounds.left + Number(match[3]), y = bounds.top + Number(match[4])
        return Math.min(Math.abs(x - target.left), Math.abs(x - target.right), Math.abs(y - target.top), Math.abs(y - target.bottom))
      }, direction)
      assert.ok(error <= 1, `${direction} arrow tip should land on the target edge`)
    }
    await executeBrowserAnnotation(page, { kind: "annotate", id: "label", shape: "label", text: "Continue", anchor: { selector: "#target", placement: "top" } } as never)
    const overlap = await page.evaluate(() => {
      const label = document.querySelector("#__wp_codebox_annotations")!.shadowRoot!.querySelector('[data-annotation-id="label"]')!.getBoundingClientRect()
      return ["#above", "#target", "#below"].some(selector => {
        const box = document.querySelector(selector)!.getBoundingClientRect()
        return label.left < box.right && label.right > box.left && label.top < box.bottom && label.bottom > box.top
      })
    })
    assert.equal(overlap, false)
  } finally { await browser.close() }
})

test("captions wrap inside their pill and apply a validated vertical offset", async () => {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 320, height: 600 } })
  try {
    await page.setContent("<div></div>")
    await executeBrowserAnnotation(page, { kind: "annotate", id: "caption", shape: "caption", position: "top", offset: 120, text: "WordPress Meetup · Wed Oct 21 · 6:30pm" } as never)
    const dimensions = await page.evaluate(() => {
      const root = document.querySelector("#__wp_codebox_annotations")!.shadowRoot!
      const caption = root.querySelector('[data-annotation-id="caption"]')!
      const pill = caption.getBoundingClientRect()
      const range = document.createRange()
      range.selectNodeContents(caption)
      const text = [...range.getClientRects()]
      return { textRects: text.map(({ left, right, top, bottom }) => ({ left, right, top, bottom })), pill: { left: pill.left, right: pill.right, top: pill.top, bottom: pill.bottom }, viewportWidth: innerWidth, height: pill.height, whiteSpace: getComputedStyle(caption).whiteSpace, overflowWrap: getComputedStyle(caption).overflowWrap }
    })
    assert.ok(dimensions.textRects.length > 1, "long caption should produce multiple text lines")
    assert.ok(dimensions.textRects.every(({ left, right, top, bottom }) => left >= dimensions.pill.left && right <= dimensions.pill.right && top >= dimensions.pill.top && bottom <= dimensions.pill.bottom))
    assert.ok(dimensions.textRects.every(({ left, right }) => left >= 0 && right <= dimensions.viewportWidth))
    assert.equal(dimensions.pill.top, 176)
    assert.ok(dimensions.height > 32, "long caption should wrap into multiple lines")
    assert.equal(dimensions.whiteSpace, "normal")
    assert.equal(dimensions.overflowWrap, "anywhere")
  } finally { await browser.close() }
})
