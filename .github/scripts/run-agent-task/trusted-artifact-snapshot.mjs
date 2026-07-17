import { createHash } from "node:crypto"
import { lstat, mkdtemp, readFile, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"

const MAX_SNAPSHOT_FILE_BYTES = 5 * 1024 * 1024

function underRoot(root, candidate) {
  const contained = relative(root, candidate)
  return candidate === root || (contained !== ".." && !contained.startsWith(`..${String.fromCharCode(47)}`) && !isAbsolute(contained))
}

/**
 * Opens a workflow-owned private root that the runtime may use before durable
 * artifact redaction. This root is never part of the artifact bundle.
 */
export async function createTrustedArtifactApplyChannel() {
  return mkdtemp(join(tmpdir(), "wp-codebox-trusted-apply-"))
}

/** Validates and projects only the two canonical private apply artifacts. */
export async function trustedArtifactApplyRefs(root, refs, maxFileBytes = MAX_SNAPSHOT_FILE_BYTES) {
  const channelRoot = await realpath(resolve(root))
  const expectedPaths = {
    "codebox-patch": "files/patch.diff",
    "codebox-changed-files": "files/changed-files.json",
  }
  const copiedRefs = await Promise.all(refs.map(async (ref) => {
    const path = expectedPaths[ref.kind]
    if (!path) throw new Error("Trusted apply artifacts must use canonical artifact kinds.")
    const requested = join(channelRoot, path)
    const stat = await lstat(requested)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxFileBytes) throw new Error("Trusted artifact snapshot requires a bounded regular file.")
    const source = await realpath(requested)
    if (!underRoot(channelRoot, source)) throw new Error("Trusted artifact snapshot escapes the artifact root.")
    const bytes = await readFile(source)
    return { ...ref, path, ...(ref.kind === "codebox-patch" ? { sha256: createHash("sha256").update(bytes).digest("hex") } : {}) }
  }))
  return { root: channelRoot, refs: copiedRefs }
}
