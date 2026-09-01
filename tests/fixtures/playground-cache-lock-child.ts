import { lstat, writeFile } from "node:fs/promises"

import { withPlaygroundArchiveCacheLock } from "../../packages/runtime-playground/src/playground-wordpress-archive-cache.js"
import { publishProcessMarker } from "../../scripts/process-marker.mjs"

const [cacheDirectory, version, archivePath, iterations, readyPath, startPath] = process.argv.slice(2)
if (!cacheDirectory || !version || !archivePath || !iterations || !readyPath || !startPath) {
  throw new Error("cacheDirectory, version, archivePath, iterations, readyPath, and startPath are required")
}

await publishProcessMarker(readyPath, "ready")
while (!await exists(startPath)) {
  await new Promise((resolve) => setTimeout(resolve, 5))
}

for (let index = 0; index < Number(iterations); index += 1) {
  await withPlaygroundArchiveCacheLock(cacheDirectory, version, async () => {
    try {
      await writeFile(archivePath, `${process.pid}\n`, { flag: "wx" })
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 2))
  })
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false
    throw error
  }
}
