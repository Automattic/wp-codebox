import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { MountSpec } from "@automattic/wp-codebox-core"
import { ArtifactRedactor, buildArtifactReview } from "../packages/runtime-playground/src/artifacts.js"
import { captureMountDiffs } from "../packages/runtime-playground/src/mounted-artifact-capture.js"

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
