import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import pixelmatch from "pixelmatch"
import { PNG } from "pngjs"
import { chromium } from "playwright"

export async function assertVisualParity({ sourceUrl, candidateUrl, artifactRoot }) {
  const browser = await chromium.launch({ headless: true })
  try {
    await mkdir(artifactRoot, { recursive: true })
    const source = await screenshot(browser, sourceUrl)
    const candidate = await screenshot(browser, candidateUrl)
    await writeFile(join(artifactRoot, "source.png"), source)
    await writeFile(join(artifactRoot, "candidate.png"), candidate)
    const sourcePng = PNG.sync.read(source)
    const candidatePng = PNG.sync.read(candidate)
    if (sourcePng.width !== candidatePng.width || sourcePng.height !== candidatePng.height) throw new Error(`Static artifact visual parity dimensions differ: source=${sourcePng.width}x${sourcePng.height} candidate=${candidatePng.width}x${candidatePng.height}.`)
    const difference = new PNG({ width: sourcePng.width, height: sourcePng.height })
    const mismatched = pixelmatch(sourcePng.data, candidatePng.data, difference.data, sourcePng.width, sourcePng.height, { threshold: 0, includeAA: true })
    if (mismatched !== 0) {
      await writeFile(join(artifactRoot, "difference.png"), PNG.sync.write(difference))
      throw new Error(`Static artifact visual parity found ${mismatched} mismatched pixels; evidence: ${artifactRoot}.`)
    }
  } finally {
    await browser.close()
  }
}

async function screenshot(browser, url) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, reducedMotion: "reduce" })
  try {
    const page = await context.newPage()
    await page.route("**/*", async (route) => {
      const requestUrl = new URL(route.request().url())
      const pageUrl = new URL(url)
      if (requestUrl.origin === pageUrl.origin) await route.continue()
      else await route.abort("blockedbyclient")
    })
    await page.goto(url, { waitUntil: "networkidle", timeout: 120_000 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    return page.screenshot({ fullPage: true, animations: "disabled" })
  } finally {
    await context.close()
  }
}
