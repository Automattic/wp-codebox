import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { publishProcessMarker } from "../scripts/process-marker.mjs"

const root = await mkdtemp(join(tmpdir(), "wp-codebox-process-marker-"))

try {
  const marker = join(root, "ready")
  const values = Array.from({ length: 20 }, (_, index) => `ready-${index}`)
  await Promise.all(values.map((value) => publishProcessMarker(marker, value)))
  assert.ok(values.includes(await readFile(marker, "utf8")), "concurrent publishers leave one complete marker")
  assert.deepEqual((await readdir(root)).filter((entry) => entry.endsWith(".tmp")), [], "successful publication leaves no private staging files")

  const invalidMarker = join(root, "directory")
  await mkdir(invalidMarker)
  await assert.rejects(publishProcessMarker(invalidMarker, "unpublishable"))
  assert.deepEqual((await readdir(root)).filter((entry) => entry.endsWith(".tmp")), [], "failed publication removes its private staging file")
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log("process marker publication passed")
