import { createHash } from "node:crypto"

import { isPlainObject as isRecord, stableJson } from "./object-utils.js"
import type {
  ObservationResult,
  RuntimeEpisodeActionRecord,
  RuntimeEpisodeActionSpec,
  RuntimeEpisodeContentDigest,
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

export function runtimeEpisodeActionDigestPayload(action: RuntimeEpisodeActionRecord | RuntimeEpisodeActionSpec): Record<string, unknown> {
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

export function runtimeEpisodeObservationDigestPayload(observation: ObservationResult): Record<string, unknown> {
  return {
    schema: RUNTIME_EPISODE_OBSERVATION_SCHEMA,
    type: observation.type,
    data: observation.data,
    observedAt: observation.observedAt,
    artifactRefs: observation.artifactRefs ?? [],
  }
}

export function runtimeEpisodeSnapshotDigestPayload(snapshot: Snapshot): Record<string, unknown> {
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
