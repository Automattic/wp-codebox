import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import type { ArtifactBundle, ArtifactPreview, RuntimeInfo } from "./runtime-contracts.js"
import { stripUndefined } from "./object-utils.js"

export type RuntimeRunStatus = "queued" | "booting" | "running" | "collecting_artifacts" | "succeeded" | "failed" | "timed_out" | "cancelled"

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

export interface RuntimeRunRecord {
  schema: "wp-codebox/run-registry-entry/v1"
  runId: string
  status: RuntimeRunStatus
  createdAt: string
  updatedAt: string
  heartbeatAt: string
  runtime?: RuntimeInfo
  preview?: ArtifactPreview
  metadata?: Record<string, unknown>
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
  retention?: RuntimeRunRetention
  replay?: RuntimeRunReplay
  artifactRefs?: RuntimeRunArtifactRef[]
  error?: RuntimeRunRecord["error"]
  heartbeat?: boolean
  now?: Date
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
      createdAt: now,
      updatedAt: now,
      heartbeatAt: now,
      artifactRefs: options.artifactRefs ?? [],
      ...stripUndefined({
        runtime: options.runtime,
        preview: options.preview,
        metadata: sanitizeRunMetadata(options.metadata),
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
    const next: RuntimeRunRecord = {
      ...current,
      status: update.status ?? current.status,
      ...(update.runtime ? { runtime: update.runtime } : {}),
      ...(update.preview ? { preview: update.preview } : {}),
      ...(update.metadata ? { metadata: sanitizeRunMetadata({ ...(current.metadata ?? {}), ...update.metadata }) } : {}),
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
      digest: bundle.contentDigest ? { algorithm: "sha256" as const, value: bundle.contentDigest } : undefined,
    }),
  ]
}

export function defaultRunRegistryDirectory(artifactsDirectory: string | undefined, cwd = process.cwd()): string {
  return resolve(artifactsDirectory ?? join(cwd, "artifacts"), "runs")
}

function sanitizeRunMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) {
    return undefined
  }

  return sanitizeValue(metadata) as Record<string, unknown>
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeValue)
  }

  if (!value || typeof value !== "object") {
    return value
  }

  const sanitized: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (isSensitiveMetadataKey(key)) {
      sanitized[key] = "[redacted]"
    } else {
      sanitized[key] = sanitizeValue(child)
    }
  }
  return sanitized
}

function isSensitiveMetadataKey(key: string): boolean {
  return /secret|token|credential|password|api[_-]?key/i.test(key)
}

function assertSafeRunId(runId: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(runId)) {
    throw new Error(`Invalid run id: ${runId}`)
  }
}
