import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const cli = resolve(root, "packages/cli/dist/index.js")
const workspace = resolve(root, "artifacts/benchmark-summary-smoke")
const recipeRunOutput = resolve(workspace, "recipe-run.json")
const bundle = resolve(workspace, "bundle")

rmSync(workspace, { recursive: true, force: true })
mkdirSync(resolve(bundle, "logs"), { recursive: true })

const benchResults = {
  component_id: "bench-plugin",
  iterations: 2,
  warmup_iterations: 0,
  scenarios: [
    {
      id: "noop",
      source: "file",
      iterations: 2,
      metrics: {
        duration_ms_mean: 3.5,
        peak_memory_bytes_mean: 1234,
        ignored_string: "not numeric",
      },
      artifacts: { report: { path: "workloads/report.json", kind: "json" } },
    },
  ],
}

writeFileSync(recipeRunOutput, `${JSON.stringify({
  schema: "wp-codebox/recipe-run/v1",
  success: true,
  benchResults,
}, null, 2)}\n`)

writeFileSync(resolve(bundle, "logs", "commands.log"), `[2026-06-04T00:00:00.000Z] wordpress.bench component-id=bench-plugin
exitCode=0
${JSON.stringify(benchResults, null, 2)}
`)

const inputSummary = runJson("bench", "summarize", "--input", recipeRunOutput, "--json")
assert.equal(inputSummary.schema, "wp-codebox/benchmark-summary/v1")
assert.equal(inputSummary.source.type, "recipe-run-output")
assert.equal(inputSummary.hasBenchResults, true)
assert.equal(inputSummary.benchmarkCount, 1)
assert.equal(inputSummary.scenarioCount, 1)
assert.equal(inputSummary.scenarios[0].componentId, "bench-plugin")
assert.equal(inputSummary.scenarios[0].id, "noop")
assert.equal(inputSummary.scenarios[0].metricCount, 2)
assert.equal(inputSummary.scenarios[0].metrics.duration_ms_mean, 3.5)
assert.equal(inputSummary.scenarios[0].artifacts.report.path, "workloads/report.json")

const bundleSummary = runJson("artifacts", "bench-results", "--bundle", bundle, "--json")
assert.equal(bundleSummary.schema, "wp-codebox/benchmark-summary/v1")
assert.equal(bundleSummary.source.type, "artifact-bundle")
assert.equal(bundleSummary.hasBenchResults, true)
assert.equal(bundleSummary.scenarioCount, 1)

const human = spawnSync(process.execPath, [cli, "bench", "summarize", "--input", recipeRunOutput], { cwd: root, encoding: "utf8" })
assert.equal(human.status, 0, human.stderr || human.stdout)
assert.match(human.stdout, /WP Codebox benchmark summary/)
assert.match(human.stdout, /bench-plugin\/noop: 2 metrics/)

console.log("benchmark summary smoke passed")

function runJson(...args: string[]): any {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return JSON.parse(result.stdout)
}
