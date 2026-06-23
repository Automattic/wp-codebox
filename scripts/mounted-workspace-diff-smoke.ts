import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import type { MountSpec } from "@automattic/wp-codebox-core"
import { ArtifactRedactor, buildArtifactReview } from "../packages/runtime-playground/src/artifacts.js"
import { applyVfsMountSnapshots, vfsMountSnapshotPhp } from "../packages/runtime-playground/src/mount-materialization.js"
import { captureMountDiffs } from "../packages/runtime-playground/src/mounted-artifact-capture.js"

const execFileAsync = promisify(execFile)

const root = await mkdtemp(join(tmpdir(), "wp-codebox-mounted-diff-smoke-"))

try {
  const artifactRoot = join(root, "artifacts")
  const filesDirectory = join(artifactRoot, "files")
  const baseline = join(root, "baseline")
  const workspace = join(root, "workspace")
  await mkdir(filesDirectory, { recursive: true })
  await mkdir(baseline, { recursive: true })
  await mkdir(workspace, { recursive: true })

  await writeFile(join(baseline, "plugin.php"), "<?php\n// before\n")
  await writeFile(join(baseline, "delete-me.txt"), "remove me\n")
  await writeFile(join(baseline, "script.sh"), numberedLines("before", 120).join("\r\n") + "\r\n")

  // Simulates workspace_edit mutations against the mounted workspace copy.
  await writeFile(join(workspace, "plugin.php"), "<?php\n// after\n")
  const scriptLines = numberedLines("before", 120)
  scriptLines[41] = "line 042 after"
  await writeFile(join(workspace, "script.sh"), scriptLines.join("\n") + "\n")

  // Simulates workspace_write creating a new file in the mounted workspace copy.
  await writeFile(join(workspace, "generated.txt"), "cooked\n")

  const mounts: MountSpec[] = [
    {
      type: "directory",
      source: workspace,
      target: "/workspace/plugin",
      mode: "readwrite",
      metadata: {
        kind: "recipe-workspace",
        sourceMode: "repo-backed",
        baselineSource: baseline,
        workspaceRef: "wp-codebox-fixture",
      },
    },
  ]

  const result = await captureMountDiffs(artifactRoot, filesDirectory, mounts, new ArtifactRedactor())
  const changed = new Map(result.changedFiles.files.map((file) => [file.relativePath, file]))

  assert.equal(result.diagnostics.length, 0)
  assert.equal(result.mountDiffs.length, 1)
  assert.equal(result.mountDiffs[0].status, "changed")
  assert.equal(result.mountDiffs[0].changed, true)
  assert.equal(changed.get("generated.txt")?.status, "added")
  assert.equal(changed.get("generated.txt")?.beforeSha256, undefined)
  assert.match(changed.get("generated.txt")?.afterSha256 ?? "", /^[a-f0-9]{64}$/)
  assert.equal(changed.get("generated.txt")?.afterMode, "100644")
  assert.equal(changed.get("plugin.php")?.status, "modified")
  assert.match(changed.get("plugin.php")?.beforeSha256 ?? "", /^[a-f0-9]{64}$/)
  assert.match(changed.get("plugin.php")?.afterSha256 ?? "", /^[a-f0-9]{64}$/)
  assert.equal(changed.get("plugin.php")?.beforeMode, "100644")
  assert.equal(changed.get("plugin.php")?.afterMode, "100644")
  assert.equal(changed.get("script.sh")?.status, "modified")
  assert.equal(changed.get("delete-me.txt")?.status, "deleted")
  assert.match(changed.get("delete-me.txt")?.beforeSha256 ?? "", /^[a-f0-9]{64}$/)
  assert.equal(changed.get("delete-me.txt")?.afterSha256, undefined)
  assert.equal(changed.get("delete-me.txt")?.beforeMode, "100644")
  assert.match(result.patch, /diff --git a\/workspace\/plugin\/generated\.txt b\/workspace\/plugin\/generated\.txt/)
  assert.match(result.patch, /\+cooked/)
  assert.match(result.patch, /diff --git a\/workspace\/plugin\/plugin\.php b\/workspace\/plugin\/plugin\.php/)
  assert.match(result.patch, /\+\/\/ after/)
  assert.match(result.patch, /diff --git a\/workspace\/plugin\/script\.sh b\/workspace\/plugin\/script\.sh/)
  assert.match(result.patch, /@@ -39,7 \+39,7 @@/)
  assert.match(result.patch, /-line 042 before/)
  assert.match(result.patch, /\+line 042 after/)
  assert.doesNotMatch(result.patch, /@@ -1,120 \+1,120 @@/)
  assert.doesNotMatch(result.patch, /-line 001 before[\s\S]*-line 120 before/)
  assert.match(result.patch, /deleted file mode 100644/)

  const mountPatch = await readFile(join(artifactRoot, result.mountDiffs[0].artifactPath), "utf8")
  assert.equal(mountPatch, result.patch)

  const missingBaselineResult = await captureMountDiffs(artifactRoot, filesDirectory, [
    {
      type: "directory",
      source: workspace,
      target: "/workspace/untracked",
      mode: "readwrite",
      metadata: { sourceMode: "repo-backed" },
    },
  ], new ArtifactRedactor())
  assert.equal(missingBaselineResult.patch, "")
  assert.equal(missingBaselineResult.changedFiles.files.length, 0)
  assert.equal(missingBaselineResult.mountDiffs[0].status, "skipped")
  assert.equal(missingBaselineResult.mountDiffs[0].reason, "missing-baseline-source")

  const fullRewritePatch = [
    "diff --git a/workspace/plugin/script.sh b/workspace/plugin/script.sh",
    "--- a/workspace/plugin/script.sh",
    "+++ b/workspace/plugin/script.sh",
    "@@ -1,60 +1,60 @@",
    ...numberedLines("before", 60).map((line) => `-${line}`),
    ...numberedLines("after", 60).map((line) => `+${line}`),
    "",
  ].join("\n")
  // A readwrite git work tree with no explicit baselineSource diffs against its
  // committed HEAD, so orchestrator workspace mounts capture the agent's edits
  // without the caller supplying a filesystem baseline snapshot.
  const gitRepo = join(root, "git-repo")
  await mkdir(gitRepo, { recursive: true })
  await execFileAsync("git", ["-C", gitRepo, "init", "-q"])
  await execFileAsync("git", ["-C", gitRepo, "config", "user.email", "smoke@wp-codebox.test"])
  await execFileAsync("git", ["-C", gitRepo, "config", "user.name", "wp-codebox smoke"])
  await writeFile(join(gitRepo, "committed.php"), "<?php\n// committed\n")
  await writeFile(join(gitRepo, "remove-me.txt"), "delete this\n")
  await execFileAsync("git", ["-C", gitRepo, "add", "."])
  await execFileAsync("git", ["-C", gitRepo, "commit", "-q", "-m", "baseline"])

  // Mutations the agent would make in the sandbox: edit a tracked file, delete a
  // tracked file, and create an untracked file.
  await writeFile(join(gitRepo, "committed.php"), "<?php\n// edited by agent\n")
  await rm(join(gitRepo, "remove-me.txt"), { force: true })
  await writeFile(join(gitRepo, "AGENT_WROTE_THIS.md"), "cooked by the agent\n")

  const gitResult = await captureMountDiffs(artifactRoot, filesDirectory, [
    {
      type: "directory",
      source: gitRepo,
      target: "/workspace/wp-coding-agents",
      mode: "readwrite",
      metadata: { kind: "orchestrator-workspace", workspace_slug: "wp-coding-agents" },
    },
  ], new ArtifactRedactor())
  const gitChanged = new Map(gitResult.changedFiles.files.map((file) => [file.relativePath, file]))

  assert.equal(gitResult.diagnostics.length, 0)
  assert.equal(gitResult.mountDiffs.length, 1)
  assert.equal(gitResult.mountDiffs[0].status, "changed")
  assert.equal(gitResult.mountDiffs[0].changed, true)
  assert.equal(gitResult.mountDiffs[0].reason, undefined)
  assert.equal(gitChanged.get("AGENT_WROTE_THIS.md")?.status, "added")
  assert.equal(gitChanged.get("committed.php")?.status, "modified")
  assert.equal(gitChanged.get("remove-me.txt")?.status, "deleted")
  assert.match(gitResult.patch, /diff --git a\/workspace\/wp-coding-agents\/AGENT_WROTE_THIS\.md b\/workspace\/wp-coding-agents\/AGENT_WROTE_THIS\.md/)
  assert.match(gitResult.patch, /\+cooked by the agent/)
  assert.match(gitResult.patch, /\+\/\/ edited by agent/)
  assert.match(gitResult.patch, /deleted file mode 100644/)

  const vfsBackedRepo = join(root, "vfs-backed-repo")
  await mkdir(vfsBackedRepo, { recursive: true })
  await execFileAsync("git", ["-C", vfsBackedRepo, "init", "-q"])
  await execFileAsync("git", ["-C", vfsBackedRepo, "config", "user.email", "smoke@wp-codebox.test"])
  await execFileAsync("git", ["-C", vfsBackedRepo, "config", "user.name", "wp-codebox smoke"])
  await writeFile(join(vfsBackedRepo, "committed.php"), "<?php\n// committed\n")
  await writeFile(join(vfsBackedRepo, "remove-me.txt"), "delete this\n")
  await execFileAsync("git", ["-C", vfsBackedRepo, "add", "."])
  await execFileAsync("git", ["-C", vfsBackedRepo, "commit", "-q", "-m", "baseline"])

  const vfsMounts: MountSpec[] = [{
    type: "directory",
    source: vfsBackedRepo,
    target: "/workspace/vfs-backed-repo",
    mode: "readwrite",
    metadata: { kind: "orchestrator-workspace", workspace_slug: "vfs-backed-repo" },
  }]

  const rawPhpTarget = join(root, "raw-php-vfs-target")
  const rawPhpFile = join(root, "vfs-mount-snapshot.php")
  await mkdir(rawPhpTarget, { recursive: true })
  await writeFile(join(rawPhpTarget, "changed.txt"), "changed inside raw php\n")
  const rawPhp = vfsMountSnapshotPhp([{
    mountIndex: 0,
    target: rawPhpTarget,
    files: {
      "changed.txt": createHash("sha256").update("before raw php\n").digest("hex"),
    },
  }])
  assert.doesNotMatch(rawPhp, /wp_json_encode/)
  await writeFile(rawPhpFile, rawPhp)
  const rawPhpResult = await execFileAsync("php", [rawPhpFile])
  const rawPhpSnapshot = JSON.parse(rawPhpResult.stdout) as { schema?: string; mounts?: Array<{ authoritative?: boolean; files?: Array<{ relativePath?: string; contentsBase64?: string }> }> }
  assert.equal(rawPhpSnapshot.schema, "wp-codebox/vfs-mount-snapshot/v1")
  assert.equal(rawPhpSnapshot.mounts?.[0]?.authoritative, true)
  assert.equal(rawPhpSnapshot.mounts?.[0]?.files?.[0]?.relativePath, "changed.txt")
  assert.equal(Buffer.from(rawPhpSnapshot.mounts?.[0]?.files?.[0]?.contentsBase64 ?? "", "base64").toString("utf8"), "changed inside raw php\n")

  const missingRawPhp = vfsMountSnapshotPhp([{
    mountIndex: 0,
    target: join(root, "missing-vfs-target"),
    files: {
      "remove-me.txt": createHash("sha256").update("delete this\n").digest("hex"),
    },
  }])
  await writeFile(rawPhpFile, missingRawPhp)
  const missingRawPhpResult = await execFileAsync("php", [rawPhpFile])
  const missingRawPhpSnapshot = JSON.parse(missingRawPhpResult.stdout) as { mounts?: Array<{ authoritative?: boolean; files?: unknown[] }> }
  assert.equal(missingRawPhpSnapshot.mounts?.[0]?.authoritative, false)
  assert.deepEqual(missingRawPhpSnapshot.mounts?.[0]?.files, [])

  const missingTargetMaterialized = await applyVfsMountSnapshots(vfsMounts, [{
    mountIndex: 0,
    target: "/workspace/vfs-backed-repo",
    authoritative: false,
    files: [],
  }])
  assert.equal(missingTargetMaterialized.materialized, 0)
  assert.equal(missingTargetMaterialized.deleted, 0)
  assert.equal(missingTargetMaterialized.skipped, 1)
  assert.equal(await readFile(join(vfsBackedRepo, "remove-me.txt"), "utf8"), "delete this\n")

  const emptyAndUnsafePathMaterialized = await applyVfsMountSnapshots(vfsMounts, [{
    mountIndex: 0,
    target: "/workspace/vfs-backed-repo",
    files: [
      {
        relativePath: "empty.txt",
        sha256: "unused",
        contentsBase64: "",
      },
      {
        relativePath: "remove-me.txt",
        sha256: "unused",
      },
      {
        relativePath: "../escaped.txt",
        sha256: "unused",
        contentsBase64: Buffer.from("escaped\n").toString("base64"),
      },
      {
        relativePath: "/absolute.txt",
        sha256: "unused",
        contentsBase64: Buffer.from("absolute\n").toString("base64"),
      },
    ],
  }])
  assert.equal(emptyAndUnsafePathMaterialized.materialized, 1)
  assert.equal(emptyAndUnsafePathMaterialized.deleted, 1)
  assert.equal(emptyAndUnsafePathMaterialized.skipped, 2)
  assert.equal(emptyAndUnsafePathMaterialized.phaseResult.schema, "wp-codebox/materialization-phase-result/v1")
  assert.equal(emptyAndUnsafePathMaterialized.phaseResult.phase, "playground-vfs-mount-materialization")
  assert.equal(emptyAndUnsafePathMaterialized.phaseResult.status, "completed")
  assert.equal((await stat(join(vfsBackedRepo, "empty.txt"))).size, 0)
  await assert.rejects(() => stat(join(root, "escaped.txt")))

  const materialized = await applyVfsMountSnapshots(vfsMounts, [{
    mountIndex: 0,
    target: "/workspace/vfs-backed-repo",
    files: [
      {
        relativePath: "committed.php",
        sha256: "unused",
        contentsBase64: Buffer.from("<?php\n// edited inside playground\n").toString("base64"),
      },
      {
        relativePath: "AGENT_WROTE_THIS.md",
        sha256: "unused",
        contentsBase64: Buffer.from("created inside playground\n").toString("base64"),
      },
    ],
  }])
  assert.equal(materialized.materialized, 2)
  assert.equal(materialized.deleted, 2)

  const vfsResult = await captureMountDiffs(artifactRoot, filesDirectory, vfsMounts, new ArtifactRedactor())
  const vfsChanged = new Map(vfsResult.changedFiles.files.map((file) => [file.relativePath, file]))
  assert.equal(vfsChanged.get("AGENT_WROTE_THIS.md")?.status, "added")
  assert.equal(vfsChanged.get("committed.php")?.status, "modified")
  assert.equal(vfsChanged.get("remove-me.txt")?.status, "deleted")
  assert.match(vfsResult.patch, /created inside playground/)
  assert.match(vfsResult.patch, /edited inside playground/)

  const review = buildArtifactReview({
    artifactId: "artifact-bundle-test",
    createdAt: "2026-06-01T00:00:00.000Z",
    provenance: {
      runtime: { backend: "wordpress-playground" },
      mounts: [{ type: "directory", source: workspace, target: "/workspace/plugin", mode: "readwrite" }],
    },
    changedFiles: {
      schema: "wp-codebox/changed-files/v1",
      files: [{ path: "/workspace/plugin/script.sh", relativePath: "script.sh", status: "modified", mountIndex: 0, mountTarget: "/workspace/plugin", patchPath: "files/patch.diff" }],
    },
    patch: fullRewritePatch,
    contentDigest: "sha256-test",
    runtimeCreatedAt: "2026-06-01T00:00:00.000Z",
    mounts,
  })
  assert.deepEqual(review.riskFlags, ["suspicious-full-file-rewrite:/workspace/plugin/script.sh"])
} finally {
  await rm(root, { recursive: true, force: true })
}

function numberedLines(label: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `line ${String(index + 1).padStart(3, "0")} ${label}`)
}
