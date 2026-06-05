import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

const repoRoot = resolve(import.meta.dirname, "..")
const workspace = resolve(repoRoot, "artifacts", "browser-scenario-artifact-smoke")
const pluginDir = join(workspace, "browser-scenario-fixture")
const recipePath = join(workspace, "recipe.json")
const artifactsRoot = join(workspace, "artifacts")

await rm(workspace, { recursive: true, force: true })
await mkdir(pluginDir, { recursive: true })

await writeFile(join(pluginDir, "browser-scenario-fixture.php"), `<?php
/**
 * Plugin Name: Browser Scenario Fixture
 */
add_action('wp_footer', function () {
    echo '<main id="wp-codebox-scenario"><label for="wp-codebox-scenario-name">Name</label><input id="wp-codebox-scenario-name" value=""><button id="wp-codebox-scenario-button" type="button">Apply</button><p id="wp-codebox-scenario-result" data-state="idle"></p><script>document.getElementById("wp-codebox-scenario-button").addEventListener("click", function () { var value = document.getElementById("wp-codebox-scenario-name").value; var result = document.getElementById("wp-codebox-scenario-result"); result.dataset.state = "done"; result.textContent = "Scenario " + value; console.log("wp-codebox browser scenario completed"); });</script></main>';
});
`)

await writeFile(recipePath, `${JSON.stringify({
  schema: "wp-codebox/workspace-recipe/v1",
  inputs: {
    extraPlugins: [
      {
        source: "./browser-scenario-fixture",
        pluginFile: "browser-scenario-fixture/browser-scenario-fixture.php",
        activate: true,
      },
    ],
  },
  workflow: {
    steps: [
      {
        command: "wordpress.browser-scenario",
        args: [
          `scenario-json=${JSON.stringify({
            url: "/",
            profile: "desktop-chrome",
            captures: ["steps", "console", "errors", "html", "network", "screenshot"],
            steps: [
              { type: "wait", ms: 100 },
              { kind: "waitFor", selector: "#wp-codebox-scenario-button" },
              { kind: "fill", selector: "#wp-codebox-scenario-name", value: "Evidence" },
              { kind: "click", selector: "#wp-codebox-scenario-button" },
              { kind: "waitFor", selector: '#wp-codebox-scenario-result[data-state="done"]' },
            ],
            assertions: [
              { type: "selectorVisible", selector: "#wp-codebox-scenario-result", withinMs: 3000 },
              { type: "noPageErrors" },
            ],
            viewport: "390x844",
          })}`,
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
], 0)

assert.equal(output.success, true, output.error?.message ?? "recipe-run failed")
assert.ok(output.artifacts?.directory, "recipe-run should return an artifact directory")

const artifactDirectory = output.artifacts.directory
const scenarioSummaryPath = join(artifactDirectory, "files", "browser", "scenario-summary.json")
const actionSummaryPath = join(artifactDirectory, "files", "browser", "action-summary.json")
const stepsPath = join(artifactDirectory, "files", "browser", "steps.jsonl")
const consolePath = join(artifactDirectory, "files", "browser", "console.jsonl")
const htmlPath = join(artifactDirectory, "files", "browser", "snapshot.html")
const screenshotPath = join(artifactDirectory, "files", "browser", "screenshot.png")
const reviewPath = join(artifactDirectory, "files", "review.json")

assert.equal(existsSync(scenarioSummaryPath), true, "scenario-summary.json should be captured")
assert.equal(existsSync(actionSummaryPath), true, "action-summary.json should be captured")
assert.equal(existsSync(stepsPath), true, "steps.jsonl should be captured")
assert.equal(existsSync(consolePath), true, "console.jsonl should be captured")
assert.equal(existsSync(htmlPath), true, "snapshot.html should be captured")
assert.equal(existsSync(screenshotPath), true, "screenshot.png should be captured")

const scenarioSummary = JSON.parse(await readFile(scenarioSummaryPath, "utf8")) as {
  schema: string
  finalUrl: string
  profile: string
  files: { actionSummary?: string; scenarioSummary: string }
  viewport: { width: number; height: number; userAgent: string }
  summary: { actions?: { assertions?: { total: number; passed: number; failed: number }; steps: number } }
}
assert.equal(scenarioSummary.schema, "wp-codebox/browser-scenario/v1")
assert.equal(scenarioSummary.finalUrl.endsWith("/"), true, "scenario summary should include final URL")
assert.equal(scenarioSummary.profile, "desktop-chrome")
assert.equal(scenarioSummary.files.actionSummary, "files/browser/action-summary.json")
assert.equal(scenarioSummary.files.scenarioSummary, "files/browser/scenario-summary.json")
assert.equal(scenarioSummary.viewport.width, 390)
assert.equal(scenarioSummary.viewport.height, 844)
assert.ok(scenarioSummary.viewport.userAgent.length > 0, "scenario summary should include browser context metadata")
assert.equal(scenarioSummary.summary.actions?.steps, 8)
assert.equal(scenarioSummary.summary.actions?.assertions?.total, 2)
assert.equal(scenarioSummary.summary.actions?.assertions?.passed, 2)
assert.equal(scenarioSummary.summary.actions?.assertions?.failed, 0)

const stepsLog = await readFile(stepsPath, "utf8")
const consoleLog = await readFile(consolePath, "utf8")
const htmlSnapshot = await readFile(htmlPath, "utf8")
assert.match(stepsLog, /"kind":"fill"/)
assert.match(stepsLog, /"kind":"click"/)
assert.match(stepsLog, /"kind":"expect"/)
assert.match(stepsLog, /"kind":"evaluate"/)
assert.match(consoleLog, /wp-codebox browser scenario completed/)
assert.match(htmlSnapshot, /Scenario Evidence/)

const review = JSON.parse(await readFile(reviewPath, "utf8")) as { browser?: { probes?: Array<{ summaryFile?: string; assertions?: { total: number; passed: number; failed: number } }> } }
assert.equal(review.browser?.probes?.[0]?.summaryFile, "files/browser/scenario-summary.json")
assert.equal(review.browser?.probes?.[0]?.assertions?.total, 2)
assert.equal(review.browser?.probes?.[0]?.assertions?.passed, 2)

console.log(`Browser scenario artifact smoke passed: ${artifactDirectory}`)

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
