import { spawn } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { expandBenchmarkMatrix, createBenchmarkMatrixCellFailure, createBenchmarkMatrixCellResults, type BenchmarkMatrixCell, type BenchmarkMatrixCellResult, type BenchmarkMatrixDimension, type BenchmarkResultEnvelope } from "@automattic/wp-codebox-core"

interface BenchmarkSummaryOptions {
  inputPath?: string
  bundleDirectory?: string
  json: boolean
}

interface BenchmarkMatrixOptions {
  matrixPath: string
  recipePath?: string
  artifactsDirectory?: string
  runRegistryDirectory?: string
  timeout?: string
  json: boolean
}

interface BenchResults {
  component_id?: string
  iterations?: number
  warmup_iterations?: number
  scenarios?: unknown[]
  [key: string]: unknown
}

interface BenchmarkScenarioSummary {
  componentId: string
  id: string
  source?: string
  iterations?: number
  metricCount: number
  metrics: Record<string, number>
  artifacts: Record<string, unknown>
}

interface BenchmarkSummaryOutput {
  schema: "wp-codebox/benchmark-summary/v1"
  source: {
    type: "recipe-run-output" | "artifact-bundle"
    path: string
  }
  hasBenchResults: boolean
  benchmarkCount: number
  scenarioCount: number
  benchmarks: BenchResults[]
  scenarios: BenchmarkScenarioSummary[]
}

interface BenchmarkRecipeMatrixDefinition {
  schema?: "wp-codebox/benchmark-recipe-matrix/v1" | (string & {})
  recipe?: string
  dimensions?: BenchmarkMatrixDimension[]
  artifacts?: string | { directory?: string }
  runRegistry?: string
  timeout?: string
  metadata?: Record<string, unknown>
}

interface BenchmarkMatrixRunOutput {
  schema: "wp-codebox/benchmark-matrix-run/v1"
  source: {
    matrixPath: string
    recipePath: string
  }
  matrix: ReturnType<typeof expandBenchmarkMatrix>
  cells: BenchmarkMatrixCellResult[]
  benchResults: Array<{
    cellId: string
    cell: BenchmarkMatrixCell
    results: BenchResults[]
  }>
  diagnostics: BenchmarkMatrixCellResult["diagnostics"]
  provenance: Record<string, unknown>
}

export async function runBenchSummarizeCommand(args: string[]): Promise<number> {
  const options = parseBenchmarkSummaryOptions(args)
  const output = await summarizeBenchmarks(options)
  if (!options.json) {
    printBenchmarkSummaryHumanOutput(output)
    return 0
  }

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  return 0
}

export async function runBenchMatrixCommand(args: string[]): Promise<number> {
  const options = parseBenchmarkMatrixOptions(args)
  const output = await runBenchmarkRecipeMatrix(options)
  if (!options.json) {
    printBenchmarkMatrixHumanOutput(output)
    return output.diagnostics.length === 0 ? 0 : 1
  }

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  return output.diagnostics.length === 0 ? 0 : 1
}

export async function runArtifactsBenchResultsCommand(args: string[]): Promise<number> {
  const options = parseBenchmarkSummaryOptions(args, { requireBundle: true })
  const output = await summarizeBenchmarks(options)
  if (!options.json) {
    printBenchmarkSummaryHumanOutput(output)
    return 0
  }

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  return 0
}

async function summarizeBenchmarks(options: BenchmarkSummaryOptions): Promise<BenchmarkSummaryOutput> {
  if (options.inputPath) {
    const inputPath = resolve(options.inputPath)
    const parsed = JSON.parse(await readFile(inputPath, "utf8")) as unknown
    return benchmarkSummaryOutput({ type: "recipe-run-output", path: inputPath }, extractBenchResultsFromRecipeRun(parsed))
  }

  if (options.bundleDirectory) {
    const bundleDirectory = resolve(options.bundleDirectory)
    const commandsLog = await readFile(join(bundleDirectory, "logs", "commands.log"), "utf8").catch((error: unknown) => {
      if (isRecord(error) && error.code === "ENOENT") {
        return ""
      }
      throw error
    })
    return benchmarkSummaryOutput({ type: "artifact-bundle", path: bundleDirectory }, extractBenchResultsFromText(commandsLog))
  }

  throw new Error("Missing required option: --input or --bundle")
}

async function runBenchmarkRecipeMatrix(options: BenchmarkMatrixOptions): Promise<BenchmarkMatrixRunOutput> {
  const matrixPath = resolve(options.matrixPath)
  const matrixDirectory = dirname(matrixPath)
  const definition = JSON.parse(await readFile(matrixPath, "utf8")) as BenchmarkRecipeMatrixDefinition
  const configuredRecipePath = options.recipePath ?? definition.recipe
  if (!configuredRecipePath) {
    throw new Error("Benchmark matrix requires --recipe or recipe in the matrix definition")
  }
  const recipePath = resolve(matrixDirectory, configuredRecipePath)

  const baseRecipe = JSON.parse(await readFile(recipePath, "utf8")) as Record<string, unknown>
  const dimensions = Array.isArray(definition.dimensions) ? definition.dimensions : []
  const matrix = expandBenchmarkMatrix(dimensions)
  const artifactsDirectory = resolve(matrixDirectory, options.artifactsDirectory ?? artifactsDirectoryFromDefinition(definition) ?? "artifacts/benchmark-matrix")
  const cells: BenchmarkMatrixCellResult[] = []
  if (matrix.diagnostics.length > 0) {
    return {
      schema: "wp-codebox/benchmark-matrix-run/v1",
      source: { matrixPath, recipePath },
      matrix,
      cells,
      benchResults: [],
      diagnostics: matrix.diagnostics.map((diagnostic) => ({
        type: "cell-failed",
        severity: diagnostic.severity,
        cellId: "matrix-expansion",
        code: diagnostic.type,
        message: diagnostic.message,
      })),
      provenance: {
        generated_at: new Date().toISOString(),
        command: "bench matrix",
        ...(definition.metadata ? { definition: { metadata: definition.metadata } } : {}),
      },
    }
  }

  for (const cell of matrix.cells) {
    const cellDirectory = join(artifactsDirectory, safeCellDirectoryName(cell.id))
    const cellArtifactsDirectory = join(cellDirectory, "artifacts")
    const cellRecipePath = join(cellDirectory, "recipe.json")
    const recipe = applyCellRecipePatches(baseRecipe, cell)
    await mkdir(cellArtifactsDirectory, { recursive: true })
    await writeFile(cellRecipePath, `${JSON.stringify(recipe, null, 2)}\n`)

    const recipeRun = await runRecipeRunForMatrixCell({
      recipePath: cellRecipePath,
      artifactsDirectory: cellArtifactsDirectory,
      runRegistryDirectory: options.runRegistryDirectory ?? definition.runRegistry,
      timeout: options.timeout ?? definition.timeout,
    })
    await writeFile(join(cellDirectory, "recipe-run.json"), `${recipeRun.stdout}\n`)

    if (recipeRun.status === 0 && isRecord(recipeRun.output) && recipeRun.output.success === true) {
      const benchResultsList = extractBenchResultsFromRecipeRun(recipeRun.output)
      cells.push({
        ...createBenchmarkMatrixCellResults(cell, benchResultsList as BenchmarkResultEnvelope[]),
        diagnostics: benchResultsList.length > 0 ? [] : [{
          type: "cell-failed",
          severity: "error",
          cellId: cell.id,
          code: "missing-bench-results",
          message: `Benchmark matrix cell "${cell.id}" completed without benchResults.`,
        }],
        ...(benchResultsList.length === 0 ? { status: "failed" as const } : {}),
      })
      continue
    }

    cells.push(createBenchmarkMatrixCellFailure(cell, recipeRunFailure(recipeRun)))
  }

  return {
    schema: "wp-codebox/benchmark-matrix-run/v1",
    source: { matrixPath, recipePath },
    matrix,
    cells,
    benchResults: cells
      .filter((cell): cell is BenchmarkMatrixCellResult & { benchResultsList: BenchResults[] } => cell.status === "succeeded" && Array.isArray(cell.benchResultsList))
      .map((cell) => ({ cellId: cell.cell.id, cell: cell.cell, results: cell.benchResultsList })),
    diagnostics: cells.flatMap((cell) => cell.diagnostics),
    provenance: {
      generated_at: new Date().toISOString(),
      command: "bench matrix",
      ...(definition.metadata ? { definition: { metadata: definition.metadata } } : {}),
    },
  }
}

function benchmarkSummaryOutput(source: BenchmarkSummaryOutput["source"], benchmarks: BenchResults[]): BenchmarkSummaryOutput {
  const scenarios = benchmarks.flatMap((benchmark) => benchmarkScenarioSummaries(benchmark))
  return {
    schema: "wp-codebox/benchmark-summary/v1",
    source,
    hasBenchResults: benchmarks.length > 0,
    benchmarkCount: benchmarks.length,
    scenarioCount: scenarios.length,
    benchmarks,
    scenarios,
  }
}

function extractBenchResultsFromRecipeRun(value: unknown): BenchResults[] {
  if (!isRecord(value)) {
    return []
  }

  if (Array.isArray(value.benchResultsList)) {
    return value.benchResultsList.filter(isBenchResults)
  }

  if (isBenchResults(value.benchResults)) {
    return [value.benchResults]
  }

  return []
}

function extractBenchResultsFromText(text: string): BenchResults[] {
  const results: BenchResults[] = []
  for (const jsonObject of jsonObjectsInText(text)) {
    const parsed = parseJsonObject(jsonObject)
    if (isBenchResults(parsed)) {
      results.push(parsed)
    }
  }
  return results
}

function* jsonObjectsInText(text: string): Generator<string> {
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = 0; index < text.length; index++) {
    const char = text[index]

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === "\\") {
        escaped = true
      } else if (char === "\"") {
        inString = false
      }
      continue
    }

    if (char === "\"") {
      inString = true
      continue
    }

    if (char === "{") {
      if (depth === 0) {
        start = index
      }
      depth += 1
      continue
    }

    if (char === "}" && depth > 0) {
      depth -= 1
      if (depth === 0 && start >= 0) {
        yield text.slice(start, index + 1)
        start = -1
      }
    }
  }
}

function parseJsonObject(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function isBenchResults(value: unknown): value is BenchResults {
  return isRecord(value) && Array.isArray(value.scenarios) && typeof value.component_id === "string"
}

function benchmarkScenarioSummaries(benchmark: BenchResults): BenchmarkScenarioSummary[] {
  const componentId = typeof benchmark.component_id === "string" ? benchmark.component_id : "unknown"
  return (benchmark.scenarios ?? []).filter(isRecord).map((scenario, index) => {
    const metrics = numericRecord(scenario.metrics)
    return {
      componentId,
      id: typeof scenario.id === "string" ? scenario.id : `scenario-${index + 1}`,
      ...(typeof scenario.source === "string" ? { source: scenario.source } : {}),
      ...(typeof scenario.iterations === "number" && Number.isFinite(scenario.iterations) ? { iterations: scenario.iterations } : {}),
      metricCount: Object.keys(metrics).length,
      metrics,
      artifacts: isRecord(scenario.artifacts) ? scenario.artifacts : {},
    }
  })
}

function numericRecord(value: unknown): Record<string, number> {
  if (!isRecord(value)) {
    return {}
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]))
      .sort(([left], [right]) => left.localeCompare(right)),
  )
}

function printBenchmarkSummaryHumanOutput(output: BenchmarkSummaryOutput): void {
  console.log("WP Codebox benchmark summary")
  console.log(`Source: ${output.source.path}`)
  console.log(`Benchmarks: ${output.benchmarkCount}`)
  console.log(`Scenarios: ${output.scenarioCount}`)

  if (output.scenarios.length === 0) {
    return
  }

  console.log("Scenarios:")
  for (const scenario of output.scenarios) {
    console.log(`  ${scenario.componentId}/${scenario.id}: ${scenario.metricCount} metrics`)
  }
}

function printBenchmarkMatrixHumanOutput(output: BenchmarkMatrixRunOutput): void {
  console.log("WP Codebox benchmark matrix")
  console.log(`Recipe: ${output.source.recipePath}`)
  console.log(`Cells: ${output.cells.length}`)
  console.log(`Succeeded: ${output.cells.filter((cell) => cell.status === "succeeded").length}`)
  console.log(`Failed: ${output.cells.filter((cell) => cell.status === "failed").length}`)
}

function parseBenchmarkSummaryOptions(args: string[], config: { requireBundle?: boolean } = {}): BenchmarkSummaryOptions {
  const options: Partial<BenchmarkSummaryOptions> = { json: false }

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]

    if (arg === "--json") {
      options.json = true
      continue
    }

    const [name, inlineValue] = arg.split("=", 2)
    const value = inlineValue ?? args[++index]

    if (!name.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument: ${arg}`)
    }

    switch (name) {
      case "--input":
        options.inputPath = value
        break
      case "--bundle":
      case "--artifacts":
        options.bundleDirectory = value
        break
      default:
        throw new Error(`Unknown option: ${name}`)
    }
  }

  if (config.requireBundle && !options.bundleDirectory) {
    throw new Error("Missing required option: --bundle")
  }

  if (config.requireBundle && options.inputPath) {
    throw new Error("artifacts bench-results only accepts --bundle")
  }

  if (!config.requireBundle && !options.inputPath && !options.bundleDirectory) {
    throw new Error("Missing required option: --input or --bundle")
  }

  return options as BenchmarkSummaryOptions
}

function parseBenchmarkMatrixOptions(args: string[]): BenchmarkMatrixOptions {
  const options: Partial<BenchmarkMatrixOptions> = { json: false }

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === "--json") {
      options.json = true
      continue
    }

    const [name, inlineValue] = arg.split("=", 2)
    const value = inlineValue ?? args[++index]
    if (!name.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument: ${arg}`)
    }

    switch (name) {
      case "--matrix":
        options.matrixPath = value
        break
      case "--recipe":
        options.recipePath = value
        break
      case "--artifacts":
        options.artifactsDirectory = value
        break
      case "--run-registry":
        options.runRegistryDirectory = value
        break
      case "--timeout":
        options.timeout = value
        break
      default:
        throw new Error(`Unknown option: ${name}`)
    }
  }

  if (!options.matrixPath) {
    throw new Error("bench matrix requires --matrix <path>")
  }

  return options as BenchmarkMatrixOptions
}

async function runRecipeRunForMatrixCell(options: { recipePath: string; artifactsDirectory: string; runRegistryDirectory?: string; timeout?: string }): Promise<{ status: number; stdout: string; stderr: string; output: unknown }> {
  const args = [process.argv[1] ?? "", "recipe-run", "--recipe", options.recipePath, "--artifacts", options.artifactsDirectory, "--json"]
  if (options.runRegistryDirectory) {
    args.push("--run-registry", options.runRegistryDirectory)
  }
  if (options.timeout) {
    args.push("--timeout", options.timeout)
  }

  const result = await new Promise<{ status: number; stdout: string; stderr: string }>((resolveResult, reject) => {
    const child = spawn(process.execPath, args)
    let stdout = ""
    let stderr = ""
    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => { stdout += chunk })
    child.stderr?.on("data", (chunk: string) => { stderr += chunk })
    child.once("error", reject)
    child.once("close", (status) => resolveResult({ status: status ?? 1, stdout, stderr }))
  })

  return { ...result, output: parseJsonObject(result.stdout) }
}

function applyCellRecipePatches(baseRecipe: Record<string, unknown>, cell: BenchmarkMatrixCell): Record<string, unknown> {
  return Object.values(cell.dimensions).reduce((recipe, dimensionValue) => {
    const patch = isRecord(dimensionValue.value) && isRecord(dimensionValue.value.recipe) ? dimensionValue.value.recipe : undefined
    return patch ? deepMerge(recipe, patch) : recipe
  }, deepClone(baseRecipe) as Record<string, unknown>)
}

function deepMerge(left: Record<string, unknown>, right: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...left }
  for (const [key, value] of Object.entries(right)) {
    merged[key] = isRecord(value) && isRecord(merged[key]) ? deepMerge(merged[key], value) : value
  }
  return merged
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function artifactsDirectoryFromDefinition(definition: BenchmarkRecipeMatrixDefinition): string | undefined {
  return typeof definition.artifacts === "string" ? definition.artifacts : definition.artifacts?.directory
}

function safeCellDirectoryName(cellId: string): string {
  return cellId.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "cell"
}

function recipeRunFailure(recipeRun: { status: number; stderr: string; output: unknown }): Error & { code?: string } {
  const error = new Error(recipeRunErrorMessage(recipeRun)) as Error & { code?: string }
  error.code = isRecord(recipeRun.output) && isRecord(recipeRun.output.error) && typeof recipeRun.output.error.code === "string" ? recipeRun.output.error.code : `recipe-run-exit-${recipeRun.status}`
  return error
}

function recipeRunErrorMessage(recipeRun: { status: number; stderr: string; output: unknown }): string {
  if (isRecord(recipeRun.output) && isRecord(recipeRun.output.error) && typeof recipeRun.output.error.message === "string") {
    return recipeRun.output.error.message
  }
  return recipeRun.stderr.trim() || `recipe-run exited with status ${recipeRun.status}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
