import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { artifactFileDigest, artifactManifestFileWithSha256, checkWorkspacePolicy, isPlainObject as isRecord, refreshArtifactManifestFileSha256s, sha256StableJson, stripUndefined, upsertArtifactManifestFiles, verifyArtifactBundle, type ArtifactBundle, type ArtifactBundleVerificationResult, type ArtifactManifest, type ArtifactManifestFile, type ExecutionResult, type Runtime, type RuntimeInfo, type RuntimePolicy, type WorkspacePolicyResult, type WorkspaceRecipe } from "@automattic/wp-codebox-core"

export interface RecipeArtifactEvidenceFile {
  path: string
  sha256: string
  kind: string
  contentType: string
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
  completionOutcome?: SandboxCompletionOutcome & {
    artifact: RecipeArtifactEvidenceFile
  }
  transcript?: AgentSandboxTranscript & {
    artifact: RecipeArtifactEvidenceFile
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
    secrets: Array<{ name: string; status: "available"; source: "recipe-secret-env" }>
    redaction: "names-only"
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

const DEFAULT_WORDPRESS_VERSION = "7.0"
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
  secretEnv: Record<string, string>
  executions: RecipeEvidenceExecutionResult[]
  interruption?: RecipeArtifactsFinalizationController
}): Promise<ArtifactBundle | undefined> {
  let artifacts = args.existingArtifacts

  if (!artifacts) {
    try {
      artifacts = await args.runtime.collectArtifacts({ includeLogs: true, includeObservations: true })
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

export async function finalizeRecipeArtifactEvidence(
  artifacts: ArtifactBundle,
  recipe: WorkspaceRecipe,
  workspaceMounts: RecipeEvidenceWorkspaceMount[],
  stagedFiles: RecipeEvidenceStagedFile[],
  policy: RuntimePolicy,
  secretEnv: Record<string, string>,
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

  await updateRecipeArtifactEvidenceReferences(artifacts, evidenceFiles)
  return result
}

export async function finalizeAgentSandboxEvidence(artifacts: ArtifactBundle, executions: RecipeEvidenceExecutionResult[]): Promise<Pick<RecipeArtifactEvidenceResult, "agentResult" | "completionOutcome" | "transcript">> {
  const transcript = buildAgentSandboxTranscript(executions)
  if (transcript.executions.length === 0) {
    return {}
  }

  const transcriptPath = join(dirname(artifacts.reviewPath), "transcript.json")
  const agentResultPath = join(dirname(artifacts.reviewPath), "agent-result.json")
  const completionOutcomePath = join(dirname(artifacts.reviewPath), "completion-outcome.json")
  const transcriptFile = await writeRecipeEvidenceJson(artifacts.directory, transcriptPath, transcript, "agent-transcript")
  const agentResult = await buildAgentSandboxResultSummary(artifacts, transcript, transcriptFile.path)
  const agentResultFile = await writeRecipeEvidenceJson(artifacts.directory, agentResultPath, agentResult, "agent-result")
  const completionOutcome = buildSandboxCompletionOutcome(artifacts, agentResult, transcript)
  const completionOutcomeFile = await writeRecipeEvidenceJson(artifacts.directory, completionOutcomePath, completionOutcome, "completion-outcome")
  await updateRecipeArtifactEvidenceReferences(artifacts, [agentResultFile, completionOutcomeFile, transcriptFile])

  return {
    agentResult: { ...agentResult, artifact: agentResultFile },
    completionOutcome: { ...completionOutcome, artifact: completionOutcomeFile },
    transcript: { ...transcript, artifact: transcriptFile },
  }
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
  const directFailure = agentRuntimeFailureFromRecord(parsed)
  if (directFailure) {
    return directFailure
  }

  const output = typeof parsed?.output === "string" ? decodeJsonFragment(parsed.output) : undefined
  return agentRuntimeFailureFromRecord(isRecord(output) ? output : undefined)
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

export function recipeCompletionOutcomeOutput(completionOutcome: RecipeArtifactEvidenceResult["completionOutcome"]): SandboxCompletionOutcome | undefined {
  if (!completionOutcome) {
    return undefined
  }

  const { artifact: _artifact, ...result } = completionOutcome
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
  secretEnv: Record<string, string>
  workspacePolicy: { enabled: boolean; strict: boolean }
  verifier: { enabled: boolean; strict: boolean }
  workspacePolicyFile?: RecipeArtifactEvidenceFile
  artifactVerificationFile?: RecipeArtifactEvidenceFile
}): Promise<RecipeRunAttestation> {
  const manifest = JSON.parse(await readFile(args.artifacts.manifestPath, "utf8")) as { runtime?: RuntimeInfo }
  const runtime = manifest.runtime ?? {
    id: "unknown",
    backend: args.recipe.runtime?.backend ?? "wordpress-playground",
    environment: {
      kind: "wordpress",
      name: args.recipe.runtime?.name ?? "wp-codebox-recipe",
      version: args.recipe.runtime?.wp ?? DEFAULT_WORDPRESS_VERSION,
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
      provided: Object.keys(args.secretEnv).length > 0,
      count: Object.keys(args.secretEnv).length,
      secrets: Object.keys(args.secretEnv).sort().map((name) => ({ name, status: "available", source: "recipe-secret-env" })),
      redaction: "names-only",
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

  const evidence = Object.fromEntries(evidenceFiles.map((file) => [file.kind, { path: file.path, sha256: file.sha256 }]))
  const metadata = JSON.parse(await readFile(artifacts.metadataPath, "utf8")) as Record<string, unknown>
  const metadataArtifacts = isRecord(metadata.artifacts) ? metadata.artifacts : {}
  const metadataEvidence = isRecord(metadata.evidence) ? metadata.evidence : {}
  metadata.artifacts = { ...metadataArtifacts, runtimeEvidence: { ...(isRecord(metadataArtifacts.runtimeEvidence) ? metadataArtifacts.runtimeEvidence : {}), ...evidence } }
  metadata.evidence = { ...metadataEvidence, runtimeEvidence: { ...(isRecord(metadataEvidence.runtimeEvidence) ? metadataEvidence.runtimeEvidence : {}), ...evidence } }
  await writeFile(artifacts.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`)

  const review = JSON.parse(await readFile(artifacts.reviewPath, "utf8")) as Record<string, unknown>
  const reviewEvidence = isRecord(review.evidence) ? review.evidence : {}
  review.evidence = { ...reviewEvidence, runtimeEvidence: { ...(isRecord(reviewEvidence.runtimeEvidence) ? reviewEvidence.runtimeEvidence : {}), ...evidence } }
  await writeFile(artifacts.reviewPath, `${JSON.stringify(review, null, 2)}\n`)

  await refreshArtifactManifestFileSha256s(artifacts.directory, manifest)
  await writeFile(artifacts.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
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
