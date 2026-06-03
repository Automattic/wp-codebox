import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ArtifactManifestFile } from "@automattic/wp-codebox-core"
import { buildRuntimeReferenceIndex } from "../packages/runtime-playground/src/runtime-reference-index.js"
import type { CapturedMountFiles } from "../packages/runtime-playground/src/artifacts.js"

const artifactRoot = await mkdtemp(join(tmpdir(), "wp-codebox-runtime-reference-index-"))

try {
  await mkdir(join(artifactRoot, "files", "mounts", "0", "assets"), { recursive: true })
  await writeFile(join(artifactRoot, "files", "mounts", "0", "index.html"), `<!doctype html>
<html>
  <head><link rel="stylesheet" href="assets/site.css"></head>
  <body>
    <img src="assets/logo.png">
    <source srcset="assets/logo.png 1x, assets/missing-2x.png 2x">
  </body>
</html>
`)
  await writeFile(join(artifactRoot, "files", "mounts", "0", "assets", "site.css"), `.hero { background: url("logo.png"); }
.missing { background-image: url('../missing.png'); }
`)
  await writeFile(join(artifactRoot, "files", "mounts", "0", "assets", "logo.png"), "fake-png")

  const manifestFiles: ArtifactManifestFile[] = [
    manifestFile("files/mounts/0/index.html", "file", "text/html; charset=utf-8"),
    manifestFile("files/mounts/0/assets/site.css", "file", "text/css; charset=utf-8"),
    manifestFile("files/mounts/0/assets/logo.png", "file", "image/png"),
  ]
  const capturedMounts: CapturedMountFiles = {
    files: [
      capturedFile("files/mounts/0/index.html", "/srv/site/index.html", "index.html"),
      capturedFile("files/mounts/0/assets/site.css", "/srv/site/assets/site.css", "assets/site.css"),
      capturedFile("files/mounts/0/assets/logo.png", "/srv/site/assets/logo.png", "assets/logo.png"),
    ],
    skipped: [],
    limits: {
      maxFiles: 200,
      maxFileBytes: 1024 * 1024,
      skippedDirectories: [],
    },
  }

  const index = await buildRuntimeReferenceIndex({
    artifactRoot,
    createdAt: "2026-05-31T00:00:00.000Z",
    manifestFiles,
    capturedMounts,
    browserProbes: [],
  })

  assert.equal(index.schema, "wp-codebox/runtime-reference-index/v1")
  assert.equal(index.summary.filesScanned, 2)
  assert.equal(index.summary.present, 4)
  assert.equal(index.summary.missing, 2)
  assert.equal(index.entrypoints.length, 1)
  assert.equal(index.entrypoints[0]?.path, "files/mounts/0/index.html")

  assert.ok(index.present.some((reference) => reference.source.kind === "html" && reference.kind === "stylesheet" && reference.target.runtimePath === "/srv/site/assets/site.css"))
  assert.ok(index.present.some((reference) => reference.source.kind === "html" && reference.kind === "src" && reference.target.runtimePath === "/srv/site/assets/logo.png"))
  assert.ok(index.present.some((reference) => reference.source.kind === "css" && reference.kind === "css-url" && reference.target.runtimePath === "/srv/site/assets/logo.png"))
  assert.ok(index.missing.some((reference) => reference.source.kind === "html" && reference.kind === "srcset" && reference.target.runtimePath === "/srv/site/assets/missing-2x.png"))
  assert.ok(index.missing.some((reference) => reference.source.kind === "css" && reference.kind === "css-url" && reference.target.runtimePath === "/srv/site/missing.png"))
} finally {
  await rm(artifactRoot, { recursive: true, force: true })
}

function manifestFile(path: string, kind: string, contentType: string): ArtifactManifestFile {
  return {
    path,
    kind,
    contentType,
    sha256: { algorithm: "sha256", value: "0".repeat(64) },
  }
}

function capturedFile(artifactPath: string, target: string, relativePath: string): CapturedMountFiles["files"][number] {
  return {
    mountIndex: 0,
    source: `/tmp/source/${relativePath}`,
    target,
    relativePath,
    artifactPath,
    size: 1,
    sha256: "0".repeat(64),
    contentType: "text/plain; charset=utf-8",
    replayable: true,
  }
}
