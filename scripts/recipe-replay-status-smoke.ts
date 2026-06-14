import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ArtifactBundle, ArtifactManifest, ArtifactManifestFile } from "@automattic/wp-codebox-core"
import { buildRecipeReplayStatusSummary } from "../packages/cli/src/recipe-evidence.js"

const workspace = await mkdtemp(join(tmpdir(), "wp-codebox-replay-status-"))

try {
  const replayable = await fixtureBundle("replayable", [
    manifestFile("blueprint.after.json", "blueprint-after"),
    manifestFile("blueprint.after-notes.json", "blueprint-after-notes"),
    manifestFile("files/runtime-snapshots/runtime-state.json", "runtime-snapshot"),
    manifestFile("files/runtime-reference-manifest.json", "runtime-reference-manifest"),
    manifestFile("files/runtime-replay-index.json", "runtime-replay-index"),
  ], "replayable-runtime-state")
  const replayableStatus = await buildRecipeReplayStatusSummary(replayable)
  assert.equal(replayableStatus.status, "replayable")
  assert.equal(replayableStatus.artifacts.executableBlueprint?.path, "blueprint.after.json")
  assert.equal(replayableStatus.artifacts.runtimeSnapshot?.path, "files/runtime-snapshots/runtime-state.json")
  assert.equal(replayableStatus.publicAccess.status, "caller_must_publish")

  const partial = await fixtureBundle("partial", [
    manifestFile("blueprint.after.json", "blueprint-after"),
    manifestFile("blueprint.after-notes.json", "blueprint-after-notes"),
    manifestFile("files/runtime-reference-manifest.json", "runtime-reference-manifest"),
    manifestFile("files/runtime-replay-index.json", "runtime-replay-index"),
  ], "partial")
  const partialStatus = await buildRecipeReplayStatusSummary(partial)
  assert.equal(partialStatus.status, "partial")
  assert.ok(partialStatus.reasons.includes("missing_runtime_snapshot"))
  assert.ok(partialStatus.reasons.includes("blueprint_after_is_partial"))

  const unavailable = await fixtureBundle("not-available", [
    manifestFile("files/runtime-reference-manifest.json", "runtime-reference-manifest"),
  ])
  const unavailableStatus = await buildRecipeReplayStatusSummary(unavailable)
  assert.equal(unavailableStatus.status, "not_available")
  assert.ok(unavailableStatus.reasons.includes("missing_executable_blueprint"))
  assert.equal(unavailableStatus.publicAccess.status, "not_required")

  console.log("Recipe replay status smoke passed")
} finally {
  await rm(workspace, { recursive: true, force: true })
}

async function fixtureBundle(name: string, files: ArtifactManifestFile[], replayStatus?: string): Promise<ArtifactBundle> {
  const directory = join(workspace, name)
  await mkdir(join(directory, "files", "runtime-snapshots"), { recursive: true })
  if (files.some((file) => file.path === "blueprint.after.json")) {
    await writeFile(join(directory, "blueprint.after.json"), `${JSON.stringify({ steps: [] }, null, 2)}\n`)
  }
  if (files.some((file) => file.path === "blueprint.after-notes.json")) {
    await writeFile(join(directory, "blueprint.after-notes.json"), `${JSON.stringify({ replayStatus }, null, 2)}\n`)
  }

  const manifestPath = join(directory, "manifest.json")
  const metadataPath = join(directory, "metadata.json")
  const reviewPath = join(directory, "files", "review.json")
  const manifest: Pick<ArtifactManifest, "files"> = { files }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(metadataPath, "{}\n")
  await writeFile(reviewPath, "{}\n")

  return {
    id: name,
    directory,
    manifestPath,
    metadataPath,
    blueprintAfterPath: join(directory, "blueprint.after.json"),
    blueprintAfterNotesPath: join(directory, "blueprint.after-notes.json"),
    eventsPath: join(directory, "events.ndjson"),
    commandsPath: join(directory, "commands.ndjson"),
    observationsPath: join(directory, "observations.ndjson"),
    runtimeLogPath: join(directory, "runtime.log"),
    commandsLogPath: join(directory, "commands.log"),
    mountsPath: join(directory, "files", "mounts.json"),
    capturedMountsPath: join(directory, "files", "mounted-files.json"),
    diffsPath: join(directory, "files", "diffs.json"),
    workspacePatchPath: join(directory, "files", "workspace-patch.json"),
    changedFilesPath: join(directory, "files", "changed-files.json"),
    patchPath: join(directory, "files", "patch.diff"),
    diagnosticsPath: join(directory, "files", "diagnostics.json"),
    testResultsPath: join(directory, "files", "test-results.json"),
    reviewPath,
    contentDigest: "0".repeat(64),
    createdAt: "2026-06-14T00:00:00.000Z",
  }
}

function manifestFile(path: string, kind: string): ArtifactManifestFile {
  return {
    path,
    kind,
    contentType: "application/json",
    sha256: { algorithm: "sha256", value: "0".repeat(64) },
  }
}
