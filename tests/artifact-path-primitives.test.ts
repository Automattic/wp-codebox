import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { withTempDir } from "../scripts/test-kit.js"
import {
  artifactFileDigest,
  artifactManifestRelativePath,
  artifactStoragePath,
  artifactStoragePublicUrl,
  captureArtifactFile,
  evidenceArtifactEnvelope,
  normalizeArtifactPartPath,
  normalizeRecipeMounts,
  normalizeReviewerSafePath,
  normalizeSharedMounts,
  normalizeWorkspaceRelativeTarget,
  resolveArtifactPath,
  reviewerSafeArtifactRef,
  runtimeArtifactStorageDescriptor,
  runtimeOverlayBundle,
  safeArtifactRelativePath,
  validateEvidenceArtifactEnvelope,
  validateWorkspaceRecipeJsonSchema,
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
assert.equal(normalizeReviewerSafePath("/packages//plugin"), "packages/plugin")
assert.equal(normalizeWorkspaceRelativeTarget("packages/plugin"), "/workspace/packages/plugin")
assert.equal(normalizeWorkspaceRelativeTarget("/workspace/packages/plugin"), "/workspace/packages/plugin")

assert.throws(() => runtimeArtifactStorageDescriptor({ root: "./artifacts", pathPrefix: "../escape" }), /parent-directory/)
assert.throws(() => runtimeArtifactStorageDescriptor({ root: "./artifacts", publicUrlRoot: "file:///tmp/artifacts" }), /http/)
assert.throws(() => safeArtifactRelativePath("files/../secret.txt"), /parent-directory/)
assert.throws(() => resolveArtifactPath(storage.root, "../secret.txt"), /parent-directory/)
assert.throws(() => artifactManifestRelativePath(storage.root, resolve(storage.root, "../secret.txt")), /inside the artifact root/)
assert.throws(() => normalizeReviewerSafePath("../secret"), /parent-directory/)

assert.deepEqual(reviewerSafeArtifactRef({ path: "/files//browser/screenshot.png", kind: "browser-screenshot", digest: "abc", publicUrl: "https://artifacts.example.test/run-1/files/browser/screenshot.png#local" }), {
  path: "files/browser/screenshot.png",
  kind: "browser-screenshot",
  digest: { algorithm: "sha256", value: "abc" },
  publicUrl: "https://artifacts.example.test/run-1/files/browser/screenshot.png",
})
assert.throws(() => reviewerSafeArtifactRef({ path: "files/browser/screenshot.png", kind: "browser-screenshot", publicUrl: "http://localhost:8881/artifact.png" }), /loopback/)

const evidenceEnvelope = evidenceArtifactEnvelope({
  id: "run-1",
  subject: { kind: "component", id: "example" },
  status: "passed",
  createdAt: new Date("2026-01-02T03:04:05.000Z"),
  artifacts: [{ path: "files/review.md", kind: "review", contentType: "text/markdown" }],
  browserCaptures: [{
    id: "homepage",
    status: "passed",
    finalUrl: "https://example.test/",
    artifacts: [{ path: "files/browser/home.png", kind: "browser-screenshot", publicUrl: "https://artifacts.example.test/run-1/files/browser/home.png" }],
  }],
})
assert.equal(evidenceEnvelope.schema, "wp-codebox/evidence-artifact-envelope/v1")
assert.equal(evidenceEnvelope.browserCaptures[0].schema, "wp-codebox/browser-evidence-capture/v1")
assert.deepEqual(validateEvidenceArtifactEnvelope(evidenceEnvelope), { valid: true, errors: [] })
assert.equal(validateEvidenceArtifactEnvelope({ ...evidenceEnvelope, artifacts: [{ path: "../secret.txt", kind: "file" }] }).valid, false)

const overlayBundle = runtimeOverlayBundle({
  id: "example-runtime-overlay",
  files: [{ path: "/wordpress/wp-content/mu-plugins/example.php", source: "overlays/example.php" }],
  configPreludes: [{ target: "wp-config.php", contents: "define('EXAMPLE_RUNTIME', true);", order: 10 }],
  localRoutes: [{ path: "/_runtime/example", target: "http://127.0.0.1:9400/example", methods: ["get"], localOnly: true }],
  patches: [{ id: "example.patch", source: "patches/example.patch", appliesTo: "runtime" }],
  capabilities: { provided: ["example/runtime-overlay", "example/runtime-overlay"], required: ["wordpress"] },
})
assert.equal(overlayBundle.schema, "wp-codebox/runtime-overlay-bundle/v1")
assert.deepEqual(overlayBundle.localRoutes?.[0].methods, ["GET"])
assert.deepEqual(overlayBundle.capabilities?.provided, ["example/runtime-overlay"])
assert.throws(() => runtimeOverlayBundle({ id: "gap", unsupportedGaps: [{ capability: "route-alias", reason: "backend does not support local route aliases", failureMode: "fail-closed" }] }), /unsupported fail-closed gaps/)

assert.equal(validateWorkspaceRecipeJsonSchema({
  schema: "wp-codebox/workspace-recipe/v1",
  runtime: { overlays: [{ kind: "runtime-overlay-bundle", bundle: overlayBundle }] },
  workflow: { steps: [{ command: "noop" }] },
}).valid, true)
assert.equal(validateWorkspaceRecipeJsonSchema({
  schema: "wp-codebox/workspace-recipe/v1",
  runtime: { overlays: [{ kind: "runtime-overlay-bundle", bundle: { ...overlayBundle, localRoutes: [{ path: "/_runtime/example", target: "http://127.0.0.1:9400/example" }] } }] },
  workflow: { steps: [{ command: "noop" }] },
}).valid, false)

assert.deepEqual(normalizeRecipeMounts([{ source: "/host/plugin", target: "//wordpress//wp-content/plugins/plugin" }]), [{ source: "/host/plugin", target: "/wordpress/wp-content/plugins/plugin", mode: "readwrite" }])
assert.throws(() => normalizeSharedMounts([{ source: "/host/plugin", target: "wordpress/wp-content/plugins/plugin" }]), /absolute target/)
assert.throws(() => normalizeSharedMounts([{ source: "/host/plugin", target: "/wordpress/../escape" }]), /parent-directory/)
assert.deepEqual(normalizeSharedMounts([{ source: "/host/site.zip", target: "/wordpress/site.zip", phase: "pre-install" }]), [{ source: "/host/site.zip", target: "/wordpress/site.zip", mode: "readwrite", phase: "pre-install" }])
assert.throws(() => normalizeSharedMounts([{ source: "/host/site.zip", target: "/wordpress/site.zip", phase: "before-install" as "pre-install" }]), /phase must be pre-install or post-install/)

await withTempDir("wp-codebox-artifact-part-", async (artifactRoot) => {
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
})
assert.equal(normalizeArtifactPartPath("/files//check/result.json"), "files/check/result.json")
assert.throws(() => normalizeArtifactPartPath("files/../secret.txt"), /relative path/)

await withTempDir("wp-codebox-capture-", async (captureRoot) => {
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

  await withTempDir("wp-codebox-capture-source-", async (sourceRoot) => {
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
  })

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
})
