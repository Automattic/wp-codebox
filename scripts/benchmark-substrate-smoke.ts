import assert from "node:assert/strict"
import { compareBenchmarkResults, createBenchmarkMatrixCellFailure, createBenchmarkMatrixCellResult, executeBenchmarkMatrix, expandBenchmarkMatrix } from "@automattic/wp-codebox-core/internals"

const matrix = expandBenchmarkMatrix([
  {
    id: "wp",
    values: [
      { id: "6.9", value: "6.9" },
      { id: "7.0", value: "7.0" },
    ],
  },
  {
    id: "viewport",
    values: [
      { id: "desktop", provenance: { width: 1280, height: 720 } },
      { id: "mobile", provenance: { width: 390, height: 844 } },
    ],
  },
])

assert.equal(matrix.schema, "wp-codebox/benchmark-matrix/v1")
assert.equal(matrix.diagnostics.length, 0)
assert.equal(matrix.cells.length, 4)
assert.equal(matrix.cells[0]?.id, "wp:6.9__viewport:desktop")
assert.deepEqual(matrix.cells[0]?.provenance, { wp: "6.9", viewport: { width: 1280, height: 720 } })

const emptyDimension = expandBenchmarkMatrix([{ id: "environment", values: [] }])
assert.equal(emptyDimension.cells.length, 0)
assert.equal(emptyDimension.diagnostics[0]?.type, "empty-dimension")

const cell = matrix.cells[0]
assert.ok(cell)
const success = createBenchmarkMatrixCellResult(cell, { component_id: "demo", scenarios: [] })
assert.equal(success.status, "succeeded")
assert.equal(success.diagnostics.length, 0)

const failure = createBenchmarkMatrixCellFailure(cell, Object.assign(new Error("runtime boot failed"), { code: "boot-failed" }))
assert.equal(failure.status, "failed")
assert.equal(failure.diagnostics[0]?.type, "cell-failed")
assert.equal(failure.diagnostics[0]?.code, "boot-failed")

const matrixRun = await executeBenchmarkMatrix([
  {
    id: "wp",
    values: [
      { id: "6.9", value: { recipe: { runtime: { wp: "6.9" } } } },
      { id: "7.0", value: { recipe: { runtime: { wp: "7.0" } } } },
    ],
  },
  {
    id: "cache",
    values: [
      { id: "cold", value: { recipe: { workflow: { steps: [{ command: "wordpress.bench", args: ["cache=cold"] }] } } } },
      { id: "warm", value: { recipe: { workflow: { steps: [{ command: "wordpress.bench", args: ["cache=warm"] }] } } } },
    ],
  },
], async (matrixCell) => {
  if (matrixCell.id === "wp:7.0__cache:warm") {
    throw Object.assign(new Error("simulated cell failure"), { code: "simulated-failure" })
  }

  return {
    component_id: "demo",
    iterations: 1,
    scenarios: [{ id: matrixCell.id, iterations: 1, metrics: { duration_ms_mean: 1 } }],
  }
}, { generatedAt: "2026-06-04T00:00:00.000Z" })

assert.equal(matrixRun.schema, "wp-codebox/benchmark-matrix-run/v1")
assert.equal(matrixRun.matrix.cells.length, 4)
assert.equal(matrixRun.cells.length, 4)
assert.equal(matrixRun.benchResults.length, 3)
assert.equal(matrixRun.diagnostics.length, 1)
assert.equal(matrixRun.diagnostics[0]?.cellId, "wp:7.0__cache:warm")
assert.equal(matrixRun.diagnostics[0]?.code, "simulated-failure")
assert.equal(matrixRun.cells.find((matrixCell) => matrixCell.cell.id === "wp:7.0__cache:warm")?.status, "failed")

const comparison = compareBenchmarkResults(
  {
    component_id: "demo",
    iterations: 3,
    scenarios: [
      { id: "load", iterations: 3, metrics: { mean_ms: 100, p95_ms: 140, only_baseline: 1, ignored: "text" } },
      { id: "baseline-only", metrics: { mean_ms: 10 } },
    ],
  },
  {
    component_id: "demo",
    iterations: 5,
    scenarios: [
      { id: "load", iterations: 5, metrics: { mean_ms: 125, p95_ms: 133, only_candidate: 2 } },
      { id: "candidate-only", metrics: { mean_ms: 9 } },
    ],
  },
  { baseline: { runId: "run_baseline" }, candidate: { runId: "run_candidate" } },
)

assert.equal(comparison.schema, "wp-codebox/benchmark-comparison/v1")
assert.equal(comparison.baseline?.runId, "run_baseline")
assert.equal(comparison.candidate?.runId, "run_candidate")
assert.deepEqual(comparison.provenance, {
  baselineComponentId: "demo",
  baselineIterations: 3,
  candidateComponentId: "demo",
  candidateIterations: 5,
})

const loadPair = comparison.pairs.find((pair) => pair.scenarioId === "load")
assert.ok(loadPair)
assert.equal(loadPair.baselineIterations, 3)
assert.equal(loadPair.candidateIterations, 5)
const meanDelta = loadPair.metrics.find((metric) => metric.metricId === "mean_ms")
assert.deepEqual(meanDelta, {
  scenarioId: "load",
  metricId: "mean_ms",
  baseline: 100,
  candidate: 125,
  absoluteDelta: 25,
  percentDelta: 25,
})
const p95Delta = loadPair.metrics.find((metric) => metric.metricId === "p95_ms")
assert.equal(p95Delta?.absoluteDelta, -7)
assert.equal(comparison.diagnostics.some((diagnostic) => diagnostic.type === "missing-candidate-metric" && diagnostic.scenarioId === "load" && diagnostic.metricId === "only_baseline"), true)
assert.equal(comparison.diagnostics.some((diagnostic) => diagnostic.type === "missing-baseline-metric" && diagnostic.scenarioId === "load" && diagnostic.metricId === "only_candidate"), true)
assert.equal(comparison.diagnostics.some((diagnostic) => diagnostic.type === "missing-candidate-scenario" && diagnostic.scenarioId === "baseline-only"), true)
assert.equal(comparison.diagnostics.some((diagnostic) => diagnostic.type === "missing-baseline-scenario" && diagnostic.scenarioId === "candidate-only"), true)

const sampleComparison = compareBenchmarkResults(
  {
    component_id: "demo",
    scenarios: [{ id: "load", metrics: { duration: { unit: "ms", samples: { count: 2, mean: 10, p50: 10, p95: 11, p99: 11, min: 9, max: 11, standard_deviation: 1, relative_standard_deviation: 0.1 } } } }],
  },
  {
    component_id: "demo",
    scenarios: [{ id: "load", metrics: { duration: { unit: "ms", samples: { count: 4, mean: 12, p50: 12, p95: 13, p99: 13, min: 11, max: 13, standard_deviation: 2, relative_standard_deviation: 0.16 } } } }],
  },
)
const sampleDelta = sampleComparison.pairs[0]?.metrics[0]
assert.deepEqual(sampleDelta, {
  scenarioId: "load",
  metricId: "duration",
  unit: "ms",
  statistic: "mean",
  baseline: 10,
  candidate: 12,
  absoluteDelta: 2,
  percentDelta: 20,
  baselineSamples: { count: 2, standardDeviation: 1, relativeStandardDeviation: 0.1, min: 9, max: 11, p50: 10, p95: 11, p99: 11 },
  candidateSamples: { count: 4, standardDeviation: 2, relativeStandardDeviation: 0.16, min: 11, max: 13, p50: 12, p95: 13, p99: 13 },
})

console.log("benchmark substrate smoke passed")
