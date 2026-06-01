import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validatePlaygroundWordPressArchiveCache } from "../packages/runtime-playground/src/playground-cli-runner.js"

const cacheDirectory = await mkdtemp(join(tmpdir(), "wp-codebox-playground-cache-"))

try {
  await writeFile(join(cacheDirectory, "7.1.zip"), "not a valid zip yet")
  await writeFile(join(cacheDirectory, "prebuilt-wp-content-for-wp-7.1.zip"), "nope")

  const result = await validatePlaygroundWordPressArchiveCache("7.1", cacheDirectory)

  assert.equal(result.version, "7.1")
  assert.match(result.sourceUrl, /wordpress/i)
  assert.equal(result.invalidArchives.length, 2)
  assert.equal(result.invalidArchives.every((archive) => archive.deleted), true)
  assert.equal(existsSync(join(cacheDirectory, "7.1.zip")), false)
  assert.equal(existsSync(join(cacheDirectory, "prebuilt-wp-content-for-wp-7.1.zip")), false)
  assert.match(result.invalidArchives[0]?.reason ?? "", /too small|unexpected zip header/)

  console.log("Playground archive cache validation smoke passed")
} finally {
  await rm(cacheDirectory, { recursive: true, force: true })
}
