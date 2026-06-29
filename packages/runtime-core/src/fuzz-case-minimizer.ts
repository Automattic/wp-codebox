import { stripUndefined } from "./object-utils.js"
import { fuzzSuiteContract, type FuzzSuiteCase, type FuzzSuiteCaseResult, type FuzzSuiteContract, type FuzzSuiteDiagnostic, type FuzzSuiteResultEnvelope } from "./fuzz-suite-contracts.js"
import { runFuzzSuite, type FuzzSuiteRunOptions } from "./fuzz-suite-runner.js"
import type { RuntimeAction } from "./runtime-action-adapter.js"

export const FUZZ_MINIMIZE_CASE_INPUT_SCHEMA = "wp-codebox/fuzz-minimize-case-input/v1" as const
export const FUZZ_MINIMIZE_CASE_RESULT_SCHEMA = "wp-codebox/fuzz-minimize-case-result/v1" as const

export interface FuzzReplayCaseInput {
  schema?: "wp-codebox/fuzz-replay-case-input/v1" | (string & {})
  suite?: Partial<FuzzSuiteContract> & { id?: string; version?: string }
  case?: FuzzSuiteCaseResult | FuzzSuiteCase | Record<string, unknown>
  replay?: Record<string, unknown>
  artifactRefs?: unknown[]
  reset?: unknown
}

export interface FuzzMinimizeCaseInput {
  schema?: typeof FUZZ_MINIMIZE_CASE_INPUT_SCHEMA | (string & {})
  replayCase: FuzzReplayCaseInput
  metadata?: Record<string, unknown>
}

export interface FuzzMinimizeCaseResult {
  schema: typeof FUZZ_MINIMIZE_CASE_RESULT_SCHEMA
  status: "reduced" | "unchanged" | "blocked"
  caseId: string
  originalSteps: number
  minimizedSteps: number
  originalStatus?: string
  minimizedCase?: FuzzSuiteCase
  minimizedResult?: FuzzSuiteCaseResult
  diagnostics: FuzzSuiteDiagnostic[]
  attempts: Array<{ stepCount: number; status: string; preserved: boolean; removedRange?: [number, number] }>
  metadata?: Record<string, unknown>
}

export async function minimizeFuzzCase(input: FuzzMinimizeCaseInput | FuzzReplayCaseInput, options: FuzzSuiteRunOptions = {}): Promise<FuzzMinimizeCaseResult> {
  const replayCase = isRecord(input) && isRecord(input.replayCase) ? input.replayCase as FuzzReplayCaseInput : input as FuzzReplayCaseInput
  const caseRecord = isRecord(replayCase.case) ? replayCase.case : {}
  const caseId = stringValue(caseRecord.id) ?? "replay-case"
  const originalStatus = stringValue(caseRecord.status)
  const replay = isRecord(replayCase.replay) ? replayCase.replay : {}
  const sequence = isRecord(replay.sequence) ? replay.sequence : undefined
  const steps = Array.isArray(sequence?.steps) ? sequence.steps.filter(isRuntimeAction) : []

  if (steps.length < 2) {
    return blockedMinimizeResult(caseId, steps.length, originalStatus, "fuzz_minimize_case_sequence_replay_required", "Fuzz case minimization currently requires a replay.sequence.steps array with at least two runtime actions.")
  }
  if (originalStatus !== "failed" && originalStatus !== "error") {
    return blockedMinimizeResult(caseId, steps.length, originalStatus, "fuzz_minimize_case_failing_replay_required", "Fuzz case minimization requires an original failed or error replay case.")
  }

  const originalDiagnosticCodes = diagnosticCodes(caseRecord.diagnostics)
  const suiteId = stringValue(replayCase.suite?.id) ?? `${caseId}-minimize-suite`
  const target = isRecord(caseRecord.target) && typeof caseRecord.target.kind === "string" ? caseRecord.target as unknown as FuzzSuiteCase["target"] : { kind: "runtime-action" as const }
  const baseInput = stripUndefined({ ...sequence, type: "sequence", steps, max_steps: steps.length, maxSteps: undefined }) as RuntimeAction
  const baseCase: FuzzSuiteCase = stripUndefined({ id: caseId, target, input: baseInput, metadata: { minimizedFromReplay: true } })
  const attempts: FuzzMinimizeCaseResult["attempts"] = []

  let currentSteps = [...steps]
  let chunkSize = Math.max(1, Math.floor(currentSteps.length / 2))
  while (chunkSize >= 1) {
    let reducedThisPass = false
    for (let start = 0; start < currentSteps.length && currentSteps.length > 1; start += chunkSize) {
      const end = Math.min(currentSteps.length, start + chunkSize)
      const candidateSteps = [...currentSteps.slice(0, start), ...currentSteps.slice(end)]
      if (candidateSteps.length === 0 || candidateSteps.length === currentSteps.length) continue
      const candidate = await replayMinimizedSequence({ suiteId, baseCase, steps: candidateSteps, options })
      const preserved = preservesFailure(candidate, originalStatus, originalDiagnosticCodes)
      attempts.push({ stepCount: candidateSteps.length, status: candidate.cases[0]?.status ?? candidate.status, preserved, removedRange: [start, end] })
      if (preserved) {
        currentSteps = candidateSteps
        reducedThisPass = true
        break
      }
    }
    if (!reducedThisPass) {
      chunkSize = Math.floor(chunkSize / 2)
    }
  }

  const minimizedRun = await replayMinimizedSequence({ suiteId, baseCase, steps: currentSteps, options })
  const minimizedCase = minimizedRun.cases[0]
  const status: FuzzMinimizeCaseResult["status"] = currentSteps.length < steps.length ? "reduced" : "unchanged"
  return stripUndefined({
    schema: FUZZ_MINIMIZE_CASE_RESULT_SCHEMA,
    status,
    caseId,
    originalSteps: steps.length,
    minimizedSteps: currentSteps.length,
    originalStatus,
    minimizedCase: minimizedCaseFrom(baseCase, currentSteps),
    minimizedResult: minimizedCase,
    diagnostics: minimizedCase?.diagnostics ?? [],
    attempts,
    metadata: { operation: "fuzz-minimize-case", strategy: "runtime-action-sequence-subset-replay" },
  })
}

async function replayMinimizedSequence(input: { suiteId: string; baseCase: FuzzSuiteCase; steps: RuntimeAction[]; options: FuzzSuiteRunOptions }): Promise<FuzzSuiteResultEnvelope> {
  const fuzzCase = minimizedCaseFrom(input.baseCase, input.steps)
  return runFuzzSuite(fuzzSuiteContract({ id: input.suiteId, cases: [fuzzCase] }), input.options)
}

function minimizedCaseFrom(baseCase: FuzzSuiteCase, steps: RuntimeAction[]): FuzzSuiteCase {
  const input = isRecord(baseCase.input) ? baseCase.input : {}
  return stripUndefined({
    ...baseCase,
    input: { ...input, type: "sequence", steps, max_steps: steps.length },
  }) as FuzzSuiteCase
}

function preservesFailure(result: FuzzSuiteResultEnvelope, originalStatus: string | undefined, originalDiagnosticCodes: string[]): boolean {
  const candidate = result.cases[0]
  if (!candidate || candidate.status !== originalStatus) return false
  if (originalDiagnosticCodes.length === 0) return true
  const candidateCodes = new Set(diagnosticCodes(candidate.diagnostics))
  return originalDiagnosticCodes.some((code) => candidateCodes.has(code))
}

function blockedMinimizeResult(caseId: string, stepCount: number, originalStatus: string | undefined, code: string, message: string): FuzzMinimizeCaseResult {
  return {
    schema: FUZZ_MINIMIZE_CASE_RESULT_SCHEMA,
    status: "blocked",
    caseId,
    originalSteps: stepCount,
    minimizedSteps: stepCount,
    originalStatus,
    diagnostics: [{ severity: "error", code, caseId, message }],
    attempts: [],
  }
}

function diagnosticCodes(input: unknown): string[] {
  return Array.isArray(input) ? input.map((item) => isRecord(item) ? stringValue(item.code) : undefined).filter((item): item is string => Boolean(item)) : []
}

function isRuntimeAction(input: unknown): input is RuntimeAction {
  return isRecord(input) && typeof input.type === "string" && input.type !== "sequence"
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

function stringValue(input: unknown): string | undefined {
  return typeof input === "string" && input.length > 0 ? input : undefined
}
