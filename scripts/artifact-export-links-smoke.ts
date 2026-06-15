import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

import { artifactFileDigest, type ArtifactManifest } from "@automattic/wp-codebox-core"
import { buildReviewerArtifactExportLinks } from "@automattic/wp-codebox-core/artifacts"

const execFileAsync = promisify(execFile)
const root = resolve(import.meta.dirname, "..")
const workspace = await mkdtemp(join(tmpdir(), "wp-codebox-artifact-export-links-"))

try {
  const bundle = join(workspace, "bundle")
  await writeBundle(bundle)

  const links = await buildReviewerArtifactExportLinks(bundle, { baseUrl: "https://artifacts.example.test/runs/abc123" })
  assert.equal(links.schema, "wp-codebox/reviewer-artifact-export-links/v1")
  assert.equal(links.artifactId, "artifact-bundle-sha256-fixture")
  assert.equal(links.files.length, 3)
  assert.equal(links.files[0]?.url, "https://artifacts.example.test/runs/abc123/manifest.json")
  assert.equal(links.files[2]?.url, "https://artifacts.example.test/runs/abc123/files/browser/diff%20image.png")

  const filtered = await buildReviewerArtifactExportLinks(bundle, { baseUrl: "https://artifacts.example.test/runs/abc123/", includeKinds: ["browser-screenshot"] })
  assert.deepEqual(filtered.files.map((file) => file.path), ["files/browser/diff image.png"])

  await assert.rejects(() => buildReviewerArtifactExportLinks(bundle, { baseUrl: "http://localhost:8888/artifacts" }), /must not use/)

  const cli = await execFileAsync(process.execPath, ["packages/cli/dist/index.js", "artifacts", "export-links", "--bundle", bundle, "--base-url", "https://artifacts.example.test/runs/abc123", "--kind", "review", "--json"], { cwd: root })
  const cliOutput = JSON.parse(cli.stdout)
  assert.equal(cliOutput.files.length, 1)
  assert.equal(cliOutput.files[0].url, "https://artifacts.example.test/runs/abc123/files/review.json")

  console.log("Artifact export links smoke passed")
} finally {
  await rm(workspace, { recursive: true, force: true })
}

async function writeBundle(directory: string): Promise<void> {
  await mkdir(join(directory, "files/browser"), { recursive: true })
  const review = `${JSON.stringify({ schema: "wp-codebox/artifact-review/v1", summary: "Review fixture" }, null, 2)}\n`
  const screenshot = "png fixture"
  await writeFile(join(directory, "files/review.json"), review)
  await writeFile(join(directory, "files/browser/diff image.png"), screenshot)

  const manifest: ArtifactManifest = {
    id: "artifact-bundle-sha256-fixture",
    createdAt: "2026-06-08T00:00:00.000Z",
    contentDigest: { algorithm: "sha256", inputs: ["files/review.json"], value: "a".repeat(64) },
    runtime: { id: "runtime-fixture", backend: "wordpress-playground", status: "destroyed", environment: { kind: "wordpress", version: "latest" }, createdAt: "2026-06-08T00:00:00.000Z" },
    files: [
      { path: "manifest.json", kind: "manifest", contentType: "application/json", sha256: { algorithm: "sha256", value: "0".repeat(64) } },
      { path: "files/review.json", kind: "review", contentType: "application/json", sha256: artifactFileDigest(review) },
      { path: "files/browser/diff image.png", kind: "browser-screenshot", contentType: "image/png", sha256: artifactFileDigest(screenshot) },
    ],
  }
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`
  manifest.files[0]!.sha256 = artifactFileDigest(manifestJson)
  await writeFile(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
}
