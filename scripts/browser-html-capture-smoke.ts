import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

const repoRoot = resolve(import.meta.dirname, "..")
const workspace = resolve(repoRoot, "artifacts", "browser-html-capture-smoke")
const pluginDir = join(workspace, "html-capture-fixture")
const recipePath = join(workspace, "recipe.json")
const artifactsRoot = join(workspace, "artifacts")

await rm(workspace, { recursive: true, force: true })
await mkdir(pluginDir, { recursive: true })

await writeFile(join(pluginDir, "html-capture-fixture.php"), `<?php
/**
 * Plugin Name: HTML Capture Fixture
 */
add_action('wp_footer', function () {
    echo '<main id="wp-codebox-html-capture"><h1>Captured by Codebox</h1><script>console.log("wp-codebox html capture ready");</script></main>';
});
`)

await writeFile(recipePath, `${JSON.stringify({
  schema: "wp-codebox/workspace-recipe/v1",
  inputs: {
    extraPlugins: [
      {
        source: "./html-capture-fixture",
        pluginFile: "html-capture-fixture/html-capture-fixture.php",
        activate: true,
      },
    ],
  },
  workflow: {
    steps: [
      {
        command: "wordpress.capture-html",
        args: ["url=/"],
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
], 0)

assert.equal(output.success, true, output.error?.message ?? "recipe-run failed")
assert.ok(output.artifacts?.directory, "recipe-run should return an artifact directory")
assert.equal(output.executions?.[0]?.command, "wordpress.capture-html")

const artifactDirectory = output.artifacts.directory
const htmlPath = join(artifactDirectory, "files", "browser", "snapshot.html")
const consolePath = join(artifactDirectory, "files", "browser", "console.jsonl")
const errorsPath = join(artifactDirectory, "files", "browser", "errors.jsonl")
const networkPath = join(artifactDirectory, "files", "browser", "network.jsonl")
const summaryPath = join(artifactDirectory, "files", "browser", "summary.json")
const manifestPath = join(artifactDirectory, "manifest.json")
const reviewPath = join(artifactDirectory, "files", "review.json")

assert.equal(existsSync(htmlPath), true, "snapshot.html should be captured")
assert.equal(existsSync(consolePath), true, "console.jsonl should be captured")
assert.equal(existsSync(errorsPath), true, "errors.jsonl should be captured")
assert.equal(existsSync(networkPath), true, "network.jsonl should be captured")
assert.equal(existsSync(summaryPath), true, "summary.json should be captured")

const htmlSnapshot = await readFile(htmlPath, "utf8")
const consoleLog = await readFile(consolePath, "utf8")
assert.match(htmlSnapshot, /Captured by Codebox/)
assert.match(consoleLog, /wp-codebox html capture ready/)

const summary = JSON.parse(await readFile(summaryPath, "utf8")) as {
  schema: string
  files: { html?: string; console?: string; errors?: string; network?: string; summary: string }
  summary: { replayability: string; htmlSnapshot: boolean; screenshot: boolean }
}
assert.equal(summary.schema, "wp-codebox/browser-probe/v1")
assert.equal(summary.files.html, "files/browser/snapshot.html")
assert.equal(summary.files.summary, "files/browser/summary.json")
assert.equal(summary.summary.replayability, "partial")
assert.equal(summary.summary.htmlSnapshot, true)
assert.equal(summary.summary.screenshot, false)

const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { files: Array<{ path: string; kind: string }> }
assert.ok(manifest.files.some((file) => file.path === "files/browser/snapshot.html" && file.kind === "browser-html-snapshot"))
assert.ok(manifest.files.some((file) => file.path === "files/browser/summary.json" && file.kind === "browser-summary"))

const review = JSON.parse(await readFile(reviewPath, "utf8")) as { browser?: { probes?: Array<{ html?: string; summaryFile?: string }> } }
assert.equal(review.browser?.probes?.[0]?.html, "files/browser/snapshot.html")
assert.equal(review.browser?.probes?.[0]?.summaryFile, "files/browser/summary.json")

console.log(`Browser HTML capture smoke passed: ${artifactDirectory}`)

async function runCli(args: string[], expectedExitCode: number): Promise<any> {
  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  })

  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString()
  })
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString()
  })

  const exitCode = await new Promise<number | null>((resolveExit) => child.once("exit", (code) => resolveExit(code)))
  assert.equal(exitCode, expectedExitCode, `CLI exited with ${exitCode}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`)
  return JSON.parse(stdout)
}
