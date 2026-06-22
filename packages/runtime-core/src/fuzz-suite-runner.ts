import { stripUndefined } from "./object-utils.js"
import { fuzzSuiteResultEnvelope, type FuzzSuiteArtifactRef, type FuzzSuiteCase, type FuzzSuiteCaseResult, type FuzzSuiteContract, type FuzzSuiteDiagnostic, type FuzzSuiteTargetRef } from "./fuzz-suite-contracts.js"
import type { ExecutionResult, ExecutionSpec, RuntimeCommandDiagnosticsCaptureSpec, RuntimeEpisodeTraceRef } from "./runtime-contracts.js"

export interface FuzzSuiteCommandExecutor {
  execute(spec: ExecutionSpec): Promise<ExecutionResult>
}

export interface FuzzSuiteRunOptions {
  executor?: FuzzSuiteCommandExecutor | ((spec: ExecutionSpec) => Promise<ExecutionResult>)
  supportedTargetKinds?: readonly string[]
  metadata?: Record<string, unknown>
}

export interface FuzzSuiteCaseExecutionInput {
  args?: string[]
  cwd?: string
  timeoutMs?: number
  diagnostics?: RuntimeCommandDiagnosticsCaptureSpec
}

const DEFAULT_SUPPORTED_TARGET_KINDS = ["command", "runtime"]

export async function runFuzzSuite(suite: FuzzSuiteContract, options: FuzzSuiteRunOptions = {}) {
  const cases: FuzzSuiteCaseResult[] = []
  const diagnostics: FuzzSuiteDiagnostic[] = []
  const execute = normalizeFuzzSuiteExecutor(options.executor)
  const supportedTargetKinds = new Set(options.supportedTargetKinds ?? DEFAULT_SUPPORTED_TARGET_KINDS)

  for (const [index, fuzzCase] of suite.cases.entries()) {
    const target = fuzzCase.target ?? suite.target
    const command = fuzzSuiteTargetCommand(target)
    const replayMetadata = fuzzSuiteReplayMetadata(suite, fuzzCase, index, target)
    if (!target || !command || !supportedTargetKinds.has(target.kind)) {
      const diagnostic = fuzzSuiteUnsupportedDiagnostic(fuzzCase, target)
      diagnostics.push(diagnostic)
      cases.push({
        id: fuzzCase.id,
        status: "skipped",
        success: false,
        target,
        diagnostics: [diagnostic],
        metadata: stripUndefined({ replay: replayMetadata }),
      })
      continue
    }

    if (!execute) {
      const diagnostic: FuzzSuiteDiagnostic = {
        severity: "warning",
        code: "fuzz_suite_executor_unavailable",
        caseId: fuzzCase.id,
        target,
        message: `No executor was provided for fuzz suite case ${fuzzCase.id}.`,
      }
      diagnostics.push(diagnostic)
      cases.push({
        id: fuzzCase.id,
        status: "skipped",
        success: false,
        target,
        diagnostics: [diagnostic],
        metadata: stripUndefined({ replay: replayMetadata }),
      })
      continue
    }

    const input = normalizeFuzzSuiteCaseExecutionInput(fuzzCase.input)
    if (!input.valid) {
      const diagnostic: FuzzSuiteDiagnostic = {
        severity: "error",
        code: "fuzz_suite_input_unsupported",
        caseId: fuzzCase.id,
        target,
        message: `Fuzz suite case ${fuzzCase.id} has unsupported command input. Expected an args array or an object with args, cwd, timeoutMs, and diagnostics.`,
      }
      diagnostics.push(diagnostic)
      cases.push({
        id: fuzzCase.id,
        status: "skipped",
        success: false,
        target,
        diagnostics: [diagnostic],
        metadata: stripUndefined({ replay: replayMetadata }),
      })
      continue
    }

    try {
      const spec = stripUndefined({ command, ...input.value }) as ExecutionSpec
      const execution = await execute(spec)
      const status = execution.exitCode === 0 ? "passed" : "failed"
      const caseDiagnostics = execution.exitCode === 0 ? [] : [{
        severity: "error" as const,
        code: "fuzz_suite_command_failed",
        caseId: fuzzCase.id,
        target,
        message: `${command} exited with ${execution.exitCode}`,
        metadata: stripUndefined({ executionId: execution.id, stderr: execution.stderr }),
      }]
      diagnostics.push(...caseDiagnostics)
      cases.push({
        id: fuzzCase.id,
        status,
        success: status === "passed",
        target,
        diagnostics: caseDiagnostics,
        artifactRefs: fuzzSuiteExecutionArtifactRefs(execution),
        metadata: stripUndefined({
          input: fuzzCase.input,
          description: fuzzCase.description,
          caseMetadata: fuzzCase.metadata,
          replay: { ...replayMetadata, executionId: execution.id, command: spec },
          execution: {
            id: execution.id,
            command: execution.command,
            args: execution.args,
            exitCode: execution.exitCode,
            startedAt: execution.startedAt,
            finishedAt: execution.finishedAt,
          },
        }),
      })
    } catch (error) {
      const diagnostic: FuzzSuiteDiagnostic = {
        severity: "error",
        code: "fuzz_suite_execution_error",
        caseId: fuzzCase.id,
        target,
        message: error instanceof Error ? error.message : String(error),
      }
      diagnostics.push(diagnostic)
      cases.push({
        id: fuzzCase.id,
        status: "error",
        success: false,
        target,
        diagnostics: [diagnostic],
        metadata: stripUndefined({ replay: replayMetadata }),
      })
    }
  }

  return fuzzSuiteResultEnvelope({
    suite,
    cases,
    diagnostics,
    metadata: stripUndefined({
      ...options.metadata,
      sourceSchema: suite.schema,
      runner: "wp-codebox/fuzz-suite-runner/v1",
    }),
  })
}

function normalizeFuzzSuiteExecutor(executor: FuzzSuiteRunOptions["executor"]): ((spec: ExecutionSpec) => Promise<ExecutionResult>) | undefined {
  if (!executor) {
    return undefined
  }
  if (typeof executor === "function") {
    return executor
  }
  return (spec) => executor.execute(spec)
}

function fuzzSuiteTargetCommand(target: FuzzSuiteTargetRef | undefined): string | undefined {
  if (!target) {
    return undefined
  }
  return target.entrypoint ?? target.id
}

function fuzzSuiteUnsupportedDiagnostic(fuzzCase: FuzzSuiteCase, target: FuzzSuiteTargetRef | undefined): FuzzSuiteDiagnostic {
  return {
    severity: "warning",
    code: "fuzz_suite_case_unsupported",
    caseId: fuzzCase.id,
    target,
    message: target ? `Fuzz suite target ${target.kind}:${fuzzSuiteTargetCommand(target) ?? "<missing-command>"} is not supported by this runner.` : `Fuzz suite case ${fuzzCase.id} has no target.`,
  }
}

function normalizeFuzzSuiteCaseExecutionInput(input: unknown): { valid: true; value: FuzzSuiteCaseExecutionInput } | { valid: false } {
  if (input === undefined) {
    return { valid: true, value: { args: [] } }
  }
  if (Array.isArray(input) && input.every((item) => typeof item === "string")) {
    return { valid: true, value: { args: input } }
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { valid: false }
  }

  const record = input as Record<string, unknown>
  const args = record.args === undefined ? [] : record.args
  if (!Array.isArray(args) || !args.every((item) => typeof item === "string")) {
    return { valid: false }
  }
  if (record.cwd !== undefined && typeof record.cwd !== "string") {
    return { valid: false }
  }
  if (record.timeoutMs !== undefined && (typeof record.timeoutMs !== "number" || !Number.isFinite(record.timeoutMs))) {
    return { valid: false }
  }
  if (record.diagnostics !== undefined && (!record.diagnostics || typeof record.diagnostics !== "object" || Array.isArray(record.diagnostics))) {
    return { valid: false }
  }

  return {
    valid: true,
    value: stripUndefined({
      args,
      cwd: record.cwd,
      timeoutMs: record.timeoutMs,
      diagnostics: record.diagnostics as RuntimeCommandDiagnosticsCaptureSpec | undefined,
    }),
  }
}

function fuzzSuiteExecutionArtifactRefs(execution: ExecutionResult): FuzzSuiteArtifactRef[] | undefined {
  const refs = [...(execution.artifactRefs ?? []), ...(execution.result?.artifactRefs ?? [])].map(fuzzSuiteArtifactRefFromTrace).filter((ref): ref is FuzzSuiteArtifactRef => Boolean(ref))
  return refs.length > 0 ? refs : undefined
}

function fuzzSuiteArtifactRefFromTrace(ref: RuntimeEpisodeTraceRef): FuzzSuiteArtifactRef | undefined {
  const path = ref.path ?? ref.artifactId ?? ref.id
  if (!path) {
    return undefined
  }
  return stripUndefined({
    path,
    kind: ref.kind,
    sha256: ref.digest?.algorithm === "sha256" ? ref.digest.value : undefined,
    metadata: stripUndefined({ id: ref.id, artifactId: ref.artifactId, digest: ref.digest }),
  })
}

function fuzzSuiteReplayMetadata(suite: FuzzSuiteContract, fuzzCase: FuzzSuiteCase, index: number, target: FuzzSuiteTargetRef | undefined): Record<string, unknown> {
  return stripUndefined({
    suiteId: suite.id,
    suiteVersion: suite.version,
    caseId: fuzzCase.id,
    caseIndex: index,
    target,
    input: fuzzCase.input,
  })
}
