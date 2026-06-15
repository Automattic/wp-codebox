import type { ArtifactBundle, BenchResults, ExecutionResult, RuntimeInfo, RuntimeRunRecord } from "@automattic/wp-codebox-core"
import type { RecipeDryRunOutput, RecipeDryRunSiteSeed, RecipeDryRunStagedFile } from "../recipe-dry-run.js"
import type { AgentSandboxResultSummary, AgentTaskSingleResult, RecipeReplayStatusSummary, SandboxCompletionOutcome } from "../recipe-evidence.js"
import type { RecipeValidationIssue, RecipeWorkflowPhase } from "../recipe-validation.js"
import type { RunOutput } from "../runtime-command-wrappers.js"

export interface RecipeRunOptions {
  recipePath: string
  artifactsDirectory?: string
  runRegistryDirectory?: string
  previewHoldSeconds?: number
  previewPublicUrl?: string
  previewPort?: number
  previewBind?: string
  previewHoldBlocking: boolean
  timeoutMs: number
  json: boolean
  dryRun: boolean
}

export interface RecipeValidateOptions {
  recipePath: string
  json: boolean
}

export interface RecipeValidateOutput {
  success: boolean
  schema: "wp-codebox/recipe-validation/v1"
  recipePath?: string
  valid: boolean
  issues: RecipeValidationIssue[]
  summary?: {
    steps: number
    mounts: number
    workspaces: number
    extraPlugins: number
    stagedFiles: number
  }
  error?: RunOutput["error"]
}

export interface RecipeRunOutput {
  success: boolean
  schema: "wp-codebox/recipe-run/v1"
  recipePath?: string
  runtime?: RuntimeInfo
  executions: RecipeExecutionResult[]
  stagedFiles?: RecipeRunStagedFile[]
  fixtureDatabases?: RecipeRunFixtureDatabase[]
  siteSeeds?: RecipeRunSiteSeed[]
  probes?: RecipeRunProbe[]
  declaredArtifacts?: RecipeRunDeclaredArtifact[]
  phaseEvidence?: RecipePhaseEvidence[]
  advisoryFailures?: RecipeAdvisoryFailure[]
  browserEvidence?: RecipeBrowserEvidence[]
  diagnostics?: RecipeRuntimeDiagnostic[]
  validation?: {
    issues: RecipeValidationIssue[]
  }
  benchResults?: BenchResults
  benchResultsList?: BenchResults[]
  agentResult?: AgentSandboxResultSummary
  agentTaskResult?: AgentTaskSingleResult
  completionOutcome?: SandboxCompletionOutcome
  replayStatus?: RecipeReplayStatusSummary
  artifacts?: ArtifactBundle
  run?: RuntimeRunRecord
  interruption?: RecipeInterruptionMetadata
  logs?: string[]
  error?: RunOutput["error"]
}

export type RecipeRunCommandOutput = RecipeRunOutput | RecipeDryRunOutput

export type RecipeExecutionResult = ExecutionResult & {
  recipePhase?: RecipeWorkflowPhase
  recipeStepIndex?: number
  recipeCommand?: string
  recipeAdvisory?: boolean
}

export interface RecipeAdvisoryFailure {
  schema: "wp-codebox/recipe-advisory-failure/v1"
  phase: RecipeWorkflowPhase
  index: number
  command: string
  status: "failed"
  error: RunOutput["error"]
}

export interface RecipeBrowserEvidenceFileRef {
  path: string
  kind?: string
  contentType?: string
  sha256?: { algorithm: "sha256"; value: string }
}

export interface RecipeBrowserEvidence {
  schema: "wp-codebox/recipe-browser-evidence/v1"
  phase?: RecipeWorkflowPhase
  index?: number
  command: string
  status: "completed" | "failed"
  requestedUrl?: string
  finalUrl?: string
  summaryFile?: RecipeBrowserEvidenceFileRef
  files: Record<string, RecipeBrowserEvidenceFileRef | RecipeBrowserEvidenceFileRef[]>
  summary?: unknown
  scriptResult?: unknown
}

export type RecipeArtifactPointerCommandStatus = "queued" | "running" | "completed" | "failed"

export interface RecipeArtifactPointerState {
  command?: string
  commandStatus?: RecipeArtifactPointerCommandStatus
  runtime?: RuntimeInfo
  artifacts?: ArtifactBundle
  failure?: RunOutput["error"]
  phases?: RecipePhaseEvidence[]
  browserEvidence?: RecipeBrowserEvidence[]
}

export type RecipePhaseName = "runtime_startup" | "mount_plugins" | "activate_plugins" | "run_blueprint_steps" | "import_fixture_databases" | "run_workloads" | "run_probes" | "collect_artifacts"

export interface RecipePhaseEvidence {
  schema: "wp-codebox/recipe-phase-evidence/v1"
  name: RecipePhaseName
  status: "completed" | "failed"
  startedAt: string
  endedAt: string
  durationMs: number
  data?: Record<string, unknown>
  error?: RunOutput["error"]
}

export interface RecipePluginRuntimeDiagnostic {
  schema: "wp-codebox/plugin-runtime-diagnostic/v1"
  severity: "error"
  phase: "setup" | "health-probe" | "runtime" | "overlay-preparation" | "backend-preparation"
  name?: string
  command?: string
  exitCode?: number
  message: string
  executionIndex?: number
}

export interface RecipePhpWasmRuntimeDiagnostic {
  schema: "wp-codebox/php-wasm-runtime-diagnostic/v1"
  severity: "error"
  phase: "preflight"
  message: string
  runtime?: Record<string, unknown>
  repair?: string
}

export interface RecipePhaseDiagnostic {
  schema: "wp-codebox/recipe-phase-diagnostic/v1"
  severity: "error"
  phase: RecipePhaseName
  pluginFile?: string
  command?: string
  exitCode?: number
  message: string
  executionIndex?: number
}

export type RecipeRuntimeDiagnostic = RecipePluginRuntimeDiagnostic | RecipePhaseDiagnostic | RecipePhpWasmRuntimeDiagnostic

export interface RecipeRunSiteSeed extends Omit<RecipeDryRunSiteSeed, "dryRunOnly"> {
  action: "imported" | "skipped"
  reason?: string
  counts?: Record<string, number>
  warnings?: string[]
  provenance?: Record<string, unknown>
}

export interface RecipeRunStagedFile extends RecipeDryRunStagedFile {
  action: "staged"
}

export interface RecipeRunFixtureDatabase {
  schema: "wp-codebox/fixture-database-result/v1"
  index: number
  name: string
  version: string
  source: string
  format: "sql"
  action: "imported" | "skipped"
  reset: {
    strategy: "none" | "truncate-tables"
    tables: string[]
  }
  identity: {
    name: string
    version: string
    sourceSha256: string
  }
  counts?: Record<string, number>
  metadata?: Record<string, unknown>
}

export interface RecipeRunProbe {
  schema: "wp-codebox/recipe-probe-result/v1"
  index: number
  name: string
  status: "passed" | "failed"
  command: string
  args: string[]
  exitCode: number
  stdout: string
  stderr: string
  parsedJson?: unknown
  allowFailure: boolean
  metadata?: Record<string, unknown>
}

export interface RecipeRunDeclaredArtifact {
  schema: "wp-codebox/recipe-declared-artifact-result/v1"
  index: number
  name: string
  path: string
  required: boolean
  status: "collected" | "missing" | "failed"
  exists: boolean
  type?: "file" | "directory" | "other"
  size?: number
  sha256?: string
  parsedJson?: unknown
  metadata?: Record<string, unknown>
  error?: RunOutput["error"]
}

export type RecipeInterruptionSignal = "SIGINT" | "SIGTERM" | "SIGHUP"
export type RecipeInterruptionReason = "signal" | "parent-disconnect" | "stdio-closed"

export interface RecipeInterruptionMetadata {
  signal: RecipeInterruptionSignal
  reason: RecipeInterruptionReason
  receivedAt: string
  artifactsFinalized: boolean
}

export interface RecipeInterruptionController {
  readonly metadata: RecipeInterruptionMetadata | undefined
  install(): void
  dispose(): void
  interruptible<T>(promise: Promise<T>): Promise<T>
  throwIfInterrupted(): void
  propagateIfInterrupted(): void
  clear(): void
}
