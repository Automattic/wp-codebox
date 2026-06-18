import assert from "node:assert/strict"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { artifactManifestFile, calculateArtifactManifestFileListDigest, refreshArtifactManifestFileSha256s, type ArtifactManifest } from "../packages/runtime-core/src/index.js"
import { verifyArtifactBundle } from "../packages/runtime-core/src/artifact-bundle-verifier.js"
import { buildFailureEvidence } from "../packages/cli/src/commands/agent-task-run.js"

const patchOnlyFiles = [
  artifactManifestFile("manifest.json", "manifest", "application/json"),
  artifactManifestFile("files/changed-files.json", "changed-files", "application/json"),
  artifactManifestFile("files/patch.diff", "patch", "text/x-diff"),
]
const evidenceFiles = [
  ...patchOnlyFiles,
  artifactManifestFile("files/browser/summary.json", "browser-summary", "application/json"),
]

assert.equal(calculateArtifactManifestFileListDigest(patchOnlyFiles), calculateArtifactManifestFileListDigest([...patchOnlyFiles]))
assert.notEqual(calculateArtifactManifestFileListDigest(patchOnlyFiles), calculateArtifactManifestFileListDigest(evidenceFiles))

const artifactRoot = await mkdtemp(join(tmpdir(), "wp-codebox-evidence-bundle-digest-"))
await mkdir(join(artifactRoot, "files"), { recursive: true })
await writeFile(join(artifactRoot, "files", "changed-files.json"), "{}\n")
await writeFile(join(artifactRoot, "files", "patch.diff"), "")
await writeFile(join(artifactRoot, "files", "browser-summary.json"), "{}\n")

const manifestFiles = [
  artifactManifestFile("manifest.json", "manifest", "application/json"),
  artifactManifestFile("files/changed-files.json", "changed-files", "application/json"),
  artifactManifestFile("files/patch.diff", "patch", "text/x-diff"),
  artifactManifestFile("files/browser-summary.json", "browser-summary", "application/json"),
]
const manifest: ArtifactManifest = {
  id: `artifact-bundle-sha256-${calculateArtifactManifestFileListDigest(manifestFiles)}`,
  contentDigest: {
    algorithm: "sha256",
    inputs: ["manifest.files"],
    value: calculateArtifactManifestFileListDigest(manifestFiles),
  },
  createdAt: "2026-01-01T00:00:00.000Z",
  runtime: {
    id: "runtime-1",
    kind: "wordpress-playground",
    backend: "playground-cli",
    status: "ready",
    createdAt: "2026-01-01T00:00:00.000Z",
    environment: { kind: "wordpress", version: "latest" },
  },
  files: manifestFiles,
}
await refreshArtifactManifestFileSha256s(artifactRoot, manifest)
await writeFile(join(artifactRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
assert.equal((await verifyArtifactBundle(artifactRoot)).valid, true)

const failureEvidence = buildFailureEvidence({
  input: {},
  task: "Reproduce a failure",
  wpVersion: "latest",
  artifacts: "/tmp/wp-codebox-artifacts",
  recipePath: "/var/folders/deleted/wp-codebox-agent-task-recipe-123/recipe.json",
  generatedRecipeArtifact: {
    path: "files/generated-recipe/recipe.json",
    absolutePath: "/tmp/wp-codebox-artifacts/files/generated-recipe/recipe.json",
    kind: "generated-recipe",
    contentType: "application/json",
  },
  run: { success: false, error: { message: "failed" } },
})

assert.deepEqual(failureEvidence.recipe_run, {
  recipe_path: "files/generated-recipe/recipe.json",
  recipe_artifact: {
    path: "files/generated-recipe/recipe.json",
    kind: "generated-recipe",
    content_type: "application/json",
  },
})

console.log("evidence bundle digest and recipe artifact passed")
