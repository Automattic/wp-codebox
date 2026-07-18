import assert from "node:assert/strict"

import { minimizeFuzzCase } from "../packages/runtime-core/src/index.js"
import type { RuntimeAction } from "../packages/runtime-core/src/runtime-action-adapter.js"

const replayed: string[][] = []
const result = await minimizeFuzzCase({
  schema: "wp-codebox/fuzz-replay-case-input/v1",
  suite: { id: "suite-minimize" },
  case: {
    id: "case-sequence-fails",
    status: "failed",
    success: false,
    target: { kind: "runtime-action" },
    diagnostics: [{ severity: "error", code: "fuzz_suite_runtime_action_failed", message: "Runtime action php exited with 1." }],
  },
  replay: {
    sequence: {
      schema: "wp-codebox/runtime-action-sequence/v1",
      steps: [
        { type: "editor_actions", steps: [{ kind: "inspectState" }], metadata: { id: "setup" } },
        { type: "editor_validate_blocks", content: "<!-- wp:paragraph --><p>noise</p><!-- /wp:paragraph -->", metadata: { id: "noise-a" } },
        { type: "editor_validate_blocks", content: "<!-- wp:paragraph --><p>failing</p><!-- /wp:paragraph -->", metadata: { id: "failing", fail: true } },
        { type: "editor_validate_blocks", content: "<!-- wp:paragraph --><p>noise</p><!-- /wp:paragraph -->", metadata: { id: "noise-b" } },
      ],
    },
  },
}, {
  runtimeActionExecutor: async ({ action }) => {
    const metadata = (action as { metadata?: Record<string, unknown> }).metadata
    replayed.push([String(metadata?.id ?? action.type)])
    const exitCode = metadata?.fail === true ? 1 : 0
    return {
      schema: "wp-codebox/runtime-action-observation/v1",
      type: action.type,
      status: "ok",
      action,
      data: { exitCode },
      observedAt: "2026-01-01T00:00:00.000Z",
      step: {
        phase: "steps",
        index: 0,
        step: { command: `runtime-action:${action.type}` },
        execution: { id: `exec-${String(metadata?.id ?? action.type)}`, command: `runtime-action:${action.type}`, args: [], exitCode, stdout: exitCode === 0 ? "ok" : "", stderr: exitCode === 0 ? "" : "failed", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z" },
      },
      digest: { algorithm: "sha256", value: String(metadata?.id ?? action.type) },
    }
  },
})

assert.equal(result.schema, "wp-codebox/fuzz-minimize-case-result/v1")
assert.equal(result.status, "reduced")
assert.equal(result.originalSteps, 4)
assert.equal(result.minimizedSteps, 1)
assert.equal((result.minimizedCase?.input as { steps?: RuntimeAction[] }).steps?.[0]?.metadata?.id, "failing")
assert.equal(result.minimizedResult?.status, "failed")
assert.equal(result.minimizedResult?.diagnostics[0]?.code, "fuzz_suite_runtime_action_failed")
assert.equal(result.attempts.some((attempt) => attempt.preserved && attempt.stepCount < 4), true)
assert.equal(replayed.length > 0, true)

const blocker = await minimizeFuzzCase({
  schema: "wp-codebox/fuzz-replay-case-input/v1",
  suite: { id: "suite-minimize" },
  case: { id: "case-command", status: "failed", diagnostics: [] },
  replay: { command: "wordpress.run-php" },
})

assert.equal(blocker.status, "blocked")
assert.equal(blocker.diagnostics[0]?.code, "fuzz_minimize_case_sequence_replay_required")
