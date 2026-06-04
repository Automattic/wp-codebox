import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolvePlaygroundWordPressStartupAsset, validatePlaygroundWordPressArchiveCache } from "../packages/runtime-playground/src/playground-cli-runner.js"

const cacheDirectory = await mkdtemp(join(tmpdir(), "wp-codebox-playground-cache-"))

try {
  await writeFile(join(cacheDirectory, "7.1.zip"), "not a valid zip yet")
  await writeFile(join(cacheDirectory, "prebuilt-wp-content-for-wp-7.1.zip"), "nope")

  const result = await validatePlaygroundWordPressArchiveCache("7.1", cacheDirectory)

  assert.equal(result.version, "7.1")
  assert.match(result.sourceUrl, /wordpress/i)
  assert.equal(result.source, "inferred")
  assert.equal(result.invalidArchives.length, 2)
  assert.equal(result.invalidArchives.every((archive) => archive.deleted), true)
  assert.equal(existsSync(join(cacheDirectory, "7.1.zip")), false)
  assert.equal(existsSync(join(cacheDirectory, "prebuilt-wp-content-for-wp-7.1.zip")), false)
  assert.match(result.invalidArchives[0]?.reason ?? "", /too small|unexpected zip header/)

  await writeFile(join(cacheDirectory, "7.2.zip"), minimalZipArchive())
  const cachedStartupAsset = await resolvePlaygroundWordPressStartupAsset("7.2", undefined, cacheDirectory)
  assert.equal(cachedStartupAsset.wp, undefined)
  assert.equal(cachedStartupAsset.localPath, join(cacheDirectory, "7.2.zip"))
  assert.equal(cachedStartupAsset.cacheValidation.source, "cache")
  assert.equal(cachedStartupAsset.cacheValidation.sourceUrl, "https://wordpress.org/wordpress-7.2.zip")
  assert.equal(cachedStartupAsset.cacheValidation.cache?.archivePath, join(cacheDirectory, "7.2.zip"))
  assert.equal(cachedStartupAsset.cacheValidation.cache?.status, "hit")

  const preResolvedStartupAsset = await resolvePlaygroundWordPressStartupAsset("7.4", join(cacheDirectory, "7.2.zip"), cacheDirectory)
  assert.equal(preResolvedStartupAsset.wp, undefined)
  assert.equal(preResolvedStartupAsset.localPath, join(cacheDirectory, "7.2.zip"))
  assert.equal(preResolvedStartupAsset.cacheValidation.source, "pre-resolved")

  const originalFetch = globalThis.fetch
  let downloads = 0
  globalThis.fetch = async () => {
    downloads++
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
    return new Response(minimalZipArchive(), { status: 200, headers: { "content-type": "application/zip" } })
  }
  try {
    const inferredStartupAsset = await resolvePlaygroundWordPressStartupAsset("7.3", undefined, cacheDirectory)
    assert.equal(inferredStartupAsset.wp, undefined)
    assert.equal(inferredStartupAsset.localPath, join(cacheDirectory, "7.3.zip"))
    assert.equal(inferredStartupAsset.cacheValidation.source, "inferred")
    assert.equal(inferredStartupAsset.cacheValidation.sourceUrl, "https://wordpress.org/wordpress-7.3.zip")
    assert.equal(inferredStartupAsset.cacheValidation.cache?.status, "downloaded")

    await writeFile(join(cacheDirectory, "7.5.zip"), "corrupt archive")
    const [firstConcurrentAsset, secondConcurrentAsset] = await Promise.all([
      resolvePlaygroundWordPressStartupAsset("7.5", undefined, cacheDirectory),
      resolvePlaygroundWordPressStartupAsset("7.5", undefined, cacheDirectory),
    ])

    assert.equal(downloads, 2, "one inferred warmup plus one concurrent cache warmup should download two archives")
    assert.equal(firstConcurrentAsset.localPath, join(cacheDirectory, "7.5.zip"))
    assert.equal(secondConcurrentAsset.localPath, join(cacheDirectory, "7.5.zip"))
    assert.deepEqual(await readFile(join(cacheDirectory, "7.5.zip")), Buffer.from(minimalZipArchive()))
    const statuses = [firstConcurrentAsset, secondConcurrentAsset].map((asset) => asset.cacheValidation.cache?.status).sort()
    assert.deepEqual(statuses, ["downloaded", "hit"])
    assert.ok([firstConcurrentAsset, secondConcurrentAsset].every((asset) => (asset.cacheValidation.cache?.waitedMs ?? 0) >= 0))
    const invalidArchives = [firstConcurrentAsset, secondConcurrentAsset].flatMap((asset) => asset.cacheValidation.invalidArchives)
    assert.equal(invalidArchives.length, 1)
    assert.equal(invalidArchives[0]?.deleted, true)
  } finally {
    globalThis.fetch = originalFetch
  }

  console.log("Playground archive cache validation smoke passed")
} finally {
  await rm(cacheDirectory, { recursive: true, force: true })
}

function minimalZipArchive(): Uint8Array {
  const archive = new Uint8Array(22)
  archive[0] = 0x50
  archive[1] = 0x4b
  archive[2] = 0x05
  archive[3] = 0x06
  return archive
}
