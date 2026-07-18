import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { createHash } from "node:crypto"
import { applyRunnerWorkspacePatch, runnerWorkspaceIdentity, verifyRunnerWorkspaceIntegrity } from "../packages/runtime-core/src/runner-workspace-apply.js"

const exec = promisify(execFile)

async function fixture(patch: string, files: unknown[]): Promise<{ workspace: string; artifacts: string; refs: Array<{ kind: string; path: string; sha256?: string }> }> {
  const root = await mkdtemp(join(tmpdir(), "wp-codebox-apply-"))
  const workspace = join(root, "workspace")
  const artifacts = join(root, "artifacts")
  await mkdir(workspace, { recursive: true })
  await mkdir(join(artifacts, "files"), { recursive: true })
  await writeFile(join(workspace, "README.md"), "before\n")
  await exec("git", ["init", "--quiet"], { cwd: workspace })
  await exec("git", ["config", "user.email", "tests@example.invalid"], { cwd: workspace })
  await exec("git", ["config", "user.name", "Tests"], { cwd: workspace })
  await exec("git", ["add", "README.md"], { cwd: workspace })
  await exec("git", ["commit", "--quiet", "-m", "seed"], { cwd: workspace })
  await writeFile(join(artifacts, "files", "patch.diff"), patch)
  await writeFile(join(artifacts, "files", "changed-files.json"), JSON.stringify({ schema: "wp-codebox/changed-files/v1", files }))
  return { workspace, artifacts, refs: [
    { kind: "codebox-patch", path: join(artifacts, "files", "patch.diff"), sha256: createHash("sha256").update(patch).digest("hex") },
    { kind: "codebox-changed-files", path: join(artifacts, "files", "changed-files.json") },
  ] }
}

const patch = "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-before\n+after\n"
const files = [{ path: "/workspace/README.md", relativePath: "README.md", status: "modified", beforeMode: "100644", afterMode: "100644" }]

{
  const input = await fixture(patch, files)
  const order: string[] = []
  const result = await applyRunnerWorkspacePatch({ artifactRoot: input.artifacts, artifactRefs: input.refs, workspaceRoot: input.workspace, writablePaths: ["README.md"], verify: async () => { order.push("verify") } })
  assert.equal(result.status, "applied")
  assert.equal(await readFile(join(input.workspace, "README.md"), "utf8"), "after\n")
  assert.deepEqual(order, ["verify"])
  await verifyRunnerWorkspaceIntegrity(result.integrity!)
}

{
  const input = await fixture(patch, files)
  const seedIdentity = await runnerWorkspaceIdentity(input.workspace)
  assert.match(seedIdentity.git?.head ?? "", /^[a-f0-9]{40}$/)
  const result = await applyRunnerWorkspacePatch({ artifactRoot: input.artifacts, artifactRefs: input.refs, workspaceRoot: input.workspace, writablePaths: ["README.md"], seedIdentity })
  assert.equal(result.status, "applied", "a matching seed identity permits the canonical patch")
}

{
  const input = await fixture(patch, files)
  const seedIdentity = await runnerWorkspaceIdentity(input.workspace)
  await writeFile(join(input.workspace, "README.md"), "diverged\n")
  await assert.rejects(
    () => applyRunnerWorkspacePatch({ artifactRoot: input.artifacts, artifactRefs: input.refs, workspaceRoot: input.workspace, writablePaths: ["README.md"], seedIdentity }),
    (error: Error & { evidence?: Record<string, any> }) => {
      assert.match(error.message, /seed identity does not match/)
      assert.equal(error.evidence?.expected_identity.content_digest.value, seedIdentity.content_digest.value)
      assert.notEqual(error.evidence?.actual_identity.content_digest.value, seedIdentity.content_digest.value)
      assert.equal(error.evidence?.patch.artifact_path, "files/patch.diff")
      assert.equal(error.evidence?.changed_files.artifact_path, "files/changed-files.json")
      return true
    },
  )
  assert.equal(await readFile(join(input.workspace, "README.md"), "utf8"), "diverged\n", "identity mismatch rejects before git apply can mutate the workspace")
}

{
  const input = await fixture(patch, files)
  await writeFile(join(input.workspace, "README.md"), "other change\n")
  await assert.rejects(
    () => applyRunnerWorkspacePatch({ artifactRoot: input.artifacts, artifactRefs: input.refs, workspaceRoot: input.workspace, writablePaths: ["README.md"] }),
    (error: Error & { evidence?: Record<string, any> }) => {
      assert.match(error.message, /Host git apply failed/)
      assert.equal(error.evidence?.expected_identity, undefined, "legacy apply callers do not claim a seed baseline")
      assert.equal(error.evidence?.patch.artifact_path, "files/patch.diff")
      assert.equal(error.evidence?.changed_files.artifact_path, "files/changed-files.json")
      return true
    },
  )
  assert.equal(await readFile(join(input.workspace, "README.md"), "utf8"), "other change\n", "a rejected patch leaves the host workspace unchanged")
}

{
  const input = await fixture("", [])
  const result = await applyRunnerWorkspacePatch({ artifactRoot: input.artifacts, artifactRefs: input.refs, workspaceRoot: input.workspace, writablePaths: ["README.md"] })
  assert.equal(result.status, "no-op")
}

{
  const executablePatch = "diff --git a/README.md b/README.md\nold mode 100644\nnew mode 100755\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-before\n+after\n"
  const executableFiles = [{ ...files[0], afterMode: "100755" }]
  const input = await fixture(executablePatch, executableFiles)
  const result = await applyRunnerWorkspacePatch({ artifactRoot: input.artifacts, artifactRefs: input.refs, workspaceRoot: input.workspace, writablePaths: ["README.md"] })
  assert.equal(result.publicationFiles?.[0]?.mode, "100755")
}

{
  const input = await fixture(patch, files)
  await writeFile(join(input.artifacts, "files", "changed-files.json"), JSON.stringify({ schema: "wp-codebox/changed-files/v1", files: [{ ...files[0], relativePath: "other.md" }] }))
  await assert.rejects(() => applyRunnerWorkspacePatch({ artifactRoot: input.artifacts, artifactRefs: input.refs, workspaceRoot: input.workspace, writablePaths: ["README.md", "other.md"] }), /exactly correspond/)
}

{
  const input = await fixture(patch, files)
  const result = await applyRunnerWorkspacePatch({ artifactRoot: input.artifacts, artifactRefs: input.refs, workspaceRoot: input.workspace, writablePaths: ["README.md"] })
  await writeFile(join(input.workspace, "extra.txt"), "unexpected\n")
  await assert.rejects(() => verifyRunnerWorkspaceIntegrity(result.integrity!), /changed after approval/)
}

{
  const input = await fixture(patch, files)
  await writeFile(join(input.workspace, ".gitignore"), "node_modules/\n")
  await exec("git", ["add", ".gitignore"], { cwd: input.workspace })
  await exec("git", ["commit", "--quiet", "-m", "ignore dependencies"], { cwd: input.workspace })
  const result = await applyRunnerWorkspacePatch({
    artifactRoot: input.artifacts,
    artifactRefs: input.refs,
    workspaceRoot: input.workspace,
    writablePaths: ["README.md"],
    verify: async () => {
      const packageLinks = join(input.workspace, "node_modules", ".pnpm", "hono", "node_modules")
      await mkdir(packageLinks, { recursive: true })
      await symlink(input.artifacts, join(packageLinks, "hono"))
    },
  })
  await verifyRunnerWorkspaceIntegrity(result.integrity!)
}

{
  const input = await fixture(patch, files)
  const controlDirectory = join(input.workspace, ".codebox")
  await mkdir(controlDirectory)
  await writeFile(join(controlDirectory, "request.json"), "before\n")
  const result = await applyRunnerWorkspacePatch({
    artifactRoot: input.artifacts,
    artifactRefs: input.refs,
    workspaceRoot: input.workspace,
    writablePaths: ["README.md"],
    verify: async () => {
      await writeFile(join(controlDirectory, "request.json"), "after\n")
      await writeFile(join(controlDirectory, "result.json"), "complete\n")
    },
  })
  await verifyRunnerWorkspaceIntegrity(result.integrity!)
}

{
  const input = await fixture(patch, files)
  await symlink(input.artifacts, join(input.workspace, "publishable-link"))
  await assert.rejects(
    () => applyRunnerWorkspacePatch({ artifactRoot: input.artifacts, artifactRefs: input.refs, workspaceRoot: input.workspace, writablePaths: ["README.md"] }),
    /unsupported path type: publishable-link/,
  )
}

{
  const input = await fixture(patch, files)
  await assert.rejects(() => applyRunnerWorkspacePatch({ artifactRoot: input.artifacts, artifactRefs: input.refs, workspaceRoot: input.workspace, writablePaths: ["src/**"] }), /outside writable_paths/)
  assert.equal(await readFile(join(input.workspace, "README.md"), "utf8"), "before\n")
}

{
  const input = await fixture(patch, files)
  await assert.rejects(() => applyRunnerWorkspacePatch({ artifactRoot: input.artifacts, artifactRefs: input.refs, workspaceRoot: input.workspace, writablePaths: ["README.md"], verify: async () => { throw new Error("verification failed") } }), /verification failed/)
  assert.equal(await readFile(join(input.workspace, "README.md"), "utf8"), "after\n")
}

{
  const input = await fixture(patch, files)
  const patchPath = join(input.artifacts, "files", "patch.diff")
  const target = join(input.artifacts, "files", "patch-source.diff")
  await writeFile(target, patch)
  await rm(patchPath)
  await symlink(target, patchPath)
  await assert.rejects(() => applyRunnerWorkspacePatch({ artifactRoot: input.artifacts, artifactRefs: input.refs, workspaceRoot: input.workspace, writablePaths: ["README.md"] }), /bounded regular file/)
}

console.log("runner workspace apply ok")
