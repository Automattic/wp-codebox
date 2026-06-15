import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { calculateArtifactContentDigest, calculateArtifactManifestFileSha256 } from "@automattic/wp-codebox-core"
import { createArtifactApplyRequest, loadArtifactBundleForApply, normalizeArtifactApplyPreflight } from "@automattic/wp-codebox-core/artifacts"
import type { ArtifactManifest } from "@automattic/wp-codebox-core"

const workspace = await mkdtemp(join(tmpdir(), "wp-codebox-artifact-apply-adapter-"))

try {
  const validBundle = join(workspace, "valid")
  await writeValidBundle(validBundle)

  const bundlePreflight = await loadArtifactBundleForApply(validBundle, { approvedFiles: ["/wordpress/wp-content/plugins/example/file.txt"] })
  assert.equal(bundlePreflight.ready, true)
  assert.equal(bundlePreflight.schema, "wp-codebox/artifact-apply-preflight/v1")
  assert.equal(bundlePreflight.payload?.artifact_id.startsWith("artifact-bundle-sha256-"), true)
  assert.equal(bundlePreflight.payload?.artifact.changed_files.files[0]?.path, "/wordpress/wp-content/plugins/example/file.txt")

  const request = await createArtifactApplyRequest({ bundlePath: validBundle, approvedFiles: ["/wordpress/wp-content/plugins/example/file.txt"], branch: "codebox/apply-fixture" })
  assert.equal(request.artifact.id, bundlePreflight.payload?.artifact_id)
  assert.equal(request.policy.approved_files[0], "/wordpress/wp-content/plugins/example/file.txt")
  assert.equal(request.inputs.branch, "codebox/apply-fixture")

  const preflightPath = join(workspace, "preflight.json")
  await writeJson(preflightPath, bundlePreflight)
  const preflightFile = await normalizeArtifactApplyPreflight({ preflightPath })
  assert.equal(preflightFile.ready, true)
  assert.equal(preflightFile.payload?.patch_sha256, bundlePreflight.payload?.patch_sha256)

  const payloadInput = await normalizeArtifactApplyPreflight(bundlePreflight.payload)
  assert.equal(payloadInput.ready, true)
  assert.equal(payloadInput.payload?.artifact_content_digest, bundlePreflight.payload?.artifact_content_digest)

  const approvedMismatch = await normalizeArtifactApplyPreflight({
    ...bundlePreflight.payload,
    approved_files: ["/wordpress/wp-content/plugins/example/other.txt"],
  })
  assertViolation(approvedMismatch, "approved-file-mismatch")

  const digestMismatch = await normalizeArtifactApplyPreflight({
    ...bundlePreflight.payload,
    artifact_content_digest: "0".repeat(64),
  })
  assertViolation(digestMismatch, "digest-mismatch")

  const patchMismatch = await normalizeArtifactApplyPreflight({
    ...bundlePreflight.payload,
    patch_sha256: "0".repeat(64),
  })
  assertViolation(patchMismatch, "digest-mismatch")

  const missingPatch = await normalizeArtifactApplyPreflight({
    ...bundlePreflight.payload,
    patch: undefined,
  })
  assertViolation(missingPatch, "missing-patch")

  const missingChangedFiles = await normalizeArtifactApplyPreflight({
    ...bundlePreflight.payload,
    artifact: {
      ...bundlePreflight.payload?.artifact,
      changed_files: undefined,
    },
  })
  assertViolation(missingChangedFiles, "missing-changed-files")

  const missingPatchBundle = await copyBundle(validBundle, join(workspace, "missing-patch-bundle"))
  await rm(join(missingPatchBundle, "files/patch.diff"))
  assertViolation(await loadArtifactBundleForApply(missingPatchBundle, { approvedFiles: ["/wordpress/wp-content/plugins/example/file.txt"] }), "missing-patch")

  const missingChangedFilesBundle = await copyBundle(validBundle, join(workspace, "missing-changed-files-bundle"))
  await rm(join(missingChangedFilesBundle, "files/changed-files.json"))
  assertViolation(await loadArtifactBundleForApply(missingChangedFilesBundle, { approvedFiles: ["/wordpress/wp-content/plugins/example/file.txt"] }), "missing-changed-files")

  console.log("Artifact apply adapter smoke passed")
} finally {
  await rm(workspace, { recursive: true, force: true })
}

async function writeValidBundle(directory: string): Promise<void> {
  await mkdir(join(directory, "files"), { recursive: true })
  const changedFiles = `${JSON.stringify({ schema: "wp-codebox/changed-files/v1", files: [{ path: "/wordpress/wp-content/plugins/example/file.txt", status: "added", mountIndex: 0, mountTarget: "/wordpress/wp-content/plugins/example", relativePath: "file.txt", patchPath: "files/diffs/0-file.txt.diff" }] }, null, 2)}\n`
  const patch = "diff --git a/wordpress/wp-content/plugins/example/file.txt b/wordpress/wp-content/plugins/example/file.txt\nnew file mode 100644\n--- /dev/null\n+++ b/wordpress/wp-content/plugins/example/file.txt\n@@ -0,0 +1 @@\n+cooked\n"
  await writeFile(join(directory, "files/changed-files.json"), changedFiles)
  await writeFile(join(directory, "files/patch.diff"), patch)
  await writeFile(join(directory, "metadata.json"), `${JSON.stringify({ provenance: { mounts: [{ target: "/wordpress/wp-content/plugins/example", metadata: { editable: true, repo: "example/example-plugin", branch: "main", commit: "abc123" } }] } }, null, 2)}\n`)

  const digest = await calculateArtifactContentDigest(directory, ["files/changed-files.json", "files/patch.diff"])
  await writeJson(join(directory, "files/review.json"), reviewFixture(digest, patch))
  const manifest = manifestFixture(digest)
  await attachManifestFileHashes(directory, manifest)
  await writeJson(join(directory, "manifest.json"), manifest)
}

function manifestFixture(digest: string): ArtifactManifest {
  return {
    id: `artifact-bundle-sha256-${digest}`,
    contentDigest: {
      algorithm: "sha256",
      inputs: ["files/changed-files.json", "files/patch.diff"],
      value: digest,
    },
    createdAt: "2026-06-06T00:00:00.000Z",
    runtime: {
      id: "runtime-fixture",
      backend: "wordpress-playground",
      status: "destroyed",
      environment: { kind: "wordpress", version: "latest" },
      createdAt: "2026-06-06T00:00:00.000Z",
    },
    files: [
      fileFixture("manifest.json", "manifest", "application/json"),
      fileFixture("metadata.json", "metadata", "application/json"),
      fileFixture("files/changed-files.json", "changed-files", "application/json"),
      fileFixture("files/patch.diff", "patch", "text/x-diff"),
      fileFixture("files/review.json", "review", "application/json"),
    ],
  }
}

function fileFixture(path: string, kind: string, contentType: string): ArtifactManifest["files"][number] {
  return { path, kind, contentType, sha256: { algorithm: "sha256", value: "0".repeat(64) } }
}

async function attachManifestFileHashes(directory: string, manifest: ArtifactManifest): Promise<void> {
  for (const file of manifest.files) {
    if (file.path !== "manifest.json") {
      file.sha256 = { algorithm: "sha256", value: await calculateArtifactManifestFileSha256(directory, manifest, file) }
    }
  }
  for (const file of manifest.files) {
    if (file.path === "manifest.json") {
      file.sha256 = { algorithm: "sha256", value: await calculateArtifactManifestFileSha256(directory, manifest, file) }
    }
  }
}

function reviewFixture(digest: string, patch: string) {
  return {
    schema: "wp-codebox/artifact-review/v1",
    artifactId: `artifact-bundle-sha256-${digest}`,
    evidence: {
      patch: "files/patch.diff",
      patchSha256: createHash("sha256").update(patch).digest("hex"),
      artifactContentDigest: digest,
      changedFiles: "files/changed-files.json",
    },
    changedFiles: [{ path: "/wordpress/wp-content/plugins/example/file.txt", status: "added" }],
  }
}

async function copyBundle(source: string, target: string): Promise<string> {
  await cp(source, target, { recursive: true })
  return target
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

function assertViolation(result: Awaited<ReturnType<typeof normalizeArtifactApplyPreflight>>, code: string): void {
  assert.equal(result.ready, false)
  assert.ok(result.violations.some((violation) => violation.code === code), `Expected ${code}, got ${result.violations.map((violation) => violation.code).join(", ")}`)
}
