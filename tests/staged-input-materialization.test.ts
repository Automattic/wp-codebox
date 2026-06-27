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

await withTempDir("wp-codebox-staged-input-materialization-fallback-", async (root) => {
  const source = join(root, "store-idea-agent")
  await mkdir(join(source, "flows"), { recursive: true })
  await writeFile(join(source, "manifest.json"), `${JSON.stringify({ schema: "test/runtime-bundle/v1" })}\n`)
  await writeFile(join(source, "flows", "store.json"), `${JSON.stringify({ id: "store" })}\n`)

  const written = new Map<string, string>()
  let fallbackWrites = 0
  const server = {
    playground: {
      async run({ code }: { code: string }) {
        if (code.includes("wp-codebox/host-mount-materialization/v1")) {
          fallbackWrites++
          return { text: JSON.stringify({ materialized: 1, skipped: 0 }) }
        }
        return { text: JSON.stringify({ created: 1, skipped: 0 }) }
      },
      async writeFile(path: string, contents: string) {
        if (path.endsWith("/flows/store.json")) {
          throw new Error("persistent writer unavailable for nested file")
        }
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
  assert.equal(fallbackWrites, 1)
  assert.equal(written.get("/workspace/wp-site-generator/bundles/store-idea-agent/manifest.json"), `${JSON.stringify({ schema: "test/runtime-bundle/v1" })}\n`)
})

console.log("staged input materialization ok")
