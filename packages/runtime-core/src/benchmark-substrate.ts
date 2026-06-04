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
  benchResultsList?: BenchmarkResultEnvelope[]
  diagnostics: BenchmarkMatrixCellDiagnostic[]
}

export interface BenchmarkMatrixGroupedBenchResults {
  cellId: string
  cell: BenchmarkMatrixCell
  results: BenchmarkResultEnvelope[]
}

export interface BenchmarkMatrixRun {
  schema: "wp-codebox/benchmark-matrix-run/v1"
  matrix: BenchmarkMatrixExpansion
  cells: BenchmarkMatrixCellResult[]
  benchResults: BenchmarkMatrixGroupedBenchResults[]
  diagnostics: BenchmarkMatrixCellDiagnostic[]
  provenance: Record<string, unknown>
}

export interface ExecuteBenchmarkMatrixOptions {
  generatedAt?: string
  provenance?: Record<string, unknown>
}

export type BenchmarkMatrixCellRunner = (cell: BenchmarkMatrixCell) => Promise<BenchmarkResultEnvelope | BenchmarkResultEnvelope[]>

export interface BenchmarkComparisonMetricDelta {
  scenarioId: string
  metricId: string
  unit?: string
  statistic?: "mean" | "value" | (string & {})
  baseline: number
  candidate: number
  absoluteDelta: number
  percentDelta?: number
  baselineSamples?: BenchmarkComparisonSampleMetadata
  candidateSamples?: BenchmarkComparisonSampleMetadata
}

export interface BenchmarkComparisonSampleMetadata {
  count?: number
  standardDeviation?: number
  relativeStandardDeviation?: number
  min?: number
  max?: number
  p50?: number
  p95?: number
  p99?: number
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

export function createBenchmarkMatrixCellResults(cell: BenchmarkMatrixCell, benchResultsList: BenchmarkResultEnvelope[]): BenchmarkMatrixCellResult {
  return {
    schema: "wp-codebox/benchmark-matrix-cell-result/v1",
    cell,
    status: "succeeded",
    ...(benchResultsList.length === 1 ? { benchResults: benchResultsList[0] } : {}),
    benchResultsList,
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

export async function executeBenchmarkMatrix(dimensions: readonly BenchmarkMatrixDimension[], runCell: BenchmarkMatrixCellRunner, options: ExecuteBenchmarkMatrixOptions = {}): Promise<BenchmarkMatrixRun> {
  const matrix = expandBenchmarkMatrix(dimensions)
  const cells: BenchmarkMatrixCellResult[] = []

  if (matrix.diagnostics.length > 0) {
    return {
      schema: "wp-codebox/benchmark-matrix-run/v1",
      matrix,
      cells,
      benchResults: [],
      diagnostics: matrix.diagnostics.map((diagnostic) => ({
        type: "cell-failed",
        severity: diagnostic.severity,
        cellId: "matrix-expansion",
        message: diagnostic.message,
        code: diagnostic.type,
      })),
      provenance: matrixRunProvenance(options),
    }
  }

  for (const cell of matrix.cells) {
    try {
      const result = await runCell(cell)
      cells.push(createBenchmarkMatrixCellResults(cell, Array.isArray(result) ? result : [result]))
    } catch (error) {
      cells.push(createBenchmarkMatrixCellFailure(cell, error))
    }
  }

  return {
    schema: "wp-codebox/benchmark-matrix-run/v1",
    matrix,
    cells,
    benchResults: cells
      .filter((cell): cell is BenchmarkMatrixCellResult & { benchResultsList: BenchmarkResultEnvelope[] } => cell.status === "succeeded" && Array.isArray(cell.benchResultsList))
      .map((cell) => ({ cellId: cell.cell.id, cell: cell.cell, results: cell.benchResultsList })),
    diagnostics: cells.flatMap((cell) => cell.diagnostics),
    provenance: matrixRunProvenance(options),
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

    const baselineMetrics = comparableMetricMap(baselineScenario.metrics)
    const candidateMetrics = comparableMetricMap(candidateScenario.metrics)
    const metricIds = sortedUnion(Object.keys(baselineMetrics), Object.keys(candidateMetrics))
    const metrics: BenchmarkComparisonMetricDelta[] = []
    for (const metricId of metricIds) {
      const baselineMetric = baselineMetrics[metricId]
      const candidateMetric = candidateMetrics[metricId]
      if (!baselineMetric) {
        diagnostics.push({
          type: "missing-baseline-metric",
          severity: "warning",
          scenarioId,
          metricId,
          message: `Metric "${metricId}" in scenario "${scenarioId}" is missing from the baseline benchmark results.`,
        })
        continue
      }
      if (!candidateMetric) {
        diagnostics.push({
          type: "missing-candidate-metric",
          severity: "warning",
          scenarioId,
          metricId,
          message: `Metric "${metricId}" in scenario "${scenarioId}" is missing from the candidate benchmark results.`,
        })
        continue
      }

      const absoluteDelta = candidateMetric.value - baselineMetric.value
      metrics.push({
        scenarioId,
        metricId,
        ...(baselineMetric.unit === candidateMetric.unit && baselineMetric.unit ? { unit: baselineMetric.unit } : {}),
        ...comparisonStatistic(baselineMetric, candidateMetric),
        baseline: baselineMetric.value,
        candidate: candidateMetric.value,
        absoluteDelta,
        ...(baselineMetric.value !== 0 ? { percentDelta: (absoluteDelta / baselineMetric.value) * 100 } : {}),
        ...(baselineMetric.samples ? { baselineSamples: baselineMetric.samples } : {}),
        ...(candidateMetric.samples ? { candidateSamples: candidateMetric.samples } : {}),
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

interface ComparableBenchmarkMetric {
  value: number
  unit?: string
  statistic: "mean" | "value" | (string & {})
  samples?: BenchmarkComparisonSampleMetadata
}

function comparableMetricMap(metrics: Record<string, unknown> | undefined): Record<string, ComparableBenchmarkMetric> {
  const comparableMetrics: Record<string, ComparableBenchmarkMetric> = {}
  for (const [key, value] of Object.entries(metrics ?? {})) {
    if (typeof value === "number" && Number.isFinite(value)) {
      comparableMetrics[key] = { value, statistic: "value" }
      continue
    }

    const samples = metricSamplesSummary(value)
    if (samples && Number.isFinite(samples.mean)) {
      comparableMetrics[key] = {
        value: samples.mean,
        statistic: "mean",
        ...metricUnit(value),
        samples: comparisonSampleMetadata(samples),
      }
    }
  }
  return comparableMetrics
}

function metricSamplesSummary(value: unknown): { count?: unknown; mean: number; standard_deviation?: unknown; relative_standard_deviation?: unknown; min?: unknown; max?: unknown; p50?: unknown; p95?: unknown; p99?: unknown } | undefined {
  if (!isRecord(value) || !isRecord(value.samples) || typeof value.samples.mean !== "number") {
    return undefined
  }
  return value.samples as { count?: unknown; mean: number; standard_deviation?: unknown; relative_standard_deviation?: unknown; min?: unknown; max?: unknown; p50?: unknown; p95?: unknown; p99?: unknown }
}

function metricUnit(value: unknown): { unit?: string } {
  if (!isRecord(value) || typeof value.unit !== "string" || !value.unit.trim()) {
    return {}
  }
  return { unit: value.unit }
}

function comparisonSampleMetadata(samples: { count?: unknown; standard_deviation?: unknown; relative_standard_deviation?: unknown; min?: unknown; max?: unknown; p50?: unknown; p95?: unknown; p99?: unknown }): BenchmarkComparisonSampleMetadata {
  return {
    ...finiteNumberProperty("count", samples.count),
    ...finiteNumberProperty("standardDeviation", samples.standard_deviation),
    ...finiteNumberProperty("relativeStandardDeviation", samples.relative_standard_deviation),
    ...finiteNumberProperty("min", samples.min),
    ...finiteNumberProperty("max", samples.max),
    ...finiteNumberProperty("p50", samples.p50),
    ...finiteNumberProperty("p95", samples.p95),
    ...finiteNumberProperty("p99", samples.p99),
  }
}

function finiteNumberProperty(name: keyof BenchmarkComparisonSampleMetadata, value: unknown): Partial<BenchmarkComparisonSampleMetadata> {
  return typeof value === "number" && Number.isFinite(value) ? { [name]: value } : {}
}

function comparisonStatistic(baselineMetric: ComparableBenchmarkMetric, candidateMetric: ComparableBenchmarkMetric): { statistic?: "mean" | "value" | (string & {}) } {
  const statistic = baselineMetric.statistic === candidateMetric.statistic ? baselineMetric.statistic : "value"
  return statistic === "value" ? {} : { statistic }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
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

function matrixRunProvenance(options: ExecuteBenchmarkMatrixOptions): Record<string, unknown> {
  return {
    generated_at: options.generatedAt ?? new Date().toISOString(),
    ...(options.provenance ?? {}),
  }
}
