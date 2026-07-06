import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { DEFAULT_CAPTURED_ARTIFACT_MAX_BYTES, DEFAULT_WORDPRESS_VERSION, STRUCTURED_ARTIFACT_INDEX_SCHEMA, artifactFileDigest, artifactManifestFileWithSha256, calculateArtifactManifestFileListDigest, captureArtifactFile, checkWorkspacePolicy, materializeStructuredArtifactFiles, normalizeAgentTerminalResult, normalizeRuntimeBackendKind, normalizeStructuredArtifacts, refreshArtifactManifestFileSha256s, runtimeReferenceManifestDigest, runtimeReplayReferenceIndexDigest, upsertArtifactManifestFiles, type AgentTerminalResult, type ArtifactBundle, type ArtifactManifest, type ArtifactManifestFile, type ArtifactSpec, type ExecutionResult, type Runtime, type RuntimeInfo, type RuntimePolicy, type StructuredArtifactRef, type WorkspacePolicyResult, type WorkspaceRecipe } from "@automattic/wp-codebox-core"
import { verifyArtifactBundle, type ArtifactBundleVerificationResult } from "@automattic/wp-codebox-core/artifacts"
import { isPlainObject as isRecord, sha256StableJson, stripUndefined } from "@automattic/wp-codebox-core/internals"
import type { RecipeSecretEnvSummaryEntry } from "./recipe-secret-env.js"
import { recipeExternalServiceBoundarySummaries, type RecipeExternalServiceBoundarySummary } from "./recipe-external-services.js"

export interface RecipeArtifactEvidenceFile {
  path: string
  sha256: string
  kind: string
  contentType: string
}

export interface RecipeRuntimeEvidenceInput {
  filename: string
  kind: string
  value: unknown
}

export interface RecipeRuntimeEvidenceFileInput {
  filename: string
  kind: string
  contentType: string
  contents: string | Buffer
  maxBytes?: number
  skipSensitiveText?: boolean
}

export interface RecipeArtifactEvidenceResult {
  runAttestation?: RecipeRunAttestation & {
    artifact: RecipeArtifactEvidenceFile
  }
  artifactVerification?: ArtifactBundleVerificationResult & {
    artifact: RecipeArtifactEvidenceFile
    strict: boolean
  }
  workspacePolicy?: RecipeWorkspacePolicyArtifactResult & {
    artifact: RecipeArtifactEvidenceFile
    strict: boolean
  }
  agentResult?: AgentSandboxResultSummary & {
    artifact: RecipeArtifactEvidenceFile
  }
  agentTaskResult?: AgentTaskSingleResult & {
    artifact: RecipeArtifactEvidenceFile
  }
  terminalResult?: AgentTerminalResult & {
    artifact: RecipeArtifactEvidenceFile
  }
  completionOutcome?: SandboxCompletionOutcome & {
    artifact: RecipeArtifactEvidenceFile
  }
  transcript?: AgentSandboxTranscript & {
    artifact: RecipeArtifactEvidenceFile
  }
  replayStatus?: RecipeReplayStatusSummary & {
    artifact: RecipeArtifactEvidenceFile
  }
}

export interface RecipeReplayStatusSummary {
  schema: "wp-codebox/recipe-replay-status/v1"
  status: "replayable" | "partial" | "not_available"
  reasons: string[]
  artifacts: {
    executableBlueprint?: RecipeReplayArtifactRef
    notes?: RecipeReplayArtifactRef
    runtimeSnapshot?: RecipeReplayArtifactRef
    runtimeReferenceManifest?: RecipeReplayArtifactRef
    replayIndex?: RecipeReplayArtifactRef
  }
  publicAccess: {
    status: "not_required" | "caller_must_publish"
    reason?: string
  }
}

export interface RecipeReplayArtifactRef {
  path: string
  kind: string
  contentType?: string
}

export interface AgentTaskSingleResult {
  schema: "wp-codebox/agent-task-result/v1"
  success: boolean
  status: "completed" | "failed"
  outputs: Record<string, unknown>
  structured_artifacts: StructuredArtifactRef[]
  terminal_result?: AgentTerminalResult
  diagnostics: Record<string, unknown>
  raw: {
    agent_runtime?: Record<string, unknown>
    result?: unknown
  }
}

export interface AgentSandboxResultSummary {
  schema: "wp-codebox/agent-result/v1"
  status: "completed" | "failed" | "unknown"
  actionable: boolean
  summary: string
  changedFiles: {
    count: number
    paths: string[]
    statuses: Record<string, number>
    artifact: string
  }
  patch: {
    bytes: number
    sha256: string
    artifact: string
  }
  transcript: {
    artifact: string
    executionCount: number
  }
  artifacts: {
    directory: string
    review: string
    manifest: string
  }
  failures: Array<{ executionIndex: number; command: string; exitCode: number; message: string }>
  noOpReason?: string
  workspaceTools?: {
    diagnostics: string[]
  }
}

export interface SandboxCompletionOutcome {
  schema: "wp-codebox/sandbox-completion-outcome/v1"
  status: "succeeded" | "blocked" | "failed" | "partial"
  summary: string
  changedFiles: AgentSandboxResultSummary["changedFiles"]
  patch: AgentSandboxResultSummary["patch"]
  artifacts: AgentSandboxResultSummary["artifacts"]
  verification: {
    transcript: AgentSandboxResultSummary["transcript"]
    commands: Array<{ command: string; exitCode: number }>
    artifactBundle?: {
      artifact: string
      status: "passed" | "failed" | "unknown"
      strict: boolean
    }
  }
  blockers: Array<{ kind: string; message: string; retryable: boolean }>
  riskNotes: string[]
  confidence: "high" | "medium" | "low"
  nextAction: "promote" | "retry" | "review" | "fix-blocker"
  provenance: {
    artifactBundleId: string
    artifactDirectory: string
    runtime?: RuntimeInfo
    task?: Record<string, unknown>
  }
}

export interface AgentSandboxTranscript {
  schema: "wp-codebox/agent-transcript/v1"
  executions: AgentSandboxTranscriptExecution[]
}

export interface AgentSandboxTranscriptExecution {
  executionIndex: number
  command: string
  exitCode: number
  recipePhase?: string
  recipeStepIndex?: number
  recipeCommand?: string
  stdout: string
  stderr: string
  parsed?: unknown
}

export interface AgentSandboxRuntimeFailure {
  code?: string
  message: string
  data?: unknown
}

export interface RecipeRunAttestation {
  schema: "wp-codebox/run-attestation/v1"
  createdAt: string
  package: {
    name: string
    version?: string
    commit?: string
  }
  backend: {
    kind: string
    package: {
      name: string
      version?: string
    }
    engine?: {
      name: string
      version?: string
    }
  }
  runtime: {
    kind: string
    name?: string
    version?: string
    immutableRef?: string
  }
  policy: {
    command: {
      sha256: string
      allowedCommands: string[]
      enforcement: "enforced"
    }
    network: RunAttestationPolicyField
    filesystem: RunAttestationPolicyField
    secrets: RunAttestationPolicyField
    approvals: RunAttestationPolicyField
    workspace: RunAttestationEvidencePolicy
    artifactVerifier: RunAttestationEvidencePolicy
  }
  secretEnvelope: {
    schema: "wp-codebox/redacted-secret-envelope/v1"
    provided: boolean
    count: number
    secrets: Array<{ name: string; status: RecipeSecretEnvSummaryEntry["status"]; source?: string }>
    redaction: "names-only"
  }
  externalServices: {
    schema: "wp-codebox/external-service-boundaries-attestation/v1"
    boundaries: RecipeExternalServiceBoundarySummary[]
    redaction: "secret-env-names-only"
  }
  evidenceRefs: {
    workspacePolicyResult?: RunAttestationEvidenceRef
    artifactVerifierResult?: RunAttestationEvidenceRef
  }
  sealed: {
    enforced: string[]
    declarative: string[]
  }
}

interface RunAttestationPolicyField {
  value: RuntimePolicy[keyof RuntimePolicy]
  enforcement: "enforced"
}

interface RunAttestationEvidencePolicy {
  enabled: boolean
  strict: boolean
  enforcement: "enforced" | "declarative" | "not-configured"
  sha256?: string
  resultRef?: RunAttestationEvidenceRef
}

interface RunAttestationEvidenceRef {
  path: string
  sha256: string
  kind: string
}

export interface RecipeWorkspacePolicyArtifactResult {
  schema: "wp-codebox/workspace-policy-artifacts/v1"
  passed: boolean
  checks: Array<{
    workspace: {
      target: string
      mode: "readonly" | "readwrite"
      metadata?: Record<string, unknown>
    }
    result: WorkspacePolicyResult
  }>
}

export type RecipeEvidenceExecutionResult = ExecutionResult & {
  recipePhase?: string
  recipeStepIndex?: number
  recipeCommand?: string
}

export interface RecipeEvidenceWorkspaceMount {
  source: string
  target: string
  mode: "readonly" | "readwrite"
  metadata: Record<string, unknown>
}

export interface RecipeEvidenceStagedFile {
  target: string
  metadata: Record<string, unknown>
}

export interface RecipeArtifactsFinalizationController {
  readonly metadata: { artifactsFinalized: boolean } | undefined
}

interface RecipeRuntimeArtifactCollectionOptions {
  timeoutMs?: number
  snapshotTimeoutMs?: number
}

const execFileAsync = promisify(execFile)
const moduleDirectory = dirname(fileURLToPath(import.meta.url))
const workspaceRoot = resolve(moduleDirectory, "..", "..", "..")

export async function collectAndFinalizeFailedRecipeArtifacts(args: {
  runtime: Runtime
  existingArtifacts?: ArtifactBundle
  recipe: WorkspaceRecipe
  workspaceMounts: RecipeEvidenceWorkspaceMount[]
  stagedFiles: RecipeEvidenceStagedFile[]
  policy: RuntimePolicy
  secretEnv: RecipeSecretEnvSummaryEntry[]
  executions: RecipeEvidenceExecutionResult[]
  interruption?: RecipeArtifactsFinalizationController
}): Promise<ArtifactBundle | undefined> {
  let artifacts = args.existingArtifacts

  if (!artifacts) {
    try {
      artifacts = await collectRecipeRuntimeArtifacts(args.runtime, { includeLogs: true, includeObservations: true }, { snapshotTimeoutMs: 20_000, timeoutMs: 30_000 })
    } catch {
      return undefined
    }
  }

  try {
    await finalizeRecipeArtifactEvidence(artifacts, args.recipe, args.workspaceMounts, args.stagedFiles, args.policy, args.secretEnv)
    await finalizeAgentSandboxEvidence(artifacts, args.executions)
    markRecipeArtifactsFinalized(args.interruption, true)
  } catch {
    markRecipeArtifactsFinalized(args.interruption, true)
  }

  return artifacts
}

export async function collectRecipeRuntimeArtifacts(runtime: Runtime, spec: ArtifactSpec, options: RecipeRuntimeArtifactCollectionOptions = {}): Promise<ArtifactBundle> {
  if (spec.includeRuntimeSnapshotBundles === true) {
    try {
      const snapshot = runtime.snapshot()
      if (options.snapshotTimeoutMs && options.snapshotTimeoutMs > 0) {
        snapshot.catch(() => undefined)
        await timeoutOrUndefined(snapshot, options.snapshotTimeoutMs)
      } else {
        await snapshot
      }
    } catch {
      // Preserve artifact collection on runtimes that are too broken to snapshot.
    }
  }

  const artifacts = runtime.collectArtifacts(spec)
  if (options.timeoutMs && options.timeoutMs > 0) {
    return timeoutOrReject(artifacts, options.timeoutMs, `Runtime artifact collection exceeded ${options.timeoutMs}ms`)
  }
  return artifacts
}

async function timeoutOrUndefined<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timeout: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => resolve(undefined), timeoutMs)
        timeout.unref()
      }),
    ])
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
  }
}

async function timeoutOrReject<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined
  promise.catch(() => undefined)
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
        timeout.unref()
      }),
    ])
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
  }
}

export async function finalizeRecipeArtifactEvidence(
  artifacts: ArtifactBundle,
  recipe: WorkspaceRecipe,
  workspaceMounts: RecipeEvidenceWorkspaceMount[],
  stagedFiles: RecipeEvidenceStagedFile[],
  policy: RuntimePolicy,
  secretEnv: RecipeSecretEnvSummaryEntry[],
): Promise<RecipeArtifactEvidenceResult> {
  const result: RecipeArtifactEvidenceResult = {}
  const verifier = normalizeArtifactToggle(recipe.artifacts?.verify)
  const workspacePolicy = normalizeWorkspacePolicyArtifact(recipe.artifacts?.workspacePolicy)

  const evidenceDirectory = join(dirname(artifacts.reviewPath), "runtime-evidence")
  await mkdir(evidenceDirectory, { recursive: true })

  const evidenceFiles: RecipeArtifactEvidenceFile[] = []
  if (workspacePolicy.enabled) {
    const workspacePolicyPath = join(evidenceDirectory, "workspace-policy.json")
    const policyResult = await buildRecipeWorkspacePolicyResult(recipe, workspaceMounts, stagedFiles, workspacePolicy)
    const policyFile = await writeRecipeEvidenceJson(artifacts.directory, workspacePolicyPath, policyResult, "workspace-policy-result")
    artifacts.workspacePolicyPath = workspacePolicyPath
    evidenceFiles.push(policyFile)
    result.workspacePolicy = {
      ...policyResult,
      artifact: policyFile,
      strict: workspacePolicy.strict,
    }
  }

  if (verifier.enabled) {
    const verificationPath = join(evidenceDirectory, "artifact-bundle-verification.json")
    const placeholder = {
      schema: "wp-codebox/artifact-bundle-verification/v1",
      bundleDirectory: artifacts.directory,
      valid: false,
      violations: [],
      status: "pending",
    }
    const placeholderFile = await writeRecipeEvidenceJson(artifacts.directory, verificationPath, placeholder, "artifact-bundle-verification")
    artifacts.artifactVerificationPath = verificationPath
    evidenceFiles.push(placeholderFile)
    await updateRecipeArtifactEvidenceReferences(artifacts, evidenceFiles)

    const verification = await verifyArtifactBundle(artifacts.directory)
    const verificationFile = await writeRecipeEvidenceJson(artifacts.directory, verificationPath, verification, "artifact-bundle-verification")
    const verificationFiles = evidenceFiles.map((file) => file.path === verificationFile.path ? verificationFile : file)
    await updateRecipeArtifactEvidenceReferences(artifacts, verificationFiles)
    result.artifactVerification = {
      ...verification,
      artifact: verificationFile,
      strict: verifier.strict,
    }
  }

  const attestationPath = join(evidenceDirectory, "run-attestation.json")
  const attestation = await buildRecipeRunAttestation({
    artifacts,
    recipe,
    policy,
    secretEnv,
    workspacePolicy,
    verifier,
    workspacePolicyFile: result.workspacePolicy?.artifact,
    artifactVerificationFile: result.artifactVerification?.artifact,
  })
  const attestationFile = await writeRecipeEvidenceJson(artifacts.directory, attestationPath, attestation, "run-attestation")
  artifacts.runAttestationPath = attestationPath
  evidenceFiles.push(attestationFile)
  result.runAttestation = {
    ...attestation,
    artifact: attestationFile,
  }

  const replayStatusPath = join(evidenceDirectory, "replay-status.json")
  const replayStatus = await buildRecipeReplayStatusSummary(artifacts)
  const replayStatusFile = await writeRecipeEvidenceJson(artifacts.directory, replayStatusPath, replayStatus, "replay-status")
  evidenceFiles.push(replayStatusFile)
  result.replayStatus = {
    ...replayStatus,
    artifact: replayStatusFile,
  }

  await updateRecipeArtifactEvidenceReferences(artifacts, evidenceFiles)
  return result
}

export async function buildRecipeReplayStatusSummary(artifacts: ArtifactBundle): Promise<RecipeReplayStatusSummary> {
  const manifest = JSON.parse(await readFile(artifacts.manifestPath, "utf8")) as ArtifactManifest
  const filesByKind = new Map(manifest.files.map((file) => [file.kind, file]))
  const executableBlueprint = replayArtifactRef(filesByKind.get("blueprint-after"))
  const notes = replayArtifactRef(filesByKind.get("blueprint-after-notes"))
  const runtimeReferenceManifest = replayArtifactRef(filesByKind.get("runtime-reference-manifest"))
  const replayIndex = replayArtifactRef(filesByKind.get("runtime-replay-index"))
  const runtimeSnapshot = replayArtifactRef(manifest.files.find((file) => file.kind === "runtime-snapshot"))
  const reasons: string[] = []

  if (!executableBlueprint) {
    reasons.push("missing_executable_blueprint")
  }
  if (!notes) {
    reasons.push("missing_blueprint_notes")
  }
  if (!runtimeReferenceManifest) {
    reasons.push("missing_runtime_reference_manifest")
  }
  if (!replayIndex) {
    reasons.push("missing_runtime_replay_index")
  }
  if (!runtimeSnapshot) {
    reasons.push("missing_runtime_snapshot")
  }

  const blueprintReplayStatus = executableBlueprint
    ? await readBlueprintReplayStatus(artifacts.directory, executableBlueprint.path, notes?.path)
    : undefined
  if (blueprintReplayStatus === "replayable-runtime-state") {
    reasons.push("blueprint_after_uses_runtime_state_snapshot")
  } else if (blueprintReplayStatus === "partial") {
    reasons.push("blueprint_after_is_partial")
  } else if (executableBlueprint) {
    reasons.push("blueprint_after_replay_status_unknown")
  }

  const status = !executableBlueprint
    ? "not_available"
    : runtimeSnapshot && replayIndex && blueprintReplayStatus === "replayable-runtime-state"
      ? "replayable"
      : "partial"

  return {
    schema: "wp-codebox/recipe-replay-status/v1",
    status,
    reasons,
    artifacts: stripUndefined({
      executableBlueprint,
      notes,
      runtimeSnapshot,
      runtimeReferenceManifest,
      replayIndex,
    }) as RecipeReplayStatusSummary["artifacts"],
    publicAccess: {
      status: executableBlueprint ? "caller_must_publish" : "not_required",
      ...(executableBlueprint ? { reason: "WP Codebox writes bundle-relative artifacts; callers must publish the executable blueprint URL when external replay needs browser access." } : {}),
    },
  }
}

function replayArtifactRef(file: ArtifactManifestFile | undefined): RecipeReplayArtifactRef | undefined {
  if (!file) {
    return undefined
  }
  return stripUndefined({ path: file.path, kind: file.kind, contentType: file.contentType }) as RecipeReplayArtifactRef
}

async function readBlueprintReplayStatus(artifactRoot: string, blueprintPath: string, notesPath: string | undefined): Promise<string | undefined> {
  const notesStatus = notesPath ? await readJsonReplayStatus(artifactRoot, notesPath) : undefined
  if (notesStatus) {
    return notesStatus
  }

  return readJsonReplayStatus(artifactRoot, blueprintPath)
}

async function readJsonReplayStatus(artifactRoot: string, path: string): Promise<string | undefined> {
  try {
    const value = JSON.parse(await readFile(join(artifactRoot, path), "utf8")) as Record<string, unknown>
    if (typeof value.replayStatus === "string") {
      return value.replayStatus
    }
    if (typeof value["wp-codebox/replayStatus"] === "string") {
      return value["wp-codebox/replayStatus"]
    }
    const metadata = isRecord(value.metadata) ? value.metadata : undefined
    return typeof metadata?.replayStatus === "string" ? metadata.replayStatus : undefined
  } catch {
    return undefined
  }
}

export async function appendRecipeRuntimeEvidence(artifacts: ArtifactBundle, files: RecipeRuntimeEvidenceInput[]): Promise<RecipeArtifactEvidenceFile[]> {
  if (files.length === 0) {
    return []
  }

  const evidenceDirectory = join(dirname(artifacts.reviewPath), "runtime-evidence")
  await mkdir(evidenceDirectory, { recursive: true })
  const evidenceFiles: RecipeArtifactEvidenceFile[] = []
  for (const file of files) {
    evidenceFiles.push(await writeRecipeEvidenceJson(artifacts.directory, join(evidenceDirectory, file.filename), file.value, file.kind))
  }
  await updateRecipeArtifactEvidenceReferences(artifacts, evidenceFiles)
  return evidenceFiles
}

export async function appendRecipeRuntimeEvidenceFiles(artifacts: ArtifactBundle, files: RecipeRuntimeEvidenceFileInput[]): Promise<RecipeArtifactEvidenceFile[]> {
  if (files.length === 0) {
    return []
  }

  const evidenceDirectory = join(dirname(artifacts.reviewPath), "runtime-evidence")
  const evidenceFiles: RecipeArtifactEvidenceFile[] = []
  for (const file of files) {
    const path = join(evidenceDirectory, file.filename)
    const captured = await captureArtifactFile({
      root: artifacts.directory,
      path: relative(artifacts.directory, path),
      kind: file.kind,
      contentType: file.contentType,
      contents: file.contents,
      maxBytes: file.maxBytes ?? DEFAULT_CAPTURED_ARTIFACT_MAX_BYTES,
      skipSensitiveText: file.skipSensitiveText,
      redaction: { policy: "applied", sensitive: file.skipSensitiveText === true, reason: "Runtime evidence files are redacted and bounded before capture." },
      provenance: { source: "recipe-run", operation: "append-runtime-evidence-file", id: file.filename },
    })
    if (captured.status !== "captured" || !captured.sha256) {
      continue
    }
    evidenceFiles.push({
      path: relative(artifacts.directory, path),
      sha256: captured.sha256,
      kind: file.kind,
      contentType: file.contentType,
    })
  }
  await updateRecipeArtifactEvidenceReferences(artifacts, evidenceFiles)
  return evidenceFiles
}

export async function finalizeAgentSandboxEvidence(artifacts: ArtifactBundle, executions: RecipeEvidenceExecutionResult[]): Promise<Pick<RecipeArtifactEvidenceResult, "agentResult" | "agentTaskResult" | "terminalResult" | "completionOutcome" | "transcript">> {
  const transcript = buildAgentSandboxTranscript(executions)
  if (transcript.executions.length === 0) {
    return {}
  }

  const transcriptPath = join(dirname(artifacts.reviewPath), "transcript.json")
  const agentResultPath = join(dirname(artifacts.reviewPath), "agent-result.json")
  const agentTaskResultPath = join(dirname(artifacts.reviewPath), "agent-task-result.json")
  const terminalResultPath = join(dirname(artifacts.reviewPath), "terminal-result.json")
  const completionOutcomePath = join(dirname(artifacts.reviewPath), "completion-outcome.json")
  const transcriptFile = await writeRecipeEvidenceJson(artifacts.directory, transcriptPath, transcript, "agent-transcript")
  const agentTaskResult = buildAgentTaskSingleResult(transcript)
  const agentResult = reconcileAgentSandboxResult(
    await buildAgentSandboxResultSummary(artifacts, transcript, transcriptFile.path),
    agentTaskResult,
  )
  const agentResultFile = await writeRecipeEvidenceJson(artifacts.directory, agentResultPath, agentResult, "agent-result")
  const structuredArtifactFiles = agentTaskResult ? await writeAgentTaskStructuredArtifacts(artifacts, agentTaskResult) : []
  const agentTaskResultFile = agentTaskResult ? await writeRecipeEvidenceJson(artifacts.directory, agentTaskResultPath, agentTaskResult, "agent-task-result") : undefined
  const terminalResult = agentTaskResult?.terminal_result ?? latestAgentTerminalResult(transcript)
  const terminalResultFile = terminalResult ? await writeRecipeEvidenceJson(artifacts.directory, terminalResultPath, terminalResult, "agent-terminal-result") : undefined
  const completionOutcome = buildSandboxCompletionOutcome(artifacts, agentResult, transcript)
  const completionOutcomeFile = await writeRecipeEvidenceJson(artifacts.directory, completionOutcomePath, completionOutcome, "completion-outcome")
  await updateRecipeArtifactEvidenceReferences(artifacts, [agentResultFile, ...structuredArtifactFiles, ...(agentTaskResultFile ? [agentTaskResultFile] : []), ...(terminalResultFile ? [terminalResultFile] : []), completionOutcomeFile, transcriptFile])

  return {
    agentResult: { ...agentResult, artifact: agentResultFile },
    ...(agentTaskResult && agentTaskResultFile ? { agentTaskResult: { ...agentTaskResult, artifact: agentTaskResultFile } } : {}),
    ...(terminalResult && terminalResultFile ? { terminalResult: { ...terminalResult, artifact: terminalResultFile } } : {}),
    completionOutcome: { ...completionOutcome, artifact: completionOutcomeFile },
    transcript: { ...transcript, artifact: transcriptFile },
  }
}

function reconcileAgentSandboxResult(agentResult: AgentSandboxResultSummary, agentTaskResult: AgentTaskSingleResult | undefined): AgentSandboxResultSummary {
  if (agentTaskResult?.success !== true || agentResult.status !== "failed") {
    return agentResult
  }

  const actionable = agentResult.changedFiles.count > 0 || agentResult.patch.bytes > 0
  return stripUndefined({
    ...agentResult,
    status: "completed" as const,
    actionable,
    summary: actionable
      ? `Agent sandbox produced ${agentResult.changedFiles.count === 1 ? "1 changed file" : `${agentResult.changedFiles.count} changed files`} and a ${agentResult.patch.bytes}-byte patch.`
      : "Agent sandbox completed successfully without actionable file changes.",
    failures: [],
    noOpReason: actionable ? undefined : "no_file_changes",
  })
}

function buildAgentSandboxTranscript(executions: RecipeEvidenceExecutionResult[]): AgentSandboxTranscript {
  return {
    schema: "wp-codebox/agent-transcript/v1",
    executions: executions
      .map((execution, index) => ({ execution, index }))
      .filter(({ execution }) => isAgentSandboxExecution(execution))
      .map(({ execution, index }) => ({
        executionIndex: index,
        command: execution.command,
        exitCode: execution.exitCode,
        recipePhase: execution.recipePhase,
        recipeStepIndex: execution.recipeStepIndex,
        recipeCommand: execution.recipeCommand,
        stdout: boundTranscriptText(execution.stdout),
        stderr: boundTranscriptText(execution.stderr),
        ...(decodeJsonFragment(execution.stdout) ?? decodeJsonFragment(execution.stderr) ? { parsed: decodeJsonFragment(execution.stdout) ?? decodeJsonFragment(execution.stderr) } : {}),
      })),
  }
}

function isAgentSandboxExecution(execution: RecipeEvidenceExecutionResult): boolean {
  return execution.recipeCommand === "wp-codebox.agent-sandbox-run"
}

async function buildAgentSandboxResultSummary(artifacts: ArtifactBundle, transcript: AgentSandboxTranscript, transcriptPath: string): Promise<AgentSandboxResultSummary> {
  const changedFiles = await readChangedFileSummary(artifacts.changedFilesPath)
  const patch = await readPatchSummary(artifacts.patchPath)
  const failures = transcript.executions
    .map((execution) => ({ execution, runtimeFailure: agentSandboxRuntimeFailure(execution) }))
    .filter(({ execution, runtimeFailure }) => execution.exitCode !== 0 || runtimeFailure)
    .map(({ execution, runtimeFailure }) => ({
      executionIndex: execution.executionIndex,
      command: execution.command,
      exitCode: execution.exitCode,
      message: runtimeFailure?.message || firstTranscriptMessage(execution) || `Command exited with ${execution.exitCode}`,
    }))
  const status: AgentSandboxResultSummary["status"] = failures.length > 0 ? "failed" : transcript.executions.length > 0 ? "completed" : "unknown"
  const actionable = status === "completed" && (changedFiles.count > 0 || patch.bytes > 0)
  const noOpReason = actionable ? undefined : status === "failed" ? "execution_failed" : "no_file_changes"

  return stripUndefined({
    schema: "wp-codebox/agent-result/v1" as const,
    status,
    actionable,
    summary: actionable
      ? `Agent sandbox produced ${changedFiles.count === 1 ? "1 changed file" : `${changedFiles.count} changed files`} and a ${patch.bytes}-byte patch.`
      : status === "failed"
        ? "Agent sandbox failed before producing actionable file changes."
        : "Agent sandbox completed without actionable file changes.",
    changedFiles,
    patch,
    transcript: {
      artifact: transcriptPath,
      executionCount: transcript.executions.length,
    },
    artifacts: {
      directory: artifacts.directory,
      review: relative(artifacts.directory, artifacts.reviewPath),
      manifest: relative(artifacts.directory, artifacts.manifestPath),
    },
    failures,
    noOpReason,
    workspaceTools: workspaceToolDiagnostics(transcript),
  })
}

function buildSandboxCompletionOutcome(artifacts: ArtifactBundle, agentResult: AgentSandboxResultSummary, transcript: AgentSandboxTranscript): SandboxCompletionOutcome {
  const blockedDiagnostics = new Set(agentResult.workspaceTools?.diagnostics ?? [])
  const blockers = agentResult.failures.map((failure) => ({
    kind: blockedDiagnostics.size > 0 ? "runtime-blocker" : "runtime-failure",
    message: failure.message,
    retryable: true,
  }))
  const status: SandboxCompletionOutcome["status"] = agentResult.status === "failed"
    ? blockedDiagnostics.size > 0 ? "blocked" : "failed"
    : agentResult.status === "completed"
      ? agentResult.actionable ? "succeeded" : "partial"
      : "partial"
  const confidence: SandboxCompletionOutcome["confidence"] = status === "succeeded" ? "high" : blockers.length > 0 ? "low" : "medium"
  const nextAction: SandboxCompletionOutcome["nextAction"] = status === "succeeded" ? "promote" : status === "blocked" ? "fix-blocker" : status === "failed" ? "retry" : "review"

  return stripUndefined({
    schema: "wp-codebox/sandbox-completion-outcome/v1" as const,
    status,
    summary: agentResult.summary,
    changedFiles: agentResult.changedFiles,
    patch: agentResult.patch,
    artifacts: agentResult.artifacts,
    verification: {
      transcript: agentResult.transcript,
      commands: transcript.executions.map((execution) => ({ command: execution.command, exitCode: execution.exitCode })),
    },
    blockers,
    riskNotes: agentResult.noOpReason ? [agentResult.noOpReason] : [],
    confidence,
    nextAction,
    provenance: {
      artifactBundleId: artifacts.id,
      artifactDirectory: artifacts.directory,
    },
  })
}

export function buildAgentTaskSingleResult(transcript: AgentSandboxTranscript): AgentTaskSingleResult | undefined {
  const runtime = latestAgentRuntime(transcript)
  if (!runtime) {
    return undefined
  }

  const rawResult = runtime.result
  const resultRecord = isRecord(rawResult) ? rawResult : undefined
  const success = runtime.success === true
  const terminalResult = normalizeAgentTerminalResult(runtime)
  return {
    schema: "wp-codebox/agent-task-result/v1",
    success,
    status: success ? "completed" : "failed",
    outputs: semanticOutputs(resultRecord),
    structured_artifacts: [],
    ...(terminalResult ? { terminal_result: terminalResult } : {}),
    diagnostics: stripUndefined({
      runtime: isRecord(resultRecord?.diagnostics) || Array.isArray(resultRecord?.diagnostics) ? resultRecord?.diagnostics : undefined,
      error: isRecord(runtime.error) ? runtime.error : undefined,
      adapter: resultRecord ? undefined : { code: "agent_task_result_not_object", message: "Runtime agent task result was preserved under raw.result but did not expose object-shaped semantic outputs." },
    }),
    raw: stripUndefined({
      agent_runtime: runtime,
      result: rawResult,
    }),
  }
}

async function writeAgentTaskStructuredArtifacts(artifacts: ArtifactBundle, agentTaskResult: AgentTaskSingleResult): Promise<RecipeArtifactEvidenceFile[]> {
  const outputCandidates = structuredArtifactOutputCandidates(agentTaskResult)
  if (outputCandidates.length === 0) {
    return []
  }

  const structuredDirectory = join(dirname(artifacts.reviewPath), "structured-artifacts")
  const materialized = materializeStructuredArtifactFiles<StructuredArtifactRef, StructuredArtifactRef>({
    artifacts: outputCandidates,
    artifactPathPrefix: relative(artifacts.directory, structuredDirectory),
    artifactKind: "structured-artifact",
    indexKind: "structured-artifacts-index",
    indexSchema: STRUCTURED_ARTIFACT_INDEX_SCHEMA,
  })
  const files: RecipeArtifactEvidenceFile[] = []

  await mkdir(structuredDirectory, { recursive: true })
  for (const file of materialized.files) {
    await writeFile(join(artifacts.directory, file.path), file.contents)
    files.push({
      path: file.path,
      sha256: file.sha256.value,
      kind: file.artifact ? `structured-artifact:${file.artifact.name}` : file.kind,
      contentType: file.contentType,
    })
  }
  agentTaskResult.structured_artifacts = materialized.refs
  agentTaskResult.outputs = {
    ...agentTaskResult.outputs,
    structured_artifacts: materialized.refs,
  }
  return files
}

function structuredArtifactOutputCandidates(agentTaskResult: AgentTaskSingleResult): StructuredArtifactRef[] {
  const outputs = agentTaskResult.outputs
  const rawResult = isRecord(agentTaskResult.raw.result) ? agentTaskResult.raw.result : undefined
  const value = Array.isArray(outputs.structured_artifacts)
    ? outputs.structured_artifacts
    : Array.isArray(outputs.structuredArtifacts)
      ? outputs.structuredArtifacts
      : Array.isArray(rawResult?.structured_artifacts)
        ? rawResult.structured_artifacts
        : Array.isArray(rawResult?.structuredArtifacts)
          ? rawResult.structuredArtifacts
          : []
  return normalizeStructuredArtifacts(value, "output")
}

function latestAgentRuntime(transcript: AgentSandboxTranscript): Record<string, unknown> | undefined {
  for (const execution of [...transcript.executions].reverse()) {
    const runtime = agentRuntimeFromParsed(execution.parsed)
    if (runtime) {
      return runtime
    }
  }

  return undefined
}

function agentRuntimeFromParsed(parsed: unknown): Record<string, unknown> | undefined {
  const record = isRecord(parsed) ? parsed : undefined
  const runtime = isRecord(record?.agent_runtime) ? record.agent_runtime : undefined
  if (runtime) {
    return runtime
  }

  const output = typeof record?.output === "string" ? decodeJsonFragment(record.output) : undefined
  const outputRecord = isRecord(output) ? output : undefined
  return isRecord(outputRecord?.agent_runtime) ? outputRecord.agent_runtime : undefined
}

function semanticOutputs(result: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!result) {
    return {}
  }

  const outputs = isRecord(result.outputs) ? result.outputs : isRecord(result.output) ? result.output : undefined
  if (outputs) {
    return outputs
  }

  return Object.fromEntries(Object.entries(result).filter(([key]) => !["schema", "success", "status", "diagnostics", "raw", "error", "metadata"].includes(key)))
}

async function readChangedFileSummary(path: string): Promise<AgentSandboxResultSummary["changedFiles"]> {
  try {
    const decoded = JSON.parse(await readFile(path, "utf8"))
    const files: Record<string, unknown>[] = Array.isArray(decoded?.files) ? decoded.files.filter(isRecord) : []
    const statuses: Record<string, number> = {}
    for (const file of files) {
      const status = typeof file.status === "string" && file.status.length > 0 ? file.status : "unknown"
      statuses[status] = (statuses[status] ?? 0) + 1
    }

    return {
      count: files.length,
      paths: files.map((file) => String(file.relativePath ?? file.relative_path ?? file.path ?? "")).filter(Boolean),
      statuses,
      artifact: "files/changed-files.json",
    }
  } catch {
    return { count: 0, paths: [], statuses: {}, artifact: "files/changed-files.json" }
  }
}

async function readPatchSummary(path: string): Promise<AgentSandboxResultSummary["patch"]> {
  try {
    const patch = await readFile(path, "utf8")
    return {
      bytes: Buffer.byteLength(patch),
      sha256: artifactFileDigest(patch).value,
      artifact: "files/patch.diff",
    }
  } catch {
    return { bytes: 0, sha256: artifactFileDigest("").value, artifact: "files/patch.diff" }
  }
}

function firstTranscriptMessage(execution: AgentSandboxTranscriptExecution): string {
  const runtimeFailure = agentSandboxRuntimeFailure(execution)
  if (runtimeFailure) {
    return runtimeFailure.message
  }

  const parsed = isRecord(execution.parsed) ? execution.parsed : undefined
  const result = isRecord(parsed?.result) ? parsed.result : parsed
  for (const key of ["message", "error", "error_message", "errorMessage", "answer"]) {
    const value = result?.[key]
    if (typeof value === "string" && value.trim()) {
      return boundTranscriptText(value.trim(), 500)
    }
  }

  return boundTranscriptText(execution.stderr || execution.stdout, 500)
}

export function agentSandboxRuntimeFailure(execution: AgentSandboxTranscriptExecution): AgentSandboxRuntimeFailure | undefined {
  const parsed = isRecord(execution.parsed) ? execution.parsed : undefined
  const terminalResult = agentTerminalResultFromRecord(parsed)
  if (terminalResult?.source === "canonical") {
    return terminalResult.success ? undefined : {
      code: terminalResult.failure_classification || terminalResult.status,
      message: terminalResult.status === "max_turns"
        ? "Agent sandbox runtime reached the configured max turns before completing."
        : terminalResult.pending_tools?.detected
          ? "Agent sandbox runtime ended before the nested agent completed pending tool work."
          : "Agent sandbox runtime reported terminal failure.",
      data: stripUndefined({
        status: terminalResult.status,
        failure_classification: terminalResult.failure_classification,
        pending_tools: terminalResult.pending_tools,
        max_turns: terminalResult.max_turns,
        evidence_refs: terminalResult.evidence_refs.length > 0 ? terminalResult.evidence_refs : undefined,
        source: terminalResult.source,
      }),
    }
  }

  const directFailure = agentRuntimeFailureFromRecord(parsed)
  if (directFailure) {
    return directFailure
  }

  const directIncomplete = agentRuntimeIncompleteFromRecord(parsed)
  if (directIncomplete) {
    return directIncomplete
  }

  const output = typeof parsed?.output === "string" ? decodeJsonFragment(parsed.output) : undefined
  const outputRecord = isRecord(output) ? output : undefined
  return agentRuntimeFailureFromRecord(outputRecord) ?? agentRuntimeIncompleteFromRecord(outputRecord)
}

function agentRuntimeFailureFromRecord(record: Record<string, unknown> | undefined): AgentSandboxRuntimeFailure | undefined {
  const runtime = isRecord(record?.agent_runtime) ? record.agent_runtime : undefined
  if (!runtime || runtime.success !== false) {
    return undefined
  }

  const error = isRecord(runtime.error) ? runtime.error : undefined
  const message = typeof error?.message === "string" && error.message.trim()
    ? error.message.trim()
    : "Agent runtime reported failure."

  return stripUndefined({
    code: typeof error?.code === "string" && error.code.trim() ? error.code.trim() : undefined,
    message: boundTranscriptText(message, 500),
    data: error?.data,
  })
}

function agentRuntimeIncompleteFromRecord(record: Record<string, unknown> | undefined): AgentSandboxRuntimeFailure | undefined {
  if (!record) {
    return undefined
  }

  const runtime = isRecord(record?.agent_runtime) ? record.agent_runtime : undefined
  const runtimeResult = runtime?.success === true && isRecord(runtime.result) ? runtime.result : undefined
  const candidates = [runtimeResult, record].filter(isRecord)

  for (const result of candidates) {
    if (!isIncompleteAgentResult(result)) {
      continue
    }

    return {
      code: "agent_runtime_incomplete",
      message: "Agent sandbox runtime ended before the nested agent completed pending tool work.",
      data: incompleteAgentResultData(result),
    }
  }

  return undefined
}

function latestAgentTerminalResult(transcript: AgentSandboxTranscript): AgentTerminalResult | undefined {
  for (const execution of [...transcript.executions].reverse()) {
    const terminalResult = agentTerminalResultFromRecord(isRecord(execution.parsed) ? execution.parsed : undefined)
    if (terminalResult) return terminalResult
  }
  return undefined
}

function agentTerminalResultFromRecord(record: Record<string, unknown> | undefined): AgentTerminalResult | undefined {
  if (!record) return undefined
  const direct = normalizeAgentTerminalResult(record)
  if (direct) return direct
  const output = typeof record.output === "string" ? decodeJsonFragment(record.output) : undefined
  return normalizeAgentTerminalResult(output)
}

function isIncompleteAgentResult(result: Record<string, unknown>): boolean {
  const status = stringKey(result, ["status", "state"]) ?? ""
  const completed = typeof result.completed === "boolean" ? result.completed : undefined
  const hasPendingTools = truthyKey(result, ["has_pending_tools", "hasPendingTools"])
  const maxTurnsReached = truthyKey(result, ["max_turns_reached", "maxTurnsReached"])

  return hasPendingTools || status === "processing" || completed === false || maxTurnsReached || reachedMaxTurnsWithoutAnswer(result)
}

function reachedMaxTurnsWithoutAnswer(payload: Record<string, unknown>): boolean {
  const currentTurn = numberKey(payload, ["current_turn", "currentTurn"])
  const maxTurns = numberKey(payload, ["max_turns", "maxTurns"])
  return currentTurn !== undefined && maxTurns !== undefined && maxTurns > 0 && currentTurn >= maxTurns && !hasTerminalAnswer(payload)
}

function hasTerminalAnswer(payload: Record<string, unknown>): boolean {
  return ["answer", "final_answer", "finalAnswer", "reply", "message", "content"].some((key) => {
    const value = payload[key]
    return typeof value === "string" && value.trim().length > 0
  })
}

function incompleteAgentResultData(payload: Record<string, unknown>): Record<string, unknown> {
  return stripUndefined({
    status: stringKey(payload, ["status", "state"]),
    completed: typeof payload.completed === "boolean" ? payload.completed : undefined,
    current_turn: numberKey(payload, ["current_turn", "currentTurn"]),
    max_turns: numberKey(payload, ["max_turns", "maxTurns"]),
    has_pending_tools: truthyKey(payload, ["has_pending_tools", "hasPendingTools"]) || undefined,
    max_turns_reached: truthyKey(payload, ["max_turns_reached", "maxTurnsReached"]) || undefined,
  })
}

function truthyKey(record: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => record[key] === true || record[key] === 1 || record[key] === "1" || record[key] === "true")
}

function stringKey(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) {
      return value.trim().toLowerCase()
    }
  }

  return undefined
}

function numberKey(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "number" && Number.isFinite(value)) {
      return value
    }
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
      return Number(value)
    }
  }

  return undefined
}

export function recipeAgentResultFailure(agentResult: RecipeArtifactEvidenceResult["agentResult"]): { name: string; code: string; message: string } | undefined {
  if (!agentResult || agentResult.status !== "failed") {
    return undefined
  }

  const firstFailure = agentResult.failures[0]
  return {
    name: "AgentRuntimeError",
    code: "agent-runtime-failed",
    message: firstFailure?.message || "Agent sandbox runtime failed.",
  }
}

/**
 * Gate recipe success on post-agent verification steps.
 *
 * Steps in the recipe `workflow.after` phase (e.g. a `wordpress.phpunit` or
 * `wordpress.run-php` smoke gate run after the agent finishes editing) execute
 * but do not throw on a non-zero exit, so without this check a red test gate
 * would still report the run as succeeded. Any failing after-phase step turns
 * the whole run into a failure, so the orchestrator cannot accept an agent
 * change until its verification gates are green.
 */
export function recipeVerifyStepFailure(
  executions: ReadonlyArray<{ exitCode: number; recipePhase?: string; recipeCommand?: string; command?: string; recipeAdvisory?: boolean }>,
): { name: string; code: string; message: string } | undefined {
  const failed = executions.find((execution) => execution.exitCode !== 0 && execution.recipeAdvisory !== true)
  if (!failed) {
    return undefined
  }

  const stepName = failed.recipeCommand || failed.command || "recipe"
  return {
    name: "RecipeVerifyError",
    code: "verify-step-failed",
    message: `Recipe step ${stepName} failed with exit code ${failed.exitCode}.`,
  }
}

function workspaceToolDiagnostics(transcript: AgentSandboxTranscript): AgentSandboxResultSummary["workspaceTools"] | undefined {
  const diagnostics = new Set<string>()
  const text = transcript.executions.map((execution) => `${execution.stdout}\n${execution.stderr}`).join("\n").toLowerCase()
  if (text.includes("workspace") && /not found|unknown tool|tool_not_found|tool not found|not available/.test(text)) {
    diagnostics.add("workspace-tool-unavailable")
  }
  if (/permission denied|not allowlisted|not allowed|forbidden/.test(text)) {
    diagnostics.add("workspace-tool-denied")
  }
  if (text.includes("workspace_apply_patch") || text.includes("workspace-edit") || text.includes("workspace_write")) {
    diagnostics.add("workspace-tool-surface-observed")
  }

  return diagnostics.size > 0 ? { diagnostics: [...diagnostics].sort() } : undefined
}

export function recipeAgentResultOutput(agentResult: RecipeArtifactEvidenceResult["agentResult"]): AgentSandboxResultSummary | undefined {
  if (!agentResult) {
    return undefined
  }

  const { artifact: _artifact, ...result } = agentResult
  return result
}

export function recipeAgentTaskResultOutput(agentTaskResult: RecipeArtifactEvidenceResult["agentTaskResult"]): AgentTaskSingleResult | undefined {
  if (!agentTaskResult) {
    return undefined
  }

  const { artifact: _artifact, ...result } = agentTaskResult
  return result
}

export function recipeTerminalResultOutput(terminalResult: RecipeArtifactEvidenceResult["terminalResult"]): AgentTerminalResult | undefined {
  if (!terminalResult) {
    return undefined
  }

  const { artifact: _artifact, ...result } = terminalResult
  return result
}

export function recipeCompletionOutcomeOutput(completionOutcome: RecipeArtifactEvidenceResult["completionOutcome"]): SandboxCompletionOutcome | undefined {
  if (!completionOutcome) {
    return undefined
  }

  const { artifact: _artifact, ...result } = completionOutcome
  return result
}

export function recipeReplayStatusOutput(replayStatus: RecipeArtifactEvidenceResult["replayStatus"]): RecipeReplayStatusSummary | undefined {
  if (!replayStatus) {
    return undefined
  }

  const { artifact: _artifact, ...result } = replayStatus
  return result
}

function decodeJsonFragment(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed) {
    return undefined
  }

  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.indexOf("{")
    const end = trimmed.lastIndexOf("}")
    if (start === -1 || end <= start) {
      return undefined
    }
    try {
      return JSON.parse(trimmed.slice(start, end + 1))
    } catch {
      return undefined
    }
  }
}

function boundTranscriptText(text: string, maxLength = 12000): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n[truncated ${text.length - maxLength} bytes]` : text
}

async function buildRecipeRunAttestation(args: {
  artifacts: ArtifactBundle
  recipe: WorkspaceRecipe
  policy: RuntimePolicy
  secretEnv: RecipeSecretEnvSummaryEntry[]
  workspacePolicy: { enabled: boolean; strict: boolean }
  verifier: { enabled: boolean; strict: boolean }
  workspacePolicyFile?: RecipeArtifactEvidenceFile
  artifactVerificationFile?: RecipeArtifactEvidenceFile
}): Promise<RecipeRunAttestation> {
  const manifest = JSON.parse(await readFile(args.artifacts.manifestPath, "utf8")) as { runtime?: RuntimeInfo }
  const runtime = manifest.runtime ?? {
    id: "unknown",
    backend: normalizeRuntimeBackendKind(args.recipe.runtime?.backend),
    environment: {
      kind: "wordpress",
      name: args.recipe.runtime?.name ?? "wp-codebox-recipe",
      version: args.recipe.runtime?.wp ?? DEFAULT_WORDPRESS_VERSION,
      phpVersion: args.recipe.runtime?.phpVersion,
    },
    createdAt: args.artifacts.createdAt,
    status: "destroyed" as const,
  }
  const rootPackage = await readPackageJson(resolve(workspaceRoot, "package.json"))
  const backendPackage = await readPackageJson(resolve(moduleDirectory, "..", "..", "runtime-playground", "package.json"))
  const commit = await readGitCommit(workspaceRoot)
  const workspacePolicyRef = args.workspacePolicyFile ? evidenceRef(args.workspacePolicyFile) : undefined
  const artifactVerificationRef = args.artifactVerificationFile ? evidenceRef(args.artifactVerificationFile) : undefined
  const workspacePolicyEnforcement = evidencePolicyEnforcement(args.workspacePolicy.enabled, args.workspacePolicy.strict)
  const verifierEnforcement = evidencePolicyEnforcement(args.verifier.enabled, args.verifier.strict)

  return {
    schema: "wp-codebox/run-attestation/v1",
    createdAt: new Date().toISOString(),
    package: stripUndefined({
      name: "wp-codebox",
      version: typeof rootPackage.version === "string" ? rootPackage.version : undefined,
      commit,
    }),
    backend: stripUndefined({
      kind: runtime.backend,
      package: stripUndefined({
        name: typeof backendPackage.name === "string" ? backendPackage.name : "@automattic/wp-codebox-playground",
        version: typeof backendPackage.version === "string" ? backendPackage.version : undefined,
      }),
      engine: stripUndefined({
        name: "@wp-playground/cli",
        version: packageDependencyVersion(backendPackage, "@wp-playground/cli"),
      }),
    }),
    runtime: stripUndefined({
      kind: runtime.environment.kind,
      name: runtime.environment.name,
      version: runtime.environment.version,
      immutableRef: runtime.environment.version,
      phpVersion: runtime.environment.phpVersion,
    }),
    policy: {
      command: {
        sha256: sha256Json(args.policy.commands),
        allowedCommands: args.policy.commands,
        enforcement: "enforced",
      },
      network: enforcedPolicyField(args.policy.network),
      filesystem: enforcedPolicyField(args.policy.filesystem),
      secrets: enforcedPolicyField(args.policy.secrets),
      approvals: enforcedPolicyField(args.policy.approvals),
      workspace: stripUndefined({
        enabled: args.workspacePolicy.enabled,
        strict: args.workspacePolicy.strict,
        enforcement: workspacePolicyEnforcement,
        sha256: args.workspacePolicyFile?.sha256,
        resultRef: workspacePolicyRef,
      }),
      artifactVerifier: stripUndefined({
        enabled: args.verifier.enabled,
        strict: args.verifier.strict,
        enforcement: verifierEnforcement,
        sha256: args.artifactVerificationFile?.sha256,
        resultRef: artifactVerificationRef,
      }),
    },
    secretEnvelope: {
      schema: "wp-codebox/redacted-secret-envelope/v1",
      provided: args.secretEnv.some((entry) => entry.status === "available"),
      count: args.secretEnv.filter((entry) => entry.status === "available").length,
      secrets: [...args.secretEnv].sort((a, b) => a.name.localeCompare(b.name)),
      redaction: "names-only",
    },
    externalServices: {
      schema: "wp-codebox/external-service-boundaries-attestation/v1",
      boundaries: recipeExternalServiceBoundarySummaries(args.recipe),
      redaction: "secret-env-names-only",
    },
    evidenceRefs: stripUndefined({
      workspacePolicyResult: workspacePolicyRef,
      artifactVerifierResult: artifactVerificationRef,
    }),
    sealed: {
      enforced: [
        "command-policy",
        "network-policy",
        "filesystem-policy",
        "secret-policy",
        "approval-policy",
        ...(args.workspacePolicy.strict ? ["workspace-policy"] : []),
        ...(args.verifier.strict ? ["artifact-verifier"] : []),
      ],
      declarative: [
        ...(!args.workspacePolicy.enabled || args.workspacePolicy.strict ? [] : ["workspace-policy"]),
        ...(!args.verifier.enabled || args.verifier.strict ? [] : ["artifact-verifier"]),
      ],
    },
  }
}

function enforcedPolicyField(value: RuntimePolicy[keyof RuntimePolicy]): RunAttestationPolicyField {
  return { value, enforcement: "enforced" }
}

function evidencePolicyEnforcement(enabled: boolean, strict: boolean): RunAttestationEvidencePolicy["enforcement"] {
  if (!enabled) {
    return "not-configured"
  }
  return strict ? "enforced" : "declarative"
}

function evidenceRef(file: RecipeArtifactEvidenceFile): RunAttestationEvidenceRef {
  return {
    path: file.path,
    sha256: file.sha256,
    kind: file.kind,
  }
}

async function readPackageJson(path: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
  } catch {
    return {}
  }
}

function packageDependencyVersion(packageJson: Record<string, unknown>, name: string): string | undefined {
  for (const key of ["dependencies", "devDependencies", "peerDependencies"] as const) {
    const dependencies = packageJson[key]
    if (isRecord(dependencies) && typeof dependencies[name] === "string") {
      return dependencies[name]
    }
  }
  return undefined
}

async function readGitCommit(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd })
    const commit = stdout.trim()
    return /^[a-f0-9]{40}$/i.test(commit) ? commit : undefined
  } catch {
    return undefined
  }
}

function sha256Json(value: unknown): string {
  return sha256StableJson(value, true)
}

export function recipeArtifactEvidenceFailure(evidence: RecipeArtifactEvidenceResult): { name: string; code: string; message: string } | undefined {
  if (evidence.artifactVerification?.strict && !evidence.artifactVerification.valid) {
    return {
      name: "ArtifactVerificationError",
      code: "artifact-verification-failed",
      message: `Artifact verification failed with ${evidence.artifactVerification.violations.length} violation${evidence.artifactVerification.violations.length === 1 ? "" : "s"}.`,
    }
  }

  if (evidence.workspacePolicy?.strict && !evidence.workspacePolicy.passed) {
    const violations = evidence.workspacePolicy.checks.reduce((count, check) => count + check.result.violations.length, 0)
    return {
      name: "WorkspacePolicyError",
      code: "workspace-policy-failed",
      message: `Workspace policy failed with ${violations} violation${violations === 1 ? "" : "s"}.`,
    }
  }

  return undefined
}

export function normalizeArtifactToggle(value: boolean | { enabled?: boolean; strict?: boolean } | undefined): { enabled: boolean; strict: boolean } {
  if (value === undefined || value === false) {
    return { enabled: false, strict: false }
  }
  if (value === true) {
    return { enabled: true, strict: false }
  }
  if (value && typeof value === "object") {
    return { enabled: value.enabled !== false, strict: value.strict === true }
  }
  return { enabled: false, strict: false }
}

export function normalizeWorkspacePolicyArtifact(value: boolean | { enabled?: boolean; strict?: boolean; writableRoots?: string[]; hiddenPaths?: string[]; gitBacked?: boolean } | undefined): {
  enabled: boolean
  strict: boolean
  writableRoots: string[]
  hiddenPaths: string[]
  gitBacked: boolean
} {
  if (value === undefined || value === false) {
    return { enabled: false, strict: false, writableRoots: ["."], hiddenPaths: [], gitBacked: false }
  }
  if (value === true) {
    return { enabled: true, strict: false, writableRoots: ["."], hiddenPaths: [], gitBacked: false }
  }
  if (value && typeof value === "object") {
    return {
      enabled: value.enabled !== false,
      strict: value.strict === true,
      writableRoots: Array.isArray(value.writableRoots) && value.writableRoots.length > 0 ? value.writableRoots : ["."],
      hiddenPaths: Array.isArray(value.hiddenPaths) ? value.hiddenPaths : [],
      gitBacked: value.gitBacked === true,
    }
  }
  return { enabled: false, strict: false, writableRoots: ["."], hiddenPaths: [], gitBacked: false }
}

async function buildRecipeWorkspacePolicyResult(
  recipe: WorkspaceRecipe,
  workspaceMounts: RecipeEvidenceWorkspaceMount[],
  stagedFiles: RecipeEvidenceStagedFile[],
  policy: { writableRoots: string[]; hiddenPaths: string[]; gitBacked: boolean },
): Promise<RecipeWorkspacePolicyArtifactResult> {
  const checks = []
  for (const workspace of workspaceMounts.filter((mount) => mount.mode === "readwrite")) {
    checks.push({
      workspace: {
        target: workspace.target,
        mode: workspace.mode,
        metadata: workspace.metadata,
      },
      result: await checkWorkspacePolicy({
        workspaceRoot: workspace.source,
        writableRoots: policy.writableRoots,
        hiddenPaths: policy.hiddenPaths,
        gitBacked: policy.gitBacked,
      }),
    })
  }

  for (const [index, mount] of (recipe.inputs?.mounts ?? []).entries()) {
    if ((mount.mode ?? "readwrite") !== "readwrite") {
      continue
    }
    checks.push(uncheckedReadwriteInputPolicyCheck(`inputs.mounts[${index}]`, mount.target, mount.metadata))
  }

  for (const [index, stagedFile] of stagedFiles.entries()) {
    checks.push(uncheckedReadwriteInputPolicyCheck(`inputs.stagedFiles[${index}]`, stagedFile.target, stagedFile.metadata))
  }

  return {
    schema: "wp-codebox/workspace-policy-artifacts/v1",
    passed: checks.every((check) => check.result.passed),
    checks,
  }
}

function uncheckedReadwriteInputPolicyCheck(sourceField: string, target: string, metadata?: Record<string, unknown>): RecipeWorkspacePolicyArtifactResult["checks"][number] {
  return {
    workspace: {
      target,
      mode: "readwrite",
      metadata: { ...(metadata ?? {}), sourceField },
    },
    result: {
      schema: "wp-codebox/workspace-policy-result/v1",
      passed: false,
      policy_sha256: createHash("sha256").update(JSON.stringify({ sourceField, target })).digest("hex"),
      violations: [
        {
          code: "path-outside-workspace",
          path: target,
          message: `${sourceField} is mounted readwrite but is not a declared workspace policy root. Use inputs.workspaces for policy-checked writable sources or make the mount readonly.`,
          details: { sourceField, target },
        },
      ],
    },
  }
}

async function writeRecipeEvidenceJson(artifactRoot: string, path: string, value: unknown, kind: string): Promise<RecipeArtifactEvidenceFile> {
  const json = `${JSON.stringify(value, null, 2)}\n`
  await writeFile(path, json)
  return {
    path: relative(artifactRoot, path),
    sha256: artifactFileDigest(json).value,
    kind,
    contentType: "application/json",
  }
}

async function updateRecipeArtifactEvidenceReferences(artifacts: ArtifactBundle, evidenceFiles: RecipeArtifactEvidenceFile[]): Promise<void> {
  const manifest = JSON.parse(await readFile(artifacts.manifestPath, "utf8")) as ArtifactManifest
  upsertArtifactManifestFiles(manifest, evidenceFiles.map(evidenceFileToManifestFile))
  refreshManifestFileListDigest(manifest, artifacts)

  const evidence = Object.fromEntries(evidenceFiles.map((file) => [file.kind, { path: file.path, sha256: file.sha256 }]))
  const metadata = JSON.parse(await readFile(artifacts.metadataPath, "utf8")) as Record<string, unknown>
  const metadataArtifacts = isRecord(metadata.artifacts) ? metadata.artifacts : {}
  const metadataEvidence = isRecord(metadata.evidence) ? metadata.evidence : {}
  metadata.id = manifest.id
  metadata.contentDigest = manifest.contentDigest
  metadata.artifacts = { ...metadataArtifacts, runtimeEvidence: { ...(isRecord(metadataArtifacts.runtimeEvidence) ? metadataArtifacts.runtimeEvidence : {}), ...evidence } }
  metadata.evidence = { ...metadataEvidence, runtimeEvidence: { ...(isRecord(metadataEvidence.runtimeEvidence) ? metadataEvidence.runtimeEvidence : {}), ...evidence } }
  await writeFile(artifacts.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`)

  const review = JSON.parse(await readFile(artifacts.reviewPath, "utf8")) as Record<string, unknown>
  const reviewEvidence = isRecord(review.evidence) ? review.evidence : {}
  review.artifactId = manifest.id
  review.evidence = { ...reviewEvidence, artifactContentDigest: manifest.contentDigest.value, runtimeEvidence: { ...(isRecord(reviewEvidence.runtimeEvidence) ? reviewEvidence.runtimeEvidence : {}), ...evidence } }
  await writeFile(artifacts.reviewPath, `${JSON.stringify(review, null, 2)}\n`)

  await refreshManifestAfterEvidenceMutation(artifacts.directory, manifest)
  await writeFile(artifacts.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

function refreshManifestFileListDigest(manifest: ArtifactManifest, artifacts: ArtifactBundle): void {
  if (manifest.contentDigest.inputs.length !== 1 || manifest.contentDigest.inputs[0] !== "manifest.files") {
    return
  }

  const value = calculateArtifactManifestFileListDigest(manifest.files)
  manifest.contentDigest = { algorithm: "sha256", inputs: ["manifest.files"], value }
  manifest.id = `artifact-bundle-sha256-${value}`
  artifacts.id = manifest.id
  artifacts.contentDigest = value
}

async function refreshManifestAfterEvidenceMutation(artifactRoot: string, manifest: ArtifactManifest): Promise<void> {
  // Runtime reference files embed manifest hashes, then become manifest-hashed artifacts themselves.
  await refreshArtifactManifestFileSha256s(artifactRoot, manifest)
  await refreshRuntimeReferenceFiles(artifactRoot, manifest)
  await refreshArtifactManifestFileSha256s(artifactRoot, manifest)
}

async function refreshRuntimeReferenceFiles(artifactRoot: string, manifest: ArtifactManifest): Promise<void> {
  const filesByPath = new Map(manifest.files.map((file) => [file.path, file]))
  let changed = false

  for (const file of manifest.files) {
    if (file.kind !== "runtime-reference-manifest") {
      continue
    }

    const path = join(artifactRoot, file.path)
    const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
    if (value.schema !== "wp-codebox/runtime-reference-manifest/v1") {
      continue
    }

    refreshRuntimeArtifactReferences(value, filesByPath)
    value.artifactBundle = artifactBundleRef(manifest)
    const digest = runtimeReferenceManifestDigest(value as unknown as Parameters<typeof runtimeReferenceManifestDigest>[0])
    value.digest = digest
    value.id = `runtime-reference-manifest-sha256-${digest.value}`
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
    changed = true
  }

  if (changed) {
    await refreshArtifactManifestFileSha256s(artifactRoot, manifest)
    filesByPath.clear()
    for (const file of manifest.files) {
      filesByPath.set(file.path, file)
    }
  }

  for (const file of manifest.files) {
    if (file.kind !== "runtime-replay-index") {
      continue
    }

    const path = join(artifactRoot, file.path)
    const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
    if (value.schema !== "wp-codebox/runtime-replay-reference-index/v1") {
      continue
    }

    refreshRuntimeArtifactReferences(value, filesByPath)
    value.artifactBundle = artifactBundleRef(manifest)
    const digest = runtimeReplayReferenceIndexDigest(value as unknown as Parameters<typeof runtimeReplayReferenceIndexDigest>[0])
    value.digest = digest
    value.id = `runtime-replay-reference-index-sha256-${digest.value}`
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
  }
}

function refreshRuntimeArtifactReferences(value: unknown, filesByPath: Map<string, ArtifactManifestFile>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      refreshRuntimeArtifactReferences(item, filesByPath)
    }
    return
  }

  if (!isRecord(value)) {
    return
  }

  const path = typeof value.path === "string" ? value.path : undefined
  const file = path ? filesByPath.get(path) : undefined
  if (file && isRecord(file.sha256)) {
    value.kind = file.kind
    value.contentType = file.contentType
    value.sha256 = file.sha256
  }

  for (const nested of Object.values(value)) {
    refreshRuntimeArtifactReferences(nested, filesByPath)
  }
}

function artifactBundleRef(manifest: ArtifactManifest): Record<string, unknown> {
  return {
    kind: "artifact-bundle",
    id: manifest.id,
    digest: manifest.contentDigest,
  }
}

function evidenceFileToManifestFile(file: RecipeArtifactEvidenceFile): ArtifactManifestFile {
  return artifactManifestFileWithSha256(file.path, file.kind, file.contentType, file.sha256)
}

function markRecipeArtifactsFinalized(interruption: RecipeArtifactsFinalizationController | undefined, artifactsFinalized: boolean): void {
  if (!interruption?.metadata) {
    return
  }

  ;(interruption.metadata as { artifactsFinalized: boolean }).artifactsFinalized = artifactsFinalized
}
