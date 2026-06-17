import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Ajv2020 } from "ajv/dist/2020.js"
import {
  STRUCTURED_ARTIFACT_SCHEMA,
  TYPED_ARTIFACT_INDEX_SCHEMA,
  artifactFileDigest,
  calculateArtifactContentDigest,
  calculateArtifactManifestFileSha256,
  createWorkspaceRecipeJsonSchema,
  normalizeStructuredArtifacts,
  type ArtifactManifest,
  type TypedArtifactIndex,
} from "@automattic/wp-codebox-core"
import { verifyArtifactBundle } from "@automattic/wp-codebox-core/artifacts"

const workspace = await mkdtemp(join(tmpdir(), "wp-codebox-typed-artifacts-"))

try {
  const recipeSchema = createWorkspaceRecipeJsonSchema()
  const validateRecipe = new Ajv2020({ strict: false }).compile(recipeSchema)
  assert.equal(validateRecipe({
    schema: "wp-codebox/workspace-recipe/v1",
    workflow: { steps: [{ command: "host/example" }] },
    artifacts: {
      typed: [{ name: "summary", type: "example.summary", path: "/tmp/summary.json", required: true, parseJson: true, payloadSchema: "example/summary/v1" }],
    },
  }), true)

  const structured = normalizeStructuredArtifacts([{ name: "summary", type: "example.summary", payload: { ok: true } }], "output")
  assert.equal(structured[0]?.schema, STRUCTURED_ARTIFACT_SCHEMA)
  assert.equal(structured[0]?.provenance.direction, "output")

  const validBundle = join(workspace, "valid")
  await writeTypedArtifactBundle(validBundle)
  const valid = await verifyArtifactBundle(validBundle)
  assert.equal(valid.valid, true)

  const missingTypedArtifact = join(workspace, "missing-typed-artifact")
  await writeTypedArtifactBundle(missingTypedArtifact, { omitTypedArtifactManifestEntry: true })
  const missing = await verifyArtifactBundle(missingTypedArtifact, { allowOrphanedFiles: true })
  assert.equal(missing.valid, false)
  assert.equal(missing.violations.some((violation) => violation.code === "malformed-reference" && violation.file === "files/runtime-evidence/typed-artifacts/summary-1.json"), true)

  const digestMismatch = join(workspace, "typed-digest-mismatch")
  await writeTypedArtifactBundle(digestMismatch, { badTypedArtifactDigest: true })
  const mismatch = await verifyArtifactBundle(digestMismatch)
  assert.equal(mismatch.valid, false)
  assert.equal(mismatch.violations.some((violation) => violation.code === "file-hash-mismatch" && violation.file === "files/runtime-evidence/typed-artifacts/summary-1.json"), true)

  const payloadSchemaMismatch = join(workspace, "typed-payload-schema-mismatch")
  await writeTypedArtifactBundle(payloadSchemaMismatch, { invalidPayloadForSchema: true })
  const schemaMismatch = await verifyArtifactBundle(payloadSchemaMismatch)
  assert.equal(schemaMismatch.valid, false)
  assert.equal(schemaMismatch.violations.some((violation) => violation.code === "payload-schema-violation" && violation.path === "files/runtime-evidence/typed-artifacts/index.json:artifacts[0].payload"), true)

  console.log("Typed artifacts smoke passed")
} finally {
  await rm(workspace, { recursive: true, force: true })
}

async function writeTypedArtifactBundle(directory: string, options: { omitTypedArtifactManifestEntry?: boolean; badTypedArtifactDigest?: boolean; invalidPayloadForSchema?: boolean } = {}): Promise<void> {
  await mkdir(join(directory, "files/runtime-evidence/typed-artifacts"), { recursive: true })
  await writeFile(join(directory, "metadata.json"), "{}\n")

  const payload = options.invalidPayloadForSchema ? { ok: "yes" } : { ok: true }
  const typedPayload = `${JSON.stringify(payload, null, 2)}\n`
  const typedPath = "files/runtime-evidence/typed-artifacts/summary-1.json"
  await writeFile(join(directory, typedPath), typedPayload)
  const typedDigest = artifactFileDigest(typedPayload).value
  const index: TypedArtifactIndex = {
    schema: TYPED_ARTIFACT_INDEX_SCHEMA,
    direction: "output",
    artifacts: [{
      schema: STRUCTURED_ARTIFACT_SCHEMA,
      name: "summary",
      type: "example.summary",
      payload_schema: options.invalidPayloadForSchema ? { $id: "example/summary/v1", type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } } : "example/summary/v1",
      payload,
      metadata: {},
      provenance: { direction: "output", source: "/tmp/summary.json" },
      artifact: {
        path: typedPath,
        kind: "typed-artifact",
        contentType: "application/json",
        sha256: options.badTypedArtifactDigest ? "0".repeat(64) : typedDigest,
      },
    }],
  }
  await writeFile(join(directory, "files/runtime-evidence/typed-artifacts/index.json"), `${JSON.stringify(index, null, 2)}\n`)

  const digest = await calculateArtifactContentDigest(directory, [typedPath])
  const manifest: ArtifactManifest = {
    id: `artifact-bundle-sha256-${digest}`,
    contentDigest: { algorithm: "sha256", inputs: [typedPath], value: digest },
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
      manifestFile("files/runtime-evidence/typed-artifacts/index.json", "typed-artifacts-index", "application/json"),
      ...(options.omitTypedArtifactManifestEntry ? [] : [manifestFile(typedPath, "typed-artifact", "application/json")]),
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
