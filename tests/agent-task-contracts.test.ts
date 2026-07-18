import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chdir, cwd } from "node:process"
import { AGENT_TASK_RUN_REQUEST_SCHEMA, AGENT_TASK_RUN_RESULT_JSON_SCHEMA, AGENT_TASK_RUN_RESULT_SCHEMA, ARTIFACT_RESULT_ENVELOPE_SCHEMA, HEADLESS_AGENT_TASK_REQUEST_JSON_SCHEMA, HEADLESS_AGENT_TASK_REQUEST_SCHEMA, HEADLESS_AGENT_TASK_RESULT_JSON_SCHEMA, HEADLESS_AGENT_TASK_RESULT_SCHEMA, PREVIEW_LEASE_SCHEMA, TYPED_ARTIFACT_SCHEMA, WORKSPACE_DELTA_JSON_SCHEMA, WORKSPACE_DELTA_SCHEMA, buildAgentTaskRecipe, headlessAgentTaskRequestToRunInput, normalizeAgentRuntimeExecutionChanges, normalizeAgentRuntimeWorkload, normalizeAgentTaskRunResult, normalizeAgentTerminalResult, normalizeArtifactResultTypedArtifacts, normalizeHeadlessAgentTaskRequest, normalizeHeadlessAgentTaskResult, normalizeRecipeRunSummary, normalizeTaskInput, workspaceDeltaFromAgentTaskRunResult } from "../packages/runtime-core/src/index.js"
import { effectivePolicyCommands } from "../packages/runtime-core/src/contracts.js"
import { commandCatalogOutput } from "../packages/cli/src/commands/discovery.js"
import { agentTaskResultFromRun, agentTaskRunExitCode, agentTaskRunJsonOutput, normalizeAgentTaskRunCliInput, writeAgentTaskRunResultFile } from "../packages/cli/src/commands/agent-task-run.js"
import { agentSandboxRunCode, resolveSandboxTaskCode } from "../packages/cli/src/agent-code.js"
import { dryRunRecipe } from "../packages/cli/src/recipe-dry-run.js"
import { recipePolicy } from "../packages/cli/src/recipe-validation.js"

const succeeded = normalizeAgentTaskRunResult({ success: true, status: "completed" }, { exitStatus: 0 })
assert.equal(AGENT_TASK_RUN_RESULT_SCHEMA, "wp-codebox/agent-task-run-result/v1")
assert.equal(AGENT_TASK_RUN_RESULT_JSON_SCHEMA.properties.schema.const, AGENT_TASK_RUN_RESULT_SCHEMA)
assert.equal(succeeded.schema, AGENT_TASK_RUN_RESULT_SCHEMA)
assert.equal(succeeded.status, "succeeded")
assert.equal(agentTaskRunExitCode({ success: true, agent_task_run_result: succeeded }), 0)

const toolObservability = normalizeAgentTaskRunResult({
  success: true,
  metadata: {
    agents_api: {
      tool_observability: {
        version: 1,
        calls: [
          { sequence: 1, turn: 1, tool_call_id: "call-success", tool_name: "workspace.read", status: "succeeded", arguments: { keys: ["path"], count: 1, redacted: true }, result: { type: "object", count: 2 }, result_body: "secret-sentinel" },
          { sequence: 2, turn: 1, tool_call_id: "call-failure", tool_name: "workspace.write", status: "failed", arguments: { keys: [], count: 0, redacted: true }, error: { code: "raw-secret", message: "secret-sentinel" } },
          { sequence: 3, turn: 2, tool_call_id: "call-rejected", tool_name: "workspace.delete", status: "rejected", arguments: { keys: ["path"], count: 1, redacted: true } },
          { sequence: 4, turn: 2, tool_call_id: "call-pending", tool_name: "workspace.grep", status: "pending", arguments: { keys: ["query"], count: 1, redacted: true } },
          { sequence: 5, turn: 2, tool_call_id: "malformed", tool_name: "workspace.read", status: "succeeded", arguments: { keys: ["path"], count: 2, redacted: true } },
          { sequence: 6, turn: 2, tool_call_id: "untrusted secret sentinel", tool_name: "workspace.read", status: "pending", arguments: { keys: [], count: 0, redacted: true } },
          { sequence: 7, turn: 2, tool_call_id: "call-secret-name", tool_name: "untrusted secret sentinel", status: "pending", arguments: { keys: [], count: 0, redacted: true } },
          { sequence: 8, turn: 2, tool_call_id: "call-secret-key", tool_name: "workspace.read", status: "pending", arguments: { keys: ["untrusted secret sentinel"], count: 1, redacted: true } },
          { sequence: 9, turn: 2, tool_call_id: "call-secret-type", tool_name: "workspace.read", status: "succeeded", arguments: { keys: [], count: 0, redacted: true }, result: { type: "untrusted secret sentinel", count: 1 } },
        ],
      },
    },
  },
})
assert.deepEqual((toolObservability.metadata.tool_observability as any)?.calls.map((call: any) => call.status), ["succeeded", "failed", "rejected", "pending"])
assert.deepEqual((toolObservability.metadata.tool_observability as any)?.calls[0].result, { type: "object", count: 2 })
assert.deepEqual((toolObservability.metadata.tool_observability as any)?.calls[1].error, { code: "tool_call_failed", message: "Tool call failed." })
assert.equal(JSON.stringify(toolObservability).includes("secret-sentinel"), false, "normalized tool observability never retains payloads or raw errors")
assert.equal(JSON.stringify(toolObservability).includes("untrusted secret sentinel"), false, "normalized tool observability rejects non-identifier summary strings")
for (const resultShape of [{ type: "string", size: 12 }, { type: "integer" }]) {
  const normalized = normalizeAgentTaskRunResult({ metadata: { agents_api: { tool_observability: { version: 1, calls: [{ sequence: 1, turn: 1, tool_call_id: "call-shape", tool_name: "workspace.read", status: "succeeded", arguments: { keys: [], count: 0, redacted: true }, result: resultShape }] } } } })
  assert.deepEqual((normalized.metadata.tool_observability as any)?.calls[0].result, resultShape)
}
for (const unsupported of [0, 2, "1"]) {
  const result = normalizeAgentTaskRunResult({ metadata: { agents_api: { tool_observability: { version: unsupported, calls: [{ sequence: 1, turn: 1, tool_call_id: "call", tool_name: "tool", status: "pending", arguments: { keys: [], count: 0, redacted: true } }] } } } })
  assert.equal("tool_observability" in result.metadata, false, "only canonical version 1 tool observability is consumed")
}

const resultFileDirectory = mkdtempSync(join(tmpdir(), "wp-codebox-agent-task-result-file-"))
const resultFilePath = join(resultFileDirectory, "result.json")
const atomicResult = { schema: "wp-codebox/agent-task-run/v1", success: true, status: "succeeded", padding: "x".repeat(40 * 1024) }
await writeAgentTaskRunResultFile(resultFilePath, atomicResult as never)
assert.deepEqual(JSON.parse(await (await import("node:fs/promises")).readFile(resultFilePath, "utf8")), atomicResult)
assert.equal(statSync(resultFilePath).mode & 0o777, 0o600)
const originalNow = Date.now
Date.now = () => 1
const interruptedTemporaryPath = `${resultFilePath}.${process.pid}.1.tmp`
writeFileSync(interruptedTemporaryPath, "partial")
try {
  await assert.rejects(writeAgentTaskRunResultFile(resultFilePath, atomicResult as never), /EEXIST/)
} finally {
  Date.now = originalNow
}
assert.deepEqual(readdirSync(resultFileDirectory).filter((entry) => entry.includes(".tmp")), [], "Interrupted atomic writes must clean up temporary files")
mkdirSync(join(resultFileDirectory, "interrupted.json"))
await assert.rejects(writeAgentTaskRunResultFile(join(resultFileDirectory, "interrupted.json"), atomicResult as never), /regular file/)
assert.deepEqual(readdirSync(resultFileDirectory).filter((entry) => entry.includes(".tmp")), [], "Failed result-file writes must not leave partial temporary files")
rmSync(resultFileDirectory, { recursive: true, force: true })

const succeededWithAccess = normalizeAgentTaskRunResult({ success: true, status: "completed", outputs: { preview_url: "https://preview.example.test", site_url: "https://site.example.test" } }, { exitStatus: 0 })
assert.equal(succeededWithAccess.runtime_access?.schema, "wp-codebox/runtime-access/v1")
assert.equal(succeededWithAccess.runtime_access?.preview_url, "https://preview.example.test")
assert.equal(succeededWithAccess.runtime_access?.site_url, "https://site.example.test")

const previewLease = {
  schema: PREVIEW_LEASE_SCHEMA,
  local_url: "http://127.0.0.1:9400/",
  lease: { status: "active", provider: "preview-runtime" },
}

const agentPreviewAccess = normalizeAgentTaskRunResult({
  success: true,
  status: "completed",
  preview: {
    url: "https://preview.example.test/",
    localUrl: "http://127.0.0.1:9400/",
    lease: previewLease,
  },
}, { exitStatus: 0 })
assert.equal(agentPreviewAccess.runtime_access?.preview_url, "https://preview.example.test/")
assert.equal(agentPreviewAccess.runtime_access?.local_url, "http://127.0.0.1:9400/")
assert.equal(agentPreviewAccess.runtime_access?.lease?.local_url, "http://127.0.0.1:9400/")

const nestedRuntimeAccess = normalizeAgentTaskRunResult({
  success: true,
  status: "completed",
  outputs: {
    runtime_access: {
      previewPublicUrl: "https://public-preview.example.test/",
      reviewerAccess: { targetUrl: "https://reviewer.example.test/" },
      lease: {
        schema: PREVIEW_LEASE_SCHEMA,
        previewPublicUrl: "https://lease-preview.example.test/",
        localUrl: "http://127.0.0.1:9401/",
      },
    },
  },
}, { exitStatus: 0 })
assert.equal(nestedRuntimeAccess.runtime_access?.preview_url, "https://public-preview.example.test/")
assert.equal(nestedRuntimeAccess.runtime_access?.public_url, "https://public-preview.example.test/")
assert.equal(nestedRuntimeAccess.runtime_access?.lease?.preview_public_url, "https://lease-preview.example.test/")
assert.equal(nestedRuntimeAccess.runtime_access?.lease?.local_url, "http://127.0.0.1:9401/")

const agentLocalLeaseAccess = normalizeAgentTaskRunResult({
  success: true,
  status: "completed",
  preview: { localUrl: "http://127.0.0.1:9400/", lease: previewLease },
}, { exitStatus: 0 })
assert.equal(agentLocalLeaseAccess.runtime_access?.preview_url, "http://127.0.0.1:9400/")
assert.equal(agentLocalLeaseAccess.runtime_access?.local_url, "http://127.0.0.1:9400/")

const recipePreviewAccess = normalizeRecipeRunSummary({
  success: true,
  status: "completed",
  run: {
    preview: {
      url: "https://preview.example.test/",
      localUrl: "http://127.0.0.1:9400/",
      publicUrl: "https://review.example.test/",
      lease: previewLease,
    },
  },
}, { exitStatus: 0 })
assert.equal(recipePreviewAccess.runtime_access?.preview_url, "https://review.example.test/")
assert.equal(recipePreviewAccess.runtime_access?.public_url, "https://review.example.test/")
assert.equal(recipePreviewAccess.runtime_access?.local_url, "http://127.0.0.1:9400/")
assert.equal(recipePreviewAccess.preview?.runtime_access?.lease?.local_url, "http://127.0.0.1:9400/")

const stableRunRequestInput = normalizeAgentTaskRunCliInput({
  schema: AGENT_TASK_RUN_REQUEST_SCHEMA,
  task_id: "stable-run",
  task_input: {
    schema: "wp-codebox/task-input/v1",
    goal: "Run the delegated task.",
  },
  artifacts_path: "/tmp/stable-run-artifacts",
  callback_data: { source: "external-orchestrator" },
})
assert.equal(stableRunRequestInput.goal, "Run the delegated task.")
assert.equal(stableRunRequestInput.artifacts_path, "/tmp/stable-run-artifacts")
assert.deepEqual(stableRunRequestInput.callback_data, { source: "external-orchestrator" })

assert.throws(() => buildAgentTaskRecipe({
  sandbox_tool_policy: {
    schema: "wp-codebox/sandbox-tool-policy/v1",
    version: 1,
    tools: [{
      id: "contradictory-parent-tool",
      runtime_tool_id: "contradictory-parent-tool",
      execution_location: "parent",
      transport_visibility: "parent",
      allowed: true,
      runtime: { environment: "runtime_local", capability_scope: "runtime_local" },
    }],
    metadata: {},
  },
}, normalizeTaskInput({ goal: "Reject contradictory tool runtime metadata." }), "latest"), /must be control_plane for parent tools/)

const headlessRequest = normalizeHeadlessAgentTaskRequest({
  schema: HEADLESS_AGENT_TASK_REQUEST_SCHEMA,
  task_input: {
    goal: "Ship a clean public boundary.",
    target: { kind: "repo", ref: "wp-codebox" },
    expected_artifacts: ["patch", "preview", "evidence"],
  },
  runtime_profile: {
    id: "agent-runtime",
    capabilities: ["wordpress.playground", "agent.task"],
    provider_plugins: [{ slug: "provider-openai" }],
  },
  workspace_artifact_policy: {
    capture: ["patch", "transcript", "evidence"],
    publish: "reviewed",
    retention: "durable",
    public_url_root: "https://artifacts.example.test/run-1/",
  },
  sandbox_session_id: "session-1",
  provider_plugin_paths: ["/internal/provider"],
})
assert.equal(HEADLESS_AGENT_TASK_REQUEST_JSON_SCHEMA.properties.schema.const, HEADLESS_AGENT_TASK_REQUEST_SCHEMA)
assert.equal(HEADLESS_AGENT_TASK_RESULT_JSON_SCHEMA.properties.schema.const, HEADLESS_AGENT_TASK_RESULT_SCHEMA)
assert.equal(headlessRequest.task_input.goal, "Ship a clean public boundary.")
assert.equal(headlessRequest.runtime_profile.schema, "wp-codebox/runtime-profile/v1")
assert.equal(headlessRequest.workspace_artifact_policy.publish, "reviewed")
assert.equal("provider_plugin_paths" in headlessRequest, false)

const headlessRunInput = headlessAgentTaskRequestToRunInput(headlessRequest)
assert.equal(headlessRunInput.goal, "Ship a clean public boundary.")
assert.equal((headlessRunInput.runtime_profile as any).id, "agent-runtime")
assert.equal((headlessRunInput.workspace_artifact_policy as any).retention, "durable")
assert.equal("provider_plugin_paths" in headlessRunInput, false)

const headlessCliInput = normalizeAgentTaskRunCliInput({ ...headlessRequest, provider_plugin_paths: ["/internal/provider"] })
assert.equal(headlessCliInput.goal, "Ship a clean public boundary.")
assert.equal("provider_plugin_paths" in headlessCliInput, false)

const headlessResult = normalizeHeadlessAgentTaskResult(normalizeAgentTaskRunResult({
  success: true,
  status: "completed",
  preview: { publicUrl: "https://preview.example.test/" },
  evidence_refs: [{ id: "evidence-1", path: "evidence.json" }],
}), { request_schema: headlessRequest.schema })
assert.equal(headlessResult.schema, HEADLESS_AGENT_TASK_RESULT_SCHEMA)
assert.equal(headlessResult.preview?.public_url, "https://preview.example.test/")
assert.equal(headlessResult.evidence_refs[0].kind, "codebox-evidence-bundle")
assert.equal(headlessResult.agent_task_run_result.schema, AGENT_TASK_RUN_RESULT_SCHEMA)

const workspaceDeltaResult = normalizeAgentTaskRunResult({
  success: true,
  artifacts: [
    { kind: "codebox-changed-files", path: "files/changed-files.json", bytes: 128, sha256: "changed" },
    { kind: "codebox-patch", path: "files/patch.diff", bytes: 256, sha256: "patch" },
  ],
  agent_result: {
    changedFiles: { artifact: "files/changed-files.json", bytes: 128, count: 1, sha256: "changed" },
    patch: { artifact: "files/patch.diff", bytes: 256, sha256: "patch" },
  },
})
const workspaceDelta = workspaceDeltaFromAgentTaskRunResult(workspaceDeltaResult)
assert.equal(workspaceDelta.schema, WORKSPACE_DELTA_SCHEMA)
assert.equal(workspaceDelta.status, "changed")
assert.equal(workspaceDelta.changed_files?.path, "files/changed-files.json")
assert.equal(workspaceDelta.patch?.path, "files/patch.diff")
assert.equal(normalizeHeadlessAgentTaskResult(workspaceDeltaResult).workspace_delta.status, "changed")
assert.equal(WORKSPACE_DELTA_JSON_SCHEMA.additionalProperties, false)
assert.equal(WORKSPACE_DELTA_JSON_SCHEMA.properties.changed_files.required.includes("path"), true)

assert.equal(workspaceDeltaFromAgentTaskRunResult(normalizeAgentTaskRunResult({ success: true, no_op: true })).status, "no_op")

const hostPathDelta = workspaceDeltaFromAgentTaskRunResult(normalizeAgentTaskRunResult({
  success: true,
  artifacts: [
    { kind: "codebox-changed-files", path: "/private/codebox/files/changed-files.json" },
    { kind: "codebox-patch", path: "/private/codebox/files/patch.diff" },
  ],
}))
assert.equal(hostPathDelta.status, "unavailable")
assert.equal(hostPathDelta.diagnostics.filter((diagnostic) => diagnostic.code === "workspace_delta.artifact_not_portable").length, 2)

for (const path of ["\\private\\codebox\\files\\changed-files.json", "\\\\host\\share\\files\\changed-files.json", "C:\\codebox\\files\\changed-files.json", "files/../changed-files.json"]) {
  const malformedDelta = workspaceDeltaFromAgentTaskRunResult(normalizeAgentTaskRunResult({
    success: true,
    artifacts: [
      { kind: "codebox-changed-files", path },
      { kind: "codebox-patch", path: "files/patch.diff" },
    ],
  }))
  assert.equal(malformedDelta.status, "unavailable")
  assert.equal(malformedDelta.changed_files, undefined)
  assert.equal(JSON.stringify(malformedDelta).includes("private/codebox"), false, "workspace delta never leaks a host artifact path")
}

const inferredFilenameDelta = workspaceDeltaFromAgentTaskRunResult(normalizeAgentTaskRunResult({
  success: true,
  artifacts: [
    { kind: "artifact", path: "files/changed-files.json" },
    { kind: "artifact", path: "files/patch.diff" },
  ],
}))
assert.equal(inferredFilenameDelta.status, "unavailable", "workspace delta only accepts explicitly typed artifacts")

const headlessJsonOutput = agentTaskRunJsonOutput({
  success: true,
  schema: "wp-codebox/agent-task-run/v1",
  status: headlessResult.status,
  session: {},
  task: headlessRequest.task_input.goal,
  task_input: headlessRequest.task_input,
  wp: "latest",
  artifacts: "/tmp/artifacts",
  agent_result: {},
  agent_task_result: {},
  agent_task_run_result: headlessResult.agent_task_run_result,
  completion_outcome: {},
  component_contracts: [],
  structured_artifacts: [],
  typed_artifacts: [],
  outputs: {},
  artifact_result: { schema: ARTIFACT_RESULT_ENVELOPE_SCHEMA, operation: "agent-task-run", status: "created", artifacts: [], refs: [], result: {}, diagnostics: [], metadata: {} },
  run: {},
  diagnostics: [],
  agent_runtime_diagnostics: {},
  evidence_refs: [],
  run_metadata: {},
  metadata: {},
  headless_agent_task_result: headlessResult,
})
assert.equal(headlessJsonOutput.schema, HEADLESS_AGENT_TASK_RESULT_SCHEMA)
assert.equal("run" in headlessJsonOutput, false)

const headlessArtifactUrls = normalizeHeadlessAgentTaskResult(normalizeAgentTaskRunResult({
  success: true,
  status: "completed",
  workspace_artifact_policy: { public_url_root: "https://artifacts.example.test/run-1/" },
  agentResult: {
    artifacts: { directory: "/tmp/codebox-artifacts/run-1" },
    patch: { artifact: "patch.diff", sha256: "abc123" },
    transcript: { artifact: "transcript.jsonl" },
  },
  evidence_refs: [{ id: "evidence-1", path: "/tmp/codebox-artifacts/run-1/evidence.json" }],
}), { request_schema: headlessRequest.schema })
assert.equal(headlessArtifactUrls.refs.patches[0]?.url, "https://artifacts.example.test/run-1/patch.diff")
assert.equal(headlessArtifactUrls.evidence_refs[0]?.url, "https://artifacts.example.test/run-1/evidence.json")

const noOp = normalizeAgentTaskRunResult({ success: true, no_op: true }, { exitStatus: 0 })
assert.equal(noOp.status, "no_op")
assert.equal(agentTaskRunExitCode({ success: true, agent_task_run_result: noOp }), 0)

const timeout = normalizeAgentTaskRunResult({
  success: true,
  terminal_result: {
    schema: "wp-codebox/agent-terminal-result/v1",
    terminal: true,
    status: "max_turns",
    success: false,
  },
}, { exitStatus: 0 })
assert.equal(timeout.status, "timeout")
assert.equal(agentTaskRunExitCode({ success: true, agent_task_run_result: timeout }), 1)

const failedBeforeArtifacts = normalizeAgentTaskRunResult({ success: false, status: "failed", summary: "Runtime failed before artifact capture." }, { exitStatus: 1 })
assert.equal(failedBeforeArtifacts.status, "failed")
assert.equal(failedBeforeArtifacts.success, false)
assert.deepEqual(failedBeforeArtifacts.refs.artifact_bundles, [])

const objectArtifact = normalizeAgentTaskRunResult({
  success: true,
  status: "succeeded",
  artifacts: { kind: "codebox-patch", path: "files/patch.diff", sha256: "abc" },
  agent_result: { artifacts: { directory: "files" } },
})
assert.equal(objectArtifact.refs.patches[0]?.path, "files/patch.diff")

const malformedProviderOutput = normalizeAgentTaskRunResult({ success: false, status: "failed", diagnostics: [{ code: "wp-codebox.output.invalid-json", message: "Invalid JSON" }] }, { exitStatus: 0 })
assert.equal(malformedProviderOutput.status, "failed")
assert.equal(malformedProviderOutput.diagnostics[0].code, "wp-codebox.output.invalid-json")

const failedExit = normalizeAgentTaskRunResult({ success: true, status: "completed" }, { exitStatus: 1 })
assert.equal(failedExit.status, "failed")
assert.equal(agentTaskRunExitCode({ success: true, agent_task_run_result: failedExit }), 1)

const strictNestedTerminal = normalizeAgentTerminalResult({ agent_runtime: { success: true, result: { pending_tools: ["review"], completed: false } } })
assert.equal(strictNestedTerminal, undefined)

const strictRuntimeWorkload = normalizeAgentRuntimeWorkload({ outputs: { answer: "legacy" } })
assert.deepEqual(strictRuntimeWorkload.outputs, {})

const executionChanges = normalizeAgentRuntimeExecutionChanges({
  changedFiles: { count: 1, artifact: "changed-files.json", bytes: 128, sha256: "changed" },
  patch: { artifact: "patch.diff", bytes: 256, sha256: "patch" },
})
const changedRuntimeWorkload = normalizeAgentRuntimeWorkload({}, { executionChanges })
assert.equal(changedRuntimeWorkload.success, true)
assert.equal(changedRuntimeWorkload.diagnostics.some((diagnostic) => diagnostic.data?.reason === "missing_semantic_outputs"), false)
assert.deepEqual(changedRuntimeWorkload.outputs.execution_changes, {
  summary: "Agent execution changed 1 file with a 256-byte patch.",
  changed_files_count: 1,
  patch_bytes: 256,
  refs: [
    { id: "changed-files.json", kind: "codebox-changed-files", path: "changed-files.json", sha256: "changed", size_bytes: 128 },
    { id: "patch.diff", kind: "codebox-patch", path: "patch.diff", sha256: "patch", size_bytes: 256 },
  ],
})
assert.deepEqual(normalizeAgentRuntimeExecutionChanges({ changedFiles: { count: 0 }, patch: { bytes: 0 } }), undefined)
assert.deepEqual(normalizeAgentRuntimeExecutionChanges({ changedFiles: { count: 1 }, patch: { bytes: 0 } }), undefined)
const emptyChangeRuntimeWorkload = normalizeAgentRuntimeWorkload({}, { executionChanges: normalizeAgentRuntimeExecutionChanges({ changedFiles: { count: 0 }, patch: { bytes: 0 } }) })
assert.equal(emptyChangeRuntimeWorkload.success, false)
assert.equal(emptyChangeRuntimeWorkload.diagnostics.some((diagnostic) => diagnostic.data?.reason === "missing_semantic_outputs"), true)

const typedArtifactRefs = normalizeArtifactResultTypedArtifacts({
  typed_artifacts: [{
    schema: TYPED_ARTIFACT_SCHEMA,
    name: "concept_packet",
    type: "wp-site-generator.concept-packet",
    payload_schema: "wp-site-generator/ConceptPacket/v1",
    payload: { title: "Repair Bench Supply" },
    artifact: {
      path: "files/runtime-evidence/typed-artifacts/concept-packet-1.json",
      kind: "typed-artifact",
      contentType: "application/json",
      sha256: "a".repeat(64),
    },
  }],
})
assert.equal(typedArtifactRefs[0]?.schema, TYPED_ARTIFACT_SCHEMA)
assert.equal(typedArtifactRefs[0]?.name, "concept_packet")
assert.equal(typedArtifactRefs[0]?.payload_schema, "wp-site-generator/ConceptPacket/v1")
assert.deepEqual(typedArtifactRefs[0]?.payload, { title: "Repair Bench Supply" })
assert.equal(typedArtifactRefs[0]?.artifact?.path, "files/runtime-evidence/typed-artifacts/concept-packet-1.json")

const snakeCaseAgentTaskResult = agentTaskResultFromRun({
  agent_task_result: {
    outputs: {
      result: {
        engine_data: {
          outputs: {
            typed_artifacts: {
              concept_packet: {
                output_key: "concept_packet",
                schema: "wp-site-generator/ConceptPacket/v1",
                artifact: "ConceptPacket",
                payload: { title: "The Repair Drawer" },
              },
            },
          },
        },
      },
    },
  },
})
assert.deepEqual(normalizeArtifactResultTypedArtifacts(snakeCaseAgentTaskResult), [])

const normalizedWithArtifactEnvelope = normalizeAgentTaskRunResult({
  success: true,
  run: { artifactRefs: [{ id: "bundle-1", kind: "artifact-bundle", directory: "artifacts/run-1" }] },
  agentResult: {
    artifacts: { directory: "artifacts/run-1" },
    summary: "Changed one file",
    transcript: { artifact: "files/transcript.json" },
  },
}, { exitStatus: 0 })
assert.equal(normalizedWithArtifactEnvelope.refs.artifact_bundles[0].path, "artifacts/run-1")
assert.equal(normalizedWithArtifactEnvelope.refs.transcripts[0].kind, "codebox-transcript")
assert.equal(ARTIFACT_RESULT_ENVELOPE_SCHEMA, "wp-codebox/artifact-result-envelope/v1")

const normalizedWithEvidenceBundle = normalizeAgentTaskRunResult({
  success: true,
  evidence_refs: [{ id: "evidence-1", path: "artifacts/run-1/evidence.json", sha256: "abc" }],
}, { exitStatus: 0 })
assert.equal(normalizedWithEvidenceBundle.refs.evidence_bundles[0].kind, "codebox-evidence-bundle")

const catalog = commandCatalogOutput()
const agentSandboxRun = catalog.commands.find((command) => command.id === "wp-codebox.agent-sandbox-run")
assert.ok(agentSandboxRun, "catalog includes wp-codebox.agent-sandbox-run")
assert.equal(agentSandboxRun.acceptedArgs.some((arg) => arg.name === "code"), false)
assert.equal(agentSandboxRun.acceptedArgs.some((arg) => arg.name === "code-file"), false)
assert.deepEqual(agentSandboxRun.requiresPolicyCommands, ["wordpress.run-php", "wordpress.wp-cli"])

const wordpressBench = catalog.commands.find((command) => command.id === "wordpress.bench")
assert.ok(wordpressBench, "catalog includes wordpress.bench")
const workloadsJsonArg = wordpressBench.acceptedArgs.find((arg) => arg.name === "workloads-json")
assert.match(workloadsJsonArg?.description ?? "", /rest-db-query-profiler/)
assert.deepEqual(wordpressBench.requiresPolicyCommands, [
  "wordpress.run-php",
  "wordpress.wp-cli",
  "wordpress.ability",
  "wordpress.rest-request",
  "wordpress.db-operation",
  "wordpress.runtime-discovery",
  "wordpress.inventory-database",
  "wordpress.browser-probe",
])

assert.deepEqual(effectivePolicyCommands("wp-codebox.agent-sandbox-run"), ["wordpress.run-php", "wordpress.wp-cli"])
assert.deepEqual(effectivePolicyCommands("wordpress.bench"), [
  "wordpress.bench",
  "wordpress.run-php",
  "wordpress.wp-cli",
  "wordpress.ability",
  "wordpress.rest-request",
  "wordpress.db-operation",
  "wordpress.runtime-discovery",
  "wordpress.inventory-database",
  "wordpress.browser-probe",
])
assert.deepEqual(effectivePolicyCommands("custom.wrapper", [
  {
    id: "custom.wrapper",
    description: "test wrapper",
    acceptedArgs: [],
    outputShape: "test",
    policyRequirement: "test",
    requiresPolicyCommands: ["custom.inner"],
    recipe: true,
    handler: { kind: "recipe-alias", command: "custom.inner" },
  },
  {
    id: "custom.inner",
    description: "test inner",
    acceptedArgs: [],
    outputShape: "test",
    policyRequirement: "test",
    requiresPolicyCommands: ["wordpress.run-php"],
    recipe: true,
    handler: { kind: "recipe-alias", command: "wordpress.run-php" },
  },
]), ["wordpress.run-php"])

const agentRecipePolicy = recipePolicy({
  schema: "wp-codebox/workspace-recipe/v1",
  workflow: {
    steps: [
      { command: "wp-codebox.agent-sandbox-run", args: ["task=Verify policy dependencies"] },
    ],
  },
} as never)
assert.equal(agentRecipePolicy.commands.includes("wordpress.run-php"), true)
assert.equal(agentRecipePolicy.commands.includes("wordpress.wp-cli"), true)
assert.equal(agentRecipePolicy.commands.includes("wp-codebox.agent-sandbox-run"), false)

const benchRecipePolicy = recipePolicy({
  schema: "wp-codebox/workspace-recipe/v1",
  workflow: {
    steps: [
      { command: "wordpress.bench", args: ["plugin-slug=sample-plugin"] },
    ],
  },
} as never)
assert.equal(benchRecipePolicy.commands.includes("wordpress.bench"), true)
assert.equal(benchRecipePolicy.commands.includes("wordpress.run-php"), true)

const generatedAgentSandboxPhp = agentSandboxRunCode("Verify registry adapter", "echo 'ok';", [], [])
assert.doesNotMatch(generatedAgentSandboxPhp, /DataMachine\\Core\\Database\\Agents\\Agents|data_machine_agent_create_failed|agents-api\/agents-api\.php/)
const generatedDefaultAgentPhp = await resolveSandboxTaskCode({
  task: "Verify registry adapter",
  agent: "wp-codebox-sandbox",
  sandboxToolPolicy: { schema: "wp-codebox/sandbox-tool-policy/v1", version: 1, tools: [] },
})
assert.doesNotMatch(generatedDefaultAgentPhp, /DataMachine\\Core\\Database\\Agents\\Agents|data_machine_agent_create_failed/)
assert.match(generatedDefaultAgentPhp, /wp_codebox_runtime_agent_registry_ensure_agent/)

const agentRecipeTemp = mkdtempSync(join(tmpdir(), "wp-codebox-agent-recipe-test-"))
const originalCwd = cwd()
const originalAgentsApiPath = process.env.WP_CODEBOX_AGENTS_API_PATH
const originalDataMachinePath = process.env.WP_CODEBOX_DATA_MACHINE_PATH
const originalDataMachineCodePath = process.env.WP_CODEBOX_DATA_MACHINE_CODE_PATH
const originalRuntimeComponentPaths = process.env.WP_CODEBOX_AGENT_RUNTIME_COMPONENT_PATHS
const originalContainedRuntimeComponentPaths = process.env.CONTAINED_RUNTIME_COMPONENT_PATHS
try {
  const workspaceRoot = join(agentRecipeTemp, "workspace")
  mkdirSync(workspaceRoot)
  chdir(workspaceRoot)

  const agentsApiSource = join(agentRecipeTemp, "agents-api")
  mkdirSync(agentsApiSource)
  writeFileSync(join(agentsApiSource, "agents-api.php"), "<?php\n/* Plugin Name: Agents API */\n")
  const dataMachineSource = join(agentRecipeTemp, "data-machine")
  const bundledAgentsApiSource = join(dataMachineSource, "vendor", "wordpress", "agents-api")
  mkdirSync(bundledAgentsApiSource, { recursive: true })
  writeFileSync(join(dataMachineSource, "data-machine.php"), "<?php\n/* Plugin Name: Data Machine */\n")
  writeFileSync(join(bundledAgentsApiSource, "agents-api.php"), "<?php\n/* Plugin Name: Agents API */\n")
  const dataMachineCodeSource = join(agentRecipeTemp, "data-machine-code")
  mkdirSync(dataMachineCodeSource)
  writeFileSync(join(dataMachineCodeSource, "data-machine-code.php"), "<?php\n/* Plugin Name: Data Machine Code */\n")
  const providerSource = join(agentRecipeTemp, "test-provider")
  mkdirSync(providerSource)
  writeFileSync(join(providerSource, "test-provider.php"), "<?php\n/* Plugin Name: Test Provider */\n")
  const profileProviderSource = join(agentRecipeTemp, "profile-provider")
  mkdirSync(profileProviderSource)
  writeFileSync(join(profileProviderSource, "profile-provider.php"), "<?php\n/* Plugin Name: Profile Provider */\n")
  const profileComponentSource = join(agentRecipeTemp, "profile-component")
  mkdirSync(profileComponentSource)
  writeFileSync(join(profileComponentSource, "profile-component.php"), "<?php\n/* Plugin Name: Profile Component */\n")
  const bridgeSource = join(agentRecipeTemp, "agent-runtime-tool-bridge")
  mkdirSync(bridgeSource)
  writeFileSync(join(bridgeSource, "agent-runtime-tool-bridge.php"), "<?php\n/* Plugin Name: Agent Runtime Tool Bridge */\n")
  const helperSource = join(agentRecipeTemp, "agent-runtime-helper")
  mkdirSync(helperSource)
  writeFileSync(join(helperSource, "agent-runtime-helper.php"), "<?php\n/* Plugin Name: Agent Runtime Helper */\n")
  const artifactsPath = join(agentRecipeTemp, "artifacts")
  mkdirSync(artifactsPath)

  const genericRecipe = buildAgentTaskRecipe({
    goal: "Verify generic runtime propagation",
    artifacts_path: artifactsPath,
    provider_plugin_paths: [providerSource],
    runtime_profile: {
      schema: "wp-codebox/runtime-profile/v1",
      provider_plugins: [{ slug: "profile-provider", source: profileProviderSource }],
      component_contracts: [{ slug: "profile-component", source: profileComponentSource, loadAs: "mu-plugin" }],
      env: { PROFILE_ENV: "1" },
      runtime_overlays: [{ slug: "profile-overlay" }],
    },
  }, normalizeTaskInput({ goal: "Verify generic runtime propagation" }), "latest")
  assert.equal(genericRecipe.inputs?.extra_plugins?.some((plugin) => plugin.pluginFile === "wordpress-plugin/wp-codebox.php"), true)
  assert.equal(genericRecipe.inputs?.component_manifest?.components.some((component) => component.pluginFile === "wordpress-plugin/wp-codebox.php"), true)
  assert.equal(genericRecipe.inputs?.extra_plugins?.some((plugin) => plugin.slug === "agents-api"), true)
  assert.equal(genericRecipe.inputs?.component_manifest?.components.some((component) => component.slug === "agents-api"), true)
  // Default runtime substrate is agents-api + the bundled wp-codebox plugin only.
  // Data Machine / Data Machine Code are no longer mounted by default; they are
  // provisioned only when a caller passes them explicitly (see the explicit
  // component_contracts recipe below).
  assert.equal(genericRecipe.inputs?.extra_plugins?.some((plugin) => plugin.slug === "data-machine"), false)
  assert.equal(genericRecipe.inputs?.extra_plugins?.some((plugin) => plugin.slug === "data-machine-code"), false)
  assert.equal(genericRecipe.inputs?.component_manifest?.components.some((component) => component.slug === "data-machine"), false)
  assert.equal(genericRecipe.inputs?.component_manifest?.components.some((component) => component.slug === "data-machine-code"), false)
  assert.equal(genericRecipe.inputs?.extra_plugins?.some((plugin) => plugin.slug === "profile-provider"), true)
  assert.equal(genericRecipe.inputs?.component_manifest?.providers.some((component) => component.slug === "profile-provider"), true)
  assert.equal(genericRecipe.inputs?.component_manifest?.components.some((component) => component.slug === "profile-component"), true)
  assert.equal(genericRecipe.inputs?.runtimeEnv?.PROFILE_ENV, "1")
  assert.equal(genericRecipe.runtime?.overlays?.some((overlay) => overlay.slug === "profile-overlay"), true)
  const genericSandboxStepArgs = genericRecipe.workflow.steps.find((step) => step.command === "wp-codebox.agent-sandbox-run")?.args ?? []
  const genericRuntimeComponentsArg = genericSandboxStepArgs.find((arg) => arg.startsWith("runtime-component-contracts-json=")) ?? "runtime-component-contracts-json=[]"
  const genericRuntimeComponents = JSON.parse(genericRuntimeComponentsArg.slice("runtime-component-contracts-json=".length)) as Array<{ slug?: string }>
  assert.equal(genericRuntimeComponents.some((component) => component.slug === "wordpress-plugin"), true)
  assert.equal(genericRuntimeComponents.some((component) => component.slug === "agents-api"), true)
  assert.equal(genericRuntimeComponents.some((component) => component.slug === "data-machine"), false)
  assert.equal(genericRuntimeComponents.some((component) => component.slug === "data-machine-code"), false)

  const recipe = buildAgentTaskRecipe({
    goal: "Verify extra plugin propagation",
    artifacts_path: artifactsPath,
    provider_plugin_paths: [providerSource],
    component_contracts: [
      { slug: "agents-api", source: agentsApiSource, pluginFile: "agents-api/agents-api.php", loadAs: "mu-plugin" },
      { slug: "data-machine", source: dataMachineSource, pluginFile: "data-machine/data-machine.php", loadAs: "mu-plugin" },
      { slug: "data-machine-code", source: dataMachineCodeSource, pluginFile: "data-machine-code/data-machine-code.php", loadAs: "mu-plugin" },
    ],
    extra_plugins: [{
      source: bridgeSource,
      slug: "agent-runtime-tool-bridge",
      loadAs: "mu-plugin",
      activate: false,
      pluginFile: "agent-runtime-tool-bridge/agent-runtime-tool-bridge.php",
      metadata: { source: "agent-task-input" },
    }, {
      source: providerSource,
      slug: "test-provider",
      loadAs: "plugin",
      activate: true,
    }, {
      source: helperSource,
      slug: "agent-runtime-helper",
      loadAs: "plugin",
      activate: true,
      pluginFile: "agent-runtime-helper/agent-runtime-helper.php",
    }],
  }, normalizeTaskInput({ goal: "Verify extra plugin propagation" }), "latest")
  const extraPlugins = recipe.inputs?.extra_plugins ?? []
  const agentsApiPlugin = extraPlugins.find((plugin) => plugin.slug === "agents-api")
  assert.equal(agentsApiPlugin?.pluginFile, "agents-api/agents-api.php")
  assert.equal(agentsApiPlugin?.activate, false)
  assert.equal(agentsApiPlugin?.loadAs, "mu-plugin")
  assert.equal(recipe.inputs?.component_manifest?.components.some((component) => component.slug === "agents-api" && component.loadAs === "mu-plugin"), true)
  assert.equal(recipe.inputs?.component_manifest?.components.some((component) => component.slug === "data-machine" && component.loadAs === "mu-plugin"), true)
  assert.equal(recipe.inputs?.component_manifest?.components.some((component) => component.slug === "data-machine-code" && component.loadAs === "mu-plugin"), true)
  assert.equal(recipe.inputs?.component_manifest?.components.some((component) => String(component.mountedPath).includes("/contained-runtime/")), true)
  assert.equal(JSON.stringify(recipe).includes("wp-codebox-default-agent-runtime-substrate"), false)
  assert.equal(JSON.stringify(recipe).includes("wp-codebox-runtime"), false)
  assert.equal(extraPlugins.some((plugin) => plugin.slug === "test-provider" && plugin.activate === true && plugin.loadAs === "plugin"), true)
  assert.equal(extraPlugins.filter((plugin) => plugin.slug === "test-provider" && plugin.loadAs === "plugin").length, 1)
  assert.deepEqual(extraPlugins.find((plugin) => plugin.slug === "agent-runtime-tool-bridge"), {
    source: bridgeSource,
    slug: "agent-runtime-tool-bridge",
    pluginFile: "agent-runtime-tool-bridge/agent-runtime-tool-bridge.php",
    activate: false,
    loadAs: "mu-plugin",
    metadata: { source: "agent-task-input" },
  })
  assert.deepEqual(extraPlugins.find((plugin) => plugin.slug === "agent-runtime-helper"), {
    source: helperSource,
    slug: "agent-runtime-helper",
    pluginFile: "agent-runtime-helper/agent-runtime-helper.php",
    activate: true,
    loadAs: "plugin",
  })

  const recipePath = join(agentRecipeTemp, "recipe.json")
  writeFileSync(recipePath, JSON.stringify(recipe, null, 2))
  const dryRun = await dryRunRecipe({ recipePath, artifactsDirectory: artifactsPath }, {
    defaultWordPressVersion: "latest",
    resolveExecutionSpec: async (step) => ({ command: step.command, args: step.args ?? [] }),
  })
  assert.equal(dryRun.success, true)
  assert.deepEqual(dryRun.plan?.runtime.blueprint, { steps: [] })
} finally {
  chdir(originalCwd)
  if (originalAgentsApiPath === undefined) {
    delete process.env.WP_CODEBOX_AGENTS_API_PATH
  } else {
    process.env.WP_CODEBOX_AGENTS_API_PATH = originalAgentsApiPath
  }
  if (originalDataMachinePath === undefined) {
    delete process.env.WP_CODEBOX_DATA_MACHINE_PATH
  } else {
    process.env.WP_CODEBOX_DATA_MACHINE_PATH = originalDataMachinePath
  }
  if (originalDataMachineCodePath === undefined) {
    delete process.env.WP_CODEBOX_DATA_MACHINE_CODE_PATH
  } else {
    process.env.WP_CODEBOX_DATA_MACHINE_CODE_PATH = originalDataMachineCodePath
  }
  if (originalRuntimeComponentPaths === undefined) {
    delete process.env.WP_CODEBOX_AGENT_RUNTIME_COMPONENT_PATHS
  } else {
    process.env.WP_CODEBOX_AGENT_RUNTIME_COMPONENT_PATHS = originalRuntimeComponentPaths
  }
  if (originalContainedRuntimeComponentPaths === undefined) {
    delete process.env.CONTAINED_RUNTIME_COMPONENT_PATHS
  } else {
    process.env.CONTAINED_RUNTIME_COMPONENT_PATHS = originalContainedRuntimeComponentPaths
  }
  rmSync(agentRecipeTemp, { recursive: true, force: true })
}

console.log("agent task contracts passed")
