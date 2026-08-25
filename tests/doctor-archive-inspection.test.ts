import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inspectArchivePath } from "../packages/cli/src/commands/doctor.js"

const root = await mkdtemp(join(tmpdir(), "wp-codebox-doctor-archive-test-"))

try {
  const vanishedArchive = join(root, "vanished.zip")
  await writeFile(vanishedArchive, Buffer.alloc(22))
  const enumeratedArchives = [vanishedArchive]
  await rm(vanishedArchive)

  assert.equal(await inspectArchivePath(enumeratedArchives[0]!), undefined, "an archive removed after enumeration is skipped")

  const erroringArchive = join(root, "still-present.zip")
  await mkdir(erroringArchive)
  for (let index = 0; index < 4; index++) {
    await writeFile(join(erroringArchive, `entry-${index}`), "content")
  }

  await assert.rejects(
    inspectArchivePath(erroringArchive),
    (error: NodeJS.ErrnoException) => error.code === "EISDIR",
    "a still-present entry inspection error must remain surfaced",
  )
  assert.equal((await stat(erroringArchive)).isDirectory(), true)

  console.log("Doctor archive inspection tests passed")
} finally {
  await rm(root, { recursive: true, force: true })
}
