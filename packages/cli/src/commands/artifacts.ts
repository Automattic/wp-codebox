import { copyFile, mkdir, readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { buildTransferProbeDiagnostics, verifyTransferProofBundle, type TransferProbeDiagnosticsResult, type TransferProofBundleVerificationResult } from "@automattic/wp-codebox-core"
import { buildArtifactDiagnostics, buildReviewerArtifactExportLinks, discoverPartialRunArtifacts, preflightArtifactBundleApply, verifyArtifactBundle, type ArtifactBundleApplyPreflightResult, type ArtifactBundleVerificationResult, type ArtifactDiagnosticNormalizerOptions, type ArtifactDiagnostics, type PartialArtifactDiscoveryResult, type ReviewerArtifactExportLinks } from "@automattic/wp-codebox-core/artifacts"
import { browserArtifactMetrics, type BrowserArtifactMetricsResult } from "@automattic/wp-codebox-playground"
import { printArtifactVerifyHumanOutput } from "../output.js"

interface ArtifactVerifyOptions {
  bundleDirectory: string
  json: boolean
}

interface ArtifactApplyPreflightOptions extends ArtifactVerifyOptions {
  approvedFiles: string[]
}

interface BenchmarkArtifactsOptions extends ArtifactVerifyOptions {
  scenarioId?: string
  copyTo?: string
}

interface ArtifactDiscoverPartialOptions {
  artifactsRoot: string
  sessionId?: string
  startedAt?: string
  finishedAt?: string
  json: boolean
}

interface ArtifactDiagnosticsOptions extends ArtifactDiagnosticNormalizerOptions {
  inputFile: string
  json: boolean
}

interface ArtifactExportLinksOptions {
  bundleDirectory: string
  baseUrl: string
  includeKinds: string[]
  includePaths: string[]
  json: boolean
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

export async function runArtifactsApplyPreflightCommand(args: string[]): Promise<number> {
  const options = parseArtifactApplyPreflightOptions(args)
  const output = await applyPreflight(options)
  if (!options.json) {
    printArtifactApplyPreflightHumanOutput(output)
    return output.ready ? 0 : 1
  }

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  return output.ready ? 0 : 1
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

export async function runArtifactsTransferVerifyCommand(args: string[]): Promise<number> {
  const options = parseArtifactVerifyOptions(args)
  const output = await transferVerify(options)
  if (!options.json) {
    printArtifactTransferVerifyHumanOutput(output)
    return output.valid ? 0 : 1
  }

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  return output.valid ? 0 : 1
}

export async function runArtifactsTransferProbesCommand(args: string[]): Promise<number> {
  const options = parseArtifactVerifyOptions(args)
  const output = await transferProbes(options)
  if (!options.json) {
    printArtifactTransferProbesHumanOutput(output)
    return output.status === "passed" ? 0 : 1
  }

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  return output.status === "passed" ? 0 : 1
}

export async function runArtifactsExportLinksCommand(args: string[]): Promise<number> {
  const options = parseArtifactExportLinksOptions(args)
  const output = await exportLinks(options)
  if (!options.json) {
    printArtifactExportLinksHumanOutput(output)
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

export async function runArtifactsDiscoverPartialCommand(args: string[]): Promise<number> {
  const options = parseArtifactDiscoverPartialOptions(args)
  const output = await discoverPartialArtifacts(options)
  if (!options.json) {
    printArtifactDiscoverPartialHumanOutput(output)
    return 0
  }

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  return 0
}

export async function runArtifactsDiagnosticsCommand(args: string[]): Promise<number> {
  const options = parseArtifactDiagnosticsOptions(args)
  const output = await normalizeDiagnostics(options)
  if (!options.json) {
    printArtifactDiagnosticsHumanOutput(output)
    return 0
  }

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  return 0
}

async function verifyArtifacts(options: ArtifactVerifyOptions): Promise<ArtifactBundleVerificationResult> {
  return verifyArtifactBundle(resolve(options.bundleDirectory))
}

async function applyPreflight(options: ArtifactApplyPreflightOptions): Promise<ArtifactBundleApplyPreflightResult> {
  return preflightArtifactBundleApply(resolve(options.bundleDirectory), { approvedFiles: options.approvedFiles })
}

async function browserMetrics(options: ArtifactVerifyOptions): Promise<BrowserArtifactMetricsResult> {
  return browserArtifactMetrics(resolve(options.bundleDirectory))
}

async function transferVerify(options: ArtifactVerifyOptions): Promise<TransferProofBundleVerificationResult> {
  return verifyTransferProofBundle(resolve(options.bundleDirectory))
}

async function transferProbes(options: ArtifactVerifyOptions): Promise<TransferProbeDiagnosticsResult> {
  return buildTransferProbeDiagnostics(resolve(options.bundleDirectory))
}

async function exportLinks(options: ArtifactExportLinksOptions): Promise<ReviewerArtifactExportLinks> {
  return buildReviewerArtifactExportLinks(resolve(options.bundleDirectory), {
    baseUrl: options.baseUrl,
    includeKinds: options.includeKinds,
    includePaths: options.includePaths,
  })
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

async function discoverPartialArtifacts(options: ArtifactDiscoverPartialOptions): Promise<PartialArtifactDiscoveryResult> {
  return discoverPartialRunArtifacts({
    artifactsRoot: resolve(options.artifactsRoot),
    sessionId: options.sessionId,
    startedAt: options.startedAt,
    finishedAt: options.finishedAt,
  })
}

async function normalizeDiagnostics(options: ArtifactDiagnosticsOptions): Promise<ArtifactDiagnostics> {
  const input = JSON.parse(await readFile(resolve(options.inputFile), "utf8")) as unknown
  return buildArtifactDiagnostics(input, {
    source: options.source,
    stage: options.stage,
    observationType: options.observationType,
    refs: options.refs,
  })
}

function parseArtifactDiagnosticsOptions(args: string[]): ArtifactDiagnosticsOptions {
  const options: Partial<ArtifactDiagnosticsOptions> = { json: false, refs: [] }
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
      case "--observations":
      case "--diagnostics":
      case "--import-report":
        options.inputFile = value
        break
      case "--source":
        options.source = value
        break
      case "--stage":
        options.stage = value
        break
      case "--observation-type":
        options.observationType = value
        break
      case "--ref":
        options.refs?.push(parseDiagnosticRef(value))
        break
      default:
        throw new Error(`Unknown option: ${name}`)
    }
  }

  if (!options.inputFile) {
    throw new Error("Missing required option: --input")
  }

  return options as ArtifactDiagnosticsOptions
}

function parseDiagnosticRef(value: string): NonNullable<ArtifactDiagnosticNormalizerOptions["refs"]>[number] {
  const [path, kind] = value.split(":", 2)
  return { path, ...(kind ? { kind } : {}) }
}

function parseArtifactDiscoverPartialOptions(args: string[]): ArtifactDiscoverPartialOptions {
  const options: Partial<ArtifactDiscoverPartialOptions> = { json: false }
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
      case "--artifacts":
      case "--artifacts-root":
        options.artifactsRoot = value
        break
      case "--session-id":
        options.sessionId = value
        break
      case "--started-at":
        options.startedAt = value
        break
      case "--finished-at":
        options.finishedAt = value
        break
      default:
        throw new Error(`Unknown option: ${name}`)
    }
  }

  if (!options.artifactsRoot) {
    throw new Error("Missing required option: --artifacts")
  }

  return options as ArtifactDiscoverPartialOptions
}

function parseArtifactExportLinksOptions(args: string[]): ArtifactExportLinksOptions {
  const options: Partial<ArtifactExportLinksOptions> = { json: false, includeKinds: [], includePaths: [] }

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
      case "--base-url":
      case "--url-base":
        options.baseUrl = value
        break
      case "--kind":
      case "--include-kind":
        options.includeKinds?.push(value)
        break
      case "--path":
      case "--include-path":
        options.includePaths?.push(value)
        break
      default:
        throw new Error(`Unknown option: ${name}`)
    }
  }

  if (!options.bundleDirectory) {
    throw new Error("Missing required option: --bundle")
  }
  if (!options.baseUrl) {
    throw new Error("Missing required option: --base-url")
  }

  return options as ArtifactExportLinksOptions
}

function parseArtifactBrowserMetricsOptions(args: string[]): ArtifactVerifyOptions {
  return parseArtifactVerifyOptions(args)
}

function parseArtifactApplyPreflightOptions(args: string[]): ArtifactApplyPreflightOptions {
  const options: Partial<ArtifactApplyPreflightOptions> = { json: false, approvedFiles: [] }

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
      case "--approved-file":
        options.approvedFiles?.push(value)
        break
      case "--approved-files":
        options.approvedFiles?.push(...value.split(","))
        break
      default:
        throw new Error(`Unknown option: ${name}`)
    }
  }

  if (!options.bundleDirectory) {
    throw new Error("Missing required option: --bundle")
  }

  return options as ArtifactApplyPreflightOptions
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

function printArtifactTransferVerifyHumanOutput(output: TransferProofBundleVerificationResult): void {
  console.log("WP Codebox transfer proof verification")
  console.log(`Bundle: ${output.bundleDirectory}`)
  console.log(`Valid: ${output.valid ? "yes" : "no"}`)
  console.log(`Transfer violations: ${output.violations.length}`)
  console.log(`Probe diagnostics: ${output.diagnostics.summary.errors} error(s), ${output.diagnostics.summary.warnings} warning(s)`)
  for (const violation of output.violations) {
    console.log(`- ${violation.code}: ${violation.message}`)
  }
}

function printArtifactTransferProbesHumanOutput(output: TransferProbeDiagnosticsResult): void {
  console.log("WP Codebox transfer probe diagnostics")
  console.log(`Bundle: ${output.bundleDirectory}`)
  console.log(`Status: ${output.status}`)
  console.log(`Diagnostics: ${output.summary.total} (${output.summary.errors} error(s), ${output.summary.warnings} warning(s))`)
  for (const diagnostic of output.diagnostics) {
    console.log(`- ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}`)
  }
}

function printArtifactExportLinksHumanOutput(output: ReviewerArtifactExportLinks): void {
  console.log("WP Codebox reviewer artifact export links")
  console.log(`Artifact: ${output.artifactId}`)
  console.log(`Files: ${output.files.length}`)
  for (const file of output.files) {
    console.log(`- ${file.kind} ${file.path}: ${file.url}`)
  }
}

function printArtifactDiagnosticsHumanOutput(output: ArtifactDiagnostics): void {
  console.log("WP Codebox artifact diagnostics")
  console.log(`Status: ${output.status}`)
  console.log(`Diagnostics: ${output.summary.total} (${output.summary.error} error(s), ${output.summary.warning} warning(s), ${output.summary.notice} notice(s), ${output.summary.info} info)`)
  for (const diagnostic of output.diagnostics) {
    console.log(`- ${diagnostic.severity} ${diagnostic.code ?? diagnostic.type}: ${diagnostic.message}`)
  }
}

function printArtifactApplyPreflightHumanOutput(output: ArtifactBundleApplyPreflightResult): void {
  console.log("WP Codebox artifact apply preflight")
  console.log(`Bundle: ${output.bundleDirectory}`)
  console.log(`Ready: ${output.ready ? "yes" : "no"}`)
  if (output.payload) {
    console.log(`Artifact: ${output.payload.artifactId}`)
    console.log(`Changed files: ${output.payload.changedFiles.files.length}`)
    console.log(`Patch: ${output.payload.patch.path}`)
  }
  for (const violation of output.violations) {
    console.log(`- ${violation.code} ${violation.path}: ${violation.message}`)
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

function printArtifactDiscoverPartialHumanOutput(output: PartialArtifactDiscoveryResult): void {
  console.log("WP Codebox partial artifact discovery")
  console.log(`Artifacts root: ${output.artifactsRoot}`)
  console.log(`Selected by: ${output.selectedBy}`)
  console.log(`Artifacts: ${output.artifacts.length}/${output.candidateCount}`)
  for (const artifact of output.artifacts) {
    console.log(`  ${artifact.directory}`)
    console.log(`    manifest: ${artifact.hasManifest ? "yes" : "no"}`)
    console.log(`    changed files: ${artifact.hasChangedFiles ? artifact.changedFiles.path : "no"}`)
    console.log(`    runtime reference manifest: ${artifact.hasRuntimeReferenceManifest ? artifact.runtimeReferenceManifest.path : "no"}`)
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
