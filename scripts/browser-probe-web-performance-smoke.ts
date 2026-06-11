import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

const repoRoot = resolve(import.meta.dirname, "..")
const workspace = resolve(repoRoot, "artifacts", "browser-probe-web-performance-smoke")
const pluginDir = join(workspace, "browser-web-performance-fixture")

await rm(workspace, { recursive: true, force: true })
await mkdir(pluginDir, { recursive: true })

await writeFile(join(pluginDir, "browser-web-performance-fixture.php"), `<?php
/**
 * Plugin Name: Browser Web Performance Fixture
 */
add_action('wp_footer', function () {
    echo '<main id="web-performance-fixture" style="font-size:48px;line-height:1.2;margin:40px">Synthetic Performance Fixture</main>';
});
`)

const passingRecipePath = await writeRecipe("passing", [
  "url=/",
  "wait-for=load",
  "duration=750ms",
  "profile=low-end-mobile-slow-4g",
  "capture=performance,memory,html",
  "assert=lcp_ms<=10000",
  "assert=fcp_ms<=10000",
  "assert=ttfb_ms>=0",
  "assert=nav_duration_ms>=0",
])

const output = await runCli([
  "packages/cli/dist/index.js",
  "recipe-run",
  "--recipe",
  passingRecipePath,
  "--json",
])

assert.equal(output.success, true, output.error?.message ?? "recipe-run failed")
assert.ok(output.artifacts?.directory, "recipe-run should return an artifact directory")

const artifactDirectory = output.artifacts.directory
const performancePath = join(artifactDirectory, "files", "browser", "performance.json")
const summaryPath = join(artifactDirectory, "files", "browser", "summary.json")

assert.equal(existsSync(performancePath), true, "performance.json should be captured")
assert.equal(existsSync(summaryPath), true, "summary.json should be captured")

const performance = JSON.parse(await readFile(performancePath, "utf8")) as {
  final: {
    navigation: { durationMs: number | null; ttfbMs: number | null; responseStartMs: number | null }
    paint: { firstContentfulPaintMs: number | null; largestContentfulPaintMs: number | null; largestContentfulPaintElement: string | null }
  }
  phaseMetrics?: { phases: Array<{ name: string; elapsedMs: number | null; performance: { resources: number } }> }
}
const summary = JSON.parse(await readFile(summaryPath, "utf8")) as {
  context?: { requested?: { profile?: string; throttle?: string }; effective?: { profile?: string; throttle?: string } }
  summary?: { metrics?: Record<string, number>; assertions?: { total: number; failed: number } }
}

assert.equal(summary.context?.requested?.profile, "low-end-mobile-slow-4g", "summary should record requested synthetic profile")
assert.equal(summary.context?.requested?.throttle, "low-end-mobile-slow-4g", "summary should record requested throttle profile")
assert.equal(summary.context?.effective?.throttle, "low-end-mobile-slow-4g", "summary should record effective throttle profile")
assert.equal(summary.summary?.assertions?.total, 4, "summary should include web performance budget assertions")
assert.equal(summary.summary?.assertions?.failed, 0, "web performance budget assertions should pass")

assert.equal(typeof performance.final.navigation.durationMs, "number", "performance artifact should include navigation duration")
assert.equal(typeof performance.final.navigation.ttfbMs, "number", "performance artifact should include TTFB")
assert.equal(typeof performance.final.navigation.responseStartMs, "number", "performance artifact should include responseStart")
assert.equal(typeof performance.final.paint.firstContentfulPaintMs, "number", "performance artifact should include FCP")
assert.equal(typeof performance.final.paint.largestContentfulPaintMs, "number", "performance artifact should include LCP")
assert.ok((performance.final.paint.largestContentfulPaintElement ?? "").length > 0, "LCP should include an element selector")
assert.equal(typeof summary.summary?.metrics?.browser_lcp_ms, "number", "summary metrics should expose browser_lcp_ms")
assert.equal(typeof summary.summary?.metrics?.browser_fcp_ms, "number", "summary metrics should expose browser_fcp_ms")
assert.equal(typeof summary.summary?.metrics?.browser_ttfb_ms, "number", "summary metrics should expose browser_ttfb_ms")
assert.equal(typeof summary.summary?.metrics?.browser_nav_duration_ms, "number", "summary metrics should expose browser_nav_duration_ms")
assert.ok(performance.phaseMetrics?.phases.some((phase) => phase.name === "before-navigation-complete"), "performance artifact should include phase metrics")
assert.equal(typeof summary.summary?.metrics?.browser_phase_before_navigation_complete_elapsed_ms, "number", "summary metrics should expose phase elapsed time")
assert.equal(typeof summary.summary?.metrics?.browser_phase_before_final_resource_count, "number", "summary metrics should expose final phase resource count")

const failingRecipePath = await writeRecipe("failing", [
  "url=/",
  "wait-for=load",
  "duration=250ms",
  "profile=desktop-chrome",
  "capture=performance,memory,html",
  "assert=lcp_ms<0",
])

const failingOutput = await runCli([
  "packages/cli/dist/index.js",
  "recipe-run",
  "--recipe",
  failingRecipePath,
  "--json",
], { allowFailure: true })

assert.equal(failingOutput.success, false, "impossible web performance budget should fail")
assert.notEqual(failingOutput.__exitCode, 0, "failing web performance budget should set non-zero exit")
const failingArtifactDirectory = failingOutput.artifacts?.directory ?? failingOutput.run?.artifactRefs?.find((ref: { kind?: string }) => ref.kind === "artifact-bundle")?.directory
assert.equal(typeof failingArtifactDirectory, "string", "failing run should still return artifacts")
const failingSummary = JSON.parse(await readFile(join(failingArtifactDirectory, "files", "browser", "summary.json"), "utf8"))
const failingBudget = failingSummary.assertions.results.find((result: { assertion?: string }) => result.assertion === "lcp_ms<0")
assert.equal(failingSummary.context?.requested?.profile, "desktop-chrome", "failing summary should record requested profile")
assert.equal(failingBudget.status, "fail")
assert.equal(failingBudget.expectedBudget, 0)
assert.equal(typeof failingBudget.observed, "number")
assert.deepEqual(failingBudget.supportingArtifacts, ["files/browser/performance.json", "files/browser/memory.json"])

console.log(`Browser probe web performance smoke passed: ${artifactDirectory}`)

async function writeRecipe(name: string, args: string[]): Promise<string> {
  const recipePath = join(workspace, `${name}.recipe.json`)
  await writeFile(recipePath, `${JSON.stringify({
    schema: "wp-codebox/workspace-recipe/v1",
    inputs: {
      extra_plugins: [
        {
          source: "./browser-web-performance-fixture",
          pluginFile: "browser-web-performance-fixture/browser-web-performance-fixture.php",
          activate: true,
        },
      ],
    },
    workflow: {
      steps: [
        {
          command: "wordpress.browser-probe",
          args,
        },
      ],
    },
    artifacts: {
      directory: join(workspace, `${name}-artifacts`),
    },
  }, null, 2)}\n`)
  return recipePath
}

async function runCli(args: string[], options: { allowFailure?: boolean } = {}): Promise<any> {
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
  assert.ok(stdout.trim().length > 0, `CLI should emit JSON. STDERR:\n${stderr}`)
  const output = JSON.parse(stdout)
  if (!options.allowFailure) {
    assert.equal(exitCode, 0, `CLI exited with ${exitCode}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`)
  }
  return { ...output, __exitCode: exitCode }
}
