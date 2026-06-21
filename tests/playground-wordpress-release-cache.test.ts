import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { resolveWordPressReleaseForStartup } from "../packages/runtime-playground/src/playground-cli-runner.js"

const cacheDirectory = await mkdtemp(join(tmpdir(), "wp-codebox-wordpress-release-cache-"))

try {
  const exact = await resolveWordPressReleaseForStartup("6.8.2", cacheDirectory, async () => {
    throw new Error("exact versions should not resolve release metadata")
  })

  assert.deepEqual(exact, {
    version: "6.8.2",
    releaseUrl: "https://wordpress.org/wordpress-6.8.2.zip",
    source: "inferred",
  })

  const resolved = await resolveWordPressReleaseForStartup("latest", cacheDirectory, async () => ({
    version: "6.8.2",
    releaseUrl: "https://wordpress.org/wordpress-6.8.2.zip",
    source: "api",
  }))

  assert.deepEqual(resolved, {
    version: "6.8.2",
    releaseUrl: "https://wordpress.org/wordpress-6.8.2.zip",
    source: "api",
  })

  const cached = await resolveWordPressReleaseForStartup("latest", cacheDirectory, async () => {
    throw new Error("metadata endpoint timed out")
  })

  assert.deepEqual(cached, {
    version: "6.8.2",
    releaseUrl: "https://wordpress.org/wordpress-6.8.2.zip",
    source: "cache",
  })

  await assert.rejects(
    () => resolveWordPressReleaseForStartup("nightly", cacheDirectory, async () => {
      throw new Error("metadata endpoint timed out")
    }),
    /Unable to resolve Playground startup asset wordpress-release-metadata/
  )

  console.log("playground WordPress release cache passed")
} finally {
  await rm(cacheDirectory, { recursive: true, force: true })
}
