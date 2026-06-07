import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const workspace = await mkdtemp(join(tmpdir(), "wp-codebox-browser-probe-context-"))

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
          "capture=html",
          "device=iPhone 13",
          "locale=fr-FR",
          "auth=wordpress-admin",
          "script=return document.body.classList.contains('logged-in')",
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

  const summary = JSON.parse(await readFile(join(output.artifacts.directory, "files", "browser", "summary.json"), "utf8"))
  assert.equal(summary.schema, "wp-codebox/browser-probe/v1")
  assert.equal(summary.context?.requested?.device, "iPhone 13")
  assert.equal(summary.context?.requested?.locale, "fr-FR")
  assert.equal(summary.context?.effective?.device, "iPhone 13")
  assert.equal(summary.context?.effective?.locale, "fr-FR")
  assert.equal(summary.context?.effective?.viewport?.hasTouch, true)
  assert.equal(summary.context?.effective?.viewport?.isMobile, true)
  assert.equal(summary.context?.effective?.viewport?.width, summary.viewport.width)
  assert.equal(summary.context?.effective?.viewport?.height, summary.viewport.height)
  assert.equal(summary.auth?.mode, "wordpress-admin")
  assert.equal(summary.auth?.userId, 1)
  assert.ok(summary.auth?.cookieCount >= 2, "authenticated probe should install WordPress auth cookies")
  assert.equal(summary.summary?.scriptResult, true, "authenticated probe should see logged-in browser state")
  assert.doesNotMatch(JSON.stringify(summary), /wordpress_logged_in|wordpress_sec|wordpress_test_cookie/i, "summary should not expose auth cookie names or values")
  assert.equal(summary.files?.review, "files/browser/review.json")
  assert.equal(summary.summary?.review?.timings?.ttfbMs?.status, "missing", "review should explicitly mark missing TTFB without performance capture")
  assert.equal(summary.summary?.review?.timings?.ttfbMs?.reason, "capture=performance was not requested")
  assert.equal(summary.summary?.review?.network?.status, "not-captured", "review should explicitly mark missing network capture")

  const browserReview = JSON.parse(await readFile(join(output.artifacts.directory, "files", "browser", "review.json"), "utf8"))
  assert.equal(browserReview.timings.ttfbMs.status, "missing")
  assert.equal(browserReview.timings.ttfbMs.reason, "capture=performance was not requested")

  console.log("Browser probe context smoke passed")
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
    "90s",
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
