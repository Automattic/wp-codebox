import assert from "node:assert/strict"
import { compareBenchmarkResults, createBenchmarkMatrixCellFailure, createBenchmarkMatrixCellResult, expandBenchmarkMatrix } from "@automattic/wp-codebox-core"

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

console.log("benchmark substrate smoke passed")
