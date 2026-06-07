import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startPlaygroundCliServer, type PlaygroundCliModule } from "../packages/runtime-playground/src/playground-cli-runner.js"
import type { RuntimeCreateSpec } from "@automattic/wp-codebox-core"

const workspace = await mkdtemp(join(tmpdir(), "wp-codebox-wordpress-directory-asset-"))

try {
  const wordpressDirectory = join(workspace, "wordpress")
  let cliOptions: Parameters<PlaygroundCliModule["runCLI"]>[0] | undefined
  const cliModule: PlaygroundCliModule = {
    async runCLI(options) {
      cliOptions = options
      return {
        serverUrl: "http://127.0.0.1:9999",
        close: async () => undefined,
      }
    },
  }

  const spec: RuntimeCreateSpec = {
    backend: "wordpress-playground",
    environment: {
      kind: "wordpress",
      name: "playground-wordpress-directory-asset-smoke",
      version: "mounted-wordpress-source",
      assets: { wordpressDirectory },
      wordpressInstallMode: "do-not-attempt-installing",
      blueprint: { steps: [] },
    },
    policy: {
      filesystem: "readwrite-mounts",
      network: "deny",
      commands: ["wordpress.run-php"],
      secrets: "none",
      approvals: "never",
    },
    secretEnv: {},
    artifactsDirectory: workspace,
  }

  const server = await startPlaygroundCliServer(spec, [], { cliModule })
  await server.close?.()

  assert.ok(cliOptions)
  assert.deepEqual(cliOptions["mount-before-install"], [{ hostPath: wordpressDirectory, vfsPath: "/wordpress" }])
  assert.equal(cliOptions.wordpressInstallMode, "do-not-attempt-installing")
  assert.equal(cliOptions.wp, undefined)

  console.log("Playground WordPress directory asset smoke passed")
} finally {
  await rm(workspace, { recursive: true, force: true })
}
