import assert from "node:assert/strict"
import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { createRuntime } from "../packages/runtime-core/src/index.js"
import { createPlaygroundRuntimeBackend } from "../packages/runtime-playground/src/index.js"
import type { PlaygroundCliModule } from "../packages/runtime-playground/src/playground-cli-runner.js"
import { withTempDir } from "../scripts/test-kit.js"

await withTempDir("wp-codebox-direct-mount-materialization-", async (root) => {
  const source = join(root, "source")
  const wordpressDirectory = join(root, "wordpress")
  await mkdir(source)
  await mkdir(wordpressDirectory)
  await writeFile(join(source, "fixture.txt"), "direct mount fixture")

  let directWrites = 0
  let mountedHostPath = ""
  const cliModule: PlaygroundCliModule = {
    async runCLI(options) {
      const mount = options.mount.find((candidate) => candidate.vfsPath === "/workspace/fixture")
      assert.ok(mount)
      mountedHostPath = mount.hostPath
      assert.equal(await readFile(join(mount.hostPath, "fixture.txt"), "utf8"), "direct mount fixture")
      return {
        serverUrl: "http://127.0.0.1:9404",
        playground: {
          async run() { return { text: "" } },
          async writeFile() { directWrites++ },
        },
        async [Symbol.asyncDispose]() {},
      }
    },
  }

  const runtime = await createRuntime({
    backend: "wordpress-playground",
    artifactsDirectory: join(root, "artifacts"),
    environment: {
      kind: "wordpress",
      name: "direct-mount-materialization",
      version: "mounted-wordpress-source",
      phpVersion: "8.4",
      wordpressInstallMode: "do-not-attempt-installing",
      assets: { wordpressDirectory },
      blueprint: {},
    },
    policy: {
      network: "deny",
      filesystem: "readonly-mounts",
      commands: [],
      secrets: "none",
      approvals: "never",
    },
  }, createPlaygroundRuntimeBackend({ cliModule }))

  const mount = { type: "directory" as const, source, target: "/workspace/fixture", mode: "readonly" as const }
  try {
    await runtime.mount(mount)
    const result = await runtime.materializeStagedInputs?.([mount]) as { phaseResult?: { status?: string; metadata?: Record<string, unknown> } }
    assert.equal(directWrites, 0, "mounted files are not rewritten through the Playground API")
    assert.notEqual(mountedHostPath, source, "readonly isolation still uses a private staged source")
    assert.equal(result.phaseResult?.status, "completed")
    assert.deepEqual(result.phaseResult?.metadata, {
      materialized: 0,
      deleted: 0,
      skipped: 0,
      mounts: 1,
      transport: "direct-nodefs-mount",
    })
  } finally {
    await runtime.destroy()
  }

  await assert.rejects(access(mountedHostPath), /ENOENT/, "readonly staging is removed with the runtime")
})

console.log("Playground staged inputs use direct NODEFS mounts")
