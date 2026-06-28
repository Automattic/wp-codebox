import assert from "node:assert/strict"
import { Buffer } from "node:buffer"
import {
  STRUCTURED_ARTIFACT_INDEX_SCHEMA,
  STRUCTURED_ARTIFACT_SCHEMA,
  TYPED_ARTIFACT_SCHEMA,
  TYPED_ARTIFACT_INDEX_SCHEMA,
  materializeStructuredArtifactFiles,
  type StructuredArtifactPayload,
  type TypedArtifactRef,
} from "../packages/runtime-core/src/index.js"

const agentArtifact: StructuredArtifactPayload = {
  schema: STRUCTURED_ARTIFACT_SCHEMA,
  name: "Summary Report",
  type: "example.summary",
  payload: { ok: true },
  metadata: { source: "agent" },
  provenance: { direction: "output", source: "agent-runtime" },
}

const agentMaterialized = materializeStructuredArtifactFiles({
  artifacts: [agentArtifact],
  artifactPathPrefix: "files/structured-artifacts",
  artifactKind: "structured-artifact",
  indexKind: "structured-artifacts-index",
  indexSchema: STRUCTURED_ARTIFACT_INDEX_SCHEMA,
})

assert.equal(agentMaterialized.files[0].path, "files/structured-artifacts/summary-report-1.json")
assert.equal(agentMaterialized.files[0].kind, "structured-artifact")
assert.equal(agentMaterialized.files[1].path, "files/structured-artifacts/index.json")
assert.equal(agentMaterialized.files[1].kind, "structured-artifacts-index")
assert.deepEqual(agentMaterialized.index, {
  schema: STRUCTURED_ARTIFACT_INDEX_SCHEMA,
  direction: "output",
  artifacts: agentMaterialized.refs,
})
assert.deepEqual(agentMaterialized.refs[0].artifact, {
  path: "files/structured-artifacts/summary-report-1.json",
  kind: "structured-artifact",
  contentType: "application/json",
  sha256: agentMaterialized.files[0].sha256.value,
})

const typedArtifact: StructuredArtifactPayload = {
  schema: STRUCTURED_ARTIFACT_SCHEMA,
  name: "Summary Report",
  type: "example.summary",
  payload_schema: "https://example.test/schema.json",
  payload: { ok: true },
  metadata: { source: "recipe" },
  provenance: { direction: "output", source: "/tmp/summary.json" },
}
const typedContents = Buffer.from(JSON.stringify({ ok: true }))
const typedMaterialized = materializeStructuredArtifactFiles<StructuredArtifactPayload, TypedArtifactRef>({
  artifacts: [typedArtifact],
  artifactPathPrefix: "files/runtime-evidence/typed-artifacts",
  artifactKind: "typed-artifact",
  indexKind: "typed-artifacts-index",
  indexSchema: TYPED_ARTIFACT_INDEX_SCHEMA,
  contentType: "application/json",
  contents: () => typedContents,
})

assert.equal(typedMaterialized.files[0].path, "files/runtime-evidence/typed-artifacts/summary-report-1.json")
assert.equal(typedMaterialized.files[0].kind, "typed-artifact")
assert.equal(typedMaterialized.files[1].path, "files/runtime-evidence/typed-artifacts/index.json")
assert.equal(typedMaterialized.files[1].kind, "typed-artifacts-index")
assert.deepEqual(typedMaterialized.index, {
  schema: TYPED_ARTIFACT_INDEX_SCHEMA,
  direction: "output",
  artifacts: typedMaterialized.refs,
})
assert.deepEqual(typedMaterialized.refs[0].artifact, {
  path: "files/runtime-evidence/typed-artifacts/summary-report-1.json",
  kind: "typed-artifact",
  contentType: "application/json",
  sha256: typedMaterialized.files[0].sha256.value,
})
assert.equal(typedMaterialized.refs[0].schema, TYPED_ARTIFACT_SCHEMA)

console.log("structured artifact materializer passed")
