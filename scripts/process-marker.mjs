import { randomUUID } from "node:crypto"
import { rename, rm, writeFile } from "node:fs/promises"

export async function publishProcessMarker(markerPath, contents) {
  const pendingPath = `${markerPath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(pendingPath, contents)
    await rename(pendingPath, markerPath)
  } finally {
    await rm(pendingPath, { force: true })
  }
}
