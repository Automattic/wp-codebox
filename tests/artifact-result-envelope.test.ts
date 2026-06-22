import assert from "node:assert/strict"
import { ARTIFACT_RESULT_ENVELOPE_SCHEMA, artifactResultEnvelope, normalizeArtifactResultEnvelope } from "../packages/runtime-core/src/index.js"

const envelope = artifactResultEnvelope({
  operation: "agent-task-run",
  status: "created",
  artifactBundle: { kind: "artifact-bundle", path: "artifacts/run-1", digest: { algorithm: "sha256", value: "abc" } },
  artifactRefs: [{ kind: "codebox-patch", path: "files/patch.diff" }],
  evidenceRefs: [{ kind: "evidence-bundle", path: "files/evidence.json" }],
  result: {
    typed_artifacts: [{ name: "report", artifact_schema: "example/report/v1", payload: { ok: true } }],
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
assert.deepEqual(envelope.result?.outputs, { answer: 42 })
assert.equal(envelope.result?.typed_artifacts?.[0]?.name, "report")

const normalized = normalizeArtifactResultEnvelope({
  schema: ARTIFACT_RESULT_ENVELOPE_SCHEMA,
  operation: "agent-task-run",
  status: "created",
  artifactBundle: { kind: "bundle", path: "artifacts/run-2" },
  artifactRefs: [{ kind: "log", path: "files/log.txt" }],
  evidenceRefs: [{ kind: "probe", path: "files/probe.json" }],
  result: { ok: true },
})

assert.equal(normalized.artifactBundle?.kind, "bundle")
assert.equal(normalized.artifactRefs[0].path, "artifacts/run-2")
assert.equal(normalized.evidenceRefs[0].path, "files/probe.json")
assert.deepEqual(normalized.result, { ok: true })
assert.deepEqual(normalized.diagnostics, [])

console.log("artifact result envelope contract passed")
