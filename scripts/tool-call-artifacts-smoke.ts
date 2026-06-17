import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  TOOL_CALL_TRANSCRIPT_SCHEMA,
  artifactFileDigest,
  calculateArtifactContentDigest,
  calculateArtifactManifestFileSha256,
  type ArtifactManifest,
  type ToolCallTranscriptArtifact,
} from "@automattic/wp-codebox-core"
import { verifyArtifactBundle } from "@automattic/wp-codebox-core/artifacts"

const workspace = await mkdtemp(join(tmpdir(), "wp-codebox-tool-call-artifacts-"))

try {
  const validBundle = join(workspace, "valid")
  await writeToolCallArtifactBundle(validBundle)
  const valid = await verifyArtifactBundle(validBundle)
  assert.equal(valid.valid, true)

  const missingRef = join(workspace, "missing-ref")
  await writeToolCallArtifactBundle(missingRef, { omitInputArtifactManifestEntry: true })
  const missing = await verifyArtifactBundle(missingRef, { allowOrphanedFiles: true })
  assert.equal(missing.valid, false)
  assert.equal(missing.violations.some((violation) => violation.code === "malformed-reference" && violation.file === "files/runtime-evidence/tool-calls/call-1-input.json"), true)

  const digestMismatch = join(workspace, "digest-mismatch")
  await writeToolCallArtifactBundle(digestMismatch, { badOutputDigest: true })
  const mismatch = await verifyArtifactBundle(digestMismatch)
  assert.equal(mismatch.valid, false)
  assert.equal(mismatch.violations.some((violation) => violation.code === "file-hash-mismatch" && violation.file === "files/runtime-evidence/tool-calls/call-1-output.json"), true)

  const missingRedaction = join(workspace, "missing-redaction")
  await writeToolCallArtifactBundle(missingRedaction, { omitCallRedaction: true })
  const redaction = await verifyArtifactBundle(missingRedaction)
  assert.equal(redaction.valid, false)
  assert.equal(redaction.violations.some((violation) => violation.code === "malformed-reference" && violation.path.endsWith(".redaction")), true)

  console.log("Tool-call artifacts smoke passed")
} finally {
  await rm(workspace, { recursive: true, force: true })
}

async function writeToolCallArtifactBundle(directory: string, options: { omitInputArtifactManifestEntry?: boolean; badOutputDigest?: boolean; omitCallRedaction?: boolean } = {}): Promise<void> {
  await mkdir(join(directory, "files/runtime-evidence/tool-calls"), { recursive: true })
  await writeFile(join(directory, "metadata.json"), "{}\n")

  const inputPath = "files/runtime-evidence/tool-calls/call-1-input.json"
  const outputPath = "files/runtime-evidence/tool-calls/call-1-output.json"
  const transcriptPath = "files/runtime-evidence/tool-calls/transcript.json"
  const input = `${JSON.stringify({ command: "example", args: ["--version"] }, null, 2)}\n`
  const output = `${JSON.stringify({ exitCode: 0, stdout: "example 1.0.0\n" }, null, 2)}\n`
  await writeFile(join(directory, inputPath), input)
  await writeFile(join(directory, outputPath), output)
  const inputDigest = artifactFileDigest(input)
  const outputDigest = artifactFileDigest(output)

  const call = {
    call_id: "call-1",
    tool_name: "host.example",
    tool_type: "host-command",
    phase: "execution",
    status: "succeeded",
    started_at: "2026-06-16T00:00:00.000Z",
    finished_at: "2026-06-16T00:00:01.000Z",
    input_artifacts: [{ path: inputPath, kind: "tool-call-input", contentType: "application/json", sha256: inputDigest }],
    output_artifacts: [{ path: outputPath, kind: "tool-call-output", contentType: "application/json", sha256: options.badOutputDigest ? { algorithm: "sha256", value: "0".repeat(64) } : outputDigest }],
    input_digest: inputDigest,
    output_digest: outputDigest,
    ...(!options.omitCallRedaction ? { redaction: { policy: "applied", sensitive: false } } : {}),
  }
  const transcript: ToolCallTranscriptArtifact = {
    schema: TOOL_CALL_TRANSCRIPT_SCHEMA,
    tool_calls: [call as ToolCallTranscriptArtifact["tool_calls"][number]],
    redaction: { policy: "applied", sensitive: false },
  }
  await writeFile(join(directory, transcriptPath), `${JSON.stringify(transcript, null, 2)}\n`)

  const digest = await calculateArtifactContentDigest(directory, [inputPath, outputPath, transcriptPath])
  const manifest: ArtifactManifest = {
    id: `artifact-bundle-sha256-${digest}`,
    contentDigest: { algorithm: "sha256", inputs: [inputPath, outputPath, transcriptPath], value: digest },
    createdAt: "2026-06-16T00:00:00.000Z",
    runtime: {
      id: "runtime-fixture",
      backend: "wordpress-playground",
      status: "destroyed",
      environment: { kind: "wordpress", version: "latest" },
      createdAt: "2026-06-16T00:00:00.000Z",
    },
    files: [
      manifestFile("manifest.json", "manifest", "application/json"),
      manifestFile("metadata.json", "metadata", "application/json"),
      manifestFile(transcriptPath, "tool-call-transcript", "application/json"),
      ...(options.omitInputArtifactManifestEntry ? [] : [manifestFile(inputPath, "tool-call-input", "application/json")]),
      manifestFile(outputPath, "tool-call-output", "application/json"),
    ],
  }
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
  await writeFile(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
}

function manifestFile(path: string, kind: string, contentType: string): ArtifactManifest["files"][number] {
  return { path, kind, contentType, sha256: { algorithm: "sha256", value: "0".repeat(64) } }
}
