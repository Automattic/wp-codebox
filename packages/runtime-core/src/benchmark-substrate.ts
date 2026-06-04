export type BenchmarkMetricValue = number

export interface BenchmarkScenarioResult {
  id: string
  iterations?: number
  metrics?: Record<string, unknown>
  [key: string]: unknown
}

export interface BenchmarkResultEnvelope {
  component_id?: string
  componentId?: string
  iterations?: number
  scenarios?: BenchmarkScenarioResult[]
  [key: string]: unknown
}

export interface BenchmarkRunRef {
  id?: string
  runId?: string
  artifactRef?: string
  label?: string
  provenance?: Record<string, unknown>
}

export interface BenchmarkMatrixDimensionValue {
  id: string
  label?: string
  value?: unknown
  provenance?: Record<string, unknown>
}

export interface BenchmarkMatrixDimension {
  id: string
  label?: string
  values: BenchmarkMatrixDimensionValue[]
}

export interface BenchmarkMatrixCell {
  schema: "wp-codebox/benchmark-matrix-cell/v1"
  id: string
  dimensions: Record<string, BenchmarkMatrixDimensionValue>
  provenance: Record<string, unknown>
}

export interface BenchmarkMatrixExpansionDiagnostic {
  type: "empty-dimension"
  severity: "error"
  dimensionId: string
  message: string
}

export interface BenchmarkMatrixExpansion {
  schema: "wp-codebox/benchmark-matrix/v1"
  cells: BenchmarkMatrixCell[]
  diagnostics: BenchmarkMatrixExpansionDiagnostic[]
}

export interface BenchmarkMatrixCellDiagnostic {
  type: "cell-failed"
  severity: "error"
  cellId: string
  message: string
  code?: string
}

export interface BenchmarkMatrixCellResult {
  schema: "wp-codebox/benchmark-matrix-cell-result/v1"
  cell: BenchmarkMatrixCell
  status: "succeeded" | "failed"
  benchResults?: BenchmarkResultEnvelope
  diagnostics: BenchmarkMatrixCellDiagnostic[]
}

export interface BenchmarkComparisonMetricDelta {
  scenarioId: string
  metricId: string
  baseline: number
  candidate: number
  absoluteDelta: number
  percentDelta?: number
}

export interface BenchmarkComparisonScenarioPair {
  scenarioId: string
  baselineIterations?: number
  candidateIterations?: number
  metrics: BenchmarkComparisonMetricDelta[]
}

export type BenchmarkComparisonDiagnosticType = "missing-baseline-scenario" | "missing-candidate-scenario" | "missing-baseline-metric" | "missing-candidate-metric"

export interface BenchmarkComparisonDiagnostic {
  type: BenchmarkComparisonDiagnosticType
  severity: "warning"
  scenarioId: string
  metricId?: string
  message: string
}

export interface BenchmarkComparison {
  schema: "wp-codebox/benchmark-comparison/v1"
  baseline?: BenchmarkRunRef
  candidate?: BenchmarkRunRef
  pairs: BenchmarkComparisonScenarioPair[]
  diagnostics: BenchmarkComparisonDiagnostic[]
  provenance: {
    baselineComponentId?: string
    candidateComponentId?: string
    baselineIterations?: number
    candidateIterations?: number
  }
}

export interface CompareBenchmarkResultsOptions {
  baseline?: BenchmarkRunRef
  candidate?: BenchmarkRunRef
}

export function expandBenchmarkMatrix(dimensions: readonly BenchmarkMatrixDimension[]): BenchmarkMatrixExpansion {
  const normalizedDimensions = dimensions.map(normalizeMatrixDimension)
  const diagnostics: BenchmarkMatrixExpansionDiagnostic[] = []
  for (const dimension of normalizedDimensions) {
    if (dimension.values.length === 0) {
      diagnostics.push({
        type: "empty-dimension",
        severity: "error",
        dimensionId: dimension.id,
        message: `Benchmark matrix dimension "${dimension.id}" has no values.`,
      })
    }
  }

  if (diagnostics.length > 0) {
    return { schema: "wp-codebox/benchmark-matrix/v1", cells: [], diagnostics }
  }

  const cells = normalizedDimensions.length === 0
    ? [createBenchmarkMatrixCell([])]
    : cartesianProduct(normalizedDimensions.map((dimension) => dimension.values.map((value) => ({ dimension, value })))).map(createBenchmarkMatrixCell)

  return { schema: "wp-codebox/benchmark-matrix/v1", cells, diagnostics }
}

export function createBenchmarkMatrixCellResult(cell: BenchmarkMatrixCell, benchResults: BenchmarkResultEnvelope): BenchmarkMatrixCellResult {
  return {
    schema: "wp-codebox/benchmark-matrix-cell-result/v1",
    cell,
    status: "succeeded",
    benchResults,
    diagnostics: [],
  }
}

export function createBenchmarkMatrixCellFailure(cell: BenchmarkMatrixCell, error: unknown): BenchmarkMatrixCellResult {
  const normalized = normalizeError(error)
  return {
    schema: "wp-codebox/benchmark-matrix-cell-result/v1",
    cell,
    status: "failed",
    diagnostics: [{
      type: "cell-failed",
      severity: "error",
      cellId: cell.id,
      message: normalized.message,
      ...(normalized.code ? { code: normalized.code } : {}),
    }],
  }
}

export function compareBenchmarkResults(baseline: BenchmarkResultEnvelope, candidate: BenchmarkResultEnvelope, options: CompareBenchmarkResultsOptions = {}): BenchmarkComparison {
  const baselineScenarios = scenarioMap(baseline)
  const candidateScenarios = scenarioMap(candidate)
  const scenarioIds = sortedUnion(Object.keys(baselineScenarios), Object.keys(candidateScenarios))
  const pairs: BenchmarkComparisonScenarioPair[] = []
  const diagnostics: BenchmarkComparisonDiagnostic[] = []

  for (const scenarioId of scenarioIds) {
    const baselineScenario = baselineScenarios[scenarioId]
    const candidateScenario = candidateScenarios[scenarioId]
    if (!baselineScenario) {
      diagnostics.push({
        type: "missing-baseline-scenario",
        severity: "warning",
        scenarioId,
        message: `Scenario "${scenarioId}" is missing from the baseline benchmark results.`,
      })
      continue
    }
    if (!candidateScenario) {
      diagnostics.push({
        type: "missing-candidate-scenario",
        severity: "warning",
        scenarioId,
        message: `Scenario "${scenarioId}" is missing from the candidate benchmark results.`,
      })
      continue
    }

    const baselineMetrics = numericMetricMap(baselineScenario.metrics)
    const candidateMetrics = numericMetricMap(candidateScenario.metrics)
    const metricIds = sortedUnion(Object.keys(baselineMetrics), Object.keys(candidateMetrics))
    const metrics: BenchmarkComparisonMetricDelta[] = []
    for (const metricId of metricIds) {
      const baselineValue = baselineMetrics[metricId]
      const candidateValue = candidateMetrics[metricId]
      if (baselineValue === undefined) {
        diagnostics.push({
          type: "missing-baseline-metric",
          severity: "warning",
          scenarioId,
          metricId,
          message: `Metric "${metricId}" in scenario "${scenarioId}" is missing from the baseline benchmark results.`,
        })
        continue
      }
      if (candidateValue === undefined) {
        diagnostics.push({
          type: "missing-candidate-metric",
          severity: "warning",
          scenarioId,
          metricId,
          message: `Metric "${metricId}" in scenario "${scenarioId}" is missing from the candidate benchmark results.`,
        })
        continue
      }

      const absoluteDelta = candidateValue - baselineValue
      metrics.push({
        scenarioId,
        metricId,
        baseline: baselineValue,
        candidate: candidateValue,
        absoluteDelta,
        ...(baselineValue !== 0 ? { percentDelta: (absoluteDelta / baselineValue) * 100 } : {}),
      })
    }

    pairs.push({
      scenarioId,
      ...(typeof baselineScenario.iterations === "number" ? { baselineIterations: baselineScenario.iterations } : {}),
      ...(typeof candidateScenario.iterations === "number" ? { candidateIterations: candidateScenario.iterations } : {}),
      metrics,
    })
  }

  return {
    schema: "wp-codebox/benchmark-comparison/v1",
    ...(options.baseline ? { baseline: options.baseline } : {}),
    ...(options.candidate ? { candidate: options.candidate } : {}),
    pairs,
    diagnostics,
    provenance: {
      ...componentAndIterationProvenance("baseline", baseline),
      ...componentAndIterationProvenance("candidate", candidate),
    },
  }
}

function normalizeMatrixDimension(dimension: BenchmarkMatrixDimension): BenchmarkMatrixDimension {
  const id = requiredId(dimension.id, "Benchmark matrix dimension")
  return {
    id,
    ...(dimension.label ? { label: dimension.label } : {}),
    values: dimension.values.map((value) => ({
      id: requiredId(value.id, `Benchmark matrix dimension "${id}" value`),
      ...(value.label ? { label: value.label } : {}),
      ...(value.value !== undefined ? { value: value.value } : {}),
      ...(value.provenance ? { provenance: value.provenance } : {}),
    })),
  }
}

function createBenchmarkMatrixCell(entries: Array<{ dimension: BenchmarkMatrixDimension; value: BenchmarkMatrixDimensionValue }>): BenchmarkMatrixCell {
  const dimensions: Record<string, BenchmarkMatrixDimensionValue> = {}
  const provenance: Record<string, unknown> = {}
  for (const { dimension, value } of entries) {
    dimensions[dimension.id] = value
    provenance[dimension.id] = value.provenance ?? value.value ?? value.id
  }

  return {
    schema: "wp-codebox/benchmark-matrix-cell/v1",
    id: entries.length === 0 ? "default" : entries.map(({ dimension, value }) => `${dimension.id}:${value.id}`).join("__"),
    dimensions,
    provenance,
  }
}

function cartesianProduct<T>(sets: T[][]): T[][] {
  return sets.reduce<T[][]>((product, set) => product.flatMap((prefix) => set.map((item) => [...prefix, item])), [[]])
}

function scenarioMap(results: BenchmarkResultEnvelope): Record<string, BenchmarkScenarioResult> {
  const scenarios: Record<string, BenchmarkScenarioResult> = {}
  for (const scenario of results.scenarios ?? []) {
    if (scenario && typeof scenario.id === "string" && scenario.id.trim()) {
      scenarios[scenario.id] = scenario
    }
  }
  return scenarios
}

function numericMetricMap(metrics: Record<string, unknown> | undefined): Record<string, number> {
  const numericMetrics: Record<string, number> = {}
  for (const [key, value] of Object.entries(metrics ?? {})) {
    if (typeof value === "number" && Number.isFinite(value)) {
      numericMetrics[key] = value
    }
  }
  return numericMetrics
}

function sortedUnion(left: string[], right: string[]): string[] {
  return [...new Set([...left, ...right])].sort()
}

function componentAndIterationProvenance(prefix: "baseline" | "candidate", results: BenchmarkResultEnvelope): Record<string, string | number> {
  const provenance: Record<string, string | number> = {}
  const componentId = typeof results.component_id === "string" ? results.component_id : typeof results.componentId === "string" ? results.componentId : undefined
  if (componentId) {
    provenance[`${prefix}ComponentId`] = componentId
  }
  if (typeof results.iterations === "number") {
    provenance[`${prefix}Iterations`] = results.iterations
  }
  return provenance
}

function requiredId(value: string, label: string): string {
  const id = value.trim()
  if (!id) {
    throw new Error(`${label} requires id`)
  }
  return id
}

function normalizeError(error: unknown): { message: string; code?: string } {
  if (error instanceof Error) {
    const code = typeof (error as Error & { code?: unknown }).code === "string" ? (error as Error & { code: string }).code : undefined
    return { message: error.message, ...(code ? { code } : {}) }
  }
  return { message: typeof error === "string" ? error : "Benchmark matrix cell failed." }
}
