import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { createHash } from "node:crypto"
import { applyRunnerWorkspacePatch, verifyRunnerWorkspaceIntegrity } from "../packages/runtime-core/src/runner-workspace-apply.js"

const exec = promisify(execFile)

async function fixture(patch: string, files: unknown[]): Promise<{ workspace: string; artifacts: string; refs: Array<{ kind: string; path: string; sha256?: string }> }> {
  const root = await mkdtemp(join(tmpdir(), "wp-codebox-apply-"))
  const workspace = join(root, "workspace")
  const artifacts = join(root, "artifacts")
  await mkdir(workspace, { recursive: true })
  await mkdir(join(artifacts, "files"), { recursive: true })
  await writeFile(join(workspace, "README.md"), "before\n")
  await exec("git", ["init", "--quiet"], { cwd: workspace })
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
