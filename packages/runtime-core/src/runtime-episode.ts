import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { refreshArtifactManifestFileSha256s, upsertArtifactManifestFiles } from "./artifact-manifest.js"
import type { ArtifactManifest, ArtifactManifestFile } from "./artifact-manifest.js"
import { isPlainObject as isRecord, stableJson } from "./object-utils.js"
import { buildRuntimeReferenceManifest, buildRuntimeReplayReferenceIndex } from "./runtime-reference.js"
import type { RuntimeReferenceManifestSnapshotRef } from "./runtime-reference.js"
import { assertRuntimePolicy } from "./runtime-policy.js"
import type {
  ArtifactBundle,
  ArtifactReview,
  ArtifactSpec,
  ObservationResult,
  ObservationSpec,
  Runtime,
  RuntimeBackend,
  RuntimeEpisode,
  RuntimeEpisodeActionRecord,
  RuntimeEpisodeActionSpec,
  RuntimeEpisodeContentDigest,
  RuntimeEpisodeResetResult,
  RuntimeEpisodeSpec,
  RuntimeEpisodeStepResult,
  RuntimeEpisodeTrace,
  RuntimeEpisodeTraceRef,
  RuntimeEpisodeTraceValidationIssue,
  RuntimeEpisodeTraceValidationResult,
  Snapshot,
} from "./index.js"

export const RUNTIME_EPISODE_TRACE_SCHEMA = "wp-codebox/runtime-episode-trace/v1" as const
export const RUNTIME_EPISODE_ACTION_SCHEMA = "wp-codebox/runtime-episode-action/v1" as const
export const RUNTIME_EPISODE_OBSERVATION_SCHEMA = "wp-codebox/runtime-episode-observation/v1" as const
export const RUNTIME_EPISODE_SNAPSHOT_SCHEMA = "wp-codebox/runtime-episode-snapshot/v1" as const

export const RUNTIME_EPISODE_TRACE_JSON_SCHEMA = {
  $id: RUNTIME_EPISODE_TRACE_SCHEMA,
  type: "object",
  required: ["schema", "version", "id", "createdAt", "runtime", "reset", "steps", "snapshots"],
  properties: {
    schema: { const: RUNTIME_EPISODE_TRACE_SCHEMA },
    version: { const: 1 },
    id: { type: "string", minLength: 1 },
    createdAt: { type: "string", minLength: 1 },
    runtime: { type: "object", required: ["id", "backend", "environment", "createdAt", "status"] },
    reset: { type: "object", required: ["id", "runtime", "observations", "observationRefs"] },
    steps: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "index", "action", "actionRef", "execution", "executionRef"],
        properties: {
          action: {
            type: "object",
            required: ["schema", "id", "kind", "command", "args", "digest"],
            properties: {
              schema: { const: RUNTIME_EPISODE_ACTION_SCHEMA },
              id: { type: "string", minLength: 1 },
              kind: { enum: ["command", "filesystem", "http", "browser"] },
              command: { type: "string", minLength: 1 },
              args: { type: "array", items: { type: "string" } },
              cwd: { type: "string" },
              timeoutMs: { type: "number", minimum: 0 },
              method: { type: "string", minLength: 1 },
              url: { type: "string", minLength: 1 },
              path: { type: "string", minLength: 1 },
              operation: { type: "string", minLength: 1 },
              selector: { type: "string", minLength: 1 },
              description: { type: "string", minLength: 1 },
              metadata: { type: "object" },
              digest: {
                type: "object",
                required: ["algorithm", "value"],
                properties: {
                  algorithm: { const: "sha256" },
                  value: { type: "string", pattern: "^[a-f0-9]{64}$" },
                },
                additionalProperties: false,
              },
            },
            additionalProperties: false,
          },
          observation: {
            type: "object",
            required: ["schema", "id", "type", "data", "observedAt", "digest"],
          },
        },
      },
    },
    snapshots: {
      type: "array",
      items: { type: "object", required: ["schema", "id", "createdAt", "semantics", "metadata", "digest"] },
    },
    artifacts: { type: "object" },
    artifactRef: { type: "object", required: ["kind", "id"] },
  },
  additionalProperties: true,
} as const

const RUNTIME_EPISODE_TRACE_FORBIDDEN_FIELDS = new Set([
  "reward",
  "success",
  "grader",
  "scenario",
  "task-set",
  "task_set",
  "taskSet",
  "benchmark",
  "model-eval",
  "model_eval",
  "modelEval",
])

export function runtimeEpisodeDigest(value: unknown): RuntimeEpisodeContentDigest {
  return {
    algorithm: "sha256",
    value: createHash("sha256").update("wp-codebox/runtime-episode-trace/v1\n").update(stableJson(value)).digest("hex"),
  }
}

function runtimeEpisodeActionDigestPayload(action: RuntimeEpisodeActionRecord | RuntimeEpisodeActionSpec): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    schema: RUNTIME_EPISODE_ACTION_SCHEMA,
    kind: action.kind ?? "command",
    command: action.command,
    args: Array.isArray(action.args) ? action.args : [],
  }

  for (const key of ["cwd", "method", "url", "path", "operation", "selector", "description"] as const) {
    if (typeof action[key] === "string") {
      payload[key] = action[key]
    }
  }
  if (typeof action.timeoutMs === "number") {
    payload.timeoutMs = action.timeoutMs
  }
  if (isRecord(action.metadata)) {
    payload.metadata = action.metadata
  }

  return payload
}

function runtimeEpisodeObservationDigestPayload(observation: ObservationResult): Record<string, unknown> {
  return {
    schema: RUNTIME_EPISODE_OBSERVATION_SCHEMA,
    type: observation.type,
    data: observation.data,
    observedAt: observation.observedAt,
    artifactRefs: observation.artifactRefs ?? [],
  }
}

function runtimeEpisodeSnapshotDigestPayload(snapshot: Snapshot): Record<string, unknown> {
  return {
    schema: RUNTIME_EPISODE_SNAPSHOT_SCHEMA,
    id: snapshot.id,
    createdAt: snapshot.createdAt,
    semantics: snapshot.semantics,
    metadata: snapshot.metadata,
    artifactRefs: snapshot.artifactRefs ?? [],
  }
}

export function validateRuntimeEpisodeTrace(trace: unknown): RuntimeEpisodeTraceValidationResult {
  const issues: RuntimeEpisodeTraceValidationIssue[] = []
  const candidate = trace as Partial<RuntimeEpisodeTrace> | null

  if (!candidate || typeof candidate !== "object") {
    return { valid: false, schema: RUNTIME_EPISODE_TRACE_SCHEMA, issues: [{ path: "$", message: "trace must be an object" }] }
  }

  if (candidate.schema !== RUNTIME_EPISODE_TRACE_SCHEMA) {
    issues.push({ path: "$.schema", message: `schema must be ${RUNTIME_EPISODE_TRACE_SCHEMA}` })
  }
  if (candidate.version !== 1) {
    issues.push({ path: "$.version", message: "version must be 1" })
  }
  if (!nonEmptyString(candidate.id)) {
    issues.push({ path: "$.id", message: "id must be a non-empty string" })
  }
  if (!nonEmptyString(candidate.createdAt)) {
    issues.push({ path: "$.createdAt", message: "createdAt must be a non-empty string" })
  }
  if (!candidate.runtime || typeof candidate.runtime !== "object" || !nonEmptyString(candidate.runtime.id)) {
    issues.push({ path: "$.runtime.id", message: "runtime id is required" })
  }
  if (!candidate.reset || typeof candidate.reset !== "object" || !nonEmptyString(candidate.reset.id)) {
    issues.push({ path: "$.reset.id", message: "reset id is required" })
  }
  if (!Array.isArray(candidate.reset?.observations)) {
    issues.push({ path: "$.reset.observations", message: "reset observations must be an array" })
  } else {
    candidate.reset.observations.forEach((observation, index) => {
      validateRuntimeEpisodeObservation(observation, `$.reset.observations[${index}]`, issues)
    })
  }
  if (!Array.isArray(candidate.reset?.observationRefs)) {
    issues.push({ path: "$.reset.observationRefs", message: "reset observationRefs must be an array" })
  } else {
    candidate.reset.observationRefs.forEach((ref, index) => {
      validateRuntimeEpisodeTraceRef(ref, `$.reset.observationRefs[${index}]`, "observation", issues)
      const observation = candidate.reset?.observations?.[index]
      if (observation) {
        validateRuntimeEpisodeRefDigest(ref, observation.digest, `$.reset.observationRefs[${index}]`, issues)
      }
    })
  }
  if (!Array.isArray(candidate.steps)) {
    issues.push({ path: "$.steps", message: "steps must be an array" })
  } else {
    candidate.steps.forEach((step, index) => validateRuntimeEpisodeStep(step, index, issues))
  }
  if (!Array.isArray(candidate.snapshots)) {
    issues.push({ path: "$.snapshots", message: "snapshots must be an array" })
  } else {
    candidate.snapshots.forEach((snapshot, index) => validateRuntimeEpisodeSnapshot(snapshot, `$.snapshots[${index}]`, issues))
  }

  collectForbiddenRuntimeEpisodeTraceFields(candidate, "$", issues)

  return { valid: issues.length === 0, schema: RUNTIME_EPISODE_TRACE_SCHEMA, issues }
}

function validateRuntimeEpisodeStep(
  step: RuntimeEpisodeStepResult,
  index: number,
  issues: RuntimeEpisodeTraceValidationIssue[],
): void {
  const path = `$.steps[${index}]`
  if (!nonEmptyString(step.id)) {
    issues.push({ path: `${path}.id`, message: "step id is required" })
  }
  if (step.index !== index) {
    issues.push({ path: `${path}.index`, message: "step index must match array position" })
  }
  if (!nonEmptyString(step.action?.id)) {
    issues.push({ path: `${path}.action.id`, message: "action id is required" })
  } else {
    validateRuntimeEpisodeAction(step.action, `${path}.action`, issues)
  }
  if (!nonEmptyString(step.actionRef?.id)) {
    issues.push({ path: `${path}.actionRef.id`, message: "actionRef id is required" })
  } else {
    validateRuntimeEpisodeTraceRef(step.actionRef, `${path}.actionRef`, "action", issues)
    validateRuntimeEpisodeRefDigest(step.actionRef, step.action?.digest, `${path}.actionRef`, issues)
  }
  if (!nonEmptyString(step.execution?.id)) {
    issues.push({ path: `${path}.execution.id`, message: "execution id is required" })
  }
  if (!nonEmptyString(step.executionRef?.id)) {
    issues.push({ path: `${path}.executionRef.id`, message: "executionRef id is required" })
  } else {
    validateRuntimeEpisodeTraceRef(step.executionRef, `${path}.executionRef`, "execution", issues)
    validateRuntimeEpisodeRefDigest(step.executionRef, step.execution ? runtimeEpisodeDigest(step.execution) : undefined, `${path}.executionRef`, issues)
  }
  if (step.observation && !nonEmptyString(step.observation.id)) {
    issues.push({ path: `${path}.observation.id`, message: "observation id is required" })
  } else if (step.observation) {
    validateRuntimeEpisodeObservation(step.observation, `${path}.observation`, issues)
  }
  if (step.observationRef) {
    validateRuntimeEpisodeTraceRef(step.observationRef, `${path}.observationRef`, "observation", issues)
    if (step.observation) {
      validateRuntimeEpisodeRefDigest(step.observationRef, step.observation.digest, `${path}.observationRef`, issues)
    }
  }
}

function validateRuntimeEpisodeAction(
  action: RuntimeEpisodeActionRecord | unknown,
  path: string,
  issues: RuntimeEpisodeTraceValidationIssue[],
): void {
  if (!isRecord(action)) {
    issues.push({ path, message: "action must be an object" })
    return
  }

  if (action.schema !== RUNTIME_EPISODE_ACTION_SCHEMA) {
    issues.push({ path: `${path}.schema`, message: `action schema must be ${RUNTIME_EPISODE_ACTION_SCHEMA}` })
  }
  if (!["command", "filesystem", "http", "browser"].includes(`${action.kind}`)) {
    issues.push({ path: `${path}.kind`, message: "action kind must be command, filesystem, http, or browser" })
  }
  if (!nonEmptyString(action.command)) {
    issues.push({ path: `${path}.command`, message: "action command is required" })
  }
  if (!Array.isArray(action.args) || !action.args.every((arg) => typeof arg === "string")) {
    issues.push({ path: `${path}.args`, message: "action args must be an array of strings" })
  }
  if (action.cwd !== undefined && typeof action.cwd !== "string") {
    issues.push({ path: `${path}.cwd`, message: "action cwd must be a string when present" })
  }
  for (const key of ["method", "url", "path", "operation", "selector", "description"] as const) {
    if (action[key] !== undefined && !nonEmptyString(action[key])) {
      issues.push({ path: `${path}.${key}`, message: `action ${key} must be a non-empty string when present` })
    }
  }
  if (action.metadata !== undefined && !isRecord(action.metadata)) {
    issues.push({ path: `${path}.metadata`, message: "action metadata must be an object when present" })
  }
  const timeoutMs = action.timeoutMs
  if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 0)) {
    issues.push({ path: `${path}.timeoutMs`, message: "action timeoutMs must be a non-negative number when present" })
  }
  if (!validDigest(action.digest)) {
    issues.push({ path: `${path}.digest`, message: "action digest must be a sha256 digest" })
    return
  }

  const expected = runtimeEpisodeDigest(runtimeEpisodeActionDigestPayload(action as unknown as RuntimeEpisodeActionRecord))
  if (action.digest.value !== expected.value) {
    issues.push({ path: `${path}.digest`, message: "action digest must match the canonical replay payload" })
  }
}

function validateRuntimeEpisodeObservation(
  observation: ObservationResult | unknown,
  path: string,
  issues: RuntimeEpisodeTraceValidationIssue[],
): void {
  if (!isRecord(observation)) {
    issues.push({ path, message: "observation must be an object" })
    return
  }

  if (observation.schema !== RUNTIME_EPISODE_OBSERVATION_SCHEMA) {
    issues.push({ path: `${path}.schema`, message: `observation schema must be ${RUNTIME_EPISODE_OBSERVATION_SCHEMA}` })
  }
  if (!nonEmptyString(observation.id)) {
    issues.push({ path: `${path}.id`, message: "observation id is required" })
  }
  if (!nonEmptyString(observation.type)) {
    issues.push({ path: `${path}.type`, message: "observation type is required" })
  }
  if (!("data" in observation)) {
    issues.push({ path: `${path}.data`, message: "observation data is required" })
  }
  if (!nonEmptyString(observation.observedAt)) {
    issues.push({ path: `${path}.observedAt`, message: "observation observedAt is required" })
  }
  if (!validDigest(observation.digest)) {
    issues.push({ path: `${path}.digest`, message: "observation digest must be a sha256 digest" })
    return
  }

  if (observation.artifactRefs !== undefined) {
    if (!Array.isArray(observation.artifactRefs)) {
      issues.push({ path: `${path}.artifactRefs`, message: "observation artifactRefs must be an array when present" })
    } else {
      observation.artifactRefs.forEach((ref, index) => validateRuntimeEpisodeTraceRef(ref, `${path}.artifactRefs[${index}]`, undefined, issues))
    }
  }

  const expected = runtimeEpisodeDigest(runtimeEpisodeObservationDigestPayload(observation as unknown as ObservationResult))
  if (observation.digest.value !== expected.value) {
    issues.push({ path: `${path}.digest`, message: "observation digest must match the canonical observation payload" })
  }
}

function validateRuntimeEpisodeSnapshot(
  snapshot: Snapshot | unknown,
  path: string,
  issues: RuntimeEpisodeTraceValidationIssue[],
): void {
  if (!isRecord(snapshot)) {
    issues.push({ path, message: "snapshot must be an object" })
    return
  }

  if (snapshot.schema !== RUNTIME_EPISODE_SNAPSHOT_SCHEMA) {
    issues.push({ path: `${path}.schema`, message: `snapshot schema must be ${RUNTIME_EPISODE_SNAPSHOT_SCHEMA}` })
  }
  if (!nonEmptyString(snapshot.id)) {
    issues.push({ path: `${path}.id`, message: "snapshot id is required" })
  }
  if (!nonEmptyString(snapshot.createdAt)) {
    issues.push({ path: `${path}.createdAt`, message: "snapshot createdAt is required" })
  }
  if (!nonEmptyString(snapshot.semantics)) {
    issues.push({ path: `${path}.semantics`, message: "snapshot semantics are required" })
  }
  if (!isRecord(snapshot.metadata)) {
    issues.push({ path: `${path}.metadata`, message: "snapshot metadata must be an object" })
  }
  if (snapshot.artifactRefs !== undefined) {
    if (!Array.isArray(snapshot.artifactRefs)) {
      issues.push({ path: `${path}.artifactRefs`, message: "snapshot artifactRefs must be an array when present" })
    } else {
      snapshot.artifactRefs.forEach((ref, index) => validateRuntimeEpisodeTraceRef(ref, `${path}.artifactRefs[${index}]`, undefined, issues))
    }
  }
  if (!validDigest(snapshot.digest)) {
    issues.push({ path: `${path}.digest`, message: "snapshot digest must be a sha256 digest" })
    return
  }

  const expected = runtimeEpisodeDigest(runtimeEpisodeSnapshotDigestPayload(snapshot as unknown as Snapshot))
  if (snapshot.digest.value !== expected.value) {
    issues.push({ path: `${path}.digest`, message: "snapshot digest must match the canonical snapshot payload" })
  }
}

function validateRuntimeEpisodeTraceRef(
  ref: RuntimeEpisodeTraceRef | unknown,
  path: string,
  kind: RuntimeEpisodeTraceRef["kind"] | undefined,
  issues: RuntimeEpisodeTraceValidationIssue[],
): void {
  if (!isRecord(ref)) {
    issues.push({ path, message: "ref must be an object" })
    return
  }

  if (kind !== undefined && ref.kind !== kind) {
    issues.push({ path: `${path}.kind`, message: `ref kind must be ${kind}` })
  }
  if (!nonEmptyString(ref.kind)) {
    issues.push({ path: `${path}.kind`, message: "ref kind is required" })
  }
  if (!nonEmptyString(ref.id)) {
    issues.push({ path: `${path}.id`, message: "ref id is required" })
  }
  if (!validDigest(ref.digest)) {
    issues.push({ path: `${path}.digest`, message: "ref digest must be a sha256 digest" })
  }
}

function validateRuntimeEpisodeRefDigest(
  ref: RuntimeEpisodeTraceRef,
  targetDigest: RuntimeEpisodeContentDigest | undefined,
  path: string,
  issues: RuntimeEpisodeTraceValidationIssue[],
): void {
  if (!validDigest(ref.digest) || !validDigest(targetDigest)) {
    return
  }
  if (ref.digest.value !== targetDigest.value) {
    issues.push({ path: `${path}.digest`, message: "ref digest must match the referenced envelope digest" })
  }
}

function validDigest(value: unknown): value is RuntimeEpisodeContentDigest {
  return isRecord(value) && value.algorithm === "sha256" && typeof value.value === "string" && /^[a-f0-9]{64}$/.test(value.value)
}

function collectForbiddenRuntimeEpisodeTraceFields(
  value: unknown,
  path: string,
  issues: RuntimeEpisodeTraceValidationIssue[],
): void {
  if (!value || typeof value !== "object") {
    return
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => collectForbiddenRuntimeEpisodeTraceFields(item, `${path}[${index}]`, issues))
    return
  }

  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`
    if (RUNTIME_EPISODE_TRACE_FORBIDDEN_FIELDS.has(key)) {
      issues.push({ path: childPath, message: `${key} is not part of the generic runtime episode trace contract` })
    }
    collectForbiddenRuntimeEpisodeTraceFields(child, childPath, issues)
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

function observationRef(observation: ObservationResult, fallbackId: string): RuntimeEpisodeTraceRef {
  return { kind: "observation", id: observation.id || fallbackId, digest: observation.digest ?? runtimeEpisodeDigest(runtimeEpisodeObservationDigestPayload(observation)) }
}

function observationWithId(observation: ObservationResult, fallbackId: string): ObservationResult {
  const enveloped = {
    ...observation,
    schema: RUNTIME_EPISODE_OBSERVATION_SCHEMA,
    id: observation.id || fallbackId,
  }

  return { ...enveloped, digest: runtimeEpisodeDigest(runtimeEpisodeObservationDigestPayload(enveloped)) }
}

function snapshotWithSemantics(snapshot: Snapshot): Snapshot {
  const enveloped = {
    ...snapshot,
    schema: RUNTIME_EPISODE_SNAPSHOT_SCHEMA,
    semantics: snapshot.semantics ?? "metadata-only",
  }

  return { ...enveloped, digest: runtimeEpisodeDigest(runtimeEpisodeSnapshotDigestPayload(enveloped)) }
}

function runtimeSnapshotReplaySemantics(semantics: string): RuntimeReferenceManifestSnapshotRef["replay"] {
  if (semantics === "replayable-runtime-state") {
    return { status: "replayable-runtime-state", limitations: [] }
  }

  if (semantics === "runtime-state-artifact") {
    return { status: "runtime-state-artifact", limitations: [] }
  }

  if (semantics === "partial-replay") {
    return {
      status: "partial-replay",
      limitations: [
        "Snapshot bundle contains replay instructions and artifact references, but not a complete WordPress database checkpoint.",
        "Replay consumers can restore mounted files and inspect runtime evidence; posts, options, terms, users, uploads, active theme/plugins, and browser/editor state may require external capture.",
      ],
    }
  }

  if (semantics === "metadata-only") {
    return {
      status: "metadata-only",
      limitations: [
        "Snapshot records runtime metadata only; it is not a WordPress database or filesystem checkpoint.",
        "Replay consumers must use trace actions and artifact bundle files to reconstruct supported state.",
      ],
    }
  }

  return {
    status: "not-replayable",
    limitations: [`Snapshot semantics are not recognized by this WP Codebox version: ${semantics}`],
  }
}

function runtimeEpisodeJsonLines(trace: RuntimeEpisodeTrace): string {
  const records: Array<Record<string, unknown>> = [
    {
      type: "episode.reset",
      id: trace.reset.id,
      runtime: trace.reset.runtime,
      observations: trace.reset.observationRefs,
    },
    ...trace.steps.map((step) => ({
      type: "episode.step",
      id: step.id,
      index: step.index,
      actionRef: step.actionRef,
      executionRef: step.executionRef,
      ...(step.observationRef ? { observationRef: step.observationRef } : {}),
    })),
    ...trace.snapshots.map((snapshot) => ({
      type: "episode.snapshot",
      id: snapshot.id,
      createdAt: snapshot.createdAt,
      semantics: snapshot.semantics,
      artifactRefs: snapshot.artifactRefs ?? [],
    })),
  ]

  if (trace.artifactRef) {
    records.push({
      type: "episode.artifacts",
      id: trace.artifactRef.id,
      artifactRef: trace.artifactRef,
    })
  }

  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`
}

function artifactManifestFile(path: string, kind: string, contentType: string): ArtifactManifestFile {
  return { path, kind, contentType, sha256: { algorithm: "sha256", value: "0".repeat(64) } }
}

export async function createRuntimeEpisode(spec: RuntimeEpisodeSpec, backend: RuntimeBackend): Promise<RuntimeEpisode> {
  return RuntimeEpisodeRunner.create(spec, backend)
}

class RuntimeEpisodeRunner implements RuntimeEpisode {
  private runtime?: Runtime
  private resetResult?: RuntimeEpisodeResetResult
  private resetCount = 0
  private readonly steps: RuntimeEpisodeStepResult[] = []
  private readonly snapshots: Snapshot[] = []
  private artifacts?: ArtifactBundle
  private traceCreatedAt?: string

  private constructor(
    private readonly spec: RuntimeEpisodeSpec,
    private readonly backend: RuntimeBackend,
  ) {}

  static async create(spec: RuntimeEpisodeSpec, backend: RuntimeBackend): Promise<RuntimeEpisodeRunner> {
    const episode = new RuntimeEpisodeRunner(spec, backend)
    await episode.reset()
    return episode
  }

  async reset(): Promise<RuntimeEpisodeResetResult> {
    await this.runtime?.destroy()
    this.runtime = await createEpisodeRuntime(this.spec, this.backend)
    this.steps.length = 0
    this.snapshots.length = 0
    this.artifacts = undefined
    this.traceCreatedAt = undefined

    for (const mount of this.spec.mounts ?? []) {
      await this.runtime.mount(mount)
    }

    const runtime = await this.runtime.info()
    const resetId = `${runtime.id}:reset:${this.resetCount++}`
    const observations = []
    for (const [index, observation] of (this.spec.resetObservations ?? [{ type: "runtime-info" }, { type: "mounts" }]).entries()) {
      observations.push(observationWithId(await this.runtime.observe(observation), `${resetId}:observation:${index}`))
    }
    this.resetResult = {
      id: resetId,
      runtime,
      observations,
      observationRefs: observations.map((observation, index) => observationRef(observation, `${resetId}:observation:${index}`)),
    }

    return this.resetResult
  }

  async step(action: RuntimeEpisodeActionSpec, observation: ObservationSpec | false = this.spec.stepObservation ?? false): Promise<RuntimeEpisodeStepResult> {
    const runtime = this.assertRuntime()
    const execution = await runtime.execute(action)
    const index = this.steps.length
    const stepId = `${execution.id}:step:${index}`
    const actionRecord = {
      schema: RUNTIME_EPISODE_ACTION_SCHEMA,
      id: `${stepId}:action`,
      kind: action.kind ?? "command",
      command: action.command,
      args: action.args ?? [],
      ...(action.cwd ? { cwd: action.cwd } : {}),
      ...(action.timeoutMs !== undefined ? { timeoutMs: action.timeoutMs } : {}),
      ...(action.method ? { method: action.method } : {}),
      ...(action.url ? { url: action.url } : {}),
      ...(action.path ? { path: action.path } : {}),
      ...(action.operation ? { operation: action.operation } : {}),
      ...(action.selector ? { selector: action.selector } : {}),
      ...(action.description ? { description: action.description } : {}),
      ...(action.metadata ? { metadata: action.metadata } : {}),
      digest: runtimeEpisodeDigest(runtimeEpisodeActionDigestPayload(action)),
    }
    const stepObservation = observation ? observationWithId(await runtime.observe(observation), `${stepId}:observation`) : undefined
    const result: RuntimeEpisodeStepResult = {
      id: stepId,
      index,
      action: actionRecord,
      actionRef: { kind: "action", id: actionRecord.id, digest: actionRecord.digest },
      execution,
      executionRef: { kind: "execution", id: execution.id, digest: runtimeEpisodeDigest(execution) },
      ...(stepObservation
        ? { observation: stepObservation, observationRef: observationRef(stepObservation, `${stepId}:observation`) }
        : {}),
    }

    this.steps.push(result)
    return result
  }

  async observe(spec: ObservationSpec): Promise<ObservationResult> {
    return this.assertRuntime().observe(spec)
  }

  async snapshot(): Promise<Snapshot> {
    const snapshot = snapshotWithSemantics(await this.assertRuntime().snapshot())
    this.snapshots.push(snapshot)
    return snapshot
  }

  async collectArtifacts(spec: ArtifactSpec = this.spec.artifactSpec ?? {}): Promise<ArtifactBundle> {
    const artifacts = await this.assertRuntime().collectArtifacts(spec)
    this.artifacts = {
      ...artifacts,
      runtimeEpisodeTracePath: join(artifacts.directory, "files/runtime-episode-trace.json"),
      runtimeEpisodeEventsPath: join(artifacts.directory, "files/runtime-episode.jsonl"),
      runtimeReplayReferenceIndexPath: join(artifacts.directory, "files/runtime-replay-index.json"),
    }
    if (spec.includeRuntimeSnapshotBundles) {
      await this.persistRuntimeSnapshotBundles()
    }
    await this.persistRuntimeEpisodeTraceArtifacts()
    return this.artifacts
  }

  private async persistRuntimeSnapshotBundles(): Promise<void> {
    if (!this.artifacts || this.snapshots.length === 0) {
      return
    }

    const manifest = JSON.parse(await readFile(this.artifacts.manifestPath, "utf8")) as ArtifactManifest
    const snapshotDirectory = join(this.artifacts.directory, "files/runtime-snapshots")
    await mkdir(snapshotDirectory, { recursive: true })
    const baseRefs = manifest.files
      .filter((file) => !["manifest.json", "metadata.json", "files/review.json", "files/runtime-reference-manifest.json", "files/runtime-replay-index.json"].includes(file.path))
      .map((file) => ({ path: file.path, kind: file.kind, contentType: file.contentType, sha256: file.sha256 }))

    for (const [index, snapshot] of this.snapshots.entries()) {
      const semantics = snapshot.semantics === "replayable-runtime-state" || snapshot.semantics === "runtime-state-artifact"
        ? snapshot.semantics
        : "partial-replay"
      const replay = runtimeSnapshotReplaySemantics(semantics)
      const relativePath = `files/runtime-snapshots/${snapshot.id}.json`
      const bundleId = `${snapshot.id}:runtime-snapshot-bundle`
      const bundle = {
        schema: "wp-codebox/runtime-snapshot-bundle/v1",
        version: 1,
        id: bundleId,
        snapshot: {
          id: snapshot.id,
          createdAt: snapshot.createdAt,
          originalSemantics: snapshot.semantics ?? "metadata-only",
          semantics,
          metadata: snapshot.metadata,
        },
        replay: {
          status: replay.status,
          limitations: replay.limitations,
          instructions: [
            "Verify every referenced artifact SHA-256 before replay.",
            "Use blueprint.after.json and blueprint.after-notes.json as generated Playground replay guidance when present.",
            "Restore mounted file artifacts from files/mounted-files.json where replayable file contents are available.",
            "Use files/runtime-episode-trace.json and files/runtime-episode.jsonl to inspect actions, observations, and snapshot refs after the episode trace is persisted.",
          ],
        },
        refs: baseRefs,
      }
      await writeFile(join(this.artifacts.directory, relativePath), `${JSON.stringify(bundle, null, 2)}\n`)
      const digest = { algorithm: "sha256" as const, value: createHash("sha256").update(await readFile(join(this.artifacts.directory, relativePath))).digest("hex") }
      const artifactRef: RuntimeEpisodeTraceRef = {
        kind: "runtime-snapshot-bundle",
        id: bundleId,
        path: relativePath,
        digest,
      }
      this.snapshots[index] = snapshotWithSemantics({
        ...snapshot,
        semantics,
        artifactRefs: [
          ...(snapshot.artifactRefs ?? []).filter((ref) => ref.path !== relativePath),
          artifactRef,
        ],
      })
      upsertArtifactManifestFiles(manifest, [artifactManifestFile(relativePath, "runtime-snapshot-bundle", "application/json")])
    }

    await refreshArtifactManifestFileSha256s(this.artifacts.directory, manifest)
    await writeFile(this.artifacts.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  }

  private async persistRuntimeEpisodeTraceArtifacts(): Promise<void> {
    if (!this.artifacts?.runtimeEpisodeTracePath || !this.artifacts.runtimeEpisodeEventsPath || !this.artifacts.runtimeReferenceManifestPath || !this.artifacts.runtimeReplayReferenceIndexPath) {
      return
    }

    const trace = await this.trace()
    const traceRelativePath = "files/runtime-episode-trace.json"
    const eventsRelativePath = "files/runtime-episode.jsonl"
    await writeFile(this.artifacts.runtimeEpisodeTracePath, `${JSON.stringify(trace, null, 2)}\n`)
    await writeFile(this.artifacts.runtimeEpisodeEventsPath, `${runtimeEpisodeJsonLines(trace)}`)
    await this.updateArtifactMetadataForRuntimeEpisodeTrace(traceRelativePath, eventsRelativePath)
    await this.updateArtifactReviewForRuntimeEpisodeTrace(traceRelativePath)
    await this.updateArtifactManifestForRuntimeEpisodeTrace(traceRelativePath, eventsRelativePath)
    await this.updateRuntimeReferenceManifestForRuntimeEpisodeTrace(traceRelativePath, eventsRelativePath)
    await this.updateRuntimeReplayReferenceIndexForRuntimeEpisodeTrace(trace, traceRelativePath, eventsRelativePath)
  }

  private async updateRuntimeReferenceManifestForRuntimeEpisodeTrace(traceRelativePath: string, eventsRelativePath: string): Promise<void> {
    if (!this.artifacts?.runtimeReferenceManifestPath) {
      return
    }

    const manifest = JSON.parse(await readFile(this.artifacts.manifestPath, "utf8")) as ArtifactManifest
    const fileRefs = manifest.files
      .filter((file) => !["manifest.json", "metadata.json", "files/review.json", "files/runtime-reference-manifest.json", "files/runtime-replay-index.json"].includes(file.path))
      .map((file) => ({ path: file.path, kind: file.kind, contentType: file.contentType, sha256: file.sha256 }))
    const traceRef = fileRefs.find((file) => file.path === traceRelativePath)
    const eventsRef = fileRefs.find((file) => file.path === eventsRelativePath)
    const referenceManifest = buildRuntimeReferenceManifest({
      createdAt: this.artifacts.createdAt,
      runtime: manifest.runtime,
      artifactBundle: {
        kind: "artifact-bundle",
        id: manifest.id,
        digest: { algorithm: "sha256", value: manifest.contentDigest.value },
      },
      files: fileRefs,
      ...(traceRef ? { trace: traceRef } : {}),
      ...(eventsRef ? { events: eventsRef } : {}),
      snapshots: this.snapshots,
    })
    await writeFile(this.artifacts.runtimeReferenceManifestPath, `${JSON.stringify(referenceManifest, null, 2)}\n`)
    await refreshArtifactManifestFileSha256s(this.artifacts.directory, manifest)
    await writeFile(this.artifacts.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  }

  private async updateRuntimeReplayReferenceIndexForRuntimeEpisodeTrace(trace: RuntimeEpisodeTrace, traceRelativePath: string, eventsRelativePath: string): Promise<void> {
    if (!this.artifacts?.runtimeReplayReferenceIndexPath) {
      return
    }

    const manifest = JSON.parse(await readFile(this.artifacts.manifestPath, "utf8")) as ArtifactManifest
    const fileRefs = manifest.files
      .filter((file) => file.path !== "manifest.json")
      .map((file) => ({ path: file.path, kind: file.kind, contentType: file.contentType, sha256: file.sha256 }))
    const traceRef = fileRefs.find((file) => file.path === traceRelativePath)
    const eventsRef = fileRefs.find((file) => file.path === eventsRelativePath)
    const runtimeReferenceManifestRef = fileRefs.find((file) => file.path === "files/runtime-reference-manifest.json")
    const replayIndex = buildRuntimeReplayReferenceIndex({
      createdAt: this.artifacts.createdAt,
      runtime: manifest.runtime,
      artifactBundle: {
        kind: "artifact-bundle",
        id: manifest.id,
        digest: { algorithm: "sha256", value: manifest.contentDigest.value },
      },
      files: fileRefs,
      ...(traceRef ? { trace: traceRef } : {}),
      ...(eventsRef ? { events: eventsRef } : {}),
      ...(runtimeReferenceManifestRef ? { runtimeReferenceManifest: runtimeReferenceManifestRef } : {}),
      snapshots: this.snapshots,
      episodeTrace: trace,
    })
    await writeFile(this.artifacts.runtimeReplayReferenceIndexPath, `${JSON.stringify(replayIndex, null, 2)}\n`)
    await refreshArtifactManifestFileSha256s(this.artifacts.directory, manifest)
    await writeFile(this.artifacts.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  }

  private async updateArtifactManifestForRuntimeEpisodeTrace(traceRelativePath: string, eventsRelativePath: string): Promise<void> {
    if (!this.artifacts) {
      return
    }

    const manifest = JSON.parse(await readFile(this.artifacts.manifestPath, "utf8")) as ArtifactManifest
    upsertArtifactManifestFiles(manifest, [
      artifactManifestFile(traceRelativePath, "runtime-episode-trace", "application/json"),
      artifactManifestFile(eventsRelativePath, "runtime-episode-events", "application/x-ndjson"),
      artifactManifestFile("files/runtime-replay-index.json", "runtime-replay-index", "application/json"),
    ])
    await refreshArtifactManifestFileSha256s(this.artifacts.directory, manifest)
    await writeFile(this.artifacts.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  }

  private async updateArtifactMetadataForRuntimeEpisodeTrace(traceRelativePath: string, eventsRelativePath: string): Promise<void> {
    if (!this.artifacts) {
      return
    }

    const metadata = JSON.parse(await readFile(this.artifacts.metadataPath, "utf8")) as Record<string, unknown>
    metadata.artifacts = {
      ...(isRecord(metadata.artifacts) ? metadata.artifacts : {}),
      runtimeEpisodeTrace: traceRelativePath,
      runtimeEpisodeEvents: eventsRelativePath,
      runtimeReplayReferenceIndex: "files/runtime-replay-index.json",
    }
    await writeFile(this.artifacts.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`)
  }

  private async updateArtifactReviewForRuntimeEpisodeTrace(traceRelativePath: string): Promise<void> {
    if (!this.artifacts) {
      return
    }

    const review = JSON.parse(await readFile(this.artifacts.reviewPath, "utf8")) as ArtifactReview
    review.evidence.runtimeEpisodeTrace = traceRelativePath
    review.evidence.runtimeReplayReferenceIndex = "files/runtime-replay-index.json"
    if (!review.progress.some((event) => event.type === "artifact" && event.component === "runtime-episode")) {
      review.progress.push({
        type: "artifact",
        component: "runtime-episode",
        label: "Runtime episode trace persisted",
        timestamp: new Date().toISOString(),
      })
    }
    await writeFile(this.artifacts.reviewPath, `${JSON.stringify(review, null, 2)}\n`)
  }

  async trace(): Promise<RuntimeEpisodeTrace> {
    const runtime = this.assertRuntime()
    const reset = this.resetResult ?? {
      id: `${(await runtime.info()).id}:reset:unrecorded`,
      runtime: await runtime.info(),
      observations: [],
      observationRefs: [],
    }
    const artifactRef = this.artifacts
      ? {
          kind: "artifact-bundle" as const,
          id: this.artifacts.id,
          artifactId: this.artifacts.id,
          path: this.artifacts.directory,
          digest: { algorithm: "sha256" as const, value: this.artifacts.contentDigest },
        }
      : undefined

    return {
      schema: RUNTIME_EPISODE_TRACE_SCHEMA,
      version: 1,
      id: `trace-${reset.runtime.id}`,
      createdAt: this.traceCreatedAt ??= new Date().toISOString(),
      runtime: await runtime.info(),
      reset,
      steps: [...this.steps],
      snapshots: [...this.snapshots],
      ...(this.artifacts ? { artifacts: this.artifacts } : {}),
      ...(artifactRef ? { artifactRef } : {}),
    }
  }

  async close(): Promise<void> {
    await this.runtime?.destroy()
    this.runtime = undefined
  }

  private assertRuntime(): Runtime {
    if (!this.runtime) {
      throw new Error("Runtime episode is closed")
    }

    return this.runtime
  }
}

async function createEpisodeRuntime(spec: RuntimeEpisodeSpec, backend: RuntimeBackend): Promise<Runtime> {
  assertRuntimePolicy(spec.runtime.policy)

  if (backend.kind !== spec.runtime.backend) {
    throw new Error(`Backend ${backend.kind} cannot create runtime ${spec.runtime.backend}`)
  }

  return backend.create(spec.runtime)
}
