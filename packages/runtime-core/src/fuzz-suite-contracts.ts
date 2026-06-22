import { stripUndefined } from "./object-utils.js"

export const FUZZ_SUITE_SCHEMA = "wp-codebox/fuzz-suite/v1" as const
export const FUZZ_SUITE_RESULT_SCHEMA = "wp-codebox/fuzz-suite-result/v1" as const

export type FuzzSuiteTargetKind = "ability" | "command" | "http" | "rest" | "runtime" | "runtime-action" | (string & {})
export type FuzzSuiteCaseStatus = "passed" | "failed" | "error" | "skipped"
export type FuzzSuiteDiagnosticSeverity = "error" | "warning" | "info"

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
  const diagnostics = input.diagnostics ?? []
  const artifactRefs = dedupeArtifactRefs([...(input.artifactRefs ?? []), ...cases.flatMap((item) => item.artifactRefs ?? [])])
  const summary = summarizeFuzzCases(cases)
  const coverageSummary = input.coverageSummary ?? summarizeFuzzCoverage({ discovered: fuzzSuiteDiscoveredCount(input.suite, cases.length), cases })
  const status: FuzzSuiteCaseStatus = summary.error > 0 ? "error" : summary.failed > 0 ? "failed" : summary.skipped === summary.total && summary.total > 0 ? "skipped" : "passed"

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
