import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { artifactManifestFile, createBenchResultsJsonSchema, refreshArtifactManifestFileSha256s, upsertArtifactManifestFiles, type ArtifactBundle, type ArtifactManifest, type ArtifactManifestFile, type BenchmarkArtifactRef, type BenchResults } from "@automattic/wp-codebox-core"
import { stripUndefined } from "@automattic/wp-codebox-core/internals"
import { Ajv2020 } from "ajv/dist/2020.js"

interface BenchmarkArtifactOutput {
  schema: "wp-codebox/benchmark-artifacts/v1"
  artifactBundle: {
    id: string
    directory: string
    contentDigest: string
  }
  results: BenchResults[]
  scenarios: Array<{
    componentId: string
    scenarioId: string
    source?: string
    artifactRefs: BenchmarkArtifactRef[]
  }>
}

type BenchScenarioWithArtifactRefs = BenchResults["scenarios"][number] & {
  artifactRefs?: BenchmarkArtifactRef[]
  samples?: Array<{ artifacts?: unknown }>
}

const benchResultsAjv = new Ajv2020({ strict: false })
const validateBenchResultsSchema = benchResultsAjv.compile(createBenchResultsJsonSchema())

export function parseBenchResults(raw: string, manifestFiles: Map<string, ArtifactManifestFile>): BenchResults {
  const { parsed, prefix, suffix } = parseBenchResultsJson(raw)
  if (!validateBenchResultsSchema(parsed)) {
    throw new Error(`Bench command did not emit a wp-codebox/bench-results/v1 envelope: ${benchResultsAjv.errorsText(validateBenchResultsSchema.errors)}`)
  }

  const results = parsed as BenchResults
  const diagnostics = [...results.diagnostics]
  if (prefix.trim()) {
    diagnostics.push(benchOutputDiagnostic("bench-output-prefix", "before", prefix))
  }
  if (suffix.trim()) {
    diagnostics.push(benchOutputDiagnostic("bench-output-suffix", "after", suffix))
  }

  return {
    ...results,
    diagnostics,
    scenarios: results.scenarios.map((scenario) => enrichBenchScenarioArtifactRefs(scenario, manifestFiles)),
  }
}

function parseBenchResultsJson(raw: string): { parsed: unknown; prefix: string; suffix: string } {
  try {
    return { parsed: JSON.parse(raw) as unknown, prefix: "", suffix: "" }
  } catch (error) {
    const extracted = extractFirstJsonObject(raw)
    if (!extracted) {
      throw error
    }

    try {
      return { parsed: JSON.parse(extracted.json) as unknown, prefix: extracted.prefix, suffix: extracted.suffix }
    } catch {
      throw error
    }
  }
}

function extractFirstJsonObject(raw: string): { json: string; prefix: string; suffix: string } | undefined {
  for (let start = raw.indexOf("{"); start !== -1; start = raw.indexOf("{", start + 1)) {
    let depth = 0
    let inString = false
    let escaped = false

    for (let index = start; index < raw.length; index++) {
      const character = raw[index]
      if (inString) {
        if (escaped) {
          escaped = false
        } else if (character === "\\") {
          escaped = true
        } else if (character === '"') {
          inString = false
        }
        continue
      }

      if (character === '"') {
        inString = true
      } else if (character === "{") {
        depth++
      } else if (character === "}") {
        depth--
        if (depth === 0) {
          return { json: raw.slice(start, index + 1), prefix: raw.slice(0, start), suffix: raw.slice(index + 1) }
        }
      }
    }
  }

  return undefined
}

function benchOutputDiagnostic(code: string, position: "before" | "after", output: string): BenchResults["diagnostics"][number] {
  return {
    severity: "warning",
    code,
    source: "wordpress.bench/stdout",
    message: `wordpress.bench emitted non-JSON stdout ${position} the bench-results envelope.`,
    details: {
      output: boundDiagnosticText(output),
    },
  }
}

function boundDiagnosticText(output: string): string {
  const normalized = output.trim()
  return normalized.length > 4000 ? `${normalized.slice(0, 4000)}...` : normalized
}

function enrichBenchScenarioArtifactRefs(scenario: BenchResults["scenarios"][number], manifestFiles: Map<string, ArtifactManifestFile>): BenchScenarioWithArtifactRefs {
  const artifactRefs = [
    ...scenarioArtifactRefs(scenario.artifacts, manifestFiles, "scenario-artifact"),
    ...sampleArtifactRefs((scenario as BenchScenarioWithArtifactRefs).samples, manifestFiles),
    ...metricArtifactRefs(scenario.metrics, manifestFiles),
    ...browserArtifactRefs(scenario.metrics, manifestFiles),
  ]
  const existingRefs = Array.isArray((scenario as BenchScenarioWithArtifactRefs).artifactRefs) ? (scenario as BenchScenarioWithArtifactRefs).artifactRefs ?? [] : []
  const dedupedRefs = dedupeBenchmarkArtifactRefs([...existingRefs, ...artifactRefs])

  return stripUndefined({
    ...scenario,
    ...(dedupedRefs.length > 0 ? { artifactRefs: dedupedRefs } : {}),
  }) as BenchScenarioWithArtifactRefs
}

export async function writeBenchmarkArtifactEvidence(artifacts: ArtifactBundle, benchResultsList: BenchResults[]): Promise<void> {
  const scenarios = benchResultsList.flatMap((result) => result.scenarios.map((scenario) => ({
    componentId: result.component_id,
    scenarioId: String(scenario.id ?? ""),
    source: typeof scenario.source === "string" ? scenario.source : undefined,
    artifactRefs: (scenario as BenchScenarioWithArtifactRefs).artifactRefs ?? [],
  }))).filter((scenario) => scenario.scenarioId.length > 0 || scenario.artifactRefs.length > 0)
  const output: BenchmarkArtifactOutput = {
    schema: "wp-codebox/benchmark-artifacts/v1",
    artifactBundle: {
      id: artifacts.id,
      directory: artifacts.directory,
      contentDigest: artifacts.contentDigest,
    },
    results: benchResultsList,
    scenarios,
  }
  const relativePath = "files/bench-results.json"
  await writeFile(join(artifacts.directory, relativePath), `${JSON.stringify(output, null, 2)}\n`)
  const manifest = JSON.parse(await readFile(artifacts.manifestPath, "utf8")) as ArtifactManifest
  upsertArtifactManifestFiles(manifest, [artifactManifestFile(relativePath, "benchmark-results", "application/json")])
  await refreshArtifactManifestFileSha256s(artifacts.directory, manifest)
  await writeFile(artifacts.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

export async function artifactManifestFilesByPath(artifacts: ArtifactBundle): Promise<Map<string, ArtifactManifestFile>> {
  try {
    const manifest = JSON.parse(await readFile(artifacts.manifestPath, "utf8")) as ArtifactManifest
    return new Map((manifest.files ?? []).map((file) => [file.path, file]))
  } catch {
    return new Map()
  }
}

function scenarioArtifactRefs(input: unknown, manifestFiles: Map<string, ArtifactManifestFile>, source: BenchmarkArtifactRef["source"], sampleIndex?: number): BenchmarkArtifactRef[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return []
  }

  return Object.entries(input).flatMap(([name, value]) => artifactValueRefs(name, value, manifestFiles, source, sampleIndex))
}

function sampleArtifactRefs(samples: BenchScenarioWithArtifactRefs["samples"], manifestFiles: Map<string, ArtifactManifestFile>): BenchmarkArtifactRef[] {
  if (!Array.isArray(samples)) {
    return []
  }

  return samples.flatMap((sample, sampleIndex) => scenarioArtifactRefs(sample.artifacts, manifestFiles, "sample-artifact", sampleIndex))
}

function artifactValueRefs(name: string, value: unknown, manifestFiles: Map<string, ArtifactManifestFile>, source: BenchmarkArtifactRef["source"], sampleIndex?: number): BenchmarkArtifactRef[] {
  if (typeof value === "string") {
    return [benchmarkArtifactRef(value, { name, source, sampleIndex }, manifestFiles)]
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return []
  }
  const record = value as Record<string, unknown>
  if (typeof record.path === "string") {
    return [benchmarkArtifactRef(record.path, {
      name,
      source,
      sampleIndex,
      kind: typeof record.kind === "string" ? record.kind : undefined,
      contentType: typeof record.contentType === "string" ? record.contentType : typeof record.mime === "string" ? record.mime : undefined,
    }, manifestFiles)]
  }

  return Object.entries(record).flatMap(([childName, childValue]) => artifactValueRefs(`${name}.${childName}`, childValue, manifestFiles, source, sampleIndex))
}

function metricArtifactRefs(metrics: BenchResults["scenarios"][number]["metrics"], manifestFiles: Map<string, ArtifactManifestFile>): BenchmarkArtifactRef[] {
  if (!metrics || typeof metrics !== "object") {
    return []
  }

  return Object.keys(metrics).sort().map((metric) => benchmarkArtifactRef("files/bench-results.json", { source: "metric-source", metric, kind: "benchmark-results", contentType: "application/json" }, manifestFiles))
}

function browserArtifactRefs(metrics: BenchResults["scenarios"][number]["metrics"], manifestFiles: Map<string, ArtifactManifestFile>): BenchmarkArtifactRef[] {
  if (!metrics || !Object.keys(metrics).some((metric) => metric.startsWith("browser_"))) {
    return []
  }

  return [...manifestFiles.values()]
    .filter((file) => file.path.startsWith("files/browser/"))
    .map((file) => benchmarkArtifactRef(file.path, { source: "browser-artifact", kind: file.kind, contentType: file.contentType }, manifestFiles))
}

function benchmarkArtifactRef(path: string, options: Omit<Partial<BenchmarkArtifactRef>, "path"> & { source: BenchmarkArtifactRef["source"] }, manifestFiles: Map<string, ArtifactManifestFile>): BenchmarkArtifactRef {
  const manifestFile = manifestFiles.get(path)
  return stripUndefined({
    path,
    kind: options.kind ?? manifestFile?.kind ?? "artifact",
    contentType: options.contentType ?? manifestFile?.contentType,
    sha256: manifestFile?.sha256.value,
    source: options.source,
    name: options.name,
    metric: options.metric,
    sampleIndex: options.sampleIndex,
  }) as BenchmarkArtifactRef
}

function dedupeBenchmarkArtifactRefs(refs: BenchmarkArtifactRef[]): BenchmarkArtifactRef[] {
  const seen = new Set<string>()
  const deduped: BenchmarkArtifactRef[] = []
  for (const ref of refs) {
    const key = `${ref.source}:${ref.path}:${ref.name ?? ""}:${ref.metric ?? ""}:${ref.sampleIndex ?? ""}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    deduped.push(ref)
  }

  return deduped
}
