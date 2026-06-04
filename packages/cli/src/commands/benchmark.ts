import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { compareBenchmarkResults, type BenchmarkComparison, type BenchmarkResultEnvelope, type BenchmarkRunRef, type BenchmarkScenarioResult } from "@automattic/wp-codebox-core"

interface BenchmarkSummaryOptions {
  inputPath?: string
  bundleDirectory?: string
  json: boolean
}

interface BenchmarkCompareOptions {
  baselineInputPath?: string
  candidateInputPath?: string
  baselineBundleDirectory?: string
  candidateBundleDirectory?: string
  baselineIndex?: number
  candidateIndex?: number
  json: boolean
}

interface BenchResults extends BenchmarkResultEnvelope {
  component_id?: string
  iterations?: number
  warmup_iterations?: number
  scenarios?: BenchmarkScenarioResult[]
  [key: string]: unknown
}

interface BenchmarkSourceRef {
  type: "recipe-run-output" | "artifact-bundle"
  path: string
  benchmarkIndex: number
}

interface BenchmarkCompareOutput extends BenchmarkComparison {
  source: {
    baseline: BenchmarkSourceRef
    candidate: BenchmarkSourceRef
  }
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

export async function runBenchCompareCommand(args: string[]): Promise<number> {
  const options = parseBenchmarkCompareOptions(args)
  const output = await compareBenchmarks(options)
  if (!options.json) {
    printBenchmarkCompareHumanOutput(output)
    return 0
  }

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  return 0
}

export async function runArtifactsBenchCompareCommand(args: string[]): Promise<number> {
  const options = parseBenchmarkCompareOptions(args, { requireBundles: true })
  const output = await compareBenchmarks(options)
  if (!options.json) {
    printBenchmarkCompareHumanOutput(output)
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
    const commandsLog = await readArtifactBundleCommandsLog(bundleDirectory)
    return benchmarkSummaryOutput({ type: "artifact-bundle", path: bundleDirectory }, extractBenchResultsFromText(commandsLog))
  }

  throw new Error("Missing required option: --input or --bundle")
}

async function compareBenchmarks(options: BenchmarkCompareOptions): Promise<BenchmarkCompareOutput> {
  const baseline = await loadBenchmarkForComparison("baseline", options)
  const candidate = await loadBenchmarkForComparison("candidate", options)
  return {
    ...compareBenchmarkResults(baseline.benchmark, candidate.benchmark, {
      baseline: benchmarkRunRef(baseline.source),
      candidate: benchmarkRunRef(candidate.source),
    }),
    source: {
      baseline: baseline.source,
      candidate: candidate.source,
    },
  }
}

async function loadBenchmarkForComparison(kind: "baseline" | "candidate", options: BenchmarkCompareOptions): Promise<{ source: BenchmarkSourceRef; benchmark: BenchResults }> {
  const inputPath = kind === "baseline" ? options.baselineInputPath : options.candidateInputPath
  const bundleDirectory = kind === "baseline" ? options.baselineBundleDirectory : options.candidateBundleDirectory
  const benchmarkIndex = kind === "baseline" ? options.baselineIndex ?? 0 : options.candidateIndex ?? 0

  if (inputPath) {
    const resolvedPath = resolve(inputPath)
    const parsed = JSON.parse(await readFile(resolvedPath, "utf8")) as unknown
    return selectBenchmark(kind, { type: "recipe-run-output", path: resolvedPath, benchmarkIndex }, extractBenchResultsFromRecipeRun(parsed))
  }

  if (bundleDirectory) {
    const resolvedDirectory = resolve(bundleDirectory)
    const commandsLog = await readArtifactBundleCommandsLog(resolvedDirectory)
    return selectBenchmark(kind, { type: "artifact-bundle", path: resolvedDirectory, benchmarkIndex }, extractBenchResultsFromText(commandsLog))
  }

  throw new Error(`Missing required ${kind} source: use --${kind}-input or --${kind}-bundle`)
}

function selectBenchmark(kind: "baseline" | "candidate", source: BenchmarkSourceRef, benchmarks: BenchResults[]): { source: BenchmarkSourceRef; benchmark: BenchResults } {
  const benchmark = benchmarks[source.benchmarkIndex]
  if (!benchmark) {
    throw new Error(`No ${kind} benchResults envelope found at index ${source.benchmarkIndex} in ${source.path}.`)
  }
  return { source, benchmark }
}

function benchmarkRunRef(source: BenchmarkSourceRef): BenchmarkRunRef {
  return {
    label: source.type,
    artifactRef: source.path,
    provenance: {
      sourceType: source.type,
      path: source.path,
      benchmarkIndex: source.benchmarkIndex,
    },
  }
}

async function readArtifactBundleCommandsLog(bundleDirectory: string): Promise<string> {
  return readFile(join(bundleDirectory, "logs", "commands.log"), "utf8").catch((error: unknown) => {
    if (isRecord(error) && error.code === "ENOENT") {
      return ""
    }
    throw error
  })
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
      .map(([key, metric]) => [key, numericMetricValue(metric)] as const)
      .filter((entry): entry is readonly [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]))
      .sort(([left], [right]) => left.localeCompare(right)),
  )
}

function numericMetricValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }
  if (isRecord(value) && isRecord(value.samples) && typeof value.samples.mean === "number" && Number.isFinite(value.samples.mean)) {
    return value.samples.mean
  }
  return undefined
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

function printBenchmarkCompareHumanOutput(output: BenchmarkCompareOutput): void {
  console.log("WP Codebox benchmark comparison")
  console.log(`Baseline: ${output.source.baseline.path}`)
  console.log(`Candidate: ${output.source.candidate.path}`)
  console.log(`Scenarios compared: ${output.pairs.length}`)
  console.log(`Diagnostics: ${output.diagnostics.length}`)

  for (const pair of output.pairs) {
    console.log(`  ${pair.scenarioId}: ${pair.metrics.length} metric delta${pair.metrics.length === 1 ? "" : "s"}`)
    for (const metric of pair.metrics) {
      const percent = metric.percentDelta === undefined ? "n/a" : `${metric.percentDelta.toFixed(2)}%`
      console.log(`    ${metric.metricId}: ${metric.baseline} -> ${metric.candidate} (${metric.absoluteDelta >= 0 ? "+" : ""}${metric.absoluteDelta}, ${percent})`)
    }
  }
}

function parseBenchmarkCompareOptions(args: string[], config: { requireBundles?: boolean } = {}): BenchmarkCompareOptions {
  const options: Partial<BenchmarkCompareOptions> = { json: false }

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
      case "--baseline":
      case "--baseline-input":
        options.baselineInputPath = value
        break
      case "--candidate":
      case "--candidate-input":
        options.candidateInputPath = value
        break
      case "--baseline-bundle":
      case "--baseline-artifacts":
        options.baselineBundleDirectory = value
        break
      case "--candidate-bundle":
      case "--candidate-artifacts":
        options.candidateBundleDirectory = value
        break
      case "--baseline-index":
        options.baselineIndex = parseBenchmarkIndex(value, name)
        break
      case "--candidate-index":
        options.candidateIndex = parseBenchmarkIndex(value, name)
        break
      default:
        throw new Error(`Unknown option: ${name}`)
    }
  }

  if (config.requireBundles && (options.baselineInputPath || options.candidateInputPath)) {
    throw new Error("Use --baseline-bundle and --candidate-bundle with artifacts bench-compare")
  }
  if (config.requireBundles && (!options.baselineBundleDirectory || !options.candidateBundleDirectory)) {
    throw new Error("Missing required options: --baseline-bundle and --candidate-bundle")
  }
  if (!config.requireBundles && !options.baselineInputPath && !options.baselineBundleDirectory) {
    throw new Error("Missing required option: --baseline-input or --baseline-bundle")
  }
  if (!config.requireBundles && !options.candidateInputPath && !options.candidateBundleDirectory) {
    throw new Error("Missing required option: --candidate-input or --candidate-bundle")
  }

  return options as BenchmarkCompareOptions
}

function parseBenchmarkIndex(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`)
  }
  return parsed
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
