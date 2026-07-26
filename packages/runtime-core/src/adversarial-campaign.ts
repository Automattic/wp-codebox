import { createHash } from "node:crypto"

import { stableJson, stripUndefined } from "./object-utils.js"
import type { TransportFaultModel } from "./transport-faults.js"

export const ADVERSARIAL_CAMPAIGN_SCHEMA = "wp-codebox/adversarial-campaign/v1" as const
export const ADVERSARIAL_CAMPAIGN_RESULT_SCHEMA = "wp-codebox/adversarial-campaign-result/v1" as const
export const ADVERSARIAL_FINDING_SCHEMA = "wp-codebox/adversarial-finding/v1" as const
export const ADVERSARIAL_REPLAY_SCHEMA = "wp-codebox/adversarial-replay/v1" as const
export const ADVERSARIAL_ORACLE_SCHEMA = "wp-codebox/adversarial-oracle/v1" as const
export const DIFFERENTIAL_RESULT_SCHEMA = "wp-codebox/differential-result/v1" as const

export type AdversarialMutationKind = "scalar" | "structured" | "binary" | "sequence"
export type AdversarialCaseStatus = "passed" | "failed" | "error" | "timed-out" | "resource-exhausted"

export interface AdversarialAction {
  type: string
  input?: unknown
  metadata?: Record<string, unknown>
}

export interface AdversarialCorpusEntry {
  id: string
  actions: AdversarialAction[]
  input?: unknown
  signals?: string[]
  metadata?: Record<string, unknown>
}

export interface AdversarialResourceBudget {
  maxCases: number
  maxActionsPerCase: number
  maxInputBytes: number
  maxCaseTimeMs: number
  maxWallTimeMs: number
  maxArtifactBytes: number
  workers: number
}

export interface AdversarialMatrixDimension {
  name: string
  values: string[]
}

export interface AdversarialOracleContract {
  schema: typeof ADVERSARIAL_ORACLE_SCHEMA
  id: string
  severity: "low" | "medium" | "high" | "critical"
  description?: string
  metadata?: Record<string, unknown>
}

export interface AdversarialCampaign {
  schema: typeof ADVERSARIAL_CAMPAIGN_SCHEMA
  id: string
  seed: string
  corpus: AdversarialCorpusEntry[]
  mutationKinds: AdversarialMutationKind[]
  budgets: AdversarialResourceBudget
  oracles: AdversarialOracleContract[]
  matrix?: AdversarialMatrixDimension[]
  faults?: TransportFaultModel
  provenance?: Record<string, unknown>
  replayCommand?: string
  metadata?: Record<string, unknown>
}

export interface AdversarialCasePlan extends AdversarialCorpusEntry {
  caseId: string
  corpusId: string
  iteration: number
  workerId: number
  matrix: Record<string, string>
  mutation: { kind: AdversarialMutationKind; path: string; description: string }
}

export interface AdversarialExecutionObservation {
  status: AdversarialCaseStatus
  signals?: string[]
  diagnostics?: Array<{ code: string; message: string; severity?: string; metadata?: Record<string, unknown> }>
  artifacts?: Array<{ path: string; kind: string; bytes?: number; sha256?: string }>
  stateDigest?: string
  metrics?: { durationMs?: number; memoryBytes?: number; cpuMs?: number; [name: string]: number | undefined }
  metadata?: Record<string, unknown>
}

export interface AdversarialOracleResult {
  oracleId: string
  failed: boolean
  code?: string
  message?: string
  evidence?: Record<string, unknown>
}

export interface AdversarialFinding {
  schema: typeof ADVERSARIAL_FINDING_SCHEMA
  fingerprint: string
  caseId: string
  corpusId: string
  oracleIds: string[]
  status: AdversarialCaseStatus
  minimized: AdversarialCorpusEntry
  original: AdversarialCorpusEntry
  replay: AdversarialReplay
  diagnostics: AdversarialExecutionObservation["diagnostics"]
  artifactRefs: NonNullable<AdversarialExecutionObservation["artifacts"]>
  secretScan: { status: "passed" | "redacted"; redactions: number }
  duplicates: number
  matrix: Record<string, string>
}

export interface AdversarialReplay {
  schema: typeof ADVERSARIAL_REPLAY_SCHEMA
  campaignId: string
  seed: string
  caseId: string
  corpusId: string
  workerId: number
  iteration: number
  matrix: Record<string, string>
  actions: AdversarialAction[]
  input?: unknown
  faultSchedule?: TransportFaultModel
  schedule: AdversarialScheduleEntry[]
  provenance?: Record<string, unknown>
  command: string
  expectedFingerprint?: string
  expectedStateDigest?: string
}

export interface AdversarialScheduleEntry {
  round: number
  workerId: number
  caseId: string
  corpusId: string
  iteration: number
}

export interface AdversarialCampaignResult {
  schema: typeof ADVERSARIAL_CAMPAIGN_RESULT_SCHEMA
  campaignId: string
  seed: string
  status: "passed" | "findings" | "incomplete"
  summary: { generated: number; executed: number; retained: number; findings: number; duplicates: number; timedOut: number }
  corpus: AdversarialCorpusEntry[]
  findings: AdversarialFinding[]
  schedule: AdversarialScheduleEntry[]
  noveltySignals: string[]
  diagnostics: Array<{ code: string; message: string }>
  resourceUsage: { wallTimeMs: number; artifactBytes: number }
}

export interface AdversarialCampaignRunnerOptions {
  execute(plan: AdversarialCasePlan, signal: AbortSignal): Promise<AdversarialExecutionObservation>
  evaluate?(plan: AdversarialCasePlan, observation: AdversarialExecutionObservation, oracles: readonly AdversarialOracleContract[]): Promise<AdversarialOracleResult[]> | AdversarialOracleResult[]
  now?: () => number
  replayCommand?: (campaign: AdversarialCampaign, plan: AdversarialCasePlan, fingerprint: string) => string
  signal?: AbortSignal
  retainNovelty?: boolean
  minimize?: boolean
}

export interface DifferentialCell {
  id: string
  role?: "base" | "candidate"
  runtime?: Record<string, string>
  fingerprint?: string
  status: AdversarialCaseStatus | "missing"
}

export interface DifferentialResult {
  schema: typeof DIFFERENTIAL_RESULT_SCHEMA
  classification: "candidate-regression" | "pre-existing" | "platform-difference" | "nondeterminism" | "equivalent"
  cells: DifferentialCell[]
  fingerprints: string[]
}

export function adversarialCampaign(input: Omit<AdversarialCampaign, "schema" | "budgets" | "mutationKinds" | "oracles"> & { budgets?: Partial<AdversarialResourceBudget>; mutationKinds?: AdversarialMutationKind[]; oracles?: AdversarialOracleContract[] }): AdversarialCampaign {
  if (!input.id || !input.seed) throw new Error("Adversarial campaigns require non-empty id and seed values.")
  if (input.corpus.length === 0) throw new Error("Adversarial campaigns require at least one corpus entry.")
  const ids = new Set<string>()
  for (const entry of input.corpus) {
    if (!entry.id || ids.has(entry.id)) throw new Error(`Adversarial corpus ids must be non-empty and unique: ${entry.id}`)
    ids.add(entry.id)
  }
  return stripUndefined({
    schema: ADVERSARIAL_CAMPAIGN_SCHEMA,
    id: input.id,
    seed: input.seed,
    corpus: input.corpus.map(normalizeCorpusEntry),
    mutationKinds: input.mutationKinds?.length ? [...new Set(input.mutationKinds)] : ["scalar", "structured", "binary", "sequence"] as AdversarialMutationKind[],
    budgets: normalizeBudgets(input.budgets),
    oracles: input.oracles ?? [],
    matrix: input.matrix,
    faults: input.faults,
    provenance: input.provenance,
    replayCommand: input.replayCommand,
    metadata: input.metadata,
  })
}

export async function runAdversarialCampaign(campaignInput: AdversarialCampaign, options: AdversarialCampaignRunnerOptions): Promise<AdversarialCampaignResult> {
  const campaign = adversarialCampaign(campaignInput)
  const started = (options.now ?? Date.now)()
  const corpus = [...campaign.corpus]
  const novelty = new Set(corpus.flatMap((entry) => entry.signals ?? []))
  const findings = new Map<string, AdversarialFinding>()
  const schedule: AdversarialScheduleEntry[] = []
  const diagnostics: AdversarialCampaignResult["diagnostics"] = []
  let executed = 0
  let generated = 0
  let artifactBytes = 0
  let timedOut = 0
  let incomplete = false

  for (let round = 0; generated < campaign.budgets.maxCases; round += 1) {
    if (options.signal?.aborted) { incomplete = true; diagnostics.push({ code: "campaign-interrupted", message: "Campaign stopped after an interruption request." }); break }
    if ((options.now ?? Date.now)() - started >= campaign.budgets.maxWallTimeMs) { incomplete = true; diagnostics.push({ code: "campaign-wall-time-exhausted", message: "Campaign stopped at its wall-time budget." }); break }
    const roundPlans: AdversarialCasePlan[] = []
    for (let workerId = 0; workerId < campaign.budgets.workers && generated < campaign.budgets.maxCases; workerId += 1) {
      const corpusEntry = corpus[deterministicInteger(`${campaign.seed}:source:${generated}`, corpus.length)] as AdversarialCorpusEntry
      const plan = mutateCorpusEntry(campaign, corpusEntry, generated, workerId)
      roundPlans.push(plan)
      schedule.push({ round, workerId, caseId: plan.caseId, corpusId: plan.corpusId, iteration: plan.iteration })
      generated += 1
    }
    const observations = await Promise.all(roundPlans.map(async (plan) => await executeBoundedCase(campaign, plan, options)))
    for (let index = 0; index < roundPlans.length; index += 1) {
      const plan = roundPlans[index] as AdversarialCasePlan
      const observation = observations[index] as AdversarialExecutionObservation
      executed += 1
      if (observation.status === "timed-out") timedOut += 1
      artifactBytes += (observation.artifacts ?? []).reduce((total, artifact) => total + (artifact.bytes ?? 0), 0)
      if (artifactBytes > campaign.budgets.maxArtifactBytes) { incomplete = true; diagnostics.push({ code: "campaign-artifact-budget-exhausted", message: "Campaign stopped before artifact evidence exceeded its byte budget." }); break }

      const newSignals = (observation.signals ?? []).filter((signal) => !novelty.has(signal))
      for (const signal of newSignals) novelty.add(signal)
      if (newSignals.length > 0 && options.retainNovelty !== false) corpus.push({ id: plan.caseId, actions: plan.actions, input: plan.input, signals: [...new Set(observation.signals ?? [])], metadata: { retainedFrom: plan.corpusId, mutation: plan.mutation } })

      const oracleResults = options.evaluate ? await options.evaluate(plan, observation, campaign.oracles) : defaultOracleResults(observation)
      const failedOracles = oracleResults.filter((result) => result.failed)
      if (failedOracles.length > 0 || observation.status !== "passed") {
        if (options.signal?.aborted) { incomplete = true; diagnostics.push({ code: "campaign-interrupted", message: "Campaign stopped before finding minimization after an interruption request." }); break }
        const fingerprint = observationFingerprint(plan, observation, failedOracles)
        const minimized = options.minimize === false ? normalizeCorpusEntry({ id: plan.caseId, actions: plan.actions, input: plan.input }) : await minimizeAdversarialCase(campaign, plan, failedOracles, fingerprint, options)
        const existing = findings.get(fingerprint)
        if (existing) existing.duplicates += 1
        else findings.set(fingerprint, createFinding(campaign, plan, minimized, observation, failedOracles, schedule, options, fingerprint))
      }
    }
    if (incomplete) break
  }

  const duplicateCount = [...findings.values()].reduce((total, finding) => total + finding.duplicates, 0)
  return {
    schema: ADVERSARIAL_CAMPAIGN_RESULT_SCHEMA,
    campaignId: campaign.id,
    seed: campaign.seed,
    status: incomplete ? "incomplete" : findings.size > 0 ? "findings" : "passed",
    summary: { generated, executed, retained: corpus.length, findings: findings.size, duplicates: duplicateCount, timedOut },
    corpus,
    findings: [...findings.values()].sort((left, right) => left.fingerprint.localeCompare(right.fingerprint)),
    schedule,
    noveltySignals: [...novelty].sort(),
    diagnostics,
    resourceUsage: { wallTimeMs: Math.max(0, (options.now ?? Date.now)() - started), artifactBytes },
  }
}

export function mutateAdversarialValue(value: unknown, kind: AdversarialMutationKind, seed: string): { value: unknown; path: string; description: string } {
  if (kind === "sequence") return { value, path: "$", description: "sequence mutation is applied to actions" }
  const leaves = collectValueLeaves(value)
  if (leaves.length === 0) return { value: adversarialBoundaryValue(undefined, seed, kind), path: "$", description: `${kind} root boundary` }
  const leaf = leaves[deterministicInteger(seed, leaves.length)] as { path: Array<string | number>; value: unknown }
  const replacement = adversarialBoundaryValue(leaf.value, seed, kind)
  if (leaf.path.length === 0) return { value: replacement, path: "$", description: `${kind} root boundary mutation` }
  const mutated = cloneJsonValue(value)
  setValueAtPath(mutated, leaf.path, replacement)
  return { value: mutated, path: jsonPath(leaf.path), description: `${kind} boundary mutation` }
}

export function adversarialFindingFingerprint(value: unknown): string {
  return createHash("sha256").update("wp-codebox/adversarial-finding-fingerprint/v1\n").update(stableJson(value)).digest("hex")
}

export function classifyDifferentialResult(cells: DifferentialCell[]): DifferentialResult {
  const fingerprints = [...new Set(cells.map((cell) => cell.fingerprint).filter((value): value is string => Boolean(value)))].sort()
  const base = cells.filter((cell) => cell.role === "base")
  const candidate = cells.filter((cell) => cell.role === "candidate")
  let classification: DifferentialResult["classification"] = "equivalent"
  if (cells.some((cell) => cell.status === "missing") || cells.some((cell, index) => cells.findIndex((candidateCell) => candidateCell.id === cell.id) !== index)) classification = "nondeterminism"
  else if (candidate.some(isDifferentialFailure) && base.every((cell) => !isDifferentialFailure(cell))) classification = "candidate-regression"
  else if (candidate.some(isDifferentialFailure) && base.some(isDifferentialFailure)) classification = "pre-existing"
  else if (fingerprints.length > 1 || new Set(cells.map((cell) => cell.status)).size > 1) classification = "platform-difference"
  return { schema: DIFFERENTIAL_RESULT_SCHEMA, classification, cells, fingerprints }
}

async function executeBoundedCase(campaign: AdversarialCampaign, plan: AdversarialCasePlan, options: AdversarialCampaignRunnerOptions): Promise<AdversarialExecutionObservation> {
  const controller = new AbortController()
  const abort = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener("abort", abort, { once: true })
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      options.execute(plan, controller.signal),
      new Promise<AdversarialExecutionObservation>((resolve) => { timer = setTimeout(() => { controller.abort(); resolve({ status: "timed-out", diagnostics: [{ code: "case-time-budget-exhausted", message: `Case exceeded ${campaign.budgets.maxCaseTimeMs}ms.` }] }) }, campaign.budgets.maxCaseTimeMs) }),
    ])
  } catch (error) {
    return { status: "error", diagnostics: [{ code: "case-execution-error", message: error instanceof Error ? error.message : String(error) }] }
  } finally {
    if (timer) clearTimeout(timer)
    options.signal?.removeEventListener("abort", abort)
  }
}

function mutateCorpusEntry(campaign: AdversarialCampaign, source: AdversarialCorpusEntry, iteration: number, workerId: number): AdversarialCasePlan {
  const kind = campaign.mutationKinds[deterministicInteger(`${campaign.seed}:kind:${iteration}`, campaign.mutationKinds.length)] as AdversarialMutationKind
  let actions: AdversarialAction[] = source.actions.map((action) => ({ ...action, input: cloneJsonValue(action.input) }))
  let input = cloneJsonValue(source.input)
  let mutation = { kind, path: "$", description: `${kind} mutation` }
  if (kind === "sequence") {
    actions = mutateActionSequence(actions, `${campaign.seed}:sequence:${iteration}`, campaign.budgets.maxActionsPerCase)
    mutation = { kind, path: "$.actions", description: "stateful action schedule mutation" }
  } else if (actions.length > 0 && deterministicInteger(`${campaign.seed}:target:${iteration}`, 2) === 0) {
    const actionIndex = deterministicInteger(`${campaign.seed}:action:${iteration}`, actions.length)
    const result = mutateAdversarialValue(actions[actionIndex]?.input, kind, `${campaign.seed}:value:${iteration}`)
    actions[actionIndex] = { ...(actions[actionIndex] as AdversarialAction), input: result.value }
    mutation = { kind, path: `$.actions[${actionIndex}].input${result.path.slice(1)}`, description: result.description }
  } else {
    const result = mutateAdversarialValue(input, kind, `${campaign.seed}:value:${iteration}`)
    input = result.value
    mutation = { kind, path: `$.input${result.path.slice(1)}`, description: result.description }
  }
  actions = actions.slice(0, campaign.budgets.maxActionsPerCase)
  if (jsonBytes(input) > campaign.budgets.maxInputBytes) input = truncateJsonValue(input, campaign.budgets.maxInputBytes)
  const matrix = matrixCell(campaign.matrix, iteration)
  return { id: `${source.id}-mutation-${iteration}`, caseId: `${campaign.id}-${iteration}`, corpusId: source.id, iteration, workerId, matrix, actions, input, mutation, metadata: source.metadata }
}

async function minimizeAdversarialCase(campaign: AdversarialCampaign, plan: AdversarialCasePlan, originalOracles: AdversarialOracleResult[], expectedFingerprint: string, options: AdversarialCampaignRunnerOptions): Promise<AdversarialCorpusEntry> {
  const oracleIds = new Set(originalOracles.filter((item) => item.failed).map((item) => item.oracleId))
  const preserves = async (candidate: AdversarialCorpusEntry): Promise<boolean> => {
    if (options.signal?.aborted) return false
    const candidatePlan = { ...plan, actions: candidate.actions, input: candidate.input }
    const observation = await executeBoundedCase(campaign, candidatePlan, options)
    const oracleResults = options.evaluate ? await options.evaluate(candidatePlan, observation, campaign.oracles) : defaultOracleResults(observation)
    const preservesOracle = observation.status !== "passed" || oracleResults.some((item) => item.failed && (oracleIds.size === 0 || oracleIds.has(item.oracleId)))
    return preservesOracle && observationFingerprint(candidatePlan, observation, oracleResults.filter((item) => item.failed)) === expectedFingerprint
  }
  let actions = [...plan.actions]
  let chunk = Math.max(1, Math.floor(actions.length / 2))
  while (actions.length > 1 && chunk >= 1) {
    let reduced = false
    for (let start = 0; start < actions.length; start += chunk) {
      const candidate = [...actions.slice(0, start), ...actions.slice(start + chunk)]
      if (candidate.length === 0) continue
      if (await preserves({ id: plan.caseId, actions: candidate, input: plan.input })) { actions = candidate; reduced = true; break }
    }
    if (!reduced) chunk = Math.floor(chunk / 2)
  }
  for (let actionIndex = 0; actionIndex < actions.length; actionIndex += 1) {
    for (const candidateInput of shrinkAdversarialValue(actions[actionIndex]?.input)) {
      const candidateActions = actions.map((action, index) => index === actionIndex ? { ...action, input: candidateInput } : action)
      if (await preserves({ id: plan.caseId, actions: candidateActions, input: plan.input })) actions = candidateActions
    }
  }
  let input = plan.input
  for (const candidateInput of shrinkAdversarialValue(input)) {
    if (await preserves({ id: plan.caseId, actions, input: candidateInput })) input = candidateInput
  }
  return stripUndefined({ id: plan.caseId, actions, input, metadata: { minimizedFrom: plan.corpusId } })
}

function createFinding(campaign: AdversarialCampaign, plan: AdversarialCasePlan, minimized: AdversarialCorpusEntry, observation: AdversarialExecutionObservation, oracles: AdversarialOracleResult[], schedule: AdversarialScheduleEntry[], options: AdversarialCampaignRunnerOptions, fingerprint: string): AdversarialFinding {
  const command = options.replayCommand?.(campaign, plan, fingerprint) ?? campaign.replayCommand ?? `wp-codebox adversarial replay --campaign ${campaign.id} --case ${plan.caseId}`
  return {
    schema: ADVERSARIAL_FINDING_SCHEMA,
    fingerprint,
    caseId: plan.caseId,
    corpusId: plan.corpusId,
    oracleIds: oracles.filter((item) => item.failed).map((item) => item.oracleId).sort(),
    status: observation.status,
    minimized,
    original: { id: plan.caseId, actions: plan.actions, input: plan.input },
    replay: stripUndefined({ schema: ADVERSARIAL_REPLAY_SCHEMA, campaignId: campaign.id, seed: campaign.seed, caseId: plan.caseId, corpusId: plan.corpusId, workerId: plan.workerId, iteration: plan.iteration, matrix: plan.matrix, actions: minimized.actions, input: minimized.input, faultSchedule: campaign.faults, schedule: [...schedule], provenance: campaign.provenance, command, expectedFingerprint: fingerprint, expectedStateDigest: observation.stateDigest }),
    diagnostics: observation.diagnostics ?? [],
    artifactRefs: observation.artifacts ?? [],
    secretScan: { status: "passed", redactions: 0 },
    duplicates: 0,
    matrix: plan.matrix,
  }
}

function defaultOracleResults(observation: AdversarialExecutionObservation): AdversarialOracleResult[] {
  return observation.status === "passed" ? [] : [{ oracleId: "runtime-status", failed: true, code: observation.status, message: observation.diagnostics?.[0]?.message ?? `Runtime status was ${observation.status}.` }]
}

function observationFingerprint(plan: AdversarialCasePlan, observation: AdversarialExecutionObservation, oracles: AdversarialOracleResult[]): string {
  return adversarialFindingFingerprint({
    oracleIds: oracles.filter((result) => result.failed).map((result) => result.oracleId).sort(),
    status: observation.status,
    diagnosticCodes: (observation.diagnostics ?? []).map((item) => item.code).sort(),
    stateDigest: observation.stateDigest,
    matrix: plan.matrix,
  })
}

function normalizeBudgets(input: Partial<AdversarialResourceBudget> | undefined): AdversarialResourceBudget {
  return {
    maxCases: boundedInteger(input?.maxCases, 100, 1, 100_000),
    maxActionsPerCase: boundedInteger(input?.maxActionsPerCase, 50, 1, 10_000),
    maxInputBytes: boundedInteger(input?.maxInputBytes, 1_048_576, 1, 64 * 1_048_576),
    maxCaseTimeMs: boundedInteger(input?.maxCaseTimeMs, 30_000, 1, 3_600_000),
    maxWallTimeMs: boundedInteger(input?.maxWallTimeMs, 300_000, 1, 86_400_000),
    maxArtifactBytes: boundedInteger(input?.maxArtifactBytes, 100 * 1_048_576, 1, 4 * 1024 * 1_048_576),
    workers: boundedInteger(input?.workers, 1, 1, 128),
  }
}

function normalizeCorpusEntry(entry: AdversarialCorpusEntry): AdversarialCorpusEntry {
  return stripUndefined({ ...entry, actions: entry.actions.map((action) => ({ ...action, input: cloneJsonValue(action.input) })), input: cloneJsonValue(entry.input), signals: entry.signals ? [...new Set(entry.signals)].sort() : undefined })
}

function mutateActionSequence(actions: AdversarialAction[], seed: string, maximum: number): AdversarialAction[] {
  if (actions.length === 0) return [{ type: "noop", metadata: { generated: true } }]
  const operation = deterministicInteger(seed, 4)
  const index = deterministicInteger(`${seed}:index`, actions.length)
  if (operation === 0 && actions.length > 1) return actions.filter((_, candidate) => candidate !== index)
  if (operation === 1 && actions.length < maximum) return [...actions.slice(0, index), actions[index] as AdversarialAction, actions[index] as AdversarialAction, ...actions.slice(index + 1)]
  if (operation === 2 && actions.length > 1) {
    const reordered = [...actions]
    const target = (index + 1) % actions.length
    ;[reordered[index], reordered[target]] = [reordered[target] as AdversarialAction, reordered[index] as AdversarialAction]
    return reordered
  }
  return [...actions, actions[index] as AdversarialAction].slice(0, maximum)
}

function adversarialBoundaryValue(value: unknown, seed: string, kind: AdversarialMutationKind): unknown {
  if (kind === "binary") {
    const bytes = typeof value === "string" ? Buffer.from(value) : Buffer.from(stableJson(value))
    if (bytes.length === 0) return { encoding: "base64", data: "/w==" }
    bytes[deterministicInteger(seed, bytes.length)] = (bytes[deterministicInteger(`${seed}:byte`, bytes.length)] ?? 0) ^ 0xff
    return { encoding: "base64", data: bytes.toString("base64") }
  }
  if (typeof value === "string") {
    const boundaries = ["", "\u0000", "'\"<>\\", "../".repeat(32), "A".repeat(4096), "\u202e\u2066hostile\u2069", "😀".repeat(256)]
    return boundaries[deterministicInteger(seed, boundaries.length)]
  }
  if (typeof value === "number") return [0, -1, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER][deterministicInteger(seed, 4)]
  if (typeof value === "boolean") return !value
  if (value === null || value === undefined) return { unexpected: true }
  if (Array.isArray(value)) return value.length === 0 ? [null] : [...value, cloneJsonValue(value[0])]
  if (typeof value === "object") return { ...(value as Record<string, unknown>), __unexpected: { nested: true } }
  return String(value)
}

function shrinkAdversarialValue(value: unknown): unknown[] {
  if (typeof value === "string") return ["", value.slice(0, Math.floor(value.length / 2)), value.slice(0, 1)]
  if (typeof value === "number") return [0, Math.sign(value)]
  if (Array.isArray(value)) return [[], value.slice(0, Math.max(1, Math.floor(value.length / 2)))]
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
    return entries.map(([key]) => Object.fromEntries(entries.filter(([candidate]) => candidate !== key)))
  }
  return []
}

function collectValueLeaves(value: unknown, path: Array<string | number> = []): Array<{ path: Array<string | number>; value: unknown }> {
  if (Array.isArray(value)) return value.flatMap((item, index) => collectValueLeaves(item, [...path, index]))
  if (value && typeof value === "object") return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => collectValueLeaves(item, [...path, key]))
  return [{ path, value }]
}

function setValueAtPath(root: unknown, path: Array<string | number>, value: unknown): void {
  if (path.length === 0) return
  let current = root as Record<string | number, unknown>
  for (const segment of path.slice(0, -1)) current = current[segment] as Record<string | number, unknown>
  current[path[path.length - 1] as string | number] = value
}

function matrixCell(dimensions: AdversarialMatrixDimension[] | undefined, iteration: number): Record<string, string> {
  const cell: Record<string, string> = {}
  let divisor = 1
  for (const dimension of dimensions ?? []) {
    if (dimension.values.length === 0) continue
    cell[dimension.name] = dimension.values[Math.floor(iteration / divisor) % dimension.values.length] as string
    divisor *= dimension.values.length
  }
  return cell
}

function truncateJsonValue(value: unknown, maximumBytes: number): unknown {
  if (typeof value === "string") return value.slice(0, maximumBytes)
  const serialized = stableJson(value)
  return { truncated: true, sha256: createHash("sha256").update(serialized).digest("hex"), originalBytes: Buffer.byteLength(serialized) }
}

function cloneJsonValue<T>(value: T): T {
  if (value === undefined) return value
  return structuredClone(value)
}

function jsonBytes(value: unknown): number {
  return value === undefined ? 0 : Buffer.byteLength(stableJson(value))
}

function jsonPath(path: Array<string | number>): string {
  return `$${path.map((segment) => typeof segment === "number" ? `[${segment}]` : `.${segment}`).join("")}`
}

function deterministicInteger(seed: string, maximum: number): number {
  if (maximum <= 1) return 0
  return createHash("sha256").update(seed).digest().readUInt32BE(0) % maximum
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(minimum, Math.min(maximum, Math.floor(value as number)))
}

function isDifferentialFailure(cell: DifferentialCell): boolean {
  return cell.status !== "passed" && cell.status !== "missing"
}
