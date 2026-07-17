import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"

const MAX_SNAPSHOT_FILE_BYTES = 5 * 1024 * 1024

function underRoot(root, candidate) {
  const contained = relative(root, candidate)
  return candidate === root || (contained !== ".." && !contained.startsWith(`..${String.fromCharCode(47)}`) && !isAbsolute(contained))
}

/**
 * Copies selected regular artifacts to a private temporary root before a later
 * durable-artifact transformation. Callers retain their artifact references,
 * with paths rewritten relative to the trusted copy.
 */
export async function createTrustedArtifactSnapshot(artifactRoot, refs, maxFileBytes = MAX_SNAPSHOT_FILE_BYTES) {
  const root = await realpath(resolve(artifactRoot))
  const snapshotRoot = await mkdtemp(join(tmpdir(), "wp-codebox-trusted-artifacts-"))
  try {
    const copiedRefs = await Promise.all(refs.map(async (ref) => {
      const requested = isAbsolute(ref.path) ? resolve(ref.path) : resolve(root, ref.path)
      const stat = await lstat(requested)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxFileBytes) throw new Error("Trusted artifact snapshot requires a bounded regular file.")
      const source = await realpath(requested)
      if (!underRoot(root, source)) throw new Error("Trusted artifact snapshot escapes the artifact root.")
      const path = relative(root, source).replaceAll("\\", "/")
      const destination = join(snapshotRoot, path)
      await mkdir(resolve(destination, ".."), { recursive: true })
      await writeFile(destination, await readFile(source))
      return { ...ref, path }
    }))
    return { root: snapshotRoot, refs: copiedRefs }
  } catch (error) {
    await rm(snapshotRoot, { recursive: true, force: true })
    throw error
  }
}
