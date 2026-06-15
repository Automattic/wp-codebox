import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

const repoRoot = resolve(import.meta.dirname, "..")
const workspace = resolve(repoRoot, "artifacts", "browser-actions-painted-readiness-smoke")
const pluginDir = join(workspace, "browser-painted-readiness-fixture")
const recipePath = join(workspace, "recipe.json")
const stalledRecipePath = join(workspace, "stalled-recipe.json")
const artifactsRoot = join(workspace, "artifacts")
const stalledArtifactsRoot = join(workspace, "stalled-artifacts")

await rm(workspace, { recursive: true, force: true })
await mkdir(pluginDir, { recursive: true })

await writeFile(join(pluginDir, "browser-painted-readiness-fixture.php"), `<?php
/**
 * Plugin Name: Browser Painted Readiness Fixture
 */
add_action('template_redirect', function () {
    if ( ! isset( $_GET['wp_codebox_painted_readiness_fixture'] ) ) {
        return;
    }

    nocache_headers();
    $frame_html = '<!doctype html><html><body style="margin:0;background:#0f766e;color:white;font:24px sans-serif;display:grid;place-items:center;height:900px"><main id="rendered">Rendered iframe content</main></body></html>';
    echo '<!doctype html><html><head><style>body{font-family:sans-serif;margin:0;padding:24px}iframe{width:360px;height:160px;border:4px solid #111827}</style></head><body><button id="render-frame" type="button">Render frame</button><iframe id="preview-frame" title="Preview frame"></iframe><script>const frameHtml = ' . wp_json_encode( $frame_html ) . '; document.getElementById("render-frame").addEventListener("click", function () { setTimeout(function () { document.getElementById("preview-frame").srcdoc = frameHtml; }, 250); });</script></body></html>';
    exit;
} );
`)

await writeFile(recipePath, `${JSON.stringify({
  schema: "wp-codebox/workspace-recipe/v1",
  inputs: {
    extra_plugins: [
      {
        source: "./browser-painted-readiness-fixture",
        pluginFile: "browser-painted-readiness-fixture/browser-painted-readiness-fixture.php",
        activate: true,
      },
    ],
  },
  workflow: {
    steps: [
      {
        command: "wordpress.browser-actions",
        args: [
          "url=/?wp_codebox_painted_readiness_fixture=1",
          `steps-json=${JSON.stringify([
            { kind: "waitFor", selector: "#render-frame" },
            { kind: "click", selector: "#render-frame" },
            { kind: "screenshot", name: "frame-painted", waitFor: "frame-painted:#preview-frame" },
            { kind: "screenshot", name: "frame-document", frameSelector: "#preview-frame" },
          ])}`,
          "viewport=480x320",
          "step-timeout=8s",
          "capture=steps,errors,screenshot,dom-snapshot",
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
const stepsPath = join(artifactDirectory, "files", "browser", "steps.jsonl")
const screenshotPath = join(artifactDirectory, "files", "browser", "screenshot-frame-painted.png")
const frameDocumentScreenshotPath = join(artifactDirectory, "files", "browser", "screenshot-frame-document.png")
const domSnapshotPath = join(artifactDirectory, "files", "browser", "dom-snapshot-frame-painted.json")
const summaryPath = join(artifactDirectory, "files", "browser", "action-summary.json")

assert.equal(existsSync(stepsPath), true, "steps.jsonl should be captured")
assert.equal(existsSync(screenshotPath), true, "painted iframe screenshot should be captured")
assert.equal(existsSync(frameDocumentScreenshotPath), true, "frame document screenshot should be captured")
assert.equal(existsSync(domSnapshotPath), true, "painted iframe screenshot should have a DOM sidecar")
assert.equal(existsSync(summaryPath), true, "action summary should be captured")

const steps = (await readFile(stepsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line)) as Array<{
  kind: string
  screenshot?: string
  readiness?: { mode: string; selector?: string; ready: boolean; visibleElementCount: number; textLength: number; frameUrl?: string }
}>
const screenshotStep = steps.find((step) => step.kind === "screenshot")
assert.equal(screenshotStep?.screenshot, "files/browser/screenshot-frame-painted.png")
assert.equal(screenshotStep?.readiness?.mode, "frame-selector")
assert.equal(screenshotStep?.readiness?.selector, "#preview-frame")
assert.equal(screenshotStep?.readiness?.ready, true)
assert.ok((screenshotStep?.readiness?.visibleElementCount ?? 0) > 0, "readiness should observe visible rendered iframe elements")
assert.ok((screenshotStep?.readiness?.textLength ?? 0) > 0, "readiness should observe rendered iframe text")
assert.match(screenshotStep?.readiness?.frameUrl ?? "", /about:srcdoc|wp_codebox_painted_readiness_fixture/)

const frameDocumentStep = steps.find((step) => step.kind === "screenshot" && step.screenshot === "files/browser/screenshot-frame-document.png")
assert.equal(frameDocumentStep?.target?.mode, "frame-selector")
assert.equal(frameDocumentStep?.target?.selector, "#preview-frame")
const frameDocumentDimensions = pngDimensions(await readFile(frameDocumentScreenshotPath))
assert.equal(frameDocumentDimensions.width, 360, "frame document screenshot should use iframe document width")
assert.ok(frameDocumentDimensions.height >= 900, "frame document screenshot should capture iframe document height")

const summary = JSON.parse(await readFile(summaryPath, "utf8")) as { steps: Array<{ kind: string; readiness?: unknown }>; files: { domSnapshots?: string[] } }
assert.ok(summary.steps.some((step) => step.kind === "screenshot" && step.readiness), "summary should preserve screenshot readiness evidence")
assert.ok(summary.files.domSnapshots?.includes("files/browser/dom-snapshot-frame-painted.json"), "summary should include the screenshot DOM sidecar")

await writeFile(stalledRecipePath, `${JSON.stringify({
  schema: "wp-codebox/workspace-recipe/v1",
  inputs: {
    extra_plugins: [
      {
        source: "./browser-painted-readiness-fixture",
        pluginFile: "browser-painted-readiness-fixture/browser-painted-readiness-fixture.php",
        activate: true,
      },
    ],
  },
  workflow: {
    steps: [
      {
        command: "wordpress.browser-actions",
        args: [
          "url=/?wp_codebox_painted_readiness_fixture=1",
          `steps-json=${JSON.stringify([
            { kind: "waitFor", selector: "#render-frame" },
            { kind: "evaluate", expression: "window.requestAnimationFrame = () => 0; return true" },
            { kind: "screenshot", name: "painted-stall", waitFor: "painted", timeout: "5s" },
          ])}`,
          "viewport=480x320",
          "timeout=8s",
          "capture=steps,errors,screenshot,dom-snapshot",
        ],
      },
    ],
  },
  artifacts: {
    directory: stalledArtifactsRoot,
  },
}, null, 2)}\n`)

const stalledOutput = await runCli([
  "packages/cli/dist/index.js",
  "recipe-run",
  "--recipe",
  stalledRecipePath,
  "--json",
], { expectSuccess: false })

assert.equal(stalledOutput.success, false, "stalled painted readiness recipe should fail")
assert.match(stalledOutput.error?.message ?? "", /painted-readiness-stabilization|exceeded 1000ms|wall/i)
const stalledArtifact = findBrowserArtifact(stalledOutput, "actions")
assert.ok(stalledOutput.artifacts?.directory || stalledArtifact, "failed painted readiness recipe should report a browser artifact")

const stalledSummaryPath = stalledOutput.artifacts?.directory ? join(stalledOutput.artifacts.directory, "files", "browser", "action-summary.json") : undefined
if (stalledSummaryPath) {
  assert.equal(existsSync(stalledSummaryPath), true, "stalled painted readiness should still write action summary")
}
const stalledSummary = stalledSummaryPath
  ? JSON.parse(await readFile(stalledSummaryPath, "utf8")) as { steps: Array<{ status: string; error?: { message?: string } }>; summary: { errors: number } }
  : { steps: [], summary: stalledArtifact?.summary ?? { errors: 0 } }
if (stalledSummary.steps.length > 0) {
  assert.equal(stalledSummary.steps.at(-1)?.status, "failed")
  assert.match(stalledSummary.steps.at(-1)?.error?.message ?? "", /painted-readiness-stabilization|exceeded 1000ms|wall/i)
}
assert.ok(stalledSummary.summary.errors > 0, "stalled painted readiness should record an error")

console.log(`Browser actions painted readiness smoke passed: ${artifactDirectory}`)

async function runCli(args: string[], options: { expectSuccess?: boolean } = {}): Promise<{ success?: boolean; artifacts?: { directory?: string }; error?: { message?: string } }> {
  const child = spawn(process.execPath, args, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => { stdout += chunk })
  child.stderr.on("data", (chunk) => { stderr += chunk })
  const code = await new Promise<number | null>((resolveCode) => child.on("close", resolveCode))
  if ((options.expectSuccess ?? true) && code !== 0) {
    throw new Error(`CLI exited with ${code}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`)
  }
  if (!(options.expectSuccess ?? true) && code === 0) {
    throw new Error(`CLI unexpectedly exited with 0\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`)
  }
  return JSON.parse(stdout)
}

function pngDimensions(buffer: Buffer): { width: number; height: number } {
  assert.equal(buffer.toString("ascii", 1, 4), "PNG", "screenshot should be a PNG")
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

function findBrowserArtifact(value: unknown, artifactType: string): Record<string, any> | undefined {
  if (!value || typeof value !== "object") {
    return undefined
  }
  if ((value as Record<string, unknown>).artifactType === artifactType) {
    return value as Record<string, any>
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    if (Array.isArray(child)) {
      for (const item of child) {
        const found = findBrowserArtifact(item, artifactType)
        if (found) return found
      }
    } else {
      const found = findBrowserArtifact(child, artifactType)
      if (found) return found
    }
  }
  return undefined
}
