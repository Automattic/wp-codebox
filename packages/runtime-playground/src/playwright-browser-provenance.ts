import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"

const packageRequire = createRequire(import.meta.url)

export interface PlaywrightBrowserProvenance {
  schema: "wp-codebox/playwright-browser-provenance/v1"
  playwrightVersion: string
  chromiumRevision: string
  chromiumVersion: string
  executablePath: string
  platform: NodeJS.Platform
  arch: string
  dependencyManifestSha256?: string
}

export interface PlaywrightBrowserReadiness {
  status: "ready" | "unavailable"
  reason?: string
}

export async function playwrightBrowserProvenance(): Promise<PlaywrightBrowserProvenance> {
  const { chromium } = await import("playwright")
  const playwright = packageRequire("playwright/package.json") as { version: string }
  const browsers = JSON.parse(readFileSync(join(dirname(packageRequire.resolve("playwright-core")), "browsers.json"), "utf8")) as { browsers: Array<{ name: string; revision: string; browserVersion?: string }> }
  const chromiumManifest = browsers.browsers.find((browser) => browser.name === "chromium")
  if (!chromiumManifest?.browserVersion) throw new Error("Installed Playwright package has no Chromium browser provenance.")

  return {
    schema: "wp-codebox/playwright-browser-provenance/v1",
    playwrightVersion: playwright.version,
    chromiumRevision: chromiumManifest.revision,
    chromiumVersion: chromiumManifest.browserVersion,
    executablePath: chromium.executablePath(),
    platform: process.platform,
    arch: process.arch,
    dependencyManifestSha256: dependencyManifestSha256(),
  }
}

export async function assertPlaywrightBrowserReady(): Promise<PlaywrightBrowserProvenance> {
  const provenance = await playwrightBrowserProvenance()
  if (!existsSync(provenance.executablePath)) {
    throw new Error(playwrightBrowserUnavailableReason(provenance))
  }
  return provenance
}

export async function playwrightBrowserReadiness(options: { executableExists?: (path: string) => boolean; signal?: AbortSignal; provenance?: () => Promise<PlaywrightBrowserProvenance> } = {}): Promise<PlaywrightBrowserReadiness> {
  throwIfAborted(options.signal)
  const provenance = await abortable(options.provenance?.() ?? playwrightBrowserProvenance(), options.signal)
  throwIfAborted(options.signal)
  if ((options.executableExists ?? existsSync)(provenance.executablePath)) return { status: "ready" }
  return { status: "unavailable", reason: playwrightBrowserUnavailableReason(provenance) }
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(new Error("Playwright browser readiness interrupted")) }
    signal.addEventListener("abort", abort, { once: true })
    void promise.then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value) },
      (error) => { signal.removeEventListener("abort", abort); reject(error) },
    )
  })
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Playwright browser readiness interrupted")
}

function playwrightBrowserUnavailableReason(provenance: PlaywrightBrowserProvenance): string {
  return `Required Playwright Chromium ${provenance.chromiumVersion} (revision ${provenance.chromiumRevision}) is unavailable. Install the browser owned by this WP Codebox package with: node ./node_modules/playwright/cli.js install chromium`
}

function dependencyManifestSha256(): string | undefined {
  try {
    const lockPath = packageRequire.resolve("../../../npm-shrinkwrap.json")
    return createHash("sha256").update(readFileSync(lockPath)).digest("hex")
  } catch {
    return undefined
  }
}
