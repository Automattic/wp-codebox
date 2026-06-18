import assert from "node:assert/strict"
import {
  RUNTIME_EPISODE_TRACE_SCHEMA,
  validateRuntimeEpisodeTrace,
  type RuntimeEpisodeTrace,
} from "../packages/runtime-core/src/index.js"
import {
  RUNTIME_EPISODE_ACTION_SCHEMA,
  RUNTIME_EPISODE_OBSERVATION_SCHEMA,
  runtimeEpisodeActionDigestPayload,
  runtimeEpisodeDigest,
  runtimeEpisodeObservationDigestPayload,
} from "../packages/runtime-core/src/runtime-episode-contracts.js"

const action = {
  schema: RUNTIME_EPISODE_ACTION_SCHEMA,
  id: "step-0:action",
  kind: "command" as const,
  command: "noop",
  args: [],
  digest: runtimeEpisodeDigest({}),
}
action.digest = runtimeEpisodeDigest(runtimeEpisodeActionDigestPayload(action))

const observation = {
  schema: RUNTIME_EPISODE_OBSERVATION_SCHEMA,
  id: "reset:observation:0",
  type: "browser-result",
  data: {
    success: true,
    scenario: "checkout-flow",
    nested: {
      benchmark: "consumer-owned-payload",
      modelEval: { score: 1 },
    },
  },
  observedAt: "2026-01-02T03:04:05.000Z",
  digest: runtimeEpisodeDigest({}),
}
observation.digest = runtimeEpisodeDigest(runtimeEpisodeObservationDigestPayload(observation))

const trace: RuntimeEpisodeTrace = {
  schema: RUNTIME_EPISODE_TRACE_SCHEMA,
  version: 1,
  id: "episode-1",
  createdAt: "2026-01-02T03:04:05.000Z",
  runtime: {
    id: "runtime-1",
    backend: "test",
    environment: { kind: "test" },
    createdAt: "2026-01-02T03:04:05.000Z",
    status: "ready",
    policy: { network: "deny", filesystem: { write: "workspace" }, secrets: "deny" },
  },
  reset: {
    id: "reset",
    runtime: {
      id: "runtime-1",
      backend: "test",
      environment: { kind: "test" },
      createdAt: "2026-01-02T03:04:05.000Z",
      status: "ready",
      policy: { network: "deny", filesystem: { write: "workspace" }, secrets: "deny" },
    },
    observations: [observation],
    observationRefs: [{ kind: "observation", id: observation.id, digest: observation.digest }],
  },
  steps: [{
    id: "step-0",
    index: 0,
    action,
    actionRef: { kind: "action", id: action.id, digest: action.digest },
    execution: {
      id: "execution-0",
      command: "noop",
      args: [],
      exitCode: 0,
      stdout: "",
      stderr: "",
      startedAt: "2026-01-02T03:04:05.000Z",
      finishedAt: "2026-01-02T03:04:05.000Z",
    },
    executionRef: { kind: "execution", id: "execution-0", digest: runtimeEpisodeDigest({
      id: "execution-0",
      command: "noop",
      args: [],
      exitCode: 0,
      stdout: "",
      stderr: "",
      startedAt: "2026-01-02T03:04:05.000Z",
      finishedAt: "2026-01-02T03:04:05.000Z",
    }) },
  }],
  snapshots: [],
}

assert.deepEqual(validateRuntimeEpisodeTrace(trace), {
  valid: true,
  schema: RUNTIME_EPISODE_TRACE_SCHEMA,
  issues: [],
})

const leaked = { ...trace, success: true }
const validation = validateRuntimeEpisodeTrace(leaked)
assert.equal(validation.valid, false)
assert.ok(validation.issues.some((issue) => issue.path === "$.success" && issue.message.includes("generic runtime episode trace contract")))

console.log("runtime episode contract validation passed")
