import { mkdir, writeFile } from "node:fs/promises"
import { chromium } from "playwright"

const origin = process.env.BRICKS_PROBE_ORIGIN ?? "http://127.0.0.1:8798"
const outputDirectory = process.env.BRICKS_RENDER_OUTPUT ?? "outputs/bricks-render"

await mkdir(outputDirectory, { recursive: true })
const browser = await chromium.launch({ headless: true })
const results = []

try {
  for (const target of [
    { name: "desktop", width: 1440, height: 1000 },
    { name: "mobile", width: 390, height: 844 },
  ]) {
    const context = await browser.newContext({ viewport: { width: target.width, height: target.height }, deviceScaleFactor: 1 })
    const page = await context.newPage()
    const response = await page.goto(origin, { waitUntil: "networkidle", timeout: 30000 })
    if (!response?.ok()) throw new Error(`${target.name} homepage failed: ${response?.status() ?? "no response"}`)
    await page.locator("h1").waitFor({ state: "visible", timeout: 10000 })
    const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight)
    for (let y = 0; y < scrollHeight; y += Math.max(320, target.height - 120)) {
      await page.evaluate((nextY) => scrollTo(0, nextY), y)
      await page.waitForTimeout(80)
    }
    await page.evaluate(() => scrollTo(0, 0))
    await page.waitForTimeout(150)
    const evidence = await page.evaluate(() => {
      const rect = (selector) => {
        const node = document.querySelector(selector)
        if (!(node instanceof HTMLElement)) return null
        const box = node.getBoundingClientRect()
        return { x: box.x, y: box.y, width: box.width, height: box.height }
      }
      const rootStyle = getComputedStyle(document.documentElement)
      const heroStyle = getComputedStyle(document.querySelector(".hero"))
      const serviceStyle = getComputedStyle(document.querySelector(".service-grid"))
      const images = [...document.images].map((image) => ({
        alt: image.alt,
        complete: image.complete,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
        src: image.currentSrc,
      }))
      return {
        title: document.title,
        h1: document.querySelector("h1")?.textContent?.trim() ?? "",
        nativeElementCount: document.querySelectorAll("[id^='brxe-']").length,
        sections: document.querySelectorAll("main .brxe-section").length,
        headerVisible: Boolean(document.querySelector("#brx-header")?.getClientRects().length),
        footerVisible: Boolean(document.querySelector("#brx-footer")?.getClientRects().length),
        viewportWidth: innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
        heroColumns: heroStyle.gridTemplateColumns,
        serviceColumns: serviceStyle.gridTemplateColumns,
        hero: rect(".hero"),
        heroCopy: rect(".hero-copy"),
        heroMedia: rect(".hero-media"),
        serviceGrid: rect(".service-grid"),
        cssVariables: {
          brandNavy: rootStyle.getPropertyValue("--brand-navy").trim(),
          brandOrange: rootStyle.getPropertyValue("--brand-orange").trim(),
          spaceM: rootStyle.getPropertyValue("--space-m").trim(),
          textM: rootStyle.getPropertyValue("--text-m").trim(),
        },
        images,
      }
    })
    if (evidence.horizontalOverflow) throw new Error(`${target.name} has horizontal overflow: ${JSON.stringify(evidence)}`)
    if (evidence.h1 !== "Restore the wood you love. Protect it for years.") throw new Error(`${target.name} did not render the expected Bricks H1`)
    if (evidence.nativeElementCount < 40 || evidence.sections !== 4) throw new Error(`${target.name} native Bricks structure is incomplete: ${JSON.stringify(evidence)}`)
    if (evidence.images.length < 4 || evidence.images.some((image) => !image.complete || image.naturalWidth < 1)) throw new Error(`${target.name} media did not render: ${JSON.stringify(evidence.images)}`)
    const screenshot = `${outputDirectory}/${target.name}.png`
    await page.screenshot({ path: screenshot, fullPage: true })
    results.push({ ...target, screenshot, responseHeaders: await response.allHeaders(), evidence })
    await context.close()
  }
} finally {
  await browser.close()
}

const report = { status: "rendered-desktop-and-mobile", origin, results, generatedAt: new Date().toISOString() }
await writeFile(`${outputDirectory}/report.json`, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report))
