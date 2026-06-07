import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

const repoRoot = resolve(import.meta.dirname, "..")
const workspace = resolve(repoRoot, "artifacts", "editor-canvas-probe-smoke")
const pluginDir = join(workspace, "editor-canvas-fixture")
const recipePath = join(workspace, "recipe.json")
const artifactsRoot = join(workspace, "artifacts")

await rm(workspace, { recursive: true, force: true })
await mkdir(pluginDir, { recursive: true })

await writeFile(join(pluginDir, "editor-canvas-fixture.php"), `<?php
/**
 * Plugin Name: Editor Canvas Fixture
 */
add_action('wp_footer', function () {
    $srcdoc = '<!doctype html><html><body><div class="block-editor-block-list__layout" aria-busy="false"><p class="block-editor-block-list__block" data-block="fixture">Canvas block</p></div></body></html>';
    printf('<iframe name="editor-canvas" srcdoc="%s" style="width: 640px; height: 360px; border: 0;"></iframe>', esc_attr($srcdoc));
});
`)

await writeFile(recipePath, `${JSON.stringify({
  schema: "wp-codebox/workspace-recipe/v1",
  inputs: {
    extraPlugins: [
      {
        source: "./editor-canvas-fixture",
        pluginFile: "editor-canvas-fixture/editor-canvas-fixture.php",
        activate: true,
      },
    ],
  },
  workflow: {
    steps: [
      {
        command: "wordpress.editor-canvas-probe",
        args: [
          "url=/",
          "timeout-ms=10000",
          "capture=screenshot",
          `selector-groups-json=${JSON.stringify([
            { name: "layout", selector: ".block-editor-block-list__layout" },
            { name: "blocks", selectors: [".block-editor-block-list__block", "[data-block]"] },
          ])}`,
        ],
      },
    ],
  },
  artifacts: {
    directory: artifactsRoot,
  },
}, null, 2)}\n`)

const output = await runCli([
  "packages/cli/dist/index.js",
  "recipe-run",
  "--recipe",
  recipePath,
  "--json",
])

assert.equal(output.success, true, output.error?.message ?? "recipe-run failed")
assert.ok(output.artifacts?.directory, "recipe-run should return an artifact directory")

const artifactDirectory = output.artifacts.directory
const summaryPath = join(artifactDirectory, "files", "browser", "editor-canvas-summary.json")
const screenshotPath = join(artifactDirectory, "files", "browser", "editor-canvas-screenshot.png")
const manifestPath = join(artifactDirectory, "manifest.json")
const reviewPath = join(artifactDirectory, "files", "review.json")

assert.equal(existsSync(summaryPath), true, "editor canvas summary should be captured")
assert.equal(existsSync(screenshotPath), true, "editor canvas screenshot should be captured")

const summary = JSON.parse(await readFile(summaryPath, "utf8")) as {
  schema: string
  files: { screenshot?: string; summary: string }
  hashes: { screenshot?: { value: string } }
  summary: {
    ready: boolean
    readyMs: number | null
    diagnostics: Array<{ code: string }>
    selectorSummary: { totals: { matched_selector_count: number; visible_selector_count: number } }
  }
}
assert.equal(summary.schema, "wp-codebox/editor-canvas-probe/v1")
assert.equal(summary.files.summary, "files/browser/editor-canvas-summary.json")
assert.equal(summary.files.screenshot, "files/browser/editor-canvas-screenshot.png")
assert.ok(summary.hashes.screenshot?.value, "summary should include screenshot hash")
assert.equal(summary.summary.ready, true, "editor canvas should be ready")
assert.equal(typeof summary.summary.readyMs, "number", "readyMs should be recorded")
assert.deepEqual(summary.summary.diagnostics, [])
assert.equal(summary.summary.selectorSummary.totals.matched_selector_count, 3)
assert.equal(summary.summary.selectorSummary.totals.visible_selector_count, 3)

const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { files: Array<{ path: string; kind: string }> }
assert.ok(manifest.files.some((file) => file.path === "files/browser/editor-canvas-summary.json" && file.kind === "browser-summary"))
assert.ok(manifest.files.some((file) => file.path === "files/browser/editor-canvas-screenshot.png" && file.kind === "browser-screenshot"))

const review = JSON.parse(await readFile(reviewPath, "utf8")) as { browser?: { probes?: Array<{ screenshot?: string; summaryFile?: string }> } }
assert.equal(review.browser?.probes?.[0]?.summaryFile, "files/browser/editor-canvas-summary.json")
assert.equal(review.browser?.probes?.[0]?.screenshot, "files/browser/editor-canvas-screenshot.png")

function runCli(args: string[]): Promise<Record<string, any>> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, args, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => { stdout += String(chunk) })
    child.stderr.on("data", (chunk) => { stderr += String(chunk) })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`CLI exited with ${code}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`))
        return
      }
      try {
        resolveRun(JSON.parse(stdout) as Record<string, any>)
      } catch (error) {
        reject(new Error(`CLI output was not JSON: ${error instanceof Error ? error.message : String(error)}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`))
      }
    })
  })
}
