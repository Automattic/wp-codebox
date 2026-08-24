import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { promisify } from "node:util"
import { directoryDiff } from "../packages/runtime-playground/src/artifacts.js"

const execFileAsync = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), "wp-codebox-artifact-patch-"))

try {
  const textBaseline = join(root, "text-baseline")
  const textCurrent = join(root, "text-current")
  const baselineTextFiles = {
    "deleted.txt": "deleted\n",
    "modified.txt": "before\n",
  }
  const currentTextFiles = {
    "added.txt": "added\n",
    "modified.txt": "after\n",
  }
  await writeFiles(textBaseline, baselineTextFiles)
  await writeFiles(textCurrent, currentTextFiles)

  const textDiff = await directoryDiff(textBaseline, textCurrent, "/workspace/plugin")
  assert.deepEqual(textDiff.files.map(({ path, relativePath, status }) => ({ path, relativePath, status })), [
    { path: "/workspace/plugin/added.txt", relativePath: "added.txt", status: "added" },
    { path: "/workspace/plugin/deleted.txt", relativePath: "deleted.txt", status: "deleted" },
    { path: "/workspace/plugin/modified.txt", relativePath: "modified.txt", status: "modified" },
  ])
  assert.deepEqual(patchHeaders(textDiff.patch), [
    "diff --git a/added.txt b/added.txt",
    "diff --git a/deleted.txt b/deleted.txt",
    "diff --git a/modified.txt b/modified.txt",
  ])
  assert.deepEqual(fileMarkers(textDiff.patch), [
    "--- /dev/null",
    "+++ b/added.txt",
    "--- a/deleted.txt",
    "+++ /dev/null",
    "--- a/modified.txt",
    "+++ b/modified.txt",
  ])
  await assertPatchRoundTrip(join(root, "text-apply"), textDiff.patch, baselineTextFiles, currentTextFiles)

  const gitSource = join(root, "git-source")
  const baselineGitFiles = {
    "binary-deleted.bin": Buffer.from([0, 1, 2, 3, 4]),
    "binary-modified.bin": Buffer.from([0, 10, 20, 30, 40]),
    "text-deleted.txt": "deleted\n",
    "text-modified.txt": "before\n",
  }
  const currentGitFiles = {
    "binary-added.bin": Buffer.from([0, 5, 10, 15, 20]),
    "binary-modified.bin": Buffer.from([0, 10, 99, 30, 40]),
    "text-added.txt": "added\n",
    "text-modified.txt": "after\n",
  }
  await writeFiles(gitSource, baselineGitFiles)
  await execFileAsync("git", ["init", "--quiet"], { cwd: gitSource })
  await execFileAsync("git", ["config", "user.email", "smoke@wp-codebox.test"], { cwd: gitSource })
  await execFileAsync("git", ["config", "user.name", "WP Codebox Smoke"], { cwd: gitSource })
  await execFileAsync("git", ["add", "."], { cwd: gitSource })
  await execFileAsync("git", ["commit", "--quiet", "-m", "baseline"], { cwd: gitSource })
  await replaceFiles(gitSource, baselineGitFiles, currentGitFiles)
  await execFileAsync("git", ["add", "--all"], { cwd: gitSource })
  const { stdout: gitPatch } = await execFileAsync("git", [
    "diff",
    "--cached",
    "--binary",
    "--no-ext-diff",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "HEAD",
    "--",
  ], { cwd: gitSource, maxBuffer: 1024 * 1024 })

  assert.deepEqual(patchHeaders(gitPatch), [
    "diff --git a/binary-added.bin b/binary-added.bin",
    "diff --git a/binary-deleted.bin b/binary-deleted.bin",
    "diff --git a/binary-modified.bin b/binary-modified.bin",
    "diff --git a/text-added.txt b/text-added.txt",
    "diff --git a/text-deleted.txt b/text-deleted.txt",
    "diff --git a/text-modified.txt b/text-modified.txt",
  ])
  assert.equal(gitPatch.match(/^GIT binary patch$/gm)?.length, 3)
  await assertPatchRoundTrip(join(root, "binary-apply"), gitPatch, baselineGitFiles, currentGitFiles)

  console.log("Artifact patch git apply smoke passed")
} finally {
  await rm(root, { recursive: true, force: true })
}

type FixtureFiles = Record<string, string | Buffer>

async function assertPatchRoundTrip(directory: string, patch: string, baseline: FixtureFiles, expected: FixtureFiles): Promise<void> {
  await writeFiles(directory, baseline)
  await execFileAsync("git", ["init", "--quiet"], { cwd: directory })
  const patchPath = join(root, `${basename(directory)}.diff`)
  await writeFile(patchPath, patch)
  await execFileAsync("git", ["apply", "--check", "--whitespace=error", "--", patchPath], { cwd: directory })
  await execFileAsync("git", ["apply", "--whitespace=error", "--", patchPath], { cwd: directory })

  for (const [path, contents] of Object.entries(expected)) {
    assert.deepEqual(await readFile(join(directory, path)), Buffer.from(contents))
  }
  for (const path of Object.keys(baseline).filter((path) => !(path in expected))) {
    await assert.rejects(readFile(join(directory, path)), (error: NodeJS.ErrnoException) => error.code === "ENOENT")
  }
}

async function replaceFiles(directory: string, before: FixtureFiles, after: FixtureFiles): Promise<void> {
  for (const path of Object.keys(before).filter((path) => !(path in after))) {
    await rm(join(directory, path))
  }
  await writeFiles(directory, after)
}

async function writeFiles(directory: string, files: FixtureFiles): Promise<void> {
  await mkdir(directory, { recursive: true })
  for (const [path, contents] of Object.entries(files)) {
    const fullPath = join(directory, path)
    await mkdir(dirname(fullPath), { recursive: true })
    await writeFile(fullPath, contents)
  }
}

function patchHeaders(patch: string): string[] {
  return patch.split("\n").filter((line) => line.startsWith("diff --git "))
}

function fileMarkers(patch: string): string[] {
  return patch.split("\n").filter((line) => line.startsWith("--- ") || line.startsWith("+++ "))
}
