import { stripUndefined } from "./object-utils.js"
import { FUZZ_RUNNER_CAPABILITIES_SCHEMA, RUNTIME_BACKED_FUZZ_SUITE_RUNNER_CAPABILITIES, fuzzRunnerCapabilitiesContract, fuzzSuiteCaseResetPolicy, fuzzSuiteRequiredRunnerCapabilities, fuzzSuiteResetPolicyDiagnostics, fuzzSuiteResultEnvelope, unsupportedRequiredFuzzRunnerCapabilities, type FuzzSuiteArtifactRef, type FuzzSuiteCase, type FuzzSuiteCaseResetResult, type FuzzSuiteCaseResult, type FuzzSuiteContract, type FuzzSuiteDiagnostic, type FuzzSuiteResetPolicy, type FuzzSuiteRunnerCapabilities, type FuzzSuiteTargetRef } from "./fuzz-suite-contracts.js"
import { DELETE_BOUNDARY_ARTIFACT_SCHEMA, MUTATION_ISOLATION_ARTIFACT_SCHEMA, isRestMutationMethod } from "./mutation-isolation-contracts.js"
import type { RuntimeAction, RuntimeActionObservation } from "./runtime-action-adapter.js"
import type { ExecutionResult, ExecutionSpec, RuntimeCommandDiagnosticsCaptureSpec, RuntimeEpisodeTraceRef } from "./runtime-contracts.js"
import { WORDPRESS_CRUD_OPERATION_SCHEMA, normalizeWordPressCrudOperation } from "./wordpress-crud-contracts.js"
import { WORDPRESS_DB_OPERATION_SCHEMA, normalizeWordPressDbOperation } from "./wordpress-db-contracts.js"

export interface FuzzSuiteCommandExecutor {
  execute(spec: ExecutionSpec): Promise<ExecutionResult>
}

export interface FuzzSuiteRunOptions {
  executor?: FuzzSuiteCommandExecutor | ((spec: ExecutionSpec) => Promise<ExecutionResult>)
  runtimeActionExecutor?: FuzzSuiteRuntimeActionExecutor | ((input: FuzzSuiteRuntimeActionExecutionInput) => Promise<RuntimeActionObservation>)
  runtimeWorkloadExecutor?: FuzzSuiteRuntimeWorkloadExecutor | ((input: FuzzSuiteRuntimeWorkloadExecutionInput) => Promise<ExecutionResult>)
  resetExecutor?: FuzzSuiteResetExecutor | ((input: FuzzSuiteResetExecutionInput) => Promise<FuzzSuiteCaseResetResult>)
  targetAdapters?: FuzzSuiteTargetAdapterRegistry | readonly FuzzSuiteTargetAdapter[]
  supportedTargetKinds?: readonly string[]
  runnerCapabilities?: FuzzSuiteRunnerCapabilities | readonly string[]
  requireCoverage?: boolean
  metadata?: Record<string, unknown>
}

export interface FuzzSuiteResetExecutionInput {
  suite: FuzzSuiteContract
  case: FuzzSuiteCase
  caseIndex: number
  policy: FuzzSuiteResetPolicy
}

export interface FuzzSuiteResetExecutor {
  resetFuzzSuiteCase(input: FuzzSuiteResetExecutionInput): Promise<FuzzSuiteCaseResetResult>
}

export interface FuzzSuiteRuntimeActionExecutionInput {
  suite: FuzzSuiteContract
  case: FuzzSuiteCase
  caseIndex: number
  target: FuzzSuiteTargetRef
  action: RuntimeAction
}

export interface FuzzSuiteRuntimeActionExecutor {
  executeRuntimeAction(input: FuzzSuiteRuntimeActionExecutionInput): Promise<RuntimeActionObservation>
}

export interface FuzzSuiteRuntimeWorkloadExecutionInput {
  suite: FuzzSuiteContract
  case: FuzzSuiteCase
  caseIndex: number
  target: FuzzSuiteTargetRef
  workload: Record<string, unknown>
}

export interface FuzzSuiteRuntimeWorkloadExecutor {
  executeRuntimeWorkload(input: FuzzSuiteRuntimeWorkloadExecutionInput): Promise<ExecutionResult>
}

export type FuzzSuiteTargetAdapterStatus = "supported" | "unsupported"

export interface FuzzSuiteTargetAdapterResolution {
  status: FuzzSuiteTargetAdapterStatus
  spec?: ExecutionSpec
  diagnostics?: FuzzSuiteDiagnostic[]
  metadata?: Record<string, unknown>
}

export interface FuzzSuiteTargetAdapter {
  kind: string
  adapt(input: {
    suite: FuzzSuiteContract
    case: FuzzSuiteCase
    caseIndex: number
    target: FuzzSuiteTargetRef
  }): FuzzSuiteTargetAdapterResolution
}

export interface FuzzSuiteTargetAdapterRegistry {
  resolve(input: {
    suite: FuzzSuiteContract
    case: FuzzSuiteCase
    caseIndex: number
    target: FuzzSuiteTargetRef
  }): FuzzSuiteTargetAdapterResolution
}

export interface FuzzSuiteCaseExecutionInput {
  args?: string[]
  cwd?: string
  timeoutMs?: number
  diagnostics?: RuntimeCommandDiagnosticsCaptureSpec
}

export interface FuzzSuiteCaseExecutionSpecPlanInput {
  suite: FuzzSuiteContract
  case: FuzzSuiteCase
  caseIndex: number
  target?: FuzzSuiteTargetRef
  targetAdapters?: FuzzSuiteTargetAdapterRegistry | readonly FuzzSuiteTargetAdapter[]
  supportedTargetKinds?: readonly string[]
}

export interface FuzzSuiteCaseExecutionSpecPlan extends FuzzSuiteTargetAdapterResolution {
  target?: FuzzSuiteTargetRef
  replayMetadata: Record<string, unknown>
}

const DEFAULT_SUPPORTED_TARGET_KINDS = ["ability", "command", "http", "rest", "runtime", "runtime-action"]

export async function runFuzzSuite(suite: FuzzSuiteContract, options: FuzzSuiteRunOptions = {}) {
  const cases: FuzzSuiteCaseResult[] = []
  const diagnostics: FuzzSuiteDiagnostic[] = []
  const execute = normalizeFuzzSuiteExecutor(options.executor)
  const executeRuntimeAction = normalizeFuzzSuiteRuntimeActionExecutor(options.runtimeActionExecutor)
  const executeRuntimeWorkload = normalizeFuzzSuiteRuntimeWorkloadExecutor(options.runtimeWorkloadExecutor)
  const executeReset = normalizeFuzzSuiteResetExecutor(options.resetExecutor)
  const adapterRegistry = normalizeFuzzSuiteTargetAdapterRegistry(options.targetAdapters)
  const runnerCapabilities = normalizeFuzzSuiteRunnerCapabilities(options.runnerCapabilities)
  const supportedTargetKinds = new Set(options.supportedTargetKinds ?? runnerCapabilities.targetKinds ?? DEFAULT_SUPPORTED_TARGET_KINDS)
  const missingCapabilities = missingRequiredFuzzSuiteCapabilities(suite, runnerCapabilities)

  if (options.requireCoverage && missingCapabilities.length > 0) {
    const diagnostic: FuzzSuiteDiagnostic = {
      severity: "error",
      code: "fuzz_suite_required_runner_capabilities_unsupported",
      message: `Fuzz suite ${suite.id} requires runner capabilities that are not available: ${missingCapabilities.join(", ")}.`,
      metadata: { requiredCapabilities: fuzzSuiteRequiredRunnerCapabilities(suite), availableCapabilities: runnerCapabilities.capabilities, missingCapabilities, runnerMode: runnerCapabilities.mode },
    }
    return fuzzSuiteResultEnvelope({
      suite,
      cases: suite.cases.map((fuzzCase) => ({ id: fuzzCase.id, status: "skipped", success: false, target: fuzzCase.target ?? suite.target, skipReason: diagnostic.code, diagnostics: [diagnostic] })),
      diagnostics: [diagnostic],
      metadata: stripUndefined({ ...options.metadata, sourceSchema: suite.schema, runner: "wp-codebox/fuzz-suite-runner/v1", runnerCapabilities: fuzzRunnerCapabilitiesContract(runnerCapabilities, suite) }),
    })
  }

  for (const [index, fuzzCase] of suite.cases.entries()) {
    const reset = await executeFuzzSuiteCaseReset({ suite, case: fuzzCase, caseIndex: index, executeReset })
    if (reset.status === "failed" || reset.status === "unsupported") {
      const resetDiagnostics = reset.diagnostics ?? []
      diagnostics.push(...resetDiagnostics)
      cases.push({
        id: fuzzCase.id,
        status: "error",
        success: false,
        target: fuzzCase.target ?? suite.target,
        reset,
        diagnostics: resetDiagnostics,
        artifactRefs: reset.artifactRefs,
        metadata: stripUndefined({ resetPolicy: reset.metadata }),
      })
      continue
    }

    const plan = planFuzzSuiteCaseExecutionSpec({ suite, case: fuzzCase, caseIndex: index, targetAdapters: adapterRegistry, supportedTargetKinds: [...supportedTargetKinds] })
    const target = plan.target
    const replayMetadata = plan.replayMetadata
    if (plan.status === "unsupported" || !plan.spec) {
      const planDiagnostics = plan.diagnostics ?? []
      const caseDiagnostics = requiredCoverageDiagnostics(options.requireCoverage, suite, fuzzCase, planDiagnostics)
      diagnostics.push(...caseDiagnostics)
      cases.push({
        id: fuzzCase.id,
        status: "skipped",
        success: false,
        target,
        reset,
        skipReason: fuzzSuiteSkipReason(planDiagnostics),
        diagnostics: caseDiagnostics,
        metadata: stripUndefined({ replay: replayMetadata, adapter: plan.metadata }),
      })
      continue
    }

    const runtimeAction = target?.kind === "runtime-action" && executeRuntimeAction ? fuzzSuiteRuntimeActionInput(fuzzCase.input) : undefined
    if (runtimeAction?.status === "invalid") {
      const diagnostic = target ? unsupportedInputAdapterResolution(fuzzCase, target, runtimeAction.message, { adapterKind: "runtime-action" }).diagnostics?.[0] : undefined
      if (diagnostic) {
        diagnostics.push(diagnostic)
        cases.push({
          id: fuzzCase.id,
          status: "skipped",
          success: false,
          target,
          reset,
          skipReason: diagnostic.code,
          diagnostics: [diagnostic],
          metadata: stripUndefined({ replay: replayMetadata, adapter: { adapterKind: "runtime-action" } }),
        })
        continue
      }
    }

    if (runtimeAction?.status === "valid" && executeRuntimeAction && target) {
      try {
        const observation = await executeRuntimeAction({ suite, case: fuzzCase, caseIndex: index, target, action: runtimeAction.action })
        const mutationArtifacts = fuzzSuiteRuntimeActionMutationArtifactRefs(observation)
        const metadataInput = fuzzSuiteRuntimeActionMetadataInput(fuzzCase.input, runtimeAction.action)
        cases.push({
          id: fuzzCase.id,
          status: "passed",
          success: true,
          target,
          reset,
          diagnostics: [],
          artifactRefs: dedupeFuzzSuiteArtifactRefs([...(fuzzSuiteRuntimeActionArtifactRefs(observation) ?? []), ...mutationArtifacts]),
          metadata: stripUndefined({
            input: metadataInput,
            description: fuzzCase.description,
            caseMetadata: fuzzCase.metadata,
            adapter: { adapterKind: "runtime-action", actionType: runtimeAction.action.type, executorKind: "episode" },
            replay: { ...replayMetadata, input: metadataInput, runtimeAction: fuzzSuiteRuntimeActionMetadataInput(runtimeAction.action, runtimeAction.action) },
            observation: {
              type: observation.type,
              status: observation.status,
              observedAt: observation.observedAt,
              digest: observation.digest,
            },
            mutationIsolation: recordValue(observation.data.mutationIsolationArtifact),
            deleteBoundary: recordValue(observation.data.deleteBoundaryArtifact),
          }),
        })
      } catch (error) {
        const diagnostic: FuzzSuiteDiagnostic = {
          severity: "error",
          code: "fuzz_suite_runtime_action_execution_error",
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
          reset,
          diagnostics: [diagnostic],
          metadata: stripUndefined({ replay: replayMetadata, adapter: { adapterKind: "runtime-action", actionType: runtimeAction.action.type, executorKind: "episode" } }),
        })
      }
      continue
    }

    const runtimeWorkload = target && isWordPressWorkloadRunTarget(target) ? fuzzSuiteRuntimeWorkloadInput(fuzzCase.input) : undefined
    if (runtimeWorkload?.status === "invalid") {
      const diagnostic = target ? unsupportedInputAdapterResolution(fuzzCase, target, runtimeWorkload.message, { adapterKind: "runtime-workload" }).diagnostics?.[0] : undefined
      if (diagnostic) {
        diagnostics.push(diagnostic)
        cases.push({
          id: fuzzCase.id,
          status: "skipped",
          success: false,
          target,
          reset,
          skipReason: diagnostic.code,
          diagnostics: [diagnostic],
          metadata: stripUndefined({ replay: replayMetadata, adapter: { adapterKind: "runtime-workload" } }),
        })
        continue
      }
    }

    if (runtimeWorkload?.status === "valid" && executeRuntimeWorkload && target) {
      try {
        const execution = await executeRuntimeWorkload({ suite, case: fuzzCase, caseIndex: index, target, workload: runtimeWorkload.workload })
        const status = execution.exitCode === 0 ? "passed" : "failed"
        const caseDiagnostics = status === "passed" ? [] : [{ severity: "error" as const, code: "fuzz_suite_command_failed", caseId: fuzzCase.id, target, message: `${target.entrypoint ?? target.id} exited with ${execution.exitCode}`, metadata: stripUndefined({ executionId: execution.id, stderr: execution.stderr }) }]
        diagnostics.push(...caseDiagnostics)
        cases.push({
          id: fuzzCase.id,
          status,
          success: status === "passed",
          target,
          reset,
          diagnostics: caseDiagnostics,
          artifactRefs: fuzzSuiteExecutionArtifactRefs(execution),
          metadata: stripUndefined({
            input: fuzzCase.input,
            description: fuzzCase.description,
            caseMetadata: fuzzCase.metadata,
            adapter: { adapterKind: "runtime-workload", executorKind: "episode" },
            replay: { ...replayMetadata, workload: runtimeWorkload.workload },
            execution: { id: execution.id, command: execution.command, exitCode: execution.exitCode, startedAt: execution.startedAt, finishedAt: execution.finishedAt, result: execution.result },
          }),
        })
      } catch (error) {
        const diagnostic: FuzzSuiteDiagnostic = {
          severity: "error",
          code: "fuzz_suite_runtime_workload_execution_error",
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
          reset,
          diagnostics: [diagnostic],
          metadata: stripUndefined({ replay: replayMetadata, adapter: { adapterKind: "runtime-workload", executorKind: "episode" } }),
        })
      }
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
      const caseDiagnostics = requiredCoverageDiagnostics(options.requireCoverage, suite, fuzzCase, [diagnostic])
      diagnostics.push(...caseDiagnostics)
      cases.push({
        id: fuzzCase.id,
        status: "skipped",
        success: false,
        target,
        reset,
        skipReason: diagnostic.code,
        diagnostics: caseDiagnostics,
        metadata: stripUndefined({ replay: replayMetadata }),
      })
      continue
    }

    try {
      const spec = plan.spec
      const execution = await execute(spec)
      const status = execution.exitCode === 0 ? "passed" : "failed"
      const caseDiagnostics = execution.exitCode === 0 ? [] : [{
        severity: "error" as const,
        code: "fuzz_suite_command_failed",
        caseId: fuzzCase.id,
        target,
        message: `${spec.command} exited with ${execution.exitCode}`,
        metadata: stripUndefined({ executionId: execution.id, stderr: execution.stderr }),
      }]
      diagnostics.push(...caseDiagnostics)
      cases.push({
        id: fuzzCase.id,
        status,
        success: status === "passed",
        target,
        reset,
        diagnostics: caseDiagnostics,
        artifactRefs: fuzzSuiteExecutionArtifactRefs(execution),
        metadata: stripUndefined({
          input: fuzzCase.input,
          description: fuzzCase.description,
          caseMetadata: fuzzCase.metadata,
          adapter: plan.metadata,
          replay: { ...replayMetadata, executionId: execution.id, command: spec },
          execution: {
            id: execution.id,
            command: execution.command,
            args: execution.args,
            exitCode: execution.exitCode,
            startedAt: execution.startedAt,
            finishedAt: execution.finishedAt,
            result: fuzzSuiteExecutionMetadataResult(execution.result),
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
        reset,
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
      runnerCapabilities: fuzzRunnerCapabilitiesContract(runnerCapabilities, suite),
    }),
  })
}

function fuzzSuiteExecutionMetadataResult(result: ExecutionResult["result"]): ExecutionResult["result"] | undefined {
  if (!result) return undefined
  const { stdout: _stdout, stderr: _stderr, ...metadataResult } = result
  return stripUndefined(metadataResult) as ExecutionResult["result"]
}

function normalizeFuzzSuiteResetExecutor(executor: FuzzSuiteRunOptions["resetExecutor"]): ((input: FuzzSuiteResetExecutionInput) => Promise<FuzzSuiteCaseResetResult>) | undefined {
  if (!executor) {
    return undefined
  }
  if (typeof executor === "function") {
    return executor
  }
  return (input) => executor.resetFuzzSuiteCase(input)
}

async function executeFuzzSuiteCaseReset(input: {
  suite: FuzzSuiteContract
  case: FuzzSuiteCase
  caseIndex: number
  executeReset?: (input: FuzzSuiteResetExecutionInput) => Promise<FuzzSuiteCaseResetResult>
}): Promise<FuzzSuiteCaseResetResult> {
  const rawPolicy = input.case.resetPolicy ?? input.case.reset_policy ?? input.suite.resetPolicy ?? input.suite.reset_policy
  const policy = fuzzSuiteCaseResetPolicy(input.suite, input.case)
  const validationDiagnostics = fuzzSuiteResetPolicyDiagnostics(rawPolicy, input.case.id)
  if (validationDiagnostics.length > 0) {
    return { mode: policy.mode, status: "failed", diagnostics: validationDiagnostics }
  }
  if (policy.mode === "none") {
    return { mode: "none", status: "not-required" }
  }
  if (!input.executeReset) {
    return {
      mode: policy.mode,
      status: "unsupported",
      checkpointName: policy.checkpointName ?? policy.checkpoint_name,
      snapshotRef: policy.snapshotRef ?? policy.snapshot_ref,
      fixtureRefs: policy.fixtureRefs ?? policy.fixture_refs,
      diagnostics: [{
        severity: "error",
        code: "fuzz_suite_reset_executor_unavailable",
        caseId: input.case.id,
        message: `Fuzz suite case ${input.case.id} requires reset policy ${policy.mode}, but no reset executor was provided.`,
      }],
    }
  }
  try {
    return await input.executeReset({ suite: input.suite, case: input.case, caseIndex: input.caseIndex, policy })
  } catch (error) {
    return {
      mode: policy.mode,
      status: "failed",
      checkpointName: policy.checkpointName ?? policy.checkpoint_name,
      snapshotRef: policy.snapshotRef ?? policy.snapshot_ref,
      fixtureRefs: policy.fixtureRefs ?? policy.fixture_refs,
      diagnostics: [{
        severity: "error",
        code: "fuzz_suite_reset_execution_error",
        caseId: input.case.id,
        message: error instanceof Error ? error.message : String(error),
      }],
    }
  }
}

export function planFuzzSuiteCaseExecutionSpec(input: FuzzSuiteCaseExecutionSpecPlanInput): FuzzSuiteCaseExecutionSpecPlan {
  const target = input.target ?? input.case.target ?? input.suite.target
  const replayMetadata = fuzzSuiteReplayMetadata(input.suite, input.case, input.caseIndex, target)
  const supportedTargetKinds = new Set(input.supportedTargetKinds ?? DEFAULT_SUPPORTED_TARGET_KINDS)

  if (!target || !supportedTargetKinds.has(target.kind)) {
    const diagnostic = fuzzSuiteUnsupportedDiagnostic(input.case, target)
    return { status: "unsupported", target, replayMetadata, diagnostics: [diagnostic] }
  }

  const adapterRegistry = normalizeFuzzSuiteTargetAdapterRegistry(input.targetAdapters)
  return { target, replayMetadata, ...adapterRegistry.resolve({ suite: input.suite, case: input.case, caseIndex: input.caseIndex, target }) }
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

function normalizeFuzzSuiteRuntimeActionExecutor(executor: FuzzSuiteRunOptions["runtimeActionExecutor"]): ((input: FuzzSuiteRuntimeActionExecutionInput) => Promise<RuntimeActionObservation>) | undefined {
  if (!executor) {
    return undefined
  }
  if (typeof executor === "function") {
    return executor
  }
  return (input) => executor.executeRuntimeAction(input)
}

function normalizeFuzzSuiteRuntimeWorkloadExecutor(executor: FuzzSuiteRunOptions["runtimeWorkloadExecutor"]): ((input: FuzzSuiteRuntimeWorkloadExecutionInput) => Promise<ExecutionResult>) | undefined {
  if (!executor) {
    return undefined
  }
  if (typeof executor === "function") {
    return executor
  }
  return (input) => executor.executeRuntimeWorkload(input)
}

export function createFuzzSuiteTargetAdapterRegistry(adapters: readonly FuzzSuiteTargetAdapter[] = defaultFuzzSuiteTargetAdapters()): FuzzSuiteTargetAdapterRegistry {
  const byKind = new Map(adapters.map((adapter) => [adapter.kind, adapter]))
  return {
    resolve(input) {
      const adapter = byKind.get(input.target.kind)
      if (!adapter) {
        return unsupportedTargetAdapterResolution(input.case, input.target, `No fuzz suite target adapter is registered for ${input.target.kind}.`, { adapterKind: input.target.kind })
      }
      return adapter.adapt(input)
    },
  }
}

function normalizeFuzzSuiteTargetAdapterRegistry(input: FuzzSuiteRunOptions["targetAdapters"]): FuzzSuiteTargetAdapterRegistry {
  if (!input) {
    return createFuzzSuiteTargetAdapterRegistry()
  }
  if (Array.isArray(input)) {
    return createFuzzSuiteTargetAdapterRegistry(input)
  }
  return input as FuzzSuiteTargetAdapterRegistry
}

export function defaultFuzzSuiteTargetAdapters(): FuzzSuiteTargetAdapter[] {
  return [
    commandFuzzSuiteTargetAdapter("command"),
    commandFuzzSuiteTargetAdapter("runtime"),
    abilityFuzzSuiteTargetAdapter(),
    httpFuzzSuiteTargetAdapter(),
    restFuzzSuiteTargetAdapter(),
    runtimeActionFuzzSuiteTargetAdapter(),
  ]
}

function commandFuzzSuiteTargetAdapter(kind: "command" | "runtime"): FuzzSuiteTargetAdapter {
  return {
    kind,
    adapt({ case: fuzzCase, target }) {
      const command = fuzzSuiteTargetCommand(target)
      const input = normalizeFuzzSuiteCaseExecutionInput(fuzzCase.input)
      if (!command) {
        return unsupportedTargetAdapterResolution(fuzzCase, target, `Fuzz suite target ${target.kind} is missing an id or entrypoint.`, { adapterKind: kind })
      }
      if (kind === "runtime" && command === "wordpress.run-workload") {
        const workload = fuzzSuiteRuntimeWorkloadInput(fuzzCase.input)
        if (workload.status === "invalid") {
          return unsupportedInputAdapterResolution(fuzzCase, target, workload.message, { adapterKind: "runtime-workload" })
        }
        return { status: "supported", spec: { command, args: [`workload-json=${JSON.stringify(workload.workload)}`] } as ExecutionSpec, metadata: { adapterKind: "runtime-workload" } }
      }
      if (!input.valid) {
        return unsupportedInputAdapterResolution(fuzzCase, target, "Expected an args array or an object with args, cwd, timeoutMs, and diagnostics.", { adapterKind: kind })
      }
      return { status: "supported", spec: stripUndefined({ command, ...input.value }) as ExecutionSpec, metadata: { adapterKind: kind } }
    },
  }
}

function abilityFuzzSuiteTargetAdapter(): FuzzSuiteTargetAdapter {
  return {
    kind: "ability",
    adapt({ case: fuzzCase, target }) {
      const ability = fuzzSuiteTargetCommand(target)
      if (!ability) {
        return unsupportedTargetAdapterResolution(fuzzCase, target, "Fuzz suite ability target is missing an id or entrypoint.", { adapterKind: "ability" })
      }
      const input = fuzzSuiteCaseRecordInput(fuzzCase.input)
      if (input.invalid) {
        return unsupportedInputAdapterResolution(fuzzCase, target, "Expected ability input to be any JSON value or an object with input, payload, expectedResultSchema, and timeoutMs.", { adapterKind: "ability" })
      }
      return {
        status: "supported",
        spec: stripUndefined({
          command: "wordpress.ability",
          args: [
            `name=${ability}`,
            input.payload === undefined ? undefined : `input=${JSON.stringify(input.payload)}`,
            input.expectedResultSchema === undefined ? undefined : `expected-result-schema=${typeof input.expectedResultSchema === "string" ? input.expectedResultSchema : JSON.stringify(input.expectedResultSchema)}`,
          ].filter((arg): arg is string => Boolean(arg)),
          timeoutMs: input.timeoutMs,
        }) as ExecutionSpec,
        metadata: { adapterKind: "ability", mappedCommand: "wordpress.ability" },
      }
    },
  }
}

function httpFuzzSuiteTargetAdapter(): FuzzSuiteTargetAdapter {
  return {
    kind: "http",
    adapt({ case: fuzzCase, target }) {
      const input = fuzzSuiteCaseRecordInput(fuzzCase.input)
      if (input.invalid || !isRecord(input.payload)) {
        return unsupportedInputAdapterResolution(fuzzCase, target, "Expected HTTP input object with url or path.", { adapterKind: "http" })
      }
      const url = stringField(input.payload, "url") ?? stringField(input.payload, "path") ?? fuzzSuiteTargetCommand(target)
      if (!url) {
        return unsupportedInputAdapterResolution(fuzzCase, target, "Expected HTTP target id/entrypoint or input url/path.", { adapterKind: "http" })
      }
      return {
        status: "supported",
        spec: stripUndefined({
          command: "wordpress.http-request",
          args: [
            `url=${url}`,
            optionalStringArg("method", input.payload.method),
            jsonArg("headers-json", input.payload.headers),
            input.payload.body === undefined ? undefined : `body=${String(input.payload.body)}`,
            optionalNumberArg("expect-status", input.payload.expectStatus ?? input.payload.expect_status),
          ].filter((arg): arg is string => Boolean(arg)),
          method: stringField(input.payload, "method"),
          path: url,
          timeoutMs: input.timeoutMs,
        }) as ExecutionSpec,
        metadata: { adapterKind: "http", mappedCommand: "wordpress.http-request" },
      }
    },
  }
}

function restFuzzSuiteTargetAdapter(): FuzzSuiteTargetAdapter {
  return {
    kind: "rest",
    adapt({ suite, case: fuzzCase, target }) {
      const input = fuzzSuiteCaseRecordInput(fuzzCase.input)
      if (input.invalid || !isRecord(input.payload)) {
        return unsupportedInputAdapterResolution(fuzzCase, target, "Expected REST input object with path or route.", { adapterKind: "rest" })
      }
      const path = stringField(input.payload, "path") ?? stringField(input.payload, "route") ?? fuzzSuiteTargetCommand(target)
      if (!path) {
        return unsupportedInputAdapterResolution(fuzzCase, target, "Expected REST target id/entrypoint or input path/route.", { adapterKind: "rest" })
      }
      const method = stringField(input.payload, "method") ?? "GET"
      if (isRestMutationMethod(method) && !fuzzSuiteAllowsRestMutations(suite, fuzzCase, input.payload)) {
        return unsupportedInputAdapterResolution(fuzzCase, target, "REST mutation fuzzing requires explicit allowRestMutations opt-in on the suite, case, or input.", { adapterKind: "rest", mappedCommand: "wordpress.rest-request", method, path, mutationSkipped: true })
      }
      return {
        status: "supported",
        spec: stripUndefined({
          command: "wordpress.rest-request",
          args: [
            `path=${path}`,
            optionalStringArg("method", input.payload.method),
            jsonArg("headers-json", input.payload.headers),
            jsonArg("params-json", input.payload.params),
            input.payload.body === undefined ? undefined : `body=${String(input.payload.body)}`,
            input.payload.bodyJson === undefined && input.payload.body_json === undefined ? undefined : `body-json=${JSON.stringify(input.payload.bodyJson ?? input.payload.body_json)}`,
            optionalStringArg("user", input.payload.user),
            optionalStringArg("session", input.payload.session),
          ].filter((arg): arg is string => Boolean(arg)),
          method,
          path,
          timeoutMs: input.timeoutMs,
        }) as ExecutionSpec,
        metadata: { adapterKind: "rest", mappedCommand: "wordpress.rest-request" },
      }
    },
  }
}

function runtimeActionFuzzSuiteTargetAdapter(): FuzzSuiteTargetAdapter {
  return {
    kind: "runtime-action",
    adapt({ suite, case: fuzzCase, target }) {
      const input = fuzzSuiteCaseRecordInput(fuzzCase.input)
      if (input.invalid || !isRecord(input.payload) || typeof input.payload.type !== "string") {
        return unsupportedInputAdapterResolution(fuzzCase, target, "Expected runtime-action input object with a type field.", { adapterKind: "runtime-action" })
      }

      if (input.payload.type === "wp_cli") {
        const command = stringField(input.payload, "command")
        if (!command) {
          return unsupportedInputAdapterResolution(fuzzCase, target, "Expected wp_cli runtime-action input command.", { adapterKind: "runtime-action", actionType: input.payload.type })
        }
        return {
          status: "supported",
          spec: stripUndefined({
            command: "wordpress.wp-cli",
            args: [`command=${command}`],
            timeoutMs: runtimeActionTimeoutMs(input.payload, input.timeoutMs),
          }) as ExecutionSpec,
          metadata: { adapterKind: "runtime-action", actionType: input.payload.type, mappedCommand: "wordpress.wp-cli" },
        }
      }

      if (input.payload.type === "php") {
        const code = stringField(input.payload, "code")
        if (!code) {
          return unsupportedInputAdapterResolution(fuzzCase, target, "Expected php runtime-action input code.", { adapterKind: "runtime-action", actionType: input.payload.type })
        }
        return {
          status: "supported",
          spec: stripUndefined({
            command: "wordpress.run-php",
            args: [`code=${code}`, optionalStringArg("bootstrap", input.payload.bootstrap)].filter((arg): arg is string => Boolean(arg)),
            diagnostics: isRecord(input.payload.diagnostics) ? input.payload.diagnostics as RuntimeCommandDiagnosticsCaptureSpec : undefined,
            timeoutMs: runtimeActionTimeoutMs(input.payload, input.timeoutMs),
          }) as ExecutionSpec,
          metadata: { adapterKind: "runtime-action", actionType: input.payload.type, mappedCommand: "wordpress.run-php" },
        }
      }

      if (input.payload.type === "rest_request") {
        const path = stringField(input.payload, "path") ?? stringField(input.payload, "route")
        if (!path) {
          return unsupportedInputAdapterResolution(fuzzCase, target, "Expected rest_request runtime-action input path or route.", { adapterKind: "runtime-action", actionType: input.payload.type })
        }
        const method = stringField(input.payload, "method") ?? "GET"
        if (isRestMutationMethod(method) && !fuzzSuiteAllowsRestMutations(suite, fuzzCase, input.payload)) {
          return unsupportedInputAdapterResolution(fuzzCase, target, "REST mutation fuzzing requires explicit allowRestMutations opt-in on the suite, case, or input.", { adapterKind: "runtime-action", actionType: input.payload.type, mappedCommand: "wordpress.rest-request", method, path, mutationSkipped: true })
        }
        return {
          status: "supported",
          spec: stripUndefined({
            command: "wordpress.rest-request",
            args: [
              `path=${path}`,
              optionalStringArg("method", input.payload.method),
              jsonArg("headers-json", input.payload.headers),
              jsonArg("params-json", input.payload.params),
              input.payload.body === undefined ? undefined : `body=${String(input.payload.body)}`,
              input.payload.bodyJson === undefined && input.payload.body_json === undefined ? undefined : `body-json=${JSON.stringify(input.payload.bodyJson ?? input.payload.body_json)}`,
              optionalStringArg("user", input.payload.user),
              optionalStringArg("session", input.payload.session),
            ].filter((arg): arg is string => Boolean(arg)),
            method,
            path,
            timeoutMs: runtimeActionTimeoutMs(input.payload, input.timeoutMs),
          }) as ExecutionSpec,
          metadata: { adapterKind: "runtime-action", actionType: input.payload.type, mappedCommand: "wordpress.rest-request" },
        }
      }

      if (input.payload.type === "crud_operation") {
        try {
          const operation = normalizeWordPressCrudOperation({ schema: WORDPRESS_CRUD_OPERATION_SCHEMA, ...input.payload })
          return {
            status: "supported",
            spec: stripUndefined({
              command: "wordpress.crud-operation",
              args: [`operation-json=${JSON.stringify(operation)}`],
              timeoutMs: runtimeActionTimeoutMs(input.payload, input.timeoutMs),
            }) as ExecutionSpec,
            metadata: { adapterKind: "runtime-action", actionType: input.payload.type, mappedCommand: "wordpress.crud-operation" },
          }
        } catch (error) {
          return unsupportedInputAdapterResolution(fuzzCase, target, error instanceof Error ? error.message : String(error), { adapterKind: "runtime-action", actionType: input.payload.type })
        }
      }

      if (input.payload.type === "db_operation") {
        try {
          const operation = normalizeWordPressDbOperation({ schema: WORDPRESS_DB_OPERATION_SCHEMA, ...input.payload, operation: input.payload.operation ?? "read" })
          return {
            status: "supported",
            spec: stripUndefined({
              command: "wordpress.db-operation",
              args: [`operation-json=${JSON.stringify(operation)}`],
              timeoutMs: runtimeActionTimeoutMs(input.payload, input.timeoutMs),
            }) as ExecutionSpec,
            metadata: { adapterKind: "runtime-action", actionType: input.payload.type, mappedCommand: "wordpress.db-operation" },
          }
        } catch (error) {
          return unsupportedInputAdapterResolution(fuzzCase, target, error instanceof Error ? error.message : String(error), { adapterKind: "runtime-action", actionType: input.payload.type })
        }
      }

      if (input.payload.type === "wordpress_crud_operation") {
        return unsupportedTargetAdapterResolution(fuzzCase, target, "Runtime-action type wordpress_crud_operation has been renamed to crud_operation.", { adapterKind: "runtime-action", actionType: input.payload.type })
      }

      if (input.payload.type === "browser") {
        return {
          status: "supported",
          spec: stripUndefined({
            command: "wordpress.browser-actions",
            args: runtimeBrowserActionArgs(input.payload),
            timeoutMs: runtimeActionTimeoutMs(input.payload, input.timeoutMs),
          }) as ExecutionSpec,
          metadata: { adapterKind: "runtime-action", actionType: input.payload.type, mappedCommand: "wordpress.browser-actions" },
        }
      }

      if (input.payload.type === "browser_probe") {
        const url = stringField(input.payload, "url")
        if (!url) {
          return unsupportedInputAdapterResolution(fuzzCase, target, "Expected browser_probe runtime-action input url.", { adapterKind: "runtime-action", actionType: input.payload.type })
        }
        return {
          status: "supported",
          spec: stripUndefined({
            command: "wordpress.browser-probe",
            args: [
              `url=${url}`,
              optionalStringArg("wait-for", input.payload.wait_for ?? input.payload.waitFor),
              optionalStringArg("duration", input.payload.duration),
              csvArg("capture", input.payload.capture),
              optionalStringArg("viewport", input.payload.viewport),
            ].filter((arg): arg is string => Boolean(arg)),
            timeoutMs: runtimeActionTimeoutMs(input.payload, input.timeoutMs),
          }) as ExecutionSpec,
          metadata: { adapterKind: "runtime-action", actionType: input.payload.type, mappedCommand: "wordpress.browser-probe" },
        }
      }

      if (input.payload.type === "editor_open") {
        return {
          status: "supported",
          spec: stripUndefined({
            command: "wordpress.editor-open",
            args: runtimeEditorOpenArgs(input.payload),
            timeoutMs: runtimeActionTimeoutMs(input.payload, input.timeoutMs),
          }) as ExecutionSpec,
          metadata: { adapterKind: "runtime-action", actionType: input.payload.type, mappedCommand: "wordpress.editor-open" },
        }
      }

      if (input.payload.type === "admin_page" || input.payload.type === "page") {
        const command = input.payload.type === "admin_page" ? "wordpress.admin-page-load" : "wordpress.frontend-page-load"
        return {
          status: "supported",
          spec: stripUndefined({
            command,
            args: runtimePageLoadArgs(input.payload),
            timeoutMs: runtimeActionTimeoutMs(input.payload, input.timeoutMs),
          }) as ExecutionSpec,
          metadata: { adapterKind: "runtime-action", actionType: input.payload.type, mappedCommand: command },
        }
      }

      return unsupportedTargetAdapterResolution(fuzzCase, target, `Runtime-action type ${input.payload.type} needs an episode-aware executor and is not supported by this command-backed runner.`, { adapterKind: "runtime-action", actionType: input.payload.type })
    },
  }
}

function fuzzSuiteTargetCommand(target: FuzzSuiteTargetRef | undefined): string | undefined {
  if (!target) {
    return undefined
  }
  return target.entrypoint ?? target.id
}

function isWordPressWorkloadRunTarget(target: FuzzSuiteTargetRef): boolean {
  return target.kind === "runtime" && fuzzSuiteTargetCommand(target) === "wordpress.run-workload"
}

function fuzzSuiteRuntimeWorkloadInput(input: unknown): { status: "valid"; workload: Record<string, unknown> } | { status: "invalid"; message: string } {
  const payload = fuzzSuiteCaseRecordInput(input)
  if (payload.invalid || !isRecord(payload.payload)) {
    return { status: "invalid", message: "Expected wordpress.run-workload input object." }
  }
  const workload = payload.payload.schema === "wp-codebox/wordpress-workload-run/v1" ? payload.payload : isRecord(payload.payload.workload) ? payload.payload.workload : payload.payload
  if (!isRecord(workload) || !Array.isArray(workload.steps)) {
    return { status: "invalid", message: "Expected wordpress.run-workload input with a steps array." }
  }
  return { status: "valid", workload }
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

function unsupportedTargetAdapterResolution(fuzzCase: FuzzSuiteCase, target: FuzzSuiteTargetRef, message: string, metadata?: Record<string, unknown>): FuzzSuiteTargetAdapterResolution {
  return {
    status: "unsupported",
    diagnostics: [{ severity: "warning", code: "fuzz_suite_target_adapter_unsupported", caseId: fuzzCase.id, target, message, metadata }],
    metadata,
  }
}

function unsupportedInputAdapterResolution(fuzzCase: FuzzSuiteCase, target: FuzzSuiteTargetRef, message: string, metadata?: Record<string, unknown>): FuzzSuiteTargetAdapterResolution {
  return {
    status: "unsupported",
    diagnostics: [{ severity: "error", code: "fuzz_suite_input_unsupported", caseId: fuzzCase.id, target, message: `Fuzz suite case ${fuzzCase.id} has unsupported ${target.kind} input. ${message}`, metadata }],
    metadata,
  }
}

function fuzzSuiteSkipReason(diagnostics: readonly FuzzSuiteDiagnostic[]): string | undefined {
  return diagnostics[0]?.code ?? diagnostics[0]?.message
}

function normalizeFuzzSuiteRunnerCapabilities(input: FuzzSuiteRunOptions["runnerCapabilities"]): FuzzSuiteRunnerCapabilities {
  if (!input) {
    return RUNTIME_BACKED_FUZZ_SUITE_RUNNER_CAPABILITIES
  }
  if (Array.isArray(input)) {
    return { schema: FUZZ_RUNNER_CAPABILITIES_SCHEMA, mode: "runtime-backed", capabilities: [...input], targetKinds: DEFAULT_SUPPORTED_TARGET_KINDS, unsupportedRequiredCapabilities: [] }
  }
  return input as FuzzSuiteRunnerCapabilities
}

function missingRequiredFuzzSuiteCapabilities(suite: FuzzSuiteContract, runnerCapabilities: FuzzSuiteRunnerCapabilities): string[] {
  return unsupportedRequiredFuzzRunnerCapabilities(suite, runnerCapabilities)
}

function requiredCoverageDiagnostics(requireCoverage: boolean | undefined, suite: FuzzSuiteContract, fuzzCase: FuzzSuiteCase, diagnostics: readonly FuzzSuiteDiagnostic[]): FuzzSuiteDiagnostic[] {
  if (!requireCoverage) {
    return [...diagnostics]
  }
  const unsupported = diagnostics.find((diagnostic) => diagnostic.code === "fuzz_suite_case_unsupported" || diagnostic.code === "fuzz_suite_target_adapter_unsupported" || diagnostic.code === "fuzz_suite_executor_unavailable")
  if (!unsupported) {
    return [...diagnostics]
  }
  return [...diagnostics, {
    severity: "error",
    code: "fuzz_suite_required_coverage_unsupported",
    caseId: fuzzCase.id,
    target: fuzzCase.target ?? suite.target,
    message: `Fuzz suite ${suite.id} requires coverage for case ${fuzzCase.id}, but the selected runner skipped an unsupported target.`,
    metadata: { skippedCode: unsupported.code },
  }]
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

function fuzzSuiteCaseRecordInput(input: unknown): { invalid?: false; payload: unknown; timeoutMs?: number; expectedResultSchema?: unknown } | { invalid: true } {
  if (!isRecord(input)) {
    return { payload: input }
  }
  const timeoutMs = input.timeoutMs
  if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs))) {
    return { invalid: true }
  }
  return {
    payload: input.input ?? input.payload ?? input,
    timeoutMs,
    expectedResultSchema: input.expectedResultSchema ?? input.expected_result_schema,
  }
}

function fuzzSuiteRuntimeActionInput(input: unknown): { status: "valid"; action: RuntimeAction } | { status: "invalid"; message: string } {
  const normalized = fuzzSuiteCaseRecordInput(input)
  if (normalized.invalid || !isRecord(normalized.payload) || typeof normalized.payload.type !== "string") {
    return { status: "invalid", message: "Expected runtime-action input object with a type field." }
  }
  return { status: "valid", action: normalized.payload as unknown as RuntimeAction }
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return Boolean(input) && typeof input === "object" && !Array.isArray(input)
}

function stringField(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function optionalStringArg(name: string, value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? `${name}=${value}` : undefined
}

function optionalNumberArg(name: string, value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value) ? `${name}=${value}` : undefined
}

function csvArg(name: string, value: unknown): string | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") && value.length > 0 ? `${name}=${value.join(",")}` : undefined
}

function runtimeBrowserActionArgs(input: Record<string, unknown>): string[] {
  const action: Record<string, unknown> = { kind: input.operation === "wait" ? "waitFor" : input.operation }
  for (const key of ["url", "selector", "text", "value", "key", "duration"] as const) {
    if (typeof input[key] === "string") {
      action[key] = input[key]
    }
  }
  if (typeof input.wait_for === "string") {
    action.waitFor = input.wait_for
  } else if (typeof input.waitFor === "string") {
    action.waitFor = input.waitFor
  }
  if (input.operation === "capture" && Array.isArray(input.capture)) {
    action.capture = input.capture
  }
  return [
    typeof input.url === "string" && input.operation !== "navigate" ? `url=${input.url}` : undefined,
    `steps-json=${JSON.stringify([action])}`,
    csvArg("capture", input.capture),
  ].filter((arg): arg is string => Boolean(arg))
}

function runtimeEditorOpenArgs(input: Record<string, unknown>): string[] {
  return [
    optionalStringArg("target", input.target),
    optionalNumberArg("post-id", input.post_id ?? input.postId),
    optionalStringArg("post-type", input.post_type ?? input.postType),
    optionalStringArg("url", input.url),
    optionalStringArg("wait-selector", input.wait_selector ?? input.waitSelector),
    durationMsArg("wait-timeout", input.timeout_ms ?? input.timeoutMs),
    csvArg("capture", input.capture),
  ].filter((arg): arg is string => Boolean(arg))
}

function durationMsArg(name: string, value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value) ? `${name}=${value}ms` : undefined
}

function runtimePageLoadArgs(input: Record<string, unknown>): string[] {
  return [
    optionalStringArg("path", input.path),
    optionalStringArg("url", input.url),
    optionalStringArg("method", input.method),
    jsonArg("query-json", input.query),
    input.body === undefined ? undefined : `body-json=${JSON.stringify(input.body)}`,
    optionalStringArg("user", input.user),
    optionalStringArg("session", input.session),
    csvArg("capture-diagnostics", input.capture_diagnostics ?? input.captureDiagnostics),
  ].filter((arg): arg is string => Boolean(arg))
}

function runtimeActionTimeoutMs(input: Record<string, unknown>, fallback: number | undefined): number | undefined {
  const timeoutMs = input.timeout_ms ?? input.timeoutMs ?? fallback
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) ? timeoutMs : undefined
}

function jsonArg(name: string, value: unknown): string | undefined {
  return value === undefined ? undefined : `${name}=${JSON.stringify(value)}`
}

function fuzzSuiteExecutionArtifactRefs(execution: ExecutionResult): FuzzSuiteArtifactRef[] | undefined {
  const refs = [...(execution.artifactRefs ?? []), ...(execution.result?.artifactRefs ?? [])].map(fuzzSuiteArtifactRefFromTrace).filter((ref): ref is FuzzSuiteArtifactRef => Boolean(ref))
  return refs.length > 0 ? refs : undefined
}

function fuzzSuiteRuntimeActionArtifactRefs(observation: RuntimeActionObservation): FuzzSuiteArtifactRef[] | undefined {
  const refs = (observation.artifactRefs ?? []).map(fuzzSuiteArtifactRefFromTrace).filter((ref): ref is FuzzSuiteArtifactRef => Boolean(ref))
  return refs.length > 0 ? refs : undefined
}

function fuzzSuiteRuntimeActionMutationArtifactRefs(observation: RuntimeActionObservation): FuzzSuiteArtifactRef[] {
  const artifacts = [recordValue(observation.data.mutationIsolationArtifact), recordValue(observation.data.deleteBoundaryArtifact)]
  return artifacts.flatMap((artifact) => {
    if (!artifact) return []
    const path = typeof artifact?.artifactPath === "string" ? artifact.artifactPath : undefined
    const schema = typeof artifact?.schema === "string" ? artifact.schema : undefined
    if (!path || (schema !== MUTATION_ISOLATION_ARTIFACT_SCHEMA && schema !== DELETE_BOUNDARY_ARTIFACT_SCHEMA)) {
      return []
    }
    return [stripUndefined({
      path,
      kind: schema === DELETE_BOUNDARY_ARTIFACT_SCHEMA ? "delete-boundary" : "mutation-isolation",
      contentType: "application/json",
      sha256: typeof artifact.sha256 === "string" ? artifact.sha256 : undefined,
      bytes: typeof artifact.bytes === "number" ? artifact.bytes : undefined,
      name: schema === DELETE_BOUNDARY_ARTIFACT_SCHEMA ? "delete-boundary" : "mutation-isolation",
      metadata: { schema, method: artifact.method, target: artifact.target, status: artifact.status, restore: recordValue(artifact.restore) },
    })]
  })
}

function dedupeFuzzSuiteArtifactRefs(refs: readonly FuzzSuiteArtifactRef[]): FuzzSuiteArtifactRef[] | undefined {
  const seen = new Set<string>()
  const deduped: FuzzSuiteArtifactRef[] = []
  for (const ref of refs) {
    const key = `${ref.kind}:${ref.path}`
    if (!seen.has(key)) {
      seen.add(key)
      deduped.push(ref)
    }
  }
  return deduped.length > 0 ? deduped : undefined
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

function fuzzSuiteAllowsRestMutations(suite: FuzzSuiteContract, fuzzCase: FuzzSuiteCase, input?: Record<string, unknown>): boolean {
  const candidates = [input, fuzzCase.metadata, suite.metadata]
  return candidates.some((metadata) => Boolean(metadata?.allowRestMutations ?? metadata?.allow_rest_mutations))
}

function fuzzSuiteRuntimeActionMetadataInput(input: unknown, action: RuntimeAction): unknown {
  if (action.type !== "rest_request" || !isRestMutationMethod(action.method ?? "GET")) {
    return input
  }
  const payload = recordValue(input)
  return stripUndefined({
    ...(payload ?? {}),
    type: "rest_request",
    method: action.method ?? "GET",
    path: action.path,
    headers: payload?.headers === undefined ? undefined : "[redacted]",
    params: payload?.params === undefined ? undefined : "[redacted]",
    body: payload?.body === undefined ? undefined : "[redacted]",
    body_json: payload?.body_json === undefined ? undefined : "[redacted]",
    bodyJson: payload?.bodyJson === undefined ? undefined : "[redacted]",
  })
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
