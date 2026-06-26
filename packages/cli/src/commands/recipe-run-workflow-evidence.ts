import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { commandArgValue, parseCommandJson, parseCommandJsonObject, RUNTIME_BACKED_FUZZ_SUITE_RUNNER_CAPABILITIES, runFuzzSuite, runtimeCheckpointUnsupportedDiagnostic, type ArtifactBundle, type ArtifactManifestFile, type ExecutionResult, type FuzzSuiteContract, type Runtime, type RuntimeCheckpointFailureDiagnostic, type RuntimeCheckpointOperation, type RuntimeCheckpointResult, type WorkspaceRecipe, type WorkspaceRecipeDistributionSetupArtifact, type WorkspaceRecipeDistributionStartupProbe, type WorkspaceRecipeProbe } from "@automattic/wp-codebox-core"
import { stripUndefined } from "@automattic/wp-codebox-core/internals"
import { recipeExecutionSpec, sandboxWorkspaceContract } from "../agent-sandbox.js"
import { executeAgentFanoutFromArgs } from "../agent-fanout.js"
import { recipeWorkflowSteps, type RecipeWorkflowPhase } from "../recipe-validation.js"
import { artifactManifestFilesByPath } from "./recipe-run-benchmark-artifacts.js"
import { serializeRecipeRunError } from "./recipe-run-output.js"
import type { RecipeAdvisoryFailure, RecipeBrowserEvidence, RecipeBrowserEvidenceFileRef, RecipeExecutionResult, RecipeRunDistributionSetupArtifact, RecipeRunDistributionStartupProbe, RecipeRunOptions, RecipeRunProbe } from "./recipe-run-types.js"

export function withRecipeExecutionPhase(execution: ExecutionResult, recipePhase: RecipeWorkflowPhase, recipeStepIndex: number, recipeCommand?: string): RecipeExecutionResult {
  return {
    ...execution,
    recipePhase,
    recipeStepIndex,
    recipeCommand,
  }
}

export function recipeWorkflowStepIsAdvisory(step: WorkspaceRecipe["workflow"]["steps"][number]): boolean {
  return step.allowFailure === true || step.advisory === true
}

export function recipeAdvisoryFailure(workflowStep: ReturnType<typeof recipeWorkflowSteps>[number], error: unknown): RecipeAdvisoryFailure {
  return {
    schema: "wp-codebox/recipe-advisory-failure/v1",
    phase: workflowStep.phase,
    index: workflowStep.index,
    command: workflowStep.step.command,
    status: "failed",
    error: serializeRecipeRunError(error),
  }
}

export async function recipeBrowserEvidence(artifacts: ArtifactBundle, executions: RecipeExecutionResult[]): Promise<RecipeBrowserEvidence[]> {
  const manifestFiles = await artifactManifestFilesByPath(artifacts)
  return executions.flatMap((execution) => recipeBrowserEvidenceForExecution(execution, manifestFiles))
}

function recipeBrowserEvidenceForExecution(execution: RecipeExecutionResult, manifestFiles: Map<string, ArtifactManifestFile>): RecipeBrowserEvidence[] {
  const command = execution.recipeCommand ?? execution.command
  if (!recipeCommandProducesBrowserEvidence(command)) {
    return []
  }

  const parsed = parseJsonObject(execution.stdout)
  if (!parsed) {
    return []
  }

  if (Array.isArray(parsed.profiles)) {
    return parsed.profiles.flatMap((profile) => {
      const profileEvidence = recipeBrowserEvidenceFromParsedExecution(execution, command, profile, manifestFiles)
      return profileEvidence ? [profileEvidence] : []
    })
  }

  const evidence = recipeBrowserEvidenceFromParsedExecution(execution, command, parsed, manifestFiles)
  return evidence ? [evidence] : []
}

function recipeBrowserEvidenceFromParsedExecution(execution: RecipeExecutionResult, command: string, parsed: Record<string, unknown>, manifestFiles: Map<string, ArtifactManifestFile>): RecipeBrowserEvidence | undefined {
  const files = recipeBrowserEvidenceFiles(parsed.files, manifestFiles)
  const summaryFile = browserEvidenceFileRef(stringValue((parsed.files as Record<string, unknown> | undefined)?.summary), manifestFiles)
  if (Object.keys(files).length === 0 && !summaryFile) {
    return undefined
  }

  const summary = parsed.summary
  const summaryObject = isRecord(summary) ? summary : undefined
  return stripUndefined({
    schema: "wp-codebox/recipe-browser-evidence/v1",
    phase: execution.recipePhase,
    index: execution.recipeStepIndex,
    command,
    status: execution.exitCode === 0 ? "completed" : "failed",
    requestedUrl: stringValue(parsed.requestedUrl),
    finalUrl: stringValue(parsed.finalUrl ?? summaryObject?.finalUrl),
    summaryFile,
    files,
    summary,
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
  return command.startsWith("wordpress.browser-") || command === "wordpress.editor-canvas-probe" || command === "wordpress.html-capture"
}

export async function executeRecipeWorkflowStep(runtime: Runtime, workflowStep: ReturnType<typeof recipeWorkflowSteps>[number], recipeDirectory: string, sandboxWorkspace?: ReturnType<typeof sandboxWorkspaceContract>, artifactRoot?: string, options?: RecipeRunOptions): Promise<RecipeExecutionResult> {
  try {
    if (workflowStep.step.command === "wp-codebox.agent-fanout") {
      const startedAt = new Date().toISOString()
      const result = await executeAgentFanoutFromArgs(workflowStep.step.args ?? [], {
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
        ...withRecipeExecutionPhase({
          id: `agent-fanout-${workflowStep.index}`,
          command: workflowStep.step.command,
          args: workflowStep.step.args ?? [],
          exitCode: result.success ? 0 : 1,
          stdout: `${JSON.stringify(result, null, 2)}\n`,
          stderr: "",
          startedAt,
          finishedAt,
        }, workflowStep.phase, workflowStep.index, workflowStep.step.command),
        ...(workflowStep.fuzzCaseId ? { fuzzCaseId: workflowStep.fuzzCaseId } : {}),
        ...(workflowStep.fuzzCaseIndex !== undefined ? { fuzzCaseIndex: workflowStep.fuzzCaseIndex } : {}),
        ...(workflowStep.fuzzPhase ? { fuzzPhase: workflowStep.fuzzPhase } : {}),
        ...(workflowStep.fuzzStepIndex !== undefined ? { fuzzStepIndex: workflowStep.fuzzStepIndex } : {}),
      }
    }
    if (isRuntimeCheckpointRecipeCommand(workflowStep.step.command)) {
      return withRecipeExecutionPhase(await executeRuntimeCheckpointRecipeCommand(runtime, workflowStep.step.command, workflowStep.step.args ?? []), workflowStep.phase, workflowStep.index, workflowStep.step.command)
    }
    if (workflowStep.step.command === "wp-codebox/run-fuzz-suite") {
      return withRecipeExecutionPhase(await executeRunFuzzSuiteRecipeCommand(runtime, workflowStep.step.args ?? [], recipeDirectory, sandboxWorkspace), workflowStep.phase, workflowStep.index, workflowStep.step.command)
    }
    const execution = await runtime.execute(await recipeExecutionSpec(workflowStep.step, recipeDirectory, sandboxWorkspace))
    return {
      ...withRecipeExecutionPhase(execution, workflowStep.phase, workflowStep.index, workflowStep.step.command),
      ...(workflowStep.fuzzCaseId ? { fuzzCaseId: workflowStep.fuzzCaseId } : {}),
      ...(workflowStep.fuzzCaseIndex !== undefined ? { fuzzCaseIndex: workflowStep.fuzzCaseIndex } : {}),
      ...(workflowStep.fuzzPhase ? { fuzzPhase: workflowStep.fuzzPhase } : {}),
      ...(workflowStep.fuzzStepIndex !== undefined ? { fuzzStepIndex: workflowStep.fuzzStepIndex } : {}),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Recipe workflow ${workflowStep.phase}[${workflowStep.index}] failed: ${message}`, { cause: error })
  }
}

async function executeRunFuzzSuiteRecipeCommand(runtime: Runtime, args: string[], recipeDirectory: string, sandboxWorkspace?: ReturnType<typeof sandboxWorkspaceContract>): Promise<ExecutionResult> {
  const startedAt = new Date().toISOString()
  const suite = await fuzzSuiteFromRecipeCommandArgs(args, recipeDirectory)
  const result = await runFuzzSuite(suite, {
    runnerCapabilities: RUNTIME_BACKED_FUZZ_SUITE_RUNNER_CAPABILITIES,
    executor: async (spec) => runtime.execute(await recipeExecutionSpec(workflowStepFromExecutionSpec(spec), recipeDirectory, sandboxWorkspace)),
    runtimeWorkloadExecutor: async ({ workload, case: fuzzCase }) => {
      const steps = [...workflowStepsFromWorkloadPhase(workload.before), ...workflowStepsFromWorkloadPhase(workload.steps), ...workflowStepsFromWorkloadPhase(workload.after)]
      const workloadStartedAt = new Date().toISOString()
      const executions: ExecutionResult[] = []
      for (const step of steps) {
        const execution = await runtime.execute(await recipeExecutionSpec(step, recipeDirectory, sandboxWorkspace))
        executions.push(execution)
        if (execution.exitCode !== 0 && !step.allowFailure && !step.advisory) {
          break
        }
      }
      const failed = executions.find((execution) => execution.exitCode !== 0)
      const payload = { schema: "wp-codebox/wordpress-workload-run-result/v1", caseId: fuzzCase.id, steps: executions.length, exitCode: failed?.exitCode ?? 0 }
      return {
        id: `wordpress-run-workload-${fuzzCase.id}`,
        command: "wordpress.run-workload",
        args: [`steps=${steps.length}`],
        exitCode: failed?.exitCode ?? 0,
        stdout: `${JSON.stringify(payload)}\n`,
        stderr: failed?.stderr ?? "",
        result: { schema: "wp-codebox/runtime-command-result/v1", status: failed ? "error" : "ok", json: payload },
        startedAt: workloadStartedAt,
        finishedAt: executions.at(-1)?.finishedAt ?? new Date().toISOString(),
        artifactRefs: executions.flatMap((execution) => execution.artifactRefs ?? []),
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

async function fuzzSuiteFromRecipeCommandArgs(args: string[], recipeDirectory: string): Promise<FuzzSuiteContract> {
  const inline = commandArgValue(args, "input-json") ?? commandArgValue(args, "suite-json")
  if (inline) {
    return parseCommandJson(inline, "input-json") as FuzzSuiteContract
  }
  const file = commandArgValue(args, "input-file") ?? commandArgValue(args, "suite-file")
  if (file) {
    return parseCommandJson(await readFile(resolve(recipeDirectory, file), "utf8"), file) as FuzzSuiteContract
  }
  throw new Error("wp-codebox/run-fuzz-suite requires input-json=<suite> or input-file=<path>")
}

function workflowStepsFromWorkloadPhase(value: unknown): WorkspaceRecipe["workflow"]["steps"] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.flatMap((step) => {
    if (!step || typeof step !== "object" || Array.isArray(step)) {
      return []
    }
    const command = (step as { command?: unknown }).command
    return typeof command === "string" && command.trim() !== "" ? [step as WorkspaceRecipe["workflow"]["steps"][number]] : []
  })
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
