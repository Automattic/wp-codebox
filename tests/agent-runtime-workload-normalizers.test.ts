import assert from "node:assert/strict"
import {
  AGENT_RUNTIME_WORKLOAD_SCHEMA,
  legacyAgentRuntimeWorkloadNormalizerAdapters,
  normalizeAgentRuntimeWorkload,
  type AgentRuntimeWorkloadNormalizerAdapter,
} from "../packages/runtime-core/src/agent-runtime-workload.js"

const canonical = normalizeAgentRuntimeWorkload({
  schema: AGENT_RUNTIME_WORKLOAD_SCHEMA,
  success: true,
  outputs: { preview_url: "https://example.test/canonical" },
  scenarios: [{ id: "canonical", status: "completed" }],
})

assert.equal(canonical.success, true)
assert.equal(canonical.outputs.preview_url, "https://example.test/canonical")
assert.equal(canonical.scenarios[0]?.id, "canonical")
assert.deepEqual(canonical.diagnostics, [])

const legacyBundleRun = {
  schema: "example/agent-bundle-run/v1",
  success: true,
  job_id: "caller-job-123",
  flow_slug: "downstream-flow",
  engine_data: { provider: "downstream" },
  bundle: { flow_slug: "bundle-flow", bundle_slug: "site-build" },
  outputs: { preview_url: "https://example.test/legacy" },
  workflow: { steps: [{ id: "generate" }, { id: "verify" }] },
}

const strictBundleRun = normalizeAgentRuntimeWorkload(legacyBundleRun, { requiredOutputs: ["preview_url"] })
assert.equal(strictBundleRun.success, false)
assert.deepEqual(strictBundleRun.outputs, {})
assert.deepEqual(strictBundleRun.scenarios, [])
assert.equal(strictBundleRun.diagnostics[0]?.data?.reason, "missing_required_outputs")

const adaptedBundleRun = normalizeAgentRuntimeWorkload(legacyBundleRun, {
  normalizerAdapters: legacyAgentRuntimeWorkloadNormalizerAdapters,
  requiredOutputs: ["preview_url"],
})
assert.equal(adaptedBundleRun.success, true)
assert.equal(adaptedBundleRun.outputs.preview_url, "https://example.test/legacy")
assert.equal(adaptedBundleRun.scenarios[0]?.id, "bundle-flow")
assert.equal(adaptedBundleRun.scenarios[0]?.metrics?.workflow_step_count, 2)
assert.equal(adaptedBundleRun.scenarios[0]?.metadata?.job_id, "caller-job-123")
assert.deepEqual(adaptedBundleRun.scenarios[0]?.metadata?.engine_data, { provider: "downstream" })
assert.equal(adaptedBundleRun.diagnostics.some((diagnostic) => diagnostic.data?.adapter === "runtime-workload-agent-bundle-run"), true)

const scenarioShape = {
  success: true,
  outputs: { report_path: "runtime/report.json" },
  scenarios: [{ id: "legacy-scenario", outputs: { report_path: "runtime/report.json" } }],
}

const strictScenarioShape = normalizeAgentRuntimeWorkload(scenarioShape)
assert.equal(strictScenarioShape.success, false)
assert.deepEqual(strictScenarioShape.scenarios, [])
assert.equal(strictScenarioShape.diagnostics[0]?.data?.reason, "missing_semantic_outputs")

const adaptedScenarioShape = normalizeAgentRuntimeWorkload(scenarioShape, { normalizerAdapters: legacyAgentRuntimeWorkloadNormalizerAdapters })
assert.equal(adaptedScenarioShape.success, true)
assert.equal(adaptedScenarioShape.scenarios[0]?.id, "legacy-scenario")
assert.equal(adaptedScenarioShape.outputs.report_path, "runtime/report.json")

const adaptedSingleResultShape = normalizeAgentRuntimeWorkload({
  schema: "example/runtime-package-result/v1",
  success: true,
  concept_packet: { title: "Generated concept" },
  typed_artifacts: [{ name: "concept_packet", type: "example.concept-packet", payload_schema: "example/concept-packet/v1", payload: { title: "Generated concept" } }],
  structured_artifacts: [{ name: "concept_packet", schema: "example/concept-packet/v1", payload: { title: "Generated concept" } }],
}, { normalizerAdapters: legacyAgentRuntimeWorkloadNormalizerAdapters })
assert.equal(adaptedSingleResultShape.success, true)
assert.deepEqual(adaptedSingleResultShape.outputs.concept_packet, { title: "Generated concept" })
assert.equal(Array.isArray(adaptedSingleResultShape.outputs.typed_artifacts), true)
assert.equal(Array.isArray(adaptedSingleResultShape.outputs.structured_artifacts), true)
assert.equal(adaptedSingleResultShape.scenarios[0]?.outputs?.concept_packet, adaptedSingleResultShape.outputs.concept_packet)
assert.equal(adaptedSingleResultShape.diagnostics.some((diagnostic) => diagnostic.data?.adapter === "runtime-workload-single-result-shape"), true)

const executionStdout = {
  executions: [{
    stdout: JSON.stringify({
      schema: AGENT_RUNTIME_WORKLOAD_SCHEMA,
      success: true,
      outputs: { artifact_url: "https://example.test/artifact" },
      scenarios: [{ id: "execution" }],
    }),
  }],
}

const strictExecutionStdout = normalizeAgentRuntimeWorkload(executionStdout)
assert.equal(strictExecutionStdout.success, false)
assert.deepEqual(strictExecutionStdout.outputs, {})

const adaptedExecutionStdout = normalizeAgentRuntimeWorkload(executionStdout, { normalizerAdapters: legacyAgentRuntimeWorkloadNormalizerAdapters })
assert.equal(adaptedExecutionStdout.success, true)
assert.equal(adaptedExecutionStdout.outputs.artifact_url, "https://example.test/artifact")
assert.equal(adaptedExecutionStdout.scenarios[0]?.id, "execution")

const customAdapter: AgentRuntimeWorkloadNormalizerAdapter = {
  name: "test-custom-downstream-shape",
  normalize(raw) {
    const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined
    const customOutput = record?.custom_output
    if (typeof customOutput !== "string") return undefined
    return {
      outputs: { custom_output: customOutput },
      scenarios: [{ id: "custom-adapter", outputs: { custom_output: customOutput } }],
      diagnostics: [],
      artifacts: [],
      metadata: {},
    }
  },
}

const adaptedCustomShape = normalizeAgentRuntimeWorkload({ custom_output: "owned-by-caller" }, { normalizerAdapters: [customAdapter] })
assert.equal(adaptedCustomShape.success, true)
assert.equal(adaptedCustomShape.outputs.custom_output, "owned-by-caller")
assert.equal(adaptedCustomShape.diagnostics.some((diagnostic) => diagnostic.data?.adapter === "test-custom-downstream-shape"), true)

console.log("agent runtime workload normalizer adapters ok")
