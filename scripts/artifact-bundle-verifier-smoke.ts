import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { cp, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { calculateArtifactContentDigest, calculateArtifactManifestFileListDigest, calculateArtifactManifestFileSha256 } from "@automattic/wp-codebox-core"
import { preflightArtifactBundleApply, verifyArtifactBundle } from "@automattic/wp-codebox-core/artifacts"
import type { ArtifactBundle, ArtifactManifest } from "@automattic/wp-codebox-core"
import { appendRecipeRuntimeEvidence } from "../packages/cli/src/recipe-evidence.js"

const execFileAsync = promisify(execFile)
const root = resolve(import.meta.dirname, "..")
const workspace = await mkdtemp(join(tmpdir(), "wp-codebox-artifact-verifier-"))

try {
  const validBundle = join(workspace, "valid")
  await writeValidBundle(validBundle)

  const valid = await verifyArtifactBundle(validBundle)
  assert.equal(valid.valid, true)
  assert.deepEqual(valid.violations, [])

  const validPreflight = await preflightArtifactBundleApply(validBundle, { approvedFiles: ["/wordpress/wp-content/plugins/example/file.txt"] })
  assert.equal(validPreflight.ready, true)
  assert.equal(validPreflight.payload?.patch.path, "files/patch.diff")
  assert.equal(validPreflight.payload?.changedFiles.files[0]?.path, "/wordpress/wp-content/plugins/example/file.txt")
  assert.equal(validPreflight.payload?.patch.body.includes("+cooked"), true)

  const { stdout } = await execFileAsync(process.execPath, ["packages/cli/dist/index.js", "artifacts", "verify", "--bundle", validBundle, "--json"], { cwd: root })
  assert.equal(JSON.parse(stdout).valid, true)

  const applyPreflightCli = await execFileAsync(process.execPath, ["packages/cli/dist/index.js", "artifacts", "apply-preflight", "--bundle", validBundle, "--approved-file", "/wordpress/wp-content/plugins/example/file.txt", "--json"], { cwd: root })
  assert.equal(JSON.parse(applyPreflightCli.stdout).ready, true)

  const artifactsOption = await execFileAsync(process.execPath, ["packages/cli/dist/index.js", "artifacts", "verify", "--artifacts", validBundle, "--json"], { cwd: root })
  assert.equal(JSON.parse(artifactsOption.stdout).valid, true)

  const recipeEvidenceBundle = await copyBundle(validBundle, join(workspace, "recipe-evidence-appended"))
  await rewriteBundleToManifestFileListDigest(recipeEvidenceBundle)
  const recipeArtifacts = await artifactBundleFixture(recipeEvidenceBundle)
  await appendRecipeRuntimeEvidence(recipeArtifacts, [{ filename: "run-attestation.json", kind: "run-attestation", value: { schema: "fixture/run-attestation/v1", status: "passed" } }])
  const recipeEvidenceVerification = await verifyArtifactBundle(recipeEvidenceBundle)
  assert.equal(recipeEvidenceVerification.valid, true)
  assert.equal(recipeEvidenceVerification.manifest?.contentDigest.value, recipeArtifacts.contentDigest)
  assert.equal(recipeEvidenceVerification.manifest?.files.some((file) => file.path === "files/runtime-evidence/run-attestation.json"), true)

  const missingManifest = join(workspace, "missing-manifest")
  await mkdir(missingManifest, { recursive: true })
  assertViolation(await verifyArtifactBundle(missingManifest), "missing-manifest")

  const missingFile = await copyBundle(validBundle, join(workspace, "missing-file"))
  await rm(join(missingFile, "files/patch.diff"))
  assertViolation(await verifyArtifactBundle(missingFile), "missing-file")
  assertPreflightViolation(await preflightArtifactBundleApply(missingFile, { approvedFiles: ["/wordpress/wp-content/plugins/example/file.txt"] }), "missing-file")

  const traversalPath = await copyBundle(validBundle, join(workspace, "traversal-path"))
  const traversalManifest = manifestFixture(await calculateArtifactContentDigest(traversalPath, ["files/changed-files.json", "files/patch.diff"]))
  traversalManifest.files.push(fileFixture("../escape.txt", "file", "text/plain"))
  await writeJson(join(traversalPath, "manifest.json"), traversalManifest)
  assertViolation(await verifyArtifactBundle(traversalPath), "invalid-path")

  const digestMismatch = await copyBundle(validBundle, join(workspace, "digest-mismatch"))
  await writeFile(join(digestMismatch, "files/patch.diff"), "diff --git a/file.txt b/file.txt\n+tampered\n")
  assertViolation(await verifyArtifactBundle(digestMismatch), "digest-mismatch")
  assertPreflightViolation(await preflightArtifactBundleApply(digestMismatch, { approvedFiles: ["/wordpress/wp-content/plugins/example/file.txt"] }), "digest-mismatch")

  const missingApprovedFile = await preflightArtifactBundleApply(validBundle, { approvedFiles: [] })
  assertPreflightViolation(missingApprovedFile, "malformed-reference")
  assert.equal(missingApprovedFile.violations.some((violation) => violation.path === "approvedFiles" && violation.file === "/wordpress/wp-content/plugins/example/file.txt"), true)

  const fileHashMismatch = await copyBundle(validBundle, join(workspace, "file-hash-mismatch"))
  await writeFile(join(fileHashMismatch, "files/test-results.json"), "{\"tampered\":true}\n")
  assertViolation(await verifyArtifactBundle(fileHashMismatch), "file-hash-mismatch")

  const caseReferenceMissing = await copyBundle(validBundle, join(workspace, "case-reference-missing"))
  const caseReferenceMissingManifest = manifestFixture(await calculateArtifactContentDigest(caseReferenceMissing, ["files/changed-files.json", "files/patch.diff"]))
  caseReferenceMissingManifest.cases![0]!.artifacts[0]!.path = "files/cases/missing.json"
  await attachManifestFileHashes(caseReferenceMissing, caseReferenceMissingManifest)
  await writeJson(join(caseReferenceMissing, "manifest.json"), caseReferenceMissingManifest)
  assertViolation(await verifyArtifactBundle(caseReferenceMissing), "malformed-reference")

  const caseLocalPublicUrl = await copyBundle(validBundle, join(workspace, "case-local-public-url"))
  const caseLocalPublicUrlManifest = manifestFixture(await calculateArtifactContentDigest(caseLocalPublicUrl, ["files/changed-files.json", "files/patch.diff"]))
  caseLocalPublicUrlManifest.cases![0]!.artifacts[0]!.publicUrl = "http://127.0.0.1:8881/artifacts/case.json"
  await attachCaseArtifactHashes(caseLocalPublicUrl, caseLocalPublicUrlManifest)
  await attachManifestFileHashes(caseLocalPublicUrl, caseLocalPublicUrlManifest)
  await writeJson(join(caseLocalPublicUrl, "manifest.json"), caseLocalPublicUrlManifest)
  assertViolation(await verifyArtifactBundle(caseLocalPublicUrl), "unsafe-file")

  const missingFileHash = await copyBundle(validBundle, join(workspace, "missing-file-hash"))
  const missingHashManifest = manifestFixture(await calculateArtifactContentDigest(missingFileHash, ["files/changed-files.json", "files/patch.diff"]))
  await attachManifestFileHashes(missingFileHash, missingHashManifest)
  delete (missingHashManifest.files[2] as Partial<(typeof missingHashManifest.files)[number]>).sha256
  await writeJson(join(missingFileHash, "manifest.json"), missingHashManifest)
  assertViolation(await verifyArtifactBundle(missingFileHash), "missing-file-hash")

  const unlistedDigestInput = await copyBundle(validBundle, join(workspace, "unlisted-digest-input"))
  const unlistedDigestManifest = manifestFixture(await calculateArtifactContentDigest(unlistedDigestInput, ["files/changed-files.json", "files/patch.diff"]))
  unlistedDigestManifest.contentDigest.inputs = ["files/unlisted.txt"]
  await writeFile(join(unlistedDigestInput, "files/unlisted.txt"), "not listed\n")
  unlistedDigestManifest.contentDigest.value = await calculateArtifactContentDigest(unlistedDigestInput, unlistedDigestManifest.contentDigest.inputs)
  await attachManifestFileHashes(unlistedDigestInput, unlistedDigestManifest)
  await writeJson(join(unlistedDigestInput, "manifest.json"), unlistedDigestManifest)
  assertViolation(await verifyArtifactBundle(unlistedDigestInput), "malformed-reference")

  const duplicateManifestPath = await copyBundle(validBundle, join(workspace, "duplicate-manifest-path"))
  const duplicateManifest = manifestFixture(await calculateArtifactContentDigest(duplicateManifestPath, ["files/changed-files.json", "files/patch.diff"]))
  duplicateManifest.files.push(fileFixture("files/patch.diff", "patch-copy", "text/x-diff"))
  await attachManifestFileHashes(duplicateManifestPath, duplicateManifest)
  await writeJson(join(duplicateManifestPath, "manifest.json"), duplicateManifest)
  assertViolation(await verifyArtifactBundle(duplicateManifestPath), "invalid-manifest-shape")

  const hardlinkedFile = await copyBundle(validBundle, join(workspace, "hardlinked-file"))
  await link(join(hardlinkedFile, "files/patch.diff"), join(hardlinkedFile, "files/patch-copy.diff"))
  assertViolation(await verifyArtifactBundle(hardlinkedFile), "hardlink")

  const orphanedSymlink = await copyBundle(validBundle, join(workspace, "orphaned-symlink"))
  await symlink("patch.diff", join(orphanedSymlink, "files/patch-link.diff"))
  assertViolation(await verifyArtifactBundle(orphanedSymlink), "orphaned-file")

  const malformedManifest = join(workspace, "malformed-manifest")
  await mkdir(malformedManifest, { recursive: true })
  await writeFile(join(malformedManifest, "manifest.json"), "{not-json")
  assertViolation(await verifyArtifactBundle(malformedManifest), "malformed-manifest")

  const reviewMismatch = await copyBundle(validBundle, join(workspace, "review-mismatch"))
  const review = reviewFixture("0".repeat(64))
  await writeJson(join(reviewMismatch, "files/review.json"), review)
  assertViolation(await verifyArtifactBundle(reviewMismatch), "review-evidence-mismatch")

  const invalidTrace = await copyBundle(validBundle, join(workspace, "invalid-runtime-episode-trace"))
  await writeJson(join(invalidTrace, "files/runtime-episode-trace.json"), { schema: "wrong" })
  assertViolation(await verifyArtifactBundle(invalidTrace), "malformed-reference")

  console.log("Artifact bundle verifier smoke passed")
} finally {
  await rm(workspace, { recursive: true, force: true })
}

async function writeValidBundle(directory: string): Promise<void> {
  await mkdir(join(directory, "files"), { recursive: true })
  await mkdir(join(directory, "files/cases"), { recursive: true })
  const changedFiles = `${JSON.stringify({ schema: "wp-codebox/changed-files/v1", files: [{ path: "/wordpress/wp-content/plugins/example/file.txt", status: "added", mountIndex: 0, mountTarget: "/wordpress/wp-content/plugins/example", relativePath: "file.txt", patchPath: "files/diffs/0-file.txt.diff" }] }, null, 2)}\n`
  const patch = "diff --git a/wordpress/wp-content/plugins/example/file.txt b/wordpress/wp-content/plugins/example/file.txt\nnew file mode 100644\n--- /dev/null\n+++ b/wordpress/wp-content/plugins/example/file.txt\n@@ -0,0 +1 @@\n+cooked\n"
  await writeFile(join(directory, "files/changed-files.json"), changedFiles)
  await writeFile(join(directory, "files/patch.diff"), patch)
  await writeFile(join(directory, "metadata.json"), "{}\n")
  await writeFile(join(directory, "files/test-results.json"), "{}\n")
  await writeJson(join(directory, "files/cases/case-1.json"), { schema: "example/case-result/v1", id: "case-1", status: "passed" })

  const digest = await calculateArtifactContentDigest(directory, ["files/changed-files.json", "files/patch.diff"])
  await writeJson(join(directory, "files/runtime-episode-trace.json"), runtimeEpisodeTraceFixture(digest))
  await writeFile(join(directory, "files/runtime-episode.jsonl"), `${JSON.stringify({ type: "episode.artifacts", id: `artifact-bundle-sha256-${digest}` })}\n`)
  await writeJson(join(directory, "files/review.json"), reviewFixture(digest))
  await writeJson(join(directory, "metadata.json"), {
    id: `artifact-bundle-sha256-${digest}`,
    artifacts: {
      changedFiles: "files/changed-files.json",
      patch: "files/patch.diff",
      review: "files/review.json",
      testResults: "files/test-results.json",
      runtimeEpisodeTrace: "files/runtime-episode-trace.json",
      runtimeEpisodeEvents: "files/runtime-episode.jsonl",
    },
  })
  const manifest = manifestFixture(digest)
  await attachCaseArtifactHashes(directory, manifest)
  await attachManifestFileHashes(directory, manifest)
  await writeJson(join(directory, "manifest.json"), manifest)
}

async function rewriteBundleToManifestFileListDigest(directory: string): Promise<void> {
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as ArtifactManifest
  const digest = calculateArtifactManifestFileListDigest(manifest.files)
  manifest.id = `artifact-bundle-sha256-${digest}`
  manifest.contentDigest = { algorithm: "sha256", inputs: ["manifest.files"], value: digest }
  await writeJson(join(directory, "files/review.json"), reviewFixture(digest))
  await writeJson(join(directory, "metadata.json"), {
    id: manifest.id,
    contentDigest: manifest.contentDigest,
    artifacts: {
      changedFiles: "files/changed-files.json",
      patch: "files/patch.diff",
      review: "files/review.json",
      testResults: "files/test-results.json",
      runtimeEpisodeTrace: "files/runtime-episode-trace.json",
      runtimeEpisodeEvents: "files/runtime-episode.jsonl",
    },
  })
  await attachManifestFileHashes(directory, manifest)
  await writeJson(join(directory, "manifest.json"), manifest)
}

async function artifactBundleFixture(directory: string): Promise<ArtifactBundle> {
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as ArtifactManifest
  return {
    id: manifest.id,
    directory,
    manifestPath: join(directory, "manifest.json"),
    metadataPath: join(directory, "metadata.json"),
    blueprintAfterPath: join(directory, "blueprint.after.json"),
    blueprintAfterNotesPath: join(directory, "blueprint.after-notes.json"),
    eventsPath: join(directory, "events.jsonl"),
    commandsPath: join(directory, "commands.jsonl"),
    observationsPath: join(directory, "observations.jsonl"),
    runtimeLogPath: join(directory, "logs/runtime.log"),
    commandsLogPath: join(directory, "logs/commands.log"),
    mountsPath: join(directory, "files/mounts.json"),
    capturedMountsPath: join(directory, "files/mounted-files.json"),
    diffsPath: join(directory, "files/diffs.json"),
    workspacePatchPath: join(directory, "files/workspace-patch.json"),
    changedFilesPath: join(directory, "files/changed-files.json"),
    patchPath: join(directory, "files/patch.diff"),
    diagnosticsPath: join(directory, "files/diagnostics.json"),
    testResultsPath: join(directory, "files/test-results.json"),
    reviewPath: join(directory, "files/review.json"),
    contentDigest: manifest.contentDigest.value,
    createdAt: manifest.createdAt,
  }
}

function manifestFixture(digest: string): ArtifactManifest {
  return {
    id: `artifact-bundle-sha256-${digest}`,
    contentDigest: {
      algorithm: "sha256",
      inputs: ["files/changed-files.json", "files/patch.diff"],
      value: digest,
    },
    createdAt: "2026-05-27T00:00:00.000Z",
    runtime: {
      id: "runtime-fixture",
      backend: "wordpress-playground",
      status: "destroyed",
      environment: { kind: "wordpress", version: "latest" },
      createdAt: "2026-05-27T00:00:00.000Z",
    },
    files: [
      fileFixture("manifest.json", "manifest", "application/json"),
      fileFixture("metadata.json", "metadata", "application/json"),
      fileFixture("files/changed-files.json", "changed-files", "application/json"),
      fileFixture("files/patch.diff", "patch", "text/x-diff"),
      fileFixture("files/review.json", "review", "application/json"),
      fileFixture("files/test-results.json", "test-results", "application/json"),
      fileFixture("files/cases/case-1.json", "case-result", "application/json"),
      fileFixture("files/runtime-episode-trace.json", "runtime-episode-trace", "application/json"),
      fileFixture("files/runtime-episode.jsonl", "runtime-episode-events", "application/x-ndjson"),
    ],
    cases: [
      {
        id: "case-1",
        hash: { algorithm: "sha256", value: createHash("sha256").update("case-1").digest("hex") },
        artifacts: [
          {
            path: "files/cases/case-1.json",
            kind: "case-result",
            contentType: "application/json",
            sha256: { algorithm: "sha256", value: "0".repeat(64) },
            publicUrl: "https://artifacts.example.test/runs/fixture/files/cases/case-1.json",
            redaction: { policy: "none", sensitive: false },
          },
        ],
        redaction: { policy: "none", sensitive: false },
        verification: { status: "passed", verifiedAt: "2026-05-27T00:00:00.000Z", verifier: "artifact-bundle-verifier-smoke" },
      },
    ],
  }
}

function runtimeEpisodeTraceFixture(digest: string) {
  const runtime = {
    id: "runtime-fixture",
    backend: "wordpress-playground",
    status: "destroyed",
    environment: { kind: "wordpress", version: "latest" },
    createdAt: "2026-05-27T00:00:00.000Z",
  }

  return {
    schema: "wp-codebox/runtime-episode-trace/v1",
    version: 1,
    id: "trace-runtime-fixture",
    createdAt: "2026-05-27T00:00:00.000Z",
    runtime,
    reset: {
      id: "runtime-fixture:reset:0",
      runtime,
      observations: [],
      observationRefs: [],
    },
    steps: [],
    snapshots: [],
    artifactRef: {
      kind: "artifact-bundle",
      id: `artifact-bundle-sha256-${digest}`,
      artifactId: `artifact-bundle-sha256-${digest}`,
      path: "/tmp/wp-codebox-artifact-verifier/valid",
      digest: { algorithm: "sha256", value: digest },
    },
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

async function attachCaseArtifactHashes(directory: string, manifest: ArtifactManifest): Promise<void> {
  for (const manifestCase of manifest.cases ?? []) {
    for (const artifact of manifestCase.artifacts) {
      artifact.sha256 = { algorithm: "sha256", value: await calculateArtifactManifestFileSha256(directory, manifest, { path: artifact.path, kind: artifact.kind, contentType: artifact.contentType ?? "application/octet-stream", sha256: artifact.sha256 ?? { algorithm: "sha256", value: "0".repeat(64) } }) }
    }
  }
}

function reviewFixture(digest: string) {
  const patch = "diff --git a/wordpress/wp-content/plugins/example/file.txt b/wordpress/wp-content/plugins/example/file.txt\nnew file mode 100644\n--- /dev/null\n+++ b/wordpress/wp-content/plugins/example/file.txt\n@@ -0,0 +1 @@\n+cooked\n"
  return {
    schema: "wp-codebox/artifact-review/v1",
    artifactId: `artifact-bundle-sha256-${digest}`,
    evidence: {
      patch: "files/patch.diff",
      patchSha256: createHash("sha256").update(patch).digest("hex"),
      artifactContentDigest: digest,
      changedFiles: "files/changed-files.json",
      testResults: "files/test-results.json",
      runtimeEpisodeTrace: "files/runtime-episode-trace.json",
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

function assertViolation(result: Awaited<ReturnType<typeof verifyArtifactBundle>>, code: string): void {
  assert.equal(result.valid, false)
  assert.ok(result.violations.some((violation) => violation.code === code), `Expected ${code}, got ${result.violations.map((violation) => violation.code).join(", ")}`)
}

function assertPreflightViolation(result: Awaited<ReturnType<typeof preflightArtifactBundleApply>>, code: string): void {
  assert.equal(result.ready, false)
  assert.ok(result.violations.some((violation) => violation.code === code), `Expected ${code}, got ${result.violations.map((violation) => violation.code).join(", ")}`)
}
