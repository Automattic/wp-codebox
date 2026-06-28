import { stripUndefined } from "./object-utils.js"
import { fuzzCoveragePlanContract, type FuzzCoveragePlanContract, type FuzzCoveragePlanItem } from "./fuzz-coverage-plan-contracts.js"

export const FUZZ_SUITE_SCHEMA = "wp-codebox/fuzz-suite/v1" as const
export const FUZZ_SUITE_RESULT_SCHEMA = "wp-codebox/fuzz-suite-result/v1" as const
export const FUZZ_RUNNER_CAPABILITIES_SCHEMA = "wp-codebox/fuzz-runner-capabilities/v1" as const
export const FUZZ_RUNNER_READINESS_SCHEMA = "wp-codebox/fuzz-runner-readiness/v1" as const

export type FuzzSuiteTargetKind = "ability" | "command" | "http" | "rest" | "runtime" | "runtime-action" | (string & {})
export type FuzzSuiteCaseStatus = "passed" | "failed" | "error" | "skipped"
export type FuzzSuiteDiagnosticSeverity = "error" | "warning" | "info"
export type FuzzSuiteRunnerMode = "php-in-process" | "runtime-backed" | (string & {})
export type FuzzSuiteResetMode = "none" | "checkpoint-per-case" | "restore-snapshot"
export type FuzzSuiteResetStatus = "not-required" | "passed" | "failed" | "unsupported"
export type FuzzSuiteMutationIntensity = "none" | "low" | "medium" | "high" | (string & {})
export type FuzzSuiteMutationIntentKind = "read" | "write" | "delete" | "destructive" | (string & {})
export type FuzzSuiteCasePhase = "setup" | "action" | "assert" | "teardown"

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
  phases?: Partial<Record<FuzzSuiteCasePhase, FuzzSuitePhaseStep[]>>
  resetPolicy?: FuzzSuiteResetPolicy
  reset_policy?: FuzzSuiteResetPolicy | string
  mutation?: FuzzSuiteMutationIntent
  mutation_intent?: FuzzSuiteMutationIntent | string
  description?: string
  metadata?: Record<string, unknown>
}

export interface FuzzSuitePhaseStep {
  command: string
  args?: string[]
  timeoutMs?: number
  timeout_ms?: number
  allowFailure?: boolean
  allow_failure?: boolean
  advisory?: boolean
  metadata?: Record<string, unknown>
}

export interface FuzzSuiteMutationIntent {
  intent?: FuzzSuiteMutationIntentKind
  destructive?: boolean
  intensity?: FuzzSuiteMutationIntensity
  resetRequired?: boolean
  reset_required?: boolean
  metadata?: Record<string, unknown>
}

export interface FuzzSuiteResetPolicy {
  mode: FuzzSuiteResetMode | (string & {})
  checkpointName?: string
  checkpoint_name?: string
  snapshotRef?: string
  snapshot_ref?: string
  fixtureRefs?: string[]
  fixture_refs?: string[]
  metadata?: Record<string, unknown>
}

export interface FuzzSuiteCaseResetResult {
  mode: FuzzSuiteResetMode | (string & {})
  status: FuzzSuiteResetStatus
  checkpointName?: string
  snapshotRef?: string
  fixtureRefs?: string[]
  artifactRefs?: FuzzSuiteArtifactRef[]
  diagnostics?: FuzzSuiteDiagnostic[]
  metadata?: Record<string, unknown>
}

export interface FuzzSuiteContract {
  schema: typeof FUZZ_SUITE_SCHEMA
  id: string
  version?: string
  target?: FuzzSuiteTargetRef
  resetPolicy?: FuzzSuiteResetPolicy
  reset_policy?: FuzzSuiteResetPolicy | string
  mutation?: FuzzSuiteMutationIntent
  mutation_intent?: FuzzSuiteMutationIntent | string
  cases: FuzzSuiteCase[]
  coveragePlan?: FuzzCoveragePlanContract
  metadata?: Record<string, unknown>
}

export interface FuzzSuiteRunnerCapabilities {
  schema?: typeof FUZZ_RUNNER_CAPABILITIES_SCHEMA
  mode: FuzzSuiteRunnerMode
  entrypoint?: string
  capabilities: string[]
  targetKinds: string[]
  operationKinds?: string[]
  runtimeActionTypes?: string[]
  commands?: string[]
  unsupportedRequiredCapabilities?: string[]
  metadata?: Record<string, unknown>
}

export interface FuzzRunnerCapabilitiesContract extends FuzzSuiteRunnerCapabilities {
  schema: typeof FUZZ_RUNNER_CAPABILITIES_SCHEMA
  unsupportedRequiredCapabilities: string[]
}

export interface FuzzRunnerReadinessContract {
  schema: typeof FUZZ_RUNNER_READINESS_SCHEMA
  status: "ready" | "unsupported"
  entrypoint: string
  mode: FuzzSuiteRunnerMode
  capabilities: FuzzRunnerCapabilitiesContract
  operationKinds: string[]
  unsupportedRequiredCapabilities: string[]
  metadata?: Record<string, unknown>
}

export interface FuzzRunnerRequiredCapabilities {
  capabilities?: readonly string[]
  targetKinds?: readonly string[]
  target_kinds?: readonly string[]
  runtimeActionTypes?: readonly string[]
  runtime_action_types?: readonly string[]
  commands?: readonly string[]
}

export const PHP_IN_PROCESS_FUZZ_SUITE_RUNNER_CAPABILITIES: FuzzSuiteRunnerCapabilities = {
  schema: FUZZ_RUNNER_CAPABILITIES_SCHEMA,
  mode: "php-in-process",
  entrypoint: "run-fuzz-suite",
  capabilities: ["target:ability", "target:http", "target:rest"],
  targetKinds: ["ability", "http", "rest"],
  operationKinds: ["read"],
  unsupportedRequiredCapabilities: [],
}

export const RUNTIME_BACKED_FUZZ_SUITE_RUNNER_CAPABILITIES: FuzzSuiteRunnerCapabilities = {
  schema: FUZZ_RUNNER_CAPABILITIES_SCHEMA,
  mode: "runtime-backed",
  entrypoint: "run-fuzz-suite --runner-mode=runtime-backed",
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
    "runtime-action:random_walk",
    "runtime-action:crud_operation",
    "runtime-action:db_operation",
    "runtime-action:editor_open",
    "runtime-action:page",
    "runtime-action:php",
    "runtime-action:rest_request",
    "runtime-action:sequence",
    "runtime-action:wp_cli",
    "db_operation",
    "rest-mutation:fixture-opt-in",
    "mutation-isolation-artifact",
    "delete-boundary-artifact",
    "rest-mutation:post:mutation-isolation-artifact",
    "rest-mutation:put:mutation-isolation-artifact",
    "rest-mutation:patch:mutation-isolation-artifact",
    "rest-mutation:delete:delete-boundary-artifact",
  ],
  targetKinds: ["ability", "command", "http", "rest", "runtime", "runtime-action"],
  operationKinds: ["read", "crud", "mutation-isolation", "delete-boundary"],
  runtimeActionTypes: ["admin_page", "browser", "browser_probe", "crud_operation", "db_operation", "editor_open", "page", "php", "random_walk", "rest_request", "sequence", "wp_cli"],
  commands: ["wp-codebox.checkpoint-create", "wp-codebox.checkpoint-list", "wp-codebox.checkpoint-restore", "wordpress.ability", "wordpress.browser-actions", "wordpress.browser-page-load", "wordpress.browser-probe", "wordpress.collect-workload-result", "wordpress.crud-operation", "wordpress.db-operation", "wordpress.editor-open", "wordpress.fuzz-admin-pages", "wordpress.fuzz-plugin-module-state", "wordpress.http-request", "wordpress.inventory-plugin-module-options-tables", "wordpress.rest-performance-observation", "wordpress.rest-request", "wordpress.run-php", "wordpress.run-workload", "wordpress.server-page-load", "wordpress.simulated-admin-page-load", "wordpress.simulated-frontend-page-load", "wordpress.wp-cli"],
  unsupportedRequiredCapabilities: [],
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
  reset?: FuzzSuiteCaseResetResult
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
  coveragePlan?: FuzzCoveragePlanContract
  cases: FuzzSuiteCaseResult[]
  diagnostics: FuzzSuiteDiagnostic[]
  artifactRefs: FuzzSuiteArtifactRef[]
  metadata?: Record<string, unknown>
}

export function fuzzSuiteContract(input: {
  id: string
  version?: string
  target?: FuzzSuiteTargetRef
  resetPolicy?: FuzzSuiteResetPolicy
  reset_policy?: FuzzSuiteResetPolicy | string
  mutation?: FuzzSuiteMutationIntent
  mutation_intent?: FuzzSuiteMutationIntent | string
  cases?: FuzzSuiteCase[]
  coveragePlan?: FuzzCoveragePlanContract
  metadata?: Record<string, unknown>
}): FuzzSuiteContract {
  return stripUndefined({
    schema: FUZZ_SUITE_SCHEMA,
    id: input.id,
    version: input.version,
    target: input.target,
    resetPolicy: input.resetPolicy,
    reset_policy: input.reset_policy,
    mutation: input.mutation,
    mutation_intent: input.mutation_intent,
    cases: input.cases ?? [],
    coveragePlan: input.coveragePlan,
    metadata: input.metadata,
  })
}

export function fuzzSuiteResultEnvelope(input: {
  suite: { id: string; version?: string } | FuzzSuiteContract
  cases?: FuzzSuiteCaseResult[]
  diagnostics?: FuzzSuiteDiagnostic[]
  artifactRefs?: FuzzSuiteArtifactRef[]
  coverageSummary?: FuzzSuiteCoverageSummary
  coveragePlan?: FuzzCoveragePlanContract
  metadata?: Record<string, unknown>
}): FuzzSuiteResultEnvelope {
  const cases = (input.cases ?? []).map(normalizeCaseResult)
  const diagnostics = [...(input.diagnostics ?? [])]
  const artifactRefs = dedupeArtifactRefs([...(input.artifactRefs ?? []), ...cases.flatMap((item) => [...(item.artifactRefs ?? []), ...(item.reset?.artifactRefs ?? [])])])
  const summary = summarizeFuzzCases(cases)
  const coverageSummary = input.coverageSummary ?? summarizeFuzzCoverage({ discovered: fuzzSuiteDiscoveredCount(input.suite, cases.length), cases })
  const coveragePlan = input.coveragePlan ?? fuzzSuiteResultCoveragePlan(input.suite, cases)
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
    coveragePlan,
    cases,
    diagnostics,
    artifactRefs,
    metadata: input.metadata,
  })
}

export function fuzzSuiteRequiredRunnerCapabilities(suite: FuzzSuiteContract): string[] {
  const metadata = fuzzSuiteMetadata(suite)
  const required = recordField(metadata, "requiredRunnerCapabilities") ?? recordField(metadata, "required_runner_capabilities")
  return fuzzRunnerRequiredCapabilities(required, metadata)
}

export function fuzzRunnerCapabilitiesContract(input: FuzzSuiteRunnerCapabilities, required?: FuzzSuiteContract | FuzzRunnerRequiredCapabilities | readonly string[]): FuzzRunnerCapabilitiesContract {
  const requiredCapabilities = Array.isArray(required)
    ? [...required]
    : isFuzzSuiteContract(required)
      ? fuzzSuiteRequiredRunnerCapabilities(required)
      : fuzzRunnerRequiredCapabilities(required)

  return stripUndefined({
    schema: FUZZ_RUNNER_CAPABILITIES_SCHEMA,
    mode: input.mode,
    entrypoint: input.entrypoint,
    capabilities: dedupeStrings(input.capabilities),
    targetKinds: dedupeStrings(input.targetKinds),
    operationKinds: input.operationKinds ? dedupeStrings(input.operationKinds) : undefined,
    runtimeActionTypes: input.runtimeActionTypes ? dedupeStrings(input.runtimeActionTypes) : undefined,
    commands: input.commands ? dedupeStrings(input.commands) : undefined,
    unsupportedRequiredCapabilities: unsupportedRequiredFuzzRunnerCapabilities(requiredCapabilities, input),
    metadata: input.metadata,
  })
}

export function fuzzRunnerReadinessContract(input: FuzzSuiteRunnerCapabilities, required?: FuzzSuiteContract | FuzzRunnerRequiredCapabilities | readonly string[]): FuzzRunnerReadinessContract {
  const capabilities = fuzzRunnerCapabilitiesContract(input, required)
  const unsupportedRequiredCapabilities = capabilities.unsupportedRequiredCapabilities
  const status: FuzzRunnerReadinessContract["status"] = unsupportedRequiredCapabilities.length > 0 ? "unsupported" : "ready"
  return stripUndefined({
    schema: FUZZ_RUNNER_READINESS_SCHEMA,
    status,
    entrypoint: input.entrypoint ?? "run-fuzz-suite",
    mode: input.mode,
    capabilities,
    operationKinds: capabilities.operationKinds ?? [],
    unsupportedRequiredCapabilities,
    metadata: input.metadata,
  })
}

export function unsupportedRequiredFuzzRunnerCapabilities(required: FuzzSuiteContract | FuzzRunnerRequiredCapabilities | readonly string[] | undefined, runnerCapabilities: FuzzSuiteRunnerCapabilities): string[] {
  const requiredCapabilities = Array.isArray(required)
    ? [...required]
    : isFuzzSuiteContract(required)
      ? fuzzSuiteRequiredRunnerCapabilities(required)
      : fuzzRunnerRequiredCapabilities(required)
  const available = new Set([
    ...runnerCapabilities.capabilities,
    ...runnerCapabilities.targetKinds.map((kind) => `target:${kind}`),
    ...(runnerCapabilities.runtimeActionTypes ?? []).map((type) => `runtime-action:${type}`),
    ...(runnerCapabilities.commands ?? []).map((command) => `command:${command}`),
  ])
  return requiredCapabilities.filter((capability) => !available.has(capability))
}

function fuzzRunnerRequiredCapabilities(required?: FuzzRunnerRequiredCapabilities | unknown, metadata?: Record<string, unknown>): string[] {
  const requiredRecord = isRecord(required) ? required : undefined
  return dedupeStrings([
    ...stringArrayField(requiredRecord, "capabilities"),
    ...stringArrayField(requiredRecord, "targetKinds").map((kind) => `target:${kind}`),
    ...stringArrayField(requiredRecord, "target_kinds").map((kind) => `target:${kind}`),
    ...stringArrayField(requiredRecord, "runtimeActionTypes").map((type) => `runtime-action:${type}`),
    ...stringArrayField(requiredRecord, "runtime_action_types").map((type) => `runtime-action:${type}`),
    ...stringArrayField(requiredRecord, "commands").map((command) => `command:${command}`),
    ...stringArrayField(metadata, "requiredCapabilities"),
    ...stringArrayField(metadata, "required_capabilities"),
  ])
}

export function fuzzSuiteCaseResetPolicy(suite: FuzzSuiteContract, fuzzCase: FuzzSuiteCase): FuzzSuiteResetPolicy {
  const candidate = fuzzCase.resetPolicy ?? fuzzCase.reset_policy ?? suite.resetPolicy ?? suite.reset_policy
  return normalizeFuzzSuiteResetPolicy(candidate)
}

export function normalizeFuzzSuiteResetPolicy(input: unknown): FuzzSuiteResetPolicy {
  if (typeof input === "string") {
    return normalizeFuzzSuiteResetPolicyRecord({ mode: input })
  }
  if (isRecord(input)) {
    return normalizeFuzzSuiteResetPolicyRecord(input)
  }
  return { mode: "none" }
}

export function fuzzSuiteResetPolicyDiagnostics(input: unknown, caseId?: string): FuzzSuiteDiagnostic[] {
  const diagnostics: FuzzSuiteDiagnostic[] = []
  const policy = normalizeFuzzSuiteResetPolicy(input)
  if (!isFuzzSuiteResetMode(policy.mode)) {
    diagnostics.push({
      severity: "error",
      code: "fuzz_suite_reset_policy_invalid_mode",
      caseId,
      message: `Fuzz suite reset policy mode is not supported: ${String(policy.mode)}.`,
      metadata: { supportedModes: ["none", "checkpoint-per-case", "restore-snapshot"] },
    })
  }
  if (policy.mode === "restore-snapshot" && !policy.snapshotRef && !policy.snapshot_ref) {
    diagnostics.push({
      severity: "error",
      code: "fuzz_suite_reset_policy_snapshot_ref_required",
      caseId,
      message: "Fuzz suite reset policy mode restore-snapshot requires snapshotRef or snapshot_ref.",
    })
  }
  return diagnostics
}

function isFuzzSuiteContract(value: unknown): value is FuzzSuiteContract {
  return isRecord(value) && value.schema === FUZZ_SUITE_SCHEMA
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
    reset: input.reset,
    skipReason: input.status === "skipped" ? input.skipReason ?? input.diagnostics?.[0]?.code ?? input.diagnostics?.[0]?.message : undefined,
    diagnostics: input.diagnostics ?? [],
    artifactRefs: input.artifactRefs,
    metadata: input.metadata,
  })
}

function fuzzSuiteResultCoveragePlan(suite: { id: string; version?: string } | FuzzSuiteContract, cases: readonly FuzzSuiteCaseResult[]): FuzzCoveragePlanContract | undefined {
  const basePlan = fuzzSuiteCoveragePlan(suite)
  const suiteCases = "cases" in suite && Array.isArray(suite.cases) ? suite.cases : []
  if (basePlan || suiteCases.length > 0 || cases.length > 0) {
    const baseItems = new Map((basePlan?.generated.length ? basePlan.generated : basePlan?.discovered ?? []).map((item) => [item.id, item]))
    const generated = basePlan?.generated.length ? basePlan.generated : suiteCases.map(fuzzSuiteCaseCoveragePlanItem)
    const executed = cases.filter((item) => item.status !== "skipped").map((item) => fuzzSuiteCaseResultCoveragePlanItem(item, baseItems.get(item.id)))
    const skipped = cases.filter((item) => item.status === "skipped").map((item) => fuzzSuiteCaseResultCoveragePlanItem(item, baseItems.get(item.id)))
    return fuzzCoveragePlanContract({
      id: basePlan?.id ?? `${suite.id}-coverage-plan`,
      version: basePlan?.version ?? suite.version,
      discovered: basePlan?.discovered ?? generated,
      generated,
      executable: basePlan?.executable ?? generated,
      executed,
      skipped: [...(basePlan?.skipped ?? []), ...skipped.filter((item) => !basePlan?.skipped.some((baseItem) => baseItem.id === item.id))],
      untested: basePlan?.untested,
      parameterGenerationHooks: basePlan?.parameterGenerationHooks,
      metadata: basePlan?.metadata,
    })
  }
  return undefined
}

function fuzzSuiteCoveragePlan(suite: { id: string; version?: string } | FuzzSuiteContract): FuzzCoveragePlanContract | undefined {
  if ("coveragePlan" in suite && suite.coveragePlan?.schema === "wp-codebox/fuzz-coverage-plan/v1") return suite.coveragePlan
  const metadataCoveragePlan = recordField(fuzzSuiteMetadata(suite), "coveragePlan") ?? recordField(fuzzSuiteMetadata(suite), "coverage_plan")
  return metadataCoveragePlan?.schema === "wp-codebox/fuzz-coverage-plan/v1" ? metadataCoveragePlan as unknown as FuzzCoveragePlanContract : undefined
}

function fuzzSuiteCaseCoveragePlanItem(fuzzCase: FuzzSuiteCase): FuzzCoveragePlanItem {
  return stripUndefined({
    id: fuzzCase.id,
    target: fuzzCase.target,
    description: fuzzCase.description,
    input: fuzzCase.input,
    metadata: stripUndefined({ ...fuzzCase.metadata, mutation: fuzzCase.mutation, mutation_intent: fuzzCase.mutation_intent }),
  })
}

function fuzzSuiteCaseResultCoveragePlanItem(result: FuzzSuiteCaseResult, base?: FuzzCoveragePlanItem): FuzzCoveragePlanItem {
  return stripUndefined({
    ...base,
    id: result.id,
    target: result.target ?? base?.target,
    reason: result.status === "skipped" ? { code: result.skipReason ?? result.diagnostics[0]?.code ?? "fuzz_suite_case_skipped", message: result.diagnostics[0]?.message ?? `Fuzz suite case ${result.id} was skipped.`, data: result.diagnostics[0]?.metadata } : base?.reason,
    metadata: stripUndefined({ ...base?.metadata, status: result.status }),
  })
}

function normalizeFuzzSuiteResetPolicyRecord(input: Record<string, unknown>): FuzzSuiteResetPolicy {
  const fixtureRefs = [...stringArrayField(input, "fixtureRefs"), ...stringArrayField(input, "fixture_refs")]
  return stripUndefined({
    mode: typeof input.mode === "string" ? input.mode : "none",
    checkpointName: typeof input.checkpointName === "string" ? input.checkpointName : undefined,
    checkpoint_name: typeof input.checkpoint_name === "string" ? input.checkpoint_name : undefined,
    snapshotRef: typeof input.snapshotRef === "string" ? input.snapshotRef : undefined,
    snapshot_ref: typeof input.snapshot_ref === "string" ? input.snapshot_ref : undefined,
    fixtureRefs: fixtureRefs.length > 0 ? fixtureRefs : undefined,
    metadata: recordField(input, "metadata"),
  }) as FuzzSuiteResetPolicy
}

function isFuzzSuiteResetMode(mode: string): mode is FuzzSuiteResetMode {
  return mode === "none" || mode === "checkpoint-per-case" || mode === "restore-snapshot"
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
