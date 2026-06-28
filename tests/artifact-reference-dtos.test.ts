import assert from "node:assert/strict"

import {
  BROWSER_SESSION_PRODUCT_DTO_SCHEMA,
  PUBLIC_ARTIFACT_REF_DTO_SCHEMA,
  TYPED_ARTIFACT_INDEX_SCHEMA,
  TYPED_ARTIFACT_SCHEMA,
  changedFilesArtifactRefs,
  findChangedFilesArtifactRef,
  findPatchArtifactRef,
  normalizeBrowserSessionProductDTO,
  normalizePublicArtifactRefDTO,
  normalizePublicArtifactRefDTOs,
  normalizeTypedArtifactDTO,
  normalizeTypedArtifactIndex,
  patchArtifactRefs,
  publicArtifactRefGroups,
} from "../packages/runtime-core/src/index.js"

const ref = normalizePublicArtifactRefDTO({
  artifact_id: "bundle-1",
  directory: "artifacts/run-1",
  contentDigest: "abc123",
})

assert.equal(ref?.schema, PUBLIC_ARTIFACT_REF_DTO_SCHEMA)
assert.equal(ref?.kind, "artifact")
assert.equal(ref?.id, "bundle-1")
assert.equal(ref?.path, "artifacts/run-1")
assert.equal(ref?.sha256, "abc123")
assert.deepEqual(ref?.digest, { algorithm: "sha256", value: "abc123" })

const runResult = {
  artifacts: {
    id: "bundle-1",
    directory: "artifacts/run-1",
    changedFilesPath: "artifacts/run-1/files/changed-files.json",
    patchPath: "artifacts/run-1/files/patch.diff",
  },
  agent_task_run_result: {
    refs: {
      changed_files: [{ kind: "codebox-changed-files", path: "artifacts/run-1/files/changed-files.json" }],
      patches: [{ kind: "codebox-patch", path: "artifacts/run-1/files/patch.diff", sha256: "patch-sha" }],
      logs: [{ kind: "codebox-runtime-log", path: "artifacts/run-1/events.jsonl" }],
    },
  },
}

const refs = normalizePublicArtifactRefDTOs(runResult)
const groups = publicArtifactRefGroups(runResult)

assert.equal(refs.filter((item) => item.path === "artifacts/run-1/files/changed-files.json").length, 1)
assert.equal(groups.artifact_bundles[0]?.path, "artifacts/run-1")
assert.equal(groups.changed_files[0]?.path, "artifacts/run-1/files/changed-files.json")
assert.equal(groups.patches[0]?.sha256, "patch-sha")
assert.equal(groups.logs[0]?.path, "artifacts/run-1/events.jsonl")
assert.equal(changedFilesArtifactRefs(runResult)[0]?.kind, "codebox-changed-files")
assert.equal(patchArtifactRefs(runResult)[0]?.kind, "codebox-patch")
assert.equal(findChangedFilesArtifactRef(runResult)?.path, "artifacts/run-1/files/changed-files.json")
assert.equal(findPatchArtifactRef(runResult)?.path, "artifacts/run-1/files/patch.diff")

const session = normalizeBrowserSessionProductDTO({
  schema: "wp-codebox/browser-playground-session/v1",
  success: true,
  session: { id: "browser-session-1" },
  task_input: {
    goal: "Inspect checkout",
    target: { kind: "browser-playground", token: "secret-token" },
  },
  artifacts: {
    path: "artifacts/browser-session-1",
    changedFilesPath: "artifacts/browser-session-1/files/changed-files.json",
    patchPath: "artifacts/browser-session-1/files/patch.diff",
    content: "raw bundle content omitted",
  },
  contained_site: {
    preview_url: "https://example.test/",
    runtime: { internal: true },
    api_key: "secret",
  },
})

assert.equal(session.schema, BROWSER_SESSION_PRODUCT_DTO_SCHEMA)
assert.equal(session.status, "ready")
assert.equal(session.session_id, "browser-session-1")
assert.equal(session.task, "Inspect checkout")
assert.equal(session.target?.token, "[redacted]")
assert.equal(session.contained_site?.preview_url, "https://example.test/")
assert.equal(session.contained_site?.runtime, undefined)
assert.equal(session.contained_site?.api_key, "[redacted]")
assert.equal(session.artifacts?.content, undefined)
assert.equal(session.artifact_refs.changed_files[0]?.path, "artifacts/browser-session-1/files/changed-files.json")
assert.equal(session.artifact_refs.patches[0]?.path, "artifacts/browser-session-1/files/patch.diff")

const typedArtifact = normalizeTypedArtifactDTO({
  schema: TYPED_ARTIFACT_SCHEMA,
  name: "review-summary",
  type: "review",
  payload_schema: "example/review/v1",
  payload: { status: "passed" },
  source: "runtime-command",
  artifact: {
    path: "files/typed/review-summary.json",
    contentType: "application/json",
    sha256: "d".repeat(64),
  },
  metadata: { scenario: "homepage" },
})

assert.equal(typedArtifact?.schema, TYPED_ARTIFACT_SCHEMA)
assert.equal(typedArtifact?.name, "review-summary")
assert.equal(typedArtifact?.type, "review")
assert.equal(typedArtifact?.payload_schema, "example/review/v1")
assert.deepEqual(typedArtifact?.payload, { status: "passed" })
assert.equal(typedArtifact?.provenance.source, "runtime-command")
assert.equal(typedArtifact?.artifact.path, "files/typed/review-summary.json")
assert.equal(typedArtifact?.artifact.kind, "typed-artifact")
assert.equal(typedArtifact?.artifact.contentType, "application/json")
assert.equal(typedArtifact?.artifact.sha256, "d".repeat(64))

const typedIndex = normalizeTypedArtifactIndex({ artifacts: [typedArtifact, { name: "bad", type: "missing-artifact" }] })
assert.equal(typedIndex.schema, TYPED_ARTIFACT_INDEX_SCHEMA)
assert.equal(typedIndex.direction, "output")
assert.equal(typedIndex.artifacts.length, 1)
assert.equal(typedIndex.artifacts[0]?.artifact.path, "files/typed/review-summary.json")

console.log("artifact reference dto helpers passed")
