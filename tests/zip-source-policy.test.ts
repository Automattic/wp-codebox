import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

import { prepareLocalZipSource } from "../packages/cli/src/zip-source.js"
import { withTempDir } from "../scripts/test-kit.js"

const execFileAsync = promisify(execFile)

async function archive(directory: string, name: string, entries: string[]): Promise<string> {
  await execFileAsync("zip", ["-q", name, ...entries], { cwd: directory })
  return join(directory, name)
}

await withTempDir("wp-codebox-zip-source-policy-", async (directory) => {
  const entries = Array.from({ length: 5002 }, (_, index) => `entry-${String(index).padStart(5, "0")}.txt`)
  await mkdir(join(directory, "package"))
  await Promise.all(entries.map((entry) => writeFile(join(directory, "package", entry), "x")))

  const validArchive = await archive(join(directory, "package"), "../valid.zip", entries.slice(0, 5001))
  const prepared = await prepareLocalZipSource(validArchive, "valid", undefined, "trusted")
  await rm(prepared.root, { recursive: true, force: true })

  const overLimitArchive = await archive(join(directory, "package"), "../over-limit.zip", entries)
  const previousLimit = process.env.WP_CODEBOX_TRUSTED_ARCHIVE_MAX_EXTRACTED_FILES
  process.env.WP_CODEBOX_TRUSTED_ARCHIVE_MAX_EXTRACTED_FILES = "5001"
  try {
    await assert.rejects(() => prepareLocalZipSource(overLimitArchive, "over-limit", undefined, "trusted"), /contains too many entries: 5002; limit 5001; archive class trusted/)
  } finally {
    if (previousLimit === undefined) delete process.env.WP_CODEBOX_TRUSTED_ARCHIVE_MAX_EXTRACTED_FILES
    else process.env.WP_CODEBOX_TRUSTED_ARCHIVE_MAX_EXTRACTED_FILES = previousLimit
  }
})

console.log("zip source policy bounds ok")
