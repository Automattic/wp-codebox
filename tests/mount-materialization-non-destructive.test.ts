import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { applyVfsMountSnapshots, materializePlaygroundMountsFromVfs } from "../packages/runtime-playground/src/mount-materialization.js"

const root = await mkdtemp(join(tmpdir(), "wp-codebox-mount-materialization-"))

try {
  await writeFile(join(root, "host-only.txt"), "keep me")

  const skippedMaterialization = await materializePlaygroundMountsFromVfs({
    playground: {
      async run() {
        throw new Error("default readwrite mounts should not be snapshotted from VFS")
      },
    },
  } as never, [{ type: "directory", source: root, target: "/workspace/example", mode: "readwrite" }])

  assert.equal(skippedMaterialization.phaseResult.status, "skipped")
  assert.equal(skippedMaterialization.materialized, 0)

  await applyVfsMountSnapshots([{ type: "directory", source: root, target: "/workspace/example", mode: "readwrite" }], [{
    mountIndex: 0,
    target: "/workspace/example",
    files: [{ relativePath: "changed.txt", sha256: "", contentsBase64: Buffer.from("changed").toString("base64") }],
  }])

  assert.equal(await readFile(join(root, "host-only.txt"), "utf8"), "keep me", "host-only files are preserved by default")
  assert.equal(await readFile(join(root, "changed.txt"), "utf8"), "changed", "changed VFS files are written back")

  await applyVfsMountSnapshots([{ type: "directory", source: root, target: "/workspace/example", mode: "readwrite", metadata: { materializeDeletes: true } }], [{
    mountIndex: 0,
    target: "/workspace/example",
    files: [{ relativePath: "changed.txt", sha256: "" }],
  }])

  await assert.rejects(readFile(join(root, "host-only.txt"), "utf8"), "explicit delete opt-in removes host-only files")
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log("mount materialization non-destructive ok")
