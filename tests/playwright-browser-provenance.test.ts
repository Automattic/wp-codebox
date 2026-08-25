import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { test } from "node:test"
import { playwrightBrowserProvenance, playwrightBrowserReadiness } from "../packages/runtime-playground/src/playwright-browser-provenance.js"

test("reports the lock-resolved Playwright Chromium provenance", async () => {
  const provenance = await playwrightBrowserProvenance()
  const manifest = JSON.parse(await readFile(resolve(import.meta.dirname, "..", "npm-shrinkwrap.json"), "utf8")) as { packages: Record<string, { version?: string }> }

  assert.equal(provenance.schema, "wp-codebox/playwright-browser-provenance/v1")
  assert.equal(provenance.playwrightVersion, manifest.packages["node_modules/playwright"]?.version)
  assert.equal(provenance.chromiumRevision, "1228")
  assert.equal(provenance.chromiumVersion, "149.0.7827.55")
  assert.ok(provenance.executablePath.length > 0)
  assert.equal(provenance.platform, process.platform)
  assert.equal(provenance.arch, process.arch)
  assert.equal(provenance.dependencyManifestSha256, createHash("sha256").update(await readFile(resolve(import.meta.dirname, "..", "npm-shrinkwrap.json"))).digest("hex"))
})

test("reports missing and present browser revisions without using the ambient cache", async () => {
  const provenance = await playwrightBrowserProvenance()
  const missing = await playwrightBrowserReadiness({ executableExists: () => false })
  assert.equal(missing.status, "unavailable")
  assert.match(missing.reason ?? "", new RegExp(`revision ${provenance.chromiumRevision}`))
  assert.doesNotMatch(missing.reason ?? "", /\/home\/|\\Users\\|node_modules.*cache/)

  const present = await playwrightBrowserReadiness({ executableExists: () => true })
  assert.deepEqual(present, { status: "ready" })
})
