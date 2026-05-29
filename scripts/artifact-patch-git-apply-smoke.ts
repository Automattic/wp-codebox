import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { promisify } from "node:util"
import { directoryDiff } from "../packages/runtime-playground/src/artifacts.js"

const execFileAsync = promisify(execFile)
const workspace = await mkdtemp(join(tmpdir(), "wp-codebox-artifact-patch-"))

try {
  const addedBaseline = join(workspace, "added-baseline")
  const addedCurrent = join(workspace, "added-current")
  await mkdir(addedBaseline, { recursive: true })
  await mkdir(addedCurrent, { recursive: true })
  await writeFile(join(addedCurrent, "added.txt"), "added\n")

  const added = await directoryDiff(addedBaseline, addedCurrent, "/workspace/plugin")
  assert.match(added.patch, /^diff --git a\/workspace\/plugin\/added\.txt b\/workspace\/plugin\/added\.txt/m)
  assert.match(added.patch, /^--- \/dev\/null$/m)
  assert.match(added.patch, /^\+\+\+ b\/workspace\/plugin\/added\.txt$/m)
  await assertPatchApplies(join(workspace, "added-apply"), added.patch)

  const deletedBaseline = join(workspace, "deleted-baseline")
  const deletedCurrent = join(workspace, "deleted-current")
  await mkdir(deletedBaseline, { recursive: true })
  await mkdir(deletedCurrent, { recursive: true })
  await writeFile(join(deletedBaseline, "deleted.txt"), "deleted\n")

  const deleted = await directoryDiff(deletedBaseline, deletedCurrent, "/workspace/plugin")
  assert.match(deleted.patch, /^diff --git a\/workspace\/plugin\/deleted\.txt b\/workspace\/plugin\/deleted\.txt/m)
  assert.match(deleted.patch, /^--- a\/workspace\/plugin\/deleted\.txt$/m)
  assert.match(deleted.patch, /^\+\+\+ \/dev\/null$/m)
  await assertPatchApplies(join(workspace, "deleted-apply"), deleted.patch, { "workspace/plugin/deleted.txt": "deleted\n" })

  console.log("Artifact patch git apply smoke passed")
} finally {
  await rm(workspace, { recursive: true, force: true })
}

async function assertPatchApplies(directory: string, patch: string, files: Record<string, string> = {}): Promise<void> {
  await mkdir(directory, { recursive: true })
  await execFileAsync("git", ["init"], { cwd: directory })
  for (const [path, contents] of Object.entries(files)) {
    const fullPath = join(directory, path)
    await mkdir(dirname(fullPath), { recursive: true })
    await writeFile(fullPath, contents)
  }

  const patchPath = join(directory, "patch.diff")
  await writeFile(patchPath, patch)
  await execFileAsync("git", ["apply", "--check", patchPath], { cwd: directory })
}
