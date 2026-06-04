import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"

interface BenchmarkSummaryOptions {
  inputPath?: string
  bundleDirectory?: string
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
