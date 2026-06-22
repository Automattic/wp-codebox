import { legacyAgentRuntimeWorkloadNormalizerAdapters, normalizeAgentRuntimeWorkload } from "@automattic/wp-codebox-core"

const canonicalEnvelope = normalizeAgentRuntimeWorkload({
  schema: "wp-codebox/agent-runtime-workload/v1",
  success: true,
  outputs: { preview_url: "https://example.test/canonical" },
  scenarios: [{ id: "canonical", status: "completed", outputs: { preview_url: "https://example.test/canonical" } }],
  diagnostics: [{ class: "agent_runtime.note", message: "canonical envelope retained" }],
  artifacts: [{ kind: "runtime-report", path: "runtime/report.json" }],
})
assertEqual(canonicalEnvelope.schema, "wp-codebox/agent-runtime-workload/v1", "canonical schema is stable")
assertEqual(canonicalEnvelope.success, true, "canonical envelope succeeds")
assertEqual(canonicalEnvelope.outputs.preview_url, "https://example.test/canonical", "canonical outputs are preserved")
assertEqual(canonicalEnvelope.scenarios[0]?.id, "canonical", "canonical scenario id is preserved")
assertEqual(canonicalEnvelope.diagnostics[0]?.message, "canonical envelope retained", "canonical diagnostics are preserved")
assertEqual(canonicalEnvelope.artifacts[0]?.path, "runtime/report.json", "canonical artifacts are preserved")

const explicitEnvelope = normalizeAgentRuntimeWorkload({
  agent_runtime_workload: {
    schema: "wp-codebox/agent-runtime-workload/v1",
    success: true,
    outputs: { report_path: "runtime/report.json" },
    scenarios: [{ id: "explicit" }],
  },
  stdout: JSON.stringify({ success: false, outputs: { report_path: "legacy/report.json" } }),
}, { normalizerAdapters: legacyAgentRuntimeWorkloadNormalizerAdapters })
assertEqual(explicitEnvelope.success, true, "explicit envelope wins over legacy extraction")
assertEqual(explicitEnvelope.outputs.report_path, "runtime/report.json", "explicit envelope output is used")
assertEqual(explicitEnvelope.scenarios[0]?.id, "explicit", "explicit envelope scenario is used")

const legacyBundleRun = normalizeAgentRuntimeWorkload({
  schema: "example/agent-bundle-run/v1",
  success: true,
  bundle: { bundle_slug: "site-build" },
  outputs: { preview_url: "https://example.test/preview" },
  workflow: { steps: [{ id: "generate" }, { id: "verify" }] },
}, { normalizerAdapters: legacyAgentRuntimeWorkloadNormalizerAdapters, requiredOutputs: { preview_url: "outputs.preview_url" } })
assertEqual(legacyBundleRun.schema, "wp-codebox/agent-runtime-workload/v1", "legacy bundle run emits canonical schema")
assertEqual(legacyBundleRun.success, true, "legacy bundle run succeeds")
assertEqual(legacyBundleRun.outputs.preview_url, "https://example.test/preview", "legacy bundle outputs are preserved")
assertEqual(legacyBundleRun.scenarios[0]?.id, "site-build", "legacy bundle scenario id is normalized")
assertEqual(legacyBundleRun.scenarios[0]?.metrics?.workflow_step_count, 2, "legacy workflow step count is exposed")

const stdoutWrapper = normalizeAgentRuntimeWorkload({
  stdout: JSON.stringify({
    output: JSON.stringify({
      agent_runtime: {
        result: {
          success: true,
          output: { pull_request_url: "https://github.com/Automattic/wp-codebox/pull/1" },
          diagnostics: [{ class: "agent_runtime.note", message: "kept generic" }],
        },
      },
    }),
  }),
}, { normalizerAdapters: legacyAgentRuntimeWorkloadNormalizerAdapters, workloadId: "stdout-agent", toolRecorders: [{ name: "pull_request_url", path: "outputs.pull_request_url" }] })
assertEqual(stdoutWrapper.success, true, "stdout wrapper succeeds")
assertEqual(stdoutWrapper.outputs.pull_request_url, "https://github.com/Automattic/wp-codebox/pull/1", "stdout wrapper output is normalized")
assertEqual(stdoutWrapper.scenarios[0]?.id, "stdout-agent", "stdout wrapper workload id is used")
assertEqual(stdoutWrapper.diagnostics[0]?.class, "agent_runtime.note", "runtime diagnostics are retained")

const missingRequired = normalizeAgentRuntimeWorkload({ success: true, outputs: {} }, { requiredOutputs: ["artifact_url"] })
assertEqual(missingRequired.success, false, "missing required output fails workload")
assertEqual(missingRequired.diagnostics[0]?.class, "agent_runtime.workload.incomplete", "missing required output diagnostic is emitted")

const recipeRun = normalizeAgentRuntimeWorkload({
  run: {
    agentTaskResult: {
      raw: {
        agent_runtime: {
          success: true,
          result: {
            success: true,
            outputs: { report_path: "runtime-evidence/report.json" },
          },
        },
      },
    },
  },
}, { normalizerAdapters: legacyAgentRuntimeWorkloadNormalizerAdapters })
assertEqual(recipeRun.success, true, "recipe-run nested agent task result succeeds")
assertEqual(recipeRun.outputs.report_path, "runtime-evidence/report.json", "recipe-run nested outputs are normalized")

const failedScenario = normalizeAgentRuntimeWorkload({
  scenarios: [{ id: "failed", metadata: { error: "runtime adapter failed" } }],
}, { normalizerAdapters: legacyAgentRuntimeWorkloadNormalizerAdapters })
assertEqual(failedScenario.success, false, "scenario metadata error fails workload")
assertEqual(failedScenario.diagnostics.some((diagnostic) => diagnostic.message === "runtime adapter failed"), true, "scenario metadata error is surfaced")

console.log("agent runtime workload normalizer smoke ok")

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`)
  }
}
