import assert from "node:assert/strict"
import { resolve } from "node:path"
import {
  artifactStoragePath,
  artifactStoragePublicUrl,
  materializationPhaseResult,
  materializationRunArtifactRefs,
  runtimeArtifactStorageDescriptor,
  trustedBrowserSessionOrigin,
  trustedBrowserSessionOrigins,
} from "../packages/runtime-core/src/index.js"

const storage = runtimeArtifactStorageDescriptor({
  root: "./artifacts",
  publicUrlRoot: "https://example.test/codebox///?ignored=1#hash",
  pathPrefix: "/runs/run-1/",
})

assert.equal(storage.schema, "wp-codebox/runtime-artifact-storage/v1")
assert.equal(storage.root, resolve("./artifacts"))
assert.equal(storage.publicUrlRoot, "https://example.test/codebox")
assert.equal(storage.pathPrefix, "runs/run-1")
assert.equal(artifactStoragePath(storage, "files/output.json"), "runs/run-1/files/output.json")
assert.equal(artifactStoragePublicUrl(storage, "files/output.json"), "https://example.test/codebox/runs/run-1/files/output.json")

assert.throws(() => runtimeArtifactStorageDescriptor({ root: "./artifacts", pathPrefix: "../escape" }), /parent-directory/)
assert.throws(() => runtimeArtifactStorageDescriptor({ root: "./artifacts", publicUrlRoot: "file:///tmp/artifacts" }), /http/)

assert.deepEqual(trustedBrowserSessionOrigin("http://localhost:8881/path?x=1"), {
  schema: "wp-codebox/trusted-browser-session-origin/v1",
  origin: "http://localhost:8881",
  secure: true,
  loopback: true,
})
assert.throws(() => trustedBrowserSessionOrigin("http://example.test"), /https/)
assert.equal(trustedBrowserSessionOrigins(["https://example.test/a", "https://example.test/b"]).length, 1)

const phase = materializationPhaseResult({
  phase: "persist-browser-artifacts",
  status: "completed",
  artifactRefs: [{ kind: "browser-bundle", path: "files/browser/index.html", digest: { algorithm: "sha256", value: "abc" } }],
})
assert.equal(phase.schema, "wp-codebox/materialization-phase-result/v1")
assert.deepEqual(materializationRunArtifactRefs([phase]), [
  {
    kind: "materialization:browser-bundle",
    path: "files/browser/index.html",
    digest: { algorithm: "sha256", value: "abc" },
  },
])
