import assert from "node:assert/strict"

import type { ArtifactSpec, Runtime } from "@automattic/wp-codebox-core"
import { collectRecipeRuntimeArtifacts } from "../packages/cli/src/recipe-evidence.js"

async function collectWithSpec(spec: ArtifactSpec) {
  let snapshotCalls = 0
  let collectSpec: ArtifactSpec | undefined
  const runtime = {
    async snapshot() {
      snapshotCalls++
      return { id: "snapshot-1" }
    },
    async collectArtifacts(input: ArtifactSpec) {
      collectSpec = input
      return { id: "bundle-1" }
    },
  } as unknown as Runtime

  await collectRecipeRuntimeArtifacts(runtime, spec)
  return { snapshotCalls, collectSpec }
}

assert.deepEqual(await collectWithSpec({ includeLogs: true, includeObservations: true }), {
  snapshotCalls: 0,
  collectSpec: { includeLogs: true, includeObservations: true },
})

assert.deepEqual(await collectWithSpec({ includeLogs: true, includeRuntimeSnapshotBundles: false }), {
  snapshotCalls: 0,
  collectSpec: { includeLogs: true, includeRuntimeSnapshotBundles: false },
})

assert.deepEqual(await collectWithSpec({ includeRuntimeSnapshotBundles: true }), {
  snapshotCalls: 1,
  collectSpec: { includeRuntimeSnapshotBundles: true },
})

console.log("recipe runtime artifacts snapshot policy ok")
