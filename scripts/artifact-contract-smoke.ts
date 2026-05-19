import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const artifactsDirectory = await mkdtemp(join(tmpdir(), "wp-codebox-artifacts-"))

try {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "packages/cli/dist/index.js",
      "recipe-run",
      "--recipe",
      "./examples/recipes/seeded-plugin-workspace.json",
      "--artifacts",
      artifactsDirectory,
      "--json",
    ],
    {
      cwd: resolve(import.meta.dirname, ".."),
      maxBuffer: 1024 * 1024 * 10,
    },
  )
  const output = JSON.parse(stdout)
  assert.equal(output.success, true)

  const artifacts = output.artifacts
  assert.ok(artifacts.changedFilesPath, "artifact bundle should expose changedFilesPath")
  assert.ok(artifacts.patchPath, "artifact bundle should expose patchPath")
  assert.ok(artifacts.reviewPath, "artifact bundle should expose reviewPath")

  const manifest = JSON.parse(await readFile(artifacts.manifestPath, "utf8"))
  const metadata = JSON.parse(await readFile(artifacts.metadataPath, "utf8"))
  const changedFiles = JSON.parse(await readFile(artifacts.changedFilesPath, "utf8"))
  const patch = await readFile(artifacts.patchPath, "utf8")
  const review = JSON.parse(await readFile(artifacts.reviewPath, "utf8"))

  assert.ok(manifest.files.some((file: { path: string; kind: string }) => file.path === "files/changed-files.json" && file.kind === "changed-files"))
  assert.ok(manifest.files.some((file: { path: string; kind: string }) => file.path === "files/patch.diff" && file.kind === "patch"))
  assert.ok(manifest.files.some((file: { path: string; kind: string }) => file.path === "files/review.json" && file.kind === "review"))
  assert.deepEqual(metadata.artifacts, {
    changedFiles: "files/changed-files.json",
    patch: "files/patch.diff",
    review: "files/review.json",
    mountDiffs: "files/diffs.json",
  })
  assert.equal(changedFiles.schema, "wp-codebox/changed-files/v1")
  assert.ok(
    changedFiles.files.some((file: { path: string; status: string }) =>
      file.path === "/wordpress/wp-content/plugins/seeded-helper/generated.txt" && file.status === "added",
    ),
  )
  assert.match(patch, /generated\.txt/)
  assert.match(patch, /\+cooked/)
  assert.equal(review.schema, "wp-codebox/artifact-review/v1")
  assert.equal(review.evidence.patch, "files/patch.diff")
  assert.equal(review.evidence.changedFiles, "files/changed-files.json")
  assert.ok(review.changedFiles.some((file: { path: string; status: string }) =>
    file.path === "/wordpress/wp-content/plugins/seeded-helper/generated.txt" && file.status === "added",
  ))
  assert.ok(review.actions.some((action: { kind: string; requiresApprovedFiles?: boolean }) => action.kind === "approve" && action.requiresApprovedFiles === true))
  assert.ok(review.actions.some((action: { kind: string }) => action.kind === "discard"))
  assert.ok(review.progress.some((event: { type: string; label: string }) => event.type === "complete" && event.label === "Ready for your review."))

  console.log("Artifact contract smoke passed")
} finally {
  await rm(artifactsDirectory, { recursive: true, force: true })
}
