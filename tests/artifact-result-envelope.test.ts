import assert from "node:assert/strict"
import { ARTIFACT_RESULT_ENVELOPE_SCHEMA, TYPED_ARTIFACT_SCHEMA, artifactResultEnvelope, normalizeArtifactResultEnvelope } from "../packages/runtime-core/src/index.js"

const envelope = artifactResultEnvelope({
  operation: "agent-task-run",
  status: "created",
  artifactBundle: { kind: "artifact-bundle", path: "artifacts/run-1", digest: { algorithm: "sha256", value: "abc" } },
  artifactRefs: [{ kind: "codebox-patch", path: "files/patch.diff" }],
  evidenceRefs: [{ kind: "evidence-bundle", path: "files/evidence.json" }],
  typedArtifacts: [{
    schema: TYPED_ARTIFACT_SCHEMA,
    name: "runtime-package-report",
    type: "application/json",
    payload_schema: "example/report/v1",
    payload: { ok: true },
    artifact: {
      path: "files/runtime-evidence/typed-artifacts/runtime-package-report-1.json",
      kind: "typed-artifact",
      contentType: "application/json",
      sha256: "a".repeat(64),
    },
  }],
  result: {
    outputs: { answer: 42 },
  },
  diagnostics: [{ code: "wp-codebox.test", message: "test diagnostic", severity: "info" }],
  metadata: { runtime_id: "runtime-1" },
})

assert.equal(envelope.schema, ARTIFACT_RESULT_ENVELOPE_SCHEMA)
assert.equal(envelope.success, true)
assert.equal(envelope.artifactBundle?.path, "artifacts/run-1")
assert.equal(envelope.artifactRefs.length, 2)
assert.deepEqual(envelope.evidenceRefs, [{ kind: "evidence-bundle", path: "files/evidence.json" }])
assert.equal(envelope.typed_artifacts[0]?.schema, TYPED_ARTIFACT_SCHEMA)
assert.equal(envelope.typed_artifacts[0]?.name, "runtime-package-report")
assert.equal(envelope.typed_artifacts[0]?.payload_schema, "example/report/v1")
assert.deepEqual(envelope.typed_artifacts[0]?.payload, { ok: true })
assert.equal(envelope.typed_artifacts[0]?.artifact?.path, "files/runtime-evidence/typed-artifacts/runtime-package-report-1.json")
assert.deepEqual(envelope.result?.outputs, { answer: 42 })

const normalized = normalizeArtifactResultEnvelope({
  schema: ARTIFACT_RESULT_ENVELOPE_SCHEMA,
  operation: "agent-task-run",
  status: "created",
  artifactBundle: { kind: "bundle", path: "artifacts/run-2" },
  artifactRefs: [{ kind: "log", path: "files/log.txt" }],
  evidenceRefs: [{ kind: "probe", path: "files/probe.json" }],
  typed_artifacts: [{
    schema: TYPED_ARTIFACT_SCHEMA,
    name: "runtime-package-inline",
    type: "example.inline",
    payload_schema: { type: "object" },
    payload: { answer: 42 },
    metadata: { runtime_package: "example/package" },
    provenance: { source: "wp-codebox/run-runtime-package" },
  }],
  result: { ok: true, typed_artifacts: [{ name: "ignored", type: "example.ignored", payload: {} }] },
})

assert.equal(normalized.artifactBundle?.kind, "bundle")
assert.equal(normalized.artifactRefs[0].path, "artifacts/run-2")
assert.equal(normalized.evidenceRefs[0].path, "files/probe.json")
assert.equal(normalized.typed_artifacts.length, 1)
assert.equal(normalized.typed_artifacts[0]?.name, "runtime-package-inline")
assert.deepEqual(normalized.typed_artifacts[0]?.payload, { answer: 42 })
assert.deepEqual(normalized.result, { ok: true })
assert.deepEqual(normalized.diagnostics, [])

console.log("artifact result envelope contract passed")
