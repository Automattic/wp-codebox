import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

const repoRoot = resolve(import.meta.dirname, "..")
const workspace = resolve(repoRoot, "artifacts", "browser-probe-layout-shift-smoke")

await rm(workspace, { recursive: true, force: true })
await mkdir(workspace, { recursive: true })

const shifting = await runProbe("shifting", shiftingPage(), [
  "assert=metric:browser_cls>0",
  "assert=metric:browser_layout_shift_count>=1",
])
const shiftingSummary = await readSummary(shifting)
const shiftingPerformance = await readPerformance(shifting)
assert.ok(shiftingSummary.summary.metrics.browser_cls > 0, "shifting page should report non-zero CLS")
assert.ok(shiftingSummary.summary.metrics.browser_layout_shift_count >= 1, "shifting page should report layout-shift count")
assert.ok(shiftingSummary.summary.metrics.browser_layout_shift_max > 0, "shifting page should report max layout shift")
assert.ok(shiftingPerformance.final.layoutShifts.entries.length >= 1, "performance artifact should include layout-shift entries")
assert.equal(shiftingPerformance.final.layoutShifts.entries[0]?.hadRecentInput, false, "synthetic layout shift should not be user-input excluded")
assert.ok(shiftingPerformance.final.layoutShifts.entries[0]?.sources.length >= 1, "layout-shift entries should include source details")

const reserved = await runProbe("reserved", reservedPage(), [
  "assert=metric:browser_cls<=0.001",
  "assert=metric:browser_layout_shift_count=0",
])
const reservedSummary = await readSummary(reserved)
assert.ok(reservedSummary.summary.metrics.browser_cls <= 0.001, "reserved page should report near-zero CLS")
assert.equal(reservedSummary.summary.metrics.browser_layout_shift_count, 0, "reserved page should not report layout shifts")

assert.equal(shiftingSummary.summary.scriptResult.text, reservedSummary.summary.scriptResult.text, "both pages should finish with the same visible inserted content")
assert.equal(commandOutput(shifting).summary.metrics.browser_cls, shiftingSummary.summary.metrics.browser_cls, "command JSON should expose CLS metric")

console.log("Browser probe layout-shift smoke passed")

function shiftingPage(): string {
  return pageShell(`
    <main id="content" class="content">
      <h1>Layout Shift Fixture</h1>
      <p>This content moves when the banner is inserted above it.</p>
    </main>
    <script>
      setTimeout(() => {
        const banner = document.createElement('section');
        banner.id = 'inserted-banner';
        banner.className = 'banner';
        banner.textContent = 'Synthetic ECE button ready';
        document.body.insertBefore(banner, document.body.firstChild);
      }, 50);
    </script>
  `)
}

function reservedPage(): string {
  return pageShell(`
    <section id="reserved-space" class="banner" aria-live="polite"></section>
    <main id="content" class="content">
      <h1>Layout Shift Fixture</h1>
      <p>This content keeps its position while the banner fills reserved space.</p>
    </main>
    <script>
      setTimeout(() => {
        const banner = document.getElementById('reserved-space');
        banner.id = 'inserted-banner';
        banner.textContent = 'Synthetic ECE button ready';
      }, 50);
    </script>
  `)
}

function pageShell(body: string): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>WP Codebox Layout Shift Fixture</title>
    <style>
      body { margin: 0; font-family: system-ui, sans-serif; }
      .banner { box-sizing: border-box; display: flex; align-items: center; min-height: 160px; padding: 24px; background: #f6d365; font-size: 24px; font-weight: 700; }
      .content { min-height: 900px; padding: 24px; background: #ffffff; font-size: 20px; }
    </style>
  </head>
  <body>${body}</body>
</html>`
}

async function runProbe(name: string, html: string, assertions: string[]): Promise<any> {
  const recipePath = join(workspace, `${name}.recipe.json`)
  const artifactsRoot = join(workspace, `${name}-artifacts`)
  await writeFile(recipePath, `${JSON.stringify({
    schema: "wp-codebox/workspace-recipe/v1",
    workflow: {
      steps: [
        {
          command: "wordpress.browser-probe",
          args: [
            `url=${dataUrl(html)}`,
            "wait-for=duration",
            "duration=500ms",
            "viewport=1280x720",
            "capture=html,performance",
            "script=return { text: document.getElementById('inserted-banner')?.textContent ?? null };",
            ...assertions,
          ],
        },
      ],
    },
    artifacts: {
      directory: artifactsRoot,
    },
  }, null, 2)}\n`)

  return runCli([
    "packages/cli/dist/index.js",
    "recipe-run",
    "--recipe",
    recipePath,
    "--json",
  ])
}

function dataUrl(html: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

async function readSummary(output: any): Promise<any> {
  const artifactDirectory = artifactDirectoryFromOutput(output)
  const summaryPath = join(artifactDirectory, "files", "browser", "summary.json")
  assert.equal(existsSync(summaryPath), true, "summary.json should be captured")
  return JSON.parse(await readFile(summaryPath, "utf8"))
}

async function readPerformance(output: any): Promise<any> {
  const artifactDirectory = artifactDirectoryFromOutput(output)
  const performancePath = join(artifactDirectory, "files", "browser", "performance.json")
  assert.equal(existsSync(performancePath), true, "performance.json should be captured")
  return JSON.parse(await readFile(performancePath, "utf8"))
}

function artifactDirectoryFromOutput(output: any): string {
  const artifactDirectory = output.artifacts?.directory ?? output.run?.artifactRefs?.find((ref: { kind?: string }) => ref.kind === "artifact-bundle")?.directory
  assert.equal(typeof artifactDirectory, "string", "recipe-run should return artifact bundle directory")
  return artifactDirectory
}

function commandOutput(output: any): any {
  const execution = output.executions?.find((item: { command?: string }) => item.command === "wordpress.browser-probe")
  assert.equal(typeof execution?.stdout, "string", "recipe-run should include browser-probe command stdout")
  return JSON.parse(execution.stdout)
}

async function runCli(args: string[]): Promise<any> {
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
  assert.equal(exitCode, 0, `CLI exited with ${exitCode}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`)
  return JSON.parse(stdout)
}
