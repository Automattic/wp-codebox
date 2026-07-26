import { createHash } from "node:crypto"

import { stableJson, stripUndefined } from "./object-utils.js"

export const BROWSER_ENVIRONMENT_MATRIX_SCHEMA = "wp-codebox/browser-environment-matrix/v1" as const
export const BROWSER_ENVIRONMENT_MATRIX_REPORT_SCHEMA = "wp-codebox/browser-environment-matrix-report/v1" as const
export const BROWSER_ENVIRONMENT_REPLAY_SCHEMA = "wp-codebox/browser-environment-replay/v1" as const

export type BrowserEnvironmentFidelity = "exact" | "emulated" | "unsupported"
export type BrowserEnvironmentCellStatus = "passed" | "findings" | "error" | "timed-out" | "inconclusive"

export interface BrowserEnvironment {
  viewport?: { width: number; height: number }
  device?: string
  deviceScaleFactor?: number
  isMobile?: boolean
  hasTouch?: boolean
  orientation?: "portrait" | "landscape"
  zoom?: number
  colorScheme?: "light" | "dark" | "no-preference"
  reducedMotion?: "reduce" | "no-preference"
  forcedColors?: "active" | "none"
  contrast?: "more" | "no-preference"
  locale?: string
  timezone?: string
  networkProfile?: string
  cpuProfile?: string
  online?: boolean
  clock?: { mode: "realtime" | "fixed"; at?: string }
  capabilities?: Record<string, boolean | string | number>
}

export interface BrowserEnvironmentDimensionValue {
  id: string
  environment: BrowserEnvironment
  requiredCapabilities?: string[]
  optionalCapabilities?: string[]
}

export interface BrowserEnvironmentDimension {
  id: string
  values: BrowserEnvironmentDimensionValue[]
}

export interface BrowserEnvironmentMatrixLimits {
  maxCells: number
  maxDurationMs: number
  maxCellDurationMs: number
  maxArtifactBytes: number
}

export interface BrowserEnvironmentMatrix {
  schema: typeof BROWSER_ENVIRONMENT_MATRIX_SCHEMA
  id: string
  seed: string
  dimensions: BrowserEnvironmentDimension[]
  limits: BrowserEnvironmentMatrixLimits
  failOnFinding: boolean
  replayCommand?: string
  metadata?: Record<string, unknown>
}

export interface BrowserEnvironmentCell {
  id: string
  index: number
  seed: string
  selections: Record<string, string>
  requested: BrowserEnvironment
  requiredCapabilities: string[]
  optionalCapabilities: string[]
}

export interface BrowserEnvironmentCapabilityResult {
  id: string
  fidelity: BrowserEnvironmentFidelity
  reason?: string
}

export interface ResolvedBrowserEnvironment {
  effective: BrowserEnvironment
  capabilities: BrowserEnvironmentCapabilityResult[]
  provider?: { id: string; browser?: string; channel?: string; version?: string }
}

export interface BrowserEnvironmentFinding {
  code: string
  message: string
  severity?: string
  fingerprint?: string
  metadata?: Record<string, unknown>
}

export interface BrowserEnvironmentCellExecution {
  status: BrowserEnvironmentCellStatus
  findings?: BrowserEnvironmentFinding[]
  artifacts?: Array<{ path: string; kind: string; bytes?: number; sha256?: string }>
  metadata?: Record<string, unknown>
}

export interface BrowserEnvironmentReplay {
  schema: typeof BROWSER_ENVIRONMENT_REPLAY_SCHEMA
  matrixId: string
  matrixSeed: string
  cellId: string
  cellSeed: string
  selections: Record<string, string>
  requested: BrowserEnvironment
  effective: BrowserEnvironment
  provider?: ResolvedBrowserEnvironment["provider"]
  capabilities: BrowserEnvironmentCapabilityResult[]
  artifactNamespace: string
  command: string
}

export interface BrowserEnvironmentMatrixCellReport {
  id: string
  index: number
  seed: string
  selections: Record<string, string>
  artifactNamespace: string
  requested: BrowserEnvironment
  effective: BrowserEnvironment
  status: BrowserEnvironmentCellStatus
  findings: BrowserEnvironmentFinding[]
  artifacts: NonNullable<BrowserEnvironmentCellExecution["artifacts"]>
  timing: { startedAt: string; completedAt: string; durationMs: number }
  replay: BrowserEnvironmentReplay
  capabilities: BrowserEnvironmentCapabilityResult[]
  unsupported: string[]
  inconclusive: string[]
  metadata?: Record<string, unknown>
}

export interface BrowserEnvironmentMatrixReport {
  schema: typeof BROWSER_ENVIRONMENT_MATRIX_REPORT_SCHEMA
  matrixId: string
  runId: string
  seed: string
  status: "passed" | "findings" | "incomplete"
  failOnFinding: boolean
  cells: BrowserEnvironmentMatrixCellReport[]
  summary: { planned: number; completed: number; passed: number; findings: number; failed: number; inconclusive: number }
  resourceUsage: { durationMs: number; artifactBytes: number }
  diagnostics: Array<{ code: string; message: string }>
}

export interface BrowserEnvironmentMatrixRunnerOptions {
  runId: string
  resolve(cell: BrowserEnvironmentCell): Promise<ResolvedBrowserEnvironment> | ResolvedBrowserEnvironment
  execute(input: { cell: BrowserEnvironmentCell; resolved: ResolvedBrowserEnvironment; artifactNamespace: string; signal: AbortSignal }): Promise<BrowserEnvironmentCellExecution>
  now?: () => number
  signal?: AbortSignal
  replayCommand?: (matrix: BrowserEnvironmentMatrix, cell: BrowserEnvironmentCell) => string
}

export function browserEnvironmentMatrix(input: Omit<BrowserEnvironmentMatrix, "schema" | "limits" | "failOnFinding"> & { limits?: Partial<BrowserEnvironmentMatrixLimits>; failOnFinding?: boolean }): BrowserEnvironmentMatrix {
  if (!safeId(input.id) || !input.seed) throw new Error("Browser environment matrices require a safe non-empty id and seed.")
  if (!Array.isArray(input.dimensions) || input.dimensions.length === 0) throw new Error("Browser environment matrices require at least one dimension.")
  const dimensions = input.dimensions.map(normalizeDimension).sort((left, right) => left.id.localeCompare(right.id))
  if (new Set(dimensions.map(({ id }) => id)).size !== dimensions.length) throw new Error("Browser environment matrix dimension ids must be unique.")
  const limits = normalizeLimits(input.limits)
  const cells = dimensions.reduce((count, dimension) => count * dimension.values.length, 1)
  if (!Number.isSafeInteger(cells) || cells > limits.maxCells) throw new Error(`Browser environment matrix expands to ${cells} cells, exceeding maxCells=${limits.maxCells}.`)
  const requestedDuration = cells * limits.maxCellDurationMs
  if (requestedDuration > limits.maxDurationMs) throw new Error(`Browser environment matrix reserves ${requestedDuration}ms, exceeding maxDurationMs=${limits.maxDurationMs}.`)
  return stripUndefined({ schema: BROWSER_ENVIRONMENT_MATRIX_SCHEMA, id: input.id, seed: input.seed, dimensions, limits, failOnFinding: input.failOnFinding !== false, replayCommand: input.replayCommand, metadata: input.metadata })
}

export function expandBrowserEnvironmentMatrix(input: BrowserEnvironmentMatrix): BrowserEnvironmentCell[] {
  const matrix = browserEnvironmentMatrix(input)
  let selections: Array<Array<[string, BrowserEnvironmentDimensionValue]>> = [[]]
  for (const dimension of matrix.dimensions) selections = selections.flatMap((selection) => dimension.values.map((value) => [...selection, [dimension.id, value] as [string, BrowserEnvironmentDimensionValue]]))
  return selections.map((selection, index) => {
    const selected = Object.fromEntries(selection.map(([dimension, value]) => [dimension, value.id]))
    const requested = selection.reduce((environment, [, value]) => mergeEnvironment(environment, value.environment), {} as BrowserEnvironment)
    const identity = stableJson({ selections: selected, requested })
    const id = createHash("sha256").update(`wp-codebox/browser-environment-cell/v1\n${identity}`).digest("hex").slice(0, 16)
    return {
      id,
      index,
      seed: createHash("sha256").update(`wp-codebox/browser-environment-cell-seed/v1\n${matrix.seed}\n${identity}`).digest("hex"),
      selections: selected,
      requested,
      requiredCapabilities: uniqueSorted(selection.flatMap(([, value]) => value.requiredCapabilities ?? [])),
      optionalCapabilities: uniqueSorted(selection.flatMap(([, value]) => value.optionalCapabilities ?? [])),
    }
  })
}

export async function runBrowserEnvironmentMatrix(input: BrowserEnvironmentMatrix, options: BrowserEnvironmentMatrixRunnerOptions): Promise<BrowserEnvironmentMatrixReport> {
  const matrix = browserEnvironmentMatrix(input)
  if (!safeId(options.runId)) throw new Error("Browser environment matrix runId must be a safe non-empty id.")
  const cells = expandBrowserEnvironmentMatrix(matrix)
  const now = options.now ?? Date.now
  const started = now()
  const reports: BrowserEnvironmentMatrixCellReport[] = []
  const diagnostics: BrowserEnvironmentMatrixReport["diagnostics"] = []
  let artifactBytes = 0
  let incomplete = false

  for (const cell of cells) {
    if (options.signal?.aborted || now() - started >= matrix.limits.maxDurationMs) {
      incomplete = true
      diagnostics.push({ code: options.signal?.aborted ? "browser-environment-matrix-interrupted" : "browser-environment-matrix-duration-exhausted", message: `Matrix stopped after ${reports.length} completed cells.` })
      break
    }
    const artifactNamespace = `browser-matrices/${matrix.id}/${options.runId}/cells/${String(cell.index).padStart(4, "0")}-${cell.id}`
    const cellStarted = now()
    let resolved: ResolvedBrowserEnvironment
    let resolutionError: Error | undefined
    try {
      resolved = await options.resolve(cell)
    } catch (error) {
      resolutionError = error instanceof Error ? error : new Error(String(error))
      resolved = { effective: cell.requested, capabilities: [] }
    }
    const capabilityMap = new Map(resolved.capabilities.map((capability) => [capability.id, capability]))
    const unsupported = cell.requiredCapabilities.filter((id) => capabilityMap.get(id)?.fidelity === "unsupported" || !capabilityMap.has(id))
    const inconclusive = cell.optionalCapabilities.filter((id) => capabilityMap.get(id)?.fidelity === "unsupported" || !capabilityMap.has(id))
    let execution: BrowserEnvironmentCellExecution
    if (resolutionError) {
      execution = { status: "error", findings: [{ code: "browser-environment-resolution-error", message: resolutionError.message }] }
    } else if (unsupported.length > 0) {
      execution = { status: "error", findings: unsupported.map((id) => ({ code: "browser-environment-required-capability-unsupported", message: `Required browser environment capability is unsupported: ${id}` })) }
    } else {
      execution = await executeBoundedCell(matrix, cell, resolved, artifactNamespace, options)
      if (execution.status === "passed" && inconclusive.length > 0) execution = { ...execution, status: "inconclusive" }
    }
    const findings = (execution.findings ?? []).map((finding) => ({ ...finding, fingerprint: finding.fingerprint ?? browserEnvironmentFindingFingerprint(cell.id, finding) }))
    artifactBytes += (execution.artifacts ?? []).reduce((total, artifact) => total + (artifact.bytes ?? 0), 0)
    const completedAtMs = now()
    reports.push({
      id: cell.id,
      index: cell.index,
      seed: cell.seed,
      selections: cell.selections,
      artifactNamespace,
      requested: cell.requested,
      effective: resolved.effective,
      status: execution.status,
      findings,
      artifacts: execution.artifacts ?? [],
      timing: { startedAt: new Date(cellStarted).toISOString(), completedAt: new Date(completedAtMs).toISOString(), durationMs: Math.max(0, completedAtMs - cellStarted) },
      replay: { schema: BROWSER_ENVIRONMENT_REPLAY_SCHEMA, matrixId: matrix.id, matrixSeed: matrix.seed, cellId: cell.id, cellSeed: cell.seed, selections: cell.selections, requested: cell.requested, effective: resolved.effective, provider: resolved.provider, capabilities: resolved.capabilities, artifactNamespace, command: options.replayCommand?.(matrix, cell) ?? matrix.replayCommand ?? `wp-codebox browser-matrix replay --matrix ${matrix.id} --cell ${cell.id} --seed ${cell.seed}` },
      capabilities: resolved.capabilities,
      unsupported,
      inconclusive,
      ...(execution.metadata ? { metadata: execution.metadata } : {}),
    })
    if (artifactBytes > matrix.limits.maxArtifactBytes) {
      incomplete = true
      diagnostics.push({ code: "browser-environment-matrix-artifact-budget-exhausted", message: `Matrix stopped after completed evidence exceeded maxArtifactBytes=${matrix.limits.maxArtifactBytes}.` })
      break
    }
  }

  const findingCount = reports.reduce((count, cell) => count + cell.findings.length, 0)
  const failed = reports.filter((cell) => cell.status === "error" || cell.status === "timed-out").length
  return {
    schema: BROWSER_ENVIRONMENT_MATRIX_REPORT_SCHEMA,
    matrixId: matrix.id,
    runId: options.runId,
    seed: matrix.seed,
    status: incomplete || reports.length < cells.length ? "incomplete" : findingCount > 0 || failed > 0 ? "findings" : "passed",
    failOnFinding: matrix.failOnFinding,
    cells: reports,
    summary: { planned: cells.length, completed: reports.length, passed: reports.filter((cell) => cell.status === "passed").length, findings: findingCount, failed, inconclusive: reports.filter((cell) => cell.status === "inconclusive").length },
    resourceUsage: { durationMs: Math.max(0, now() - started), artifactBytes },
    diagnostics,
  }
}

export function browserEnvironmentFindingFingerprint(cellId: string, finding: Pick<BrowserEnvironmentFinding, "code" | "message" | "severity" | "metadata">): string {
  return createHash("sha256").update("wp-codebox/browser-environment-finding/v1\n").update(stableJson({ cellId, finding })).digest("hex")
}

export function browserEnvironmentMatrixFailed(report: BrowserEnvironmentMatrixReport): boolean {
  return report.status === "incomplete" || (report.failOnFinding && report.status === "findings")
}

async function executeBoundedCell(matrix: BrowserEnvironmentMatrix, cell: BrowserEnvironmentCell, resolved: ResolvedBrowserEnvironment, artifactNamespace: string, options: BrowserEnvironmentMatrixRunnerOptions): Promise<BrowserEnvironmentCellExecution> {
  const controller = new AbortController()
  const abort = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener("abort", abort, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      options.execute({ cell, resolved, artifactNamespace, signal: controller.signal }),
      new Promise<BrowserEnvironmentCellExecution>((resolve) => { timer = setTimeout(() => { controller.abort(); resolve({ status: "timed-out", findings: [{ code: "browser-environment-cell-timeout", message: `Cell exceeded ${matrix.limits.maxCellDurationMs}ms.` }] }) }, matrix.limits.maxCellDurationMs) }),
    ])
  } catch (error) {
    return { status: "error", findings: [{ code: "browser-environment-cell-error", message: error instanceof Error ? error.message : String(error) }] }
  } finally {
    if (timer) clearTimeout(timer)
    options.signal?.removeEventListener("abort", abort)
  }
}

function normalizeDimension(dimension: BrowserEnvironmentDimension): BrowserEnvironmentDimension {
  if (!safeId(dimension.id) || !Array.isArray(dimension.values) || dimension.values.length === 0) throw new Error(`Invalid browser environment dimension: ${dimension.id}`)
  const values = dimension.values.map((value) => {
    if (!safeId(value.id)) throw new Error(`Invalid browser environment value id in ${dimension.id}: ${value.id}`)
    validateEnvironment(value.environment)
    return { id: value.id, environment: canonicalEnvironment(value.environment), requiredCapabilities: uniqueSorted(value.requiredCapabilities ?? []), optionalCapabilities: uniqueSorted(value.optionalCapabilities ?? []) }
  }).sort((left, right) => left.id.localeCompare(right.id) || stableJson(left.environment).localeCompare(stableJson(right.environment)))
  if (new Set(values.map(({ id }) => id)).size !== values.length) throw new Error(`Browser environment value ids must be unique in ${dimension.id}.`)
  return { id: dimension.id, values }
}

function normalizeLimits(input: Partial<BrowserEnvironmentMatrixLimits> | undefined): BrowserEnvironmentMatrixLimits {
  return {
    maxCells: boundedInteger(input?.maxCells, 32, 1, 10_000),
    maxDurationMs: boundedInteger(input?.maxDurationMs, 300_000, 1, 86_400_000),
    maxCellDurationMs: boundedInteger(input?.maxCellDurationMs, 30_000, 1, 3_600_000),
    maxArtifactBytes: boundedInteger(input?.maxArtifactBytes, 100 * 1_048_576, 1, 4 * 1024 * 1_048_576),
  }
}

function validateEnvironment(environment: BrowserEnvironment): void {
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) throw new Error("Browser environment values must be objects.")
  if (environment.viewport && (!positiveInteger(environment.viewport.width) || !positiveInteger(environment.viewport.height))) throw new Error("Browser environment viewport width and height must be positive integers.")
  if (environment.deviceScaleFactor !== undefined && (!Number.isFinite(environment.deviceScaleFactor) || environment.deviceScaleFactor <= 0)) throw new Error("Browser environment deviceScaleFactor must be positive.")
  if (environment.zoom !== undefined && (!Number.isFinite(environment.zoom) || environment.zoom < 0.25 || environment.zoom > 5)) throw new Error("Browser environment zoom must be between 0.25 and 5.")
  if (environment.clock?.mode === "fixed" && (!environment.clock.at || !Number.isFinite(Date.parse(environment.clock.at)))) throw new Error("Fixed browser environment clocks require an ISO-compatible at value.")
}

function canonicalEnvironment(environment: BrowserEnvironment): BrowserEnvironment {
  return JSON.parse(stableJson(JSON.parse(JSON.stringify(environment)))) as BrowserEnvironment
}

function mergeEnvironment(left: BrowserEnvironment, right: BrowserEnvironment): BrowserEnvironment {
  const conflicts = Object.keys(right).filter((key) => key !== "capabilities" && key in left && stableJson(left[key as keyof BrowserEnvironment]) !== stableJson(right[key as keyof BrowserEnvironment]))
  if (conflicts.length > 0) throw new Error(`Browser environment dimensions assign conflicting values: ${conflicts.sort().join(", ")}.`)
  const capabilities = left.capabilities || right.capabilities ? { ...(left.capabilities ?? {}), ...(right.capabilities ?? {}) } : undefined
  return canonicalEnvironment({ ...left, ...right, ...(capabilities ? { capabilities } : {}) })
}

function safeId(value: string): boolean { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value) }
function positiveInteger(value: number): boolean { return Number.isInteger(value) && value > 0 }
function uniqueSorted(values: string[]): string[] { return [...new Set(values)].sort() }
function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number { return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Math.floor(value as number))) : fallback }
