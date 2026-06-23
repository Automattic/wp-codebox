import { stripUndefined } from "./object-utils.js"
import type { FuzzSuiteTargetRef } from "./fuzz-suite-contracts.js"

export const FUZZ_COVERAGE_PLAN_SCHEMA = "wp-codebox/fuzz-coverage-plan/v1" as const

export interface FuzzCoveragePlanReason {
  code: string
  message: string
  data?: Record<string, unknown>
}

export interface FuzzCoveragePlanParameterGenerationHook {
  id: string
  label?: string
  description?: string
  inputSchema?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export interface FuzzCoveragePlanParameterGenerationPlaceholder {
  hook: string
  requiredInputs?: string[]
  metadata?: Record<string, unknown>
}

export interface FuzzCoveragePlanItem {
  id: string
  target?: FuzzSuiteTargetRef
  description?: string
  input?: unknown
  reason?: FuzzCoveragePlanReason
  parameterGeneration?: FuzzCoveragePlanParameterGenerationPlaceholder
  metadata?: Record<string, unknown>
}

export interface FuzzCoveragePlanSummary {
  discovered: number
  generated: number
  executable: number
  executed: number
  skipped: number
  untested: number
  caseIds: string[]
  targetIds: string[]
}

export interface FuzzCoveragePlanContract {
  schema: typeof FUZZ_COVERAGE_PLAN_SCHEMA
  id: string
  version?: string
  discovered: FuzzCoveragePlanItem[]
  generated: FuzzCoveragePlanItem[]
  executable: FuzzCoveragePlanItem[]
  executed: FuzzCoveragePlanItem[]
  skipped: FuzzCoveragePlanItem[]
  untested: FuzzCoveragePlanItem[]
  parameterGenerationHooks?: FuzzCoveragePlanParameterGenerationHook[]
  summary: FuzzCoveragePlanSummary
  metadata?: Record<string, unknown>
}

export function fuzzCoveragePlanContract(input: {
  id: string
  version?: string
  discovered?: FuzzCoveragePlanItem[]
  generated?: FuzzCoveragePlanItem[]
  executable?: FuzzCoveragePlanItem[]
  executed?: FuzzCoveragePlanItem[]
  skipped?: FuzzCoveragePlanItem[]
  untested?: FuzzCoveragePlanItem[]
  parameterGenerationHooks?: FuzzCoveragePlanParameterGenerationHook[]
  metadata?: Record<string, unknown>
}): FuzzCoveragePlanContract {
  const discovered = input.discovered ?? []
  const generated = input.generated ?? []
  const executable = input.executable ?? []
  const executed = input.executed ?? []
  const skipped = input.skipped ?? []
  const untested = input.untested ?? []
  const allItems = [...discovered, ...generated, ...executable, ...executed, ...skipped, ...untested]

  return stripUndefined({
    schema: FUZZ_COVERAGE_PLAN_SCHEMA,
    id: input.id,
    version: input.version,
    discovered,
    generated,
    executable,
    executed,
    skipped,
    untested,
    parameterGenerationHooks: input.parameterGenerationHooks?.length ? input.parameterGenerationHooks : undefined,
    summary: {
      discovered: discovered.length,
      generated: generated.length,
      executable: executable.length,
      executed: executed.length,
      skipped: skipped.length,
      untested: untested.length,
      caseIds: uniqueStrings(allItems.map((item) => item.id)),
      targetIds: uniqueStrings(allItems.map((item) => item.target?.id ?? item.target?.entrypoint ?? item.target?.kind)),
    },
    metadata: input.metadata,
  })
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))]
}
