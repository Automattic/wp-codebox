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

  for (const relativePath of ["blueprint.after.json", "files/runtime-snapshot.json", "blueprint.after-notes.json", "manifest.json"]) {
    if (!existsSync(join(outputDirectory, relativePath))) {
      throw new Error(`Missing materialized file: ${relativePath}`)
    }
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

  console.log("materialize-replay-package-smoke passed")
} finally {
  await rm(root, { recursive: true, force: true })
}
