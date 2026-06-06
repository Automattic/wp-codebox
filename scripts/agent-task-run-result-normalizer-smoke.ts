import { normalizeAgentTaskRunResult } from "@automattic/wp-codebox-core"

const success = normalizeAgentTaskRunResult({ success: true, status: "completed", run: { runtime: { id: "runtime-ok", status: "destroyed" } } })
assertEqual(success.status, "succeeded", "completed success normalizes to succeeded")
assertEqual(success.success, true, "succeeded result is successful")
assertEqual(success.refs.runtimes[0]?.id, "runtime-ok", "runtime ref is exposed")

const failed = normalizeAgentTaskRunResult({ success: false, status: "completed" })
assertEqual(failed.status, "failed", "completed failure normalizes to failed")
assertEqual(failed.failure_classification, "runtime", "failed result classifies as runtime")

const timeout = normalizeAgentTaskRunResult({ success: false, timeout: true })
assertEqual(timeout.status, "timeout", "timeout flag normalizes to timeout")
assertEqual(timeout.failure_classification, "timeout", "timeout result classifies as timeout")

const providerError = normalizeAgentTaskRunResult({ success: false, provider_error: { code: "rate_limit_exceeded" } })
assertEqual(providerError.status, "provider_error", "provider error flag normalizes to provider_error")
assertEqual(providerError.failure_classification, "provider", "provider error classifies as provider")
assertEqual((providerError.metadata.provider_error as Record<string, unknown>).code, "rate_limit_exceeded", "provider metadata is retained")

const unable = normalizeAgentTaskRunResult({ success: false, unable_to_remediate: true })
assertEqual(unable.status, "unable_to_remediate", "unable_to_remediate flag is canonical")

const canary = normalizeAgentTaskRunResult({
  success: true,
  schema: "wp-codebox/agent-task-run/v1",
  session: { artifacts: { bundle_id: "artifact-bundle-sha256-canary" } },
  artifacts: {
    id: "artifact-bundle-sha256-canary",
    runtimeLogPath: "/tmp/canary/runtime/logs/runtime.log",
    commandsLogPath: "/tmp/canary/runtime/logs/commands.log",
  },
  run: {
    runId: "run-canary",
    status: "succeeded",
    runtime: { id: "runtime-canary", status: "destroyed" },
    artifactRefs: [{ kind: "artifact-bundle", directory: "/tmp/canary/runtime", id: "artifact-bundle-sha256-canary", digest: { algorithm: "sha256", value: "canary-digest" } }],
    agentResult: {
      summary: "Agent sandbox completed without actionable file changes.",
      changedFiles: { count: 0, paths: [], artifact: "files/changed-files.json" },
      patch: { bytes: 0, sha256: "empty-patch-sha", artifact: "files/patch.diff" },
      transcript: { artifact: "files/transcript.json", executionCount: 1 },
      artifacts: { directory: "/tmp/canary/runtime" },
      noOpReason: "no_file_changes",
    },
  },
  completionOutcome: {
    status: "partial",
    nextAction: "review",
    confidence: "medium",
    provenance: { artifactBundleId: "artifact-bundle-sha256-canary", artifactDirectory: "/tmp/canary/runtime" },
  },
})
assertEqual(canary.status, "no_op", "no-op metadata normalizes to no_op")
assertEqual(canary.no_op.detected, true, "no-op detection is exposed")
assertEqual(canary.no_op.reason, "no_file_changes", "no-op reason is exposed")
assertEqual(canary.refs.artifact_bundles.some((artifact) => artifact.path === "/tmp/canary/runtime"), true, "artifact bundle path is exposed")
assertEqual(canary.refs.changed_files[0]?.path, "/tmp/canary/runtime/files/changed-files.json", "changed-files artifact path is exposed")
assertEqual(canary.refs.patches[0]?.path, "/tmp/canary/runtime/files/patch.diff", "patch artifact path is exposed")
assertEqual(canary.refs.patches[0]?.sha256, "empty-patch-sha", "patch digest is exposed")
assertEqual(canary.refs.transcripts[0]?.path, "/tmp/canary/runtime/files/transcript.json", "transcript path is exposed")
assertEqual(canary.refs.logs.length, 2, "runtime and command logs are exposed")
assertEqual(canary.metadata.run_id, "run-canary", "run metadata is exposed")
assertEqual(canary.metadata.completion_next_action, "review", "completion outcome metadata is exposed")

const legacy = normalizeAgentTaskRunResult({
  success: true,
  agent_result: {
    changedFiles: { count: 1, artifact: "changed.json" },
    patch: { bytes: 32, sha256: "legacy-patch", artifact: "patch.diff" },
    artifacts: { directory: "/tmp/legacy" },
  },
  completion_outcome: { provenance: { artifactBundleId: "legacy-bundle", artifactDirectory: "/tmp/legacy" } },
})
assertEqual(legacy.status, "succeeded", "legacy snake-case result succeeds")
assertEqual(legacy.refs.patches[0]?.path, "/tmp/legacy/patch.diff", "legacy patch path is exposed")
assertEqual(legacy.refs.changed_files[0]?.path, "/tmp/legacy/changed.json", "legacy changed-files path is exposed")

console.log("agent task run result normalizer smoke ok")

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`)
  }
}
