import { lstat, mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

const CHANNEL_ROOT_ENV = "WP_CODEBOX_TRUSTED_APPLY_ARTIFACT_ROOT"
const MAX_APPLY_ARTIFACT_BYTES = 5 * 1024 * 1024

/**
 * The workflow creates this private temporary root. It is deliberately outside
 * the durable bundle so canonical apply bytes never enter manifests or uploads.
 */
export async function writeTrustedApplyArtifacts(changedFiles: unknown, patch: string): Promise<void> {
  const root = process.env[CHANNEL_ROOT_ENV]
  if (!root) return

  const changedFilesContents = `${JSON.stringify(changedFiles, null, 2)}\n`
  if (Buffer.byteLength(changedFilesContents) > MAX_APPLY_ARTIFACT_BYTES || Buffer.byteLength(patch) > MAX_APPLY_ARTIFACT_BYTES) {
    throw new Error("Trusted apply artifacts must be bounded.")
  }

  const rootStat = await lstat(resolve(root))
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Trusted apply artifact root must be a directory.")
  const files = join(root, "files")
  await mkdir(files, { recursive: true, mode: 0o700 })
  const filesStat = await lstat(files)
  if (!filesStat.isDirectory() || filesStat.isSymbolicLink()) throw new Error("Trusted apply artifact files directory must be a directory.")
  await Promise.all([
    writeFile(join(files, "changed-files.json"), changedFilesContents, { mode: 0o600 }),
    writeFile(join(files, "patch.diff"), patch, { mode: 0o600 }),
  ])
}
