import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { commandArgValue, parseCommandJson, parseCommandJsonObject, RUNTIME_BACKED_FUZZ_SUITE_RUNNER_CAPABILITIES, runFuzzSuite, runtimeCheckpointUnsupportedDiagnostic, type ArtifactBundle, type ArtifactManifestFile, type ExecutionResult, type FuzzSuiteContract, type Runtime, type RuntimeCheckpointFailureDiagnostic, type RuntimeCheckpointOperation, type RuntimeCheckpointResult, type WorkspaceRecipe, type WorkspaceRecipeDistributionSetupArtifact, type WorkspaceRecipeDistributionStartupProbe, type WorkspaceRecipeProbe } from "@automattic/wp-codebox-core"
import { stripUndefined } from "@automattic/wp-codebox-core/internals"
import { createWordPressFuzzSuiteResetExecutor } from "@automattic/wp-codebox-playground/public"
import { correlateObservedHostsToExternalServiceBoundaries, recipeExternalServiceBoundarySummaries } from "../recipe-external-services.js"
import { recipeExecutionSpec, sandboxWorkspaceContract } from "../agent-sandbox.js"
import { executeAgentFanoutFromArgs } from "../agent-fanout.js"
import { executeBoundedRecipePlanFromArgs } from "../bounded-recipe-plan.js"
import { recipeWorkflowSteps, type RecipeWorkflowPhase } from "../recipe-validation.js"
import { artifactManifestFilesByPath } from "./recipe-run-benchmark-artifacts.js"
import { assertResolvedInputMountPathArgs, rewriteInputMountPathArgs, rewriteInputMountPathJsonArgs, type InputMountPathMapping } from "../input-mount-paths.js"
import { RecipeRunTimeoutError, serializeRecipeRunError } from "./recipe-run-output.js"
import type { RecipeAdvisoryFailure, RecipeBrowserEvidence, RecipeBrowserEvidenceFileRef, RecipeContinuationEvidence, RecipeContinuationProgress, RecipeExecutionResult, RecipeRunDistributionSetupArtifact, RecipeRunDistributionStartupProbe, RecipeRunOptions, RecipeRunProbe, RecipeStepFailure, RecipeWorkflowArgsEvidence } from "./recipe-run-types.js"

export function withRecipeExecutionPhase(execution: ExecutionResult, recipePhase: RecipeWorkflowPhase, recipeStepIndex: number, recipeCommand?: string, recipeArgs?: RecipeWorkflowArgsEvidence, recipeStepMetadata?: Record<string, unknown>): RecipeExecutionResult {
  return {
    ...execution,
    recipePhase,
    recipeStepIndex,
    recipeCommand,
    ...(recipeArgs ? { recipeArgs } : {}),
    ...(recipeStepMetadata ? { recipeStepMetadata } : {}),
  }
}

export function recipeWorkflowArgsEvidence(original: readonly string[] | undefined, effective: readonly string[] | undefined): RecipeWorkflowArgsEvidence | undefined {
  const originalArgs = [...(original ?? [])]
  const effectiveArgs = [...(effective ?? [])]
  if (originalArgs.length === 0 && effectiveArgs.length === 0) {
    return undefined
  }

  return {
    schema: "wp-codebox/recipe-workflow-args/v1",
    original: originalArgs,
    effective: effectiveArgs,
    rewritten: JSON.stringify(originalArgs) !== JSON.stringify(effectiveArgs),
  }
}

export function recipeWorkflowStepIsAdvisory(step: WorkspaceRecipe["workflow"]["steps"][number]): boolean {
  return step.allowFailure === true || step.advisory === true
}

export function recipeAdvisoryFailure(workflowStep: ReturnType<typeof recipeWorkflowSteps>[number], error: unknown, continuationProgress?: RecipeContinuationProgress): RecipeAdvisoryFailure {
  const continuationEvidence = recipeFailureContinuationEvidence(error, continuationProgress)
  return {
    schema: "wp-codebox/recipe-advisory-failure/v1",
    phase: workflowStep.phase,
    index: workflowStep.index,
    command: workflowStep.step.command,
    status: "failed",
    error: serializeRecipeRunError(error),
    ...(continuationEvidence ? { continuationEvidence } : {}),
  }
}

export function recipeStepFailure(workflowStep: ReturnType<typeof recipeWorkflowSteps>[number], error: unknown, startedAtMs: number, finishedAtMs = Date.now(), continuationProgress?: RecipeContinuationProgress): RecipeStepFailure {
  const timeoutError = recipeTimeoutError(error)
  const continuationEvidence = recipeFailureContinuationEvidence(error, continuationProgress)
  return stripUndefined({
    schema: "wp-codebox/recipe-step-failure/v1",
    phase: workflowStep.phase,
    index: workflowStep.index,
    command: workflowStep.step.command,
    metadata: workflowStep.step.metadata,
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: Math.max(0, finishedAtMs - startedAtMs),
    classification: timeoutError ? "timeout" as const : "error" as const,
    timeoutMs: timeoutError?.timeoutMs,
    error: serializeRecipeRunError(error),
    continuationEvidence,
  }) as RecipeStepFailure
}

function recipeTimeoutError(error: unknown): RecipeRunTimeoutError | undefined {
  if (error instanceof RecipeRunTimeoutError) return error
  if (error instanceof Error && error.cause) return recipeTimeoutError(error.cause)
  return undefined
}

function recipeContinuationError(error: unknown): RecipeContinuationError | undefined {
  if (error instanceof RecipeContinuationError) return error
  if (error instanceof Error && error.cause) return recipeContinuationError(error.cause)
  return undefined
}

function recipeFailureContinuationEvidence(error: unknown, progress?: RecipeContinuationProgress): RecipeContinuationEvidence | undefined {
  const evidence = recipeContinuationError(error)?.continuationEvidence
  if (evidence || !progress) return evidence
  const timeout = recipeTimeoutError(error)
  return {
    ...progress,
    status: "failed",
    diagnostics: {
      code: timeout ? "step-timeout" : "step-failed",
      message: timeout ? `Continuation timed out after ${timeout.timeoutMs}ms.` : "Continuation failed before producing terminal evidence.",
    },
  }
}

export async function recipeBrowserEvidence(artifacts: ArtifactBundle, executions: RecipeExecutionResult[], recipe?: WorkspaceRecipe): Promise<RecipeBrowserEvidence[]> {
  const manifestFiles = await artifactManifestFilesByPath(artifacts)
  return executions.flatMap((execution) => recipeBrowserEvidenceForExecution(execution, manifestFiles, recipe))
}

function recipeBrowserEvidenceForExecution(execution: RecipeExecutionResult, manifestFiles: Map<string, ArtifactManifestFile>, recipe: WorkspaceRecipe | undefined): RecipeBrowserEvidence[] {
  const command = execution.recipeCommand ?? execution.command
  if (!recipeCommandProducesBrowserEvidence(command)) {
    return []
  }

  const parsed = parseJsonObject(execution.stdout)
  if (!parsed && command === "wordpress.editor-validate-blocks") {
    const evidence = recipeBrowserEvidenceFromEditorValidateBlocksExecution(execution, manifestFiles)
    return evidence ? [evidence] : []
  }
  if (!parsed) {
    return []
  }

  if (Array.isArray(parsed.profiles)) {
    return parsed.profiles.flatMap((profile) => {
      const profileEvidence = recipeBrowserEvidenceFromParsedExecution(execution, command, profile, manifestFiles, recipe)
      return profileEvidence ? [profileEvidence] : []
    })
  }

  const evidence = command === "wordpress.editor-validate-blocks"
    ? recipeBrowserEvidenceFromEditorValidateBlocksExecution(execution, manifestFiles, parsed)
    : recipeBrowserEvidenceFromParsedExecution(execution, command, parsed, manifestFiles, recipe)
  return evidence ? [evidence] : []
}

function recipeBrowserEvidenceFromEditorValidateBlocksExecution(execution: RecipeExecutionResult, manifestFiles: Map<string, ArtifactManifestFile>, parsed?: Record<string, unknown>): RecipeBrowserEvidence | undefined {
  const files = recipeBrowserEvidenceFiles({
    validateBlocks: "files/browser/editor-validate-blocks.json",
    summary: "files/browser/editor-validate-blocks-summary.json",
  }, manifestFiles)
  const summaryFile = browserEvidenceFileRef("files/browser/editor-validate-blocks-summary.json", manifestFiles)
  if (Object.keys(files).length === 0 && !summaryFile) {
    return undefined
  }

  const validation = parsed ?? (typeof execution.result?.stdout === "string" ? parseJsonObject(execution.result.stdout) : undefined)
  const summary = stripUndefined({
    editorValidateBlocks: validation,
  })
  return stripUndefined({
    schema: "wp-codebox/recipe-browser-evidence/v1",
    phase: execution.recipePhase,
    index: execution.recipeStepIndex,
    command: "wordpress.editor-validate-blocks",
    metadata: execution.recipeStepMetadata,
    status: execution.exitCode === 0 ? "completed" : "failed",
    summaryFile,
    files,
    summary: Object.keys(summary).length > 0 ? summary : undefined,
  }) as RecipeBrowserEvidence
}

function recipeBrowserEvidenceFromParsedExecution(execution: RecipeExecutionResult, command: string, parsed: Record<string, unknown>, manifestFiles: Map<string, ArtifactManifestFile>, recipe: WorkspaceRecipe | undefined): RecipeBrowserEvidence | undefined {
  const files = recipeBrowserEvidenceFiles(parsed.files, manifestFiles)
  const summaryFile = browserEvidenceFileRef(stringValue((parsed.files as Record<string, unknown> | undefined)?.summary), manifestFiles)
  if (Object.keys(files).length === 0 && !summaryFile) {
    return undefined
  }

  const summary = parsed.summary
  const summaryObject = isRecord(summary) ? summary : undefined
  const networkPolicy = isRecord(summaryObject?.networkPolicy) ? summaryObject.networkPolicy : isRecord(parsed.networkPolicy) ? parsed.networkPolicy : undefined
  const observedHosts = isRecord(networkPolicy?.hosts) ? networkPolicy.hosts : undefined
  const externalServiceBoundaries = recipe ? correlateObservedHostsToExternalServiceBoundaries(observedHosts, recipeExternalServiceBoundarySummaries(recipe)) : undefined
  return stripUndefined({
    schema: "wp-codebox/recipe-browser-evidence/v1",
    phase: execution.recipePhase,
    index: execution.recipeStepIndex,
    command,
    metadata: execution.recipeStepMetadata,
    status: execution.exitCode === 0 ? "completed" : "failed",
    requestedUrl: stringValue(parsed.requestedUrl),
    finalUrl: stringValue(parsed.finalUrl ?? summaryObject?.finalUrl),
    summaryFile,
    files,
    summary,
    externalServiceBoundaries,
    scriptResult: summaryObject?.scriptResult,
  }) as RecipeBrowserEvidence
}

function recipeBrowserEvidenceFiles(files: unknown, manifestFiles: Map<string, ArtifactManifestFile>): Record<string, RecipeBrowserEvidenceFileRef | RecipeBrowserEvidenceFileRef[]> {
  if (!isRecord(files)) {
    return {}
  }

  const refs: Record<string, RecipeBrowserEvidenceFileRef | RecipeBrowserEvidenceFileRef[]> = {}
  for (const [name, value] of Object.entries(files)) {
    const ref = Array.isArray(value)
      ? value.map((entry) => browserEvidenceFileRef(stringValue(entry), manifestFiles)).filter((entry): entry is RecipeBrowserEvidenceFileRef => Boolean(entry))
      : browserEvidenceFileRef(stringValue(value), manifestFiles)
    if (Array.isArray(ref)) {
      if (ref.length > 0) {
        refs[name] = ref
      }
      continue
    }
    if (ref) {
      refs[name] = ref
    }
  }
  return refs
}

function browserEvidenceFileRef(path: string | undefined, manifestFiles: Map<string, ArtifactManifestFile>): RecipeBrowserEvidenceFileRef | undefined {
  if (!path) {
    return undefined
  }
  const manifestFile = manifestFiles.get(path)
  return stripUndefined({
    path,
    kind: manifestFile?.kind,
    contentType: manifestFile?.contentType,
    sha256: manifestFile?.sha256,
  }) as RecipeBrowserEvidenceFileRef
}

function recipeCommandProducesBrowserEvidence(command: string): boolean {
  return command.startsWith("wordpress.browser-") || command === "wordpress.editor-canvas-probe" || command === "wordpress.editor-validate-blocks" || command === "wordpress.html-capture" || command === "wordpress.visual-compare"
}

export async function executeRecipeWorkflowStep(runtime: Runtime, workflowStep: ReturnType<typeof recipeWorkflowSteps>[number], recipeDirectory: string, sandboxWorkspace?: ReturnType<typeof sandboxWorkspaceContract>, artifactRoot?: string, options?: RecipeRunOptions, inputMountPathMap: readonly InputMountPathMapping[] = [], onContinuationProgress?: (progress: RecipeContinuationProgress) => void, signal?: AbortSignal): Promise<RecipeExecutionResult> {
  const originalArgs = workflowStep.step.args ?? []
  const resolvedArgs = rewriteWorkflowStepArgs(workflowStep.step.command, originalArgs, inputMountPathMap)
  assertResolvedInputMountPathArgs(resolvedArgs, inputMountPathMap, `Recipe workflow ${workflowStep.phase}[${workflowStep.index}] ${workflowStep.step.command}`)
  const step = { ...workflowStep.step, args: resolvedArgs }
  const argsEvidence = recipeWorkflowArgsEvidence(originalArgs, resolvedArgs)
  const mappedWorkflowStep = { ...workflowStep, step }
  const phase = (execution: ExecutionResult, command = step.command, evidence = argsEvidence) => withRecipeExecutionPhase(execution, workflowStep.phase, workflowStep.index, command, evidence, step.metadata)
  try {
    if (step.continuation) {
      if (recipeCommandHandlesItsOwnExecution(step.command)) {
        throw new Error(`Continuation is unavailable for recipe command ${step.command}.`)
      }
      return await executeRecipeStepContinuation(runtime, mappedWorkflowStep, recipeDirectory, sandboxWorkspace, inputMountPathMap, onContinuationProgress, signal)
    }
    if (step.command === "wp-codebox.agent-fanout") {
      const startedAt = new Date().toISOString()
      const result = await executeAgentFanoutFromArgs(step.args ?? [], {
        artifactRoot: artifactRoot || recipeDirectory,
        recipeDirectory,
        previewHoldSeconds: options?.previewHoldSeconds === undefined ? "" : String(options.previewHoldSeconds),
        previewPublicUrl: options?.previewPublicUrl,
        previewPort: options?.previewPort === undefined ? "" : String(options.previewPort),
        previewBind: options?.previewBind,
        previewHoldBlocking: options?.previewHoldBlocking,
      })
      const finishedAt = new Date().toISOString()
      return {
        ...phase({
          id: `agent-fanout-${workflowStep.index}`,
          command: step.command,
          args: step.args ?? [],
          exitCode: result.success ? 0 : 1,
          stdout: `${JSON.stringify(result, null, 2)}\n`,
          stderr: "",
          startedAt,
          finishedAt,
        }),
        ...(workflowStep.fuzzCaseId ? { fuzzCaseId: workflowStep.fuzzCaseId } : {}),
        ...(workflowStep.fuzzCaseIndex !== undefined ? { fuzzCaseIndex: workflowStep.fuzzCaseIndex } : {}),
        ...(workflowStep.fuzzPhase ? { fuzzPhase: workflowStep.fuzzPhase } : {}),
        ...(workflowStep.fuzzStepIndex !== undefined ? { fuzzStepIndex: workflowStep.fuzzStepIndex } : {}),
      }
    }
    if (step.command === "wp-codebox.bounded-runtime-plan") {
      const startedAt = new Date().toISOString()
      const result = await executeBoundedRecipePlanFromArgs(runtime, step.args ?? [], {
        artifactRoot: artifactRoot || recipeDirectory,
        recipeDirectory,
      })
      const safeArgs = (step.args ?? []).map((argument) => argument.startsWith("plan-json=") || argument.startsWith("request-json=") ? `${argument.slice(0, argument.indexOf("=") + 1)}[redacted-plan]` : argument)
      return phase({
        id: `bounded-runtime-plan-${workflowStep.index}`,
        command: step.command,
        args: safeArgs,
        exitCode: result.success ? 0 : 1,
        stdout: `${JSON.stringify(result, null, 2)}\n`,
        stderr: "",
        startedAt,
        finishedAt: new Date().toISOString(),
        artifactRefs: [{ kind: "bounded-runtime-plan-result", id: "bounded-runtime-plan-result", path: "bounded-plan/result.json" }],
      }, step.command, recipeWorkflowArgsEvidence(safeArgs, safeArgs))
    }
    if (isRuntimeCheckpointRecipeCommand(step.command)) {
      return phase(await executeRuntimeCheckpointRecipeCommand(runtime, step.command, step.args ?? []))
    }
    if (step.command === "wp-codebox/run-fuzz-suite") {
      return phase(await executeRunFuzzSuiteRecipeCommand(runtime, step.args ?? [], recipeDirectory, sandboxWorkspace, inputMountPathMap, signal))
    }
    if (step.command === "wordpress.run-workload" && commandArgValue(step.args ?? [], "workload-json")) {
      return phase(await executeWordPressRunWorkloadJsonRecipeCommand(runtime, step.args ?? [], recipeDirectory, sandboxWorkspace, undefined, undefined, inputMountPathMap, signal))
    }
    const spec = await recipeExecutionSpec(workflowStep.step, recipeDirectory, sandboxWorkspace, { inputMountPathMap })
    const execution = await runtime.execute({ ...spec, signal })
    return {
      ...withRecipeExecutionPhase(execution, workflowStep.phase, workflowStep.index, step.command, recipeWorkflowArgsEvidence(spec.originalArgs, spec.resolvedArgs), step.metadata),
      ...(workflowStep.fuzzCaseId ? { fuzzCaseId: workflowStep.fuzzCaseId } : {}),
      ...(workflowStep.fuzzCaseIndex !== undefined ? { fuzzCaseIndex: workflowStep.fuzzCaseIndex } : {}),
      ...(workflowStep.fuzzPhase ? { fuzzPhase: workflowStep.fuzzPhase } : {}),
      ...(workflowStep.fuzzStepIndex !== undefined ? { fuzzStepIndex: workflowStep.fuzzStepIndex } : {}),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Recipe workflow ${mappedWorkflowStep.phase}[${mappedWorkflowStep.index}] failed: ${message}`, { cause: error })
  }
}

function recipeCommandHandlesItsOwnExecution(command: string): boolean {
  return command === "wordpress.collect-workload-result"
    || command === "wordpress.run-workload"
    || command === "wp-codebox.agent-fanout"
    || command === "wp-codebox.bounded-runtime-plan"
    || command === "wp-codebox.checkpoint-create"
    || command === "wp-codebox.checkpoint-restore"
    || command === "wp-codebox.checkpoint-list"
    || command === "wp-codebox/run-fuzz-suite"
}

export class RecipeContinuationError extends Error {
  readonly code = "recipe-continuation-failed"

  constructor(message: string, readonly continuationEvidence: RecipeContinuationEvidence) {
    super(message)
    this.name = "RecipeContinuationError"
  }
}

async function executeRecipeStepContinuation(runtime: Runtime, workflowStep: ReturnType<typeof recipeWorkflowSteps>[number], recipeDirectory: string, sandboxWorkspace: ReturnType<typeof sandboxWorkspaceContract> | undefined, inputMountPathMap: readonly InputMountPathMapping[], onProgress?: (progress: RecipeContinuationProgress) => void, signal?: AbortSignal): Promise<RecipeExecutionResult> {
  const continuation = workflowStep.step.continuation!
  let args = rewriteWorkflowStepArgs(workflowStep.step.command, workflowStep.step.args ?? [], inputMountPathMap)
  const policy = continuationPolicyEvidence(continuation)
  const executions: RecipeContinuationEvidence["executions"] = []
  const progress = (): RecipeContinuationProgress => ({ schema: "wp-codebox/recipe-continuation-evidence/v1", policy, iterations: executions.length, executions: [...executions] })
  onProgress?.(progress())
  const fail = (code: string, message: string): never => {
    throw new RecipeContinuationError(message, { schema: "wp-codebox/recipe-continuation-evidence/v1", policy, status: "failed", iterations: executions.length, executions, diagnostics: { code, message } })
  }

  for (let iteration = 1; iteration <= continuation.maxIterations; iteration++) {
    let execution: ExecutionResult | undefined
    try {
      const spec = await recipeExecutionSpec({ ...workflowStep.step, args }, recipeDirectory, sandboxWorkspace, { inputMountPathMap })
      execution = await runtime.execute({ ...spec, signal })
      args = spec.resolvedArgs
    } catch (error) {
      fail("execution-error", error instanceof Error ? error.message : String(error))
    }
    if (!execution) fail("execution-error", "Continuation command did not produce an execution result.")
    const completedExecution = execution as ExecutionResult
    const result = continuationResult(completedExecution)
    executions.push(continuationExecutionEvidence(iteration, args, completedExecution.exitCode, result))
    onProgress?.(progress())
    if (completedExecution.exitCode !== 0) {
      fail("command-failed", `Continuation command exited with code ${completedExecution.exitCode}.`)
    }
    const predicate = pointerValue(result, continuation.while.pointer)
    if (!predicate.found) {
      fail("predicate-value-missing", `Continuation predicate pointer ${continuation.while.pointer} did not resolve.`)
    }
    if (!isDeepStrictEqual(predicate.value, continuation.while.equals)) {
      return {
        ...withRecipeExecutionPhase(completedExecution, workflowStep.phase, workflowStep.index, workflowStep.step.command, recipeWorkflowArgsEvidence(workflowStep.step.args, args), workflowStep.step.metadata),
        continuationEvidence: { schema: "wp-codebox/recipe-continuation-evidence/v1", policy, status: "completed", iterations: iteration, executions },
      }
    }
    if (iteration === continuation.maxIterations) {
      throw new RecipeContinuationError(`Continuation reached its maximum of ${continuation.maxIterations} iterations without a terminal result.`, { schema: "wp-codebox/recipe-continuation-evidence/v1", policy, status: "exhausted", iterations: iteration, executions, diagnostics: { code: "max-iterations-exhausted", message: "Continuation predicate remained matched at the iteration limit." } })
    }
    args = applyContinuationMappings(args, result, continuation.inputMappings, fail)
  }
  throw new Error("Unreachable continuation state")
}

const CONTINUATION_RESULT_PREVIEW_MAX_BYTES = 4096

function continuationPolicyEvidence(continuation: NonNullable<WorkspaceRecipe["workflow"]["steps"][number]["continuation"]>): RecipeContinuationEvidence["policy"] {
  const serializedEquals = JSON.stringify(continuation.while.equals) ?? "null"
  const equalsBytes = Buffer.byteLength(serializedEquals, "utf8")
  return {
    maxIterations: continuation.maxIterations,
    while: {
      pointer: continuation.while.pointer,
      equalsBytes,
      equalsSha256: createHash("sha256").update(serializedEquals).digest("hex"),
      ...(equalsBytes <= CONTINUATION_RESULT_PREVIEW_MAX_BYTES ? { equals: continuation.while.equals } : { equalsTruncated: true }),
    },
    inputMappings: continuation.inputMappings.map((mapping) => ({ from: mapping.from, to: { ...mapping.to } })),
  }
}

function continuationExecutionEvidence(iteration: number, args: string[], exitCode: number, result: unknown): RecipeContinuationEvidence["executions"][number] {
  const serialized = result === undefined ? "" : JSON.stringify(result)
  const resultBytes = Buffer.byteLength(serialized, "utf8")
  return {
    iteration,
    exitCode,
    argsSha256: createHash("sha256").update(JSON.stringify(args)).digest("hex"),
    resultBytes,
    resultSha256: createHash("sha256").update(serialized).digest("hex"),
    ...(result !== undefined && resultBytes <= CONTINUATION_RESULT_PREVIEW_MAX_BYTES ? { result } : {}),
    ...(resultBytes > CONTINUATION_RESULT_PREVIEW_MAX_BYTES ? { resultTruncated: true } : {}),
  }
}

function continuationResult(execution: ExecutionResult): unknown {
  if (execution.result?.json !== undefined) return execution.result.json
  try {
    return JSON.parse(execution.stdout)
  } catch {
    return undefined
  }
}

function applyContinuationMappings(args: string[], result: unknown, mappings: NonNullable<WorkspaceRecipe["workflow"]["steps"][number]["continuation"]>["inputMappings"], fail: (code: string, message: string) => never): string[] {
  const next = [...args]
  for (const mapping of mappings) {
    const source = pointerValue(result, mapping.from)
    if (!source.found) fail("mapping-source-missing", `Continuation source pointer ${mapping.from} did not resolve.`)
    const indexes = next.map((argument, index) => argument.startsWith(`${mapping.to.arg}=`) ? index : -1).filter((index) => index >= 0)
    if (indexes.length !== 1) fail(indexes.length === 0 ? "target-argument-missing" : "target-argument-ambiguous", `Continuation target argument ${mapping.to.arg} must appear exactly once.`)
    const index = indexes[0]!
    const raw = next[index]!.slice(mapping.to.arg.length + 1)
    let target: unknown
    try {
      target = JSON.parse(raw)
    } catch {
      fail("target-argument-not-json", `Continuation target argument ${mapping.to.arg} must contain JSON.`)
    }
    if (!target || typeof target !== "object") fail("target-argument-not-container", `Continuation target argument ${mapping.to.arg} must contain a JSON object or array.`)
    if (mapping.to.pointer === "") fail("target-root-mutation-unsupported", "Continuation mappings cannot replace a target argument root.")
    if (!setPointerValue(target, mapping.to.pointer, source.value)) fail("target-pointer-missing", `Continuation target pointer ${mapping.to.pointer} did not resolve to an existing value.`)
    next[index] = `${mapping.to.arg}=${JSON.stringify(target)}`
  }
  return next
}

function pointerValue(value: unknown, pointer: string): { found: boolean; value?: unknown } {
  const segments = decodeJsonPointer(pointer)
  if (!segments) return { found: false }
  let current = value
  for (const segment of segments) {
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(segment) || Number(segment) >= current.length) return { found: false }
      current = current[Number(segment)]
    } else if (current && typeof current === "object" && Object.prototype.hasOwnProperty.call(current, segment)) {
      current = (current as Record<string, unknown>)[segment]
    } else return { found: false }
  }
  return { found: true, value: current }
}

function setPointerValue(target: object, pointer: string, value: unknown): boolean {
  const segments = decodeJsonPointer(pointer)
  if (!segments || segments.length === 0) return false
  const parentSegments = segments.slice(0, -1)
  const parent = pointerValue(target, parentSegments.length === 0 ? "" : `/${parentSegments.map(encodeJsonPointerSegment).join("/")}`)
  if (!parent.found || !parent.value || typeof parent.value !== "object") return false
  const key = segments.at(-1)!
  if (Array.isArray(parent.value)) {
    if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= parent.value.length) return false
    parent.value[Number(key)] = value
    return true
  }
  if (["__proto__", "constructor", "prototype"].includes(key)) return false
  ;(parent.value as Record<string, unknown>)[key] = value
  return true
}

function decodeJsonPointer(pointer: string): string[] | undefined {
  if (pointer === "") return []
  if (!pointer.startsWith("/")) return undefined
  const segments = pointer.slice(1).split("/")
  if (segments.some((segment) => /~(?:[^01]|$)/.test(segment))) return undefined
  return segments.map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"))
}

function encodeJsonPointerSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1")
}

function rewriteWorkflowStepArgs(command: string, args: readonly string[], inputMountPathMap: readonly InputMountPathMapping[] = []): string[] {
  const rewritten = rewriteInputMountPathArgs(args, inputMountPathMap)
  if (command === "wordpress.run-workload") {
    return rewriteInputMountPathJsonArgs(rewritten, ["workload-json"], inputMountPathMap)
  }
  if (command === "wp-codebox/run-fuzz-suite") {
    return rewriteInputMountPathJsonArgs(rewritten, ["input-json", "suite-json"], inputMountPathMap)
  }
  return rewritten
}

async function executeWordPressRunWorkloadJsonRecipeCommand(runtime: Runtime, args: string[], recipeDirectory: string, sandboxWorkspace?: ReturnType<typeof sandboxWorkspaceContract>, suite?: FuzzSuiteContract, fuzzCase?: unknown, inputMountPathMap: readonly InputMountPathMapping[] = [], signal?: AbortSignal): Promise<ExecutionResult> {
  const startedAt = new Date().toISOString()
  const workloadJson = commandArgValue(args, "workload-json")
  if (!workloadJson) {
    throw new Error("wordpress.run-workload requires workload-json=<json> for JSON workload execution")
  }
  const workload = parseCommandJsonObject(workloadJson, "workload-json")
  const workloadAlias = recipeWorkloadInputAlias(workload)
  const steps = [...workflowStepsFromWorkloadPhase(workload.before, workload, suite, fuzzCase, inputMountPathMap), ...workflowStepsFromWorkloadPhase(workload.steps, workload, suite, fuzzCase, inputMountPathMap), ...workflowStepsFromWorkloadPhase(workload.after, workload, suite, fuzzCase, inputMountPathMap)]
  const executions: ExecutionResult[] = []
  for (const [index, step] of steps.entries()) {
    const execution = step.command === "wordpress.collect-workload-result"
      ? executeRecipeCollectWorkloadResult(step, executions, startedAt, workloadAlias)
      : await executeRecipeWorkflowStep(runtime, { phase: "steps", index, step }, recipeDirectory, sandboxWorkspace, undefined, undefined, inputMountPathMap, undefined, signal)
    executions.push(execution)
    if (execution.exitCode !== 0 && !step.allowFailure && !step.advisory) {
      break
    }
  }
  const failed = executions.find((execution) => execution.exitCode !== 0)
  const artifacts = recipeWorkloadExecutionArtifacts(executions)
  const incompleteResults = recipeIncompleteWorkloadResults(executions)
  if (workloadAlias && !artifacts[workloadAlias]) {
    const aliasPayloads = dedupeRecipeArtifactPayloads(executions.flatMap(recipeAllWorkloadArtifactPayloadsFromExecution))
    if (aliasPayloads.length === 1) artifacts[workloadAlias] = aliasPayloads[0]!.payload
  }
  const payload = stripUndefined({ schema: "wp-codebox/wordpress-workload-run-result/v1", steps: executions.length, exitCode: failed?.exitCode ?? 0, artifacts: Object.keys(artifacts).length > 0 ? artifacts : undefined, incompleteResults: incompleteResults.length > 0 ? incompleteResults : undefined })
  return {
    id: `wordpress-run-workload:${startedAt}`,
    command: "wordpress.run-workload",
    args,
    exitCode: failed?.exitCode ?? 0,
    stdout: `${JSON.stringify(payload)}\n`,
    stderr: failed?.stderr ?? "",
    result: { schema: "wp-codebox/runtime-command-result/v1", status: failed ? "error" : "ok", json: payload },
    startedAt,
    finishedAt: executions.at(-1)?.finishedAt ?? new Date().toISOString(),
    artifactRefs: executions.flatMap((execution) => [...(execution.artifactRefs ?? []), ...recipeWorkloadResultArtifactRefs(execution)]),
  }
}

function recipeIncompleteWorkloadResults(executions: ExecutionResult[]): Array<{ schema: string; status: "incomplete"; budgetExhausted?: string }> {
  const results = executions.flatMap((execution) => incompleteResultSummaries(isRecord(execution.result?.json) ? execution.result.json : parseJsonObject(execution.stdout)))
  return results.filter((result, index) => results.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(result)) === index)
}

function incompleteResultSummaries(value: unknown): Array<{ schema: string; status: "incomplete"; budgetExhausted?: string }> {
  if (!value || typeof value !== "object") return []
  if (Array.isArray(value)) return value.flatMap(incompleteResultSummaries)
  const record = value as Record<string, unknown>
  const summary = isRecord(record.summary) ? record.summary : undefined
  const current = typeof record.schema === "string" && record.status === "incomplete"
    ? [{ schema: record.schema, status: "incomplete" as const, budgetExhausted: typeof record.budgetExhausted === "string" ? record.budgetExhausted : typeof summary?.budgetExhausted === "string" ? summary.budgetExhausted : undefined }]
    : []
  return [...current, ...Object.values(record).flatMap(incompleteResultSummaries)]
}

export function executeRecipeCollectWorkloadResult(step: WorkspaceRecipe["workflow"]["steps"][number], priorExecutions: ExecutionResult[], startedAt: string, workloadAlias?: string): ExecutionResult {
  const args = commandArgs(step.args ?? [])
  const artifact = args.artifact ?? args.name ?? ""
  const expectedSchema = args.schema
  const command = args.command ?? ""
  const status = args.status ?? ""
  const matchedExecutions = priorExecutions.filter((execution) => {
    if (command && execution.command !== command) return false
    if (status && (execution.exitCode === 0 ? "passed" : "failed") !== status) return false
    if (!artifact) return true
    return recipeExecutionMatchesArtifact(execution, artifact) || Boolean(workloadAlias && artifactNameMatches(workloadAlias, artifact) && recipeAllWorkloadArtifactPayloadsFromExecution(execution).length === 1)
  })
  let payloads = dedupeRecipeArtifactPayloads(matchedExecutions.flatMap((execution) => recipeWorkloadArtifactPayloads(execution, artifact, expectedSchema)))
  if (payloads.length === 0 && workloadAlias && artifactNameMatches(workloadAlias, artifact)) {
    payloads = dedupeRecipeArtifactPayloads(matchedExecutions.flatMap((execution) => recipeAllWorkloadArtifactPayloadsFromExecution(execution).filter(({ payload }) => !expectedSchema || payload.schema === expectedSchema).map(({ payload }) => ({ name: artifact, payload }))))
  }
  const missing = artifact && (matchedExecutions.length === 0 || payloads.length === 0)
  const ambiguous = payloads.length > 1
  const diagnostic = missing
    ? { severity: "error", code: "wp_codebox_workload_result_artifact_missing", message: "Requested workload result artifact was not found or had no typed payload.", metadata: stripUndefined({ artifact: artifact || undefined, command: command || undefined, status: status || undefined, expectedSchema: expectedSchema || undefined }) }
    : ambiguous
      ? { severity: "error", code: "wp_codebox_workload_result_artifact_ambiguous", message: "Requested workload result artifact resolved multiple typed payloads; refine the collection query.", metadata: stripUndefined({ artifact: artifact || undefined, command: command || undefined, status: status || undefined, expectedSchema: expectedSchema || undefined, payloads: payloads.length }) }
      : undefined
  const payload = payloads[0]?.payload ?? {}
  const artifactName = artifact || payloads[0]?.name || "workload-result"
  return {
    id: `wordpress-collect-workload-result-${artifactName}`,
    command: "wordpress.collect-workload-result",
    args: step.args ?? [],
    exitCode: diagnostic ? 1 : 0,
    stdout: `${JSON.stringify(payload)}\n`,
    stderr: diagnostic?.message ?? "",
    result: { schema: "wp-codebox/runtime-command-result/v1", status: diagnostic ? "error" : "ok", json: payload, diagnostics: diagnostic ? [diagnostic] : undefined },
    startedAt,
    finishedAt: new Date().toISOString(),
    artifactRefs: payloads[0] ? [{ kind: payloads[0].name, id: artifactName, artifactId: artifactName, path: `files/workload-results/${safeArtifactSegment(artifactName)}.json` }] : [],
  }
}

function recipeExecutionMatchesArtifact(execution: ExecutionResult, artifact: string): boolean {
  if ((execution.artifactRefs ?? []).some((ref) => recipeArtifactRefMatchesName(ref, artifact))) return true
  return recipeWorkloadArtifactPayloads(execution, artifact).length > 0
    || Boolean(recipeWorkloadAlias(execution) && artifactNameMatches(recipeWorkloadAlias(execution)!, artifact) && recipeAllWorkloadArtifactPayloadsFromJson(isRecord(execution.result?.json) ? execution.result.json : parseJsonObject(execution.stdout)).length === 1)
}

function recipeArtifactRefMatchesName(ref: NonNullable<ExecutionResult["artifactRefs"]>[number], artifact: string): boolean {
  const record = ref as unknown as Record<string, unknown>
  return [record.name, record.artifact, record.artifactId, record.id, record.path].some((value) => typeof value === "string" && artifactNameMatches(value, artifact))
}

function recipeWorkloadArtifactPayloads(execution: ExecutionResult, artifact: string, expectedSchema?: string): Array<{ name: string; payload: Record<string, unknown> }> {
  const payloads: Array<{ name: string; payload: Record<string, unknown> }> = []
  const json = isRecord(execution.result?.json) ? execution.result.json : parseJsonObject(execution.stdout)
  for (const { profile } of recipeRestDbQueryProfilesFromJson(json)) {
    if (artifactNameMatches(artifact, "rest-db-query-profile") && (!expectedSchema || profile.schema === expectedSchema)) {
      payloads.push({ name: "rest-db-query-profile", payload: profile })
    }
  }
  collectRecipeArtifactPayloadsFromContainer(json, artifact, expectedSchema, payloads)
  const alias = recipeWorkloadAlias(execution)
  if (alias && artifactNameMatches(alias, artifact) && payloads.length === 0) {
    const aliasPayloads = recipeAllWorkloadArtifactPayloadsFromJson(json).filter(({ payload }) => !expectedSchema || payload.schema === expectedSchema)
    if (aliasPayloads.length === 1) payloads.push({ name: artifact, payload: aliasPayloads[0]!.payload })
  }
  for (const ref of execution.artifactRefs ?? []) {
    const record = ref as unknown as Record<string, unknown>
    const payload = isRecord(record.payload) ? record.payload : undefined
    if (payload && recipeArtifactRefMatchesName(ref, artifact) && (!expectedSchema || payload.schema === expectedSchema)) {
      payloads.push({ name: stringValue(record.name ?? record.artifact ?? record.artifactId ?? record.id) ?? artifact, payload })
    }
  }
  return payloads
}

function collectRecipeArtifactPayloadsFromContainer(container: Record<string, unknown> | undefined, artifact: string, expectedSchema: string | undefined, out: Array<{ name: string; payload: Record<string, unknown> }>): void {
  if (!container) return
  collectRecipeFuzzSuiteArtifactPayloads(container, artifact, expectedSchema, out)
  const artifacts = isRecord(container.artifacts) ? container.artifacts : undefined
  for (const [name, value] of Object.entries(artifacts ?? {})) {
    if (!artifactNameMatches(name, artifact)) continue
    const payload = isRecord(value) ? value : undefined
    if (payload && (!expectedSchema || payload.schema === expectedSchema)) out.push({ name, payload })
  }
  for (const scenario of Array.isArray(container.scenarios) ? container.scenarios : []) {
    if (isRecord(scenario)) collectRecipeArtifactPayloadsFromContainer(scenario, artifact, expectedSchema, out)
  }
  for (const nestedStep of Array.isArray(container.steps) ? container.steps : []) {
    if (isRecord(nestedStep)) collectRecipeArtifactPayloadsFromContainer(nestedStep, artifact, expectedSchema, out)
  }
}

function collectRecipeFuzzSuiteArtifactPayloads(result: Record<string, unknown>, artifact: string, expectedSchema: string | undefined, out: Array<{ name: string; payload: Record<string, unknown> }>): void {
  if (result.schema !== "wp-codebox/fuzz-suite-result/v1" || (expectedSchema && result.schema !== expectedSchema)) return
  const add = (name: string) => {
    if (!artifact || artifactNameMatches(name, artifact)) out.push({ name, payload: result })
  }

  // Keep the normalized result envelope intact; consumers receive real fuzz evidence, not a lossy wrapper.
  add("wp-codebox-fuzz-suite-result")
  add("result-envelope")
  if (Array.isArray(result.cases)) add("case-log")
  if (isRecord(result.coverageSummary)) add("coverage-summary")
  if (Array.isArray(result.cases) && result.cases.some((fuzzCase) => isRecord(fuzzCase) && isRecord(fuzzCase.metadata) && isRecord(fuzzCase.metadata.replay))) {
    add("replay-data")
  }
}

function recipeRestDbQueryProfilesFromJson(json: Record<string, unknown> | undefined): Array<{ profile: Record<string, unknown> }> {
  const profiles: Array<{ profile: Record<string, unknown> }> = []
  if (!json) return profiles
  if (json.schema === "wp-codebox/wordpress-rest-db-query-profile/v1") profiles.push({ profile: json })
  if (json.schema === "wp-codebox/bench-results/v1") {
    for (const scenario of Array.isArray(json.scenarios) ? json.scenarios : []) {
      const scenarioRecord = isRecord(scenario) ? scenario : undefined
      const artifacts = isRecord(scenarioRecord?.artifacts) ? scenarioRecord.artifacts : undefined
      const profile = isRecord(artifacts?.["rest-db-query-profile"]) ? artifacts["rest-db-query-profile"] : undefined
      if (profile?.schema === "wp-codebox/wordpress-rest-db-query-profile/v1") profiles.push({ profile })
    }
  }
  for (const step of Array.isArray(json.steps) ? json.steps : []) {
    const stepRecord = isRecord(step) ? step : undefined
    const artifacts = isRecord(stepRecord?.artifacts) ? stepRecord.artifacts : undefined
    const profile = isRecord(artifacts?.["rest-db-query-profile"]) ? artifacts["rest-db-query-profile"] : undefined
    if (profile?.schema === "wp-codebox/wordpress-rest-db-query-profile/v1") profiles.push({ profile })
  }
  if (json.schema === "wp-codebox/recipe-run/v1") {
    profiles.push(...recipeRestDbQueryProfilesFromJson(isRecord(json.benchResults) ? json.benchResults : undefined))
  }
  return profiles
}

function recipeWorkloadExecutionArtifacts(executions: ExecutionResult[]): Record<string, Record<string, unknown>> {
  const artifacts: Record<string, Record<string, unknown>> = {}
  let restDbQueryProfileIndex = 0
  const seen = new Set<string>()
  for (const execution of executions) {
    const json = isRecord(execution.result?.json) ? execution.result.json : parseJsonObject(execution.stdout)
    for (const { profile } of recipeRestDbQueryProfilesFromJson(json)) {
      const fingerprint = JSON.stringify(profile)
      if (seen.has(fingerprint)) continue
      seen.add(fingerprint)
      const name = restDbQueryProfileIndex === 0 ? "rest-db-query-profile" : `rest-db-query-profile-${restDbQueryProfileIndex + 1}`
      artifacts[name] = profile
      restDbQueryProfileIndex += 1
    }
    for (const { name, payload } of recipeAllWorkloadArtifactPayloadsFromJson(json)) {
      const fingerprint = `${name}:${JSON.stringify(payload)}`
      if (seen.has(fingerprint)) continue
      seen.add(fingerprint)
      artifacts[name] = payload
      const alias = recipeWorkloadAlias(execution)
      if (alias) artifacts[alias] = payload
    }
  }
  return artifacts
}

function recipeWorkloadAlias(execution: ExecutionResult): string | undefined {
  const args = commandArgs(execution.args ?? [])
  const workload = parseJsonObject(args["workload-json"])
  const metadata = isRecord(workload?.metadata) ? workload.metadata : undefined
  return stringValue(metadata?.source_entry ?? metadata?.sourceEntry ?? metadata?.workload)
}

function recipeAllWorkloadArtifactPayloadsFromJson(json: Record<string, unknown> | undefined): Array<{ name: string; payload: Record<string, unknown> }> {
  const payloads: Array<{ name: string; payload: Record<string, unknown> }> = []
  collectRecipeArtifactPayloadsFromContainer(json, "", undefined, payloads)
  return payloads.filter(({ payload }) => typeof payload.schema === "string")
}

function recipeAllWorkloadArtifactPayloadsFromExecution(execution: ExecutionResult): Array<{ name: string; payload: Record<string, unknown> }> {
  return recipeAllWorkloadArtifactPayloadsFromJson(isRecord(execution.result?.json) ? execution.result.json : parseJsonObject(execution.stdout))
}

function recipeWorkloadInputAlias(workload: Record<string, unknown>): string | undefined {
  const metadata = isRecord(workload.metadata) ? workload.metadata : undefined
  return stringValue(metadata?.source_entry ?? metadata?.sourceEntry ?? metadata?.workload)
}

function recipeWorkloadResultArtifactRefs(execution: ExecutionResult): NonNullable<ExecutionResult["artifactRefs"]> {
  const json = isRecord(execution.result?.json) ? execution.result.json : parseJsonObject(execution.stdout)
  if (!json) return []
  return Object.entries(isRecord(json.artifacts) ? json.artifacts : {})
    .filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]))
    .map(([name, payload]) => ({ id: name, artifactId: name, kind: name, path: `files/workload-results/${safeArtifactSegment(name)}.json`, payload }))
}

function dedupeRecipeArtifactPayloads(payloads: Array<{ name: string; payload: Record<string, unknown> }>): Array<{ name: string; payload: Record<string, unknown> }> {
  const seen = new Set<string>()
  const out: Array<{ name: string; payload: Record<string, unknown> }> = []
  for (const payload of payloads) {
    const key = `${payload.name}:${JSON.stringify(payload.payload)}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(payload)
  }
  return out
}

function commandArgs(args: string[]): Record<string, string> {
  return Object.fromEntries(args.map((arg) => {
    const index = arg.indexOf("=")
    return index === -1 ? [arg, ""] : [arg.slice(0, index), arg.slice(index + 1)]
  }))
}

function artifactNameMatches(candidate: string, artifact: string): boolean {
  const normalizedCandidate = candidate.toLowerCase().replace(/[_-]/g, "")
  const normalizedArtifact = artifact.toLowerCase().replace(/[_-]/g, "")
  return candidate === artifact || candidate.replace(/_/g, "-") === artifact.replace(/_/g, "-") || normalizedCandidate.includes(normalizedArtifact)
}

function safeArtifactSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "artifact"
}

async function executeRunFuzzSuiteRecipeCommand(runtime: Runtime, args: string[], recipeDirectory: string, sandboxWorkspace?: ReturnType<typeof sandboxWorkspaceContract>, inputMountPathMap: readonly InputMountPathMapping[] = [], signal?: AbortSignal): Promise<ExecutionResult> {
  const startedAt = new Date().toISOString()
  const suite = await fuzzSuiteFromRecipeCommandArgs(args, recipeDirectory)
  const result = await runFuzzSuite(suite, {
    runnerCapabilities: RUNTIME_BACKED_FUZZ_SUITE_RUNNER_CAPABILITIES,
    executor: async (spec) => executeRecipeWorkflowStep(runtime, { phase: "steps", index: 0, step: workflowStepFromExecutionSpec(spec) }, recipeDirectory, sandboxWorkspace, undefined, undefined, inputMountPathMap, undefined, signal),
    resetExecutor: createWordPressFuzzSuiteResetExecutor(recipeRuntimeFuzzSuiteResetEpisode(runtime, recipeDirectory, sandboxWorkspace, inputMountPathMap, signal)),
    runtimeWorkloadExecutor: async ({ suite, workload, case: fuzzCase }) => {
      const workloadJson = JSON.stringify(workload)
      const execution = await executeWordPressRunWorkloadJsonRecipeCommand(runtime, [`workload-json=${workloadJson}`], recipeDirectory, sandboxWorkspace, suite, fuzzCase, inputMountPathMap, signal)
      const parsed = parseCommandJsonObject(execution.stdout, "wordpress.run-workload stdout")
      return {
        ...execution,
        id: `wordpress-run-workload-${fuzzCase.id}`,
        args: [`steps=${parsed.steps ?? 0}`],
        stdout: `${JSON.stringify({ ...parsed, caseId: fuzzCase.id })}\n`,
        result: { schema: "wp-codebox/runtime-command-result/v1", status: execution.exitCode === 0 ? "ok" : "error", json: { ...parsed, caseId: fuzzCase.id } },
      }
    },
    metadata: { public_recipe_command: "wp-codebox/run-fuzz-suite" },
  })
  const stdout = `${JSON.stringify(result, null, 2)}\n`
  const failed = result.status === "failed" || result.status === "error"
  return {
    id: `wp-codebox-run-fuzz-suite:${startedAt}`,
    command: "wp-codebox/run-fuzz-suite",
    args,
    exitCode: failed ? 1 : 0,
    stdout,
    stderr: failed ? result.diagnostics.map((diagnostic) => diagnostic.message).filter(Boolean).join("\n") : "",
    startedAt,
    finishedAt: new Date().toISOString(),
    artifactRefs: result.artifactRefs?.map((ref) => ({ id: ref.path, path: ref.path, kind: ref.kind, digest: ref.sha256 ? { algorithm: "sha256", value: ref.sha256 } : undefined, metadata: ref.metadata })) ?? [],
  }
}

function recipeRuntimeFuzzSuiteResetEpisode(runtime: Runtime, recipeDirectory: string, sandboxWorkspace: ReturnType<typeof sandboxWorkspaceContract> | undefined, inputMountPathMap: readonly InputMountPathMapping[], signal?: AbortSignal) {
  let index = 0
  return {
    async step(action: { command: string; args?: string[]; metadata?: Record<string, unknown> }) {
      index += 1
      const id = `recipe-fuzz-reset-${index}`
      const execution = await executeRecipeWorkflowStep(runtime, {
        phase: "steps",
        index,
        step: { command: action.command, args: action.args, metadata: action.metadata },
      }, recipeDirectory, sandboxWorkspace, undefined, undefined, inputMountPathMap, undefined, signal)
      return {
        id,
        index,
        action: {
          schema: "wp-codebox/runtime-episode-action/v1" as const,
          id,
          kind: "command" as const,
          command: action.command,
          args: action.args ?? [],
          metadata: action.metadata,
          digest: { algorithm: "sha256" as const, value: createHash("sha256").update(JSON.stringify(action)).digest("hex") },
        },
        actionRef: { kind: "action", id },
        execution,
        executionRef: { kind: "execution", id: execution.id },
      }
    },
  }
}

async function fuzzSuiteFromRecipeCommandArgs(args: string[], recipeDirectory: string): Promise<FuzzSuiteContract> {
  const inline = commandArgValue(args, "input-json") ?? commandArgValue(args, "suite-json")
  if (inline) {
    return parseCommandJson(inline, "input-json") as FuzzSuiteContract
  }
  const file = commandArgValue(args, "input-file") ?? commandArgValue(args, "suite-file") ?? commandArgValue(args, "suite")
  if (file) {
    return parseCommandJson(await readFile(resolve(recipeDirectory, file), "utf8"), file) as FuzzSuiteContract
  }
  throw new Error("wp-codebox/run-fuzz-suite requires input-json=<suite> or input-file=<path>")
}

function workflowStepsFromWorkloadPhase(value: unknown, workload: Record<string, unknown>, suite: FuzzSuiteContract | undefined, fuzzCase: unknown, inputMountPathMap: readonly InputMountPathMapping[] = []): WorkspaceRecipe["workflow"]["steps"] {
  if (!Array.isArray(value)) {
    return []
  }
  const commandSteps = value.flatMap((step) => {
    if (!step || typeof step !== "object" || Array.isArray(step)) {
      return []
    }
    const record = step as Record<string, unknown>
    const command = record.command
    if (typeof command !== "string" || command.trim() === "") {
      return []
    }
    const args = Array.isArray(record.args) ? rewriteInputMountPathArgs(record.args.map(String), inputMountPathMap) : undefined
    const parsedArgs = stepArgMap(args)
    if (command === "wordpress.run-workload" && parsedArgs.type?.toLowerCase() === "php") {
      const path = parsedArgs.path ?? parsedArgs.file ?? ""
      return [{ command: "wordpress.run-php", args: [`code=${wordpressWorkloadPhpWrapper(path, workload, parsedArgs)}`] }]
    }
    return [{ ...(step as WorkspaceRecipe["workflow"]["steps"][number]), ...(args ? { args } : {}) }]
  })
  if (commandSteps.length > 0) {
    return commandSteps
  }
  if (value.some((step) => step && typeof step === "object" && !Array.isArray(step) && typeof (step as Record<string, unknown>).type === "string")) {
    return [{
      command: "wordpress.bench",
      args: [
        `plugin-slug=${runtimeRequirementPluginSlug(suite) ?? typedWorkloadPluginSlug(workload, fuzzCase)}`,
        `workloads-json=${JSON.stringify([{ id: typeof workload.id === "string" ? workload.id : "wordpress-workload", run: value, metadata: objectValue(workload.metadata) }])}`,
      ],
    }]
  }
  return []
}

function wordpressWorkloadPhpWrapper(path: string, workload: Record<string, unknown>, args: Record<string, string>): string {
  const encodedInput = Buffer.from(JSON.stringify(workload), "utf8").toString("base64")
  const encodedArgs = Buffer.from(JSON.stringify(args), "utf8").toString("base64")
  return `$__wp_codebox_workload_input = json_decode(base64_decode('${encodedInput}'), true);\n$__wp_codebox_workload_args = json_decode(base64_decode('${encodedArgs}'), true);\n$__wp_codebox_workload_callable = require ${JSON.stringify(path)};\nif (!is_callable($__wp_codebox_workload_callable)) { throw new RuntimeException('PHP workload file must return a callable.'); }\n$__wp_codebox_workload_result = $__wp_codebox_workload_callable(is_array($__wp_codebox_workload_input) ? $__wp_codebox_workload_input : array(), is_array($__wp_codebox_workload_args) ? $__wp_codebox_workload_args : array());\nif (is_array($__wp_codebox_workload_result) || is_object($__wp_codebox_workload_result)) { echo json_encode($__wp_codebox_workload_result, JSON_UNESCAPED_SLASHES) . "\\n"; } elseif (false === $__wp_codebox_workload_result) { exit(1); }`
}

function stepArgMap(args: string[] | undefined): Record<string, string> {
  const parsed: Record<string, string> = {}
  for (const arg of args ?? []) {
    const [key, value = ""] = String(arg).split(/=(.*)/s, 2)
    if (key) parsed[key] = value
  }
  return parsed
}

function runtimeRequirementPluginSlug(suite: FuzzSuiteContract | undefined): string | undefined {
  const requirements = objectValue(objectValue(suite?.metadata)?.runtime_requirements)
  for (const key of ["extra_plugins", "component_contracts"]) {
    for (const plugin of arrayValue(requirements?.[key])) {
      const slug = objectValue(plugin)?.slug
      if (typeof slug === "string" && slug.trim()) return slug
    }
  }
  return undefined
}

function typedWorkloadPluginSlug(workload: Record<string, unknown>, fuzzCase: unknown): string {
  const caseRecord = objectValue(fuzzCase)
  const explicit = stringValue(workload.pluginSlug) ?? stringValue(workload.plugin_slug) ?? stringValue(objectValue(workload.metadata)?.plugin_slug) ?? stringValue(objectValue(caseRecord?.metadata)?.plugin_slug)
  if (explicit) return explicit
  const metadata = objectValue(caseRecord?.metadata)
  const caseMetadata = objectValue(metadata?.caseMetadata) ?? objectValue(metadata?.case_metadata) ?? metadata
  const activation = stringValue(objectValue(objectValue(objectValue(caseMetadata?.intent)?.plugin)?.activation)?.entrypoint) ?? stringValue(objectValue(objectValue(caseMetadata?.intent)?.plugin)?.activation)
  return activation?.split("/")[0]?.trim() || "wp-codebox-workload"
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function workflowStepFromExecutionSpec(spec: { command: string; args?: string[]; diagnostics?: WorkspaceRecipe["workflow"]["steps"][number]["diagnostics"] }): WorkspaceRecipe["workflow"]["steps"][number] {
  return {
    command: spec.command,
    args: spec.args,
    diagnostics: spec.diagnostics,
  }
}

async function executeRuntimeCheckpointRecipeCommand(runtime: Runtime, command: string, args: string[]): Promise<ExecutionResult> {
  const startedAt = new Date().toISOString()
  const operation = runtimeCheckpointOperation(command)
  const finish = (exitCode: number, payload: RuntimeCheckpointResult | RuntimeCheckpointFailureDiagnostic): ExecutionResult => ({
    id: `${command}:${startedAt}`,
    command,
    args,
    exitCode,
    stdout: `${JSON.stringify({ command, ...payload }, null, 2)}\n`,
    stderr: exitCode === 0 ? "" : "message" in payload ? payload.message : "Runtime checkpoint command failed.",
    startedAt,
    finishedAt: new Date().toISOString(),
  })

  try {
    if (operation === "list") {
      if (!runtime.listCheckpoints) {
        return finish(1, runtimeCheckpointUnsupportedDiagnostic(operation, await runtime.info()))
      }
      return finish(0, await runtime.listCheckpoints())
    }

    const name = commandArgValue(args, "name")?.trim()
    if (!name) {
      return finish(1, runtimeCheckpointFailure(operation, "invalid-request", "runtime-checkpoint-name-required", "Runtime checkpoint command requires name=<checkpoint>."))
    }

    if (operation === "create") {
      if (!runtime.createCheckpoint) {
        return finish(1, runtimeCheckpointUnsupportedDiagnostic(operation, await runtime.info(), name))
      }
      return finish(0, await runtime.createCheckpoint({
        name,
        metadata: parseCommandJsonObject(commandArgValue(args, "metadata-json"), "metadata-json"),
        snapshotOptions: snapshotOptionsFromCheckpointArgs(args),
      }))
    }

    if (!runtime.restoreCheckpoint) {
      return finish(1, runtimeCheckpointUnsupportedDiagnostic(operation, await runtime.info(), name))
    }
    return finish(0, await runtime.restoreCheckpoint(name))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return finish(1, runtimeCheckpointFailure(operation, "failed", "runtime-checkpoint-operation-failed", message))
  }
}

function isRuntimeCheckpointRecipeCommand(command: string): boolean {
  return command === "wp-codebox.checkpoint-create" || command === "wp-codebox.checkpoint-restore" || command === "wp-codebox.checkpoint-list"
}

function runtimeCheckpointOperation(command: string): RuntimeCheckpointOperation {
  if (command === "wp-codebox.checkpoint-create") {
    return "create"
  }
  if (command === "wp-codebox.checkpoint-restore") {
    return "restore"
  }
  return "list"
}

function runtimeCheckpointFailure(operation: RuntimeCheckpointOperation, status: RuntimeCheckpointFailureDiagnostic["status"], code: string, message: string): RuntimeCheckpointFailureDiagnostic {
  return {
    schema: "wp-codebox/runtime-checkpoint-failure/v1",
    status,
    operation,
    code,
    message,
    supported: false,
  }
}

function snapshotOptionsFromCheckpointArgs(args: string[]): Record<string, string[]> {
  return {
    excludedWpContentPaths: commaListArg(args, "snapshot-exclude-wp-content"),
    includedWpContentPaths: commaListArg(args, "snapshot-include-wp-content"),
    includedDatabaseTables: commaListArg(args, "snapshot-database-tables"),
    excludedDatabaseTables: commaListArg(args, "snapshot-exclude-database-tables"),
    includedOptionNames: commaListArg(args, "snapshot-option-names"),
    includedPostTypes: commaListArg(args, "snapshot-post-types"),
  }
}

function commaListArg(args: string[], name: string): string[] {
  return (commandArgValue(args, name) ?? "").split(",").map((entry) => entry.trim()).filter(Boolean)
}

export async function runRecipeProbes(recipe: WorkspaceRecipe, recipeDirectory: string, runtime: Runtime, executions: RecipeExecutionResult[]): Promise<RecipeRunProbe[]> {
  const results: RecipeRunProbe[] = []
  for (const [index, probe] of (recipe.probes ?? []).entries()) {
    const execution = await executeRecipeProbe(runtime, probe, recipeDirectory, index)
    executions.push(execution)
    const parsedJson = parseProbeJson(execution.stdout)
    const failedJsonExpectation = probe.expectJson === true && parsedJson === undefined
    results.push(stripUndefined({
      schema: "wp-codebox/recipe-probe-result/v1" as const,
      index,
      name: probe.name,
      status: execution.exitCode === 0 && !failedJsonExpectation ? "passed" as const : "failed" as const,
      command: execution.command,
      args: execution.args,
      exitCode: execution.exitCode,
      stdout: execution.stdout,
      stderr: execution.stderr,
      parsedJson,
      allowFailure: probe.allowFailure === true,
      metadata: probe.metadata,
    }))
  }
  return results
}

export async function runDistributionStartupProbes(recipe: WorkspaceRecipe, runtime: Runtime, executions: RecipeExecutionResult[]): Promise<RecipeRunDistributionStartupProbe[]> {
  const results: RecipeRunDistributionStartupProbe[] = []
  for (const [index, probe] of (recipe.distribution?.startupProbes ?? []).entries()) {
    const execution = await executeDistributionStartupProbe(runtime, probe, index).catch((error) => {
      if (probe.type === "http" && distributionStartupHttpProbeCommandUnavailable(error)) {
        return undefined
      }
      throw error
    })
    if (!execution) {
      results.push(distributionStartupHttpProbeSkipped(probe, index))
      continue
    }
    executions.push(execution)
    results.push(stripUndefined({
      schema: "wp-codebox/distribution-startup-probe-result/v1" as const,
      index,
      name: probe.name,
      type: probe.type,
      status: execution.exitCode === 0 ? "passed" as const : "failed" as const,
      command: execution.command,
      args: execution.args,
      exitCode: execution.exitCode,
      stdout: execution.stdout,
      stderr: execution.stderr,
      metadata: probe.metadata,
    }))
  }
  return results
}

export async function runDistributionSetupArtifacts(recipe: WorkspaceRecipe, recipeDirectory: string, runtime: Runtime, executions: RecipeExecutionResult[]): Promise<RecipeRunDistributionSetupArtifact[]> {
  const results: RecipeRunDistributionSetupArtifact[] = []
  for (const [index, artifact] of (recipe.distribution?.setupArtifacts ?? []).entries()) {
    const source = resolve(recipeDirectory, artifact.source)
    const sql = await readFile(source, "utf8")
    const execution = await executeDistributionSetupArtifact(runtime, artifact, sql, index)
    executions.push(execution)
    const applied = parseDistributionSetupArtifactResult(execution.stdout)
    results.push(stripUndefined({
      schema: "wp-codebox/distribution-setup-artifact-result/v1" as const,
      index,
      name: artifact.name,
      type: artifact.type,
      source,
      action: "applied" as const,
      command: execution.command,
      args: execution.args,
      exitCode: execution.exitCode,
      stdout: execution.stdout,
      stderr: execution.stderr,
      identity: {
        name: artifact.name,
        sourceSha256: createHash("sha256").update(sql).digest("hex"),
      },
      counts: applied.counts,
      metadata: artifact.metadata,
    }))
  }
  return results
}

async function executeDistributionSetupArtifact(runtime: Runtime, artifact: WorkspaceRecipeDistributionSetupArtifact, sql: string, index: number): Promise<RecipeExecutionResult> {
  try {
    const execution = await runtime.execute({
      command: "wordpress.run-php",
      args: [`code=${distributionSetupSqlArtifactCode(artifact, sql)}`],
    })
    return withRecipeExecutionPhase(execution, "setup", index, `distribution.setupArtifact:${artifact.name}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Distribution setup artifact "${artifact.name}" failed before producing a result: ${message}`, { cause: error })
  }
}

export function distributionStartupProbeFailure(probes: RecipeRunDistributionStartupProbe[]): Error | undefined {
  const failed = probes.find((probe) => probe.status === "failed")
  return failed ? new Error(`Distribution startup probe "${failed.name}" failed with exit code ${failed.exitCode ?? "unknown"}.`) : undefined
}

async function executeRecipeProbe(runtime: Runtime, probe: WorkspaceRecipeProbe, recipeDirectory: string, index: number): Promise<RecipeExecutionResult> {
  try {
    const execution = await runtime.execute(await recipeExecutionSpec(probe.step, recipeDirectory))
    return withRecipeExecutionPhase(execution, "setup", index, `recipe.probe:${probe.name}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Recipe probe "${probe.name}" failed before producing a result: ${message}`, { cause: error })
  }
}

async function executeDistributionStartupProbe(runtime: Runtime, probe: WorkspaceRecipeDistributionStartupProbe, index: number): Promise<RecipeExecutionResult> {
  const spec = distributionStartupProbeExecutionSpec(probe)
  try {
    const execution = await runtime.execute(spec)
    return withRecipeExecutionPhase(execution, "setup", index, `distribution.startupProbe:${probe.name}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Distribution startup probe "${probe.name}" failed before producing a result: ${message}`, { cause: error })
  }
}

function distributionStartupProbeExecutionSpec(probe: WorkspaceRecipeDistributionStartupProbe): { command: string; args: string[] } {
  if (probe.type === "wp-cli") {
    return { command: "wordpress.wp-cli", args: [`command=${probe.command ?? ""}`] }
  }
  if (probe.type === "php") {
    return { command: "wordpress.run-php", args: [`code=${probe.code ?? ""}`] }
  }
  if (probe.type === "http") {
    return { command: "wordpress.http-request", args: [`url=${probe.url ?? ""}`, probe.expectStatus === undefined ? undefined : `expect-status=${probe.expectStatus}`].filter((arg): arg is string => Boolean(arg)) }
  }
  return { command: "wordpress.browser-probe", args: [`url=${probe.url ?? ""}`] }
}

function parseDistributionSetupArtifactResult(stdout: string): { counts: Record<string, number> } {
  const parsed = JSON.parse(stdout.trim() || "{}") as { counts?: Record<string, unknown> }
  const counts: Record<string, number> = {}
  for (const [key, value] of Object.entries(parsed.counts ?? {})) {
    if (typeof value === "number") {
      counts[key] = value
    }
  }
  return { counts }
}

function distributionSetupSqlArtifactCode(artifact: WorkspaceRecipeDistributionSetupArtifact, sql: string): string {
  const encodedName = JSON.stringify(artifact.name)
  const encodedSql = JSON.stringify(sql)
  return `
global $wpdb;
$artifact_name = ${encodedName};
$sql = ${encodedSql};
$counts = array('statements' => 0);
$statements = preg_split('/;\s*(?:\r?\n|$)/', $sql);
foreach ($statements as $statement) {
    $statement = trim($statement);
    if ('' === $statement || str_starts_with($statement, '--')) {
        continue;
    }
    $result = $wpdb->query($statement);
    if (false === $result) {
        throw new RuntimeException('Distribution setup artifact failed for ' . $artifact_name . ': ' . $wpdb->last_error);
    }
    $counts['statements']++;
}
echo wp_json_encode(array('counts' => $counts));`
}

function distributionStartupHttpProbeSkipped(probe: WorkspaceRecipeDistributionStartupProbe, index: number): RecipeRunDistributionStartupProbe {
  return stripUndefined({
    schema: "wp-codebox/distribution-startup-probe-result/v1" as const,
    index,
    name: probe.name,
    type: probe.type,
    status: "skipped" as const,
    reason: "Distribution startup http probes require a generic HTTP runtime command, but this runtime does not expose wordpress.http-request.",
    missingCommand: "wordpress.http-request",
    url: probe.url,
    expectStatus: probe.expectStatus,
    availableCommands: ["wordpress.rest-request", "wordpress.browser-probe"],
    metadata: probe.metadata,
  })
}

function distributionStartupHttpProbeCommandUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes("wordpress.http-request") && (message.includes("No Playground command handler") || message.includes("unavailable") || message.includes("not allowed"))
}

function parseProbeJson(stdout: string): unknown | undefined {
  const trimmed = stdout.trim()
  if (!trimmed) {
    return undefined
  }
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(raw)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}
