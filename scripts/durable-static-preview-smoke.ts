import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ArtifactBundleBuilder, type ArtifactBundleBuilderSource } from "../packages/runtime-playground/src/artifact-bundle-builder.js"

const artifactRoot = await mkdtemp(join(tmpdir(), "wp-codebox-durable-static-preview-"))

try {
  const browserArtifact = {
    requestedUrl: "https://preview.example.test/",
    url: "https://preview.example.test/",
    preview: {
      requestedMode: "public",
      effectiveMode: "public",
      localOrigin: "http://127.0.0.1:1234",
      effectiveOrigin: "https://preview.example.test",
      publicOrigin: "https://preview.example.test",
      diagnostics: [],
    },
    files: { summary: "files/browser/summary.json" },
    summary: {
      consoleMessages: 0,
      errors: 0,
      finalUrl: "https://preview.example.test/",
      htmlSnapshot: false,
      networkEvents: 0,
      replayability: "artifact-backed",
      screenshot: false,
      scriptResult: {
        phase: "editable_preview_ready",
        artifact_bundle: {
          schema: "wp-codebox/browser-runtime-website-artifact/v1",
          root: "public",
          entrypoint: "public/index.html",
          files: [
            {
              path: "public/index.html",
              mime_type: "text/html; charset=utf-8",
              content: "<!doctype html><title>Durable preview</title><main>Reviewer safe</main>",
            },
            {
              path: "public/styles.css",
              mime_type: "text/css; charset=utf-8",
              content: "main { color: rebeccapurple; }",
            },
          ],
        },
      },
      viewport: null,
    },
  }

  const source: ArtifactBundleBuilderSource = {
    artifactRoot,
    runtimeId: "runtime-durable-static-preview-smoke",
    runtimeCreatedAt: "2026-01-01T00:00:00.000Z",
    spec: {
      backend: "wordpress-playground",
      environment: { kind: "wordpress", name: "durable-static-preview-smoke", version: "latest" },
      policy: { network: "allow", filesystem: "readwrite-mounts", commands: ["wordpress.browser-probe"], secrets: "none", approvals: "never" },
    },
    mounts: [],
    commands: [],
    observations: [],
    snapshots: [],
    events: [],
    async info() {
      return {
        id: "runtime-durable-static-preview-smoke",
        backend: "wordpress-playground",
        environment: { kind: "wordpress", name: "durable-static-preview-smoke", version: "latest" },
        createdAt: "2026-01-01T00:00:00.000Z",
        status: "destroyed",
      }
    },
    async previewInfo() {
      return undefined
    },
    browserReviewSummary() {
      return undefined
    },
    browserArtifacts() {
      return [browserArtifact as ReturnType<ArtifactBundleBuilderSource["browserArtifacts"]>[number]]
    },
    async captureMountedFiles() {
      return { files: [], skipped: [], limits: { maxFiles: 0, maxFileBytes: 0, skippedDirectories: [] } }
    },
    async captureMountDiffs() {
      return { mountDiffs: [], changedFiles: { schema: "wp-codebox/changed-files/v1", files: [] }, patch: "", diagnostics: [] }
    },
    async redactBrowserArtifacts() {},
    async redactPluginCheckArtifacts() {},
    async redactThemeCheckArtifacts() {},
    browserManifestFiles() {
      return []
    },
    pluginCheckArtifactPaths() {
      return []
    },
    themeCheckArtifactPaths() {
      return []
    },
    observationManifestFiles() {
      return []
    },
    pluginCheckManifestFiles() {
      return []
    },
    themeCheckManifestFiles() {
      return []
    },
    formatRuntimeLog() {
      return ""
    },
    formatCommandsLog() {
      return ""
    },
    recordArtifactsCollected() {},
  }

  const bundle = await new ArtifactBundleBuilder(source).build()
  assert.equal(bundle.durablePreview?.kind, "static-artifact-preview")
  assert.equal(bundle.durablePreview?.reviewerSafe, true)
  assert.equal(bundle.durablePreview?.durable, true)
  assert.equal(bundle.durablePreview?.entrypoint, "files/static-preview/site/public/index.html")
  assert.equal(bundle.durablePreview?.source.kind, "browser-runtime-artifact-bundle")
  assert.equal(bundle.durablePreview?.source.schema, "wp-codebox/browser-runtime-website-artifact/v1")

  const staticHtml = await readFile(join(artifactRoot, "files/static-preview/site/public/index.html"), "utf8")
  assert.match(staticHtml, /Reviewer safe/)

  const staticManifest = JSON.parse(await readFile(join(artifactRoot, "files/static-preview/manifest.json"), "utf8"))
  assert.equal(staticManifest.schema, "wp-codebox/static-artifact-preview/v1")
  assert.equal(staticManifest.entrypoint, "files/static-preview/site/public/index.html")
  assert.equal(staticManifest.files.length, 2)

  const metadata = JSON.parse(await readFile(bundle.metadataPath, "utf8"))
  const previewEvidence = JSON.parse(await readFile(bundle.previewEvidencePath ?? "", "utf8"))
  const previewSessionEvidence = JSON.parse(await readFile(bundle.previewSessionEvidencePath ?? "", "utf8"))
  assert.equal(metadata.artifacts.durablePreview, "files/static-preview/manifest.json")
  assert.equal(metadata.durablePreview.entrypoint, "files/static-preview/site/public/index.html")
  assert.equal(previewEvidence.preview.durablePreview.entrypoint, "files/static-preview/site/public/index.html")
  assert.equal(previewSessionEvidence.refs.durablePreview.path, "files/static-preview/manifest.json")
} finally {
  await rm(artifactRoot, { recursive: true, force: true })
}

console.log("Durable static preview smoke passed")
