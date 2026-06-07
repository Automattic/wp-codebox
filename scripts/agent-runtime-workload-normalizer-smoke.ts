import { normalizeAgentRuntimeWorkload } from "@automattic/wp-codebox-core"

const bundleRun = normalizeAgentRuntimeWorkload({
  schema: "example/agent-bundle-run/v1",
  success: true,
  bundle: { bundle_slug: "site-build" },
  outputs: { preview_url: "https://example.test/preview" },
  workflow: { steps: [{ id: "generate" }, { id: "verify" }] },
}, { requiredOutputs: { preview_url: "outputs.preview_url" } })
assertEqual(bundleRun.schema, "wp-codebox/agent-runtime-workload/v1", "schema is stable")
assertEqual(bundleRun.success, true, "bundle run succeeds")
assertEqual(bundleRun.outputs.preview_url, "https://example.test/preview", "bundle outputs are preserved")
assertEqual(bundleRun.scenarios[0]?.id, "site-build", "bundle scenario id is normalized")
assertEqual(bundleRun.scenarios[0]?.metrics?.workflow_step_count, 2, "workflow step count is exposed")

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
}, { workloadId: "stdout-agent", toolRecorders: [{ name: "pull_request_url", path: "outputs.pull_request_url" }] })
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
})
assertEqual(recipeRun.success, true, "recipe-run nested agent task result succeeds")
assertEqual(recipeRun.outputs.report_path, "runtime-evidence/report.json", "recipe-run nested outputs are normalized")

const failedScenario = normalizeAgentRuntimeWorkload({
  scenarios: [{ id: "failed", metadata: { error: "runtime adapter failed" } }],
})
assertEqual(failedScenario.success, false, "scenario metadata error fails workload")
assertEqual(failedScenario.diagnostics[0]?.message, "runtime adapter failed", "scenario metadata error is surfaced")

console.log("agent runtime workload normalizer smoke ok")

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`)
  }
}
