import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import {
  artifactFileDigest,
  calculateArtifactContentDigest,
  calculateArtifactManifestFileSha256,
  buildRuntimeReferenceManifest,
  buildRuntimeReplayReferenceIndex,
  verifyTransferProofBundle,
  buildTransferProbeDiagnostics,
  type ArtifactManifest,
  type ArtifactManifestFile,
  type RuntimeInfo,
} from "@automattic/wp-codebox-core"

const execFileAsync = promisify(execFile)
const root = resolve(import.meta.dirname, "..")
const workspace = await mkdtemp(join(tmpdir(), "wp-codebox-transfer-proof-"))

try {
  const validBundle = join(workspace, "valid")
  await writeTransferBundle(validBundle)

  const valid = await verifyTransferProofBundle(validBundle)
  assert.equal(valid.schema, "wp-codebox/transfer-proof-bundle-verification/v1")
  assert.equal(valid.valid, true)
  assert.deepEqual(valid.violations, [])
  assert.equal(valid.diagnostics.schema, "wp-codebox/transfer-probe-diagnostics/v1")
  assert.equal(valid.diagnostics.status, "passed")

  const probes = await buildTransferProbeDiagnostics(validBundle)
  assert.equal(probes.status, "passed")

  const cliVerify = await execFileAsync(process.execPath, ["packages/cli/dist/index.js", "artifacts", "transfer-verify", "--bundle", validBundle, "--json"], { cwd: root })
  assert.equal(JSON.parse(cliVerify.stdout).valid, true)

  const cliProbes = await execFileAsync(process.execPath, ["packages/cli/dist/index.js", "artifacts", "transfer-probes", "--bundle", validBundle, "--json"], { cwd: root })
  assert.equal(JSON.parse(cliProbes.stdout).status, "passed")

  const unsafe = await copyBundle(validBundle, join(workspace, "unsafe"))
  const unsafeReview = JSON.parse(await readText(join(unsafe, "files/review.json")))
  unsafeReview.preview = { url: "http://localhost:8888" }
  unsafeReview.credentials = { token: "sk-testthisshouldberejectedbecauseitislong" }
  await writeJson(join(unsafe, "files/review.json"), unsafeReview)
  const unsafeMetadata = JSON.parse(await readText(join(unsafe, "metadata.json")))
  unsafeMetadata.transferProofBundle.summary = "Unsafe private proof bundle URL: https://10.0.0.2/proof"
  await writeJson(join(unsafe, "metadata.json"), unsafeMetadata)
  await rewriteManifestHashes(unsafe)
  const unsafeResult = await verifyTransferProofBundle(unsafe)
  assert.equal(unsafeResult.valid, false)
  assert.ok(unsafeResult.violations.some((violation) => violation.code === "unsafe-reviewer-evidence"), unsafeResult.violations.map((violation) => violation.code).join(", "))

  const broken = await copyBundle(validBundle, join(workspace, "broken"))
  await writeFile(join(broken, "files/browser/network.jsonl"), `${JSON.stringify({ type: "response", url: "https://example.com/missing.png", resourceType: "image", status: 404 })}\n`)
  await rewriteManifestHashes(broken)
  const brokenResult = await verifyTransferProofBundle(broken)
  assert.equal(brokenResult.valid, false)
  assert.ok(brokenResult.diagnostics.diagnostics.some((diagnostic) => diagnostic.code === "missing-media"), JSON.stringify(brokenResult.diagnostics, null, 2))

  const missingPreviewRef = await copyBundle(validBundle, join(workspace, "missing-preview-ref"))
  const metadata = JSON.parse(await readText(join(missingPreviewRef, "metadata.json")))
  delete metadata.previewSessionEvidence
  await writeJson(join(missingPreviewRef, "metadata.json"), metadata)
  await rewriteManifestHashes(missingPreviewRef)
  const missingPreviewRefResult = await verifyTransferProofBundle(missingPreviewRef)
  assert.equal(missingPreviewRefResult.valid, false)
  assert.ok(missingPreviewRefResult.violations.some((violation) => violation.code === "missing-transfer-artifact"), missingPreviewRefResult.violations.map((violation) => violation.code).join(", "))

  console.log("Transfer proof verifier smoke passed")
} finally {
  await rm(workspace, { recursive: true, force: true })
}

async function writeTransferBundle(directory: string): Promise<void> {
  await mkdir(join(directory, "files/browser"), { recursive: true })
  const createdAt = "2026-06-05T00:00:00.000Z"
  const runtime = runtimeFixture(createdAt)
  const changedFiles = `${JSON.stringify({ schema: "wp-codebox/changed-files/v1", files: [{ path: "/wordpress/wp-content/plugins/example/file.txt", status: "added" }] }, null, 2)}\n`
  const patch = "diff --git a/wordpress/wp-content/plugins/example/file.txt b/wordpress/wp-content/plugins/example/file.txt\nnew file mode 100644\n--- /dev/null\n+++ b/wordpress/wp-content/plugins/example/file.txt\n@@ -0,0 +1 @@\n+cooked\n"
  await writeFile(join(directory, "files/changed-files.json"), changedFiles)
  await writeFile(join(directory, "files/patch.diff"), patch)
  const contentDigest = await calculateArtifactContentDigest(directory, ["files/changed-files.json", "files/patch.diff"])
  const artifactId = `artifact-bundle-sha256-${contentDigest}`
  const artifactBundle = { kind: "artifact-bundle" as const, id: artifactId, digest: { algorithm: "sha256" as const, value: contentDigest } }

  await writeJson(join(directory, "files/preview-evidence.json"), previewEvidenceFixture(createdAt, runtime, artifactBundle))
  const previewSessionEvidence = previewSessionEvidenceFixture(createdAt, artifactId, contentDigest, runtime)
  const previewSessionEvidenceText = `${JSON.stringify(previewSessionEvidence, null, 2)}\n`
  await writeFile(join(directory, "files/preview-session-evidence.json"), previewSessionEvidenceText)
  await writeJson(join(directory, "files/diagnostics.json"), { schema: "wp-codebox/artifact-diagnostics/v1", status: "clean", summary: { total: 0, error: 0, warning: 0, notice: 0, info: 0 }, diagnostics: [] })
  await writeJson(join(directory, "files/source-inventory.json"), { schema: "wp-codebox/source-inventory/v1", status: "captured", resources: [{ id: "post:1", type: "post", title: "Source" }] })
  await writeJson(join(directory, "files/source-runtime.json"), { schema: "wp-codebox/runtime-evidence/v1", runtimeId: "runtime-source", status: "destroyed" })
  await writeJson(join(directory, "files/target-before.json"), { schema: "wp-codebox/target-evidence/v1", phase: "before", resources: [] })
  await writeJson(join(directory, "files/target-after.json"), { schema: "wp-codebox/target-evidence/v1", phase: "after", resources: [{ id: "post:1", type: "post" }] })
  await writeJson(join(directory, "files/sandbox-rehearsal.json"), { schema: "wp-codebox/sandbox-rehearsal-evidence/v1", status: "passed", planDigest: contentDigest })
  await writeJson(join(directory, "files/transfer-digest-ref.json"), { schema: "wp-codebox/transfer-digest-ref/v1", contentDigest: { algorithm: "sha256", value: contentDigest } })
  await writeFile(join(directory, "files/runtime.log"), "runtime completed\n")
  await writeFile(join(directory, "files/browser/network.jsonl"), `${JSON.stringify({ type: "response", url: "https://example.com/", resourceType: "document", status: 200 })}\n`)
  await writeFile(join(directory, "files/browser/console.jsonl"), "")
  await writeFile(join(directory, "files/browser/errors.jsonl"), "")
  await writeJson(join(directory, "files/browser/summary.json"), { schema: "wp-codebox/browser-probe/v1", finalUrl: "https://example.com/", errors: 0, assertions: { total: 1, passed: 1, failed: 0 } })
  await writeJson(join(directory, "files/test-results.json"), { schema: "wp-codebox/test-results/v1", status: "passed" })
  await writeJson(join(directory, "files/runtime-episode-trace.json"), runtimeEpisodeTraceFixture(createdAt, runtime, artifactId, contentDigest))
  await writeFile(join(directory, "files/runtime-episode.jsonl"), `${JSON.stringify({ type: "episode.artifacts", id: artifactId })}\n`)

  const runtimeReferenceManifest = buildRuntimeReferenceManifest({ createdAt, runtime, artifactBundle, files: [] })
  const runtimeReferenceManifestText = `${JSON.stringify(runtimeReferenceManifest, null, 2)}\n`
  await writeFile(join(directory, "files/runtime-reference-manifest.json"), runtimeReferenceManifestText)
  const runtimeReferenceManifestFile = fileRef("files/runtime-reference-manifest.json", "runtime-reference-manifest", "application/json", artifactFileDigest(runtimeReferenceManifestText).value)
  const runtimeReplayIndex = buildRuntimeReplayReferenceIndex({ createdAt, runtime, artifactBundle, files: [runtimeReferenceManifestFile], runtimeReferenceManifest: runtimeReferenceManifestFile })
  await writeJson(join(directory, "files/runtime-replay-index.json"), runtimeReplayIndex)

  const review = {
    schema: "wp-codebox/artifact-review/v1",
    artifactId,
    createdAt,
    summary: "Transfer proof fixture.",
    evidence: {
      patch: "files/patch.diff",
      patchSha256: createHash("sha256").update(patch).digest("hex"),
      artifactContentDigest: contentDigest,
      changedFiles: "files/changed-files.json",
      diagnostics: "files/diagnostics.json",
      runtimeEpisodeTrace: "files/runtime-episode-trace.json",
      runtimeReferenceManifest: "files/runtime-reference-manifest.json",
      runtimeReplayReferenceIndex: "files/runtime-replay-index.json",
      previewEvidence: "files/preview-evidence.json",
      previewSessionEvidence: "files/preview-session-evidence.json",
    },
    changedFiles: [{ path: "/wordpress/wp-content/plugins/example/file.txt", status: "added" }],
    browser: {
      probes: [{ url: "https://example.com/", requestedUrl: "https://example.com/", finalUrl: "https://example.com/", errors: 0, network: "files/browser/network.jsonl", console: "files/browser/console.jsonl", errorsFile: "files/browser/errors.jsonl", summaryFile: "files/browser/summary.json", assertions: { total: 1, passed: 1, failed: 0 } }],
    },
  }
  await writeJson(join(directory, "files/review.json"), review)

  const metadata = {
    id: artifactId,
    contentDigest: { algorithm: "sha256", inputs: ["files/changed-files.json", "files/patch.diff"], value: contentDigest },
    artifacts: {
      changedFiles: "files/changed-files.json",
      patch: "files/patch.diff",
      review: "files/review.json",
      diagnostics: "files/diagnostics.json",
      runtimeEpisodeTrace: "files/runtime-episode-trace.json",
      runtimeEpisodeEvents: "files/runtime-episode.jsonl",
      runtimeReferenceManifest: "files/runtime-reference-manifest.json",
      runtimeReplayReferenceIndex: "files/runtime-replay-index.json",
      previewEvidence: "files/preview-evidence.json",
      previewSessionEvidence: "files/preview-session-evidence.json",
      browser: "files/browser/summary.json",
    },
    previewSessionEvidence: { path: "files/preview-session-evidence.json", kind: "preview-session-evidence", contentType: "application/json", sha256: artifactFileDigest(previewSessionEvidenceText) },
    transferProofBundle: {
      schema: "wp-codebox/transfer-proof-bundle/v1",
      createdAt,
      summary: "Multi-role transfer proof fixture.",
      roles: [
        {
          role: "source",
          runtimeId: "runtime-source",
          sessionId: "session-source",
          evidence: {
            sourceInventory: artifactRef(directory, "files/source-inventory.json", "source-inventory", "application/json"),
            runtime: artifactRef(directory, "files/source-runtime.json", "runtime-evidence", "application/json"),
            previewEvidence: artifactRef(directory, "files/preview-evidence.json", "preview-evidence", "application/json"),
            previewSessionEvidence: artifactRef(directory, "files/preview-session-evidence.json", "preview-session-evidence", "application/json"),
            probes: [artifactRef(directory, "files/browser/summary.json", "browser-summary", "application/json")],
          },
        },
        {
          role: "target",
          runtimeId: "runtime-target",
          sessionId: "session-target",
          evidence: {
            targetBefore: artifactRef(directory, "files/target-before.json", "target-before-evidence", "application/json"),
            targetAfter: artifactRef(directory, "files/target-after.json", "target-after-evidence", "application/json"),
            diagnostics: [artifactRef(directory, "files/diagnostics.json", "diagnostics", "application/json")],
            digestRefs: [artifactRef(directory, "files/transfer-digest-ref.json", "transfer-digest-ref", "application/json")],
          },
        },
        {
          role: "sandbox",
          runtimeId: runtime.id,
          sessionId: "session-fixture",
          evidence: {
            sandboxRehearsal: artifactRef(directory, "files/sandbox-rehearsal.json", "sandbox-rehearsal-evidence", "application/json"),
            runtime: artifactRef(directory, "files/runtime-reference-manifest.json", "runtime-reference-manifest", "application/json"),
            probes: [artifactRef(directory, "files/browser/network.jsonl", "browser-network", "application/x-ndjson")],
          },
        },
      ],
      previewSessionEvidence: artifactRef(directory, "files/preview-session-evidence.json", "preview-session-evidence", "application/json"),
      digestRefs: [artifactRef(directory, "files/runtime-replay-index.json", "runtime-replay-index", "application/json")],
    },
  }
  await writeJson(join(directory, "metadata.json"), metadata)

  const manifest = manifestFixture(createdAt, runtime, artifactId, contentDigest)
  await attachManifestFileHashes(directory, manifest)
  await writeJson(join(directory, "manifest.json"), manifest)
}

function manifestFixture(createdAt: string, runtime: RuntimeInfo, artifactId: string, contentDigest: string): ArtifactManifest {
  return {
    id: artifactId,
    contentDigest: { algorithm: "sha256", inputs: ["files/changed-files.json", "files/patch.diff"], value: contentDigest },
    createdAt,
    runtime,
    files: [
      fileFixture("manifest.json", "manifest", "application/json"),
      fileFixture("metadata.json", "metadata", "application/json"),
      fileFixture("files/changed-files.json", "changed-files", "application/json"),
      fileFixture("files/patch.diff", "patch", "text/x-diff"),
      fileFixture("files/review.json", "review", "application/json"),
      fileFixture("files/test-results.json", "test-results", "application/json"),
      fileFixture("files/diagnostics.json", "diagnostics", "application/json"),
      fileFixture("files/source-inventory.json", "source-inventory", "application/json"),
      fileFixture("files/source-runtime.json", "runtime-evidence", "application/json"),
      fileFixture("files/target-before.json", "target-before-evidence", "application/json"),
      fileFixture("files/target-after.json", "target-after-evidence", "application/json"),
      fileFixture("files/sandbox-rehearsal.json", "sandbox-rehearsal-evidence", "application/json"),
      fileFixture("files/transfer-digest-ref.json", "transfer-digest-ref", "application/json"),
      fileFixture("files/runtime.log", "log", "text/plain"),
      fileFixture("files/runtime-episode-trace.json", "runtime-episode-trace", "application/json"),
      fileFixture("files/runtime-episode.jsonl", "runtime-episode-events", "application/x-ndjson"),
      fileFixture("files/runtime-reference-manifest.json", "runtime-reference-manifest", "application/json"),
      fileFixture("files/runtime-replay-index.json", "runtime-replay-index", "application/json"),
      fileFixture("files/preview-evidence.json", "preview-evidence", "application/json"),
      fileFixture("files/preview-session-evidence.json", "preview-session-evidence", "application/json"),
      fileFixture("files/browser/network.jsonl", "browser-network", "application/x-ndjson"),
      fileFixture("files/browser/console.jsonl", "browser-console", "application/x-ndjson"),
      fileFixture("files/browser/errors.jsonl", "browser-errors", "application/x-ndjson"),
      fileFixture("files/browser/summary.json", "browser-summary", "application/json"),
    ],
  }
}

function runtimeFixture(createdAt: string): RuntimeInfo {
  return {
    id: "runtime-fixture",
    backend: "wordpress-playground",
    status: "destroyed",
    environment: { kind: "wordpress", version: "latest" },
    createdAt,
  }
}

function previewEvidenceFixture(createdAt: string, runtime: RuntimeInfo, artifactBundleRef: { kind: "artifact-bundle"; id: string; digest: { algorithm: "sha256"; value: string } }) {
  return {
    schema: "wp-codebox/preview-evidence/v1",
    createdAt,
    session: { kind: "browser-playground-session", id: "session-fixture", runtimeId: runtime.id, backend: runtime.backend, environment: { kind: "wordpress", name: "WordPress", version: "latest" } },
    run: { ...artifactBundleRef, path: "manifest.json" },
    preview: { status: "available", lifecycle: "held-after-run", source: "public-url-override", url: { kind: "preview-url", availability: "reviewer-safe", reviewerSafe: true, url: "https://example.com/" } },
    readiness: { ready: true, status: "ready", events: [] },
    components: { runtime: { backend: runtime.backend, wordpressVersion: "latest" } },
  }
}

function previewSessionEvidenceFixture(createdAt: string, artifactId: string, contentDigest: string, runtime: RuntimeInfo) {
  return {
    schema: "wp-codebox/preview-session-evidence/v1",
    createdAt,
    artifact: { id: artifactId, contentDigest: { algorithm: "sha256", value: contentDigest } },
    session: { id: "session-fixture", runtimeId: runtime.id, backend: runtime.backend },
    preview: { status: "available", url: { kind: "preview-url", availability: "reviewer-safe", reviewerSafe: true, url: "https://example.com/" } },
    artifacts: { manifest: "manifest.json", review: "files/review.json", runtimeLog: "files/runtime.log", runtimeReferenceManifest: "files/runtime-reference-manifest.json", runtimeReplayReferenceIndex: "files/runtime-replay-index.json", browserSummary: "files/browser/summary.json" },
    browser: { probes: [{ finalUrl: "https://example.com/", errors: 0, summaryFile: "files/browser/summary.json" }] },
  }
}

function runtimeEpisodeTraceFixture(createdAt: string, runtime: RuntimeInfo, artifactId: string, contentDigest: string) {
  return {
    schema: "wp-codebox/runtime-episode-trace/v1",
    version: 1,
    id: "trace-runtime-fixture",
    createdAt,
    runtime,
    reset: { id: "runtime-fixture:reset:0", runtime, observations: [], observationRefs: [] },
    steps: [],
    snapshots: [],
    artifactRef: { kind: "artifact-bundle", id: artifactId, artifactId, path: "manifest.json", digest: { algorithm: "sha256", value: contentDigest } },
  }
}

function fileFixture(path: string, kind: string, contentType: string): ArtifactManifestFile {
  return { path, kind, contentType, sha256: { algorithm: "sha256", value: "0".repeat(64) } }
}

function fileRef(path: string, kind: string, contentType: string, sha256: string): ArtifactManifestFile {
  return { path, kind, contentType, sha256: { algorithm: "sha256", value: sha256 } }
}

function artifactRef(directory: string, path: string, kind: string, contentType: string) {
  const sha256 = createHash("sha256").update(readFileSync(join(directory, path))).digest("hex")
  return { path, kind, contentType, sha256: { algorithm: "sha256", value: sha256 } }
}

async function rewriteManifestHashes(directory: string): Promise<void> {
  const manifest = JSON.parse(await readText(join(directory, "manifest.json"))) as ArtifactManifest
  await attachManifestFileHashes(directory, manifest)
  await writeJson(join(directory, "manifest.json"), manifest)
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

async function copyBundle(source: string, target: string): Promise<string> {
  await cp(source, target, { recursive: true })
  return target
}

async function readText(path: string): Promise<string> {
  return readFile(path, "utf8")
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}
