import { copyFile, mkdir, readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { verifyArtifactBundle, type ArtifactBundleVerificationResult } from "@automattic/wp-codebox-core"
import { browserArtifactMetrics, type BrowserArtifactMetricsResult } from "@automattic/wp-codebox-playground"
import { printArtifactVerifyHumanOutput } from "../output.js"

interface ArtifactVerifyOptions {
  bundleDirectory: string
  json: boolean
}

interface BenchmarkArtifactsOptions extends ArtifactVerifyOptions {
  scenarioId?: string
  copyTo?: string
}

interface BenchmarkArtifactRef {
  path: string
  kind: string
  contentType?: string
  sha256?: { algorithm: "sha256"; value: string }
  source?: string
  name?: string
  metric?: string
  sampleIndex?: number
}

interface BenchmarkArtifactsOutput {
  schema: "wp-codebox/benchmark-artifacts/v1"
  artifactBundle?: Record<string, unknown>
  scenarioId?: string
  scenarios: Array<{
    componentId?: string
    scenarioId?: string
    source?: string
    artifactRefs: BenchmarkArtifactRef[]
  }>
  artifactRefs: BenchmarkArtifactRef[]
  copied?: Array<{ from: string; to: string }>
}

export async function runArtifactsVerifyCommand(args: string[]): Promise<number> {
  const options = parseArtifactVerifyOptions(args)
  const output = await verifyArtifacts(options)
  if (!options.json) {
    printArtifactVerifyHumanOutput(output)
    return output.valid ? 0 : 1
  }

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  return output.valid ? 0 : 1
}

export async function runArtifactsBrowserMetricsCommand(args: string[]): Promise<number> {
  const options = parseArtifactBrowserMetricsOptions(args)
  const output = await browserMetrics(options)
  if (!options.json) {
    printArtifactBrowserMetricsHumanOutput(output)
    return 0
  }

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  return 0
}

export async function runArtifactsBenchmarkCommand(args: string[]): Promise<number> {
  const options = parseBenchmarkArtifactsOptions(args)
  const output = await benchmarkArtifacts(options)
  if (!options.json) {
    printBenchmarkArtifactsHumanOutput(output)
    return 0
  }

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  return 0
}

async function verifyArtifacts(options: ArtifactVerifyOptions): Promise<ArtifactBundleVerificationResult> {
  return verifyArtifactBundle(resolve(options.bundleDirectory))
}

async function browserMetrics(options: ArtifactVerifyOptions): Promise<BrowserArtifactMetricsResult> {
  return browserArtifactMetrics(resolve(options.bundleDirectory))
}

async function benchmarkArtifacts(options: BenchmarkArtifactsOptions): Promise<BenchmarkArtifactsOutput> {
  const bundleDirectory = resolve(options.bundleDirectory)
  const raw = JSON.parse(await readFile(join(bundleDirectory, "files", "bench-results.json"), "utf8")) as BenchmarkArtifactsOutput
  const scenarios = (raw.scenarios ?? []).filter((scenario) => !options.scenarioId || scenario.scenarioId === options.scenarioId)
  const artifactRefs = dedupeBenchmarkArtifactRefs(scenarios.flatMap((scenario) => scenario.artifactRefs ?? []))
  const output: BenchmarkArtifactsOutput = {
    schema: "wp-codebox/benchmark-artifacts/v1",
    artifactBundle: raw.artifactBundle,
    ...(options.scenarioId ? { scenarioId: options.scenarioId } : {}),
    scenarios,
    artifactRefs,
  }
  if (options.copyTo) {
    output.copied = await copyBenchmarkArtifactRefs(bundleDirectory, resolve(options.copyTo), artifactRefs)
  }

  return output
}

function parseArtifactBrowserMetricsOptions(args: string[]): ArtifactVerifyOptions {
  return parseArtifactVerifyOptions(args)
}

function parseBenchmarkArtifactsOptions(args: string[]): BenchmarkArtifactsOptions {
  const options: Partial<BenchmarkArtifactsOptions> = { json: false }
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
      case "--bundle":
      case "--artifacts":
        options.bundleDirectory = value
        break
      case "--scenario-id":
        options.scenarioId = value
        break
      case "--copy-to":
      case "--extract-to":
        options.copyTo = value
        break
      default:
        throw new Error(`Unknown option: ${name}`)
    }
  }

  if (!options.bundleDirectory) {
    throw new Error("Missing required option: --bundle")
  }

  return options as BenchmarkArtifactsOptions
}

function printArtifactBrowserMetricsHumanOutput(output: BrowserArtifactMetricsResult): void {
  console.log("WP Codebox browser metrics")
  console.log(`Bundle: ${output.bundleDirectory}`)
  console.log(`Browser metrics: ${output.hasBrowserMetrics ? "yes" : "no"}`)
  if (Object.keys(output.metrics).length > 0) {
    console.log("Metrics:")
    for (const [name, value] of Object.entries(output.metrics).sort(([left], [right]) => left.localeCompare(right))) {
      console.log(`  ${name}: ${value}`)
    }
  }
  if (Object.keys(output.artifacts).length > 0) {
    console.log("Artifacts:")
    for (const [name, artifact] of Object.entries(output.artifacts).sort(([left], [right]) => left.localeCompare(right))) {
      console.log(`  ${name}: ${artifact.path}`)
    }
  }
}

function printBenchmarkArtifactsHumanOutput(output: BenchmarkArtifactsOutput): void {
  console.log("WP Codebox benchmark artifacts")
  if (output.scenarioId) {
    console.log(`Scenario: ${output.scenarioId}`)
  }
  console.log(`Scenarios: ${output.scenarios.length}`)
  console.log(`Artifact refs: ${output.artifactRefs.length}`)
  for (const scenario of output.scenarios) {
    console.log(`  ${scenario.scenarioId ?? "unknown"}: ${(scenario.artifactRefs ?? []).length} artifact ref${(scenario.artifactRefs ?? []).length === 1 ? "" : "s"}`)
    for (const ref of scenario.artifactRefs ?? []) {
      console.log(`    ${ref.path} (${ref.kind})`)
    }
  }
  if (output.copied && output.copied.length > 0) {
    console.log("Copied:")
    for (const copy of output.copied) {
      console.log(`  ${copy.from} -> ${copy.to}`)
    }
  }
}

async function copyBenchmarkArtifactRefs(bundleDirectory: string, targetDirectory: string, refs: BenchmarkArtifactRef[]): Promise<Array<{ from: string; to: string }>> {
  const copied: Array<{ from: string; to: string }> = []
  for (const ref of refs) {
    if (!ref.path || ref.path === "files/bench-results.json") {
      continue
    }
    const from = join(bundleDirectory, ref.path)
    const to = join(targetDirectory, ref.path)
    await mkdir(dirname(to), { recursive: true })
    try {
      await copyFile(from, to)
      copied.push({ from: ref.path, to })
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error
      }
    }
  }

  return copied
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

function dedupeBenchmarkArtifactRefs(refs: BenchmarkArtifactRef[]): BenchmarkArtifactRef[] {
  const seen = new Set<string>()
  const deduped: BenchmarkArtifactRef[] = []
  for (const ref of refs) {
    const key = `${ref.path}:${ref.source ?? ""}:${ref.name ?? ""}:${ref.metric ?? ""}:${ref.sampleIndex ?? ""}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    deduped.push(ref)
  }

  return deduped
}

function parseArtifactVerifyOptions(args: string[]): ArtifactVerifyOptions {
  const options: Partial<ArtifactVerifyOptions> = { json: false }

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
      case "--bundle":
      case "--artifacts":
        options.bundleDirectory = value
        break
      default:
        throw new Error(`Unknown option: ${name}`)
    }
  }

  if (!options.bundleDirectory) {
    throw new Error("Missing required option: --bundle")
  }

  return options as ArtifactVerifyOptions
}
