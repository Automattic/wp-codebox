import { stripUndefined } from "./object-utils.js"

export const FUZZ_SUITE_SCHEMA = "wp-codebox/fuzz-suite/v1" as const
export const FUZZ_SUITE_RESULT_SCHEMA = "wp-codebox/fuzz-suite-result/v1" as const

export type FuzzSuiteTargetKind = "ability" | "command" | "http" | "rest" | "runtime" | "runtime-action" | (string & {})
export type FuzzSuiteCaseStatus = "passed" | "failed" | "error" | "skipped"
export type FuzzSuiteDiagnosticSeverity = "error" | "warning" | "info"
export type FuzzSuiteRunnerMode = "php-in-process" | "runtime-backed" | (string & {})

export interface FuzzSuiteTargetRef {
  kind: FuzzSuiteTargetKind
  id?: string
  entrypoint?: string
  label?: string
  metadata?: Record<string, unknown>
}

export interface FuzzSuiteCase {
  id: string
  target?: FuzzSuiteTargetRef
  input?: unknown
  description?: string
  metadata?: Record<string, unknown>
}

export interface FuzzSuiteContract {
  schema: typeof FUZZ_SUITE_SCHEMA
  id: string
  version?: string
  target?: FuzzSuiteTargetRef
  cases: FuzzSuiteCase[]
  metadata?: Record<string, unknown>
}

export interface FuzzSuiteRunnerCapabilities {
  mode: FuzzSuiteRunnerMode
  capabilities: string[]
  targetKinds: string[]
  runtimeActionTypes?: string[]
  commands?: string[]
}

export const PHP_IN_PROCESS_FUZZ_SUITE_RUNNER_CAPABILITIES: FuzzSuiteRunnerCapabilities = {
  mode: "php-in-process",
  capabilities: ["target:ability", "target:http", "target:rest"],
  targetKinds: ["ability", "http", "rest"],
}

export const RUNTIME_BACKED_FUZZ_SUITE_RUNNER_CAPABILITIES: FuzzSuiteRunnerCapabilities = {
  mode: "runtime-backed",
  capabilities: [
    "target:ability",
    "target:command",
    "target:http",
    "target:rest",
    "target:runtime",
    "target:runtime-action",
    "runtime",
    "runtime-action:admin_page",
    "runtime-action:browser",
    "runtime-action:browser_probe",
    "runtime-action:crud_operation",
    "runtime-action:editor_open",
    "runtime-action:page",
    "runtime-action:php",
    "runtime-action:rest_request",
    "runtime-action:wp_cli",
  ],
  targetKinds: ["ability", "command", "http", "rest", "runtime", "runtime-action"],
  runtimeActionTypes: ["admin_page", "browser", "browser_probe", "crud_operation", "editor_open", "page", "php", "rest_request", "wp_cli"],
  commands: ["wordpress.ability", "wordpress.admin-page-load", "wordpress.browser-actions", "wordpress.browser-probe", "wordpress.crud-operation", "wordpress.editor-open", "wordpress.frontend-page-load", "wordpress.http-request", "wordpress.rest-request", "wordpress.run-php", "wordpress.wp-cli"],
}

export interface FuzzSuiteDiagnostic {
  severity: FuzzSuiteDiagnosticSeverity
  message: string
  code?: string
  caseId?: string
  target?: FuzzSuiteTargetRef
  metadata?: Record<string, unknown>
}

export interface FuzzSuiteArtifactRef {
  path: string
  kind: string
  contentType?: string
  sha256?: string
  bytes?: number
  name?: string
  metadata?: Record<string, unknown>
}

export interface FuzzSuiteCaseResult {
  id: string
  status: FuzzSuiteCaseStatus
  success: boolean
  target?: FuzzSuiteTargetRef
  skipReason?: string
  diagnostics: FuzzSuiteDiagnostic[]
  artifactRefs?: FuzzSuiteArtifactRef[]
  metadata?: Record<string, unknown>
}

export interface FuzzSuiteSummary {
  total: number
  passed: number
  failed: number
  error: number
  skipped: number
}

export interface FuzzSuiteSkippedReasonSummary {
  reason: string
  count: number
  caseIds?: string[]
}

export interface FuzzSuiteCoverageSummary {
  discovered: number
  generated: number
  executed: number
  skipped: number
  untested: number
  skippedReasons: FuzzSuiteSkippedReasonSummary[]
}

export interface FuzzSuiteResultEnvelope {
  schema: typeof FUZZ_SUITE_RESULT_SCHEMA
  suite: {
    id: string
    version?: string
  }
  status: FuzzSuiteCaseStatus
  success: boolean
  summary: FuzzSuiteSummary
  coverageSummary?: FuzzSuiteCoverageSummary
  cases: FuzzSuiteCaseResult[]
  diagnostics: FuzzSuiteDiagnostic[]
  artifactRefs: FuzzSuiteArtifactRef[]
  metadata?: Record<string, unknown>
}

export function fuzzSuiteContract(input: {
  id: string
  version?: string
  target?: FuzzSuiteTargetRef
  cases?: FuzzSuiteCase[]
  metadata?: Record<string, unknown>
}): FuzzSuiteContract {
  return stripUndefined({
    schema: FUZZ_SUITE_SCHEMA,
    id: input.id,
    version: input.version,
    target: input.target,
    cases: input.cases ?? [],
    metadata: input.metadata,
  })
}

export function fuzzSuiteResultEnvelope(input: {
  suite: { id: string; version?: string } | FuzzSuiteContract
  cases?: FuzzSuiteCaseResult[]
  diagnostics?: FuzzSuiteDiagnostic[]
  artifactRefs?: FuzzSuiteArtifactRef[]
  coverageSummary?: FuzzSuiteCoverageSummary
  metadata?: Record<string, unknown>
}): FuzzSuiteResultEnvelope {
  const cases = (input.cases ?? []).map(normalizeCaseResult)
  const diagnostics = [...(input.diagnostics ?? [])]
  const artifactRefs = dedupeArtifactRefs([...(input.artifactRefs ?? []), ...cases.flatMap((item) => item.artifactRefs ?? [])])
  const summary = summarizeFuzzCases(cases)
  const coverageSummary = input.coverageSummary ?? summarizeFuzzCoverage({ discovered: fuzzSuiteDiscoveredCount(input.suite, cases.length), cases })
  const contractDiagnostics = fuzzSuiteContractDiagnostics({ suite: input.suite, cases, artifactRefs, coverageSummary })
  diagnostics.push(...contractDiagnostics)
  const hasRequiredCoverageError = diagnostics.some((diagnostic) => diagnostic.code === "fuzz_suite_required_runner_capabilities_unsupported" || diagnostic.code === "fuzz_suite_required_coverage_unsupported")
  const status: FuzzSuiteCaseStatus = summary.error > 0 || hasRequiredCoverageError || contractDiagnostics.length > 0 ? "error" : summary.failed > 0 ? "failed" : summary.skipped === summary.total && summary.total > 0 ? "skipped" : "passed"

  return stripUndefined({
    schema: FUZZ_SUITE_RESULT_SCHEMA,
    suite: stripUndefined({ id: input.suite.id, version: input.suite.version }),
    status,
    success: status === "passed",
    summary,
    coverageSummary,
    cases,
    diagnostics,
    artifactRefs,
    metadata: input.metadata,
  })
}

export function fuzzSuiteRequiredRunnerCapabilities(suite: FuzzSuiteContract): string[] {
  const metadata = fuzzSuiteMetadata(suite)
  const required = recordField(metadata, "requiredRunnerCapabilities") ?? recordField(metadata, "required_runner_capabilities")
  return dedupeStrings([
    ...stringArrayField(required, "capabilities"),
    ...stringArrayField(required, "targetKinds").map((kind) => `target:${kind}`),
    ...stringArrayField(required, "target_kinds").map((kind) => `target:${kind}`),
    ...stringArrayField(required, "runtimeActionTypes").map((type) => `runtime-action:${type}`),
    ...stringArrayField(required, "runtime_action_types").map((type) => `runtime-action:${type}`),
    ...stringArrayField(metadata, "requiredCapabilities"),
    ...stringArrayField(metadata, "required_capabilities"),
  ])
}

export function summarizeFuzzCases(cases: readonly Pick<FuzzSuiteCaseResult, "status">[]): FuzzSuiteSummary {
  const summary: FuzzSuiteSummary = { total: cases.length, passed: 0, failed: 0, error: 0, skipped: 0 }
  for (const item of cases) {
    if (item.status === "passed") summary.passed += 1
    else if (item.status === "failed") summary.failed += 1
    else if (item.status === "error") summary.error += 1
    else if (item.status === "skipped") summary.skipped += 1
  }
  return summary
}

export function summarizeFuzzCoverage(input: {
  discovered: number
  cases: readonly Pick<FuzzSuiteCaseResult, "id" | "status" | "skipReason" | "diagnostics">[]
}): FuzzSuiteCoverageSummary {
  const skippedReasons = new Map<string, { count: number; caseIds: string[] }>()
  let executed = 0
  let skipped = 0

  for (const item of input.cases) {
    if (item.status === "skipped") {
      skipped += 1
      const reason = item.skipReason ?? item.diagnostics[0]?.code ?? item.diagnostics[0]?.message ?? "unspecified"
      const existing = skippedReasons.get(reason) ?? { count: 0, caseIds: [] }
      existing.count += 1
      existing.caseIds.push(item.id)
      skippedReasons.set(reason, existing)
    } else {
      executed += 1
    }
  }

  return {
    discovered: input.discovered,
    generated: input.cases.length,
    executed,
    skipped,
    untested: Math.max(input.discovered - input.cases.length, 0),
    skippedReasons: [...skippedReasons.entries()].map(([reason, value]) => ({ reason, count: value.count, caseIds: value.caseIds })),
  }
}

function normalizeCaseResult(input: FuzzSuiteCaseResult): FuzzSuiteCaseResult {
  return stripUndefined({
    id: input.id,
    status: input.status,
    success: input.status === "passed",
    target: input.target,
    skipReason: input.status === "skipped" ? input.skipReason ?? input.diagnostics?.[0]?.code ?? input.diagnostics?.[0]?.message : undefined,
    diagnostics: input.diagnostics ?? [],
    artifactRefs: input.artifactRefs,
    metadata: input.metadata,
  })
}

function fuzzSuiteDiscoveredCount(suite: { id: string; version?: string } | FuzzSuiteContract, fallback: number): number {
  return "cases" in suite && Array.isArray(suite.cases) ? suite.cases.length : fallback
}

function fuzzSuiteContractDiagnostics(input: {
  suite: { id: string; version?: string } | FuzzSuiteContract
  cases: readonly FuzzSuiteCaseResult[]
  artifactRefs: readonly FuzzSuiteArtifactRef[]
  coverageSummary: FuzzSuiteCoverageSummary
}): FuzzSuiteDiagnostic[] {
  if (fuzzSuiteAllowsEmpty(input.suite)) {
    return []
  }

  const diagnostics: FuzzSuiteDiagnostic[] = []
  const requiredArtifacts = fuzzSuiteRequiredArtifactDeclarations(input.suite)
  const expectsCoverage = fuzzSuiteExpectsNonEmptyCoverage(input.suite, input.coverageSummary)

  if (input.cases.length === 0 && (requiredArtifacts.length > 0 || expectsCoverage)) {
    diagnostics.push({
      severity: "error",
      code: "fuzz_suite_empty_cases_for_declared_contract",
      message: `Fuzz suite ${input.suite.id} produced no cases for a contract that declares required artifacts or non-empty coverage.`,
      metadata: stripUndefined({ requiredArtifacts: requiredArtifacts.map((artifact) => artifact.name ?? artifact.path ?? artifact.semantic_key ?? artifact.kind), expectsCoverage }),
    })
  }

  if (requiredArtifacts.length > 0 && input.artifactRefs.length === 0) {
    diagnostics.push({
      severity: "error",
      code: "fuzz_suite_required_artifacts_missing",
      message: `Fuzz suite ${input.suite.id} produced no artifacts for a contract with required artifact declarations.`,
      metadata: { requiredArtifacts: requiredArtifacts.map((artifact) => artifact.name ?? artifact.path ?? artifact.semantic_key ?? artifact.kind) },
    })
  }

  return diagnostics
}

function fuzzSuiteAllowsEmpty(suite: { id: string; version?: string } | FuzzSuiteContract): boolean {
  const metadata = fuzzSuiteMetadata(suite)
  const readiness = recordField(metadata, "readiness")
  const genericPrimitive = recordField(metadata, "generic_primitive") ?? recordField(metadata, "genericPrimitive")

  return booleanField(metadata, "allow_empty") === true
    || booleanField(metadata, "allowed_empty") === true
    || booleanField(metadata, "allowEmpty") === true
    || booleanField(metadata, "declared_only") === true
    || booleanField(metadata, "declaredOnly") === true
    || readiness?.level === "declared"
    || readiness?.declared_only === true
    || readiness?.declaredOnly === true
    || genericPrimitive?.status === "blocked"
}

function fuzzSuiteExpectsNonEmptyCoverage(suite: { id: string; version?: string } | FuzzSuiteContract, coverageSummary: FuzzSuiteCoverageSummary): boolean {
  if (coverageSummary.discovered > 0) {
    return true
  }

  const coverage = recordField(fuzzSuiteMetadata(suite), "coverage")
  return nonEmptyArrayField(coverage, "surface_ids")
    || nonEmptyArrayField(coverage, "surfaceIds")
    || nonEmptyArrayField(coverage, "operations")
    || numberField(coverage, "expected") > 0
    || numberField(coverage, "discovered") > 0
}

function fuzzSuiteRequiredArtifactDeclarations(suite: { id: string; version?: string } | FuzzSuiteContract): Record<string, unknown>[] {
  const metadata = fuzzSuiteMetadata(suite)
  const artifacts = recordField(metadata, "artifacts")
  const candidates = [
    ...arrayField(artifacts, "expected"),
    ...arrayField(artifacts, "required"),
    ...arrayField(metadata, "artifact_declarations"),
    ...arrayField(metadata, "artifactDeclarations"),
    ...arrayField(metadata, "expected_artifacts"),
    ...arrayField(metadata, "expectedArtifacts"),
  ]

  return candidates.filter((item): item is Record<string, unknown> => isRecord(item) && item.required === true)
}

function fuzzSuiteMetadata(suite: { id: string; version?: string } | FuzzSuiteContract): Record<string, unknown> | undefined {
  return "metadata" in suite && isRecord(suite.metadata) ? suite.metadata : undefined
}

function recordField(source: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const value = source?.[key]
  return isRecord(value) ? value : undefined
}

function arrayField(source: Record<string, unknown> | undefined, key: string): unknown[] {
  const value = source?.[key]
  return Array.isArray(value) ? value : []
}

function nonEmptyArrayField(source: Record<string, unknown> | undefined, key: string): boolean {
  return arrayField(source, key).length > 0
}

function stringArrayField(source: Record<string, unknown> | undefined, key: string): string[] {
  return arrayField(source, key).filter((item): item is string => typeof item === "string" && item.length > 0)
}

function dedupeStrings(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function booleanField(source: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const value = source?.[key]
  return typeof value === "boolean" ? value : undefined
}

function numberField(source: Record<string, unknown> | undefined, key: string): number {
  const value = source?.[key]
  return typeof value === "number" ? value : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function dedupeArtifactRefs(refs: readonly FuzzSuiteArtifactRef[]): FuzzSuiteArtifactRef[] {
  const seen = new Set<string>()
  const output: FuzzSuiteArtifactRef[] = []
  for (const ref of refs) {
    const key = `${ref.kind}:${ref.path}:${ref.sha256 ?? ""}`
    if (seen.has(key)) continue
    seen.add(key)
    output.push(ref)
  }
  return output
}
