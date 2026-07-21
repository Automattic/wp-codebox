import { lstat, writeFile } from "node:fs/promises"

import { acquirePlaygroundArchiveReference } from "../../packages/runtime-playground/src/playground-wordpress-archive-cache.js"

const [archivePath, readyPath, stopPath] = process.argv.slice(2)
if (!archivePath || !readyPath || !stopPath) {
  throw new Error("archivePath, readyPath, and stopPath are required")
}

const reference = await acquirePlaygroundArchiveReference(archivePath)
await writeFile(readyPath, reference.path)

while (!await exists(stopPath)) {
  await new Promise((resolve) => setTimeout(resolve, 25))
}

await reference.release()

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false
    }
    throw error
  }
}
