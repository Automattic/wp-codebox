import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

const repoRoot = resolve(import.meta.dirname, "..")
const workspace = resolve(repoRoot, "artifacts", "recipe-browser-bench-metrics-smoke")
const recipePath = join(workspace, "recipe.json")
const artifactsRoot = join(workspace, "artifacts")
const emptyArtifactsRoot = join(workspace, "empty-artifacts")

await rm(workspace, { recursive: true, force: true })
await mkdir(workspace, { recursive: true })
await mkdir(emptyArtifactsRoot, { recursive: true })

await writeFile(recipePath, `${JSON.stringify({
  schema: "wp-codebox/workspace-recipe/v1",
  inputs: {
    extraPlugins: [
      {
        source: resolve(repoRoot, "examples", "bench-plugin"),
        slug: "bench-plugin",
      },
      {
        source: resolve(repoRoot, "examples", "bench-dependency"),
        slug: "bench-dependency",
        pluginFile: "bench-dependency/dependency-main.php",
      },
    ],
  },
  workflow: {
    steps: [
      {
        command: "wordpress.browser-probe",
        args: [
          "url=/",
          "wait-for=load",
          "capture=performance,memory",
          "script=document.body.appendChild(document.createElement('iframe'));",
        ],
      },
      {
        command: "wordpress.bench",
        args: [
          "component-id=bench-plugin",
          "plugin-slug=bench-plugin",
          "dependency-slugs=bench-dependency",
          "iterations=1",
          "warmup=0",
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
assert.ok(output.benchResults, "recipe-run should expose benchResults")
assert.equal(output.benchResults.scenarios.length, 1)

const metrics = output.benchResults.scenarios[0].metrics
const artifactRefs = output.benchResults.scenarios[0].artifactRefs
assert.equal(output.benchResults.schema, "wp-codebox/bench-results/v1")
const expectedBrowserMetrics = {
  browser_peak_used_js_heap_bytes: metrics.browser_peak_used_js_heap_bytes.samples.mean,
  browser_final_used_js_heap_bytes: metrics.browser_final_used_js_heap_bytes.samples.mean,
  browser_checkpoint_count: metrics.browser_checkpoint_count.samples.mean,
  browser_dom_node_count: metrics.browser_dom_node_count.samples.mean,
  browser_iframe_count: metrics.browser_iframe_count.samples.mean,
  browser_resource_count: metrics.browser_resource_count.samples.mean,
  browser_transfer_size_bytes: metrics.browser_transfer_size_bytes.samples.mean,
  browser_long_task_count: metrics.browser_long_task_count.samples.mean,
  browser_long_task_total_ms: metrics.browser_long_task_total_ms.samples.mean,
  browser_cls: metrics.browser_cls.samples.mean,
  browser_layout_shift_count: metrics.browser_layout_shift_count.samples.mean,
  browser_layout_shift_max: metrics.browser_layout_shift_max.samples.mean,
}
assert.equal(metrics.browser_peak_used_js_heap_bytes.unit, "bytes")
assert.equal(metrics.browser_long_task_total_ms.unit, "ms")
assert.equal(metrics.browser_checkpoint_count.unit, "count")
assert.equal(metrics.browser_cls.unit, "unitless")
assert.equal(metrics.browser_layout_shift_count.unit, "count")
assert.equal(metrics.browser_layout_shift_max.unit, "unitless")
assert.ok(metrics.browser_checkpoint_count.samples.mean >= 3, "browser_checkpoint_count should include probe checkpoints")
assert.ok(metrics.browser_dom_node_count.samples.mean > 0, "browser_dom_node_count should be numeric")
assert.equal(metrics.browser_iframe_count.samples.mean, 1)
assert.ok(metrics.browser_resource_count.samples.mean >= 0, "browser_resource_count should be numeric")
assert.ok(metrics.browser_transfer_size_bytes.samples.mean >= 0, "browser_transfer_size_bytes should be numeric")
assert.ok(metrics.browser_long_task_count.samples.mean >= 0, "browser_long_task_count should be numeric")
assert.ok(metrics.browser_long_task_total_ms.samples.mean >= 0, "browser_long_task_total_ms should be numeric")
assert.ok(metrics.browser_cls.samples.mean >= 0, "browser_cls should be numeric")
assert.ok(metrics.browser_layout_shift_count.samples.mean >= 0, "browser_layout_shift_count should be numeric")
assert.ok(metrics.browser_layout_shift_max.samples.mean >= 0, "browser_layout_shift_max should be numeric")
assert.ok(metrics.browser_peak_used_js_heap_bytes.samples.mean >= 0, "browser_peak_used_js_heap_bytes should be numeric")
assert.ok(metrics.browser_final_used_js_heap_bytes.samples.mean >= 0, "browser_final_used_js_heap_bytes should be numeric")
assert.ok(artifactRefs.some((ref: { path: string; source: string }) => ref.path === "files/browser/performance.json" && ref.source === "browser-artifact"), "browser performance artifact should be scenario-linked")
assert.ok(artifactRefs.some((ref: { path: string; source: string; metric?: string }) => ref.path === "files/bench-results.json" && ref.source === "metric-source" && ref.metric === "browser_checkpoint_count"), "browser metric should reference benchmark evidence")

const artifactDirectory = output.artifacts.directory
const performancePath = join(artifactDirectory, "files", "browser", "performance.json")
const checkpointsPath = join(artifactDirectory, "files", "browser", "checkpoints.jsonl")
assert.equal(existsSync(performancePath), true, "performance.json should remain available")
assert.equal(existsSync(checkpointsPath), true, "checkpoints.jsonl should remain available")

const performance = JSON.parse(await readFile(performancePath, "utf8"))
assert.equal(performance.schema, "wp-codebox/browser-performance/v1")
assert.ok(performance.checkpoints.length >= 3, "performance artifact should include probe checkpoints")
assert.match(await readFile(checkpointsPath, "utf8"), /"name":"after-navigation"/)

const browserMetrics = await runCli([
  "packages/cli/dist/index.js",
  "artifacts",
  "browser-metrics",
  "--bundle",
  artifactDirectory,
  "--json",
])

assert.equal(browserMetrics.schema, "wp-codebox/browser-metrics/v1")
assert.equal(browserMetrics.hasBrowserMetrics, true)
assert.deepEqual(browserMetrics.metrics, expectedBrowserMetrics)
assert.equal(browserMetrics.artifacts.summary.path, "files/browser/summary.json")
assert.equal(browserMetrics.artifacts.memory.path, "files/browser/memory.json")
assert.equal(browserMetrics.artifacts.performance.path, "files/browser/performance.json")
assert.equal(browserMetrics.artifacts.checkpoints.path, "files/browser/checkpoints.jsonl")

const benchmarkArtifacts = await runCli([
  "packages/cli/dist/index.js",
  "artifacts",
  "benchmark",
  "--bundle",
  artifactDirectory,
  "--scenario-id",
  "noop",
  "--json",
])

assert.equal(benchmarkArtifacts.schema, "wp-codebox/benchmark-artifacts/v1")
assert.equal(benchmarkArtifacts.scenarioId, "noop")
assert.equal(benchmarkArtifacts.scenarios.length, 1)
assert.ok(benchmarkArtifacts.artifactRefs.some((ref: { path: string; source: string }) => ref.path === "files/browser/performance.json" && ref.source === "browser-artifact"))

const emptyBrowserMetrics = await runCli([
  "packages/cli/dist/index.js",
  "artifacts",
  "browser-metrics",
  "--bundle",
  emptyArtifactsRoot,
  "--json",
])

assert.equal(emptyBrowserMetrics.schema, "wp-codebox/browser-metrics/v1")
assert.equal(emptyBrowserMetrics.hasBrowserMetrics, false)
assert.deepEqual(emptyBrowserMetrics.metrics, {})
assert.deepEqual(emptyBrowserMetrics.artifacts, {})

console.log(`Recipe browser bench metrics smoke passed: ${artifactDirectory}`)

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
