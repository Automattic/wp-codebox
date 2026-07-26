import assert from "node:assert/strict"
import test from "node:test"

import {
  browserEnvironmentMatrix,
  browserEnvironmentMatrixFailed,
  expandBrowserEnvironmentMatrix,
  runBrowserEnvironmentMatrix,
  type BrowserEnvironmentMatrix,
  type ResolvedBrowserEnvironment,
} from "../packages/runtime-core/src/browser-environment-matrix.js"

const limits = { maxCells: 16, maxDurationMs: 16_000, maxCellDurationMs: 1_000, maxArtifactBytes: 1024 }

function fixtureMatrix(dimensions: BrowserEnvironmentMatrix["dimensions"]): BrowserEnvironmentMatrix {
  return browserEnvironmentMatrix({ id: "environment-fixture", seed: "fixture-seed", dimensions, limits })
}

const dimensions: BrowserEnvironmentMatrix["dimensions"] = [
  {
    id: "viewport",
    values: [
      { id: "wide", environment: { viewport: { width: 1280, height: 720 } }, requiredCapabilities: ["browser.environment.viewport"] },
      { id: "narrow", environment: { viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true }, requiredCapabilities: ["browser.environment.viewport"] },
    ],
  },
  {
    id: "media",
    values: [
      { id: "reduced", environment: { reducedMotion: "reduce" }, optionalCapabilities: ["browser.environment.reduced-motion"] },
      { id: "dark", environment: { colorScheme: "dark" }, optionalCapabilities: ["browser.environment.color-scheme"] },
    ],
  },
]

test("environment matrices expand canonically independent of declaration order", () => {
  const first = expandBrowserEnvironmentMatrix(fixtureMatrix(dimensions))
  const reordered = expandBrowserEnvironmentMatrix(fixtureMatrix([...dimensions].reverse().map((dimension) => ({ ...dimension, values: [...dimension.values].reverse() }))))
  assert.deepEqual(first, reordered)
  assert.deepEqual(first.map((cell) => cell.selections), [
    { media: "dark", viewport: "narrow" },
    { media: "dark", viewport: "wide" },
    { media: "reduced", viewport: "narrow" },
    { media: "reduced", viewport: "wide" },
  ])
  assert.equal(new Set(first.map((cell) => cell.seed)).size, 4)
})

test("environment matrices reject combinatorial and duration budget explosions", () => {
  assert.throws(() => browserEnvironmentMatrix({ id: "too-many", seed: "seed", dimensions, limits: { ...limits, maxCells: 3 } }), /exceeding maxCells=3/)
  assert.throws(() => browserEnvironmentMatrix({ id: "too-slow", seed: "seed", dimensions, limits: { ...limits, maxDurationMs: 3_999 } }), /exceeding maxDurationMs=3999/)
})

test("environment dimensions merge independent capability state", () => {
  const [cell] = expandBrowserEnvironmentMatrix(fixtureMatrix([
    { id: "first", values: [{ id: "first", environment: { capabilities: { alpha: true } } }] },
    { id: "second", values: [{ id: "second", environment: { capabilities: { beta: "enabled" } } }] },
  ]))
  assert.deepEqual(cell?.requested.capabilities, { alpha: true, beta: "enabled" })
})

test("matrix cells use isolated run and cell artifact namespaces", async () => {
  const namespaces: string[] = []
  const report = await runBrowserEnvironmentMatrix(fixtureMatrix(dimensions), {
    runId: "run-a",
    resolve: resolveAll,
    execute: async ({ artifactNamespace }) => { namespaces.push(artifactNamespace); return { status: "passed" } },
  })
  const other = await runBrowserEnvironmentMatrix(fixtureMatrix(dimensions), { runId: "run-b", resolve: resolveAll, execute: async () => ({ status: "passed" }) })
  assert.equal(new Set(namespaces).size, 4)
  assert(namespaces.every((namespace) => namespace.startsWith("browser-matrices/environment-fixture/run-a/cells/")))
  assert.notEqual(report.cells[0]?.artifactNamespace, other.cells[0]?.artifactNamespace)
})

test("matrix execution retains completed evidence after failures and artifact exhaustion", async () => {
  let now = 0
  const report = await runBrowserEnvironmentMatrix(fixtureMatrix(dimensions), {
    runId: "partial",
    now: () => now += 10,
    resolve: resolveAll,
    execute: async ({ cell, artifactNamespace }) => cell.index === 1
      ? Promise.reject(new Error("fixture failure"))
      : { status: "passed", artifacts: [{ path: `${artifactNamespace}/summary.json`, kind: "json", bytes: cell.index === 2 ? 2048 : 10 }] },
  })
  assert.equal(report.status, "incomplete")
  assert.equal(report.cells.length, 3)
  assert.equal(report.cells[0]?.status, "passed")
  assert.equal(report.cells[1]?.status, "error")
  assert.match(report.cells[1]?.findings[0]?.message ?? "", /fixture failure/)
  assert.equal(report.cells[2]?.artifacts[0]?.bytes, 2048)
  assert(report.diagnostics.some(({ code }) => code === "browser-environment-matrix-artifact-budget-exhausted"))
  assert.equal(browserEnvironmentMatrixFailed(report), true)
})

test("capability resolution errors retain earlier completed cells", async () => {
  const matrix = fixtureMatrix([{ id: "scheme", values: [
    { id: "dark", environment: { colorScheme: "dark" } },
    { id: "light", environment: { colorScheme: "light" } },
  ] }])
  const report = await runBrowserEnvironmentMatrix(matrix, {
    runId: "resolution-error",
    resolve: (cell) => { if (cell.index === 1) throw new Error("resolver unavailable"); return resolveAll(cell) },
    execute: async () => ({ status: "passed" }),
  })
  assert.equal(report.cells.length, 2)
  assert.equal(report.cells[0]?.status, "passed")
  assert.equal(report.cells[1]?.status, "error")
  assert.match(report.cells[1]?.findings[0]?.message ?? "", /resolver unavailable/)
})

test("required capabilities fail closed while optional capabilities are inconclusive", async () => {
  const matrix = fixtureMatrix([{
    id: "capability",
    values: [
      { id: "optional", environment: { reducedMotion: "reduce" }, optionalCapabilities: ["browser.environment.reduced-motion"] },
      { id: "required", environment: { forcedColors: "active" }, requiredCapabilities: ["browser.environment.forced-colors"] },
    ],
  }])
  let executions = 0
  const report = await runBrowserEnvironmentMatrix(matrix, {
    runId: "unsupported",
    resolve: (cell) => ({ effective: cell.requested, capabilities: [] }),
    execute: async () => { executions += 1; return { status: "passed" } },
  })
  assert.equal(executions, 1)
  assert.equal(report.cells[0]?.status, "inconclusive")
  assert.deepEqual(report.cells[0]?.inconclusive, ["browser.environment.reduced-motion"])
  assert.equal(report.cells[1]?.status, "error")
  assert.deepEqual(report.cells[1]?.unsupported, ["browser.environment.forced-colors"])
})

test("finding fingerprints include the environment cell and fail-on-finding remains configurable", async () => {
  const matrix = fixtureMatrix([{ id: "scheme", values: [
    { id: "dark", environment: { colorScheme: "dark" } },
    { id: "light", environment: { colorScheme: "light" } },
  ] }])
  const report = await runBrowserEnvironmentMatrix(matrix, {
    runId: "findings",
    resolve: resolveAll,
    execute: async () => ({ status: "findings", findings: [{ code: "fixture", message: "same finding" }] }),
  })
  assert.equal(report.status, "findings")
  assert.notEqual(report.cells[0]?.findings[0]?.fingerprint, report.cells[1]?.findings[0]?.fingerprint)
  assert.equal(browserEnvironmentMatrixFailed(report), true)
  const advisory = await runBrowserEnvironmentMatrix({ ...matrix, failOnFinding: false }, { runId: "advisory", resolve: resolveAll, execute: async () => ({ status: "findings", findings: [{ code: "fixture", message: "same finding" }] }) })
  assert.equal(browserEnvironmentMatrixFailed(advisory), false)
})

function resolveAll(cell: { requested: BrowserEnvironmentMatrix["dimensions"][number]["values"][number]["environment"] }): ResolvedBrowserEnvironment {
  return { effective: cell.requested, capabilities: [
    { id: "browser.environment.viewport", fidelity: "exact" },
    { id: "browser.environment.reduced-motion", fidelity: "exact" },
    { id: "browser.environment.color-scheme", fidelity: "exact" },
  ] }
}
