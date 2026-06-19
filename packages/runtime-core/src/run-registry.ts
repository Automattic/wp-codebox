import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import type { ArtifactBundle, ArtifactPreview, RuntimeInfo } from "./runtime-contracts.js"
import type { RecipeRunSummary } from "./recipe-run-summary.js"
import { normalizeArtifactDigest } from "./artifact-references.js"
import { stripUndefined } from "./object-utils.js"
import { redactJsonValue } from "./redaction.js"

export type RuntimeRunStatus = "queued" | "booting" | "running" | "collecting_artifacts" | "succeeded" | "failed" | "timed_out" | "cancelled"
export const RUNTIME_RUN_RESULT_SCHEMA = "wp-codebox/runtime-run-result/v1" as const

export type RuntimeRunLifecyclePhase = "pending" | "active" | "finalizing" | "terminal"
export type RuntimeRunLifecycleOutcome = "succeeded" | "failed" | "timed_out" | "cancelled"
export type RuntimeRunCleanupStatus = "not_started" | "running" | "succeeded" | "failed"

export interface RuntimeRunCleanupState {
  status: RuntimeRunCleanupStatus
  attempts: number
  startedAt?: string
  updatedAt?: string
  completedAt?: string
  error?: RuntimeRunRecord["error"]
}

export interface RuntimeRunLifecycle {
  schema: "wp-codebox/run-lifecycle/v1"
  status: RuntimeRunStatus
  phase: RuntimeRunLifecyclePhase
  terminal: boolean
  cancellable: boolean
  cancelRequested: boolean
  cancellation?: RuntimeRunCancellationState
  successful: boolean
  failed: boolean
  cancelled: boolean
  outcome?: RuntimeRunLifecycleOutcome
  cleanup: RuntimeRunCleanupState
}

export interface RuntimeRunCancellationState {
  requestedAt: string
  reason?: string
}

export interface RuntimeRunArtifactRef {
  kind: "artifact-bundle" | "command-log" | "transcript" | (string & {})
  path?: string
  directory?: string
  id?: string
  digest?: {
    algorithm: "sha256" | (string & {})
    value: string
  }
}

export interface RuntimeRunRetention {
  cleanupEligibleAt?: string
  retainUntil?: string
  retained?: boolean
  reason?: string
}

export interface RuntimeRunReplay {
  command?: string[]
  recipePath?: string
  ref?: string
}

export interface RuntimeRunResult {
  schema: typeof RUNTIME_RUN_RESULT_SCHEMA
  kind: "recipe-run" | (string & {})
  success: boolean
  status: string
  summary?: RecipeRunSummary
  artifacts: RecipeRunSummary["artifacts"]
  refs?: RecipeRunSummary["refs"]
  metadata: Record<string, unknown>
}

export interface RuntimeRunRecord {
  schema: "wp-codebox/run-registry-entry/v1"
  runId: string
  status: RuntimeRunStatus
  lifecycle: RuntimeRunLifecycle
  createdAt: string
  updatedAt: string
  heartbeatAt: string
  runtime?: RuntimeInfo
  preview?: ArtifactPreview
  metadata?: Record<string, unknown>
  result?: RuntimeRunResult
  artifactRefs: RuntimeRunArtifactRef[]
  retention?: RuntimeRunRetention
  replay?: RuntimeRunReplay
  error?: {
    name: string
    message: string
    code?: string
  }
}

export interface RuntimeRunRegistryCreateOptions {
  runId?: string
  status?: RuntimeRunStatus
  runtime?: RuntimeInfo
  preview?: ArtifactPreview
  metadata?: Record<string, unknown>
  result?: RuntimeRunResult
  retention?: RuntimeRunRetention
  replay?: RuntimeRunReplay
  artifactRefs?: RuntimeRunArtifactRef[]
  now?: Date
}

export interface RuntimeRunRegistryUpdate {
  status?: RuntimeRunStatus
  runtime?: RuntimeInfo
  preview?: ArtifactPreview
  metadata?: Record<string, unknown>
  result?: RuntimeRunResult
  retention?: RuntimeRunRetention
  replay?: RuntimeRunReplay
  artifactRefs?: RuntimeRunArtifactRef[]
  error?: RuntimeRunRecord["error"]
  cleanup?: RuntimeRunCleanupUpdate
  heartbeat?: boolean
  now?: Date
}

export interface RuntimeRunCancellationRequestOptions {
  reason?: string
  now?: Date
}

export interface RuntimeRunCancellationRequestResult {
  schema: "wp-codebox/run-cancellation-request/v1"
  runId: string
  status: RuntimeRunStatus
  cancellationRequested: boolean
  alreadyRequested: boolean
  terminal: boolean
  record: RuntimeRunRecord
}

export interface RuntimeRunCleanupUpdate {
  status: RuntimeRunCleanupStatus
  error?: RuntimeRunRecord["error"]
}

const runtimeRunStatusTransitions: Record<RuntimeRunStatus, readonly RuntimeRunStatus[]> = {
  queued: ["booting", "running", "collecting_artifacts", "cancelled", "failed", "timed_out"],
  booting: ["running", "collecting_artifacts", "cancelled", "failed", "timed_out"],
  running: ["collecting_artifacts", "succeeded", "cancelled", "failed", "timed_out"],
  collecting_artifacts: ["succeeded", "cancelled", "failed", "timed_out"],
  succeeded: [],
  failed: [],
  timed_out: [],
  cancelled: [],
}

export class RuntimeRunRegistry {
  readonly directory: string

  constructor(directory: string) {
    this.directory = resolve(directory)
  }

  async create(options: RuntimeRunRegistryCreateOptions = {}): Promise<RuntimeRunRecord> {
    const now = (options.now ?? new Date()).toISOString()
    const record: RuntimeRunRecord = {
      schema: "wp-codebox/run-registry-entry/v1",
      runId: options.runId ?? createRuntimeRunId(),
      status: options.status ?? "queued",
      lifecycle: buildRuntimeRunLifecycle(options.status ?? "queued", initialRuntimeRunCleanup()),
      createdAt: now,
      updatedAt: now,
      heartbeatAt: now,
      artifactRefs: options.artifactRefs ?? [],
      ...stripUndefined({
        runtime: options.runtime,
        preview: options.preview,
        metadata: sanitizeRunMetadata(options.metadata),
        result: options.result,
        retention: options.retention,
        replay: options.replay,
      }),
    }
    await this.write(record)
    return record
  }

  async read(runId: string): Promise<RuntimeRunRecord> {
    return JSON.parse(await readFile(this.recordPath(runId), "utf8")) as RuntimeRunRecord
  }

  async update(runId: string, update: RuntimeRunRegistryUpdate): Promise<RuntimeRunRecord> {
    const current = await this.read(runId)
    const now = (update.now ?? new Date()).toISOString()
    const status = transitionRuntimeRunStatus(current.status, update.status)
    const cleanup = update.cleanup ? updateRuntimeRunCleanup(current.lifecycle?.cleanup, update.cleanup, now) : current.lifecycle?.cleanup ?? initialRuntimeRunCleanup()
    const cancellation = current.lifecycle?.cancellation
    const next: RuntimeRunRecord = {
      ...current,
      status,
      lifecycle: buildRuntimeRunLifecycle(status, cleanup, cancellation),
      ...(update.runtime ? { runtime: update.runtime } : {}),
      ...(update.preview ? { preview: update.preview } : {}),
      ...(update.metadata ? { metadata: sanitizeRunMetadata({ ...(current.metadata ?? {}), ...update.metadata }) } : {}),
      ...(update.result ? { result: update.result } : {}),
      ...(update.retention ? { retention: update.retention } : {}),
      ...(update.replay ? { replay: update.replay } : {}),
      ...(update.artifactRefs ? { artifactRefs: update.artifactRefs } : {}),
      ...(update.error ? { error: update.error } : {}),
      updatedAt: now,
      heartbeatAt: update.heartbeat === false ? current.heartbeatAt : now,
    }
    await this.write(next)
    return next
  }

  async requestCancellation(runId: string, options: RuntimeRunCancellationRequestOptions = {}): Promise<RuntimeRunCancellationRequestResult> {
    const current = await this.read(runId)
    const terminal = isTerminalRuntimeRunStatus(current.status)
    const existingCancellation = current.lifecycle?.cancellation
    if (terminal || existingCancellation) {
      return {
        schema: "wp-codebox/run-cancellation-request/v1",
        runId: current.runId,
        status: current.status,
        cancellationRequested: Boolean(existingCancellation),
        alreadyRequested: Boolean(existingCancellation),
        terminal,
        record: current,
      }
    }

    const now = (options.now ?? new Date()).toISOString()
    const cancellation = stripUndefined({
      requestedAt: now,
      reason: options.reason,
    }) as RuntimeRunCancellationState
    const next: RuntimeRunRecord = {
      ...current,
      lifecycle: buildRuntimeRunLifecycle(current.status, current.lifecycle?.cleanup ?? initialRuntimeRunCleanup(), cancellation),
      updatedAt: now,
    }
    await this.write(next)
    return {
      schema: "wp-codebox/run-cancellation-request/v1",
      runId: next.runId,
      status: next.status,
      cancellationRequested: true,
      alreadyRequested: false,
      terminal: false,
      record: next,
    }
  }

  async heartbeat(runId: string, now = new Date()): Promise<RuntimeRunRecord> {
    return this.update(runId, { now, heartbeat: true })
  }

  recordPath(runId: string): string {
    assertSafeRunId(runId)
    return join(this.directory, `${runId}.json`)
  }

  private async write(record: RuntimeRunRecord): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    const target = this.recordPath(record.runId)
    const temp = join(dirname(target), `.${record.runId}.${process.pid}.tmp`)
    await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`)
    await rename(temp, target)
  }
}

export function buildRuntimeRunLifecycle(status: RuntimeRunStatus, cleanup: RuntimeRunCleanupState = initialRuntimeRunCleanup(), cancellation?: RuntimeRunCancellationState): RuntimeRunLifecycle {
  const terminal = isTerminalRuntimeRunStatus(status)
  return {
    schema: "wp-codebox/run-lifecycle/v1",
    status,
    phase: runtimeRunLifecyclePhase(status),
    terminal,
    cancellable: !terminal,
    cancelRequested: Boolean(cancellation),
    ...(cancellation ? { cancellation } : {}),
    successful: status === "succeeded",
    failed: status === "failed" || status === "timed_out",
    cancelled: status === "cancelled",
    ...(terminal ? { outcome: status as RuntimeRunLifecycleOutcome } : {}),
    cleanup,
  }
}

export function transitionRuntimeRunStatus(current: RuntimeRunStatus, next = current): RuntimeRunStatus {
  if (current === next) {
    return current
  }

  if (isTerminalRuntimeRunStatus(current)) {
    throw new Error(`Cannot transition terminal runtime run status from ${current} to ${next}`)
  }

  if (!runtimeRunStatusTransitions[current].includes(next)) {
    throw new Error(`Invalid runtime run status transition from ${current} to ${next}`)
  }

  return next
}

function initialRuntimeRunCleanup(): RuntimeRunCleanupState {
  return {
    status: "not_started",
    attempts: 0,
  }
}

function updateRuntimeRunCleanup(current: RuntimeRunCleanupState | undefined, update: RuntimeRunCleanupUpdate, now: string): RuntimeRunCleanupState {
  const previous = current ?? initialRuntimeRunCleanup()
  const attempts = update.status === "running" ? previous.attempts + 1 : previous.attempts
  return stripUndefined({
    ...previous,
    status: update.status,
    attempts,
    startedAt: update.status === "running" ? now : previous.startedAt,
    updatedAt: now,
    completedAt: update.status === "succeeded" || update.status === "failed" ? now : previous.completedAt,
    error: update.error,
  }) as RuntimeRunCleanupState
}

function runtimeRunLifecyclePhase(status: RuntimeRunStatus): RuntimeRunLifecyclePhase {
  if (isTerminalRuntimeRunStatus(status)) {
    return "terminal"
  }

  if (status === "collecting_artifacts") {
    return "finalizing"
  }

  if (status === "queued") {
    return "pending"
  }

  return "active"
}

function isTerminalRuntimeRunStatus(status: RuntimeRunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "timed_out" || status === "cancelled"
}

export function createRuntimeRunId(): string {
  return `run_${randomUUID().replaceAll("-", "")}`
}

export function artifactBundleRunRef(bundle: ArtifactBundle | undefined): RuntimeRunArtifactRef[] {
  if (!bundle) {
    return []
  }

  return [
    stripUndefined({
      kind: "artifact-bundle" as const,
      directory: bundle.directory,
      id: bundle.id,
      digest: normalizeArtifactDigest(bundle.contentDigest),
    }),
    ...(bundle.previewSessionEvidenceRef ? [stripUndefined({
      kind: bundle.previewSessionEvidenceRef.kind,
      path: bundle.previewSessionEvidenceRef.path,
      id: `${bundle.id}:preview-session-evidence`,
      digest: normalizeArtifactDigest(bundle.previewSessionEvidenceRef.sha256),
    })] : []),
  ]
}

export function runtimeRunResultFromRecipeSummary(summary: RecipeRunSummary): RuntimeRunResult {
  return {
    schema: RUNTIME_RUN_RESULT_SCHEMA,
    kind: "recipe-run",
    success: summary.success,
    status: summary.status,
    summary,
    artifacts: summary.artifacts,
    refs: summary.refs,
    metadata: summary.metadata,
  }
}

export function defaultRunRegistryDirectory(artifactsDirectory: string | undefined, cwd = process.cwd()): string {
  return resolve(artifactsDirectory ?? join(cwd, "artifacts"), "runs")
}

function sanitizeRunMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) {
    return undefined
  }

  return redactJsonValue(metadata, { redactStrings: false, pattern: /secret|token|credential|password|api[_-]?key/i }) as Record<string, unknown>
}

function assertSafeRunId(runId: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(runId)) {
    throw new Error(`Invalid run id: ${runId}`)
  }
}
