import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

const root = await mkdtemp(join(tmpdir(), "wp-codebox-materialize-replay-package-"))
const outputDirectory = join(root, "package")
const snapshotPath = join(process.cwd(), "tests/fixtures/runtime-snapshot-small.json")

try {
  const materialize = spawnSync(process.execPath, [
    "packages/cli/dist/index.js",
    "materialize-replay-package",
    "--snapshot",
    snapshotPath,
    "--snapshot-ref",
    "fixture:runtime-snapshot-small",
    "--output",
    outputDirectory,
    "--json",
  ], { encoding: "utf8" })

  if (materialize.status !== 0) {
    throw new Error(`materialize-replay-package failed: ${materialize.stderr || materialize.stdout}`)
  }

  for (const relativePath of ["blueprint.after.json", "blueprint.zip", "files/runtime-snapshot.json", "blueprint.after-notes.json", "manifest.json"]) {
    if (!existsSync(join(outputDirectory, relativePath))) {
      throw new Error(`Missing materialized file: ${relativePath}`)
    }
  }

  const zipListing = spawnSync("unzip", ["-Z1", join(outputDirectory, "blueprint.zip")], { encoding: "utf8" })
  if (zipListing.status !== 0) {
    throw new Error(`Generated blueprint.zip is not listable: ${zipListing.stderr || zipListing.stdout}`)
  }

  const zipEntries = zipListing.stdout.trim().split(/\r?\n/).filter(Boolean).sort()
  const expectedZipEntries = ["blueprint.json", "files/runtime-snapshot.json"]
  if (JSON.stringify(zipEntries) !== JSON.stringify(expectedZipEntries)) {
    throw new Error(`Generated blueprint.zip entries mismatch: expected ${expectedZipEntries.join(", ")}; got ${zipEntries.join(", ")}`)
  }

  const zippedBlueprint = spawnSync("unzip", ["-p", join(outputDirectory, "blueprint.zip"), "blueprint.json"], { encoding: "utf8" })
  if (zippedBlueprint.status !== 0) {
    throw new Error(`Generated blueprint.zip does not contain root blueprint.json: ${zippedBlueprint.stderr || zippedBlueprint.stdout}`)
  }

  const zippedBlueprintJson = JSON.parse(zippedBlueprint.stdout)
  if (zippedBlueprintJson.steps?.[0]?.data?.path !== "files/runtime-snapshot.json") {
    throw new Error("Root blueprint.json must reference files/runtime-snapshot.json as a bundled resource")
  }

  const validate = spawnSync(process.execPath, [
    "packages/cli/dist/index.js",
    "validate-blueprint",
    "--blueprint",
    join(outputDirectory, "blueprint.after.json"),
    "--json",
  ], { encoding: "utf8" })

  if (validate.status !== 0) {
    throw new Error(`Generated blueprint did not validate: ${validate.stderr || validate.stdout}`)
  }

  const notes = JSON.parse(await readFile(join(outputDirectory, "blueprint.after-notes.json"), "utf8"))
  if (notes.source?.inputSnapshotPath !== snapshotPath) {
    throw new Error("Replay package notes must record the input snapshot path")
  }

  if (notes.source?.inputSnapshotRef !== "fixture:runtime-snapshot-small") {
    throw new Error("Replay package notes must record the input snapshot ref")
  }

  if (notes.source?.materializerCommand !== "wp-codebox materialize-replay-package") {
    throw new Error("Replay package notes must record the materializer command")
  }

  const manifest = JSON.parse(await readFile(join(outputDirectory, "manifest.json"), "utf8"))
  if (manifest.replayableWordPressSite?.source?.inputSnapshotPath !== snapshotPath) {
    throw new Error("Replay package manifest must record the input snapshot path")
  }

  if (manifest.replayableWordPressSite?.publicViewerArtifactPath !== "blueprint.zip") {
    throw new Error("Replay package manifest must point public viewers at blueprint.zip")
  }

  console.log("materialize-replay-package-smoke passed")
} finally {
  await rm(root, { recursive: true, force: true })
}
