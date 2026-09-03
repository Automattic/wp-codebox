import assert from "node:assert/strict"
import { isChangedFilesArtifactRef, isLogArtifactRef, isPatchArtifactRef, isTranscriptArtifactRef } from "../packages/runtime-core/src/artifact-ref-classification.js"
import { normalizeAgentTaskRunResult, publicArtifactRefGroups, workspaceDeltaFromAgentTaskRunResult } from "../packages/runtime-core/src/index.js"

// A reference that only looks like a patch by path must never be trusted as one.
// Typed classification feeds the workspace delta, and a delta patch can be applied.
const untypedPatch = { kind: "artifact", path: "files/patch.diff" }
const untypedChangedFiles = { kind: "artifact", path: "files/changed-files.json" }

assert.equal(isPatchArtifactRef(untypedPatch), false, "typed mode rejects path-inferred patches")
assert.equal(isChangedFilesArtifactRef(untypedChangedFiles), false, "typed mode rejects path-inferred changed files")
assert.equal(isPatchArtifactRef(untypedPatch, "discovery"), true, "discovery mode infers patches from path")
assert.equal(isChangedFilesArtifactRef(untypedChangedFiles, "discovery"), true, "discovery mode infers changed files from path")

// Declared kinds are trusted in both modes.
for (const mode of ["typed", "discovery"] as const) {
  assert.equal(isPatchArtifactRef({ kind: "codebox-patch" }, mode), true, `declared patch kind is classified in ${mode} mode`)
  assert.equal(isChangedFilesArtifactRef({ kind: "codebox-changed-files" }, mode), true, `declared changed-files kind is classified in ${mode} mode`)
  assert.equal(isTranscriptArtifactRef({ kind: "codebox-transcript" }, mode), true, `declared transcript kind is classified in ${mode} mode`)
  assert.equal(isLogArtifactRef({ kind: "codebox-runtime-log" }, mode), true, `declared runtime log kind is classified in ${mode} mode`)
}

// Loosely named kinds stay out of typed groups but remain discoverable.
assert.equal(isTranscriptArtifactRef({ kind: "agent-transcript" }), false, "typed mode requires the declared transcript kind")
assert.equal(isTranscriptArtifactRef({ kind: "agent-transcript" }, "discovery"), true, "discovery mode matches transcript-like kinds")
assert.equal(isLogArtifactRef({ kind: "artifact", path: "files/run.jsonl" }), false, "typed mode requires a declared log kind")
assert.equal(isLogArtifactRef({ kind: "artifact", path: "files/run.jsonl" }, "discovery"), true, "discovery mode infers logs from path")

// The two consumers of the classifier keep their respective modes end to end.
const untypedArtifacts = [untypedChangedFiles, untypedPatch]
const runResult = normalizeAgentTaskRunResult({ success: true, artifacts: untypedArtifacts })
assert.deepEqual(runResult.refs.patches, [], "agent task run refs stay typed")
assert.deepEqual(runResult.refs.changed_files, [], "agent task run refs reject inferred changed files")
assert.equal(workspaceDeltaFromAgentTaskRunResult(runResult).status, "unavailable", "workspace delta refuses untyped change evidence")

const discovered = publicArtifactRefGroups({ artifacts: untypedArtifacts })
assert.equal(discovered.patches.length, 1, "public discovery projection still surfaces the patch")
assert.equal(discovered.changed_files.length, 1, "public discovery projection still surfaces changed files")

console.log("artifact ref classification ok")
