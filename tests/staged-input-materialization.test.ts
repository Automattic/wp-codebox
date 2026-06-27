import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { materializePlaygroundStagedInputs } from "../packages/runtime-playground/src/mount-materialization.js"
import { withTempDir } from "../scripts/test-kit.js"

await withTempDir("wp-codebox-staged-input-materialization-", async (root) => {
  const source = join(root, "store-idea-agent")
  await mkdir(join(source, "flows"), { recursive: true })
  await writeFile(join(source, "manifest.json"), `${JSON.stringify({ schema: "test/runtime-bundle/v1" })}\n`)
  await writeFile(join(source, "flows", "store.json"), `${JSON.stringify({ id: "store" })}\n`)

  const written = new Map<string, string>()
  const server = {
    playground: {
      async run() {
        return { text: JSON.stringify({ created: 2, skipped: 0 }) }
      },
      async writeFile(path: string, contents: string) {
        written.set(path, contents)
      },
    },
  }

  const result = await materializePlaygroundStagedInputs(server as never, [{
    type: "directory",
    source,
    target: "/workspace/wp-site-generator/bundles/store-idea-agent",
    mode: "readwrite",
    metadata: { kind: "runtime-package-source" },
  }])

  assert.equal(result.materialized, 2)
  assert.equal(result.deleted, 0)
  assert.equal(result.skipped, 0)
  assert.equal(result.phaseResult.phase, "playground-staged-input-materialization")
  assert.equal(written.get("/workspace/wp-site-generator/bundles/store-idea-agent/manifest.json"), `${JSON.stringify({ schema: "test/runtime-bundle/v1" })}\n`)
  assert.equal(written.get("/workspace/wp-site-generator/bundles/store-idea-agent/flows/store.json"), `${JSON.stringify({ id: "store" })}\n`)
})

console.log("staged input materialization ok")
