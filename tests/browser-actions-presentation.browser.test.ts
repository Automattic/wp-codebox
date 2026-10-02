import assert from "node:assert/strict"
import { createServer } from "node:http"
import test from "node:test"
import { chromium } from "playwright"
import { browserPresentationInitScript } from "../packages/runtime-playground/src/browser-presentation.js"
import { executeBrowserInteractionStep } from "../packages/runtime-playground/src/browser-interactions.js"

test("presentation overlay survives navigation without intercepting clicks and scroll reaches target", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html")
    response.end('<button id="target" style="margin-top:2200px">target</button><script>window.clicked=false;document.querySelector("#target").onclick=()=>window.clicked=true</script>')
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert(address && typeof address === "object")
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext()
  await context.addInitScript(browserPresentationInitScript({ pointer: { enabled: true, style: "dot" } }))
  const page = await context.newPage()
  try {
    await page.goto(`http://127.0.0.1:${address.port}`)
    await page.reload()
    const overlay = await page.evaluate(() => {
      const host = document.querySelector("browser-presentation-root")
      return { exists: Boolean(host), hit: host ? document.elementFromPoint(5, 5) === host : false }
    })
    assert.equal(overlay.exists, true)
    assert.equal(overlay.hit, false)
    assert.match(browserPresentationInitScript({ pointer: { enabled: true } }), /visibility:hidden/)
    assert.match(browserPresentationInitScript({ pointer: { enabled: true } }), /cursor\.style\.visibility='visible'/)
    await executeBrowserInteractionStep(page, { kind: "scroll", selector: "#target", behavior: "smooth" }, page.url(), 3_000, async () => ({ path: "unused", isDefault: false }))
    const visible = await page.locator("#target").evaluate(element => {
      const rect = element.getBoundingClientRect()
      return rect.top >= 0 && rect.bottom <= innerHeight
    })
    assert.equal(visible, true)
    await page.locator("#target").click()
    assert.equal(await page.evaluate(() => (window as Window & { clicked: boolean }).clicked), true)
  } finally {
    await context.close()
    await browser.close()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
