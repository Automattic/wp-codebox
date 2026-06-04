import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const cli = resolve(root, "packages/cli/dist/index.js")
const workspace = resolve(root, "artifacts/benchmark-comparison-smoke")
const baselineRecipeRun = resolve(workspace, "baseline-recipe-run.json")
const candidateRecipeRun = resolve(workspace, "candidate-recipe-run.json")
const baselineBundle = resolve(workspace, "baseline-bundle")
const candidateBundle = resolve(workspace, "candidate-bundle")

rmSync(workspace, { recursive: true, force: true })
mkdirSync(resolve(baselineBundle, "logs"), { recursive: true })
mkdirSync(resolve(candidateBundle, "logs"), { recursive: true })

const baselineBenchResults = {
  schema: "wp-codebox/bench-results/v1",
  component_id: "bench-plugin",
  iterations: 4,
  warmup_iterations: 1,
  scenarios: [
    {
      id: "load",
      source: "file",
      iterations: 4,
      metrics: {
        duration: {
          unit: "ms",
          samples: {
            count: 4,
            mean: 100,
            p50: 99,
            p95: 120,
            p99: 130,
            min: 90,
            max: 125,
            standard_deviation: 5,
            relative_standard_deviation: 0.05,
          },
        },
        peak_memory: {
          unit: "bytes",
          samples: { count: 4, mean: 1000, p50: 1000, p95: 1100, p99: 1200, min: 900, max: 1100 },
        },
        baseline_only: {
          unit: "count",
          samples: { count: 4, mean: 1, p50: 1, p95: 1, p99: 1, min: 1, max: 1 },
        },
      },
      diagnostics: [],
    },
    { id: "baseline-only", source: "file", iterations: 4, metrics: { duration: { unit: "ms", samples: { count: 4, mean: 9, p50: 9, p95: 9, p99: 9, min: 9, max: 9 } } }, diagnostics: [] },
  ],
  diagnostics: [],
  provenance: { command: "wordpress.bench", component: { id: "bench-plugin" } },
}

const candidateBenchResults = {
  schema: "wp-codebox/bench-results/v1",
  component_id: "bench-plugin",
  iterations: 6,
  warmup_iterations: 1,
  scenarios: [
    {
      id: "load",
      source: "file",
      iterations: 6,
      metrics: {
        duration: {
          unit: "ms",
          samples: {
            count: 6,
            mean: 125,
            p50: 124,
            p95: 150,
            p99: 160,
            min: 110,
            max: 155,
            standard_deviation: 9,
            relative_standard_deviation: 0.072,
          },
        },
        peak_memory: {
          unit: "bytes",
          samples: { count: 6, mean: 900, p50: 900, p95: 950, p99: 990, min: 850, max: 975 },
        },
        candidate_only: {
          unit: "count",
          samples: { count: 6, mean: 2, p50: 2, p95: 2, p99: 2, min: 2, max: 2 },
        },
      },
      diagnostics: [],
    },
    { id: "candidate-only", source: "file", iterations: 6, metrics: { duration: { unit: "ms", samples: { count: 6, mean: 8, p50: 8, p95: 8, p99: 8, min: 8, max: 8 } } }, diagnostics: [] },
  ],
  diagnostics: [],
  provenance: { command: "wordpress.bench", component: { id: "bench-plugin" } },
}

writeFileSync(baselineRecipeRun, `${JSON.stringify({ schema: "wp-codebox/recipe-run/v1", success: true, benchResults: baselineBenchResults }, null, 2)}\n`)
writeFileSync(candidateRecipeRun, `${JSON.stringify({ schema: "wp-codebox/recipe-run/v1", success: true, benchResults: candidateBenchResults }, null, 2)}\n`)
writeFileSync(resolve(baselineBundle, "logs", "commands.log"), `[2026-06-04T00:00:00.000Z] wordpress.bench\n${JSON.stringify(baselineBenchResults, null, 2)}\n`)
writeFileSync(resolve(candidateBundle, "logs", "commands.log"), `[2026-06-04T00:00:00.000Z] wordpress.bench\n${JSON.stringify(candidateBenchResults, null, 2)}\n`)

const recipeComparison = runJson("bench", "compare", "--baseline-input", baselineRecipeRun, "--candidate-input", candidateRecipeRun, "--json")
assertComparison(recipeComparison, "recipe-run-output")

const bundleComparison = runJson("artifacts", "bench-compare", "--baseline-bundle", baselineBundle, "--candidate-bundle", candidateBundle, "--json")
assertComparison(bundleComparison, "artifact-bundle")

const human = spawnSync(process.execPath, [cli, "bench", "compare", "--baseline-input", baselineRecipeRun, "--candidate-input", candidateRecipeRun], { cwd: root, encoding: "utf8" })
assert.equal(human.status, 0, human.stderr || human.stdout)
assert.match(human.stdout, /WP Codebox benchmark comparison/)
assert.match(human.stdout, /duration: 100 -> 125/)

console.log("benchmark comparison smoke passed")

function assertComparison(output: any, sourceType: string): void {
  assert.equal(output.schema, "wp-codebox/benchmark-comparison/v1")
  assert.equal(output.source.baseline.type, sourceType)
  assert.equal(output.source.candidate.type, sourceType)
  assert.equal(output.provenance.baselineComponentId, "bench-plugin")
  assert.equal(output.provenance.candidateComponentId, "bench-plugin")
  assert.equal(output.provenance.baselineIterations, 4)
  assert.equal(output.provenance.candidateIterations, 6)

  const load = output.pairs.find((pair: any) => pair.scenarioId === "load")
  assert.ok(load)
  assert.equal(load.baselineIterations, 4)
  assert.equal(load.candidateIterations, 6)

  const duration = load.metrics.find((metric: any) => metric.metricId === "duration")
  assert.deepEqual(duration, {
    scenarioId: "load",
    metricId: "duration",
    unit: "ms",
    statistic: "mean",
    baseline: 100,
    candidate: 125,
    absoluteDelta: 25,
    percentDelta: 25,
    baselineSamples: { count: 4, standardDeviation: 5, relativeStandardDeviation: 0.05, min: 90, max: 125, p50: 99, p95: 120, p99: 130 },
    candidateSamples: { count: 6, standardDeviation: 9, relativeStandardDeviation: 0.072, min: 110, max: 155, p50: 124, p95: 150, p99: 160 },
  })

  const memory = load.metrics.find((metric: any) => metric.metricId === "peak_memory")
  assert.equal(memory.absoluteDelta, -100)
  assert.equal(memory.percentDelta, -10)
  assert.equal(output.diagnostics.some((diagnostic: any) => diagnostic.type === "missing-candidate-metric" && diagnostic.scenarioId === "load" && diagnostic.metricId === "baseline_only"), true)
  assert.equal(output.diagnostics.some((diagnostic: any) => diagnostic.type === "missing-baseline-metric" && diagnostic.scenarioId === "load" && diagnostic.metricId === "candidate_only"), true)
  assert.equal(output.diagnostics.some((diagnostic: any) => diagnostic.type === "missing-candidate-scenario" && diagnostic.scenarioId === "baseline-only"), true)
  assert.equal(output.diagnostics.some((diagnostic: any) => diagnostic.type === "missing-baseline-scenario" && diagnostic.scenarioId === "candidate-only"), true)
}

function runJson(...args: string[]): any {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return JSON.parse(result.stdout)
}
