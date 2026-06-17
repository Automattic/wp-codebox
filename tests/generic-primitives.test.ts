import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { mkdtempSync } from "node:fs"
import {
  artifactFileDigest,
  artifactStoragePath,
  artifactStoragePublicUrl,
  captureArtifactFile,
  materializationPhaseResult,
  materializationRunArtifactRefs,
  normalizeArtifactPartPath,
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
assert.deepEqual(part.manifestFile.sha256, artifactFileDigest("{\"ok\":true}\n"))
assert.deepEqual(part.manifestFile.redaction, { policy: "required", sensitive: true, reason: "test sensitive artifact" })
assert.deepEqual(part.manifestFile.provenance, { source: "test", operation: "write-artifact-part", id: "result" })
assert.equal(normalizeArtifactPartPath("/files//check/result.json"), "files/check/result.json")
assert.throws(() => normalizeArtifactPartPath("files/../secret.txt"), /relative path/)

const captureRoot = mkdtempSync(resolve(tmpdir(), "wp-codebox-capture-"))
const redactedCapture = await captureArtifactFile({
  root: captureRoot,
  path: "files/diagnostics/failure.txt",
  kind: "diagnostics",
  contents: "Authorization: bearer-secret\ntoken sk-abcdefghijklmnopqrstuvwxyz\n",
  contentType: "text/plain; charset=utf-8",
  redaction: { policy: "applied", sensitive: true },
  provenance: { source: "test", operation: "capture" },
})
assert.equal(redactedCapture.status, "captured")
assert.equal(await readFile(join(captureRoot, "files/diagnostics/failure.txt"), "utf8"), "Authorization: [redacted]\ntoken [redacted]\n")
assert.equal(redactedCapture.manifestFile?.redaction?.policy, "applied")

const sourceRoot = mkdtempSync(resolve(tmpdir(), "wp-codebox-capture-source-"))
const largeSource = join(sourceRoot, "large.txt")
await writeFile(largeSource, "0123456789")
const oversizedCapture = await captureArtifactFile({
  sourcePath: largeSource,
  root: captureRoot,
  path: "files/large.txt",
  kind: "file",
  allowedRoots: [sourceRoot],
  maxBytes: 4,
})
assert.equal(oversizedCapture.status, "oversized")
assert.equal(oversizedCapture.reason, "max-bytes-exceeded")
assert.equal(oversizedCapture.originalBytes, 10)

const sensitiveCapture = await captureArtifactFile({
  root: captureRoot,
  path: "files/sensitive.txt",
  kind: "file",
  contents: "token sk-abcdefghijklmnopqrstuvwxyz\n",
  maxBytes: 1024,
  skipSensitiveText: true,
})
assert.equal(sensitiveCapture.status, "sensitive")
assert.equal(sensitiveCapture.reason, "secret-like-value")
