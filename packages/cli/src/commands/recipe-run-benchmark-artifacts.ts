import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
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

interface RouteMatrixSummaryArtifact {
  schema: "wp-codebox/benchmark-route-matrix-summary/v1"
  componentId: string
  scenarioId: string
  routes: RouteMatrixStepSummary[]
}

interface RestRequestCaseSummaryArtifact {
  schema: "wp-codebox/benchmark-rest-request-case-summary/v1"
  componentId: string
  scenarioId: string
  cases: RestRequestCaseStepSummary[]
}

interface RouteMatrixStepSummary {
  index?: number
  id?: string
  method?: string
  path?: string
  route?: string
  status?: number
  duration_ms?: number
  response?: {
    redacted: true
    bytes: number
    shape: unknown
  }
}

interface RestRequestCaseStepSummary extends RouteMatrixStepSummary {
  caseId?: string
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
  const materializedBenchResultsList = await materializeRouteMatrixSummaryArtifacts(artifacts, benchResultsList)
  const scenarios = materializedBenchResultsList.flatMap((result) => result.scenarios.map((scenario) => ({
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
    results: materializedBenchResultsList,
    scenarios,
  }
  const relativePath = "files/bench-results.json"
  await writeFile(join(artifacts.directory, relativePath), `${JSON.stringify(output, null, 2)}\n`)
  const manifest = JSON.parse(await readFile(artifacts.manifestPath, "utf8")) as ArtifactManifest
  upsertArtifactManifestFiles(manifest, [artifactManifestFile(relativePath, "benchmark-results", "application/json")])
  await refreshArtifactManifestFileSha256s(artifacts.directory, manifest)
  await writeFile(artifacts.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

async function materializeRouteMatrixSummaryArtifacts(artifacts: ArtifactBundle, benchResultsList: BenchResults[]): Promise<BenchResults[]> {
  const manifest = JSON.parse(await readFile(artifacts.manifestPath, "utf8")) as ArtifactManifest
  const writes: Array<{ resultIndex: number; scenarioIndex: number; path: string; artifactName: string; kind: string; operation: string; summary: RouteMatrixSummaryArtifact | RestRequestCaseSummaryArtifact }> = []

  benchResultsList.forEach((result, resultIndex) => {
    const routeMatrixScenarioIds = routeMatrixWorkloadScenarioIds(result)
    result.scenarios.forEach((scenario, scenarioIndex) => {
      if (!routeMatrixScenarioIds.has(String(scenario.id ?? ""))) {
        return
      }
      const routes = routeMatrixStepSummaries((scenario as BenchScenarioWithArtifactRefs).steps)
      if (routes.length === 0) {
        return
      }
      const scenarioId = String(scenario.id ?? "")
      writes.push({
        resultIndex,
        scenarioIndex,
        path: `files/bench/${safeArtifactSegment(result.component_id)}/${safeArtifactSegment(scenarioId)}-route-matrix-summary.json`,
        artifactName: "route-matrix-summary",
        kind: "benchmark-route-matrix-summary",
        operation: "materialize-route-matrix-summary",
        summary: {
          schema: "wp-codebox/benchmark-route-matrix-summary/v1",
          componentId: result.component_id,
          scenarioId,
          routes,
        },
      })
    })
    const restCaseScenarioIds = restRequestCaseWorkloadScenarioIds(result)
    result.scenarios.forEach((scenario, scenarioIndex) => {
      if (!restCaseScenarioIds.has(String(scenario.id ?? ""))) {
        return
      }
      const cases = restRequestCaseStepSummaries((scenario as BenchScenarioWithArtifactRefs).steps)
      if (cases.length === 0) {
        return
      }
      const scenarioId = String(scenario.id ?? "")
      writes.push({
        resultIndex,
        scenarioIndex,
        path: `files/bench/${safeArtifactSegment(result.component_id)}/${safeArtifactSegment(scenarioId)}-rest-request-case-summary.json`,
        artifactName: "rest-request-case-summary",
        kind: "benchmark-rest-request-case-summary",
        operation: "materialize-rest-request-case-summary",
        summary: {
          schema: "wp-codebox/benchmark-rest-request-case-summary/v1",
          componentId: result.component_id,
          scenarioId,
          cases,
        },
      })
    })
  })

  if (writes.length === 0) {
    return benchResultsList
  }

  await mkdir(join(artifacts.directory, "files", "bench"), { recursive: true })
  for (const write of writes) {
    const absolutePath = join(artifacts.directory, write.path)
    await mkdir(dirname(absolutePath), { recursive: true })
    await writeFile(absolutePath, `${JSON.stringify(write.summary, null, 2)}\n`)
  }

  upsertArtifactManifestFiles(manifest, writes.map((write) => artifactManifestFile(write.path, write.kind, "application/json", undefined, {
    redaction: {
      policy: "applied",
      sensitive: false,
      reason: "REST response bodies are replaced with bounded shape and byte metadata.",
    },
    provenance: {
      source: "wordpress.bench",
      operation: write.operation,
    },
  })))
  await refreshArtifactManifestFileSha256s(artifacts.directory, manifest)
  await writeFile(artifacts.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  const manifestFiles = new Map((manifest.files ?? []).map((file) => [file.path, file]))

  return benchResultsList.map((result, resultIndex) => ({
    ...result,
    scenarios: result.scenarios.map((scenario, scenarioIndex) => {
      const scenarioWrites = writes.filter((candidate) => candidate.resultIndex === resultIndex && candidate.scenarioIndex === scenarioIndex)
      if (scenarioWrites.length === 0) {
        return scenario
      }
      const refs = scenarioWrites.map((write) => benchmarkArtifactRef(write.path, { source: "scenario-artifact", name: write.artifactName, kind: write.kind, contentType: "application/json" }, manifestFiles))
      const existingRefs = Array.isArray((scenario as BenchScenarioWithArtifactRefs).artifactRefs) ? (scenario as BenchScenarioWithArtifactRefs).artifactRefs ?? [] : []
      return stripUndefined({
        ...scenario,
        steps: redactRestStepResponses((scenario as BenchScenarioWithArtifactRefs).steps),
        artifacts: {
          ...(scenario.artifacts ?? {}),
          ...Object.fromEntries(scenarioWrites.map((write, index) => [write.artifactName, refs[index]])),
        },
        artifactRefs: dedupeBenchmarkArtifactRefs([...existingRefs, ...refs]),
      }) as BenchResults["scenarios"][number]
    }),
  }))
}

function redactRestStepResponses(steps: unknown): unknown {
  if (!Array.isArray(steps)) {
    return steps
  }
  return steps.map((step) => {
    if (!isRecord(step) || step.type !== "rest-request" || (typeof step.route_matrix_index !== "number" && typeof step.rest_request_case_index !== "number") || !Object.hasOwn(step, "response")) {
      return step
    }
    return {
      ...step,
      response: redactedResponseSummary(step.response),
    }
  })
}

function routeMatrixWorkloadScenarioIds(result: BenchResults): Set<string> {
  const workloads = isRecord(result.provenance.definition) && Array.isArray(result.provenance.definition.workloads) ? result.provenance.definition.workloads : []
  return new Set(workloads
    .filter((workload) => isRecord(workload) && Array.isArray(workload.route_matrix) && workload.route_matrix.length > 0 && typeof workload.id === "string" && workload.id.length > 0)
    .map((workload) => String(workload.id)))
}

function restRequestCaseWorkloadScenarioIds(result: BenchResults): Set<string> {
  const workloads = isRecord(result.provenance.definition) && Array.isArray(result.provenance.definition.workloads) ? result.provenance.definition.workloads : []
  return new Set(workloads
    .filter((workload) => isRecord(workload) && ((Array.isArray(workload.rest_request_cases) && workload.rest_request_cases.length > 0) || (Array.isArray(workload.request_cases) && workload.request_cases.length > 0)) && typeof workload.id === "string" && workload.id.length > 0)
    .map((workload) => String(workload.id)))
}

function routeMatrixStepSummaries(steps: unknown): RouteMatrixStepSummary[] {
  if (!Array.isArray(steps)) {
    return []
  }
  return steps
    .filter((step): step is Record<string, unknown> => isRecord(step) && step.type === "rest-request" && typeof step.route_matrix_index === "number")
    .map((step) => stripUndefined({
      index: typeof step.route_matrix_index === "number" ? step.route_matrix_index : undefined,
      id: typeof step.route_id === "string" ? step.route_id : undefined,
      method: typeof step.method === "string" ? step.method : undefined,
      path: typeof step.path === "string" ? step.path : undefined,
      route: typeof step.route === "string" ? step.route : undefined,
      status: typeof step.status === "number" ? step.status : undefined,
      duration_ms: isRecord(step.timing) && typeof step.timing.duration_ms === "number" ? step.timing.duration_ms : undefined,
      ...(Object.hasOwn(step, "response") ? { response: redactedResponseSummary(step.response) } : {}),
    })) as RouteMatrixStepSummary[]
}

function restRequestCaseStepSummaries(steps: unknown): RestRequestCaseStepSummary[] {
  if (!Array.isArray(steps)) {
    return []
  }
  return steps
    .filter((step): step is Record<string, unknown> => isRecord(step) && step.type === "rest-request" && typeof step.rest_request_case_index === "number")
    .map((step) => stripUndefined({
      index: typeof step.rest_request_case_index === "number" ? step.rest_request_case_index : undefined,
      caseId: typeof step.case_id === "string" ? step.case_id : undefined,
      id: typeof step.route_id === "string" ? step.route_id : undefined,
      method: typeof step.method === "string" ? step.method : undefined,
      path: typeof step.path === "string" ? step.path : undefined,
      route: typeof step.route === "string" ? step.route : undefined,
      status: typeof step.status === "number" ? step.status : undefined,
      duration_ms: isRecord(step.timing) && typeof step.timing.duration_ms === "number" ? step.timing.duration_ms : undefined,
      ...(Object.hasOwn(step, "response") ? { response: redactedResponseSummary(step.response) } : {}),
    })) as RestRequestCaseStepSummary[]
}

function redactedResponseSummary(response: unknown): RouteMatrixStepSummary["response"] {
  if (isRecord(response) && response.redacted === true && typeof response.bytes === "number" && Object.hasOwn(response, "shape")) {
    return response as RouteMatrixStepSummary["response"]
  }
  const serialized = JSON.stringify(response) ?? "null"
  return {
    redacted: true,
    bytes: Buffer.byteLength(serialized, "utf8"),
    shape: responseShape(response),
  }
}

function responseShape(value: unknown, depth = 0): unknown {
  if (value === null) {
    return "null"
  }
  if (Array.isArray(value)) {
    return { type: "array", length: value.length, items: value.length > 0 && depth < 3 ? responseShape(value[0], depth + 1) : undefined }
  }
  if (isRecord(value)) {
    if (depth >= 3) {
      return { type: "object", keys: Object.keys(value).sort() }
    }
    return {
      type: "object",
      keys: Object.fromEntries(Object.keys(value).sort().slice(0, 50).map((key) => [key, responseShape(value[key], depth + 1)])),
    }
  }
  return typeof value
}

function safeArtifactSegment(value: string): string {
  const safe = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
  return safe.length > 0 ? safe : "unknown"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
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
