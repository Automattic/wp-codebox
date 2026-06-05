import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const workspace = await mkdtemp(join(tmpdir(), "wp-codebox-browser-profile-matrix-"))

try {
  const artifacts = join(workspace, "artifacts")
  const recipePath = join(workspace, "recipe.json")
  await writeFile(recipePath, `${JSON.stringify({
    schema: "wp-codebox/workspace-recipe/v1",
    runtime: { wp: "7.0" },
    workflow: {
      steps: [{
        command: "wordpress.browser-probe",
        args: [
          "url=/",
          "capture=html,screenshot",
          "profiles=desktop-chrome,mobile-chrome",
        ],
      }],
    },
    artifacts: {
      directory: artifacts,
      verify: false,
      workspacePolicy: { strict: false, writableRoots: ["."], gitBacked: false },
    },
  }, null, 2)}\n`)

  const output = await runRecipe(recipePath, artifacts)
  assert.equal(output.schema, "wp-codebox/recipe-run/v1")
  assert.equal(output.success, true, `recipe-run should succeed: ${JSON.stringify(output, null, 2)}`)
  assert.ok(output.artifacts?.directory, "recipe-run should report artifact directory")

  const artifactDirectory = output.artifacts.directory
  const desktopSummaryPath = join(artifactDirectory, "files", "browser", "desktop-chrome", "summary.json")
  const mobileSummaryPath = join(artifactDirectory, "files", "browser", "mobile-chrome", "summary.json")
  const reviewPath = join(artifactDirectory, "files", "review.json")

  assert.equal(existsSync(desktopSummaryPath), true, "desktop profile summary should exist")
  assert.equal(existsSync(mobileSummaryPath), true, "mobile profile summary should exist")

  const desktop = JSON.parse(await readFile(desktopSummaryPath, "utf8"))
  const mobile = JSON.parse(await readFile(mobileSummaryPath, "utf8"))
  assert.equal(desktop.schema, "wp-codebox/browser-probe/v1")
  assert.equal(mobile.schema, "wp-codebox/browser-probe/v1")
  assert.equal(desktop.context?.requested?.profile, "desktop-chrome")
  assert.equal(desktop.context?.requested?.browser, "chromium")
  assert.equal(desktop.context?.requested?.viewport?.width, 1280)
  assert.equal(desktop.context?.effective?.profile, "desktop-chrome")
  assert.equal(desktop.context?.effective?.browser, "chromium")
  assert.equal(desktop.viewport?.width, 1280)
  assert.equal(desktop.files.html, "files/browser/desktop-chrome/snapshot.html")
  assert.equal(desktop.files.screenshot, "files/browser/desktop-chrome/screenshot.png")

  assert.equal(mobile.context?.requested?.profile, "mobile-chrome")
  assert.equal(mobile.context?.requested?.browser, "chromium")
  assert.equal(mobile.context?.requested?.device, "Pixel 5")
  assert.equal(mobile.context?.effective?.profile, "mobile-chrome")
  assert.equal(mobile.context?.effective?.browser, "chromium")
  assert.equal(mobile.context?.effective?.viewport?.isMobile, true)
  assert.equal(mobile.files.html, "files/browser/mobile-chrome/snapshot.html")
  assert.equal(mobile.files.screenshot, "files/browser/mobile-chrome/screenshot.png")

  const review = JSON.parse(await readFile(reviewPath, "utf8")) as { browser?: { probes?: Array<{ summaryFile?: string; html?: string; screenshot?: string }> } }
  assert.equal(review.browser?.probes?.length, 2, "review should include both profile probes")
  assert.ok(review.browser?.probes?.some((probe) => probe.summaryFile === "files/browser/desktop-chrome/summary.json"), "review should include desktop profile summary")
  assert.ok(review.browser?.probes?.some((probe) => probe.summaryFile === "files/browser/mobile-chrome/summary.json"), "review should include mobile profile summary")

  console.log("Browser probe profile matrix smoke passed")
} finally {
  await rm(workspace, { recursive: true, force: true })
}

async function runRecipe(recipePath: string, artifacts: string): Promise<Record<string, any>> {
  const child = spawn(process.execPath, [
    "packages/cli/dist/index.js",
    "recipe-run",
    "--recipe",
    recipePath,
    "--artifacts",
    artifacts,
    "--timeout",
    "120s",
    "--json",
  ], {
    cwd: root,
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

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
    child.once("close", (code, signal) => resolveExit({ code, signal }))
  })
  assert.equal(exit.signal, null, `recipe-run should not be killed; stdout: ${stdout}; stderr: ${stderr}`)
  assert.equal(exit.code, 0, `recipe-run should exit cleanly; stdout: ${stdout}; stderr: ${stderr}`)

  return JSON.parse(stdout)
}
