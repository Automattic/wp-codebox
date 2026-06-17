import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { mkdtempSync } from "node:fs"
import {
  artifactFileDigest,
  artifactManifestRelativePath,
  resolveArtifactPath,
  safeArtifactRelativePath,
  artifactStoragePath,
  artifactStoragePublicUrl,
  materializationPhaseResult,
  materializationRunArtifactRefs,
  normalizeArtifactPartPath,
  normalizeRecipeMounts,
  normalizeSharedMounts,
  runtimeArtifactStorageDescriptor,
  trustedBrowserSessionOrigin,
  trustedBrowserSessionOrigins,
  writeArtifactPart,
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
assert.equal(safeArtifactRelativePath("/files//output.json"), "files/output.json")
assert.equal(resolveArtifactPath(storage.root, "files/output.json").relativePath, "files/output.json")
assert.equal(artifactManifestRelativePath(storage.root, resolve(storage.root, "files/output.json")), "files/output.json")

assert.throws(() => runtimeArtifactStorageDescriptor({ root: "./artifacts", pathPrefix: "../escape" }), /parent-directory/)
assert.throws(() => runtimeArtifactStorageDescriptor({ root: "./artifacts", publicUrlRoot: "file:///tmp/artifacts" }), /http/)
assert.throws(() => safeArtifactRelativePath("files/../secret.txt"), /parent-directory/)
assert.throws(() => resolveArtifactPath(storage.root, "../secret.txt"), /parent-directory/)
assert.throws(() => artifactManifestRelativePath(storage.root, resolve(storage.root, "../secret.txt")), /inside the artifact root/)

assert.deepEqual(trustedBrowserSessionOrigin("http://localhost:8881/path?x=1"), {
  schema: "wp-codebox/trusted-browser-session-origin/v1",
  origin: "http://localhost:8881",
  secure: true,
  loopback: true,
})
assert.throws(() => trustedBrowserSessionOrigin("http://example.test"), /https/)
assert.equal(trustedBrowserSessionOrigins(["https://example.test/a", "https://example.test/b"]).length, 1)

assert.deepEqual(normalizeRecipeMounts([{ source: "/host/plugin", target: "//wordpress//wp-content/plugins/plugin" }]), [{ source: "/host/plugin", target: "/wordpress/wp-content/plugins/plugin", mode: "readwrite" }])
assert.throws(() => normalizeSharedMounts([{ source: "/host/plugin", target: "wordpress/wp-content/plugins/plugin" }]), /absolute target/)
assert.throws(() => normalizeSharedMounts([{ source: "/host/plugin", target: "/wordpress/../escape" }]), /parent-directory/)

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

const artifactRoot = mkdtempSync(resolve(tmpdir(), "wp-codebox-artifact-part-"))
const part = await writeArtifactPart({
  root: artifactRoot,
  path: "files/check/result.json",
  kind: "check-result",
  contentType: "application/json",
  contents: "{\"ok\":true}\n",
  redaction: { policy: "required", sensitive: true, reason: "test sensitive artifact" },
  provenance: { source: "test", operation: "write-artifact-part", id: "result" },
})

assert.equal(part.path, "files/check/result.json")
assert.equal(await readFile(part.absolutePath, "utf8"), "{\"ok\":true}\n")
assert.equal(part.manifestFile.path, "files/check/result.json")
assert.deepEqual(part.manifestFile.sha256, artifactFileDigest("{\"ok\":true}\n"))
assert.deepEqual(part.manifestFile.redaction, { policy: "required", sensitive: true, reason: "test sensitive artifact" })
assert.deepEqual(part.manifestFile.provenance, { source: "test", operation: "write-artifact-part", id: "result" })
assert.equal(normalizeArtifactPartPath("/files//check/result.json"), "files/check/result.json")
assert.throws(() => normalizeArtifactPartPath("files/../secret.txt"), /relative path/)
